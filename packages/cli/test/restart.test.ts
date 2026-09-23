/**
 * `restart`, `agents` and `status` against a real host.
 *
 * The three new verbs are thin over the lease table and the host's HTTP surface, and a fake of
 * either would test the fake: `reload` disposes and re-creates an agent inside the process that
 * holds its lease, and whether that round trip works is the whole claim. So a real `serve` is
 * spawned from the built entry — the same shape `lifecycle.test.ts` uses — and the commands run
 * against it. Every spawn opts out of the bootstrap, or the first run would install a LaunchAgent
 * on the machine running the tests.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BRAND } from "@dispach/core"

const HERE = dirname(fileURLToPath(import.meta.url))
const BINARY = join(HERE, "..", "dist", "index.js")

const roots: string[] = []
afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop()
        if (root !== undefined) rmSync(root, { recursive: true, force: true })
    }
})

function sandbox(ids: readonly string[]): { home: string; store: string } {
    const home = mkdtempSync(join(tmpdir(), "restart-home-"))
    roots.push(home)
    for (const id of ids) {
        const dir = join(home, BRAND.stateDir, "agents", id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: ${id}
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
server:
  enabled: true
`,
            "utf8",
        )
    }
    return { home, store: join(home, BRAND.stateDir, "store.db") }
}

function env(home: string): Record<string, string> {
    return {
        ...process.env,
        MODEL_API_KEY: "test-key",
        [`${BRAND.envPrefix}HOME`]: join(home, BRAND.stateDir),
        // See lifecycle.test.ts: without this a spawn that wants a host installs a real service.
        [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
    } as Record<string, string>
}

async function host(home: string, store: string): Promise<{ out: () => string; stop: () => void }> {
    const child = spawn(process.execPath, [BINARY, "serve", "--port", "0", "--store", store], {
        env: env(home),
        stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    await new Promise<void>((resolve, reject) => {
        const overall = setTimeout(() => reject(new Error(`no outcome:\n${out}`)), 25_000)
        let quiet: ReturnType<typeof setTimeout> | undefined
        const collect = (chunk: Buffer) => {
            out += chunk.toString()
            if (!out.includes("serving on")) return
            if (quiet !== undefined) clearTimeout(quiet)
            quiet = setTimeout(() => {
                clearTimeout(overall)
                resolve()
            }, 500)
        }
        child.stdout.on("data", collect)
        child.stderr.on("data", collect)
        child.on("exit", () => {
            clearTimeout(overall)
            reject(new Error(`exited before serving:\n${out}`))
        })
    })
    return { out: () => out, stop: () => child.kill("SIGTERM") }
}

function run(args: readonly string[], home: string, store: string): { out: string; code: number } {
    const result = spawnSync(process.execPath, [BINARY, ...args, "--store", store], {
        env: env(home),
        encoding: "utf8",
    })
    return { out: `${result.stdout}${result.stderr}`, code: result.status ?? -1 }
}

describe("restart, agents and status against a live host", () => {
    test("bare `agents` lists the sandbox with who serves it, and `restart` reloads in place", async () => {
        const { home, store } = sandbox(["alpha", "beta"])
        // Before any host: both listed, neither hosted.
        const cold = run(["agents"], home, store)
        expect(cold.code).toBe(0)
        expect(cold.out).toContain("alpha")
        expect(cold.out).toContain("beta")
        expect(cold.out).toContain("not hosted")

        const served = await host(home, store)
        try {
            const warm = run(["agents", "--json"], home, store)
            expect(warm.code).toBe(0)
            const listed = JSON.parse(warm.out) as {
                agents: { ref: string; serving?: string; enabled: boolean }[]
            }
            const alpha = listed.agents.find((agent) => agent.ref === "alpha")
            expect(alpha?.enabled).toBe(true)
            expect(alpha?.serving).toContain("serving")

            const reloaded = run(["restart", "alpha", "--json"], home, store)
            expect(reloaded.code).toBe(0)
            const result = JSON.parse(reloaded.out) as { result: { kind: string } }
            expect(result.result.kind).toBe("reloaded")

            // Still hosted afterwards — a reload that dropped the agent would pass the line above.
            const after = run(["agents", "--json"], home, store)
            const again = (
                JSON.parse(after.out) as { agents: { ref: string; serving?: string }[] }
            ).agents.find((agent) => agent.ref === "alpha")
            expect(again?.serving).toContain("serving")

            const status = run(["status", "--json"], home, store)
            expect(status.code).toBe(0)
            const shown = JSON.parse(status.out) as { agents: { ref: string; serving?: string }[] }
            expect(shown.agents.map((agent) => agent.ref).sort()).toEqual(["alpha", "beta"])
        } finally {
            served.stop()
        }
    }, 60_000)

    test("`restart` with nothing running names what to start", () => {
        const { home, store } = sandbox(["alpha"])
        const result = run(["restart", "alpha"], home, store)
        expect(result.code).not.toBe(0)
        expect(result.out).toContain("cli_restart_nothing_running")
        expect(result.out).toContain(`${BRAND.slug} serve alpha`)
    })
})
