/**
 * The transcript reducer, which is the only part of the UI with logic worth testing.
 *
 * Every rule here was a bug in the terminal first, and each is tested against the failure it
 * produced rather than against its implementation — a test asserting "commit happens on
 * `model.result`" would pass on code that also committed somewhere else, which is precisely the
 * defect. So they assert **order** and **pairing**, which is what actually broke.
 */

import { describe, expect, test } from "bun:test"
import type { TurnStreamItem } from "@dispach/client"
import type { EventDataMap, EventType } from "@dispach/core/wire"
import { EMPTY, emptyFor, reduce, type Transcript, withUser } from "../src/lib/transcript.ts"

/**
 * An enveloped event — and **typed against `EventDataMap`, which is the whole point.**
 *
 * The first version of this helper took `Record<string, unknown>`, so every fixture below was free
 * to invent fields. It did, and the tests agreed with it: the reducer read `model.chunk.text`
 * (really `delta`), `tool.call.args` (really `argsHash`, and the arguments are deliberately not on
 * the wire), `tool.result.observation` (not there at all) and `turn.end.note` (not there either).
 * Fifteen tests passed against a UI that rendered a **blank reply and empty tool rows**, and the
 * defect was found by streaming one real turn.
 *
 * With the generic, a field that does not exist is a compile error at the fixture. This is the
 * repo's standing rule — a test at the far end that reads the real value out — applied to the
 * shape of the data rather than to its plumbing.
 */
function event<K extends EventType>(type: K, data: EventDataMap[K]): TurnStreamItem {
    return {
        kind: "event",
        event: {
            v: 1,
            type,
            data,
            at: "2026-09-17T10:00:00.000Z",
            runtimeId: "rt",
        },
    } as unknown as TurnStreamItem
}

/**
 * One `model.result` payload, named because every step boundary needs the whole thing.
 *
 * The compiler insisted on `finishReason` and `latencyMs`, which is the fixture typing working: the
 * reducer reads neither, and a fixture free to omit them is a fixture free to be wrong about the
 * fields it *does* read — which is precisely what happened before this file was retyped.
 */
const MODEL_RESULT = {
    outputTokens: 4,
    promptTokens: 10,
    promptTokensReported: true,
    finishReason: "stop",
    latencyMs: 120,
} as const

function run(items: readonly TurnStreamItem[], from: Transcript = EMPTY): Transcript {
    return items.reduce(reduce, from)
}

function kinds(state: Transcript): string[] {
    return state.rows.map((row) => row.kind)
}

describe("a multi-step turn keeps the order it happened in", () => {
    test("reasoning, then its tool call, then the next step's reasoning", () => {
        /**
         * Reasoning above the tool call it produced, and the reply below the result.
         *
         * Revert-checking taught what this does *not* prove: removing the commit from
         * `model.result` leaves it **green**, because `tool.call` commits too — so a turn with a
         * tool in it is ordered either way. The test below, two model calls with nothing between
         * them, is the one that isolates the boundary. Both are kept: this one is the shape a
         * reader recognises, that one is the guard.
         */
        const state = run([
            event("turn.start", { source: "api", inputTokens: 12, trust: "trusted" }),
            event("model.chunk", { delta: "I should look that up.", kind: "reasoning" }),
            event("model.result", MODEL_RESULT),
            event("tool.call", { callId: "c1", slug: "now", argsHash: "h1", mutating: false }),
            event("tool.result", {
                callId: "c1",
                slug: "now",
                ok: true,
                latencyMs: 2,
                bytes: 5,
                truncated: false,
                trust: "trusted",
            }),
            event("model.chunk", { delta: "It is ten.", kind: "text" }),
            event("model.result", MODEL_RESULT),
            event("turn.end", {
                reason: "final",
                steps: 2,
                tokens: { prompt: 10, output: 4 },
                durationMs: 90,
            }),
        ])

        expect(kinds(state)).toEqual(["reasoning", "tool", "reply"])
        expect(state.running).toBe(false)
    })

    test("two model calls are two rows, never one paragraph", () => {
        const state = run([
            event("model.chunk", { delta: "First.", kind: "text" }),
            event("model.result", MODEL_RESULT),
            event("model.chunk", { delta: "Second.", kind: "text" }),
            event("model.result", MODEL_RESULT),
        ])
        expect(state.rows.map((row) => (row.kind === "reply" ? row.text : ""))).toEqual([
            "First.",
            "Second.",
        ])
    })

    test("tokens accumulate before they are committed", () => {
        const state = run([
            event("model.chunk", { delta: "par", kind: "text" }),
            event("model.chunk", { delta: "tial", kind: "text" }),
        ])
        // Still live, so the UI renders it as the tail and no row exists yet.
        expect(state.live).toBe("partial")
        expect(state.rows).toEqual([])
    })
})

describe("a tool result finds its own call", () => {
    test("matched on callId, not on position", () => {
        // Calls overlap, so "the last tool row" is not the row a result belongs to. Two calls are
        // opened and answered in the reverse order, which is the case that fails on position.
        const state = run([
            event("tool.call", { callId: "c1", slug: "glob", argsHash: "h1", mutating: false }),
            event("tool.call", { callId: "c2", slug: "grep", argsHash: "h2", mutating: false }),
            event("tool.result", {
                callId: "c2",
                slug: "grep",
                ok: true,
                latencyMs: 3,
                bytes: 9,
                truncated: false,
                trust: "trusted",
            }),
            event("tool.result", {
                callId: "c1",
                slug: "glob",
                ok: false,
                latencyMs: 1,
                bytes: 0,
                truncated: false,
                trust: "trusted",
            }),
        ])
        const rows = state.rows.filter((row) => row.kind === "tool")
        // `bytes` rather than a result string: `tool.result` does not carry the observation, and
        // asserting one is exactly the invented field this file was rewritten to make impossible.
        expect(
            rows.map((row) => (row.kind === "tool" ? [row.slug, row.ok, row.bytes] : [])),
        ).toEqual([
            ["glob", false, 0],
            ["grep", true, 9],
        ])
    })

    test("a result for a call nobody saw changes nothing", () => {
        // Identical state, so React skips the render. A reattach part-way through a turn is the
        // real case: the call frame was in the evicted part of the buffer.
        const before = run([
            event("tool.call", { callId: "c1", slug: "now", argsHash: "h1", mutating: false }),
        ])
        const after = reduce(
            before,
            event("tool.result", {
                callId: "zz",
                slug: "now",
                ok: true,
                latencyMs: 1,
                bytes: 1,
                truncated: false,
                trust: "trusted",
            }),
        )
        expect(after).toBe(before)
    })

    test("untrusted output is flagged so the UI can fence it", () => {
        const state = run([
            event("tool.call", {
                callId: "c1",
                slug: "web_fetch",
                argsHash: "h1",
                mutating: false,
            }),
            event("tool.result", {
                callId: "c1",
                slug: "web_fetch",
                ok: true,
                latencyMs: 4,
                bytes: 2,
                truncated: false,
                trust: "untrusted",
            }),
        ])
        const row = state.rows[0]
        expect(row?.kind === "tool" && row.untrusted).toBe(true)
    })
})

describe("an approval is a row where it happened", () => {
    test("and settles in place", () => {
        const state = run([
            event("approval.requested", {
                approvalId: "a1",
                slug: "exec",
                callId: "c1",
                match: "rm -rf build",
                mutating: true,
                reason: "a rule says ask",
            }),
            event("approval.resolved", {
                approvalId: "a1",
                slug: "exec",
                granted: true,
                by: "approver",
            }),
        ])
        const row = state.rows[0]
        expect(row?.kind === "approval" && row.settled).toBe("granted")
    })

    test("abandoned and error are distinct from a refusal", () => {
        /**
         * The distinction 11.188 exists for, and the reason `by` is on the event at all.
         *
         * A UI with a prompt on screen needs the three apart: `abandoned` means take it down and
         * nobody declined anything, `error` means the approver itself is broken and the denial says
         * nothing about what a person wanted. Collapsing them to `granted: false` would put "a
         * person refused this" on screen for a turn that simply timed out.
         */
        for (const [by, expected] of [
            ["abandoned", "abandoned"],
            ["error", "error"],
            ["approver", "denied"],
        ] as const) {
            const state = run([
                event("approval.requested", {
                    approvalId: "a1",
                    slug: "exec",
                    callId: "c1",
                    mutating: true,
                    reason: "r",
                }),
                event("approval.resolved", { approvalId: "a1", slug: "exec", granted: false, by }),
            ])
            const row = state.rows[0]
            expect(row?.kind === "approval" && row.settled).toBe(expected)
        }
    })
})

describe("how a turn ended is a row, not a silence", () => {
    test("a budget stop says so", () => {
        // Rendered nowhere for three phases in the TUI, which made a turn stopped by its step
        // budget pixel-identical to a completed one.
        const state = run([
            event("model.chunk", { delta: "Let me install it", kind: "text" }),
            event("turn.end", {
                reason: "max_steps",
                steps: 4,
                tokens: { prompt: 10, output: 4 },
                durationMs: 90,
            }),
        ])
        const last = state.rows[state.rows.length - 1]
        expect(last?.kind === "note" && last.bad).toBe(true)
        // Core's sentence, not one this page composes — `endNote` is the single formatter three
        // other surfaces already share, and a fourth wording is how a stopped turn came to be
        // reported three different ways. Asserted on substance rather than byte-for-byte, so
        // rewording the note in core does not fail a UI test that is about *which* note.
        expect(last?.kind === "note" && last.text).toContain("limits.maxSteps")
        expect(last?.kind === "note" && last.text).toContain("4 steps")
    })

    test("a clean ending adds nothing", () => {
        const state = run([
            event("model.chunk", { delta: "Done.", kind: "text" }),
            event("turn.end", {
                reason: "final",
                steps: 2,
                tokens: { prompt: 10, output: 4 },
                durationMs: 90,
            }),
        ])
        expect(kinds(state)).toEqual(["reply"])
    })

    test("a stopped turn is noted but not an error", () => {
        // `stopped` is somebody pressing stop — an outcome, not a fault. `endNote` still returns a
        // word for it ("cancelled"), because a transcript that simply ends is one where the reader
        // cannot tell a cancel from a crash; `endedBadly` is what separates the two.
        const state = run([
            event("turn.end", {
                reason: "stopped",
                steps: 1,
                tokens: { prompt: 10, output: 0 },
                durationMs: 20,
            }),
        ])
        const last = state.rows[state.rows.length - 1]
        expect(last?.kind === "note" && last.bad).toBe(false)
        expect(state.running).toBe(false)
    })
})

describe("reattach", () => {
    test("a truncated replay is reported before text is assembled", () => {
        // The preamble arrives first precisely so a hole is known before the UI builds a reply out
        // of what follows — a fragment presented as a whole answer is the failure.
        const state = run([
            { kind: "replay", report: { state: "running", events: 10, truncated: true } },
            event("model.chunk", { delta: "…dle of a sentence", kind: "text" }),
        ] as unknown as TurnStreamItem[])
        expect(state.truncated).toBe(true)
    })

    test("a turn that ended before the page attached is not an error", () => {
        const state = run([
            {
                kind: "ended",
                turnId: "t1",
                status: "final",
                steps: 2,
                errorCode: undefined,
            },
        ] as unknown as TurnStreamItem[])
        const row = state.rows[0]
        expect(row?.kind === "note" && row.bad).toBe(false)
        expect(state.running).toBe(false)
    })

    test("running elsewhere is distinct from finished", () => {
        // One store is shared by every process under a sandbox root, so a served process can hold a
        // `running` row for a turn another process is executing. Treating it as finished would send
        // a reader after a final text that does not exist yet.
        const state = run([
            { kind: "unavailable", turnId: "t1", reason: "another process is running this turn" },
        ] as unknown as TurnStreamItem[])
        const row = state.rows[0]
        expect(row?.kind === "note" && row.bad).toBe(true)
    })
})

describe("the dialect's call markup never reaches a chat bubble", () => {
    /**
     * Deltas copied from a real deepseek turn through `examples/minimal` with `now` pinned.
     *
     * The defect this guards shipped and was found by streaming that turn: the reply row read
     * `ACTION: now / format: human / END`, because **the wire carries unfiltered chunks** and the
     * filter `proseOf` describes is applied by the CLI on its own path (`cli/src/run.ts:821`), not
     * on the way to SSE. Split across deltas on purpose — a filter that only worked on whole lines
     * would pass a single-delta fixture and fail on the real stream.
     */
    const NLT_DELTAS = ["Let me check.\n", "ACT", "ION: now\nfor", "mat: human\nEND"]

    function stream(dialect: string): Transcript {
        let state = emptyFor(dialect)
        for (const delta of NLT_DELTAS) {
            state = reduce(state, event("model.chunk", { delta, kind: "text" }))
        }
        state = reduce(state, event("model.result", MODEL_RESULT))
        return reduce(
            state,
            event("turn.end", {
                reason: "final",
                steps: 1,
                tokens: { prompt: 10, output: 4 },
                durationMs: 50,
            }),
        )
    }

    test("under nlt the block is stripped and the prose survives", () => {
        const rows = stream("nlt").rows
        const text = rows.map((row) => (row.kind === "reply" ? row.text : "")).join("")
        expect(text.includes("ACTION")).toBe(false)
        // The prose has to survive, which is the half a blunt "drop anything that looks like a
        // call" would fail: the filter withholds a partial `ACT` and must release it as text if the
        // line turns out to be prose after all.
        expect(text.includes("Let me check.")).toBe(true)
    })

    test("held-back prose survives a step boundary", () => {
        /**
         * What `filter.endStep()` does beyond ordering: it releases text the filter was withholding
         * because it *might* have been the start of an invocation.
         */
        let state = emptyFor("nlt")
        for (const delta of ["The answer is ", "ACT", "ually 42."]) {
            state = reduce(state, event("model.chunk", { delta, kind: "text" }))
        }
        state = reduce(state, event("model.result", MODEL_RESULT))
        const text = state.rows.map((row) => (row.kind === "reply" ? row.text : "")).join("")
        expect(text).toBe("The answer is ACTually 42.")
    })

    test("a step after a completed call block still speaks", () => {
        /**
         * The defect the live run caught, and the one no earlier fixture could.
         *
         * Without `filter.endStep()` the filter's parse state does not reset after a completed
         * `ACTION` block, so **every following step's prose is suppressed entirely** — a two-step
         * turn rendered `reasoning → tool → reasoning` while the stored turn held the answer in
         * full. The fixture has to contain a *completed block followed by another step*; one with
         * prose in step one never enters the block state and passes either way, which is how two
         * revert-checks agreed with the wrong conclusion.
         */
        let state = emptyFor("nlt")
        for (const delta of ["Let me check.\n", "ACTION: now\nformat: human\nEND"]) {
            state = reduce(state, event("model.chunk", { delta, kind: "text" }))
        }
        state = reduce(state, event("model.result", MODEL_RESULT))
        state = reduce(
            state,
            event("tool.call", { callId: "c1", slug: "now", argsHash: "h", mutating: false }),
        )
        state = reduce(
            state,
            event("tool.result", {
                callId: "c1",
                slug: "now",
                ok: true,
                latencyMs: 7,
                bytes: 42,
                truncated: false,
                trust: "trusted",
            }),
        )
        state = reduce(state, event("model.chunk", { delta: "It is Thursday.", kind: "text" }))
        state = reduce(state, event("model.result", MODEL_RESULT))

        expect(state.rows.map((row) => row.kind)).toEqual(["reply", "tool", "reply"])
        const texts = state.rows.flatMap((row) => (row.kind === "reply" ? [row.text] : []))
        expect(texts).toEqual(["Let me check.", "It is Thursday."])
    })

    test("no row opens with a blank line, whatever the filter queued", () => {
        /**
         * The reason `filter.endStep()` is **not** called at the step boundary.
         *
         * It queues the blank line that separates two steps' prose for a renderer building one
         * growing string, and the next `push` emits it — measured:
         * `push("First answer.")`, `endStep()`, `push("Second answer.")` gives
         * `"\n\nSecond answer."`. Here each step is its own row, so that break would show as a
         * leading blank line inside a chat bubble. Committing trims as well, which covers a model
         * that pads its own prose.
         */
        let state = emptyFor("nlt")
        state = reduce(state, event("model.chunk", { delta: "First answer.", kind: "text" }))
        state = reduce(state, event("model.result", MODEL_RESULT))
        state = reduce(state, event("model.chunk", { delta: "Second answer.", kind: "text" }))
        state = reduce(state, event("model.result", MODEL_RESULT))
        const texts = state.rows.flatMap((row) => (row.kind === "reply" ? [row.text] : []))
        expect(texts).toEqual(["First answer.", "Second answer."])
    })

    test("under native it is not stripped, which is what proves the filter does it", () => {
        /**
         * The positive control, and it is not hypothetical: `native` puts the call in `toolCalls`,
         * so its `content` is already what the person saw and filtering it would be a parse that
         * cannot change the answer. Feeding it NLT text is therefore an artificial stream — the
         * point is only that the *stripping* is the filter's doing and not something the reducer
         * does anyway, which a single test could not distinguish.
         */
        const text = stream("native")
            .rows.map((row) => (row.kind === "reply" ? row.text : ""))
            .join("")
        expect(text.includes("ACTION")).toBe(true)
    })
})

describe("the user's own message", () => {
    test("lands immediately and marks the turn running", () => {
        // Optimistic, because the round trip to `POST /messages` is long enough to look broken —
        // and the text is the person's own, so there is nothing to be wrong about.
        const state = withUser(EMPTY, "hello")
        expect(kinds(state)).toEqual(["user"])
        expect(state.running).toBe(true)
    })
})

describe("a turn that failed says so", () => {
    /**
     * The defect this exists for, measured in the container on 2026-09-22.
     *
     * A DeepSeek key pasted without its `sk-` prefix made every turn 401. `POST /messages` answered
     * **200** with a turn id, the turn ended 258 ms later with `reason: "error"`, and the browser
     * showed the message going out and **nothing coming back** — no reply, no note, no error. The
     * runtime had the whole sentence (`model_http_error`, the endpoint's own words, and a hint
     * naming `model.main.apiKeyEnv`); this reducer dropped the event on `default` and `endNote`
     * returns `undefined` for `"error"` by design, on the reasoning that the two CLI paths render it.
     *
     * So the assertion is on the **text**, not on a row appearing: a bad note that does not carry
     * the code and the hint sends a reader nowhere, which is the failure with better manners.
     */
    test("the error event becomes a bad note carrying code, message and hint", () => {
        const state = run([
            event("turn.start", { source: "api", inputTokens: 12, trust: "trusted" }),
            event("error", {
                code: "model_http_error",
                message:
                    "Model endpoint returned 401 for https://api.deepseek.com/v1/chat/completions",
                hint: "Check the API key named by model.main.apiKeyEnv, and that baseUrl points at the right provider.",
            }),
            event("turn.end", {
                reason: "error",
                steps: 1,
                tokens: { prompt: 0, output: 0 },
                durationMs: 258,
            }),
        ])

        const notes = state.rows.filter((row) => row.kind === "note")
        expect(notes).toHaveLength(1)
        const note = notes[0]
        if (note?.kind !== "note") throw new Error("expected a note row")
        expect(note.bad).toBe(true)
        expect(note.text).toContain("model_http_error")
        expect(note.text).toContain("401")
        expect(note.text).toContain("model.main.apiKeyEnv")
        expect(state.running).toBe(false)
    })

    /**
     * Prose already streamed is kept, not thrown away.
     *
     * A turn can fail on its *second* model call, and the first call's answer is the only part of
     * the work that survives. Committing before appending the note is what keeps it; returning a
     * fresh state would delete a reply the reader had already watched arrive.
     */
    test("text streamed before the failure survives it", () => {
        const state = run([
            event("turn.start", { source: "api", inputTokens: 12, trust: "trusted" }),
            event("model.chunk", { delta: "Looking that up.", kind: "text" }),
            event("error", { code: "model_http_error", message: "boom", hint: "check the key" }),
        ])

        expect(kinds(state)).toEqual(["reply", "note"])
    })
})
