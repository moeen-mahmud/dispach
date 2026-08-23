/**
 * Cross-field and semantic validation. Rules 1–4 and 10–11 of docs/02-SPEC-MANIFEST.md;
 * rules 5–9 and 12 need resolved tools, channels, and plugins and arrive with them.
 *
 * Every failure carries a field path and a fix. Failures are *collected* rather than thrown one
 * at a time — a manifest with three problems should report three problems, because the
 * alternative is three edit-run cycles.
 */

import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { BRAND } from "../brand.ts"
import { STAGE_ORDER, type StageName } from "../context/compaction/stages.ts"
import { apiVersionMismatch, type ErrorDetail, HarnessError } from "../errors.ts"
import { planWorkspace, type WorkspaceFileRef } from "../workspace/load.ts"
import { planSoul } from "../workspace/soul.ts"
import type { AgentManifest } from "./schema.ts"

/** Rule 1, checked against the raw document before the schema runs. */
export function assertApiVersion(raw: Record<string, unknown>): void {
    if (raw.apiVersion !== BRAND.apiVersion)
        throw apiVersionMismatch(raw.apiVersion, BRAND.apiVersion)
}

// ─── Rule 2: secrets are env var names, never values ─────────────────────────────────────

interface SecretPattern {
    readonly test: RegExp
    readonly label: string
}

/**
 * Deliberately narrow: each pattern matches a credential *format*, not a suspicious-looking
 * string. A false positive here blocks a legitimate manifest, which is worse than the near
 * miss it prevents.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
    { test: /^sk-[A-Za-z0-9_-]{8,}$/, label: "an OpenAI-style secret key" },
    { test: /^sk_(live|test)_[A-Za-z0-9]{8,}$/, label: "a Stripe-style secret key" },
    { test: /^Bearer\s+\S+/i, label: "an Authorization header value" },
    { test: /^gh[pousr]_[A-Za-z0-9]{20,}$/, label: "a GitHub token" },
    { test: /^github_pat_[A-Za-z0-9_]{20,}$/, label: "a GitHub fine-grained token" },
    { test: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, label: "a Slack token" },
    { test: /^glpat-[A-Za-z0-9_-]{16,}$/, label: "a GitLab token" },
    { test: /^AKIA[0-9A-Z]{16}$/, label: "an AWS access key id" },
    { test: /^AIza[0-9A-Za-z_-]{30,}$/, label: "a Google API key" },
    { test: /^[0-9a-f]{32,}$/i, label: "a 32+ character hex secret" },
]

/** Keys that must hold an env var *name*. A value shaped like a credential is the failure. */
const ENV_NAME_KEYS = new Set(["apiKeyEnv", "tokenEnv", "secretTokenEnv"])

function looksLikeEnvName(value: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(value)
}

export function scanForLiteralSecrets(value: unknown, path = ""): ErrorDetail[] {
    const found: ErrorDetail[] = []

    if (typeof value === "string") {
        const key = path.slice(path.lastIndexOf(".") + 1)

        if (ENV_NAME_KEYS.has(key) && !looksLikeEnvName(value)) {
            found.push({
                code: "manifest_literal_secret",
                message: `${path} must be the *name* of an environment variable, but holds ${JSON.stringify(shorten(value))}.`,
                hint: `Replace it with the variable's name — e.g. ${key}: MODEL_API_KEY — and export the value in the environment. A manifest is a file people paste into issues.`,
                field: path,
            })
            return found
        }

        for (const pattern of SECRET_PATTERNS) {
            if (!pattern.test.test(value)) continue
            found.push({
                code: "manifest_literal_secret",
                message: `${path} looks like ${pattern.label}.`,
                // The placeholder below documents the manifest's own expansion syntax to the
                // reader; it is not an unfinished template literal.
                // biome-ignore lint/suspicious/noTemplateCurlyInString: documentation, not code
                hint: "Secrets belong in the environment, referenced by name (apiKeyEnv) or by expansion (${MY_VAR}). Never as a literal in the manifest.",
                field: path,
            })
            break
        }
        return found
    }

    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            found.push(...scanForLiteralSecrets(item, `${path}[${index}]`))
        }
        return found
    }

    if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            found.push(...scanForLiteralSecrets(item, path === "" ? key : `${path}.${key}`))
        }
    }

    return found
}

function shorten(value: string): string {
    return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-2)}` : value
}

// ─── Rules 3, 4, 10, 11 and the environment they need ────────────────────────────────────

/**
 * The order these must ascend in is the order the ladder runs them in, so it is read from the ladder.
 *
 * It was a second hand-kept copy of `STAGE_ORDER` until the stages were reordered, at which point the
 * copy silently described a ladder that no longer existed — the `NO_MANIFEST` and `offered` shape that
 * has cost this repo a debugging round more than once.
 */
const THRESHOLD_ORDER = STAGE_ORDER

/**
 * The pre-reorder defaults, in the order they used to ascend in.
 *
 * A manifest written against them is not malformed, it is *old*: the same five numbers, the same five
 * names, ordered for a ladder that ran `trim` first. Detected as its own case because the generic
 * ascending error would point at `context.thresholds.trim` and say it must exceed `micro`, which is
 * true, useless, and about a file nobody edited.
 */
const LEGACY_ORDER = ["trim", "snip", "micro", "collapse", "reset"] as const

/**
 * The old numbers, mapped onto the stage now in each position.
 *
 * Zipped from the two orders rather than written out, because a hint that names the wrong stage is
 * worse than a generic one: it is a remedy someone will apply.
 */
function rewriteFrom(thresholds: Readonly<Record<StageName, number>>): string[] {
    return THRESHOLD_ORDER.map((name, i) => {
        const legacy = LEGACY_ORDER[i]
        return legacy === undefined ? name : `${name} ${thresholds[legacy]}`
    })
}

function ascendsIn(
    thresholds: Readonly<Record<StageName, number>>,
    order: readonly StageName[],
): boolean {
    for (let i = 1; i < order.length; i += 1) {
        const previous = order[i - 1]
        const name = order[i]
        if (previous === undefined || name === undefined) return false
        if (thresholds[name] <= thresholds[previous]) return false
    }
    return true
}

function validateThresholds(manifest: AgentManifest): ErrorDetail[] {
    const found: ErrorDetail[] = []
    const { thresholds } = manifest.context

    for (const name of THRESHOLD_ORDER) {
        const value = thresholds[name]
        if (value > 0 && value < 1) continue
        found.push({
            code: "manifest_threshold_range",
            message: `context.thresholds.${name} is ${value}, which is not between 0 and 1.`,
            hint: "Thresholds are fractions of the prompt budget — `context.window` minus `context.reserveOutput`, the space a prompt may actually occupy — exclusive of both ends, so 0.6 means 60%. Not of the whole window: a large reserveOutput would then let the blunt oldest-first trim run while the ladder still reported mild pressure.",
            field: `context.thresholds.${name}`,
        })
    }

    if (found.length === 0 && !ascendsIn(thresholds, THRESHOLD_ORDER)) {
        if (ascendsIn(thresholds, LEGACY_ORDER)) {
            return [
                {
                    code: "manifest_thresholds_legacy_order",
                    message:
                        "context.thresholds ascends in the old stage order (trim first), which the ladder no longer uses.",
                    hint: `The ladder now runs ${THRESHOLD_ORDER.join(" → ")}, ordered by how much information each stage destroys rather than how many bytes it frees: snip and micro leave an artifact_read pointer, collapse and reset leave a digest, and trim leaves nothing. Your five numbers still work — move each onto the stage in the same position: ${rewriteFrom(thresholds).join(", ")}. Deleting the block takes the defaults.`,
                    field: "context.thresholds",
                },
            ]
        }

        for (let i = 1; i < THRESHOLD_ORDER.length; i += 1) {
            const previousName = THRESHOLD_ORDER[i - 1]
            const name = THRESHOLD_ORDER[i]
            if (previousName === undefined || name === undefined) continue
            const previous = thresholds[previousName]
            const current = thresholds[name]
            if (current > previous) continue
            found.push({
                code: "manifest_thresholds_not_ascending",
                message: `context.thresholds.${name} (${current}) must be greater than ${previousName} (${previous}).`,
                hint: `The compaction ladder runs strictly in order ${THRESHOLD_ORDER.join(" → ")}. Equal or inverted thresholds mean a stage can never fire, or fires out of order.`,
                field: `context.thresholds.${name}`,
            })
        }
    }

    return found
}

function validateToolBudget(manifest: AgentManifest): ErrorDetail[] {
    const { max, reserveWrite } = manifest.tools.budget
    if (reserveWrite < max) return []
    return [
        {
            code: "manifest_reserve_write_too_large",
            message: `tools.budget.reserveWrite (${reserveWrite}) must be less than tools.budget.max (${max}).`,
            hint: "reserveWrite holds slots inside the cap for mutating tools. Reserving the whole budget leaves no room for the read tools the agent needs to decide anything.",
            field: "tools.budget.reserveWrite",
        },
    ]
}

function validateContextBudget(manifest: AgentManifest, resolvedWindow: number): ErrorDetail[] {
    const { reserveOutput } = manifest.context
    if (reserveOutput < resolvedWindow) return []
    return [
        {
            code: "manifest_reserve_output_too_large",
            message: `context.reserveOutput (${reserveOutput}) must be less than the context window (${resolvedWindow}).`,
            hint: "reserveOutput is held back from the window for the response. Set context.window explicitly if the shipped capability registry is wrong for your endpoint.",
            field: "context.reserveOutput",
        },
    ]
}

/**
 * Every workspace file exists and is readable, whichever tier listed it.
 *
 * Reported here rather than left to the loader so that a manifest with three missing files reports
 * three, not one at a time across three edit-run cycles. `planWorkspace` is the single source of
 * where each name resolves to — including the `context.files` alias, which keeps resolving against
 * the manifest directory rather than the workspace one.
 */
function validateWorkspaceFiles(
    manifest: AgentManifest,
    dir: string,
    resolvedWindow: number,
): ErrorDetail[] {
    const found: ErrorDetail[] = []

    let refs: readonly WorkspaceFileRef[]
    try {
        refs = planWorkspace(manifest.context, dir).refs
    } catch (error) {
        // Currently only the files/static conflict, which is a configuration error in its own right.
        return [error instanceof HarnessError ? error.toDetail() : rethrow(error)]
    }

    // The soul gate runs here with the same model `run` resolves, because `onUnmet: fail` exists to
    // be heard at validation time rather than in production. Whichever file the gate picks joins the
    // existence check below like any other static ref.
    const soul = manifest.context.soul
    if (soul !== undefined) {
        const workspaceDir = isAbsolute(manifest.context.workspace)
            ? manifest.context.workspace
            : resolve(dir, manifest.context.workspace)
        try {
            const plan = planSoul(
                soul,
                { id: manifest.model.main.id, window: resolvedWindow },
                workspaceDir,
            )
            if (plan.ref !== undefined) refs = [plan.ref, ...refs]
        } catch (error) {
            found.push(error instanceof HarnessError ? error.toDetail() : rethrow(error))
        }
    }

    for (const ref of refs) {
        try {
            const stat = statSync(ref.path)
            if (stat.isDirectory()) {
                found.push({
                    code: "manifest_context_file_not_readable",
                    message: `${ref.field} points at a directory: ${ref.path}`,
                    hint: "The tier lists take individual markdown files, in the order they should appear in the prompt.",
                    field: ref.field,
                })
                continue
            }
            accessSync(ref.path, constants.R_OK)
        } catch {
            found.push({
                code: "manifest_context_file_missing",
                message: `${ref.field} is not readable: ${ref.path}`,
                hint: `${ref.field.startsWith("context.files") ? "Paths in the deprecated context.files resolve against the manifest." : "Tier paths resolve against context.workspace, which resolves against the manifest."} These files are the agent's instructions, so a missing one is a load failure rather than a warning.`,
                field: ref.field,
            })
        }
    }

    return found
}

function rethrow(error: unknown): never {
    throw error
}

/**
 * `knowledge.dir` must be a readable directory. The *entries* are validated by `loadKnowledge` —
 * frontmatter, keywords, per-entry budget — because validating them twice invites the two copies
 * of the check to disagree; the directory's existence is checked here so it lands in the same
 * aggregated report as a missing workspace file.
 */
function validateKnowledgeDir(manifest: AgentManifest, dir: string): ErrorDetail[] {
    const knowledge = manifest.knowledge
    if (knowledge === undefined) return []

    const path = isAbsolute(knowledge.dir) ? knowledge.dir : resolve(dir, knowledge.dir)
    try {
        if (statSync(path).isDirectory()) return []
    } catch {
        // fall through to the finding
    }
    return [
        {
            code: "knowledge_dir_missing",
            message: `knowledge.dir is not a readable directory: ${path}`,
            hint: "knowledge.dir resolves against the manifest directory. A configured directory that does not exist is a load failure rather than an empty catalogue — the alternative is an agent silently missing reference material its author believes it has.",
            field: "knowledge.dir",
        },
    ]
}

/**
 * The env var named by `apiKeyEnv` must exist at load.
 *
 * The *value* is read fresh on every request, so rotating a key needs no restart. Its
 * *presence* is checked here, because an agent whose key is absent can never answer, and
 * discovering that as a 401 on the first user message is exactly the translation cost this
 * project exists to remove.
 */
function validateApiKeyEnv(
    manifest: AgentManifest,
    env: Record<string, string | undefined>,
): ErrorDetail[] {
    const found: ErrorDetail[] = []

    for (const role of ["main", "selector", "compactor"] as const) {
        const config = manifest.model[role]
        if (config === undefined) continue
        const name = config.apiKeyEnv
        if (name === undefined) continue
        if (env[name] !== undefined && env[name] !== "") continue

        found.push({
            code: "model_api_key_missing",
            message: `model.${role}.apiKeyEnv names ${name}, which is not set.`,
            hint: `Export ${name}, or add it to a .env beside the manifest. Omit apiKeyEnv entirely for an endpoint that needs no key, such as a local Ollama.`,
            field: `model.${role}.apiKeyEnv`,
        })
    }

    return found
}

function validateBaseUrls(manifest: AgentManifest): ErrorDetail[] {
    const found: ErrorDetail[] = []

    for (const role of ["main", "selector", "compactor"] as const) {
        const config = manifest.model[role]
        if (config === undefined) continue
        const field = `model.${role}.baseUrl`

        let url: URL
        try {
            url = new URL(config.baseUrl)
        } catch {
            found.push({
                code: "manifest_base_url_invalid",
                message: `${field} is not a valid absolute URL: ${config.baseUrl}`,
                hint: "Give a full URL ending at the version segment, e.g. https://api.openai.com/v1 — the runtime appends /chat/completions itself.",
                field,
            })
            continue
        }

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            found.push({
                code: "manifest_base_url_invalid",
                message: `${field} uses an unsupported protocol: ${url.protocol}`,
                hint: "Only http and https are supported. The transport is OpenAI-compatible /chat/completions over HTTP.",
                field,
            })
            continue
        }

        if (url.pathname.endsWith("/chat/completions")) {
            found.push({
                code: "manifest_base_url_includes_path",
                message: `${field} already includes /chat/completions.`,
                hint: "baseUrl must end at the version segment. The runtime appends the endpoint path, so including it here produces a doubled path and a 404.",
                field,
            })
        }
    }

    return found
}

/**
 * Channel entries, and the delivery targets that name them.
 *
 * Read from the raw document rather than the parsed manifest so a schema default never looks like
 * an author's intent, and so a malformed entry is reported here rather than throwing on a property
 * access. Three checks, each of which was otherwise a runtime mystery:
 *
 * - a `type` no factory is registered for — a channel that constructs nothing and never receives,
 *   which looks exactly like a wrong token or a network fault
 * - a duplicate `id` — ids are the channel segment of a session key and a webhook path segment
 * - `delivery` naming a channel that does not exist, which is rule 9 in `02-SPEC-MANIFEST.md` and
 *   fails at the first scheduled run rather than at load
 */
function validateChannels(
    raw: Record<string, unknown>,
    knownChannels: readonly string[],
): ErrorDetail[] {
    const found: ErrorDetail[] = []
    const entries = Array.isArray(raw.channels) ? raw.channels : []
    const ids = new Set<string>()

    for (const [index, entry] of entries.entries()) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
        const channel = entry as Record<string, unknown>
        const type = typeof channel.type === "string" ? channel.type : undefined
        const id = typeof channel.id === "string" ? channel.id : undefined

        if (id !== undefined) {
            if (ids.has(id)) {
                found.push({
                    code: "channel_id_duplicate",
                    message: `Two channels share the id "${id}".`,
                    hint: "Channel ids become the channel segment of a session key and the path segment of a webhook URL, so they must be unique within an agent.",
                    field: `channels[${index}].id`,
                })
            }
            ids.add(id)
        }

        if (type !== undefined && !knownChannels.includes(type)) {
            found.push({
                code: "channel_type_unknown",
                message: `channels[${index}] declares type "${type}", which is not registered here.${
                    knownChannels.length === 0 ? "" : ` Available: ${knownChannels.join(", ")}.`
                }`,
                hint:
                    knownChannels.length === 0
                        ? `A channel is supplied by the embedder — nothing installs at runtime. Pass it as Runtime.create({ channels: { ${type}: … } }). ${BRAND.slug} validate reports this whenever it runs without one, since it cannot know what an embedder would register.`
                        : "Check the spelling against the available types.",
                field: `channels[${index}].type`,
            })
        }
    }

    const delivery = raw.delivery
    if (delivery !== null && typeof delivery === "object" && !Array.isArray(delivery)) {
        const config = delivery as Record<string, unknown>
        const named: { channel: string; field: string }[] = []

        if (typeof config.default === "string") {
            named.push({ channel: config.default, field: "delivery.default" })
        }
        const targets = config.targets
        if (targets !== null && typeof targets === "object" && !Array.isArray(targets)) {
            for (const [name, target] of Object.entries(targets as Record<string, unknown>)) {
                if (target === null || typeof target !== "object") continue
                const channel = (target as { channel?: unknown }).channel
                if (typeof channel === "string") {
                    named.push({ channel, field: `delivery.targets.${name}.channel` })
                }
            }
        }

        for (const { channel, field } of named) {
            if (ids.has(channel)) continue
            found.push({
                code: "delivery_channel_unknown",
                message: `${field} names "${channel}", which is not a channel id on this agent.${
                    ids.size === 0
                        ? " The agent declares no channels."
                        : ` Declared: ${[...ids].join(", ")}.`
                }`,
                hint: "A delivery target names a channel's id, not its type. Rule 9 in 02-SPEC-MANIFEST.md — checked at load rather than at the first scheduled run, which is otherwise where it surfaces.",
                field,
            })
        }
    }

    return found
}

/**
 * Sections this build parses but does not implement.
 *
 * Refused rather than ignored. A manifest that configures Telegram against a runtime with no
 * channel support would otherwise boot healthy and never deliver anything — the shape of
 * failure rule 8 exists to prevent. Checked against the *raw* document, so a schema default
 * never looks like a user's intent.
 */
const UNSUPPORTED_SECTIONS: readonly { key: string; feature: string; phase: string }[] = [
    { key: "schedules", feature: "schedules", phase: "Phase 8" },
    { key: "plugins", feature: "plugins", phase: "Phase 9" },
]

function validateSupportedSections(
    raw: Record<string, unknown>,
    knownProviders: readonly string[],
    knownChannels: readonly string[],
): ErrorDetail[] {
    const found: ErrorDetail[] = []
    found.push(...validateChannels(raw, knownChannels))

    for (const { key, feature, phase } of UNSUPPORTED_SECTIONS) {
        const value = raw[key]
        if (value === undefined || value === null) continue
        if (Array.isArray(value) && value.length === 0) continue
        if (!Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0) {
            continue
        }

        found.push({
            code: "not_implemented_yet",
            message: `This build does not implement ${feature}, but the manifest configures it.`,
            hint: `${feature} arrives in ${phase}. Remove the "${key}" section for now — it is refused rather than silently ignored, because a runtime that drops configuration lies about what it is doing.`,
            field: key,
        })
    }

    // `context.compactionNotice` was refused here until Phase 7A built the ladder it describes. The
    // block is left as a comment rather than deleted because the pattern it held is the one to reuse:
    // a field nested under `context` is invisible to the section-level loop above, so anything
    // specified-but-unbuilt in there needs its own check or silence gets read as support.

    const tools = raw.tools
    if (tools !== null && typeof tools === "object" && !Array.isArray(tools)) {
        const toolKeys = tools as Record<string, unknown>

        // Providers are implemented now, but only for ids the caller registered. Checked against
        // `knownProviders` rather than dropped from this list entirely: naming a provider nobody
        // supplied has to fail, and failing here — beside the field — beats failing at resolution,
        // where the report blames twenty slugs for one missing registration.
        //
        // Both spellings are read, from the same function the runtime uses. A check only `run`
        // performs is a check `validate` disagrees with, and this one had that shape already: the
        // map would have gone unchecked entirely while the scalar was still reported.
        const declaredMap = toolKeys.providers
        const declaredIds = [
            ...(declaredMap !== null &&
            typeof declaredMap === "object" &&
            !Array.isArray(declaredMap)
                ? Object.keys(declaredMap as Record<string, unknown>).map(
                      (id) => [id, `tools.providers.${id}`] as const,
                  )
                : []),
            ...(typeof toolKeys.provider === "string" && toolKeys.provider !== ""
                ? [[toolKeys.provider, "tools.provider"] as const]
                : []),
        ]
        for (const [declared, field] of declaredIds) {
            if (knownProviders.includes(declared)) continue
            found.push({
                code: "tool_provider_unknown",
                message: `${field} names "${declared}", which is not registered here.${knownProviders.length === 0 ? "" : ` Available: ${knownProviders.join(", ")}.`}`,
                hint:
                    knownProviders.length === 0
                        ? `A provider is supplied by the embedder — nothing installs at runtime. Pass it as Runtime.create({ toolProviders: { ${declared}: (ctx) => new … } }). ${BRAND.slug} validate reports this whenever it is run without one, since it cannot know what an embedder would register.`
                        : "Check the spelling against the available ids.",
                field,
            })
        }

        const search = toolKeys.search
        if (
            search !== undefined &&
            search !== null &&
            (search as { enabled?: unknown }).enabled === true
        ) {
            found.push({
                code: "not_implemented_yet",
                message: "This build does not implement tools.search.",
                hint: "Runtime tool search stays off in v1 by design: search-then-execute is two-hop reasoning, which is where small models fail. Pin the tools the agent needs instead.",
                field: "tools.search",
            })
        }
    }

    return found
}

/**
 * `tools.dialect: native` against a model that has no native tool calling.
 *
 * The capability registry already knows this, and the alternative to checking it is a 400 from the
 * endpoint on the first turn — or worse, on an endpoint that accepts an unknown `tools` key and
 * ignores it, an agent that simply never calls a tool and never says why. Refusing at load names the
 * model and the one-line fix.
 *
 * It reads `capabilities.nativeTools`, which an author can override in the manifest — so declaring
 * support for a model the registry does not know about is a supported move, not a fight.
 */
function validateDialectSupport(
    manifest: AgentManifest,
    capabilities: { readonly nativeTools: boolean },
): ErrorDetail[] {
    if (manifest.tools.dialect !== "native" || capabilities.nativeTools) return []
    return [
        {
            code: "native_tools_unsupported",
            message: `tools.dialect is native, but ${manifest.model.main.id} is not known to support native tool calling.`,
            hint: "Use the nlt dialect — it needs nothing from the endpoint, and on models this size it is the better choice anyway (+24 to +43pp on small models). If this model does support tool calling and the capability table is simply out of date, set model.main.capabilities.nativeTools: true and say so in a pull request.",
            field: "tools.dialect",
        },
    ]
}

export interface ValidateOptions {
    /** Directory the manifest was loaded from; workspace paths resolve against it. */
    dir: string
    /** The window after capability resolution, used by rule 11. */
    resolvedWindow: number
    /** Resolved capabilities for `model.main`, used by the dialect-support rule. */
    capabilities: { readonly nativeTools: boolean }
    /** Environment to check `apiKeyEnv` presence against. */
    env: Record<string, string | undefined>
    /** The document as written, for checks that must not see schema defaults. */
    raw: Record<string, unknown>
    /**
     * Provider ids the caller can actually supply, from `Runtime.create({ toolProviders })`.
     *
     * `tools.provider` is checked against this rather than against a hardcoded list, because a
     * provider is registered by the embedder and core may not import one. Omitted means none — which
     * is why `validate` on its own still refuses a manifest naming a provider: the CLI knows what it
     * registers, and a bare validation cannot know what an embedder would.
     */
    knownProviders?: readonly string[]
    /**
     * Channel types the caller can supply, from `Runtime.create({ channels })`.
     *
     * Same shape and same reasoning as `knownProviders`. Omitted means none, so a bare `validate`
     * refuses a manifest declaring a channel — the CLI knows what it registers and passes it, and a
     * library caller that registers nothing genuinely cannot serve that manifest.
     */
    knownChannels?: readonly string[]
}

/** Every rule this build can enforce. Returns all failures; the caller decides how to report. */
export function validateManifest(manifest: AgentManifest, options: ValidateOptions): ErrorDetail[] {
    return [
        ...validateThresholds(manifest),
        ...validateToolBudget(manifest),
        ...validateContextBudget(manifest, options.resolvedWindow),
        ...validateWorkspaceFiles(manifest, options.dir, options.resolvedWindow),
        ...validateKnowledgeDir(manifest, options.dir),
        ...validateBaseUrls(manifest),
        ...validateApiKeyEnv(manifest, options.env),
        ...validateDialectSupport(manifest, options.capabilities),
        ...validateSupportedSections(
            options.raw,
            options.knownProviders ?? [],
            options.knownChannels ?? [],
        ),
    ]
}
