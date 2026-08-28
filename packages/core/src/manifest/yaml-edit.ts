/**
 * Changing one setting in a YAML file without touching a byte of the rest of it.
 *
 * ## Why a line editor and not the obvious round-trip
 *
 * `parseDocument` → `setIn` → `String(doc)` is four lines, keeps comments, and was the first
 * implementation. It also **reflows the whole file**, and the damage is worse than it sounds. A
 * comment block sitting between two top-level keys is attached by the parser to the *end of the
 * first* one, so re-emitting it puts a section header inside the section above it, indented two
 * spaces. Aligned trailing comments lose their alignment. Blank lines move.
 *
 * Measured on a generated manifest: one `config_set` call produced a 30-line diff for a one-line
 * change. The manifest is the file a person reads to understand their agent, and "your comments
 * survived, in different places, at different indentation" is not preserving it.
 *
 * So the value is edited **in the source text**, and the document parse is kept for what it is
 * genuinely good at — validating the result before anything is written.
 *
 * ## Scope, deliberately narrow
 *
 * Two-or-three-level dotted paths whose values are scalars or lists of strings. That is exactly the
 * settable set and no more. Anything this cannot place with certainty returns `undefined` rather than
 * guessing, and the caller falls back to the round-trip — a reflowed file being strictly better than a
 * wrong one.
 */

import { parse } from "yaml"

/**
 * How a value is written into the file. Nothing else is settable, so nothing else is handled.
 *
 * Quoted only when it has to be. A bare `system` reads the way a person would have typed it, and a
 * value containing a comment marker or a colon would silently change meaning unquoted.
 *
 * **The first character is a separate question from the rest**, and conflating them was a real bug.
 * `@` was in the one permitted set, so a Telegram handle wrote as `- @moeen_m` — and `@` is a *reserved
 * indicator* in YAML, meaning a plain scalar may not begin with one. The file stopped parsing. Latent
 * since Phase 3.6 and invisible until `allowFrom` became the first field whose values start with `@`.
 *
 * So the body keeps the permissive set and the opener is restricted to characters that cannot be read
 * as structure: `~` is null, `-` is a sequence entry, `@` and a backtick are reserved, and `?`, `:`,
 * `#`, `&`, `*`, `!`, `|`, `>`, `%`, `[`, `]`, `{`, `}` and the quotes are all indicators. Everything
 * ruled out here is merely *quoted*, never rejected.
 */
function renderScalar(value: unknown): string {
    if (typeof value !== "string") return String(value)

    const safeThroughout = /^[A-Za-z0-9_./@~-]+$/.test(value)
    const safeOpener = /^[A-Za-z0-9_./]/.test(value)
    if (!safeThroughout || !safeOpener) return JSON.stringify(value)

    // The character classes above decide whether the text can be written bare *as text*. They say
    // nothing about what it comes back **as**, and that is a separate failure: `"1"` passes both,
    // is written bare, and parses back as the number 1. Measured — a schedule delivering to a
    // Telegram chat id, which is the normal value for that field, was refused with
    // `schedules.0.deliver: Invalid input`, a schema message pointing nowhere near the renderer that
    // caused it. `"true"`, `"null"` and `"0x10"` are the same bug wearing different clothes.
    //
    // So the question is asked of the parser rather than answered from a table of YAML's resolvers:
    // write it bare, read it back, and quote unless the identical string returns. The same library
    // with the same options that `parseDocument` uses two functions down, which is what makes this
    // the real question rather than an approximation of it — and it cannot go stale the way an
    // enumerated list of "0b, 0o, 0x, yes, no, on, off" would, which is the shape of mistake this
    // file's own history warns about.
    try {
        return parse(value) === value ? value : JSON.stringify(value)
    } catch {
        return JSON.stringify(value)
    }
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length
}

function isBlankOrComment(line: string): boolean {
    const trimmed = line.trim()
    return trimmed === "" || trimmed.startsWith("#")
}

/** The line index of `key` at `indent`, searching from `from` until the block ends. */
function findKey(
    lines: readonly string[],
    key: string,
    indent: number,
    from: number,
): number | undefined {
    const pattern = new RegExp(`^\\s{${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`)
    for (let i = from; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (isBlankOrComment(line)) continue
        // Dedent past this block: the key is not here.
        if (indentOf(line) < indent) return undefined
        if (indentOf(line) === indent && pattern.test(line)) return i
    }
    return undefined
}

/** The last line belonging to the block that starts at `start`, comments and blanks excluded. */
function endOfBlock(lines: readonly string[], start: number, indent: number): number {
    let last = start
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (isBlankOrComment(line)) continue
        if (indentOf(line) <= indent) break
        last = i
    }
    return last
}

/**
 * The trailing `# …` on a line, whitespace run included, or empty.
 *
 * The run matters: `dialect: nlt   # never auto-detected` is aligned with its neighbours, and returning
 * the comment without the spaces in front of it collapses the column on every edited line. Quotes are
 * tracked because a `#` inside a policy rule — `deny: ["exec(rm #)"]` — is a value and not a comment,
 * and treating it as one would silently truncate the rule.
 */
function trailingComment(line: string): string {
    let quote: string | undefined
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i]
        if (quote !== undefined) {
            if (char === quote) quote = undefined
            continue
        }
        if (char === '"' || char === "'") {
            quote = char
            continue
        }
        if (char !== "#" || i === 0 || !/\s/.test(line[i - 1] ?? "")) continue
        let start = i
        while (start > 0 && /\s/.test(line[start - 1] ?? "")) start -= 1
        return line.slice(start)
    }
    return ""
}

/** A value that is neither a scalar nor an array — `tools.providers` and each block inside it. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function renderBlock(key: string, value: unknown, indent: number): string[] {
    const pad = " ".repeat(indent)
    if (Array.isArray(value)) {
        if (value.length === 0) return [`${pad}${key}: []`]
        return [
            `${pad}${key}:`,
            ...value.flatMap((entry) => renderSequenceEntry(entry, indent + 2)),
        ]
    }
    // Maps became settable with `tools.providers`, and until they were handled here every value fell
    // through to `String(value)` and wrote the literal text `[object Object]` — which the schema then
    // rejected as "expected record, received array", a message pointing nowhere near the cause.
    if (isPlainObject(value)) {
        const entries = Object.entries(value)
        if (entries.length === 0) return [`${pad}${key}: {}`]
        return [
            `${pad}${key}:`,
            ...entries.flatMap(([nested, inner]) => renderBlock(nested, inner, indent + 2)),
        ]
    }
    return [`${pad}${key}: ${renderScalar(value)}`]
}

/**
 * One entry of a sequence, which may be a scalar or a map.
 *
 * The map case is the third appearance of one bug: an entry that is not a scalar used to go through
 * `renderScalar` and write the literal text `[object Object]`. It was fixed for a *value* when
 * `tools.providers` became settable and had to be fixed again here when `channels` did — an array of
 * maps is neither of the two shapes that were handled. The lesson is the general one: whenever a new
 * settable path has a shape this renderer has not seen, the failure is silent YAML that the schema
 * then rejects with a message pointing nowhere near the cause.
 */
function renderSequenceEntry(entry: unknown, indent: number): string[] {
    const pad = " ".repeat(indent)
    if (!isPlainObject(entry)) return [`${pad}- ${renderScalar(entry)}`]

    const entries = Object.entries(entry)
    if (entries.length === 0) return [`${pad}- {}`]

    // Children are rendered at this indent, then the first line's padding is replaced by the dash —
    // which is what puts every key of the entry in the same column, including a nested block's.
    const rendered = entries.flatMap(([key, nested]) => renderBlock(key, nested, indent + 2))
    const [first, ...rest] = rendered
    return [`${pad}- ${(first ?? "").trimStart()}`, ...rest]
}

/**
 * Set a dotted path in YAML source, or return `undefined` if it cannot be done confidently.
 *
 * `undefined` is not a failure — it is the honest answer that this editor is too simple for the file
 * in front of it, and the caller has a correct-but-reflowing fallback.
 */
export function setInSource(
    source: string,
    path: readonly string[],
    value: unknown,
): string | undefined {
    if (path.length === 0) return undefined
    const lines = source.split("\n")

    // Walk as far down the chain as the file actually goes, tracking where each level's block starts
    // and how deep its children sit. Stopping early is normal rather than a failure: `providerConfig`
    // is commented out in every generated manifest, so `tools.providerConfig.writeRoots` has a
    // missing *intermediate* on the very first call anyone makes.
    let searchFrom = 0
    let indent = 0
    let parent: number | undefined
    let depth = 0
    for (; depth < path.length - 1; depth += 1) {
        const at = findKey(lines, path[depth] ?? "", indent, searchFrom)
        if (at === undefined) break
        parent = at
        searchFrom = at + 1
        // The child indent is whatever the first child actually uses, not an assumed two spaces — a
        // file indented with four would otherwise get a mixed one.
        const firstChild = lines
            .slice(at + 1)
            .find((line) => !isBlankOrComment(line) && indentOf(line) > indent)
        if (firstChild === undefined) return undefined
        indent = indentOf(firstChild)
    }

    // A missing intermediate: everything from here down is written as one nested block, inserted at
    // the end of the deepest parent that does exist.
    if (depth < path.length - 1) {
        if (parent === undefined) return undefined
        const insertAt = endOfBlock(lines, parent, indent - 1) + 1
        return [
            ...lines.slice(0, insertAt),
            ...renderNested(path.slice(depth), value, indent),
            ...lines.slice(insertAt),
        ].join("\n")
    }

    const leaf = path[path.length - 1] ?? ""
    const existing = findKey(lines, leaf, indent, searchFrom)

    if (existing !== undefined) {
        const line = lines[existing] ?? ""
        // Only a scalar keeps its trailing comment. A list or a map moves the value onto child lines,
        // so `# refuse | confirm | allow` would end up annotating a key rather than the value it
        // describes — and a comment attached to the wrong thing is worse than one that was dropped.
        const comment = Array.isArray(value) || isPlainObject(value) ? "" : trailingComment(line)
        const end = endOfBlock(lines, existing, indent)
        const replacement = renderBlock(leaf, value, indent)
        if (comment !== "") replacement[0] = `${replacement[0]}${comment}`
        return [...lines.slice(0, existing), ...replacement, ...lines.slice(end + 1)].join("\n")
    }

    // Missing leaf, parent present: appended to the end of its parent's block. Inserting at the end of
    // the *file* would put a `tools:` child outside `tools`.
    if (parent === undefined) return undefined
    const insertAt = endOfBlock(lines, parent, indent - 1) + 1
    return [
        ...lines.slice(0, insertAt),
        ...renderBlock(leaf, value, indent),
        ...lines.slice(insertAt),
    ].join("\n")
}

/** `["providerConfig", "writeRoots"]` → the two nested lines that create both. */
function renderNested(keys: readonly string[], value: unknown, indent: number): string[] {
    const [head, ...rest] = keys
    if (head === undefined) return []
    if (rest.length === 0) return renderBlock(head, value, indent)
    return [`${" ".repeat(indent)}${head}:`, ...renderNested(rest, value, indent + INDENT_STEP)]
}

/** Two spaces, matching every file this project generates. Only used for levels being created. */
const INDENT_STEP = 2

/**
 * Replace a commented-out top-level block with a real one, in place.
 *
 * `setInSource` appends to a parent, and a top-level key has none, so it declines every block the
 * generated manifest ships commented — `channels`, `delivery`, `phases`, `skills`. The round-trip then
 * ran, and it is expensive in exactly the way decision 4.51 describes: measured on a generated manifest,
 * writing `channels` for the first time changed **98 lines**, indenting `# ── context ──` four spaces
 * inside `model:` and collapsing every aligned trailing comment in the file.
 *
 * Uncommenting is better than appending on its own merits, too. The generated manifest documents each
 * block where it belongs, under a heading explaining it, and *that uncommenting works is the file's
 * whole premise* — a block appended at the bottom instead leaves the documentation describing something
 * that is now defined somewhere else.
 *
 * Children are the commented lines indented under it: `#` then two or more spaces. One space is a
 * different key, which is what stops the run at `# delivery:` after `# channels:`.
 */
export function uncommentInSource(source: string, key: string, value: unknown): string | undefined {
    const lines = source.split("\n")
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const opener = new RegExp(`^#\\s*${escaped}\\s*:`)
    const at = lines.findIndex((line) => opener.test(line))
    if (at === -1) return undefined

    let end = at
    while (/^#\s{2,}\S/.test(lines[end + 1] ?? "")) end += 1

    // A phase heading immediately above becomes a lie the moment the block is live: "# Phase 5 —
    // skills" over a configured one reads as a phase that has not shipped. Only that shape, and only
    // directly above — prose explaining the block is the author's and stays.
    const from = /^#\s*Phase \d/.test(lines[at - 1] ?? "") ? at - 1 : at

    return [...lines.slice(0, from), ...renderBlock(key, value, 0), ...lines.slice(end + 1)].join(
        "\n",
    )
}
