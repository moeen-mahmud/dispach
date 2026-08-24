/**
 * Turning a screen cell back into a row of the conversation.
 *
 * The inverse of the frame's vertical arithmetic, and the one piece of mouse selection that can be wrong by
 * a constant and still look plausible: a highlight one row above the pointer reads as a rendering glitch
 * rather than as an arithmetic error. So each piece of chrome above the transcript is pinned separately.
 */

import { describe, expect, test } from "bun:test"
import { EMPTY_EDITOR } from "#editor"
import { composerHit, promptRows, transcriptHit } from "#lib/chat-frame"

describe("transcriptHit", () => {
    // Working screen: no wordmark. Above the transcript there is the one-line header and the scroll-hint
    // row `Transcript` always draws — so the first content row is frame row 2.
    const working = { brandLines: 0, from: 0, to: 10 }

    test("the first content row is below the header and the scroll hint", () => {
        expect(transcriptHit({ column: 0, row: 2 }, working)).toEqual({ row: 0, column: 0 })
        expect(transcriptHit({ column: 4, row: 3 }, working)).toEqual({ row: 1, column: 4 })
    })

    test("the header and the hint row are not the transcript", () => {
        expect(transcriptHit({ column: 0, row: 0 }, working)).toBeUndefined()
        expect(transcriptHit({ column: 0, row: 1 }, working)).toBeUndefined()
    })

    test("a landing screen shifts everything down by the wordmark and its gap", () => {
        // Five rows of mark plus one blank, then the header, then the hint.
        const landing = { brandLines: 5, from: 0, to: 10 }
        expect(transcriptHit({ column: 0, row: 8 }, landing)).toEqual({ row: 0, column: 0 })
        expect(transcriptHit({ column: 0, row: 7 }, landing)).toBeUndefined()
    })

    test("the window's offset is added, so scrolling maps to the right buffer row", () => {
        // The reason the selection is stored in buffer coordinates at all: the same cell means a different
        // row once the view has scrolled, and only the mapping knows that.
        const scrolled = { brandLines: 0, from: 40, to: 50 }
        expect(transcriptHit({ column: 0, row: 2 }, scrolled)).toEqual({ row: 40, column: 0 })
    })

    test("a cell below the last drawn row is chrome, not the last row", () => {
        // Clamping here would make a click on the composer or the status line highlight the final reply,
        // which is worse than doing nothing: it looks like the click selected something deliberately.
        const short = { brandLines: 0, from: 0, to: 3 }
        expect(transcriptHit({ column: 0, row: 4 }, short)).toEqual({ row: 2, column: 0 })
        expect(transcriptHit({ column: 0, row: 5 }, short)).toBeUndefined()
        expect(transcriptHit({ column: 0, row: 40 }, short)).toBeUndefined()
    })

    test("the column passes through untouched", () => {
        // Horizontal chrome is per row, not per frame — the role prefix — so it is excluded by the row's
        // own `lead` rather than here. Subtracting anything at this level would double-count it.
        expect(transcriptHit({ column: 17, row: 2 }, working)?.column).toBe(17)
    })
})

describe("composerHit", () => {
    // The composer is located from the *bottom*, because the frame is bottom-anchored: the status line is
    // the last row and the composer sits `promptRows` above it (plus the landing hint when there is one).
    // Counting down from the top would mean knowing the height of the live pane, the palette, the history
    // search and the confirm line, and being wrong about any one of them puts the caret on another row.
    const ROWS = 30
    const COLUMNS = 80

    function hit(value: string, column: number, row: number, hint = false) {
        return composerHit(
            { column, row },
            { editor: { ...EMPTY_EDITOR, value, cursor: 0 }, columns: COLUMNS, rows: ROWS, hint },
        )
    }

    /** The row the composer's first line of text is drawn on, derived the same way the frame does it. */
    function firstTextRow(value: string, hint = false) {
        const editor = { ...EMPTY_EDITOR, value, cursor: 0 }
        return ROWS - 1 - (hint ? 1 : 0) - promptRows(editor, COLUMNS) + 1
    }

    test("a cell on the text row maps to the offset under it", () => {
        const row = firstTextRow("hello world")
        // Text starts four columns in: one border, one padding, two of prompt gutter.
        expect(hit("hello world", 4, row)).toBe(0)
        expect(hit("hello world", 10, row)).toBe(6)
    })

    test("a click left of the text lands at the start of the row", () => {
        // The border, the padding and the gutter are chrome. Clicking them means the start of the line,
        // which is what clicking a gutter means in every editor.
        const row = firstTextRow("hello")
        expect(hit("hello", 0, row)).toBe(0)
        expect(hit("hello", 3, row)).toBe(0)
    })

    test("a click past the end of a short line lands at its end", () => {
        const row = firstTextRow("hi")
        expect(hit("hi", 60, row)).toBe(2)
    })

    test("the border rows and everything below are not the composer", () => {
        const row = firstTextRow("hello")
        expect(hit("hello", 4, row - 1)).toBeUndefined()
        expect(hit("hello", 4, row + 1)).toBeUndefined()
        // The status line is the last row and must never be part of the input.
        expect(hit("hello", 4, ROWS - 1)).toBeUndefined()
    })

    test("the landing hint shifts the composer up by exactly one row", () => {
        expect(hit("hello", 4, firstTextRow("hello", true), true)).toBe(0)
        // And the same cell is no longer the composer once the hint is gone.
        expect(hit("hello", 4, firstTextRow("hello", true), false)).toBeUndefined()
    })

    test("a second line is a second row, with offsets past the newline", () => {
        const value = "first\nsecond"
        const row = firstTextRow(value)
        expect(hit(value, 4, row)).toBe(0)
        // 6 is the offset of `s`: five characters and the newline.
        expect(hit(value, 4, row + 1)).toBe(6)
        expect(hit(value, 7, row + 1)).toBe(9)
    })

    test("a wrapped line maps by row, not by counting from the start", () => {
        // The offsets come from `composerLayout`, which wraps the same way the renderer draws — so a
        // click on the second visual row of one long line lands past the break rather than near the top.
        const value =
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi"
        const row = firstTextRow(value)
        const second = hit(value, 4, row + 1)
        expect(second).toBeDefined()
        expect(second ?? 0).toBeGreaterThan(60)
    })
})
