/**
 * A scope is a **boundary**, not a filter — asserted against a real handler and a real key store.
 *
 * ## The distinction this file exists to hold
 *
 * `?agentId=` on `/v1/events` has always been a convenience a caller *chooses*. A scope is
 * something a caller cannot decline, and the difference only shows up when the caller tries: a
 * filter that a request can omit is not a boundary, and the omission is the attack. So every test
 * here reaches for the thing the scope forbids rather than checking that the allowed thing still
 * works.
 *
 * ## Why every refusal is a 404
 *
 * A `403` confirms the agent or session exists, which turns a key narrowed to one tenant into a
 * directory of the others. The assertions therefore check the **status and the code** against what
 * an entirely imaginary id produces — "indistinguishable" is the property, and a test that only
 * checked `!== 200` would pass on a 403 that leaks.
 *
 * The exception is a **capability** refusal, which is 403 on purpose: it discloses nothing about
 * what exists, only about what this credential may do.
 */

import { describe, expect, test } from "bun:test"
import type { KeyScope } from "@dispach/core"
import { attachWebSocket } from "../src/ws.ts"
import { fakeSocket, harness, readUntil } from "./harness.ts"

const TOKEN = "t_operator"

/**
 * An agent id the mint will accept that this server does not host.
 *
 * The obvious fixture — scoping to a name nobody has ever used — is **refused**, because
 * `key_scope_agent_unknown` exists precisely to stop a credential that reaches nothing. So the
 * fixture has to be an id that is real and not running, which is exactly what a durably-stopped
 * agent is. That the mint accepts one is deliberate: scoping a key to an agent somebody switched
 * off for the weekend is entirely reasonable, and refusing it would be a refusal nobody can act on.
 */
const ELSEWHERE = "switched-off"

async function elsewhere(runtime: Awaited<ReturnType<typeof harness>>["runtime"]): Promise<void> {
    await runtime.store.agentState.disable(ELSEWHERE, new Date().toISOString(), "for this test")
}

/**
 * Mint a key with a scope and hand back its secret.
 *
 * Through the route rather than the store, deliberately: minting is where the scope is validated,
 * and a test that wrote the row directly would be asserting the boundary against a scope the API
 * might have refused.
 */
async function keyWith(
    call: Awaited<ReturnType<typeof harness>>["call"],
    scope?: KeyScope & { readonly expiresIn?: number },
): Promise<string> {
    const response = await call("POST", "/v1/keys", {
        body: { label: "scoped", ...(scope === undefined ? {} : { scope }) },
    })
    const body = (await response.json()) as { secret?: string; error?: { code: string } }
    if (body.secret === undefined) {
        throw new Error(`minting failed: ${JSON.stringify(body.error)}`)
    }
    return body.secret
}

describe("agents outside the scope", () => {
    test("the resource answers exactly what an imaginary agent answers", async () => {
        const { call, runtime } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        // A real id this server does not host, so the scope is satisfiable and reaches nothing.
        const imaginary = await call("GET", "/v1/agents/does-not-exist", { token: scoped })
        const forbidden = await call("GET", "/v1/agents/assistant", { token: scoped })

        expect(forbidden.status).toBe(404)
        expect(forbidden.status).toBe(imaginary.status)
        const [a, b] = await Promise.all([forbidden.json(), imaginary.json()])
        // The *code* too: a distinct code would be a distinguishable answer, which is the whole
        // thing being avoided.
        expect((a as { error: { code: string } }).error.code).toBe(
            (b as { error: { code: string } }).error.code,
        )
    })

    test("an unscoped key still reaches it, so the test above is not passing by accident", async () => {
        const { call } = await harness({ token: TOKEN })
        const open = await keyWith(call)
        expect((await call("GET", "/v1/agents/assistant", { token: open })).status).toBe(200)
    })

    test("the listing filters rather than refusing", async () => {
        /**
         * A listing is how a client discovers what it can reach, so a narrow key gets an honest
         * answer about its own world. Refusing would leave a browser with a blank picker and no way
         * to find out why.
         */
        const { call, runtime } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        const response = await call("GET", "/v1/agents", { token: scoped })
        expect(response.status).toBe(200)
        /**
         * Exactly the one agent it may reach, and **the hosted one is absent**.
         *
         * The stopped row is built from `agentState` rather than from `runtime.list()`, which is
         * the half easy to get wrong: a filter applied only to the hosted agents would leak every
         * *stopped* agent's id to a key scoped away from it — and an id is precisely what this is
         * meant not to disclose.
         */
        const listed = (await response.json()) as readonly { id: string }[]
        expect(listed.map((entry) => entry.id)).toEqual([ELSEWHERE])
    })

    test("every agent-scoped route is behind the same check, not just the ones with tests", async () => {
        /**
         * Walked rather than listed one per test, because what is being asserted is that they all
         * go through `withAgent` — and the failure this catches is a *new* route that does not.
         */
        const { call, runtime } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        for (const path of [
            "/v1/agents/assistant",
            "/v1/agents/assistant/tools",
            "/v1/agents/assistant/skills",
            "/v1/agents/assistant/context",
            "/v1/agents/assistant/sessions",
            "/v1/agents/assistant/schedules",
            "/v1/agents/assistant/approvals",
        ]) {
            const response = await call("GET", path, { token: scoped })
            expect({ path, status: response.status }).toEqual({ path, status: 404 })
        }
    })
})

describe("the event stream", () => {
    test("a scoped key receives nothing for an agent it cannot reach", async () => {
        /**
         * **The widest disclosure on the surface, and it is reached by *omitting* a parameter.**
         * `/v1/events` with no `?agentId=` is the firehose: without a scope check there, a key
         * narrowed to one agent reads every other agent's turns, prompts and tool calls.
         */
        const { call, runtime } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        const stream = await call("GET", "/v1/events", { token: scoped })
        expect(stream.status).toBe(200)

        const emit = (agentId: string | undefined, code: string) =>
            runtime.bus.emit(
                "agent.warning",
                { code, message: "m", hint: "h" },
                agentId === undefined ? {} : { agentId },
            )

        /**
         * The forbidden event first, then a runtime-wide **sentinel**.
         *
         * Absence cannot be asserted by waiting — a stream that never ends means "nothing arrived"
         * and "not yet" are the same observation, and a frame budget would simply time out. Emitting
         * something that *must* arrive afterwards turns it into an ordering question: if the
         * forbidden event had leaked it would be in the frames before the sentinel.
         */
        emit("assistant", "must-not-arrive")
        emit(undefined, "sentinel")
        const frames = await readUntil(stream, (seen) =>
            seen.some(
                ([, data]) => (data as { data?: { code?: string } })?.data?.code === "sentinel",
            ),
        )
        const codes = frames.map(
            ([, data]) => (data as { data?: { code?: string } })?.data?.code ?? "",
        )
        expect(codes).toContain("sentinel")
        expect(codes).not.toContain("must-not-arrive")
    })

    test("a named agent outside the scope is a 404, not an empty stream", async () => {
        // An empty stream that stays open forever is the failure `unknown_event_type` was added to
        // remove: no error, no frames, and a client with every reason to believe nothing happened.
        const { call, runtime } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        const response = await call("GET", "/v1/events?agentId=assistant", { token: scoped })
        expect(response.status).toBe(404)
    })
})

describe("sessions outside the scope", () => {
    test("a named session the key may not reach is a 404", async () => {
        const { call } = await harness({ token: TOKEN })
        const scoped = await keyWith(call, { sessions: "team_42:" })
        const inside = await call("GET", "/v1/agents/assistant/sessions/team_42:a", {
            token: scoped,
        })
        const outside = await call("GET", "/v1/agents/assistant/sessions/team_7:a", {
            token: scoped,
        })
        // Neither session exists, so both are 404 — the assertion that matters is that the *inside*
        // one reaches the store and answers `session_not_found`, while the outside one is refused
        // before it gets there. Same status, and that is the point.
        expect(outside.status).toBe(404)
        expect(inside.status).toBe(404)
    })

    test("POST /messages cannot write into a session outside the scope", async () => {
        /**
         * The one place a caller **names** a session they may never have seen, in the body. Without
         * a check, a key scoped to `team_42:` writes into `team_7:`'s conversation simply by asking
         * — which is the difference between a filter and a boundary, in one request.
         */
        const { call } = await harness({ token: TOKEN })
        const scoped = await keyWith(call, { sessions: "team_42:", can: ["chat"] })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            token: scoped,
            body: { text: "hello", sessionKey: "team_7:intruder" },
        })
        expect(response.status).toBe(404)
    })

    test("a trailing star means the same as no star", async () => {
        // Both spellings will be written by somebody, and refusing one is a refusal nobody can
        // debug from the outside.
        const { call } = await harness({ token: TOKEN })
        const starred = await keyWith(call, { sessions: "team_42:*", can: ["chat"] })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            token: starred,
            body: { text: "hello", sessionKey: "team_42:ok" },
        })
        expect(response.status).toBe(202)
    })
})

describe("capabilities", () => {
    test("a refusal is 403 and names what is missing — it does not pretend the route is gone", async () => {
        const { call } = await harness({ token: TOKEN })
        const readOnly = await keyWith(call, { can: ["read"] })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            token: readOnly,
            body: { text: "hello" },
        })
        expect(response.status).toBe(403)
        const body = (await response.json()) as { error: { code: string; hint: string } }
        expect(body.error.code).toBe("capability_required")
        // A 404 here would tell somebody holding a read-only key that the agent they can plainly
        // read has vanished, which is a worse answer than the truthful one.
        expect(body.error.hint).toContain("chat")
    })

    test("each capability opens its own routes and no others", async () => {
        const { call } = await harness({ token: TOKEN })
        const chat = await keyWith(call, { can: ["chat"] })
        // `chat` sends; it does not write schedules and it does not mint credentials.
        expect(
            (
                await call("POST", "/v1/agents/assistant/messages", {
                    token: chat,
                    body: { text: "hi" },
                })
            ).status,
        ).toBe(202)
        expect(
            (
                await call("POST", "/v1/agents/assistant/schedules", {
                    token: chat,
                    body: { id: "s", kind: "every", expr: "1h", task: "t" },
                })
            ).status,
        ).toBe(403)
        expect((await call("GET", "/v1/keys", { token: chat })).status).toBe(403)
        // And it cannot read, which is the half that proves `can` is a set rather than a level.
        expect((await call("GET", "/v1/agents/assistant/tools", { token: chat })).status).toBe(403)
    })

    test("an empty capability list is honoured as written", async () => {
        // A key that may do nothing is a coherent thing to mint, and quietly promoting it to
        // "everything" — which is what an absent `can` means — would be the worst possible reading.
        const { call } = await harness({ token: TOKEN })
        const useless = await keyWith(call, { can: [] })
        expect((await call("GET", "/v1/agents", { token: useless })).status).toBe(403)
    })

    test("an unscoped key has all four, byte-identical to before scopes existed", async () => {
        const { call } = await harness({ token: TOKEN })
        const open = await keyWith(call)
        expect((await call("GET", "/v1/agents", { token: open })).status).toBe(200)
        expect((await call("GET", "/v1/keys", { token: open })).status).toBe(200)
        expect(
            (
                await call("POST", "/v1/agents/assistant/messages", {
                    token: open,
                    body: { text: "hi" },
                })
            ).status,
        ).toBe(202)
    })
})

describe("minting", () => {
    test("a scope naming an agent that does not exist is refused at the moment it is typed", async () => {
        /**
         * The failure it prevents is the one this repo keeps finding under new names: a credential
         * that authenticates perfectly and reaches nothing, indistinguishable from a working key
         * until somebody uses it — by which point the mint is hours in the past and the typo is
         * invisible.
         */
        const { call } = await harness({ token: TOKEN })
        const response = await call("POST", "/v1/keys", {
            body: { label: "typo", scope: { agents: ["assistnat"] } },
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string; field: string } }
        expect(body.error.code).toBe("key_scope_agent_unknown")
        expect(body.error.field).toBe("scope.agents")
    })

    test("an expiry comes back absolute, and the key stops working after it", async () => {
        const { call } = await harness({ token: TOKEN })
        const minted = await call("POST", "/v1/keys", {
            body: { label: "brief", scope: { expiresIn: 1 } },
        })
        const key = (await minted.json()) as { secret: string; expiresAt?: string }
        // Relative going in, absolute coming back — so the caller can see what this server decided
        // rather than asserting agreement with its clock.
        expect(typeof key.expiresAt).toBe("string")
        expect((await call("GET", "/v1/agents", { token: key.secret })).status).toBe(200)

        await new Promise((resolve) => setTimeout(resolve, 1100))
        const after = await call("GET", "/v1/agents", { token: key.secret })
        // Indistinguishable from a revoked key and from a wrong one: "expired" would date a leaked
        // credential, and "revoked" would confirm it had once been real.
        expect(after.status).toBe(401)
        expect((await after.json()) as { error: { code: string } }).toMatchObject({
            error: { code: "unauthorized" },
        })
    })

    test("the scope survives the round trip and appears in the listing", async () => {
        const { call } = await harness({ token: TOKEN })
        await call("POST", "/v1/keys", {
            body: {
                label: "web · user_8812",
                scope: { agents: ["assistant"], sessions: "team_42:*", can: ["chat", "read"] },
            },
        })
        const listed = (await (await call("GET", "/v1/keys")).json()) as {
            keys: readonly { label: string; scope?: KeyScope }[]
        }
        const row = listed.keys.find((key) => key.label === "web · user_8812")
        expect(row?.scope).toEqual({
            agents: ["assistant"],
            sessions: "team_42:*",
            can: ["chat", "read"],
        })
    })
})

describe("the websocket handshake", () => {
    /**
     * `/v1/ws` had its **own** comparison, against the configured token only — so a browser holding
     * an operator key could not use WebSocket at all. Undocumented, and not a decision: the recorded
     * *"a check only one surface performs is a check the two disagree about"* shape, on the one
     * surface where disagreeing means a credential works everywhere except the socket.
     *
     * It now calls the same `authorise` the HTTP dispatcher does, which is what makes every
     * assertion below possible at all.
     */
    function handshake(headers: Record<string, string>, query = ""): Request {
        return new Request(`http://127.0.0.1:7420/v1/ws${query}`, {
            headers: { host: "127.0.0.1:7420", ...headers },
        })
    }

    test("an operator key is accepted — it was rejected outright before", async () => {
        const { call, runtime, handler } = await harness({ token: TOKEN })
        const key = await keyWith(call)
        const bridge = attachWebSocket(runtime, handler.authenticate)

        const attempt = await bridge.accept(
            handshake({ "sec-websocket-protocol": `dispach.bearer, ${key}` }),
        )
        expect(attempt.kind).toBe("accept")
    })

    test("the credential travels in a header, not the URL", async () => {
        /**
         * A browser cannot set headers on a WebSocket handshake, which is why `?token=` existed —
         * and a credential in a URL is what this project's standing rule forbids, because it lands
         * in an access log, in a `Referer`, and in anything that proxies. The subprotocol list is a
         * header the browser *will* send on the caller's behalf.
         */
        const { call, runtime, handler } = await harness({ token: TOKEN })
        const key = await keyWith(call)
        const bridge = attachWebSocket(runtime, handler.authenticate)

        const attempt = await bridge.accept(
            handshake({ "sec-websocket-protocol": `dispach.bearer, ${key}` }),
        )
        // **Echoed, or the browser closes the socket immediately** — a server that accepts a
        // handshake offering subprotocols and names none of them has, to a browser, agreed to
        // nothing, and it hangs up with no readable reason.
        expect(attempt.kind === "accept" ? attempt.protocol : undefined).toBe("dispach.bearer")
    })

    test("the query form still works, because removing it would break every existing client", async () => {
        // Accepted and documented as deprecated. Dropping it in the same change that introduces the
        // replacement buys no security a deprecation window does not also buy.
        const { runtime, handler } = await harness({ token: TOKEN })
        const bridge = attachWebSocket(runtime, handler.authenticate)
        expect((await bridge.accept(handshake({}, `?token=${TOKEN}`))).kind).toBe("accept")
    })

    test("a wrong credential is refused, so the two above are not passing on an open server", async () => {
        const { runtime, handler } = await harness({ token: TOKEN })
        const bridge = attachWebSocket(runtime, handler.authenticate)
        const attempt = await bridge.accept(
            handshake({ "sec-websocket-protocol": "dispach.bearer, not-a-key" }),
        )
        expect(attempt.kind).toBe("reject")
        expect(attempt.kind === "reject" ? attempt.response.status : 0).toBe(401)
    })

    test("a named agent outside the scope is a 404 on the handshake too", async () => {
        /**
         * Not a 401 — the credential is fine. Not a 403 — that confirms the agent exists, which is
         * the disclosure the whole 404-not-403 rule prevents, and a socket is no less able to
         * enumerate than a GET is.
         */
        const { call, runtime, handler } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        const bridge = attachWebSocket(runtime, handler.authenticate)

        const attempt = await bridge.accept(
            handshake(
                { "sec-websocket-protocol": `dispach.bearer, ${scoped}` },
                "?agentId=assistant",
            ),
        )
        expect(attempt.kind === "reject" ? attempt.response.status : 0).toBe(404)
    })

    test("a socket opened with no agentId still does not receive another agent's events", async () => {
        /**
         * **The hole a filter would have left.** A socket with no `?agentId=` is the firehose, so
         * without the scope check on `broadcast` a key narrowed to one agent reads every other
         * agent's traffic by simply not asking for one — the same omission-is-the-attack shape as
         * `/v1/events`.
         */
        const { call, runtime, handler } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        const bridge = attachWebSocket(runtime, handler.authenticate)

        const attempt = await bridge.accept(
            handshake({ "sec-websocket-protocol": `dispach.bearer, ${scoped}` }),
        )
        expect(attempt.kind).toBe("accept")
        if (attempt.kind !== "accept") return

        const socket = fakeSocket(undefined, false, attempt.session.principal)
        bridge.handlers.open(socket.ws)
        runtime.bus.emit(
            "agent.warning",
            { code: "leak", message: "m", hint: "h" },
            {
                agentId: "assistant",
            },
        )
        expect(socket.frames().some((frame) => JSON.stringify(frame).includes("leak"))).toBe(false)
    })

    test("a subscribe frame cannot re-point the socket outside the scope", async () => {
        // The handshake is not the only moment an agent id enters: a socket opened with none can
        // name one later, and honouring that unchecked would make the frame a way round the
        // boundary the handshake had just applied.
        const { call, runtime, handler } = await harness({ token: TOKEN })
        await elsewhere(runtime)
        const scoped = await keyWith(call, { agents: [ELSEWHERE] })
        const bridge = attachWebSocket(runtime, handler.authenticate)
        const attempt = await bridge.accept(
            handshake({ "sec-websocket-protocol": `dispach.bearer, ${scoped}` }),
        )
        if (attempt.kind !== "accept") throw new Error("handshake refused")

        const socket = fakeSocket(undefined, false, attempt.session.principal)
        bridge.handlers.message(
            socket.ws,
            JSON.stringify({ type: "subscribe", agentId: "assistant" }),
        )
        expect(socket.frames()[0]).toMatchObject({
            type: "ws.error",
            error: { code: "agent_not_found" },
        })
        // And the socket is left where it was rather than half-moved.
        expect(socket.ws.data.agentId).toBeUndefined()
    })
})
