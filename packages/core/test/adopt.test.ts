/**
 * Adopting, replacing and disposing one agent while the process keeps serving.
 *
 * ## Why these are end-to-end rather than unit tests
 *
 * Six subsystems — the lease, the channel bindings, the outbox poll loop, the schedule timer, the
 * tool providers, a plugin's event watcher — were only ever unwound at process exit, and **every
 * one of them fails quietly when it is missed**: a leased agent nothing is serving, an unreaped
 * `exec` child, two loops draining one queue. None of those has an assertion available at the layer
 * where the mistake is made, so each test here reaches for the observable state on the far side —
 * the lease row, the map size, the transport's own `stopped` flag, the scheduler's due query.
 *
 * The accumulation test is the one that would have caught the class rather than an instance: adopt
 * and dispose in a loop, then assert nothing is bigger than it started.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { HarnessError } from "../src/errors.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { FetchLike } from "../src/model/provider.ts"
import type { Plugin } from "../src/plugins/plugin.ts"
import type { ChannelFactory } from "../src/runtime/channels.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { ToolProvider, ToolProviderFactory } from "../src/tools/types.ts"
import { afterEach, describe, expect, sleep, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }
const dirs: string[] = []

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

function agentDir(
    id: string,
    extra = "",
    options: { readonly model?: string } = {},
): { dir: string; manifest: string } {
    const dir = mkdtempSync(join(tmpdir(), `adopt-${id}-`))
    dirs.push(dir)
    const manifest = join(dir, "agent.yaml")
    writeFileSync(
        manifest,
        `apiVersion: ${BRAND.apiVersion}
id: ${id}
name: ${id}
model:
  main:
    id: ${options.model ?? "gpt-4o-mini"}
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
${extra}
`,
        "utf8",
    )
    return { dir, manifest }
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

const reply: FetchLike = async () =>
    sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        "data: [DONE]\n\n",
    ])

/** A transport that records what was asked of it, so a teardown is observable. */
interface Recorded {
    started: number
    stopped: number
}

function recordingChannels(log: Map<string, Recorded>): ChannelFactory {
    return (context) => {
        const key = `${context.agentId}:${context.id}`
        const entry = log.get(key) ?? { started: 0, stopped: 0 }
        log.set(key, entry)
        return {
            id: context.id,
            type: "stub",
            limits: { maxMessageChars: 4096, idempotentSend: false },
            start: async () => {
                entry.started += 1
            },
            stop: async () => {
                entry.stopped += 1
            },
            send: async () => ({ ok: true as const, providerMessageId: "1" }),
        }
    }
}

/** A provider whose `stop` is the only way to know it was reaped. */
function recordingProvider(released: string[]): ToolProviderFactory {
    return (context): ToolProvider => ({
        id: "rec",
        resolve: () => Promise.resolve([]),
        stop: async () => {
            released.push(context.agentId)
            return [`child-of-${context.agentId}`]
        },
    })
}

describe("adopt", () => {
    test("an agent is hosted, leased and announced without a restart", async () => {
        const first = agentDir("alpha")
        const second = agentDir("beta")
        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        const events: AnyEvent[] = []
        runtime.bus.on("*", (event) => events.push(event))

        const admitted = await runtime.adopt(second.manifest)

        expect(admitted.map((agent) => agent.id)).toEqual(["beta"])
        expect(
            runtime
                .list()
                .map((agent) => agent.id)
                .sort(),
        ).toEqual(["alpha", "beta"])
        // The lease, which is what stops a second process serving the same agent. An adopted agent
        // with no lease is one another `serve` would happily start polling beside.
        expect((await runtime.store.leases.get("beta"))?.runtimeId).toBe(runtime.runtimeId)
        expect(runtime.owned.includes("beta")).toBe(true)
        // `agent.loaded` is the only completion signal a client watching the stream has for a
        // provision, so an adopted agent that emitted nothing would be invisible to every UI.
        expect(
            events.filter((event) => event.type === "agent.loaded").map((event) => event.agentId),
        ).toEqual(["beta"])

        await runtime.stop()
    })

    test("a second agent with the same id is refused before anything is built", async () => {
        const first = agentDir("alpha")
        const again = agentDir("alpha")
        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        // The lease is keyed by agent id and this runtime already owns the row, so a claim would
        // *succeed* — which is why the check is up front rather than left to `#admit`.
        await expect(runtime.adopt(again.manifest)).rejects.toThrow(/already hosts an agent/)
        expect(runtime.list().length).toBe(1)
        // The first instance is untouched: still the one `agent()` resolves, and it is the
        // object created at boot rather than a half-built replacement.
        expect(runtime.agent("alpha").id).toBe("alpha")

        await runtime.stop()
    })

    test("a schedule adopted into a running scheduler actually fires", async () => {
        const first = agentDir("alpha")
        // An `at` whose moment has passed is deliberately left due, so the first wake fires it —
        // which makes this the shortest schedule that proves a fire without a fake clock.
        const due = new Date(Date.now() - 60_000).toISOString()
        const second = agentDir(
            "beta",
            `schedules:
  - id: brief
    kind: at
    expr: "${due}"
    task: "Summarise."
    deliver: none`,
        )

        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
            startSchedules: true,
        })

        const fired: string[] = []
        runtime.bus.on("turn.start", (event) => {
            if (event.agentId !== undefined) fired.push(event.agentId)
        })

        await runtime.adopt(second.manifest)

        // Reconciled: the row exists, which is what `schedules` lists.
        expect((await runtime.store.schedules.list("beta")).map((row) => row.id)).toEqual(["brief"])

        /**
         * And it **fires**, which is the assertion that needs the whole wiring to be right.
         *
         * Two things had to be true and neither was. Both of the `Scheduler`'s agent lookups closed
         * over the array `create` built, and that array is fixed at boot — so an adopted agent was
         * never in the due query. And `#arm` sleeps until the soonest due time it knew about when
         * it last looked, up to a 24-day clamp, so reconciling a row does not make anything look
         * again; `adopt` has to call `changed()` exactly as a manifest write does.
         *
         * The first version of this test asserted the store's own `nextDue` and **stayed green with
         * the wiring reverted**, because it read the store rather than anything the scheduler
         * believes. Waiting for the turn is what cannot pass for the wrong reason.
         */
        for (let waited = 0; waited < 40 && fired.length === 0; waited += 1) await sleep(25)
        expect(fired).toEqual(["beta"])

        await runtime.stop()
    })

    test("channels of an adopted agent start when the hub is already running", async () => {
        const log = new Map<string, Recorded>()
        const first = agentDir("alpha")
        const second = agentDir(
            "beta",
            `channels:
  - type: stub
    id: sc`,
        )

        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
            startChannels: true,
            channels: { stub: recordingChannels(log) },
        })

        await runtime.adopt(second.manifest)
        expect(log.get("beta:sc")).toEqual({ started: 1, stopped: 0 })
        // Slot 2 must agree, or the agent is told it has no channel in the process that just
        // started one — decision 5.17 on the adoption path.
        expect(runtime.channels.statusOf("beta").length).toBe(1)

        await runtime.stop()
        expect(log.get("beta:sc")?.stopped).toBe(1)
    })

    test("adopting into a runtime whose channels are off starts nothing", async () => {
        const log = new Map<string, Recorded>()
        const first = agentDir("alpha")
        const second = agentDir(
            "beta",
            `channels:
  - type: stub
    id: sc`,
        )

        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
            channels: { stub: recordingChannels(log) },
        })

        await runtime.adopt(second.manifest)
        // Registered, never started — the same distinction `startChannels` draws at boot. A REPL
        // that quietly began answering Telegram because somebody provisioned an agent would be the
        // surprise that flag exists to prevent.
        expect(log.get("beta:sc")).toEqual({ started: 0, stopped: 0 })
        expect(runtime.channels.started).toBe(false)

        await runtime.stop()
    })
})

describe("dispose", () => {
    test("the lease is released, the agent leaves the listing, and it is announced", async () => {
        const first = agentDir("alpha")
        const second = agentDir("beta")
        const runtime = await Runtime.create({
            agents: [first.manifest, second.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        const events: AnyEvent[] = []
        runtime.bus.on("*", (event) => events.push(event))

        await runtime.dispose("beta")

        expect(runtime.list().map((agent) => agent.id)).toEqual(["alpha"])
        // Released, not merely forgotten: a lease held by a runtime that has forgotten the agent
        // blocks the next start for ninety seconds while naming a pid that is serving nothing.
        expect(await runtime.store.leases.get("beta")).toBe(undefined)
        expect(runtime.owned).toEqual(["alpha"])
        expect(
            events
                .filter((event) => event.type === "agent.disposed")
                .map((event) => [event.agentId, event.data]),
        ).toEqual([["beta", { reason: "requested" }]])
        // The other agent is untouched, which is the whole point of a per-agent teardown.
        expect((await runtime.store.leases.get("alpha"))?.runtimeId).toBe(runtime.runtimeId)

        await runtime.stop()
    })

    test("only the disposed agent's providers are told to let go", async () => {
        const released: string[] = []
        const tools = `tools:
  providers:
    rec: {}`
        const first = agentDir("alpha", tools)
        const second = agentDir("beta", tools)
        const runtime = await Runtime.create({
            agents: [first.manifest, second.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
            toolProviders: { rec: recordingProvider(released) },
        })

        await runtime.dispose("beta")
        // The keyed map is what makes this possible. Flattened, the runtime could only answer
        // "stop everything" — so disposing one agent either left its backgrounded `exec` children
        // unreaped or reaped every other agent's with it.
        expect(released).toEqual(["beta"])

        await runtime.stop()
        expect(released).toEqual(["beta", "alpha"])
    })

    test("a running turn refuses the teardown", async () => {
        let release = (): void => {}
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const slow: FetchLike = async () => {
            await held
            return sse(["data: [DONE]\n\n"])
        }
        const first = agentDir("alpha")
        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: slow,
            store: ":memory:",
        })

        const turn = runtime.agent("alpha").send("hello")
        // One tick is enough: the counter is incremented synchronously in `send`, before the first
        // store write, which is deliberate — a dispose between `turns.start` and the first model
        // call would otherwise close the store under a turn already recorded as running.
        await sleep(5)
        expect(runtime.agent("alpha").inFlight).toBe(1)

        let refused: unknown
        try {
            await runtime.dispose("alpha")
        } catch (error) {
            refused = error
        }
        expect(refused instanceof HarnessError).toBe(true)
        expect((refused as HarnessError).code).toBe("agent_turn_in_flight")
        // Nothing was half-torn-down on the way to the refusal.
        expect(runtime.list().map((agent) => agent.id)).toEqual(["alpha"])
        expect((await runtime.store.leases.get("alpha"))?.runtimeId).toBe(runtime.runtimeId)

        release()
        await turn
        expect(runtime.agent("alpha").inFlight).toBe(0)
        await runtime.dispose("alpha")
        expect(runtime.list()).toEqual([])

        await runtime.stop()
    })

    test("disposing an unknown agent is a no-op rather than a throw", async () => {
        const first = agentDir("alpha")
        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })
        // Idempotent on purpose: `replace` disposes then adopts, and a caller retrying a failed
        // provision must not be told off for tidying up something already gone.
        await runtime.dispose("nobody")
        expect(runtime.list().length).toBe(1)
        await runtime.stop()
    })
})

describe("replace", () => {
    test("the manifest is re-read and the instance is new", async () => {
        const one = agentDir("alpha", "", { model: "gpt-4o-mini" })
        const runtime = await Runtime.create({
            agents: [one.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })
        const before = runtime.agent("alpha")
        expect(before.manifest.model.main.id).toBe("gpt-4o-mini")

        writeFileSync(
            one.manifest,
            `apiVersion: ${BRAND.apiVersion}
id: alpha
name: alpha
model:
  main:
    id: gpt-4o-replaced
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
            "utf8",
        )

        const after = await runtime.replace("alpha")

        // A *new instance*, which is what leaves the frozen-configuration decision intact: the
        // catalogue resolves once and slot 1 renders once per instance, so a changed manifest is
        // never a mutated agent.
        expect(after[0]).not.toBe(before)
        expect(runtime.agent("alpha").manifest.model.main.id).toBe("gpt-4o-replaced")
        expect(runtime.list().length).toBe(1)
        expect((await runtime.store.leases.get("alpha"))?.runtimeId).toBe(runtime.runtimeId)

        await runtime.stop()
    })

    test("replacing reports itself as replaced, not requested", async () => {
        const one = agentDir("alpha")
        const runtime = await Runtime.create({
            agents: [one.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })
        const reasons: unknown[] = []
        runtime.bus.on("agent.disposed", (event) => {
            if (event.type === "agent.disposed") reasons.push(event.data.reason)
        })

        await runtime.replace("alpha")
        // A client holding a list should keep the agent's place rather than removing it: the same
        // agent is coming back in the same call. A boolean could not say that.
        expect(reasons).toEqual(["replaced"])

        await runtime.stop()
    })

    test("an agent this runtime never loaded cannot be replaced", async () => {
        const one = agentDir("alpha")
        const runtime = await Runtime.create({
            agents: [one.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })
        await expect(runtime.replace("beta")).rejects.toThrow(/does not host an agent/)
        await runtime.stop()
    })

    test("nothing accumulates across repeated adoption", async () => {
        const released: string[] = []
        const log = new Map<string, Recorded>()
        const first = agentDir("alpha")
        const second = agentDir(
            "beta",
            `tools:
  providers:
    rec: {}
channels:
  - type: stub
    id: sc`,
        )

        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
            startChannels: true,
            channels: { stub: recordingChannels(log) },
            toolProviders: { rec: recordingProvider(released) },
        })

        for (let round = 0; round < 3; round += 1) {
            await runtime.adopt(second.manifest)
            await runtime.dispose("beta")
        }

        // The accumulation test, which is the one that catches the *class* rather than an instance.
        // Every one of these grows silently when a teardown step is missed.
        expect(runtime.all().map((agent) => agent.id)).toEqual(["alpha"])
        expect(runtime.owned).toEqual(["alpha"])
        expect(await runtime.store.leases.get("beta")).toBe(undefined)
        expect(released).toEqual(["beta", "beta", "beta"])
        // Three starts and three stops, one pair per round — not six starts against one stop, which
        // is what a hub that forgot the bindings and left the poll loop running would give.
        expect(log.get("beta:sc")).toEqual({ started: 3, stopped: 3 })

        await runtime.stop()
    })
})

describe("teams are one unit", () => {
    /** A supervisor with one member, in one directory, with the member beside it. */
    function team(): string {
        const dir = mkdtempSync(join(tmpdir(), "adopt-team-"))
        dirs.push(dir)
        writeFileSync(
            join(dir, "researcher.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: researcher
name: researcher
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
            "utf8",
        )
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: editor
name: editor
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
team:
  members:
    - id: researcher
      manifest: ./researcher.yaml
      task: Finds one fact.
      artifact:
        type: object
        properties:
          finding: { type: string }
        required: [finding]
`,
            "utf8",
        )
        return join(dir, "agent.yaml")
    }

    test("adopting a supervisor adopts its members, and only it is served", async () => {
        const first = agentDir("alpha")
        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        const admitted = await runtime.adopt(team())

        expect(admitted.map((agent) => agent.id)).toEqual(["editor", "researcher"])
        // A member is loaded, leased and runnable — and not *served*, because an addressable member
        // is a route around whatever policy its supervisor was carrying.
        expect(
            runtime
                .list()
                .map((agent) => agent.id)
                .sort(),
        ).toEqual(["alpha", "editor"])
        expect(runtime.agent("researcher").id).toBe("researcher")
        expect(runtime.team("editor").map((member) => member.id)).toEqual(["researcher"])

        await runtime.stop()
    })

    test("a member cannot be disposed on its own", async () => {
        const runtime = await Runtime.create({
            agents: [team()],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        // The refusal is the cheap half of the alternative: taking only the member leaves the
        // supervisor holding a `handoff` tool that throws at the moment somebody uses it, and
        // leaving it behind leaves an agent nothing can reach.
        await expect(runtime.dispose("researcher")).rejects.toThrow(/cannot be disposed on its own/)
        await expect(runtime.replace("researcher")).rejects.toThrow(/no manifest of its own/)
        expect(runtime.all().length).toBe(2)

        await runtime.stop()
    })

    test("disposing a supervisor takes its members with it", async () => {
        const runtime = await Runtime.create({
            agents: [team()],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        await runtime.dispose("editor")

        expect(runtime.all()).toEqual([])
        expect(runtime.team("editor")).toEqual([])
        // Both leases, not just the addressable one. A member's lease left behind would refuse the
        // next start of a team whose supervisor released its own cleanly.
        expect(await runtime.store.leases.get("editor")).toBe(undefined)
        expect(await runtime.store.leases.get("researcher")).toBe(undefined)

        await runtime.stop()
    })

    test("a replaced supervisor's members come back addressable", async () => {
        const manifest = team()
        const runtime = await Runtime.create({
            agents: [manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
        })

        await runtime.replace("editor")

        // The whole unit round-trips: without the members coming back, the supervisor's handoff
        // tool resolves an id that is gone — and it resolves it at *turn* time, so the failure
        // would arrive on somebody's message rather than on the replace.
        expect(runtime.agent("researcher").id).toBe("researcher")
        expect(runtime.list().map((agent) => agent.id)).toEqual(["editor"])
        expect(
            runtime
                .agent("editor")
                .tools.specs()
                .map((spec) => spec.slug),
        ).toContain("handoff")

        await runtime.stop()
    })
})

describe("a disposed agent's plugins stop watching", () => {
    test("the onEvent subscription is unsubscribed, not merely forgotten", async () => {
        const seen: string[] = []
        const plugin: Plugin = {
            name: "watcher",
            version: "1.0.0",
            dispachApi: "^0.1",
            setup(context) {
                context.use({
                    name: "watcher",
                    onEvent: (event) => {
                        seen.push(`${String(event.agentId)}:${event.type}`)
                    },
                })
            },
        }

        const first = agentDir("alpha")
        const second = agentDir(
            "beta",
            `plugins:
  - "@fixture/watcher"`,
        )

        const runtime = await Runtime.create({
            agents: [first.manifest],
            env: ENV,
            fetch: reply,
            store: ":memory:",
            builtInPlugins: { "@fixture/watcher": plugin },
        })

        await runtime.adopt(second.manifest)
        const whileHosted = seen.length
        expect(whileHosted).toBeGreaterThan(0)

        await runtime.dispose("beta")
        seen.length = 0

        // `bus.on` hands back an unsubscribe and nothing was holding it. Under `create` alone that
        // is harmless — the bus dies with the process — and the moment an agent can be *removed*
        // it is a leak with a behavioural symptom: a replaced agent's old plugins go on observing
        // the new one's turns, so two instances of one watcher see every event twice.
        await runtime.adopt(second.manifest)
        const afterReadopt = seen.filter((line) => line.startsWith("beta:")).length
        const loaded = seen.filter((line) => line === "beta:agent.loaded").length
        expect(afterReadopt).toBeGreaterThan(0)
        expect(loaded).toBe(1)

        await runtime.stop()
    })
})
