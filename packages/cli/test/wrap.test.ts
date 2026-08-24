/**
 * The one wrapping.
 *
 * This file used to test three functions that counted rows by dividing the character count by the width.
 * They were replaced because Ink breaks at spaces and a division does not — 240 characters at 80 columns
 * is four rows drawn and three counted — so every cap built on the division was short of what appeared on
 * screen. On the alternate buffer, short by a row is a frame taller than the terminal.
 */

import { describe, expect, test } from "bun:test"
import { livePane, wrapText } from "#lib/wrap"

describe("wrapText", () => {
    test("a line that fits is one row, unchanged", () => {
        expect(wrapText("hello", 80)).toEqual(["hello"])
    })

    test("newlines are rows", () => {
        expect(wrapText("one\ntwo\nthree", 80)).toEqual(["one", "two", "three"])
    })

    test("a blank line is a blank row", () => {
        // Dropping it would close up paragraphs the model deliberately separated.
        expect(wrapText("a\n\nb", 80)).toEqual(["a", "", "b"])
    })

    test("it breaks at spaces, never mid-word", () => {
        expect(wrapText("alpha beta gamma", 12)).toEqual(["alpha beta", "gamma"])
    })

    test("no row exceeds the width", () => {
        const text = "the quick brown fox jumps over the lazy dog ".repeat(20)
        for (const columns of [20, 40, 60, 80, 140]) {
            for (const row of wrapText(text, columns)) {
                expect([...row].length).toBeLessThanOrEqual(columns)
            }
        }
    })

    test("a word longer than the width is cut, and the next word continues its last row", () => {
        expect(wrapText(`${"x".repeat(25)} tail`, 10)).toEqual([
            "xxxxxxxxxx",
            "xxxxxxxxxx",
            "xxxxx tail",
        ])
    })

    test("columns, not code points and not UTF-16 units", () => {
        // Three different numbers, and only one of them is what a terminal draws. `"👍".length` is 2
        // (UTF-16 units), `[..."👍"].length` is 1 (code points), and it occupies **2 columns**.
        //
        // This assertion used to read `[..."👍".repeat(10)]` — one row — and it was wrong in the direction
        // that cannot be seen: ten thumbs measured as ten and drew as twenty, so a frame built on the
        // measurement was a row short, and a row short on the alternate screen scrolls the buffer. Ten
        // emoji at width 10 is five per row.
        expect(wrapText("👍".repeat(10), 10)).toEqual(["👍".repeat(5), "👍".repeat(5)])
        // A UTF-16 count would have given two per row, which is the other way to be wrong.
        expect(wrapText("👍".repeat(4), 8)).toEqual(["👍".repeat(4)])
    })

    test("CJK is two columns wide, and a mark on a letter is none", () => {
        // Both directions of the same rule. Four ideographs fill an eight-column window exactly; the
        // combining acute adds a mark to the `e` rather than a column of its own.
        expect(wrapText("日本語日本語", 8)).toEqual(["日本語日", "本語"])
        expect(wrapText(`caf${"e\u0301"} au lait`, 12)).toEqual([`caf${"e\u0301"} au lait`])
    })

    test("a cut never lands inside a double-width character", () => {
        // Half an emoji is not something a terminal can draw. The row comes out one column short instead,
        // which is the only honest option — and the reason the long-word cut advances by columns rather
        // than by cells.
        for (const row of wrapText("👍".repeat(9), 5)) {
            expect([...row].length, row).toBeLessThanOrEqual(2)
        }
    })

    test("tabs are expanded, so a row containing one can be measured", () => {
        expect(wrapText("\tx", 80)).toEqual([`${" ".repeat(8)}x`])
    })

    test("leading whitespace survives, and continuation rows inherit it", () => {
        // Found live in `/help`: entries indented two spaces kept them when short and lost them when they
        // wrapped, so one list came out at two indents depending on the length of each summary.
        expect(wrapText("  alpha beta gamma", 12)).toEqual(["  alpha beta", "  gamma"])
    })

    test("an indent that does not fit is dropped rather than recursed on", () => {
        // No good answer at this width, and two bad ones: keep the indent and there is no room for the
        // text, or recurse on a shrinking width forever. The text is the part worth keeping.
        expect(wrapText(`${" ".repeat(12)}word here`, 8)).toEqual(["word", "here"])
    })

    test("a zero width is a no-op rather than a hang", () => {
        // A pty can genuinely report `columns === 0` — measured, under `script -q`.
        expect(wrapText("anything at all", 0)).toEqual(["anything at all"])
    })
})

describe("livePane", () => {
    test("nothing to show is no rows at all", () => {
        expect(livePane("", 80, 10)).toEqual({ lines: [], rows: 0, hidden: 0 })
    })

    test("a short reply is drawn whole, with nothing hidden", () => {
        expect(livePane("one\ntwo", 80, 10)).toEqual({
            lines: ["one", "two"],
            rows: 2,
            hidden: 0,
        })
    })

    test("a long reply keeps its newest rows and counts the rest", () => {
        const pane = livePane("1\n2\n3\n4\n5", 80, 2)
        expect(pane.lines).toEqual(["4", "5"])
        expect(pane.hidden).toBe(3)
        // The height includes the notice's own row, which is what the chat frame subtracts.
        expect(pane.rows).toBe(3)
    })

    test("the height it reports is the rows it returns, plus the notice when there is one", () => {
        for (const words of [1, 5, 50, 500]) {
            const pane = livePane("token ".repeat(words).trim(), 80, 12)
            expect(pane.rows).toBe(pane.lines.length + (pane.hidden > 0 ? 1 : 0))
        }
    })

    test("a cap of zero draws nothing rather than everything", () => {
        expect(livePane("anything", 80, 0)).toEqual({ lines: [], rows: 0, hidden: 0 })
    })
})
