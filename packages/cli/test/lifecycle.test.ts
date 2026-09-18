/**
 * `stop <agent>` and `start <agent>` against a **real running host**, plus the bare `serve`.
 *
 * ## Why this spawns processes
 *
 * The whole mechanism is cross-process: a command writes a store row and posts to an address it
 * read off a lease, and the host on the other end disposes one agent while continuing to serve the
 * rest. Every part of that is invisible in-process. In particular the two failures worth guarding
 * are both about *other* agents — stopping one must not take its neighbour down, and must not take
 * the host down — and neither can be asserted without a host that is still answering afterwards.
 *
 * The sandbox is redirected with `<PREFIX>HOME`, which is how every test in this package avoids
 * touching a real `~/.dispach`, and `--store` points both sides at one database.
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

/** A sandbox root with these agents written into it, the way `init` would. */
function sandbox(ids: readonly string[]): { home: string; store: string } {
    const home = mkdtempSync(join(tmpdir(), "lifecycle-home-"))
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
    } as Record<string, string>
}

interface Host {
    readonly out: () => string
    readonly stop: () => void
}

/** Start `serve` with the given arguments and resolve once its banner has gone quiet. */
async function host(args: readonly string[], home: string, store: string): Promise<Host> {
    const child = spawn(
        process.execPath,
        [BINARY, "serve", ...args, "--port", "0", "--store", store],
        { env: env(home), stdio: ["ignore", "pipe", "pipe"] },
    )
    let out = ""
    await new Promise<void>((resolve, reject) => {
        const overall = setTimeout(() => reject(new Error(`no outcome:\n${out}`)), 25_000)
        let quiet: ReturnType<typeof setTimeout> | undefined
        const collect = (chunk: Buffer) => {
            out += chunk.toString()
            if (!out.includes("serving on")) return
            if (quiet !== undefined) clearTimeout(quiet)
            // Quiescence rather than the first match: `serving on` is the banner's first line and
            // the agent rows follow it, so resolving on the match reads a one-line transcript.
            quiet = setTimeout(() => {
                clearTimeout(overall)
                resolve()
            }, 500)
        }
        child.stdout.on("data", collect)
        child.stderr.on("data", collect)
        child.on("exit", () => {
            clearTimeout(overall)
            if (quiet !== undefined) clearTimeout(quiet)
            reject(new Error(`exited before serving:\n${out}`))
        })
    })
    return { out: () => out, stop: () => child.kill("SIGTERM") }
}

/** Run one command to completion and return its output. */
function run(args: readonly string[], home: string, store: string): { out: string; code: number } {
    const result = spawnSync(process.execPath, [BINARY, ...args, "--store", store], {
        env: env(home),
        encoding: "utf8",
    })
    return { out: `${result.stdout}${result.stderr}`, code: result.status ?? -1 }
}

describe("serve with no manifest hosts the sandbox", () => {
    test("every enabled agent, and the disabled one named with the way back", async () => {
        const { home, store } = sandbox(["alpha", "beta"])
        // Switched off before anything runs, so this is the boot path rather than a live drop.
        expect(run(["stop", "beta", "--reason", "quiet please"], home, store).code).toBe(0)

        const served = await host([], home, store)
        try {
            const out = served.out()
            expect(out).toContain("alpha —")
            // Not merely absent. An agent missing from the banner with no line explaining it is
            // the "I set this up and it is not running" failure the switch exists to make
            // explicable — the same lesson as the 57 MB log nobody opened.
            expect(out).toContain("beta — stopped (quiet please)")
            expect(out).toContain("start beta")
        } finally {
            served.stop()
        }
    }, 40_000)

    test("zero hosted agents is still a running server", async () => {
        const { home, store } = sandbox(["solo"])
        run(["stop", "solo"], home, store)

        // The always-on property: the API exists before there is anything to talk to, and a
        // container whose only agent somebody stopped must not become a crash loop.
        const served = await host([], home, store)
        try {
            expect(served.out()).toContain("serving on")
            expect(served.out()).toContain("solo — stopped")
        } finally {
            served.stop()
        }
    }, 40_000)

    test("a named manifest is subject to the switch too", async () => {
        const { home, store } = sandbox(["named"])
        run(["stop", "named"], home, store)

        const manifest = join(home, BRAND.stateDir, "agents", "named", "agent.yaml")
        const served = await host([manifest], home, store)
        try {
            // Naming the path is not a way round a durable stop. The launchd trap this is modelled
            // on is a job that installs cleanly and silently never starts, and the cure is not to
            // make the state easy to bypass — it is to say so where somebody is looking.
            expect(served.out()).toContain("named — stopped")
            expect(served.out()).not.toContain("named — no channels")
        } finally {
            served.stop()
        }
    }, 40_000)
})

describe("stop reaches into a running host", () => {
    test("one agent is dropped and the host keeps serving the others", async () => {
        const { home, store } = sandbox(["alpha", "beta"])
        const served = await host([], home, store)
        try {
            expect(served.out()).toContain("alpha —")
            expect(served.out()).toContain("beta —")

            const stopped = run(["stop", "beta"], home, store)
            expect(stopped.code).toBe(0)
            // The sentence that proves the mechanism: the host was *asked*, not signalled. Before
            // 16.3 this command killed the process, which would have taken alpha with it.
            expect(stopped.out).toContain("dropped it and kept serving")
            expect(stopped.out).toContain("start beta")

            // Still up, still serving alpha — which is only observable from outside the process.
            // Asserted through `stop --dry-run`, because it reports the *live host* it would ask:
            // an answer naming a pid and an address is a running server, and this one is still
            // holding alpha after beta was dropped out from under it.
            const alpha = run(["stop", "alpha", "--dry-run"], home, store)
            expect(alpha.out).toContain("which would drop it and keep serving")
        } finally {
            served.stop()
        }
    }, 40_000)

    test("start adopts it back into the same host", async () => {
        const { home, store } = sandbox(["alpha", "beta"])
        const served = await host([], home, store)
        try {
            run(["stop", "beta"], home, store)
            const started = run(["start", "beta"], home, store)
            expect(started.code).toBe(0)
            // Adopted, not queued for a restart. The host is the same process throughout, which is
            // the whole claim of the always-on model.
            expect(started.out).toContain("adopted by pid")
            expect(started.out).toContain("running")
        } finally {
            served.stop()
        }
    }, 40_000)

    test("with nothing running, the switch is still written", async () => {
        const { home, store } = sandbox(["lonely"])
        const stopped = run(["stop", "lonely"], home, store)
        expect(stopped.code).toBe(0)
        expect(stopped.out).toContain("nothing was running")
        // The command's promise is the durable state, and it holds with no host to ask.
        expect(stopped.out).toContain("switched off for the next start")

        const started = run(["start", "lonely"], home, store)
        expect(started.out).toContain("it will be hosted at the next start")
        expect(started.code).toBe(0)
    }, 30_000)

    test("--dry-run describes the host it would ask, and changes nothing", async () => {
        const { home, store } = sandbox(["dry"])
        const served = await host([], home, store)
        try {
            const dry = run(["stop", "dry", "--dry-run"], home, store)
            expect(dry.out).toContain("would stop 1 agent")
            expect(dry.out).toContain("which would drop it and keep serving")
            // A confirmation that describes something other than what happens is the failure
            // `remove-plan.ts` exists to prevent; here the check is simply that nothing moved.
            const after = run(["stop", "dry", "--dry-run"], home, store)
            expect(after.out).toContain("would drop it and keep serving")
        } finally {
            served.stop()
        }
    }, 40_000)

    test("bare stop takes the host down and writes no per-agent state", async () => {
        const { home, store } = sandbox(["alpha", "beta"])
        const served = await host([], home, store)
        try {
            const stopped = run(["stop"], home, store)
            expect(stopped.out).toContain("stopped")
        } finally {
            served.stop()
        }

        // The asymmetry that makes both commands safe: `daemon start` should bring back exactly
        // what was running, so a bare stop must not leave agents switched off behind it.
        const served2 = await host([], home, store)
        try {
            expect(served2.out()).toContain("alpha —")
            expect(served2.out()).toContain("beta —")
            expect(served2.out()).not.toContain("stopped")
        } finally {
            served2.stop()
        }
    }, 60_000)
})
