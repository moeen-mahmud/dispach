import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { compact, DayChart, UsagePanel } from "../src/usage.tsx"

const bucket = (over: Partial<Parameters<typeof DayChart>[0]["buckets"][number]>) => ({
    calls: 1,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    estimatedCalls: 0,
    ...over,
})

describe("usage", () => {
    test("compact numbers", () => {
        expect(compact(999)).toBe("999")
        expect(compact(1500)).toBe("1.5k")
        expect(compact(25_000)).toBe("25k")
        expect(compact(2_400_000)).toBe("2.4M")
    })

    test("the day chart draws one bar per day in date order, labels the biggest, and keeps a table", () => {
        const html = renderToStaticMarkup(
            createElement(DayChart, {
                buckets: [
                    bucket({ day: "2026-10-28", promptTokens: 4000, outputTokens: 1000 }),
                    bucket({ day: "2026-10-27", promptTokens: 1000, outputTokens: 200 }),
                ],
            }),
        )
        expect(html.match(/class="bar/g)?.length).toBe(2)
        expect(html.indexOf("10-27")).toBeLessThan(html.indexOf("10-28"))
        expect(html).toContain(">5k<")
        expect(html).toContain('aria-label="tokens per day over 2 days"')
    })

    test("the panel totals the tiles and says what was estimated", () => {
        const html = renderToStaticMarkup(
            createElement(UsagePanel, {
                range: "30d",
                onRange: () => undefined,
                agentName: "Milo",
                report: {
                    byDay: [],
                    byModel: [
                        bucket({
                            model: "deepseek-v4-pro",
                            calls: 10,
                            promptTokens: 20_000,
                            cachedPromptTokens: 10_000,
                            outputTokens: 3000,
                        }),
                        bucket({
                            model: "deepseek-v4-flash",
                            calls: 2,
                            promptTokens: 1000,
                            outputTokens: 100,
                            estimatedCalls: 2,
                        }),
                    ],
                    bySender: [bucket({ calls: 12, promptTokens: 21_000, outputTokens: 3100 })],
                },
            }),
        )
        expect(html).toContain("What Milo spent")
        expect(html).toContain(">12<")
        expect(html).toContain(">21k<")
        expect(html).toContain("48% from cache")
        expect(html).toContain("2 calls")
        expect(html).toContain("operator (API)")
        expect(html).toContain('aria-pressed="true">30 days<')
    })
})
