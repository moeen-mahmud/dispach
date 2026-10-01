/**
 * `DELETE /v1/agents/:id` (pilot.4): named twice, refused by the remover's rules, and in `remove`'s
 * order — the agent goes, then its rows, and its directory last.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, Runtime } from "@dispach/core"
import { type AgentRemover, createHandler } from "../src/handler.ts"

async function setup(remover: AgentRemover) {
    const dir = mkdtempSync(join(tmpdir(), "remove-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}\nid: doomed\nmodel:\n  main:\n    id: test-model\n    baseUrl: https://example.invalid/v1\n    apiKeyEnv: MODEL_API_KEY\n`,
    )
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "k" },
        store: ":memory:",
    })
    const handler = createHandler({ runtime, allowUnauthenticated: true, remover })
    const del = (query: string) =>
        handler(new Request(`http://127.0.0.1:7420/v1/agents/doomed${query}`, { method: "DELETE" }))
    return { runtime, del, dir }
}

describe("deleting an agent", () => {
    test("needs ?confirm, then goes in order: off the host, rows, directory last", async () => {
        const order: string[] = []
        let runtime: Runtime | undefined
        const remover: AgentRemover = {
            locate: () => ({ ok: true, dir: "/sandbox/agents/doomed" }),
            deleteDir: async (dir) => {
                // By now the agent is gone from the host.
                order.push(`hosted=${runtime?.list().length}`, `delete ${dir}`)
            },
        }
        const setupResult = await setup(remover)
        runtime = setupResult.runtime

        const unconfirmed = await setupResult.del("")
        expect(unconfirmed.status).toBe(400)
        expect(order).toEqual([])
        expect(runtime.list().length).toBe(1)

        const done = await setupResult.del("?confirm=doomed")
        expect(done.status).toBe(200)
        expect(((await done.json()) as { removed: boolean }).removed).toBe(true)
        expect(order).toEqual(["hosted=0", "delete /sandbox/agents/doomed"])
        await runtime.stop()
    })

    test("a refusal from the remover deletes nothing and leaves the agent serving", async () => {
        const deleted: string[] = []
        const { runtime, del } = await setup({
            locate: () => ({
                ok: false,
                status: 409,
                error: { code: "agent_remove_shared_id", message: "two", hint: "rename one" },
            }),
            deleteDir: async (dir) => {
                deleted.push(dir)
            },
        })
        const refused = await del("?confirm=doomed")
        expect(refused.status).toBe(409)
        expect(deleted).toEqual([])
        expect(runtime.list().map((agent) => agent.id)).toEqual(["doomed"])
        await runtime.stop()
    })
})
