/**
 * Outbound webhooks: the signature, the target check, and delivery per crash point.
 *
 * The signature is checked against the **Standard Webhooks published test vector**, not against
 * our own signer: a scheme verified only by the code that produces it proves agreement with itself,
 * and the point of a standard is that a receiver's existing library accepts what we send.
 */

import { EventBus } from "../src/events/bus.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
import {
    checkWebhookTarget,
    EMPTY_ALLOWLIST,
    type LookupLike,
    parseWebhookAllowlist,
    signWebhook,
    verifyWebhook,
    WebhookDispatcher,
    webhookMessageId,
} from "../src/webhooks/webhooks.ts"
import { describe, expect, test } from "./_harness.ts"

describe("signing", () => {
    test("matches the Standard Webhooks test vector", () => {
        const vector = {
            secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
            id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
            timestamp: 1614265330,
            body: '{"test": 2432232314}',
        }
        expect(signWebhook(vector)).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=")
    })

    test("a tampered body, a wrong secret and a stale timestamp all fail verification", () => {
        const base = {
            secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0",
            id: "msg_1",
            timestamp: 1_000,
            body: "{}",
        }
        const signature = signWebhook(base)
        expect(verifyWebhook({ ...base, signature, nowSec: 1_000 })).toBe(true)
        expect(verifyWebhook({ ...base, body: "{ }", signature, nowSec: 1_000 })).toBe(false)
        expect(
            verifyWebhook({
                ...base,
                secret: "whsec_b3RoZXJvdGhlcm90aGVy",
                signature,
                nowSec: 1_000,
            }),
        ).toBe(false)
        expect(verifyWebhook({ ...base, signature, nowSec: 1_000 + 301 })).toBe(false)
        // Several signatures in one header (key rotation) are accepted if any matches.
        expect(verifyWebhook({ ...base, signature: `v1,AAAA ${signature}`, nowSec: 1_000 })).toBe(
            true,
        )
    })
})

describe("the target", () => {
    const resolvesTo =
        (...addresses: string[]): LookupLike =>
        async () =>
            addresses.map((address) => ({ address }))

    async function codeOf(
        url: string,
        lookup: LookupLike,
        allow = EMPTY_ALLOWLIST,
    ): Promise<string> {
        try {
            await checkWebhookTarget(url, { allow, lookup })
            return "ok"
        } catch (error) {
            return (error as { code: string }).code
        }
    }

    test("public is fine; the metadata endpoint is refused even when its range is listed", async () => {
        expect(await codeOf("https://hooks.example.com/x", resolvesTo("93.184.216.34"))).toBe("ok")
        const everything = parseWebhookAllowlist("169.254.0.0/16, 0.0.0.0/0", "test")
        expect(
            await codeOf(
                "http://169.254.169.254/latest",
                resolvesTo("169.254.169.254"),
                everything,
            ),
        ).toBe("webhook_target_refused")
    })

    test("private is refused unless the operator lists the host or the range", async () => {
        const docker = resolvesTo("172.18.0.5")
        expect(await codeOf("http://velacrew-api:3000/hooks", docker)).toBe(
            "webhook_target_refused",
        )
        expect(
            await codeOf(
                "http://velacrew-api:3000/hooks",
                docker,
                parseWebhookAllowlist("velacrew-api", "t"),
            ),
        ).toBe("ok")
        expect(
            await codeOf(
                "http://velacrew-api:3000/hooks",
                docker,
                parseWebhookAllowlist("172.16.0.0/12", "t"),
            ),
        ).toBe("ok")
        // Loopback wearing an IPv6 hat is still loopback.
        expect(await codeOf("http://[::ffff:127.0.0.1]/", resolvesTo("::ffff:127.0.0.1"))).toBe(
            "webhook_target_refused",
        )
    })

    test("every answer is checked, a name that does not resolve is refused, credentials are refused", async () => {
        expect(
            await codeOf("https://mixed.example.com", resolvesTo("93.184.216.34", "10.0.0.1")),
        ).toBe("webhook_target_refused")
        expect(await codeOf("https://nowhere.example", resolvesTo())).toBe(
            "webhook_target_unresolved",
        )
        expect(await codeOf("https://u:p@hooks.example.com", resolvesTo("93.184.216.34"))).toBe(
            "webhook_url_invalid",
        )
        expect(await codeOf("ftp://hooks.example.com", resolvesTo("93.184.216.34"))).toBe(
            "webhook_url_invalid",
        )
    })

    test("a malformed allowlist entry is named", () => {
        expect(() => parseWebhookAllowlist("10.0.0.0/33", "WEBHOOK_ALLOW")).toThrow(/10.0.0.0\/33/)
    })
})

describe("delivery", () => {
    const publicDns: LookupLike = async () => [{ address: "93.184.216.34" }]

    async function setup(respond: (attempt: number) => number = () => 200) {
        const store = await openMemoryStore()
        const bus = new EventBus({ runtimeId: "rt_test" })
        const sent: { id: string; signature: string; timestamp: string; body: string }[] = []
        const fetch: FetchLike = async (_url, init) => {
            const headers = init?.headers as Record<string, string>
            sent.push({
                id: headers["webhook-id"] ?? "",
                signature: headers["webhook-signature"] ?? "",
                timestamp: headers["webhook-timestamp"] ?? "",
                body: String(init?.body),
            })
            return new Response("", { status: respond(sent.length) })
        }
        let now = Date.parse("2026-09-24T12:00:00Z")
        const make = () =>
            new WebhookDispatcher({
                store: store.webhooks,
                bus,
                fetch,
                allow: EMPTY_ALLOWLIST,
                lookup: publicDns,
                agents: () => ["a"],
                now: () => now,
                backoffMs: [1_000, 2_000],
                userAgent: "test",
            })
        await store.webhooks.create({
            subscriptionId: "wh_1",
            url: "https://hooks.example.com/in",
            secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0",
            types: ["turn.end"],
            createdAt: new Date(now).toISOString(),
        })
        const dispatcher = make()
        await dispatcher.attach()
        return { store, bus, sent, dispatcher, make, advance: (ms: number) => (now += ms) }
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

    test("an event is delivered once, signed, and verifies with the documented scheme", async () => {
        const t = await setup()
        t.bus.emit(
            "turn.end",
            { reason: "final", steps: 1, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a", sessionKey: "api:x", turnId: "t_1" },
        )
        await settle()
        await t.dispatcher.drain()
        expect(t.sent.length).toBe(1)
        const [first] = t.sent
        expect(
            verifyWebhook({
                secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0",
                id: first?.id ?? "",
                timestamp: Number(first?.timestamp),
                body: first?.body ?? "",
                signature: first?.signature ?? "",
                nowSec: Number(first?.timestamp),
            }),
        ).toBe(true)
        expect(JSON.parse(first?.body ?? "{}").type).toBe("turn.end")
        // Sent means sent: a second drain sends nothing.
        await t.dispatcher.drain()
        expect(t.sent.length).toBe(1)
        await t.store.close()
    })

    test("types, scope and chunks decide who hears what", async () => {
        const t = await setup()
        await t.store.webhooks.create({
            subscriptionId: "wh_scoped",
            url: "https://hooks.example.com/b",
            secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0",
            types: ["turn.end", "model.chunk"],
            scope: { agents: ["b"] },
            createdAt: new Date().toISOString(),
        })
        await t.dispatcher.changed()
        t.bus.emit(
            "tool.call",
            { slug: "now", callId: "c", argsHash: "h", mutating: false },
            { agentId: "a" },
        )
        t.bus.emit(
            "turn.end",
            { reason: "final", steps: 1, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a" },
        )
        await settle()
        const pending = await t.store.webhooks.list()
        // wh_1 wants turn.end only and hears agent a; wh_scoped hears only agent b.
        expect(pending.map((s) => [s.subscriptionId, s.pending])).toEqual([
            ["wh_1", 1],
            ["wh_scoped", 0],
        ])
        await t.store.close()
    })

    test("the same event enqueued twice is one delivery", async () => {
        const t = await setup()
        const body = '{"same":true}'
        const row = {
            subscriptionId: "wh_1",
            messageId: webhookMessageId("wh_1", body),
            agentId: "a",
            eventType: "turn.end",
            body,
            at: new Date().toISOString(),
        }
        expect(await t.store.webhooks.enqueue(row)).toBe(true)
        expect(await t.store.webhooks.enqueue(row)).toBe(false)
        await t.store.close()
    })

    test("a failure retries with the same id, then gives up, and the subscription says so", async () => {
        const t = await setup(() => 500)
        t.bus.emit(
            "turn.end",
            { reason: "final", steps: 1, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a" },
        )
        await settle()
        await t.dispatcher.drain() // attempt 1 → retry in 1s
        await t.dispatcher.drain() // not due yet
        expect(t.sent.length).toBe(1)
        t.advance(1_000)
        await t.dispatcher.drain() // attempt 2 → retry in 2s
        t.advance(2_000)
        await t.dispatcher.drain() // attempt 3 → out of backoff: failed
        t.advance(10_000)
        await t.dispatcher.drain()
        expect(t.sent.length).toBe(3)
        expect(new Set(t.sent.map((s) => s.id)).size).toBe(1)
        const [sub] = await t.store.webhooks.list()
        expect(sub?.consecutiveFailures).toBe(3)
        expect(sub?.lastError).toBe("HTTP 500")
        expect(sub?.pending).toBe(0)
        await t.store.close()
    })

    test("a crash mid-send re-sends under the same id, flagged uncertain; a sent one is not re-sent", async () => {
        const t = await setup()
        t.bus.emit(
            "turn.end",
            { reason: "final", steps: 1, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a" },
        )
        t.bus.emit(
            "turn.end",
            { reason: "max_steps", steps: 4, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a" },
        )
        await settle()
        // Crash point: both claimed (inflight), one acknowledged, the process dies.
        const claimed = await t.store.webhooks.claimDue(
            ["a"],
            new Date(Date.parse("2026-09-24T12:00:00Z")).toISOString(),
            10,
        )
        expect(claimed.length).toBe(2)
        await t.store.webhooks.markSent(
            claimed[0]?.subscriptionId ?? "",
            claimed[0]?.messageId ?? "",
            new Date().toISOString(),
        )

        // A new process recovers what was left in flight.
        const next = t.make()
        await next.attach()
        const recovered = await next.start()
        next.stop()
        expect(recovered.map((r) => [r.messageId, r.uncertain])).toEqual([
            [claimed[1]?.messageId, true],
        ])
        await next.drain()
        expect(t.sent.map((s) => s.id)).toEqual([claimed[1]?.messageId])
        await t.store.close()
    })

    test("a target that became private is failed, not retried", async () => {
        const store = await openMemoryStore()
        const bus = new EventBus({ runtimeId: "rt" })
        const sent: string[] = []
        const dispatcher = new WebhookDispatcher({
            store: store.webhooks,
            bus,
            fetch: async (url) => {
                sent.push(String(url))
                return new Response("")
            },
            allow: EMPTY_ALLOWLIST,
            lookup: async () => [{ address: "10.0.0.7" }],
            agents: () => ["a"],
            userAgent: "test",
        })
        await store.webhooks.create({
            subscriptionId: "wh",
            url: "https://rebound.example/",
            secret: "whsec_c2VjcmV0",
            types: ["turn.end"],
            createdAt: new Date().toISOString(),
        })
        await dispatcher.attach()
        bus.emit(
            "turn.end",
            { reason: "final", steps: 1, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a" },
        )
        await settle()
        await dispatcher.drain()
        expect(sent).toEqual([])
        const [sub] = await store.webhooks.list()
        expect(sub?.lastError).toContain("webhook_target_refused")
        expect(sub?.pending).toBe(0)
        await store.close()
    })

    test("removing an agent removes its pending deliveries and keeps the subscription", async () => {
        const t = await setup()
        t.bus.emit(
            "turn.end",
            { reason: "final", steps: 1, tokens: { prompt: 1, output: 1 }, durationMs: 1 },
            { agentId: "a" },
        )
        await settle()
        await t.store.purgeAgent("a")
        const [sub] = await t.store.webhooks.list()
        expect(sub?.subscriptionId).toBe("wh_1")
        expect(sub?.pending).toBe(0)
        await t.store.close()
    })
})
