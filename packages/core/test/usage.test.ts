/**
 * The meter: one row per model call, and the totals built from them.
 *
 * Every assertion that matters here is at the **far end**: a real `Agent.send` against a fake
 * endpoint, then the rows read back out of the store. That is the guard this repo has needed for a
 * threaded field every time. The meter is threaded through `TurnInput`, `runStep` and the compactor
 * by optional fields, which nothing excess-property-checks.
 *
 * What it guards against, measured before it existed: `turns.prompt_tokens` holds the **last** step's
 * prompt, so a two-step turn read as one prompt, and a compactor call left no row at all.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
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

const delta = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const usage = (prompt: number, output: number) =>
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: output } })}\n\n`

function workspace(extra = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "usage-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: metered
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
${extra}
tools:
  local:
    - now
limits:
  maxSteps: 4
  turnTimeoutMs: 5000
`,
    )
    return dir
}

describe("every model call is metered", () => {
    test("a two-step turn is two rows, and the prompts are summed rather than last-wins", async () => {
        let call = 0
        const fetch: FetchLike = async () => {
            call += 1
            // Step one calls a tool; step two answers. Each reports its own usage.
            return call === 1
                ? sse([delta("ACTION: now\n"), usage(100, 10), "data: [DONE]\n\n"])
                : sse([delta("It is now."), usage(150, 5), "data: [DONE]\n\n"])
        }
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch,
        })
        const agent = runtime.agent("metered")
        await agent.send("what time is it?", { from: { id: "user:ada", kind: "user" } })
        // The write is fire-and-forget by contract; let it land.
        await new Promise((resolve) => setTimeout(resolve, 20))

        const report = await runtime.store.usage.report({ by: ["agent", "model", "sender"] })
        expect(report.buckets).toEqual([
            {
                agentId: "metered",
                model: "gpt-4o-mini",
                sender: "user:ada",
                calls: 2,
                promptTokens: 250,
                cachedPromptTokens: 0,
                outputTokens: 15,
                estimatedCalls: 0,
            },
        ])
        expect(report.meteredSince).toBeDefined()
        await runtime.stop()
    })

    test("a call whose figures were estimated says so", async () => {
        // No usage frame: both figures are ours.
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: async () => sse([delta("hi"), "data: [DONE]\n\n"]),
        })
        await runtime.agent("metered").send("hello")
        await new Promise((resolve) => setTimeout(resolve, 20))
        const [total] = (await runtime.store.usage.report({ by: [] })).buckets
        expect(total?.calls).toBe(1)
        expect(total?.estimatedCalls).toBe(1)
        await runtime.stop()
    })

    test("a compactor call is metered under its own model, billed to the turn that caused it", async () => {
        const LONG = "This is a filler sentence that exists only to consume prompt budget. ".repeat(
            12,
        )
        const runtime = await Runtime.create({
            agents: [
                join(
                    workspace(`  compactor:
    id: tiny-summariser
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 4000
  reserveOutput: 500
  thresholds: { snip: 0.60, micro: 0.70, collapse: 0.80, reset: 0.88, trim: 0.95 }`),
                    "agent.yaml",
                ),
            ],
            env: ENV,
            // No usage frame, as in the compaction fixture: a reported figure calibrates the estimator
            // down and the ladder never fires, which would make this test pass by having no data.
            fetch: async () => sse([delta(LONG), "data: [DONE]\n\n"]),
        })
        const agent = runtime.agent("metered")
        for (let turn = 0; turn < 12; turn += 1) {
            await agent.send(`turn ${turn}: go on at length`, {
                from: { id: "user:grace", kind: "user" },
            })
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        const byModel = (await runtime.store.usage.report({ by: ["model", "sender"] })).buckets
        const compactor = byModel.find((bucket) => bucket.model === "tiny-summariser")
        // The spend nothing recorded before this table existed.
        expect(compactor?.calls ?? 0).toBeGreaterThan(0)
        expect(compactor?.sender).toBe("user:grace")
        await runtime.stop()
    })
})

describe("the report", () => {
    const at = (day: string) => `${day}T12:00:00.000Z`
    async function seeded() {
        const store = await openMemoryStore()
        const row = {
            role: "main",
            model: "m",
            promptTokens: 10,
            promptReported: true,
            outputTokens: 1,
            outputReported: true,
        }
        await store.usage.record({
            ...row,
            agentId: "a",
            sessionKey: "team_1:x",
            at: at("2026-09-01"),
        })
        await store.usage.record({
            ...row,
            agentId: "a",
            sessionKey: "team_2:y",
            at: at("2026-09-02"),
        })
        await store.usage.record({
            ...row,
            agentId: "b",
            sessionKey: "team_1:z",
            at: at("2026-09-02"),
        })
        return store
    }

    test("groups by day, filters by agent, window and session prefix", async () => {
        const store = await seeded()
        const byDay = await store.usage.report({ by: ["day"] })
        expect(byDay.buckets.map((b) => [b.day, b.calls])).toEqual([
            ["2026-09-01", 1],
            ["2026-09-02", 2],
        ])
        expect((await store.usage.report({ by: [], agentIds: ["a"] })).buckets[0]?.calls).toBe(2)
        expect((await store.usage.report({ by: [], agentIds: [] })).buckets).toEqual([])
        const windowed = await store.usage.report({
            by: [],
            from: at("2026-09-02"),
            to: at("2026-09-03"),
        })
        expect(windowed.buckets[0]?.calls).toBe(2)
        // `meteredSince` ignores the window: it answers how far back the meter goes at all.
        expect(windowed.meteredSince).toBe(at("2026-09-01"))
        const scoped = await store.usage.report({ by: ["agent"], sessionPrefix: "team_1:" })
        expect(scoped.buckets.map((b) => [b.agentId, b.calls])).toEqual([
            ["a", 1],
            ["b", 1],
        ])
        // A LIKE metacharacter in a prefix matches literally.
        expect((await store.usage.report({ by: [], sessionPrefix: "team_%" })).buckets).toEqual([])
        await store.close()
    })

    test("removing one agent removes its usage and leaves another's", async () => {
        const store = await seeded()
        await store.purgeAgent("a")
        const left = await store.usage.report({ by: ["agent"] })
        expect(left.buckets.map((b) => [b.agentId, b.calls])).toEqual([["b", 1]])
        await store.close()
    })

    test("clearing a session does not erase what it cost", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure("a", "api:chat")
        await store.usage.record({
            agentId: "a",
            sessionKey: "api:chat",
            role: "main",
            model: "m",
            promptTokens: 5,
            promptReported: true,
            outputTokens: 1,
            outputReported: true,
            at: at("2026-09-01"),
        })
        await store.sessions.delete("a", "api:chat")
        expect((await store.usage.report({ by: [] })).buckets[0]?.calls).toBe(1)
        await store.close()
    })
})

describe("listing an agent's turns", () => {
    test("pages newest first by row key, across sessions, narrowed by prefix", async () => {
        const store = await openMemoryStore()
        for (const [session, n] of [
            ["team_1:a", 3],
            ["team_2:b", 2],
        ] as const) {
            await store.sessions.ensure("a", session)
            for (let i = 0; i < n; i += 1) {
                await store.turns.start({
                    turnId: `${session}-${i}`,
                    agentId: "a",
                    sessionKey: session,
                    source: "api",
                    input: "x",
                })
            }
        }
        const first = await store.turns.listForAgent("a", { limit: 3 })
        expect(first.turns.map((t) => t.turnId)).toEqual(["team_2:b-1", "team_2:b-0", "team_1:a-2"])
        const second = await store.turns.listForAgent("a", {
            limit: 3,
            ...(first.nextBefore === undefined ? {} : { before: first.nextBefore }),
        })
        expect(second.turns.map((t) => t.turnId)).toEqual(["team_1:a-1", "team_1:a-0"])
        expect(second.nextBefore).toBeUndefined()
        const narrowed = await store.turns.listForAgent("a", { sessionPrefix: "team_2:" })
        expect(narrowed.turns.map((t) => t.turnId)).toEqual(["team_2:b-1", "team_2:b-0"])
        await store.close()
    })
})
