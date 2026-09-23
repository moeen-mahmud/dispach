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
        // The bind moved inside `bindWalking` when a taken port started walking to the next one.
        // Anchored on the call that performs it, which is what "before the socket binds" means.
        const bind = SOURCE.indexOf("running = await bindWalking(")

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

/**
 * The banner is the only output a container deployment has, and three things in it were wrong.
 *
 * All three were reported by someone reading `docker logs` and clicking what was there, which is
 * the only way any of them surfaces: on a laptop `serve` binds `127.0.0.1`, so the substitution
 * never fires and the sign-off is true.
 */
describe("the banner names things a person can actually use", () => {
    /** `serve` on a chosen bind, with a token because a non-loopback bind demands one. */
    async function banner(host: string): Promise<string> {
        const dir = agentDir(`banner-${host.replace(/[^a-z0-9]/gi, "")}`)
        const store = join(mkdtempSync(join(tmpdir(), "serve-banner-")), "store.db")
        const child = spawn(
            process.execPath,
            [
                BINARY,
                "serve",
                join(dir, "agent.yaml"),
                "--host",
                host,
                "--port",
                "0",
                "--store",
                store,
            ],
            {
                env: {
                    ...process.env,
                    MODEL_API_KEY: "test-key",
                    [`${BRAND.envPrefix}API_TOKEN`]: "banner-test-token",
                    [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        )
        let out = ""
        await new Promise<void>((resolve, reject) => {
            const overall = setTimeout(() => reject(new Error(`no banner:\n${out}`)), 25_000)
            let quiet: ReturnType<typeof setTimeout> | undefined
            const collect = (chunk: Buffer) => {
                out += chunk.toString()
                if (!out.includes("serving on")) return
                if (quiet !== undefined) clearTimeout(quiet)
                quiet = setTimeout(() => {
                    clearTimeout(overall)
                    resolve()
                }, 400)
            }
            child.stdout.on("data", collect)
            child.stderr.on("data", collect)
            child.on("exit", () => {
                clearTimeout(overall)
                resolve()
            })
        })
        child.kill("SIGTERM")
        rmSync(dir, { recursive: true, force: true })
        return out
    }

    test("a wildcard bind is printed as loopback, and the bind is still named", async () => {
        const out = await banner("0.0.0.0")
        // The defect: `http://0.0.0.0:7420` was the banner's first and most prominent line, and a
        // browser does nothing with it. `browsableHost` existed for this and had three callers;
        // this was the fourth and never got it.
        expect(out).not.toContain("serving on http://0.0.0.0")
        expect(out).toContain("serving on http://127.0.0.1:")
        // And the wildcard is still disclosed, because "listening on every interface" is a
        // security-relevant fact that showing loopback alone would hide.
        expect(out).toContain("bound 0.0.0.0")
    }, 30_000)

    test("a loopback bind gets no parenthetical, because nothing was substituted", async () => {
        const out = await banner("127.0.0.1")
        expect(out).toContain("serving on http://127.0.0.1:")
        expect(out).not.toContain("bound 127.0.0.1")
    }, 30_000)

    test("the web UI and the API reference are named", async () => {
        const out = await banner("0.0.0.0")
        // Both have been served unauthenticated since they shipped and neither was mentioned
        // anywhere a person looks. A surface nobody is told about is a surface nobody has.
        expect(out).toContain("web UI http://127.0.0.1:")
        expect(out).toContain("/docs")
        // Never the wildcard, in any line of it.
        expect(out).not.toContain("0.0.0.0:0")
        expect(out.split("\n").filter((line) => line.includes("http://0.0.0.0"))).toEqual([])
    }, 30_000)
})

describe("a plugin-supplied channel loads under serve", () => {
    /**
     * `PluginContext.defineChannel` is documented public API that did not work through this binary.
     *
     * `Runtime.create` had always been right — it loads an agent's plugins, then validates
     * `channels[].type` against `Object.keys(supply.channels)`, which includes whatever they
     * registered. Every CLI surface pre-loaded the manifest *first* against the static
     * `CHANNEL_IDS` table, so `channel_type_unknown` refused a correct manifest before the plugin
     * that would satisfy it was imported. `serve` is the one that matters, because `serve` is what
     * hosts channels.
     *
     * The reason it stayed invisible is the useful half: `telegram` reaches the runtime as
     * `channels: { telegram }` from the CLI's own table and never through the plugin path, so the
     * documented API had **no in-tree consumer**. This test is that consumer.
     *
     * Spawned rather than unit-tested on purpose. The bug lives in the ordering of two loads inside
     * one command, and a test that called `loadManifest` itself would be choosing the ordering it
     * meant to check — the same reason `bundle.test.ts` starts the binary.
     */
    function pluginSandbox(): string {
        const dir = mkdtempSync(join(tmpdir(), "serve-plugin-"))
        /**
         * A channel plugin, as small as the contract allows.
         *
         * `start` returns once *running* rather than once connected, which is the contract and also
         * what keeps this fixture from needing a network. `send` reports success for a message
         * nothing sends here — the assertion is that the manifest **loads and is served**, which is
         * exactly what was impossible before.
         */
        writeFileSync(
            join(dir, "smoke-channel.mjs"),
            `export default {
    name: "smoke-channel",
    version: "1.0.0",
    // The semver **range** this plugin claims, checked against the host's. A mismatch is a loud
    // load failure rather than a silent rollback, which is the one thing the runtime this replaces
    // got wrong badly enough to be worth copying the opposite of.
    dispachApi: "^0.1",
    setup(context) {
        context.defineChannel("smoke", (channel) => ({
            id: channel.id,
            type: "smoke",
            limits: { maxMessageChars: 4096, idempotentSend: false },
            async start() {},
            async stop() {},
            async send() {
                return { ok: true, providerMessageId: "smoke-1" }
            },
        }))
    },
}
`,
            "utf8",
        )
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: smoked
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
plugins:
  - ./smoke-channel.mjs
channels:
  - type: smoke
    id: sm
    allowFrom: ["someone"]
server:
  enabled: true
`,
            "utf8",
        )
        return dir
    }

    test("the manifest loads, the host stays up, and the channel is served", async () => {
        const dir = pluginSandbox()
        const { out, exited } = await serveAll([join(dir, "agent.yaml")])
        // The refusal this replaces, by code. Named rather than matched loosely, because the
        // failure was a *specific* check firing in the wrong pass.
        expect(out).not.toContain("channel_type_unknown")
        // A **named** manifest, so a load failure exits rather than being skipped — which makes
        // "did not exit" a real assertion here rather than a tolerance.
        expect(exited).toBe(false)
        expect(out).toContain("serving on")
        expect(out).toContain("smoked")
        rmSync(dir, { recursive: true, force: true })
    }, 30_000)

    test("a genuinely unknown channel type is named and the host serves the agent anyway", async () => {
        /**
         * The other direction, and it changed in 0.1.3 rather than being dropped.
         *
         * It used to refuse the agent, and the second pass in `serve` existed so that refusal
         * landed where the skip-and-report loop could see it instead of throwing from an unguarded
         * `sources.map`. A channel is an **optional** capability, so an unknown type is now a
         * warning: the agent is served, the channel is reported broken, and the concern that made
         * the two-pass necessary is gone with the refusal.
         *
         * What still has to be true is that the type is **named**. Silence was the whole objection
         * to skipping a channel that constructs nothing, and it is the only part of the old
         * behaviour worth keeping.
         */
        const dir = mkdtempSync(join(tmpdir(), "serve-nochan-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: nochan
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: carrier-pigeon
    id: cp
server:
  enabled: true
`,
            "utf8",
        )
        const { out, exited } = await serveAll([join(dir, "agent.yaml")])
        // Served, and the channel named as broken rather than the agent refused.
        expect(exited).toBe(false)
        expect(out).toContain("carrier-pigeon")
        expect(out).toContain("BROKEN")
        rmSync(dir, { recursive: true, force: true })
    }, 30_000)
})

describe("a failure a person must act on reaches the log", () => {
    /**
     * Measured in the container on 2026-09-22, and it is the 57 MB-log lesson inverted.
     *
     * A model key pasted without its provider prefix made every turn 401. The runtime did
     * everything right — `error` carried `model_http_error`, the endpoint's own words, and a hint
     * naming `model.main.apiKeyEnv` — and **nothing here subscribed to it**, so `docker logs` held
     * not one word while `POST /messages` answered 200 with a turn id and the stored session
     * returned `[]`. Under a container or a service manager stderr is the only log there is, which
     * makes an unsubscribed failure event indistinguishable from a product that does not work.
     *
     * Same empty room `delivery.failed` sat in for a release, one event over. Asserted in the
     * source because the alternative is spawning a server with a deliberately broken key and
     * waiting on a real endpoint to refuse it — a network round-trip to prove a subscription.
     */
    const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "serve.ts"), "utf8")

    test("serve subscribes to every failure event, not only the channel ones", () => {
        const subscribed = [...SOURCE.matchAll(/bus\.on\("([\w.]+)"/g)].map((m) => m[1])
        // The guard only means something if it found the subscriptions at all.
        expect(subscribed.length).toBeGreaterThan(3)
        expect(subscribed).toContain("error")
    })

    test("the line carries the code and the hint, which are what make it actionable", () => {
        const handler = SOURCE.slice(SOURCE.indexOf('bus.on("error"'))
        const body = handler.slice(0, handler.indexOf("\n        })"))
        // A line reading only "turn failed" is the failure with better manners: true, and no route
        // to acting on it. This is the same trio every other surface prints.
        expect(body).toContain("data.code")
        expect(body).toContain("data.message")
        expect(body).toContain("data.hint")
    })
})

describe("a taken port moves the server rather than stopping it", () => {
    /**
     * Reported from use: a container published 7420, and `dispach serve` on the same machine
     * dead-ended with `server_bind_failed` and a hint naming two flags. `init` writes
     * `port: 7420` into every manifest it generates, so on a machine with a container, a
     * service and a checkout the default collides constantly.
     *
     * A walk is only safe because **the lease carries the address and the manifest does not** —
     * `publishAddress` runs after the bind with whatever was actually taken, so `stop`, `web url`
     * and an attached `run` follow the socket. That mechanism exists for `--port 0`.
     *
     * Both directions are asserted, because the interesting half is the refusal: a flag is an
     * instruction, and a `--port` that silently served somewhere else would be the
     * "looks configured and is not" shape this file's bind-disagreement check already refuses.
     */
    function manifestOn(port: number): string {
        const dir = mkdtempSync(join(tmpdir(), "serve-port-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: walker
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
server:
  enabled: true
  port: ${port}
`,
            "utf8",
        )
        return join(dir, "agent.yaml")
    }

    /** Hold a port for the duration of one test, the way another process would. */
    async function occupied(): Promise<{ port: number; release: () => Promise<void> }> {
        const { createServer } = await import("node:net")
        const server = createServer()
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("no port")
        return {
            port: address.port,
            release: () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve())
                }),
        }
    }

    async function serveManifest(
        manifest: string,
        extra: readonly string[],
    ): Promise<{ out: string; exited: boolean }> {
        const store = join(mkdtempSync(join(tmpdir(), "serve-port-store-")), "store.db")
        const child = spawn(
            process.execPath,
            [BINARY, "serve", manifest, "--store", store, ...extra],
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
                if (!out.includes("serving on") && !out.includes("server_bind_failed")) return
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

    test("the manifest's port being taken moves it to the next one, and it says so", async () => {
        const held = await occupied()
        try {
            const { out } = await serveManifest(manifestOn(held.port), [])
            expect(out).toContain(`serving on http://127.0.0.1:${held.port + 1}`)
            // Silent relocation would make `server.port` a line that is false for the life of the
            // process. The remedy names the flag that refuses instead.
            expect(out).toContain(`moved from ${held.port}`)
            expect(out).not.toContain("server_bind_failed")
        } finally {
            await held.release()
        }
    }, 30_000)

    test("an explicit --port refuses, because a flag is an instruction", async () => {
        const held = await occupied()
        try {
            const { out } = await serveManifest(manifestOn(held.port), [
                "--port",
                String(held.port),
            ])
            expect(out).toContain("server_bind_failed")
            expect(out).toContain("--port was given explicitly")
            expect(out).not.toContain("moved from")
        } finally {
            await held.release()
        }
    }, 30_000)
})
