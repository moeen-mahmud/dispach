/**
 * Sessions, detached turns, and reattachment, end to end through `Runtime`.
 *
 * These are the properties with no visible symptom when they break. A turn that quietly dies
 * with its client looks exactly like a turn that finished; a reattach that drops the events
 * arriving during its own replay looks exactly like a slow network. So each is asserted against
 * the database rather than against the return value of the call that started it.
 *
 * On `./_harness.ts` rather than `bun:test` so the whole thing also runs under `node --test`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { EventBus } from "../src/events/bus.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Agent } from "../src/runtime/agent.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { TurnStreams } from "../src/store/buffer.ts"
import { describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }

function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "sessions-test-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
  files:
    - IDENTITY.md
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
    return dir
}

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

function delta(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

const replyFetch: FetchLike = async () => sse([delta("Hello"), delta(" there"), "data: [DONE]\n\n"])

/**
 * A stream that emits one chunk, then waits for `release` before finishing.
 *
 * It honours `init.signal` by erroring the body, which is what a real aborted `fetch` does — the
 * pending `read()` rejects. A double that ignored the signal would hang instead of cancelling,
 * and would quietly not be testing cancellation at all.
 */
function gatedFetch(release: Promise<void>): FetchLike {
    return async (_input, init) => {
        const signal = init?.signal ?? undefined
        return new Response(
            new ReadableStream<Uint8Array>({
                async start(controller) {
                    const encoder = new TextEncoder()
                    controller.enqueue(encoder.encode(delta("partial")))

                    const aborted = new Promise<"aborted">((resolve) => {
                        if (signal?.aborted === true) resolve("aborted")
                        else {
                            signal?.addEventListener("abort", () => resolve("aborted"), {
                                once: true,
                            })
                        }
                    })
                    const outcome = await Promise.race([
                        release.then(() => "released" as const),
                        aborted,
                    ])
                    if (outcome === "aborted") {
                        controller.error(new Error("The operation was aborted."))
                        return
                    }

                    controller.enqueue(encoder.encode(delta(" done")))
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                    controller.close()
                },
            }),
            { headers: { "content-type": "text/event-stream" } },
        )
    }
}

/**
 * A reply that reports usage with a cache figure, the way DeepSeek's endpoint does.
 *
 * `stream_options: {include_usage: true}` is on by default since Phase 7A, so a real endpoint sends
 * `usage` on the final chunk only — which is what this reproduces, cache field included.
 */
const cachingFetch: FetchLike = async () =>
    sse([
        delta("Hello"),
        `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
                prompt_tokens: 1024,
                completion_tokens: 2,
                prompt_cache_hit_tokens: 896,
                prompt_cache_miss_tokens: 128,
            },
        })}\n\n`,
        "data: [DONE]\n\n",
    ])

describe("cache accounting reaches the stored turn", () => {
    /**
     * The far-end guard, and it exists because the near-end ones could not fail.
     *
     * The path is chunk → `StepResult` → `TurnResult.tokens` → `Agent.send` → `turns.finish` → column,
     * with a conditional spread at four of those hops. A spread is not excess-property-checked, so a
     * layer that forgets to forward the field compiles and reports nothing — and deleting the forward
     * from `step.ts` left both the transport test and the store test green, which is precisely the
     * six-times-recorded failure this repo keeps paying for. Only a real turn, read back out of the
     * database, covers the middle.
     */
    test("a real turn records what the endpoint said it cached", async () => {
        const dir = workspace()
        try {
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: cachingFetch,
            })
            const agent = runtime.agent("test")
            await agent.send("hello")
            const [turn] = await agent.turns(Agent.DEFAULT_SESSION, 1)
            expect(turn?.cachedPromptTokens).toBe(896)
            expect(turn?.cacheSource).toBe("prompt_cache_hit_tokens")
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("an endpoint that says nothing about caching leaves the row absent, not zero", async () => {
        const dir = workspace()
        try {
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
            })
            const agent = runtime.agent("test")
            await agent.send("hello")
            const [turn] = await agent.turns(Agent.DEFAULT_SESSION, 1)
            expect(turn?.cachedPromptTokens).toBeUndefined()
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("session persistence", () => {
    test("history survives a restart against the same file", async () => {
        const dir = workspace()
        const dbPath = join(dir, "store.db")
        try {
            const first = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
                store: dbPath,
            })
            await first.agent("test").send("my name is Moeen")
            await first.stop()

            // A genuinely separate Runtime, as a restarted REPL would be.
            const second = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
                store: dbPath,
            })
            const history = await second.agent("test").history()
            expect(history.map((m) => m.content)).toEqual(["my name is Moeen", "Hello there"])
            await second.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("a second boot applies no migrations", async () => {
        const dir = workspace()
        const dbPath = join(dir, "store.db")
        try {
            const seen: AnyEvent[] = []
            const first = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
            })
            await first.stop()

            const second = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
                // Subscribe before boot, or `store.ready` has already fired by the time we could.
                bus: (() => {
                    const bus = new EventBus({ runtimeId: "test" })
                    bus.on("store.ready", (event) => seen.push(event))
                    return bus
                })(),
            })
            const ready = seen.find((event) => event.type === "store.ready")
            expect(ready).toBeDefined()
            const data = ready?.data as { applied: string[] } | undefined
            expect(data?.applied).toEqual([])
            await second.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("boot stays under budget with 1000 existing sessions", async () => {
        const dir = workspace()
        const dbPath = join(dir, "store.db")
        try {
            const seed = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
            })
            for (let i = 0; i < 1000; i += 1) {
                await seed.store.messages.append("test", `api:user${i}`, [
                    { role: "user", content: `hello ${i}` },
                    { role: "assistant", content: `hi ${i}` },
                ])
            }
            expect((await seed.store.sessions.list("test")).length).toBe(1000)
            await seed.stop()

            const started = performance.now()
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
            })
            const bootMs = performance.now() - started

            // Boot must not scan sessions. It opens the file, checks user_version, and reaps
            // running turns through a partial index — all independent of how much history exists.
            expect(bootMs).toBeLessThan(1000)
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("the default store is in memory, so nothing is written uninvited", async () => {
        const dir = workspace()
        try {
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
            })
            expect(runtime.store.location).toBe(":memory:")
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("detached turns", () => {
    test("abandoning the caller's promise still reaches final in the database", async () => {
        const dir = workspace()
        try {
            let release = (): void => {}
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: gatedFetch(gate),
            })
            const agent = runtime.agent("test")

            // Start the turn and drop the promise on the floor, as a disconnecting client does.
            const inFlight = agent.send("hello", { turnId: "t_detached" })

            // While it is in flight the row exists and says so.
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect((await runtime.store.turns.get("t_detached"))?.status).toBe("running")

            release()
            await inFlight

            const turn = await runtime.store.turns.get("t_detached")
            expect(turn?.status).toBe("final")
            expect(turn?.text).toBe("partial done")
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("an explicit stop persists the partial content", async () => {
        const dir = workspace()
        try {
            const never = new Promise<void>(() => {})
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: gatedFetch(never),
            })
            const agent = runtime.agent("test")
            const controller = new AbortController()

            const inFlight = agent.send("hello", {
                turnId: "t_stopped",
                signal: controller.signal,
            })
            await new Promise((resolve) => setTimeout(resolve, 20))
            controller.abort()

            const result = await inFlight
            expect(result.reason).toBe("stopped")

            const turn = await runtime.store.turns.get("t_stopped")
            expect(turn?.status).toBe("stopped")
            expect(turn?.text).toBe("partial")

            // The partial answer is in the conversation, because someone decided to stop it.
            const history = await agent.history()
            expect(history.map((m) => m.content)).toEqual(["hello", "partial"])
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("a failed turn leaves no half-exchange in the history", async () => {
        const dir = workspace()
        try {
            const failing: FetchLike = async () =>
                new Response("upstream exploded", { status: 500 })
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: failing,
            })
            const agent = runtime.agent("test")
            const result = await agent.send("hello", { turnId: "t_failed" })

            expect(result.reason).toBe("error")
            // The turn row records the failure...
            const turn = await runtime.store.turns.get("t_failed")
            expect(turn?.status).toBe("error")
            expect(turn?.errorCode).toBeDefined()
            // ...and the conversation is untouched, so the next turn is not conditioned on it.
            expect(await agent.history()).toEqual([])
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("a turn left running by a dead process is reaped at the next boot", async () => {
        const dir = workspace()
        const dbPath = join(dir, "store.db")
        try {
            const first = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
            })
            // Exactly what a crash mid-generation leaves behind: a running row and no process.
            await first.store.turns.start({
                turnId: "t_orphan",
                agentId: "test",
                sessionKey: "local:default",
                source: "repl",
                input: "hello",
            })
            await first.stop()

            const second = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
            })
            const turn = await second.store.turns.get("t_orphan")
            expect(turn?.status).toBe("error")
            expect(turn?.errorCode).toBe("turn_abandoned")
            await second.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("reattachment", () => {
    test("replays what was missed and then tails live, with no gap and no duplicate", async () => {
        const dir = workspace()
        try {
            let release = (): void => {}
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: gatedFetch(gate),
                emitChunks: true,
            })

            const inFlight = runtime.agent("test").send("hello", { turnId: "t_attach" })
            await new Promise((resolve) => setTimeout(resolve, 20))

            const tailed: AnyEvent[] = []
            const attachment = runtime.streams.attach("t_attach", (event) => {
                tailed.push(event)
            })

            expect(attachment).toBeDefined()
            expect(attachment?.state).toBe("running")
            // The replay already contains the first chunk, emitted before anyone attached.
            const replayedText = (attachment?.replay ?? [])
                .filter((event) => event.type === "model.chunk")
                .map((event) => (event.data as { delta: string }).delta)
                .join("")
            expect(replayedText).toBe("partial")

            release()
            await inFlight

            const tailedText = tailed
                .filter((event) => event.type === "model.chunk")
                .map((event) => (event.data as { delta: string }).delta)
                .join("")
            expect(tailedText).toBe(" done")

            // Replay plus tail reconstructs the whole reply exactly once.
            expect(replayedText + tailedText).toBe("partial done")
            expect(tailed.some((event) => event.type === "turn.end")).toBe(true)

            attachment?.unsubscribe()
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("attaching to an unknown turn returns undefined rather than an empty stream", async () => {
        const streams = new TurnStreams()
        expect(streams.attach("t_nope", () => {})).toBeUndefined()
    })

    test("an ended turn stays attachable inside the retention window", () => {
        const clock = 0
        const streams = new TurnStreams({ now: () => clock, retainEndedMs: 1000 })
        streams.record(event("turn.start", "t_1"))
        streams.record(event("turn.end", "t_1"))
        expect(streams.state("t_1")).toBe("ended")
        expect(streams.attach("t_1", () => {})?.replay.length).toBe(2)
    })

    test("an ended turn is dropped once the window passes", () => {
        let clock = 0
        const streams = new TurnStreams({ now: () => clock, retainEndedMs: 1000 })
        streams.record(event("turn.start", "t_old"))
        streams.record(event("turn.end", "t_old"))

        clock = 5000
        // Eviction runs on the next turn ending, not on a timer — an idle process stays idle.
        streams.record(event("turn.start", "t_new"))
        streams.record(event("turn.end", "t_new"))

        expect(streams.state("t_old")).toBeUndefined()
        expect(streams.state("t_new")).toBe("ended")
    })

    test("a buffer with a live listener is never evicted from under it", () => {
        let clock = 0
        const streams = new TurnStreams({ now: () => clock, retainEndedMs: 1000 })
        streams.record(event("turn.start", "t_watched"))
        streams.record(event("turn.end", "t_watched"))
        const attachment = streams.attach("t_watched", () => {})

        clock = 90_000
        streams.record(event("turn.start", "t_other"))
        streams.record(event("turn.end", "t_other"))

        expect(streams.state("t_watched")).toBe("ended")
        attachment?.unsubscribe()
    })

    test("the count cap drops the oldest ended turns first", () => {
        let clock = 0
        const streams = new TurnStreams({ now: () => clock, retainEndedCount: 2 })
        for (const id of ["t_1", "t_2", "t_3"]) {
            clock += 1
            streams.record(event("turn.start", id))
            streams.record(event("turn.end", id))
        }
        expect(streams.state("t_1")).toBeUndefined()
        expect(streams.state("t_2")).toBe("ended")
        expect(streams.state("t_3")).toBe("ended")
    })

    test("the per-turn cap drops the oldest events and says so", () => {
        const streams = new TurnStreams({ maxEventsPerTurn: 3 })
        for (let i = 0; i < 5; i += 1) streams.record(event("turn.start", "t_1"))
        expect(streams.attach("t_1", () => {})?.replay.length).toBe(3)
        expect(streams.truncated("t_1")).toBe(true)
    })

    test("events without a turn id are ignored", () => {
        const streams = new TurnStreams()
        streams.record({
            v: 1,
            ts: "2026-08-12T00:00:00Z",
            runtimeId: "rt",
            type: "runtime.stopping",
            data: { reason: "test" },
        } as AnyEvent)
        expect(streams.size).toBe(0)
    })

    test("a throwing listener does not stop the others", () => {
        const streams = new TurnStreams()
        streams.record(event("turn.start", "t_1"))
        const seen: string[] = []
        streams.attach("t_1", () => {
            throw new Error("bad subscriber")
        })
        streams.attach("t_1", () => {
            seen.push("second")
        })
        streams.record(event("turn.start", "t_1"))
        expect(seen).toEqual(["second"])
    })
})

/** Minimal envelope for buffer tests that do not need a real bus. */
function event(type: string, turnId: string): AnyEvent {
    return {
        v: 1,
        ts: "2026-08-12T00:00:00Z",
        runtimeId: "rt",
        turnId,
        type,
        data: {},
    } as unknown as AnyEvent
}
