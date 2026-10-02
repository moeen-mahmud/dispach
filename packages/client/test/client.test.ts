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
import { EVENT_TYPES, HarnessError, Runtime } from "@dispach/core"
import {
    type ApprovalRegistry,
    createApprovalRegistry,
    createHandler,
    type Provisioner,
    type SecretAdmin,
} from "@dispach/server"
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
        /**
         * A provisioner and a loopback bind, for the two provisioning reads.
         *
         * Both are needed together and neither is default: without a bind the handler cannot claim
         * a request is local, and `POST /v1/agents` answers `403` — which is the right answer to
         * "you did not say what you bound" and the wrong thing for this test to assert against.
         */
        provision?: Provisioner
        /** The credential writer for the secrets routes. */
        secrets?: SecretAdmin
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
        ...(options.provision === undefined
            ? {}
            : { provision: options.provision, origin: { host: "127.0.0.1" } }),
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    })

    /**
     * The client's transport *is* the server's handler — with the one header a real one adds.
     *
     * `new Request(url)` populates no `Host`, and a browser or `curl` always sends it. Without it
     * the origin guard cannot tell a rebinding attempt from an ordinary call and refuses, which
     * showed up as `host_not_allowed` on the first test to build the handler with a bind. Faked
     * here rather than relaxed in the guard: the header is a fact about HTTP, not about this test.
     */
    const transport = () =>
        ((url: string | URL | Request, init?: RequestInit) =>
            handler(
                new Request(url as string, {
                    ...init,
                    headers: { host: new URL(url as string).host, ...init?.headers },
                }),
            )) as typeof fetch

    const client = createClient({
        baseUrl: "http://127.0.0.1:7420",
        ...(options.token === undefined ? {} : { token: options.token }),
        fetch: transport(),
    })

    /** A second client against the same server, so an auth test is a real one. */
    const clientWith = (token?: string) =>
        createClient({
            baseUrl: "http://127.0.0.1:7420",
            ...(token === undefined ? {} : { token }),
            fetch: transport(),
        })

    return { client, clientWith, runtime, dir }
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

describe("every read is unwrapped the way its route wraps it", () => {
    /**
     * `schedules()` was declared `Promise<readonly ScheduleRecord[]>` and returned
     * `{ schedules: [...] }`, because the route wraps it and this one did not unwrap.
     *
     * It shipped that way and nothing noticed, for the only reason such a thing can: **nothing
     * called it.** `approvals()` twenty lines above has always unwrapped correctly, so this is the
     * `includeHistory` shape rather than a typo — a declaration with no consumer is wrong for as
     * long as it has none, and its type asserts otherwise the whole time. The first real caller was
     * 17.3's schedules panel, where it crashed on `schedules.map is not a function` and React took
     * the entire page down to a black screen.
     *
     * So this walks every list-shaped read against a real handler and asserts it is an **array**.
     * Not a type assertion — `tsc` was satisfied throughout — but the value that actually arrives.
     */
    test("each list read returns an array against a real handler", async () => {
        const { client, runtime } = await harness()
        const agent = client.agent("assistant")
        for (const [name, read] of [
            ["tools", () => agent.tools()],
            ["sessions", () => agent.sessions()],
            ["schedules", () => agent.schedules()],
            ["approvals", () => agent.approvals()],
        ] as const) {
            const value = await read()
            // `Array.isArray` rather than a length or a property: what went wrong was the *kind* of
            // thing returned, and every assertion about its contents passed right up to `.map`.
            expect({ name, isArray: Array.isArray(value) }).toEqual({ name, isArray: true })
        }
        await runtime.stop()
    })

    test("every route this client declares is reachable against a real handler", async () => {
        /**
         * The 18.5 gap, closed and then guarded: this package covered 17 of 33 routes, so the web
         * UI hand-rolled the credential calls with its own `fetch`, its own headers and its own
         * error handling — which is how one endpoint comes to throw a raw `TypeError` while its
         * neighbours throw `DispachError`, and a caller cannot write one `catch` against that.
         *
         * Walked rather than one test per method, because what is being asserted is *coverage*: a
         * method that compiles and 404s is the shape `schedules()` had for three phases.
         */
        const { client, runtime } = await harness()
        const agent = client.agent("assistant")

        const created = await agent.createSchedule({
            id: "nightly",
            kind: "every",
            expr: "15m",
            task: "check the thing",
            deliver: "none",
        })
        expect(created.id).toBe("nightly")
        expect((await agent.updateSchedule("nightly", { enabled: false })).enabled).toBe(false)
        expect((await agent.schedules()).map((row) => row.id)).toEqual(["nightly"])
        await agent.deleteSchedule("nightly")
        expect(await agent.schedules()).toEqual([])

        await runtime.stop()
    })

    test("the credential routes, which the web UI used to hand-roll", async () => {
        /**
         * A **token'd** harness, and the reason is the behaviour itself: `authRequired` latches on
         * the first live key, so minting one against a server with no token configured flips it
         * from open to closed and locks out the very client that just minted it. Documented, and
         * exactly what a naive test walks into — the first version of this one did.
         */
        const { client, runtime } = await harness({ token: "t_operator" })

        const listed = await client.keys()
        expect(Array.isArray(listed.keys)).toBe(true)
        // The sentence about scope travels with the listing, so a client never re-derives it.
        expect(listed.scope).toContain("not an identity")

        const minted = await client.createKey({ label: "probe", scope: { can: ["read"] } })
        // The secret comes back **once**, and this is the only moment it exists outside the caller.
        expect(minted.secret.length).toBeGreaterThan(20)
        expect(minted.scope).toEqual({ can: ["read"] })
        expect((await client.revokeKey(minted.keyId)).revokedAt).toBeDefined()

        await runtime.stop()
    })

    test("the step list is an array even when this server cannot provision", async () => {
        /**
         * The same class as `schedules()` above and the reason this is asserted rather than typed:
         * `steps` is declared `readonly ProvisionStepLike[]`, and a handler with no provisioner
         * still has to send `[]` rather than omit the field — a page that mapped over `undefined`
         * would take the tree down exactly as the schedules panel did.
         */
        const { client, runtime } = await harness()
        const offer = await client.provision()
        expect(Array.isArray(offer.steps)).toBe(true)
        // And it says *which* refusal applies, which is the whole reason this route answers at all
        // rather than leaving a page to discover it from a 501 after somebody filled a form in.
        expect(offer.available).toBe(false)
        expect(offer.steps).toEqual([])
        await runtime.stop()
    })
})

describe("webhooks", () => {
    test("create returns the secret once; the list is an array without it", async () => {
        const { client, runtime } = await harness()
        const created = await client.createWebhook({
            url: "https://93.184.216.34/hooks",
            types: ["turn.end"],
        })
        expect(created.secret).toStartWith("whsec_")
        const listed = await client.webhooks()
        expect(Array.isArray(listed)).toBe(true)
        expect(JSON.stringify(listed)).not.toContain(created.secret)
        expect((await client.deleteWebhook(created.subscriptionId)).deleted).toBe(true)
        expect(await client.webhooks()).toEqual([])
        await runtime.stop()
    })
})

describe("usage and turns", () => {
    test("usage buckets and the turn list are the shapes the server sends", async () => {
        const { client, runtime } = await harness()
        const agent = client.agent("assistant")
        await (await agent.send("hello")).text()
        await new Promise((resolve) => setTimeout(resolve, 20))
        const report = await client.usage({ by: ["agent"] })
        // The kind of value, not just its contents: a wrapped response read as the wrong shape is
        // how a page crashed on `.map is not a function`.
        expect(Array.isArray(report.buckets)).toBe(true)
        expect(report.buckets[0]?.agentId).toBe("assistant")
        expect((await agent.usage({ by: [] })).buckets[0]?.calls).toBeGreaterThan(0)
        const page = await agent.turns({ limit: 5 })
        expect(Array.isArray(page.turns)).toBe(true)
        expect(page.turns[0]?.input).toBe("hello")
        await runtime.stop()
    })
})

describe("creating an agent", () => {
    /** A provisioner that writes a real manifest, so `Runtime.adopt` has something to adopt. */
    function provisioner(dir: () => string): Provisioner {
        return {
            steps: () => [
                {
                    step: "name",
                    prompt: "The agent's name",
                    fallback: "",
                    optional: false,
                    secret: false,
                },
                {
                    step: "telegram",
                    prompt: "Telegram?",
                    fallback: "none",
                    optional: false,
                    secret: false,
                    choices: [
                        { value: "none", label: "no" },
                        { value: "connected", label: "yes" },
                    ],
                },
                {
                    step: "telegramToken",
                    prompt: "Telegram bot token",
                    fallback: "",
                    optional: true,
                    secret: true,
                    requires: { step: "telegram", value: "connected" },
                },
            ],
            create: (answers) => {
                const id = answers.name ?? "nameless"
                const target = join(dir(), id)
                mkdirSync(target, { recursive: true })
                writeFileSync(join(target, "agent.yaml"), MANIFEST.replace("assistant", id))
                return {
                    agentId: id,
                    manifestPath: join(target, "agent.yaml"),
                    dir: target,
                    files: ["agent.yaml"],
                }
            },
            templates: () => [
                { name: "support", vars: [{ name: "store", required: true, secret: false }] },
            ],
            createFromTemplate: (input) => {
                const id = input.name.toLowerCase()
                const target = join(dir(), id)
                mkdirSync(target, { recursive: true })
                writeFileSync(join(target, "agent.yaml"), MANIFEST.replace("assistant", id))
                return {
                    agentId: id,
                    manifestPath: join(target, "agent.yaml"),
                    dir: target,
                    files: ["agent.yaml"],
                }
            },
        }
    }

    test("templates are an array, and one creates an agent that is adopted", async () => {
        let dir = ""
        const { client, runtime } = await harness({ provision: provisioner(() => dir) })
        dir = mkdtempSync(join(tmpdir(), "client-template-"))
        dirs.push(dir)
        const templates = await client.templates()
        // The kind of value, not just its contents: a wrapped response read as a bare array is how
        // a page crashed on `.map is not a function`.
        expect(Array.isArray(templates)).toBe(true)
        expect(templates.map((entry) => entry.name)).toEqual(["support"])
        const created = await client.createAgentFromTemplate({
            template: "support",
            name: "Acme",
            vars: { store: "Acme" },
        })
        expect(created.adopted).toEqual(["acme"])
        await runtime.stop()
    })

    test("secrets are an array of names, and a write is applied", async () => {
        const written = new Map<string, string>()
        const { client, runtime } = await harness({
            secrets: {
                status: () => [
                    {
                        name: "MODEL_API_KEY",
                        set: written.has("MODEL_API_KEY"),
                        usedBy: ["model.main.apiKeyEnv"],
                    },
                ],
                write: (_path, values) => {
                    for (const [name, value] of Object.entries(values)) written.set(name, value)
                    return { written: Object.keys(values), shadowed: [] }
                },
            },
        })
        const agent = client.agent("assistant")
        const before = await agent.secrets()
        expect(Array.isArray(before)).toBe(true)
        expect(before[0]).toEqual({
            name: "MODEL_API_KEY",
            set: false,
            usedBy: ["model.main.apiKeyEnv"],
        })
        const result = await agent.setSecrets({ MODEL_API_KEY: "sk-new" })
        expect(result.applied).toBe("reloaded")
        expect((await agent.secrets())[0]?.set).toBe(true)
        await runtime.stop()
    })

    test("the answers reach the provisioner and the agent is adopted, not restarted", async () => {
        /**
         * The property the whole always-on shape rests on: `POST /v1/agents` ends in
         * `Runtime.adopt`, so the agent is served before the response returns. A client that had to
         * poll for it would be the "provisioned and silently unreachable" state this replaces.
         */
        let dir = ""
        const { client, runtime } = await harness({ provision: provisioner(() => dir) })
        dir = mkdtempSync(join(tmpdir(), "client-provision-"))
        dirs.push(dir)

        const created = await client.createAgent({ name: "vela" })
        expect(created.id).toBe("vela")
        expect(Array.isArray(created.files)).toBe(true)
        expect(created.adopted).toEqual(["vela"])
        // Live on the same host, in the same process, with no second command.
        expect((await client.agents()).map((entry) => entry.id)).toContain("vela")
        await runtime.stop()
    })

    test("a conditional step arrives with what opens it", async () => {
        // Forwarded verbatim, so a browser can reveal a token field from data the server sent
        // instead of re-implementing the wizard's walk.
        const { client, runtime } = await harness({ provision: provisioner(() => tmpdir()) })
        const offer = await client.provision()
        expect(offer.available).toBe(true)
        expect(offer.local).toBe(true)
        expect(offer.steps.find((step) => step.step === "telegramToken")?.requires).toEqual({
            step: "telegram",
            value: "connected",
        })
        // And the secret flag survives the wire, because it is what a client masks on.
        expect(offer.steps.find((step) => step.step === "telegramToken")?.secret).toBe(true)
        await runtime.stop()
    })

    test("a refused answer names the field to fix", async () => {
        /**
         * The route passes `HarnessError`'s own detail through rather than paraphrasing it, and
         * `field` is what turns a 400 into a marker beside one input instead of a banner.
         */
        const refusing: Provisioner = {
            steps: () => [],
            templates: () => [],
            createFromTemplate: () => {
                throw new Error("not used here")
            },
            create: () => {
                throw new HarnessError({
                    code: "provision_answer_invalid",
                    message: 'name is "" which cannot be empty.',
                    hint: "GET /v1/provision lists every step with its default.",
                    field: "name",
                })
            },
        }
        const { client, runtime } = await harness({ provision: refusing })
        let caught: unknown
        try {
            await client.createAgent({ name: "" })
        } catch (error) {
            caught = error
        }
        expect(caught).toBeInstanceOf(DispachError)
        expect((caught as DispachError).code).toBe("provision_answer_invalid")
        expect((caught as DispachError).field).toBe("name")
        expect((caught as DispachError).status).toBe(400)
        await runtime.stop()
    })
})

describe("activity", () => {
    test("is the shape the server sends", async () => {
        const { client, runtime } = await harness()
        const activity = await client.activity()
        expect(activity.idle).toBe(true)
        expect(activity.deliveries.webhooks.pending).toBe(0)
        await runtime.stop()
    })
})
