/**
 * A typed client for the Dispach agent server.
 *
 * ```ts
 * const client = createClient({ baseUrl: "http://localhost:7420", token })
 * const agent = client.agent("milo")
 *
 * const turn = await agent.send("what's on my calendar?")
 * for await (const token of turn.tokens()) process.stdout.write(token)
 *
 * // or, later, from anywhere:
 * const text = await agent.turn(turn.turnId).text()
 * ```
 *
 * **No dependency beyond the standard library and core.** `fetch`, `ReadableStream` and
 * `AbortController` are all platform now, and core supplies the SSE parser and the event types —
 * so `EventDataMap` is imported rather than restated, and this package cannot drift from the
 * runtime's own catalogue. That is the same argument `spec.test.ts` makes about the document.
 *
 * **Turns are detached from the connection, and this client cannot change that.** `send` returns
 * once the server has accepted the turn; dropping the iterator, losing the socket or exiting the
 * process does not cancel it. Only `stop()` does. That is a property of the protocol rather than a
 * convenience of the SDK, and a client that cancelled on disconnect would be lying about it.
 */

import type { AnyEvent, EventDataMap, EventType, ScheduleRecord, TurnSender } from "@dispach/core"
import { DispachError, errorFromResponse, transportError, type WireError } from "./errors.ts"
import {
    type EventStreamItem,
    eventStreamItems,
    type TurnStreamItem,
    textDeltas,
    turnStreamItems,
} from "./stream.ts"

/**
 * Re-exported so a caller building a `from` does not need a second import.
 *
 * Re-exported rather than restated: a local copy of this shape could gain a `trust` field that the
 * wire has no way to honour, and the whole design of `from` is that trust is derived from `kind`
 * and cannot be stated separately.
 */
export type { SenderKind, TurnSender } from "@dispach/core"
export { DispachError, type WireError } from "./errors.ts"
export type {
    EventStreamItem,
    ReplayReport,
    SubscribedReport,
    TurnStreamItem,
} from "./stream.ts"

export interface ClientOptions {
    /** `http://host:port`, with or without a trailing slash. `/v1` is added by this client. */
    readonly baseUrl: string
    /**
     * The bearer token. Optional because a loopback server may be configured without one — and
     * omitting it against a server that wants one produces a `401 unauthorized`, which is the
     * correct and legible failure rather than something this client should guess about.
     */
    readonly token?: string
    /** Injectable for tests and for a runtime with its own instrumented `fetch`. */
    readonly fetch?: typeof fetch
}

/** What `POST /messages` returns, and the handle for everything you can then do with it. */
export interface TurnHandle {
    readonly turnId: string
    readonly sessionKey: string
    /**
     * This send was an idempotent **replay**: nothing ran, and this is the original turn.
     *
     * `false` on every handle that is not one, including a reattach handle from `agent.turn(id)`,
     * so a caller never has to distinguish absent from false. Worth branching on when the send is
     * the trigger for something else — enqueueing a notification twice because a retry looked like
     * a fresh turn is the failure the key exists to prevent, and it is only avoidable if the caller
     * can see that it happened.
     */
    readonly replayed: boolean
    /**
     * Every frame, as a discriminated union: the replay report, the events, and whichever of the
     * three endings applies. The honest view, and the one to use when assembling anything.
     */
    stream(options?: StreamOptions): AsyncGenerator<TurnStreamItem>
    /**
     * The reply's text deltas. Throws `replay_truncated` rather than yielding a fragment whose
     * front is missing — pass `{ allowTruncated: true }` to accept one knowingly.
     */
    tokens(options?: StreamOptions & { readonly allowTruncated?: boolean }): AsyncGenerator<string>
    /** Wait for the turn to finish and return its stored text. */
    text(): Promise<string>
    /** The stored row, once the turn has finished. */
    get(): Promise<TurnRecordLike>
    /** Cooperative cancel. Partial content is persisted on this path and never on a disconnect. */
    stop(): Promise<void>
}

export interface StreamOptions {
    /**
     * Per-token `model.chunk` frames. **Default off, and the reader decides.**
     *
     * Not caution: a token event is one envelope and one ISO timestamp per token, and most clients
     * are watching a turn's progress rather than animating its text. Asking for a stream and
     * asking for the tokens in it are two requests.
     */
    readonly chunks?: boolean
    /** Aborts the HTTP request. **Does not cancel the turn** — `stop()` does. */
    readonly signal?: AbortSignal
}

/** The turn row, kept structural so this package does not re-declare core's store types. */
export interface TurnRecordLike {
    readonly turnId: string
    readonly sessionKey: string
    readonly status: string
    readonly text: string
    readonly steps: number
    readonly promptTokens: number
    readonly outputTokens: number
    readonly errorCode?: string
    /** Who sent the input. Absent means the token-holder — not "unknown". */
    readonly sender?: string
    readonly senderName?: string
    readonly senderKind?: "user" | "agent"
}

export interface SendOptions {
    readonly sessionKey?: string
    /** `"none"`, a channel id, or `{ channel, to }`. See the spec — a bare id needs a recipient. */
    readonly deliver?: string | { readonly channel: string; readonly to: string }
    /**
     * Who sent this, when it was not you.
     *
     * `kind: "agent"` is a declaration with teeth: the server fences the text as data and blocks
     * mutating tools for the whole turn. There is no separate `trust` field here for the same
     * reason there is none on the wire — the pair could then disagree, and the dangerous half is
     * the one that would win quietly.
     */
    readonly from?: TurnSender
    /**
     * Makes this send safe to retry.
     *
     * Sent as the `Idempotency-Key` header. A second send with the same key and the same text
     * returns the **first** turn's handle with `replayed` set, having run nothing; the same key
     * with different text is a `DispachError` (`idempotency_key_reused`) rather than a silent
     * replay of a message you did not send. Remembered by the server for 24 hours.
     */
    readonly idempotencyKey?: string
    readonly signal?: AbortSignal
}

export interface AgentClient {
    readonly id: string
    /** Start a turn. Returns once accepted; the turn runs detached. */
    send(text: string, options?: SendOptions): Promise<TurnHandle>
    /** A handle for a turn id you already hold — the reattach path. */
    turn(turnId: string): TurnHandle
    describe(): Promise<AgentDescriptionLike>
    tools(): Promise<readonly ToolSummary[]>
    skills(): Promise<SkillsReport>
    sessions(): Promise<readonly SessionSummary[]>
    /**
     * A page of one conversation, newest first.
     *
     * Needed by anything that *resumes* rather than watches: an attached terminal or a browser tab
     * opening onto a conversation has to paint what is already there, and the event stream only
     * carries what happens next. Without this a resumed session shows a blank screen above a live
     * prompt, which is the failure `seedHistory` was written for on the embedded path.
     */
    messages(sessionKey: string, options?: MessagesOptions): Promise<MessagePageLike>
    /**
     * Clear a conversation's history. Memory files on disk are untouched, and the server says so.
     *
     * Deliberately not called `delete`: the session key keeps working and the next message starts
     * it again, so this empties rather than removes. A name implying removal would invite a caller
     * to treat a cleared key as unusable.
     */
    clearSession(sessionKey: string): Promise<{ readonly memoryFilesKept: boolean }>
    /**
     * Re-read the manifest by **replacing** the agent — a new instance, not a mutated one.
     *
     * `adopted` lists everything that came back, which is more than one agent when the target is a
     * supervisor: a team loads from one manifest as one unit. Answers 409 while a turn is running
     * rather than aborting it, so a caller applying a config change retries instead of assuming.
     */
    reload(): Promise<{ readonly id: string; readonly adopted: readonly string[] }>
    schedules(): Promise<readonly ScheduleRecord[]>
    context(options?: { readonly sessionKey?: string; readonly input?: string }): Promise<unknown>
    /**
     * What is waiting on a person right now, oldest first.
     *
     * The recovery path. `approval.requested` on the stream is how a live client learns about a
     * question; this is how one that missed it — opened late, refreshed, a second operator —
     * discovers why a turn has visibly stopped. A UI that only listens will lose prompts to a page
     * reload, which is the same failure turn reattach exists to prevent.
     */
    approvals(): Promise<readonly PendingApproval[]>
    /**
     * Answer one. Throws `approval_not_found` when it is no longer waiting.
     *
     * That covers answered-already and abandoned-with-its-turn alike, deliberately: nothing about a
     * settled approval is kept, so there is no state to tell them apart with. Watch
     * `approval.resolved` for `by: "abandoned"` if you need to take a prompt down for the right
     * reason.
     */
    approve(approvalId: string, granted: boolean): Promise<void>
    /**
     * Switch this agent off — durably, and out of the host now.
     *
     * Two effects in one call and both are needed: the store row survives a restart, and the host
     * drops the agent immediately. It is not a signal — since one process hosts several agents,
     * signalling the process would take the others with it.
     *
     * Throws `agent_turn_in_flight` (409) while a turn is running. The row is written first either
     * way, so the agent is off at the next start even when the teardown is refused.
     */
    stop(reason?: string): Promise<AgentLifecycleState>
    /**
     * Switch it back on, and have the host adopt it now.
     *
     * Throws `start_not_supported` (501) on a server with no way to look up a manifest for an agent
     * it is not hosting — an embedder over its own agent store, or the container image, which
     * passes none on purpose.
     */
    start(): Promise<AgentLifecycleState>
}

/** What `stop` and `start` report back. */
export interface AgentLifecycleState {
    readonly id: string
    readonly status: "loaded" | "disabled"
    /**
     * When it was last switched off, and why — **kept through a later start**, as the record of
     * what happened. So a started agent legitimately carries both, and a reader has to look at
     * `status` rather than at their presence.
     */
    readonly disabledAt?: string
    readonly reason?: string
    /** Which agents the host took on. A supervisor brings its team, so this can be several. */
    readonly adopted?: readonly string[]
}

/** A question waiting on somebody. */
export interface PendingApproval {
    readonly approvalId: string
    /** Which agent is asking. Always the agent in the path — a listing never crosses agents. */
    readonly agentId: string
    readonly slug: string
    readonly callId: string
    /** The command or path a rule would match — what the person actually needs to read. */
    readonly match?: string
    readonly mutating: boolean
    readonly reason: string
    readonly requestedAt: string
}

/**
 * An agent in the listing, or at the head of its own resource.
 *
 * **Most fields are optional because a stopped agent is listed too.** `GET /v1/agents` carries a
 * thin `{ id, name, status: "disabled", reason? }` row for one — it is not loaded, so there is no
 * manifest in memory to report a model or a window from, and loading one to fill the row in would
 * make a listing depend on the agent's credentials being present, which is the defect
 * `readManifestHeader` exists to avoid. Read `status` first: `"disabled"` means the rest is absent
 * by design rather than missing by accident.
 */
export interface AgentDescriptionLike {
    readonly id: string
    readonly name: string
    readonly status: string
    readonly model?: string
    readonly dialect?: string
    readonly window?: number
    readonly tools?: number
    /** What the catalogue costs per turn. A tool *count* says nothing about the bill. */
    readonly catalogueTokens?: number
    readonly skills?: number
    readonly schedules?: number
    readonly entryPhase?: string | null
    readonly phases?: readonly string[]
    /**
     * Each channel's last reported state. `unknown[]` until 16.6, which is why the web UI cast.
     *
     * `status` is deliberately a plain `string` and not `ChannelStatus`: the set can grow inside
     * `v: 1`, and a closed union here would make a server one member ahead of this package a type
     * error rather than a state a client renders generically. `input` is present only with
     * `needs_input` and its `kind` is `string` for the same reason.
     */
    readonly channels?: readonly {
        readonly id: string
        readonly type: string
        readonly status: string
        readonly detail?: string
        readonly input?: {
            readonly kind: string
            readonly payload: string
            readonly issuedAt: string
            readonly expiresAt?: string
        }
    }[]
    readonly warnings?: readonly WireError[]
    /** Set on a `disabled` row: when it was switched off, and why if anybody said. */
    readonly disabledAt?: string
    readonly reason?: string
}

export interface ToolSummary {
    readonly slug: string
    readonly summary: string
    readonly mutating: boolean
    readonly trust: string
    /** Why a tool declares itself trusted when a provider tool defaults to untrusted. */
    readonly trustReason?: string
    readonly provider: string
    readonly tags: readonly string[]
    /** Absent on an unphased agent — which is not the same as "visible in no phase". */
    readonly phases?: readonly string[]
}

export interface SkillsReport {
    /** `false` when the agent declares no `skills:` block at all. */
    readonly configured: boolean
    readonly maxActive?: number
    readonly threshold?: number
    readonly cached?: boolean
    readonly skills: readonly {
        readonly name: string
        readonly description: string
        readonly tokens: number
        readonly whenNotToUse?: string
        readonly scripts: readonly string[]
    }[]
}

/**
 * One stored message, as a page returns it.
 *
 * `origin` is what a resuming client filters on and the field most easily got wrong: it is set
 * only when the *harness* wrote the row (`observation`, `call`, `repair`, `digest`), and absent for
 * a person's message and the model's prose. So a transcript is built from an **allowlist of
 * absent-or-prose**, never a blocklist — `lib/resume.ts` in the CLI owns that rule for the same
 * reason `endNote` is shared: it has been written wrong twice.
 */
export interface StoredMessageLike {
    /** Monotonic within a store, and the ordering key. Never sort by timestamp, which can tie. */
    readonly id: number
    readonly role: string
    readonly content: string
    readonly turnId?: string
    readonly origin?: string
    readonly createdAt?: string
}

export interface MessagePageLike {
    readonly messages: readonly StoredMessageLike[]
    /** Feed back as `before` for the previous page. Absent once the first message is included. */
    readonly nextBefore?: number
}

/**
 * One conversation, as `GET /v1/agents/:id/sessions` returns it.
 *
 * This declared four fields while the route sent the store's whole `SessionSummary` — `messages`
 * and `phase` among them. Under-declaring is not harmless: a session picker cannot show how long a
 * conversation is, and the field is *there*, so the only way to find out is to read the server. The
 * same shape as `channels` being `readonly unknown[]` until 16.6.
 */
export interface SessionSummary {
    readonly sessionKey: string
    readonly channel: string
    readonly peerId: string
    readonly turns: number
    readonly messages: number
    readonly lastActivityAt: string
    readonly createdAt: string
    readonly updatedAt: string
    readonly thread?: string
    /** Phase-scoped tool visibility, persisted per session. Absent on an unphased agent. */
    readonly phase?: string
}

export interface MessagesOptions {
    /** The cursor from a previous page's `nextBefore`. Absent starts at the newest. */
    readonly before?: number
    readonly limit?: number
}

export interface EventStreamOptions {
    readonly agentId?: string
    /**
     * Event types to receive. An unknown type is **refused** with `unknown_event_type` naming the
     * nearest real one, rather than opening a stream that matches nothing — so a typo here is an
     * error at the call rather than a silence forever.
     *
     * Naming `model.chunk` turns `chunks` on by itself; the `subscribed` report says so.
     */
    readonly types?: readonly EventType[]
    readonly chunks?: boolean
    readonly signal?: AbortSignal
}

export interface DispachClient {
    agent(id: string): AgentClient
    /** Every agent this runtime hosts. */
    agents(): Promise<readonly AgentDescriptionLike[]>
    health(): Promise<{ status: string; version: string; uptimeMs: number; agents: number }>
    /** `true` once the runtime can serve a turn. Needs no token. */
    ready(): Promise<boolean>
    /** The firehose. Every event, optionally narrowed. */
    events(options?: EventStreamOptions): AsyncGenerator<EventStreamItem>
}

/** Narrow an event by type, so a `switch` over a stream keeps its `data` typed. */
export function isEvent<K extends EventType>(
    event: AnyEvent,
    type: K,
): event is AnyEvent & { type: K; data: EventDataMap[K] } {
    return event.type === type
}

export function createClient(options: ClientOptions): DispachClient {
    const base = options.baseUrl.replace(/\/+$/, "")
    const doFetch = options.fetch ?? fetch

    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...extra,
    })

    /**
     * One request path, so the token, the error mapping and the transport wrapping happen once.
     *
     * A per-method copy of this is how one endpoint comes to throw a raw `TypeError` while its
     * neighbours throw `DispachError` — and a caller cannot write one `catch` against that.
     */
    async function request(
        method: string,
        path: string,
        init: {
            readonly body?: unknown
            readonly signal?: AbortSignal
            readonly accept?: string
            /**
             * Per-request headers, merged last.
             *
             * Merged last so a caller cannot displace the bearer token by accident — an
             * `authorization` supplied here loses to the client's own, which is the direction that
             * fails safely. `Idempotency-Key` is the only current user.
             */
            readonly headers?: Readonly<Record<string, string>>
        } = {},
    ): Promise<Response> {
        let response: Response
        try {
            response = await doFetch(`${base}${path}`, {
                method,
                headers: headers({
                    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
                    ...(init.accept === undefined ? {} : { accept: init.accept }),
                    ...init.headers,
                }),
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                ...(init.signal === undefined ? {} : { signal: init.signal }),
            })
        } catch (error) {
            throw transportError(error, { method, path, baseUrl: base })
        }
        if (!response.ok) throw await errorFromResponse(response, { method, path })
        return response
    }

    async function json<T>(
        method: string,
        path: string,
        init?: {
            readonly body?: unknown
            readonly signal?: AbortSignal
            readonly headers?: Readonly<Record<string, string>>
        },
    ): Promise<T> {
        return (await (await request(method, path, init ?? {})).json()) as T
    }

    /** The body of an SSE response, or a typed error naming why there is none. */
    async function streamBody(
        path: string,
        signal?: AbortSignal,
    ): Promise<ReadableStream<Uint8Array>> {
        const response = await request("GET", path, {
            accept: "text/event-stream",
            ...(signal === undefined ? {} : { signal }),
        })
        if (response.body === null) {
            throw new DispachError(
                {
                    code: "no_response_body",
                    message: `GET ${path} returned ${response.status} with no body to read.`,
                    hint: "An SSE route always has a body. A missing one means something between you and the server buffered the response — commonly a proxy without streaming enabled.",
                },
                { status: response.status, method: "GET", path },
            )
        }
        return response.body
    }

    function turnHandle(
        agentId: string,
        turnId: string,
        sessionKey: string,
        facts: { readonly replayed?: boolean } = {},
    ): TurnHandle {
        const query = (opts?: StreamOptions) => (opts?.chunks === true ? "?chunks=true" : "")

        const handle: TurnHandle = {
            turnId,
            sessionKey,
            replayed: facts.replayed === true,

            async *stream(opts) {
                const body = await streamBody(
                    `/v1/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}/stream${query(opts)}`,
                    opts?.signal,
                )
                yield* turnStreamItems(body)
            },

            async *tokens(opts) {
                yield* textDeltas(handle.stream({ chunks: true, ...opts }), {
                    ...(opts?.allowTruncated === undefined
                        ? {}
                        : { allowTruncated: opts.allowTruncated }),
                })
            },

            async text() {
                // Drains the stream to its end rather than polling the row, so this returns as
                // soon as the turn finishes instead of on the next poll interval — and then reads
                // the row, because the store is canonical and a stream may have been reattached
                // after the reply began.
                for await (const item of handle.stream()) {
                    if (item.kind === "ended") break
                    if (item.kind === "unavailable") break
                    if (item.kind === "event" && item.event.type === "turn.end") break
                }
                return (await handle.get()).text
            },

            get: () =>
                json<TurnRecordLike>(
                    "GET",
                    `/v1/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}`,
                ),

            async stop() {
                await request(
                    "POST",
                    `/v1/agents/${encodeURIComponent(agentId)}/turns/${encodeURIComponent(turnId)}/stop`,
                )
            },
        }
        return handle
    }

    function agent(id: string): AgentClient {
        const at = (suffix: string) => `/v1/agents/${encodeURIComponent(id)}${suffix}`
        return {
            id,

            async send(text, opts) {
                const accepted = await json<{
                    turnId: string
                    sessionKey: string
                    replayed?: boolean
                }>("POST", at("/messages"), {
                    body: {
                        text,
                        ...(opts?.sessionKey === undefined ? {} : { sessionKey: opts.sessionKey }),
                        ...(opts?.deliver === undefined ? {} : { deliver: opts.deliver }),
                        ...(opts?.from === undefined ? {} : { from: opts.from }),
                    },
                    ...(opts?.idempotencyKey === undefined
                        ? {}
                        : { headers: { "idempotency-key": opts.idempotencyKey } }),
                    ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
                })
                // Deliberately **not** `stream: true`. The inline stream and the reattach path
                // would then be two code paths producing the same union, and the difference only
                // shows up under load — a class of bug this project has paid for twice. One extra
                // request buys one implementation, and the buffer is opened at acceptance, so
                // attaching immediately afterwards is a guarantee rather than a race.
                return turnHandle(id, accepted.turnId, accepted.sessionKey, {
                    replayed: accepted.replayed === true,
                })
            },

            turn: (turnId) => turnHandle(id, turnId, ""),
            describe: () => json<AgentDescriptionLike>("GET", at("")),
            tools: () => json<readonly ToolSummary[]>("GET", at("/tools")),
            skills: () => json<SkillsReport>("GET", at("/skills")),
            sessions: () => json<readonly SessionSummary[]>("GET", at("/sessions")),

            messages: (sessionKey, options) => {
                const query = new URLSearchParams()
                if (options?.before !== undefined) query.set("before", String(options.before))
                if (options?.limit !== undefined) query.set("limit", String(options.limit))
                const suffix = query.size === 0 ? "" : `?${query.toString()}`
                return json<MessagePageLike>(
                    "GET",
                    at(`/sessions/${encodeURIComponent(sessionKey)}/messages${suffix}`),
                )
            },

            clearSession: (sessionKey) =>
                json<{ memoryFilesKept: boolean }>(
                    "DELETE",
                    at(`/sessions/${encodeURIComponent(sessionKey)}`),
                ),

            reload: () =>
                json<{ id: string; adopted: readonly string[] }>("POST", at("/reload"), {
                    body: {},
                }),

            schedules: () => json<readonly ScheduleRecord[]>("GET", at("/schedules")),

            approvals: async () =>
                (await json<{ approvals: readonly PendingApproval[] }>("GET", at("/approvals")))
                    .approvals,

            approve: async (approvalId, granted) => {
                await json<unknown>("POST", at(`/approvals/${encodeURIComponent(approvalId)}`), {
                    // Always sent, never defaulted. The server refuses a body without it for the
                    // reason the mechanism exists: one default denies a call over a typo and the
                    // other grants one, and neither is a decision anybody made.
                    body: { granted },
                })
            },

            stop: (reason) =>
                json<AgentLifecycleState>("POST", at("/stop"), {
                    body: reason === undefined ? {} : { reason },
                }),

            start: () => json<AgentLifecycleState>("POST", at("/start"), { body: {} }),

            context: (opts) => {
                const params = new URLSearchParams()
                if (opts?.sessionKey !== undefined) params.set("sessionKey", opts.sessionKey)
                if (opts?.input !== undefined) params.set("input", opts.input)
                const query = params.size === 0 ? "" : `?${params.toString()}`
                return json<unknown>("GET", at(`/context${query}`))
            },
        }
    }

    return {
        agent,
        agents: () => json<readonly AgentDescriptionLike[]>("GET", "/v1/agents"),
        health: () =>
            json<{ status: string; version: string; uptimeMs: number; agents: number }>(
                "GET",
                "/v1/health",
            ),

        async ready() {
            // `503` is a real answer here rather than an error — "not yet" — so this is the one
            // place a non-2xx is read instead of thrown. Anything else still throws.
            try {
                await request("GET", "/v1/ready")
                return true
            } catch (error) {
                if (error instanceof DispachError && error.status === 503) return false
                throw error
            }
        },

        async *events(opts) {
            const params = new URLSearchParams()
            if (opts?.agentId !== undefined) params.set("agentId", opts.agentId)
            if (opts?.types !== undefined && opts.types.length > 0) {
                params.set("types", opts.types.join(","))
            }
            if (opts?.chunks === true) params.set("chunks", "true")
            const query = params.size === 0 ? "" : `?${params.toString()}`
            const body = await streamBody(`/v1/events${query}`, opts?.signal)
            yield* eventStreamItems(body)
        },
    }
}
