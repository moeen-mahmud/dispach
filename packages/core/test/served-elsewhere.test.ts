/**
 * Slot 2's third state, through a whole turn, with two runtimes on one store.
 *
 * ## The failure
 *
 * Asked to schedule a message, a real agent answered — accurately, and uselessly — that its channel
 * "isn't running in this session" and that "channels only start when I'm served". A `serve` was
 * running in the next terminal at that moment, holding this agent's lease, polling Telegram and
 * arming its schedules. Every sentence slot 2 had given it was true of the process rendering them.
 *
 * ## Why it needs two runtimes and a request body
 *
 * `renderConfigSummary` is unit-tested in `context.test.ts`, and it was never the broken part. What
 * was missing is a *wire*: `claimLeases` computes `declined` — the leases another live process is
 * holding — and until this landed nothing anywhere read it. So the guard has to be at the far end of
 * that wire: a second runtime on the same store, and the prompt the model was actually sent. The
 * same discipline `skills-turn.test.ts` records, for the same class of defect.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }
const dirs: string[] = []

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "served-elsewhere-"))
    dirs.push(dir)
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
name: Test Agent
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
schedules:
  - id: brief
    kind: cron
    expr: "0 8 * * *"
    timezone: UTC
    task: "Summarise the day ahead."
    deliver: none
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    return join(dir, "agent.yaml")
}

function recorder(): { fetch: FetchLike; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = []
    const fetch: FetchLike = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder()
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." } }] })}\n\n`,
                    ),
                )
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                controller.close()
            },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }
    return { fetch, bodies }
}

function prompt(body: Record<string, unknown> | undefined): string {
    const messages = body?.messages
    if (!Array.isArray(messages)) return ""
    return messages
        .map((message) => String((message as { content?: unknown }).content ?? ""))
        .join("\n---\n")
}

describe("an agent already served by another process is told so", () => {
    test("the second runtime's prompt says another process holds it", async () => {
        const path = manifest()
        const store = join(mkdtempSync(join(tmpdir(), "served-store-")), "store.db")

        // First: the `serve`-shaped one. `startSchedules` is what makes it exclusive in spirit, and
        // taking the lease is what makes it visible to anyone else on this store.
        const holder = await Runtime.create({ agents: [path], env: ENV, store, mode: "daemon" })

        // Second: the REPL. It declines the lease and carries on, which is correct and is exactly
        // the moment it used to start describing the world as though nothing else existed.
        const { fetch, bodies } = recorder()
        const repl = await Runtime.create({ agents: [path], env: ENV, store, fetch })
        const agent = repl.list()[0]
        expect(agent).toBeDefined()
        if (agent === undefined) return
        await agent.send("hello")

        const text = prompt(bodies[0])
        expect(text).toContain("armed in another process serving me")
        // And it must not also carry the sentence that sends someone to start what is running.
        expect(text).not.toContain("only `serve` starts the scheduler")

        await repl.stop("test done")
        await holder.stop("test done")
    })

    test("with nobody else on the store it still says what it used to", async () => {
        // The other half, and the one that makes the first a guard rather than a rewrite: alone, the
        // old sentence is the correct one and must survive.
        const path = manifest()
        const store = join(mkdtempSync(join(tmpdir(), "served-store-")), "store.db")
        const { fetch, bodies } = recorder()
        const solo = await Runtime.create({ agents: [path], env: ENV, store, fetch })
        const agent = solo.list()[0]
        expect(agent).toBeDefined()
        if (agent === undefined) return
        await agent.send("hello")

        const text = prompt(bodies[0])
        expect(text).toContain("only `serve` starts the scheduler")
        expect(text).not.toContain("another process serving me")
        await solo.stop("test done")
    })
})
