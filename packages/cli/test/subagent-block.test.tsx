/**
 * A routed call's subagent, drawn under its tool row (pilot.6).
 *
 * The reducer half reads the items; the frame half renders the real `Transcript` at three widths,
 * because a row count asserted as strings has been right while the drawn list wrapped before.
 */

import { describe, expect, test } from "bun:test"
import type { AnyEvent } from "@dispach/core"
import { App } from "#components/App"
import { Transcript } from "#components/Transcript"
import type { AppProps } from "#lib/schema"
import { FOLLOWING, slice } from "#lib/scroll"
import type { TranscriptState } from "#lib/types"
import { EMPTY_TRANSCRIPT, reduce, type TranscriptAction, transcriptRows } from "#transcript"
import { KEY, mount, overflowing, renderFrame } from "./helpers/frame.tsx"

const CHILD = "subagent:r1"

/** An envelope; `child` marks the subagent's own events the way the runtime does. */
function ev<K extends AnyEvent["type"]>(
    type: K,
    data: Extract<AnyEvent, { type: K }>["data"],
    child = false,
): TranscriptAction {
    const event = {
        v: 1,
        ts: "2026-10-02T00:00:00.000Z",
        runtimeId: "test",
        sessionKey: child ? CHILD : "local:abc",
        ...(child ? { parentTurnId: "turn_p", parentSessionKey: "local:abc" } : {}),
        type,
        data,
    } as Extract<AnyEvent, { type: K }>
    return { kind: "event", event }
}

const call = (slug: string, callId: string, child = false) =>
    ev("tool.call", { slug, callId, argsHash: "h", mutating: false }, child)
const result = (slug: string, callId: string, child = false) =>
    ev(
        "tool.result",
        { slug, callId, ok: true, latencyMs: 12, bytes: 40, truncated: false, trust: "trusted" },
        child,
    )

/** A parent turn whose `mail_list` call ran in subagent `inbox`, which made two calls of its own. */
const ROUTED: readonly TranscriptAction[] = [
    ev("turn.start", { source: "repl", inputTokens: 4, trust: "trusted" }),
    call("mail_list", "c1"),
    ev("handoff.start", {
        member: "test",
        task: "t",
        sessionKey: CHILD,
        kind: "self",
        name: "inbox",
        callId: "c1",
    }),
    call("mail_list", "k1", true),
    result("mail_list", "k1", true),
    call("mail_read", "k2", true),
    result("mail_read", "k2", true),
    // A child's own turn end must not end the parent's.
    ev(
        "turn.end",
        { reason: "final", steps: 3, tokens: { prompt: 900, output: 300 }, durationMs: 5 },
        true,
    ),
    ev("handoff.result", {
        member: "test",
        sessionKey: CHILD,
        kind: "self",
        name: "inbox",
        callId: "c1",
        outcome: "ok",
        steps: 3,
        tokens: { prompt: 900, output: 300 },
    }),
    result("mail_list", "c1"),
]

const run = (actions: readonly TranscriptAction[]): TranscriptState =>
    actions.reduce(reduce, EMPTY_TRANSCRIPT)

describe("the reducer", () => {
    test("puts the child's calls under the routed row and keeps them past its result", () => {
        const state = run(ROUTED)
        const row = state.items.find((item) => item.callId === "c1")
        expect(row?.subagent?.name).toBe("inbox")
        expect(row?.subagent?.lines.map((line) => line.text)).toEqual([
            "mail_list — ok · 12 ms",
            "mail_read — ok · 12 ms",
        ])
        expect(row?.subagent?.summary).toBe("3 steps · 1.2k tokens · ok")
        // The child's calls are not rows of their own, and its turn.end did not settle the parent.
        expect(state.items.filter((item) => item.role === "tool").length).toBe(1)
        expect(state.status).not.toBe("idle")
    })
})

describe("the rows", () => {
    test("fold to one status line, and ⌥r opens the child's calls", () => {
        const { items } = run(ROUTED)
        const folded = transcriptRows(items, { showReasoning: false, quiet: true, columns: 80 })
        const text = folded.map((row) => row.text)
        expect(
            text.some((line) =>
                line.includes("↳ subagent inbox · 3 steps · 1.2k tokens · ok · ⌥r shows 2 calls"),
            ),
        ).toBe(true)
        expect(text.some((line) => line.includes("mail_read — ok"))).toBe(false)

        const open = transcriptRows(items, {
            showReasoning: false,
            quiet: true,
            columns: 80,
            expandReasoning: true,
        }).map((row) => row.text)
        expect(open.some((line) => line.includes("mail_read — ok"))).toBe(true)
        expect(open.some((line) => line.includes("⌥r shows"))).toBe(false)
    })

    test("a running child says so", () => {
        const { items } = run(ROUTED.slice(0, 5))
        const text = transcriptRows(items, { showReasoning: false, quiet: true, columns: 80 }).map(
            (row) => row.text,
        )
        expect(
            text.some((line) => line.includes("↳ subagent inbox · running · ⌥r shows 1 call")),
        ).toBe(true)
    })

    for (const columns of [40, 80, 100]) {
        test(`draw within ${columns} columns, folded and open`, () => {
            const { items } = run(ROUTED)
            for (const expandReasoning of [false, true]) {
                const rows = transcriptRows(items, {
                    showReasoning: false,
                    quiet: true,
                    columns,
                    expandReasoning,
                })
                const frame = renderFrame(
                    <Transcript rows={rows} slice={slice(FOLLOWING, rows.length, rows.length)} />,
                    { columns, rows: rows.length + 4 },
                )
                expect(overflowing(frame, columns)).toEqual([])
                expect(frame.text).toContain("subagent inbox")
                // Every row we produced is a line on screen: nothing wrapped behind our back.
                expect(frame.lines.length).toBe(rows.length + 1)
            }
        })
    }
})

/** The narrow source `App` calls, with `subscribe` handing the test the hook's own handler. */
function source(listen: (handler: (event: AnyEvent) => void) => void): AppProps["source"] {
    const filter = { push: (text: string) => text, endStep: () => "", end: () => "" }
    return {
        kind: "embedded",
        agentId: "milo",
        describe: () => ({
            agentId: "milo",
            name: "milo",
            model: "m",
            dialect: "nlt",
            window: 32_768,
            catalogueTokens: 120,
            thinking: "none",
            warnings: [],
        }),
        subscribe: (handler) => {
            listen(handler)
            return () => {}
        },
        send: async () => ({
            text: "",
            reason: "final" as const,
            steps: 1,
            durationMs: 1,
            tokens: { prompt: 0, output: 0 },
        }),
        streamFilter: () => filter as unknown as ReturnType<AppProps["source"]["streamFilter"]>,
        history: async () => [],
        sessions: async () => [],
        clearSession: async () => {},
        tools: async () => ({ dialect: "nlt", catalogueTokens: 120, tools: [] }),
        context: async () => {
            throw new Error("no context in a frame test")
        },
        close: async () => {},
    }
}

describe("the chat", () => {
    test("shows the child's calls under the routed row, and none of the child's own text", async () => {
        let emit: (event: AnyEvent) => void = () => {}
        const app = mount(
            <App
                source={source((handler) => {
                    emit = handler
                })}
                sessionKey="local:abc"
                model="m"
                agentName="milo"
                initial={{
                    items: [],
                    live: undefined,
                    status: "idle",
                    nextId: 1,
                    turnFrom: undefined,
                }}
                showReasoning={false}
                quiet={true}
            />,
            { columns: 100, rows: 30 },
        )
        await app.settle()
        const text = (delta: string, child: boolean) =>
            ev("model.chunk", { delta, kind: "text" }, child)
        for (const action of [
            ...ROUTED.slice(0, 5),
            text("CHILD-SAYS", true),
            ...ROUTED.slice(5),
        ]) {
            if (action.kind === "event") emit(action.event)
        }
        await app.settle()
        const frame = app.frame().text
        expect(frame).toContain("subagent inbox · 3 steps · 1.2k tokens · ok · ⌥r shows 2 calls")
        expect(frame).not.toContain("CHILD-SAYS")

        // ⌥r opens it on a model that streams no reasoning, which is the case it was refused in.
        await app.press(KEY.kittyMetaR)
        const open = app.frame().text
        expect(open).toContain("mail_read — ok · 12 ms")
        expect(open).not.toContain("reasoning is off")
        app.unmount()
    })

    test("the child's submit_artifact is not one of its calls", () => {
        const { items } = run([
            ...ROUTED.slice(0, 3),
            call("submit_artifact", "k9", true),
            result("submit_artifact", "k9", true),
        ])
        expect(items.find((item) => item.callId === "c1")?.subagent?.lines).toEqual([])
    })
})
