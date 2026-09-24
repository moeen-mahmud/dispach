/**
 * Governor limits (`limits.maxConcurrentTurns`, `limits.tokens`) and `Runtime.activity`.
 *
 * Driven through a real runtime against a fake endpoint, and read at the far end: the turn rows, the
 * channel's sent text, the activity report. A refusal is only worth having if *nothing* was recorded
 * and the refused party heard about it, so both halves are asserted.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { ChannelHost } from "../src/channels/channel.ts"
import type { FetchLike } from "../src/model/provider.ts"
import type { ChannelFactory } from "../src/runtime/channels.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }

function sse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
        },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

const reply = (text: string, usage?: { prompt: number; output: number }) =>
    sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        ...(usage === undefined
            ? []
            : [
                  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.output } })}\n\n`,
              ]),
        "data: [DONE]\n\n",
    ])

function agentDir(id: string, limits: string, extra = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "governor-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: ${id}
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
${extra}
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
${limits}
`,
    )
    return join(dir, "agent.yaml")
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("maxConcurrentTurns", () => {
    test("a second turn is refused while one runs; another agent in the silo is not", async () => {
        let open: (() => void) | undefined
        const held = new Promise<void>((resolve) => {
            open = resolve
        })
        const fetch: FetchLike = async (_url, init) => {
            // The capped agent's first turn waits until released; everything else answers at once.
            if (String(init?.body).includes("hold me")) await held
            return reply("ok")
        }
        const runtime = await Runtime.create({
            agents: [agentDir("capped", "  maxConcurrentTurns: 1"), agentDir("free", "")],
            env: ENV,
            fetch,
        })
        const capped = runtime.agent("capped")
        const first = capped.send("hold me", { sessionKey: "api:a" })
        await settle()

        await expect(capped.send("second", { sessionKey: "api:b" })).rejects.toThrow(
            /already running 1 turn/,
        )
        // The neighbour is unaffected.
        expect((await runtime.agent("free").send("hi")).reason).toBe("final")
        // And the refusal recorded nothing: only the held turn has a row.
        const rows = await runtime.store.turns.listForAgent("capped", {})
        expect(rows.turns.map((t) => t.input)).toEqual(["hold me"])

        open?.()
        await first
        // Capacity comes back.
        expect((await capped.send("third", { sessionKey: "api:b" })).reason).toBe("final")
        await runtime.stop()
    })

    test("an admission holds its slot synchronously, and release gives it back", async () => {
        // A token budget too, so each admission awaits the usage query — which is the window a slot
        // taken only *after* the budget check would lose the race in.
        const runtime = await Runtime.create({
            agents: [
                agentDir(
                    "capped",
                    "  maxConcurrentTurns: 1\n  tokens:\n    max: 1000000\n    windowMs: 3600000",
                ),
            ],
            env: ENV,
            fetch: async () => reply("ok"),
        })
        const agent = runtime.agent("capped")
        // Two admissions racing: the second must lose even though neither has sent anything yet.
        const [a, b] = await Promise.all([agent.admit(), agent.admit()])
        expect([a.ok, b.ok].sort()).toEqual([false, true])
        const winner = a.ok ? a : b
        if (!winner.ok) throw new Error("unreachable")
        winner.release()
        winner.release() // idempotent
        const again = await agent.admit()
        expect(again.ok).toBe(true)
        if (!again.ok) throw new Error("unreachable")
        expect((await agent.send("go", { admission: again })).reason).toBe("final")
        expect(agent.inFlight).toBe(0)
        await runtime.stop()
    })
})

describe("limits.tokens", () => {
    test("a turn under the budget runs to its end; the next one is refused and not recorded", async () => {
        const runtime = await Runtime.create({
            agents: [agentDir("budgeted", "  tokens:\n    max: 100\n    windowMs: 3600000")],
            env: ENV,
            fetch: async () => reply("ok", { prompt: 150, output: 10 }),
        })
        const agent = runtime.agent("budgeted")
        // Under budget when it started, so it runs — and overshoots, which is the accepted cost.
        expect((await agent.send("one")).reason).toBe("final")
        await settle()
        await expect(agent.send("two")).rejects.toThrow(/spent 160 of its 100 tokens/)
        const rows = await runtime.store.turns.listForAgent("budgeted", {})
        expect(rows.turns.length).toBe(1)
        await runtime.stop()
    })

    test("a channel sender over the budget is told, in their words", async () => {
        const sent: string[] = []
        let host: ChannelHost | undefined
        const stub: ChannelFactory = (context) => ({
            id: context.id,
            type: "stub",
            limits: { maxMessageChars: 4096, idempotentSend: false },
            start: async (h: ChannelHost) => {
                host = h
            },
            stop: async () => {},
            send: async (message) => {
                sent.push(message.text)
                return { ok: true as const, providerMessageId: String(sent.length) }
            },
        })
        const runtime = await Runtime.create({
            agents: [
                agentDir(
                    "budgeted",
                    "  tokens:\n    max: 100\n    windowMs: 3600000",
                    "channels:\n  - type: stub\n    id: tg\n    allowFrom: [ada]",
                ),
            ],
            env: ENV,
            fetch: async () => reply("the answer", { prompt: 150, output: 10 }),
            channels: { stub },
            startChannels: true,
        })
        if (host === undefined) throw new Error("the stub never started")
        const message = (text: string) => ({
            peerId: "1",
            senderHandle: "ada",
            text,
            receivedAt: new Date().toISOString(),
        })
        host.receive(message("first"))
        await settle()
        await settle()
        host.receive(message("second"))
        await settle()
        await settle()
        expect(sent[0]).toBe("the answer")
        expect(sent[1]).toContain("usage limit")
        await runtime.stop()
    })
})

describe("Runtime.activity", () => {
    test("idle with nothing owed; a started schedule sets nextWakeAt; a running turn is not idle", async () => {
        let open: (() => void) | undefined
        const held = new Promise<void>((resolve) => {
            open = resolve
        })
        const runtime = await Runtime.create({
            agents: [
                agentDir(
                    "sleepy",
                    "",
                    `schedules:
  - id: later
    kind: every
    expr: 10m
    task: "say hi"
    deliver: none`,
                ),
            ],
            env: ENV,
            fetch: async (_url, init) => {
                if (String(init?.body).includes("hold me")) await held
                return reply("ok")
            },
            startSchedules: true,
        })
        const before = await runtime.activity()
        expect(before.idle).toBe(true)
        expect(before.turnsRunning).toBe(0)
        const due = await runtime.store.schedules.nextDue(["sleepy"])
        expect(before.nextWakeAt).toBe(due)
        const wake = Date.parse(before.nextWakeAt ?? "")
        // Ten minutes out, within a second.
        expect(Math.abs(wake - Date.now() - 600_000)).toBeLessThan(1_000)

        const turn = runtime.agent("sleepy").send("hold me")
        await settle()
        const during = await runtime.activity()
        expect(during.idle).toBe(false)
        expect(during.turnsRunning).toBe(1)
        open?.()
        await turn
        expect((await runtime.activity()).idle).toBe(true)
        await runtime.stop()
    })

    test("without a started scheduler, schedules do not set a wake time", async () => {
        const runtime = await Runtime.create({
            agents: [
                agentDir(
                    "sleepy",
                    "",
                    `schedules:
  - id: later
    kind: every
    expr: 10m
    task: "say hi"
    deliver: none`,
                ),
            ],
            env: ENV,
            fetch: async () => reply("ok"),
        })
        const activity = await runtime.activity()
        expect(activity.idle).toBe(true)
        expect(activity.nextWakeAt).toBeUndefined()
        await runtime.stop()
    })
})
