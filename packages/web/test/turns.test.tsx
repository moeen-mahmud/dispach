import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { endedBadly, statusSentence, TurnsPanel } from "../src/turns.tsx"

describe("turns", () => {
    test("every end reason has a sentence, and the bad ones are the bad ones", () => {
        for (const status of [
            "final",
            "running",
            "stopped",
            "max_steps",
            "no_progress",
            "truncated",
            "timeout",
            "error",
        ]) {
            expect(statusSentence(status)).not.toBe(status)
        }
        expect(endedBadly("final")).toBe(false)
        expect(endedBadly("stopped")).toBe(false)
        expect(endedBadly("max_steps")).toBe(true)
        expect(endedBadly("truncated")).toBe(true)
    })

    test("a listing marks bad turns by reason and offers older pages", () => {
        const html = renderToStaticMarkup(
            createElement(TurnsPanel, {
                hasMore: true,
                onMore: () => undefined,
                turns: [
                    {
                        turnId: "t1",
                        sessionKey: "web:abc",
                        status: "final",
                        input: "hi",
                        text: "hello",
                        steps: 1,
                        promptTokens: 500,
                        outputTokens: 20,
                    },
                    {
                        turnId: "t2",
                        sessionKey: "tg:1",
                        status: "max_steps",
                        input: "do all the things",
                        text: "",
                        steps: 40,
                        promptTokens: 90_000,
                        outputTokens: 4000,
                    },
                ],
            }),
        )
        expect(html).toContain("1 of the 2 shown ended badly")
        expect(html).toContain("hit the step budget")
        expect(html).toContain("40 steps")
        expect(html).toContain(">older turns<")
        expect(html.match(/class="card turn bad"/g)?.length).toBe(1)
    })
})
