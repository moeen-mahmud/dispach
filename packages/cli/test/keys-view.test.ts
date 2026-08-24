/**
 * The key probe's formatter, asserted without a terminal.
 *
 * Every claim the probe makes on screen is decided here, which is the point: a diagnostic nobody has
 * checked is a diagnostic that will be believed when it is wrong, and this one exists precisely because
 * nine rounds of keyboard work were argued from unmeasured claims.
 */

import { describe, expect, test } from "bun:test"
import { flagsOf, hexOf, keystrokeRows, protocolVerdict, provesProtocol } from "#lib/keys-view"
import type { KeyState } from "#lib/types"

const NO_KEYS: KeyState = {
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
}

describe("hexOf reports the bytes a terminal wrote", () => {
    test("an escape sequence, byte by byte", () => {
        expect(hexOf("\u001B[114;3u")).toBe("1b 5b 31 31 34 3b 33 75")
    })

    test("UTF-8, not UTF-16 code units", () => {
        // The composed character Warp sends for ⌥r without the protocol. As UTF-8 it is two bytes; a
        // `charCodeAt` probe would print `ae`, a number no terminal ever wrote — and the entire value of
        // a byte probe is that the bytes are the bytes.
        expect(hexOf("\u00ae")).toBe("c2 ae")
    })

    test("an empty input is empty rather than a zero byte", () => {
        expect(hexOf("")).toBe("")
    })
})

describe("flagsOf names what Ink set, and says so when it set nothing", () => {
    test("a plain letter carries no flags", () => {
        expect(flagsOf(NO_KEYS)).toBe("—")
    })

    test("modifiers come before the key, in a fixed order", () => {
        expect(flagsOf({ ...NO_KEYS, ctrl: true, meta: true, super: true, leftArrow: true })).toBe(
            "ctrl meta super left",
        )
    })

    test("home and end are named, which is the point of adding them", () => {
        expect(flagsOf({ ...NO_KEYS, home: true })).toBe("home")
        expect(flagsOf({ ...NO_KEYS, end: true })).toBe("end")
    })

    test("a press is not annotated and a release is", () => {
        // Only the surprising event types are worth a word: every keystroke is a press, so labelling it
        // would put a column of noise beside the one case that matters.
        expect(flagsOf({ ...NO_KEYS, meta: true, eventType: "press" })).toBe("meta")
        expect(flagsOf({ ...NO_KEYS, meta: true, eventType: "release" })).toBe("meta release")
    })
})

describe("the protocol verdict claims only what a keystroke proved", () => {
    test("super proves it; so does an event type; a bare modifier does not", () => {
        expect(provesProtocol({ ...NO_KEYS, super: true })).toBe(true)
        expect(provesProtocol({ ...NO_KEYS, eventType: "press" })).toBe(true)
        expect(provesProtocol({ ...NO_KEYS, meta: true })).toBe(false)
    })

    test("asked but unproven says so, rather than reporting success", () => {
        const verdict = protocolVerdict([], true)
        expect(verdict).toContain("requested")
        expect(verdict).not.toContain("active")
    })

    test("evidence flips it", () => {
        const stroke = {
            bytes: "\u001B[1;9:1D",
            input: "",
            key: { ...NO_KEYS, super: true, leftArrow: true },
            intent: { kind: "cursorHome" } as const,
        }
        expect(protocolVerdict([stroke], true)).toContain("active")
    })

    test("the override is reported as its own state, not as a failure", () => {
        // "off because you asked" and "off because the terminal declined" are different facts, and a
        // probe that conflated them would send somebody looking for a terminal bug they do not have.
        expect(protocolVerdict([], false)).toContain("not requested")
    })
})

describe("keystrokeRows shows three layers, deepest last", () => {
    test("bytes, ink, intent — and a control byte is not printed raw", () => {
        const rows = keystrokeRows({
            bytes: "\u001B[1;9:1D",
            // Empty, and that is the finding this row exists to show: Ink reports a special key with no
            // `input` at all, so a probe that printed only `input` showed nothing for every cmd chord.
            input: "",
            key: { ...NO_KEYS, super: true, leftArrow: true, eventType: "press" },
            intent: { kind: "cursorHome" },
        })
        expect(rows).toHaveLength(3)
        expect(rows[0]).toContain("1b 5b")
        // The escape is shown as a dot rather than written to the terminal, which would move the cursor.
        expect(rows[0]).toContain(".[1;9:1D")
        expect(rows[1]).toContain("super")
        expect(rows[2]).toBe("intent  cursorHome")
    })
})
