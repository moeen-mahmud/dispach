/**
 * The one thing that writes `agent.yaml`.
 *
 * ## Why there is exactly one
 *
 * There were three. `config_set` did floor → place → **validate** → write. `skills enable` did
 * place → write, with a comment saying the next load would catch a bad result — which is precisely
 * the failure the validation exists to prevent, because "the next load" is a person's agent refusing
 * to start after a command reported success. And a person-facing `config` command was about to be the
 * third. The shapes differed in what they checked, which means the guarantee a caller got depended on
 * which caller it was.
 *
 * So the mechanical half lives here and is not optional: place the value, parse the result, check it
 * against the real schema, check that the providers still resolve, and only then write. The *policy*
 * half — which paths a caller may touch, and what it refuses — stays with each caller, because they
 * genuinely differ: the agent has a floor (`floorRefusal`) and a person has confirmations. Sharing the
 * policy would have to mean giving one of them the other's authority.
 *
 * ## Why the schema is not the whole check
 *
 * `resolveProviders` runs too. Writing `tools.providers` into a manifest that still carries the
 * deprecated `tools.provider` scalar produces a document the schema *accepts* and the runtime
 * *refuses* — an agent that boots today and not tomorrow, reported as a success. It is the same
 * function the runtime calls, so the two cannot disagree.
 *
 * ## Why nothing here decides where the file is
 *
 * The caller passes an absolute path. A helper that resolved a ref would make this module the second
 * place that knows how an agent is named, and the id-versus-directory split has already cost a round.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { isMap, isSeq, parseDocument } from "yaml"
import { HarnessError } from "../errors.ts"
import { resolveProviders } from "./providers.ts"
import { AgentManifestSchema } from "./schema.ts"
import { validateSchedules } from "./validate.ts"
import { setInSource, uncommentInSource } from "./yaml-edit.ts"

export interface ManifestEdit {
    /** Absolute path to the manifest. */
    readonly file: string
    /** Dotted path, already split. */
    readonly path: readonly string[]
    /** Already parsed from whatever the surface accepted. */
    readonly value: unknown
    /**
     * Used instead of the reflowing round-trip when the source editor cannot place the path.
     *
     * A caller that knows its own file can do better than either. `skills enable` writes a top-level
     * block that does not exist yet — which `setInSource` declines, since it appends to a parent and
     * there is none — and the generated manifest already ships the line commented out under its own
     * heading, so uncommenting in place puts the block where a reader expects it rather than orphaned
     * at the end of the file. Returning `undefined` falls through to the round-trip.
     */
    readonly fallback?: (source: string) => string | undefined
}

export interface ManifestEditResult {
    /** What was there, as plain JS. `undefined` when the field was not set. */
    readonly before: unknown
    /** What is there now. */
    readonly after: unknown
    /**
     * The source editor could not place the path, so the document was re-serialised.
     *
     * Worth reporting rather than swallowing: a reflowed file is correct and its comments have moved,
     * which is a surprise a person should hear about from the command rather than from `git diff`.
     */
    readonly reflowed: boolean
    /** The validated manifest, for a caller that wants to say something about the result. */
    readonly manifest: ReturnType<typeof AgentManifestSchema.parse>
}

/** What a validated edit produced, before anybody has written it. */
export interface PreparedEdit extends Omit<ManifestEditResult, "after"> {
    /** The complete new file contents. */
    readonly next: string
}

/**
 * Place the value and check the result. Pure — no filesystem, so the validation is testable directly.
 *
 * Split out because the checks are the valuable half and they need nothing but a string. It also lets
 * a sync caller and an async one share them rather than one of the two skipping them, which is how
 * three writers with three different guarantees happened.
 *
 * Throws rather than returning a doubtful result: there is no useful "written but invalid".
 */
export function prepareManifestEdit(
    source: string,
    edit: Pick<ManifestEdit, "path" | "value" | "fallback">,
): PreparedEdit {
    const parts = [...edit.path]
    const dotted = parts.join(".")
    const before = plain(parseDocument(source), parts)

    // Edited in the source text; the round-trip is the fallback, not the plan. See `yaml-edit.ts` for
    // why — one change through `setIn` produced a thirty-line diff on a generated manifest.
    // Three attempts, cheapest damage first: replace the value in place; a caller's own placement;
    // then uncomment the block the generated manifest ships commented, which is what keeps a first-time
    // `channels` write from reflowing 98 lines. The round-trip below is the last resort.
    const placed =
        setInSource(source, parts, edit.value) ??
        edit.fallback?.(source) ??
        (parts.length === 1 ? uncommentInSource(source, parts[0] ?? "", edit.value) : undefined)
    let next: string
    if (placed === undefined) {
        const round = parseDocument(source)
        round.setIn(parts, edit.value)
        next = String(round)
    } else {
        next = placed
    }

    // Parsed *and checked for parse errors* before the schema sees anything. `toJS()` on a broken
    // document still returns an object — so a rendering defect produced `- @moeen_m`, which is invalid
    // YAML because `@` is a reserved indicator, `allowFrom` came back absent, the schema accepted the
    // rest, and this function wrote a manifest the runtime refuses to load and reported success. That is
    // the exact failure the validation exists to prevent, and it was inside the validation.
    const document = parseDocument(next)
    if (document.errors.length > 0) {
        throw manifestEditInvalid(
            dotted,
            `the result is not valid YAML — ${document.errors[0]?.message ?? "unparseable"}`,
        )
    }

    const parsed = AgentManifestSchema.safeParse(document.toJS())
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        throw manifestEditInvalid(
            dotted,
            `${first?.path.join(".") ?? dotted}: ${first?.message ?? "does not fit the schema"}`,
        )
    }

    // Same rule as the providers check below, and schedules are the field it applies to second:
    // `expr`, `deliver.channel` and `role` are strings the schema accepts and the runtime refuses. A
    // `config_set schedules` without this reports a successful edit and the next boot fails.
    const scheduleFindings = validateSchedules(
        document.toJS() as Record<string, unknown>,
        parsed.data,
        Date.now(),
    )
    const firstSchedule = scheduleFindings[0]
    if (firstSchedule !== undefined) {
        throw manifestEditInvalid(dotted, `${firstSchedule.message} ${firstSchedule.hint}`)
    }

    // The schema alone is not the whole load. Writing `tools.providers` into a manifest that still
    // carries the deprecated `tools.provider` scalar produces a document the schema accepts and the
    // runtime refuses — an agent that boots today and not tomorrow, reported as a success. Same
    // function the runtime calls, so the two cannot disagree.
    try {
        resolveProviders(parsed.data.tools)
    } catch (cause) {
        throw manifestEditInvalid(
            dotted,
            cause instanceof Error ? cause.message : "the providers block does not resolve",
        )
    }

    return { next, before, reflowed: placed === undefined, manifest: parsed.data }
}

/**
 * Place one value, validate the whole file, write it.
 *
 * Reads the file itself instead of taking source text: a caller that read it earlier would be writing
 * over whatever happened in between, and this is a file the agent, the person and `init` all touch.
 */
export async function editManifest(edit: ManifestEdit): Promise<ManifestEditResult> {
    let source: string
    try {
        source = await readFile(edit.file, "utf8")
    } catch (cause) {
        throw manifestEditUnreadable(edit.file, cause)
    }
    const prepared = prepareManifestEdit(source, edit)
    await writeFile(edit.file, prepared.next, "utf8")
    return { ...prepared, after: edit.value }
}

/**
 * The same thing for a caller that is not async.
 *
 * Here rather than making one command async because the alternative was `skills enable` keeping its own
 * unvalidated write — and a guarantee that depends on whether its caller happened to return a promise
 * is not a guarantee. Every check is `prepareManifestEdit`'s, so the two cannot drift.
 */
export function editManifestSync(edit: ManifestEdit): ManifestEditResult {
    let source: string
    try {
        source = readFileSync(edit.file, "utf8")
    } catch (cause) {
        throw manifestEditUnreadable(edit.file, cause)
    }
    const prepared = prepareManifestEdit(source, edit)
    writeFileSync(edit.file, prepared.next, "utf8")
    return { ...prepared, after: edit.value }
}

/**
 * Read a value a surface was handed, written as a scalar or a JSON-ish list or map.
 *
 * Here rather than in either surface because the two must not disagree about whether `["a", "b"]` is a
 * list of two strings — one accepting it and the other storing the literal text is the same class of
 * split as two settable lists. `stringify`-then-parse rather than `JSON.parse`, because YAML is what a
 * model writes and `["a", "b"]` happens to be valid in both.
 *
 * A value that parses as neither is thrown on by name. Guessing is how `tools.pinned: "exec"` becomes a
 * one-character tool list.
 */
export function parseSettingValue(raw: string): unknown {
    const text = raw.trim()
    if (text === "") return ""
    const doc = parseDocument(text)
    if (doc.errors.length > 0) {
        throw new HarnessError({
            code: "manifest_value_unreadable",
            message: `Cannot read ${JSON.stringify(raw)} as a value.`,
            hint: 'A bare word, a number, true or false, a list as ["a", "b"], or a map as {k: v}. Quote anything containing a colon or a "#".',
        })
    }
    return doc.toJS()
}

/**
 * The value at `path` in this manifest source, as plain JS. `undefined` when it is absent.
 *
 * Exists so a surface never has to parse YAML itself. `packages/cli` does not depend on a YAML parser
 * and should not start: how a manifest is represented is core's business, which is the whole reason the
 * writer moved here. A second parser in the CLI would be a second thing that has to agree about it.
 */
export function manifestValueAt(source: string, path: readonly string[]): unknown {
    return plain(parseDocument(source), path)
}

/**
 * The whole document as plain JS — unexpanded, unvalidated, exactly as written.
 *
 * For a reader that has to walk the file looking for a *shape* rather than a known path, which is how
 * the env variables a manifest depends on are found: `tokenEnv` and `apiKeyEnv` occur at several
 * depths and more will be added. Deliberately not `loadManifest`, which expands references and throws
 * when a variable is unset — the caller here is trying to find out which ones those are.
 */
export function manifestDocument(source: string): unknown {
    return parseDocument(source).toJS()
}

/** Read a path out of a parsed document as plain JS, so callers never handle YAML node types. */
export function plain(doc: ReturnType<typeof parseDocument>, path: readonly string[]): unknown {
    const found = doc.getIn([...path], false)
    if (found === undefined || found === null) return undefined
    return isMap(found) || isSeq(found) ? found.toJS(doc) : found
}

function manifestEditUnreadable(file: string, cause: unknown): HarnessError {
    return new HarnessError({
        code: "manifest_edit_unreadable",
        message: `Cannot read the manifest at ${file} to change it.`,
        hint: "Check the path and file permissions. Nothing was written.",
        cause,
    })
}

function manifestEditInvalid(path: string, detail: string): HarnessError {
    return new HarnessError({
        code: "manifest_edit_invalid",
        message: `Setting ${path} would make the manifest invalid: ${detail}`,
        hint: "Nothing was written. Check the value's shape — a list is [a, b], a map is {k: v} — against the field this path names.",
    })
}
