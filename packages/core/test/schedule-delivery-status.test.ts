/**
 * A scheduled run whose delivery failed must stop reporting `ok`.
 *
 * ## The failure
 *
 * A real 15-minute schedule fired correctly, the turn completed, and the send came back
 * `Bad Request: chat not found` — permanently, every quarter of an hour. Every surface reported
 * success: `schedules` printed `ok just now`, the service's `err.log` stayed at zero bytes, and
 * `daemon status` exited 0. The outbox emitted `delivery.failed` and **nothing anywhere subscribed
 * to it**, which is the same empty-room shape this repo has recorded for boot warnings and for
 * `LeaseOutcome.declined`.
 *
 * ## Why it is tested here rather than on the store
 *
 * `markDeliveryFailed` is asserted directly in `schedule-provenance.test.ts`, and it was never the
 * part at risk. What is at risk is the *wire*: a subscription in `Runtime.create` that could be
 * absent, mistyped, or guarded behind `startSchedules` and would fail silently in every one of those
 * cases. So this drives the real bus and reads the durable row at the far end.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { loadManifest } from "../src/manifest/load.ts"
import { scheduleDeliveryWarnings } from "../src/manifest/validate.ts"
import type { ChannelFactory } from "../src/runtime/channels.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key", TELEGRAM_BOT_TOKEN: "test-token" }
/** Core registers no channel, so the load has to be told which types the caller can supply. */
const CHANNEL_TYPES = ["telegram", "whatsapp"]
const dirs: string[] = []

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "sched-delivery-"))
    dirs.push(dir)
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
name: Test Agent
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
schedules:
  - id: hi-every-15
    kind: every
    expr: 15m
    task: "Say exactly: hi"
    deliver: none
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    return join(dir, "agent.yaml")
}

/** Waits for the subscription's own write, which is deliberately not awaited by the emitter. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 5))
}

describe("a delivery failure reaches the schedule row through the runtime", () => {
    test("the bus subscription records it, and does not need the scheduler to be running", async () => {
        const path = manifest()
        const store = join(mkdtempSync(join(tmpdir(), "sched-delivery-store-")), "store.db")
        // No `startSchedules`. The outbox drains under `run` too, so a failure has to be recorded
        // whether or not this process is the one that fires schedules.
        const runtime = await Runtime.create({ agents: [path], env: ENV, store })
        const agent = runtime.list()[0]
        expect(agent).toBeDefined()
        if (agent === undefined) return

        await agent.store.schedules.markFired(agent.id, "hi-every-15", {
            firedAt: "2026-08-27T14:25:33.000Z",
            anchorAt: "2026-08-27T14:40:30.000Z",
            nextRunAt: "2026-08-27T14:40:30.000Z",
            status: "ok",
            runId: "r_live",
        })

        runtime.bus.emit(
            "delivery.failed",
            {
                channelId: "tg",
                chunkIndex: 0,
                chunkTotal: 1,
                attempts: 1,
                exhausted: false,
                abandoned: 0,
                error: {
                    code: "telegram_refused",
                    message: "Telegram refused sendMessage: Bad Request: chat not found",
                    hint: "Use the numeric chat id.",
                },
            },
            { agentId: agent.id, sessionKey: "schedule:hi-every-15:r_live" },
        )
        await settle()

        const row = await agent.store.schedules.get(agent.id, "hi-every-15")
        expect(row?.lastStatus).toBe("error")
        expect(row?.lastError).toContain("chat not found")

        await runtime.stop("test done")
    })

    test("a failure on an ordinary conversation touches no schedule", async () => {
        // The other half. Without it the subscription could write on every delivery failure in the
        // process and this file would still be green.
        const path = manifest()
        const store = join(mkdtempSync(join(tmpdir(), "sched-delivery-store-")), "store.db")
        const runtime = await Runtime.create({ agents: [path], env: ENV, store })
        const agent = runtime.list()[0]
        expect(agent).toBeDefined()
        if (agent === undefined) return

        await agent.store.schedules.markFired(agent.id, "hi-every-15", {
            firedAt: "2026-08-27T14:25:33.000Z",
            anchorAt: "2026-08-27T14:40:30.000Z",
            nextRunAt: "2026-08-27T14:40:30.000Z",
            status: "ok",
            runId: "r_live",
        })

        runtime.bus.emit(
            "delivery.failed",
            {
                channelId: "tg",
                chunkIndex: 0,
                chunkTotal: 1,
                attempts: 1,
                exhausted: false,
                abandoned: 0,
                error: { code: "telegram_refused", message: "chat not found", hint: "-" },
            },
            { agentId: agent.id, sessionKey: "tg:1195568132" },
        )
        await settle()

        expect((await agent.store.schedules.get(agent.id, "hi-every-15"))?.lastStatus).toBe("ok")

        await runtime.stop("test done")
    })
})

/**
 * The other half of the same failure: a target that is going to fail every time.
 *
 * Telegram's `chat_id` takes `@name` for a **channel** and nothing else, so a private recipient must
 * be the numeric chat id. `allowFrom` holds handles, they are the form a person recognises, and
 * copying one across is the obvious move — the live agent that produced this bug did exactly that.
 *
 * A warning and never a refusal: `@somechannel` is a legitimate target, and a heuristic that refuses
 * to load a manifest is a heuristic nobody keeps.
 */
function withDelivery(to: string, channelType = "telegram"): string {
    const dir = mkdtempSync(join(tmpdir(), "sched-warn-"))
    dirs.push(dir)
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
name: Test Agent
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
channels:
  - type: ${channelType}
    id: tg
    tokenEnv: TELEGRAM_BOT_TOKEN
schedules:
  - id: hi-every-15
    kind: every
    expr: 15m
    task: "Say exactly: hi"
    deliver:
      channel: tg
      to: "${to}"
`,
    )
    return join(dir, "agent.yaml")
}

function warnings(to: string, channelType?: string): readonly string[] {
    const loaded = loadManifest(withDelivery(to, channelType), {
        env: ENV,
        knownChannels: CHANNEL_TYPES,
    })
    return scheduleDeliveryWarnings(loaded.manifest).map((warning) => warning.code)
}

describe("a Telegram handle in deliver.to is warned about, never refused", () => {
    test("an @handle on a telegram channel warns", () => {
        expect(warnings("@moeen_mahmud")).toEqual(["schedule_delivery_handle"])
    })

    test("the numeric chat id is silent — it is the working form", () => {
        expect(warnings("1195568132")).toEqual([])
    })

    test("a non-telegram channel is silent, because the rule is Telegram's", () => {
        // Not a claim that every other transport takes handles. It is a claim that this check knows
        // one service's addressing rules and must not pretend to know another's.
        expect(warnings("@somebody", "whatsapp")).toEqual([])
    })

    test("it warns rather than failing the load", () => {
        // The whole reason it is not in `validateSchedules`: `@somechannel` is a real target, and a
        // manifest that will not load is a far worse outcome than a line of advice.
        const loaded = loadManifest(withDelivery("@moeen_mahmud"), {
            env: ENV,
            knownChannels: CHANNEL_TYPES,
        })
        expect(loaded.manifest.schedules[0]?.deliver).toEqual({
            channel: "tg",
            to: "@moeen_mahmud",
        })
    })
})

/**
 * The warning has to reach the surface a person actually looks at, which is not `validate`.
 *
 * `validate` is run deliberately; a boot warning is seen by whoever starts the agent, which is the
 * only moment this one is useful. `Runtime.create` emits during boot — before any command can
 * subscribe — so it is read off `agent.warnings` rather than caught on the bus, exactly as the
 * provider and window warnings are.
 */
const telegramStub: ChannelFactory = (context) => ({
    id: context.id,
    type: "telegram",
    limits: { maxMessageChars: 4096, idempotentSend: false },
    start: async () => {},
    stop: async () => {},
    send: async () => ({ ok: true as const, providerMessageId: "1" }),
})

describe("the handle warning reaches a booted agent", () => {
    test("it is on agent.warnings, where a banner still finds it after boot", async () => {
        const store = join(mkdtempSync(join(tmpdir(), "sched-warn-store-")), "store.db")
        const runtime = await Runtime.create({
            agents: [withDelivery("@moeen_mahmud")],
            env: ENV,
            store,
            channels: { telegram: telegramStub },
        })
        const agent = runtime.list()[0]
        expect(agent?.warnings.map((warning) => warning.code)).toContain("schedule_delivery_handle")
        await runtime.stop("test done")
    })

    test("the working form boots silent, so the warning means something when it appears", async () => {
        const store = join(mkdtempSync(join(tmpdir(), "sched-warn-store-")), "store.db")
        const runtime = await Runtime.create({
            agents: [withDelivery("1195568132")],
            env: ENV,
            store,
            channels: { telegram: telegramStub },
        })
        const agent = runtime.list()[0]
        expect(agent?.warnings.map((warning) => warning.code)).not.toContain(
            "schedule_delivery_handle",
        )
        await runtime.stop("test done")
    })
})
