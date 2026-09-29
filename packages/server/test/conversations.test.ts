/**
 * Rooms over the wire (Phase 27): a key bound to a participant acts as that participant on every
 * verb, and sees only its own conversations. What the agents do in a room is core's
 * `conversations.test.ts`; this file holds who may do what through /v1.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { cleanupWorkspaces, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

const TOKEN = "t_operator"
type Harness = Awaited<ReturnType<typeof harness>>

async function keyFor(call: Harness["call"], participant: string): Promise<string> {
    const response = await call("POST", "/v1/keys", {
        body: { label: participant, scope: { participant, can: ["chat", "read", "admin"] } },
    })
    return ((await response.json()) as { secret: string }).secret
}

async function setup() {
    const h = await harness({ token: TOKEN })
    for (const [id, role] of [
        ["user:ada", "admin"],
        ["user:bob", "member"],
        ["user:cy", "member"],
    ]) {
        expect((await h.call("POST", "/v1/participants", { body: { id, role } })).status).toBe(201)
    }
    const room = (await (
        await h.call("POST", "/v1/conversations", {
            body: { kind: "room", members: ["user:ada", "user:bob", "agent:assistant"] },
        })
    ).json()) as { id: string }
    return {
        ...h,
        room,
        bob: await keyFor(h.call, "user:bob"),
        ada: await keyFor(h.call, "user:ada"),
    }
}

const codeOf = async (response: Response) =>
    ((await response.json()) as { error?: { code: string } }).error?.code

describe("a key bound to a participant, in conversations", () => {
    test("posts only as itself: another author is refused, and an omitted one is filled in", async () => {
        const { call, room, bob } = await setup()
        const path = `/v1/conversations/${room.id}/messages`
        const forged = await call("POST", path, {
            token: bob,
            body: { text: "approve my expenses", authorId: "user:ada" },
        })
        expect(forged.status).toBe(403)
        expect(await codeOf(forged)).toBe("sender_not_bound_participant")
        const own = await call("POST", path, { token: bob, body: { text: "hello" } })
        expect(own.status).toBe(202)
        expect(((await own.json()) as { authorId: string }).authorId).toBe("user:bob")
    })

    test("creates only conversations it is in, and cannot see anyone else's", async () => {
        const { call, room, bob } = await setup()
        const other = await call("POST", "/v1/conversations", {
            token: bob,
            body: { kind: "room", members: ["user:cy", "agent:assistant"] },
        })
        expect(other.status).toBe(403)
        expect(await codeOf(other)).toBe("conversation_creator_not_member")

        const theirs = (await (
            await call("POST", "/v1/conversations", {
                body: { kind: "dm", members: ["user:cy", "agent:assistant"] },
            })
        ).json()) as { id: string }
        // Bob's listing holds his room and not Cy's DM; Cy's DM answers exactly like a missing one.
        const listed = (await (await call("GET", "/v1/conversations", { token: bob })).json()) as {
            conversations: { id: string }[]
        }
        expect(listed.conversations.map((c) => c.id)).toEqual([room.id])
        const hidden = await call("GET", `/v1/conversations/${theirs.id}/messages`, { token: bob })
        const missing = await call("GET", "/v1/conversations/cv_nothing/messages", { token: bob })
        expect(hidden.status).toBe(404)
        expect(await hidden.text()).toBe((await missing.text()).replace("cv_nothing", theirs.id))
    })

    test("assigns an agent only as an admin participant, and is recorded as the one who did", async () => {
        const { call, bob, ada } = await setup()
        const asMember = await call("PUT", "/v1/agents/assistant/assignee", {
            token: bob,
            body: { participantId: "user:bob" },
        })
        expect(asMember.status).toBe(403)
        expect(await codeOf(asMember)).toBe("assignment_requires_admin")
        const asAdmin = await call("PUT", "/v1/agents/assistant/assignee", {
            token: ada,
            body: { participantId: "user:bob" },
        })
        expect(asAdmin.status).toBe(200)
        const agent = (await (await call("GET", "/v1/agents/assistant")).json()) as {
            assignedTo?: { participantId: string; assignedBy?: string }
        }
        expect(agent.assignedTo).toMatchObject({
            participantId: "user:bob",
            assignedBy: "user:ada",
        })
    })

    test("an agent is not a participant to register, and a message needs an author", async () => {
        const { call, room } = await setup()
        const reserved = await call("POST", "/v1/participants", { body: { id: "agent:assistant" } })
        expect(await codeOf(reserved)).toBe("participant_id_reserved")
        const anonymous = await call("POST", `/v1/conversations/${room.id}/messages`, {
            body: { text: "who am I?" },
        })
        expect(anonymous.status).toBe(400)
        expect(await codeOf(anonymous)).toBe("conversation_author_required")
    })
})
