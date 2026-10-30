import { describe, expect, test } from "bun:test"
import { summarise } from "../../../scripts/bench/report.ts"
import type { RunRow } from "../../../scripts/bench/run.ts"
import { build, passK, readme } from "../../../scripts/bench/summary.ts"

describe("bench summary", () => {
    const summary = build()

    test("the README's table is replaced between its markers and nothing else moves", () => {
        const text = "intro\n<!-- benchmark:start -->\nold table\n<!-- benchmark:end -->\noutro\n"
        const out = readme(text, summary)
        expect(out.startsWith("intro\n<!-- benchmark:start -->\n| Model |")).toBe(true)
        expect(out.endsWith("\n<!-- benchmark:end -->\noutro\n")).toBe(true)
        expect(out).not.toContain("old table")
        // Running it twice changes nothing, which is what `--check` relies on.
        expect(readme(out, summary)).toBe(out)
    })

    test("a README without the markers is refused, never appended to", () => {
        expect(() => readme("no markers here\n", summary)).toThrow(/benchmark:start/)
    })

    test("a paused arm is never published as a rate", () => {
        const qwen = summary.models.find((m) => m.key === "qwen3.5-9b")
        expect(qwen?.nlt?.paused).toBe(true)
        expect(qwen?.native?.paused).toBeUndefined()
    })

    test("pass^k: one task failed once in five counts as 24 of 25, throttled row excluded", () => {
        const row = (task: string, repeat: number, pass: boolean, throttled = false): RunRow => ({
            harness: "dispach",
            model: "fixture",
            task,
            category: "single",
            repeat,
            pass,
            reply: "",
            errored: false,
            retries: 0,
            ...(throttled ? { throttled: true as const } : {}),
            wallMs: 1,
            toolCalls: 0,
            modelCalls: 1,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            generationIds: [],
            at: "2026-10-26T00:00:00.000Z",
        })
        const rows: RunRow[] = []
        for (let t = 1; t <= 25; t++)
            for (let r = 1; r <= 5; r++)
                rows.push(row(`task-${String(t).padStart(2, "0")}`, r, !(t === 25 && r === 5)))
        // A trial the provider rate-limited: scored as a failure it would drop task-01 too.
        rows.push(row("task-01", 6, false, true))
        expect(passK(summarise("native.fixture", rows))).toEqual({ pass: 24, tasks: 25 })
    })

    test("the published arms carry the pass^k the issue computed from the runs", () => {
        const byKey = new Map(summary.models.map((m) => [m.key, m]))
        expect(byKey.get("gemini-4-argon")?.native?.passK).toEqual({ pass: 23, tasks: 25 })
        expect(byKey.get("glm-5.3")?.native?.passK).toEqual({ pass: 25, tasks: 25 })
        expect(byKey.get("kimi-k3")?.native?.passK).toEqual({ pass: 19, tasks: 25 })
    })
})
