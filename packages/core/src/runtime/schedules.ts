/**
 * Turning a schedule row into a turn, and a manifest's `schedules:` into rows.
 *
 * Two things live here rather than in `schedule/`, and both for the same reason: they need an
 * `Agent` and a `ChannelHub`. The `schedule/` modules are pure calendar arithmetic and a timer, and
 * keeping them free of the runtime is what lets the whole DST table be tested without constructing
 * anything.
 *
 * **A scheduled run delivers through the outbox, never around it.** `ChannelHub.deliver` chunks,
 * orders, dedupes on a derived key and retries; a second delivery path here would be a second set of
 * idempotency semantics, and the two would disagree the first time one of them was changed. The
 * scheduler therefore knows nothing about Telegram, WhatsApp or email — it names a channel id and a
 * recipient, and the transport that owns that id does the rest. That is why adding a delivery
 * channel is a new package and no change here at all.
 */

import { ConfigError } from "../errors.ts"
import type { ScheduleConfig } from "../manifest/schema.ts"
import { ScheduleSchema } from "../manifest/schema.ts"
import { decideDue, parseSchedule } from "../schedule/kinds.ts"
import { formatSessionKey, isSessionKey, parseSessionKey } from "../store/session-key.ts"
import type {
    ScheduleOrigin,
    ScheduleRecord,
    ScheduleStore,
    UpsertSchedule,
} from "../store/store.ts"
import type { Agent } from "./agent.ts"
import type { ChannelHub } from "./channels.ts"

/** The channel segment every scheduled session carries. */
const SCHEDULE_CHANNEL = "schedule"

/**
 * The session a run happens in.
 *
 * `isolated` is a **fresh session per run** — the run id goes in the thread segment, which
 * `parseSessionKey` already handles. Each run therefore starts clean, and the store keeps what every
 * run said. The alternative, one key that accumulates, fills its window and starts paying for
 * compaction on every fire forever with nobody watching; `shared:<key>` remains the opt-in for
 * genuinely wanting continuity.
 */
export function scheduleSessionKey(sessionMode: string, scheduleId: string, runId: string): string {
    if (sessionMode.startsWith("shared:")) {
        const key = sessionMode.slice("shared:".length)
        if (key !== "") return key
    }
    return formatSessionKey({ channel: SCHEDULE_CHANNEL, peerId: scheduleId, thread: runId })
}

/**
 * The schedule run a session key belongs to, or `undefined` when it is not a scheduled session.
 *
 * The inverse of `scheduleSessionKey`, and it only answers for `isolated` runs — which is the whole
 * set it can answer for. A `shared:<key>` schedule deliberately writes into a session named by the
 * author, so its key carries no schedule id and nothing can be recovered from it. That is a real
 * limit rather than an oversight: continuity was the thing asked for, and the cost of it is that a
 * late report about one run cannot be told apart from a late report about another.
 */
export function scheduleRunOfSession(
    sessionKey: string,
): { readonly id: string; readonly runId: string } | undefined {
    if (!isSessionKey(sessionKey)) return undefined
    const parts = parseSessionKey(sessionKey)
    if (parts.channel !== SCHEDULE_CHANNEL || parts.thread === undefined) return undefined
    return { id: parts.peerId, runId: parts.thread }
}

export interface ReconcileReport {
    readonly created: readonly string[]
    readonly updated: readonly string[]
    readonly removed: readonly string[]
}

/**
 * Bring the store's manifest-owned schedules in line with the manifest.
 *
 * **Scoped to `origin: "manifest"`.** A schedule created through the API and absent from the file is
 * left alone, which `02-SPEC-MANIFEST.md` states and which a naive "delete everything not in the
 * manifest" would quietly violate on the next reload.
 *
 * A row that already exists keeps its `anchorAt` and `nextRunAt` **when its definition has not
 * changed**, so a reload does not reset a schedule's place in its own sequence — restarting the
 * process twice in a minute must not make an hourly schedule wait another hour each time. An edited
 * expression does reset, because the old anchor describes a sequence that no longer exists.
 *
 * **Scoped to `sourcePath` as well, because that guarantee was only ever true of one manifest.** A
 * store is keyed by agent `id`, and two directories may declare the same one; the removal below then
 * deleted the other manifest's rows, and the next reconcile re-created them — `existing` undefined,
 * so `unchanged` false, so a fresh anchor. Measured on a real pair of manifests: `in 3m`, deleted,
 * `in 16m`. The schedule never reached its own due time and nothing anywhere reported a fault,
 * because each manifest was correct about the rows it could see.
 */
export async function reconcileSchedules(input: {
    readonly agentId: string
    readonly schedules: readonly ScheduleConfig[]
    readonly store: ScheduleStore
    readonly now: number
    /**
     * Absolute path of the manifest doing the reconciling — `LoadedManifest.path`, which is
     * `"(object)"` for a programmatic manifest and is a stable identity for that case too.
     */
    readonly sourcePath: string
}): Promise<ReconcileReport> {
    const created: string[] = []
    const updated: string[] = []
    const nowIso = new Date(input.now).toISOString()

    for (const declared of input.schedules) {
        const existing = await input.store.get(input.agentId, declared.id)
        // Parsed here so a manifest that got past the schema but names an impossible date fails at
        // load rather than at the first fire.
        const parsed = parseSchedule({
            id: declared.id,
            kind: declared.kind,
            expr: declared.expr,
            timezone: declared.timezone,
            now: input.now,
            field: `schedules.${declared.id}.expr`,
        })

        const deliver = declared.deliver === "none" ? undefined : declared.deliver
        const unchanged =
            existing !== undefined &&
            existing.kind === declared.kind &&
            existing.expr === declared.expr &&
            existing.timezone === declared.timezone &&
            existing.sessionMode === declared.session

        // The real next occurrence, computed here rather than stamped as `now`.
        //
        // The scheduler recomputes at `start()` anyway, so stamping was harmless *when a scheduler
        // ran*. Under `run` none does — schedules are reconciled so a listing can see them — and the
        // row then reported a next-run time in the past. A listing that answers "when does this fire
        // next" with a moment that has already gone is worse than one that does not answer.
        const decision = decideDue(parsed, declared.id, input.now, input.now)
        const fresh = {
            anchorAt:
                decision.anchor === undefined ? nowIso : new Date(decision.anchor).toISOString(),
            nextRunAt:
                decision.runAt === undefined ? undefined : new Date(decision.runAt).toISOString(),
        }

        await input.store.upsert({
            agentId: input.agentId,
            id: declared.id,
            kind: declared.kind,
            expr: declared.expr,
            ...(declared.timezone === undefined ? {} : { timezone: declared.timezone }),
            task: declared.task,
            ...(deliver === undefined
                ? {}
                : { deliverChannel: deliver.channel, deliverTo: deliver.to }),
            sessionMode: declared.session,
            ...(declared.role === undefined ? {} : { role: declared.role }),
            enabled: declared.enabled,
            origin: "manifest",
            // Keeping the anchor is what stops a restart resetting the sequence.
            anchorAt: unchanged ? existing.anchorAt : fresh.anchorAt,
            nextRunAt: unchanged ? existing.nextRunAt : fresh.nextRunAt,
            sourcePath: input.sourcePath,
            now: nowIso,
        })

        if (existing === undefined) created.push(declared.id)
        else if (!unchanged) updated.push(declared.id)
    }

    const removed = await input.store.removeManifestExcept(
        input.agentId,
        input.schedules.map((schedule) => schedule.id),
        input.sourcePath,
    )

    return { created, updated, removed }
}

/**
 * Validate an API-supplied schedule and turn it into a row.
 *
 * **In core, and shared with reconciliation's parse, because a check only one writer performs is a
 * check the two writers disagree about.** The manifest path and the API path accept the same
 * expressions, refuse the same ones, and produce the same first `nextRunAt` — which they would not
 * if the endpoint did its own parsing, and the difference would surface as a schedule that loads
 * from a file and is refused through the API, or worse the other way round.
 *
 * Throws `ConfigError` with the documented codes. `schedule_missing_delivery` is the one the wire
 * spec fixes by name.
 */
export function prepareScheduleWrite(input: {
    readonly agentId: string
    readonly body: Readonly<Record<string, unknown>>
    /** Channel ids declared on this agent, for the delivery check. */
    readonly channelIds: readonly string[]
    /** Role names declared under `model:`, for the role check. */
    readonly roleNames: readonly string[]
    readonly now: number
    readonly origin: ScheduleOrigin
    /** Carried through unchanged on a patch, so an edit does not reset the sequence. */
    readonly existing?: ScheduleRecord
}): UpsertSchedule {
    const parsedBody = ScheduleSchema.safeParse(input.body)
    if (!parsedBody.success) {
        const first = parsedBody.error.issues[0]
        throw new ConfigError({
            code: "schedule_invalid",
            message: `Schedule rejected: ${first?.path.join(".") ?? "body"} ${first?.message ?? "is invalid"}.`,
            hint: "A schedule needs id, kind (cron|every|at), expr, task and deliver. See docs/02-SPEC-MANIFEST.md.",
            ...(first?.path.length === undefined || first.path.length === 0
                ? {}
                : { field: first.path.join(".") }),
        })
    }
    const declared = parsedBody.data

    if (declared.deliver !== "none") {
        if (!input.channelIds.includes(declared.deliver.channel)) {
            throw new ConfigError({
                code: "schedule_delivery_channel_unknown",
                message: `Schedule "${declared.id}" delivers to "${declared.deliver.channel}", which is not a channel id on this agent.${
                    input.channelIds.length === 0
                        ? " The agent declares no channels."
                        : ` Declared: ${input.channelIds.join(", ")}.`
                }`,
                hint: 'A delivery target names a channel\'s id, not its type. Use deliver: "none" to return results through the event stream instead.',
                field: "deliver.channel",
            })
        }
    }

    if (declared.role !== undefined && !input.roleNames.includes(declared.role)) {
        throw new ConfigError({
            code: "schedule_role_unknown",
            message: `Schedule "${declared.id}" names the model role "${declared.role}", which is not declared under model:. Declared: ${input.roleNames.join(", ")}.`,
            hint: "Add the role under model: in the manifest, or point the schedule at one of the declared roles. Omit role entirely to use main.",
            field: "role",
        })
    }

    const parsed = parseSchedule({
        id: declared.id,
        kind: declared.kind,
        expr: declared.expr,
        timezone: declared.timezone,
        now: input.now,
        field: "expr",
    })

    const nowIso = new Date(input.now).toISOString()
    const decision = decideDue(parsed, declared.id, input.now, input.now)
    const deliver = declared.deliver === "none" ? undefined : declared.deliver

    return {
        agentId: input.agentId,
        id: declared.id,
        kind: declared.kind,
        expr: declared.expr,
        ...(declared.timezone === undefined ? {} : { timezone: declared.timezone }),
        task: declared.task,
        ...(deliver === undefined
            ? {}
            : { deliverChannel: deliver.channel, deliverTo: deliver.to }),
        sessionMode: declared.session,
        ...(declared.role === undefined ? {} : { role: declared.role }),
        enabled: declared.enabled,
        origin: input.origin,
        anchorAt: decision.anchor === undefined ? nowIso : new Date(decision.anchor).toISOString(),
        nextRunAt:
            decision.runAt === undefined ? undefined : new Date(decision.runAt).toISOString(),
        // No manifest wrote this. `''` is the unknown-provenance value, and it is never consulted
        // for an API row anyway: `removeManifestExcept` is scoped to `origin = 'manifest'`.
        sourcePath: "",
        now: nowIso,
    }
}

export interface ScheduleRunnerOptions {
    readonly agents: () => readonly Agent[]
    readonly hub: ChannelHub
}

/**
 * The callback the scheduler calls when a schedule comes due.
 *
 * Supplied from here rather than built inside `Scheduler` because core's scheduler starts no turns
 * of its own — it decides *when*, and this decides *what*. That split is what lets the timer be
 * tested against a fake run function with no model, no channels and no store beyond the schedules.
 */
export function scheduleRunner(options: ScheduleRunnerOptions) {
    return async (schedule: ScheduleRecord, runId: string): Promise<void> => {
        const agent = options.agents().find((candidate) => candidate.id === schedule.agentId)
        if (agent === undefined) {
            throw new Error(
                `Schedule "${schedule.id}" belongs to agent "${schedule.agentId}", which this runtime is not hosting. ` +
                    "hint: this means the store is shared with another runtime and the due query was not scoped — see ScheduleStore.due.",
            )
        }

        const sessionKey = scheduleSessionKey(schedule.sessionMode, schedule.id, runId)
        const result = await agent.send(schedule.task, {
            sessionKey,
            source: `schedule:${schedule.id}`,
            ...(schedule.role === undefined ? {} : { role: schedule.role }),
        })

        // `deliver: "none"` is a real answer rather than a missing one: the reply reaches the event
        // stream and the store, and no channel is involved.
        if (schedule.deliverChannel === undefined || schedule.deliverTo === undefined) return
        if (result.text.trim() === "") return

        await options.hub.deliver({
            agentId: schedule.agentId,
            sessionKey,
            channelId: schedule.deliverChannel,
            recipient: schedule.deliverTo,
            text: result.text,
            turnId: result.turnId,
        })
    }
}
