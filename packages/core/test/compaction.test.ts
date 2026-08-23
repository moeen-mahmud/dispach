/**
 * The compaction ladder.
 *
 * Two groups matter most. The **ordering** group asserts that stages run from the first rung and never
 * skip, because skipping is how a mild overflow gets a digest it did not need — and that a stage which
 * changes nothing reports so, because that is the signal the ladder escalates on. The **displacement**
 * group asserts that a `micro` following a `snip` over the same message still points at the *original*
 * observation: deriving the pointer's id from the text as it then stands would resolve it to the
 * truncation, which is a pointer that lies about what it retrieves.
 */

import { UNCALIBRATED } from "../src/context/budget.ts"
import {
    deepestStage,
    runLadder,
    type Thresholds,
    targetFraction,
} from "../src/context/compaction/ladder.ts"
import {
    collapse,
    displacedId,
    historyTokens,
    mechanicalDigest,
    micro,
    reset,
    STAGE_ORDER,
    type StageInput,
    type StageOutcome,
    snip,
    trim,
} from "../src/context/compaction/stages.ts"
import type { ChatMessage } from "../src/model/provider.ts"
import { describe, expect, test } from "./_harness.ts"

/** Stage order, so the fixture reads the way the ladder runs: snip, micro, collapse, reset, trim. */
const THRESHOLDS: Thresholds = { snip: 0.6, micro: 0.7, collapse: 0.8, reset: 0.88, trim: 0.95 }

function ask(text: string): ChatMessage {
    return { role: "user", content: text }
}

function reply(text: string): ChatMessage {
    return { role: "assistant", content: text }
}

/** An NLT observation: a `user` message whose role says nothing and whose `origin` says everything. */
function observation(slug: string, lines: number): ChatMessage {
    const body = Array.from(
        { length: lines },
        (_, i) => `row ${i} : some value with punctuation, braces {and} quotes "here"`,
    ).join("\n")
    return {
        role: "user",
        origin: "observation",
        content: `OBSERVATION ${slug} — ok\n${body}`,
    }
}

/** Three complete turns, the middle one carrying a large tool result. */
function session(): ChatMessage[] {
    return [
        ask("first question"),
        reply("first answer"),
        ask("second question, the one with tools"),
        reply("ACTION exec"),
        observation("exec", 120),
        reply("second answer"),
        ask("third question"),
        reply("third answer"),
    ]
}

describe("the target is one rung down", () => {
    test("a stage aims at the threshold below the deepest one that fired", () => {
        // 0.72 crosses snip and micro; the rung below micro is snip.
        expect(deepestStage(THRESHOLDS, 0.72)?.stage).toBe("micro")
        expect(targetFraction(THRESHOLDS, 1)).toBe(0.6)
        // 0.96 crosses everything; the rung below trim is reset.
        expect(deepestStage(THRESHOLDS, 0.96)?.stage).toBe("trim")
        expect(targetFraction(THRESHOLDS, 4)).toBe(0.88)
    })

    test("the first rung has nothing below it, so it uses the one margin in the scheme", () => {
        expect(targetFraction(THRESHOLDS, 0)).toBeCloseTo(0.55, 5)
    })

    test("below every threshold, nothing fired", () => {
        expect(deepestStage(THRESHOLDS, 0.59)).toBeUndefined()
    })
})

describe("nothing over threshold costs nothing", () => {
    test("the history is returned untouched with no stage records", async () => {
        const history = session()
        const result = await runLadder({
            history,
            protectedTail: 0,
            budget: 200_000,
            fixed: 1_000,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
        })
        expect(result.stages).toEqual([])
        expect(result.history).toBe(history)
        expect(result.displaced).toEqual([])
        expect(result.fellShort).toBe(false)
        expect(result.after).toBe(result.before)
    })
})

describe("trim drops working detail and keeps what the person said", () => {
    test("every request survives, however hard it is pushed", () => {
        const history = session()
        const asked = history.filter((m) => m.role === "user" && m.origin === undefined)
        expect(asked.length).toBeGreaterThan(1)

        // target 1 is unreachable, so this is the stage at full stretch — the case where an
        // oldest-first design has thrown away everything it is allowed to.
        const outcome = trim({ history, target: 1, protectedTail: 0 })
        expect(outcome.changed).toBe(true)

        const survived = outcome.messages.filter((m) => m.role === "user" && m.origin === undefined)
        expect(survived).toEqual(asked)
        // And in the order they were asked, because a spine that reorders is worse than none.
        expect(survived.map((m) => m.content)).toEqual(asked.map((m) => m.content))
    })

    test("the observations are what actually goes", () => {
        const history = session()
        const before = history.filter((m) => m.origin === "observation").length
        expect(before).toBeGreaterThan(0)
        const outcome = trim({ history, target: 1, protectedTail: 0 })
        expect(outcome.messages.filter((m) => m.origin === "observation")).toEqual([])
    })

    test("the survivors are framed, or the oldest request reads as the live one", () => {
        const outcome = trim({ history: session(), target: 1, protectedTail: 0 })
        const first = outcome.messages[0]
        expect(first?.origin).toBe("digest")
        expect(first?.content).toContain("cannot be retrieved")
        // No artifact id, because this stage writes no artifact. A marker implying one sends the model
        // looking for a pointer nobody stored.
        expect(first?.content).not.toContain("artifact_read")
    })

    test("a history of nothing but requests has nothing it may drop", () => {
        const history = [ask("only question"), ask("and another")]
        expect(trim({ history, target: 1, protectedTail: 0 }).changed).toBe(false)
    })

    test("a lone reply is droppable — the working detail is the unit, not the turn", () => {
        const history = [ask("only question"), reply("only answer")]
        const outcome = trim({ history, target: 1, protectedTail: 0 })
        expect(outcome.changed).toBe(true)
        expect(outcome.messages.some((m) => m.content === "only answer")).toBe(false)
        expect(outcome.messages.some((m) => m.content === "only question")).toBe(true)
    })

    test("it drops oldest-first, so recent detail outlives old detail", () => {
        // Replies far larger than the header, deliberately. The header is itself a message and is
        // charged for before anything is removed, so on a history of one-line turns trim takes more
        // than the naive arithmetic suggests — real, and not what this test is about.
        const first = `first answer ${"x".repeat(4000)}`
        const second = `second answer ${"y".repeat(4000)}`
        const history = [ask("first"), reply(first), ask("second"), reply(second)]
        const target = historyTokens(history) - 400
        const outcome = trim({ history, target, protectedTail: 0 })
        expect(outcome.messages.some((m) => m.content === first)).toBe(false)
        expect(outcome.messages.some((m) => m.content === second)).toBe(true)
    })
})

describe("trim re-keys what earlier stages displaced", () => {
    /**
     * The trap the reorder set, and the one with data loss behind it.
     *
     * `trim` reindexes, and `runLadder` *replaces* the displacement map with whatever the stage
     * returns rather than merging. While `trim` ran first it correctly returned an empty map and its
     * own comment said there could never be one to lose. Running third, an empty map would discard
     * everything `snip` and `micro` recorded — so `persist()` would never be asked to write those
     * artifacts, while the pointers naming them stayed in the surviving messages. A live
     * `artifact_read` id resolving to nothing, with no error anywhere.
     */
    test("a pointer that survives trim still names an artifact the caller was told to persist", () => {
        // A large assistant reply first, so `trim` reaches its target by dropping that and leaves the
        // pointers behind. Oldest-first is what makes the fixture's order load-bearing.
        const history = [
            ask("first"),
            reply(`long narration ${"n".repeat(6000)}`),
            reply("ACTION exec"),
            observation("exec", 200),
            ask("second"),
            reply("ACTION exec"),
            observation("exec", 200),
            ask("third"),
        ]

        // `snip` records the originals, `micro` reuses them, `trim` then removes some messages.
        const snipped = snip({ history, target: 1, protectedTail: 1 })
        expect(snipped.displaced.size).toBeGreaterThan(0)
        const microd = micro({
            history: snipped.messages,
            target: 1,
            protectedTail: 1,
            displaced: snipped.displaced,
        })
        const trimmed = trim({
            history: microd.messages,
            // Enough to cost the long narration and nothing more.
            target: historyTokens(microd.messages) - 400,
            protectedTail: 1,
            displaced: microd.displaced,
        })

        // Every id still referenced by a surviving message is still in the map the ladder will persist.
        const ids = [...trimmed.displaced.values()].map((entry) => entry.id)
        for (const [index, message] of trimmed.messages.entries()) {
            const match = /artifact_read\("([^"]+)"\)/.exec(message.content)
            if (match?.[1] === undefined) continue
            expect(ids).toContain(match[1])
            // And keyed by where the message actually is now, not where it used to be.
            expect(trimmed.displaced.get(index)?.id).toBe(match[1])
        }
        expect(ids.length).toBeGreaterThan(0)
    })

    test("a displacement whose message trim removed is not carried forward", () => {
        const history = [ask("q"), reply("ACTION exec"), observation("exec", 200), ask("newest")]
        const snipped = snip({ history, target: 1, protectedTail: 1 })
        expect(snipped.displaced.size).toBe(1)
        // Target 1 is unreachable, so trim removes every droppable message including the snipped one.
        const trimmed = trim({
            history: snipped.messages,
            target: 1,
            protectedTail: 1,
            displaced: snipped.displaced,
        })
        expect(trimmed.messages.some((m) => m.origin === "observation")).toBe(false)
        expect(trimmed.displaced.size).toBe(0)
    })

    test("trim leaves a digest alone — it runs after both stages that write one", () => {
        const history = [
            {
                role: "user" as const,
                content: "A DIGEST OF EARLIER WORK",
                origin: "digest" as const,
            },
            ask("q"),
            reply(`answer ${"x".repeat(3000)}`),
            ask("newest"),
        ]
        const trimmed = trim({ history, target: 1, protectedTail: 1 })
        expect(trimmed.messages.some((m) => m.content === "A DIGEST OF EARLIER WORK")).toBe(true)
        // The assistant prose is what went.
        expect(trimmed.messages.some((m) => m.role === "assistant")).toBe(false)
    })
})

describe("the protected tail is untouchable", () => {
    // The turn's own trace lives at the end of history while the turn is still running, so a stage
    // that touched it would replace the observation the model is about to reason over — a compaction
    // that breaks the turn it was rescuing.
    const history = session()
    const tail = 3

    const mechanical: [string, (input: StageInput) => StageOutcome][] = [
        ["trim", trim],
        ["snip", snip],
        ["micro", micro],
    ]
    test.each(mechanical)("%s leaves the newest messages alone", (_name, stage) => {
        const outcome = stage({ history, target: 1, protectedTail: tail })
        const kept = outcome.messages.slice(-tail)
        expect(kept).toEqual(history.slice(-tail))
    })

    test("collapse and reset keep it too", () => {
        const digest = "a digest"
        for (const stage of [collapse, reset]) {
            const outcome = stage({ history, target: 1, protectedTail: tail, digest })
            expect(outcome.messages.slice(-tail)).toEqual(history.slice(-tail))
        }
    })

    test("a tail longer than the history is clamped rather than reversing the slice", () => {
        const outcome = snip({ history, target: 1, protectedTail: 99 })
        expect(outcome.changed).toBe(false)
        expect(outcome.messages).toEqual(history)
    })
})

describe("snip cuts the middle and keeps the whole thing", () => {
    test("the observation shrinks, says how much was cut, and the original is displaced", () => {
        const history = session()
        const original = history[4] as ChatMessage
        const outcome = snip({ history, target: 100, protectedTail: 0 })

        expect(outcome.changed).toBe(true)
        const cut = outcome.messages[4] as ChatMessage
        expect(cut.content.length).toBeLessThan(original.content.length)
        expect(cut.content).toContain("cut by compaction")
        // The id, in the marker. Without it the marker invites a retrieval the runtime cannot
        // honour — found live: the model reported there was no id to pass and answered from the
        // fragment instead.
        expect(cut.content).toContain(displacedId(original.content))
        expect(cut.content).toContain("artifact_read")
        // Head and tail both survive: the first line of a tool result says what happened and the last
        // carries the exit status.
        expect(cut.content).toContain("OBSERVATION exec — ok")
        expect(cut.content).toContain("row 119")

        const entries = [...outcome.displaced.values()]
        expect(entries.length).toBe(1)
        expect(entries[0]?.content).toBe(original.content)
        expect(entries[0]?.slug).toBe("exec")
    })

    test("a small observation is left alone — a marker would cost more than the cut saves", () => {
        const history = [ask("q"), reply("a"), observation("now", 1)]
        expect(snip({ history, target: 1, protectedTail: 0 }).changed).toBe(false)
    })

    test("a human message is never cut, however large", () => {
        const huge = ask("x ".repeat(4000))
        const history = [huge, reply("ok")]
        const outcome = snip({ history, target: 10, protectedTail: 0 })
        expect(outcome.changed).toBe(false)
        expect(outcome.messages[0]?.content).toBe(huge.content)
    })
})

describe("micro points at the original, even after a snip", () => {
    test("the pointer names the tool, the size and an id", () => {
        const history = session()
        const outcome = micro({ history, target: 100, protectedTail: 0 })
        const replaced = outcome.messages[4] as ChatMessage
        expect(replaced.content).toContain("compacted exec observation")
        expect(replaced.content).toContain("artifact_read")
        const entry = [...outcome.displaced.values()][0]
        expect(entry).toBeDefined()
        expect(replaced.content).toContain(entry?.id as string)
    })

    test("escalating over the same message converges on one artifact holding the uncut text", () => {
        const history = session()
        const original = history[4] as ChatMessage

        const snipped = snip({ history, target: 100, protectedTail: 0 })
        const micro2 = micro({
            history: snipped.messages,
            target: 100,
            protectedTail: 0,
            displaced: snipped.displaced,
        })

        const entries = [...micro2.displaced.values()]
        // One artifact, not two: `micro` reused the entry `snip` recorded.
        expect(entries.length).toBe(1)
        // And it holds the original observation, not the truncated form. Deriving the id from the text
        // as it then stood would have produced a pointer resolving to the cut version.
        expect(entries[0]?.content).toBe(original.content)
        expect(entries[0]?.id).toBe(displacedId(original.content))
        expect((micro2.messages[4] as ChatMessage).content).toContain(displacedId(original.content))
    })

    test("an id is printable ASCII and stable for the same content", () => {
        const id = displacedId("OBSERVATION exec — ok\nrow 0")
        expect(id).toBe(displacedId("OBSERVATION exec — ok\nrow 0"))
        expect(/^[\x21-\x7e]+$/.test(id)).toBe(true)
        expect(id).not.toBe(displacedId("OBSERVATION exec — ok\nrow 1"))
    })
})

describe("digests", () => {
    /**
     * Turns substantial enough that a digest is a win. `session()` is not: with the request spine kept,
     * collapsing it drops one short reply and adds a digest plus a header, so the no-growth guard
     * refuses — correctly. A stage that is only worth running on a large history should be tested on
     * one.
     */
    function longSession(): ChatMessage[] {
        return [
            ask("first question"),
            reply(`first answer ${"a".repeat(3000)}`),
            ask("second question"),
            reply(`second answer ${"b".repeat(3000)}`),
            ask("third question"),
            reply(`third answer ${"c".repeat(3000)}`),
        ]
    }

    test("collapse keeps the newest turns and prepends the digest", () => {
        const history = longSession()
        const outcome = collapse({ history, target: 10, protectedTail: 0, digest: "THE DIGEST" })
        expect(outcome.changed).toBe(true)
        expect(outcome.messages[0]?.content).toBe("THE DIGEST")
        expect(outcome.messages[0]?.origin).toBe("digest")
        expect(outcome.messages.at(-1)).toEqual(history.at(-1))
    })

    test("collapse keeps every request, including ones inside the span it digested", () => {
        const history = longSession()
        const outcome = collapse({ history, target: 10, protectedTail: 0, digest: "THE DIGEST" })
        for (const asked of ["first question", "second question", "third question"]) {
            expect(outcome.messages.some((m) => m.content === asked)).toBe(true)
        }
        // Framed, and pointing at the digest rather than claiming the detail is unrecoverable.
        expect(outcome.messages.some((m) => m.content.includes("summarised above"))).toBe(true)
    })

    test("a digest longer than what it replaced is refused", () => {
        const history = [ask("a"), reply("b"), ask("c"), reply("d"), ask("e"), reply("f")]
        const outcome = collapse({
            history,
            target: 1,
            protectedTail: 0,
            digest: "x ".repeat(2000),
        })
        // Growing the prompt at the moment the ladder was asked to shrink it is not a compaction.
        expect(outcome.changed).toBe(false)
    })

    test("the mechanical digest states facts and admits what it dropped", () => {
        const text = mechanicalDigest(session())
        expect(text).toContain("tool result")
        expect(text).toContain("exec")
        expect(text).toContain("first question")
        // The instruction matters more than the summary: a model that fills a gap by guessing is worse
        // than one that asks.
        expect(text).toContain("Ask the person rather than guessing")
    })

    test("reset replaces everything before the protected tail, except the requests", () => {
        const history = session()
        const outcome = reset({ history, target: 1, protectedTail: 1, digest: "ALL GONE" })
        expect(outcome.messages[0]?.content).toBe("ALL GONE")
        expect(outcome.messages.at(-1)).toEqual(history.at(-1))
        // The last rung is the one most likely to be reached, and the worst place to be left unable to
        // say what the work was. Pinned blocks survive here, and so do the person's words.
        expect(outcome.messages.filter((m) => m.role === "user" && m.origin === undefined)).toEqual(
            history.filter((m) => m.role === "user" && m.origin === undefined),
        )
        // Nothing else does — outside the protected tail, which is the current turn and untouchable.
        const compacted = outcome.messages.slice(0, -1)
        expect(compacted.some((m) => m.origin === "observation")).toBe(false)
        expect(compacted.some((m) => m.role === "assistant")).toBe(false)
    })
})

describe("the compactor model is asked, never depended on", () => {
    /**
     * Pressure high enough to authorise every stage *and* a target no cheaper stage can reach.
     *
     * The first version of this helper only raised the pressure, and all four tests failed with no
     * digest at all — because `trim` reached the target on its own and the ladder correctly stopped
     * one rung down. Squeezing the history budget to nothing with a large `fixed` is what forces the
     * escalation, and it is a real configuration rather than a contrivance: pinned blocks that consume
     * most of the window leave history nowhere to go.
     */
    async function atFullPressure(
        summarise?: (messages: readonly ChatMessage[]) => Promise<string>,
    ) {
        // The newest turn carries the large observation, so that after `trim` has dropped everything
        // it may there is still enough left for a digest to be *smaller* than what it replaces. Both
        // digest stages refuse to grow the prompt, and on a two-message tail they correctly refuse —
        // which is what the second failure of this helper turned out to be.
        const history = [
            ask("first"),
            reply("a"),
            ask("second"),
            reply("b"),
            ask("third, the one with tools"),
            reply("ACTION exec"),
            observation("exec", 120),
            reply("done"),
        ]
        return runLadder({
            history,
            protectedTail: 1,
            budget: 1_000,
            fixed: 900,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
            ...(summarise === undefined ? {} : { summarise }),
        })
    }

    test("with no compactor configured the digest is mechanical", async () => {
        const result = await atFullPressure()
        expect(result.digestSource).toBe("mechanical")
    })

    test("a compactor that answers is used", async () => {
        const result = await atFullPressure(async () => "a real summary of what happened")
        expect(result.digestSource).toBe("model")
        expect(result.history.some((m) => m.content === "a real summary of what happened")).toBe(
            true,
        )
    })

    test("a compactor that throws does not fail the turn it was rescuing", async () => {
        const result = await atFullPressure(async () => {
            throw new Error("endpoint down")
        })
        expect(result.digestSource).toBe("mechanical")
    })

    test("a compactor that returns nothing is a failed compactor, not an empty digest", async () => {
        // Measured behaviour in this repo more than once: a reasoning model spends its whole output
        // budget thinking and returns empty content. Accepting it would blank a span of history and
        // report success.
        const result = await atFullPressure(async () => "   \n  ")
        expect(result.digestSource).toBe("mechanical")
        expect(result.history[0]?.content.trim()).not.toBe("")
    })
})

describe("ordering", () => {
    test("stages run from the first rung and never skip", async () => {
        const history = session()
        const result = await runLadder({
            history,
            protectedTail: 1,
            budget: historyTokens(history) + 50,
            fixed: 0,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
            summarise: async () => "digest",
        })
        const order = result.stages.map((record) => record.stage)
        // Whatever subset ran, it is a prefix of the validated order. Compared against `STAGE_ORDER`
        // rather than a literal: a hand-copied list is what made this test assert a ladder that no
        // longer existed the moment the stages were reordered.
        expect(order).toEqual([...STAGE_ORDER].slice(0, order.length))
        expect(order[0]).toBe(STAGE_ORDER[0])
    })

    test("only the authorised stages are reachable", async () => {
        const history = session()
        const total = historyTokens(history)
        // Pressure just past `snip`: 0.72 of the budget.
        const result = await runLadder({
            history,
            protectedTail: 1,
            budget: Math.ceil(total / 0.72),
            fixed: 0,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
        })
        const reached = result.stages.map((record) => record.stage)
        // 0.72 crosses `snip` and `micro`. Everything past `micro` is unauthorised — and the two that
        // ask a model are among them, which is the property that keeps a mild overflow offline.
        expect(reached).not.toContain("collapse")
        expect(reached).not.toContain("reset")
        expect(reached).not.toContain("trim")
    })

    test("a stage that changes nothing is recorded as such, and the next one runs", async () => {
        // An observation under `snip`'s keep budget, so `snip` has nothing to cut — but `micro` can
        // still replace the body with a pointer, which is smaller. A stage reporting success for a
        // no-op would stall the ladder one rung too low.
        const history = [ask("q"), reply("ACTION exec"), observation("exec", 20), reply("done")]
        const total = historyTokens(history)
        const result = await runLadder({
            history,
            protectedTail: 0,
            budget: Math.ceil(total / 0.72),
            fixed: 0,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
        })
        const records = new Map(result.stages.map((record) => [record.stage, record]))
        expect(records.get("snip")?.changed).toBe(false)
        expect(records.get("micro")?.changed).toBe(true)
    })

    test("falling short is reported rather than hidden", async () => {
        // No observation to snip or pointer, no span to digest, and the protected tail is the whole
        // history — so every rung is authorised and none of them can do anything.
        const history = [ask("a".repeat(4000)), reply("b".repeat(4000))]
        const total = historyTokens(history)
        const result = await runLadder({
            history,
            protectedTail: history.length,
            budget: Math.ceil(total / 0.72),
            fixed: 0,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
        })
        expect(result.fellShort).toBe(true)
        expect(result.history).toEqual(history)
    })
})

describe("the calibration is applied to the pressure", () => {
    test("a history the estimator undercounts crosses a threshold it otherwise would not", async () => {
        const history = session()
        const total = historyTokens(history)
        // Raw estimate sits at 0.55 — below every threshold. Corrected by the measured ~1.2 ratio it
        // is 0.66, which crosses `trim`. This is the whole reason the anchor exists: the estimator
        // runs low on observation-heavy prompts, and low is the overflow direction.
        const budget = Math.ceil(total / 0.55)
        const quiet = await runLadder({
            history,
            protectedTail: 1,
            budget,
            fixed: 0,
            thresholds: THRESHOLDS,
            calibration: UNCALIBRATED,
        })
        expect(quiet.stages).toEqual([])

        const corrected = await runLadder({
            history,
            protectedTail: 1,
            budget,
            fixed: 0,
            thresholds: THRESHOLDS,
            calibration: { ratio: 1.2, samples: 8 },
        })
        expect(corrected.stages.length).toBeGreaterThan(0)
        expect(corrected.before).toBeGreaterThan(quiet.before)
    })
})
