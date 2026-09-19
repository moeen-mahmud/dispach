/**
 * The two ways a chat view reaches an agent, and the three places they genuinely differ.
 *
 * `embeddedSource` is a thin wrapper over objects this process holds, so there is little to test
 * that is not already covered where those objects are. `remoteSource` is where the behaviour is:
 * it turns one SSE stream into a subscription, a 202 plus an event into a turn outcome, and an
 * `AbortSignal` into a request — and each of those has a window in it that a fake can reach and a
 * running server cannot be made to hold open reliably.
 *
 * Every fake here is a plain object, which is the evidence the interface is narrow. The moment one
 * of them needs a runtime, the seam has stopped being a seam.
 */

import { describe, expect, test } from "bun:test"
import type { AnyEvent } from "@dispach/core"
import { type ApiClient, embeddedSource, hostFrom, remoteSource } from "#lib/source"

const DESCRIPTION = {
    agentId: "milo",
    name: "Milo",
    model: "gpt-4o-mini",
    dialect: "nlt",
    window: 32_768,
    catalogueTokens: 120,
    thinking: "none",
    warnings: [],
}

/** An event stream a test pushes into, and a record of what was asked of the agent. */
function fakeClient(): {
    client: ApiClient
    push: (event: AnyEvent) => void
    close: () => void
    calls: string[]
    streams: number
    sendResolves: (turnId: string) => void
} {
    const calls: string[] = []
    let streams = 0
    const queue: AnyEvent[] = []
    let wake: (() => void) | undefined
    let done = false
    let releaseSend: ((turnId: string) => void) | undefined

    const client: ApiClient = {
        agent: () => ({
            send: async () =>
                await new Promise<{ turnId: string }>((resolve) => {
                    calls.push("send")
                    releaseSend = (turnId) => resolve({ turnId })
                }),
            turn: (turnId) => ({
                stop: async () => {
                    calls.push(`stop:${turnId}`)
                },
            }),
            messages: async () => ({
                messages: [
                    { role: "assistant", content: "second" },
                    { role: "user", content: "first" },
                    { role: "assistant", content: "hidden", origin: "observation" },
                ],
            }),
            clearSession: async () => {
                calls.push("clear")
                return {}
            },
            reload: async () => {
                calls.push("reload")
                return { adopted: ["milo", "researcher"] }
            },
            tools: async () => [
                {
                    slug: "exec",
                    summary: "run a command",
                    mutating: true,
                    trust: "trusted",
                    trustReason: "the runtime composed it",
                },
            ],
            sessions: async () => [],
            context: async () => ({ slots: [], total: 1, compactions: 2 }),
        }),
        events: async function* () {
            streams += 1
            for (;;) {
                const next = queue.shift()
                if (next !== undefined) {
                    yield { kind: "event" as const, event: next }
                    continue
                }
                if (done) return
                await new Promise<void>((resolve) => {
                    wake = resolve
                })
            }
        },
    }

    return {
        client,
        push: (event) => {
            queue.push(event)
            wake?.()
            wake = undefined
        },
        close: () => {
            done = true
            wake?.()
            wake = undefined
        },
        calls,
        get streams() {
            return streams
        },
        sendResolves: (turnId) => releaseSend?.(turnId),
    }
}

function turnEnd(turnId: string): AnyEvent {
    return {
        v: 1,
        ts: "2026-09-19T10:00:00.000Z",
        runtimeId: "rt",
        turnId,
        type: "turn.end",
        data: { reason: "final", steps: 2, tokens: { prompt: 10, output: 4 }, durationMs: 120 },
    } as AnyEvent
}

function attached(fake: ReturnType<typeof fakeClient>) {
    return remoteSource({
        client: fake.client,
        agentId: "milo",
        description: DESCRIPTION,
        host: { baseUrl: "http://127.0.0.1:7420", pid: 4711 },
    })
}

describe("a source knows which kind it is", () => {
    test("attached carries where, embedded carries nothing to carry", () => {
        const fake = fakeClient()
        const source = attached(fake)
        expect(source.kind).toBe("attached")
        expect(source.host).toEqual({ baseUrl: "http://127.0.0.1:7420", pid: 4711 })
        // The capability, spelled as presence. `/restart` branches on it rather than on `kind`,
        // because a caller branching on `kind` is one that should have been given a method.
        expect(typeof source.reload).toBe("function")

        const local = embeddedSource({
            agent: {
                id: "milo",
                describe: () => ({ dialect: "nlt", catalogueTokens: 1 }),
                tools: { specs: () => [] },
            },
            bus: { on: () => () => {} },
            send: async () => ({
                text: "",
                reason: "final" as const,
                steps: 1,
                durationMs: 1,
                tokens: { prompt: 0, output: 0 },
            }),
            history: async () => [],
            sessions: async () => [],
            clearSession: async () => {},
            context: async () => {
                throw new Error("unused")
            },
            streamFilter: () => ({ push: (t: string) => t, endStep: () => "", end: () => "" }),
            description: DESCRIPTION,
        })
        expect(local.kind).toBe("embedded")
        expect(local.host).toBeUndefined()
        // Absent, not a no-op: the caller owns the runtime and rebuilds it, and a `reload` that
        // resolved without doing anything would make `/restart` silently stop working.
        expect(local.reload).toBeUndefined()
    })

    test("a lease with no address cannot be attached to", () => {
        // A host serving no HTTP holds a lease and publishes nothing. Guessing 7420 is how a second
        // server on 7421 becomes invisible, which is the reason the column exists at all.
        expect(hostFrom({ pid: 1 })).toBeUndefined()
        expect(hostFrom({ pid: 1, baseUrl: "" })).toBeUndefined()
        expect(hostFrom(undefined)).toBeUndefined()
        expect(hostFrom({ pid: 9, baseUrl: "http://h:1" })).toEqual({
            baseUrl: "http://h:1",
            pid: 9,
        })
    })
})

describe("one stream, however many subscribers", () => {
    test("two subscriptions open one connection and both receive", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        const first: string[] = []
        const second: string[] = []
        const offA = source.subscribe((event) => first.push(event.type))
        const offB = source.subscribe((event) => second.push(event.type))

        fake.push(turnEnd("t_1"))
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 5))

        expect(first).toEqual(["turn.end"])
        expect(second).toEqual(["turn.end"])
        // A connection per subscriber would be two SSE streams on one terminal, each carrying every
        // token — the thing `{chunks: true}` is opt-in everywhere else to avoid.
        expect(fake.streams).toBe(1)

        offA()
        offB()
        await source.close()
    })
})

describe("a turn is followed on that same stream", () => {
    test("send resolves on its own turn.end, not on another turn's", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        let settled = false
        const sending = source
            .send("hello", { sessionKey: "local:1", signal: new AbortController().signal })
            .then((outcome) => {
                settled = true
                return outcome
            })

        fake.sendResolves("t_mine")
        await new Promise((resolve) => setTimeout(resolve, 5))

        // A channel can be delivering a turn for somebody else while this prompt is open, and the
        // firehose carries it. Resolving on the first `turn.end` seen would end this turn early and
        // report another one's token counts as its own.
        fake.push(turnEnd("t_someone_else"))
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(settled).toBe(false)

        fake.push(turnEnd("t_mine"))
        const outcome = await sending
        expect(outcome.reason).toBe("final")
        expect(outcome.steps).toBe(2)
        expect(outcome.tokens).toEqual({ prompt: 10, output: 4 })
        // Empty, because the chunks were already written by whoever subscribed. Handing back a
        // second copy prints the reply twice on the plain path.
        expect(outcome.text).toBe("")
        await source.close()
    })

    test("an error before the end is carried into the outcome", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        const sending = source.send("x", {
            sessionKey: "local:1",
            signal: new AbortController().signal,
        })
        fake.sendResolves("t_1")
        await new Promise((resolve) => setTimeout(resolve, 5))
        fake.push({
            v: 1,
            ts: "2026-09-19T10:00:00.000Z",
            runtimeId: "rt",
            turnId: "t_1",
            type: "error",
            data: { code: "model_refused", message: "no", hint: "try again" },
        } as AnyEvent)
        fake.push(turnEnd("t_1"))
        const outcome = await sending
        // Without this the plain path prints "(the turn failed)" with no code, no message and no
        // hint — the shape hard rule 7 exists to prevent, one process boundary out.
        expect(outcome.error?.code).toBe("model_refused")
        await source.close()
    })
})

describe("cancelling a turn that belongs to somebody else", () => {
    test("an abort after the id is known stops that turn", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        const controller = new AbortController()
        const sending = source.send("x", { sessionKey: "local:1", signal: controller.signal })
        fake.sendResolves("t_7")
        await new Promise((resolve) => setTimeout(resolve, 5))

        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(fake.calls).toContain("stop:t_7")

        // The turn still ends on the stream — a stop is cooperative, and the outcome comes from
        // `turn.end` either way rather than from the abort.
        fake.push(turnEnd("t_7"))
        await sending
        await source.close()
    })

    test("an abort BEFORE the id exists is applied when it arrives", async () => {
        /**
         * The window this implementation exists to close.
         *
         * `POST /messages` has to return before there is a turn id, so a ^C in that gap has nothing
         * to name. Dropping it is the worst available outcome for a cancel key: the person pressed
         * stop, nothing happened, and the turn runs to completion looking like the key is broken.
         */
        const fake = fakeClient()
        const source = attached(fake)
        const controller = new AbortController()
        const sending = source.send("x", { sessionKey: "local:1", signal: controller.signal })

        // Aborted while the request is still in flight — no id anywhere yet.
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(fake.calls).not.toContain("stop:t_late")

        fake.sendResolves("t_late")
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(fake.calls).toContain("stop:t_late")

        fake.push(turnEnd("t_late"))
        await sending
        await source.close()
    })
})

describe("what the host is asked for", () => {
    test("history is oldest-first and excludes what the runtime wrote", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        // The API pages newest-first because that is how a UI scrolls back; a transcript is painted
        // the other way. And `origin` is what separates the conversation from the runtime's own
        // messages — indexing an observation would put text a stranger wrote on screen as the
        // agent's reply.
        expect(await source.history("local:1")).toEqual([
            { role: "user", text: "first" },
            { role: "assistant", text: "second" },
        ])
        await source.close()
    })

    test("the tools view keeps the reason a tool is trusted", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        const view = await source.tools()
        // The column exists because the boot warning fired on every start of every system-provider
        // agent, and a warning always present for a correct configuration is one nobody reads. The
        // route omitted `trustReason` until 17.1, which made the column silently blank when attached.
        expect(view.tools[0]?.trustReason).toBe("the runtime composed it")
        expect(view.catalogueTokens).toBe(120)
        await source.close()
    })

    test("reload names every agent that came back", async () => {
        const fake = fakeClient()
        const source = attached(fake)
        // Named rather than counted: replacing a supervisor replaces its team, and "2 agents
        // reloaded" leaves somebody guessing which.
        expect(await source.reload?.()).toEqual(["milo", "researcher"])
        expect(fake.calls).toContain("reload")
        await source.close()
    })
})
