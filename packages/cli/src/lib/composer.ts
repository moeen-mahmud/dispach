/**
 * The composer's visual rows and where the caret sits on them. Pure, so the layout is arithmetic.
 *
 * ## Why the input box needs its own wrapping at all
 *
 * It rendered each logical line with `wrap="truncate"` and no wrapping of its own, which is half of the
 * rule `lib/wrap.ts` states and the half that does not work. Ink truncates to the width Yoga measured,
 * and a `<Box>` with no explicit width takes its *content* width — so a long message made the box wider
 * than the terminal, and what happened next was the terminal's decision rather than ours. Measured at 100
 * columns: VS Code cut the line at the border and took the caret with it, so you could not see what you
 * were typing; Warp wrapped the over-wide row and the tail landed on top of the right-hand border. One
 * cause, two symptoms, and neither reproducible in the other terminal.
 *
 * So the composer wraps its own text, exactly as the transcript and the live pane do, and every row is
 * drawn `wrap="truncate"` as a backstop rather than as the layout.
 *
 * ## One column is reserved, deliberately
 *
 * The caret is drawn as an inverse cell, so it needs a cell — including when it sits at the end of a line
 * that exactly fills the row. Wrapping to `columns - 1` buys that cell once, for every row, with no
 * special case; the alternative is an extra visual row that appears and disappears as you type past the
 * edge, which moves the whole frame on a surface that has no room to move.
 *
 * ## One derivation, two callers
 *
 * `LineCursor` draws these rows and `chat-frame.promptRows` counts them. That is the pairing the repo has
 * been bitten by before — a component that grows a row without the frame arithmetic knowing is a frame
 * taller than the terminal, which on the alternate buffer is corruption rather than crowding. Here the
 * count is `layout.rows.length` plus the notices, by construction.
 */

import { lineInfo } from "#editor"
import type { EditorState } from "#lib/types"
import { expandColumn, wrapRows } from "#lib/wrap"

/** A cell reserved so the caret has somewhere to sit at the end of a full row. */
const CARET_CELL = 1

export interface ComposerRow {
    /** What is painted, hanging indent included. Never wider than the window. */
    readonly text: string
    /** Where the caret sits in this row, or `undefined` when it is on another row. */
    readonly caret: number | undefined
    /**
     * Buffer-absolute code-point offsets of the source this row draws, `start` inclusive and `end` not.
     *
     * Absolute rather than line-relative, which is the only form a selection can use: `wrapRows` reports
     * offsets into a single *line*, and a selection is a range over the whole buffer. Adding the line's own
     * start here is the one place that translation belongs — a renderer recomputing it would need the
     * split, the tab expansion and the wrap all over again to get the same number.
     */
    readonly start: number
    readonly end: number
    /** Columns of `text` that are re-applied indent, which no selection may highlight. */
    readonly lead: number
}

/** A run of a row that is drawn the same way: selected or not, caret or not. */
export interface RowSegment {
    readonly text: string
    readonly selected: boolean
    /** The single cell the caret inverts. Never wider than one code point. */
    readonly caret: boolean
}

export interface ComposerLayout {
    /** Every visual row of the buffer, in order. At least one, even for an empty buffer. */
    readonly rows: readonly ComposerRow[]
    /** Index into `rows` holding the caret. */
    readonly caretRow: number
}

/**
 * Every visual row of `editor`'s buffer at `columns`, and which one the caret is on.
 *
 * `columns` is the width available *inside* whatever draws it — a caller with a border and padding
 * subtracts those first, because this cannot see them.
 */
export function composerLayout(editor: EditorState, columns: number): ComposerLayout {
    const width = Math.max(1, columns - CARET_CELL)
    const lines = editor.value.split("\n")
    const cursor = lineInfo(editor)

    const rows: ComposerRow[] = []
    let caretRow = 0
    // Where each line starts in the buffer, in code points. The `+ 1` is the newline itself, which no row
    // draws and every offset after it has to account for.
    let base = 0
    for (const [at, line] of lines.entries()) {
        const wrapped = wrapRows(line, width)
        // The caret's column has to be translated into the same tab-expanded coordinates the rows are
        // measured in, or a line containing a tab puts it seven columns to the left of where it is.
        const column = at === cursor.line ? expandColumn(line, cursor.column) : -1
        // Walked backwards so a caret exactly on a break lands at the *end* of the earlier row rather
        // than the start of the later one, which is where a person expects it after pressing → .
        let on = -1
        if (column >= 0) {
            on = wrapped.length - 1
            for (const [n, row] of wrapped.entries()) {
                if (column <= row.to) {
                    on = n
                    break
                }
            }
        }
        for (const [n, row] of wrapped.entries()) {
            if (n === on) caretRow = rows.length
            rows.push({
                start: base + row.from,
                end: base + row.to,
                lead: row.lead,
                text: row.text,
                // Clamped into the row: a caret past `to` can only mean the source column sat in the
                // whitespace a break consumed, and the end of the row is the honest place for it.
                caret:
                    n === on
                        ? row.lead + Math.max(0, Math.min(column - row.from, row.to - row.from))
                        : undefined,
            })
        }
        base += [...line].length + 1
    }
    return { rows, caretRow }
}

/**
 * One row, split into the runs a renderer can paint in one go.
 *
 * Built as runs rather than as three slices because the caret can sit anywhere — including inside the
 * selection — and slicing for both produces overlapping ranges that have to be reconciled. Walking the row
 * once and grouping adjacent code points by how they are drawn has no such case, and the caret staying
 * exactly one cell wide is a property of the walk rather than something to remember.
 *
 * The indent is never selected. Those columns are chrome the wrap re-applied; highlighting them would
 * suggest text is included that no offset in the buffer corresponds to.
 */
export function rowSegments(
    row: ComposerRow,
    selection: { readonly start: number; readonly end: number } | undefined,
): readonly RowSegment[] {
    const cells = [...row.text]
    const segments: RowSegment[] = []
    for (const [column, cell] of cells.entries()) {
        // A column past the indent maps back to the source by the same arithmetic the caret uses; one
        // inside it maps to nothing, which is why it can never be selected.
        const offset = column < row.lead ? -1 : row.start + (column - row.lead)
        const isSelected =
            selection !== undefined && offset >= selection.start && offset < selection.end
        const isCaret = row.caret === column
        const last = segments.at(-1)
        // The caret is its own run always, so it stays one cell wide even in the middle of a selection.
        if (last !== undefined && !isCaret && !last.caret && last.selected === isSelected) {
            segments[segments.length - 1] = { ...last, text: last.text + cell }
            continue
        }
        segments.push({ text: cell, selected: isSelected, caret: isCaret })
    }
    // A caret past the last character has no cell to invert, so it needs one. Same reason `LineCursor`
    // inverts a trailing space today.
    if (row.caret !== undefined && row.caret >= cells.length) {
        segments.push({ text: " ", selected: false, caret: true })
    }
    return segments
}
