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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
        {
            env: {
                ...process.env,
                MODEL_API_KEY: "test-key",
                [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
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

/** A workspace with a chosen agent id, and optionally a port the manifest insists on. */
function agentDir(id: string, port?: number): string {
    const dir = mkdtempSync(join(tmpdir(), `serve-${id}-`))
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
${port === undefined ? "" : `  port: ${port}\n`}`,
        "utf8",
    )
    return dir
}

/**
 * Run `serve` with these manifests and return what it printed, whether it stayed up or refused.
 *
 * Resolves on the serving banner *or* on exit, because both are outcomes these tests assert —
 * waiting only for "serving on" would turn an expected refusal into a 20-second timeout with a
 * misleading message.
 */
async function serveAll(
    manifests: readonly string[],
    options: { readonly port?: "auto" | "none" } = {},
): Promise<{ readonly out: string; readonly exited: boolean }> {
    const store = join(mkdtempSync(join(tmpdir(), "serve-store-")), "store.db")
    // `--port 0` by default, so a developer already running an agent on 7420 does not fail these
    // and two can run at once. **`"none"` is not a detail**: the flag *settles* a bind
    // disagreement, so a test of the refusal that passed one could never fail. Safe here because
    // the refusal happens before anything binds, so the manifest's real port is never reached.
    const portArgs = options.port === "none" ? [] : ["--port", "0"]
    const child = spawn(
        process.execPath,
        [BINARY, "serve", ...manifests, ...portArgs, "--store", store],
        {
            env: {
                ...process.env,
                MODEL_API_KEY: "test-key",
                [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    )
    let out = ""
    /**
     * Resolve when the output goes **quiet**, not on the first matching chunk.
     *
     * `serving on` is the banner's *first* line and the agent rows follow it, so resolving on the
     * match left every assertion reading a one-line transcript — which failed in a way that looked
     * like the feature was broken rather than the harness. Quiescence also covers the refusal path
     * without a second code path: an error is written and the process exits.
     */
    const settled = await new Promise<boolean>((resolve, reject) => {
        const overall = setTimeout(() => reject(new Error(`no outcome:\n${out}`)), 25_000)
        let quiet: ReturnType<typeof setTimeout> | undefined
        const done = (exited: boolean) => {
            clearTimeout(overall)
            if (quiet !== undefined) clearTimeout(quiet)
            resolve(exited)
        }
        const collect = (chunk: Buffer) => {
            out += chunk.toString()
            if (!out.includes("serving on")) return
            if (quiet !== undefined) clearTimeout(quiet)
            quiet = setTimeout(() => done(false), 400)
        }
        child.stdout.on("data", collect)
        child.stderr.on("data", collect)
        child.on("exit", () => done(true))
    })
    if (!settled) child.kill("SIGTERM")
    return { out, exited: settled }
}

/**
 * Several agents in one process, which decision 8.5 has described since the beginning and which
 * one line in the CLI prevented: `agents: [options.manifestPath]`.
 */
describe("one process, several agents", () => {
    test("every manifest's agent is served and named", async () => {
        const { out } = await serveAll([
            join(agentDir("alpha"), "agent.yaml"),
            join(agentDir("beta"), "agent.yaml"),
        ])
        expect(out).toContain("alpha —")
        expect(out).toContain("beta —")
    }, 30_000)

    test("**a partial conflict serves what it can and names what it cannot**", async () => {
        // The behaviour this stage exists for. `claimLeases` threw on the *first* conflict, so a
        // host asked for two agents with one held elsewhere refused both — one stale-looking row
        // taking a healthy agent down with it. The store is shared here, which is what makes the
        // lease contended: the first process keeps `held`, the second must serve `free` anyway.
        const held = join(agentDir("held"), "agent.yaml")
        const free = join(agentDir("free"), "agent.yaml")
        const store = join(mkdtempSync(join(tmpdir(), "serve-shared-")), "store.db")

        const first = spawn(
            process.execPath,
            [BINARY, "serve", held, "--port", "0", "--store", store],
            {
                env: {
                    ...process.env,
                    MODEL_API_KEY: "test-key",
                    [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        )
        let firstOut = ""
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`first never served:\n${firstOut}`)),
                20_000,
            )
            first.stdout.on("data", (chunk: Buffer) => {
                firstOut += chunk.toString()
                if (firstOut.includes("serving on")) {
                    clearTimeout(timer)
                    resolve()
                }
            })
        })

        try {
            const second = spawn(
                process.execPath,
                [BINARY, "serve", held, free, "--port", "0", "--store", store],
                {
                    env: {
                        ...process.env,
                        MODEL_API_KEY: "test-key",
                        [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                },
            )
            let out = ""
            // Same quiescence rule as `serveAll`, and for the same reason: the line this test is
            // about is printed *after* the one that says the server is up.
            const up = await new Promise<boolean>((resolve, reject) => {
                const overall = setTimeout(() => reject(new Error(`no outcome:\n${out}`)), 25_000)
                let quiet: ReturnType<typeof setTimeout> | undefined
                const done = (served: boolean) => {
                    clearTimeout(overall)
                    if (quiet !== undefined) clearTimeout(quiet)
                    resolve(served)
                }
                const collect = (chunk: Buffer) => {
                    out += chunk.toString()
                    if (!out.includes("serving on")) return
                    if (quiet !== undefined) clearTimeout(quiet)
                    quiet = setTimeout(() => done(true), 400)
                }
                second.stdout.on("data", collect)
                second.stderr.on("data", collect)
                second.on("exit", () => done(false))
            })
            expect(up).toBe(true)
            second.kill("SIGTERM")

            // Serves the one it could claim…
            expect(out).toContain("free —")
            // …and says out loud that it is not serving the other, with the pid to act on. Without
            // this line the process looks entirely healthy while hosting half of what was asked for.
            expect(out).toContain("held — NOT served here")
            expect(out).toMatch(/pid \d+/)
        } finally {
            first.kill("SIGTERM")
        }
    }, 60_000)

    test("manifests that disagree about the bind are refused before anything binds", async () => {
        // One process, one socket, one token. Taking the first manifest's port silently would make
        // a file that carefully declares 7500 a file whose setting does nothing — and the symptom
        // would be a port somebody else is already using.
        const { out, exited } = await serveAll(
            [join(agentDir("one", 7420), "agent.yaml"), join(agentDir("two", 7500), "agent.yaml")],
            { port: "none" },
        )
        expect(exited).toBe(true)
        expect(out).toContain("serve_bind_conflict")
        expect(out).toContain("server.port")
    }, 30_000)

    test("a flag settles the disagreement, because it settles the value", async () => {
        // The same disagreeing pair comes **up** when `--port` is given: the flag overrides every
        // manifest, so refusing over a value nothing will read would be a refusal the operator has
        // already answered. This pairs with the test above — one asserts the refusal, one asserts
        // it is not overzealous, and neither is meaningful without the other.
        const { out, exited } = await serveAll([
            join(agentDir("three", 7420), "agent.yaml"),
            join(agentDir("four", 7500), "agent.yaml"),
        ])
        expect(exited).toBe(false)
        expect(out).not.toContain("serve_bind_conflict")
        expect(out).toContain("three —")
        expect(out).toContain("four —")
    }, 30_000)
})

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
        const env = {
            ...process.env,
            MODEL_API_KEY: "test-key",
            [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
        }

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

/**
 * A misconfigured agent in the sandbox must not take the host down.
 *
 * **Found by running the container, not by reading the code.** `init` writes an agent whose `.env`
 * holds `MODEL_API_KEY=` — empty on purpose, since step 1 of what it prints is "add your key". A
 * bare `serve` hosts every enabled agent in the sandbox, so that one agent made `loadManifest`
 * throw, the host exited 1, and `restart: unless-stopped` restarted it into the same failure: nine
 * restarts, no API, no web UI. The always-on server that exists to provision agents, taken down by
 * an agent halfway through being provisioned.
 *
 * Both directions are asserted, because the fix is an asymmetry rather than a tolerance: a
 * **discovered** agent is skipped and named, a **named** one still refuses. Reverting either half
 * turns one of these two red.
 */
describe("a broken agent does not take the host down", () => {
    /** A sandbox with one loadable agent and one whose key is missing from the environment. */
    function sandbox(): string {
        const home = mkdtempSync(join(tmpdir(), "serve-sandbox-"))
        const agents = join(home, BRAND.stateDir, "agents")
        for (const [id, keyEnv] of [
            ["fine", "MODEL_API_KEY"],
            ["halfdone", "KEY_NOBODY_SET"],
        ] as const) {
            const dir = join(agents, id)
            mkdirSync(dir, { recursive: true })
            writeFileSync(
                join(dir, "agent.yaml"),
                `apiVersion: ${BRAND.apiVersion}
id: ${id}
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: ${keyEnv}
server:
  enabled: true
`,
                "utf8",
            )
        }
        return home
    }

    /** `serve` against that sandbox. `manifests` empty is the bare, discovering form. */
    async function serveSandbox(
        home: string,
        manifests: readonly string[] = [],
    ): Promise<{ readonly out: string; readonly exited: boolean }> {
        const store = join(home, "store.db")
        const child = spawn(
            process.execPath,
            [BINARY, "serve", ...manifests, "--port", "0", "--store", store],
            {
                env: {
                    ...process.env,
                    HOME: home,
                    // **The override IS the sandbox root**, not the home directory above it —
                    // `sandboxRoot` returns it verbatim rather than joining `stateDir` onto it.
                    // Pointed at `home`, discovery looked in `<home>/agents`, found nothing, and
                    // the banner listed no agents at all: a green-looking run asserting nothing.
                    [`${BRAND.envPrefix}HOME`]: join(home, BRAND.stateDir),
                    MODEL_API_KEY: "test-key",
                    [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
                    // Or the ambient environment satisfies the very variable this fixture
                    // withholds, and the broken agent loads perfectly.
                    KEY_NOBODY_SET: "",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        )
        let out = ""
        const settled = await new Promise<boolean>((resolve, reject) => {
            const overall = setTimeout(() => reject(new Error(`no outcome:\n${out}`)), 25_000)
            let quiet: ReturnType<typeof setTimeout> | undefined
            const done = (exited: boolean) => {
                clearTimeout(overall)
                if (quiet !== undefined) clearTimeout(quiet)
                resolve(exited)
            }
            const collect = (chunk: Buffer) => {
                out += chunk.toString()
                if (!out.includes("serving on")) return
                if (quiet !== undefined) clearTimeout(quiet)
                quiet = setTimeout(() => done(false), 400)
            }
            child.stdout.on("data", collect)
            child.stderr.on("data", collect)
            child.on("exit", () => done(true))
        })
        if (!settled) child.kill("SIGTERM")
        return { out, exited: settled }
    }

    test("a bare serve stays up, serves the good agent and names the broken one", async () => {
        const home = sandbox()
        const { out, exited } = await serveSandbox(home)
        rmSync(home, { recursive: true, force: true })

        // The host is up. This is the assertion that was false: it exited 1 into a restart loop.
        expect(exited).toBe(false)
        expect(out).toContain("serving on")
        expect(out).toContain("fine —")
        // And says so, because a skipped agent nothing mentions is the failure this repo keeps
        // finding. The path is the actionable half — the fix is in the `.env` beside it.
        expect(out).toContain("NOT served")
        expect(out).toContain("halfdone")
        expect(out).toContain("KEY_NOBODY_SET")
    }, 30_000)

    test("a manifest named on the command line still refuses", async () => {
        const home = sandbox()
        const named = join(home, BRAND.stateDir, "agents", "halfdone", "agent.yaml")
        const { out, exited } = await serveSandbox(home, [named])
        rmSync(home, { recursive: true, force: true })

        // Asked for that agent by path, so skipping it would serve something other than what was
        // requested — the worse error, and the direction `hostableAgents` already distinguishes.
        expect(exited).toBe(true)
        expect(out).toContain("KEY_NOBODY_SET")
        expect(out).not.toContain("serving on")
    }, 30_000)
})
