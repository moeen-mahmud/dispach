/**
 * An agent bundle over the wire (doc 16 R11): who may move one, and its own size cap. The merge itself
 * is core's `bundle.test.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { cleanupWorkspaces, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

const codeOf = async (response: Response) =>
    ((await response.json()) as { error?: { code: string; field?: string } }).error

describe("export and import", () => {
    test("export is a JSON bundle; a path outside the allowlist is refused by name", async () => {
        const { call } = await harness({ token: "t" })
        const bundle = (await (await call("GET", "/v1/agents/assistant/export")).json()) as {
            version: number
            agentId: string
            files: unknown[]
        }
        expect(bundle.version).toBe(1)
        expect(bundle.agentId).toBe("assistant")
        expect(Array.isArray(bundle.files)).toBe(true)
        const wrong = await call("GET", "/v1/agents/assistant/export?paths=MEMORY.md,skills/")
        expect(wrong.status).toBe(400)
        expect(await codeOf(wrong)).toMatchObject({
            code: "bundle_path_not_allowed",
            field: "paths.1",
        })
    })

    test("a member-bound key may not move an agent's memory", async () => {
        const { call } = await harness({ token: "t" })
        await call("POST", "/v1/participants", { body: { id: "user:bob", role: "member" } })
        const key = (await (
            await call("POST", "/v1/keys", {
                body: {
                    label: "bob",
                    scope: { participant: "user:bob", can: ["chat", "read", "admin"] },
                },
            })
        ).json()) as { secret: string }
        const out = await call("GET", "/v1/agents/assistant/export", { token: key.secret })
        expect(out.status).toBe(403)
    })

    test("a bundle past the shared 1 MB cap is read, and one past its own 25 MB is not", async () => {
        const { call } = await harness({ token: "t" })
        const big = (bytes: number) => ({
            bundle: {
                version: 1,
                agentId: "x",
                exportedAt: "",
                files: [{ path: "agent.yaml", content: "x".repeat(bytes) }],
            },
        })
        // Read, and refused for what it says rather than for its size.
        const two = await call("POST", "/v1/agents/assistant/import", { body: big(2_000_000) })
        expect(await codeOf(two)).toMatchObject({ code: "bundle_path_not_allowed" })
        const huge = await call("POST", "/v1/agents/assistant/import", { body: big(26_000_000) })
        expect(await codeOf(huge)).toMatchObject({ code: "body_too_large" })
    })
})
