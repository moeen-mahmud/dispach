/**
 * The three schedule kinds, and the two policies that decide when one runs.
 *
 * `cron` is **wall-clock-anchored** and `every` is **interval-anchored**. That is Quartz's
 * CronTrigger/SimpleTrigger split and it maps onto our kinds with nothing left over: a cron
 * expression names a time of day, so it participates in DST; an interval names a gap, so it does
 * not. `every: 24h` across a spring-forward fires 24 hours later, an hour earlier by the clock, and
 * that is correct rather than a bug to compensate for.
 *
 * **Catch-up after downtime differs by kind, and the asymmetry is deliberate.** A recurring schedule
 * that missed occurrences skips to the next one and reports how many it dropped — tomorrow's brief
 * still arrives, and firing forty at once is the stampede the policy exists to prevent. A one-shot
 * whose moment passed fires **once, late, flagged**: nobody else will ever fire it, so dropping it
 * silently is rule 8's shape. This is systemd's `Persistent=` semantics, which fires once at
 * activation if it would have fired during downtime and never replays the backlog.
 *
 * **Jitter is derived from the id, not drawn at random.** systemd's `RandomizedDelaySec=` re-rolls
 * per boot, so the same schedule lands somewhere different every restart and a drift measurement
 * cannot mean anything. Deriving it from the id makes the offset a fact about the schedule: the
 * 08:00 brief is always the 08:04:12 brief, reproducible across restarts and across machines.
 */

import { ConfigError } from "../errors.ts"
import { type CronSpec, nextCron, parseCron } from "./cron.ts"
import { type Duration, parseDuration } from "./duration.ts"
import { assertZone, hostZone } from "./zone.ts"

export type ScheduleKind = "cron" | "every" | "at"

/** Ten years. Matches `docs/02-SPEC-MANIFEST.md`, and is the bound `at` is documented to carry. */
const AT_HORIZON_MS = 10 * 365 * 86_400_000

/** No schedule is displaced by more than this, however long its interval. */
export const MAX_JITTER_MS = 15 * 60_000

/**
 * How many occurrences a catch-up will count before giving up and reporting a floor.
 *
 * A `* * * * *` down for a week has missed ten thousand fires, and the exact number is worth
 * nothing to anybody — counting it costs a `nextCron` per occurrence to produce a figure whose only
 * use is being printed. The report says "at least N" past the cap, which is true and cheap.
 */
const MISSED_CAP = 1_000

export type ParsedSchedule =
    | {
          readonly kind: "cron"
          readonly spec: CronSpec
          readonly zone: string
          readonly source: string
      }
    | {
          readonly kind: "every"
          readonly every: Duration
          readonly zone: string
          readonly source: string
      }
    | { readonly kind: "at"; readonly at: number; readonly zone: string; readonly source: string }

export interface ParseScheduleInput {
    readonly id: string
    readonly kind: ScheduleKind
    readonly expr: string
    readonly timezone?: string | undefined
    /** Injected so a test is not a function of the day it runs on. */
    readonly now: number
    readonly field: string
}

export function parseSchedule(input: ParseScheduleInput): ParsedSchedule {
    // `TZ` then UTC, per the manifest spec. Resolved here rather than at use, so every later
    // computation sees a concrete zone and a listing can show which one is in force.
    const zone = input.timezone ?? hostZone()
    assertZone(zone)

    const source = input.expr.trim()

    if (input.kind === "cron") {
        const spec = parseCron(source, input.field)
        if (nextCron(spec, input.now, zone) === undefined) {
            throw new ConfigError({
                code: "schedule_cron_unsatisfiable",
                message: `"${source}" never matches a real date.`,
                hint: "The expression parses but names a day that does not occur — 30 February, or a weekday-and-date pair that never coincide. Checked over four years, so a leap-year schedule like 0 3 29 2 * is accepted.",
                field: input.field,
            })
        }
        return { kind: "cron", spec, zone, source }
    }

    if (input.kind === "every") {
        return { kind: "every", every: parseDuration(source, input.field), zone, source }
    }

    const at = Date.parse(source)
    if (Number.isNaN(at)) {
        throw new ConfigError({
            code: "schedule_at_malformed",
            message: `"${source}" is not an ISO 8601 instant.`,
            hint: "Write a full timestamp with an offset, as in 2026-12-25T09:00:00+06:00 or 2026-12-25T03:00:00Z. A bare date has no time of day.",
            field: input.field,
        })
    }
    if (at > input.now + AT_HORIZON_MS) {
        throw new ConfigError({
            code: "schedule_at_too_far",
            message: `${source} is more than ten years away.`,
            hint: "A one-shot this far out is almost always a year typo. Ten years is the documented bound.",
            field: input.field,
        })
    }
    return { kind: "at", at, zone, source }
}

/** FNV-1a, 32-bit. Small, stable across runtimes, and not required to be anything more. */
function hash(text: string): number {
    let value = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index)
        value = Math.imul(value, 0x01000193) >>> 0
    }
    return value
}

/**
 * The fixed displacement this schedule's fires carry, in ms.
 *
 * A tenth of the interval, capped — so a 15-minute schedule moves by at most 90 seconds and a daily
 * one by at most fifteen minutes. Zero when the interval is unknown or the schedule is a one-shot: a
 * person who wrote a specific instant meant that instant.
 */
export function jitterFor(id: string, intervalMs: number | undefined): number {
    if (intervalMs === undefined || intervalMs <= 0) return 0
    const span = Math.min(Math.floor(intervalMs / 10), MAX_JITTER_MS)
    return span <= 0 ? 0 : hash(id) % span
}

/** The gap to the following occurrence, which is what jitter is scaled against. */
function intervalOf(parsed: ParsedSchedule, from: number): number | undefined {
    if (parsed.kind === "every") return parsed.every.ms
    if (parsed.kind === "at") return undefined
    const first = nextCron(parsed.spec, from, parsed.zone)
    if (first === undefined) return undefined
    const second = nextCron(parsed.spec, first, parsed.zone)
    return second === undefined ? undefined : second - first
}

export interface DueDecision {
    /** When to fire next, jitter included. `undefined` means never again — a spent one-shot. */
    readonly runAt: number | undefined
    /**
     * The same fire without jitter, and **this is what the next computation must be anchored on**.
     *
     * Feeding `runAt` back in makes the offset compound: measured before this field existed, an
     * `every: 15m` with a 79-second jitter produced 00:16:19 → 00:32:38 → 00:48:58, adding its own
     * displacement once per fire. That is precisely the cumulative drift the whole design exists to
     * prevent, reintroduced by the mechanism meant to spread load. `cron` self-corrects because the
     * next occurrence is recomputed from the expression, so only `every` could accumulate — which is
     * exactly why both kinds return this rather than only the one that needs it.
     */
    readonly anchor: number | undefined
    /** Occurrences that came due while nothing was running. Capped; see `MISSED_CAP`. */
    readonly missed: number
    /** True when `missed` hit the cap and the real figure is higher. */
    readonly missedCapped: boolean
    /** A one-shot firing after its moment. Rides onto the event so a late reply is explicable. */
    readonly late: boolean
}

/**
 * Decide the next fire, given when this schedule last ran and what time it is now.
 *
 * `from` is the last fire, or the creation time for a schedule that has never run. It is the anchor
 * for `every` and the search origin for `cron`, which is what makes an interval survive a restart
 * without drifting: the next fire is computed from the last one, never from process start.
 */
/**
 * Whether the occurrence `from` names has already been taken.
 *
 * The two callers want different answers from the same anchor, and only they know which. At
 * **dispatch** the pending occurrence is being consumed right now, so a one-shot becomes spent. At
 * **boot** the same anchor names an occurrence that has *not* run — and reading it as consumed is
 * how an overdue `at` came to be marked spent without ever firing, which is the miss the late-fire
 * policy exists to prevent. Inferring it from `from >= at` cannot tell the two apart.
 */
export interface DueOptions {
    readonly consumed?: boolean
}

export function decideDue(
    parsed: ParsedSchedule,
    id: string,
    from: number,
    now: number,
    options: DueOptions = {},
): DueDecision {
    if (parsed.kind === "at") {
        // Fires once, and only the caller knows whether that has happened.
        if (options.consumed === true) {
            return {
                runAt: undefined,
                anchor: undefined,
                missed: 0,
                missedCapped: false,
                late: false,
            }
        }
        // A one-shot carries no jitter: someone who wrote an instant meant that instant.
        if (parsed.at <= now) {
            return { runAt: now, anchor: parsed.at, missed: 0, missedCapped: false, late: true }
        }
        return { runAt: parsed.at, anchor: parsed.at, missed: 0, missedCapped: false, late: false }
    }

    const jitter = jitterFor(id, intervalOf(parsed, from))

    if (parsed.kind === "every") {
        const elapsed = now - from
        const missedExact = elapsed <= 0 ? 0 : Math.floor(elapsed / parsed.every.ms)
        const missed = Math.min(missedExact, MISSED_CAP)
        // Anchored on `from` plus whole intervals rather than on `now`, so a schedule that fires
        // slightly late does not walk its own start time forward on every run.
        const steps = missedExact + 1
        const anchor = from + steps * parsed.every.ms
        return {
            runAt: anchor + jitter,
            anchor,
            missed,
            missedCapped: missedExact > MISSED_CAP,
            late: false,
        }
    }

    let cursor = from
    let missed = 0
    let capped = false
    for (;;) {
        const occurrence = nextCron(parsed.spec, cursor, parsed.zone)
        if (occurrence === undefined) {
            return {
                runAt: undefined,
                anchor: undefined,
                missed,
                missedCapped: capped,
                late: false,
            }
        }
        if (occurrence + jitter > now) {
            return {
                runAt: occurrence + jitter,
                anchor: occurrence,
                missed,
                missedCapped: capped,
                late: false,
            }
        }
        cursor = occurrence
        missed += 1
        if (missed >= MISSED_CAP) {
            capped = true
            // Stop counting and jump to the present, so the report is bounded and the next fire is
            // still correct. The exact backlog past a thousand is not information anyone acts on.
            const resume = nextCron(parsed.spec, now, parsed.zone)
            return {
                runAt: resume === undefined ? undefined : resume + jitter,
                anchor: resume,
                missed,
                missedCapped: true,
                late: false,
            }
        }
    }
}
