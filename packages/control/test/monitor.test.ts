/**
 * The pilot monitor: subscription at create, signed receipt, rates, alerts with hysteresis, and
 * deletion taking a silo's rows with it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { AddressInfo } from "node:net"
import { Readable } from "node:stream"
import { gzipSync } from "node:zlib"
import { ControlPlane } from "../src/control.ts"
import { MONITORED_TYPES, Monitor, verifySignature } from "../src/monitor.ts"
import { createControlServer } from "../src/server.ts"
import { SiloStore } from "../src/store.ts"
import { FakePlacer } from "./fake.ts"

const TOKEN = "operator-token"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup(rules = { window: 10, minTurns: 4, nonFinal: 0.2, toolErrors: 0.5 }) {
    const store = await SiloStore.open(":memory:")
    const placer = new FakePlacer()
    const alerts: string[] = []
    const monitor = new Monitor({
        store,
        hookUrl: "http://control.test:7600",
        rules,
        alert: async (text) => {
            alerts.push(text)
        },
        log: () => {},
    })
    const control = new ControlPlane({ store, placer, monitor, readyTimeoutMs: 300, log: () => {} })
    const server = createControlServer({ control, token: TOKEN, monitor })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cleanups.push(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        await placer.closeAll()
        store.close()
    })
    let n = 0
    /** Deliver one event exactly as a silo would: Standard Webhooks, signed with the secret. */
    const deliver = async (
        subject: string,
        event: Record<string, unknown>,
        sign = true,
        id?: string,
    ) => {
        const secret = store.hook(subject)?.secret ?? "whsec_AAAA"
        n += 1
        const webhookId = id ?? `msg_${n}`
        const ts = String(Math.floor(Date.now() / 1000))
        const body = JSON.stringify({
            v: 1,
            ts: new Date().toISOString(),
            agentId: "helper",
            ...event,
        })
        const mac = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
            .update(`${webhookId}.${ts}.${body}`)
            .digest("base64")
        return fetch(`${base}/hooks/${subject}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "webhook-id": webhookId,
                "webhook-timestamp": ts,
                "webhook-signature": sign ? `v1,${mac}` : "v1,AAAA",
            },
            body,
        })
    }
    const call = (path: string) =>
        fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const create = (subject: string) =>
        fetch(`${base}/v1/silos`, {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ subject }),
        })
    return { store, placer, control, alerts, deliver, call, create }
}

const turn = (turnId: string, reason = "final", extra: Record<string, unknown> = {}) => ({
    type: "turn.end",
    turnId,
    data: { reason, steps: 2, tokens: { prompt: 100, output: 20 }, durationMs: 900, ...extra },
})

describe("the monitor", () => {
    test("each new silo is subscribed, with the silo's token, to the events the rates need", async () => {
        const { create, placer, store } = await setup()
        expect((await create("a")).status).toBe(201)
        const silo = placer.silos.get("silo-a")
        expect(silo?.webhooks).toEqual([
            { url: "http://control.test:7600/hooks/a", types: [...MONITORED_TYPES] },
        ])
        const seen = silo?.seen.find((s) => s.path === "/v1/webhooks")
        expect(seen?.auth).toBe(store.get("a")?.token)
        expect(store.hook("a")?.subscriptionId).toBe("wh_1")
    })

    test("only a correctly signed delivery is recorded, and a redelivery counts once", async () => {
        const { create, deliver, call } = await setup()
        await create("a")
        expect((await deliver("a", turn("t1"), false)).status).toBe(401)
        expect((await deliver("nobody", turn("t1"))).status).toBe(401)
        expect((await deliver("a", turn("t1"), true, "msg_same")).status).toBe(204)
        expect((await deliver("a", turn("t1"), true, "msg_same")).status).toBe(204)
        const report = (await (await call("/v1/monitor")).json()) as { overall: { turns: number } }
        expect(report.overall.turns).toBe(1)
    })

    test("rates: non-final share, reasons, first token from the turn's first model call, tool errors", async () => {
        const { create, deliver, call } = await setup()
        await create("a")
        await deliver("a", {
            type: "model.result",
            turnId: "t1",
            data: { firstTokenMs: 300, latencyMs: 900 },
        })
        await deliver("a", {
            type: "model.result",
            turnId: "t1",
            data: { firstTokenMs: 50, latencyMs: 400 },
        })
        await deliver("a", turn("t1"))
        await deliver("a", turn("t2", "max_steps"))
        await deliver("a", { type: "tool.result", turnId: "t2", data: { slug: "exec", ok: false } })
        await deliver("a", { type: "tool.result", turnId: "t2", data: { slug: "now", ok: true } })
        const report = (await (await call("/v1/monitor")).json()) as {
            overall: {
                turns: number
                nonFinalRate: number
                reasons: Record<string, number>
                firstTokenMs: { p50?: number }
                toolErrorRate: number
                tokensPerTurn: number
            }
            unmonitored: string[]
        }
        expect(report.overall.turns).toBe(2)
        expect(report.overall.nonFinalRate).toBe(0.5)
        expect(report.overall.reasons).toEqual({ final: 1, max_steps: 1 })
        // The first model call's figure, not the second step's.
        expect(report.overall.firstTokenMs.p50).toBe(300)
        expect(report.overall.toolErrorRate).toBe(0.5)
        expect(report.overall.tokensPerTurn).toBe(120)
        expect(report.unmonitored).toEqual([])

        const failures = (await (await call("/v1/monitor/failures")).json()) as {
            failures: { type: string; reason?: string; detail?: string }[]
        }
        expect(failures.failures.map((f) => f.reason ?? f.detail).sort()).toEqual([
            "exec",
            "max_steps",
        ])
    })

    test("a rate alert fires once on crossing and once on recovery, and never below the minimum sample", async () => {
        const { create, deliver, alerts } = await setup({
            window: 4,
            minTurns: 4,
            nonFinal: 0.3,
            toolErrors: 1,
        })
        await create("a")
        await deliver("a", turn("t1", "error"))
        await deliver("a", turn("t2", "error"))
        await deliver("a", turn("t3"))
        expect(alerts).toEqual([]) // three turns is below the minimum sample
        await deliver("a", turn("t4"))
        expect(alerts.length).toBe(1)
        expect(alerts[0]).toContain("non-final turns")
        await deliver("a", turn("t5", "error")) // still crossed: no second alert
        expect(alerts.length).toBe(1)
        for (const id of ["t6", "t7", "t8", "t9"]) await deliver("a", turn(id))
        expect(alerts.length).toBe(2)
        expect(alerts[1]).toContain("recovered")
    })

    test("a lost delivery alerts at once", async () => {
        const { create, deliver, alerts } = await setup()
        await create("a")
        await deliver("a", {
            type: "delivery.failed",
            data: { exhausted: false, error: { code: "telegram_refused", message: "retrying" } },
        })
        expect(alerts).toEqual([])
        await deliver("a", {
            type: "delivery.failed",
            data: {
                exhausted: true,
                error: { code: "telegram_refused", message: "chat not found" },
            },
        })
        expect(alerts.length).toBe(1)
        expect(alerts[0]).toContain("lost message in a")
    })

    test("a restore re-subscribes the silo as itself, dropping the source's subscription", async () => {
        const { create, control, placer, store } = await setup()
        await create("a")
        await create("c")
        // What restoring A's archive into C leaves in C: A's subscription, pointing at A's hook.
        const silo = placer.silos.get("silo-c")
        silo?.webhooks.splice(0, silo.webhooks.length, {
            url: "http://control.test:7600/hooks/a",
            types: [],
        })
        await control.restore("c", Readable.from([gzipSync("archive of a")]))
        const live = silo?.webhooks
            .filter((hook) => hook.url !== "(deleted)")
            .map((hook) => hook.url)
        expect(live).toEqual(["http://control.test:7600/hooks/c"])
        expect(store.hook("c")).toBeDefined()
    })

    test("deleting a silo deletes everything recorded about it", async () => {
        const { create, deliver, control, store } = await setup()
        await create("a")
        await create("b")
        await deliver("a", turn("t1"))
        await deliver("b", turn("t2"))
        await control.remove("a")
        expect(store.hook("a")).toBeUndefined()
        expect(store.events("turn.end", 10, "a")).toEqual([])
        expect(store.events("turn.end", 10, "b").length).toBe(1)
    })

    test("the signature check refuses a stale timestamp", () => {
        const secret = `whsec_${Buffer.from("k").toString("base64")}`
        const now = 1_700_000_000
        const sign = (ts: number) =>
            `v1,${createHmac("sha256", Buffer.from("k")).update(`id.${ts}.body`).digest("base64")}`
        expect(
            verifySignature(
                secret,
                { id: "id", timestamp: String(now), signature: sign(now) },
                "body",
                now,
            ),
        ).toBe(true)
        expect(
            verifySignature(
                secret,
                { id: "id", timestamp: String(now - 600), signature: sign(now - 600) },
                "body",
                now,
            ),
        ).toBe(false)
    })
})
