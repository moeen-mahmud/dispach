/**
 * The composer's rows, and the caret on them.
 *
 * Two properties carry the weight. **The offsets have to be honest** — a row's text is not a slice of its
 * line, because a break consumes the space and a hanging indent is re-applied to rows that never held one,
 * so the assertion is that stripping the indent gives back exactly the source characters the row claims.
 * And **the caret has to be reachable at every position**, including the end of a row that exactly fills
 * the window, which is the case the reserved column exists for.
 *
 * The defect this file exists for: nothing wrapped. Each logical line went to Ink with `wrap="truncate"`,
 * so at 100 columns a long message was cut at the border and the caret went with it — you could not see
 * what you were typing. Measured in both VS Code (cut) and Warp (the terminal wrapped the over-wide box
 * and the tail landed on the border), which is one cause with two symptoms and neither reproducible in the
 * other terminal.
 */

import { describe, expect, test } from "bun:test"
import { EMPTY_EDITOR } from "#editor"
import { type ComposerRow, composerLayout, rowSegments } from "#lib/composer"
import type { EditorState } from "#lib/types"
import { expandColumn, wrapRows, wrapText } from "#lib/wrap"

function editor(value: string, cursor = value.length): EditorState {
    return { ...EMPTY_EDITOR, value, cursor }
}

describe("wrapRows", () => {
    test("every row's offsets name exactly the characters it draws", () => {
        const line =
            "The quick brown fox jumps over the lazy dog and keeps on jumping well past the edge."
        for (const columns of [8, 13, 20, 40, 79]) {
            for (const row of wrapRows(line, columns)) {
                const drawn = [...row.text].slice(row.lead).join("")
                expect(drawn).toBe([...line].slice(row.from, row.to).join(""))
                expect([...row.text].length).toBeLessThanOrEqual(columns)
            }
        }
    })

    test("the rows are the same rows `wrapText` produces", () => {
        // One implementation, so the caret arithmetic and every existing caller cannot disagree.
        for (const columns of [1, 4, 12, 37, 100]) {
            for (const line of [
                "",
                "short",
                "  an indented line that has to wrap somewhere sensible",
                "aVeryLongUnbreakableTokenThatHasToBeCutBecauseThereIsNowhereBetterToBreakIt",
                "trailing spaces   ",
            ]) {
                expect(wrapRows(line, columns).map((row) => row.text)).toEqual([
                    ...wrapText(line, columns),
                ])
            }
        }
    })

    test("a break at a space is drawn by neither row", () => {
        const rows = wrapRows("alpha beta", 5)
        expect(rows.map((row) => row.text)).toEqual(["alpha", "beta"])
        expect(rows[0]?.to).toBe(5)
        // 6, not 5: the space at index 5 is the break and belongs to no row.
        expect(rows[1]?.from).toBe(6)
    })

    test("expandColumn counts a tab as the width it is drawn at", () => {
        expect(expandColumn("a\tb", 0)).toBe(0)
        expect(expandColumn("a\tb", 1)).toBe(1)
        expect(expandColumn("a\tb", 2)).toBe(9)
    })
})

describe("composerLayout", () => {
    test("an empty buffer is one row with the caret at its start", () => {
        const layout = composerLayout(editor(""), 20)
        expect(layout.rows).toHaveLength(1)
        expect(layout.caretRow).toBe(0)
        expect(layout.rows[0]?.caret).toBe(0)
    })

    test("a long line becomes several rows and only one carries the caret", () => {
        const layout = composerLayout(editor("wrap me ".repeat(10).trim()), 20)
        expect(layout.rows.length).toBeGreaterThan(1)
        expect(layout.rows.filter((row) => row.caret !== undefined)).toHaveLength(1)
        expect(layout.caretRow).toBe(layout.rows.length - 1)
    })

    test("the caret is reachable at every position in a wrapped line", () => {
        // The property that matters: no cursor offset may fall off the layout. A caret placed past the end
        // of a row is a caret drawn over the border, or not drawn at all.
        const value = "the quick brown fox jumps over the lazy dog"
        for (let at = 0; at <= [...value].length; at += 1) {
            const layout = composerLayout(editor(value, at), 12)
            const row = layout.rows[layout.caretRow]
            expect(row).toBeDefined()
            const caret = row?.caret
            expect(caret).toBeDefined()
            expect(caret ?? -1).toBeGreaterThanOrEqual(0)
            // Inside the window, including the reserved cell the caret itself may occupy.
            expect(caret ?? 0).toBeLessThanOrEqual(11)
        }
    })

    test("a caret at the end of a full row stays inside the window", () => {
        // The reason a column is reserved. Wrapping to the full width would put the caret at column
        // `columns`, one past the last cell, which the terminal wraps and the border absorbs.
        const layout = composerLayout(editor("abcdefghij"), 6)
        const row = layout.rows[layout.caretRow]
        expect((row?.caret ?? 0) < 6).toBe(true)
    })

    test("newlines are rows too, and the caret follows the line it is on", () => {
        const layout = composerLayout(editor("one\ntwo\nthree", 5), 20)
        expect(layout.rows.map((row) => row.text)).toEqual(["one", "two", "three"])
        // Offset 5 is the "w" of "two": one past "one\nt".
        expect(layout.caretRow).toBe(1)
        expect(layout.rows[1]?.caret).toBe(1)
    })

    test("a blank line keeps its row rather than closing the paragraph up", () => {
        const layout = composerLayout(editor("one\n\ntwo"), 20)
        expect(layout.rows).toHaveLength(3)
        expect(layout.rows[1]?.text).toBe("")
    })

    test("the caret is measured in code points, not UTF-16 units", () => {
        // "👍" is two units and one column. A caret counted in units lands inside the pair.
        const layout = composerLayout(editor("👍👍a", 2), 20)
        expect(layout.rows[0]?.caret).toBe(2)
    })

    test("a tab moves the caret by the width it is drawn at", () => {
        const layout = composerLayout(editor("a\tb", 2), 40)
        expect(layout.rows[0]?.caret).toBe(9)
    })

    test("a width of one still produces a layout rather than looping", () => {
        // `columns - 1` floors at 1, so the reserved cell cannot make the window zero-wide.
        const layout = composerLayout(editor("abc"), 1)
        expect(layout.rows.length).toBeGreaterThan(0)
    })
})

describe("rowSegments", () => {
    function layout(value: string, cursor: number, columns: number) {
        return composerLayout({ ...EMPTY_EDITOR, value, cursor }, columns)
    }

    test("no selection and no caret is one run", () => {
        const row = layout("hello", 99, 40).rows[0]
        expect(row).toBeDefined()
        const runs = rowSegments({ ...(row as ComposerRow), caret: undefined }, undefined)
        expect(runs).toEqual([{ text: "hello", selected: false, caret: false }])
    })

    test("a selection in the middle is three runs", () => {
        const row = layout("hello world", 99, 40).rows[0]
        const runs = rowSegments(
            { ...(row as ComposerRow), caret: undefined },
            { start: 6, end: 11 },
        )
        expect(runs.map((run) => run.text)).toEqual(["hello ", "world"])
        expect(runs.map((run) => run.selected)).toEqual([false, true])
    })

    test("the caret is its own run, one cell wide, even inside a selection", () => {
        // The case that made runs the right shape rather than slices: slicing for a selection and a caret
        // separately produces overlapping ranges, and where they overlap the caret vanishes.
        const row = layout("hello world", 8, 40).rows[0]
        const runs = rowSegments(row as ComposerRow, { start: 6, end: 11 })
        const caret = runs.filter((run) => run.caret)
        expect(caret).toHaveLength(1)
        expect([...(caret[0]?.text ?? "")]).toHaveLength(1)
        expect(caret[0]?.selected).toBe(true)
        // And the row is still the row: concatenating the runs gives back exactly what was drawn.
        expect(runs.map((run) => run.text).join("")).toBe(row?.text ?? "")
    })

    test("a caret past the last character gets a cell of its own", () => {
        // Same reason the old renderer inverted a trailing space: there is nothing at that column to
        // invert, so the segment walk supplies one.
        const row = layout("hi", 2, 40).rows[0]
        const runs = rowSegments(row as ComposerRow, undefined)
        expect(runs.at(-1)).toEqual({ text: " ", selected: false, caret: true })
    })

    test("the hanging indent is never selected", () => {
        // Those columns are chrome the wrap re-applied. Highlighting them would claim text is selected
        // that no offset in the buffer corresponds to.
        const rows = layout("  alpha beta gamma delta", 99, 14).rows
        const wrapped = rows.find((row) => row.lead > 0)
        expect(wrapped).toBeDefined()
        const runs = rowSegments(
            { ...(wrapped as ComposerRow), caret: undefined },
            { start: 0, end: 99 },
        )
        expect(runs[0]?.selected).toBe(false)
        expect([...(runs[0]?.text ?? "")]).toHaveLength(wrapped?.lead ?? 0)
    })

    test("row offsets are buffer-absolute, so a selection spans lines correctly", () => {
        // Line-relative offsets would make every line after the first select the wrong text — the bug this
        // field exists to avoid, and the reason the newline is counted in the base.
        const rows = layout("first\nsecond", 99, 40).rows
        expect(rows[0]?.start).toBe(0)
        expect(rows[0]?.end).toBe(5)
        expect(rows[1]?.start).toBe(6)
        expect(rows[1]?.end).toBe(12)
        const second = rowSegments(
            { ...(rows[1] as ComposerRow), caret: undefined },
            { start: 6, end: 9 },
        )
        expect(second.filter((run) => run.selected).map((run) => run.text)).toEqual(["sec"])
    })
})
