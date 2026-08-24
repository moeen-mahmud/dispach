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
        // Three modes now: 1000 (press/release/wheel), 1002 (motion while held — without which a drag is
        // never reported at all), and 1006 (SGR encoding). Counted rather than pattern-matched, because
        // the failure being guarded against is a literal `ESC` in the string.
        for (const sequence of [ENABLE_MOUSE, DISABLE_MOUSE]) {
            expect(sequence).not.toContain("ESC")
            expect([...sequence].filter((char) => char === "\u001B")).toHaveLength(3)
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
        // `rows: 0` is the load-bearing part — it is what makes the keymap swallow a click rather than
        // letting the report text reach the buffer. The position rides along now that a selection needs it,
        // and the conversion from SGR's 1-based cells to zero-based happens here so no caller repeats it.
        expect(mouseInput(`${ESC}[<0;10;5M`)).toEqual({
            rows: 0,
            at: { column: 9, row: 4 },
            kind: "press",
        })
    })

    test("press, drag and release are told apart, and shift is carried", () => {
        // Motion is bit 5, so a left-button drag is 32. `m` as the final byte is a release whatever the
        // button bits say — a terminal reports the button that *was* held, not one being pressed.
        expect(mouseInput(`${ESC}[<32;3;7M`)?.kind).toBe("drag")
        expect(mouseInput(`${ESC}[<0;3;7m`)?.kind).toBe("release")
        // Shift is bit 2, so a shift-click is 4: it extends an existing selection instead of starting one.
        expect(mouseInput(`${ESC}[<4;3;7M`)?.shift).toBe(true)
        expect(mouseInput(`${ESC}[<0;3;7M`)?.shift).toBeUndefined()
    })

    test("only the newest position in a chunk survives, while wheel notches sum", () => {
        // A drag arrives as a stream of motion reports and a selection follows the pointer rather than
        // retracing it, so the last position wins. The wheel is the opposite case and is summed, which is
        // why `rows` is a separate field — a flick coalesces several notches into one chunk, and honouring
        // only the last would move a single row.
        const dragged = mouseInput(`${ESC}[<32;3;7M${ESC}[<32;9;11M`)
        expect(dragged?.at).toEqual({ column: 8, row: 10 })
        const flicked = mouseInput(`${ESC}[<64;1;1M${ESC}[<64;1;1M`)
        expect(flicked?.rows).toBe(-WHEEL_ROWS * 2)
        expect(flicked?.at).toBeUndefined()
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

    test("a click becomes a pointer gesture rather than being typed", () => {
        // It used to resolve to `none`, which was right while nothing could act on it. Now it carries
        // where it happened — the keymap reports the gesture and the component with the frame decides
        // which row of the conversation that cell is on. What has not changed is the part that mattered:
        // the report is *claimed*, so no coordinate text can reach the buffer.
        expect(intent(`${ESC}[<0;10;5M`)).toEqual({
            kind: "pointer",
            gesture: "press",
            column: 9,
            row: 4,
            shift: false,
        })
        expect(intent(`${ESC}[<32;10;5M`)).toMatchObject({ gesture: "drag" })
        expect(intent(`${ESC}[<0;10;5m`)).toMatchObject({ gesture: "release" })
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
