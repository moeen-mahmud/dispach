/**
 * A key bound to a participant speaks for that participant and no one else (doc 16 R7), on every
 * verb that starts a turn. What a tool then receives is asserted in core's
 * `acting-participant.test.ts`; this file holds the wire's half — who the turn is attributed to.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { attachWebSocket } from "../src/ws.ts"
import { cleanupWorkspaces, fakeSocket, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

const TOKEN = "t_operator"
const BOB = "user:bob"

type Harness = Awaited<ReturnType<typeof harness>>

async function bobKey(call: Harness["call"]): Promise<string> {
    const response = await call("POST", "/v1/keys", {
        body: { label: "bob's front end", scope: { participant: BOB, can: ["chat", "read"] } },
    })
    const body = (await response.json()) as { secret: string; scope?: { participant?: string } }
    expect(body.scope?.participant).toBe(BOB)
    return body.secret
}

async function senderOf(runtime: Harness["runtime"], turnId: string): Promise<unknown> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const row = await runtime.store.turns.get(turnId)
        if (row !== undefined && row.status !== "running") return row.sender
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`turn ${turnId} never finished`)
}

function send(call: Harness["call"], token: string, from?: unknown) {
    return call("POST", "/v1/agents/assistant/messages", {
        token,
        body: { text: "hello", ...(from === undefined ? {} : { from }) },
    })
}

describe("a key bound to a participant", () => {
    test("cannot post as anyone else, nor as an agent", async () => {
        const { call } = await harness({ token: TOKEN })
        const key = await bobKey(call)
        for (const from of [
            { id: "user:alice", kind: "user" },
            { id: BOB, kind: "agent" },
        ]) {
            const response = await send(call, key, from)
            expect(response.status).toBe(403)
            const body = (await response.json()) as { error: { code: string; hint: string } }
            expect(body.error.code).toBe("sender_not_bound_participant")
            expect(body.error.hint).toContain(BOB)
        }
    })

    test("posts as itself, and an omitted from is filled in", async () => {
        const { call, runtime } = await harness({ token: TOKEN })
        const key = await bobKey(call)
        const named = (await (await send(call, key, { id: BOB, kind: "user" })).json()) as {
            turnId: string
        }
        const omitted = (await (await send(call, key)).json()) as { turnId: string }
        expect(await senderOf(runtime, named.turnId)).toBe(BOB)
        expect(await senderOf(runtime, omitted.turnId)).toBe(BOB)
    })

    test("over a WebSocket, which carries no from, the turn is attributed to the bound participant", async () => {
        const { runtime } = await harness({ token: TOKEN })
        const bridge = attachWebSocket(runtime, async () => ({ kind: "open" }))
        const socket = fakeSocket("assistant", false, {
            kind: "key",
            keyId: "k_bob",
            scope: { participant: BOB },
        })
        bridge.handlers.open(socket.ws)
        bridge.handlers.message(socket.ws, JSON.stringify({ type: "message", text: "hi" }))
        const accepted = socket.frames().find((frame) => frame.type === "ws.accepted") as
            | { turnId: string }
            | undefined
        expect(await senderOf(runtime, accepted?.turnId ?? "")).toBe(BOB)
        bridge.closeAll()
    })

    test("an unbound key still names any sender, so nothing that works today changes", async () => {
        const { call, runtime } = await harness({ token: TOKEN })
        const minted = (await (
            await call("POST", "/v1/keys", { body: { label: "backend" } })
        ).json()) as { secret: string }
        const response = await send(call, minted.secret, { id: "user:alice", kind: "user" })
        expect(response.status).toBe(202)
        const { turnId } = (await response.json()) as { turnId: string }
        expect(await senderOf(runtime, turnId)).toBe("user:alice")
    })

    test("an empty participant is refused at mint", async () => {
        const { call } = await harness({ token: TOKEN })
        const response = await call("POST", "/v1/keys", {
            body: { label: "bad", scope: { participant: "" } },
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe("key_scope_participant_invalid")
    })
})
