/**
 * Durations for the `every` kind: `90s`, `15m`, `2h`, `7d`.
 *
 * Deliberately not a general duration grammar. There is no `1h30m`, no `1.5h`, no ISO 8601 —
 * one integer and one unit, because every additional spelling is a shape the round-trip has to
 * preserve and a person has to recognise in a listing. `90m` says what `1h30m` says.
 *
 * **The parse is lossless by construction**, which matters because a manifest is re-read and
 * re-written: `format(parse(text)) === text` for anything this accepts, so reconciliation never
 * reports a schedule as changed merely because it round-tripped through a number. That property
 * is asserted rather than assumed — a canonicalising parser (`120s` → `2m`) would rewrite the
 * author's file on the next `config_set`, which is the kind of edit nobody asked for.
 */

import { ConfigError } from "../errors.ts"

const PATTERN = /^(\d+)(s|m|h|d)$/

const MS: Readonly<Record<string, number>> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
}

/**
 * One second. Below this the value is not a schedule, it is a busy loop.
 *
 * The overlap policy already bounds a fast schedule — a fire arriving while the previous run is
 * still going is deferred rather than run, so `every: 1s` degenerates to back-to-back turns rather
 * than to unbounded concurrency. This floor is only about refusing a number that cannot mean
 * anything, not about pacing.
 */
const MIN_MS = 1_000

/** Ten years, matching the bound `at` carries. Beyond this an interval is a typo. */
const MAX_MS = 10 * 365 * 86_400_000

export interface Duration {
    readonly ms: number
    /** The text exactly as written, so `format` can return it unchanged. */
    readonly source: string
}

export function parseDuration(text: string, field: string): Duration {
    const match = PATTERN.exec(text.trim())
    if (match === null) {
        throw new ConfigError({
            code: "schedule_duration_malformed",
            message: `"${text}" is not a duration.`,
            hint: "A duration is a whole number and one unit: 90s, 15m, 2h, 7d. There is no combined form — write 90m rather than 1h30m.",
            field,
        })
    }

    const value = Number(match[1])
    const unit = match[2] ?? ""
    const ms = value * (MS[unit] ?? 0)

    if (ms < MIN_MS) {
        throw new ConfigError({
            code: "schedule_duration_too_small",
            message: `"${text}" is under the one-second minimum.`,
            hint: "An interval below a second is a busy loop rather than a schedule. If the intent is to run continuously, a schedule is the wrong mechanism.",
            field,
        })
    }
    if (ms > MAX_MS) {
        throw new ConfigError({
            code: "schedule_duration_too_large",
            message: `"${text}" is over the ten-year maximum.`,
            hint: "An interval this long is almost always a unit typo — check whether d was meant where h was written.",
            field,
        })
    }

    return { ms, source: text.trim() }
}

/** The text the duration was written as. Never a re-derived spelling — see the file comment. */
export function formatDuration(duration: Duration): string {
    return duration.source
}
