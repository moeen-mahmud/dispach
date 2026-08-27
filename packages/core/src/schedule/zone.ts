/**
 * IANA-zoned wall-clock time, with no dependency beyond `Intl`.
 *
 * A cron expression is written in wall-clock terms — "08:00 in Asia/Dhaka" — and a timer fires on
 * an instant. Converting between the two is the whole difficulty, and it is not symmetric: an
 * instant always has exactly one local time, while a local time may have **none** (the hour a
 * spring-forward skips) or **two** (the hour a fall-back repeats).
 *
 * The technique is the one the reference implementations converged on: a **cached**
 * `Intl.DateTimeFormat` for the zone, read through `formatToParts`, with the offset computed by
 * differencing the reconstructed local fields against the instant they came from. An offset is a
 * function of *(zone, instant)* — never of the zone alone, which is the defect a static offset table
 * cannot fix and why node-cron's own `tz-offset` still cannot represent DST at all.
 *
 * **The DST behaviour is a consequence of scanning in local fields, not a special case.** The cron
 * search walks local wall-clock minutes forward and asks this module for the instant of each
 * candidate. A candidate inside a spring-forward gap has no instant, so it is skipped — which is
 * Quartz's documented behaviour, a daily 02:15 simply not firing on that day. A repeated local hour
 * is visited once by a forward walk over local fields, so it fires once. Neither needed code.
 *
 * `hourCycle: "h23"` is not decoration: `hour12: false` reports midnight as hour **24** on some
 * engines, which silently becomes the next day when reconstructed.
 */

import { ConfigError } from "../errors.ts"

/** Local wall-clock fields. `month` is 1-12 and `weekday` is 0-6 with Sunday at 0, as cron writes them. */
export interface ZonedFields {
    readonly year: number
    readonly month: number
    readonly day: number
    readonly hour: number
    readonly minute: number
    readonly second: number
    readonly weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
    const cached = formatters.get(zone)
    if (cached !== undefined) return cached

    let made: Intl.DateTimeFormat
    try {
        made = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        })
    } catch (cause) {
        throw new ConfigError({
            code: "schedule_timezone_unknown",
            message: `"${zone}" is not a timezone this runtime recognises.`,
            hint: "Use an IANA name such as Asia/Dhaka, Europe/London or America/Sao_Paulo — not an abbreviation like BST and not a UTC offset. Omit the field to use the TZ environment variable, then UTC.",
            field: "timezone",
            cause,
        })
    }

    formatters.set(zone, made)
    return made
}

/** Validate a zone name at write time, so a typo fails where it was typed. */
export function assertZone(zone: string): void {
    formatterFor(zone)
}

function partsOf(zone: string, instant: number): ZonedFields {
    const parts = formatterFor(zone).formatToParts(new Date(instant))
    const read = (type: string): number => {
        const found = parts.find((part) => part.type === type)
        return found === undefined ? 0 : Number(found.value)
    }

    const year = read("year")
    const month = read("month")
    const day = read("day")
    return {
        year,
        month,
        day,
        hour: read("hour"),
        minute: read("minute"),
        second: read("second"),
        // Derived rather than formatted: a `weekday` part is a localised string, so reading it means
        // parsing "Tue" against a locale. The date is already in hand and `Date.UTC` is exact.
        weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    }
}

/** The local wall-clock fields a zone shows at an instant. Always exactly one answer. */
export function fieldsAt(zone: string, instant: number): ZonedFields {
    return partsOf(zone, instant)
}

/**
 * The zone's UTC offset in milliseconds at an instant — positive east of Greenwich.
 *
 * Computed at **second** granularity because a zone offset has never had sub-second precision, and
 * because the reconstruction discards milliseconds: keeping them would make the difference carry the
 * instant's own millisecond remainder and turn a constant offset into a jittering one.
 */
export function offsetAt(zone: string, instant: number): number {
    const f = partsOf(zone, instant)
    const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second)
    return asIfUtc - (instant - (instant % 1_000))
}

/**
 * The instant at which a zone's wall clock reads these fields, or `undefined` when it never does.
 *
 * Two passes, then a verification. The first pass guesses the offset by treating the fields as UTC;
 * the second re-reads the offset at that candidate, which is what makes a transition converge. The
 * **verification is not optional** — it is the only thing that distinguishes "this local time exists"
 * from "this local time is inside a gap", and without it a 02:30 that never happened silently
 * resolves to 01:30 or 03:30 and the schedule fires at the wrong time rather than not at all.
 *
 * On a fall-back, two instants satisfy the fields; this returns the earlier. A forward walk over
 * local fields visits such a time once, so the schedule fires once, which is the documented
 * behaviour everywhere it is documented.
 */
export function instantFrom(
    zone: string,
    fields: Omit<ZonedFields, "weekday">,
): number | undefined {
    const asIfUtc = Date.UTC(
        fields.year,
        fields.month - 1,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
    )

    let candidate = asIfUtc - offsetAt(zone, asIfUtc)
    candidate = asIfUtc - offsetAt(zone, candidate)

    const back = partsOf(zone, candidate)
    const matches =
        back.year === fields.year &&
        back.month === fields.month &&
        back.day === fields.day &&
        back.hour === fields.hour &&
        back.minute === fields.minute &&
        back.second === fields.second

    if (!matches) return undefined

    // A fall-back leaves an earlier instant with the same local reading. One hour is the largest
    // transition any current zone applies, and stepping back only counts when it reads identically.
    const earlier = candidate - 3_600_000
    const earlierParts = partsOf(zone, earlier)
    const sameReading =
        earlierParts.year === fields.year &&
        earlierParts.month === fields.month &&
        earlierParts.day === fields.day &&
        earlierParts.hour === fields.hour &&
        earlierParts.minute === fields.minute &&
        earlierParts.second === fields.second

    return sameReading ? earlier : candidate
}

/** The host's own zone, for a schedule that declares none. */
export function hostZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}
