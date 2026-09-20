/**
 * The lifecycle event schema. Append-only within `v: 1` — consumers key off `type`, and
 * removing or repurposing one breaks them silently.
 *
 * Core emits; consumers persist. The runtime writes no rows it does not own, so everything a
 * platform wants to know about an agent arrives here.
 */

import type { ChannelStatus, IssuedChannelInput } from "../channels/channel.ts"
import type { ErrorDetail } from "../errors.ts"
import type { SenderKind } from "../loop/sender.ts"
import type { OnMutate, Trust } from "../tools/trust.ts"

/** Envelope fields shared by every event. */
export interface EventContext {
    readonly agentId?: string
    readonly sessionKey?: string
    readonly turnId?: string
    readonly stepId?: string
}

export interface EventEnvelope<TType extends string = string, TData = unknown> {
    readonly v: 1
    /** RFC 3339 UTC. */
    readonly ts: string
    readonly runtimeId: string
    readonly agentId?: string
    readonly sessionKey?: string
    readonly turnId?: string
    readonly stepId?: string
    readonly type: TType
    readonly data: TData
}

/**
 * Why a turn stopped. Everything that is not `final` is reported honestly, never as `final`.
 *
 * `max_steps` used to be applied only when the last step left work pending or produced no text, so a
 * turn that exhausted its budget while narrating was recorded as a clean completion. There is no
 * reading under which reaching the cap is `final`, and the condition is gone.
 *
 * `truncated` and `no_progress` are separate reasons rather than shades of the other two because each
 * needs a different sentence: a truncated reply names an output limit and whose it was, and a stalled
 * one names the call that repeated. Collapsing either into `max_steps` would put the wrong remedy in
 * front of whoever reads it.
 */
export type TurnEndReason =
    | "final"
    | "max_steps"
    | "no_progress"
    | "truncated"
    | "stopped"
    | "timeout"
    | "error"

export interface ContextSlotReport {
    readonly slot: number
    /**
     * Human-facing name for the slot, from the first block in it.
     *
     * Declared because it is *sent*: `slotReport` has always included it and the interface has always
     * omitted it, which type-checks because a function return is not excess-property-checked. So every
     * reader saw `undefined` where the wire carried a name, and `04-SPEC-WIRE.md` documented a field
     * the type said did not exist.
     */
    readonly label: string
    readonly tokens: number
    readonly pinned: boolean
}

/**
 * Event type → shape of its `data`. Phase 1 covers boot, turn, and model events; tool events
 * arrived in Phase 3 and channel and delivery events in Phase 4. Skill, compaction, and schedule
 * events arrive with their subsystems.
 */
export interface EventDataMap {
    "runtime.ready": {
        /** Time inside `Runtime.create`. */
        bootMs: number
        /** Time since process start — the number the sub-second boot claim refers to. */
        processMs: number
        phases: Record<string, number>
        agents: number
    }
    /**
     * The store is open and migrated. Fires before `runtime.ready`, because nothing can serve a
     * turn until it does.
     *
     * `reaped` names turns a previous process left `running`. It is reported rather than fixed
     * quietly: a non-empty list means that process died mid-generation, which is worth seeing.
     */
    "store.ready": {
        location: string
        driver: "bun" | "node"
        /** Schema version before migrating. 0 for a fresh database. */
        from: number
        to: number
        applied: string[]
        reaped: string[]
    }
    "runtime.stopping": { reason: string }
    "agent.loaded": { tools: number; skills: number; schedules: number; model: string }
    /**
     * One agent stopped being hosted by this process, while the process kept running.
     *
     * The other half of `agent.loaded`, and it only became possible to emit when `Runtime.dispose`
     * did: before that an agent left only by the process exiting, which `runtime.stopping` already
     * reports. A client holding a list of agents needs both — an always-on server whose agent set
     * changes under it, with nothing on the stream saying so, is a UI that shows a chat for an
     * agent that has gone.
     *
     * `reason` rather than a boolean because the three cases read differently to whoever is
     * watching: `requested` is an operator, `replaced` is the same agent coming back a moment
     * later, `stopped` is 16.3's durable off switch.
     */
    "agent.disposed": { reason: "requested" | "replaced" | "stopped" }
    "agent.warning": ErrorDetail
    /**
     * One plugin registered, with what it cost and what it declared.
     *
     * `permissions` carries the *kinds* rather than the full entries: the event's job is to make
     * visible that a plugin asked for network and env access at all, and the detail belongs in
     * `plugins` output where somebody is actually reading it. Advisory in v1 either way (7.5).
     */
    "plugin.loaded": {
        name: string
        version: string
        setupMs: number
        permissions: string[]
    }
    /**
     * A `setup` over its budget.
     *
     * Reported, never refused. `setup` registers capabilities and does no work, so a slow one is
     * usually doing work that belonged in a factory — and naming it is what makes that visible,
     * where a refusal would turn a performance smell into an agent that will not start.
     */
    "plugin.slow": { name: string; setupMs: number }
    /**
     * `trust` and `from` are additive within `v: 1` and both are always meaningful.
     *
     * `trust` is present on every turn — `"trusted"` for the operator, the REPL, a schedule and a
     * channel turn alike — rather than only when it is `"untrusted"`. A field that appears only in
     * the interesting case makes its absence ambiguous between "this turn was trusted" and "this
     * server predates the field", and an observability surface has to be able to tell those apart.
     * `from` *is* omitted when there was no sender, because an absent sender is a real third state
     * and synthesising one would put the operator's own turn behind a fake identity.
     */
    /**
     * A call is waiting on a person, and the runtime emitted this **before** asking.
     *
     * Core emits it, not the front end, and that placement is the whole reason every surface gets
     * approvals for free. The plan had the approver emitting its own event, which makes the request
     * visible only to whichever front end implements it — so a second observer of a REPL session,
     * or an audit log, or the firehose, would see a turn simply stop. Core already holds the
     * `EventContext` (agent, session, turn) that a client needs to correlate the prompt with what it
     * is showing, and an `ApprovalRequest` deliberately does not carry any of it.
     *
     * Paired with exactly one `approval.resolved`. A request with no resolution is a bug, not a
     * state — the same reasoning that keeps `tool.gated` from emitting a `tool.call` it will never
     * follow with a `tool.result`.
     */
    "approval.requested": {
        approvalId: string
        slug: string
        callId: string
        /** The command or path a rule would match. Terminal escapes already stripped. */
        match?: string
        mutating: boolean
        reason: string
    }
    /**
     * How it ended, including the ways nobody chose.
     *
     * `by` matters more than `granted` to a client with a prompt on screen: `"abandoned"` means
     * take it down because the turn is gone, `"error"` means the approver itself is broken and the
     * denial says nothing about what a person wanted. Collapsing all three into `granted: false`
     * would make a crashed approver indistinguishable from a considered no.
     */
    "approval.resolved": {
        approvalId: string
        slug: string
        granted: boolean
        by: "approver" | "error" | "abandoned"
    }
    /**
     * A delegation began. Emitted on the **supervisor's** context, so the envelope's `turnId` is
     * the turn that is waiting rather than the member's.
     *
     * `sessionKey` is the member's fresh session, which is the answer to "what did it actually
     * say" — the artifact is all that reaches the supervisor's prompt, deliberately, so without
     * this a `no_artifact` would be unexplainable from the outside.
     */
    "handoff.start": { member: string; task: string; sessionKey: string }
    /**
     * How it ended. `outcome` rather than a boolean, and that is the same reasoning
     * `approval.resolved.by` carries: four outcomes collapse badly into `ok: false`.
     *
     * `no_artifact` is the member declining or failing to fit the schema — its own prose says which.
     * `budget` is its `limits` stopping it, which is a task-too-large signal rather than a fault.
     * `error` is a fault. Reporting the first two as failure would send a reader debugging the
     * member when the thing to change is the task.
     */
    "handoff.result": {
        member: string
        sessionKey: string
        outcome: "ok" | "no_artifact" | "budget" | "error"
        steps: number
        tokens: { prompt: number; output: number }
        errorCode?: string
    }
    "turn.start": {
        source: string
        inputTokens: number
        trust: Trust
        from?: { id: string; kind: SenderKind }
    }
    "context.assembled": { slots: ContextSlotReport[]; total: number }
    /**
     * History that did not fit the prompt budget and was left out by `assembleContext`.
     *
     * This is the blunt trim, not the ladder: it runs after compaction has done what it can and drops
     * whole messages newest-budget-first. `AssembledContext.droppedMessages` was documented as
     * "Reported, never silent" and had no reader anywhere, so a prompt could lose the oldest half of a
     * conversation with nothing saying so on any surface.
     *
     * Distinct from `compaction.stage` on purpose: a stage is a decision the ladder made and can
     * explain, and this is the budget running out anyway.
     */
    "context.dropped": { messages: number; budget: number; keptTokens: number }
    /**
     * How full the prompt that was sent is. Emitted once per step, after any compaction.
     *
     * `fraction` describes the prompt that went to the endpoint, not the one the ladder was handed —
     * and that distinction was a real defect, caught in a pty capture. Reporting the pre-compaction
     * figure put **`ctx 128%`** on the status line of a session that compaction had handled correctly:
     * true of a prompt nobody sent, and indistinguishable from a runtime that had just overflowed its
     * window. `peak` carries the figure the ladder actually ran on, and is present only when it differs.
     *
     * `source` is here because a fraction alone cannot be acted on: `estimated` means no endpoint has
     * reported `prompt_tokens` yet and the figure carries the estimator's raw bias, which is measured
     * at 16–20% *low* on observation-heavy prompts. Reading a bare number without knowing which of the
     * three it is invites tuning thresholds against the wrong quantity.
     */
    "context.pressure": {
        fraction: number
        tokens: number
        budget: number
        source: "reported" | "corrected" | "estimated"
        /** What the ladder faced, when compaction changed it. Absent on an ordinary turn. */
        peak?: number
    }
    /**
     * One compaction stage that ran. Emitted per stage, in the order they ran.
     *
     * `changed: false` is not noise — it is why the next stage ran, and a ladder that only reported its
     * successes would look like it skipped rungs. `digest` names where the text came from, because "the
     * digest is thin" and "the compactor is unreachable" need different fixes.
     */
    "compaction.stage": {
        stage: "trim" | "snip" | "micro" | "collapse" | "reset"
        before: number
        after: number
        changed: boolean
        digest?: "model" | "mechanical"
    }
    /**
     * The last rung fired: history was replaced by a digest.
     *
     * `count` is per session, and a second firing is a misconfiguration rather than a busy day —
     * `warning` carries the sentence saying so.
     */
    "context.reset": { count: number; warning?: string }
    /**
     * The session moved to another phase, and the visible catalogue changed with it.
     *
     * `tools` is the count now visible, because that is the fact a reader wants: the phase name alone
     * does not say whether the move did anything. Emitted from inside the step that called `phase_set`,
     * so the ordering shows which reply the change applies to.
     */
    "phase.changed": { to: string; tools: number }
    "model.call": {
        role: "main" | "selector" | "compactor"
        model: string
        promptTokens: number
        cached: boolean
        attempt: number
    }
    /** Suppressed unless a subscriber opted in — this is per-token and high volume. */
    "model.chunk": { delta: string; kind: "text" | "reasoning" }
    "model.retry": { status: number; attempt: number; delayMs: number }
    "model.result": {
        outputTokens: number
        promptTokens: number
        /**
         * Whether `promptTokens` came from the endpoint or from `estimateTokens`.
         *
         * The event carried the number and not whether it was measured, so every consumer summing
         * it was mixing the two silently — and the estimator runs **16-20% low** on exactly the
         * observation-heavy prompts worth summing (`evals/budget`). `StepResult` has carried this
         * flag since Phase 7A for the compaction ladder, which refuses to calibrate without it; a
         * ladder that would not trust the figure while an observability surface reported it as fact
         * is the same asymmetry `cachedPromptTokens`' three states exist to prevent.
         *
         * Added by 10B's eval, which needs to compare two token figures and must refuse to print a
         * ratio of two estimates.
         */
        promptTokensReported: boolean
        finishReason: string
        latencyMs: number
    }
    /**
     * A tool is about to run. `argsHash` rather than the arguments themselves: arguments carry
     * whatever the conversation carried, and an event stream is the wrong place to copy it to.
     */
    "tool.call": { slug: string; callId: string; argsHash: string; mutating: boolean }
    "tool.result": {
        slug: string
        callId: string
        ok: boolean
        latencyMs: number
        /** Of the observation before any truncation, so a cut is visible as a size, not a guess. */
        bytes: number
        truncated: boolean
        /** Whether this output may contain text a stranger wrote. */
        trust: Trust
    }
    /**
     * A call was blocked before it ran — by the trust gate, or by a `tools.policy` rule.
     *
     * **Not an error.** The model is told and the turn continues. `reason` says which of the two
     * decided and why; `policy` carries the `tools.untrusted.onMutate` setting, so a surprised
     * operator can see whether they were on the default.
     *
     * A blocked call emits this and nothing else — no `tool.call`, no `tool.result` — because
     * nothing ran, and a consumer pairing call with result would otherwise hold an orphan.
     */
    "tool.gated": { slug: string; callId: string; reason: string; policy: OnMutate }
    /**
     * A step's tool calls could not be used as written. The first occurrence is followed by one
     * correction request; a second in a row ends the turn with `tool_repair_failed` rather than
     * asking again. Two of these back to back is the signal that a catalogue needs work.
     */
    "tool.repair": { slugs: string[]; errors: string[] }
    /**
     * A remote tool provider caught its cached catalogue up, **after** `runtime.ready`.
     *
     * The only observable evidence that the refresh happened, since it is deliberately fire-and-forget:
     * the boot path resolves from disk so that nothing touches the network before readiness, which
     * means the network call has to live somewhere with no caller waiting on it. `ok: false` carries
     * the reason and is not a turn failure — the agent keeps serving the cached catalogue.
     *
     * `changed` is the field worth watching. A slug whose schema moved under a running agent is a
     * catalogue the model has already been told about in the current session's cached prefix.
     */
    "tools.refreshed": {
        provider: string
        ok: boolean
        fetched: number
        changed: string[]
        missing: string[]
        latencyMs: number
        /** Present when `ok` is false. */
        error?: string
    }
    /**
     * A channel's state changed.
     *
     * Never blocks readiness. A channel that cannot connect says so here and keeps trying, because
     * a runtime that refused to boot during a Telegram outage would also be unable to serve its
     * HTTP API during one. `needs_input` is the same rule applied to a person rather than a
     * network: the transport is up and cannot finish without somebody acting.
     *
     * `status` is imported rather than restated. It was a second literal copy of `ChannelStatus`
     * for four phases — right when written and silently wrong at the next member, which is the
     * hand-kept-list shape this runtime has paid for repeatedly (`NO_MANIFEST`, `THRESHOLD_ORDER`,
     * the wire doc's six phantom event rows).
     *
     * `input` accompanies `needs_input` and nothing else: the structured thing a person has to act
     * on, where `detail` is the sentence explaining it. A consumer must tolerate an unknown
     * `kind`, because that set can grow inside `v: 1` while this field's type cannot.
     */
    "agent.channel.status": {
        channelId: string
        channelType: string
        status: ChannelStatus
        detail?: string
        input?: IssuedChannelInput
    }
    /** A channel failure that did not stop the channel. A bad token lands here, not on `error`. */
    "agent.channel.error": ErrorDetail & { channelId: string }
    /**
     * An inbound message was not turned into a turn.
     *
     * `duplicate` is routine — a provider replaying an unacknowledged update. `denied` is an
     * `allowFrom` refusal, and is reported rather than dropped silently: an allowlist that quietly
     * discards a message is indistinguishable from a channel that is not receiving at all, which is
     * a support conversation nobody enjoys.
     */
    "agent.channel.rejected": {
        channelId: string
        reason: "duplicate" | "denied"
        /** Handle where the provider exposes one, peer id otherwise. Never the message body. */
        sender: string
        detail: string
    }
    /**
     * One chunk reached the provider.
     *
     * `uncertain` means this row was recovered from a dead process and may be a second copy — see
     * `delivery.uncertain`. It is on the success event on purpose: that is where a reader
     * investigating a duplicate will actually be looking.
     */
    "delivery.sent": {
        channelId: string
        providerMessageId?: string
        chunkIndex: number
        chunkTotal: number
        attempts: number
        uncertain: boolean
    }
    /** A retryable send failed and will be tried again after `delayMs`. */
    "delivery.retry": {
        channelId: string
        chunkIndex: number
        attempts: number
        delayMs: number
        error: ErrorDetail
    }
    /**
     * A chunk was abandoned. `exhausted` distinguishes "gave up after N tries" from "the provider
     * said no and meant it", which want different responses from whoever is reading.
     *
     * `abandoned` counts the later chunks of the same reply dropped as a consequence. Half a
     * message is worse than none, so they are not sent on their own — and they are reported as one
     * number rather than as N more failure events, because there was one fault.
     */
    "delivery.failed": {
        channelId: string
        chunkIndex: number
        chunkTotal: number
        attempts: number
        exhausted: boolean
        abandoned: number
        error: ErrorDetail
    }
    /**
     * A delivery was found in flight at boot and re-queued, and may therefore be sent twice.
     *
     * The window is between the bytes leaving the process and the provider's acknowledgement
     * arriving back, and it cannot be closed from this side — only by a provider that deduplicates
     * on a key we supply. `idempotentSend` reports whether this channel is one of those, so the
     * event says how much doubt there actually is rather than implying a fixed amount.
     */
    "delivery.uncertain": {
        channelId: string
        chunkIndex: number
        chunkTotal: number
        attempts: number
        idempotentSend: boolean
    }
    /**
     * A tool provider let go of something outside this process during shutdown.
     *
     * Emitted rather than logged because the thing being released is, by definition, something that
     * would otherwise outlive the runtime unnoticed — which is exactly what happened: `exec`
     * backgrounded commands that nothing ever reaped, and thirty-three of them took the machine to a
     * load average of 351 and made `runtime.ready` take 132 seconds.
     */
    "runtime.released": { provider: string; released: string[] }
    /** Manifest schedules brought in line with the store at load. API-created rows are untouched. */
    "schedules.reconciled": {
        created: number
        updated: number
        removed: number
        total: number
    }
    /**
     * A schedule came due and a turn started.
     *
     * `driftMs` is measured against the row's own `nextRunAt`, so it reports the **scheduler's**
     * lateness and not the jitter — jitter is a deliberate, reproducible displacement and folding it
     * into drift would make a healthy schedule look permanently late by its own offset.
     */
    "schedule.fired": {
        scheduleId: string
        kind: "cron" | "every" | "at"
        driftMs: number
        /** A one-shot firing after its moment, because nothing was running when it came due. */
        late: boolean
    }
    /**
     * Occurrences that came due with nothing running, and were not replayed.
     *
     * A recurring schedule skips to the next occurrence after downtime rather than firing the whole
     * backlog. Emitted so the skip is visible: a schedule that silently drops fires is
     * indistinguishable from one that is working, which is the failure this event exists to prevent.
     */
    "schedule.skipped": {
        scheduleId: string
        kind: "cron" | "every" | "at"
        reason: "downtime"
        missed: number
        /** The count hit its cap and the real figure is higher. */
        missedAtLeast: boolean
    }
    /** A fire arrived while the previous run of the same schedule was still going. */
    "schedule.deferred": { scheduleId: string; kind: "cron" | "every" | "at" }
    /**
     * A schedule could not be read, or the turn it started failed.
     *
     * Never thrown, on purpose: one unreadable expression must not stop the timer for every other
     * schedule in the process.
     */
    "schedule.error": { scheduleId: string; code: string; message: string; hint: string }
    "turn.end": {
        reason: TurnEndReason
        steps: number
        tokens: { prompt: number; output: number }
        durationMs: number
    }
    error: ErrorDetail & { stack?: string }
}

export type EventType = keyof EventDataMap & string

/**
 * Every event type, as a value.
 *
 * `EventDataMap` is a *type*, so nothing at runtime could enumerate it — which is why
 * `GET /v1/events?types=` accepted any string at all and streamed nothing forever for a typo, and
 * why `04-SPEC-WIRE.md` could carry six rows for events that did not exist. Both are the same
 * missing thing: a list a program can read.
 *
 * Kept in the same order as `EventDataMap` so the two can be diffed by eye, though nothing depends
 * on the order.
 */
export const EVENT_TYPES = [
    "runtime.ready",
    "store.ready",
    "runtime.stopping",
    "agent.loaded",
    "agent.disposed",
    "agent.warning",
    "plugin.loaded",
    "plugin.slow",
    "approval.requested",
    "approval.resolved",
    "handoff.start",
    "handoff.result",
    "turn.start",
    "context.assembled",
    "context.dropped",
    "context.pressure",
    "compaction.stage",
    "context.reset",
    "phase.changed",
    "model.call",
    "model.chunk",
    "model.retry",
    "model.result",
    "tool.call",
    "tool.result",
    "tool.gated",
    "tool.repair",
    "tools.refreshed",
    "agent.channel.status",
    "agent.channel.error",
    "agent.channel.rejected",
    "delivery.sent",
    "delivery.retry",
    "delivery.failed",
    "delivery.uncertain",
    "runtime.released",
    "schedules.reconciled",
    "schedule.fired",
    "schedule.skipped",
    "schedule.deferred",
    "schedule.error",
    "turn.end",
    "error",
] as const satisfies readonly EventType[]

/** Declared in `EventDataMap` and absent from `EVENT_TYPES`. Should always be `never`. */
export type EventTypesMissing = Exclude<EventType, (typeof EVENT_TYPES)[number]>

/** Named in `EVENT_TYPES` and absent from `EventDataMap`. Should always be `never`. */
export type EventTypesUnknown = Exclude<(typeof EVENT_TYPES)[number], EventType>

/**
 * **The drift check, and it is `tsc` rather than a test on purpose.**
 *
 * A test can only run where somebody runs it; a type error stops the build, and the whole problem
 * being solved here is a list that was correct when written and wrong at the next addition. Adding
 * a type to `EventDataMap` without adding it here makes the annotation `never`, so `= true` fails
 * to compile — and `EventTypesMissing` above names which one, because an error reading "true is
 * not assignable to never" would send somebody looking in the wrong place.
 *
 * `satisfies readonly EventType[]` on the tuple covers the other direction: a typo'd member is
 * rejected at the literal itself, where the mistake is.
 *
 * Exported because `noUnusedLocals` is on and an unused local would be deleted by the next person
 * tidying up — the check has to be load-bearing to survive.
 */
export const EVENT_TYPES_COMPLETE: [EventTypesMissing, EventTypesUnknown] extends [never, never]
    ? true
    : never = true

export type AnyEvent = {
    [K in EventType]: EventEnvelope<K, EventDataMap[K]>
}[EventType]
