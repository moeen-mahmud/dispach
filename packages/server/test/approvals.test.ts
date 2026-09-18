/**
 * Phase 15.2 — approvals over the wire.
 *
 * The turn blocks, `approval.requested` goes out on the stream every reader already has, a POST
 * releases it, and an unanswered one dies with its turn. Every assertion here drives the real
 * handler, so the registry, the route, the event and the suspended turn are the production ones.
 *
 * The shape that needs care: a blocked turn is *waiting*, so a test that awaits the turn before
 * answering deadlocks. Each test here starts the turn, waits for the question to appear, and only
 * then answers — which is also exactly what a client does.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { Runtime } from "@dispach/core"
import { createApprovalRegistry } from "../src/approvals.ts"
import { createHandler } from "../src/handler.ts"
import { serve } from "../src/serve.ts"
import { cleanupWorkspaces, ENV, readUntil, recordingFetch, workspace } from "./harness.ts"

afterAll(cleanupWorkspaces)

/**
 * A manifest whose every mutating call has to be asked about.
 *
 * `mode: ask` on the policy rather than `untrusted.onMutate: "confirm"`, because the latter needs
 * untrusted content in the turn to fire and this stage is about the asking, not about the taint.
 * 10A's tests cover the other door.
 */
const ASK_MANIFEST = `apiVersion: dispach/v1
id: assistant
name: Assistant
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  pinned: [now, memory_write]
  policy:
    mode: ask
`

/** The model asks to write a note, then answers. Two steps, so step two reports the outcome. */
const WRITES_A_NOTE = [
    "I'll save that.\nACTION: memory_write\ntext: a note worth keeping\nEND",
    "done",
]

async function asking(
    options: { readonly turnTimeoutMs?: number; readonly replies?: readonly string[] } = {},
) {
    const dir = workspace(
        options.turnTimeoutMs === undefined
            ? ASK_MANIFEST
            : `${ASK_MANIFEST}limits:\n  turnTimeoutMs: ${options.turnTimeoutMs}\n`,
    )
    const model = recordingFetch(options.replies ?? WRITES_A_NOTE)
    const approvals = createApprovalRegistry()
    const runtime = await Runtime.create({
        agents: [`${dir}/agent.yaml`],
        env: ENV,
        fetch: model.fetch,
        // The seam. Without it `authorize` resolves `ask` through `onNoApprover` and no question is
        // ever raised — which is what every deployment did before this stage.
        approve: approvals.approver,
    })
    const handler = createHandler({ runtime, allowUnauthenticated: true, approvals })

    const call = (method: string, path: string, body?: unknown) =>
        handler(
            new Request(`http://127.0.0.1:7420${path}`, {
                method,
                headers: { "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        )

    /** Poll the listing until a question shows up. This is the client's own flow. */
    const waitForQuestion = async () => {
        for (let attempt = 0; attempt < 300; attempt += 1) {
            const body = (await (await call("GET", "/v1/agents/assistant/approvals")).json()) as {
                approvals: { approvalId: string; slug: string }[]
            }
            if (body.approvals.length > 0) return body.approvals
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error("no approval was ever requested")
    }

    const turnRow = async (turnId: string) => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const row = (await (
                await call("GET", `/v1/agents/assistant/turns/${turnId}`)
            ).json()) as Record<string, unknown>
            if (row.status !== "running") return row
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error(`turn ${turnId} never finished`)
    }

    const send = async (text = "save a note") =>
        (
            (await (await call("POST", "/v1/agents/assistant/messages", { text })).json()) as {
                turnId: string
            }
        ).turnId

    return { runtime, handler, call, approvals, model, send, waitForQuestion, turnRow }
}

describe("a blocked call asks, and a POST releases it", () => {
    test("the question is listable while the turn waits, and granting runs the call", async () => {
        const h = await asking()
        try {
            const turnId = await h.send()
            const [question] = await h.waitForQuestion()
            expect(question?.approvalId).toMatch(/^a_/)
            expect(question?.slug).toBe("memory_write")

            // The turn is genuinely suspended, not merely slow — the row is still `running` while
            // the question stands. Asserted because "it worked" would also be true of a runtime
            // that asked nobody and ran the call anyway.
            const mid = (await (
                await h.call("GET", `/v1/agents/assistant/turns/${turnId}`)
            ).json()) as { status: string }
            expect(mid.status).toBe("running")

            const answer = await h.call(
                "POST",
                `/v1/agents/assistant/approvals/${question?.approvalId}`,
                { granted: true },
            )
            expect(answer.status).toBe(200)
            expect(await answer.json()).toMatchObject({ granted: true })

            const row = await h.turnRow(turnId)
            expect(row.status).toBe("final")
            // The observation the model was shown next proves the call ran rather than being
            // refused — the far end of the pipeline, not the route's own answer.
            expect(
                h.model.prompts().some((prompt) => prompt.includes("memory_write was not run")),
            ).toBe(false)
            // And the question is gone from the listing.
            expect(
                (
                    (await (await h.call("GET", "/v1/agents/assistant/approvals")).json()) as {
                        approvals: unknown[]
                    }
                ).approvals.length,
            ).toBe(0)
        } finally {
            await h.runtime.stop()
        }
    })

    test("denying refuses the call and the model is told a person declined", async () => {
        const h = await asking()
        try {
            const turnId = await h.send()
            const [question] = await h.waitForQuestion()
            await h.call("POST", `/v1/agents/assistant/approvals/${question?.approvalId}`, {
                granted: false,
            })
            await h.turnRow(turnId)
            const observation = h.model
                .prompts()
                .find((prompt) => prompt.includes("memory_write was not"))
            expect(observation).toContain("not approved")
            // Not "the approver failed" and not "the turn ended" — a person said no, and the three
            // are deliberately different sentences.
            expect(observation).not.toContain("Nobody declined it")
        } finally {
            await h.runtime.stop()
        }
    })

    test("approval.requested reaches the firehose, with the turn it belongs to", async () => {
        // Core emits it, which is why it is here at all: an approver that emitted its own event
        // would make the question visible only to whichever front end implemented it.
        const h = await asking()
        try {
            const stream = await h.call(
                "GET",
                "/v1/events?types=approval.requested,approval.resolved",
            )
            const turnId = await h.send()
            const frames = await readUntil(stream, (seen) =>
                seen.some(([event]) => event === "approval.requested"),
            )
            const [, data] = frames.find(([event]) => event === "approval.requested") ?? []
            const envelope = data as {
                turnId: string
                sessionKey: string
                agentId: string
                data: { approvalId: string; slug: string; mutating: boolean; reason: string }
            }
            // The correlation a UI needs and an `ApprovalRequest` deliberately does not carry.
            expect(envelope.turnId).toBe(turnId)
            expect(envelope.agentId).toBe("assistant")
            expect(envelope.sessionKey).toBe("api:default")
            expect(envelope.data.slug).toBe("memory_write")
            expect(envelope.data.mutating).toBe(true)
            expect(envelope.data.reason.length).toBeGreaterThan(0)

            await h.call("POST", `/v1/agents/assistant/approvals/${envelope.data.approvalId}`, {
                granted: true,
            })
            await h.turnRow(turnId)
        } finally {
            await h.runtime.stop()
        }
    })
})

describe("the ways an approval fails to be answered", () => {
    test("an unknown id is a 404 naming the listing", async () => {
        const h = await asking()
        try {
            const response = await h.call("POST", "/v1/agents/assistant/approvals/a_nope", {
                granted: true,
            })
            expect(response.status).toBe(404)
            const body = (await response.json()) as { error: { code: string; hint: string } }
            expect(body.error.code).toBe("approval_not_found")
            expect(body.error.hint).toContain("/v1/agents/:id/approvals")
        } finally {
            await h.runtime.stop()
        }
    })

    test("answering twice is a 404 the second time", async () => {
        const h = await asking()
        try {
            const turnId = await h.send()
            const [question] = await h.waitForQuestion()
            const path = `/v1/agents/assistant/approvals/${question?.approvalId}`
            expect((await h.call("POST", path, { granted: true })).status).toBe(200)
            // Deleted from the map before the promise resolves, so a duplicate answer cannot reach
            // a turn that has already resumed on the first one.
            expect((await h.call("POST", path, { granted: false })).status).toBe(404)
            await h.turnRow(turnId)
        } finally {
            await h.runtime.stop()
        }
    })

    test("a body with no boolean granted is refused, in both directions", async () => {
        const h = await asking()
        try {
            for (const body of [{}, { granted: "yes" }, { granted: 1 }, { granted: null }]) {
                const response = await h.call("POST", "/v1/agents/assistant/approvals/a_x", body)
                // 400 before the 404: a body this route cannot read is not a decision about an id,
                // and reporting "no such approval" for a malformed body sends the reader to the
                // wrong problem.
                expect(response.status).toBe(400)
                expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
                    "approval_decision_required",
                )
            }
        } finally {
            await h.runtime.stop()
        }
    })

    test("an unanswered question ends with its turn, and nobody declined it", async () => {
        // The guarantee that makes waiting safe. A short turn timeout stands in for a person who
        // never answers — there is deliberately no second clock, so this *is* the mechanism.
        const h = await asking({ turnTimeoutMs: 700 })
        try {
            const turnId = await h.send()
            await h.waitForQuestion()
            const row = await h.turnRow(turnId)
            expect(row.status).toBe("timeout")
            // And the registry is empty afterwards: the abort listener clears the entry, or a UI
            // polling the listing shows an abandoned prompt forever and gets a 404 for answering.
            expect(h.approvals.size).toBe(0)
        } finally {
            await h.runtime.stop()
        }
    })

    test("with no registry wired, the routes still answer something true", async () => {
        // A deployment that attached no approver. Nothing is ever pending, so every id is a 404 —
        // one code path rather than a `501` that reads as a missing feature.
        const dir = workspace(ASK_MANIFEST)
        const runtime = await Runtime.create({
            agents: [`${dir}/agent.yaml`],
            env: ENV,
            fetch: recordingFetch(["hi"]).fetch,
        })
        const handler = createHandler({ runtime, allowUnauthenticated: true })
        try {
            const listing = await handler(
                new Request("http://127.0.0.1:7420/v1/agents/assistant/approvals"),
            )
            expect(listing.status).toBe(200)
            expect(await listing.json()).toEqual({ approvals: [] })

            const answer = await handler(
                new Request("http://127.0.0.1:7420/v1/agents/assistant/approvals/a_x", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ granted: true }),
                }),
            )
            expect(answer.status).toBe(404)
            // The agent keeps its warning, which is where the honest signal lives.
            expect(
                runtime.agent("assistant").warnings.map((warning) => warning.code),
            ).not.toContain("confirm_without_approver")
        } finally {
            await runtime.stop()
        }
    })
})

describe("serve forwards the registry it was given", () => {
    /**
     * A real bind, because this is the one claim `createHandler` cannot make.
     *
     * `serve` builds its `createHandler` argument by hand rather than spreading `options`, so a
     * field inherited through `ServeOptions` type-checks and reaches nothing. `approvals` was wrong
     * exactly that way on the first write — declared, accepted, dropped — and every test in this
     * file passed, because they all construct the handler directly. Reverting the one forwarding
     * line leaves this test as the only thing that goes red.
     *
     * The failure it prevents is the worst shape available: the turn waits on the registry the
     * runtime was built with, while every POST is answered by a different, empty one — so a person
     * answers, is told `approval_not_found`, and the turn hangs until its timeout.
     */
    test("a question raised through serve is answerable through serve", async () => {
        const dir = workspace(ASK_MANIFEST)
        const model = recordingFetch(WRITES_A_NOTE)
        const approvals = createApprovalRegistry()
        const runtime = await Runtime.create({
            agents: [`${dir}/agent.yaml`],
            env: ENV,
            fetch: model.fetch,
            approve: approvals.approver,
        })
        const running = await serve({ runtime, host: "127.0.0.1", port: 0, approvals })
        try {
            const accepted = (await (
                await fetch(`${running.url}/v1/agents/assistant/messages`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: "save a note" }),
                })
            ).json()) as { turnId: string }

            let question: { approvalId: string } | undefined
            for (let attempt = 0; attempt < 300 && question === undefined; attempt += 1) {
                const body = (await (
                    await fetch(`${running.url}/v1/agents/assistant/approvals`)
                ).json()) as { approvals: { approvalId: string }[] }
                question = body.approvals[0]
                if (question === undefined) await new Promise((r) => setTimeout(r, 10))
            }
            expect(question?.approvalId).toMatch(/^a_/)

            const answer = await fetch(
                `${running.url}/v1/agents/assistant/approvals/${question?.approvalId}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ granted: true }),
                },
            )
            // 200, not 404. A 404 here is the forwarding bug and nothing else.
            expect(answer.status).toBe(200)

            for (let attempt = 0; attempt < 400; attempt += 1) {
                const row = (await (
                    await fetch(`${running.url}/v1/agents/assistant/turns/${accepted.turnId}`)
                ).json()) as { status: string }
                if (row.status !== "running") {
                    expect(row.status).toBe("final")
                    break
                }
                await new Promise((r) => setTimeout(r, 10))
            }
        } finally {
            await running.stop()
            await runtime.stop()
        }
    })
})

describe("the registry itself", () => {
    test("pending is oldest first, which is the order a queue should be worked", () => {
        const times = ["2026-09-15T10:00:02Z", "2026-09-15T10:00:00Z", "2026-09-15T10:00:01Z"]
        let index = 0
        const registry = createApprovalRegistry({ now: () => new Date(times[index++] ?? 0) })
        const signal = new AbortController().signal
        for (const id of ["a_third", "a_first", "a_second"]) {
            void registry.approver({
                approvalId: id,
                agentId: "assistant",
                slug: "memory_write",
                callId: "c1",
                mutating: true,
                reason: "because",
                signal,
            })
        }
        expect(registry.pending("assistant").map((entry) => entry.approvalId)).toEqual([
            "a_first",
            "a_second",
            "a_third",
        ])
    })

    test("an aborted request leaves the map, without reporting an approver error", async () => {
        const registry = createApprovalRegistry()
        const controller = new AbortController()
        const answer = registry.approver({
            approvalId: "a_x",
            agentId: "assistant",
            slug: "memory_write",
            callId: "c1",
            mutating: true,
            reason: "because",
            signal: controller.signal,
        })
        expect(registry.size).toBe(1)
        controller.abort()
        // Resolves false rather than rejecting. A rejection would surface through core as
        // `by: "error"` — "the approver is broken" — which is a lie about a turn that was stopped.
        expect(await answer).toBe(false)
        expect(registry.size).toBe(0)
    })

    test("resolve reports false for an id it does not hold", () => {
        expect(createApprovalRegistry().resolve("a_nothing", true)).toBe(false)
    })
})

/**
 * One registry, several agents — the disclosure this scoping exists to close.
 *
 * `GET /v1/agents/:id/approvals` discarded `:id` and returned every pending question in the
 * process: slug, matched command and reason, for agents the caller named nothing about. Harmless
 * only because a served process hosted one agent, which is how the same shape stayed invisible on
 * `/v1/events` until Phase 13 went looking. Single-tenancy hides multi-tenancy bugs; it does not
 * prevent them.
 */
describe("scoped to one agent", () => {
    function ask(registry: ReturnType<typeof createApprovalRegistry>, agentId: string, id: string) {
        void registry.approver({
            approvalId: id,
            agentId,
            slug: "exec",
            callId: "c1",
            match: `deploy --to production # ${agentId}`,
            mutating: true,
            reason: "changes things",
            signal: new AbortController().signal,
        })
    }

    test("one agent's queue never contains another's question", () => {
        const registry = createApprovalRegistry()
        ask(registry, "milo", "a_milo")
        ask(registry, "vela", "a_vela")

        expect(registry.pending("milo").map((e) => e.approvalId)).toEqual(["a_milo"])
        expect(registry.pending("vela").map((e) => e.approvalId)).toEqual(["a_vela"])
        // And the matched command — the part that actually leaks something — does not cross over.
        expect(JSON.stringify(registry.pending("milo"))).not.toContain("vela")
    })

    test("`size` stays process-wide, because it answers a different question", () => {
        // What is this process holding open, for readiness and introspection. Scoping it would make
        // "nothing is waiting" mean "nothing is waiting *for you*", which is the wrong answer to
        // give a supervisor deciding whether a shutdown is safe.
        const registry = createApprovalRegistry()
        ask(registry, "milo", "a_milo")
        ask(registry, "vela", "a_vela")
        expect(registry.size).toBe(2)
    })

    test("an agent with nothing waiting gets an empty list, not everything", () => {
        const registry = createApprovalRegistry()
        ask(registry, "milo", "a_milo")
        expect(registry.pending("triage")).toEqual([])
    })

    test("resolve stays keyed by approval id alone", () => {
        // Deliberately not scoped: an `approvalId` is minted per ask and globally unique, so
        // requiring an agent id to answer would add a way to get it wrong without removing any.
        const registry = createApprovalRegistry()
        ask(registry, "milo", "a_milo")
        expect(registry.resolve("a_milo", true)).toBe(true)
        expect(registry.pending("milo")).toEqual([])
    })
})
