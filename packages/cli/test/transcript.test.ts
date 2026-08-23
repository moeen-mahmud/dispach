import { describe, expect, test } from "bun:test"
import type { AnyEvent } from "@dispach/core"
import { MAX_TRANSCRIPT_ITEMS } from "#lib/const"
import type { TranscriptState } from "#lib/types"
import {
    EMPTY_TRANSCRIPT,
    reduce,
    seed,
    seedHistory,
    type TranscriptAction,
    transcriptRows,
} from "#transcript"

/**
 * Envelope fields the reducer never reads. The cast is needed only because TypeScript cannot check
 * a generic object literal against a mapped discriminated union; every field is real.
 */
function ev<K extends AnyEvent["type"]>(
    type: K,
    data: Extract<AnyEvent, { type: K }>["data"],
): AnyEvent {
    return {
        v: 1,
        ts: "2026-08-13T00:00:00.000Z",
        runtimeId: "test",
        type,
        data,
    } as Extract<AnyEvent, { type: K }>
}

function run(actions: readonly TranscriptAction[], from = EMPTY_TRANSCRIPT): TranscriptState {
    return actions.reduce(reduce, from)
}

const START = {
    kind: "event",
    event: ev("turn.start", { source: "repl", inputTokens: 4 }),
} as const

function chunk(delta: string, kind: "text" | "reasoning" = "text"): TranscriptAction {
    return { kind: "event", event: ev("model.chunk", { delta, kind }) }
}

function end(reason: "final" | "stopped" | "error" | "timeout" | "max_steps"): TranscriptAction {
    return {
        kind: "event",
        event: ev("turn.end", {
            reason,
            steps: 1,
            tokens: { prompt: 10, output: 5 },
            durationMs: 250,
        }),
    }
}

describe("a clean turn", () => {
    test("a typed line becomes a user item immediately", () => {
        const state = run([{ kind: "user", text: "hello" }])
        expect(state.items).toHaveLength(1)
        expect(state.items[0]?.role).toBe("user")
        expect(state.items[0]?.text).toBe("hello")
    })

    test("turn.start opens an empty live turn and reports thinking", () => {
        const state = run([START])
        expect(state.status).toBe("thinking")
        expect(state.live).toEqual({ text: "", reasoning: "", last: undefined })
    })

    test("chunks accumulate in the live turn, not in the transcript", () => {
        const state = run([START, chunk("Hel"), chunk("lo")])
        expect(state.status).toBe("streaming")
        expect(state.live?.text).toBe("Hello")
        // Nothing has finished, so nothing may be committed — <Static> would freeze a partial line.
        expect(state.items).toHaveLength(0)
    })

    test("turn.end commits the reply with its stats and closes the live turn", () => {
        const state = run([{ kind: "user", text: "hi" }, START, chunk("there"), end("final")])
        expect(state.status).toBe("idle")
        expect(state.live).toBeUndefined()
        expect(state.items.map((i) => i.role)).toEqual(["user", "assistant"])
        expect(state.items[1]?.text).toBe("there")
        expect(state.items[1]?.stats).toEqual({
            promptTokens: 10,
            outputTokens: 5,
            durationMs: 250,
            steps: 1,
            reason: "final",
        })
    })
})

describe("the <Static> contract", () => {
    test("ids are unique across a long session", () => {
        let state = EMPTY_TRANSCRIPT
        for (let i = 0; i < 25; i += 1) {
            state = run(
                [{ kind: "user", text: `q${i}` }, START, chunk(`a${i}`), end("final")],
                state,
            )
        }
        const ids = state.items.map((item) => item.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test("an item never changes once committed", () => {
        // Ink writes a <Static> node once and never looks at it again, so a mutation here would be
        // a change that silently fails to appear on screen.
        const first = run([{ kind: "user", text: "one" }, START, chunk("reply"), end("final")])
        const snapshot = first.items.map((item) => structuredClone(item))
        const later = run(
            [{ kind: "user", text: "two" }, START, chunk("second"), end("final")],
            first,
        )
        expect(later.items.slice(0, snapshot.length)).toEqual(snapshot)
    })

    test("the dynamic region stays one item however long the conversation gets", () => {
        let state = EMPTY_TRANSCRIPT
        for (let i = 0; i < 50; i += 1) {
            state = run([START, chunk("x"), end("final")], state)
        }
        state = run([START, chunk("in flight")], state)
        expect(state.items.length).toBeGreaterThan(40)
        expect(state.live?.text).toBe("in flight")
    })

    test("the reducer is deterministic — no clock, no randomness", () => {
        const actions = [{ kind: "user", text: "same" } as const, START, chunk("out"), end("final")]
        expect(run(actions)).toEqual(run(actions))
    })
})

describe("cancellation", () => {
    test("asking to cancel is a status, not an item", () => {
        const state = run([START, chunk("partial"), { kind: "cancelling" }])
        expect(state.status).toBe("cancelling")
        expect(state.items).toHaveLength(0)
    })

    test("a token still in flight does not undo the request", () => {
        const state = run([START, chunk("a"), { kind: "cancelling" }, chunk("b")])
        expect(state.status).toBe("cancelling")
        expect(state.live?.text).toBe("ab")
    })

    test("partial text survives the cancellation", () => {
        // The view-layer counterpart of the Phase 1 bug: cancelling discarded partial text because
        // an abort reached the loop as an exception. What was streamed has to end up committed.
        const state = run([START, chunk("half a th"), { kind: "cancelling" }, end("stopped")])
        // And a note under it, so scrollback distinguishes a reply you stopped from one that ended.
        expect(state.items.map((i) => i.text)).toEqual(["half a th", "cancelled"])
        expect(state.items[0]?.stats?.reason).toBe("stopped")
        expect(state.items[1]?.role).toBe("note")
        expect(state.status).toBe("idle")
    })

    test("cancelling at an idle prompt changes nothing", () => {
        expect(run([{ kind: "cancelling" }])).toEqual(EMPTY_TRANSCRIPT)
    })
})

describe("failure", () => {
    test("an error mid-stream is committed and the partial reply is kept", () => {
        const state = run([
            START,
            chunk("I was saying"),
            {
                kind: "event",
                event: ev("agent.error", {
                    code: "model_http_error",
                    message: "502 from the endpoint",
                    hint: "The provider is failing; retry or switch base URL.",
                }),
            },
            end("error"),
        ])
        expect(state.items.map((i) => i.role)).toEqual(["error", "assistant"])
        expect(state.items[0]?.text).toContain("model_http_error")
        expect(state.items[0]?.text).toContain("hint:")
        expect(state.items[1]?.text).toBe("I was saying")
    })

    test("a clean turn that produced nothing says so rather than looking normal", () => {
        const state = run([START, end("final")])
        expect(state.items).toHaveLength(1)
        expect(state.items[0]?.role).toBe("note")
        expect(state.items[0]?.text).toContain("no text")
    })

    test("max_steps and timeout are reported as themselves, never as success", () => {
        for (const reason of ["max_steps", "timeout"] as const) {
            const state = run([START, chunk("partial"), end(reason)])
            expect(state.items[0]?.stats?.reason).toBe(reason)
        }
    })

    test("a retry is visible — a silent 30-second pause is indistinguishable from a hang", () => {
        const state = run([
            START,
            { kind: "event", event: ev("model.retry", { status: 429, attempt: 2, delayMs: 1200 }) },
        ])
        expect(state.items[0]?.role).toBe("note")
        expect(state.items[0]?.text).toContain("429")
        expect(state.items[0]?.text).toContain("1200")
    })

    test("a warning is a note, not an error", () => {
        const state = run([
            {
                kind: "event",
                event: ev("agent.warning", {
                    code: "channel_degraded",
                    message: "long-poll fell back",
                    hint: "Check the token.",
                }),
            },
        ])
        expect(state.items[0]?.role).toBe("note")
    })
})

describe("reasoning", () => {
    test("is accumulated separately from the reply", () => {
        const state = run([START, chunk("thinking…", "reasoning"), chunk("answer")])
        expect(state.live?.reasoning).toBe("thinking…")
        expect(state.live?.text).toBe("answer")
        expect(state.live?.last).toBe("text")
    })

    test("is committed ahead of the reply it produced", () => {
        const state = run([START, chunk("because…", "reasoning"), chunk("42"), end("final")])
        expect(state.items.map((i) => i.role)).toEqual(["reasoning", "assistant"])
    })

    test("is not invented when the model sent none", () => {
        const state = run([START, chunk("42"), end("final")])
        expect(state.items.map((i) => i.role)).toEqual(["assistant"])
    })
})

describe("events the transcript does not own", () => {
    test("boot and bookkeeping events are inert", () => {
        // They belong to the banner and the status bar. A new event type from a later phase must be
        // inert here rather than a crash.
        const state = run([
            {
                kind: "event",
                event: ev("runtime.ready", { bootMs: 40, processMs: 60, phases: {}, agents: 1 }),
            },
            {
                kind: "event",
                event: ev("store.ready", {
                    location: ":memory:",
                    driver: "bun",
                    from: 0,
                    to: 1,
                    applied: [],
                    reaped: [],
                }),
            },
            {
                kind: "event",
                event: ev("model.call", {
                    role: "main",
                    model: "m",
                    promptTokens: 10,
                    cached: false,
                    attempt: 1,
                }),
            },
            {
                kind: "event",
                event: ev("model.result", {
                    outputTokens: 5,
                    promptTokens: 10,
                    finishReason: "stop",
                    latencyMs: 100,
                }),
            },
            { kind: "event", event: ev("context.assembled", { slots: [], total: 10 }) },
            { kind: "event", event: ev("runtime.stopping", { reason: "cli-exit" }) },
        ])
        expect(state).toEqual(EMPTY_TRANSCRIPT)
    })
})

test("chunks arriving before turn.start do not throw", () => {
    // Ordering is the bus's guarantee, not this reducer's, and a crash in a renderer is a worse
    // failure than a slightly odd transcript.
    const state = run([chunk("orphan")])
    expect(state.live?.text).toBe("orphan")
})

describe("tool rows", () => {
    function call(slug: string, mutating = false): TranscriptAction {
        return {
            kind: "event",
            event: ev("tool.call", { slug, callId: `${slug}-1`, argsHash: "deadbeef", mutating }),
        }
    }

    function result(slug: string, ok = true, truncated = false): TranscriptAction {
        return {
            kind: "event",
            event: ev("tool.result", {
                slug,
                callId: `${slug}-1`,
                trust: "trusted",
                ok,
                latencyMs: 12,
                bytes: 40,
                truncated,
            }),
        }
    }

    test("a call is committed when it starts, not when it returns", () => {
        // A tool that takes eight seconds must not leave the screen looking like a stalled model.
        const state = run([START, call("now")])
        expect(state.items.map((item) => item.role)).toEqual(["tool"])
        expect(state.items[0]?.text).toBe("now")
    })

    test("a running tool is `working`, which is not `streaming`", () => {
        // The model is not producing tokens during a tool call, and saying "replying" would be a lie.
        expect(run([START, call("now")]).status).toBe("working")
    })

    test("a mutating call says so on the row", () => {
        expect(run([START, call("memory_write", true)]).items[0]?.text).toBe(
            "memory_write (changes state)",
        )
    })

    test("the result completes the call's own row rather than adding a second", () => {
        // It *was* a second row, because `<Static>` had already written the first and editing a written
        // node silently does nothing. `<Static>` went in Phase 5.5 and the buffer is ours, so a call is
        // one row — which with the blank between items was four rows per tool call and is now one.
        const state = run([START, call("now"), result("now")])
        expect(state.items).toHaveLength(1)
        expect(state.items[0]?.text).toBe("now — ok · 12 ms")
        expect(state.items[0]?.pending).toBe(undefined)
    })

    test("a call is pending until its own result arrives, and pairs by id", () => {
        // Two calls in flight: matching "the last tool row" would complete the wrong one.
        const both = run([START, call("read_a"), call("read_b")])
        expect(both.items.every((item) => item.pending === true)).toBe(true)

        const first = reduce(both, {
            kind: "event",
            event: ev("tool.result", {
                slug: "read_a",
                callId: "read_a-1",
                trust: "trusted",
                ok: true,
                latencyMs: 12,
                bytes: 40,
                truncated: false,
            }),
        })
        expect(first.items[0]?.text).toBe("read_a — ok · 12 ms")
        expect(first.items[1]?.pending).toBe(true)
    })

    test("a result for a call nobody saw is appended rather than dropped", () => {
        // An observation nothing can account for is exactly the thing worth seeing.
        const state = run([START, result("orphan")])
        expect(state.items).toHaveLength(1)
        expect(state.items[0]?.text).toBe("orphan — ok · 12 ms")
    })

    test("a failed call is an error row, not a tool row", () => {
        const state = run([START, call("now"), result("now", false)])
        expect(state.items[0]?.role).toBe("error")
        expect(state.items[0]?.text).toContain("failed")
    })

    test("a trimmed observation is visible on the row", () => {
        const state = run([START, call("big"), result("big", true, true)])
        expect(state.items[0]?.text).toContain("observation trimmed")
    })

    test("a repair is a note naming what could not be used", () => {
        const state = run([
            START,
            { kind: "event", event: ev("tool.repair", { slugs: ["memory_write"], errors: ["x"] }) },
        ])
        expect(state.items[0]?.role).toBe("note")
        expect(state.items[0]?.text).toContain("memory_write")
        expect(state.items[0]?.text).toContain("asking the model again")
    })

    test("a blocked write is a visible note naming the policy that decided", () => {
        // Invisible would be the worst outcome here: the run did less than it was asked to, and the
        // person has to be able to see why without going looking.
        const state = run([
            START,
            {
                kind: "event",
                event: ev("tool.gated", {
                    slug: "memory_write",
                    callId: "c1",
                    reason: "web_fetch returned untrusted content earlier in this turn.",
                    policy: "refuse",
                }),
            },
        ])
        expect(state.items[0]?.role).toBe("note")
        expect(state.items[0]?.text).toContain("memory_write — blocked")
        // The reason says what decided — the trust gate or a policy rule. The row does not assert
        // one of them, because it cannot tell and guessing produced a line that named the wrong
        // setting on every policy refusal.
        expect(state.items[0]?.text).toContain("web_fetch")
    })

    test("a cancellation already requested survives a tool starting", () => {
        const state = run([START, chunk("hi"), { kind: "cancelling" }, call("now")])
        expect(state.status).toBe("cancelling")
    })
})

describe("filtered deltas", () => {
    test("a delta action accumulates exactly like a raw chunk event", () => {
        const viaAction = run([START, { kind: "delta", of: "text", text: "hello" }])
        const viaEvent = run([START, chunk("hello")])
        expect(viaAction.live).toEqual(viaEvent.live)
        expect(viaAction.status).toBe("streaming")
    })

    test("an empty delta changes nothing — a filter holding text back is not a state change", () => {
        // The filter returns "" while it waits to see whether a line becomes an ACTION block. That
        // must not flip the status to streaming or replace the live turn.
        const before = run([START])
        const after = reduce(before, { kind: "delta", of: "text", text: "" })
        expect(after).toBe(before)
    })

    test("reasoning arrives unfiltered and stays separate from the reply", () => {
        const state = run([
            START,
            { kind: "delta", of: "reasoning", text: "thinking…" },
            { kind: "delta", of: "text", text: "answer" },
        ])
        expect(state.live).toEqual({ text: "answer", reasoning: "thinking…", last: "text" })
    })
})

describe("transcriptRows — the finished conversation as rows", () => {
    const ITEMS = [
        { id: "a", role: "user" as const, text: "what is the time" },
        { id: "b", role: "assistant" as const, text: "half past four" },
    ]

    test("a row is a row on screen: prefix included, width respected", () => {
        const rows = transcriptRows(ITEMS, { showReasoning: false, quiet: false, columns: 80 })
        expect(rows.map((row) => row.text)).toEqual(["› what is the time", "", "half past four"])
        for (const row of rows) expect([...row.text].length).toBeLessThanOrEqual(80)
    })

    test("a wrapped reply is indented to its prefix, so it reads as one message", () => {
        const rows = transcriptRows([{ id: "a", role: "user", text: "alpha beta gamma delta" }], {
            showReasoning: false,
            quiet: false,
            columns: 14,
        })
        // The continuation lines carry a blank gutter of the prefix's width rather than starting a column
        // to its left, which is what made a two-line message read as two messages.
        expect(rows.map((row) => row.text)).toEqual(["› alpha beta", "  gamma delta"])
    })

    test("scrolling by rows means a long reply can be entered part-way", () => {
        // The property an item-indexed window cannot have: page-up from the bottom of a forty-row answer
        // would jump over the whole thing and land on the question before it.
        const long = [{ id: "a", role: "assistant" as const, text: "word ".repeat(200) }]
        const rows = transcriptRows(long, { showReasoning: false, quiet: false, columns: 40 })
        expect(rows.length).toBeGreaterThan(10)
    })

    test("reasoning is dropped unless asked for", () => {
        const items = [
            { id: "a", role: "reasoning" as const, text: "thinking" },
            { id: "b", role: "assistant" as const, text: "answer" },
        ]
        const hidden = transcriptRows(items, {
            showReasoning: false,
            quiet: false,
            columns: 80,
        })
        const shown = transcriptRows(items, { showReasoning: true, quiet: false, columns: 80 })
        expect(hidden.map((row) => row.text).join(" ")).not.toContain("thinking")
        expect(shown.map((row) => row.text).join(" ")).toContain("thinking")
    })

    test("stats ride under their reply, and quiet drops them", () => {
        const items = [
            {
                id: "a",
                role: "assistant" as const,
                text: "done",
                stats: {
                    promptTokens: 10,
                    outputTokens: 5,
                    durationMs: 1000,
                    steps: 1,
                    reason: "final",
                },
            },
        ]
        const loud = transcriptRows(items, { showReasoning: false, quiet: false, columns: 80 })
        const quiet = transcriptRows(items, { showReasoning: false, quiet: true, columns: 80 })
        expect(loud.length).toBe(2)
        expect(loud[1]?.dim).toBe(true)
        expect(quiet.length).toBe(1)
    })

    test("the banner loses its border and keeps its content", () => {
        // A bordered box inside a windowed list costs two rows this module cannot count, because Ink
        // measures the frame and we do not. The frame was decoration on a surface that is now one.
        const rows = transcriptRows(
            [{ id: "a", role: "banner", text: "the product 0.1.0\nsession local:default" }],
            { showReasoning: false, quiet: false, columns: 80 },
        )
        expect(rows[0]).toEqual({
            key: "a:title",
            role: "banner",
            text: "the product 0.1.0",
            bold: true,
        })
        expect(rows[1]?.text).toBe("session local:default")
        expect(rows.every((row) => !row.text.includes("╭"))).toBe(true)
    })

    test("keys are unique, so two identical replies are two rows", () => {
        const twice = [
            { id: "a", role: "assistant" as const, text: "yes" },
            { id: "b", role: "assistant" as const, text: "yes" },
        ]
        const rows = transcriptRows(twice, { showReasoning: false, quiet: false, columns: 80 })
        expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    })

    test("no trailing blank row", () => {
        // A gap before each item after the first, never after the last: a trailing one would be a
        // permanent empty line above the composer.
        const rows = transcriptRows(ITEMS, { showReasoning: false, quiet: false, columns: 80 })
        expect(rows.at(-1)?.text).not.toBe("")
    })
})

describe("compaction events", () => {
    test("pressure is a gauge: it replaces rather than accumulating", () => {
        const state = run([
            {
                kind: "event",
                event: ev("context.pressure", {
                    fraction: 0.4,
                    tokens: 400,
                    budget: 1000,
                    source: "estimated",
                }),
            },
            {
                kind: "event",
                event: ev("context.pressure", {
                    fraction: 0.72,
                    tokens: 720,
                    budget: 1000,
                    source: "corrected",
                }),
            },
        ])
        expect(state.pressure).toBe(0.72)
        // Nothing in the transcript: a value that changes every step is not an event.
        expect(state.items).toEqual([])
    })

    test("the recoverable stages are silent in the transcript", () => {
        // trim, snip and micro leave the conversation in the store and a snipped observation keeps a
        // pointer, so a line per stage would be noise on every turn under pressure.
        const state = run([
            {
                kind: "event",
                event: ev("compaction.stage", {
                    stage: "trim",
                    before: 900,
                    after: 500,
                    changed: true,
                }),
            },
            {
                kind: "event",
                event: ev("compaction.stage", {
                    stage: "snip",
                    before: 500,
                    after: 400,
                    changed: true,
                }),
            },
            {
                kind: "event",
                event: ev("compaction.stage", {
                    stage: "micro",
                    before: 400,
                    after: 300,
                    changed: false,
                }),
            },
        ])
        expect(state.items).toEqual([])
    })

    test("a summary that replaced part of the conversation gets a line", () => {
        const state = run([
            {
                kind: "event",
                event: ev("compaction.stage", {
                    stage: "collapse",
                    before: 900,
                    after: 300,
                    changed: true,
                    digest: "model",
                }),
            },
        ])
        expect(state.items.length).toBe(1)
        expect(state.items[0]?.text).toContain("earlier turns were replaced by a summary")
        expect(state.items[0]?.text).toContain("900 → 300")
    })

    test("a stage that changed nothing is not announced", () => {
        const state = run([
            {
                kind: "event",
                event: ev("compaction.stage", {
                    stage: "reset",
                    before: 900,
                    after: 900,
                    changed: false,
                }),
            },
        ])
        expect(state.items).toEqual([])
    })

    test("a second reset carries the configuration warning into the transcript", () => {
        const first = run([{ kind: "event", event: ev("context.reset", { count: 1 }) }])
        expect(first.items).toEqual([])

        const second = run([
            {
                kind: "event",
                event: ev("context.reset", { count: 2, warning: "raise context.window" }),
            },
        ])
        expect(second.items.length).toBe(1)
        expect(second.items[0]?.text).toContain("raise context.window")
    })
})

describe("phase changes", () => {
    test("a change is both a line and the current state", () => {
        const state = run([{ kind: "event", event: ev("phase.changed", { to: "act", tools: 6 }) }])
        expect(state.phase).toBe("act")
        expect(state.items.length).toBe(1)
        expect(state.items[0]?.text).toContain("now in act")
        expect(state.items[0]?.text).toContain("6 tools available")
    })

    test("the entry phase is not invented — it only appears once something moved it", () => {
        // The reducer is told about changes, never about where a session started. Filling that in would
        // be it asserting a fact nobody gave it.
        expect(EMPTY_TRANSCRIPT.phase).toBeUndefined()
    })

    test("one tool reads as one, not 1 tools", () => {
        const state = run([{ kind: "event", event: ev("phase.changed", { to: "x", tools: 1 }) }])
        expect(state.items[0]?.text).toContain("1 tool available")
    })
})

describe("a multi-step turn reads in the order it happened", () => {
    /**
     * The defect: `live` accumulated across every step and was committed once at `turn.end`, so a turn came
     * out shaped "every tool row, then all the reasoning, then all the text". The reasoning that *decided*
     * to call a tool was printed below that tool's result, and step one's reasoning was concatenated onto
     * step two's with nothing marking the join — a live turn read `…look for it in my workspace.The user is
     * asking me to…`. `model.result` is emitted once per model call, so it is the boundary; no new event
     * was needed to find it.
     */
    function step(): TranscriptAction {
        return {
            kind: "event",
            event: ev("model.result", {
                outputTokens: 10,
                promptTokens: 100,
                finishReason: "tool_calls",
                latencyMs: 200,
            }),
        }
    }
    function call(slug: string): TranscriptAction {
        return {
            kind: "event",
            event: ev("tool.call", { slug, callId: `${slug}-1`, argsHash: "d", mutating: false }),
        }
    }
    function done(slug: string): TranscriptAction {
        return {
            kind: "event",
            event: ev("tool.result", {
                slug,
                callId: `${slug}-1`,
                trust: "trusted",
                ok: true,
                latencyMs: 5,
                bytes: 9,
                truncated: false,
            }),
        }
    }

    test("reasoning sits above the tool it explains, not below the tool's result", () => {
        const state = run([
            START,
            chunk("I should read the file.", "reasoning"),
            step(),
            call("file_read"),
            done("file_read"),
            chunk("Now I know.", "reasoning"),
            chunk("Here is the answer.", "text"),
            step(),
            end("final"),
        ])
        expect(state.items.map((item) => item.role)).toEqual([
            "reasoning",
            "tool",
            "reasoning",
            "assistant",
        ])
        expect(state.items[0]?.text).toBe("I should read the file.")
        expect(state.items[1]?.text).toBe("file_read — ok · 5 ms")
    })

    test("two steps of reasoning are two items, never one run-on", () => {
        const state = run([
            START,
            chunk("first thought.", "reasoning"),
            step(),
            chunk("second thought.", "reasoning"),
            step(),
            end("final"),
        ])
        const reasoning = state.items.filter((item) => item.role === "reasoning")
        expect(reasoning).toHaveLength(2)
        expect(reasoning[0]?.text).toBe("first thought.")
        expect(reasoning[1]?.text).toBe("second thought.")
    })

    test("a tool call flushes what was streamed before it, even with no step boundary", () => {
        // Some endpoints emit the call without a `model.result` in between. The reasoning still belongs
        // above the call.
        const state = run([START, chunk("let me look.", "reasoning"), call("glob"), done("glob")])
        expect(state.items.map((item) => item.role)).toEqual(["reasoning", "tool"])
    })

    test("the turn's cost lands on the reply it belongs to", () => {
        const state = run([
            START,
            chunk("thinking.", "reasoning"),
            step(),
            chunk("the answer.", "text"),
            step(),
            end("final"),
        ])
        const reply = state.items.find((item) => item.role === "assistant")
        expect(reply?.text).toBe("the answer.")
        expect(reply?.stats?.promptTokens).toBe(10)
        // Not on the reasoning above it, and not on a row of its own.
        expect(state.items.filter((item) => item.stats !== undefined)).toHaveLength(1)
    })

    test("a turn with no reply of its own does not claim the previous turn's", () => {
        // Without the `turnFrom` floor the statistics would be attached to whatever reply came before,
        // which reads as that reply having cost twice.
        const first = run([START, chunk("answered."), step(), end("final")])
        const second = run([START, call("glob"), done("glob"), end("final")], first)
        const replies = second.items.filter((item) => item.role === "assistant")
        expect(replies).toHaveLength(1)
        expect(replies[0]?.stats?.promptTokens).toBe(10)
        // The turn that produced nothing says so, rather than borrowing.
        expect(second.items.at(-1)?.text).toBe("the model returned no text")
    })

    test("a cancelled turn still commits what it had streamed", () => {
        const state = run([START, chunk("half an ans"), { kind: "cancelling" }, end("stopped")])
        expect(state.items.map((item) => item.role)).toEqual(["assistant", "note"])
        expect(state.items[0]?.text).toBe("half an ans")
        expect(state.status).toBe("idle")
    })

    test("the live buffer is cleared at each boundary, so nothing is committed twice", () => {
        const state = run([START, chunk("once."), step(), step(), end("final")])
        expect(state.items.filter((item) => item.role === "assistant")).toHaveLength(1)
        expect(state.live).toBe(undefined)
    })
})

describe("reasoning becomes a header and an indented body", () => {
    /**
     * `ROLE_PREFIX.reasoning` was `· reasoning · ` — fourteen columns — and a prefix is re-applied as a
     * hanging indent on every row after the first. So the longest item in a conversation was also the
     * narrowest: 86 columns of a 100-column terminal, on the one thing that is routinely forty rows long.
     * The label moved to a row of its own, where it costs one row once instead of fourteen columns per row.
     */
    const long = Array.from({ length: 40 }, (_, at) => `thought number ${at}`).join(" ")
    const withReasoning = run([START, chunk(long, "reasoning"), chunk("done."), end("final")])

    test("the body gets nearly the whole width, not width minus a label", () => {
        const rows = transcriptRows(withReasoning.items, {
            showReasoning: true,
            quiet: true,
            columns: 60,
            expandReasoning: true,
        })
        const body = rows.filter((row) => row.role === "reasoning" && row.text.startsWith("  t"))
        expect(body.length).toBeGreaterThan(0)
        for (const row of body) expect(row.text.length).toBeLessThanOrEqual(60)
        // Two columns of indent, not fourteen.
        expect(body[0]?.text.startsWith("  thought")).toBe(true)
    })

    test("a long block folds to a count and says how to see the rest", () => {
        const rows = transcriptRows(withReasoning.items, {
            showReasoning: true,
            quiet: true,
            columns: 60,
        })
        const label = rows.find((row) => row.text.includes("· reasoning ·"))
        expect(label?.text).toContain("expands")
        expect(rows.some((row) => row.text.includes("more row"))).toBe(true)
    })

    test("expanding shows every row and drops the fold notice", () => {
        const folded = transcriptRows(withReasoning.items, {
            showReasoning: true,
            quiet: true,
            columns: 60,
        })
        const whole = transcriptRows(withReasoning.items, {
            showReasoning: true,
            quiet: true,
            columns: 60,
            expandReasoning: true,
        })
        expect(whole.length).toBeGreaterThan(folded.length)
        expect(whole.some((row) => row.text.includes("more row"))).toBe(false)
        expect(whole.find((row) => row.text.includes("· reasoning ·"))?.text).not.toContain(
            "expands",
        )
    })

    test("a short block is not folded and carries no expand hint", () => {
        const short = run([START, chunk("brief.", "reasoning"), chunk("done."), end("final")])
        const rows = transcriptRows(short.items, {
            showReasoning: true,
            quiet: true,
            columns: 60,
        })
        expect(rows.find((row) => row.text.includes("· reasoning ·"))?.text).toBe(
            "· reasoning · 1 row",
        )
        expect(rows.some((row) => row.text.includes("more row"))).toBe(false)
    })

    test("hidden reasoning renders no header either", () => {
        const rows = transcriptRows(withReasoning.items, {
            showReasoning: false,
            quiet: true,
            columns: 60,
        })
        expect(rows.some((row) => row.text.includes("reasoning"))).toBe(false)
    })
})

describe("a resumed conversation", () => {
    test("the messages that already happened are on the screen", () => {
        // The defect this replaced: a resumed session painted an empty transcript over a full history.
        // The messages reached the model and never the person, so the banner said `17 message(s)` above
        // a blank screen and the only honest reading was that something had been lost.
        const state = seedHistory(seed(["session local:abc123 · 4 message(s)"]), [
            { role: "user", text: "what were we at?" },
            { role: "assistant", text: "Researching OpenClaw." },
        ])

        expect(state.items.map((item) => item.role)).toEqual(["banner", "user", "assistant"])
        expect(state.items[1]?.text).toBe("what were we at?")
        expect(state.items[2]?.text).toBe("Researching OpenClaw.")
    })

    test("no statistics ride along, because they were true of a process that has exited", () => {
        const state = seedHistory(EMPTY_TRANSCRIPT, [
            { role: "assistant", text: "an earlier reply" },
        ])
        expect(state.items[0]?.stats).toBe(undefined)
    })

    test("ids stay unique across the banner and the history, or React drops a line", () => {
        const state = seedHistory(seed(["a banner"]), [
            { role: "user", text: "one" },
            { role: "assistant", text: "two" },
            { role: "user", text: "three" },
        ])
        expect(new Set(state.items.map((item) => item.id)).size).toBe(state.items.length)
        expect(state.nextId).toBe(state.items.length)
    })

    test("an empty message is skipped rather than drawn as a blank row", () => {
        // A native-dialect assistant message that only carried tool calls has no content at all.
        const state = seedHistory(EMPTY_TRANSCRIPT, [
            { role: "assistant", text: "   " },
            { role: "user", text: "a real question" },
        ])
        expect(state.items.length).toBe(1)
        expect(state.items[0]?.role).toBe("user")
    })

    test("nothing to resume leaves the state exactly as it was", () => {
        const banner = seed(["a banner"])
        expect(seedHistory(banner, [])).toEqual(banner)
    })

    test("the seeded conversation still reduces normally on top", () => {
        // The rebuild path: `/sessions` and `/restart` both tear the mount down and reopen, so a seeded
        // state has to be a legitimate starting point for the reducer rather than a display-only shape.
        let state = seedHistory(seed(["a banner"]), [
            { role: "user", text: "earlier" },
            { role: "assistant", text: "earlier reply" },
        ])
        state = reduce(state, { kind: "user", text: "a new question" })
        expect(state.items.at(-1)?.text).toBe("a new question")
        expect(state.items.length).toBe(4)
    })
})

describe("trim", () => {
    /** `n` user messages, which is the cheapest item the reducer makes. */
    function filled(n: number): TranscriptState {
        let state = EMPTY_TRANSCRIPT
        for (let i = 0; i < n; i++) state = reduce(state, { kind: "user", text: `m${i}` })
        return state
    }

    test("a buffer under the cap comes back as the same object, not a copy", () => {
        // Identity, not equality. `useReducer` compares by reference to decide whether to render, so a
        // fresh object here would repaint the whole frame on every keystroke of every session — the cap
        // would cost more than the growth it bounds. This is what lets App dispatch without checking.
        const state = filled(10)
        expect(reduce(state, { kind: "trim" })).toBe(state)
    })

    test("exactly at the cap is still nothing to do", () => {
        const state = filled(MAX_TRANSCRIPT_ITEMS)
        expect(reduce(state, { kind: "trim" })).toBe(state)
        expect(state.items.length).toBe(MAX_TRANSCRIPT_ITEMS)
    })

    test("over the cap drops the oldest and keeps the newest", () => {
        const state = reduce(filled(MAX_TRANSCRIPT_ITEMS + 5), { kind: "trim" })
        expect(state.items.length).toBe(MAX_TRANSCRIPT_ITEMS)
        // The five oldest went, and the order of what is left is untouched.
        expect(state.items[0]?.text).toBe("m5")
        expect(state.items.at(-1)?.text).toBe(`m${MAX_TRANSCRIPT_ITEMS + 4}`)
    })

    test("ids stay unique across an eviction, because nextId never rewinds", () => {
        // Keys are what Ink reconciles rows by. Numbering from the surviving items instead of from the
        // counter would reissue an id that is still on screen, and a duplicate key is a row that does
        // not update rather than an error anybody sees.
        let state = reduce(filled(MAX_TRANSCRIPT_ITEMS + 1), { kind: "trim" })
        state = reduce(state, { kind: "user", text: "after" })
        expect(new Set(state.items.map((item) => item.id)).size).toBe(state.items.length)
        expect(state.items.at(-1)?.id).toBe(`t${MAX_TRANSCRIPT_ITEMS + 1}`)
    })

    test("no other action ever evicts, however far over the cap the buffer is", () => {
        // The other half of App's gate. Eviction while a reader is parked in history would leave their
        // offset pointing at different text, so the *only* thing that may drop a row is an explicit ask
        // from the layer holding `pinned`. If `append` ever grew a cap of its own that gate would be
        // bypassed with nothing failing — the buffer would be correct and the reading of it wrong.
        let state = filled(MAX_TRANSCRIPT_ITEMS + 5)
        state = reduce(state, { kind: "user", text: "another" })
        state = reduce(state, { kind: "note", text: "a note" })
        state = reduce(state, { kind: "delta", of: "text", text: "streaming" })
        expect(state.items.length).toBe(MAX_TRANSCRIPT_ITEMS + 7)
    })

    test("the banner is evicted with everything else", () => {
        // No exemption. Four hundred turns later it describes a session that has moved on, and pinning
        // it above the conversation would be the trimmed-catalogue failure: true of the screen, false of
        // what is the case. Nothing else depends on item 0 being the banner.
        const state = reduce(
            (() => {
                let s = seed(["a banner"])
                for (let i = 0; i < MAX_TRANSCRIPT_ITEMS; i++) {
                    s = reduce(s, { kind: "user", text: `m${i}` })
                }
                return s
            })(),
            { kind: "trim" },
        )
        expect(state.items.some((item) => item.role === "banner")).toBe(false)
        expect(state.items.length).toBe(MAX_TRANSCRIPT_ITEMS)
    })
})
