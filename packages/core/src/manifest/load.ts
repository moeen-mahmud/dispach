/**
 * Manifest loading: read → extends → $ref → secret scan → env expansion → schema → rules.
 *
 * The order is deliberate.
 *
 * - `apiVersion` is checked first, on the raw document. A v2 manifest hitting a v1 schema
 *   produces a dozen confusing field errors; naming the version once is the honest answer.
 * - The secret scan runs *before* the schema, so `apiKey: sk-…` is reported as a literal
 *   secret rather than as an unknown key. The user's mistake is the secret, not the spelling.
 * - Env expansion runs *after* `$ref` resolution, so a shared block expands per use site, and
 *   *before* the schema, so `${PORT}` can satisfy a numeric field via YAML coercion.
 *
 * Nothing here touches the network. Loading a manifest resolves files and environment only.
 */

import { readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import {
    type ErrorDetail,
    extendsUnresolved,
    manifestNotObject,
    manifestNotYaml,
    manifestUnreadable,
    schemaInvalid,
    validationFailed,
} from "../errors.ts"
import { resolveCapabilities } from "../model/capabilities.ts"
import {
    type EnvOverride,
    type EnvSource,
    envOverrides,
    expandEnvDeep,
    layeredEnv,
    mergeEnv,
    parseDotEnv,
} from "./env.ts"
import { resolveRefs, shallowMerge } from "./refs.ts"
import { type AgentManifest, AgentManifestSchema } from "./schema.ts"
import { assertApiVersion, scanForLiteralSecrets, validateManifest } from "./validate.ts"

export interface LoadedManifest {
    readonly manifest: AgentManifest
    /** Absolute path the manifest was read from, or `"(object)"` for the programmatic path. */
    readonly path: string
    /** Directory that relative paths inside the manifest resolve against. */
    readonly dir: string
    /** Window after capability resolution — what the budget actually gets to spend. */
    readonly window: number
    /**
     * Live environment for this manifest: the real environment layered over any `.env` beside it.
     *
     * Carried on the result because the provider reads the API key on every request, and it must
     * see the same variables the load-time validation checked. Without this, `validate` approves a
     * manifest whose `.env` supplies the key and `run` then fails with "not set" — a validator
     * that disagrees with the runtime is worse than no validator.
     */
    readonly env: EnvSource
    /**
     * Variables the ambient environment took away from the `.env` beside this manifest.
     *
     * Carried rather than warned about here, because `loadManifest` is also what `validate --json`
     * calls and a silent load has to stay silent. `Agent.create` turns it into an `agent.warning`,
     * which is where a person still sees it after boot.
     */
    readonly envOverrides: readonly EnvOverride[]
}

export interface LoadOptions {
    /** Defaults to `process.env`. Injectable so tests never depend on ambient environment. */
    env?: EnvSource
    /** Skip reading a `.env` beside the manifest. */
    skipEnvFile?: boolean
    /** Read a file as UTF-8. Injectable for tests. */
    readFile?: (path: string) => string
}

interface Resolved {
    /** Snapshot, for load-time checks. */
    env: EnvSource
    /** Live view, for anything read per request. */
    liveEnv: EnvSource
    /** Where the two layers disagree. Empty on the `skipEnvFile` path, which has one layer. */
    overrides: readonly EnvOverride[]
    readFile: (path: string) => string
}

function resolveOptions(dir: string, options: LoadOptions): Resolved {
    const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"))
    const realEnv = options.env ?? process.env

    if (options.skipEnvFile === true) {
        return { env: realEnv, liveEnv: realEnv, overrides: [], readFile }
    }

    let dotEnv: Record<string, string> = {}
    try {
        dotEnv = parseDotEnv(readFile(resolve(dir, ".env")))
    } catch {
        // No .env beside the manifest is the normal case, not an error.
    }

    return {
        env: mergeEnv(dotEnv, realEnv),
        liveEnv: layeredEnv(dotEnv, realEnv),
        overrides: envOverrides(dotEnv, realEnv),
        readFile,
    }
}

function readDocument(path: string, readFile: (path: string) => string): Record<string, unknown> {
    let text: string
    try {
        text = readFile(path)
    } catch (cause) {
        throw manifestUnreadable(path, cause)
    }

    let parsed: unknown
    try {
        parsed = parseYaml(text)
    } catch (cause) {
        throw manifestNotYaml(path, cause)
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw manifestNotObject(path)
    }

    return parsed as Record<string, unknown>
}

/** Resolve `extends` chains, innermost base first. Depth-capped to make a cycle terminate. */
function readWithExtends(
    path: string,
    readFile: (path: string) => string,
    depth = 0,
): Record<string, unknown> {
    const document = readDocument(path, readFile)
    const base = document.extends

    if (typeof base !== "string" || base === "") return document
    if (depth >= 8) {
        throw extendsUnresolved(
            base,
            "extends",
            new Error("extends nesting exceeded 8 levels, which usually means a cycle"),
        )
    }

    const basePath = isAbsolute(base) ? base : resolve(dirname(path), base)
    let baseDocument: Record<string, unknown>
    try {
        baseDocument = readWithExtends(basePath, readFile, depth + 1)
    } catch (cause) {
        throw extendsUnresolved(basePath, "extends", cause)
    }

    const merged = shallowMerge(baseDocument, document)
    delete merged.extends
    return merged
}

interface ZodLikeIssue {
    code?: string
    path?: (string | number)[]
    message?: string
    keys?: string[]
    expected?: string
    received?: string
}

function issuePath(issue: ZodLikeIssue): string {
    const segments = issue.path ?? []
    if (segments.length === 0) return "(root)"
    return segments
        .map((segment, index) =>
            typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("")
}

function hintForIssue(issue: ZodLikeIssue): string {
    switch (issue.code) {
        case "unrecognized_keys":
            return `Unknown key${(issue.keys?.length ?? 0) > 1 ? "s" : ""}: ${(issue.keys ?? []).join(", ")}. Unknown keys are refused rather than ignored, because a typo that silently does nothing is indistinguishable from working. See docs/02-SPEC-MANIFEST.md.`
        case "invalid_type":
            return `Expected ${issue.expected ?? "a different type"}. Check quoting — YAML reads 8080 as a number and "8080" as a string.`
        case "invalid_enum_value":
        case "invalid_value":
            return "Use one of the documented values. See the field reference in docs/02-SPEC-MANIFEST.md."
        case "too_small":
            return "The value is below the allowed minimum. Empty strings and empty required lists are rejected."
        case "too_big":
            return "The value is above the allowed maximum."
        default:
            return "See docs/02-SPEC-MANIFEST.md for this field's contract."
    }
}

function schemaIssuesToDetails(issues: unknown[]): ErrorDetail[] {
    return issues.map((raw) => {
        const issue = raw as ZodLikeIssue
        const field = issuePath(issue)
        return {
            code: "manifest_schema_invalid",
            message: `${field}: ${issue.message ?? "invalid value"}`,
            hint: hintForIssue(issue),
            field,
        }
    })
}

/**
 * Validate an already-parsed object. This is the programmatic path — `defineAgent()` and the
 * TS builder land here — and it is the same code path the YAML route uses, so there is no
 * YAML-only or TS-only behaviour.
 */
export function loadManifestFromObject(
    raw: Record<string, unknown>,
    options: LoadOptions & { dir: string; path?: string },
): LoadedManifest {
    const { env, liveEnv, overrides } = resolveOptions(options.dir, options)

    assertApiVersion(raw)

    // Before the schema: a literal credential is the real mistake, whatever key it sits under.
    const secrets = scanForLiteralSecrets(raw)
    if (secrets.length > 0) throw validationFailed(secrets)

    const withRefs = resolveRefs(raw) as Record<string, unknown>
    const expanded = expandEnvDeep(withRefs, env) as Record<string, unknown>

    const parsed = AgentManifestSchema.safeParse(expanded)
    if (!parsed.success) {
        throw schemaInvalid(schemaIssuesToDetails(parsed.error.issues as unknown[]))
    }

    const manifest = parsed.data
    const capabilities = resolveCapabilities(
        manifest.model.main.id,
        manifest.model.main.capabilities,
    )
    const window = manifest.context.window ?? capabilities.contextWindow

    const failures = validateManifest(manifest, {
        dir: options.dir,
        resolvedWindow: window,
        capabilities,
        env,
        raw: expanded,
    })
    if (failures.length > 0) throw validationFailed(failures)

    return {
        manifest: { ...manifest, context: { ...manifest.context, window } },
        path: options.path ?? "(object)",
        dir: options.dir,
        window,
        env: liveEnv,
        envOverrides: overrides,
    }
}

/** Load and fully validate a manifest from disk. */
export function loadManifest(path: string, options: LoadOptions = {}): LoadedManifest {
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path)
    const dir = dirname(absolute)
    const { readFile } = resolveOptions(dir, options)
    const raw = readWithExtends(absolute, readFile)

    return loadManifestFromObject(raw, { ...options, dir, path: absolute })
}

/**
 * The programmatic construction path. Identical shape to the YAML file, validated by the same
 * code — `import { defineAgent }` is as first-class as `run agent.yaml`.
 *
 * `dir` defaults to the current working directory, because relative paths in a
 * programmatically-built manifest have nothing else to resolve against.
 */
export function defineAgent(
    manifest: Record<string, unknown>,
    options: LoadOptions & { dir?: string } = {},
): LoadedManifest {
    return loadManifestFromObject(manifest, { ...options, dir: options.dir ?? process.cwd() })
}
