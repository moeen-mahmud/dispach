/**
 * What a chat view needs from an agent, and the two ways of supplying it.
 *
 * ## Why this exists
 *
 * `run` built a `Runtime` in its own process and handed the resulting `Agent` and `EventBus`
 * straight to the screen. That was right while the CLI *was* the product; it stopped being right
 * the moment a server is always on, because `run` then starts a **second** runtime for an agent
 * something else is already hosting. Two processes on one SQLite file is not two views of one
 * conversation — it is two writers, and slot 2 told the model as much (`declined`, decision 5.17),
 * which is the runtime being honest about a situation nobody wanted.
 *
 * So the screen takes an `AgentSource` instead. `embeddedSource` is today's behaviour, for the
 * cases where nothing else is hosting: a container, CI, `--ephemeral`, a machine whose bootstrap
 * was suppressed. `remoteSource` is the same shape over `/v1`, and is what a terminal gets when a
 * live host holds the agent.
 *
 * ## Why the two implementations are small
 *
 * Because the *views* were already projections. `toolsView` takes a structural `AgentToolsSource`
 * rather than an `Agent`, `ContextView` and `SessionRowSource` are plain data, and `endNote` lives
 * in core precisely so four callers cannot word a turn's ending four ways. Almost nothing here
 * formats anything; it fetches, and hands back the shapes the formatters already read.
 *
 * ## The one thing that is genuinely different
 *
 * **Cancellation.** Embedded, a turn is an in-process promise and an `AbortController` reaches it.
 * Attached, the turn belongs to the server — the recorded rule is that turns are detached from the
 * client connection and are never cancelled on disconnect — so stopping one is a *request*, naming
 * the turn. `send` takes a signal on both paths and each honours it its own way, so the caller
 * keeps one contract and `useTurn` never learns which it is talking to.
 */

import type { AnyEvent, ErrorDetail, StreamFilter, TurnEndReason } from "@dispach/core"
import { createNltStreamFilter, passThroughFilter } from "@dispach/core/wire"
import { priorMessages } from "#lib/resume"
import { type ContextView, type ToolsView, toolsView } from "#lib/session-commands"
import type { PriorMessage } from "#transcript"

/** The facts a banner, a status line and a reasoning decision are made from. */
export interface SourceDescription {
    readonly agentId: string
    readonly name: string
    readonly model: string
    readonly dialect: string
    readonly window: number
    /** What the catalogue costs per turn — the figure `/tools` reports and a person trims against. */
    readonly catalogueTokens: number
    /** `"none"` when the model does not reason, which is what decides streaming it by default. */
    readonly thinking: string
    readonly warnings: readonly ErrorDetail[]
}

/** One conversation, as the session picker reads it. */
export interface SourceSession {
    readonly sessionKey: string
    readonly channel: string
    readonly turns: number
    readonly messages: number
    readonly lastActivityAt: string
    readonly phase?: string
}

export interface SendOptions {
    readonly sessionKey: string
    readonly signal: AbortSignal
}

/**
 * How a turn ended, in the shape both renderers already read.
 *
 * `send` resolves with this rather than `void` because the plain path needs it: `endNote` takes a
 * reason and a step count, `endedBadly` decides the exit status, and the stats line is the one
 * thing a scripted run prints that is not the reply. Attached, every field comes off `turn.end`
 * and the `error` event rather than out of a returned object — which is the same information, and
 * is why this is a shape rather than core's `TurnResult`.
 */
export interface TurnOutcome {
    /** The reply. Empty on the streaming path, where it has already been written out. */
    readonly text: string
    readonly reason: TurnEndReason
    readonly steps: number
    readonly durationMs: number
    readonly tokens: { readonly prompt: number; readonly output: number }
    readonly error?: ErrorDetail
}

export interface AgentSource {
    /**
     * Which of the two this is.
     *
     * Read by the banner and by `/status`, never to choose behaviour — a caller branching on this
     * is a caller that should have been given a method. The one legitimate use is telling somebody
     * what they are looking at, and that is exactly the sentence a person needs when the same
     * command does two things.
     */
    readonly kind: "embedded" | "attached"
    readonly agentId: string
    /** Where the agent actually runs, when it is somewhere else. */
    readonly host?: { readonly baseUrl: string; readonly pid: number }

    describe(): SourceDescription
    /**
     * Every event for this runtime, chunks included. Returns the unsubscribe.
     *
     * Chunks are not optional and never have been: this is the one wildcard subscriber in the tree
     * that genuinely wants per-token frames, which is why they are opt-in everywhere else. Dropping
     * the flag does not break anything loudly — the TUI simply stops streaming.
     */
    subscribe(handler: (event: AnyEvent) => void): () => void
    /** Resolves when the turn has ended, on both paths, so `busy` means the same thing. */
    send(text: string, options: SendOptions): Promise<TurnOutcome>
    /**
     * A fresh filter for the dialect in use.
     *
     * The wire carries **unfiltered** chunks — deliberately, since a stream nobody has filtered is
     * the one a debugger wants and the tool block is what the next model call sees. So an attached
     * view does the same work the embedded one does, from the dialect its description already
     * carries. Without it a chat bubble shows `ACTION: now / format: human / END`.
     */
    streamFilter(): StreamFilter
    history(sessionKey: string): Promise<readonly PriorMessage[]>
    sessions(): Promise<readonly SourceSession[]>
    clearSession(sessionKey: string): Promise<void>
    tools(): Promise<ToolsView>
    context(sessionKey: string): Promise<ContextView>
    /**
     * Ask the **host** to replace this agent. Present only when attached.
     *
     * Absent means the caller owns the runtime and rebuilds it itself, which is what `/restart` has
     * always done — the optional method is the capability, the same way `AppProps.catalogue` and
     * `status` are. Resolves with every agent that came back: replacing a supervisor replaces its
     * team, because they load from one manifest as one unit.
     */
    readonly reload?: () => Promise<readonly string[]>
    /** Release whatever this holds. Never stops the agent — an attached view owns nothing. */
    close(): Promise<void>
}

/** The parts of a live `Agent` this needs, structurally, so a test needs no runtime. */
export interface EmbeddedAgent {
    readonly id: string
    describe(): { readonly dialect: string; readonly catalogueTokens: number }
    readonly tools: {
        specs(): readonly {
            readonly slug: string
            readonly mutating: boolean
            readonly trust?: string
            readonly trustReason?: string
            readonly summary: string
        }[]
    }
}

/** The bus half, equally narrow. */
export interface EmbeddedBus {
    on(
        type: "*",
        handler: (event: AnyEvent) => void,
        options?: { readonly chunks?: boolean },
    ): () => void
}

/** `createNltStreamFilter` for `nlt`, a pass-through otherwise. One place decides it. */
export function filterFor(dialect: string): StreamFilter {
    return dialect === "nlt" ? createNltStreamFilter() : passThroughFilter()
}

/**
 * Today's behaviour, unchanged, behind the interface.
 *
 * Everything here is a one-liner over an object this process already holds, which is the point: the
 * embedded path must not get slower or subtler for the sake of the remote one, and a reader should
 * be able to see at a glance that nothing was smuggled in.
 */
export function embeddedSource(input: {
    readonly agent: EmbeddedAgent
    readonly bus: EmbeddedBus
    /** `agent.send`, narrowed — the loop's own signature, not re-declared here. */
    readonly send: (text: string, options: SendOptions & { source: "repl" }) => Promise<TurnOutcome>
    readonly history: (sessionKey: string) => Promise<readonly PriorMessage[]>
    readonly sessions: () => Promise<readonly SourceSession[]>
    readonly clearSession: (sessionKey: string) => Promise<void>
    readonly context: (sessionKey: string) => Promise<ContextView>
    readonly streamFilter: () => StreamFilter
    readonly description: SourceDescription
}): AgentSource {
    return {
        kind: "embedded",
        agentId: input.agent.id,
        describe: () => input.description,
        // `{ chunks: true }` is not a tuning knob. Every other wildcard subscriber — `/v1/events`,
        // the WebSocket bridge, every plugin watcher — must stay off the per-token path, so the
        // flag is opt-in and this is the one caller that opts in.
        subscribe: (handler) => input.bus.on("*", handler, { chunks: true }),
        send: (text, options) => input.send(text, { ...options, source: "repl" }),
        streamFilter: input.streamFilter,
        history: input.history,
        sessions: input.sessions,
        clearSession: input.clearSession,
        // Built from the live registry rather than fetched, and `toolsView` takes the structural
        // source rather than an `Agent`, which is why this is a projection and not a copy.
        tools: async () => toolsView(input.agent),
        context: input.context,
        // No `reload`: the caller owns the runtime and rebuilds it. `/restart` has always worked
        // that way, and an optional method is how this interface spells a capability.
        close: async () => {},
    }
}

/**
 * The same shape over `/v1`, for an agent something else is already hosting.
 *
 * Three things here are not translations of the embedded path, and each is a decision.
 *
 * **One subscription, not two.** The events come from `GET /v1/events` and the turn is followed on
 * that same stream. Using a turn's own `/stream` as well would deliver every chunk twice, because
 * the firehose already carries them — so `send` resolves by watching for its own `turn.end` rather
 * than by draining a second stream.
 *
 * **Cancellation is a request.** Turns are detached from the client connection by design and are
 * never cancelled on disconnect, so an abort here POSTs a stop naming the turn. It is best-effort
 * in one specific way worth knowing: the turn id only exists once the send has been accepted, so an
 * abort in the window before that is remembered and applied when the id arrives, rather than lost.
 *
 * **Filtering is ours.** The wire carries unfiltered chunks — deliberately, per the wire entry's
 * own docstring — so this rebuilds the dialect's filter from the description it already fetched.
 * Without it a reply renders as `ACTION: now / format: human / END`.
 */
/**
 * The parts of the API client this needs, structurally.
 *
 * Narrow for the same two reasons `EmbeddedAgent` is — a fake is a plain object, and anything else
 * reached for is a type error rather than a surprise — and for a third: naming the client's own
 * exported type would put the product name in a `packages/cli` source file, which hard rule 3 and
 * a boundaries test both forbid. The real client satisfies this without being named.
 */
export interface ApiClient {
    agent(id: string): {
        send(
            text: string,
            options?: { readonly sessionKey?: string },
        ): Promise<{ readonly turnId: string }>
        turn(turnId: string): { stop(): Promise<void> }
        messages(sessionKey: string): Promise<{
            readonly messages: readonly {
                readonly role: string
                readonly content: string
                readonly origin?: string
            }[]
        }>
        clearSession(sessionKey: string): Promise<unknown>
        reload(): Promise<{ readonly adopted: readonly string[] }>
        tools(): Promise<
            readonly {
                readonly slug: string
                readonly summary: string
                readonly mutating: boolean
                readonly trust: string
                readonly trustReason?: string
            }[]
        >
        sessions(): Promise<readonly SourceSession[]>
        context(options: { readonly sessionKey: string }): Promise<unknown>
    }
    events(options: {
        readonly agentId?: string
        readonly chunks?: boolean
        readonly signal?: AbortSignal
    }): AsyncGenerator<{ readonly kind: string; readonly event?: AnyEvent }>
}

export function remoteSource(input: {
    readonly client: ApiClient
    readonly agentId: string
    /** Fetched once at attach, so `describe()` can stay synchronous like the embedded one. */
    readonly description: SourceDescription
    readonly host: { readonly baseUrl: string; readonly pid: number }
}): AgentSource {
    const agent = input.client.agent(input.agentId)
    /** Fans one SSE stream out to every subscriber, so attaching twice opens one connection. */
    const handlers = new Set<(event: AnyEvent) => void>()
    const abort = new AbortController()
    let pump: Promise<void> | undefined

    const start = (): void => {
        if (pump !== undefined) return
        pump = (async () => {
            for await (const item of input.client.events({
                agentId: input.agentId,
                // The one wildcard in the tree that genuinely wants tokens — see `AgentSource`.
                chunks: true,
                signal: abort.signal,
            })) {
                if (item.kind !== "event" || item.event === undefined) continue
                for (const handler of handlers) handler(item.event)
            }
        })().catch(() => {
            // A dropped stream is reported through the transcript by the turn that notices it, not
            // by throwing into a `for await` nobody is awaiting. Swallowing it here would be the
            // silent failure hard rule 8 forbids if this were the only signal — it is not: a send
            // whose `turn.end` never arrives rejects, which is where a person is actually looking.
        })
    }

    return {
        kind: "attached",
        agentId: input.agentId,
        host: input.host,
        describe: () => input.description,
        subscribe: (handler) => {
            handlers.add(handler)
            start()
            return () => handlers.delete(handler)
        },
        send: async (text, options) => {
            let stopped = false
            let turnId: string | undefined
            const onAbort = (): void => {
                stopped = true
                // Fire-and-forget: the abort is the caller saying stop, and a failed stop request
                // must not reject the send — the turn's own end is what resolves this.
                if (turnId !== undefined)
                    void agent
                        .turn(turnId)
                        .stop()
                        .catch(() => {})
            }
            options.signal.addEventListener("abort", onAbort, { once: true })

            /**
             * The outcome, assembled from the stream rather than returned by the send.
             *
             * `POST /messages` answers 202 the moment the turn is accepted — turns are detached
             * from the client connection by design — so everything the plain path prints comes off
             * `turn.end`, and the failure detail off the `error` event that precedes it. Collected
             * here rather than by the caller because both renderers would otherwise assemble it,
             * and two assemblies of one fact is how they come to disagree.
             */
            let failure: ErrorDetail | undefined
            const ended = new Promise<TurnOutcome>((resolve) => {
                const off = (event: AnyEvent): void => {
                    if (
                        turnId !== undefined &&
                        event.turnId !== undefined &&
                        event.turnId !== turnId
                    )
                        return
                    if (event.type === "error") {
                        failure = event.data
                        return
                    }
                    if (event.type !== "turn.end") return
                    handlers.delete(off)
                    resolve({
                        // Empty on purpose: the chunks have already been written by whoever is
                        // subscribed, and handing back a second copy would print the reply twice.
                        text: "",
                        reason: event.data.reason,
                        steps: event.data.steps,
                        durationMs: event.data.durationMs,
                        tokens: event.data.tokens,
                        ...(failure === undefined ? {} : { error: failure }),
                    })
                }
                handlers.add(off)
                start()
            })

            try {
                const handle = await agent.send(text, { sessionKey: options.sessionKey })
                turnId = handle.turnId
                // Aborted while the request was in flight. The listener above had no id to name, so
                // it is applied here instead of being dropped — the window is small and a stop that
                // silently did nothing is the worst available outcome for a cancel key.
                if (stopped)
                    void agent
                        .turn(turnId)
                        .stop()
                        .catch(() => {})
                return await ended
            } finally {
                options.signal.removeEventListener("abort", onAbort)
            }
        },
        streamFilter: () => filterFor(input.description.dialect),
        history: async (sessionKey) => {
            const page = await agent.messages(sessionKey)
            // Oldest-first for the screen; the API pages newest-first because that is how a UI
            // scrolls back. `priorMessages` decides what is shown — one rule, in `lib/resume.ts`,
            // because which origins count has been got wrong twice.
            return priorMessages(
                [...page.messages].reverse().map((message) => ({
                    role: message.role as "user" | "assistant",
                    content: message.content,
                    ...(message.origin === undefined ? {} : { origin: message.origin }),
                })) as Parameters<typeof priorMessages>[0],
                input.description.dialect as Parameters<typeof priorMessages>[1],
            )
        },
        sessions: () => agent.sessions(),
        clearSession: async (sessionKey) => {
            await agent.clearSession(sessionKey)
        },
        tools: async () => {
            const tools = await agent.tools()
            return {
                dialect: input.description.dialect,
                catalogueTokens: input.description.catalogueTokens,
                tools: tools.map((tool) => ({
                    slug: tool.slug,
                    mutating: tool.mutating,
                    trust: tool.trust,
                    ...(tool.trustReason === undefined ? {} : { trustReason: tool.trustReason }),
                    summary: tool.summary,
                })),
            }
        },
        context: async (sessionKey) => {
            // The route calls `previewContext` with the same arguments `send` does, so this is the
            // same object the embedded path builds — only `windowSource` is ours, because a
            // description carries the window and not where it came from.
            const preview = (await agent.context({ sessionKey })) as Omit<
                ContextView,
                "windowSource"
            > & {
                readonly compactions?: number
            }
            return {
                ...preview,
                windowSource: "as the host resolved it",
                ...(preview.lastCompaction === undefined && preview.compactions !== undefined
                    ? {
                          lastCompaction:
                              preview.compactions === 0
                                  ? undefined
                                  : `${preview.compactions} stage${preview.compactions === 1 ? "" : "s"} run this session`,
                      }
                    : {}),
            }
        },
        reload: async () => (await agent.reload()).adopted,
        close: async () => {
            abort.abort()
            handlers.clear()
        },
    }
}

/**
 * Whether something else is already hosting this agent, and where.
 *
 * Both halves matter and neither is guessable. A lease says **who** is serving an agent right now;
 * its `base_url` — published after the bind, cleared on takeover — says where, because a manifest's
 * `server.port` is only what the file asked for and `--port 0` means the port does not exist until
 * the socket does. A host serving no HTTP has a lease and no address, and cannot be attached to.
 *
 * `processAlive` is checked inside `liveHostOf` for the recorded reason: a lease row is a claim,
 * not a fact, and a boot that failed *after* claiming leaves a fresh heartbeat with no process
 * under it. A dead pid outranks a recent timestamp.
 */
export interface LiveHost {
    readonly baseUrl: string
    readonly pid: number
}

export function hostFrom(
    lease: { readonly pid: number; readonly baseUrl?: string } | undefined,
): LiveHost | undefined {
    if (lease?.baseUrl === undefined || lease.baseUrl === "") return undefined
    return { baseUrl: lease.baseUrl, pid: lease.pid }
}
