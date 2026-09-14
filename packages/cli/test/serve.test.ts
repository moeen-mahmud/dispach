/**
 * `serve` under a signal, against the built binary.
 *
 * The only test in this package that spawns a process, and it earns that cost: the bug it exists
 * to catch is invisible in-process. `installGuards()` owns SIGTERM and answers it with
 * `finishNow(EXIT_SIGTERM)`, which hard-exits; `serve` used to register a second SIGTERM listener
 * that started the graceful shutdown. Both fired and the hard exit won, so `runtime.stop()` never
 * completed — no outbox flush, no clean database close, and no `provider.stop()`, which is the
 * only thing that reaps the children `exec` backgrounds.
 *
 * Nothing caught it because ctrl-C sends SIGINT, which the guard deliberately ignores, so every
 * interactive stop took the correct path. SIGTERM is how a service manager stops and restarts a
 * process, which is to say: the path that was broken is the one a daemon uses every time.
 *
 * The assertion is the **runtime lease row**, not the exit code. A row released means
 * `runtime.stop()` ran to completion; a row left behind means the process died on the way. That is
 * a fact on disk rather than a hope about ordering, and it fails loudly if this regresses.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BRAND, SqliteStore } from "@dispach/core"

const HERE = dirname(fileURLToPath(import.meta.url))
const BINARY = join(HERE, "..", "dist", "index.js")

interface Served {
    readonly dir: string
    readonly store: string
    readonly stdout: string
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
}

function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "serve-test-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: served
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
    return dir
}

/** Start the binary, wait until it reports it is serving, then send `signal` and collect. */
async function serveThen(signal: NodeJS.Signals): Promise<Served> {
    const dir = workspace()
    const store = join(dir, "store.db")
    // Port 0 so a developer already running an agent on 7420 does not fail this, and so two of
    // these can run at once.
    const child = spawn(
        process.execPath,
        [BINARY, "serve", join(dir, "agent.yaml"), "--port", "0", "--store", store],
        { env: { ...process.env, MODEL_API_KEY: "test-key" }, stdio: ["ignore", "pipe", "pipe"] },
    )

    let stdout = ""
    const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`never started:\n${stdout}`)), 20_000)
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString()
            if (stdout.includes("serving on")) {
                clearTimeout(timer)
                resolve()
            }
        })
        child.on("exit", () => {
            clearTimeout(timer)
            reject(new Error(`exited before serving:\n${stdout}`))
        })
    })
    await ready

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on("exit", (code, sig) => resolve({ code, signal: sig })),
    )
    child.kill(signal)
    const { code, signal: sig } = await exited
    return { dir, store, stdout, code, signal: sig }
}

describe("serve shuts down gracefully", () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        test(`${signal} runs the full shutdown and releases the lease`, async () => {
            const served = await serveThen(signal)
            try {
                // Zero, not 143. A requested stop is not a fault, and the generated service
                // definition restarts only on a crash — a non-zero exit here would be read as
                // "this configuration is broken, stay down".
                expect(served.code).toBe(0)
                expect(served.signal).toBe(null)
                expect(served.stdout).toContain("stopping")

                // The proof. `Runtime.stop` releases the lease as its last act before closing the
                // database; a row still here means the process was killed mid-shutdown.
                const store = await SqliteStore.open({ path: served.store })
                expect(await store.leases.get("served")).toBeUndefined()
                await store.close()
            } finally {
                rmSync(served.dir, { recursive: true, force: true })
            }
        }, 40_000)
    }

    test("a second serve on the same agent refuses instead of polling twice", async () => {
        const dir = workspace()
        const store = join(dir, "store.db")
        const args = [BINARY, "serve", join(dir, "agent.yaml"), "--port", "0", "--store", store]
        const env = { ...process.env, MODEL_API_KEY: "test-key" }

        const first = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
        try {
            let out = ""
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`never started:\n${out}`)), 20_000)
                first.stdout.on("data", (chunk: Buffer) => {
                    out += chunk.toString()
                    if (out.includes("serving on")) {
                        clearTimeout(timer)
                        resolve()
                    }
                })
            })

            const second = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
            let err = ""
            second.stderr.on("data", (chunk: Buffer) => {
                err += chunk.toString()
            })
            const code = await new Promise<number | null>((resolve) => second.on("exit", resolve))

            expect(code).not.toBe(0)
            expect(err).toContain("already being served")
            // The refusal has to name the process, or the person cannot act on it.
            expect(err).toContain(String(first.pid))
        } finally {
            first.kill("SIGTERM")
            await new Promise((resolve) => first.on("exit", resolve))
            rmSync(dir, { recursive: true, force: true })
        }
    }, 60_000)
})

describe("the signal handlers are registered before the socket binds", () => {
    /**
     * A structural assertion, because the timing one could not fail.
     *
     * The bug: `claimSignals()` and `waitForSignal()` sat *after* the banner, so between
     * "serving on …" reaching stdout and the handlers existing there was a window with no handler
     * at all — and in it SIGINT takes its default action and kills the process outright. Exit code
     * `null`, no outbox flush, no lease release, none of the backgrounded `exec` children reaped.
     * CI caught it on a loaded two-core runner as `Expected: 0, Received: null`; an orchestrator
     * restarting a container promptly sends its signal into exactly that gap.
     *
     * The obvious test — signal immediately and assert a clean exit — **passes with the fix
     * reverted** on any machine fast enough to close the window first, which is every development
     * machine and not the CI runner. A guard that cannot fail is worse than no guard, so the
     * ordering is asserted where it is actually decided: in the source.
     *
     * The window is narrowed rather than eliminated, and that is worth stating. Anything before
     * `Runtime.create` returns is still unprotected; what this pins is that nothing *else* gets
     * inserted between the handlers and the bind.
     */
    const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "serve.ts"), "utf8")

    test("claimSignals and waitForSignal both precede the serve() call", () => {
        const claim = SOURCE.indexOf("claimSignals()")
        const register = SOURCE.indexOf("waitForSignal()")
        const bind = SOURCE.indexOf("running = await serve({")

        expect(claim).toBeGreaterThan(-1)
        expect(register).toBeGreaterThan(-1)
        expect(bind).toBeGreaterThan(-1)
        expect({ claimBeforeBind: claim < bind, registerBeforeBind: register < bind }).toEqual({
            claimBeforeBind: true,
            registerBeforeBind: true,
        })
    })

    test("the promise is awaited later, not created at the await", () => {
        // Creating it at the `await` is the bug in a different spelling: the handlers would be
        // registered at that moment rather than early. The hoisted form has to be a named promise.
        expect(SOURCE).toContain("const stopRequested = waitForSignal()")
        expect(SOURCE).toContain("await stopRequested")
    })
})
