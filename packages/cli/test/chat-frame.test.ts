/**
 * Turning a screen cell back into a row of the conversation.
 *
 * The inverse of the frame's vertical arithmetic, and the one piece of mouse selection that can be wrong by
 * a constant and still look plausible: a highlight one row above the pointer reads as a rendering glitch
 * rather than as an arithmetic error. So each piece of chrome above the transcript is pinned separately.
 */

import { describe, expect, test } from "bun:test"
import { transcriptHit } from "#lib/chat-frame"

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
