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

    test("the empty state and the new-schedule button", () => {
        const html = renderToStaticMarkup(
            createElement(SchedulesPanel, { now: 0, schedules: [], onCreate: () => undefined }),
        )
        expect(html).toContain("Nothing scheduled")
        expect(html).toContain("+ New schedule")
    })
})
