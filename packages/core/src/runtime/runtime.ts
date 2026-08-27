/**
 * One process, N agents. Owns the event bus and, from Phase 8, the single timer.
 *
 * **No network I/O before `runtime.ready`.** This is the rule the project exists for: the
 * runtime being replaced blocks roughly four minutes on network calls during hook
 * initialisation. Booting here reads files and the environment, and nothing else. The first
 * packet leaves when a turn runs or, from Phase 4, when channels connect *after* readiness.
 *
 * Hosting N agents rather than one is a library decision, not a deployment one. A platform that
 * runs one agent per container is welcome to; forcing 1:1 would make the embedded case
 * impossible.
 */

import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { BRAND } from "../brand.ts"
import type { ChannelBinding } from "../channels/channel.ts"
import { channelTypeUnknown, HarnessError, toolProviderUnknown } from "../errors.ts"
import { EventBus } from "../events/bus.ts"
import type { EnvSource } from "../manifest/env.ts"
import { type LoadedManifest, loadManifest, loadManifestFromObject } from "../manifest/load.ts"
import { resolveProviders } from "../manifest/providers.ts"
import type { FetchLike } from "../model/provider.ts"
import { Scheduler } from "../schedule/scheduler.ts"
import { TurnStreams } from "../store/buffer.ts"
import { SqliteStore } from "../store/sqlite/store.ts"
import type { RuntimeMode, Store } from "../store/store.ts"
import { ToolRegistry } from "../tools/registry.ts"
import type { ScriptRunner, ToolProvider, ToolProviderFactory } from "../tools/types.ts"
import { Agent } from "./agent.ts"
import { type ChannelFactory, ChannelHub } from "./channels.ts"
import { claimLeases, LEASE_BEAT_MS } from "./lease.ts"
import { reconcileSchedules, scheduleRunner } from "./schedules.ts"

export type AgentSource = string | Record<string, unknown>

/**
 * Where sessions live.
 *
 * - a path — a SQLite file, created along with its parent directory
 * - `":memory:"` — anonymous, gone at exit
 * - a `Store` — an already-open store the caller owns and will close itself
 * - omitted — `":memory:"`
 *
 * **Persistence is opt-in.** Defaulting to a file would mean `Runtime.create` creates a
 * directory in the caller's working directory as a side effect of being constructed, which is
 * not a library's business to do uninvited. The CLI passes `defaultStorePath()` because a REPL
 * genuinely wants history across restarts; an embedder decides for itself. Either way
 * `store.ready` reports the location, so which one is in use is observable rather than guessed.
 */
export type StoreSource = string | Store

export interface RuntimeOptions {
    /** Manifest paths, or already-parsed manifest objects. */
    readonly agents: readonly AgentSource[]
    readonly runtimeId?: string
    readonly env?: EnvSource
    readonly fetch?: FetchLike
    /** Emit per-token `model.chunk` events. Off by default; the REPL turns it on. */
    readonly emitChunks?: boolean
    /** Bring your own bus, to subscribe before boot events fire. */
    readonly bus?: EventBus
    /** Directory for relative paths in object-form manifests. Defaults to `process.cwd()`. */
    readonly dir?: string
    readonly store?: StoreSource
    /**
     * Tool provider factories, by the id a manifest's `tools.provider` names.
     *
     * Factories rather than instances: `packages/core` may not import a sibling package, and a
     * provider needs the agent's own directory and resolved environment, which exist only once its
     * manifest is loaded. A manifest naming an unregistered id fails at load rather than resolving
     * nothing and blaming the slugs.
     */
    readonly toolProviders?: Readonly<Record<string, ToolProviderFactory>>
    /**
     * How a skill's script runs. Same shape and same reasoning as `toolProviders`: core starts no
     * processes, so the one package allowed to supplies this.
     *
     * Omitted means skills carry prose and their `scripts/` is never discovered, which is the right
     * default for an embedder with no shell rather than a degraded version of having one.
     */
    readonly scriptRunner?: ScriptRunner
    /**
     * Channel transport factories, by the `type` a manifest's `channels[]` entry names.
     *
     * Same shape and same reasoning as `toolProviders`: core may not import `channel-telegram`, and
     * a transport needs the agent's directory and resolved environment. A manifest naming an
     * unregistered type fails at load, beside the entry that named it, rather than looking like a
     * channel that simply never receives anything.
     */
    readonly channels?: Readonly<Record<string, ChannelFactory>>
    /**
     * Start channels as part of `create`, after `runtime.ready` has fired.
     *
     * Off by default: constructing a `Runtime` in a test or a one-shot CLI command must not open a
     * long-poll to Telegram. `serve` passes true; `run` does not. Either way nothing connects
     * before readiness — the flag decides whether it happens at all, never whether it happens early.
     */
    readonly startChannels?: boolean
    /**
     * Start the scheduler as part of `create`, after `runtime.ready` has fired.
     *
     * Off by default, and for the same reasons `startChannels` is: a REPL that quietly began firing
     * schedules while somebody typed at it would be a surprise, and a one-shot `run --input` that
     * armed a timer would not exit. `serve` passes true; `run` does not. Schedules are still
     * *reconciled* either way, so `schedules` can list them without the timer running — the flag
     * decides whether they fire, never whether they exist.
     */
    readonly startSchedules?: boolean
    /**
     * How this process was started, recorded on the runtime lease.
     *
     * Only ever read back to phrase a refusal — "already served by pid 4711 as a background
     * service" is actionable where a bare pid is a number the person then has to go and look up.
     * Defaults to `embedded`, which is what an embedder is; the CLI passes `terminal` or `daemon`.
     */
    readonly mode?: RuntimeMode
    /**
     * Whether to take the serving lease for these agents. Default true.
     *
     * False for a read-only command — a listing that momentarily claimed a lease could refuse a
     * `serve` starting in the same millisecond, which is a race invented by the act of looking.
     * A runtime that does not claim also recovers nothing, which is correct: those rows belong to
     * whoever does hold it.
     */
    readonly lease?: boolean
}

export interface BootReport {
    /** Time inside `Runtime.create`. */
    readonly bootMs: number
    /** Time since process start — what the sub-second claim is actually about. */
    readonly processMs: number
    readonly phases: Record<string, number>
}

/** Default database location, derived from the brand so a rename moves it. */
export function defaultStorePath(cwd: string = process.cwd()): string {
    return resolve(cwd, BRAND.stateDir, "store.db")
}

export class Runtime {
    readonly runtimeId: string
    readonly bus: EventBus
    readonly boot: BootReport
    readonly store: Store
    /** Per-turn event buffers, for reattaching a client to a turn already in flight. */
    readonly streams: TurnStreams
    /** Channel bindings and the delivery queue. Empty when no agent configures a channel. */
    readonly channels: ChannelHub
    readonly scheduler: Scheduler

    /**
     * Every tool provider constructed, flattened. Held so `stop` can tell each one to let go.
     *
     * A provider can own an OS process — `exec` backgrounds a long command rather than discarding
     * it — and before this there was nothing to tell it the runtime was leaving. See
     * `ToolProvider.stop`.
     */
    #providers: readonly ToolProvider[] = []

    #agents = new Map<string, Agent>()
    #stopped = false
    /** False when the caller passed an already-open store, which stays theirs to close. */
    #ownsStore: boolean
    /** Agent ids this runtime holds a lease for — released on stop, refreshed while alive. */
    #owned: readonly string[] = []
    #heartbeat: ReturnType<typeof setInterval> | undefined

    private constructor(init: {
        runtimeId: string
        bus: EventBus
        boot: BootReport
        store: Store
        streams: TurnStreams
        channels: ChannelHub
        scheduler: Scheduler
        ownsStore: boolean
        owned: readonly string[]
    }) {
        this.runtimeId = init.runtimeId
        this.bus = init.bus
        this.boot = init.boot
        this.store = init.store
        this.streams = init.streams
        this.channels = init.channels
        this.scheduler = init.scheduler
        this.#ownsStore = init.ownsStore
        this.#owned = init.owned
    }

    static async create(options: RuntimeOptions): Promise<Runtime> {
        const startedAt = performance.now()
        const runtimeId = options.runtimeId ?? `rt_${Date.now().toString(36)}`
        const bus =
            options.bus ??
            new EventBus({
                runtimeId,
                ...(options.emitChunks === undefined ? {} : { emitChunks: options.emitChunks }),
            })

        const phases: Record<string, number> = {}
        const mark = <T>(name: string, work: () => T): T => {
            const from = performance.now()
            try {
                return work()
            } finally {
                phases[name] = Math.round((performance.now() - from) * 100) / 100
            }
        }
        const markAsync = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
            const from = performance.now()
            try {
                return await work()
            } finally {
                phases[name] = Math.round((performance.now() - from) * 100) / 100
            }
        }

        // Buffering starts before anything is emitted, so an early turn cannot be half-recorded.
        const streams = new TurnStreams()
        streams.listen(bus)

        // 1. Manifests: file reads, env expansion, schema, rules. No network.
        const loaded = mark("manifest", () =>
            options.agents.map((source) =>
                typeof source === "string"
                    ? loadManifest(source, envOptions(options))
                    : loadManifestFromObject(source, {
                          ...envOptions(options),
                          dir: options.dir ?? process.cwd(),
                      }),
            ),
        )

        // 2. Store: open the file, run pending migrations, reap turns a dead process left running.
        //    Disk only — a database file is not network I/O, so this belongs before readiness.
        const { store, ownsStore } = await markAsync("store", () => openStore(options))

        // Claim before recovering anything. Recovery is scoped to what this process owns, because
        // two runtimes can share a store file and the unscoped version marked the *other* one's
        // live turn failed and made it re-send a delivery it had already sent.
        const leases =
            options.lease === false
                ? { owned: [], tookOver: [], declined: [] }
                : await claimLeases({
                      store,
                      agentIds: loaded.map((entry) => entry.manifest.id),
                      runtimeId,
                      mode: options.mode ?? "embedded",
                      now: Date.now(),
                      // Only a runtime about to open a channel refuses. A REPL or a one-shot has
                      // always been allowed alongside another and simply recovers nothing.
                      exclusive: options.startChannels === true,
                  })
        const reaped = await store.turns.reapRunning(
            leases.owned,
            "the process exited before the turn finished",
        )

        // A caller-supplied store need not be the SQLite one — a plugin driver reports no
        // migration numbers, and inventing some would misreport rather than under-report.
        const sqlite = store instanceof SqliteStore ? store : undefined
        bus.emit("store.ready", {
            location: store.location,
            driver: sqlite?.driver ?? "node",
            from: sqlite?.migrations.from ?? 0,
            to: sqlite?.migrations.to ?? 0,
            applied: [...(sqlite?.migrations.applied ?? [])],
            reaped: [...reaped],
        })

        // 3. Tools: resolve the catalogue from the manifest. Local tools resolve from memory, so
        //    this touches nothing. A network provider resolves from its on-disk cache here and
        //    refreshes after readiness — hard rule 4 has no exception for "just this one call".
        //    The factory is called here rather than at first use so an unregistered id fails during
        //    boot, next to the manifest that named it — not on the first turn, hours later.
        const providersByAgent = new Map<string, readonly ToolProvider[]>()
        const registries = await markAsync("tools", () =>
            Promise.all(
                loaded.map((entry: LoadedManifest) => {
                    const providers = buildProviders(entry, options)
                    if (providers.length > 0) providersByAgent.set(entry.manifest.id, providers)
                    return ToolRegistry.create({
                        pinned: entry.manifest.tools.pinned,
                        local: entry.manifest.tools.local,
                        budget: entry.manifest.tools.budget,
                        ...(providers.length === 0 ? {} : { providers }),
                    })
                }),
            ),
        )

        // 4. Agents: identity files, capability resolution, provider construction. Still no network
        //    — constructing a provider allocates no socket.
        const agents = mark("agents", () =>
            loaded.map((entry: LoadedManifest, index) =>
                Agent.create(entry, bus, store, {
                    ...(registries[index] === undefined ? {} : { tools: registries[index] }),
                    ...(options.scriptRunner === undefined
                        ? {}
                        : { scriptRunner: options.scriptRunner }),
                    // The manifest's live env, not the ambient one: it layers the real environment
                    // over any `.env` beside the manifest, which is what the load-time key check
                    // validated against. Passing `process.env` here instead is how `validate` and
                    // `run` end up disagreeing about whether a key exists.
                    env: entry.env,
                    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                    onRetry: (info) => {
                        bus.emit("model.retry", info, { agentId: entry.manifest.id })
                    },
                    // A warning rather than a log line, because the agent keeps working and the only
                    // visible consequence is that every pressure figure stays `estimated` — carrying
                    // the estimator's measured 16-20% low bias, forever, with nothing saying so.
                    onUsageUnsupported: (info) => {
                        bus.emit(
                            "agent.warning",
                            {
                                code: "model_usage_unsupported",
                                message: `${entry.manifest.model.main.baseUrl} refused stream_options (HTTP ${info.status}), so token usage is not reported.`,
                                hint: "The request was retried without it and this agent works normally. What is lost is the prompt_tokens anchor: compaction pressure is estimated from characters rather than corrected against the endpoint, and the estimator runs 16-20% low on tool-heavy prompts. Set model.main.streamUsage: false to stop asking, or point at an endpoint that supports stream_options.",
                                field: "model.main.streamUsage",
                            },
                            { agentId: entry.manifest.id },
                        )
                    },
                }),
            ),
        )

        // 5. Channels: construct transports. Allocating one opens no socket — `start()` does, and
        //    that is called after readiness, below.
        const hub = new ChannelHub({ bus, outboxStore: store.outbox })

        // Built before the runtime so it can be handed in, but it arms nothing until `start()` and
        // reads its agent list lazily — the runtime's own map is populated a few lines below this.
        const scheduler = new Scheduler({
            store: store.schedules,
            bus,
            // `agents` is already built at this point; read lazily anyway so the scheduler and the
            // runtime cannot come to disagree about which agents exist.
            agentIds: () => agents.map((agent) => agent.id),
            run: scheduleRunner({ agents: () => agents, hub }),
        })

        const runtime = new Runtime({
            runtimeId,
            bus,
            boot: { bootMs: 0, processMs: 0, phases },
            store,
            streams,
            channels: hub,
            scheduler,
            ownsStore,
            owned: leases.owned,
        })

        runtime.#providers = [...providersByAgent.values()].flat()

        mark("channels", () => {
            for (const [index, entry] of loaded.entries()) {
                const agent = agents[index]
                if (agent === undefined) continue
                const bindings = buildChannels(entry, options)
                if (bindings.length > 0) hub.register(agent, bindings)
            }
        })

        for (const agent of agents) {
            if (runtime.#agents.has(agent.id)) {
                throw new Error(
                    `Two agents share the id "${agent.id}". ` +
                        "hint: agent ids are used in session keys and API paths, so they must be unique within a runtime.",
                )
            }
            runtime.#agents.set(agent.id, agent)

            // Whatever the budget trimmed, and whatever tool arrived without negative guidance, is
            // said out loud here. A catalogue quietly smaller than the manifest asked for is the
            // exact failure the loud resolution path exists to prevent.
            for (const warning of [...agent.warnings, ...agent.tools.warnings]) {
                bus.emit("agent.warning", warning, { agentId: agent.id })
            }

            bus.emit(
                "agent.loaded",
                {
                    tools: agent.tools.size,
                    skills: agent.skills?.skills.length ?? 0,
                    schedules: 0,
                    model: agent.manifest.model.main.id,
                },
                { agentId: agent.id },
            )
        }

        const bootMs = Math.round((performance.now() - startedAt) * 100) / 100
        const report: BootReport = {
            bootMs,
            processMs: Math.round(performance.now() * 100) / 100,
            phases,
        }
        Object.assign(runtime.boot, report)

        bus.emit("runtime.ready", {
            bootMs: report.bootMs,
            processMs: report.processMs,
            phases: report.phases,
            agents: agents.length,
        })

        // Channels connect here — after `runtime.ready`, never before. Awaited rather than detached
        // because `start()` is specified to return once a transport is *running*, which involves no
        // network for a long-poll and one `setWebhook` call for a webhook; a transport that cannot
        // start reports through the bus and leaves the rest of the runtime serving.
        if (options.startChannels === true) await hub.start()

        // Schedules are reconciled whether or not the timer runs, so `schedules` lists what the
        // manifest declares even under `run`. Nothing fires here: the acceptance criterion is that
        // an idle agent with schedules makes zero model calls until one comes due, and a catch-up
        // inside boot would break it on every start.
        for (const [index, entry] of loaded.entries()) {
            const agent = agents[index]
            if (agent === undefined) continue
            if (entry.manifest.schedules.length === 0) {
                // Still reconciled, so removing the last schedule from a manifest removes its row.
                await reconcileSchedules({
                    agentId: agent.id,
                    schedules: [],
                    store: store.schedules,
                    now: Date.now(),
                })
                continue
            }
            const report = await reconcileSchedules({
                agentId: agent.id,
                schedules: entry.manifest.schedules,
                store: store.schedules,
                now: Date.now(),
            })
            bus.emit(
                "schedules.reconciled",
                {
                    created: report.created.length,
                    updated: report.updated.length,
                    removed: report.removed.length,
                    total: entry.manifest.schedules.length,
                },
                { agentId: agent.id },
            )
        }

        if (options.startSchedules === true) await scheduler.start()

        // After readiness, so a timer never delays boot. `unref` because a heartbeat must not be
        // the reason a one-shot command fails to exit — the lease going stale is exactly the
        // recoverable state it is designed for, whereas a process that will not end is not.
        runtime.#startHeartbeat()

        // Slot 2 reports state, not configuration, so the agents are told what actually happened —
        // before any turn, which is what keeps the block byte-stable. Without this an agent under
        // `run` was told "channels: tg (telegram)" and concluded the Telegram runtime had died,
        // while running inside the very process that would have been polling.
        for (const agent of agents) {
            // `hub.started` and not `statusOf(...).length > 0`. The second is true of `run` as well,
            // because a binding is *registered* either way — so slot 2 was telling an agent under
            // `run` that its channel was connected in this session, which is exactly the sentence
            // decision 5.17 was written to stop it saying.
            agent.reportRuntimeState({
                channelsStarted: hub.started && hub.statusOf(agent.id).length > 0,
                // Same distinction as `channelsStarted`, and the same trap: a schedule is
                // *reconciled* under `run` as well, so "does this agent have schedules" and "is
                // anything going to fire them" are different questions and slot 2 answers the
                // second. Decision 5.17, whose own fix had to be fixed for exactly this reason.
                schedulerStarted: scheduler.started,
            })
        }

        // The first legal network call of the process, and deliberately not awaited. Awaiting it here
        // would put a remote round trip back inside `Runtime.create` — the boot cost this project
        // exists to remove — just on the far side of the event. So it runs detached and reports through
        // the bus, and a failure leaves the agent serving the catalogue it resolved from disk.
        for (const [agentId, providers] of providersByAgent) {
            const entry = loaded.find((item: LoadedManifest) => item.manifest.id === agentId)
            const slugs = entry?.manifest.tools.pinned ?? []
            for (const provider of providers) {
                // Most providers have nothing to fetch — `system` and `web` resolve from module
                // constants — so this skips them rather than requiring an empty implementation. With
                // several configured, each reports its own `tools.refreshed` and one failing leaves
                // the others alone.
                if (provider.refresh === undefined || slugs.length === 0) continue
                const from = performance.now()
                void provider
                    .refresh(slugs)
                    .then((result) => {
                        bus.emit(
                            "tools.refreshed",
                            {
                                provider: provider.id,
                                ok: true,
                                fetched: result.fetched,
                                changed: [...result.changed],
                                missing: [...result.missing],
                                latencyMs: Math.round(performance.now() - from),
                            },
                            { agentId },
                        )
                    })
                    .catch((error: unknown) => {
                        bus.emit(
                            "tools.refreshed",
                            {
                                provider: provider.id,
                                ok: false,
                                fetched: 0,
                                changed: [],
                                missing: [],
                                latencyMs: Math.round(performance.now() - from),
                                error: error instanceof Error ? error.message : String(error),
                            },
                            { agentId },
                        )
                    })
            }
        }

        return runtime
    }

    get ready(): boolean {
        return !this.#stopped
    }

    agent(id: string): Agent {
        const agent = this.#agents.get(id)
        if (agent === undefined) {
            const known = [...this.#agents.keys()].join(", ") || "(none)"
            throw new Error(`No agent with id "${id}". hint: this runtime hosts: ${known}.`)
        }
        return agent
    }

    list(): readonly Agent[] {
        return [...this.#agents.values()]
    }

    async stop(reason = "requested"): Promise<void> {
        if (this.#stopped) return
        this.#stopped = true
        this.bus.emit("runtime.stopping", { reason })

        // In-flight turns are deliberately not cancelled here — a turn ends because it finished or
        // because someone stopped it, never because the process was asked to wind down politely.
        // Their rows stay `running` and the next boot reaps them, which is the honest record of
        // what happened: the process went away mid-generation.
        this.streams.close()
        // Before the channels, because a schedule firing mid-shutdown would enqueue a delivery into
        // an outbox that is about to stop draining.
        await this.scheduler.stop()
        // Before the store closes, because stopping a transport can flush a final delivery and a
        // closed database would turn that into an exception during shutdown.
        await this.channels.stop()

        // Providers let go of anything outside the process — for `system`, the child processes
        // `exec` backgrounded rather than killed. Reported rather than silent: an orphan nobody
        // mentions is one nobody looks for, and thirty-three of them took a machine to a load
        // average of 351. One failing provider must not stop the others from cleaning up.
        //
        // Each is bounded, because every supervisor SIGKILLs eventually — launchd after
        // `ExitTimeOut`, a container after its grace period — and a provider that hangs would
        // consume the whole window and leave the *rest* unreaped. A reaper that does not fit in
        // the window is a reaper that does not run. Timing out is reported, never swallowed: the
        // whole point of this loop is that an orphan nobody mentions is one nobody looks for.
        for (const provider of this.#providers) {
            if (provider.stop === undefined) continue
            try {
                const released = await withDeadline(
                    provider.stop(),
                    STOP_DEADLINE_MS,
                    `Provider "${provider.id}" did not release its resources within ${STOP_DEADLINE_MS}ms.`,
                )
                if (released.length > 0) {
                    this.bus.emit("runtime.released", {
                        provider: provider.id,
                        released: [...released],
                    })
                }
            } catch (error) {
                this.bus.emit("agent.warning", {
                    code: "provider_stop_failed",
                    message: `Provider "${provider.id}" failed to release its resources: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    hint: "Anything it owns outside this process may still be running. For the system provider that means a backgrounded command — check with `ps` if the machine seems busy after exit. Under a service manager this is the window before SIGKILL, so a provider that times out here leaves its children behind.",
                })
            }
        }

        // Before the store closes, and best-effort: a lease left behind is recovered by the next
        // boot once its heartbeat goes stale, so failing to release is a delay rather than a
        // deadlock. Failing to *close the store* because releasing threw would be the worse bug.
        if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
        for (const agentId of this.#owned) {
            try {
                await this.store.leases.release(agentId, this.runtimeId)
            } catch {
                // Deliberately swallowed. See above: the next boot recovers a stale lease, and a
                // shutdown that throws here would skip closing the database.
            }
        }

        // Schedules arrive in Phase 8. A caller-supplied store is not closed here: it was open
        // before this runtime existed and may outlive it.
        if (this.#ownsStore) await this.store.close()
    }

    /** Agent ids this runtime holds the serving lease for. */
    get owned(): readonly string[] {
        return this.#owned
    }

    #startHeartbeat(): void {
        if (this.#owned.length === 0) return
        this.#heartbeat = setInterval(() => {
            const now = new Date().toISOString()
            for (const agentId of this.#owned) {
                // Fire and forget, and errors are ignored on purpose: a heartbeat that threw into
                // an unhandled rejection would take down a healthy process over a bookkeeping row.
                void this.store.leases.beat(agentId, this.runtimeId, now).catch(() => {})
            }
        }, LEASE_BEAT_MS)
        this.#heartbeat.unref?.()
    }
}

/**
 * How long one provider may take to let go before the runtime moves on without it.
 *
 * Sized against the shortest grace period a supervisor gives: launchd's `ExitTimeOut` defaults to
 * 20 seconds and a container's SIGTERM grace is commonly 10. Two providers each hanging for the
 * full window would exceed either, so this is deliberately well under half.
 */
const STOP_DEADLINE_MS = 5_000

/**
 * Resolve, or reject with a named failure, and never leave a timer holding the event loop open.
 *
 * The `finally` is the part that matters: an un-cleared `setTimeout` in a shutdown path is how a
 * process that has finished stopping sits there for another five seconds.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms)
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

function envOptions(options: RuntimeOptions): {
    env?: EnvSource
    knownProviders?: readonly string[]
    knownChannels?: readonly string[]
} {
    const known = Object.keys(options.toolProviders ?? {})
    const channels = Object.keys(options.channels ?? {})
    return {
        ...(options.env === undefined ? {} : { env: options.env }),
        // Passed even when empty, so the load-time check reports against what this runtime can
        // actually supply rather than against nothing at all.
        ...(known.length === 0 ? {} : { knownProviders: known }),
        ...(channels.length === 0 ? {} : { knownChannels: channels }),
    }
}

/**
 * Construct the agent's tool providers, in the order its manifest listed them.
 *
 * Each provider gets the *manifest's* directory and env rather than the process's: a resolution cache
 * belongs beside the agent it describes, and `process.cwd()` belongs to whoever launched the process
 * and moves depending on how they did it. Same reasoning as `ToolContext.dir`.
 *
 * Order is manifest order, and it is load-bearing: the registry consults providers in sequence and a
 * slug two of them both resolve is a collision it refuses — so the order decides which one is named
 * first in that failure, and nothing here may sort it into something tidier than what was written.
 */
function buildProviders(entry: LoadedManifest, options: RuntimeOptions): readonly ToolProvider[] {
    const factories = options.toolProviders ?? {}

    // The plan's warnings are deliberately not collected here. `Agent.create` reads them from the
    // same function, so they arrive on `agent.warnings` where a front end still finds them after
    // boot — the lesson from the trimmed-catalogue warning, which was emitted during boot into an
    // empty room for weeks.
    return resolveProviders(entry.manifest.tools).selections.map((selection) => {
        const factory = factories[selection.id]
        if (factory === undefined) throw toolProviderUnknown(selection.id, Object.keys(factories))
        return factory({
            dir: entry.dir,
            env: entry.env,
            config: selection.config,
            agentId: entry.manifest.id,
        })
    })
}

/**
 * Construct the agent's channel transports, in manifest order.
 *
 * The `type`-specific fields were deliberately not stripped by `ChannelSchema` — it is
 * `passthrough` — so the whole entry minus the four fields core owns is handed to the factory as
 * its config. A `type` with no registered factory fails here, during boot, next to the manifest
 * that named it: the alternative is a channel that constructs fine and silently never receives.
 *
 * **Exported because `validate` calls it too.** A channel factory reads its own config — a missing
 * `tokenEnv`, an invalid `mode` — and those are configuration mistakes knowable without a packet.
 * Left to boot alone, `validate` reported ok on a manifest `serve` refused, which is precisely the
 * asymmetry `ruleBudgetFailure` was split up to prevent. Constructing a transport allocates an
 * object and opens no socket, so a dry run costs nothing and the two callers cannot disagree.
 */
export function buildChannels(
    entry: LoadedManifest,
    options: { readonly channels?: Readonly<Record<string, ChannelFactory>> },
): readonly ChannelBinding[] {
    const factories = options.channels ?? {}
    const seen = new Set<string>()

    const bindings: ChannelBinding[] = []
    for (const channel of entry.manifest.channels) {
        if (seen.has(channel.id)) {
            throw new HarnessError({
                code: "channel_id_duplicate",
                message: `Agent "${entry.manifest.id}" declares two channels with id "${channel.id}".`,
                hint: "Channel ids become the channel segment of a session key and the path segment of a webhook URL, so they must be unique within an agent.",
                field: `channels[${channel.id}]`,
            })
        }
        seen.add(channel.id)

        // A disabled channel is not constructed. Its factory would read config it will never use,
        // and a factory that refuses — a `tokenEnv` naming an unset variable — would make it
        // impossible to switch a broken channel off, which is the one thing `enabled: false` is
        // for. Its `type` is still checked above, because a typo there is a typo either way.
        const factory = factories[channel.type]
        if (factory === undefined) throw channelTypeUnknown(channel.type, Object.keys(factories))
        if (!channel.enabled) continue

        const {
            type: _type,
            id: _id,
            allowFrom: _allowFrom,
            enabled: _enabled,
            ...config
        } = channel
        const transport = factory({
            agentId: entry.manifest.id,
            dir: entry.dir,
            env: entry.env,
            config,
            id: channel.id,
        })

        bindings.push({
            transport,
            ...(channel.allowFrom === undefined ? {} : { allowFrom: channel.allowFrom }),
            enabled: channel.enabled,
        })
    }

    return bindings
}

/**
 * Resolve the `store` option to an open store.
 *
 * The parent directory is created because the alternative — refusing to boot until the operator
 * runs `mkdir` — is a worse first-run experience for no safety gain. A path that cannot be
 * created is still a hard failure naming the path.
 */
async function openStore(options: RuntimeOptions): Promise<{ store: Store; ownsStore: boolean }> {
    const source = options.store

    if (typeof source === "object") return { store: source, ownsStore: false }

    const path =
        source === undefined || source === ":memory:"
            ? ":memory:"
            : isAbsolute(source)
              ? source
              : resolve(options.dir ?? process.cwd(), source)

    if (path !== ":memory:") {
        const dir = dirname(path)
        try {
            mkdirSync(dir, { recursive: true })
        } catch (cause) {
            throw new HarnessError({
                code: "store_dir_uncreatable",
                message: `Cannot create the directory ${dir} for the session database.`,
                hint: `Check permissions on the parent directory, or point Runtime's store option at a writable path. In a read-only container, use ":memory:" and accept that sessions do not survive a restart.`,
                cause,
            })
        }
    }

    return { store: await SqliteStore.open({ path }), ownsStore: true }
}
