/**
 * A 5- or 6-field cron expression, and the next instant it names.
 *
 * **The search walks local calendar fields, never instants.** That is what makes both DST cases
 * fall out rather than needing code: a candidate inside a spring-forward gap has no instant, so it
 * is skipped — Quartz's documented behaviour of a daily 02:15 simply not firing that day — and a
 * repeated fall-back hour is visited once by a forward walk, so it fires once. See `zone.ts`.
 *
 * **The walk descends by calendar unit rather than counting minutes.** A flat minute counter is the
 * obvious implementation and is what the closest prior art does; measured here, it costs 0.003 ms on
 * a common expression and **25.7 ms** on `0 3 29 2 *`, because it visits every minute of two years
 * to find a leap day. Skipping a whole non-matching month or day turns that into roughly a thousand
 * iterations, and it is not more code — it is the same predicates applied at the level they belong to.
 *
 * **The horizon is 1462 days (4 years + 1), and 366 is a defect.** The prior art bounds its search at
 * a year and additionally refuses, at write time, any expression whose next occurrence is further out
 * — so `0 3 29 2 *` is rejected as unsatisfiable. It is not: from March 2026 the next 29 February is
 * in **2028**. Any horizon under four years silently turns a legal leap-year schedule into an error.
 */

import { ConfigError } from "../errors.ts"
import { fieldsAt, instantFrom } from "./zone.ts"

/** Four years and a day — the longest gap between two 29 Februaries, plus slack. */
export const CRON_HORIZON_DAYS = 1462

const MONTH_NAMES = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

export interface CronSpec {
    readonly seconds: ReadonlySet<number>
    readonly minutes: ReadonlySet<number>
    readonly hours: ReadonlySet<number>
    readonly daysOfMonth: ReadonlySet<number>
    /** 1-12. */
    readonly months: ReadonlySet<number>
    /** 0-6, Sunday at 0. A written 7 is folded to 0. */
    readonly daysOfWeek: ReadonlySet<number>
    /**
     * Whether each day field was narrowed from `*`.
     *
     * Both flags are needed because vixie's day semantics are an **OR** when both fields are
     * restricted and an AND-with-everything otherwise: `0 0 13 * 5` is the 13th *or* any Friday, not
     * Friday the 13th. Deriving this from set size would be wrong — `*` over days of the week and an
     * explicit `0-6` produce the same set and mean different things.
     */
    readonly domRestricted: boolean
    readonly dowRestricted: boolean
    /** Exactly as written, so a round-trip through the store returns the author's text. */
    readonly source: string
}

interface FieldRange {
    readonly min: number
    readonly max: number
    readonly names?: readonly string[]
    readonly label: string
}

const FIELDS: Readonly<Record<string, FieldRange>> = {
    second: { min: 0, max: 59, label: "second" },
    minute: { min: 0, max: 59, label: "minute" },
    hour: { min: 0, max: 23, label: "hour" },
    dayOfMonth: { min: 1, max: 31, label: "day of month" },
    month: { min: 1, max: 12, names: MONTH_NAMES, label: "month" },
    dayOfWeek: { min: 0, max: 7, names: DAY_NAMES, label: "day of week" },
}

function fail(expr: string, detail: string, hint: string, field: string): never {
    throw new ConfigError({
        code: "schedule_cron_malformed",
        message: `"${expr}" is not a valid cron expression: ${detail}`,
        hint,
        field,
    })
}

function fieldValue(token: string, range: FieldRange, expr: string, field: string): number {
    const named = range.names?.indexOf(token.toLowerCase())
    if (named !== undefined && named !== -1) return named + (range.names === MONTH_NAMES ? 1 : 0)

    if (!/^\d+$/.test(token)) {
        fail(
            expr,
            `"${token}" is not a ${range.label}.`,
            range.names === undefined
                ? `The ${range.label} field takes numbers ${range.min}-${range.max}, ranges, steps and comma lists.`
                : `The ${range.label} field takes ${range.min}-${range.max} or a name (${range.names.slice(0, 3).join(", ")}…).`,
            field,
        )
    }

    const value = Number(token)
    if (value < range.min || value > range.max) {
        fail(
            expr,
            `${value} is outside the ${range.label} range ${range.min}-${range.max}.`,
            `Check the field order: ${range.label === "second" ? "second minute hour day-of-month month day-of-week" : "minute hour day-of-month month day-of-week"}.`,
            field,
        )
    }
    return value
}

function parseField(
    text: string,
    range: FieldRange,
    expr: string,
    field: string,
): { values: Set<number>; restricted: boolean } {
    const values = new Set<number>()
    let restricted = true

    for (const part of text.split(",")) {
        const token = part.trim()
        if (token === "")
            fail(expr, "an empty entry in a comma list.", "Remove the stray comma.", field)

        const [spec = "", stepText] = token.split("/", 2)
        const step = stepText === undefined ? 1 : Number(stepText)
        if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) {
            fail(
                expr,
                `"${stepText}" is not a step.`,
                "A step is a whole number above zero, as in */15.",
                field,
            )
        }

        let from: number
        let to: number
        if (spec === "*") {
            from = range.min
            to = range.max
            if (step === 1) restricted = false
        } else if (spec.includes("-")) {
            const [lo = "", hi = ""] = spec.split("-", 2)
            from = fieldValue(lo, range, expr, field)
            to = fieldValue(hi, range, expr, field)
            if (from > to) {
                fail(
                    expr,
                    `the range ${spec} runs backwards.`,
                    "Write the lower bound first, or use a comma list to wrap around.",
                    field,
                )
            }
        } else {
            from = fieldValue(spec, range, expr, field)
            to = stepText === undefined ? from : range.max
        }

        for (let value = from; value <= to; value += step) values.add(value)
    }

    if (values.size === 0)
        fail(expr, "it matches nothing.", "Every field must admit at least one value.", field)
    return { values, restricted }
}

/**
 * Parse, and refuse anything this runtime cannot execute.
 *
 * `@daily` and friends are refused **by name** rather than falling through to a generic syntax
 * error: they are common enough that someone will write one, and "not a cron expression" would send
 * them looking for a typo that is not there.
 */
export function parseCron(expr: string, field: string): CronSpec {
    const source = expr.trim()
    if (source.startsWith("@")) {
        fail(
            source,
            "macros are not supported.",
            'Write the fields out — @daily is "0 0 * * *", @hourly is "0 * * * *", @weekly is "0 0 * * 0". For a plain interval use kind: every with an expression like 24h.',
            field,
        )
    }

    const parts = source.split(/\s+/).filter((part) => part !== "")
    if (parts.length !== 5 && parts.length !== 6) {
        fail(
            source,
            `it has ${parts.length} field${parts.length === 1 ? "" : "s"}, not 5 or 6.`,
            "Five fields are minute hour day-of-month month day-of-week. A sixth leading field is seconds.",
            field,
        )
    }

    const withSeconds = parts.length === 6
    const [sec, min, hour, dom, mon, dow] = withSeconds
        ? parts
        : (["0", ...parts] as readonly string[])

    const seconds = parseField(sec ?? "0", FIELDS.second as FieldRange, source, field)
    const minutes = parseField(min ?? "", FIELDS.minute as FieldRange, source, field)
    const hours = parseField(hour ?? "", FIELDS.hour as FieldRange, source, field)
    const daysOfMonth = parseField(dom ?? "", FIELDS.dayOfMonth as FieldRange, source, field)
    const months = parseField(mon ?? "", FIELDS.month as FieldRange, source, field)
    const daysOfWeek = parseField(dow ?? "", FIELDS.dayOfWeek as FieldRange, source, field)

    // 7 is Sunday in vixie cron, and so is 0. Folded here so every later comparison sees one value.
    const folded = new Set<number>()
    for (const day of daysOfWeek.values) folded.add(day === 7 ? 0 : day)

    return {
        seconds: seconds.values,
        minutes: minutes.values,
        hours: hours.values,
        daysOfMonth: daysOfMonth.values,
        months: months.values,
        daysOfWeek: folded,
        domRestricted: daysOfMonth.restricted,
        dowRestricted: daysOfWeek.restricted,
        source,
    }
}

/** Vixie's day rule: OR when both day fields are narrowed, plain AND otherwise. */
function dayMatches(spec: CronSpec, day: number, weekday: number): boolean {
    const byDate = spec.daysOfMonth.has(day)
    const byWeek = spec.daysOfWeek.has(weekday)
    if (spec.domRestricted && spec.dowRestricted) return byDate || byWeek
    if (spec.domRestricted) return byDate
    if (spec.dowRestricted) return byWeek
    return true
}

/** Civil-calendar arithmetic. Never millisecond addition — a DST day is not 24 hours long. */
function addDays(
    year: number,
    month: number,
    day: number,
    count: number,
): [number, number, number] {
    const moved = new Date(Date.UTC(year, month - 1, day + count))
    return [moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate()]
}

function weekdayOf(year: number, month: number, day: number): number {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * The first instant strictly after `after` at which the expression matches, in `zone`.
 *
 * `undefined` means no match within the horizon — which for a well-formed expression means it is
 * unsatisfiable (`0 0 30 2 *`), and is the answer the write-time check reads.
 */
export function nextCron(spec: CronSpec, after: number, zone: string): number | undefined {
    // Start from the second after `after`, in local terms, so a schedule cannot re-match the instant
    // it just fired at.
    const start = fieldsAt(zone, after + 1_000)
    const deadline = new Date(Date.UTC(start.year, start.month - 1, start.day + CRON_HORIZON_DAYS))

    let [year, month, day] = [start.year, start.month, start.day]
    let first = true

    while (Date.UTC(year, month - 1, day) <= deadline.getTime()) {
        if (!spec.months.has(month)) {
            // Skip the rest of the month in one step rather than a day at a time.
            ;[year, month, day] = month === 12 ? [year + 1, 1, 1] : [year, month + 1, 1]
            first = false
            continue
        }
        if (!dayMatches(spec, day, weekdayOf(year, month, day))) {
            ;[year, month, day] = addDays(year, month, day, 1)
            first = false
            continue
        }

        for (const hour of [...spec.hours].sort((a, b) => a - b)) {
            if (first && hour < start.hour) continue
            for (const minute of [...spec.minutes].sort((a, b) => a - b)) {
                if (first && hour === start.hour && minute < start.minute) continue
                for (const second of [...spec.seconds].sort((a, b) => a - b)) {
                    if (
                        first &&
                        hour === start.hour &&
                        minute === start.minute &&
                        second < start.second
                    ) {
                        continue
                    }
                    const instant = instantFrom(zone, { year, month, day, hour, minute, second })
                    // `undefined` is a spring-forward gap. Skipping it *is* the DST policy.
                    if (instant !== undefined) return instant
                }
            }
        }

        ;[year, month, day] = addDays(year, month, day, 1)
        first = false
    }

    return undefined
}

/**
 * Whether the expression ever matches. Called at write time, so an impossible date is refused where
 * it was typed rather than by a schedule that silently never fires.
 */
export function cronSatisfiable(spec: CronSpec, from: number, zone: string): boolean {
    return nextCron(spec, from, zone) !== undefined
}
