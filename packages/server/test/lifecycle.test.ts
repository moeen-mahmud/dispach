/**
 * `POST /v1/agents/:id/stop` and `/start` — the durable switch over the wire.
 *
 * ## What these have to prove that a unit test cannot
 *
 * The switch has two effects and the whole value is that they happen together: a store row that
 * survives a restart, and an agent that leaves this host *now*. Either alone is a defect with no
 * visible symptom — a row with nothing acting on it is an agent still answering Telegram after
 * somebody stopped it, and a dispose with no row is an agent that comes back at the next restart
 * with nobody having asked. So every test here reads both sides.
 *
 * The order is asserted too, because it is the one part that cannot be recovered from: state first,
 * then teardown. A dispose that succeeded before a failed write leaves the agent down and marked
 * running, which is the shape that comes back unbidden.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { cleanupWorkspaces, harness, TOKEN, workspace } from "./harness.ts"

afterAll(cleanupWorkspaces)

describe("stopping an agent over the wire", () => {
    test("the row is written and the agent leaves this host", async () => {
        const { runtime, call } = await harness({ token: TOKEN })

        expect(runtime.list().map((agent) => agent.id)).toEqual(["assistant"])

        const response = await call("POST", "/v1/agents/assistant/stop", {
            body: { reason: "noisy at 3am" },
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            id: "assistant",
            status: "disabled",
            disabledAt: expect.any(String),
            reason: "noisy at 3am",
        })

        // Both halves. The row is what survives a restart; the empty list is what makes the
        // request mean something today.
        expect((await runtime.store.agentState.get("assistant"))?.enabled).toBe(false)
        expect(runtime.list()).toEqual([])

        await runtime.stop()
    })

    test("the resource is 404 and the listing still carries it", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await call("POST", "/v1/agents/assistant/stop", { body: {} })

        // The asymmetry is deliberate: the listing answers "what exists" and the resource answers
        // "what is running". A 200 on the resource would have to invent a body for an agent with no
        // tools, no window and no sessions in memory.
        expect((await call("GET", "/v1/agents/assistant")).status).toBe(404)
        // Annotated with every field asserted below, not just the two being read for the shape:
        // `toEqual` checks the object literal against this type, so a narrower annotation makes the
        // assertion itself a type error — which is how this file failed `tsc` while passing
        // `bun test`, since the test runner does not typecheck.
        const listing = (await (await call("GET", "/v1/agents")).json()) as {
            id: string
            name: string
            status: string
            disabledAt?: string
        }[]
        expect(listing).toEqual([
            {
                id: "assistant",
                name: "assistant",
                status: "disabled",
                disabledAt: expect.any(String),
            },
        ])

        await runtime.stop()
    })

    test("stopping a stopped agent is 200, not 404", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await call("POST", "/v1/agents/assistant/stop", { body: { reason: "first" } })

        // The caller asked for a state that already holds. A 404 on a retry makes a repeated
        // request look like a mistake — and the agent is gone from `runtime.list()` by now, so this
        // is also the path that proves the route does not need the agent to be hosted.
        const again = await call("POST", "/v1/agents/assistant/stop", { body: { reason: "again" } })
        expect(again.status).toBe(200)
        const state = await runtime.store.agentState.get("assistant")
        // The first stamp survives; the newer note replaces the old one.
        expect(state?.reason).toBe("again")

        await runtime.stop()
    })

    test("an id that is neither hosted nor recorded is 404", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        // A 200 here would report having stopped something that does not exist, which is how a
        // typo comes to look like success.
        expect((await call("POST", "/v1/agents/nope/stop", { body: {} })).status).toBe(404)
        await runtime.stop()
    })

    test("a running turn refuses the stop, and the row is written anyway", async () => {
        let release = (): void => {}
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const slow = (async () => {
            await held
            return new Response("data: [DONE]\n\n", {
                headers: { "content-type": "text/event-stream" },
            })
        }) as unknown as typeof fetch

        const { runtime, call } = await harness({ token: TOKEN, fetch: slow })
        const turn = runtime.agent("assistant").send("hello")
        await new Promise((resolve) => setTimeout(resolve, 5))

        const refused = await call("POST", "/v1/agents/assistant/stop", { body: {} })
        expect(refused.status).toBe(409)
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
            "agent_turn_in_flight",
        )
        // Written first, so the agent is off at the next start even though the teardown was
        // refused — which is the command's actual promise.
        expect((await runtime.store.agentState.get("assistant"))?.enabled).toBe(false)
        expect(runtime.list().length).toBe(1)

        release()
        await turn
        await runtime.stop()
    })
})

describe("starting an agent over the wire", () => {
    test("without a manifest lookup the route says so rather than pretending", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        await call("POST", "/v1/agents/assistant/stop", { body: {} })

        const response = await call("POST", "/v1/agents/assistant/start", { body: {} })
        expect(response.status).toBe(501)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
            "start_not_supported",
        )
        // And the row is untouched: a 501 that had already flipped the flag would leave an agent
        // marked on with nothing hosting it, which is the "looks live and is not" failure.
        expect((await runtime.store.agentState.get("assistant"))?.enabled).toBe(false)

        await runtime.stop()
    })

    test("with a lookup it enables and adopts, live", async () => {
        const dir = workspace()
        const { runtime, call } = await harness({
            token: TOKEN,
            resolveAgent: (id) => (id === "assistant" ? join(dir, "agent.yaml") : undefined),
        })
        await call("POST", "/v1/agents/assistant/stop", { body: { reason: "off for a bit" } })
        expect(runtime.list()).toEqual([])

        const response = await call("POST", "/v1/agents/assistant/start", { body: {} })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            id: "assistant",
            status: "loaded",
            // Kept through the enable, as the record of what happened. A reader has to look at
            // `status` rather than at their presence.
            disabledAt: expect.any(String),
            reason: "off for a bit",
            adopted: ["assistant"],
        })

        // Live, not merely marked: the resource answers again, which needs a real hosted agent.
        expect(runtime.list().map((agent) => agent.id)).toEqual(["assistant"])
        expect((await call("GET", "/v1/agents/assistant")).status).toBe(200)

        await runtime.stop()
    })

    test("starting a hosted agent clears a stale row without adopting twice", async () => {
        const dir = workspace()
        const { runtime, call } = await harness({
            token: TOKEN,
            resolveAgent: () => join(dir, "agent.yaml"),
        })
        // The state a crash between the two writes of `stop` can leave behind: hosted, and marked
        // off. This is the only command that can clear it.
        await runtime.store.agentState.disable("assistant", new Date().toISOString(), "stale")

        const response = await call("POST", "/v1/agents/assistant/start", { body: {} })
        expect(response.status).toBe(200)
        expect((await runtime.store.agentState.get("assistant"))?.enabled).toBe(true)
        // Not adopted a second time — which would throw `agent_already_hosted` and, without this
        // branch, turn a harmless repair into a 400.
        expect(runtime.list().map((agent) => agent.id)).toEqual(["assistant"])

        await runtime.stop()
    })

    test("a lookup that finds nothing is 404 and writes nothing", async () => {
        const { runtime, call } = await harness({
            token: TOKEN,
            resolveAgent: () => undefined,
        })
        await call("POST", "/v1/agents/assistant/stop", { body: {} })
        expect((await call("POST", "/v1/agents/gone/start", { body: {} })).status).toBe(404)
        expect(await runtime.store.agentState.get("gone")).toBeUndefined()
        await runtime.stop()
    })

    test("a failed adoption puts the row back rather than leaving it on", async () => {
        const { runtime, call } = await harness({
            token: TOKEN,
            // Points at a path with no manifest, so `adopt` throws after the row was flipped.
            resolveAgent: () => "/nonexistent/agent.yaml",
        })
        await call("POST", "/v1/agents/assistant/stop", { body: {} })

        const response = await call("POST", "/v1/agents/assistant/start", { body: {} })
        expect(response.status).toBe(400)
        // The whole point: an agent marked on with nothing running is the failure this table
        // exists to prevent, so a failed start is rolled back and says why.
        const state = await runtime.store.agentState.get("assistant")
        expect(state?.enabled).toBe(false)
        expect(state?.reason).toBe("start failed")

        await runtime.stop()
    })
})

describe("adoption honours the switch", () => {
    test("a stopped agent is refused rather than silently skipped", async () => {
        const dir = workspace()
        const { runtime } = await harness({ token: TOKEN })
        await runtime.store.agentState.disable("other", new Date().toISOString(), "off")

        // Refused, not skipped: `adopt` was asked for a specific agent, and an empty result would
        // read as success. The refusal is what stops every caller that does not know about the
        // switch from reversing a stop by accident — `POST /start` enables first, which is why it
        // is the one caller this never fires for.
        const second = workspace(`apiVersion: dispach/v1
id: other
name: other
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`)
        await expect(runtime.adopt(join(second, "agent.yaml"))).rejects.toThrow(/is stopped/)
        expect(runtime.list().map((agent) => agent.id)).toEqual(["assistant"])
        expect(dir).toBeDefined()

        await runtime.stop()
    })
})
