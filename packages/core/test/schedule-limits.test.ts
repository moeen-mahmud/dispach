/**
 * Limits per schedule (pilot.5, VelaCrew #15): `tools.allow`, `timeoutMs`, `maxSteps`.
 *
 * Driven through the real runner and a real `Runtime`, reading request bodies, because the fields
 * cross the manifest, the store, the runner, `Agent.send` and the turn: five places a spread can
 * drop one with nothing failing.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { HarnessError } from "../src/errors.ts"
import { EventBus } from "../src/events/bus.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { prepareScheduleWrite, scheduleRunner } from "../src/runtime/schedules.ts"
import { Scheduler } from "../src/schedule/scheduler.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
import type { ScheduleRecord } from "../src/store/store.ts"
import { describe, expect, test } from "./_harness.ts"

function manifest(schedule: string, maxSteps = 6): string {
    const dir = mkdtempSync(join(tmpdir(), "schedule-limits-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  local: [now, memory_write]
limits:
  maxSteps: ${maxSteps}
schedules:
${schedule}
`,
    )
    return join(dir, "agent.yaml")
}

const BRIEF = `  - id: brief
    kind: every
    expr: 1h
    task: Say the time.
    deliver: none
    tools:
      allow: [now]
    maxSteps: 99`

/** A model that calls `now` every step, so the step cap is what ends the turn. */
function looping() {
    const bodies: string[] = []
    const fetch: FetchLike = async (_url, init) => {
        bodies.push(String(init?.body ?? ""))
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "ACTION: now\nEND" } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    return { bodies, fetch }
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
    try {
        await work
        return undefined
    } catch (error) {
        return (error as { code?: string }).code
    }
}

async function run(runtime: Runtime, id: string) {
    const record = await runtime.agent("test")?.store.schedules.get("test", id)
    if (record === undefined) throw new Error(`no schedule ${id}`)
    return scheduleRunner({ agents: () => runtime.list(), hub: runtime.channels })(record, "run1")
}

describe("a schedule's limits", () => {
    test("are stored, and come back off the row", async () => {
        const store = await openMemoryStore()
        await store.schedules.upsert({
            agentId: "a",
            id: "s",
            kind: "every",
            expr: "1h",
            task: "t",
            sessionMode: "isolated",
            toolsAllow: ["now", "tag:read"],
            timeoutMs: 60_000,
            maxSteps: 5,
            enabled: true,
            origin: "api",
            anchorAt: "2026-10-02T00:00:00.000Z",
            nextRunAt: undefined,
            sourcePath: "",
            now: "2026-10-02T00:00:00.000Z",
        })
        const row = (await store.schedules.get("a", "s")) as ScheduleRecord
        expect(row.toolsAllow).toEqual(["now", "tag:read"])
        expect(row.timeoutMs).toBe(60_000)
        expect(row.maxSteps).toBe(5)
        await store.close()
    })

    test("tools.allow narrows the catalogue the run's model is shown", async () => {
        const { bodies, fetch } = looping()
        const runtime = await Runtime.create({
            agents: [manifest(BRIEF)],
            env: { MODEL_API_KEY: "k" },
            fetch,
        })
        await codeOf(run(runtime, "brief"))
        expect(bodies[0]).toContain("now")
        expect(bodies[0]).not.toContain("memory_write")
        // An ordinary turn still has both.
        await runtime.agent("test")?.send("hi", { sessionKey: "api:x" })
        expect(bodies.at(-1)).toContain("memory_write")
        await runtime.stop()
    })

    test("maxSteps can lower the manifest's cap and never raise it; a cut run is an error", async () => {
        const { bodies, fetch } = looping()
        const runtime = await Runtime.create({
            agents: [manifest(BRIEF, 2)],
            env: { MODEL_API_KEY: "k" },
            fetch,
        })
        // The schedule says 99, the manifest 2: two model calls, then the cap.
        expect(await codeOf(run(runtime, "brief"))).toBe("turn_max_steps")
        expect(bodies.length).toBe(2)
        await runtime.stop()

        const lower = looping()
        const second = await Runtime.create({
            agents: [manifest(BRIEF.replace("maxSteps: 99", "maxSteps: 1"), 6)],
            env: { MODEL_API_KEY: "k" },
            fetch: lower.fetch,
        })
        await codeOf(run(second, "brief"))
        expect(lower.bodies.length).toBe(1)
        await second.stop()
    })

    test("timeoutMs ends the run as turn_timeout", async () => {
        const hanging: FetchLike = (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(new DOMException("aborted", "AbortError")),
                )
            })
        const runtime = await Runtime.create({
            agents: [manifest(BRIEF.replace("maxSteps: 99", "timeoutMs: 50"))],
            env: { MODEL_API_KEY: "k" },
            fetch: hanging,
        })
        let caught: { code?: string; hint?: string; message?: string } = {}
        try {
            await run(runtime, "brief")
        } catch (error) {
            caught = error as typeof caught
        }
        expect(caught.code).toBe("turn_timeout")
        // The schedule's own limit is what a person editing it should change, not `limits`.
        expect(caught.hint).toContain("This schedule's timeoutMs is 50 ms")
        expect(caught.message).not.toContain("..")
        await runtime.stop()
    })

    test("an allow entry naming nothing the agent has is refused at load and at write", async () => {
        expect(
            await codeOf(
                Runtime.create({
                    agents: [manifest(BRIEF.replace("allow: [now]", "allow: [gmail_send]"))],
                    env: { MODEL_API_KEY: "k" },
                }),
            ),
        ).toBe("schedule_tool_unknown")

        const runtime = await Runtime.create({
            agents: [manifest(BRIEF)],
            env: { MODEL_API_KEY: "k" },
        })
        const agent = runtime.agent("test")
        let code: string | undefined
        try {
            prepareScheduleWrite({
                agentId: "test",
                body: {
                    id: "api",
                    kind: "every",
                    expr: "1h",
                    task: "t",
                    deliver: "none",
                    tools: { allow: ["tag:nonexistent"] },
                },
                channelIds: [],
                roleNames: ["main"],
                toolSpecs: agent?.tools.specs() ?? [],
                now: Date.now(),
                origin: "api",
            })
        } catch (error) {
            code = (error as { code?: string }).code
        }
        expect(code).toBe("schedule_tool_unknown")
        await runtime.stop()
    })
})

describe("schedule.error", () => {
    test("carries the cause's own code and hint", async () => {
        const store = await openMemoryStore()
        const bus = new EventBus({ runtimeId: "test" })
        const errors: { code: string; hint: string }[] = []
        bus.on("schedule.error", (event) => {
            errors.push(event.data as { code: string; hint: string })
        })
        let pending: (() => void) | undefined
        let now = Date.parse("2026-08-25T08:00:00.000Z")
        const scheduler = new Scheduler({
            store: store.schedules,
            bus,
            agentIds: () => ["a"],
            now: () => now,
            setTimer: (fire) => {
                pending = fire
                return () => {
                    pending = undefined
                }
            },
            run: async () => {
                throw new HarnessError({
                    code: "turn_timeout",
                    message: "ran out of time",
                    hint: "raise timeoutMs",
                })
            },
        })
        await store.schedules.upsert({
            agentId: "a",
            id: "s",
            kind: "every",
            expr: "15m",
            task: "t",
            sessionMode: "isolated",
            enabled: true,
            origin: "api",
            anchorAt: "2026-08-25T08:00:00.000Z",
            nextRunAt: "2026-08-25T08:15:00.000Z",
            sourcePath: "",
            now: "2026-08-25T08:00:00.000Z",
        })
        await scheduler.start()
        await new Promise((resolve) => setTimeout(resolve, 10))
        now = Date.parse((await store.schedules.get("a", "s"))?.nextRunAt ?? "")
        pending?.()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(errors[0]?.code).toBe("turn_timeout")
        expect(errors[0]?.hint).toBe("raise timeoutMs")
        await scheduler.stop()
        await store.close()
    })
})
