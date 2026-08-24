/**
 * Selecting text in the transcript with the mouse.
 *
 * ## Buffer coordinates, and why that is the whole design
 *
 * The reference CLI keeps its selection in *screen* coordinates against a viewport-sized cell grid, and
 * roughly forty per cent of its state exists to survive that choice: two accumulators for rows that
 * scrolled out of the grid mid-drag, two parallel soft-wrap bitmaps to go with them, a pre-clamp anchor
 * row, and a function to capture rows before they are overwritten. All of it because the text is gone once
 * it leaves the viewport, so the selection has to hoard it.
 *
 * We never lose the text. The transcript is `readonly TranscriptRow[]` for the whole conversation with a
 * window over it, so a selection stored as `{row, column}` into *that* array needs none of those fields: it
 * is stable while the view scrolls, because scrolling only moves the window, and a copy is a substring of
 * data still in hand. Drag-to-scroll is then free rather than the hardest case.
 *
 * ## What it deliberately does not do
 *
 * Rectangular selection. Terminals select linearly — from a point, through every intervening row, to
 * another point — and a block selection is a different gesture with no way to ask for it here.
 */

import type { TranscriptRow } from "#lib/types"

/** A position in the row buffer. `column` indexes code points of that row's `text`. */
export interface TextPoint {
    readonly row: number
    readonly column: number
}

export interface TextSelection {
    /** Where the press happened. */
    readonly anchor: TextPoint
    /** Where the pointer is now. Equal to `anchor` until the first motion. */
    readonly focus: TextPoint
    /** True between press and release, which is what tells a finished selection from a live drag. */
    readonly dragging: boolean
}

/** Begin a selection at a point. Focus starts equal to anchor, so a bare click selects nothing. */
export function beginSelection(at: TextPoint): TextSelection {
    return { anchor: at, focus: at, dragging: true }
}

/** Move the focus. A no-op once the drag has finished, so a stray motion report cannot resurrect it. */
export function dragSelection(selection: TextSelection, to: TextPoint): TextSelection {
    if (!selection.dragging) return selection
    return { ...selection, focus: to }
}

/** Keep the range and stop tracking, so the highlight stays up and the text can be copied. */
export function endSelection(selection: TextSelection): TextSelection {
    return { ...selection, dragging: false }
}

/** Extend an existing selection to a point, as shift-click does. */
export function extendSelection(selection: TextSelection, to: TextPoint): TextSelection {
    return { ...selection, focus: to, dragging: false }
}

function before(left: TextPoint, right: TextPoint): boolean {
    return left.row < right.row || (left.row === right.row && left.column <= right.column)
}

/** The range in reading order, or `undefined` when nothing is selected. */
export function textBounds(
    selection: TextSelection | undefined,
): { readonly start: TextPoint; readonly end: TextPoint } | undefined {
    if (selection === undefined) return undefined
    const { anchor, focus } = selection
    if (anchor.row === focus.row && anchor.column === focus.column) return undefined
    return before(anchor, focus) ? { start: anchor, end: focus } : { start: focus, end: anchor }
}

/**
 * Which columns of one row are selected, or `undefined` if none are.
 *
 * Clamped to the row's own length by the caller's `cells`, because a drag that runs off the end of a short
 * row must select to its end rather than to the pointer's column — which is what makes dragging down
 * through ragged text feel like one continuous sweep.
 */
export function rowSelection(
    selection: TextSelection | undefined,
    row: number,
    cells: number,
): { readonly from: number; readonly to: number } | undefined {
    const bounds = textBounds(selection)
    if (bounds === undefined) return undefined
    if (row < bounds.start.row || row > bounds.end.row) return undefined
    const from = row === bounds.start.row ? Math.min(bounds.start.column, cells) : 0
    const to = row === bounds.end.row ? Math.min(bounds.end.column, cells) : cells
    return to <= from ? undefined : { from, to }
}

/**
 * The selected text, with wrapped rows rejoined into the lines they came from.
 *
 * A row's `continuation` flag is what makes this a copy of the *source* rather than of the layout: without
 * it, pasting a wrapped paragraph would carry the newlines this renderer invented. The role prefix is
 * dropped for the same reason — `› ` and `  · ` are chrome nobody typed.
 *
 * Trailing whitespace goes per logical line, not per row, so a break that consumed a space does not leave
 * one behind in the middle of a rejoined sentence.
 */
export function selectedText(
    rows: readonly TranscriptRow[],
    selection: TextSelection | undefined,
): string {
    const bounds = textBounds(selection)
    if (bounds === undefined) return ""
    const lines: string[] = []
    for (let row = bounds.start.row; row <= bounds.end.row; row += 1) {
        const current = rows[row]
        if (current === undefined) continue
        const cells = [...current.text]
        const range = rowSelection(selection, row, cells.length)
        // A row with nothing selected still counts as a line break when it is inside the range: a blank
        // row between two turns is a blank line in what gets pasted.
        const text =
            range === undefined
                ? ""
                : cells.slice(Math.max(range.from, current.lead), range.to).join("")
        if (current.continuation && lines.length > 0) {
            lines[lines.length - 1] += text
            continue
        }
        lines.push(text)
    }
    return lines.map((line) => line.replace(/\s+$/, "")).join("\n")
}

/** Word characters, matching the composer's own idea of a word so a double-click agrees with `⌥←`. */
function isWordChar(char: string | undefined): boolean {
    return char !== undefined && !/\s/.test(char)
}

/** The word under a point, as a selection. Falls back to the whole row when the point is whitespace. */
export function wordAt(rows: readonly TranscriptRow[], at: TextPoint): TextSelection {
    const row = rows[at.row]
    if (row === undefined) return { anchor: at, focus: at, dragging: false }
    const cells = [...row.text]
    if (!isWordChar(cells[at.column])) return lineAt(rows, at)
    let from = at.column
    let to = at.column
    while (from > row.lead && isWordChar(cells[from - 1])) from -= 1
    while (to < cells.length && isWordChar(cells[to])) to += 1
    return {
        anchor: { row: at.row, column: from },
        focus: { row: at.row, column: to },
        dragging: false,
    }
}

/** The whole row under a point, prefix excluded. */
export function lineAt(rows: readonly TranscriptRow[], at: TextPoint): TextSelection {
    const row = rows[at.row]
    const cells = row === undefined ? 0 : [...row.text].length
    return {
        anchor: { row: at.row, column: row?.lead ?? 0 },
        focus: { row: at.row, column: cells },
        dragging: false,
    }
}
