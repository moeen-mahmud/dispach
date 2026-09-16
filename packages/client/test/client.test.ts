/**
 * The client, driven against the **real** handler rather than a mocked `fetch`.
 *
 * `createHandler` is a plain `(Request) => Promise<Response>` and `createClient` takes a `fetch`,
 * so the two compose with no port and no server process: every assertion here goes through the
 * actual routing, the actual auth check, the actual SSE framing and the actual error bodies. A
 * mocked transport would have let this package agree with a fixture instead of with the runtime,
 * which is the failure the whole package exists to avoid — it is the same argument `spec.test.ts`
 * makes about the document.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EVENT_TYPES, Runtime } from "@dispach/core"
import { type ApprovalRegistry, createApprovalRegistry, createHandler } from "@dispach/server"
import { createClient, DispachError, isEvent } from "../src/index.ts"
import { turnStreamItems } from "../src/stream.ts"

const MANIFEST = `apiVersion: dispach/v1
id: assistant
name: Assistant
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`

/**
 * A frame name that is not an event and is on nobody's roadmap.
 *
 * Deliberately not borrowed from the spec's planned list, which is how this fixture broke twice.
 * Dotted and not `stream.`-prefixed, because the implementation must not be allowed to pass by
 * testing the prefix — that is the whole thing under test.
 */
const NOT_AN_EVENT = "future.frame"

const dirs: string[] = []
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * A model endpoint answering one fixed reply in **two** deltas, after thinking out loud.
 *
 * Two rather than one on purpose: with a single delta, "the tokens concatenate to the reply" is
 * satisfied by a stream carrying one frame, and a client that dropped ordering would pass.
 *
 * The `reasoning_content` delta is not decoration. Live against a reasoning model, one short reply
 * arrived as **26 reasoning deltas and 2 text ones** — so a client that concatenated both would
 * return a monologue ending in the answer, and every test here would still be green. This fixture
 * had no reasoning in it at first, and the filter that excludes it was consequently untested:
 * deleting that line left the suite passing.
 */
function replyFetch(text: string | readonly string[]): typeof fetch {
    // A sequence answers each call in turn, last one repeating. Only the approval tests need it,
    // and they need it because a single fixed reply containing an `ACTION` block would make *every*
    // step ask for the same tool — a turn that loops until the no-progress guard stops it, which
    // looks like the approval mechanism hanging.
    const replies = typeof text === "string" ? [text] : text
    let call = 0
    return (async () => {
        const body = replies[Math.min(call, replies.length - 1)] ?? ""
        call += 1
        const half = Math.ceil(body.length / 2)
        const text_ = body
        return new Response(
            [
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me think about " } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "what to say." } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: text_.slice(0, half) } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: text_.slice(half) } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`,
                "data: [DONE]\n\n",
            ].join(""),
            { status: 200, headers: { "content-type": "text/event-stream" } },
        )
    }) as unknown as typeof fetch
}

async function harness(
    options: {
        token?: string
        reply?: string | readonly string[]
        /** Shrink the per-turn buffer so the truncation path is reachable deliberately. */
        streams?: { maxEventsPerTurn?: number }
        /** A manifest whose mutating calls must be asked about, for the approval tests. */
        manifest?: string
        /** Attach a real approval registry, so a blocked turn has somewhere to wait. */
        approvals?: ApprovalRegistry
    } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "client-test-"))
    dirs.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "agent.yaml"), options.manifest ?? MANIFEST)

    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "sk-test" },
        fetch: replyFetch(options.reply ?? "hello from the model"),
        ...(options.streams === undefined ? {} : { streams: options.streams }),
        ...(options.approvals === undefined ? {} : { approve: options.approvals.approver }),
    })
    const handler = createHandler({
        runtime,
        ...(options.token === undefined
            ? { allowUnauthenticated: true }
            : { token: options.token }),
        ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    })

    const client = createClient({
        baseUrl: "http://127.0.0.1:7420",
        ...(options.token === undefined ? {} : { token: options.token }),
        // The whole point: the client's transport *is* the server's handler.
        fetch: ((url: string | URL | Request, init?: RequestInit) =>
            handler(new Request(url as string, init))) as typeof fetch,
    })

    /** A second client against the same server, so an auth test is a real one. */
    const clientWith = (token?: string) =>
        createClient({
            baseUrl: "http://127.0.0.1:7420",
            ...(token === undefined ? {} : { token }),
            fetch: ((url: string | URL | Request, init?: RequestInit) =>
                handler(new Request(url as string, init))) as typeof fetch,
        })

    return { client, clientWith, runtime }
}

describe("a turn, end to end", () => {
    test("send returns a handle and the tokens reconstruct the reply", async () => {
        const { client, runtime } = await harness({ reply: "the client works" })
        const turn = await client.agent("assistant").send("hi")

        expect(turn.turnId).toMatch(/^t_/)
        expect(turn.sessionKey).toBe("api:default")

        let text = ""
        for await (const token of turn.tokens()) text += token
        // Exactly the reply: the model's reasoning reached the stream and must not reach this.
        expect(text).toBe("the client works")

        // And it really was there to be excluded, so the assertion above means something.
        let reasoning = 0
        for await (const item of client
            .agent("assistant")
            .turn(turn.turnId)
            .stream({ chunks: true })) {
            if (
                item.kind === "event" &&
                item.event.type === "model.chunk" &&
                (item.event.data as { kind?: string }).kind === "reasoning"
            ) {
                reasoning += 1
            }
        }
        expect(reasoning).toBeGreaterThan(0)
        await runtime.stop()
    })

    test("text() waits for the turn and reads the stored row", async () => {
        const { client, runtime } = await harness({ reply: "stored and returned" })
        const turn = await client.agent("assistant").send("hi")
        expect(await turn.text()).toBe("stored and returned")

        const row = await turn.get()
        expect({ status: row.status, text: row.text }).toEqual({
            status: "final",
            text: "stored and returned",
        })
        await runtime.stop()
    })

    test("stream() reports the replay before any event, and ends on turn.end", async () => {
        const { client, runtime } = await harness()
        const turn = await client.agent("assistant").send("hi")

        const kinds: string[] = []
        let sawTurnEnd = false
        for await (const item of turn.stream({ chunks: true })) {
            kinds.push(item.kind)
            if (item.kind === "event" && item.event.type === "turn.end") sawTurnEnd = true
        }
        // The preamble is first, which is the property it exists for: a client learns a hole
        // exists before it starts concatenating rather than after.
        expect(kinds[0]).toBe("replay")
        expect(sawTurnEnd).toBe(true)
        await runtime.stop()
    })

    test("tokens are absent unless asked for", async () => {
        // Default off, per connection. `stream()` with no options must carry no `model.chunk`.
        const { client, runtime } = await harness()
        const turn = await client.agent("assistant").send("hi")

        let chunks = 0
        for await (const item of turn.stream()) {
            if (item.kind === "event" && item.event.type === "model.chunk") chunks += 1
        }
        expect(chunks).toBe(0)
        await runtime.stop()
    })

    test("reattaching by turn id reaches the same turn", async () => {
        const { client, runtime } = await harness({ reply: "reattached" })
        const agent = client.agent("assistant")
        const turn = await agent.send("hi")
        await turn.text()

        // The path a UI takes after a refresh: an id from somewhere else, no handle.
        expect((await agent.turn(turn.turnId).get()).text).toBe("reattached")
        await runtime.stop()
    })
})

describe("a truncated replay is refused, not quietly shortened", () => {
    test("tokens() throws replay_truncated, and says where the whole text is", async () => {
        // **The assertion this package exists for.** A reattaching client whose replay lost its
        // front concatenates a shorter reply and believes it — no error, no symptom. The union
        // `stream()` yields makes the hole a value the assembling code has to have seen, and
        // `tokens()` refuses rather than putting that honesty behind a field nobody checks.
        const { client, runtime } = await harness({ streams: { maxEventsPerTurn: 3 } })
        const turn = await client.agent("assistant").send("hi")
        await turn.text()

        const caught = await (async () => {
            try {
                for await (const _ of client.agent("assistant").turn(turn.turnId).tokens()) {
                    // Drained for the throw, not for the text.
                }
                return undefined
            } catch (error) {
                return error
            }
        })()

        expect(caught).toBeInstanceOf(DispachError)
        expect((caught as DispachError).code).toBe("replay_truncated")
        expect((caught as DispachError).hint).toContain("/v1/agents/:id/turns/:turnId")
        await runtime.stop()
    })

    test("allowTruncated accepts a fragment knowingly", async () => {
        // The opt-out exists because "give me what you have" is a legitimate ask — it just must
        // not be the default. Same shape as `--yes` elsewhere in this project.
        const { client, runtime } = await harness({ streams: { maxEventsPerTurn: 3 } })
        const turn = await client.agent("assistant").send("hi")
        await turn.text()

        let text = ""
        for await (const token of client
            .agent("assistant")
            .turn(turn.turnId)
            .tokens({ allowTruncated: true })) {
            text += token
        }
        // A fragment, or nothing — either is honest. What matters is that it did not throw.
        expect(typeof text).toBe("string")
        await runtime.stop()
    })

    test("stream() reports the hole rather than hiding it", async () => {
        const { client, runtime } = await harness({ streams: { maxEventsPerTurn: 3 } })
        const turn = await client.agent("assistant").send("hi")
        await turn.text()

        let report: { truncated: boolean; dropped: number } | undefined
        for await (const item of client.agent("assistant").turn(turn.turnId).stream()) {
            if (item.kind === "replay") report = item.report
        }
        expect(report?.truncated).toBe(true)
        expect(report?.dropped ?? 0).toBeGreaterThan(0)
        await runtime.stop()
    })
})

describe("errors are typed, and carry the hint", () => {
    test("an unknown agent throws a DispachError with code, hint and status", async () => {
        const { client, runtime } = await harness()
        const caught = await client
            .agent("ghost")
            .describe()
            .then(() => undefined)
            .catch((error: unknown) => error)

        expect(caught).toBeInstanceOf(DispachError)
        const error = caught as DispachError
        expect(error.code).toBe("agent_not_found")
        expect(error.status).toBe(404)
        // The part a person reads, and the reason a bare `Error("HTTP 404")` would be a regression.
        expect(error.hint).not.toBe("")
        expect(error.request).toEqual({ method: "GET", path: "/v1/agents/ghost" })
        await runtime.stop()
    })

    test("the token is sent, and its absence is a typed 401", async () => {
        // Both halves against the same server, because "the header is sent" and "the server wants
        // it" are separate claims and only the pair proves the client is doing its job.
        const { clientWith, runtime } = await harness({ token: "secret" })

        expect((await clientWith("secret").agent("assistant").describe()).id).toBe("assistant")

        const caught = (await clientWith()
            .agent("assistant")
            .describe()
            .catch((error: unknown) => error)) as DispachError
        expect(caught).toBeInstanceOf(DispachError)
        expect(caught.code).toBe("unauthorized")
        expect(caught.status).toBe(401)
        // Never says whether the token was absent or wrong — the server's rule, and a client that
        // paraphrased it into something more helpful would be undoing it.
        expect(caught.message).not.toContain("absent")
        await runtime.stop()
    })

    test("a transport failure is a DispachError, not a bare TypeError", async () => {
        // So `catch (e) { if (e instanceof DispachError) }` is a complete answer for a caller.
        const client = createClient({
            baseUrl: "http://127.0.0.1:1",
            fetch: (() =>
                Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch,
        })
        const caught = await client.health().catch((error: unknown) => error)

        expect(caught).toBeInstanceOf(DispachError)
        expect((caught as DispachError).code).toBe("transport_failed")
        expect((caught as DispachError).status).toBeUndefined()
        expect((caught as DispachError).hint).toContain("/v1/health")
    })

    test("a non-JSON error body still produces a usable error", async () => {
        // The proxy case: an HTML 502 carries a real status and no error object, so parsing has to
        // fail into something that still names the status rather than throwing a syntax error.
        const client = createClient({
            baseUrl: "http://127.0.0.1:7420",
            fetch: (() =>
                Promise.resolve(
                    new Response("<html>502 Bad Gateway</html>", {
                        status: 502,
                        headers: { "content-type": "text/html" },
                    }),
                )) as unknown as typeof fetch,
        })
        const caught = (await client.health().catch((error: unknown) => error)) as DispachError

        expect(caught).toBeInstanceOf(DispachError)
        expect(caught.code).toBe("http_502")
        expect(caught.status).toBe(502)
        expect(caught.hint).toContain("proxy")
    })

    test("an unknown event type is refused at the call, naming the nearest", async () => {
        const { client, runtime } = await harness()
        const iterator = client.events({ types: ["turn.ended" as never] })
        const caught = await iterator.next().catch((error: unknown) => error)

        expect(caught).toBeInstanceOf(DispachError)
        expect((caught as DispachError).code).toBe("unknown_event_type")
        expect((caught as DispachError).hint).toContain("turn.end")
        await runtime.stop()
    })
})

describe("a peer's message, and a retry that is safe", () => {
    test("from and idempotencyKey reach the wire, and a replay says so", async () => {
        const { client, runtime } = await harness()
        try {
            const agent = client.agent("assistant")
            const first = await agent.send("run the deploy", {
                from: { id: "agent:ops-bot", kind: "agent" },
                idempotencyKey: "req-client-1",
            })
            // A fresh turn is not a replay, and `replayed` is a boolean rather than optional — a
            // caller must not have to distinguish absent from false to know whether work happened.
            expect(first.replayed).toBe(false)
            expect(await first.text()).toBe("hello from the model")

            const again = await agent.send("run the deploy", {
                from: { id: "agent:ops-bot", kind: "agent" },
                idempotencyKey: "req-client-1",
            })
            expect(again.turnId).toBe(first.turnId)
            expect(again.replayed).toBe(true)

            // The sender is on the row, so a UI rendering a transcript can attribute the message
            // to someone other than the operator without having kept the send's arguments.
            const row = await first.get()
            expect(row.sender).toBe("agent:ops-bot")
            expect(row.senderKind).toBe("agent")
        } finally {
            await runtime.stop()
        }
    })

    test("a reattach handle is never a replay", async () => {
        // `agent.turn(id)` knows nothing about how the turn started, so the honest answer is false
        // rather than undefined. Asserted because the field is read to decide whether a side effect
        // has already been performed, and `undefined` is falsy by luck rather than by contract.
        const { client, runtime } = await harness()
        try {
            expect(client.agent("assistant").turn("t_whatever").replayed).toBe(false)
        } finally {
            await runtime.stop()
        }
    })

    test("a key reused with different text is a typed error, not a wrong answer", async () => {
        const { client, runtime } = await harness()
        try {
            const agent = client.agent("assistant")
            await agent.send("the original", { idempotencyKey: "req-client-2" })
            await expect(
                agent.send("something else", { idempotencyKey: "req-client-2" }),
            ).rejects.toMatchObject({ code: "idempotency_key_reused" })
        } finally {
            await runtime.stop()
        }
    })

    test("an unknown sender kind is refused before a turn starts", async () => {
        const { client, runtime } = await harness()
        try {
            await expect(
                client.agent("assistant").send("hi", {
                    // Deliberately outside the union: a JavaScript caller has no compiler, and the
                    // server refusing rather than defaulting is what makes that safe.
                    from: { id: "x", kind: "robot" as "agent" },
                }),
            ).rejects.toMatchObject({ code: "sender_invalid" })
        } finally {
            await runtime.stop()
        }
    })
})

describe("the firehose", () => {
    test("reports the resolved filter first, then events", async () => {
        const { client, runtime } = await harness()
        const stream = client.events({ types: ["turn.start", "turn.end"] })

        const first = await stream.next()
        expect(first.value?.kind).toBe("subscribed")
        if (first.value?.kind === "subscribed") {
            expect(first.value.report).toEqual({
                agentId: null,
                types: ["turn.start", "turn.end"],
                chunks: false,
                implied: undefined,
            })
        }

        void client.agent("assistant").send("hi")
        const seen: string[] = []
        for await (const item of stream) {
            if (item.kind === "event") seen.push(item.event.type)
            if (seen.includes("turn.end")) break
        }
        expect(seen).toEqual(["turn.start", "turn.end"])
        await runtime.stop()
    })

    test("naming model.chunk turns tokens on and says it did", async () => {
        const { client, runtime } = await harness({ reply: "implied" })
        const stream = client.events({ types: ["model.chunk"] })

        const first = await stream.next()
        if (first.value?.kind !== "subscribed") throw new Error("expected the preamble first")
        expect(first.value.report.chunks).toBe(true)
        expect(first.value.report.implied).toBe("types names model.chunk")

        void client.agent("assistant").send("hi")
        let text = ""
        for await (const item of stream) {
            if (item.kind !== "event") continue
            // `isEvent` narrows, so `data.delta` is typed rather than cast at the call site.
            if (isEvent(item.event, "model.chunk") && item.event.data.kind === "text") {
                text += item.event.data.delta
            }
            if (text === "implied") break
        }
        expect(text).toBe("implied")
        await runtime.stop()
    })
})

describe("approvals", () => {
    const ASK_MANIFEST = `${MANIFEST}tools:
  pinned: [now, memory_write]
  policy:
    mode: ask
`

    test("a blocked turn is discoverable and answerable through the client", async () => {
        // The full loop a UI runs: the turn blocks, `approvals()` finds the question, `approve()`
        // releases it. Driven through the real handler, so the suspended turn is a real one.
        const approvals = createApprovalRegistry()
        const { client, runtime } = await harness({
            manifest: ASK_MANIFEST,
            approvals,
            reply: ["I'll save that.\nACTION: memory_write\ntext: a note\nEND", "done"],
        })
        try {
            const agent = client.agent("assistant")
            const turn = await agent.send("save a note")

            let waiting = await agent.approvals()
            for (let attempt = 0; attempt < 300 && waiting.length === 0; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10))
                waiting = await agent.approvals()
            }
            expect(waiting.length).toBe(1)
            // Everything a prompt needs to be rendered without a second request.
            expect(waiting[0]?.slug).toBe("memory_write")
            expect(waiting[0]?.mutating).toBe(true)
            expect(waiting[0]?.reason.length).toBeGreaterThan(0)
            expect(waiting[0]?.requestedAt).toMatch(/^\d{4}-/)

            await agent.approve(waiting[0]?.approvalId ?? "", true)
            // `text()` waits for the turn rather than reading the row immediately — the POST
            // releases the question and the turn still has a step to run, so `get()` here races it
            // and reads `running`. That race is worth naming: it is the normal shape of answering
            // an approval, and a UI that re-renders straight off the POST response will see a turn
            // that is not finished yet.
            // Both steps' prose, which is correct: anything the model writes outside an `ACTION`
            // block is shown to the person, so a turn that narrated before calling a tool carries
            // that narration into its reply.
            expect(await turn.text()).toBe("I'll save that.\n\ndone")
            expect((await turn.get()).status).toBe("final")
            expect(await agent.approvals()).toEqual([])
        } finally {
            await runtime.stop()
        }
    })

    test("answering an approval that is not waiting is a typed error", async () => {
        const approvals = createApprovalRegistry()
        const { client, runtime } = await harness({ manifest: ASK_MANIFEST, approvals })
        try {
            await expect(
                client.agent("assistant").approve("a_nothing", true),
            ).rejects.toMatchObject({ code: "approval_not_found" })
        } finally {
            await runtime.stop()
        }
    })
})

describe("introspection", () => {
    test("describe, tools, skills and ready report what the server reports", async () => {
        const { client, runtime } = await harness()
        const agent = client.agent("assistant")

        expect(await client.ready()).toBe(true)
        const described = await agent.describe()
        expect({ id: described.id, entryPhase: described.entryPhase }).toEqual({
            id: "assistant",
            entryPhase: null,
        })
        // The bare manifest pins no tools, so the catalogue is empty — and `skills` reports
        // `configured: false`, which is what distinguishes it from an empty skills directory.
        expect(await agent.tools()).toEqual([])
        expect((await agent.skills()).configured).toBe(false)

        const agents = await client.agents()
        expect(agents.map((entry) => entry.id)).toEqual(["assistant"])
        await runtime.stop()
    })
})

describe("the frame mapper", () => {
    /** A synthetic SSE body, so a frame this client's own paths never produce can be tested. */
    function sse(frames: { event: string; data: unknown }[]): ReadableStream<Uint8Array> {
        const text = frames
            .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
            .join("")
        return new Response(text).body as ReadableStream<Uint8Array>
    }

    test("an unrecognised control frame is ignored, not mistaken for an event", async () => {
        // The discriminator is `EVENT_TYPES` — the runtime's own catalogue — rather than a guess
        // at control-frame names. A prefix test like `!name.startsWith("stream.")` passes every
        // other test in this file, because `turn.accepted` is the only non-`stream.` control frame
        // and this client does not use the inline-stream path that produces it. So this is tested
        // directly: a future frame named neither way must not surface as an event with no
        // envelope, which is how a client crashes on `event.data.something`.
        // The stand-in for a future frame is **asserted absent from the catalogue**, not assumed
        // absent — and the assertion, not the name, is the part that works. Two stages running, the
        // chosen name shipped: `approval.requested` became real in 15.2, and `handoff.start`, which
        // replaced it, became real in 10B one stage later. Each time this line is what turned the
        // silent inversion into a failure, so it stays and the name is now deliberately one no
        // roadmap mentions.
        expect(EVENT_TYPES as readonly string[]).not.toContain(NOT_AN_EVENT)
        const items = []
        for await (const item of turnStreamItems(
            sse([
                { event: "turn.accepted", data: { turnId: "t_1", sessionKey: "api:x" } },
                { event: NOT_AN_EVENT, data: { anything: true } },
                {
                    event: "turn.start",
                    data: { v: 1, type: "turn.start", data: { source: "api" } },
                },
            ]),
        )) {
            items.push(item.kind)
        }
        // The accepted frame is mapped, the unknown one is dropped, the real event is yielded.
        expect(items).toEqual(["accepted", "event"])
    })

    test("the event catalogue decides, so a real event is never treated as a control frame", async () => {
        const items = []
        for await (const item of turnStreamItems(
            sse([
                { event: "model.chunk", data: { v: 1, type: "model.chunk", data: { delta: "x" } } },
            ]),
        )) {
            items.push(item)
        }
        expect(items).toHaveLength(1)
        expect(items[0]?.kind).toBe("event")
    })
})
