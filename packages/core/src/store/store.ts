/**
 * The persistence contract.
 *
 * **Every method is async even though the only shipped driver is synchronous.** `bun:sqlite`
 * and `node:sqlite` are both blocking, so the SQLite driver returns already-resolved promises
 * and pays an allocation per call. That cost buys the one thing this interface exists for:
 * a Postgres driver — deferred, but explicitly planned — cannot be synchronous, and a sync
 * interface would mean rewriting every call site to add it. The interface arrives in this phase
 * precisely so that later addition is a new file rather than a refactor.
 *
 * **Sub-stores arrive with their subsystems.** `toolCalls` lands in Phase 3, `schedules` in
 * Phase 8, and `artifacts` with compaction in Phase 7. They are absent here rather than stubbed:
 * an empty interface that nothing implements is indistinguishable from a working one at the type
 * level, and would let a later phase quietly ship a no-op. `outbox` arrived in Phase 4.
 */

import type { TurnEndReason } from "../events/types.ts"
import type { SenderKind, TurnSender } from "../loop/sender.ts"
import type { ChatMessage, ToolCallRequest } from "../model/provider.ts"

/**
 * A turn's lifecycle state. `running` plus the five ways a turn can end.
 *
 * The plan names four (`running | final | stopped | error`), but `timeout` and `max_steps` are
 * distinct `TurnEndReason`s that the loop goes out of its way not to collapse into `error`.
 * Flattening them at the storage layer would discard the diagnosis one layer below where it
 * was made, so the column holds all six.
 */
export type TurnStatus = "running" | TurnEndReason

export interface SessionRecord {
    readonly agentId: string
    readonly sessionKey: string
    readonly channel: string
    readonly peerId: string
    readonly thread?: string
    /** Phase-scoped tool visibility, persisted per session from Phase 7. */
    readonly phase?: string
    /** RFC 3339 UTC. */
    readonly createdAt: string
    readonly updatedAt: string
}

/** A session plus the aggregates the `sessions` command and `GET /v1/…/sessions` report. */
export interface SessionSummary extends SessionRecord {
    readonly messages: number
    readonly turns: number
    readonly lastActivityAt: string
}

export interface StoredMessage {
    /** Monotonic within a store. Ordering key — never sort by timestamp, which can tie. */
    readonly id: number
    readonly sessionKey: string
    readonly turnId?: string
    readonly role: ChatMessage["role"]
    readonly content: string
    /**
     * Native tool calling's two extra facts, persisted and read back.
     *
     * Present only under the `native` dialect, where a message is genuinely more than `{role, content}`:
     * an assistant turn carries the calls it made, and a `tool` observation names the call it answers.
     * Losing either turns a resumed session's history into an orphaned trace — a 400 from a strict
     * endpoint, and a silently confused model on a lenient one.
     */
    readonly toolCalls?: readonly ToolCallRequest[]
    readonly toolCallId?: string
    /**
     * Who wrote this, when it was the harness rather than a person or the model.
     *
     * Declared here because `toMessage` has always *set* it and this interface never declared it — a
     * conditional spread is not excess-property-checked, so the field arrived at runtime and was
     * invisible to every reader's types. Anything filtering a page by origin silently compared
     * `undefined`. Same shape as `ChatMessage.toolCalls` and `ToolContext.readArtifact` before it.
     *
     * `memory.includeHistory` is the caller that made it matter: indexing a message the runtime wrote
     * would put fetched, untrusted text into a corpus that outlives the gate which fenced it.
     */
    readonly origin?: ChatMessage["origin"]
    /** True when model prose was produced after untrusted output entered its turn. */
    readonly tainted?: boolean
    readonly createdAt: string
}

export interface TurnRecord {
    readonly turnId: string
    readonly agentId: string
    readonly sessionKey: string
    readonly status: TurnStatus
    readonly source: string
    readonly input: string
    readonly text: string
    readonly reasoning: string
    readonly steps: number
    readonly promptTokens: number
    readonly outputTokens: number
    /**
     * Prompt tokens the endpoint served from cache, when it reported a figure.
     *
     * `undefined` is *not reported*, distinct from a reported zero — see migration 10. Every reader
     * has to carry the third state; defaulting it to 0 makes an endpoint that says nothing
     * indistinguishable from one that cached nothing, and those want opposite conclusions.
     */
    readonly cachedPromptTokens?: number
    /** The wire field the figure came from, so a surprising ratio is traceable. */
    readonly cacheSource?: string
    /**
     * Who sent the input, when it was not the operator. Absent means the operator's own surface.
     *
     * Absent is not "unknown": the REPL, a schedule, an `allowFrom`-gated channel turn and an API
     * call with the container's token are all the operator, and putting a synthesised identity on
     * those would make the column useless for the one question it exists to answer. Trust is
     * derived from `senderKind` rather than stored beside it — see `loop/sender.ts`.
     */
    readonly sender?: string
    readonly senderName?: string
    readonly senderKind?: SenderKind
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly errorHint?: string
    readonly startedAt: string
    readonly endedAt?: string
    readonly durationMs?: number
}

export interface MessagePage {
    readonly messages: readonly StoredMessage[]
    /** Pass as `before` to fetch the previous page. Absent when the first message is included. */
    readonly nextBefore?: number
}

export interface SessionStore {
    /** Create if absent, returning either way. Idempotent — a turn calls this on every send. */
    ensure(agentId: string, sessionKey: string): Promise<SessionRecord>
    get(agentId: string, sessionKey: string): Promise<SessionRecord | undefined>
    list(agentId: string): Promise<readonly SessionSummary[]>
    setPhase(agentId: string, sessionKey: string, phase: string | undefined): Promise<void>
    /** Clears history, turns, and their derived session-memory source. Canonical files are untouched. */
    clear(agentId: string, sessionKey: string): Promise<void>
    /** Deletes the session and its derived session-memory source. Canonical files are untouched. */
    delete(agentId: string, sessionKey: string): Promise<void>
}

export interface MessageStore {
    append(
        agentId: string,
        sessionKey: string,
        messages: readonly ChatMessage[],
        turnId?: string,
    ): Promise<readonly StoredMessage[]>
    /** Oldest-first, the order the model needs. `limit` keeps the most recent N. */
    history(agentId: string, sessionKey: string, limit?: number): Promise<readonly ChatMessage[]>
    /**
     * Newest-first with a cursor, the order a UI pages through.
     *
     * `before` and `limit` accept an explicit `undefined` as well as being absent. Under
     * `exactOptionalPropertyTypes` those are normally different types, but the cursor exists to be
     * fed back in — `page({ before: previous.nextBefore })` is the intended call, and
     * `nextBefore` is absent on the last page. Requiring every caller to spread it conditionally
     * would make the common path the awkward one for no gain in safety: a missing cursor and an
     * undefined cursor both mean "start at the newest".
     */
    page(
        agentId: string,
        sessionKey: string,
        options?: {
            readonly before?: number | undefined
            readonly limit?: number | undefined
        },
    ): Promise<MessagePage>
    count(agentId: string, sessionKey: string): Promise<number>
}

export interface TurnStore {
    start(record: {
        readonly turnId: string
        readonly agentId: string
        readonly sessionKey: string
        readonly source: string
        /**
         * The text as it was sent — **raw**, never the fenced form the prompt carries.
         *
         * The row is the audit record of what was said, and `sender` sits beside it, so the framing
         * is reconstructible without baking runtime decoration into the evidence. History goes the
         * other way and keeps the fence, because history is prompt material.
         */
        readonly input: string
        readonly sender?: TurnSender
    }): Promise<TurnRecord>
    finish(
        turnId: string,
        outcome: {
            readonly status: TurnStatus
            readonly text: string
            readonly reasoning: string
            readonly steps: number
            readonly promptTokens: number
            readonly outputTokens: number
            /** Omitted when the endpoint reported no cache figure. Never defaulted to zero. */
            readonly cachedPromptTokens?: number
            readonly cacheSource?: string
            readonly durationMs: number
            readonly errorCode?: string
            readonly errorMessage?: string
            readonly errorHint?: string
        },
    ): Promise<void>
    get(turnId: string): Promise<TurnRecord | undefined>
    list(
        agentId: string,
        sessionKey: string,
        options?: { readonly limit?: number },
    ): Promise<readonly TurnRecord[]>
    /**
     * Every turn this agent has taken, newest first, across sessions.
     *
     * Paged by `before`, the store's own monotonic row key, never a timestamp: two turns can start in
     * the same millisecond, and a cursor that can tie can skip or repeat a row. `sessionPrefix`
     * narrows it for a session-scoped caller.
     */
    listForAgent(
        agentId: string,
        options?: {
            readonly limit?: number
            readonly before?: number
            readonly sessionPrefix?: string
        },
    ): Promise<{ readonly turns: readonly TurnRecord[]; readonly nextBefore?: number }>
    /**
     * Turns left `running` by a crash, marked `error` at boot.
     *
     * A process cannot resume someone else's in-flight generation, and leaving the row
     * `running` forever would make a dead turn indistinguishable from a live one. Returns what
     * it reaped so boot can report it rather than fixing it silently.
     *
     * `agentIds` is **required**, and it is the list this process holds a lease for — never
     * "every agent in the manifest" and never, now, "all of them". Unfiltered was correct while
     * one process owned one database and became wrong the moment two shared a file: the second
     * one's boot marked the first one's *live* turn failed, silently, with the row's own error
     * text claiming the process had exited. Required rather than optional because an optional
     * "all" leaves that behaviour one omitted argument away from returning, and the resulting bug
     * is invisible until somebody reads a turn record.
     *
     * Rows belonging to no live lease are still reachable — see `LeaseStore.orphans`.
     */
    reapRunning(agentIds: readonly string[], reason: string): Promise<readonly string[]>
    /**
     * Claim an inbound idempotency key for a turn, or report the turn that already holds it.
     *
     * Called **before** the turn runs, which is what makes it useful: `POST /messages` answers
     * `202` and writes its turn row asynchronously, so a claim that waited for the row would leave
     * the window between two retries — the only window the feature exists to close — wide open.
     *
     * `inputHash` is compared, not merely stored. A key reused with different text is a *client
     * bug*, and answering it with the first turn's id would tell that client its second message
     * succeeded when nothing ran; `mismatch` lets the surface refuse instead. Hashing rather than
     * keeping the text avoids a second copy of every message in a table that exists for minutes.
     */
    claimInboundKey(claim: {
        readonly agentId: string
        readonly key: string
        readonly turnId: string
        readonly inputHash: string
        readonly now: Date
    }): Promise<InboundKeyClaim>
}

/**
 * What claiming an idempotency key produced.
 *
 * Three outcomes rather than a boolean, because "already claimed by an identical request" and
 * "already claimed by a different one" want opposite answers on the wire — a replay and a 409.
 */
export type InboundKeyClaim =
    | { readonly kind: "claimed" }
    /** This key already belongs to a turn whose input hashed the same. Answer with that turn. */
    | { readonly kind: "replay"; readonly turnId: string }
    /** This key already belongs to a turn whose input was different. Refuse. */
    | { readonly kind: "mismatch"; readonly turnId: string }

export type HandoffOutcomeStatus = "running" | "ok" | "no_artifact" | "budget" | "error"

export interface HandoffRecord {
    readonly handoffId: string
    /** The supervisor. */
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    readonly memberId: string
    /**
     * Where the member's transcript is.
     *
     * The load-bearing column. A supervisor's prompt only ever sees the artifact (decision 10.2),
     * so without a pointer back, "what did the member actually say" is unanswerable from any
     * surface — and a `no_artifact` outcome is exactly the case where somebody needs to look.
     */
    readonly memberSession: string
    readonly task: string
    readonly outcome: HandoffOutcomeStatus
    /** JSON, present only when `outcome` is `ok`. */
    readonly artifact?: string
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly steps: number
    readonly promptTokens: number
    readonly outputTokens: number
    readonly startedAt: string
    readonly endedAt?: string
}

export interface HandoffStore {
    /**
     * Written `running` before the member starts, for the same reason a turn row is.
     *
     * A crash mid-delegation then leaves a durable record that one was in flight, rather than
     * nothing at all — which is the difference between "the supervisor's turn died during a
     * handoff" and "the supervisor never delegated".
     */
    start(record: {
        readonly handoffId: string
        readonly agentId: string
        readonly sessionKey: string
        readonly turnId: string
        readonly memberId: string
        readonly memberSession: string
        readonly task: string
        readonly startedAt: string
    }): Promise<void>
    finish(
        handoffId: string,
        outcome: {
            readonly outcome: Exclude<HandoffOutcomeStatus, "running">
            readonly artifact?: string
            readonly errorCode?: string
            readonly errorMessage?: string
            readonly steps: number
            readonly promptTokens: number
            readonly outputTokens: number
            readonly endedAt: string
        },
    ): Promise<void>
    /** What one turn delegated, oldest first. The question a transcript view asks. */
    forTurn(agentId: string, turnId: string): Promise<readonly HandoffRecord[]>
}

/**
 * How stale `last_used_at` is allowed to get: one minute.
 *
 * The figure the column answers is "is anybody still using this credential", which is read by the
 * day. A per-request `UPDATE` would buy second-level precision nobody looks at and pay for it on
 * every route including each SSE open.
 */
export const DEFAULT_KEY_TOUCH_MS = 60_000

/**
 * One operator key, as every surface but the issue response sees it.
 *
 * **There is no secret field, and there is no way to add one.** The secret exists for the length of
 * `POST /v1/keys` and is never stored — only its fingerprint is — so a record that carried one
 * would be a record that could not be produced. That absence is the whole security property, which
 * is why it is a fact about the type rather than a rule about the queries.
 */
/**
 * What a scoped key is trusted with, split by *what the holder is being given* rather than by HTTP
 * method.
 *
 * `chat` is separate from `write` because "talk to my agent" is the credential a platform hands an
 * end-user, and it must not also let them rewrite that agent's schedules. `read` is every GET
 * because a caller that can read a session can already read its messages; splitting those would be
 * a vocabulary with no consumer. `admin` is the one that can mint further credentials, which is why
 * it is a member rather than an implicit property of an unscoped key.
 *
 * The names go on the wire (`GET /v1/keys`, `POST /v1/keys`), so they are append-only in practice.
 */
export type Capability = "read" | "chat" | "write" | "admin"

/** Every capability, for validation and for a listing that cannot go stale against the union. */
export const CAPABILITIES: readonly Capability[] = ["read", "chat", "write", "admin"]

/**
 * How far one key reaches. **Every field absent is byte-identical to an unscoped key**, which is
 * what makes this opt-in narrowing rather than a new authorisation model.
 *
 * That default is the whole reason decision 11.197 survives: a key still authenticates a *caller to
 * a server*, `operator_keys` still has no `agent_id`, and `purgeAgent` still leaves the table alone.
 * A scope narrows what an already-authenticated caller may reach; it does not make the credential
 * belong to an agent.
 *
 * **This is not an identity system and must not be described as one.** There are no users, teams,
 * orgs or roles here and there will not be — `docs/06-VELAOPS-INTEGRATION.md` refuses them in four
 * places, and Better Auth stays authoritative for the consumer that needs them. A scope supplies
 * *isolation*; `from` on `POST /messages` supplies attribution. That pair is the contribution.
 */
export interface KeyScope {
    /**
     * Agent ids this key may reach. Absent means every agent this server holds.
     *
     * An id naming an agent that no longer exists is **reported**, never silently matched against
     * nothing: a credential that authenticates and reaches zero agents is the "looks live and is
     * not" failure this repo keeps finding, and it is indistinguishable from a working key until
     * somebody tries to use it.
     */
    readonly agents?: readonly string[]
    /**
     * A session-key prefix, with an optional trailing `*`. Absent means every session.
     *
     * A prefix rather than a list because a platform mints one key per end-user and their sessions
     * are created later — an enumerated list would have to be rewritten on every new conversation.
     */
    readonly sessions?: string
    /** Absent means all four. See `Capability`. */
    readonly can?: readonly Capability[]
}

export interface OperatorKeyRecord {
    readonly keyId: string
    /** What distinguishes this credential from the others in a listing. */
    readonly label: string
    readonly createdAt: string
    /**
     * Coarse: written at most once a minute per key, so a live credential is distinguishable from a
     * forgotten one without an `UPDATE` on the hot path of every request.
     */
    readonly lastUsedAt?: string
    /** Set rather than deleted. Present means the key is dead and can never be revived. */
    readonly revokedAt?: string
    /** Absent means unscoped — every agent, every session, all four capabilities. */
    readonly scope?: KeyScope
    /**
     * When this key stops authenticating. Absent means never.
     *
     * A **column** rather than a field inside `scope`, because `findLive` filters on it and a
     * caller must not be able to forget: an expired key and a revoked one are one code path and
     * answer identically, for the same reason `findLive` hides a revoked one — "forgot to check the
     * expiry" is an expiry that silently does nothing.
     */
    readonly expiresAt?: string
}

/**
 * Bearer credentials for this server, independent of any agent.
 *
 * The only store in this file with no `agent_id` parameter anywhere, for the reason migration 14
 * records: a key authenticates a caller to a *server*, and `purgeAgent` deliberately leaves them.
 */
export interface OperatorKeyStore {
    /**
     * Store a new key's fingerprint under a label. The secret itself is never passed in.
     *
     * Takes the fingerprint rather than the secret precisely so this interface cannot be the place
     * a secret is accidentally logged, retained or compared.
     */
    issue(record: {
        readonly keyId: string
        readonly label: string
        readonly fingerprint: string
        readonly createdAt: string
        /** Omitted for an unscoped key, which is what every caller before 18.2 minted. */
        readonly scope?: KeyScope
        readonly expiresAt?: string
    }): Promise<OperatorKeyRecord>
    /**
     * The live key with this fingerprint, if any. One indexed read.
     *
     * A revoked key answers `undefined` — the caller must not have to remember to check, because
     * "forgot to filter on `revoked_at`" is a revocation that silently does nothing.
     */
    findLive(fingerprint: string, at: string): Promise<OperatorKeyRecord | undefined>
    /**
     * Note that a key was just used, if the stored stamp is older than `coarseMs`.
     *
     * The threshold lives here rather than at the call site so every caller gets the same
     * behaviour: a per-caller decision about how often to write is how one route comes to keep a
     * column fresh while another leaves it null.
     */
    touch(keyId: string, at: string, coarseMs?: number): Promise<void>
    /** Every key, newest first, live and revoked. Revoked ones are shown, never hidden. */
    list(): Promise<readonly OperatorKeyRecord[]>
    /**
     * Revoke one key. `undefined` when no such id exists; the record when it does.
     *
     * Revoking an already-revoked key keeps the original stamp and is not an error — the caller
     * asked for a state that already holds, and a 404 there would make a retried request look like
     * a mistake.
     */
    revoke(keyId: string, at: string): Promise<OperatorKeyRecord | undefined>
    /** How many keys can still authenticate. Read at boot to decide whether a claim is needed. */
    liveCount(): Promise<number>
}

/** How a runtime was started. Reported in a refusal, so it has to be a fact rather than a guess. */
export type RuntimeMode = "daemon" | "terminal" | "embedded"

export interface LeaseRecord {
    readonly agentId: string
    readonly runtimeId: string
    readonly pid: number
    readonly mode: RuntimeMode
    readonly startedAt: string
    readonly heartbeatAt: string
    /**
     * Where this holder serves HTTP, once it is bound. `undefined` for a holder that serves none.
     *
     * The reason it exists: `stop <agent>` has to reach *into* a running host rather than signal
     * it, because one process hosts several agents and a signal cannot name one. The reason it is
     * optional: a `run` REPL and an embedded runtime hold leases and bind no socket, so the absent
     * case is a real state and a caller reading it falls back to stopping the process.
     *
     * Not derivable from a manifest — `--port` overrides it, `--port 0` picks one at random, and a
     * container's published port moves it again — which is why it is recorded rather than computed.
     */
    readonly baseUrl?: string
}

/**
 * The outcome of asking to serve an agent.
 *
 * A discriminated result rather than a throw, because the store does not know how to phrase the
 * refusal: `serve` wants a `HarnessError` naming the other process, an embedder may want to wait,
 * and a test wants neither. The store reports who holds it; the caller decides what that means.
 */
export type LeaseClaim =
    | { readonly ok: true; readonly lease: LeaseRecord; readonly tookOver?: LeaseRecord }
    | { readonly ok: false; readonly held: LeaseRecord }

/**
 * Who is serving which agent — the mutual exclusion that stops two pollers on one bot token.
 *
 * Liveness is **not** decided here. The store records a pid and a heartbeat; whether that pid is
 * alive is an operating-system question, and a store that answered it would be untestable without
 * spawning processes. The caller probes and passes its verdict to `claim` as `stealFrom`.
 */
export interface LeaseStore {
    /**
     * Take the lease for an agent, or report who holds it.
     *
     * `stealFrom` is the runtime id the caller has established is dead. Passing it makes the claim
     * succeed against exactly that holder and no other — so a lease that changed hands between the
     * liveness probe and the claim is still refused, rather than being stolen from a process that
     * has just legitimately started.
     */
    claim(input: {
        readonly agentId: string
        readonly runtimeId: string
        readonly pid: number
        readonly mode: RuntimeMode
        readonly now: string
        readonly stealFrom?: string
    }): Promise<LeaseClaim>
    /** Refresh `heartbeat_at`. A no-op when this runtime no longer holds the lease. */
    beat(agentId: string, runtimeId: string, now: string): Promise<boolean>
    /**
     * Record where this runtime serves HTTP, on every lease it holds.
     *
     * A second write rather than an argument to `claim`, because the port is not known when the
     * lease is taken: leases are claimed inside `Runtime.create` and the socket is bound after it
     * returns, and `--port 0` is the case that makes that ordering unavoidable rather than merely
     * convenient.
     *
     * Scoped to `runtimeId`, so a host cannot publish an address onto somebody else's lease — the
     * same scoping `beat` and `release` use, for the same reason.
     */
    publish(runtimeId: string, baseUrl: string): Promise<void>
    release(agentId: string, runtimeId: string): Promise<void>
    get(agentId: string): Promise<LeaseRecord | undefined>
    all(): Promise<readonly LeaseRecord[]>
    /**
     * Agent ids with `running` turns or `inflight` deliveries and no lease row at all.
     *
     * The escape hatch that keeps ownership-scoped recovery honest. Narrowing recovery to leased
     * agents means a deleted or renamed agent's rows are nobody's to reap; this names them so
     * something can, rather than leaving a permanent lie in the turn list.
     *
     * This pointed at a `sessions --reap-orphans` that was never built, for long enough that the
     * gap it describes was real: rows belonging to a deleted agent were unreachable by any command.
     * `remove --prune` is the one that clears them, and it reads `agentIds` rather than this —
     * because this answers the narrower question (ids with *running* turns or *inflight* deliveries
     * and no lease) and cannot see an agent whose directory was deleted while it was idle.
     */
    orphans(): Promise<readonly string[]>
}

/**
 * Whether an agent is supposed to be running, and why not.
 *
 * `enabled: false` means **not hosted at all** — no `/v1`, no channels, no schedules — and it
 * survives a restart, which is the whole point. A lease answers "who is serving this now"; this
 * answers "should anybody", and the two were one question only while a process served one agent.
 */
export interface AgentStateRecord {
    readonly agentId: string
    readonly enabled: boolean
    /** When it was last switched off. Kept through a later enable, as the audit trail. */
    readonly disabledAt: string | undefined
    readonly reason: string | undefined
}

/**
 * The durable on/off switch, per agent.
 *
 * **An absent row is enabled**, so an agent nobody has ever stopped costs nothing and `init` writes
 * no state. The alternative — a provisioning path that has to remember to write an "on" row — makes
 * a forgotten write into an agent that is silently unhosted, which is the exact shape this table
 * exists to prevent at the other end.
 *
 * `disable` and `enable` are both idempotent and neither is an error on an agent that is already in
 * the requested state: the caller asked for a state that already holds, and a 404 there makes a
 * retried request look like a mistake. `disable` twice keeps the **first** stamp, for the reason
 * `OperatorKeyStore.revoke` does — the interesting timestamp is when it stopped, not when somebody
 * last asked again.
 */
export interface AgentStateStore {
    /** `undefined` when nothing has ever been recorded, which means enabled. */
    get(agentId: string): Promise<AgentStateRecord | undefined>
    /** Every recorded state, enabled and disabled. Nothing is hidden; a caller filters. */
    list(): Promise<readonly AgentStateRecord[]>
    /**
     * Switch an agent off durably. Returns the row as it now stands.
     *
     * Keeps the original `disabled_at` when it was already off, so asking twice does not rewrite
     * the history of when it stopped.
     */
    disable(agentId: string, at: string, reason?: string): Promise<AgentStateRecord>
    /** Switch it back on, keeping `disabled_at` and `reason` as the record of what happened. */
    enable(agentId: string): Promise<AgentStateRecord>
    /**
     * The subset of `agentIds` that is switched off.
     *
     * One query rather than a `get` per agent, because the caller asking this is a host deciding
     * what to load and it asks once for everything. Ids with no row are enabled and absent here.
     */
    disabledAmong(agentIds: readonly string[]): Promise<readonly string[]>
}

/** One model call, as the meter records it. See migration 18. */
export interface ModelCallRecord {
    readonly agentId: string
    /** Absent for a call outside any session. Present for every turn and compaction today. */
    readonly sessionKey?: string
    readonly turnId?: string
    /** The manifest role that made the call: `main`, `compactor`, or a named one. */
    readonly role: string
    readonly model: string
    readonly promptTokens: number
    /** False when `promptTokens` is our estimate rather than the endpoint's figure. */
    readonly promptReported: boolean
    /** Absent when the endpoint reported no cache figure, which is distinct from a reported zero. */
    readonly cachedPromptTokens?: number
    readonly outputTokens: number
    readonly outputReported: boolean
    /** Who sent the turn, when it was not the operator. The key per-member billing groups on. */
    readonly sender?: string
    readonly at: string
}

/** The dimensions usage can be grouped by. Anything else is refused by the route. */
export const USAGE_GROUPS = ["agent", "model", "day", "sender"] as const
export type UsageGroup = (typeof USAGE_GROUPS)[number]

export interface UsageQuery {
    /** Absent means every agent in the store; the route passes a scope's list when there is one. */
    readonly agentIds?: readonly string[]
    /** Inclusive lower bound, ISO-8601. */
    readonly from?: string
    /** Exclusive upper bound, ISO-8601. */
    readonly to?: string
    readonly sessionPrefix?: string
    readonly by: readonly UsageGroup[]
}

/** One group's totals. A grouping field is present exactly when it was asked for. */
export interface UsageBucket {
    readonly agentId?: string
    readonly model?: string
    /** The calendar day in UTC, `YYYY-MM-DD`. */
    readonly day?: string
    /** Absent within a `sender` grouping means the operator's own calls. */
    readonly sender?: string
    readonly calls: number
    readonly promptTokens: number
    readonly cachedPromptTokens: number
    readonly outputTokens: number
    /**
     * Calls where either figure was our estimate. Non-zero means the totals are not a measurement,
     * and a caller billing from them should know how much of the number is a guess.
     */
    readonly estimatedCalls: number
}

export interface UsageStore {
    record(call: ModelCallRecord): Promise<void>
    report(query: UsageQuery): Promise<{
        readonly buckets: readonly UsageBucket[]
        /**
         * The earliest call on record, absent when there are none. Usage is metered from the upgrade
         * that added it, and anything earlier is simply not here, which a caller must be told.
         */
        readonly meteredSince?: string
    }>
}

/** How far a subscription hears: the creating credential's reach. Absent fields mean everything. */
export interface WebhookScope {
    readonly agents?: readonly string[]
    readonly sessionPrefix?: string
}

/** A subscription as the API reports it. Never the secret. */
export interface WebhookSubscription {
    readonly subscriptionId: string
    readonly url: string
    /** Event types delivered. See `webhookDeliverable` for what is never in this list. */
    readonly types: readonly string[]
    readonly scope?: WebhookScope
    readonly createdAt: string
    /** Failed attempts since the last success. Non-zero is what `failing` on the resource means. */
    readonly consecutiveFailures: number
    readonly lastError?: string
    readonly lastSuccessAt?: string
    readonly lastFailureAt?: string
    /** Deliveries not yet sent or given up on. */
    readonly pending: number
}

export type WebhookDeliveryStatus = "pending" | "inflight" | "sent" | "failed"

export interface WebhookDeliveryRecord {
    readonly subscriptionId: string
    /** The `webhook-id` header. Derived from the subscription and the event, stable across retries. */
    readonly messageId: string
    readonly agentId: string
    readonly eventType: string
    /** The envelope exactly as `GET /v1/events` serves it, serialised once at enqueue. */
    readonly body: string
    readonly status: WebhookDeliveryStatus
    readonly attempts: number
    /** Recovered from `inflight` by a new process: the receiver may already have it. */
    readonly uncertain: boolean
    readonly nextAttemptAt: string
    readonly lastError?: string
}

/**
 * What a delivery queue still owes, for deciding whether the process may sleep.
 *
 * `nextAttemptAt` is the earliest `pending` row's, and may be in the past: that is work due now, not
 * a wake time. `inflight` rows are bytes possibly on the wire, so a process holding one is not idle
 * whatever else is true.
 */
export interface DeliveryBacklog {
    readonly pending: number
    readonly inflight: number
    readonly nextAttemptAt?: string
}

export interface WebhookStore {
    create(subscription: {
        readonly subscriptionId: string
        readonly url: string
        readonly secret: string
        readonly types: readonly string[]
        readonly scope?: WebhookScope
        readonly createdAt: string
    }): Promise<WebhookSubscription>
    list(): Promise<readonly WebhookSubscription[]>
    get(subscriptionId: string): Promise<WebhookSubscription | undefined>
    /** For signing only. No route returns it. */
    secretOf(subscriptionId: string): Promise<string | undefined>
    /** Deletes its pending deliveries with it. `false` when there was nothing to delete. */
    delete(subscriptionId: string): Promise<boolean>
    /** `false` when this `(subscription, message)` pair already exists: an enqueue that ran twice. */
    enqueue(delivery: {
        readonly subscriptionId: string
        readonly messageId: string
        readonly agentId: string
        readonly eventType: string
        readonly body: string
        readonly at: string
    }): Promise<boolean>
    /** Mark up to `limit` due rows for these agents `inflight` and return them. */
    claimDue(
        agentIds: readonly string[],
        now: string,
        limit: number,
    ): Promise<readonly WebhookDeliveryRecord[]>
    markSent(subscriptionId: string, messageId: string, at: string): Promise<void>
    markRetry(
        subscriptionId: string,
        messageId: string,
        nextAttemptAt: string,
        error: string,
        at: string,
    ): Promise<void>
    markFailed(subscriptionId: string, messageId: string, error: string, at: string): Promise<void>
    /** Rows a dead process left `inflight`, back to `pending` with `uncertain` set. Call at boot. */
    recoverInflight(
        agentIds: readonly string[],
        at: string,
    ): Promise<readonly WebhookDeliveryRecord[]>
    /** What these agents' subscriptions still owe. */
    backlog(agentIds: readonly string[]): Promise<DeliveryBacklog>
}

/**
 * A namespaced string map.
 *
 * **Nothing consumes this yet, and it is the one table with no `agent_id`.** Recorded rather than
 * quietly carried: `scope` is a free string, so an agent-scoped caller has to compose the key itself,
 * and `purgeAgent` therefore cannot clean up after one — there is no column to match on. The first
 * caller either passes an agent-derived scope and this grows an agent-aware delete, or the table is
 * dropped. Declared vocabulary with no consumer is how `includeHistory` sat unimplemented for three
 * phases while looking finished.
 */
export interface KVStore {
    get(scope: string, key: string): Promise<string | undefined>
    set(scope: string, key: string, value: string): Promise<void>
    delete(scope: string, key: string): Promise<void>
    all(scope: string): Promise<Readonly<Record<string, string>>>
}

/**
 * Everything one agent owns that a person might weigh before deleting it, by table.
 *
 * One shape for two questions — what would go, and what went — so a listing shown before a deletion
 * and the report printed after it cannot disagree. `agentFootprint` and `purgeAgent` both return this.
 *
 * Deliberately **not** every table. `inbound_keys` is deleted by `purgeAgent` and counted here by
 * nothing: it is request plumbing with a 24-hour TTL, and `inboundKeys: 3` on a deletion
 * confirmation is a line that means nothing to anybody reading it. The listing's whole value is
 * that somebody reads it, so a row nobody can act on costs more than it adds. Anything a person
 * would hesitate over — a conversation, a memory passage, a pending delivery — is here.
 */
export interface AgentFootprint {
    readonly sessions: number
    readonly messages: number
    readonly turns: number
    readonly artifacts: number
    readonly outbox: number
    /** Deliveries not yet sent. Worth naming separately: removing the agent abandons them. */
    readonly outboxPending: number
    readonly schedules: number
    readonly passages: number
    readonly memorySources: number
    /** A live lease means a process is running under this id right now. */
    readonly lease: boolean
}

/**
 * A delivery's lifecycle. Four states, and the two transitions that matter are the ones out of
 * `inflight`: everything else is bookkeeping.
 *
 * `inflight` means *the bytes may already have left*. A row found in this state by a fresh process
 * was owned by a process that died, and no amount of local state can say whether the provider
 * received it. That ambiguity is the whole reason the state exists as a distinct value rather than
 * as `pending` with a timestamp.
 */
export type DeliveryStatus = "pending" | "inflight" | "sent" | "failed"

export interface DeliveryRecord {
    readonly id: number
    readonly agentId: string
    /**
     * The identity of this delivery, derived by the caller and unique per agent.
     *
     * **Derived, never generated.** A UUID minted at enqueue dedupes the outbox against itself, a
     * problem it does not have. The duplicate that actually happens is the *enqueuer* running twice
     * — a turn replayed after a crash, a redelivered webhook — and under a generated id each replay
     * mints a fresh key and sends again. A derived key makes the second enqueue collide with the
     * first row and do nothing. See `deliveryKey` in `channels/outbox.ts`.
     */
    readonly dedupeKey: string
    /** Everything in one reply to one recipient. Ordering and abandonment are group-scoped. */
    readonly groupKey: string
    readonly sessionKey: string
    readonly turnId?: string
    readonly channelId: string
    readonly recipient: string
    readonly thread?: string
    readonly chunkIndex: number
    readonly chunkTotal: number
    readonly body: string
    readonly status: DeliveryStatus
    readonly attempts: number
    /** RFC 3339 UTC. A `pending` row is invisible to `due` until this passes. */
    readonly nextAttemptAt: string
    /**
     * This row was found `inflight` at boot and re-queued.
     *
     * Sticky once set, and carried onto `delivery.sent` — a duplicate that reaches a person should
     * be explicable from the event stream afterwards, not only from a log line at the moment it
     * happened.
     */
    readonly uncertain: boolean
    readonly providerMessageId?: string
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly createdAt: string
    readonly updatedAt: string
}

export interface EnqueueDelivery {
    readonly agentId: string
    readonly dedupeKey: string
    readonly groupKey: string
    readonly sessionKey: string
    readonly turnId?: string
    readonly channelId: string
    readonly recipient: string
    readonly thread?: string
    readonly chunkIndex: number
    readonly chunkTotal: number
    readonly body: string
    /**
     * When this row becomes visible to `due`. Defaults to now.
     *
     * Present so the enqueuer's clock is the one that decides, matching `markRetry`, which has
     * always taken an explicit time. Without it a caller running on an injected clock — the outbox
     * engine, and therefore every test of it — stamps rows from the wall clock and then asks about
     * them from a different one. That does not fail; it produces a queue that is due or not
     * depending on what time of day the suite runs.
     */
    readonly nextAttemptAt?: string
}

/** `inserted: false` means the dedupe key was already present — the re-enqueue did nothing. */
export interface EnqueueResult {
    readonly record: DeliveryRecord
    readonly inserted: boolean
}

export interface OutboxStore {
    /**
     * Insert every delivery whose dedupe key is new, in one transaction.
     *
     * All-or-nothing per call, so a crash cannot leave a reply half-enqueued: three chunks either
     * all exist or none do, and the retry re-enqueues the whole reply against the same keys.
     */
    enqueue(deliveries: readonly EnqueueDelivery[]): Promise<readonly EnqueueResult[]>
    /**
     * Rows ready to send now, oldest first.
     *
     * Returns at most the *head of line* per group: a chunk whose predecessor in the same group is
     * not yet `sent` is withheld, so ordering holds without the caller tracking it. A predecessor
     * left `failed` withholds its successors permanently, which is deliberate — `abandonGroupAfter`
     * is what resolves that, and failing closed means a half-message never ships on its own.
     */
    due(agentId: string, now: string, limit?: number): Promise<readonly DeliveryRecord[]>
    /**
     * `pending` → `inflight`, atomically. `undefined` when another claimant won.
     *
     * The guard is in the `WHERE` clause rather than a read-then-write, because a read-then-write is
     * exactly the race a second drain pass would lose.
     */
    claim(id: number): Promise<DeliveryRecord | undefined>
    markSent(id: number, providerMessageId?: string): Promise<void>
    /** `inflight` → `pending`, attempts incremented, visible again at `nextAttemptAt`. */
    markRetry(
        id: number,
        nextAttemptAt: string,
        error: { readonly code: string; readonly message: string },
    ): Promise<void>
    markFailed(
        id: number,
        error: { readonly code: string; readonly message: string },
    ): Promise<void>
    /**
     * Fail every later chunk of a group after one chunk failed permanently.
     *
     * Half a message is worse than none: the reader gets a fragment with no indication that the
     * rest is missing. Returns the ids it abandoned so one `delivery.failed` names the real cause
     * and the cascade is reported as a cascade.
     */
    abandonGroupAfter(
        agentId: string,
        groupKey: string,
        chunkIndex: number,
        error: { readonly code: string; readonly message: string },
    ): Promise<readonly number[]>
    /**
     * Re-queue everything left `inflight` by a dead process, marking it uncertain.
     *
     * Returns what it recovered so boot reports it. Retrying is the deliberate choice: in a
     * conversational channel a lost reply looks like the agent ignored you, which is worse than a
     * rare duplicate — and the duplicate is at least visible in the event stream, while the silence
     * is not.
     *
     * `nextAttemptAt` defaults to now, and is a parameter for the same reason it is one on
     * `enqueue`: the recovering caller's clock is the one that will later ask `due`, and a store
     * that stamped its own would schedule the row into that caller's future.
     *
     * `agentIds` scopes it the same way and for the same reason as `TurnStore.reapRunning`, except
     * that here the unscoped version does visible damage rather than silent: flipping another live
     * process's `inflight` row back to `pending` makes *that* process re-send a Telegram message it
     * had already sent, flagged `uncertain`. Decision 8.9 built that flag to make a crash
     * explicable; firing it because somebody started an unrelated agent makes it mean nothing.
     */
    recoverInflight(
        agentIds: readonly string[],
        nextAttemptAt?: string,
    ): Promise<readonly DeliveryRecord[]>
    /** What these agents' outboxes still owe. */
    backlog(agentIds: readonly string[]): Promise<DeliveryBacklog>
    get(id: number): Promise<DeliveryRecord | undefined>
    byDedupeKey(agentId: string, dedupeKey: string): Promise<DeliveryRecord | undefined>
    list(
        agentId: string,
        options?: {
            readonly sessionKey?: string
            readonly status?: DeliveryStatus
            readonly limit?: number
        },
    ): Promise<readonly DeliveryRecord[]>
    /** Drop terminal rows older than `before`. Nothing calls this on a timer yet. */
    prune(before: string): Promise<number>
}

/** Where a schedule row came from, and therefore who is allowed to remove it. */
export type ScheduleOrigin = "manifest" | "api"

/** How the last run ended. `skipped` covers a fire the overlap policy deferred and then dropped. */
export type ScheduleRunStatus = "ok" | "error" | "skipped"

export interface ScheduleRecord {
    readonly agentId: string
    readonly id: string
    readonly kind: "cron" | "every" | "at"
    readonly expr: string
    /** Absent means the host zone, resolved at parse time. */
    readonly timezone: string | undefined
    readonly task: string
    /** Absent together means `deliver: "none"` — the reply reaches the event stream only. */
    readonly deliverChannel: string | undefined
    readonly deliverTo: string | undefined
    /** `isolated`, or `shared:<key>`. */
    readonly sessionMode: string
    /** Model role override. Absent is `main`. */
    readonly role: string | undefined
    readonly enabled: boolean
    readonly origin: ScheduleOrigin
    /**
     * The un-jittered boundary that **`nextRunAt` belongs to** — the occurrence that has not
     * happened yet, never the one before it.
     *
     * Two things depend on getting this right, and both were bugs first.
     *
     * Jitter must not compound: anchoring the following run on a *jittered* instant adds the offset
     * once per fire, measured at 16m19s between fires of a 15-minute schedule.
     *
     * And it must name the **pending** occurrence rather than the last one. Treating it as
     * already-fired makes the boot recompute ask for the occurrence *after* the pending one, which
     * skips one per restart — measured live, a daily brief went from "in 4h" to "in 28h" and a
     * leap-year schedule from 2028 to 2032. Whether that pending occurrence has been consumed is
     * therefore not inferable from the anchor, and `decideDue` takes it as an argument.
     */
    readonly anchorAt: string
    /** When it fires next, jitter included. `undefined` means never again — a spent one-shot. */
    readonly nextRunAt: string | undefined
    readonly lastFiredAt: string | undefined
    readonly lastStatus: ScheduleRunStatus | undefined
    readonly lastError: string | undefined
    /**
     * The run whose outcome `lastStatus` describes, so a late report can tell whether it still does.
     *
     * A delivery failure surfaces after the turn has finished — `hub.deliver` enqueues and the
     * outbox sends on a later tick — so by the time it arrives the schedule may have fired again.
     * Matching on the id is what stops that report landing on the wrong run.
     */
    readonly lastRunId: string | undefined
    readonly runs: number
    /**
     * The manifest that wrote this row, or `''` for unknown provenance.
     *
     * Rows are keyed by agent `id`, which two directories may share; this is what stops one
     * manifest's reconciliation deleting the other's schedules. See migration 9.
     */
    readonly sourcePath: string
    readonly createdAt: string
    readonly updatedAt: string
}

/** What a caller supplies to create or replace a schedule. Timestamps are the caller's. */
export interface UpsertSchedule {
    readonly agentId: string
    readonly id: string
    readonly kind: "cron" | "every" | "at"
    readonly expr: string
    readonly timezone?: string
    readonly task: string
    readonly deliverChannel?: string
    readonly deliverTo?: string
    readonly sessionMode: string
    readonly role?: string
    readonly enabled: boolean
    readonly origin: ScheduleOrigin
    readonly anchorAt: string
    readonly nextRunAt: string | undefined
    /**
     * The manifest writing this row. Required rather than optional, and `''` for an API write.
     *
     * Not optional on purpose: a conditional spread onto an object literal is not
     * excess-property-checked, and a provenance field that silently defaults is a field that
     * silently stops protecting anything.
     */
    readonly sourcePath: string
    readonly now: string
}

export interface ScheduleFired {
    readonly firedAt: string
    /** The un-jittered boundary this fire belonged to — the anchor for the run after it. */
    readonly anchorAt: string
    readonly nextRunAt: string | undefined
    readonly status: ScheduleRunStatus
    readonly error?: string
    /** Identifies this run, so an outcome reported after it finishes can be matched to it. */
    readonly runId?: string
}

/**
 * Durable schedules.
 *
 * **Every read is scoped to a list of agent ids, and `due` is the reason.** One store file serves
 * every agent in a sandbox root, and two runtimes may share it while the lease guarantees only that
 * each *agent* has one owner. An unscoped due query therefore hands this process another live
 * process's schedules to fire — the same hazard `OutboxStore.recoverInflight` is scoped against, and
 * with the same consequence: work performed twice by a process that had no claim on it.
 *
 * **There is no row-level claim, deliberately.** A transactional `UPDATE … WHERE status='pending' …
 * RETURNING` is the right pattern when several workers compete for one row; here the lease makes one
 * process the only writer for a given agent, so the claim would guard a race that cannot happen. It
 * would also introduce one that can: a claim that clears `nextRunAt` while the run is in flight
 * leaves it NULL forever if the process dies mid-run, and the schedule stops with nothing reporting
 * it. Keeping `nextRunAt` durable means a crash leaves the row simply overdue, and the boot recompute
 * treats it as a missed fire and says so. In-flight state is in memory, where it belongs.
 */
export interface ScheduleStore {
    /** Create or replace. Reconciliation and the API both land here. */
    upsert(schedule: UpsertSchedule): Promise<ScheduleRecord>
    get(agentId: string, id: string): Promise<ScheduleRecord | undefined>
    /** Every schedule, **including disabled** — decision 9.4. `enabled` filters when asked. */
    list(
        agentId: string,
        options?: { readonly enabled?: boolean; readonly origin?: ScheduleOrigin },
    ): Promise<readonly ScheduleRecord[]>
    /** Enabled rows due at or before `now`, soonest first. Scoped — see the interface comment. */
    due(
        agentIds: readonly string[],
        now: string,
        limit?: number,
    ): Promise<readonly ScheduleRecord[]>
    /**
     * The soonest `nextRunAt` across the given agents, for arming the timer.
     *
     * `undefined` when nothing is scheduled, which the scheduler reads as "sleep the full horizon"
     * rather than "sleep forever" — a schedule can be created while the timer is idle.
     */
    nextDue(agentIds: readonly string[]): Promise<string | undefined>
    /**
     * Record a completed run and the following due time, in one write.
     *
     * Increments `runs` and sets `lastStatus`, so it is **only** for a run that actually happened.
     * Moving a due time for any other reason — the boot recompute, a deferral the overlap policy
     * held — goes through `reschedule`, because counting those as runs makes the two figures a
     * person reads to judge a schedule's health both wrong in the same direction.
     */
    markFired(agentId: string, id: string, fired: ScheduleFired): Promise<void>
    /** Move the due time without recording a run. See `markFired`. */
    reschedule(
        agentId: string,
        id: string,
        next: {
            readonly anchorAt: string
            readonly nextRunAt: string | undefined
            readonly now: string
        },
    ): Promise<void>
    setEnabled(agentId: string, id: string, enabled: boolean, now: string): Promise<void>
    remove(agentId: string, id: string): Promise<boolean>
    /**
     * Drop manifest-owned rows this agent no longer declares.
     *
     * Scoped to `origin = 'manifest'` because the manifest owns manifest schedules only: one created
     * through the API and absent from the file is left alone, which `02-SPEC-MANIFEST.md` states and
     * a reload would otherwise quietly violate.
     */
    removeManifestExcept(
        agentId: string,
        keep: readonly string[],
        sourcePath: string,
    ): Promise<readonly string[]>
    /**
     * Record that a finished run's delivery did not arrive.
     *
     * **The one thing `markFired` cannot know.** It writes `ok` when the turn completes, which is
     * true and is not the question `dispach schedules` is asked — the reply is handed to
     * `hub.deliver`, which *enqueues*; the send happens on a later outbox tick and can fail
     * permanently. Before this existed a schedule delivering to an unroutable recipient reported
     * `ok just now` forever, with `err.log` at zero bytes: the exact shape the listing's own
     * docstring says it exists to prevent.
     *
     * Applies only when `runId` matches `lastRunId`, so a report that arrives after the schedule has
     * fired again is dropped rather than written onto the following run. Returns whether it applied,
     * which is the difference between "recorded" and "too late" and is worth being able to assert.
     */
    markDeliveryFailed(
        agentId: string,
        id: string,
        runId: string,
        error: string,
        now: string,
    ): Promise<boolean>
}

export interface ArtifactRecord {
    /** Derived from the content by `compaction/stages.ts`. Printable ASCII: it is a bound key. */
    readonly id: string
    readonly sessionKey: string
    /** The tool that produced the observation, where it named one. */
    readonly slug?: string
    readonly content: string
    /** Estimated cost of the original, so a reader knows the size before spending a step on it. */
    readonly tokens: number
    readonly createdAt: string
}

/**
 * What compaction displaced, so nothing it removed is unreachable.
 *
 * `put` is idempotent by construction rather than by convention: the id is derived from the content,
 * so the same observation written twice is the same row. That is what lets the ladder escalate over a
 * message across turns — snipped on one, pointer-replaced on a later one — without accumulating a row
 * per stage.
 */
export interface ArtifactStore {
    put(
        agentId: string,
        sessionKey: string,
        artifacts: readonly Omit<ArtifactRecord, "sessionKey" | "createdAt">[],
        now: string,
    ): Promise<void>
    get(agentId: string, sessionKey: string, id: string): Promise<ArtifactRecord | undefined>
    /** Newest first. For a listing; the agent reads one at a time by id. */
    list(agentId: string, sessionKey: string): Promise<readonly ArtifactRecord[]>
}

export interface MemoryPassageRecord {
    /** Content-derived, printable ASCII. See `ids.ts`. */
    readonly id: string
    /** Path relative to the memory root, or `session:<key>`. */
    readonly source: string
    readonly heading?: string
    /** Verbatim as authored. What slot 7 injects. */
    readonly text: string
    /** `rank/bm25.ts` terms(), space-joined — the indexed form, and what BM25 counts. */
    readonly terms: string
    /** Number of terms, so average document length is a SUM rather than a scan. */
    readonly length: number
    readonly at: string
    readonly stamped: boolean
    readonly tags: readonly string[]
    /** Estimated cost of `text`, so the slot budget applies without re-estimating per turn. */
    readonly tokens: number
}

/** What has been indexed for one source, and under which tokeniser. */
export interface MemorySourceState {
    readonly source: string
    readonly mtimeMs: number
    readonly size: number
    /** `TOKENISER_VERSION` at index time. A mismatch means the terms on disk are stale. */
    readonly tokeniser: number
    readonly passages: number
    readonly indexedAt: string
}

/** BM25's corpus statistics, per agent. */
export interface MemoryCorpusStats {
    readonly passages: number
    readonly totalLength: number
}

/**
 * The memory corpus. **Not scoped to a session, and that is structural.**
 *
 * Every other per-conversation table cascades from `sessions`; these rows do not reference one at all.
 * Canonical files therefore survive session deletion structurally. Conversation projections use the
 * explicit `session:<key>` namespace and the session store removes that source transactionally.
 *
 * The store supplies *candidates and statistics*, never a score. Ranking is `memory/fts5.ts` using the
 * shared BM25 in `rank/bm25.ts`, for the reason migration 6 records: FTS5's own `bm25()` computes its
 * statistics over the whole table, and one sandbox root has one store shared by every agent in it — so
 * a corpus-wide average document length would make one agent's scores move when an unrelated agent
 * saved a note.
 */
export interface MemoryStore {
    /**
     * Replace everything indexed for one source, in one transaction.
     *
     * Wholesale rather than incremental because a markdown file has no stable identity per line: an
     * edit three passages up renumbers nothing and changes nothing about the others, but working that
     * out is more expensive and more fragile than re-splitting a file that is measured in kilobytes.
     * Content-derived ids make the re-insert idempotent, so an unchanged passage keeps its row.
     */
    replaceSource(
        agentId: string,
        source: string,
        passages: readonly MemoryPassageRecord[],
        state: Omit<MemorySourceState, "source" | "passages" | "indexedAt">,
        now: string,
    ): Promise<void>
    /** Every source currently indexed, so a caller can spot a changed, vanished or stale-tokenised one. */
    sources(agentId: string): Promise<readonly MemorySourceState[]>
    /** Forget one source: its passages and its state. For a file that has been deleted. */
    dropSource(agentId: string, source: string): Promise<void>
    /** Forget everything for this agent. What `memory rebuild` does before re-reading the files. */
    clear(agentId: string): Promise<void>
    stats(agentId: string): Promise<MemoryCorpusStats>
    /** Document frequency per term, within this agent's corpus. */
    frequencies(agentId: string, terms: readonly string[]): Promise<Map<string, number>>
    /**
     * Passages containing at least one of `terms`, bounded by `limit`.
     *
     * Ordered by FTS5's own `bm25()` — which is the one legitimate use for it here. It is approximately
     * the right ranking, and it is only being asked to decide *which* rows are worth scoring properly,
     * so its corpus-wide statistics cost nothing. The caller re-scores what comes back.
     */
    candidates(
        agentId: string,
        terms: readonly string[],
        limit: number,
    ): Promise<readonly MemoryPassageRecord[]>
    /**
     * Distinct indexed terms for this agent. Used only on the empty-MATCH path to correct a typo
     * against the corpus; not a second index.
     */
    vocabulary(agentId: string): Promise<ReadonlySet<string>>
}

export interface Store {
    readonly sessions: SessionStore
    readonly messages: MessageStore
    readonly turns: TurnStore
    readonly outbox: OutboxStore
    readonly leases: LeaseStore
    /**
     * The durable per-agent on/off switch. Read by every host at every start.
     *
     * Beside `leases` rather than inside it deliberately: a lease is about *this* process and is
     * released when it exits, and this outlives every process. Putting the flag on the lease row
     * would have made "stopped" a fact that disappeared the moment the host did.
     */
    readonly agentState: AgentStateStore
    readonly kv: KVStore
    readonly artifacts: ArtifactStore
    readonly memory: MemoryStore
    readonly schedules: ScheduleStore
    readonly handoffs: HandoffStore
    /** Every model call's tokens: the meter. Keyed by agent; survives a session being cleared. */
    readonly usage: UsageStore
    /** Outbound webhook subscriptions and what is owed to them. Server-wide, like `operatorKeys`. */
    readonly webhooks: WebhookStore
    /**
     * Server credentials. The one store here that is not per-agent — see migration 14.
     *
     * Which is why `purgeAgent` does not clean it and `AgentFootprint` does not count it: removing
     * one agent from a shared sandbox root must not revoke the credential still authenticating
     * calls about the others.
     */
    readonly operatorKeys: OperatorKeyStore
    /** Human-readable location, for `store.ready` and the `sessions` command. */
    readonly location: string
    /**
     * What one agent owns, counted and not touched.
     *
     * Read-only, and the pair to `purgeAgent`: a destructive command has to be able to *show* what it
     * would take before taking it, and deriving that listing separately is how a listing and a
     * deletion come to disagree.
     */
    agentFootprint(agentId: string): Promise<AgentFootprint>
    /**
     * Delete everything belonging to one agent, in one transaction.
     *
     * Returns what went, in the same shape `agentFootprint` reports, so the confirmation and the
     * receipt are the same numbers.
     *
     * **One store is shared by every agent in a sandbox root**, so this is a `DELETE … WHERE
     * agent_id = ?` rather than dropping a file — which makes the isolation a property of these
     * queries rather than of the filesystem, and makes "another agent's rows are untouched" a thing to
     * assert rather than assume. `kv` is not cleaned: it has no `agent_id` column, and no consumer.
     */
    purgeAgent(agentId: string): Promise<AgentFootprint>
    /**
     * Every agent id with rows anywhere in the store.
     *
     * For finding rows no agent claims any more. `LeaseStore.orphans` answers a narrower question —
     * ids with *running* turns or *inflight* deliveries and no lease — which cannot see an agent whose
     * directory was deleted while it was idle. That agent's sessions, memory and logs are simply
     * unreachable, and this is what makes them nameable.
     */
    agentIds(): Promise<readonly string[]>
    close(): Promise<void>
}
