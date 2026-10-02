/**
 * `/v1/webhooks`: create, list, delete, and who may see what.
 *
 * URLs are IP literals, so `dns.lookup` answers locally and no test here touches the network.
 */

import { afterAll, describe, expect, test } from "bun:test"
import type { KeyScope } from "@dispach/core"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

type Harness = Awaited<ReturnType<typeof harness>>
const PUBLIC = "https://93.184.216.34/hooks"

async function keyWith(call: Harness["call"], scope: KeyScope): Promise<string> {
    const response = await call("POST", "/v1/keys", { body: { label: "scoped", scope } })
    return ((await response.json()) as { secret: string }).secret
}

describe("POST /v1/webhooks", () => {
    test("returns the secret once; the listing never does", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const created = await call("POST", "/v1/webhooks", {
            body: { url: PUBLIC, types: ["turn.end", "approval.requested"] },
        })
        expect(created.status).toBe(201)
        const body = (await created.json()) as {
            subscriptionId: string
            secret: string
            failing: boolean
        }
        expect(body.secret).toStartWith("whsec_")
        expect(body.failing).toBe(false)
        const listing = await (await call("GET", "/v1/webhooks")).text()
        expect(listing).toContain(body.subscriptionId)
        expect(listing).not.toContain(body.secret)
        await runtime.stop()
    })

    test("refuses the metadata endpoint, a private address, per-token chunks and an unknown type", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const codeOf = async (body: unknown) =>
            (
                (await (await call("POST", "/v1/webhooks", { body })).json()) as {
                    error: { code: string }
                }
            ).error.code
        expect(await codeOf({ url: "http://169.254.169.254/latest", types: ["turn.end"] })).toBe(
            "webhook_target_refused",
        )
        expect(await codeOf({ url: "http://10.0.0.5/hook", types: ["turn.end"] })).toBe(
            "webhook_target_refused",
        )
        expect(await codeOf({ url: PUBLIC, types: ["model.chunk"] })).toBe("webhook_type_invalid")
        expect(await codeOf({ url: PUBLIC, types: ["turn.ended"] })).toBe("webhook_type_invalid")
        expect(await codeOf({ url: PUBLIC, types: [] })).toBe("webhook_types_required")
        await runtime.stop()
    })

    test("a scoped key's subscription is bound to its reach, and cannot name another agent", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await runtime.store.agentState.disable("other", new Date().toISOString(), "test")
        const narrow = await keyWith(call, { agents: ["assistant"], can: ["admin"] })
        const refused = await call("POST", "/v1/webhooks", {
            token: narrow,
            body: { url: PUBLIC, types: ["turn.end"], agents: ["other"] },
        })
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
            "webhook_scope_invalid",
        )
        const created = (await (
            await call("POST", "/v1/webhooks", {
                token: narrow,
                body: { url: PUBLIC, types: ["turn.end"] },
            })
        ).json()) as { scope: { agents: string[] } }
        expect(created.scope.agents).toEqual(["assistant"])
        await runtime.stop()
    })
})

describe("visibility", () => {
    test("a scoped key sees and deletes only what is inside its reach", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const serverWide = (await (
            await call("POST", "/v1/webhooks", { body: { url: PUBLIC, types: ["turn.end"] } })
        ).json()) as { subscriptionId: string }
        const narrow = await keyWith(call, { agents: ["assistant"], can: ["admin"] })
        const mine = (await (
            await call("POST", "/v1/webhooks", {
                token: narrow,
                body: { url: PUBLIC, types: ["turn.end"] },
            })
        ).json()) as { subscriptionId: string }

        const seen = (await (await call("GET", "/v1/webhooks", { token: narrow })).json()) as {
            webhooks: { subscriptionId: string }[]
        }
        expect(seen.webhooks.map((w) => w.subscriptionId)).toEqual([mine.subscriptionId])
        const denied = await call("DELETE", `/v1/webhooks/${serverWide.subscriptionId}`, {
            token: narrow,
        })
        expect(denied.status).toBe(404)
        const deleted = await call("DELETE", `/v1/webhooks/${mine.subscriptionId}`, {
            token: narrow,
        })
        expect(deleted.status).toBe(200)
        // The operator still sees the server-wide one.
        const all = (await (await call("GET", "/v1/webhooks")).json()) as { webhooks: unknown[] }
        expect(all.webhooks).toHaveLength(1)
        await runtime.stop()
    })

    test("a real turn is queued for a subscription that hears it", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await call("POST", "/v1/webhooks", { body: { url: PUBLIC, types: ["turn.end"] } })
        await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", stream: true },
        }).then((response) => response.text())
        await new Promise((resolve) => setTimeout(resolve, 20))
        const [sub] = (
            (await (await call("GET", "/v1/webhooks")).json()) as {
                webhooks: { pending: number }[]
            }
        ).webhooks
        // Pending, not sent: the harness has no receiver, and the timer sends on its own schedule.
        expect(sub?.pending).toBeGreaterThanOrEqual(1)
        await runtime.stop()
    })
})
