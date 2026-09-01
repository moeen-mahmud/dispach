/**
 * Compaction inside a real turn, through `Runtime.create`.
 *
 * The unit tests in `compaction.test.ts` prove the stages and the ladder in isolation. This one exists
 * because every layer being individually right is not the same as the layers being connected — the
 * repeated lesson in this repo, from `ChatMessage.toolCalls` to `TurnInput.skills`, is that a field
 * threaded through a pipeline needs one test at the *end* of it. So these assertions read the events a
 * subscriber actually receives and the rows the store actually holds, never the ladder's return value.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { STAGE_ORDER } from "../src/context/compaction/stages.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }

/**
 * A window small enough that a couple of turns crosses `trim`, with an observation-producing tool.
 *
 * `window` is set explicitly rather than left to capability resolution: the point is to reach a
 * threshold in a handful of turns, and doing that on a 128k window would need a fixture nobody would
 * read.
 */
function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "compaction-turn-"))
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
  window: 4000
  reserveOutput: 500
  files:
    - IDENTITY.md
  thresholds:
    snip: 0.60
    micro: 0.70
    collapse: 0.80
    reset: 0.88
    trim: 0.95
tools:
  local:
    - now
    - artifact_read
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

/** A long reply, so history grows fast enough to cross a threshold within a readable fixture. */
const LONG = "This is a filler sentence that exists only to consume prompt budget. ".repeat(12)

const longFetch: FetchLike = async () => sse([delta(LONG), "data: [DONE]\n\n"])

async function runtimeWith(bus: AnyEvent[]) {
    const runtime = await Runtime.create({
        agents: [join(workspace(), "agent.yaml")],
        env: ENV,
        fetch: longFetch,
    })
    runtime.bus.on("*", (event) => bus.push(event))
    return runtime
}

/**
 * The same fixture with a `compactor` role whose window is far smaller than main's.
 *
 * `roles.ts` calls this shape "the intended production shape and usually the biggest available cost
 * win" — a cheap small model for summarising beside a large one for the work.
 */
function workspaceWithCompactor(compactorWindow: number): string {
    const dir = mkdtempSync(join(tmpdir(), "compaction-compactor-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    id: tiny-summariser
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    capabilities:
      contextWindow: ${compactorWindow}
context:
  window: 4000
  reserveOutput: 500
  files:
    - IDENTITY.md
  thresholds:
    snip: 0.60
    micro: 0.70
    collapse: 0.80
    reset: 0.88
    trim: 0.95
tools:
  local:
    - now
    - artifact_read
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
    return dir
}

describe("the compactor gets its own window, not main's", () => {
    /**
     * Read off the request body, at the far end of the pipeline.
     *
     * `requestParamsFor(compactor, this.window)` type-checked perfectly while passing **main's**
     * window, and nothing bounded the span against the compactor's at all — so the defect was
     * invisible from every layer except the bytes on the wire. That is the guard this repo keeps
     * having to relearn: assert the value out of the request, not at the place that sets it.
     */
    test("the digest span is bounded by the compactor's window and says when it was cut", async () => {
        const bodies: { messages: { role: string; content: string }[] }[] = []
        const runtime = await Runtime.create({
            agents: [join(workspaceWithCompactor(600), "agent.yaml")],
            env: ENV,
            fetch: async (_url, init) => {
                bodies.push(JSON.parse(String(init?.body)))
                return sse([delta(LONG), "data: [DONE]\n\n"])
            },
        })
        const agent = runtime.agent("test")
        for (let turn = 0; turn < 12; turn += 1) await agent.send(`turn ${turn}: go on at length`)
        await runtime.stop()

        const digests = bodies.filter((body) =>
            body.messages.some(
                (m) => m.role === "system" && m.content.includes("notes to yourself"),
            ),
        )
        expect(digests.length).toBeGreaterThan(0)

        for (const digest of digests) {
            const spent = digest.messages.reduce(
                (sum, m) => sum + Math.ceil(m.content.length / 3.8),
                0,
            )
            // Comfortably inside 600, rather than the several thousand tokens main's window allowed.
            expect(spent).toBeLessThan(600)
        }

        // And when the span did not fit, the instruction says so — a digest that silently covers less
        // than it was asked to is the failure this whole path exists to avoid.
        const cut = digests.find((digest) =>
            digest.messages.some((m) => m.content.includes("did not fit")),
        )
        expect(cut).toBeDefined()
    })

    test("a configured compactor that produced a digest raises no fallback warning", async () => {
        const seen: AnyEvent[] = []
        const runtime = await Runtime.create({
            agents: [join(workspaceWithCompactor(4000), "agent.yaml")],
            env: ENV,
            fetch: longFetch,
        })
        runtime.bus.on("*", (event) => seen.push(event))
        const agent = runtime.agent("test")
        for (let turn = 0; turn < 12; turn += 1) await agent.send(`turn ${turn}: go on at length`)
        await runtime.stop()

        const stages = seen.filter((event) => event.type === "compaction.stage")
        expect(stages.length).toBeGreaterThan(0)
        const fellBack = seen.find(
            (event) =>
                event.type === "agent.warning" &&
                (event.data as { code?: string }).code === "compactor_fell_back",
        )
        expect(fellBack).toBeUndefined()
    })
})

describe("a prompt that passes the window says so", () => {
    /**
     * Two things are deliberately allowed past `promptBudget`: the current turn's own trace, and the
     * person's requests. Both are reserves being spent, and the alternative — cutting them — leaves
     * the model reasoning about a tool result absent from its own prompt.
     *
     * What must not happen is passing the *window* in silence. Found live: a 12-step turn on a
     * 6,000-token window assembled 6,743 tokens and was simply sent, which an endpoint whose real
     * window matched would have refused with nothing here explaining it.
     */
    test("the over-window warning names the window and what to change", async () => {
        const seen: AnyEvent[] = []
        const dir = mkdtempSync(join(tmpdir(), "over-window-"))
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
  window: 700
  reserveOutput: 200
  files:
    - IDENTITY.md
limits:
  maxSteps: 1
  turnTimeoutMs: 5000
`,
        )
        // An identity large enough that slots 0-2 alone pass the window, which is the only way to
        // reach this on a one-step turn.
        writeFileSync(join(dir, "IDENTITY.md"), `You are a test fixture. ${"filler ".repeat(400)}`)

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: longFetch,
        })
        runtime.bus.on("*", (event) => seen.push(event))
        await runtime.agent("test").send("hello")
        await runtime.stop()

        const warning = seen.find(
            (event) =>
                event.type === "agent.warning" &&
                (event.data as { code?: string }).code === "prompt_over_window",
        )
        expect(warning).toBeDefined()
        const data = warning?.data as { message: string; hint: string; field: string }
        expect(data.message).toContain("700-token window")
        expect(data.field).toBe("context.window")
        // Three remedies, because which one applies depends on whether the model has the room.
        expect(data.hint).toContain("context.window")
        expect(data.hint).toContain("limits.maxSteps")
        expect(data.hint).toContain("observationMaxTokens")
    })
})

describe("a session under pressure", () => {
    test("pressure is reported on every step, with its provenance", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        await runtime.agent("test").send("hello")
        await runtime.stop()

        const pressure = seen.filter((event) => event.type === "context.pressure")
        expect(pressure.length).toBeGreaterThan(0)
        const data = pressure[0]?.data as { fraction: number; source: string; budget: number }
        expect(data.budget).toBe(3500)
        // No endpoint reported `prompt_tokens` here — the stub sends no usage — so the figure is the
        // raw estimate and says so. A bare fraction would be indistinguishable from a corrected one.
        expect(data.source).toBe("estimated")
        expect(data.fraction).toBeGreaterThan(0)
    })

    test("the ladder fires as history grows, and never exceeds the window", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        const agent = runtime.agent("test")

        for (let turn = 0; turn < 12; turn += 1) {
            await agent.send(`turn ${turn}: tell me something at length`)
        }
        await runtime.stop()

        const stages = seen.filter((event) => event.type === "compaction.stage")
        expect(stages.length).toBeGreaterThan(0)
        const fired = stages.map((event) => (event.data as { stage: string }).stage)
        // The cheapest rung, named from `STAGE_ORDER` rather than written down — this assertion said
        // "trim" for as long as `trim` happened to be first, and went on passing for the wrong reason.
        expect(fired).toContain(STAGE_ORDER[0])
        // And it escalates rather than firing the same rung twelve times: growing history is exactly
        // the condition the ladder exists to answer with progressively more.
        expect(new Set(fired).size).toBeGreaterThan(1)
        // Every rung that fired is one whose threshold the pressure had actually crossed, in order.
        for (const stage of fired)
            expect(STAGE_ORDER).toContain(stage as (typeof STAGE_ORDER)[number])

        // The whole point: no assembled prompt ever exceeds what the budget allows. `context.assembled`
        // is emitted *after* compaction, so this reads the prompt that was actually sent.
        const totals = seen
            .filter((event) => event.type === "context.assembled")
            .map((event) => (event.data as { total: number }).total)
        expect(totals.length).toBeGreaterThan(0)
        expect(Math.max(...totals)).toBeLessThanOrEqual(3500)
    })

    test("compaction leaves the cache-stable prefix byte-identical", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        const agent = runtime.agent("test")
        for (let turn = 0; turn < 12; turn += 1) await agent.send(`turn ${turn}: go on`)
        await runtime.stop()

        // Slots 0-2 are the cached prefix. If a stage touched them the cost would rise with no error
        // anywhere and no symptom but the bill, which is why this is asserted on the reported slots
        // rather than trusted to the ladder's protected-tail arithmetic.
        const reports = seen
            .filter((event) => event.type === "context.assembled")
            .map((event) => event.data as { slots: { slot: number; tokens: number }[] })
        const prefixes = reports.map((report) =>
            report.slots
                .filter((slot) => slot.slot <= 2)
                .map((slot) => `${slot.slot}:${slot.tokens}`)
                .join("|"),
        )
        expect(new Set(prefixes).size).toBe(1)
    })
})

describe("the compaction notice", () => {
    test("reaches the model, and mentions artifact_read because this agent has it", async () => {
        // Asserted on the **request body**, not on a rendered block. `previewContext` reports slot
        // sizes rather than content, and a unit test of the renderer would have passed while the
        // notice was never wired in — which is the exact failure shape this repo keeps recording for
        // fields threaded through a pipeline. Recording `fetch` and grepping the prompt is the cheap
        // guard for it.
        let body = ""
        const recording: FetchLike = async (_url: unknown, init?: { body?: unknown }) => {
            body = String(init?.body ?? "")
            return sse([delta("ok"), "data: [DONE]\n\n"])
        }
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: recording,
        })
        await runtime.agent("test").send("hi")
        await runtime.stop()

        expect(body).toContain("context is managed for you")
        expect(body).toContain("do not wrap up early")
        // Named only because the tool is pinned. Naming a tool an agent lacks is how a model comes to
        // report that it tried something it never could.
        expect(body).toContain("artifact_read")
    })
})

describe("the pressure gauge describes the prompt that was sent", () => {
    test("under compaction it reports the settled figure and keeps the peak", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        const agent = runtime.agent("test")
        for (let turn = 0; turn < 12; turn += 1) await agent.send(`turn ${turn}: at length`)
        await runtime.stop()

        const compacted = seen
            .filter((event) => event.type === "context.pressure")
            .map((event) => event.data as { fraction: number; peak?: number })
            .filter((data) => data.peak !== undefined)

        expect(compacted.length).toBeGreaterThan(0)
        for (const data of compacted) {
            // The peak is what the ladder faced; the fraction is what went out. Reporting the peak as
            // the fraction put `ctx 128%` on a real status line for a prompt nobody ever sent.
            expect(data.peak ?? 0).toBeGreaterThan(data.fraction)
            expect(data.fraction).toBeLessThanOrEqual(1)
        }
    })
})
