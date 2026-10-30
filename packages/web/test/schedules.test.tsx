import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { relative, SchedulesPanel, whenSentence } from "../src/schedules.tsx"

describe("schedule sentences", () => {
    test("when", () => {
        expect(whenSentence({ kind: "every", expr: "15m" })).toBe("every 15m")
        expect(whenSentence({ kind: "cron", expr: "0 8 * * *", timezone: "Asia/Dhaka" })).toBe(
            "cron 0 8 * * * (Asia/Dhaka)",
        )
        expect(whenSentence({ kind: "at", expr: "2030-01-01T00:00:00Z" })).toBe(
            "once at 2030-01-01T00:00:00Z",
        )
    })

    test("relative distance from an injected clock, both directions", () => {
        const now = Date.parse("2026-01-01T00:00:00Z")
        expect(relative("2026-01-01T00:00:20Z", now)).toBe("now")
        expect(relative("2026-01-01T00:12:00Z", now)).toBe("in 12 min")
        expect(relative("2026-01-01T03:12:00Z", now)).toBe("in 3 h 12 min")
        expect(relative("2026-01-04T00:00:00Z", now)).toBe("in 3 d")
        expect(relative("2025-12-31T23:50:00Z", now)).toBe("10 min ago")
        expect(relative("not a date", now)).toBe("not a date")
    })
})

describe("the schedules panel", () => {
    test("a row shows role, tools and limits, and a manifest row offers run but not delete", () => {
        const html = renderToStaticMarkup(
            createElement(SchedulesPanel, {
                now: 0,
                schedules: [
                    {
                        id: "digest",
                        kind: "cron",
                        expr: "0 9 * * 1-5",
                        task: "Digest the week",
                        enabled: true,
                        origin: "manifest",
                        role: "fast",
                        toolsAllow: ["now", "web_search"],
                        maxSteps: 12,
                        timeoutMs: 90_000,
                        deliverChannel: "tg",
                        deliverTo: "1195568132",
                    },
                ],
                onRun: () => undefined,
                onDelete: () => undefined,
                onToggle: () => undefined,
            }),
        )
        expect(html).toContain(">fast<")
        expect(html).toContain("now, web_search")
        expect(html).toContain("12 steps · 90 s")
        expect(html).toContain("tg → 1195568132")
        expect(html).toContain(">run now<")
        expect(html).not.toContain(">delete<")
        expect(html).toContain("agent.yaml")
    })

    test("the last run is on the card, and a failed one says why", () => {
        const row = (extra: Record<string, unknown>) =>
            renderToStaticMarkup(
                createElement(SchedulesPanel, {
                    now: Date.parse("2026-10-30T12:00:00Z"),
                    schedules: [
                        {
                            id: "brief",
                            kind: "every",
                            expr: "15m",
                            task: "Brief",
                            enabled: true,
                            ...extra,
                        },
                    ],
                }),
            )
        expect(row({})).toContain("never run")
        const failed = row({
            lastStatus: "error",
            lastFiredAt: "2026-10-30T11:45:00Z",
            lastError: "Bad Request: chat not found",
            runs: 7,
        })
        expect(failed).toContain(">failed<")
        expect(failed).toContain("Bad Request: chat not found")
        expect(failed).toContain("7 runs")
        expect(row({ lastStatus: "ok", lastFiredAt: "2026-10-30T11:45:00Z", runs: 1 })).toContain(
            "1 run<",
        )
    })

    test("the empty state and the new-schedule button", () => {
        const html = renderToStaticMarkup(
            createElement(SchedulesPanel, { now: 0, schedules: [], onCreate: () => undefined }),
        )
        expect(html).toContain("Nothing scheduled")
        expect(html).toContain("+ New schedule")
    })
})
