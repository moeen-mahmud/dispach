/**
 * One timer, every agent, clamped to a horizon.
 *
 * **The clamp is not an optimization — it is the only thing standing between an `at` schedule and a
 * silent misfire.** `setTimeout` coerces its delay to a signed 32-bit integer: measured on this
 * project's own runtimes, a delay past 2^31-1 ms (24.86 days) is set to **1** and fires immediately,
 * bun after 7 ms and node after 3 ms, with a `TimeoutOverflowWarning` on stderr as the only signal.
 * The manifest permits `at` ten years out. So a timer armed at the raw distance to a 2030 reminder
 * delivers it at boot, marks the one-shot spent, and reports success.
 *
 * **A timer firing means "re-read the clock", never "something is due".** Timers are scheduled
 * against libuv's monotonic clock, so an NTP step or a manual clock change does not move an armed
 * timer — a +2 h correction leaves it two hours late in wall-clock terms with nothing reporting it.
 * Due-ness is therefore recomputed from `Date.now()` on every wake, and the timer is only ever a
 * prompt to look. The same property makes suspend survivable: a machine asleep for six hours wakes to
 * a timer at most one horizon stale rather than six hours stale.
 *
 * **The timer is deliberately not `unref`'d.** An unref'd timer lets the process exit while schedules
 * are pending, which for a runtime whose only job might be running schedules is the whole feature
 * silently not happening. `stop()` clears it, so shutdown does not depend on the timer being weak.
 *
 * The overlap policy is **defer to a turn boundary**: a fire arriving while the previous run of the
 * same schedule is still going is held, at most one deep, and further fires collapse into that one.
 * A schedule whose task reliably outruns its interval therefore degrades to "always slightly behind"
 * rather than to a growing backlog or to unbounded concurrent model calls.
 */

import type { EventBus } from "../events/bus.ts"
import { newRunId } from "../loop/ids.ts"
import type { ScheduleRecord, ScheduleStore } from "../store/store.ts"
import { decideDue, parseSchedule } from "./kinds.ts"

/** Never sleep longer than this, whatever the next due time says. See the file comment. */
export const SCHEDULER_HORIZON_MS = 30_000

export interface SchedulerOptions {
    readonly store: ScheduleStore
    readonly bus: EventBus
    /** The agents this runtime hosts. Read per wake, because an agent can be added after start. */
    readonly agentIds: () => readonly string[]
    /** Runs one schedule to completion. Supplied by the runtime; core starts no turns of its own. */
    readonly run: (schedule: ScheduleRecord, runId: string) => Promise<void>
    /** Injected so a test is not a function of the wall clock. */
    readonly now?: () => number
    readonly horizonMs?: number
    /**
     * Arms one timer and returns its canceller.
     *
     * Injected alongside `now` because injecting only the clock is not enough to test this: the
     * delay is computed from the fake clock and then handed to a real `setTimeout`, so a test that
     * advances the clock still waits out the real delay. Both or neither.
     */
    readonly setTimer?: (fire: () => void, ms: number) => () => void
    /** How long `stop` waits for in-flight runs. Injected for the same reason the clock is. */
    readonly stopGraceMs?: number
}

interface InFlight {
    /** A fire arrived while this run was going. At most one is remembered. */
    deferred: boolean
    /** Settles when the run and its bookkeeping write are both done. Awaited by `stop`. */
    readonly done: Promise<void>
}

/**
 * How long `stop` waits for runs already in flight.
 *
 * Not unbounded: every supervisor SIGKILLs eventually — launchd after `ExitTimeOut`, a container
 * after its grace period — so a wait that does not fit inside that window is a wait that does not
 * happen, and the process is killed mid-write anyway. Not zero either, which is what it was: the
 * benchmark closed the store under a run that was still recording its result and got `Database has
 * closed` out of `markFired`. That is a torn write on the one row that says whether the run
 * happened, and on a real shutdown it would be silent.
 */
const STOP_GRACE_MS = 5_000

export class Scheduler {
    readonly #store: ScheduleStore
    readonly #bus: EventBus
    readonly #agentIds: () => readonly string[]
    readonly #run: (schedule: ScheduleRecord, runId: string) => Promise<void>
    readonly #now: () => number
    readonly #horizonMs: number
    readonly #setTimer: (fire: () => void, ms: number) => () => void
    readonly #stopGraceMs: number

    /** Keyed by agent and schedule id, both slugs, so `/` cannot occur inside either half. */
    readonly #inFlight = new Map<string, InFlight>()
    #cancelTimer: (() => void) | undefined
    #started = false
    #stopped = false

    constructor(options: SchedulerOptions) {
        this.#store = options.store
        this.#bus = options.bus
        this.#agentIds = options.agentIds
        this.#run = options.run
        this.#now = options.now ?? (() => Date.now())
        this.#horizonMs = options.horizonMs ?? SCHEDULER_HORIZON_MS
        this.#stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
        this.#setTimer =
            options.setTimer ??
            ((fire, ms) => {
                // Deliberately not `unref`'d — see the file comment. A runtime whose only job is
                // running schedules must not exit while one is pending.
                const handle = setTimeout(fire, ms)
                return () => clearTimeout(handle)
            })
    }

    get started(): boolean {
        return this.#started
    }

    /**
     * Recompute every schedule against the current clock, then arm.
     *
     * This is where downtime is accounted for. A recurring schedule that missed occurrences advances
     * to the next one and says how many it dropped; a one-shot whose moment passed is left due, so
     * the first wake fires it late and flagged. Nothing fires *inside* `start` — the acceptance
     * criterion is that an idle agent with schedules makes zero model calls until one comes due, and
     * a catch-up that ran here would break it on every boot.
     */
    async start(): Promise<void> {
        if (this.#started || this.#stopped) return
        this.#started = true
        await this.#recompute()
        this.#arm()
    }

    /**
     * Stop arming, and let anything already running finish writing.
     *
     * The wait is what stops a torn write. `#record` runs *after* the turn, so a stop that returned
     * immediately let the caller close the store while the row saying whether the run happened was
     * still being written.
     */
    async stop(): Promise<void> {
        if (this.#stopped) return
        this.#stopped = true
        this.#cancelTimer?.()
        this.#cancelTimer = undefined

        const running = [...this.#inFlight.values()].map((entry) => entry.done)
        if (running.length === 0) return
        await Promise.race([
            Promise.allSettled(running),
            new Promise((resolve) => setTimeout(resolve, this.#stopGraceMs)),
        ])
    }

    /** Re-arm after a write. Cheap, and the alternative is a schedule waiting a whole horizon. */
    changed(): void {
        if (!this.#started || this.#stopped) return
        this.#arm()
    }

    async #recompute(): Promise<void> {
        const now = this.#now()
        for (const agentId of this.#agentIds()) {
            for (const schedule of await this.#store.list(agentId)) {
                // **A pending occurrence is left alone.** `anchorAt` is the boundary the stored
                // `nextRunAt` belongs to — the one that has *not* happened yet — so recomputing from
                // it asks for the occurrence *after* the pending one and skips it. Measured live
                // across two starts: a daily brief went from "in 4h" to "in 28h" and a leap-year
                // schedule from 2028 to 2032, one occurrence lost per restart. It only appears
                // across two process lifetimes with something pending in between, which is why every
                // test and the first live run looked right.
                //
                // A spent one-shot has no `nextRunAt` and nothing to recompute either.
                if (schedule.nextRunAt === undefined) continue
                if (Date.parse(schedule.nextRunAt) > now) continue

                // Past its time with nothing running: the occurrence `anchorAt` names was itself
                // missed, which is why the reported count is one more than the occurrences
                // `decideDue` finds between it and now.
                const decision = this.#decide(schedule, now)
                if (decision === undefined) continue
                const missed = decision.missed + 1

                // **Disabled rows are recomputed too, and only the reporting is skipped.** Left
                // alone, a disabled schedule keeps whatever due time it had when it was switched
                // off — measured live: a disabled `every 15m` sat with a due time six seconds in
                // the past, so enabling it would have fired it immediately instead of at its next
                // occurrence. Its occurrences were not *missed*, though: it was off, which is the
                // configuration working, so no skip is reported for one.
                if (schedule.enabled) {
                    this.#bus.emit(
                        "schedule.skipped",
                        {
                            scheduleId: schedule.id,
                            kind: schedule.kind,
                            reason: "downtime",
                            missed,
                            missedAtLeast: decision.missedCapped,
                        },
                        { agentId },
                    )
                }

                await this.#store.reschedule(agentId, schedule.id, {
                    anchorAt:
                        decision.anchor === undefined
                            ? schedule.anchorAt
                            : new Date(decision.anchor).toISOString(),
                    nextRunAt:
                        decision.runAt === undefined
                            ? undefined
                            : new Date(decision.runAt).toISOString(),
                    now: new Date(now).toISOString(),
                })
            }
        }
    }

    #decide(
        schedule: ScheduleRecord,
        now: number,
        options: { readonly consumed?: boolean } = {},
    ): ReturnType<typeof decideDue> | undefined {
        try {
            const parsed = parseSchedule({
                id: schedule.id,
                kind: schedule.kind,
                expr: schedule.expr,
                timezone: schedule.timezone,
                now,
                field: `schedules.${schedule.id}.expr`,
            })
            return decideDue(parsed, schedule.id, Date.parse(schedule.anchorAt), now, options)
        } catch (cause) {
            // A stored expression that no longer parses is a real possibility — a manifest edited by
            // hand, or a row written by an older build. Reported and disabled in effect, never thrown:
            // one bad schedule must not stop the timer for every other one.
            this.#bus.emit(
                "schedule.error",
                {
                    scheduleId: schedule.id,
                    code: "schedule_unreadable",
                    message: cause instanceof Error ? cause.message : String(cause),
                    hint: `Fix or remove the schedule "${schedule.id}". It is being skipped, and the rest of this agent's schedules are unaffected.`,
                },
                { agentId: schedule.agentId },
            )
            return undefined
        }
    }

    #arm(): void {
        if (this.#stopped) return
        this.#cancelTimer?.()
        this.#cancelTimer = undefined

        void this.#store.nextDue(this.#agentIds()).then((soonest) => {
            if (this.#stopped) return
            const now = this.#now()
            const until = soonest === undefined ? this.#horizonMs : Date.parse(soonest) - now
            // Both bounds matter. The floor keeps an overdue row from arming a negative delay, which
            // setTimeout treats as 1 ms and would spin; the ceiling is the clamp this file exists for.
            const delay = Math.max(0, Math.min(until, this.#horizonMs))
            this.#cancelTimer = this.#setTimer(() => {
                void this.#wake()
            }, delay)
        })
    }

    async #wake(): Promise<void> {
        if (this.#stopped) return
        const now = this.#now()
        const due = await this.#store.due(this.#agentIds(), new Date(now).toISOString())

        for (const schedule of due) {
            const key = `${schedule.agentId}/${schedule.id}`
            const running = this.#inFlight.get(key)

            if (running !== undefined) {
                // Held rather than dropped, and at most one deep — a third fire while one is already
                // waiting collapses into it rather than queueing.
                if (!running.deferred) {
                    running.deferred = true
                    this.#bus.emit(
                        "schedule.deferred",
                        { scheduleId: schedule.id, kind: schedule.kind },
                        { agentId: schedule.agentId },
                    )
                }
                // Still move the row forward, or this wake and every wake after it re-read the same
                // overdue schedule and the timer spins at the floor delay. Through `reschedule`
                // rather than `markFired`: a deferral is not a run, and counting it as one would
                // inflate `runs` and stamp `lastStatus` on a schedule that is running right now.
                await this.#moveOn(schedule, now)
                continue
            }

            // **Advanced before the run starts, not after it finishes.** A turn takes seconds or
            // minutes, and until the row moves it is still due — so `#arm` re-reads a due time in
            // the past, arms a zero delay, wakes immediately, finds the same row, and defers it.
            // The deferral then fires it a second time when the run completes. Measured live: one
            // `at` schedule ran twice, 852 ms apart, in one process, with every individual piece
            // behaving exactly as designed. The in-flight set prevents *concurrency*; only this
            // stops the row being **due**, and the two are not the same question.
            await this.#moveOn(schedule, now)
            this.#track(key, schedule, now)
        }

        this.#arm()
    }

    async #fire(schedule: ScheduleRecord, dueAt: number, key: string): Promise<void> {
        const started = this.#now()
        // Minted here rather than inside the runner because this is what owns a run's lifetime: the
        // id has to reach `markFired`, so that a delivery failure arriving minutes later can be
        // matched to the run it belongs to instead of to whichever run is current when it lands.
        const runId = newRunId(started)
        this.#bus.emit(
            "schedule.fired",
            {
                scheduleId: schedule.id,
                kind: schedule.kind,
                // Against the row's own due time, so this reports the scheduler's lateness and not
                // the jitter, which is a deliberate displacement rather than drift.
                driftMs: started - Date.parse(schedule.nextRunAt ?? new Date(dueAt).toISOString()),
                late: schedule.kind === "at" && Date.parse(schedule.anchorAt) < started,
            },
            { agentId: schedule.agentId },
        )

        let status: "ok" | "error" = "ok"
        let error: string | undefined
        try {
            await this.#run(schedule, runId)
        } catch (cause) {
            status = "error"
            error = cause instanceof Error ? cause.message : String(cause)
            this.#bus.emit(
                "schedule.error",
                {
                    scheduleId: schedule.id,
                    code: "schedule_run_failed",
                    message: error,
                    hint: "The schedule itself is unaffected and will run again at its next occurrence. The failure is in the turn it started.",
                },
                { agentId: schedule.agentId },
            )
        }

        await this.#record(schedule.agentId, schedule.id, this.#now(), status, error, runId)

        const entry = this.#inFlight.get(key)
        this.#inFlight.delete(key)

        // The deferred fire, taken at the turn boundary this policy is named for.
        if (entry?.deferred === true && !this.#stopped) {
            const fresh = await this.#store.get(schedule.agentId, schedule.id)
            if (fresh?.enabled === true) this.#track(key, fresh, this.#now())
        }
    }

    /** Start a run and record its completion promise, so `stop` can wait for it. */
    #track(key: string, schedule: ScheduleRecord, dueAt: number): void {
        let settle: () => void = () => {}
        const done = new Promise<void>((resolve) => {
            settle = resolve
        })
        this.#inFlight.set(key, { deferred: false, done })
        void this.#fire(schedule, dueAt, key).finally(settle)
    }

    /** Move the due time on, without recording a run. The pending occurrence is being taken. */
    async #moveOn(schedule: ScheduleRecord, now: number): Promise<void> {
        const decision = this.#decide(schedule, now, { consumed: true })
        await this.#store.reschedule(schedule.agentId, schedule.id, {
            anchorAt:
                decision?.anchor === undefined
                    ? schedule.anchorAt
                    : new Date(decision.anchor).toISOString(),
            nextRunAt:
                decision?.runAt === undefined ? undefined : new Date(decision.runAt).toISOString(),
            now: new Date(now).toISOString(),
        })
    }

    /**
     * Record the outcome of a finished run. **Does not recompute the due time.**
     *
     * The schedule was already advanced at dispatch, so re-deriving here would answer the same
     * question twice — and the second answer would be computed from a different `now`, which for a
     * long turn is a different occurrence. It re-reads the row rather than using the record captured
     * when the run started, because a wake during the turn may have moved it again, and writing back
     * a twenty-minute-old anchor would undo that.
     */
    async #record(
        agentId: string,
        id: string,
        now: number,
        status: "ok" | "error",
        error: string | undefined,
        runId: string,
    ): Promise<void> {
        const schedule = await this.#store.get(agentId, id)
        if (schedule === undefined) return

        await this.#store.markFired(agentId, id, {
            firedAt: new Date(now).toISOString(),
            anchorAt: schedule.anchorAt,
            nextRunAt: schedule.nextRunAt,
            status,
            ...(error === undefined ? {} : { error }),
            runId,
        })
    }
}
