import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { endedBadly, ReplayView, statusSentence, stepLabel, TurnsPanel } from "../src/turns.tsx"

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

describe("a turn's replay", () => {
    const turn = {
        turnId: "t1",
        sessionKey: "web:a",
        status: "final",
        input: "list it",
        text: "done",
        steps: 2,
        promptTokens: 10,
        outputTokens: 5,
    }
    test("labels each stored step by what wrote it, and shows a result as text, not markup", () => {
        const html = renderToStaticMarkup(
            createElement(ReplayView, {
                turn,
                replay: {
                    state: "ready",
                    steps: [
                        { id: 1, role: "user", content: "list it" },
                        {
                            id: 2,
                            role: "assistant",
                            content: "",
                            origin: "call",
                            toolCalls: [{ name: "glob", arguments: '{"pattern":"**/*"}' }],
                        },
                        { id: 3, role: "user", content: "<b>a.txt</b>", origin: "observation" },
                        { id: 4, role: "assistant", content: "done" },
                    ],
                },
            }),
        )
        expect(stepLabel({ id: 2, role: "assistant", content: "", origin: "call" })).toBe(
            "tool call",
        )
        expect(html.indexOf(">asked<")).toBeLessThan(html.indexOf(">tool call<"))
        expect(html.indexOf(">tool result<")).toBeLessThan(html.indexOf(">reply<"))
        expect(html).toContain("&lt;b&gt;a.txt&lt;/b&gt;")
        // A native call is in toolCalls, its content empty: the replay shows the call, not a blank.
        expect(html).toContain("glob({&quot;pattern&quot;:&quot;**/*&quot;})")
    })

    test("unasked offers the replay; nothing stored says why", () => {
        expect(
            renderToStaticMarkup(createElement(ReplayView, { turn, onReplay: () => undefined })),
        ).toContain("replay every step")
        expect(
            renderToStaticMarkup(
                createElement(ReplayView, { turn, replay: { state: "ready", steps: [] } }),
            ),
        ).toContain("No stored steps")
    })
})
