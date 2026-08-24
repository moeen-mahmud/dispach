/**
 * Decoding a modifier from the bytes, which is the fix for the defect Ink's own parse creates.
 *
 * The reported symptom was that `cmd+left` and `option+left` did the same thing. Both are word-moves only
 * if both arrive as `meta`, and that is exactly what Ink's legacy branch produces for `CSI 1;9D`: super is
 * bit 8, its mask is `modifier & 10`, and `8 & 10` is truthy. So the two chords converge before the keymap
 * sees them, and no amount of care in the keymap can pull them apart again.
 */

import { describe, expect, test } from "bun:test"
import { csiKeys, isTerminalReply, withRealModifiers } from "#lib/csi"
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

/** What Ink hands over for a modified arrow: the key identity, and `meta` for anything in mask 10. */
const INK_META_LEFT: KeyState = { ...NO_KEYS, leftArrow: true, meta: true }

describe("csiKeys finds every modified key in a chunk", () => {
    test("an arrow with no event type — the form Warp actually sends", () => {
        expect(csiKeys("\u001B[1;9D")).toEqual([
            { modifier: 9, final: "D", param: 1, eventType: undefined },
        ])
    })

    test("an arrow with an event type — the form the spec allows", () => {
        expect(csiKeys("\u001B[1;9:1D")).toEqual([
            { modifier: 9, final: "D", param: 1, eventType: "press" },
        ])
    })

    test("a release, and a repeat, are distinguished", () => {
        expect(csiKeys("\u001B[114;3:3u")[0]?.eventType).toBe("release")
        expect(csiKeys("\u001B[114;3:2u")[0]?.eventType).toBe("repeat")
    })

    test("the leading escape is optional, because Ink strips one from a chunk", () => {
        // The same reason `lib/mouse.ts` does not require it: Ink removes one escape from the front of a
        // chunk before a handler sees it, so requiring the prefix matched nothing.
        expect(csiKeys("[1;5C")).toHaveLength(1)
    })

    test("two keys in one chunk come back in order", () => {
        expect(csiKeys("\u001B[1;9D\u001B[1;3C").map((key) => key.final)).toEqual(["D", "C"])
    })

    test("an unmodified sequence has nothing to correct and is skipped", () => {
        expect(csiKeys("\u001B[D")).toEqual([])
        expect(csiKeys("\u001B[5~")).toEqual([])
    })

    test("ordinary text is not a key sequence", () => {
        expect(csiKeys("hello [not;1a sequence")).toEqual([])
    })
})

describe("withRealModifiers separates cmd from option", () => {
    test("cmd+left keeps super and loses meta — the reported bug, inverted", () => {
        const records = [...csiKeys("\u001B[1;9D")]
        const key = withRealModifiers(INK_META_LEFT, "", records)
        expect(key.super).toBe(true)
        expect(key.meta).toBe(false)
        // Consumed, so a second keystroke does not reuse it.
        expect(records).toEqual([])
    })

    test("option+left keeps meta and gains no super", () => {
        const key = withRealModifiers(INK_META_LEFT, "", [...csiKeys("\u001B[1;3D")])
        expect(key.meta).toBe(true)
        expect(key.super).toBe(false)
    })

    test("ctrl+left is ctrl, not meta", () => {
        const key = withRealModifiers(INK_META_LEFT, "", [...csiKeys("\u001B[1;5D")])
        expect(key.ctrl).toBe(true)
        expect(key.meta).toBe(false)
        expect(key.super).toBe(false)
    })

    test("shift+cmd+left carries both", () => {
        // modifier 10 = 1 + shift(1) + super(8)
        const key = withRealModifiers(INK_META_LEFT, "", [...csiKeys("\u001B[1;10D")])
        expect(key.shift).toBe(true)
        expect(key.super).toBe(true)
        expect(key.meta).toBe(false)
    })

    test("a record for a different key is left alone", () => {
        // The queue is drained by identity, not by position. A record that does not correspond to the key
        // Ink is reporting has to wait for the keystroke it belongs to — applying it here would put the
        // *next* chord's modifiers on this one, which is worse than not correcting at all.
        const records = [...csiKeys("\u001B[1;9A")]
        const key = withRealModifiers(INK_META_LEFT, "", records)
        expect(key).toEqual(INK_META_LEFT)
        expect(records).toHaveLength(1)
    })

    test("nothing queued means the key is returned untouched", () => {
        expect(withRealModifiers(INK_META_LEFT, "", [])).toEqual(INK_META_LEFT)
    })

    test("a letter form matches on its codepoint", () => {
        const inkR: KeyState = { ...NO_KEYS, meta: true }
        const key = withRealModifiers(inkR, "r", [...csiKeys("\u001B[114;9u")])
        expect(key.super).toBe(true)
        expect(key.meta).toBe(false)
    })

    test("home and end match their own finals and their tilde forms", () => {
        const inkHome: KeyState = { ...NO_KEYS, home: true }
        expect(withRealModifiers(inkHome, "", [...csiKeys("\u001B[1;2H")]).shift).toBe(true)
        expect(withRealModifiers(inkHome, "", [...csiKeys("\u001B[1;2~")]).shift).toBe(true)
        const inkEnd: KeyState = { ...NO_KEYS, end: true }
        expect(withRealModifiers(inkEnd, "", [...csiKeys("\u001B[1;2F")]).shift).toBe(true)
        expect(withRealModifiers(inkEnd, "", [...csiKeys("\u001B[4;2~")]).shift).toBe(true)
    })
})

describe("a terminal's reply is not a keystroke", () => {
    test("the kitty flags answer, in the forms it comes in", () => {
        // Measured in a real Warp session: `CSI ? 0 u` arrived after Ink's 200 ms detection window had
        // closed, so Ink was no longer stripping it and the bytes fell through as text.
        expect(isTerminalReply("\u001B[?0u")).toBe(true)
        expect(isTerminalReply("[?0u")).toBe(true)
        expect(isTerminalReply("\u001B[?3u")).toBe(true)
        expect(isTerminalReply("\u001B[?u")).toBe(true)
    })

    test("a real key is not mistaken for one", () => {
        // Narrow on purpose. `CSI 1;2R` is a modified F3, so a guard generalised to more finals would
        // swallow a keystroke in order to catch a reply nobody asked for.
        expect(isTerminalReply("\u001B[1;9D")).toBe(false)
        expect(isTerminalReply("\u001B[114;3u")).toBe(false)
        expect(isTerminalReply("\u001B[1;2R")).toBe(false)
        expect(isTerminalReply("?0u")).toBe(false)
        expect(isTerminalReply("hello")).toBe(false)
    })
})
