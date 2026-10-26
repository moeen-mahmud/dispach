/**
 * A step that ends the turn without doing what the turn needs: no visible reply after a tool result, or a
 * promise to act with no call (decision 14.123).
 *
 * Both were measured as the main way small and mid-size models fail here. qwen3.5-9b wrote its answer
 * inside its reasoning and emitted its end-of-turn token there, so 16 of its 49 failures had an empty
 * reply; Hermes saw the same on 114 of 498 responses and recovered by nudging once. Under NLT, Grok 4.7
 * wrote "I'll store it under `locker_code`." and stopped, writing the ACTION block on 0 of 8 replays of a
 * two-step task. The loop now answers that once with a framed note and gives up honestly after.
 */

import type { ChatMessage } from "../model/provider.ts"
import type { ToolResult } from "../tools/types.ts"

export type Silence = "empty" | "promise" | "claim"

/**
 * An announcement of the model's own next action as the last sentence. "Let me know" is a closing, not an
 * action, and a question is asking rather than promising, so neither counts.
 */
const PROMISE =
    /^(?:(?:ok(?:ay)?|now|next|first|sure)[,:]?\s+)?(?:i['’]ll|i will|let me|i['’]m going to|i am going to)\b(?!\s+know\b)/i

/**
 * A report that something was done: "I've saved it under meal_limit", "I sent Dmitri the alert". Only acted
 * on when nothing that changes anything ran this turn, which the loop knows and the reply does not.
 */
const CLAIM =
    /\b(?:i['’]ve|i have|i)\s+(?:just\s+|now\s+|also\s+)?(?:saved|stored|sent|written|wrote|updated|recorded|messaged|notified|set|turned|deleted|created|scheduled)\b/i

/**
 * Why this step needs a nudge, or `undefined` when it is a reply. `acted` is whether a mutating tool
 * succeeded this turn: a claimed save with no save behind it is the one shape here that misleads the person.
 *
 * A promise is only a promise when nothing has acted. After a real save, "I'll keep them short" is a
 * commitment about later turns, and nudging it told the model no call was made right after one
 * succeeded, so it concluded the runtime was lying to it.
 */
export function silenceOf(
    text: string,
    trace: readonly ChatMessage[],
    acted = false,
): Silence | undefined {
    const visible = text.trim()
    if (visible === "") {
        // A first-step empty reply is something else: the reasoning budget, which has its own error.
        return trace.some((message) => message.origin === "observation") ? "empty" : undefined
    }
    if (!acted && CLAIM.test(visible)) return "claim"
    const sentences = visible.split(/(?<=[.!?])\s+/)
    const last = (sentences.at(-1) ?? "").trim()
    if (last.endsWith("?")) return undefined
    return !acted && PROMISE.test(last) ? "promise" : undefined
}

/** The note the loop sends, framed as the runtime's so it cannot read as the person's words. */
export const SILENCE_NOTE: Readonly<Record<Silence, string>> = {
    empty: "From the runtime, not the person: your last response had no visible text, so nothing reached them. You have the tool result above. Answer them now, or make the call you need.",
    promise:
        "From the runtime, not the person: you said you would do that, but no tool call was made, so nothing happened. Make the call now, or tell them plainly why you cannot.",
    claim: "From the runtime, not the person: your reply says it is done, but nothing that saves, sends or changes anything ran in this turn, so it was not done. Make the call now, or tell them it was not done.",
}

/** Identical calls let past the repeat guard per signature, per turn, after a temporary failure (14.127). */
export const TRANSIENT_RETRIES = 2

/**
 * The failure's own words say it is temporary. Read from `error.message`, which carries what the tool or
 * server said, and never from `output`: the MCP hint appended there tells the model *how* to judge a
 * failure ("if they say the failure is temporary, retry once"), so matching the whole output would call
 * every MCP failure temporary and switch the guard off.
 */
export function failedTransiently(result: ToolResult): boolean {
    if (result.ok || result.error === undefined) return false
    return /temporar|try again|retry later|unavailable|timed out|rate.?limit|overloaded|\b(429|503)\b/i.test(
        result.error.message,
    )
}
