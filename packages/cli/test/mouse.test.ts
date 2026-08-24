/**
 * Wheel scrolling, and the guard that has to come with it.
 *
 * The measurement this file records: with tracking on, Ink handed a wheel notch to the keymap **as text**,
 * it fell through to the insert branch, and the composer read `abc[<64;10;5M[<64;10;5M`. So the tests that
 * matter are not "does a wheel notch scroll" but "can any mouse report reach the message", and the answer
 * has to be no for clicks and releases as well — a click that falls through is the same bug with a
 * different button.
 *
 * The second measurement: Ink strips *one* leading escape from a chunk (`use-input.js:97`), so the first
 * report arrives bare and the rest keep theirs. Requiring the prefix matched none of them, which is how the
 * first version of the guard did nothing at all.
 */

import { describe, expect, test } from "bun:test"
import { EMPTY_EDITOR } from "#editor"
import { keyToIntent } from "#keymap"
import { DISABLE_MOUSE, ENABLE_MOUSE, mouseInput, WHEEL_ROWS } from "#lib/mouse"

const ESC = "\u001B"
const KEYS = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    home: false,
    end: false,
    super: false,
} as const

const CONTEXT = {
    busy: false,
    empty: true,
    firstLine: true,
    lastLine: true,
    searching: false,
    armed: false,
    scrolled: false,
} as const

describe("the tracking sequences themselves", () => {
    test("every escape is the byte, not the letters", () => {
        // Found by reading the raw bytes off a pty rather than by a test: the second escape in each
        // constant was the literal text `ESC`, so the SGR request was *printed into the frame* and the
        // terminal was left in its default encoding. Every symptom of that is silent — the screen shows a
        // stray sequence somewhere and the reports arrive in a shape nobody asked for.
        for (const sequence of [ENABLE_MOUSE, DISABLE_MOUSE]) {
            expect(sequence).not.toContain("ESC")
            expect([...sequence].filter((char) => char === "\u001B")).toHaveLength(2)
        }
    })

    test("enabling and disabling are exact inverses", () => {
        expect(ENABLE_MOUSE.replaceAll("h", "l")).toBe(
            [...DISABLE_MOUSE.split("\u001B").filter(Boolean)]
                .reverse()
                .map((part) => `\u001B${part}`)
                .join(""),
        )
    })
})

describe("mouseInput", () => {
    test("a bare report is recognised, because Ink strips the first escape", () => {
        expect(mouseInput("[<64;10;5M")).toEqual({ rows: -WHEEL_ROWS })
    })

    test("an escaped report is recognised too", () => {
        expect(mouseInput(`${ESC}[<65;10;5M`)).toEqual({ rows: WHEEL_ROWS })
    })

    test("several notches in one chunk are summed", () => {
        // A flick of the wheel is coalesced into one chunk. Honouring one of them moves a single row and
        // reads as the wheel not working.
        const chunk = `[<64;1;1M${ESC}[<64;1;1M${ESC}[<64;1;1M`
        expect(mouseInput(chunk)).toEqual({ rows: -3 * WHEEL_ROWS })
    })

    test("opposite notches in one chunk cancel", () => {
        expect(mouseInput(`[<64;1;1M${ESC}[<65;1;1M`)).toEqual({ rows: 0 })
    })

    test("a click is a report with no scroll in it, which still has to be claimed", () => {
        // Zero rows, not `undefined`. The difference is whether the keymap swallows it or types it.
        expect(mouseInput("[<0;10;5M")).toEqual({ rows: 0 })
        expect(mouseInput("[<0;10;5m")).toEqual({ rows: 0 })
    })

    test("the X10 fallback is recognised, offsets and all", () => {
        // A terminal that ignored the SGR request replies in X10, whose bytes are routinely above 127 —
        // so leaving it unclaimed puts unprintable characters into a message.
        expect(mouseInput(`${ESC}[M\u0060!!`)).toEqual({ rows: -WHEEL_ROWS })
        expect(mouseInput(`${ESC}[M\u0061!!`)).toEqual({ rows: WHEEL_ROWS })
    })

    test("ordinary typing is not a mouse report", () => {
        for (const input of ["", "a", "hello", "[", "[<", "[<64", "see [<64;10;5M in the middle"]) {
            expect(mouseInput(input)).toBe(undefined)
        }
    })
})

describe("the keymap claims every mouse report", () => {
    function intent(input: string) {
        return keyToIntent(input, { ...KEYS }, { ...CONTEXT })
    }

    test("a wheel notch is a scroll carrying its row count", () => {
        expect(intent("[<64;10;5M")).toEqual({ kind: "scroll", move: "up", times: WHEEL_ROWS })
        expect(intent("[<65;10;5M")).toEqual({ kind: "scroll", move: "down", times: WHEEL_ROWS })
    })

    test("a click does nothing at all, rather than being typed", () => {
        expect(intent("[<0;10;5M")).toEqual({ kind: "none" })
    })

    test("no mouse report ever becomes an insert", () => {
        // The regression this whole module exists for.
        for (const report of ["[<64;1;1M", "[<0;1;1m", `${ESC}[<65;99;99M`, `${ESC}[M\u0060!!`]) {
            expect(intent(report).kind).not.toBe("insert")
        }
    })

    test("a keystroke is still a keystroke", () => {
        expect(intent("a")).toEqual({ kind: "insert", text: "a" })
        expect(EMPTY_EDITOR.value).toBe("")
    })
})
