/**
 * `historyReport` — what the history slot is made of.
 *
 * Written because the *absence* of this cost a real diagnosis: slot 9 was 85% of a 60,973-token turn,
 * `/context` could only report the total, and the agent asked to explain its own prompt blamed its
 * instruction files — which are read once at load and cost 885 tokens. A total with no composition is
 * how a runtime lets its owner misdiagnose it.
 */

import type { ChatMessage } from "../src/index.ts"
import { historyReport, SLOT } from "../src/index.ts"
// `_harness.ts`, not `bun:test`: every file under packages/core/test runs under Node's runner too,
// and a direct `bun:` import fails there with ERR_UNSUPPORTED_ESM_URL_SCHEME.
import { describe, expect, test } from "./_harness.ts"

function block(
    slot: number,
    role: ChatMessage["role"],
    tokens: number,
    origin?: ChatMessage["origin"],
) {
    const message: ChatMessage =
        origin === undefined ? { role, content: "x" } : { role, content: "x", origin }
    return { slot, role, content: "x", pinned: false, tokens, label: "history", message }
}

describe("historyReport", () => {
    test("groups by origin, largest first", () => {
        const out = historyReport([
            block(SLOT.history, "user", 40, "observation"),
            block(SLOT.history, "assistant", 10),
            block(SLOT.history, "user", 400, "observation"),
            block(SLOT.history, "user", 5),
        ] as never)
        expect(out.map((e) => e.label)).toEqual([
            "tool results",
            "assistant replies",
            "what you said",
        ])
        expect(out[0]).toEqual({ label: "tool results", tokens: 440, messages: 2 })
    })

    /**
     * The distinction the whole report exists to draw. A person's message and a tool result are both
     * `role: "user"` under NLT — the observation is a fenced block in a user turn — so reading the role
     * alone merges the two, and the merged row is exactly the one somebody would act on.
     */
    test("a person's message is not a tool result, though both are user-role under NLT", () => {
        const out = historyReport([
            block(SLOT.history, "user", 900, "observation"),
            block(SLOT.history, "user", 12),
        ] as never)
        expect(out).toEqual([
            { label: "tool results", tokens: 900, messages: 1 },
            { label: "what you said", tokens: 12, messages: 1 },
        ])
    })

    test("a native tool-role result counts as a tool result too", () => {
        // Same kind, two wire shapes. Splitting them would name neither correctly.
        const out = historyReport([block(SLOT.history, "tool", 70)] as never)
        expect(out).toEqual([{ label: "tool results", tokens: 70, messages: 1 }])
    })

    test("only the history slot is decomposed", () => {
        // Pinned slots are already itemised by `slotReport`; counting them here would double them.
        const out = historyReport([
            block(SLOT.identity, "system", 885),
            block(SLOT.tools, "system", 7119),
            block(SLOT.history, "user", 30, "observation"),
        ] as never)
        expect(out).toEqual([{ label: "tool results", tokens: 30, messages: 1 }])
    })

    test("an empty history reports nothing rather than a zero row", () => {
        expect(historyReport([])).toEqual([])
    })
})
