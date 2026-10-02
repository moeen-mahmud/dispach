/** A subagent's events over the wire (pilot.6): the turn stream's `children` and a scoped key. */

import { afterAll, describe, expect, test } from "bun:test"
import { type Principal, reachesEventSession } from "../src/principal.ts"
import { cleanupWorkspaces, harness, MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

const ROUTED = `${MANIFEST}tools:
  pinned: [now]
subagents:
  - name: clock
    task: Tell the time.
    tools: [now]
    route:
      tools: [now]
`

/** The parent calls `now`; the child, whose catalogue offers `submit_artifact`, calls it and submits. */
const scripted = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "")
    const child = body.includes("submit_artifact")
    const step = (JSON.parse(body) as { messages: { role: string }[] }).messages.filter(
        (message) => message.role === "assistant",
    ).length
    const script = child
        ? ["ACTION: now\nEND", "ACTION: submit_artifact\nsummary: It is late.\nEND"]
        : ["ACTION: now\nEND"]
    const content = script[step] ?? "Done."
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    return new Response(`${frame}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
    })
}) as typeof globalThis.fetch

/** `data:` frames of an SSE body, parsed. */
function frames(text: string): { type?: string; turnId?: string; parentTurnId?: string }[] {
    return text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
}

describe("a turn's stream with children", () => {
    test("carries the child's events and ends on the parent's own turn.end", async () => {
        const { runtime, call } = await harness({ manifest: ROUTED, fetch: scripted })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "what time is it?", sessionKey: "api:c", stream: true, children: true },
        })
        const events = frames(await response.text())
        const turnId = events.find((event) => event.type === "turn.start")?.turnId
        const child = events.filter((event) => event.parentTurnId === turnId)
        expect(child.some((event) => event.type === "tool.call")).toBe(true)
        expect(child.some((event) => event.type === "turn.end")).toBe(true)
        const last = events.filter((event) => event.type === "turn.end").at(-1)
        expect(last?.turnId).toBe(turnId)
        await runtime.stop()
    })

    test("without it, the stream is the parent's alone", async () => {
        const { runtime, call } = await harness({ manifest: ROUTED, fetch: scripted })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "what time is it?", sessionKey: "api:p", stream: true },
        })
        const events = frames(await response.text()).filter((event) => event.type !== undefined)
        expect(events.every((event) => event.parentTurnId === undefined)).toBe(true)
        expect(events.filter((event) => event.type === "turn.end").length).toBe(1)
        await runtime.stop()
    })
})

describe("a key scoped to a session", () => {
    const key: Principal = { kind: "key", keyId: "k", scope: { sessions: "team_42:" } }

    test("reaches a child's events when it reaches the parent's session, and only then", () => {
        expect(
            reachesEventSession(key, { sessionKey: "subagent:r1", parentSessionKey: "team_42:a" }),
        ).toBe(true)
        expect(
            reachesEventSession(key, { sessionKey: "subagent:r1", parentSessionKey: "team_7:a" }),
        ).toBe(false)
        expect(reachesEventSession(key, { sessionKey: "subagent:r1" })).toBe(false)
        expect(reachesEventSession(key, { sessionKey: "team_42:a" })).toBe(true)
    })
})
