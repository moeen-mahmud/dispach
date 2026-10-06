/**
 * `GET /v1/backup` (pilot.9): a consistent store snapshot and every hosted agent's files, as a tar.gz
 * a stock `tar` reads; `.env` left out; refused to a key that reaches only some agents.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { cleanupWorkspaces, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

/** Names and contents out of a tar, PAX path records honoured. */
function untar(archive: Uint8Array): Map<string, string> {
    const files = new Map<string, string>()
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0.*$/s, "")
    let offset = 0
    let longName: string | undefined
    while (offset + 512 <= archive.length) {
        const head = archive.subarray(offset, offset + 512)
        if (head.every((byte) => byte === 0)) break
        const name = decode(head.subarray(0, 100))
        const size = Number.parseInt(decode(head.subarray(124, 136)).trim(), 8)
        const type = String.fromCharCode(head[156] ?? 0)
        const body = archive.subarray(offset + 512, offset + 512 + size)
        if (type === "x") {
            longName = /\d+ path=(.*)\n/.exec(new TextDecoder().decode(body))?.[1]
        } else {
            files.set(longName ?? name, new TextDecoder().decode(body))
            longName = undefined
        }
        offset += 512 + Math.ceil(size / 512) * 512
    }
    return files
}

describe("backup", () => {
    test("holds the store, the agent's files and a manifest, never its .env", async () => {
        const deep = `${"nested/".repeat(20)}note.md`
        const { call, runtime } = await harness({
            files: { "MEMORY.md": "- remember this\n", ".env": "MODEL_API_KEY=secret\n" },
        })
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const { dirname, join } = await import("node:path")
        const dir = runtime.agent("assistant")?.dir ?? ""
        mkdirSync(dirname(join(dir, deep)), { recursive: true })
        writeFileSync(join(dir, deep), "deep")

        const response = await call("GET", "/v1/backup")
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe("application/gzip")
        const files = untar(gunzipSync(new Uint8Array(await response.arrayBuffer())))
        expect(files.get("store.db")?.startsWith("SQLite format 3")).toBe(true)
        expect(files.get("agents/assistant/MEMORY.md")).toBe("- remember this\n")
        expect(files.get(`agents/assistant/${deep}`)).toBe("deep")
        expect(files.has("agents/assistant/.env")).toBe(false)
        expect(JSON.parse(files.get("backup.json") ?? "{}")).toMatchObject({
            agents: [{ id: "assistant" }],
        })
        await runtime.stop()
    })
})
