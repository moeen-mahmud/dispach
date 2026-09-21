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

import {
    AgentManifestSchema,
    BRAND,
    EventBus,
    HarnessError,
    isHarnessError,
    loadManifest,
    Runtime,
} from "@dispach/core"
import {
    claimCommand,
    claimUrl,
    createApprovalRegistry,
    createClaimTicket,
    serve,
} from "@dispach/server"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { claimSignals, onExit } from "#lib/exit"
import { hostableAgents, manifestForId } from "#lib/lifecycle"
import {
    BUILT_IN_PLUGINS,
    CHANNEL_IDS,
    CHANNELS,
    PROVIDER_IDS,
    scriptRunner,
    TOOL_PROVIDERS,
} from "#lib/providers"
import { provisionAgent, provisionSteps } from "#lib/provision"
import { agentsDir, storePath } from "#lib/sandbox"

export interface ServeOptions {
    /**
     * Zero or more manifests. The process hosts every agent they produce.
     *
     * Plural since 16.2a: decision 8.5 has said "one process hosts N agents" since the beginning
     * and core was built that way — `RuntimeOptions.agents` is already an array — so a single path
     * here was the only thing pinning the product to one agent.
     *
     * **Empty means the sandbox's agents**, which is what the service unit runs and what makes the
     * product always-on: a host that has to be told which agents to serve cannot serve one that was
     * provisioned after it started. Naming manifests is the container's shape, where the agent
     * arrives on a mount and the sandbox is not the inventory.
     */
    readonly manifestPaths: readonly string[]
    readonly port?: number
    readonly host?: string
    readonly store?: string
    /** Print a one-time claim even when a key already exists. The lockout escape. */
    readonly claim?: boolean
    readonly json?: boolean
}

/**
 * The `server:` block a manifest that declares none resolves to.
 *
 * Asked of the **schema** rather than written out here, so a bare `serve` and a manifest with no
 * `server:` block cannot come to disagree about the port — which they would the first time somebody
 * changed the default in one place. Parsing an empty object is the cheapest way to ask a Zod schema
 * what its defaults are.
 */
function defaultServerConfig(): ReturnType<typeof AgentManifestSchema.parse>["server"] {
    return AgentManifestSchema.shape.server.parse({})
}

export async function serveCommand(options: ServeOptions): Promise<number> {
    const env = ambientEnv(options.manifestPaths)

    /**
     * What to host, and what is switched off.
     *
     * Read before the runtime exists, because it decides which agents the runtime is *asked* for —
     * a disabled agent is not loaded at all, so there is nothing to filter afterwards. The switch is
     * honoured for an explicitly named manifest too, and that is deliberate: the launchd trap this
     * table is modelled on is precisely a job that installs cleanly, reports success and silently
     * never starts, and the cure is not to make the durable state easy to bypass — it is to say so.
     */
    // The same path the runtime will open, not the sandbox default: `serve --store` exists, and
    // a host reading its on/off switch from a different database than the one it serves out of
    // is wrong in exactly the configuration that is easiest to miss.
    const storeFile = options.store ?? storePath()
    const hostable = await hostableAgents(options.manifestPaths, env, storeFile)
    const switchedOff = hostable.filter((entry) => !entry.enabled)
    const wanted = hostable.filter((entry) => entry.enabled)

    /**
     * **A discovered agent that will not load is skipped; a named one still refuses.**
     *
     * The asymmetry is the whole point, and it was found by running the container rather than by
     * reading this. `init` writes a manifest whose `.env` holds `MODEL_API_KEY=` — empty, by its
     * own design, since step 1 of what it prints is "add your key". A bare `serve` hosts every
     * enabled agent in the sandbox, so one freshly created agent made `loadManifest` throw, the
     * host exited 1, and `restart: unless-stopped` restarted it into the same failure: **9
     * restarts, the API gone, the web UI gone** — the always-on server that exists to provision
     * agents taken down by an agent halfway through being provisioned. The message was perfect and
     * went to `docker logs`, which is the 57 MB lesson with the polarity reversed: not a bad
     * message in a file nobody opens, a correct one nobody can act on because the thing that would
     * let them act is what died.
     *
     * So a host does not get to fail because one of N agents is misconfigured. That is the same
     * reasoning `listAgents` uses to show a broken directory rather than omitting it, and the same
     * reasoning behind `GET /v1/agents` carrying a stopped row: the listing says what exists, the
     * resource says what is running.
     *
     * A **named** manifest is the other case and keeps throwing. The caller asked for that agent by
     * path, so quietly serving something else is the worse error — exactly the direction
     * `hostableAgents` already distinguishes, which is why the condition here is the same one.
     */
    const discovered = options.manifestPaths.length === 0
    const manifests: { path: string; loaded: ReturnType<typeof loadManifest> }[] = []
    const broken: { path: string; detail: string; hint?: string }[] = []
    for (const entry of wanted) {
        try {
            manifests.push({
                path: entry.manifestPath,
                loaded: loadManifest(entry.manifestPath, {
                    knownProviders: PROVIDER_IDS,
                    knownChannels: CHANNEL_IDS,
                    env,
                }),
            })
        } catch (error) {
            if (!discovered) throw error
            broken.push({
                path: entry.manifestPath,
                detail: isHarnessError(error) ? error.message : String(error),
                ...(isHarnessError(error) && error.hint !== undefined ? { hint: error.hint } : {}),
            })
        }
    }
    /**
     * **Zero agents is a running server, not a failure.**
     *
     * The whole point of an always-on host is that the API exists before there is anything to talk
     * to: the binary is installed, the server is up, and provisioning reaches it. A refusal here
     * would make the first-run experience "install, then find something to serve, then start", and
     * would turn a container whose only agent somebody stopped into a crash loop.
     *
     * So the server config comes from the first manifest when there is one, and from the schema's
     * defaults when there is not — which is the same thing a manifest that declares no `server:`
     * block resolves to.
     */
    const first = manifests[0]
    const loaded = first?.loaded
    const config = loaded?.manifest.server ?? defaultServerConfig()

    /**
     * **The bind is process-level, so a disagreement about it is refused rather than ignored.**
     *
     * One process, one socket, one token — so with several manifests the server config can only
     * come from one of them, and silently taking the first would make a manifest that carefully
     * declares `port: 7500` a file whose setting does nothing. That is the "looks configured and is
     * not" shape, and it is worse here than elsewhere because the symptom is a port somebody else
     * is already using.
     *
     * Compared after defaults are applied, which is what makes this correct rather than pedantic:
     * an unset `port` *is* 7420, so a manifest that says 7420 and one that says nothing agree, and
     * one that says 7500 disagrees with both.
     */
    for (const entry of manifests.slice(1)) {
        const other = entry.loaded.manifest.server
        for (const [field, mine, theirs, settled] of [
            // **A flag settles the question, so it also settles the disagreement.** `--port` and
            // `--host` override every manifest, so refusing because two of them disagree about a
            // value nothing is going to read would be a refusal the operator has already answered.
            // `tokenEnv` has no flag, so a disagreement there is always live.
            ["server.port", config.port, other.port, options.port !== undefined],
            ["server.host", config.host, other.host, options.host !== undefined],
            ["server.tokenEnv", config.tokenEnv, other.tokenEnv, false],
        ] as const) {
            if (settled || mine === theirs) continue
            throw new HarnessError({
                code: "serve_bind_conflict",
                message: `${first?.path ?? "the first manifest"} sets ${field} to ${String(mine)} and ${entry.path} sets it to ${String(theirs)}.`,
                hint: "One process binds one socket with one token, so these have to agree. Make them match, or run the disagreeing agent in its own process — a second `serve` on its own port.",
                field,
            })
        }
    }
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
    // `loaded.env`, never `env`. `ambientEnv` returns the *process* environment; the agent's own
    // `.env` beside the manifest is layered in by `loadManifest`. With no manifest at all there is
    // no agent env to layer, so the process environment is the only source there is — which is the
    // service unit's shape, where the variable comes from the unit definition.
    const token = loaded === undefined ? env[config.tokenEnv] : loaded.env[config.tokenEnv]

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
            const data = event.data as {
                channelId: string
                status: string
                detail?: string
                input?: { kind: string; expiresAt?: string }
            }
            /**
             * A `needs_input` names where the payload is, and never prints it.
             *
             * The payload is a QR's bytes — unreadable in a log, and hundreds of characters of it
             * would bury the sentence that matters. But a line saying only "needs_input" is the
             * 57 MB-log failure in one line: true, and no route to acting on it. The agent
             * resource carries the payload because `statusOf` returns it, so that is what this
             * points at.
             */
            const waiting =
                data.input === undefined
                    ? ""
                    : ` (${data.input.kind}${
                          data.input.expiresAt === undefined
                              ? ""
                              : `, expires ${data.input.expiresAt}`
                      } — GET /v1/agents/${event.agentId ?? ""} carries it)`
            process.stdout.write(
                `  ${data.channelId}: ${data.status}${data.detail === undefined ? "" : ` — ${data.detail}`}${waiting}\n`,
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

    /**
     * Created before the runtime, because the runtime is constructed *with* the approver.
     *
     * That ordering is the whole reason this lives here and not inside `serve()`: `Runtime.create`
     * takes `approve` and cannot hand back the function it was built with, so the registry has to
     * exist first and then be given to both. Same shape as the shared `running` map, one layer
     * further out.
     *
     * Supplying it is also what silences `confirm_without_approver` — `Agent.create` keys that
     * warning on `approve` being absent, so an agent with `onMutate: "confirm"` stops warning under
     * `serve` and keeps warning under `run`, which is exactly true of the two surfaces today.
     */
    const approvals = createApprovalRegistry()

    const runtime = await Runtime.create({
        agents: manifests.map((entry) => entry.path),
        // The seam `ToolContext.approve` declared in Phase 3 and nothing ever filled. A blocked
        // call now emits `approval.requested` and waits for a POST; an unanswered one ends with the
        // turn, because core races the approver against the turn's own signal rather than starting
        // a second clock.
        approve: approvals.approver,
        env,
        bus,
        toolProviders: TOOL_PROVIDERS,
        builtInPlugins: BUILT_IN_PLUGINS,
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
        store: storeFile,
        // Recorded on the runtime lease and read back only to phrase a refusal. `<PREFIX>SERVICE`
        // is set by the generated service definition and by nothing else, so this is a fact rather
        // than a guess — `ppid === 1` would also be true of any orphaned process.
        mode: asDaemon ? "daemon" : "terminal",
    })

    // Claimed and *registered* before the socket binds, and that ordering is the bug this fixes.
    //
    // Both used to sit after the banner. So between "serving on …" reaching stdout and
    // `waitForSignal()` registering its handlers there was a window with **no handler at all** — and
    // in it, SIGINT takes its default action and kills the process outright: exit code `null`, no
    // outbox flush, no lease release, and none of the backgrounded `exec` children reaped.
    //
    // Not a theoretical window. CI caught it as `Expected: 0, Received: null` on a loaded two-core
    // runner, where the work between the two points takes long enough to lose the race — and the
    // real-world shape is worse than a red test: an orchestrator that restarts a container promptly
    // sends its signal into exactly that gap, which is the failure `claimSignals` was introduced to
    // prevent in the first place.
    //
    // The promise is created here and awaited far below. A signal arriving in between resolves it
    // immediately, so an early stop is honoured rather than missed.
    claimSignals()
    const stopRequested = waitForSignal()

    /**
     * The one-time bootstrap credential, minted only when there is nothing to bootstrap *from*.
     *
     * Printed while no operator key is live, and otherwise not — a fresh claim at every boot would
     * leave a standing credential in the log, which is the opposite of a one-time ticket. `--claim`
     * overrides that, because a claim printed only while no key exists is a claim unavailable to
     * exactly the person who has lost theirs.
     *
     * Minted after `Runtime.create` because the store has to be open to ask, and before the bind
     * because the handler needs it — the same ordering `approvals` has one layer up.
     */
    const liveKeys = await runtime.store.operatorKeys.liveCount()
    const claim = liveKeys === 0 || options.claim === true ? createClaimTicket() : undefined

    let running: Awaited<ReturnType<typeof serve>>
    try {
        running = await serve({
            runtime,
            host,
            port,
            approvals,
            // The origin allowlists, from the manifest. Passed rather than defaulted, because the
            // guard's *default* behaviour is what protects a server whose operator configured
            // nothing — these two only widen it.
            allowedOrigins: config.allowedOrigins,
            allowedHosts: config.allowedHosts,
            /**
             * How `POST /v1/agents/:id/start` finds a manifest for an agent this host is not
             * holding. Injected because `packages/server` may not import the CLI, and the sandbox
             * layout is the CLI's — the same seam 16.5's provisioning route needs.
             *
             * Matched on the manifest's **id**, not on the directory name, because `:id` in the
             * route is an agent id and the two are allowed to differ for a hand-copied directory.
             */
            resolveAgent: (agentId) => manifestForId(agentId, env),
            /**
             * How `POST /v1/agents` creates one. The server owns the route and the gate; this is
             * the implementation, injected because `packages/server` may not import the CLI.
             *
             * Both halves come from `lib/provision.ts`, which is also what `init` writes through —
             * so an agent provisioned over HTTP is byte-identical to one created at a terminal, and
             * the step list a browser renders is the walk the wizard performs.
             *
             * Injected **unconditionally**, including in the container. What keeps provisioning out
             * of there is the loopback gate rather than this absence — the image's `CMD` binds
             * `0.0.0.0`, so the route answers `403`. A container that deliberately binds loopback
             * and wants to provision into itself is then a thing that works, which is the right
             * answer for `docker run -it … init`'s neighbour.
             */
            provision: {
                steps: () => provisionSteps({ agentDirBase: agentsDir(env) }),
                create: (answers) =>
                    provisionAgent({ answers, defaults: { agentDirBase: agentsDir(env) } }),
            },
            ...(claim === undefined ? {} : { claim }),
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

    /**
     * Tell the lease rows where this host answers, now that the socket exists.
     *
     * After the bind and not before, because `--port 0` means the port is not known until then —
     * and this is the whole mechanism behind `stop <agent>`: one process hosts several agents, so
     * stopping one has to be a request naming it rather than a signal to the process.
     */
    await runtime.publishAddress(running.url)

    const agents = runtime.list()

    // Name the process after what it is serving.
    //
    // Without this a long-running service is a bare interpreter in Activity Monitor and in `ps`,
    // indistinguishable from every other one on the machine — and the one place a person looks when
    // something is eating CPU is exactly the place it was anonymous.
    //
    // **One agent gets its name; several get a count.** Listing them would blow the 16-character
    // `comm` truncation on the second id and leave a fragment, which is worse than a number.
    //
    // Two stated costs. Assigning `process.title` overwrites the argv region, so `ps` shows this
    // instead of the full command line — the arguments stay visible in `launchctl print` and in
    // `daemon status`. And **Bun ignores the assignment entirely**: measured against the same
    // manifest, Node shows the title while `bun` and the compiled binary both show raw argv.
    // So this works on the soft-compat runtime and nowhere else, which is worth knowing before
    // relying on it — the line stays because it costs nothing where it does not work.
    const firstAgent = agents[0]
    if (firstAgent !== undefined) {
        process.title =
            agents.length === 1
                ? `${BRAND.slug} ${firstAgent.id}`
                : `${BRAND.slug} ${agents.length} agents`
    }
    // The port is bound now, which `Runtime.create` could not know — it returns before `serve` runs.
    // Told before the first turn, so slot 2 says "on" rather than "enabled but not listening".
    for (const agent of agents) agent.reportRuntimeState({ serverListening: true })

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({
                url: running.url,
                websocket: running.websocket,
                authenticated: token !== undefined && token !== "",
                keys: liveKeys,
                ...(claim === undefined ? {} : { claim: claim.token }),
                agents: agents.map((agent) => ({
                    id: agent.id,
                    channels: runtime.channels.statusOf(agent.id),
                })),
                // Named even when empty, so a scripted caller can tell "nothing was declined" from
                // "this build does not report it".
                declined: runtime.declined.map((held) => ({
                    agentId: held.agentId,
                    pid: held.pid,
                    mode: held.mode,
                    since: held.startedAt,
                })),
                // Same reasoning, and the more important of the two: an agent absent from this
                // report with no line explaining it is the "I set this up and it is not running"
                // failure the durable switch exists to make explicable.
                disabled: switchedOff.map((entry) => ({
                    agentId: entry.agentId,
                    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
                })),
                // A third way an agent can be absent, and the one that reads as a bug rather than
                // as a choice: its manifest would not load. Named for the same reason as the two
                // above — a scripted caller has to be able to tell "no agent is broken" from "this
                // build does not say".
                broken: broken.map((entry) => ({
                    path: entry.path,
                    detail: entry.detail,
                    ...(entry.hint === undefined ? {} : { hint: entry.hint }),
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

        /**
         * What this process is **not** serving, and why that has to be said.
         *
         * A lease refused means another live process is already serving that agent, and the claim
         * now declines it rather than refusing the whole boot — so without this line a host asked
         * for five agents comes up reporting four and looks entirely healthy. That is the
         * looks-fine-and-is-not shape, one process boundary out, and the same one slot 2's
         * `servedElsewhere` exists for.
         *
         * The pid is printed because it is the only actionable thing here — the `stop` command
         * is the next command, and knowing which process to expect it to reach is the difference
         * between running it and wondering.
         */
        /**
         * What is switched off, and how to switch it back on.
         *
         * The line is the whole reason a durable stop is safe to have. launchd's `disable` persists
         * across boots and no verb deletes the row, so a job with that label installs cleanly,
         * reports success and never starts — 2,463 restarts into a 57 MB log, with message quality
         * never the problem. A persistent switch is only defensible when the thing it switches off
         * says so at the moment somebody is looking.
         */
        for (const entry of switchedOff) {
            process.stdout.write(
                `  ${entry.agentId} — stopped${
                    entry.reason === undefined ? "" : ` (${entry.reason})`
                }, \`${BRAND.slug} start ${entry.agentId}\`\n`,
            )
        }

        /**
         * What would not load, with the reason and the file.
         *
         * Printed rather than thrown, because throwing is what took the host down — and printed
         * *loudly*, because "skipped" is the one state a person reads as working. The path is the
         * actionable half: the fix is almost always a key missing from the `.env` beside it, which
         * is precisely the state `init` leaves an agent in on purpose.
         */
        for (const entry of broken) {
            process.stdout.write(`  ${entry.path} — NOT served: ${entry.detail}\n`)
            if (entry.hint !== undefined) process.stdout.write(`    hint: ${entry.hint}\n`)
        }

        for (const held of runtime.declined) {
            process.stdout.write(
                `  ${held.agentId} — NOT served here: pid ${held.pid} (${held.mode}) already has it\n`,
            )
        }
        if (runtime.declined.length > 0) {
            process.stdout.write(
                `    \`${BRAND.slug} stop <agent>\` ends the other one, or leave it — nothing here is broken.\n`,
            )
        }
        if (claim !== undefined) {
            // Printed here rather than logged at debug level for the reason the 57 MB log taught:
            // this is the line somebody is looking at, and a bootstrap credential in a file nobody
            // opens is a bootstrap nobody performs. Reading it is what confers first ownership, and
            // that is a real boundary — `docker logs` already reveals the agent's conversations, so
            // this grants nothing new to anyone who can see it.
            // The URL first, because opening it is what most people will do and the page does the
            // exchange properly — it POSTs the token rather than spending it on a GET. The `curl`
            // line stays for the case a browser cannot reach: a headless box, a CI step, a platform
            // minting its first key.
            process.stdout.write(
                `  open once to claim this server:\n    ${claimUrl(host, running.port, claim.token)}\n` +
                    `    without a browser: ${claimCommand(host, running.port, claim.token)}\n`,
            )
            if (token === undefined || token === "") {
                // The latch in `createHandler`: a live key makes this server demand a credential.
                // Said out loud, because minting one on an open server *changes* what the server
                // is, and discovering that by being locked out of your own loopback port is the
                // worst way to learn it.
                process.stdout.write(
                    "    the first key closes this server — every route then needs a credential.\n",
                )
            }
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
    let stopped = false
    const shutdown = async () => {
        if (stopped) return
        stopped = true
        await running.stop()
        await runtime.stop("interrupted")
    }
    onExit(shutdown)

    await stopRequested

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
