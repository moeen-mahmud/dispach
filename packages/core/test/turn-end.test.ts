/**
 * Every ending has a sentence, and the sentence names what to do.
 *
 * The union is exhaustive by construction — `endNote` switches on it with no `default`, so a new
 * reason fails to compile rather than falling through to silence. This asserts the part the compiler
 * cannot: that each sentence is present, distinct, and actionable.
 */

import type { TurnEndReason } from "../src/events/types.ts"
import { endedBadly, endNote } from "../src/loop/turn-end.ts"
import { describe, expect, test } from "./_harness.ts"

const ALL: readonly TurnEndReason[] = [
    "final",
    "max_steps",
    "no_progress",
    "truncated",
    "stopped",
    "timeout",
    "error",
]

describe("what a stopped turn says", () => {
    test("only `final` and `error` are silent, and `error` is silent because it says more elsewhere", () => {
        const silent = ALL.filter((reason) => endNote(reason) === undefined)
        expect(silent).toEqual(["final", "error"])
    })

    test("no two endings read the same", () => {
        const notes = ALL.map((reason) => endNote(reason)).filter(
            (note): note is string => note !== undefined,
        )
        expect(new Set(notes).size).toBe(notes.length)
    })

    test("each one names the remedy, not the mechanism", () => {
        // The failing agent's reader wants the next action. "the loop exited" is true and useless.
        expect(endNote("max_steps", { steps: 40 })).toContain("continue")
        expect(endNote("max_steps", { steps: 40 })).toContain("limits.maxSteps")
        expect(endNote("no_progress")).toContain("continue")
        expect(endNote("truncated")).toContain("maxTokens")
        expect(endNote("timeout", { durationMs: 1800000 })).toContain("limits.turnTimeoutMs")
    })

    test("context is optional, because a channel has no clock to report", () => {
        // Called with nothing at all, every sentence still has to be a sentence.
        for (const reason of ALL) {
            const note = endNote(reason)
            if (note === undefined) continue
            expect(note.length).toBeGreaterThan(5)
            expect(note).not.toContain("undefined")
            expect(note).not.toContain("NaN")
        }
    })

    test("the step count appears when it is known and nothing dangles when it is not", () => {
        expect(endNote("max_steps", { steps: 12 })).toContain("12 steps")
        expect(endNote("max_steps")).not.toContain("after")
    })
})

describe("which endings are failures", () => {
    test("an unfinished turn is a failure and a requested stop is not", () => {
        expect(ALL.filter(endedBadly)).toEqual([
            "max_steps",
            "no_progress",
            "truncated",
            "timeout",
            "error",
        ])
    })

    test("truncated counts, because half a reply reads as a whole one", () => {
        // The old behaviour reported this as `final` and exited 0, on the reasoning that truncation is
        // visible. It is visible to a person at a terminal and to nobody else.
        expect(endedBadly("truncated")).toBe(true)
    })

    test("timeout counts, and that is the exit code that used to be wrong", () => {
        // `turnTimeout` was written in Phase 1 with a hint naming the field to raise, and never
        // called. So a timed-out turn had empty error columns in the store, printed one parenthesis
        // on the plain path, and exited 0 — a failure reported as success, which is hard rule 8.
        expect(endedBadly("timeout")).toBe(true)
    })
})
