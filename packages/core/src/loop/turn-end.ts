/**
 * What a turn's ending says to a person, and whether it counts as a failure.
 *
 * One module because the two output paths must not disagree. The rich transcript and the plain REPL
 * each reported endings in their own words, and neither reported most of them: `stats.reason` reached
 * the transcript and was never rendered, so a turn stopped by its step budget was pixel-identical to
 * a completed one; the plain path had a sentence for `max_steps` and printed it only when the reply
 * was *empty*, which is why a real agent could stop mid-task on "Let me install it" and say nothing.
 *
 * In core rather than in the CLI because core owns the reasons and there is a third caller: a channel
 * turn that produced no prose used to deliver *nothing at all* (`channels.ts` returns on empty text),
 * so somebody waiting on Telegram saw silence where the runtime had a sentence.
 *
 * Pure, and color-free like every other formatter — these lines are read from log files and sent to
 * chat clients as often as they are printed at a terminal.
 */

import type { TurnEndReason } from "../events/types.ts"

/** Everything the sentence can draw on. Optional throughout: a channel has no elapsed clock. */
export interface EndContext {
    readonly steps?: number
    readonly durationMs?: number
    /** Milliseconds since the cancel was requested, for `stopped` at a terminal. */
    readonly cancelledAfterMs?: number
}

/**
 * Did the work finish?
 *
 * Everything except `final` and `stopped`. `truncated` counts even though the text is delivered — half
 * a reply reads as a whole one to anything that is not a person watching a terminal. `timeout` counts
 * because a timed-out turn exited **0** for six phases: `turnTimeout` existed with a hint in it and
 * was never called, so the plain path printed "(timed out after N ms)" and reported success. `stopped`
 * is the one exclusion, and it is the only ending somebody asked for.
 */
export function endedBadly(reason: TurnEndReason): boolean {
    return reason !== "final" && reason !== "stopped"
}

/**
 * The line a person reads, or `undefined` when the turn simply finished.
 *
 * Each ending names the remedy rather than the mechanism, because the mechanism is not actionable:
 * "say continue" is what somebody does next, and the budget that stopped it is a detail they need
 * only if continuing does not work.
 */
export function endNote(reason: TurnEndReason, context: EndContext = {}): string | undefined {
    switch (reason) {
        case "final":
            return undefined
        case "max_steps": {
            const steps = context.steps === undefined ? "" : ` after ${context.steps} steps`
            return `stopped${steps} without finishing — say "continue" to carry on, or raise limits.maxSteps`
        }
        case "no_progress":
            return 'stopped: the same tool call was repeated with no change — say "continue" with more to go on, or check whether that tool is telling it anything useful'
        case "truncated":
            return "the reply was cut off at the output limit — raise model.<role>.maxTokens, or ask for less"
        case "timeout":
            return `timed out${context.durationMs === undefined ? "" : ` after ${context.durationMs} ms`} — raise limits.turnTimeoutMs`
        case "stopped":
            return context.cancelledAfterMs === undefined
                ? "cancelled"
                : `cancelled after ${context.cancelledAfterMs.toFixed(0)} ms`
        case "error":
            // The `error` event carries code, message and hint, and both paths render it in full.
            // A second sentence here would be a worse duplicate of a better one.
            return undefined
    }
}
