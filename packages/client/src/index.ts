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

/**
 * Re-exported, because a consumer of `schedules()` cannot name its own return type otherwise.
 *
 * The browser is the caller that made this a defect: it imports this package and **must not**
 * import `@dispach/core`'s barrel, which is 1.18 MB of Zod and a YAML parser (decision 11.199).
 * Telling it to reach past this package for a type is telling it to pay four hundred times the
 * bundle for one interface.
 */
export type { ScheduleRecord } from "@dispach/core"

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
    /** What was sent, raw. Always on the wire; declared late, which is why a list needed it. */
    readonly input: string
    readonly text: string
    readonly steps: number
    /**
     * The prompt the turn **ended** at, the last step's: a context-size figure, not what the turn
     * was billed. `usage()` sums every call.
     */
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
    /** What this agent cost, from the per-call meter. */
    usage(options?: UsageOptions): Promise<UsageReportLike & { readonly id: string }>
    /**
     * Every turn this agent has taken, newest first, across sessions. Pass the previous page's
     * `nextBefore` as `before`.
     */
    turns(options?: {
        readonly limit?: number
        readonly before?: number
    }): Promise<{ readonly turns: readonly TurnRecordLike[]; readonly nextBefore?: number }>
    /** The variables this agent's manifest reads, and whether each is set. Never a value. */
    secrets(): Promise<readonly SecretStatusLike[]>
    /**
     * Write credentials into the agent's `.env` and apply them: reloaded if hosted, adopted if it was
     * not running. Only names the manifest reads are accepted, all or nothing.
     */
    setSecrets(values: Readonly<Record<string, string>>): Promise<SecretsWrittenLike>
    schedules(): Promise<readonly ScheduleRecord[]>
    /**
     * Arm a schedule. The server validates the expression and the delivery target.
     *
     * Deliberately untyped beyond `Record`: the accepted shape is `prepareScheduleWrite`'s, in
     * core, and a second declaration of it here is a second definition of what a valid schedule is
     * — right when written and wrong at the next field.
     */
    createSchedule(schedule: Readonly<Record<string, unknown>>): Promise<ScheduleRecord>
    updateSchedule(
        scheduleId: string,
        patch: Readonly<Record<string, unknown>>,
    ): Promise<ScheduleRecord>
    deleteSchedule(scheduleId: string): Promise<void>
    /** Fire one now, out of band. Does **not** move its next scheduled run. */
    runSchedule(scheduleId: string): Promise<{
        readonly scheduleId: string
        readonly turnId: string
        readonly sessionKey: string
    }>
    /**
     * Every manifest field a person may set here, what it does, and its current value.
     *
     * The values are the manifest's **source** text, unexpanded — `${MODEL_ID}` comes back as
     * `${MODEL_ID}`. A caller that showed the loaded value and wrote it back would bake the
     * expansion in, turning a manifest that follows its environment into one that does not.
     */
    config(): Promise<AgentConfig>
    /**
     * Set one field, then let the server replace the agent so it takes effect.
     *
     * `value` is **text**, exactly as it is typed at a terminal, and core's `parseSettingValue`
     * reads it — a list is `["a", "b"]`, a map is `{k: v}`, a number is `40`. Not a JSON value,
     * deliberately: one parser serves both of the person's editors, and two would eventually
     * disagree about whether `["a", "b"]` is a list of two strings.
     *
     * Read `applied` rather than assuming it. The file is written before the agent is replaced and
     * `dispose` refuses while a turn is in flight, so a successful write can legitimately arrive
     * with `applied: false` and the reason under `pending` — the edit then takes effect at the next
     * start. Two fields need `confirm: true`; `config()` says which by carrying a `confirm`
     * sentence on the row.
     */
    setConfig(
        path: string,
        value: string,
        options?: { readonly confirm?: boolean },
    ): Promise<ConfigWriteResult>
    /**
     * Connect or disconnect a channel, and set its credential.
     *
     * One call for three things, because they are one decision — is this channel working — and a
     * client holding three call sites for one panel is how two of them come to disagree. The
     * credential is **write-only**: nothing reads one back, which is why there is no getter for it
     * and why `channels[]` on the agent resource reports only whether it is set.
     */
    setChannel(
        channelId: string,
        changes: { readonly enabled?: boolean; readonly credential?: string },
    ): Promise<ChannelWriteResult>
    /** Forget a channel's stored pairing, so the next start offers a new code to scan. */
    unpairChannel(channelId: string): Promise<{ readonly channelId: string; readonly note: string }>
    /** One conversation's summary. `sessions()` is the listing. */
    session(sessionKey: string): Promise<SessionSummary>
    /** Move a conversation into a phase the manifest declares. */
    setPhase(
        sessionKey: string,
        phase: string,
    ): Promise<{ readonly sessionKey: string; readonly phase: string }>
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

/** One editable manifest field, as `GET /v1/agents/:id/config` reports it. */
export interface ConfigSetting {
    /** Dotted, exactly as it appears in the file. */
    readonly path: string
    /** What it does, addressed to a person reading a list. */
    readonly means: string
    /**
     * Why a person is asked to confirm, when they are.
     *
     * Present on exactly two fields — the ones whose only purpose is to stop a check running. A
     * client must show this sentence and send `confirm: true` only after somebody has read it.
     */
    readonly confirm?: string
    /**
     * The current value, unexpanded. **Absent when the file does not set the field**, which is not
     * the same as set to nothing — it is what lets a control distinguish "unset" from "empty".
     */
    readonly value?: unknown
}

export interface AgentConfig {
    /**
     * `false` for an agent loaded from an object rather than a file.
     *
     * Named rather than implied by an empty list: an embedder's programmatic manifest has no file
     * behind it, and a client that could not tell would offer a form whose save can only fail.
     */
    readonly editable: boolean
    /** Absolute path of the manifest, when there is one. */
    readonly file?: string
    readonly settings: readonly ConfigSetting[]
}

/**
 * What a channel write reports.
 *
 * `notes` is a list because one request may do two things — set the credential and connect it — and
 * collapsing them into one sentence would lose whichever half somebody is checking. `applied`
 * separates the *write* from the agent picking it up: the manifest is written before the agent is
 * replaced, and `dispose` refuses while a turn is in flight, so `applied: false` with a reason is a
 * real and correct outcome rather than a failure.
 */
export interface ChannelWriteResult {
    readonly channelId: string
    readonly notes: readonly string[]
    readonly applied: boolean
    readonly pending?: WireError
}

export interface ConfigWriteResult {
    readonly path: string
    /** What was there. `undefined` when the field was not set. */
    readonly before: unknown
    readonly after: unknown
    /**
     * The source editor could not place the path, so the file was re-serialised.
     *
     * Worth surfacing rather than swallowing: a reflowed manifest is correct and its comments have
     * moved, which a person should hear from the thing that did it rather than from `git diff`.
     */
    readonly reflowed: boolean
    /** Whether the running agent was replaced, so the change is in force now. */
    readonly applied: boolean
    /** Why it is not, when `applied` is false. The write already happened either way. */
    readonly pending?: { readonly code: string; readonly message: string; readonly hint: string }
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

/**
 * One provisioning question, as `GET /v1/provision` serves it.
 *
 * Structural rather than imported from `@dispach/server`: the client talks to a wire, and a type
 * dependency on the server package would make a browser bundle pull Zod in for a form.
 */
export interface ProvisionStepLike {
    readonly step: string
    readonly prompt: string
    /** The default, already a value that may be sent back — never a menu index. */
    readonly fallback: string
    readonly optional: boolean
    /** Mask it. Written once into the agent's `.env` at `0600`; no route reads it back. */
    readonly secret: boolean
    /**
     * What opens this step, absent when it is always asked.
     *
     * Evaluate **transitively**: askable when the requirement is met *and* the step it names is
     * itself askable. `lib/provision-form.ts` in `@dispach/web` is the reference implementation.
     */
    readonly requires?: { readonly step: string; readonly value: string }
    readonly choices?: readonly {
        readonly value: string
        readonly label: string
        readonly hint?: string
    }[]
}

/** What this server will ask, and whether it can create an agent at all. */
export interface ProvisionOfferLike {
    /** A provisioner was injected. `false` means `POST /v1/agents` answers `501`. */
    readonly available: boolean
    /** This handler is on a loopback bind. A fact about the server, not about you. */
    readonly local: boolean
    /**
     * May *this caller* provision, which is the field to branch on.
     *
     * `local` describes the bind; this describes the request. They differ on exactly the
     * deployment that ships the onboarding page — an authenticated container — where branching on
     * `local` told an admin they were not allowed to do what they were allowed to do.
     */
    readonly allowed: boolean
    readonly steps: readonly ProvisionStepLike[]
}

/**
 * What `POST /v1/agents` answers, `201` either way.
 *
 * `adopted` is the part worth reading: the agent is on disk whichever way this went, so a failed
 * adoption is not a failed creation — telling somebody their request failed while a complete agent
 * sits in the sandbox would send them to create a second one. An empty `adopted` with an `error` is
 * "it exists and is not running", which is a different sentence and needs a different one shown.
 */
export interface ProvisionedAgentLike {
    readonly id: string
    readonly dir: string
    /** Relative paths written, so a caller can report what it made without re-reading the disk. */
    readonly files: readonly string[]
    readonly adopted: readonly string[]
    readonly error?: WireError
}

/** One template, as `GET /v1/templates` lists it. A broken one carries `problem` and no variables. */
export interface TemplateLike {
    readonly name: string
    readonly description?: string
    readonly vars: readonly {
        readonly name: string
        readonly description?: string
        readonly required: boolean
        readonly default?: string
        /** Written to the agent's `.env`, never into a file, and never returned by any route. */
        readonly secret: boolean
    }[]
    readonly problem?: WireError
}

/** One variable an agent's manifest reads. Whether it is set, never what it is. */
export interface SecretStatusLike {
    readonly name: string
    readonly set: boolean
    /** The manifest fields that read it. */
    readonly usedBy: readonly string[]
}

/**
 * What `PUT /v1/agents/:id/secrets` answers, `200` whenever the values were written.
 *
 * `applied` is the part to read: `reloaded` for a hosted agent, `adopted` for one that was not
 * running (usually because this key was the thing missing), `none` for a stopped agent or when
 * applying failed, in which case `error` says why. `shadowed` names values written and overridden
 * by the server's own environment, which wins by design.
 */
export interface SecretsWrittenLike {
    readonly id: string
    readonly written: readonly string[]
    readonly shadowed: readonly string[]
    readonly applied: "reloaded" | "adopted" | "none"
    readonly adopted: readonly string[]
    readonly stopped?: boolean
    readonly error?: WireError
}

/** A webhook subscription as the server reports it. Never the secret. */
export interface WebhookLike {
    readonly subscriptionId: string
    readonly url: string
    readonly types: readonly string[]
    readonly scope?: { readonly agents?: readonly string[]; readonly sessionPrefix?: string }
    readonly createdAt: string
    /** True while the last attempt failed. `lastError` says why. */
    readonly failing: boolean
    readonly consecutiveFailures: number
    readonly lastError?: string
    readonly lastSuccessAt?: string
    readonly lastFailureAt?: string
    readonly pending: number
}

/** How to slice usage. `by` defaults to `["agent", "model"]` on the server; `[]` is one total. */
export interface UsageOptions {
    readonly by?: readonly ("agent" | "model" | "day" | "sender")[]
    /** Inclusive, ISO-8601. */
    readonly from?: string
    /** Exclusive, ISO-8601. */
    readonly to?: string
}

/** One group's totals. A grouping field is present exactly when it was asked for. */
export interface UsageBucketLike {
    readonly agentId?: string
    readonly model?: string
    readonly day?: string
    /** Absent within a `sender` grouping means the operator's own calls. */
    readonly sender?: string
    readonly calls: number
    readonly promptTokens: number
    readonly cachedPromptTokens: number
    readonly outputTokens: number
    /** Calls where either figure was an estimate. Non-zero means the totals are partly a guess. */
    readonly estimatedCalls: number
}

export interface UsageReportLike {
    readonly buckets: readonly UsageBucketLike[]
    /** The earliest metered call. Absent when there are none. Earlier turns are not included. */
    readonly meteredSince?: string
}

/** How far one credential reaches. Absent fields mean "everything". See `04-SPEC-WIRE.md`. */
export interface KeyScopeLike {
    readonly agents?: readonly string[]
    /** A session-key prefix; a trailing `*` is accepted and ignored. */
    readonly sessions?: string
    readonly can?: readonly ("read" | "chat" | "write" | "admin")[]
}

/** A credential as a listing shows it. Never the secret — no route returns one twice. */
export interface OperatorKeyLike {
    readonly keyId: string
    readonly label: string
    readonly createdAt: string
    readonly lastUsedAt?: string
    readonly revokedAt?: string
    /** Absent means unscoped: every agent, every session, all four capabilities. */
    readonly scope?: KeyScopeLike
    readonly expiresAt?: string
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
    /**
     * What this server will ask to create an agent.
     *
     * Answers even when provisioning is unavailable or remote — an empty list beside
     * `available: false` says *why* a form cannot be offered, where a `501` would only say that one
     * cannot.
     */
    provision(): Promise<ProvisionOfferLike>
    /**
     * Create an agent and adopt it into this host.
     *
     * Send a subset: anything left out takes its default, exactly as `init --yes` does with flags.
     * A bad answer comes back as a `400` whose `field` names the step to fix.
     */
    createAgent(answers: Readonly<Record<string, string>>): Promise<ProvisionedAgentLike>
    /** What every agent this credential reaches cost, from the per-call meter. */
    usage(options?: UsageOptions): Promise<UsageReportLike>
    /** The webhook subscriptions this credential can see. */
    webhooks(): Promise<readonly WebhookLike[]>
    /**
     * Subscribe a URL. **The secret comes back exactly once**: store it where the receiver can read
     * it, and verify deliveries with any Standard Webhooks library.
     */
    createWebhook(input: {
        readonly url: string
        readonly types: readonly string[]
        readonly agents?: readonly string[]
    }): Promise<WebhookLike & { readonly secret: string }>
    deleteWebhook(
        subscriptionId: string,
    ): Promise<{ readonly id: string; readonly deleted: boolean }>
    /** Every template this server can create an agent from, with the variables each declares. */
    templates(): Promise<readonly TemplateLike[]>
    /**
     * Create an agent from a template and adopt it. The id is derived from `name`. A secret
     * variable's value goes to the new agent's `.env` and is never returned.
     */
    createAgentFromTemplate(input: {
        readonly template: string
        readonly name: string
        readonly vars?: Readonly<Record<string, string>>
    }): Promise<ProvisionedAgentLike>
    /**
     * Every credential, live and revoked, with the sentence this server says about scope.
     *
     * Revoked ones are **shown**: the row is the only record a credential ever existed, and hiding
     * it makes a revocation unverifiable.
     */
    keys(): Promise<{ readonly keys: readonly OperatorKeyLike[]; readonly scope: string }>
    /**
     * Mint one. **The secret comes back exactly once** and is stored only as a fingerprint.
     *
     * `expiresIn` is seconds from now; the response carries the absolute `expiresAt` this server
     * computed. Relative going in, because an absolute instant would assert agreement with a clock
     * the caller does not share.
     */
    createKey(input: {
        readonly label: string
        readonly scope?: KeyScopeLike & { readonly expiresIn?: number }
    }): Promise<OperatorKeyLike & { readonly secret: string }>
    /** Permanent. A revoked secret can never be re-presented. */
    revokeKey(keyId: string): Promise<OperatorKeyLike>
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

            usage: (options) =>
                json<UsageReportLike & { id: string }>("GET", at(`/usage${usageQuery(options)}`)),
            turns: (options) => {
                const params = new URLSearchParams()
                if (options?.limit !== undefined) params.set("limit", String(options.limit))
                if (options?.before !== undefined) params.set("before", String(options.before))
                const suffix = params.size === 0 ? "" : `?${params.toString()}`
                return json<{ turns: readonly TurnRecordLike[]; nextBefore?: number }>(
                    "GET",
                    at(`/turns${suffix}`),
                )
            },
            secrets: async () =>
                (await json<{ secrets: readonly SecretStatusLike[] }>("GET", at("/secrets")))
                    .secrets,
            setSecrets: (values) =>
                json<SecretsWrittenLike>("PUT", at("/secrets"), { body: { values } }),

            /**
             * Unwrapped, because the route wraps it — and this was declared as a bare array and
             * **never called** until 17.3's panel became the first consumer, at which point the
             * page crashed on `schedules.map is not a function` and React took the whole tree down
             * to a black screen.
             *
             * `approvals` directly above has always unwrapped correctly, which is what makes this
             * the `includeHistory` shape rather than a typo: a declaration with no consumer is
             * wrong for as long as nobody uses it, and its type says otherwise the whole time.
             */
            schedules: async () =>
                (await json<{ schedules: readonly ScheduleRecord[] }>("GET", at("/schedules")))
                    .schedules,

            approvals: async () =>
                (await json<{ approvals: readonly PendingApproval[] }>("GET", at("/approvals")))
                    .approvals,

            /**
             * The schedule writes, which the client declared none of.
             *
             * `schedules()` could read them and nothing could create one, so any caller wanting to
             * arm a schedule hand-rolled the call — which is how `keys.tsx` came to hand-roll the
             * credential routes, and how a client comes to have two error shapes.
             *
             * The server refuses and validates; these do no checking of their own. A cron
             * expression parsed here as well would be a second definition of what a valid schedule
             * is, and `prepareScheduleWrite` is deliberately the one — a check only one of two
             * writers performs is a check they disagree about.
             */
            createSchedule: (schedule) =>
                json<ScheduleRecord>("POST", at("/schedules"), { body: schedule }),

            updateSchedule: (scheduleId, patch) =>
                json<ScheduleRecord>("PATCH", at(`/schedules/${encodeURIComponent(scheduleId)}`), {
                    body: patch,
                }),

            deleteSchedule: async (scheduleId) => {
                await json<unknown>("DELETE", at(`/schedules/${encodeURIComponent(scheduleId)}`))
            },

            /**
             * Fire one now, out of band — it does **not** move the next scheduled run.
             *
             * Worth stating on the method rather than leaving to the route's docs: "run it now" and
             * "pretend it fired" are different things, and a caller who believed the second would
             * find the real one firing a minute later.
             */
            runSchedule: (scheduleId) =>
                json<{ scheduleId: string; turnId: string; sessionKey: string }>(
                    "POST",
                    at(`/schedules/${encodeURIComponent(scheduleId)}/run`),
                    { body: {} },
                ),

            config: () => json<AgentConfig>("GET", at("/config")),

            setConfig: (path, value, options) =>
                json<ConfigWriteResult>("PATCH", at("/config"), {
                    // `confirm` is spread rather than sent as `false`: absent is not consent, and a
                    // literal `false` reads as a considered refusal of a question nobody asked.
                    body: {
                        path,
                        value,
                        ...(options?.confirm === undefined ? {} : { confirm: options.confirm }),
                    },
                }),

            setChannel: (channelId, changes) =>
                json<ChannelWriteResult>(
                    "PATCH",
                    at(`/channels/${encodeURIComponent(channelId)}`),
                    { body: { ...changes } },
                ),

            unpairChannel: (channelId) =>
                json<{ channelId: string; note: string }>(
                    "POST",
                    at(`/channels/${encodeURIComponent(channelId)}/unpair`),
                ),

            session: (sessionKey) =>
                json<SessionSummary>("GET", at(`/sessions/${encodeURIComponent(sessionKey)}`)),

            setPhase: (sessionKey, phase) =>
                json<{ sessionKey: string; phase: string }>(
                    "POST",
                    at(`/sessions/${encodeURIComponent(sessionKey)}/phase`),
                    { body: { phase } },
                ),

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

        provision: () => json<ProvisionOfferLike>("GET", "/v1/provision"),
        /**
         * The credential routes, which this package declared none of.
         *
         * `packages/web`'s keys panel hand-rolled all three with its own `fetch`, its own header
         * assembly and its own error handling — which is exactly what a typed client exists to stop,
         * and why one endpoint there could throw a raw `TypeError` while its neighbours threw
         * `DispachError`. A caller cannot write one `catch` against that.
         */
        keys: () => json<{ keys: readonly OperatorKeyLike[]; scope: string }>("GET", "/v1/keys"),
        createKey: (input) =>
            json<OperatorKeyLike & { secret: string }>("POST", "/v1/keys", { body: input }),
        revokeKey: (keyId) =>
            json<OperatorKeyLike>("DELETE", `/v1/keys/${encodeURIComponent(keyId)}`),
        createAgent: (answers) =>
            json<ProvisionedAgentLike>("POST", "/v1/agents", { body: { answers } }),
        // Unwrapped, because the route wraps it: a list read declared as the wrong shape is how a
        // page crashed to black on `schedules.map is not a function`.
        usage: (options) => json<UsageReportLike>("GET", `/v1/usage${usageQuery(options)}`),
        webhooks: async () =>
            (await json<{ webhooks: readonly WebhookLike[] }>("GET", "/v1/webhooks")).webhooks,
        createWebhook: (input) =>
            json<WebhookLike & { secret: string }>("POST", "/v1/webhooks", { body: input }),
        deleteWebhook: (subscriptionId) =>
            json<{ id: string; deleted: boolean }>(
                "DELETE",
                `/v1/webhooks/${encodeURIComponent(subscriptionId)}`,
            ),
        templates: async () =>
            (await json<{ templates: readonly TemplateLike[] }>("GET", "/v1/templates")).templates,
        createAgentFromTemplate: (input) =>
            json<ProvisionedAgentLike>("POST", "/v1/agents", { body: input }),

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

/** `?by=…&from=…&to=…`, or nothing. An empty `by` is sent as `by=` so it means "one total". */
function usageQuery(options: UsageOptions | undefined): string {
    const params = new URLSearchParams()
    if (options?.by !== undefined) params.set("by", options.by.join(","))
    if (options?.from !== undefined) params.set("from", options.from)
    if (options?.to !== undefined) params.set("to", options.to)
    return params.size === 0 ? "" : `?${params.toString()}`
}
