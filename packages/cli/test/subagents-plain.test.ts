/**
 * `run --plain` prints this conversation's events only (pilot.6).
 *
 * A subagent's turn shares the bus, and the plain path printed every event it heard, so a child's own
 * reply was written into the parent's. Spawns the built binary against a scripted model, because the
 * plain path's subscription is inside `runCommand` and nothing smaller reaches it.
 */

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BRAND } from "@dispach/core"

const BINARY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js")

const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The parent calls `now`, then replies; the child calls it, submits, then says something of its own. */
function model() {
    return Bun.serve({
        port: 0,
        async fetch(request) {
            const body = await request.text()
            const child = body.includes("submit_artifact")
            const step = (JSON.parse(body) as { messages: { role: string }[] }).messages.filter(
                (message) => message.role === "assistant",
            ).length
            const script = child
                ? [
                      "ACTION: now\nEND",
                      "ACTION: submit_artifact\nsummary: It is late.\nEND",
                      "CHILD-PROSE-LEAK",
                  ]
                : ["ACTION: now\nEND", "It is late, says the clock."]
            const content = script[step] ?? "Done."
            const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
            return new Response(`${frame}data: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            })
        },
    })
}

/** An agent whose `now` is routed to a subagent, in a home of its own. */
function agentHome(baseUrl: string): string {
    const home = mkdtempSync(join(tmpdir(), "subagents-plain-"))
    roots.push(home)
    const manifest = join(home, "agent.yaml")
    writeFileSync(
        manifest,
        `apiVersion: ${BRAND.apiVersion}
id: plain
model:
  main:
    id: test-model
    baseUrl: ${baseUrl}
    apiKeyEnv: MODEL_API_KEY
tools:
  pinned: [now]
subagents:
  - name: clock
    task: Tell the time.
    tools: [now]
    route:
      tools: [now]
`,
    )
    return home
}

/** One `run --plain` in that home, sharing its store with every other run there. */
async function runIn(home: string, args: readonly string[]): Promise<string> {
    const manifest = join(home, "agent.yaml")
    const child = spawn(
        process.execPath,
        [BINARY, "run", manifest, ...args, "--plain", "--store", join(home, "store.db")],
        {
            env: {
                ...process.env,
                MODEL_API_KEY: "test-key",
                [`${BRAND.envPrefix}HOME`]: join(home, BRAND.stateDir),
                [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    )
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
        out += chunk.toString()
    })
    await new Promise<void>((resolve) => child.on("exit", () => resolve()))
    return out
}

describe("run --plain with a subagent", () => {
    test("prints the parent's reply and none of the child's", async () => {
        const server = model()
        try {
            const home = agentHome(`http://127.0.0.1:${server.port}/v1`)
            const out = await runIn(home, ["--input", "what time is it?"])
            expect(out).toContain("It is late, says the clock.")
            expect(out).not.toContain("CHILD-PROSE-LEAK")
        } finally {
            server.stop(true)
        }
    }, 30_000)

    test("--continue runs, and resumes the conversation rather than its subagent's session", async () => {
        const server = model()
        try {
            const home = agentHome(`http://127.0.0.1:${server.port}/v1`)
            await runIn(home, ["--input", "what time is it?"])
            const again = await runIn(home, ["--continue", "--input", "and now?"])
            // It ran, rather than throwing before the runtime source existed (3f7fe85).
            expect(again).not.toContain("before initialization")
            // Both questions are in the one conversation; the subagent's session got neither.
            const db = new Database(join(home, "store.db"), { readonly: true })
            const rows = db
                .query("SELECT session_key AS key, content FROM messages WHERE role = 'user'")
                .all() as { key: string; content: string }[]
            db.close()
            const asked = rows.filter(
                (row) => row.content === "what time is it?" || row.content === "and now?",
            )
            expect(asked.map((row) => row.key.startsWith("local:"))).toEqual([true, true])
            expect(new Set(asked.map((row) => row.key)).size).toBe(1)
        } finally {
            server.stop(true)
        }
    }, 60_000)
})
