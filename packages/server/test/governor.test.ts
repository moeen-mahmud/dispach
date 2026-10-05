/**
 * Governor limits over the wire, and `GET /v1/activity`.
 *
 * The route has to refuse *before* it detaches the turn — afterwards there is no response left to
 * put a `429` in — and a refused message must leave nothing behind: no turn row, no idempotency
 * claim that a retry would be told it already made.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { cleanupWorkspaces, harness, MANIFEST, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

const CAPPED = `${MANIFEST.trimEnd()}\nlimits:\n  maxConcurrentTurns: 1\n`

/** An endpoint whose first call waits until released, so a turn can be held open. */
function heldFetch(): { fetch: typeof fetch; release: () => void } {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    let calls = 0
    const endpoint = (async () => {
        calls += 1
        if (calls === 1) await gate
        const body = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
            "data: [DONE]\n\n",
        ].join("")
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    return { fetch: endpoint, release }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("POST /messages over a governor limit", () => {
    test("429 with the code and a hint; nothing recorded; the idempotency key is still free", async () => {
        const held = heldFetch()
        const { runtime, call } = await harness({
            token: TOKEN,
            manifest: CAPPED,
            fetch: held.fetch,
        })
        const first = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hold", sessionKey: "api:a" },
        })
        expect(first.status).toBe(202)
        await settle()

        const refused = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "second", sessionKey: "api:b" },
            headers: { "Idempotency-Key": "k-1" },
        })
        expect(refused.status).toBe(429)
        const error = ((await refused.json()) as { error: { code: string; hint: string } }).error
        expect(error.code).toBe("agent_at_capacity")
        expect(error.hint.length).toBeGreaterThan(0)

        held.release()
        await settle()
        // Same key, now under the cap: a fresh turn, not a replay of a refusal.
        const retried = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "second", sessionKey: "api:b" },
            headers: { "Idempotency-Key": "k-1" },
        })
        expect(retried.status).toBe(202)
        expect(((await retried.json()) as { replayed?: boolean }).replayed).toBeUndefined()
        await settle()
        const turns = await runtime.store.turns.listForAgent("assistant", {})
        expect(turns.turns.map((t) => t.input).sort()).toEqual(["hold", "second"])
        await runtime.stop()
    })

    test("an idempotent replay does not keep the slot it was admitted with", async () => {
        const { runtime, call } = await harness({ token: TOKEN, manifest: CAPPED })
        const send = () =>
            call("POST", "/v1/agents/assistant/messages", {
                body: { text: "same", sessionKey: "api:a" },
                headers: { "Idempotency-Key": "k-2" },
            })
        expect((await send()).status).toBe(202)
        await settle()
        // Replayed twice. Had a replay leaked its admission, the second would be 429.
        expect((await send()).status).toBe(200)
        expect((await send()).status).toBe(200)
        expect(runtime.agent("assistant").inFlight).toBe(0)
        await runtime.stop()
    })
})

describe("GET /v1/activity", () => {
    test("reports idle and the backlog to the operator; refuses a scoped key with 403", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/activity")
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
            idle: boolean
            turnsRunning: number
            deliveries: { outbox: { pending: number }; webhooks: { pending: number } }
        }
        expect(body.idle).toBe(true)
        expect(body.turnsRunning).toBe(0)
        expect(body.deliveries.outbox.pending).toBe(0)

        const minted = await call("POST", "/v1/keys", {
            body: { label: "tenant", scope: { agents: ["assistant"], can: ["admin"] } },
        })
        const scoped = ((await minted.json()) as { secret: string }).secret
        const refused = await call("GET", "/v1/activity", { token: scoped })
        expect(refused.status).toBe(403)
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
            "activity_needs_unscoped_key",
        )
        await runtime.stop()
    })

    test("an unscoped operator key may read it", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const minted = await call("POST", "/v1/keys", { body: { label: "waker" } })
        const key = ((await minted.json()) as { secret: string }).secret
        expect((await call("GET", "/v1/activity", { token: key })).status).toBe(200)
        await runtime.stop()
    })
})
