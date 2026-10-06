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

    test("?include=env,git adds what a restore needs, and says where each agent lived (pilot.10)", async () => {
        const { call, runtime } = await harness({
            files: { ".env": "TELEGRAM_TOKEN=t\n", "MEMORY.md": "- m\n" },
        })
        const { mkdirSync, writeFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const dir = runtime.agent("assistant")?.dir ?? ""
        mkdirSync(join(dir, "drive", ".git"), { recursive: true })
        writeFileSync(join(dir, "drive", ".git", "HEAD"), "ref: refs/heads/main\n")
        mkdirSync(join(dir, "node_modules"), { recursive: true })
        writeFileSync(join(dir, "node_modules", "x.js"), "x")

        const read = async (path: string) =>
            untar(gunzipSync(new Uint8Array(await (await call("GET", path)).arrayBuffer())))
        const plain = await read("/v1/backup")
        expect(plain.has("agents/assistant/.env")).toBe(false)
        expect(plain.has("agents/assistant/drive/.git/HEAD")).toBe(false)

        const full = await read("/v1/backup?include=env,git")
        expect(full.get("agents/assistant/.env")).toBe("TELEGRAM_TOKEN=t\n")
        expect(full.get("agents/assistant/drive/.git/HEAD")).toBe("ref: refs/heads/main\n")
        expect(full.has("agents/assistant/node_modules/x.js")).toBe(false)
        const manifest = JSON.parse(full.get("backup.json") ?? "{}") as {
            agents: { id: string; dir: string }[]
            included: string[]
        }
        expect(manifest.agents[0]?.dir).toBe(dir)
        expect(manifest.included).toEqual(["env", "git"])

        const refused = await call("GET", "/v1/backup?include=env,toString")
        expect(refused.status).toBe(400)
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
            "backup_include_invalid",
        )
        await runtime.stop()
    })

    test("?include=home adds the rest of the state directory, never the live store, logs or clone cache (pilot.11)", async () => {
        const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
        const { tmpdir } = await import("node:os")
        const { dirname, join } = await import("node:path")
        const home = mkdtempSync(join(tmpdir(), "backup-home-"))
        const put = (path: string, text: string) => {
            mkdirSync(dirname(join(home, path)), { recursive: true })
            writeFileSync(join(home, path), text)
        }
        put("drive/notes/plan.md", "the plan")
        put("drive.git/HEAD", "ref: refs/heads/main\n")
        put("drive.git/info/exclude", "*.tmp\n")
        put("templates/crew/template.yaml", "name: crew\n")
        put("agents/stopped/agent.yaml", "id: stopped\n")
        put("agents/stopped/.env", "K=v\n")
        put("agents/.api-token", "dispach_secret\n")
        put("store.db", "live")
        put("store.db-wal", "live")
        put("logs/server/out.log", "log")
        put("sources/anthropic/SKILL.md", "clone")
        const { call, runtime } = await harness({ home })
        const read = async (path: string) =>
            untar(gunzipSync(new Uint8Array(await (await call("GET", path)).arrayBuffer())))

        const files = await read("/v1/backup?include=home,git")
        expect(files.get("home/drive/notes/plan.md")).toBe("the plan")
        expect(files.get("home/drive.git/HEAD")).toBe("ref: refs/heads/main\n")
        expect(files.get("home/drive.git/info/exclude")).toBe("*.tmp\n")
        expect(files.get("home/templates/crew/template.yaml")).toBe("name: crew\n")
        expect(files.get("home/agents/stopped/agent.yaml")).toBe("id: stopped\n")
        // Secrets follow `env`, here as in an agent directory.
        expect(files.has("home/agents/stopped/.env")).toBe(false)
        expect(files.has("home/agents/.api-token")).toBe(false)
        // The store is the snapshot at the root, never the live file; logs and clones are rebuilt.
        expect(
            [...files.keys()].filter((name) => /^home\/(store\.db|logs|sources)/.test(name)),
        ).toEqual([])
        expect(files.get("store.db")?.startsWith("SQLite format 3")).toBe(true)
        expect(JSON.parse(files.get("backup.json") ?? "{}").home).toEqual({ dir: home, files: 5 })

        const withEnv = await read("/v1/backup?include=home,env")
        expect(withEnv.get("home/agents/.api-token")).toBe("dispach_secret\n")
        expect(withEnv.get("home/agents/stopped/.env")).toBe("K=v\n")
        await runtime.stop()

        const bare = await harness()
        const refused = await bare.call("GET", "/v1/backup?include=home")
        expect(refused.status).toBe(400)
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
            "backup_home_unavailable",
        )
        await bare.runtime.stop()
    })
})
