/**
 * The conversation a resumed session paints, out of the messages the store kept.
 *
 * Pure, and extracted from `run` for one reason: it was four chained lambdas inside a function that
 * needs a live runtime to call, so the only way to check it was to resume a real session and look. The
 * shape it decides has already been wrong twice — first painting nothing at all under a banner that
 * said `17 message(s)`, then painting every turn except the ones that called a tool — and both times
 * the layers around it were individually correct.
 *
 * What counts as part of the conversation:
 *
 * - No `origin` — a person's message, or a reply the model wrote as its final answer.
 * - `origin: "call"` — a tool-calling step. Its prose is narration the live session *did* show as it
 *   streamed, so excluding the row made a resumed transcript differ from the one that had been on
 *   screen. Under NLT the row also holds the ACTION block, which `proseOf` removes.
 *
 * What does not, and why each is deliberate rather than unhandled:
 *
 * - `origin: "observation"` — text a stranger wrote. It reaches the model inside a fence; painting it
 *   as part of the conversation would present it as something the agent or the person said.
 * - `origin: "repair"` and `origin: "digest"` — the runtime talking to itself about a malformed call
 *   or a compacted history. True of the prompt, not of anything anybody said.
 * - `role: "system"` and `role: "tool"` — the assembled prefix and native tool results, neither of
 *   which was ever on screen.
 */

import type { ChatMessage, DialectId } from "@dispach/core"
import { BRAND, proseOf } from "@dispach/core"
import { DIM_STYLE, RESET_STYLE } from "#lib/const"
import type { PriorMessage } from "#transcript"

/**
 * `history` in order, reduced to what a reader saw. Empty prose is dropped, not painted blank.
 *
 * A step that called a tool without narrating it produces no text at all, and a blank message row in a
 * resumed transcript reads as content that failed to load.
 */
export function priorMessages(
    history: readonly ChatMessage[],
    dialect: DialectId,
): readonly PriorMessage[] {
    const shown: PriorMessage[] = []
    for (const message of history) {
        if (message.origin !== undefined && message.origin !== "call") continue
        if (message.role !== "user" && message.role !== "assistant") continue
        const text = proseOf(message, dialect)
        if (text === "") continue
        shown.push({ role: message.role, text })
    }
    return shown
}

/**
 * The note a clean exit leaves on the shell's own screen.
 *
 * Nothing else survives. That was the decision and the alternate screen enforces it whether we agree or
 * not — so the one thing worth printing is not the conversation, which is in the store, but the command
 * that reaches it again.
 *
 * Two lines and faint, which is a change from the one bright line this used to be. The old form led with
 * `session <key> ·` and buried the command behind `resume with:`, so the half a person needs to *copy*
 * sat at the end of a sentence they had to read first. The key is not lost by dropping the prefix — it is
 * inside the command, which is the only place it is any use. And faint because this is the epilogue: the
 * work is over, and a line as loud as the output above it reads as one more result.
 *
 * The agent is named by the ref `resolveAgentRef` accepts rather than by a path, because a line you
 * cannot paste is a line that reads as help and is not.
 */
export function resumeNotice(input: {
    readonly ref: string | undefined
    readonly sessionKey: string
}): string {
    // Named rather than omitted when the id is missing: a command with a placeholder in it says what is
    // wanted where it is wanted, and a command silently missing its agent looks complete and is not.
    const ref = input.ref ?? "<your agent>"
    const command = `${BRAND.slug} run ${ref} --session ${input.sessionKey}`
    // The blank line above separates it from whatever the shell had on screen before the session took it.
    // The reset precedes the last newline so the prompt after it is not faint.
    return `\n${DIM_STYLE}Resume this session with:\n${command}${RESET_STYLE}\n`
}

/**
 * Why a banner is being printed, as the one sentence a person reads.
 *
 * Four answers, and they are genuinely different things to say: a `/restart` is about *configuration*
 * and would be a lie about a switch; a `/new` opened a conversation that did not exist a moment ago,
 * and the only thing worth saying about it is what happened to the one being left.
 *
 * Extracted from `bannerLines` because that function needs a live agent and a store to call, so the
 * sentence selection — the only part a person actually reads — could not be checked without resuming a
 * real session and looking. Exactly the reason `priorMessages` above lives here.
 *
 * The return is `undefined` for a first run: nothing has happened yet that needs explaining.
 */
export function reopenNote(
    reopened: "first" | "restart" | "switch" | "new",
    previousKey?: string,
): string | undefined {
    switch (reopened) {
        case "first":
            return undefined
        case "restart":
            return "restarted — the configuration on disk is now the one in force; the conversation continues from the store."
        case "switch":
            // What was left behind is worth naming: the previous conversation is still in the store, and
            // the key in the banner above is the one that reaches this one again.
            return "switched conversation — the one you left is still in the store, under its own key."
        case "new":
            // By name, unlike the switch sentence. After a `/new` the conversation you left is on screen
            // nowhere — the picker lists it, but only once you know to go looking — and the whole promise
            // of the command is that nothing was destroyed. Claiming that without naming the key is
            // asking to be taken on trust.
            return previousKey === undefined
                ? "new conversation — the one you left is still in the store, under its own key."
                : `new conversation — the one you left is ${previousKey}, still in the store. /sessions goes back to it.`
    }
}
