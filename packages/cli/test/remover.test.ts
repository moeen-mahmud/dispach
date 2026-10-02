/** `DELETE /v1/agents/:id`'s CLI half: sandbox agents only, never a shared id (pilot.4). */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@dispach/core"
import { sandboxRemover } from "#serve"

const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sandbox(agents: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "remover-"))
    roots.push(root)
    for (const [dir, id] of Object.entries(agents)) {
        mkdirSync(join(root, "agents", dir), { recursive: true })
        writeFileSync(
            join(root, "agents", dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}\nid: ${id}\nmodel:\n  main:\n    id: m\n    baseUrl: https://example.invalid/v1\n`,
        )
    }
    return { root, env: { [`${BRAND.envPrefix}HOME`]: root } }
}

describe("the sandbox remover", () => {
    test("locates a sandbox agent and deletes only its directory", async () => {
        const { root, env } = sandbox({ ada: "ada", bob: "bob" })
        const remover = sandboxRemover(env)
        const found = remover.locate("ada")
        expect(found.ok).toBe(true)
        if (!found.ok) return
        await remover.deleteDir(found.dir)
        expect(existsSync(join(root, "agents", "ada"))).toBe(false)
        expect(existsSync(join(root, "agents", "bob"))).toBe(true)
    })

    test("refuses an id two directories share, and anything outside the sandbox", async () => {
        const { env } = sandbox({ one: "same", two: "same" })
        const remover = sandboxRemover(env)
        const shared = remover.locate("same")
        expect(shared.ok === false && shared.error.code).toBe("agent_remove_shared_id")
        expect(remover.locate("nobody").ok).toBe(false)
        const outside = mkdtempSync(join(tmpdir(), "outside-"))
        roots.push(outside)
        await expect(remover.deleteDir(outside)).rejects.toThrow(/outside the sandbox/)
        expect(existsSync(outside)).toBe(true)
    })
})
