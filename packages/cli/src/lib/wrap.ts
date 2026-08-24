/**
 * Breaking text into the rows a fixed-width window will draw.
 *
 * ## One wrapping, ours
 *
 * This module used to count rows the way a terminal does — divide the character count by the width — and
 * hand the text to Ink to wrap. Those are two different answers to one question, and the difference is not
 * academic: Ink breaks at spaces, so 240 characters at 80 columns is **four** rows to Ink and three to a
 * division. Every cap built on the division was therefore one row short of what appeared on screen, which
 * on the alternate buffer is a frame taller than the terminal.
 *
 * So the rule is that whoever owns a bounded window wraps the text itself and renders each row with
 * `wrap="truncate"`. The count is then the count, by construction, and a frame test asserts it against a
 * real render rather than trusting the arithmetic.
 *
 * Tabs are expanded to spaces on the way through. A tab's width is the terminal's business and not ours,
 * so a row containing one cannot be measured — expanding it is the only way the number we counted is the
 * number drawn. It changes bytes, never meaning, which is the line decision 4.27 draws.
 */

const TAB_WIDTH = 8
const TAB = " ".repeat(TAB_WIDTH)

import { cellWidths } from "#lib/width"

/**
 * One drawn row, and which source characters it drew.
 *
 * The offsets exist because a row's text is **not** a slice of its line. Breaking at a space consumes
 * the space, a word longer than the window is cut, and a hanging indent is re-applied to rows that never
 * contained it — so "which row is source offset 41 on, and at what column" cannot be recovered from the
 * strings afterwards. Anything that draws a caret over wrapped text needs exactly that, and computing it
 * a second time from the finished rows is how a cursor ends up a column out on the lines that wrapped.
 */
export interface WrappedRow {
    /** Exactly what is painted, the re-applied indent included. */
    readonly text: string
    /** Columns of `text` that are indent. A caret never lands to the left of this. */
    readonly lead: number
    /** Source code-point offset of this row's first drawn character. */
    readonly from: number
    /** One past this row's last drawn character. A break at a space leaves a gap before the next `from`. */
    readonly to: number
}

/**
 * One logical line, broken at spaces to fit `columns`, with the source offsets kept.
 *
 * A word longer than the whole width is cut rather than allowed to overflow — a URL or a base64 blob is
 * the normal case for that, and there is nowhere better to break it. Returns one row for an empty line,
 * because a blank line in a reply is a blank row on screen and dropping it would close up paragraphs the
 * model deliberately separated.
 */
export function wrapRows(line: string, columns: number): readonly WrappedRow[] {
    // Tabs are expanded before anything is measured, so offsets are into the *expanded* line. A caller
    // placing a caret has to expand its own column the same way, which `expandColumn` is for.
    const flat = line.replaceAll("\t", TAB)
    const all = [...flat]
    // Widths per cell, computed once. Every measurement below is a sum over this rather than a count of
    // code points: an emoji is one code point and two columns, so counting made `"👍".repeat(10)` measure
    // ten and draw twenty. Offsets stay in code points, because that is what a caller slices with.
    const w = cellWidths(all)
    const span = (from: number, to: number): number => {
        let total = 0
        for (let at = from; at < to; at += 1) total += w[at] ?? 0
        return total
    }
    if (columns <= 0 || span(0, all.length) <= columns) {
        return [{ text: flat, lead: 0, from: 0, to: all.length }]
    }

    // Leading whitespace is structure, and splitting on spaces destroys it.
    //
    // Found live: `/help`'s output indents each entry by two spaces, and every line short enough to fit kept
    // them while every line that wrapped lost them — so one list came out at two different indents depending
    // on how long each summary happened to be. Held aside here and re-applied to every row, which also gives
    // a wrapped indented block a hanging indent rather than a ragged left edge.
    let indent = 0
    while (indent < all.length && (all[indent] === " " || all[indent] === "\u00a0")) indent += 1
    if (indent > 0) {
        const body = all.slice(indent).join("")
        // An indent as wide as the window is dropped rather than honoured: keeping it would leave no room
        // for the text, and shrinking the width to fit it recurses forever. The recursion terminates either
        // way, because `body` cannot begin with a space.
        if (indent >= columns) {
            return wrapRows(body, columns).map((row) => ({
                ...row,
                from: row.from + indent,
                to: row.to + indent,
            }))
        }
        const pad = " ".repeat(indent)
        return wrapRows(body, columns - indent).map((row) => ({
            text: `${pad}${row.text}`,
            lead: row.lead + indent,
            from: row.from + indent,
            to: row.to + indent,
        }))
    }

    const rows: WrappedRow[] = []
    // `at` is where the pending row starts in the source; `width` is how much of it is drawn so far.
    let at = 0
    let width = 0
    const push = (to: number) => {
        rows.push({ text: all.slice(at, to).join(""), lead: 0, from: at, to })
    }
    let cursor = 0
    while (cursor <= all.length) {
        // The next word, and the single space that introduced it. A run of spaces is not collapsed —
        // only the one space a break consumes is, which is what keeps the offsets honest.
        let end = cursor
        while (end < all.length && all[end] !== " ") end += 1
        const word = span(cursor, end)

        if (word > columns) {
            // Longer than any row can hold. Flush what is pending, then cut it into full rows.
            if (width > 0) {
                push(cursor === at ? cursor : cursor - 1)
                at = cursor
                width = 0
            }
            let take = cursor
            while (span(take, end) > columns) {
                // Advance by *columns*, not by cells. A cut that would land inside a double-width
                // character stops before it, which is why the row can come out one column short: half an
                // emoji is not a thing a terminal can draw, and drawing it anyway is how a row overflows.
                let stop = take
                let filled = 0
                while (stop < end && filled + (w[stop] ?? 0) <= columns) {
                    filled += w[stop] ?? 0
                    stop += 1
                }
                // A single character wider than the whole window would otherwise loop forever taking
                // nothing. Emit it alone and overflow by one column, which is the only option left.
                if (stop === take) stop = take + 1
                at = take
                push(stop)
                take = stop
                at = take
            }
            at = take
            width = span(take, end)
        } else if (width > 0 && width + 1 + word > columns) {
            // Does not fit beside what is already on this row. The space before it is the break and is
            // drawn by neither row, which is why `to` and the next `from` are not the same number.
            push(cursor - 1)
            at = cursor
            width = word
        } else {
            width = width === 0 ? word : width + 1 + word
        }

        if (end >= all.length) break
        cursor = end + 1
    }
    push(all.length)
    return rows
}

function wrapLine(line: string, columns: number): readonly string[] {
    return wrapRows(line, columns).map((row) => row.text)
}

/** A code-point column in `line` translated into the tab-expanded coordinates `wrapRows` reports. */
export function expandColumn(line: string, column: number): number {
    let out = 0
    for (const [at, ch] of [...line].entries()) {
        if (at >= column) break
        out += ch === "\t" ? TAB_WIDTH : 1
    }
    return out
}

/** Every row `text` occupies at `columns`, newlines respected and long lines broken. */
export function wrapText(text: string, columns: number): readonly string[] {
    return text.split("\n").flatMap((line) => wrapLine(line, columns))
}

/**
 * The live pane: the rows to draw, how tall that makes it, and how much was dropped.
 *
 * Height-capped on purpose. Ink erases and redraws its whole dynamic tree per frame, so an uncapped pane
 * means redrawing the entire reply on every token — a cost that grows with the length of the answer,
 * precisely when the terminal is busiest. The newest rows are the ones kept, because they are what the
 * reader is looking at, and nothing is lost: the finished reply joins the transcript at `turn.end`.
 *
 * All three numbers from one wrap, because they were computed separately and disagreed. The component
 * needs the rows and the dropped count; the chat frame needs the height to subtract from the terminal
 * *before* the pane renders. Deriving them apart meant the notice's own row was counted by one caller and
 * not the other, which is a layout one row taller than the screen.
 */
export interface LivePane {
    /** What to draw, newest last. Already wrapped, so each is one row. */
    readonly lines: readonly string[]
    /** Rows the pane occupies, the "… n hidden" notice included. Zero when there is nothing to show. */
    readonly rows: number
    /** Rows dropped off the top. Non-zero is exactly the condition for drawing the notice. */
    readonly hidden: number
}

export function livePane(text: string, columns: number, maxRows: number): LivePane {
    if (text === "" || maxRows <= 0) return { lines: [], rows: 0, hidden: 0 }
    const all = wrapText(text, columns)
    if (all.length <= maxRows) return { lines: all, rows: all.length, hidden: 0 }
    // The extra row is the notice itself.
    return {
        lines: all.slice(all.length - maxRows),
        rows: maxRows + 1,
        hidden: all.length - maxRows,
    }
}
