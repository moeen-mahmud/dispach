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
import { brokenTransport, type ChannelBinding } from "../channels/channel.ts"
import {
    channelFactoryFailed,
    channelTransportMismatch,
    channelTypeUnknown,
    type ErrorDetail,
    HarnessError,
    isHarnessError,
    toolProviderUnknown,
} from "../errors.ts"
import { EventBus } from "../events/bus.ts"
import type { EnvSource } from "../manifest/env.ts"
import { type ManifestHeader, readManifestHeader } from "../manifest/header.ts"
import { type LoadedManifest, loadManifest, loadManifestFromObject } from "../manifest/load.ts"
import { resolveProviders } from "../manifest/providers.ts"
import type { TeamMemberConfig } from "../manifest/schema.ts"
import type { FetchLike } from "../model/provider.ts"
import { agentPluginSupply, type BuiltInPlugins, type LoadedPlugin } from "../plugins/loader.ts"
import { type Middleware, notify } from "../plugins/middleware.ts"
import { Scheduler } from "../schedule/scheduler.ts"
import { TurnStreams, type TurnStreamsOptions } from "../store/buffer.ts"
import { SqliteStore } from "../store/sqlite/store.ts"
import type { DeliveryBacklog, LeaseRecord, RuntimeMode, Store } from "../store/store.ts"
import { expandTeams } from "../team/expand.ts"
import type { HandoffTarget } from "../team/handoff.ts"
import { handoffTool } from "../team/supervisor.ts"
import type { ApprovalRequest } from "../tools/execute.ts"
import { ToolRegistry } from "../tools/registry.ts"
import type { ScriptRunner, Tool, ToolProvider, ToolProviderFactory } from "../tools/types.ts"
import { VERSION } from "../version.ts"
import {
    EMPTY_ALLOWLIST,
    parseWebhookAllowlist,
    type WebhookAllowlist,
    WebhookDispatcher,
} from "../webhooks/webhooks.ts"
import { Agent } from "./agent.ts"
import { type ChannelFactory, ChannelHub } from "./channels.ts"
import { claimLeases, LEASE_BEAT_MS } from "./lease.ts"
import { reconcileSchedules, scheduleRunner, scheduleRunOfSession } from "./schedules.ts"

export type AgentSource = string | Record<string, unknown>

/**
 * Why an agent stopped being hosted, carried on `agent.disposed`.
 *
 * Three values rather than a boolean because they read differently to a client watching the stream:
 * `replaced` is the same agent arriving again a moment later and a UI should hold its place, where
 * `requested` and `stopped` are it going away. `stopped` is 16.3's durable off switch and has no
 * caller yet — declared here because the event is append-only within `v: 1` and adding a variant to
 * a shipped union is the expensive version of this.
 */
export type DisposeReason = "requested" | "replaced" | "stopped"

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
    /** Bring your own bus, to subscribe before boot events fire. */
    readonly bus?: EventBus
    /**
     * Per-turn event buffer limits.
     *
     * The cap is a memory bound, and memory is the embedder's to decide: a host serving one
     * conversation at a time wants a generous one, and a host with a thousand wants the opposite.
     * Defaults are in `TurnStreams` and are right for a single container.
     */
    readonly streams?: TurnStreamsOptions
    /**
     * How to ask a person, for every agent this runtime hosts.
     *
     * `ToolContext.approve` has existed since Phase 3 and **nothing anywhere filled it** — a grep
     * for callers found only the definition — so `tools.untrusted.onMutate: "confirm"` has been
     * unreachable and `tools.policy` rules with `ask` fell to `onNoApprover`. This is the seam a
     * front end supplies, and supplying it is also what silences the `confirm_without_approver`
     * warning, which `Agent.create` keys on this being absent.
     *
     * Runtime-wide rather than per-agent because the thing that can ask is a property of the
     * *surface* — a terminal, an HTTP client, a queue — not of which agent is running. An embedder
     * hosting two agents behind one UI has one approver.
     *
     * Absent means nobody is reachable, which is the honest state for a schedule, a pipe, or an
     * unattended container, and `tools.policy.onNoApprover` decides what `ask` means there.
     */
    readonly approve?: (request: ApprovalRequest) => Promise<boolean>
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
     * Plugins this host can resolve by name without importing anything, keyed by the specifier a
     * manifest writes.
     *
     * The registry exists for a structural reason rather than for speed. A module imported both
     * statically and dynamically makes `bun build --splitting` emit its exports twice and the bundle
     * stops parsing — so a binary that statically imports the first-party packages cannot also
     * `import()` them by name. Registering them here keeps each module imported exactly one way, and
     * a manifest still names the package it means.
     *
     * Anything not here is imported from beside the agent. Nothing is ever installed (hard rule 5).
     */
    readonly builtInPlugins?: BuiltInPlugins
    /**
     * Directory holding installed plugins, one per subdirectory — the middle of the loader's three
     * lookups, and absent to skip it.
     *
     * The host's, never derived here: the CLI owns every sandbox path so a test can redirect them.
     */
    readonly pluginRoot?: string
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

/**
 * Everything an agent can be *supplied* with, after its plugins have registered.
 *
 * Separate from `RuntimeOptions` because it is per agent: two agents in one process can name
 * different plugins, so "which channel types exist" stops being a property of the runtime the
 * moment plugins land. Every consumer takes this rather than the options object, which is what
 * stops one of them reading the host's map while another reads the merged one.
 */
export interface AgentSupply {
    readonly toolProviders: Readonly<Record<string, ToolProviderFactory>>
    readonly channels: Readonly<Record<string, ChannelFactory>>
    readonly scriptRunner: ScriptRunner | undefined
    readonly middleware: readonly Middleware[]
    /** Plugins this agent named that did not load, carried so they reach `agent.warnings`. */
    readonly failedPlugins?: readonly ErrorDetail[]
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

/** `Runtime.activity`: what an external waker needs to suspend a process and wake it in time. */
export interface RuntimeActivity {
    readonly idle: boolean
    readonly turnsRunning: number
    readonly deliveries: { readonly outbox: DeliveryBacklog; readonly webhooks: DeliveryBacklog }
    /** ISO time; absent when nothing is scheduled or owed. May be in the past: due now. */
    readonly nextWakeAt?: string
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
    /**
     * What each agent's `plugins:` loaded, by agent id, in manifest order.
     *
     * Surfaced rather than kept internal because the loader's whole output is otherwise invisible:
     * `plugin.loaded` fires during boot, which finishes before any command can subscribe — the
     * empty-room trap this repo has hit with boot warnings and with a trimmed catalogue. Anything
     * true for the life of the process belongs where a person can still read it afterwards.
     *
     * Empty for an agent that names none, rather than absent, so a caller never has to distinguish
     * "no plugins" from "not an agent here".
     */
    readonly plugins: ReadonlyMap<string, readonly LoadedPlugin[]>
    readonly scheduler: Scheduler
    /** Outbound webhooks. Call `changed()` after writing a subscription. */
    readonly webhooks: WebhookDispatcher

    /**
     * Every tool provider constructed, **by agent id**. Held so `stop` can tell each one to let go.
     *
     * A provider can own an OS process — `exec` backgrounds a long command rather than discarding
     * it — and before this there was nothing to tell it the runtime was leaving. See
     * `ToolProvider.stop`.
     *
     * Keyed rather than flattened, which it was until `dispose` existed. The flattened copy could
     * only answer "stop everything", so disposing one agent either left its backgrounded `exec`
     * children unreaped — the failure that once took a machine to a load average of 351 — or reaped
     * every other agent's with it. The map was already built this way inside `create`; only the
     * copy kept on the runtime threw the keys away.
     */
    #providersByAgent = new Map<string, readonly ToolProvider[]>()

    #agents = new Map<string, Agent>()
    /**
     * The source each **root** agent was loaded from, so `replace` can reload it.
     *
     * Roots only: a team member's source is its supervisor's manifest, and `replace` addresses the
     * supervisor. A path re-reads from disk, which is the point. An object-form manifest re-adopts
     * the same object — honest rather than useful, and said out loud in `replace`, because an
     * embedder that wants new settings has the new object and can pass it.
     */
    #sources = new Map<string, AgentSource>()
    /** Plugin `onEvent` subscriptions, by agent id. See `prepareAgents`. */
    #unwatch = new Map<string, () => void>()
    /**
     * Where this runtime serves HTTP, once something has told it. See `publishAddress`.
     *
     * Held as well as written, because `adopt` claims a *new* lease row and that row has to carry
     * the address too — otherwise an agent provisioned into a running host is the one agent
     * `stop` cannot reach, which is the reverse of what provisioning is for.
     */
    #baseUrl: string | undefined
    /**
     * Agents that exist only to receive handoffs, excluded from `list()`.
     *
     * A member is an implementation detail of its supervisor, and an addressable one is a route
     * around whatever policy the supervisor carries — its catalogue may be wider, and nothing would
     * have asked the supervisor. Every HTTP route resolves through `withAgent`, which reads
     * `list()`, so filtering here closes the served surface without a second concept.
     *
     * `agent(id)` still resolves a member, deliberately: the handoff runner needs it, and the
     * boundary being drawn is the served surface rather than the process.
     */
    #members = new Set<string>()
    /** A supervisor's declared members, by supervisor id. Empty for an agent with no team. */
    #teams = new Map<string, readonly TeamMemberConfig[]>()
    #stopped = false
    /** False when the caller passed an already-open store, which stays theirs to close. */
    #ownsStore: boolean
    /** Agent ids this runtime holds a lease for — released on stop, refreshed while alive. */
    #owned: string[] = []
    /**
     * Whether a lease another process holds is fatal for this runtime. Fixed at `create`.
     *
     * Recorded rather than recomputed because `adopt` has to answer the same question and has no
     * `startChannels` flag to read: whether this host refuses an agent somebody else is serving is
     * a property of the *host*, not of the call that added the agent. A served process that adopted
     * an agent held elsewhere would be the second poller on one bot token — which is the whole of
     * what the lease exists to prevent, whether the agent arrived at boot or ten minutes later.
     */
    #exclusive: boolean
    /**
     * The options this runtime was created with, so `adopt` builds an agent the same way boot did.
     *
     * Retained rather than destructured into fields because every one of them is an input to the
     * pipeline an adopted agent goes through — the provider and channel factories, the plugin
     * registry, the approver, the script runner, `fetch`, `env`, `dir`, `mode`, `lease`. Copying
     * nine of them onto the class and forgetting the tenth is the conditional-spread shape that has
     * cost this repo six debugging rounds; holding the object means an option added to
     * `RuntimeOptions` reaches adoption with nothing to remember.
     *
     * `agents` is the one field that is *not* about this runtime's future: it is what boot was asked
     * for, and `adopt` passes its own source instead.
     */
    #options: RuntimeOptions
    /**
     * Leases another **live** process holds, for the agents this runtime was asked for.
     *
     * Read by `serve` to say which agents it is *not* hosting. Populated on both paths and meaning
     * slightly different things: under `run` these agents are still loaded and usable, and slot 2
     * tells them they are served elsewhere; under `serve` they are excluded from the hosted set,
     * because a second poller on one bot token is the failure the lease exists to prevent.
     */
    #declined: LeaseRecord[] = []
    #heartbeat: ReturnType<typeof setInterval> | undefined

    private constructor(init: {
        runtimeId: string
        bus: EventBus
        boot: BootReport
        store: Store
        streams: TurnStreams
        channels: ChannelHub
        plugins: ReadonlyMap<string, readonly LoadedPlugin[]>
        scheduler: Scheduler
        webhooks: WebhookDispatcher
        ownsStore: boolean
        owned: readonly string[]
        declined: readonly LeaseRecord[]
        exclusive: boolean
        options: RuntimeOptions
    }) {
        this.runtimeId = init.runtimeId
        this.bus = init.bus
        this.boot = init.boot
        this.store = init.store
        this.streams = init.streams
        this.channels = init.channels
        this.plugins = init.plugins
        this.scheduler = init.scheduler
        this.webhooks = init.webhooks
        this.#ownsStore = init.ownsStore
        this.#owned = [...init.owned]
        this.#declined = [...init.declined]
        this.#exclusive = init.exclusive
        this.#options = init.options
    }

    static async create(options: RuntimeOptions): Promise<Runtime> {
        const startedAt = performance.now()
        const runtimeId = options.runtimeId ?? `rt_${Date.now().toString(36)}`
        const bus =
            options.bus ??
            new EventBus({
                runtimeId,
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
        const streams = new TurnStreams(options.streams ?? {})
        streams.listen(bus)

        const prepared = await prepareAgents({
            sources: options.agents,
            options,
            bus,
            mark,
            markAsync,
        })
        const loaded = prepared.loaded

        // 2. Store: open the file, run pending migrations, reap turns a dead process left running.
        //    Disk only — a database file is not network I/O, so this belongs before readiness.
        const { store, ownsStore } = await markAsync("store", () => openStore(options))

        // Claim before recovering anything. Recovery is scoped to what this process owns, because
        // two runtimes can share a store file and the unscoped version marked the *other* one's
        // live turn failed and made it re-send a delivery it had already sent.
        // Only a runtime about to open a channel refuses a conflict. A REPL or a one-shot has always
        // been allowed alongside another and simply recovers nothing.
        const exclusive = options.startChannels === true
        const leases =
            options.lease === false
                ? { owned: [], tookOver: [], declined: [] }
                : await claimLeases({
                      store,
                      agentIds: loaded.map((entry) => entry.manifest.id),
                      runtimeId,
                      mode: options.mode ?? "embedded",
                      now: Date.now(),
                      exclusive,
                  })

        /**
         * What this runtime actually hosts, which is not always what it was asked to load.
         *
         * **Under `exclusive` a declined agent is dropped rather than hosted.** `claimLeases` used
         * to throw on the first conflict, so this case could not arise: one agent held elsewhere
         * refused the whole boot. That is right for one agent and wrong for several — a host asked
         * for five with one held elsewhere took the other four down with it — so the claim now
         * refuses only when it has *nothing* left to serve, and the agent it could not claim is
         * excluded here. Hosting it anyway would be the second poller on one bot token that the
         * lease exists to prevent.
         *
         * Filtered at exactly this point, before anything downstream is built: providers, agents and
         * channel bindings are assembled as parallel arrays zipped by index against this list, so a
         * filter applied later would pair an agent with another agent's providers.
         *
         * Not filtered when the runtime is **not** exclusive: a REPL alongside a `serve` is a
         * supported thing to do, and slot 2 tells that agent it is `servedElsewhere` rather than
         * pretending it does not exist.
         */
        const hosted =
            exclusive && leases.declined.length > 0
                ? loaded.filter((entry) => leases.owned.includes(entry.manifest.id))
                : loaded
        /**
         * Which source each hosted root came from, for `replace`.
         *
         * Roots only, and hosted ones only: a declined agent is not ours to reload, and a team
         * member's source is the supervisor's manifest. `loaded` is the roots plus their expanded
         * members, so indexing `options.agents` against `prepared.loaded` would pair a member with
         * whatever source happened to sit at its index — which is exactly the parallel-arrays trap
         * `hosted` is filtered early to avoid.
         */
        const sources = new Map<string, AgentSource>()
        for (const [index, source] of options.agents.entries()) {
            // `expandTeams` pushes every root before any member, so the first `agents.length`
            // entries of `loaded` are the roots in the order they were asked for.
            const entry = loaded[index]
            if (entry === undefined) continue
            if (hosted.includes(entry)) sources.set(entry.manifest.id, source)
        }

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
        const built = await markAsync("tools", () =>
            Promise.all(
                hosted.map((entry: LoadedManifest) =>
                    buildRegistry(entry, prepared.supplyFor(entry.manifest.id)),
                ),
            ),
        )
        const registries = built.map((one) => one.registry)
        for (const [index, entry] of hosted.entries()) {
            const providers = built[index]?.providers ?? []
            if (providers.length > 0) providersByAgent.set(entry.manifest.id, providers)
        }

        // 4. Channels: construct transports. Allocating one opens no socket — `start()` does, and
        //    that is called after readiness, below.
        //
        //    **Before the agents, and that ordering is what makes a broken channel reportable.** A
        //    channel that cannot be built is a warning rather than a refusal, and a boot warning has
        //    to be *readable off the agent* — `Runtime.create` finishes before anything can
        //    subscribe to the bus, which is the empty room this repo has lost boot warnings to
        //    twice. So the bindings are built first and their failures handed to `Agent.create`.
        const channelBindings = mark("channels", () =>
            hosted.map((entry: LoadedManifest) =>
                buildChannels(entry, prepared.supplyFor(entry.manifest.id)),
            ),
        )

        // 5. Agents: identity files, capability resolution, provider construction. Still no network
        //    — constructing a provider allocates no socket.
        const agents = mark("agents", () =>
            hosted.map((entry: LoadedManifest, index) =>
                instantiateAgent({
                    entry,
                    supply: prepared.supplyFor(entry.manifest.id),
                    registry: registries[index],
                    team: prepared.teams.get(entry.manifest.id),
                    // Resolved per call. `runtime` is assigned below this block, so this
                    // closure cannot be evaluated eagerly either.
                    resolveMember: (id) => runtime.agent(id),
                    // Channels and plugins together: both are optional capabilities whose failure
                    // is a warning, and `agent.warnings` is the one array every surface reads.
                    warnings: [
                        ...(prepared.supplyFor(entry.manifest.id).failedPlugins ?? []),
                        ...(built[index]?.warnings ?? []),
                        ...brokenChannels(channelBindings[index] ?? []),
                    ],
                    options,
                    bus,
                    store,
                }),
            ),
        )

        const hub = new ChannelHub({ bus, outboxStore: store.outbox })

        /**
         * Built before the runtime so it can be handed in, and it arms nothing until `start()`.
         *
         * **Both closures read `runtime.all()`, not the `agents` array built above.** They read the
         * array until `adopt` existed, and the array is fixed at boot — so an adopted agent's
         * schedules were never queried as due and a disposed agent's still were, which is the
         * `Schedule "x" belongs to agent "x", which this runtime is not hosting` throw arriving on a
         * timer with nobody watching. The array is the *set this boot loaded*; the runtime's map is
         * the set hosted right now, and only the second is the question either closure is asking.
         *
         * `runtime` is assigned below this block and referenced inside a closure rather than called,
         * which is the same lazy resolution the team `handoff` tool uses a few lines up for the same
         * reason: the thing being built is an input to the thing it needs.
         */
        // Annotated for the reason the `handoff` getter below is: both closures read `runtime`,
        // whose type comes from a constructor call taking *this* value, so an inferred type here
        // is circular and TypeScript reports it as five `implicitly has any` errors elsewhere.
        const scheduler: Scheduler = new Scheduler({
            store: store.schedules,
            bus,
            agentIds: () => runtime.all().map((agent) => agent.id),
            run: scheduleRunner({ agents: () => runtime.all(), hub }),
        })

        /**
         * Outbound webhooks. Listening now costs nothing (enqueueing is a row); sending waits for
         * `runtime.ready` below. The allowlist is the operator's, from the environment: a malformed
         * one is a warning and "public only", the safe direction, never a failed boot.
         */
        const allowVar = `${BRAND.envPrefix}WEBHOOK_ALLOW`
        let allow: WebhookAllowlist = EMPTY_ALLOWLIST
        try {
            allow = parseWebhookAllowlist((options.env ?? process.env)[allowVar], allowVar)
        } catch (error) {
            bus.emit("agent.warning", {
                code: isHarnessError(error) ? error.code : "webhook_allowlist_invalid",
                message: error instanceof Error ? error.message : String(error),
                hint: isHarnessError(error)
                    ? error.hint
                    : "Webhooks go to the public internet only until the list is fixed.",
            })
        }
        const webhooks: WebhookDispatcher = new WebhookDispatcher({
            store: store.webhooks,
            bus,
            fetch: options.fetch ?? globalThis.fetch,
            allow,
            agents: () => runtime.all().map((agent) => agent.id),
            userAgent: `${BRAND.name}/${VERSION}`,
        })
        await webhooks.attach()

        const runtime: Runtime = new Runtime({
            runtimeId,
            bus,
            boot: { bootMs: 0, processMs: 0, phases },
            store,
            streams,
            channels: hub,
            plugins: prepared.plugins,
            scheduler,
            webhooks,
            ownsStore,
            owned: leases.owned,
            declined: leases.declined,
            exclusive,
            options,
        })

        runtime.#providersByAgent = providersByAgent
        runtime.#sources = sources

        for (const [index] of hosted.entries()) {
            const agent = agents[index]
            const bindings = channelBindings[index]
            if (agent === undefined || bindings === undefined) continue
            if (bindings.length > 0) hub.register(agent, bindings)
        }

        // Before the registration loop, so `list()` is already correct the first time anything reads
        // it — including the `agent.loaded` events emitted inside that loop.
        for (const id of prepared.memberIds) runtime.#members.add(id)
        for (const [id, team] of prepared.teams) runtime.#teams.set(id, team)
        for (const [id, off] of prepared.unwatch) runtime.#unwatch.set(id, off)

        for (const agent of agents) runtime.#admit(agent)

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
        for (const [index, entry] of hosted.entries()) {
            const agent = agents[index]
            if (agent === undefined) continue
            await runtime.#reconcile(entry, agent.id)
        }

        // A scheduled run's delivery fails *after* the run finished — `hub.deliver` enqueues and the
        // outbox sends on a later tick — so the only status the scheduler can write at the time is
        // `ok`. Subscribed unconditionally, not behind `startSchedules`: the outbox drains under
        // `run` too, and a failure recorded nowhere is the whole defect this closes.
        bus.on("delivery.failed", (event) => {
            if (event.type !== "delivery.failed") return
            const agentId = event.agentId
            const sessionKey = event.sessionKey
            if (agentId === undefined || sessionKey === undefined) return
            const run = scheduleRunOfSession(sessionKey)
            if (run === undefined) return
            const detail = event.data.error
            void store.schedules
                .markDeliveryFailed(
                    agentId,
                    run.id,
                    run.runId,
                    `${detail.code}: ${detail.message}`,
                    new Date().toISOString(),
                )
                .catch((cause: unknown) => {
                    // Never swallowed. The delivery has already failed; losing the record of *why*
                    // is what leaves `schedules` reporting `ok` on a schedule that delivers nothing.
                    bus.emit(
                        "agent.warning",
                        {
                            code: "schedule_delivery_status_unwritten",
                            message: `Delivery for schedule "${run.id}" failed and the outcome could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}`,
                            hint: "`schedules` will still report the run as ok. The delivery failure itself is on the bus as delivery.failed and in the outbox row.",
                        },
                        { agentId },
                    )
                })
        })

        if (options.startSchedules === true) await scheduler.start()

        // After readiness: sending is network I/O. Recovery first, so a delivery a dead process
        // left in flight goes out again under the same `webhook-id` and is flagged uncertain.
        await webhooks.start()

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
                brokenChannels: hub.brokenOf(agent.id),
                channelsStarted: hub.started && hub.statusOf(agent.id).length > 0,
                // The third state, and the reason the other two read as a lie without it.
                //
                // "Not in this session" is true of a REPL and says nothing about the `serve` running
                // in the next terminal — so an agent asked to schedule something answered, correctly
                // and uselessly, that only `serve` starts the scheduler. It was already being served.
                // `declined` is exactly this fact and had been computed and read by *nothing* since
                // leases landed: it holds the leases another **live** process is holding, and it is
                // only ever populated here because a runtime that is about to open a channel refuses
                // instead. `run.ts`'s `supervision()` reaches the same conclusion from the same rows
                // for `/status`, which is how the gap was visible there and invisible here.
                //
                // No pid, deliberately. Slot 2 is frozen at first use, so a pid is a fact at boot and
                // a guess by turn forty — and a dead pid presented as live is the looks-live-and-is-not
                // failure the rest of this block exists to prevent.
                servedElsewhere: leases.declined.some((held) => held.agentId === agent.id),
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
            const entry = hosted.find((item: LoadedManifest) => item.manifest.id === agentId)
            refreshProviders({
                agentId,
                providers,
                slugs: entry?.manifest.tools.pinned ?? [],
                bus,
            })
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

    /**
     * The agents this runtime **serves** — team members excluded.
     *
     * Not a filtered view of an internal list for convenience: this is the served surface, and
     * `withAgent` in the server reads it, so a member is unreachable over HTTP by construction
     * rather than by every route remembering to check.
     */
    list(): readonly Agent[] {
        return [...this.#agents.values()].filter((agent) => !this.#members.has(agent.id))
    }

    /** Every agent, members included. For a caller that needs the whole process, not the surface. */
    all(): readonly Agent[] {
        return [...this.#agents.values()]
    }

    /**
     * Whether this process may be suspended now, and when it must be woken.
     *
     * For an **external** waker — a control plane that suspends idle silos. Nothing here suspends
     * anything. `idle` means no turn is running, no delivery is on the wire, and none is due yet;
     * `nextWakeAt` is the earliest of a schedule's due time and a pending delivery's retry. A late wake
     * is safe: the scheduler re-reads the wall clock when it fires, so a schedule overdue by the length
     * of a suspension runs once under its own late-fire policy, not once per missed timer.
     *
     * Schedules count only while the scheduler is started: under `run` nothing would fire them, and a
     * wake time nothing acts on would keep a waker waking a process for no reason.
     *
     * What this cannot see is a channel holding a connection open. A Telegram long-poll suspended is a
     * bot that answers late, not one that loses messages — Telegram holds updates — but a hosted
     * deployment that suspends wants `mode: webhook`, which needs no process awake to receive.
     */
    async activity(now = Date.now()): Promise<RuntimeActivity> {
        const ids = this.all().map((agent) => agent.id)
        const turnsRunning = this.all().reduce((sum, agent) => sum + agent.inFlight, 0)
        const [outbox, webhooks, schedule] = await Promise.all([
            this.store.outbox.backlog(ids),
            this.store.webhooks.backlog(ids),
            this.scheduler.started ? this.store.schedules.nextDue(ids) : Promise.resolve(undefined),
        ])
        const candidates = [schedule, outbox.nextAttemptAt, webhooks.nextAttemptAt].filter(
            (at): at is string => at !== undefined,
        )
        const nextWakeAt = candidates.sort()[0]
        const dueNow = nextWakeAt !== undefined && Date.parse(nextWakeAt) <= now
        return {
            idle: turnsRunning === 0 && outbox.inflight === 0 && webhooks.inflight === 0 && !dueNow,
            turnsRunning,
            deliveries: { outbox, webhooks },
            ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
        }
    }

    /**
     * An agent's declared team, for introspection.
     *
     * Exposed so a member is *observable* without being addressable: `GET /v1/agents/:id` can
     * report who this agent delegates to, which is the debugging value of listing members, without
     * offering a route that runs one directly.
     */
    team(id: string): readonly TeamMemberConfig[] {
        return this.#teams.get(id) ?? []
    }

    /**
     * Put a built agent into the hosted map and say so.
     *
     * One place, called by boot and by `adopt`, because the duplicate-id check and the two events
     * are the entire contract of "this runtime now hosts this agent" — and an adopted agent that
     * emitted no `agent.loaded` would be invisible to every client watching the stream, which for
     * an always-on server is the provisioning path's only completion signal.
     */
    #admit(agent: Agent): void {
        if (this.#agents.has(agent.id)) {
            throw new Error(
                `Two agents share the id "${agent.id}". ` +
                    "hint: agent ids are used in session keys and API paths, so they must be unique within a runtime.",
            )
        }
        this.#agents.set(agent.id, agent)

        // Whatever the budget trimmed, and whatever tool arrived without negative guidance, is
        // said out loud here. A catalogue quietly smaller than the manifest asked for is the
        // exact failure the loud resolution path exists to prevent.
        for (const warning of [...agent.warnings, ...agent.tools.warnings]) {
            this.bus.emit("agent.warning", warning, { agentId: agent.id })
        }

        this.bus.emit(
            "agent.loaded",
            {
                tools: agent.tools.size,
                skills: agent.skills?.skills.length ?? 0,
                // The **manifest's declared** count, not the store's. This event fires before
                // reconciliation has run, so the reconciled number does not exist yet and
                // reporting a store read would give whatever the *previous* boot left behind — a
                // figure about a process that has exited. `GET /v1/agents/:id` reports the
                // reconciled count instead, and the spec says which is which. It was the literal
                // `0`, which was neither.
                schedules: agent.manifest.schedules.length,
                model: agent.manifest.model.main.id,
            },
            { agentId: agent.id },
        )
    }

    /**
     * Bring one agent's manifest-owned schedule rows in line with its manifest.
     *
     * Called with an **empty** list too, which is the half worth keeping in one place: that is how
     * removing the last schedule from a manifest removes its row. `sourcePath` is what keeps it
     * from also removing a same-id agent's schedules from another directory — the defect that took
     * a 15-minute schedule to "never fires, nothing reports a fault".
     */
    async #reconcile(entry: LoadedManifest, agentId: string): Promise<void> {
        const report = await reconcileSchedules({
            agentId,
            schedules: entry.manifest.schedules,
            store: this.store.schedules,
            now: Date.now(),
            sourcePath: entry.path,
        })
        if (entry.manifest.schedules.length === 0) return
        this.bus.emit(
            "schedules.reconciled",
            {
                created: report.created.length,
                updated: report.updated.length,
                removed: report.removed.length,
                total: entry.manifest.schedules.length,
            },
            { agentId },
        )
    }

    /**
     * Host an agent that was not part of this runtime's boot.
     *
     * This is what "always on" means in one method: provisioning writes a manifest and calls this,
     * and the agent is **live before the call returns** — leased, served by `/v1`, channels started,
     * schedules reconciled and armed. No restart, and nothing else disturbed. The alternative shape
     * — write the file and restart the process — drops every other agent's in-flight turn to add
     * one, which is why `POST /reload` answers 501 rather than doing it.
     *
     * Runs the identical pipeline `create` does, by calling the identical functions: `prepareAgents`
     * (plugins, manifest, teams), `buildRegistry`, `instantiateAgent`, `#admit`, `#reconcile`,
     * `refreshProviders`. A manifest this refuses is one `create` would have refused, and the other
     * way round — which matters more here than anywhere, because the caller is a provisioning route
     * and "it worked from the API and the container will not start" is the failure mode.
     *
     * Returns the adopted agents: a `team:` manifest adopts its supervisor **and** its members, so
     * one source can be several agents, and only the supervisor is in `list()`.
     *
     * Channels start only if the hub has already been started — `startAgent` is a no-op otherwise —
     * so adopting into a `run`-mode runtime adds an agent without quietly opening a long-poll, the
     * same distinction `startChannels` draws at boot. Same for the scheduler: its timer is already
     * running or it is not, and it re-reads `all()` on every arm, so an adopted schedule is picked
     * up with nothing to notify.
     */
    async adopt(source: AgentSource): Promise<readonly Agent[]> {
        if (this.#stopped) {
            throw new HarnessError({
                code: "runtime_stopped",
                message: "This runtime has been stopped, so it cannot adopt an agent.",
                hint: "Adoption adds an agent to a *running* host. A stopped runtime has closed its store and released its leases; build a new one with Runtime.create.",
            })
        }

        const pass = <T>(_name: string, work: () => T): T => work()
        const prepared = await prepareAgents({
            sources: [source],
            options: this.#options,
            bus: this.bus,
            mark: pass,
            markAsync: async (_name, work) => await work(),
        })

        // Before the lease claim, because claiming for an agent we already host succeeds — the
        // lease is keyed by agent id and this runtime already owns the row — so the duplicate would
        // only surface in `#admit`, after the providers were constructed and a plugin's `setup()`
        // had run. `replace` is the operation that means "this id again".
        for (const entry of prepared.loaded) {
            if (!this.#agents.has(entry.manifest.id)) continue
            for (const off of prepared.unwatch.values()) off()
            throw new HarnessError({
                code: "agent_already_hosted",
                message: `This runtime already hosts an agent with id "${entry.manifest.id}".`,
                hint: "Use replace(agentId) to reload it from its manifest, or change the id. Two agents with one id would share session keys, API paths and every store row keyed by agent.",
                field: "id",
            })
        }

        /**
         * A stopped agent is not adopted, however it is asked for.
         *
         * The durable switch has to be honoured on *this* path too, or provisioning is a way round
         * it: `POST /v1/agents/:id/start` enables the agent and then adopts, so the refusal never
         * fires for the one caller that means to reverse a stop, and fires for every caller that
         * does not know about one. Refused rather than silently skipped, because `adopt` was asked
         * for a specific agent and returning an empty list would read as success.
         */
        const stopped = await this.store.agentState.disabledAmong(
            prepared.loaded.map((entry) => entry.manifest.id),
        )
        if (stopped.length > 0) {
            for (const off of prepared.unwatch.values()) off()
            const first = stopped[0] ?? ""
            const state = await this.store.agentState.get(first)
            throw new HarnessError({
                code: "agent_stopped",
                message: `Agent "${first}" is stopped${
                    state?.reason === undefined ? "" : ` (${state.reason})`
                }, so it will not be hosted.`,
                hint: `\`${BRAND.slug} start ${first}\` switches it back on. A stop persists across restarts on purpose — that is the whole difference between it and killing the process.`,
            })
        }

        const leases =
            this.#options.lease === false
                ? { owned: [], tookOver: [], declined: [] }
                : await claimLeases({
                      store: this.store,
                      agentIds: prepared.loaded.map((entry) => entry.manifest.id),
                      runtimeId: this.runtimeId,
                      mode: this.#options.mode ?? "embedded",
                      now: Date.now(),
                      // The host's property, not the call's. See `#exclusive`.
                      exclusive: this.#exclusive,
                  })

        // Same filter as boot, and the same reason: hosting an agent another live process holds is
        // the second poller on one bot token. A single declined agent under `exclusive` never
        // reaches here — `claimLeases` throws when it has nothing left to own — so this only drops
        // a *member* held elsewhere, and the supervisor's handoff to it then fails by name.
        const hosted =
            this.#exclusive && leases.declined.length > 0
                ? prepared.loaded.filter((entry) => leases.owned.includes(entry.manifest.id))
                : prepared.loaded

        const admitted: Agent[] = []
        for (const entry of hosted) {
            const supply = prepared.supplyFor(entry.manifest.id)
            const built = await buildRegistry(entry, supply)
            if (built.providers.length > 0) {
                this.#providersByAgent.set(entry.manifest.id, built.providers)
            }
            // Built before the agent for the reason the boot path records: a broken channel is a
            // warning, and a warning has to be readable off the agent rather than caught on a bus
            // nothing was subscribed to yet.
            const bindings = buildChannels(entry, supply)
            const agent = instantiateAgent({
                entry,
                warnings: [
                    ...(supply.failedPlugins ?? []),
                    ...built.warnings,
                    ...brokenChannels(bindings),
                ],
                supply,
                registry: built.registry,
                team: prepared.teams.get(entry.manifest.id),
                resolveMember: (id) => this.agent(id),
                options: this.#options,
                bus: this.bus,
                store: this.store,
            })

            if (bindings.length > 0) this.channels.register(agent, bindings)
            admitted.push(agent)
        }

        // Members and teams before `#admit`, so `list()` is already correct the first time anything
        // reads it — including the `agent.loaded` events `#admit` emits. Same ordering as boot.
        for (const id of prepared.memberIds) this.#members.add(id)
        for (const [id, team] of prepared.teams) this.#teams.set(id, team)
        for (const [id, off] of prepared.unwatch) this.#unwatch.set(id, off)
        this.#owned.push(...leases.owned)
        // The freshly claimed rows have no address — `claim` clears it, deliberately, so a takeover
        // cannot inherit a dead holder's. Re-published here rather than left for the next heartbeat,
        // because `stop` may be typed a second after the provision that created the agent.
        if (this.#baseUrl !== undefined && leases.owned.length > 0) {
            await this.store.leases.publish(this.runtimeId, this.#baseUrl)
        }
        for (const agent of admitted) this.#admit(agent)
        // The root's source only. A member is reloaded by replacing its supervisor.
        const root = hosted[0]
        if (root !== undefined) this.#sources.set(root.manifest.id, source)

        for (const [index, entry] of hosted.entries()) {
            const agent = admitted[index]
            if (agent === undefined) continue
            await this.#reconcile(entry, agent.id)
            await this.channels.startAgent(agent.id)
            // Slot 2 is frozen at first use and this agent has taken no turn, so it is still
            // writable — and it must be written here rather than left to default, or an adopted
            // agent is told it has no channels in a process that has just started them.
            agent.reportRuntimeState({
                brokenChannels: this.channels.brokenOf(agent.id),
                channelsStarted:
                    this.channels.started && this.channels.statusOf(agent.id).length > 0,
                servedElsewhere: leases.declined.some((held) => held.agentId === agent.id),
                schedulerStarted: this.scheduler.started,
            })
            refreshProviders({
                agentId: agent.id,
                providers: this.#providersByAgent.get(agent.id) ?? [],
                slugs: entry.manifest.tools.pinned,
                bus: this.bus,
            })
        }

        /**
         * Re-arm, or an adopted schedule waits a whole horizon before anything looks again.
         *
         * `#arm` sleeps until the soonest due time it knew about when it last ran — up to the
         * 24-day clamp on an idle host — so reconciling a row is not enough to make it fire. This is
         * the same `changed()` a `config_set` write calls, for the same reason, and it is a no-op
         * when the timer is not running.
         *
         * Found by revert-checking the adoption test: the first version asserted the store's own
         * `nextDue` and stayed green with the wiring reverted, because it was reading the store
         * rather than anything the *scheduler* believes. The test that replaced it waits for the
         * turn, which is the only fact that needs both halves to be right.
         */
        this.scheduler.changed()

        // A heartbeat may not have been running: a runtime that booted with no agents owns no
        // leases, and `#startHeartbeat` returns early on an empty set. Idempotent, so the common
        // case — adopting into a host that already has agents — starts nothing second.
        this.#startHeartbeat()

        this.bus.emit("runtime.ready", {
            bootMs: 0,
            processMs: Math.round(performance.now() * 100) / 100,
            phases: {},
            agents: this.list().length,
        })

        return admitted
    }

    /**
     * Reload one agent from its manifest, leaving every other agent alone.
     *
     * The frozen-configuration decision is untouched, which is the whole design: an agent's
     * catalogue resolves once and slot 1 renders once *per instance*, so a changed manifest gets a
     * **new instance** rather than a mutated one. `manifest_changed` still says what it always said
     * to the conversations of the old instance; the new one simply has the new settings.
     *
     * Dispose then adopt, in that order and not overlapped: the lease, the channel bindings and the
     * outbox poll loop are all keyed by agent id, so two instances briefly coexisting would be two
     * pollers on one bot token and two loops draining one queue.
     *
     * ⚠️ **An object-form manifest re-adopts the same object.** There is nothing to re-read, so this
     * rebuilds the instance with identical settings — which is honest rather than useful. An
     * embedder holding new settings should `dispose` and `adopt` the new object.
     */
    /**
     * The manifest an agent was loaded from, for a surface that means to edit it.
     *
     * One accessor over the map `replace` already reads, rather than a second place that knows how
     * an agent's file is found: the id-versus-directory split has cost a round before, and a caller
     * guessing `<dir>/agent.yaml` would be wrong for any manifest not named that.
     *
     * A `string` is a path and can be edited; a `Record` is an object-form manifest with no file
     * behind it, and a caller that means to write **must** distinguish the two rather than
     * stringify. Roots only — a team member has no manifest of its own, so this answers `undefined`
     * for one, which is the same answer `replace` gives and for the same reason.
     */
    sourceOf(agentId: string): AgentSource | undefined {
        return this.#sources.get(agentId)
    }

    async replace(agentId: string): Promise<readonly Agent[]> {
        const source = this.#sources.get(agentId)
        if (source === undefined) {
            throw new HarnessError({
                code: "agent_not_replaceable",
                message: this.#members.has(agentId)
                    ? `"${agentId}" is a team member, so it has no manifest of its own to reload.`
                    : `This runtime does not host an agent with id "${agentId}".`,
                hint: this.#members.has(agentId)
                    ? `Replace its supervisor instead: a team is loaded as one unit from one manifest, and reloading half of it would leave a supervisor holding a handoff tool pointing at an agent that no longer exists.`
                    : `This runtime hosts: ${[...this.#agents.keys()].join(", ") || "(none)"}.`,
            })
        }
        await this.dispose(agentId, "replaced")
        return await this.adopt(source)
    }

    /**
     * Stop hosting one agent — leases, channels, schedules, providers, plugin watchers.
     *
     * Six subsystems were only ever unwound at process exit, and **every one of them fails quietly
     * when it is missed**: a leased agent nothing is serving, an unreaped `exec` child, an outbox
     * loop draining rows for an agent that is gone, a plugin watching turns it has no business
     * seeing. So this is one method rather than a note in each caller, and the test for it adopts
     * and disposes in a loop and asserts nothing accumulates.
     *
     * **A supervisor takes its members with it.** They were loaded from its manifest as one unit and
     * the handoff tool resolves them by id at turn time, so leaving them behind would leave agents
     * nothing can reach and taking only the supervisor would leave a handoff that throws. A member
     * cannot be disposed on its own, and says so.
     *
     * **Refuses while a turn is running.** Not a convenience: the alternative is closing a store
     * under a turn recorded as `running`, and stopping the turn properly needs an `AbortController`
     * per turn — the loop's cancellation model, deferred with its own review. Refusing also settles
     * pending approvals for free, because an approval that is waiting *is* a suspended turn, so
     * there is no such thing as a disposable agent with a question outstanding.
     */
    async dispose(agentId: string, reason: DisposeReason = "requested"): Promise<void> {
        if (this.#members.has(agentId)) {
            throw new HarnessError({
                code: "agent_not_disposable",
                message: `"${agentId}" is a team member and cannot be disposed on its own.`,
                hint: "Dispose its supervisor, which takes the whole team down together. A team is loaded as one unit from one manifest, and a supervisor whose member has gone away holds a handoff tool that throws at the moment somebody uses it.",
            })
        }
        if (!this.#agents.has(agentId)) return

        const ids = [agentId, ...(this.#teams.get(agentId) ?? []).map((member) => member.id)]

        const busy = ids
            .map((id) => this.#agents.get(id))
            .filter((agent) => agent !== undefined && agent.inFlight > 0)
        if (busy.length > 0) {
            const first = busy[0]
            throw new HarnessError({
                code: "agent_turn_in_flight",
                message: `Agent "${first?.id}" has ${first?.inFlight} turn(s) running, so it cannot be torn down yet.`,
                hint: "Wait for the turn to end and try again, or stop it first — POST /v1/agents/:id/turns/:turnId/stop for a turn this process started from the API. Tearing down mid-turn would close the agent's store under a turn already recorded as running.",
            })
        }

        for (const id of ids) {
            // Channels first. The outbox loop is a `setInterval` scoped to one agent, so a delivery
            // enqueued after this point has nothing draining it until the replacement starts —
            // which is why unsent rows are left in the store rather than dropped.
            await this.channels.unregister(id)

            // Providers let go of anything outside the process. The keyed map is what makes this
            // possible at all: the flattened copy could only answer "stop everything".
            for (const provider of this.#providersByAgent.get(id) ?? []) {
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
                        hint: "Anything it owns outside this process may still be running. For the system provider that means a backgrounded command — check with `ps` if the machine seems busy afterwards.",
                    })
                }
            }
            this.#providersByAgent.delete(id)

            this.#unwatch.get(id)?.()
            this.#unwatch.delete(id)

            this.#agents.delete(id)
            this.#members.delete(id)
            this.#teams.delete(id)
            this.#sources.delete(id)

            // The schedule rows stay. They are the agent's durable configuration and a dispose is
            // not a removal — `purgeAgent` is — and the scheduler stops firing them anyway, because
            // its due query reads `all()` and this agent has just left it.
            //
            // Released last of the per-agent state, so nothing above can throw and leave the lease
            // held by a runtime that has already forgotten the agent. Best-effort for the reason
            // `stop` gives: the next boot recovers a stale lease, so failing here is a delay.
            if (this.#owned.includes(id)) {
                try {
                    await this.store.leases.release(id, this.runtimeId)
                } catch {
                    // Deliberately swallowed. See above.
                }
                this.#owned = this.#owned.filter((held) => held !== id)
            }
            this.#declined = this.#declined.filter((held) => held.agentId !== id)

            this.bus.emit("agent.disposed", { reason }, { agentId: id })
        }
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
        this.webhooks.stop()
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
        for (const provider of [...this.#providersByAgent.values()].flat()) {
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

    /**
     * Record where this runtime can be reached, on every lease it holds.
     *
     * Called by whoever bound the socket, after it is bound — which is the only moment the answer
     * exists, since `--port 0` picks a port and a container republishes it. The runtime does not
     * bind anything itself and must not guess: a manifest's `server.port` is what the file asked
     * for, and a host reachable on 7421 whose lease says 7420 is invisible to the one command that
     * must never miss it.
     *
     * Kept as well as written, so an agent adopted later lands on a lease that carries the address.
     */
    async publishAddress(baseUrl: string): Promise<void> {
        this.#baseUrl = baseUrl
        await this.store.leases.publish(this.runtimeId, baseUrl)
    }

    /** Agent ids this runtime holds the serving lease for. */
    get owned(): readonly string[] {
        return this.#owned
    }

    /**
     * Agents another live process is serving, which this runtime therefore is not.
     *
     * Non-empty only when a lease was refused. A caller that asked for several agents needs this to
     * report what it is actually hosting: silently serving four of five is the looks-fine-and-is-not
     * shape, and the alternative — refusing all five over one conflict — is what this replaced.
     */
    get declined(): readonly LeaseRecord[] {
        return this.#declined
    }

    #startHeartbeat(): void {
        // Idempotent, because `adopt` calls it too: a host that booted with no agents owns no
        // leases and started no timer, and the agent provisioned into it a minute later is exactly
        // the one whose lease has to be kept alive. A second interval would beat twice as often
        // and, being a second timer, would outlive `stop`'s single `clearInterval`.
        if (this.#heartbeat !== undefined) return
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

/**
 * Everything that happens to a set of agent sources *before* a store exists: plugins, manifests,
 * teams.
 *
 * Extracted from `Runtime.create` for one reason — `adopt` runs the identical sequence for one
 * source, and a second copy of it would be a second set of answers to "which provider ids exist",
 * "does this manifest load" and "is this team a cycle". The repo has this shape recorded twice
 * already (`ruleBudgetFailure`, `validateSchedules`): a check only one caller performs is a check
 * the two callers disagree about, and the disagreement here would be an agent that boots on
 * start-up and is refused on provisioning, or the reverse.
 *
 * `mark` and `markAsync` are the boot report's stopwatches, passed in rather than owned, because
 * the phase names are asserted in order by `runtime.test.ts` and an adoption is not a boot — it
 * passes pass-throughs and contributes to no report.
 */
async function prepareAgents(input: {
    readonly sources: readonly AgentSource[]
    readonly options: RuntimeOptions
    readonly bus: EventBus
    readonly mark: <T>(name: string, work: () => T) => T
    readonly markAsync: <T>(name: string, work: () => Promise<T>) => Promise<T>
}): Promise<PreparedAgents> {
    const { sources, options, bus, mark, markAsync } = input
    /**
     * The `onEvent` watcher subscriptions, by agent id, so a disposed agent's plugins stop watching.
     *
     * Returned rather than discarded because `bus.on` hands back an unsubscribe and nothing was
     * holding it. Under `create` alone that is harmless — the bus dies with the process — and the
     * moment an agent can be *removed* from a live process it is a leak with a behavioural symptom:
     * a replaced agent's old plugins would go on observing the new one's turns.
     */
    const unwatch = new Map<string, () => void>()

    // 0. Plugins: read each agent's `plugins:` shallowly, resolve the modules, and let them
    //    register. **Before** the manifest load, because that load validates `tools.provider`
    //    and a channel `type` against the ids this host can supply — and once plugins exist,
    //    half of those ids come from the plugins themselves. Reading the refs from the header is
    //    what breaks that circle: `readManifestHeader` parses without expanding env or checking
    //    credentials, and a plugin spec is a package name rather than a secret.
    //
    //    Resolution is the only async step in boot before the store, and it does no I/O at all
    //    for a built-in. `setup()` registers and does not work, so hard rule 4 still holds.
    const supplyByAgent = new Map<string, AgentSupply>()
    const pluginsByAgent = new Map<string, readonly LoadedPlugin[]>()
    // One shallow read per agent, reused by the plugin phase and by the manifest phase below.
    // Reading it per use cost three YAML parses of the same file and made `plugins` the slowest
    // boot phase — 5.88 ms — on an agent with no plugins at all.
    const headers = sources.map((source) =>
        typeof source === "string"
            ? readManifestHeader(source)
            : {
                  id: String((source as { id?: unknown }).id ?? ""),
                  plugins: (source as { plugins?: ManifestHeader["plugins"] }).plugins,
              },
    )
    const agentIdAt = (index: number): string => {
        const source = sources[index]
        return headers[index]?.id ?? (typeof source === "string" ? source : "")
    }

    await markAsync("plugins", async () => {
        for (const [index, source] of sources.entries()) {
            const refs = headers[index]?.plugins ?? []
            if (refs.length === 0) continue
            const agentId = agentIdAt(index)

            const manifestPath =
                typeof source === "string"
                    ? resolve(source)
                    : resolve(options.dir ?? process.cwd(), "agent.yaml")
            // The same function `validate` calls. They disagreed once — `validate` checked
            // provider ids against the host's static table while this checked them against the
            // table plus the manifest's plugins — so a manifest naming a third-party provider
            // booted fine and was reported broken.
            const supply = await agentPluginSupply({
                refs,
                agentId,
                paths: {
                    workspace: dirname(manifestPath),
                    state: resolve(options.dir ?? process.cwd(), BRAND.stateDir),
                    manifest: manifestPath,
                },
                env: options.env ?? process.env,
                bus,
                ...(options.builtInPlugins === undefined
                    ? {}
                    : { builtIn: options.builtInPlugins }),
                ...(options.pluginRoot === undefined ? {} : { pluginRoot: options.pluginRoot }),
                base: {
                    ...(options.toolProviders === undefined
                        ? {}
                        : { toolProviders: options.toolProviders }),
                    ...(options.channels === undefined ? {} : { channels: options.channels }),
                    ...(options.scriptRunner === undefined
                        ? {}
                        : { scriptRunner: options.scriptRunner }),
                },
            })
            supplyByAgent.set(agentId, {
                toolProviders: supply.toolProviders,
                channels: supply.channels,
                scriptRunner: supply.scriptRunner,
                middleware: supply.middleware,
                failedPlugins: supply.failed,
            })
            pluginsByAgent.set(agentId, supply.loaded)

            // `onEvent` watchers, subscribed here rather than left to each plugin.
            //
            // Filtered to this agent's own events, because a plugin named by one agent has no
            // business watching another's turns — two agents in one process is a normal
            // configuration and the bus is runtime-wide. Boot events that fire *before* this
            // point are missed, which is honest: a watcher registered by a manifest cannot see
            // the read of that manifest.
            //
            // A throw is reported and swallowed. One plugin's observer must not be able to stop
            // the runtime reporting to everybody else's — the same rule the bus already applies
            // to its own subscribers.
            const watchers = supply.middleware.filter(
                (entry) => typeof entry.onEvent === "function",
            )
            if (watchers.length > 0) {
                const off = bus.on("*", (event) => {
                    if (event.agentId !== undefined && event.agentId !== agentId) return
                    notify(watchers, event, (error, name) => {
                        bus.emit(
                            "agent.warning",
                            {
                                code: "middleware_observer_failed",
                                message: `Middleware "${name}" threw from onEvent: ${
                                    error instanceof Error ? error.message : String(error)
                                }`,
                                hint: "`onEvent` is fire-and-forget: it must not throw and must not block. Anything slow or fallible belongs on a queue the plugin owns. The event was delivered to every other watcher regardless.",
                                field: "plugins",
                            },
                            { agentId },
                        )
                    })
                })
                unwatch.set(agentId, off)
            }
        }
    })

    /** What this agent can be supplied with — the host's registrations plus its plugins'. */
    const supplyFor = (agentId: string): AgentSupply =>
        supplyByAgent.get(agentId) ?? {
            toolProviders: options.toolProviders ?? {},
            channels: options.channels ?? {},
            scriptRunner: options.scriptRunner,
            middleware: [],
            failedPlugins: [],
        }

    // 1. Manifests: file reads, env expansion, schema, rules. No network.
    const roots = mark("manifest", () =>
        sources.map((source, index) => {
            const supply = supplyFor(agentIdAt(index))
            const known = {
                knownChannels: Object.keys(supply.channels),
            }
            return typeof source === "string"
                ? loadManifest(source, { ...envOptions(options), ...known })
                : loadManifestFromObject(source, {
                      ...envOptions(options),
                      ...known,
                      dir: options.dir ?? process.cwd(),
                  })
        }),
    )

    /**
     * Team members, loaded alongside their supervisors.
     *
     * Expanded here so `serve` and `run` need no change: they pass one manifest and get whatever
     * that manifest's team declares. The graph is checked in the same pass — a cycle or an
     * over-deep chain is refused **now**, against the manifests, rather than at the third hop of
     * a turn somebody is waiting on.
     *
     * `memberIds` is what `list()` filters by. Members are loaded, leased and runnable; they are
     * not *served*, because an addressable member is a route around whatever policy its
     * supervisor was carrying.
     */
    const expanded = mark("teams", () =>
        roots.some((entry) => entry.manifest.team !== undefined)
            ? expandTeams(roots, envOptions(options))
            : {
                  loaded: roots,
                  memberIds: new Set<string>(),
                  teams: new Map<string, readonly TeamMemberConfig[]>(),
              },
    )

    return {
        loaded: expanded.loaded,
        memberIds: expanded.memberIds,
        teams: expanded.teams,
        plugins: pluginsByAgent,
        supplyFor,
        unwatch,
    }
}

/** What `prepareAgents` produces. See its docstring. */
interface PreparedAgents {
    readonly loaded: readonly LoadedManifest[]
    readonly memberIds: ReadonlySet<string>
    readonly teams: ReadonlyMap<string, readonly TeamMemberConfig[]>
    readonly plugins: ReadonlyMap<string, readonly LoadedPlugin[]>
    supplyFor(agentId: string): AgentSupply
    readonly unwatch: ReadonlyMap<string, () => void>
}

/**
 * Construct one agent's tool providers and the registry over them.
 *
 * The pair travels together because the registry *is* the providers plus the manifest's pinned and
 * local tools, and the providers are separately held so `dispose` can tell each one to let go. A
 * caller that built only the registry would have no handle on the `exec` children a provider
 * backgrounded — the leak that once put 33 orphaned shells on a machine.
 *
 * Shared by `create` and `adopt` so a slug refused on one path is refused on the other.
 */
export async function buildRegistry(
    entry: LoadedManifest,
    supply: AgentSupply,
): Promise<{
    readonly registry: ToolRegistry
    readonly providers: readonly ToolProvider[]
    readonly warnings: readonly ErrorDetail[]
}> {
    const { providers, warnings } = buildProviders(entry, supply)
    const registry = await ToolRegistry.create({
        pinned: entry.manifest.tools.pinned,
        local: entry.manifest.tools.local,
        budget: entry.manifest.tools.budget,
        ...(providers.length === 0 ? {} : { providers }),
    })
    return { registry, providers, warnings }
}

/**
 * Build one `Agent` from one loaded manifest.
 *
 * Shared by `create` and `adopt` for the same reason `prepareAgents` is: every one of the options
 * below is a decision with a comment explaining it, and a second copy would be a second set of
 * those decisions. Two of them were already load-bearing before adoption existed — `approve` being
 * threaded rather than stubbed is what keeps the `confirm_without_approver` warning honest, and
 * `scriptRunner` being read off the *merged* supply is what stops a plugin-supplied runner being
 * silently dropped.
 *
 * `resolveMember` is a lookup rather than a map, because the handoff tool resolves its target at
 * turn time — see the comment on `teamTools`. Under `adopt` it reads the runtime, so a supervisor
 * adopted into a live process reaches members adopted in the same call.
 */
function instantiateAgent(input: {
    /** Findings made before the agent existed — a channel that could not be built. */
    readonly warnings?: readonly ErrorDetail[]
    readonly entry: LoadedManifest
    readonly supply: AgentSupply
    readonly registry: ToolRegistry | undefined
    readonly team: readonly TeamMemberConfig[] | undefined
    readonly resolveMember: (id: string) => HandoffTarget
    readonly options: RuntimeOptions
    readonly bus: EventBus
    readonly store: Store
}): Agent {
    const { entry, supply, team, resolveMember, options, bus, store } = input
    const runner = supply.scriptRunner
    /**
     * A supervisor's `handoff` tool, added at **load** so slot 1 renders it once.
     *
     * Declaring `team:` is what registers it — there is no second switch to remember,
     * the same rule decision 4.53 records for providers: a capability reachable only by
     * someone who already knows the field name is one the manifest is hiding.
     *
     * The member lookup is **lazy**, and it has to be: the tool goes into the registry
     * this call is building, while the member `Agent` it will call is built by another
     * call to this function. `resolveMember` resolves at turn time, hours later, by which
     * point every agent exists. Eager resolution here is a chicken-and-egg that would only
     * work if members happened to be loaded first.
     */
    // Annotated, both, and not for style: `resolveMember` reads the runtime, which is
    // initialised from this function's own results, so every inferred type in the chain
    // becomes circular and TypeScript gives up with six `implicitly has type any` errors.
    // One explicit return type on the getter breaks the cycle; the other follows from it.
    const teamTools: readonly Tool[] =
        team === undefined
            ? []
            : [
                  handoffTool({
                      bus,
                      store: store.handoffs,
                      members: team.map((config) => ({
                          config,
                          // Resolved per call. `runtime` is assigned below this block,
                          // so this closure cannot be evaluated eagerly either.
                          get agent(): HandoffTarget {
                              return resolveMember(config.id)
                          },
                      })),
                  }),
              ]
    const withTeam: ToolRegistry | undefined =
        input.registry === undefined || teamTools.length === 0
            ? input.registry
            : input.registry.withTools(teamTools)

    return Agent.create(entry, bus, store, {
        // Conditionally spread, like every other optional here — and this field is exactly the
        // shape this project has lost a value to six times, so `runtime.test.ts` reads it back off
        // `agent.warnings` rather than trusting the thread.
        ...(input.warnings === undefined || input.warnings.length === 0
            ? {}
            : { warnings: input.warnings }),
        ...(withTeam === undefined ? {} : { tools: withTeam }),
        // Threaded rather than defaulted: `Agent.create` reads `approve === undefined`
        // to decide whether to warn about an unreachable `onMutate: "confirm"`, so a
        // no-op stub here would silence a warning while nothing could actually ask.
        ...(options.approve === undefined ? {} : { approve: options.approve }),
        // Read once. A guard testing the merged supply while the value came from
        // `options` type-checks, passes every existing test, and silently drops a
        // plugin-supplied runner — the conditional-spread shape that has cost this repo
        // six debugging rounds.
        ...(runner === undefined ? {} : { scriptRunner: runner }),
        ...(supply.middleware.length === 0 ? {} : { middleware: supply.middleware }),
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
    })
}

/**
 * Warm a provider's resolution cache, after readiness and detached.
 *
 * A module function shared by `create` and `adopt`, which is the point: this is the first legal
 * network call for a set of agents, and an adopted agent whose Composio cache was never refreshed
 * would serve a stale catalogue with nothing saying so — a shipped feature unreachable on one of
 * the two paths that reach it.
 *
 * Never awaited by either caller. Awaiting it would put a remote round trip back inside boot — the
 * cost this project exists to remove — just on the far side of the event. A failure leaves the
 * agent serving the catalogue it resolved from disk, and says so on the bus.
 */
function refreshProviders(input: {
    readonly agentId: string
    readonly providers: readonly ToolProvider[]
    readonly slugs: readonly string[]
    readonly bus: EventBus
}): void {
    const { agentId, providers, slugs, bus } = input
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
function buildProviders(
    entry: LoadedManifest,
    supply: AgentSupply,
): { readonly providers: readonly ToolProvider[]; readonly warnings: readonly ErrorDetail[] } {
    const factories = supply.toolProviders
    const providers: ToolProvider[] = []
    const warnings: ErrorDetail[] = []

    // The plan's warnings are deliberately not collected here. `Agent.create` reads them from the
    // same function, so they arrive on `agent.warnings` where a front end still finds them after
    // boot — the lesson from the trimmed-catalogue warning, which was emitted during boot into an
    // empty room for weeks.
    for (const selection of resolveProviders(entry.manifest.tools).selections) {
        const factory = factories[selection.id]
        // **Warned and skipped, never fatal.** A provider is an optional capability — most often
        // one a plugin would have registered, and a plugin that failed to load is already a warning
        // — so refusing the agent here would turn one broken plugin into an agent that cannot
        // start. The tools it would have supplied then fall out of `tools.pinned` as unresolved,
        // which is a warning of its own, and `available()` tells the model what it was not given.
        if (factory === undefined) {
            warnings.push(toolProviderUnknown(selection.id, Object.keys(factories)).toDetail())
            continue
        }
        try {
            providers.push(
                factory({
                    dir: entry.dir,
                    env: entry.env,
                    config: selection.config,
                    agentId: entry.manifest.id,
                }),
            )
        } catch (cause) {
            // A provider factory reads its own config and may refuse it. Same reasoning as a
            // channel factory: the sentence it wrote is better than anything here, and the agent
            // starts without the provider rather than not at all.
            warnings.push(
                isHarnessError(cause)
                    ? cause.toDetail()
                    : {
                          code: "tool_provider_failed",
                          message: `tools.providers.${selection.id} could not be built: ${
                              cause instanceof Error ? cause.message : String(cause)
                          }`,
                          hint: "The agent starts without it, and any pinned tool it would have supplied is reported as unresolved. Check that provider's own fields under `tools.providers`.",
                          field: `tools.providers.${selection.id}`,
                      },
            )
        }
    }
    return { providers, warnings }
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
        // impossible to switch a broken channel off, which is the one thing `enabled: false` is for.
        if (!channel.enabled) continue

        const {
            type: _type,
            id: _id,
            allowFrom: _allowFrom,
            enabled: _enabled,
            ...config
        } = channel

        // **Every way one channel entry can fail is reported and degraded, never fatal.** A channel
        // is optional — nothing about taking a turn depends on one — and this used to throw, so
        // `init --telegram connected` generated a manifest whose factory refused at load and the
        // agent could not start at all: not `run`, not `serve`, not `validate`, over a token nobody
        // had pasted yet.
        //
        // Degraded is not silent, which is the whole reason it is defensible: the detail reaches
        // `agent.warnings`, `statusOf` reports the channel as `error`, slot 2 tells the agent its
        // own channel is broken, and `validate` prints it — the same function, so the two cannot
        // disagree. An unknown `type` degrades with the rest rather than staying fatal: the old
        // argument for refusing was that a channel constructing nothing is one that never receives
        // with no symptom, and the symptom is now on four surfaces.
        const detail = ((): ErrorDetail | undefined => {
            const factory = factories[channel.type]
            if (factory === undefined) {
                return channelTypeUnknown(channel.type, Object.keys(factories)).toDetail()
            }
            try {
                const transport = factory({
                    agentId: entry.manifest.id,
                    dir: entry.dir,
                    env: entry.env,
                    config,
                    id: channel.id,
                })
                // Checked because a plugin-supplied factory is plain JavaScript by the time it runs
                // here, and both fields are read elsewhere as facts. Found by running a third-party
                // channel for the first time: a transport with no `type` put `echo (undefined)` on
                // the serve banner and left the documented `type` absent from `GET /v1/agents/:id`.
                if (transport.id !== channel.id) {
                    return channelTransportMismatch(
                        "id",
                        channel.id,
                        transport.id,
                        channel.id,
                    ).toDetail()
                }
                if (transport.type !== channel.type) {
                    return channelTransportMismatch(
                        "type",
                        channel.type,
                        transport.type,
                        channel.id,
                    ).toDetail()
                }
                bindings.push({
                    transport,
                    ...(channel.allowFrom === undefined ? {} : { allowFrom: channel.allowFrom }),
                    enabled: true,
                })
                return undefined
            } catch (cause) {
                // A factory's own `ConfigError` carries the better sentence — it knows which
                // variable and where to put it — so it is kept rather than wrapped.
                if (isHarnessError(cause)) return cause.toDetail()
                return channelFactoryFailed(channel.id, channel.type, cause)
            }
        })()

        if (detail !== undefined) {
            bindings.push({
                transport: brokenTransport(channel.id, channel.type, detail),
                ...(channel.allowFrom === undefined ? {} : { allowFrom: channel.allowFrom }),
                enabled: true,
                broken: detail,
            })
        }
    }

    return bindings
}

/** The details of every channel that could not be built — what a caller puts on `agent.warnings`. */
export function brokenChannels(bindings: readonly ChannelBinding[]): readonly ErrorDetail[] {
    return bindings
        .map((binding) => binding.broken)
        .filter((detail): detail is ErrorDetail => detail !== undefined)
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
