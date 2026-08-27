/**
 * The parts of scheduling that are pure arithmetic over calendars: durations, zoned wall-clock
 * time, and cron.
 *
 * These tests are the deliverable rather than a check on it. A scheduler is judged almost entirely
 * on what it does at the two moments a year when local time is not a function of elapsed time, and
 * those moments cannot be reached by exercising the thing by hand — you would have to wait for
 * March. **The DST cases were written before the implementation** and the implementation was shaped
 * to pass them.
 *
 * `_harness.ts` rather than `bun:test`, so the whole file runs under `node --test` too.
 */

import { CRON_HORIZON_DAYS, cronSatisfiable, nextCron, parseCron } from "../src/schedule/cron.ts"
import { formatDuration, parseDuration } from "../src/schedule/duration.ts"
import { fieldsAt, instantFrom, offsetAt } from "../src/schedule/zone.ts"
import { describe, expect, test } from "./_harness.ts"

const at = (iso: string): number => Date.parse(iso)
const iso = (ms: number | undefined): string | undefined =>
    ms === undefined ? undefined : new Date(ms).toISOString()

function codeOf(run: () => unknown): string {
    try {
        run()
    } catch (error) {
        return (error as { code?: string }).code ?? "no-code"
    }
    return "did-not-throw"
}

describe("durations", () => {
    test("every accepted spelling round-trips to the author's own text", () => {
        // Lossless by construction, so re-writing a manifest never reports a schedule as changed
        // merely because it passed through a number. A canonicalising parser turning 120s into 2m
        // would edit somebody's file on the next config_set.
        for (const text of ["1s", "90s", "15m", "2h", "24h", "7d"]) {
            expect(formatDuration(parseDuration(text, "expr"))).toBe(text)
        }
    })

    test("the units mean what they say", () => {
        expect(parseDuration("90s", "expr").ms).toBe(90_000)
        expect(parseDuration("15m", "expr").ms).toBe(900_000)
        expect(parseDuration("2h", "expr").ms).toBe(7_200_000)
        expect(parseDuration("7d", "expr").ms).toBe(604_800_000)
    })

    test("there is no combined or fractional form, and the refusal says so", () => {
        expect(codeOf(() => parseDuration("1h30m", "expr"))).toBe("schedule_duration_malformed")
        expect(codeOf(() => parseDuration("1.5h", "expr"))).toBe("schedule_duration_malformed")
        expect(codeOf(() => parseDuration("15", "expr"))).toBe("schedule_duration_malformed")
        // The combined form is spelled as one unit instead.
        expect(parseDuration("90m", "expr").ms).toBe(5_400_000)
    })

    test("sub-second is refused as a busy loop rather than accepted as a schedule", () => {
        expect(codeOf(() => parseDuration("500ms", "expr"))).toBe("schedule_duration_malformed")
        expect(codeOf(() => parseDuration("0s", "expr"))).toBe("schedule_duration_too_small")
    })
})

describe("zoned wall-clock time", () => {
    test("offsets match both hemispheres, standard and summer", () => {
        // The pair the reference implementation used, because they move in opposite directions and a
        // northern-only table passes with the sign inverted.
        const minutes = (zone: string, when: string): number => offsetAt(zone, at(when)) / 60_000
        expect(minutes("Europe/London", "2026-01-15T12:00:00Z")).toBe(0)
        expect(minutes("Europe/London", "2026-07-15T12:00:00Z")).toBe(60)
        expect(minutes("America/Sao_Paulo", "2018-01-15T12:00:00Z")).toBe(-120)
        expect(minutes("America/Sao_Paulo", "2018-07-15T12:00:00Z")).toBe(-180)
        expect(minutes("Asia/Dhaka", "2026-08-25T12:00:00Z")).toBe(360)
    })

    test("an offset is a function of the instant, never of the zone alone", () => {
        // The defect a static offset table cannot fix, and the reason node-cron's own tz-offset
        // still cannot represent DST at all.
        const winter = offsetAt("America/New_York", at("2026-01-15T12:00:00Z"))
        const summer = offsetAt("America/New_York", at("2026-07-15T12:00:00Z"))
        expect(winter).not.toBe(summer)
    })

    test("a local time inside a spring-forward gap has no instant", () => {
        const gap = instantFrom("America/New_York", {
            year: 2026,
            month: 3,
            day: 8,
            hour: 2,
            minute: 30,
            second: 0,
        })
        expect(gap).toBe(undefined)

        // The hours on either side are ordinary.
        for (const hour of [1, 3]) {
            expect(
                instantFrom("America/New_York", {
                    year: 2026,
                    month: 3,
                    day: 8,
                    hour,
                    minute: 30,
                    second: 0,
                }),
            ).not.toBe(undefined)
        }
    })

    test("a repeated fall-back hour resolves to the earlier of the two instants", () => {
        const first = instantFrom("America/New_York", {
            year: 2026,
            month: 11,
            day: 1,
            hour: 1,
            minute: 30,
            second: 0,
        })
        expect(iso(first)).toBe("2026-11-01T05:30:00.000Z")
        // The later instant reads the same locally — which is what makes the hour ambiguous.
        expect(fieldsAt("America/New_York", (first ?? 0) + 3_600_000).hour).toBe(1)
    })

    test("instant to fields and back is exact across a whole year", () => {
        let mismatches = 0
        for (
            let t = at("2026-01-01T00:00:00Z");
            t < at("2027-01-01T00:00:00Z");
            t += 6 * 3_600_000
        ) {
            const back = instantFrom("Europe/London", fieldsAt("Europe/London", t))
            if (back !== t) mismatches += 1
        }
        expect(mismatches).toBe(0)
    })

    test("an unknown zone is refused where it was typed", () => {
        expect(codeOf(() => offsetAt("Mars/Olympus", 0))).toBe("schedule_timezone_unknown")
    })
})

describe("cron", () => {
    const next = (expr: string, from: string, zone = "UTC", count = 1): (string | undefined)[] => {
        const spec = parseCron(expr, "expr")
        const out: (string | undefined)[] = []
        let cursor = at(from)
        for (let index = 0; index < count; index += 1) {
            const found = nextCron(spec, cursor, zone)
            out.push(iso(found))
            if (found === undefined) break
            cursor = found
        }
        return out
    }

    test("the ordinary shapes", () => {
        expect(next("0 8 * * *", "2026-08-25T09:00:00Z")).toEqual(["2026-08-26T08:00:00.000Z"])
        expect(next("*/15 * * * *", "2026-08-25T09:07:00Z", "UTC", 2)).toEqual([
            "2026-08-25T09:15:00.000Z",
            "2026-08-25T09:30:00.000Z",
        ])
        expect(next("0 9 * * MON", "2026-08-25T00:00:00Z")).toEqual(["2026-08-31T09:00:00.000Z"])
        expect(next("30 5 1 JAN *", "2026-08-25T00:00:00Z")).toEqual(["2027-01-01T05:30:00.000Z"])
    })

    test("a sixth leading field is seconds", () => {
        expect(next("30 0 8 * * *", "2026-08-25T09:00:00Z")).toEqual(["2026-08-26T08:00:30.000Z"])
    })

    test("day-of-month and day-of-week are OR when both are narrowed", () => {
        // Vixie's rule, and the one people get wrong: `0 0 13 * 5` is the 13th *or* any Friday, not
        // Friday the 13th. Deriving this from set size would be wrong, since `*` over weekdays and an
        // explicit 0-6 produce the same set and mean different things.
        const days = next("0 0 13 * 5", "2026-11-01T00:00:00Z", "UTC", 5).map((value) =>
            (value ?? "").slice(0, 10),
        )
        expect(days).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"])
    })

    test("7 is Sunday, and so is 0", () => {
        expect(next("0 0 * * 7", "2026-08-25T00:00:00Z")).toEqual(
            next("0 0 * * 0", "2026-08-25T00:00:00Z"),
        )
    })

    describe("DST", () => {
        test("spring forward: the occurrence is skipped entirely, not shifted or fired late", () => {
            // Quartz's documented behaviour and the one the prior art independently agrees with. A
            // daily 02:30 simply does not happen on the transition day.
            const days = next("30 2 * * *", "2026-03-06T12:00:00Z", "America/New_York", 3).map(
                (value) => (value ?? "").slice(0, 10),
            )
            expect(days).toEqual(["2026-03-07", "2026-03-09", "2026-03-10"])
            expect(days).not.toContain("2026-03-08")
        })

        test("fall back: the repeated hour fires exactly once", () => {
            const fires = next("30 1 * * *", "2026-10-30T12:00:00Z", "America/New_York", 4)
            expect(fires).toEqual([
                "2026-10-31T05:30:00.000Z",
                "2026-11-01T05:30:00.000Z",
                "2026-11-02T06:30:00.000Z",
                "2026-11-03T06:30:00.000Z",
            ])
            // One fire on the transition day, not two.
            expect(fires.filter((value) => (value ?? "").startsWith("2026-11-01")).length).toBe(1)
        })

        test("the southern hemisphere transitions the other way and is handled the same", () => {
            // Australia springs forward in October. Same predicate, opposite direction.
            const days = next("30 2 * * *", "2026-10-02T00:00:00Z", "Australia/Sydney", 3).map(
                (value) => (value ?? "").slice(0, 10),
            )
            expect(days.length).toBe(3)
            expect(new Set(days).size).toBe(3)
        })
    })

    describe("the horizon", () => {
        test("a leap-year schedule resolves, and would not at 366 days", () => {
            // The measured defect in the closest prior art: it bounds the search at 366 days *and*
            // refuses at write time anything that does not occur within a year — so `0 3 29 2 *`,
            // which is legal and fires every leap year, is rejected outright. From March 2026 the
            // next 29 February is in 2028, two years out.
            expect(next("0 3 29 2 *", "2026-03-01T00:00:00Z", "UTC", 2)).toEqual([
                "2028-02-29T03:00:00.000Z",
                "2032-02-29T03:00:00.000Z",
            ])
            expect(CRON_HORIZON_DAYS).toBeGreaterThan(4 * 365)
        })

        test("an expression that names no real date is unsatisfiable", () => {
            expect(next("0 0 30 2 *", "2026-01-01T00:00:00Z")).toEqual([undefined])
            expect(
                cronSatisfiable(parseCron("0 0 30 2 *", "expr"), at("2026-01-01T00:00:00Z"), "UTC"),
            ).toBe(false)
            expect(
                cronSatisfiable(parseCron("0 3 29 2 *", "expr"), at("2026-03-01T00:00:00Z"), "UTC"),
            ).toBe(true)
        })
    })

    describe("refusals", () => {
        test("a macro is refused by name rather than as a syntax error", () => {
            // Common enough that somebody will write one; "not a cron expression" would send them
            // looking for a typo that is not there.
            expect(codeOf(() => parseCron("@daily", "expr"))).toBe("schedule_cron_malformed")
        })

        test("the wrong number of fields, an out-of-range value, and a backwards range", () => {
            expect(codeOf(() => parseCron("0 8 * *", "expr"))).toBe("schedule_cron_malformed")
            expect(codeOf(() => parseCron("0 99 * * *", "expr"))).toBe("schedule_cron_malformed")
            expect(codeOf(() => parseCron("0 17-9 * * *", "expr"))).toBe("schedule_cron_malformed")
            expect(codeOf(() => parseCron("0 8 * * * * *", "expr"))).toBe("schedule_cron_malformed")
        })
    })

    test("the common case stays cheap, and the pathological one stays bounded", () => {
        // Not a benchmark — a guard. The calendar descent is what keeps the leap-year lookup off the
        // 25.7 ms a flat minute-by-minute scan costs, and a regression to that would be invisible
        // except at re-arm time with many schedules.
        const leap = parseCron("0 3 29 2 *", "expr")
        const started = Date.now()
        for (let index = 0; index < 20; index += 1) {
            nextCron(leap, at("2026-03-01T00:00:00Z"), "Asia/Dhaka")
        }
        expect(Date.now() - started).toBeLessThan(2_000)
    })
})
