/**
 * A routed call's subagent in the web transcript (pilot.6): the child's calls fold under the tool row,
 * and a child's `turn.end` does not end the parent's turn. Props in, markup out.
 */

import { describe, expect, test } from "bun:test"
import type { TurnStreamItem } from "@dispach/client"
import type { EventDataMap, EventType } from "@dispach/core/wire"
import { renderToStaticMarkup } from "react-dom/server"
import { Rows } from "../src/chat.tsx"
import { EMPTY, reduce } from "../src/lib/transcript.ts"

const CHILD = "subagent:r1"

/** Typed against `EventDataMap`, so a field the wire does not carry is a compile error here. */
function event<K extends EventType>(type: K, data: EventDataMap[K], child = false): TurnStreamItem {
    return {
        kind: "event",
        event: {
            v: 1,
            type,
            data,
            ts: "2026-10-02T10:00:00.000Z",
            runtimeId: "rt",
            sessionKey: child ? CHILD : "api:w",
            ...(child ? { parentTurnId: "turn_p", parentSessionKey: "api:w" } : {}),
        },
    } as unknown as TurnStreamItem
}

const ITEMS: readonly TurnStreamItem[] = [
    event("turn.start", { source: "api", inputTokens: 3, trust: "trusted" }),
    event("tool.call", { slug: "mail_list", callId: "c1", argsHash: "h", mutating: false }),
    event("handoff.start", {
        member: "test",
        task: "t",
        sessionKey: CHILD,
        kind: "self",
        name: "inbox",
        callId: "c1",
    }),
    event("tool.call", { slug: "mail_read", callId: "k1", argsHash: "h", mutating: false }, true),
    event(
        "tool.result",
        {
            slug: "mail_read",
            callId: "k1",
            ok: true,
            latencyMs: 9,
            bytes: 10,
            truncated: false,
            trust: "trusted",
        },
        true,
    ),
    event(
        "turn.end",
        { reason: "final", steps: 2, tokens: { prompt: 800, output: 200 }, durationMs: 4 },
        true,
    ),
    event(
        "tool.call",
        { slug: "submit_artifact", callId: "k9", argsHash: "h", mutating: false },
        true,
    ),
    event("handoff.result", {
        member: "test",
        sessionKey: CHILD,
        kind: "self",
        name: "inbox",
        callId: "c1",
        outcome: "ok",
        steps: 2,
        tokens: { prompt: 800, output: 200 },
    }),
    event("tool.result", {
        slug: "mail_list",
        callId: "c1",
        ok: true,
        latencyMs: 30,
        bytes: 200,
        truncated: false,
        trust: "trusted",
    }),
]

describe("a subagent in the web transcript", () => {
    test("its calls fold under the routed row, and its turn.end leaves the parent running", () => {
        const state = ITEMS.reduce(reduce, EMPTY)
        const tools = state.rows.filter((row) => row.kind === "tool")
        expect(tools.length).toBe(1)
        const row = tools[0]
        if (row?.kind !== "tool") throw new Error("no tool row")
        expect(row.subagent?.calls).toEqual([
            { callId: "k1", slug: "mail_read", ok: true, latencyMs: 9 },
        ])
        expect(row.subagent?.outcome).toBe("ok")
        expect(state.running).toBe(true)

        const html = renderToStaticMarkup(<Rows state={state} onAnswer={() => {}} />)
        expect(html).toContain('<details class="subagent">')
        expect(html).toContain("subagent inbox · 2 steps · 1000 tokens · ok")
        expect(html).toContain("mail_read")
    })
})
