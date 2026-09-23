/**
 * The inbound gate, tested directly.
 *
 * `isAllowed` decides whether a stranger's message reaches an agent that can hold a shell, and it
 * had no test of its own — it was exercised only through the transports that call it. A gate that
 * is only ever tested by accident is one whose tolerances drift without anyone noticing.
 */

import { describe, expect, test } from "bun:test"
import { isAllowed } from "../src/index.ts"

const from = (senderHandle: string, peerId = `${senderHandle}@s.whatsapp.net`) => ({
    peerId,
    senderHandle,
    text: "hi",
    receivedAt: "2026-09-23T00:00:00.000Z",
})

describe("the gate is closed by default", () => {
    test("no list and an empty list both refuse", () => {
        expect(isAllowed(from("8801711223344"), undefined)).toBe(false)
        expect(isAllowed(from("8801711223344"), [])).toBe(false)
    })

    test("a wildcard opens it, and only an explicit one", () => {
        expect(isAllowed(from("anyone"), ["*"])).toBe(true)
    })
})

describe("a handle is matched the way a person writes it", () => {
    test("case and one leading @ do not matter, on either side", () => {
        const raw = from("Moeen_M", "12345")
        expect(isAllowed(raw, ["@moeen_m"])).toBe(true)
        expect(isAllowed(raw, ["MOEEN_M"])).toBe(true)
        expect(isAllowed({ ...raw, senderHandle: "@moeen_m" }, ["moeen_m"])).toBe(true)
    })

    test("the peer id is a candidate too, for a sender with no handle", () => {
        // Omitted, not set to `undefined`: an optional field cannot hold `undefined` under
        // `exactOptionalPropertyTypes`, and a sender with no handle simply has no key.
        const { senderHandle: _dropped, ...noHandle } = from("", "12345")
        expect(isAllowed(noHandle, ["12345"])).toBe(true)
    })
})

describe("a phone number in allowFrom is matched by its digits", () => {
    /**
     * `+880 1711-223344` is how a number reads off a contact card; `8801711223344` is how a
     * WhatsApp JID carries it. Compared literally they never matched, and the refusal that names
     * the sender printed the digits form — so the person had to notice that their `+` was the
     * whole problem. Same argument the `@` tolerance already makes for handles; OpenClaw does the
     * same ("E.164-style, normalised internally").
     */
    test("+, spaces, dashes, dots and brackets are folded away", () => {
        const me = from("8801711223344")
        expect(isAllowed(me, ["+880 1711-223344"])).toBe(true)
        expect(isAllowed(me, ["+880.1711.223344"])).toBe(true)
        expect(isAllowed(me, ["+880 (1711) 223344"])).toBe(true)
        expect(isAllowed(me, ["+8801711223344"])).toBe(true)
    })

    test("a different number still does not match", () => {
        expect(isAllowed(from("8801711223344"), ["+880 1711-223345"])).toBe(false)
    })

    /**
     * Only a *number* is folded. Stripping separators from a handle would make `abc-def` and
     * `abcdef` one person — a widening nobody asked for, on the field that decides who reaches a
     * shell.
     */
    test("a handle with punctuation is left alone", () => {
        const handle = from("abc-def", "12345")
        expect(isAllowed(handle, ["abcdef"])).toBe(false)
        expect(isAllowed(handle, ["@abc-def"])).toBe(true)
    })
})
