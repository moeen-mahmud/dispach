/**
 * Which stages run, and how far down each one aims.
 *
 * `context.thresholds` has been in the manifest since Phase 1 — defaulted, range-checked and
 * order-checked by `manifest/validate.ts` — and read by nothing. This is what reads it.
 *
 * ## Each stage aims one rung down, using the manifest's own numbers
 *
 * A stage needs a target, and the two obvious choices are both wrong. Aiming to get *just* under the
 * threshold that fired means landing on it and firing again next turn, which is thrash — and S5
 * firing twice in a session is a documented misconfiguration, so thrash has to be prevented
 * structurally rather than warned about. Aiming at some fixed comfortable level means a prompt at 96%
 * destroys as much as it takes to reach 55%, which is the "severe loss" half of the known-bad design
 * decision 5.1 rejects.
 *
 * So the target is **the threshold of the stage below the deepest one that fired**. At 0.72 pressure
 * the deepest exceeded threshold is `micro` (0.70), so the target is `snip`'s 0.60. At 0.96 it is
 * `reset` (0.95), so the target is `collapse`'s 0.88. Every compaction moves the session down exactly
 * one rung, which gives hysteresis without a constant and spends only the fidelity that rung costs.
 * `snip` is the floor and has nothing below it, hence the one margin below.
 *
 * ## Which stages are allowed
 *
 * Only those whose own threshold has been crossed, and always **in order from the first** — the
 * validator guarantees the order is ascending, and skipping a rung is how a mild overflow gets a
 * digest it did not need. So at 0.72 the ladder may use `snip` and `micro` and nothing more; if those
 * two cannot reach 0.60 it stops and says so, rather than reaching for a tool the pressure has not
 * authorised.
 *
 * ## The model is asked at S4 and S5 only, and never depends on
 *
 * `summarise` is supplied by the caller, which is where the `compactor` role lives. It is optional,
 * and a rejection is caught: a compaction that throws has failed the turn it existed to rescue, so
 * both the absent and the broken case fall through to `mechanicalDigest`. `digestSource` reports which
 * one happened, because "the digest is thin" and "the compactor is unreachable" need different fixes.
 */

import type { ChatMessage } from "../../model/provider.ts"
import { type Calibration, corrected } from "../budget.ts"
import {
    collapse,
    type Displaced,
    historyTokens,
    mechanicalDigest,
    micro,
    reset,
    STAGE_ORDER,
    type StageName,
    type StageOutcome,
    snip,
    trim,
} from "./stages.ts"

/**
 * How far below the first stage's own threshold that stage aims.
 *
 * The one margin the scheme needs, because the first rung has nothing beneath it to borrow a number
 * from. Five points of the budget: enough that a turn or two of ordinary growth does not re-fire the
 * ladder, small enough that the cheapest stage is not asked to throw away a quarter of the
 * conversation.
 *
 * Named for the position rather than the stage. It was `TRIM_MARGIN` while `trim` was first, which
 * made a fact about the floor read as a fact about one stage — and then `trim` moved.
 */
const FLOOR_MARGIN = 0.05

export type Thresholds = Readonly<Record<StageName, number>>

export interface StageRecord {
    readonly stage: StageName
    /** Estimated history tokens before and after. Reported on `compaction.stage`. */
    readonly before: number
    readonly after: number
    readonly changed: boolean
}

export interface LadderInput {
    /** Oldest first. */
    readonly history: readonly ChatMessage[]
    /** Newest messages that must not be altered — the current turn's trace. */
    readonly protectedTail: number
    /** `window - reserveOutput`, in tokens. */
    readonly budget: number
    /** Estimated tokens of everything that is not history: pinned blocks, input, wire tools. */
    readonly fixed: number
    readonly thresholds: Thresholds
    /** What the estimator has learned about its own bias. */
    readonly calibration: Calibration
    /** The `compactor` role, when one is configured. Absent and failing are handled alike. */
    readonly summarise?: (messages: readonly ChatMessage[], signal: AbortSignal) => Promise<string>
    /**
     * The turn's signal, forwarded to `summarise`.
     *
     * Optional so a test can call the ladder without one; when absent, `digestFor` supplies a signal
     * that is never aborted — which is exactly the old behaviour, and is why this is a parameter
     * rather than something the ladder invents.
     */
    readonly signal?: AbortSignal
}

export interface LadderResult {
    readonly history: readonly ChatMessage[]
    /** Content to persist so the pointers in `history` resolve. */
    readonly displaced: readonly Displaced[]
    /** Every stage attempted, in the order it ran. A `changed: false` entry is why the next one ran. */
    readonly stages: readonly StageRecord[]
    /** Pressure before and after, as fractions of the budget. */
    readonly before: number
    readonly after: number
    /** True when every authorised stage ran and the target was still not met. */
    readonly fellShort: boolean
    /** Absent when no digest was needed. */
    readonly digestSource?: "model" | "mechanical"
}

/** Corrected prompt cost of a history, as a fraction of the budget. */
function fractionOf(input: LadderInput, history: readonly ChatMessage[]): number {
    if (input.budget <= 0) return 0
    return corrected(input.calibration, input.fixed + historyTokens(history)) / input.budget
}

/**
 * The history-token ceiling that corresponds to a target fraction of the budget.
 *
 * Two conversions, in this order: the fraction is of the *charged* prompt, so it is divided back
 * through the calibration ratio to reach estimated tokens, and the fixed part is then subtracted
 * because only history can be compacted. Floored at zero — a manifest whose pinned blocks already
 * exceed the target leaves no history budget at all, and that is a real configuration rather than an
 * error for the ladder to raise.
 */
function historyTargetFor(input: LadderInput, fraction: number): number {
    const ratio = input.calibration.samples === 0 ? 1 : input.calibration.ratio
    const chargedCeiling = fraction * input.budget
    const estimatedCeiling = ratio <= 0 ? chargedCeiling : chargedCeiling / ratio
    return Math.max(0, Math.floor(estimatedCeiling - input.fixed))
}

/** The deepest stage whose threshold the current pressure has crossed, if any. */
export function deepestStage(
    thresholds: Thresholds,
    fraction: number,
): { readonly stage: StageName; readonly index: number } | undefined {
    let found: { stage: StageName; index: number } | undefined
    for (const [index, stage] of STAGE_ORDER.entries()) {
        if (fraction > thresholds[stage]) found = { stage, index }
    }
    return found
}

/**
 * The fraction a compaction aims at: the threshold one rung below the deepest stage that fired.
 *
 * Exported because it is the scheme's whole content and belongs in a test of its own rather than
 * inside the loop that uses it.
 */
export function targetFraction(thresholds: Thresholds, deepestIndex: number): number {
    const below = STAGE_ORDER[deepestIndex - 1]
    // Read the floor off `STAGE_ORDER` rather than naming a stage. Hard-coding `trim` was correct only
    // while `trim` happened to be first, and it went on type-checking after it was not.
    if (below === undefined) return Math.max(0, thresholds[STAGE_ORDER[0]] - FLOOR_MARGIN)
    return thresholds[below]
}

async function digestFor(
    input: LadderInput,
    messages: readonly ChatMessage[],
): Promise<{ readonly text: string; readonly source: "model" | "mechanical" }> {
    if (input.summarise === undefined) {
        return { text: mechanicalDigest(messages), source: "mechanical" }
    }
    try {
        const text = await input.summarise(messages, input.signal ?? new AbortController().signal)
        // An empty digest is a failed digest. An endpoint that returns nothing — a reasoning model
        // that spent its whole output budget thinking, which this repo has measured more than once —
        // would otherwise replace a span of history with a blank message and report success.
        if (text.trim() === "") return { text: mechanicalDigest(messages), source: "mechanical" }
        return { text, source: "model" }
    } catch {
        // Deliberately swallowed. The alternative is a compaction that throws, which fails the turn
        // it was called to rescue — strictly worse than a thinner digest, and rule 8 is satisfied
        // because `digestSource` reports it and the caller emits it.
        return { text: mechanicalDigest(messages), source: "mechanical" }
    }
}

/**
 * Run the ladder.
 *
 * Returns the input unchanged, with no stage records, when nothing is over its threshold — the
 * common case on the common turn, and it must cost nothing.
 */
export async function runLadder(input: LadderInput): Promise<LadderResult> {
    const before = fractionOf(input, input.history)
    const deepest = deepestStage(input.thresholds, before)

    if (deepest === undefined) {
        return {
            history: input.history,
            displaced: [],
            stages: [],
            before,
            after: before,
            fellShort: false,
        }
    }

    const target = historyTargetFor(input, targetFraction(input.thresholds, deepest.index))

    let history = input.history
    let displaced: ReadonlyMap<number, Displaced> = new Map()
    const stages: StageRecord[] = []
    let digestSource: "model" | "mechanical" | undefined

    for (const stage of STAGE_ORDER.slice(0, deepest.index + 1)) {
        const currentTokens = historyTokens(history)
        if (currentTokens <= target) break

        const stageInput = {
            history,
            target,
            protectedTail: input.protectedTail,
            displaced,
        }

        let outcome: StageOutcome
        if (stage === "trim") outcome = trim(stageInput)
        else if (stage === "snip") outcome = snip(stageInput)
        else if (stage === "micro") outcome = micro(stageInput)
        else {
            // The span a digest will replace, so the summariser sees what it is summarising rather
            // than the whole history including the part that survives.
            const span = history.slice(
                0,
                Math.max(0, history.length - Math.max(0, input.protectedTail)),
            )
            const digest = await digestFor(input, span)
            digestSource = digest.source
            outcome =
                stage === "collapse"
                    ? collapse({ ...stageInput, digest: digest.text })
                    : reset({ ...stageInput, digest: digest.text })
        }

        stages.push({
            stage,
            before: currentTokens,
            after: outcome.tokens,
            changed: outcome.changed,
        })
        history = outcome.messages
        displaced = outcome.displaced
    }

    const after = fractionOf(input, history)
    return {
        history,
        displaced: [...displaced.values()],
        stages,
        before,
        after,
        fellShort: historyTokens(history) > target,
        ...(digestSource === undefined ? {} : { digestSource }),
    }
}
