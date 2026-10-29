/**
 * `sessions.scope` over the wire (`docs/23-SPEC-SESSIONS.md`): the key a client is told in the `202`
 * and in `ws.accepted`, rotation, the `head` flag, and where a scoped key's turn may land.
 */

import { describe, expect, test } from "bun:test"
import { attachWebSocket } from "../src/ws.ts"
import { fakeSocket, harness, MANIFEST } from "./harness.ts"

const TOKEN = "t_operator"
const OWNER = "me:k7m2xp"
const SCOPED = `${MANIFEST}sessions:\n  scope: owner\n`

async function owned() {
    const setup = await harness({ token: TOKEN, manifest: SCOPED })
    await setup.call("POST", "/v1/participants", { body: { id: OWNER, role: "admin" } })
    const assigned = await setup.call("PUT", "/v1/agents/assistant/assignee", {
        body: { participantId: OWNER, channelIds: ["telegram:@moeen"] },
    })
    expect(assigned.status).toBe(200)
    return setup
}

async function mint(
    call: Awaited<ReturnType<typeof harness>>["call"],
    scope: Record<string, unknown>,
): Promise<string> {
    const response = await call("POST", "/v1/keys", { body: { label: "scoped", scope } })
    return ((await response.json()) as { secret: string }).secret
}

const send = (
    call: Awaited<ReturnType<typeof harness>>["call"],
    body: Record<string, unknown>,
    token = TOKEN,
) => call("POST", "/v1/agents/assistant/messages", { body: { text: "hi", ...body }, token })

describe("the key a client is told", () => {
    test("the 202 names the owner's conversation, whatever key was sent", async () => {
        const { call } = await owned()
        const response = await send(call, { sessionKey: "web:a1b2c3" })
        expect(response.status).toBe(202)
        expect(((await response.json()) as { sessionKey: string }).sessionKey).toBe(
            `owner:${OWNER}`,
        )
    })

    test("a stranger keeps the key they sent", async () => {
        const { call } = await owned()
        const response = await send(call, {
            sessionKey: "api:eve",
            from: { id: "user:eve", kind: "user" },
        })
        expect(((await response.json()) as { sessionKey: string }).sessionKey).toBe("api:eve")
    })

    test("a key bound to the owner lands in their conversation, beyond its own prefix", async () => {
        const { call } = await owned()
        const key = await mint(call, { participant: OWNER, sessions: "web:" })
        const response = await send(call, { sessionKey: "web:x" }, key)
        expect(((await response.json()) as { sessionKey: string }).sessionKey).toBe(
            `owner:${OWNER}`,
        )
        // And can read it back: the turn never lands where its caller could not.
        const read = await call("GET", `/v1/agents/assistant/sessions/owner:${OWNER}`, {
            token: key,
        })
        expect(read.status).not.toBe(404)
    })

    test("a prefixed key speaking for nobody keeps its key: the owner's is outside its reach", async () => {
        const { call } = await owned()
        const key = await mint(call, { sessions: "team_42:" })
        const response = await send(call, { sessionKey: "team_42:a" }, key)
        expect(((await response.json()) as { sessionKey: string }).sessionKey).toBe("team_42:a")
        // Not a rotation's worth of reach either: owner:me:k7m2xpX is not the owner's conversation.
        const bound = await mint(call, { participant: OWNER, sessions: "web:" })
        const near = await call("GET", `/v1/agents/assistant/sessions/owner:${OWNER}x`, {
            token: bound,
        })
        expect(near.status).toBe(404)
    })

    test("ws.accepted carries the key, and stays synchronous for a channel-peer agent", async () => {
        const { runtime } = await owned()
        const bridge = attachWebSocket(runtime, async () => ({ kind: "open" }))
        const socket = fakeSocket("assistant")
        bridge.handlers.open(socket.ws)
        bridge.handlers.message(socket.ws, JSON.stringify({ type: "message", text: "hi" }))
        for (let i = 0; i < 50 && !socket.frames().some((f) => f.type === "ws.accepted"); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        const accepted = socket.frames().find((frame) => frame.type === "ws.accepted")
        expect(accepted?.sessionKey).toBe(`owner:${OWNER}`)
        bridge.closeAll()

        const plain = await harness({ token: TOKEN })
        const plainBridge = attachWebSocket(plain.runtime, async () => ({ kind: "open" }))
        const plainSocket = fakeSocket("assistant")
        plainBridge.handlers.open(plainSocket.ws)
        plainBridge.handlers.message(
            plainSocket.ws,
            JSON.stringify({ type: "message", text: "hi" }),
        )
        // Same tick: no await between the frame and this read.
        const now = plainSocket.frames().find((frame) => frame.type === "ws.accepted")
        expect(now?.sessionKey).toBe("api:default")
        plainBridge.closeAll()
    })
})

describe("rotation and the head flag", () => {
    test("rotate starts afresh; the listing marks which conversation is current", async () => {
        const { call } = await owned()
        await send(call, { sessionKey: "web:a" })
        const response = await call("POST", "/v1/agents/assistant/sessions/rotate")
        expect(response.status).toBe(200)
        const rotated = (await response.json()) as { sessionKey: string; previous: string }
        expect(rotated.previous).toBe(`owner:${OWNER}`)
        expect(rotated.sessionKey.startsWith(`owner:${OWNER}~`)).toBe(true)

        const next = await send(call, { sessionKey: "web:b" })
        expect(((await next.json()) as { sessionKey: string }).sessionKey).toBe(rotated.sessionKey)
        const listed = (await (await call("GET", "/v1/agents/assistant/sessions")).json()) as {
            sessionKey: string
            head: boolean
        }[]
        const heads = Object.fromEntries(listed.map((s) => [s.sessionKey, s.head]))
        expect(heads).toEqual({ [`owner:${OWNER}`]: false, [rotated.sessionKey]: true })
    })

    test("a prefixed key cannot rotate the owner's conversation by naming the owner", async () => {
        const { call } = await owned()
        await send(call, { sessionKey: "web:a" })
        const key = await mint(call, { sessions: "team_42:" })
        for (const body of [{}, { from: { id: OWNER, kind: "user" } }]) {
            const response = await call("POST", "/v1/agents/assistant/sessions/rotate", {
                body,
                token: key,
            })
            expect(response.status).toBe(409)
        }
        // The owner's own bound key may.
        const own = await mint(call, { participant: OWNER, sessions: "web:" })
        const mine = await call("POST", "/v1/agents/assistant/sessions/rotate", { token: own })
        expect(mine.status).toBe(200)
    })

    test("a channel-peer agent has nothing to rotate, and says what to do instead", async () => {
        const { call } = await harness({ token: TOKEN })
        const response = await call("POST", "/v1/agents/assistant/sessions/rotate")
        expect(response.status).toBe(409)
        const body = (await response.json()) as { error: { code: string; hint: string } }
        expect(body.error.code).toBe("session_not_rotatable")
        expect(body.error.hint).toContain("channel-peer")
    })
})

describe("the rest of the wire", () => {
    test("the agent says its scope, and an unassigned owner scope warns until assigned", async () => {
        const { call, runtime } = await harness({ token: TOKEN, manifest: SCOPED })
        const agent = (await (await call("GET", "/v1/agents/assistant")).json()) as {
            sessionScope: string
        }
        expect(agent.sessionScope).toBe("owner")
        const warns = () => runtime.agent("assistant").warnings.map((w) => w.code)
        expect(warns()).toContain("sessions_scope_unassigned")
        await call("POST", "/v1/participants", { body: { id: OWNER, role: "admin" } })
        await call("PUT", "/v1/agents/assistant/assignee", { body: { participantId: OWNER } })
        expect(warns()).not.toContain("sessions_scope_unassigned")
    })

    test("a participant's channelIds are stored and read back; a bad list is refused by name", async () => {
        const { call } = await harness({ token: TOKEN })
        const made = await call("POST", "/v1/participants", {
            body: { id: "user:ada", channelIds: ["telegram:@ada"] },
        })
        expect(made.status).toBe(201)
        const listed = (await (await call("GET", "/v1/participants")).json()) as {
            participants: { id: string; channelIds?: string[] }[]
        }
        expect(listed.participants.find((p) => p.id === "user:ada")?.channelIds).toEqual([
            "telegram:@ada",
        ])
        const bad = await call("POST", "/v1/participants", {
            body: { id: "user:bob", channelIds: "telegram:@bob" },
        })
        expect(bad.status).toBe(400)
        expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
            "participant_channel_ids_invalid",
        )
    })

    test("the owner's agents' memory is not another admin's to read", async () => {
        const { call } = await owned()
        await call("POST", "/v1/participants", { body: { id: "user:root", role: "admin" } })
        const root = await mint(call, { participant: "user:root" })
        const theirs = await call("GET", `/v1/memory/notes?scope=agents:${OWNER}`, { token: root })
        expect(theirs.status).toBe(403)
        const own = await mint(call, { participant: OWNER })
        const mine = await call("GET", `/v1/memory/notes?scope=agents:${OWNER}`, { token: own })
        expect(mine.status).toBe(200)
    })
})
