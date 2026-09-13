/**
 * Markdown → retrievable passages.
 *
 * The unit is **one list item, falling back to one heading section**, chosen because it is what both
 * writers of these files actually produce: `memory_write` emits `- **<stamp>** _(tags)_ text`, and a
 * person editing `MEMORY.md` by hand writes bullets under headings. A fixed token window would have
 * been more uniform for BM25's length normalisation and would cut mid-sentence, which matters here more
 * than usual — a retrieved fragment that has lost its stamp cannot be recency-ranked and cannot tell
 * the model *when* the fact was learned.
 *
 * ## What the unit costs, stated plainly
 *
 * BM25 normalises by document length against the corpus average, so a corpus mixing one-line bullets
 * with 400-word sections is a corpus where the average means less. That is accepted: the alternative
 * (uniform windows) buys tidier arithmetic and loses the self-dating property, and the whole point of
 * this tier is that a fact carries when it was learned.
 *
 * ## Two things that must not reach the model
 *
 * Frontmatter and HTML comments, for exactly the reason `workspace/load.ts` strips them: an archive
 * file may be hand-edited and commented, and a comment that reaches slot 7 is tokens the agent pays
 * for every matching turn, forever, for documentation it cannot use. `strip` and `withoutFrontmatter`
 * are shared with the workspace loader rather than reimplemented.
 *
 * Nothing here does I/O. The caller reads the file and supplies `source` and `fallbackAt`, which keeps
 * this a pure function of text and makes the whole splitter testable without a filesystem.
 */

import { derivedId } from "../ids.ts"
import { strip, withoutFrontmatter } from "../workspace/frontmatter.ts"

export interface Passage {
    /**
     * Derived from `text` alone, so the same note re-indexed after a file edit is the same row — and
     * so a note that has *moved* (from the carried file into an archive, which is what eviction does)
     * keeps its identity and only changes `source`.
     *
     * Deduplication across sources is therefore deliberate, not incidental: identical text in two files
     * is one fact, and injecting it twice would spend slot 7's budget saying the same thing.
     */
    readonly id: string
    /** Where it came from: a path relative to the memory root, or `session:<key>`. */
    readonly source: string
    /** The nearest enclosing heading, without its `#` marks. Scored and shown; absent at top level. */
    readonly heading?: string
    /** Verbatim as authored. Never rewritten — decision 4.19 applies to a retrieved note too. */
    readonly text: string
    /** When the fact was learned, RFC 3339. From its own stamp where it has one. */
    readonly at: string
    /** From `_(a, b)_`, as `memory_write` writes them. */
    readonly tags: readonly string[]
    /** True when `at` came from the passage's own stamp rather than from the caller's fallback. */
    readonly stamped: boolean
}

/** `- `, `* `, `+ `, `1. `, `1) ` at any indent. */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\S/
/** ATX headings only. Setext (`===` underlines) are not produced by anything that writes these files. */
const HEADING = /^(#{1,6})[ \t]+(.*\S)[ \t]*$/
/** `**2026-08-19T10:00:00Z**` — the stamp `memory_write` writes, anywhere in the passage. */
const STAMP = /\*\*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\*\*/
/** `_(project, boot)_` — italic parenthesised labels, as written by `memory_write`. */
const TAGS = /_\(([^)]*)\)_/

/**
 * `2026-08.md` → the first of that month; `2026-08-19.md` → that day.
 *
 * An archive file's name is a real signal about when its contents were learned, and it is the only one
 * available for a hand-written bullet nobody stamped. Month granularity resolves to day 1 rather than
 * to the middle or end of the month, which biases such a passage *older* — the safe direction, because
 * the recency boost can then only under-promote it. Guessing later would let an unstamped note
 * outrank a stamped one written after it.
 */
export function impliedDate(source: string): string | undefined {
    const name = source.split("/").pop() ?? source
    const day = /(\d{4})-(\d{2})-(\d{2})/.exec(name)
    if (day !== null) return `${day[1]}-${day[2]}-${day[3]}T00:00:00Z`
    const month = /(\d{4})-(\d{2})/.exec(name)
    if (month !== null) return `${month[1]}-${month[2]}-01T00:00:00Z`
    return undefined
}

export interface SplitInput {
    readonly text: string
    readonly source: string
    /**
     * Used for any passage carrying no stamp of its own — normally the file's mtime, which the caller
     * has and this function deliberately does not go and read.
     */
    readonly fallbackAt: string
}

/**
 * Split one markdown document into passages, in document order.
 *
 * A list item absorbs its continuation lines — a wrapped bullet, an indented sub-list, a fenced block
 * indented under it — and ends at the next item, the next heading, or a non-indented line. Prose
 * between headings accumulates into one passage per section. Everything else (blank runs, horizontal
 * rules, the stray `---`) contributes nothing rather than becoming an empty passage: a zero-term
 * document has a length of 0, and BM25's length normalisation divides by the corpus average, so empty
 * rows drag that average down and quietly inflate every real passage's score.
 */
export function splitPassages(input: SplitInput): readonly Passage[] {
    const body = strip(withoutFrontmatter(input.text))
    if (body === "") return []

    const lines = body.split(/\r?\n/)
    const out: Passage[] = []
    let heading: string | undefined
    let buffer: string[] = []
    /** Whether `buffer` is a list item (absorbing continuations) or a run of prose. */
    let inItem = false
    /** Indent of the open list item, so a continuation is recognised by being deeper. */
    let itemIndent = 0

    const flush = (): void => {
        const text = buffer.join("\n").trim()
        buffer = []
        inItem = false
        if (text === "") return
        out.push(passage(text, input, heading))
    }

    for (const line of lines) {
        const headingMatch = HEADING.exec(line)
        if (headingMatch !== null) {
            flush()
            heading = headingMatch[2]
            continue
        }

        const itemMatch = LIST_ITEM.exec(line)
        if (itemMatch !== null) {
            const indent = (itemMatch[1] ?? "").replace(/\t/g, "    ").length
            // A *deeper* marker is a sub-list, which belongs to the item above it. Testing the indent
            // before opening a new passage is the whole difference between "one note with its detail"
            // and four fragments, three of which are unintelligible alone.
            if (inItem && indent > itemIndent) {
                buffer.push(line)
                continue
            }
            flush()
            inItem = true
            itemIndent = indent
            buffer.push(line)
            continue
        }

        if (inItem) {
            // A blank line inside an item is kept only if something indented follows; holding it in the
            // buffer and trimming on flush achieves that without lookahead.
            if (line.trim() === "") {
                buffer.push(line)
                continue
            }
            const indent = line.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0
            if (indent > itemIndent) {
                buffer.push(line)
                continue
            }
            // Back at or left of the marker: the item is over and this line starts prose.
            flush()
            buffer.push(line)
            continue
        }

        buffer.push(line)
    }
    flush()

    return out
}

function passage(text: string, input: SplitInput, heading: string | undefined): Passage {
    const stamp = STAMP.exec(text)?.[1]
    const tagged = TAGS.exec(text)?.[1] ?? ""
    const tags = tagged
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "")

    const at = stamp ?? impliedDate(input.source) ?? input.fallbackAt

    return {
        id: derivedId("mem", text),
        source: input.source,
        ...(heading === undefined ? {} : { heading }),
        text,
        at,
        tags,
        stamped: stamp !== undefined,
    }
}

/** Metadata fields are weighted before BM25's saturation by repeating their terms in the document. */
const HEADING_WEIGHT = 2
const TAG_WEIGHT = 2

/**
 * What BM25 actually scores: weighted metadata fields, then the passage with its markers removed.
 *
 * A bullet is frequently useless without its heading — "prefers tabs" retrieves on nothing while
 * "Formatting / prefers tabs" retrieves on `formatting`. Tags are explicit author-supplied retrieval
 * keys, so they are scored rather than carried only for display. Repeating each field before
 * tokenisation applies its weight to term frequency *before* BM25's saturation; adding an independent
 * metadata score afterwards would put the result on a second, uncalibrated scale.
 *
 * ## The stamp is removed, and the reason is *not* the one it looks like
 *
 * `**2026-06-02T10:00:00Z**` tokenises to five terms — `2026`, `06`, `02t10`, `00`, `00z` — beside a note
 * whose content is six. The obvious conclusion is that half of every document was a timestamp and scores
 * suffered for it. **Measured, that is wrong**: BM25 normalises a document's length against the *corpus
 * average*, and every passage carries a stamp, so removing them all moves the length and the average
 * together. Live on a real corpus the change was 0.278 → 0.284 — noise.
 *
 * It is kept for the reasons that survive measurement, which are smaller and real: the index holds only
 * content, `length` means what it says, and a query containing digits cannot match a timestamp in every
 * note. Written down this way because the tempting version of this comment claims a score improvement
 * that does not exist, and a false number in a docstring outlives the person who guessed it.
 *
 * Both markers are stripped from the *indexed* form only: `text` stays byte-identical for injection,
 * because decision 4.19 forbids the renderer rewriting an authored sentence and a retrieved note is an
 * authored sentence.
 */
export function document(passage: Passage): string {
    const body = passage.text.replace(STAMP, "").replace(TAGS, "")
    const fields = [
        ...(passage.heading === undefined
            ? []
            : Array.from({ length: HEADING_WEIGHT }, () => passage.heading as string)),
        ...Array.from({ length: TAG_WEIGHT }, () => passage.tags.join(" ")),
        body,
    ]
    return fields.filter((field) => field !== "").join("\n")
}
