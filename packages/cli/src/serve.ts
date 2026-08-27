/**
 * The `serve` command: `<binary> serve <manifest> [--port N] [--host H]`.
 *
 * Boots a runtime with channels started, binds the HTTP surface, and stays up until interrupted.
 * The only long-running command in the binary, and the only one that opens a listening socket.
 *
 * **Channels start here and nowhere else.** `run` constructs the same runtime with
 * `startChannels: false`, because a REPL that silently began answering Telegram messages while you
 * typed at it would be a surprise, and a one-shot `run --input` that opened a long-poll would hang
 * on exit. The flag decides *whether*, never *when* — either way nothing connects before
 * `runtime.ready`.
 *
 * No Ink. A server writes lines to stdout and is very often not attached to a terminal at all; a
 * rendering framework on this path would cost more than the whole command and produce escape codes
 * in a log file.
 */

import { BRAND, EventBus, HarnessError, loadManifest, Runtime } from "@dispach/core"
import { serve } from "@dispach/server"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { claimSignals, onExit } from "#lib/exit"
import { CHANNEL_IDS, CHANNELS, PROVIDER_IDS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { storePath } from "#lib/sandbox"

export interface ServeOptions {
    readonly manifestPath: string
    readonly port?: number
    readonly host?: string
    readonly store?: string
    readonly json?: boolean
}

export async function serveCommand(options: ServeOptions): Promise<number> {
    const env = ambientEnv([options.manifestPath])
    const loaded = loadManifest(options.manifestPath, {
        knownProviders: PROVIDER_IDS,
        knownChannels: CHANNEL_IDS,
        env,
    })

    const config = loaded.manifest.server
    // Flags win over the manifest: the manifest is the deployment's intent and a flag is this
    // invocation's. `--port 0` is honoured — it means "any free port", which a test wants.
    const port = options.port ?? config.port
    const host = options.host ?? config.host
    // `loaded.env`, never `env`. `ambientEnv` returns the *process* environment — the agent's own
    // `.env` beside the manifest is layered in by `loadManifest`, which is why every other
    // credential in this runtime is read from the manifest's live env. Reading the ambient one
    // here meant a token sitting in the agent's `.env` was invisible, and the banner said
    // "unauthenticated" while the file plainly had it. Same mistake `Agent.create` documents:
    // the manifest's live env, not the ambient one.
    const token = loaded.env[config.tokenEnv]

    // Set by the generated service definition and by nothing else, so this is a fact rather than a
    // guess. `ppid === 1` would also be true of any orphaned process, and getting it wrong means
    // telling someone to press ctrl-c at a log file.
    const asDaemon = env[`${BRAND.envPrefix}SERVICE`] !== undefined

    // Subscribed BEFORE the runtime exists, which is what the `bus` option is for. Channels start
    // inside `Runtime.create` — after `runtime.ready`, but still inside the call — so a listener
    // attached afterwards misses every status and error they emitted on the way up. Same trap as
    // the boot warnings that landed in an empty room for weeks: anything true during boot has to be
    // subscribed to before boot.
    const bus = new EventBus({ runtimeId: `rt_${Date.now().toString(36)}` })
    if (options.json !== true) {
        bus.on("agent.channel.status", (event) => {
            const data = event.data as { channelId: string; status: string; detail?: string }
            process.stdout.write(
                `  ${data.channelId}: ${data.status}${data.detail === undefined ? "" : ` — ${data.detail}`}\n`,
            )
        })
        bus.on("agent.channel.error", (event) => {
            const data = event.data as { channelId: string; message: string; hint: string }
            process.stderr.write(`  ${data.channelId}: ${data.message}\n    hint: ${data.hint}\n`)
        })
        // The one thing a person watching a bot most wants to see, and it is otherwise only in the
        // event stream: who was refused, and the line that would let them in.
        bus.on("agent.channel.rejected", (event) => {
            const data = event.data as { channelId: string; reason: string; detail: string }
            process.stdout.write(`  ${data.channelId}: ${data.reason} — ${data.detail}\n`)
        })
    }

    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        env,
        bus,
        toolProviders: TOOL_PROVIDERS,
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        // The one call site that passes this. See the file comment.
        startChannels: true,
        // Same rule and the same reason: `serve` is the only command that fires schedules. A REPL
        // that started firing them while somebody typed at it would be a surprise, and a one-shot
        // `run --input` that armed a timer would not exit.
        startSchedules: true,
        // `run` and `sessions` have resolved this default since the sandbox landed; `serve` never
        // did, so it silently took core's `":memory:"` — correct as a *library* default, since
        // constructing a Runtime must not create a directory in someone's working tree, and wrong
        // for the one command built to stay up. The cost was invisible and total: every channel
        // conversation started blank after a restart, `sessions` could not see a single turn that
        // arrived over a channel, and Phase 4's exactly-once outbox was unreachable through the
        // only command that has channels — the queue was created and destroyed per process, so a
        // crash mid-delivery lost the queue rather than recovering it.
        store: options.store ?? storePath(),
        // Recorded on the runtime lease and read back only to phrase a refusal. `<PREFIX>SERVICE`
        // is set by the generated service definition and by nothing else, so this is a fact rather
        // than a guess — `ppid === 1` would also be true of any orphaned process.
        mode: asDaemon ? "daemon" : "terminal",
    })

    let running: Awaited<ReturnType<typeof serve>>
    try {
        running = await serve({
            runtime,
            host,
            port,
            ...(token === undefined || token === "" ? {} : { token }),
        })
    } catch (error) {
        // The runtime is already up; leaving it running after a failed bind would hold the store
        // open and keep channels polling with nothing serving.
        await runtime.stop("server failed to bind")
        if (error instanceof HarnessError) throw error
        throw new HarnessError({
            code: "server_bind_failed",
            message: `Could not bind ${host}:${port}: ${
                error instanceof Error ? error.message : String(error)
            }`,
            hint: "Another process is probably on that port. Pass --port, or set server.port in the manifest.",
            cause: error,
        })
    }

    const agents = runtime.list()

    // Name the process after the agent it is serving.
    //
    // Without this a long-running service is a bare `node` in Activity Monitor and in `ps`, signed
    // by the Node Foundation, indistinguishable from every other Node process on the machine — and
    // the one place a person looks when something is eating CPU is exactly the place it was
    // anonymous. Set here rather than at startup because the agent id is only known once the
    // manifest has loaded, and `serve` takes one manifest so there is only ever one name.
    //
    // The trade, stated because it costs something real: assigning `process.title` overwrites the
    // argv region, so `ps` shows this instead of the full command line. Kept short so it survives
    // the 16-character `comm` truncation intact, and the arguments remain visible in
    // `launchctl print` and in `daemon status`.
    if (agents[0] !== undefined) process.title = `${BRAND.slug} ${agents[0].id}`
    // The port is bound now, which `Runtime.create` could not know — it returns before `serve` runs.
    // Told before the first turn, so slot 2 says "on" rather than "enabled but not listening".
    for (const agent of agents) agent.reportRuntimeState({ serverListening: true })

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({
                url: running.url,
                websocket: running.websocket,
                authenticated: token !== undefined && token !== "",
                agents: agents.map((agent) => ({
                    id: agent.id,
                    channels: runtime.channels.statusOf(agent.id),
                })),
            })}\n`,
        )
    } else {
        process.stdout.write(`${BRAND.name} serving on ${running.url}\n`)
        for (const agent of agents) {
            const channels = runtime.channels.statusOf(agent.id)
            const suffix =
                channels.length === 0
                    ? "no channels"
                    : channels.map((c) => `${c.id} (${c.type})`).join(", ")
            // Schedules named on the banner for the reason the 57 MB log taught: this is the last
            // place a person looks before walking away, and "it is set up" is exactly the belief a
            // schedule that never fires depends on going unchecked.
            const enabled = agent.manifest.schedules.filter((schedule) => schedule.enabled)
            const scheduled =
                agent.manifest.schedules.length === 0
                    ? ""
                    : `, ${enabled.length} schedule${enabled.length === 1 ? "" : "s"}${
                          agent.manifest.schedules.length > enabled.length
                              ? ` (+${agent.manifest.schedules.length - enabled.length} disabled)`
                              : ""
                      }`
            process.stdout.write(`  ${agent.id} — ${suffix}${scheduled}\n`)
        }
        if (token === undefined || token === "") {
            // Loopback-only, or `serve` would have refused to bind. Said out loud anyway: someone
            // who later changes the host needs to know the token was never set.
            process.stdout.write(
                `  unauthenticated — loopback only. Set ${config.tokenEnv} to bind a public host.\n`,
            )
        }
        if (!running.websocket) {
            process.stdout.write("  /v1/ws unavailable under Node — SSE and HTTP are unaffected.\n")
        }
        // The single highest-value place to mention the daemon: this is the exact moment a person
        // learns that `serve` lives and dies with the terminal it was typed into. Left unsaid, the
        // discovery happens later, by the agent going quiet with nothing to explain it.
        if (asDaemon) {
            process.stdout.write(
                `  running as a background service · ${BRAND.slug} daemon status ${agents[0]?.id ?? ""}\n`,
            )
        } else {
            process.stdout.write(
                `  ctrl-c to stop — this ends when the terminal does. \`${BRAND.slug} daemon install ${
                    agents[0]?.id ?? "<agent>"
                }\` keeps it running.\n`,
            )
        }
    }

    // Registered as a *teardown*, not as a second signal handler, and that distinction was a live
    // bug. `installGuards` already owns SIGTERM and answers it with `finishNow(EXIT_SIGTERM)`,
    // which hard-exits; this module used to register its own `process.once("SIGTERM")` alongside
    // it. Both fired, and the hard exit won — so `runtime.stop()` never completed. No outbox
    // flush, no clean database close, and no `provider.stop()`, which is the only thing that reaps
    // the child processes `exec` backgrounds. Invisible at a terminal, because ctrl-C sends SIGINT
    // and the guard deliberately ignores that one; unavoidable under a service manager, where
    // SIGTERM is how every stop and every restart happens.
    //
    // `finish()` awaits `runTeardowns()`, so putting the shutdown here means the signal path waits
    // for it instead of racing it.
    claimSignals()
    let stopped = false
    const shutdown = async () => {
        if (stopped) return
        stopped = true
        await running.stop()
        await runtime.stop("interrupted")
    }
    onExit(shutdown)

    await waitForSignal()

    process.stdout.write("stopping\n")
    await shutdown()
    // Zero, deliberately, and it is load-bearing rather than cosmetic. A requested stop is not a
    // fault, and the generated service definition restarts only on a crash signal — so a non-zero
    // exit here would be read by the supervisor as "this configuration is broken, stay down".
    return EXIT_OK
}

/**
 * Resolve on SIGINT or SIGTERM.
 *
 * Both, because SIGINT is a person at a terminal and SIGTERM is an orchestrator, and a container
 * that ignored SIGTERM would be killed after its grace period — mid-delivery, which is the one
 * moment the outbox's recovery path exists to survive and would rather not exercise.
 */
function waitForSignal(): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            process.off("SIGINT", finish)
            process.off("SIGTERM", finish)
            resolve()
        }
        process.once("SIGINT", finish)
        process.once("SIGTERM", finish)
    })
}

/** Re-exported for the boundaries test, which asserts this module imports no renderer. */
export const SERVE_EXIT_FAILURE = EXIT_FAILURE
