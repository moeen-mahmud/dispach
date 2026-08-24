/**
 * Selecting text in the transcript: what a drag covers, and what a copy contains.
 *
 * Every case here is about the two things buffer coordinates buy — a selection that survives scrolling, and
 * a copy that is a substring of data still in hand — plus the two exclusions that make a copy paste-able:
 * the role prefix, and the newlines this renderer invented by wrapping.
 */

import { describe, expect, test } from "bun:test"
import {
    beginSelection,
    dragSelection,
    endSelection,
    extendSelection,
    lineAt,
    rowSelection,
    selectedText,
    textBounds,
    wordAt,
} from "#lib/text-selection"
import type { TranscriptRow } from "#lib/types"

function row(text: string, lead = 0, continuation = false): TranscriptRow {
    return { key: text + String(lead), role: "assistant", text, lead, continuation }
}

/** A reply the renderer wrapped into three rows, prefixed as a user line would be. */
const WRAPPED: readonly TranscriptRow[] = [
    row("› hello brave", 2),
    row("  new world", 2, true),
    row("  and again", 2, true),
]

describe("bounds", () => {
    test("a bare click selects nothing", () => {
        const at = { row: 1, column: 4 }
        expect(textBounds(beginSelection(at))).toBeUndefined()
    })

    test("dragging backwards still reads in order", () => {
        const selection = dragSelection(beginSelection({ row: 2, column: 5 }), {
            row: 0,
            column: 3,
        })
        expect(textBounds(selection)).toEqual({
            start: { row: 0, column: 3 },
            end: { row: 2, column: 5 },
        })
    })

    test("a finished selection keeps its range so it can still be copied", () => {
        const done = endSelection(
            dragSelection(beginSelection({ row: 0, column: 2 }), { row: 0, column: 8 }),
        )
        expect(done.dragging).toBe(false)
        expect(textBounds(done)).toBeDefined()
    })

    test("a motion report after the release is ignored", () => {
        // A terminal can emit one, and honouring it would make a finished selection creep after the
        // pointer with no button held.
        const done = endSelection(
            dragSelection(beginSelection({ row: 0, column: 2 }), { row: 0, column: 8 }),
        )
        expect(dragSelection(done, { row: 5, column: 5 })).toEqual(done)
    })

    test("shift-click extends rather than starting again", () => {
        const first = endSelection(
            dragSelection(beginSelection({ row: 0, column: 2 }), { row: 0, column: 6 }),
        )
        const wider = extendSelection(first, { row: 2, column: 4 })
        expect(textBounds(wider)?.start).toEqual({ row: 0, column: 2 })
        expect(textBounds(wider)?.end).toEqual({ row: 2, column: 4 })
    })
})

describe("rowSelection", () => {
    const selection = dragSelection(beginSelection({ row: 0, column: 4 }), { row: 2, column: 5 })

    test("the first and last rows are partial, the middle is whole", () => {
        expect(rowSelection(selection, 0, 13)).toEqual({ from: 4, to: 13 })
        expect(rowSelection(selection, 1, 11)).toEqual({ from: 0, to: 11 })
        expect(rowSelection(selection, 2, 11)).toEqual({ from: 0, to: 5 })
    })

    test("rows outside the range have nothing selected", () => {
        expect(rowSelection(selection, 3, 11)).toBeUndefined()
        expect(rowSelection(undefined, 0, 11)).toBeUndefined()
    })

    test("a column past the end of a short row clamps to it", () => {
        // What makes dragging down through ragged text feel like one sweep rather than a staircase: the
        // pointer is past the end of a short row, and the whole row is selected instead of nothing.
        const wide = dragSelection(beginSelection({ row: 0, column: 0 }), { row: 0, column: 99 })
        expect(rowSelection(wide, 0, 13)).toEqual({ from: 0, to: 13 })
    })
})

describe("selectedText", () => {
    test("wrapped rows rejoin into the line they came from", () => {
        // The whole point of `continuation`. Without it a pasted paragraph carries the newlines this
        // renderer invented, which is not what anybody selected.
        const all = dragSelection(beginSelection({ row: 0, column: 0 }), { row: 2, column: 11 })
        expect(selectedText(WRAPPED, all)).toBe("hello bravenew worldand again")
    })

    test("the role prefix is never copied", () => {
        // `› ` is chrome. A paste containing it is a paste somebody has to edit.
        const all = dragSelection(beginSelection({ row: 0, column: 0 }), { row: 0, column: 13 })
        expect(selectedText(WRAPPED, all)).toBe("hello brave")
    })

    test("separate items stay separate lines", () => {
        const rows = [row("› first", 2), row("second", 0), row("third", 0)]
        const all = dragSelection(beginSelection({ row: 0, column: 0 }), { row: 2, column: 5 })
        expect(selectedText(rows, all)).toBe("first\nsecond\nthird")
    })

    test("a blank row inside the range is a blank line", () => {
        const rows = [row("one"), row(""), row("two")]
        const all = dragSelection(beginSelection({ row: 0, column: 0 }), { row: 2, column: 3 })
        expect(selectedText(rows, all)).toBe("one\n\ntwo")
    })

    test("trailing whitespace goes per logical line, not per row", () => {
        // A wrap that consumed a space must not leave one in the middle of a rejoined sentence.
        const rows = [row("alpha  "), row("beta  ", 0, true)]
        const all = dragSelection(beginSelection({ row: 0, column: 0 }), { row: 1, column: 6 })
        expect(selectedText(rows, all)).toBe("alpha  beta")
    })

    test("nothing selected copies nothing", () => {
        expect(selectedText(WRAPPED, undefined)).toBe("")
        expect(selectedText(WRAPPED, beginSelection({ row: 0, column: 3 }))).toBe("")
    })
})

describe("double and triple click", () => {
    test("a word is bounded by whitespace and never reaches into the prefix", () => {
        const selection = wordAt(WRAPPED, { row: 0, column: 4 })
        expect(selectedText(WRAPPED, selection)).toBe("hello")
        // Clicking the first character of the text must not select the `› ` before it.
        expect(wordAt(WRAPPED, { row: 0, column: 2 }).anchor.column).toBe(2)
    })

    test("clicking whitespace takes the line instead of an empty word", () => {
        // A zero-width selection from a click on a space reads as the click having done nothing.
        expect(selectedText(WRAPPED, wordAt(WRAPPED, { row: 0, column: 7 }))).toBe("hello brave")
    })

    test("a line excludes the prefix and is not dragging", () => {
        const selection = lineAt(WRAPPED, { row: 1, column: 0 })
        expect(selectedText(WRAPPED, selection)).toBe("new world")
        expect(selection.dragging).toBe(false)
    })

    test("a row that does not exist selects nothing rather than throwing", () => {
        expect(selectedText(WRAPPED, wordAt(WRAPPED, { row: 99, column: 0 }))).toBe("")
    })
})
