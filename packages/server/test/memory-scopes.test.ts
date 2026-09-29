/**
 * Team memory over the wire (Phase 29): who may write which shared scope, and who may read an audit.
 * What a turn recalls is core's `memory-scopes.test.ts`; this file holds the credentials.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { cleanupWorkspaces, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

const TOKEN = "t_operator"
type Harness = Awaited<ReturnType<typeof harness>>

async function keyFor(
    call: Harness["call"],
    scope: { participant?: string; can: string[] },
): Promise<string> {
    const response = await call("POST", "/v1/keys", { body: { label: "k", scope } })
    return ((await response.json()) as { secret: string }).secret
}

const codeOf = async (response: Response) =>
    ((await response.json()) as { error?: { code: string } }).error?.code

async function setup() {
    const h = await harness({ token: TOKEN })
    for (const [id, role] of [
        ["user:ada", "admin"],
        ["user:bob", "member"],
    ]) {
        expect((await h.call("POST", "/v1/participants", { body: { id, role } })).status).toBe(201)
    }
    return {
        ...h,
        ada: await keyFor(h.call, { participant: "user:ada", can: ["chat", "read", "admin"] }),
        bob: await keyFor(h.call, { participant: "user:bob", can: ["chat", "read"] }),
        backendChat: await keyFor(h.call, { can: ["chat", "read"] }),
    }
}

describe("shared memory scopes, by credential", () => {
    test("a member writes and reads their own owner scope, and nobody else's", async () => {
        const { call, bob, ada } = await setup()
        const own = await call("POST", "/v1/memory/notes", {
            token: bob,
            body: { scope: "owner:user:bob", text: "Bob prefers async updates" },
        })
        expect(own.status).toBe(201)
        expect(((await own.json()) as { writtenBy: string }).writtenBy).toBe("user:bob")

        // Not even an admin writes, or lists, another member's owner scope.
        const byAdmin = await call("POST", "/v1/memory/notes", {
            token: ada,
            body: { scope: "owner:user:bob", text: "overwritten" },
        })
        expect(byAdmin.status).toBe(403)
        expect(await codeOf(byAdmin)).toBe("memory_scope_forbidden")
        const listed = await call("GET", "/v1/memory/notes?scope=owner:user:bob", { token: ada })
        expect(listed.status).toBe(403)
        const mine = await call("GET", "/v1/memory/notes?scope=owner:user:bob", { token: bob })
        expect(((await mine.json()) as { notes: unknown[] }).notes.length).toBe(1)
    })

    test("the space takes an admin or the designated writer; a chat-only backend key is not an admin", async () => {
        const { call, bob, ada, backendChat } = await setup()
        const note = { scope: "space", text: "The launch is on Friday" }
        const asMember = await call("POST", "/v1/memory/notes", { token: bob, body: note })
        expect(asMember.status).toBe(403)
        const asBackend = await call("POST", "/v1/memory/notes", { token: backendChat, body: note })
        expect(asBackend.status).toBe(403)
        expect(await codeOf(asBackend)).toBe("memory_write_requires_admin")
        expect((await call("POST", "/v1/memory/notes", { token: ada, body: note })).status).toBe(
            201,
        )
        expect((await call("POST", "/v1/memory/notes", { body: note })).status).toBe(201)

        const named = await call("PUT", "/v1/memory/space/writer", {
            token: bob,
            body: { writer: "user:bob" },
        })
        expect(named.status).toBe(403)
        expect(
            (
                await call("PUT", "/v1/memory/space/writer", {
                    token: ada,
                    body: { writer: "user:bob" },
                })
            ).status,
        ).toBe(200)
        expect((await call("POST", "/v1/memory/notes", { token: bob, body: note })).status).toBe(
            201,
        )
    })

    test("a project is an admin's to define, and its scope needs it to exist", async () => {
        const { call, ada, bob } = await setup()
        const missing = await call("POST", "/v1/memory/notes", {
            body: { scope: "project:apollo", text: "x" },
        })
        expect(missing.status).toBe(404)
        expect(await codeOf(missing)).toBe("project_not_found")
        const byMember = await call("PUT", "/v1/projects/apollo", {
            token: bob,
            body: { agents: ["assistant"] },
        })
        expect(byMember.status).toBe(403)
        const defined = await call("PUT", "/v1/projects/apollo", {
            token: ada,
            body: { name: "Apollo", agents: ["assistant"] },
        })
        expect(await defined.json()).toMatchObject({ id: "apollo", agents: ["assistant"] })
        const ghost = await call("PUT", "/v1/projects/apollo", { body: { agents: ["ghost"] } })
        expect(ghost.status).toBe(404)
    })

    test("a person's audit is theirs or an admin's", async () => {
        const { call, ada, bob } = await setup()
        expect(
            (await call("GET", "/v1/participants/user:bob/memory/reads", { token: bob })).status,
        ).toBe(200)
        expect(
            (await call("GET", "/v1/participants/user:bob/memory/reads", { token: ada })).status,
        ).toBe(200)
        const other = await call("GET", "/v1/participants/user:ada/memory/reads", { token: bob })
        expect(other.status).toBe(403)
        expect(await codeOf(other)).toBe("memory_scope_forbidden")
    })
})
