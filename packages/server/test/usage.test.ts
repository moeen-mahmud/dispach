/**
 * `GET /v1/usage`, `GET /v1/agents/:id/usage` and `GET /v1/agents/:id/turns`.
 *
 * The scope tests are the ones that matter. A total is where an omitted filter leaks quietly: a
 * per-sender row is identity, and a key narrowed to one tenant's sessions must not read another
 * tenant's senders from an aggregate it could never have reached turn by turn.
 */

import { afterAll, describe, expect, test } from "bun:test"
import type { KeyScope } from "@dispach/core"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

type Harness = Awaited<ReturnType<typeof harness>>

async function seed(runtime: Harness["runtime"]): Promise<void> {
    const row = {
        role: "main",
        model: "m",
        promptTokens: 10,
        promptReported: true,
        outputTokens: 2,
        outputReported: true,
    }
    await runtime.store.usage.record({
        ...row,
        agentId: "assistant",
        sessionKey: "team_1:a",
        sender: "user:ada",
        at: "2026-09-01T10:00:00.000Z",
    })
    await runtime.store.usage.record({
        ...row,
        agentId: "assistant",
        sessionKey: "team_2:b",
        sender: "user:bob",
        at: "2026-09-02T10:00:00.000Z",
    })
    await runtime.store.usage.record({
        ...row,
        agentId: "elsewhere",
        sessionKey: "team_1:c",
        at: "2026-09-02T11:00:00.000Z",
    })
}

async function keyWith(call: Harness["call"], scope: KeyScope): Promise<string> {
    const response = await call("POST", "/v1/keys", { body: { label: "scoped", scope } })
    return ((await response.json()) as { secret: string }).secret
}

describe("GET /v1/usage", () => {
    test("groups by agent and model by default, and says how far back it goes", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await seed(runtime)
        const body = (await (await call("GET", "/v1/usage")).json()) as {
            buckets: { agentId: string; calls: number; promptTokens: number }[]
            meteredSince: string
        }
        expect(body.buckets.map((b) => [b.agentId, b.calls, b.promptTokens])).toEqual([
            ["assistant", 2, 20],
            ["elsewhere", 1, 10],
        ])
        expect(body.meteredSince).toBe("2026-09-01T10:00:00.000Z")
        await runtime.stop()
    })

    test("a session-scoped key sees only its own sessions' senders", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await seed(runtime)
        const narrow = await keyWith(call, { sessions: "team_1:" })
        const body = (await (
            await call("GET", "/v1/usage?by=sender", { token: narrow })
        ).json()) as { buckets: { sender?: string; calls: number }[] }
        // `user:bob` spoke only in team_2, and must not appear at all.
        expect(body.buckets.map((b) => b.sender ?? "(operator)").sort()).toEqual([
            "(operator)",
            "user:ada",
        ])
        await runtime.stop()
    })

    test("an agent-scoped key sees only its agents", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await seed(runtime)
        const narrow = await keyWith(call, { agents: ["assistant"] })
        const body = (await (
            await call("GET", "/v1/usage?by=agent", { token: narrow })
        ).json()) as { buckets: { agentId: string }[] }
        expect(body.buckets.map((b) => b.agentId)).toEqual(["assistant"])
        await runtime.stop()
    })

    test("a window, a day grouping, and refusals for a bad grouping or date", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await seed(runtime)
        const byDay = (await (
            await call("GET", "/v1/usage?by=day&from=2026-09-02&to=2026-09-03")
        ).json()) as { buckets: { day: string; calls: number }[] }
        expect(byDay.buckets).toEqual([expect.objectContaining({ day: "2026-09-02", calls: 2 })])

        const bad = await call("GET", "/v1/usage?by=agent,colour")
        expect(bad.status).toBe(400)
        expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
            "usage_group_invalid",
        )
        const badDate = await call("GET", "/v1/usage?from=last-tuesday")
        expect(((await badDate.json()) as { error: { code: string } }).error.code).toBe(
            "usage_range_invalid",
        )
        await runtime.stop()
    })

    test("a real turn is metered and shows up", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hello", stream: true },
        }).then((response) => response.text())
        await new Promise((resolve) => setTimeout(resolve, 20))
        const body = (await (await call("GET", "/v1/agents/assistant/usage")).json()) as {
            id: string
            buckets: { calls: number }[]
        }
        expect(body.id).toBe("assistant")
        expect(body.buckets[0]?.calls).toBeGreaterThan(0)
        await runtime.stop()
    })
})

describe("GET /v1/agents/:id/usage and /turns", () => {
    test("out of scope is the same 404 an imaginary agent gets", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await runtime.store.agentState.disable("switched-off", new Date().toISOString(), "test")
        const narrow = await keyWith(call, { agents: ["switched-off"] })
        for (const path of ["/v1/agents/assistant/usage", "/v1/agents/assistant/turns"]) {
            const response = await call("GET", path, { token: narrow })
            expect(response.status).toBe(404)
        }
        await runtime.stop()
    })

    test("turns page across sessions and refuse a malformed cursor", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        for (const text of ["one", "two", "three"]) {
            await call("POST", "/v1/agents/assistant/messages", {
                body: { text, stream: true },
            }).then((response) => response.text())
        }
        const first = (await (await call("GET", "/v1/agents/assistant/turns?limit=2")).json()) as {
            turns: { input: string }[]
            nextBefore?: number
        }
        expect(first.turns.map((t) => t.input)).toEqual(["three", "two"])
        const second = (await (
            await call("GET", `/v1/agents/assistant/turns?limit=2&before=${first.nextBefore}`)
        ).json()) as { turns: { input: string }[]; nextBefore?: number }
        expect(second.turns.map((t) => t.input)).toEqual(["one"])
        expect(second.nextBefore).toBeUndefined()

        const bad = await call("GET", "/v1/agents/assistant/turns?before=abc")
        expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
            "turns_page_invalid",
        )
        await runtime.stop()
    })
})
