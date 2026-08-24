/**
 * Display width, asserted per code point and per string.
 *
 * Pure and table-driven, so the interesting cases are cheap: the ones that matter are the boundaries of
 * each range and the three kinds of zero — a control byte, a combining mark, and a joiner.
 */

import { describe, expect, test } from "bun:test"
import { cellWidths, charWidth, textWidth } from "#lib/width"

describe("charWidth", () => {
    test("ASCII is one column", () => {
        for (const char of "aZ0 ~!") expect(charWidth(char.codePointAt(0) ?? 0), char).toBe(1)
    })

    test("emoji, CJK, Hangul and fullwidth forms are two", () => {
        for (const char of ["👍", "日", "本", "語", "한", "Ａ", "🚀", "🧠"]) {
            expect(charWidth(char.codePointAt(0) ?? 0), char).toBe(2)
        }
    })

    test("combining marks, joiners and variation selectors are none", () => {
        for (const code of [0x0301, 0x200d, 0x200b, 0xfe0f, 0x20e3]) {
            expect(charWidth(code), code.toString(16)).toBe(0)
        }
    })

    test("a control byte is none rather than one", () => {
        // A floor, not a feature: nothing measured should contain one, since `wrap.ts` expands tabs and
        // `printableOnly` strips the rest. Counting an escape as a column would wrap every row holding
        // one a character early, which is harder to notice than an overflow.
        expect(charWidth(0x1b)).toBe(0)
        expect(charWidth(0x00)).toBe(0)
        expect(charWidth(0x7f)).toBe(0)
    })

    test("the boundaries of a range are inside it", () => {
        // Off-by-one at a range edge is the failure mode of a table like this, so both ends are pinned.
        expect(charWidth(0x4e00)).toBe(2)
        expect(charWidth(0x9fff)).toBe(2)
        expect(charWidth(0x4dff)).toBe(1)
        expect(charWidth(0xa000)).toBe(2)
        expect(charWidth(0xff61)).toBe(1)
    })
})

describe("textWidth", () => {
    test("sums per code point", () => {
        expect(textWidth("hello")).toBe(5)
        expect(textWidth("👍👍")).toBe(4)
        expect(textWidth("日本語")).toBe(6)
        expect(textWidth("")).toBe(0)
    })

    test("a letter with a combining mark is one column, not two", () => {
        expect(textWidth("é")).toBe(1)
        expect(textWidth("café")).toBe(4)
    })

    test("a ZWJ sequence is over-measured, and that is the stated direction to be wrong in", () => {
        // Width is defined per code point, so a cluster built from several is summed. A family emoji is
        // two columns on screen and counts as more here. Over-measuring wraps early; under-measuring
        // overflows the row, and only one of those corrupts an alternate-screen frame.
        expect(textWidth("👩‍👩‍👧")).toBeGreaterThan(2)
    })
})

describe("cellWidths", () => {
    test("one entry per code point, in order", () => {
        expect(cellWidths([..."a👍b"])).toEqual([1, 2, 1])
    })
})
