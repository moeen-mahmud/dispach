/**
 * The stdin tap: what it queues, what it hands back, and that closing it really detaches.
 *
 * The one thing this cannot assert is the property the whole design rests on — that our `data` listener
 * runs before Ink's. That is a fact about registration order at the call site (`openTap` before `render`),
 * not about this module, and a test cannot register a listener before a renderer that creates the stream.
 * It is proven instead by driving the built binary under a pty, which is where it was found in the first
 * place. Said plainly here rather than left as a gap somebody discovers later.
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { openTap } from "#lib/stdin-tap"
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

const INK_META_LEFT: KeyState = { ...NO_KEYS, leftArrow: true, meta: true }

/** Stands in for `process.stdin`: the tap uses only `on` and `off` for `data`. */
class FakeStdin extends EventEmitter {
    send(text: string): void {
        this.emit("data", text)
    }
}

describe("openTap", () => {
    test("a chunk becomes a correction and a readable byte string", () => {
        const stdin = new FakeStdin()
        const tap = openTap(stdin)
        stdin.send("\u001B[1;9D")
        // The raw bytes, for the probe.
        expect(tap.takeRaw()).toBe("\u001B[1;9D")
        expect(tap.takeRaw()).toBeUndefined()
        // And the correction, for the chat.
        expect(tap.correct(INK_META_LEFT, "").super).toBe(true)
        tap.close()
    })

    test("a Buffer chunk is decoded as UTF-8", () => {
        // `process.stdin` hands over Buffers unless an encoding is set, and Ink sets one on its own copy —
        // not on ours. Reading it as a string without decoding would put replacement characters in a byte
        // row, which is the one place they would be actively misleading.
        const stdin = new FakeStdin()
        const tap = openTap(stdin)
        stdin.emit("data", Buffer.from("\u001B[1;9D", "utf8"))
        expect(tap.takeRaw()).toBe("\u001B[1;9D")
        tap.close()
    })

    test("a record is consumed once, so a second identical key is not corrected twice", () => {
        const stdin = new FakeStdin()
        const tap = openTap(stdin)
        stdin.send("\u001B[1;9D")
        expect(tap.correct(INK_META_LEFT, "").super).toBe(true)
        // Nothing left to claim: the second call falls back to what Ink reported.
        expect(tap.correct(INK_META_LEFT, "").super).toBe(false)
        tap.close()
    })

    test("two keys in one chunk are corrected independently", () => {
        const stdin = new FakeStdin()
        const tap = openTap(stdin)
        stdin.send("\u001B[1;9D\u001B[1;3D")
        // Identity matching means the left-arrow records are claimed in order, so cmd first, then option.
        expect(tap.correct(INK_META_LEFT, "").super).toBe(true)
        const second = tap.correct(INK_META_LEFT, "")
        expect(second.super).toBe(false)
        expect(second.meta).toBe(true)
        tap.close()
    })

    test("close detaches, so a later chunk changes nothing", () => {
        const stdin = new FakeStdin()
        const tap = openTap(stdin)
        tap.close()
        stdin.send("\u001B[1;9D")
        expect(tap.takeRaw()).toBeUndefined()
        expect(tap.correct(INK_META_LEFT, "").super).toBe(false)
        expect(stdin.listenerCount("data")).toBe(0)
    })

    test("unclaimed records are bounded rather than kept forever", () => {
        // A terminal that emits sequences nothing ever claims must not grow an array for the life of the
        // session. Bounded, not cleared: a burst of key repeat legitimately queues several at once.
        const stdin = new FakeStdin()
        const tap = openTap(stdin)
        for (let at = 0; at < 100; at += 1) stdin.send("\u001B[1;9A")
        // Still corrects — the queue kept the newest — and the oldest were dropped rather than retained.
        expect(tap.correct({ ...NO_KEYS, upArrow: true, meta: true }, "").super).toBe(true)
        tap.close()
    })
})
