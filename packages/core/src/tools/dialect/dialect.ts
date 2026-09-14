/**
 * The dialect seam: how tools are described to a model, and how its output is read back.
 *
 * Which dialect runs is **configuration, never detection**. Reading the model id and picking a
 * dialect would mean behaviour changing silently when someone edits `model.main.id` — one code
 * path in production is worth more than the convenience, and a per-provider difference nobody can
 * reproduce is the bug class this avoids.
 *
 * NLT is the default, on published evidence rather than taste: across 14 models and 8,560 trials,
 * +14.9pp accuracy, 93% fewer critical errors, −25% tokens, and +24 to +43pp on small models
 * specifically. Frontier models show smaller or reversed gains, which is what `native` is for.
 */

import type { ContextBlock } from "../../context/blocks.ts"
import type { ChatMessage, ToolCallRequest, ToolDefinition } from "../../model/provider.ts"
import type { FieldError, ToolAvailability, ToolIntent, ToolResult, ToolSpec } from "../types.ts"

export type DialectId = "nlt" | "native"

/**
 * What one model call produced, before a dialect has interpreted it.
 *
 * Both halves, always, because *which* half carries the protocol is exactly what a dialect decides.
 * Under NLT the call is text and `calls` is empty; under `native` the call is in `calls` and the text
 * is only prose. Handing a dialect one half would mean the loop had already guessed.
 */
export interface StepOutput {
    readonly text: string
    readonly calls: readonly ToolCallRequest[]
}

export interface ParsedOutput {
    /** In the order the model wrote them. Empty means the step's text is the final reply. */
    readonly intents: readonly ToolIntent[]
    /** Everything outside the invocation blocks — what the user sees. */
    readonly text: string
    /**
     * The output could not be read at all — present only where that is possible.
     *
     * `native` sets it when the `arguments` document is not JSON — a truncated one is unrecoverable by
     * any amount of tolerance. It exists rather than being folded into "no arguments" because a tool
     * with no required fields would then run, with no arguments, having been asked for something else
     * entirely — a wrong action taken silently.
     *
     * NLT sets it in two cases, and the second carries *intents alongside it*.
     *
     * **Nothing parsed and the prose is markup** from some other tool-calling protocol. A model that
     * invents `<TOOL_CALL>` or its own vendor tokens has attempted a call, and with nothing here the
     * markup becomes the reply — shown to the person as prose, no repair asked for, no event fired,
     * the turn recorded as a clean answer. The parser stays tolerant of *readable* variations; this
     * is for the ones no tolerance could enumerate.
     *
     * **A block parsed but one of its values arrived damaged** — it spans lines without `<<<` / `>>>`,
     * so the continuation branch stripped its indentation, or it opens a shell heredoc whose
     * terminator never arrived, so it was cut at a blank line and the rest became the reply. Both were
     * measured against a real endpoint at a combined 4 of 16 attempts on `exec`, and both produced a
     * clean answer with a half-written command *executed*. A reader who assumes `malformed` implies
     * `intents.length === 0` will drop the call the repair is about; the loop reads them together and
     * makes the step all-or-nothing.
     */
    readonly malformed?: readonly FieldError[]
}

/**
 * Turns a stream of model deltas into a stream of text safe to show a person.
 *
 * Needed because with a line-oriented dialect the invocation *is* text: printing `model.chunk`
 * deltas straight through leaks `ACTION:` and `END` into the reply and runs them into the answer that
 * follows. Every consumer has the problem — the CLI, the server's SSE clients, a TUI — so it belongs
 * here rather than in any one of them.
 *
 * Stateful and single-use: one per turn, or the block it was halfway through leaks into the next.
 */
export interface StreamFilter {
    /** Text to show now, possibly empty. Never contains part of an invocation block. */
    push(delta: string): string
    /**
     * One step finished; the next is about to start.
     *
     * Two things happen here that a caller would otherwise have to reinvent. A step's output ends
     * without a line break, so a filter carried straight across the boundary glues the next step's
     * first word onto this one's `END`. And the loop joins each step's prose with a blank line, so
     * that break is queued here — and held, so it appears only if the next step actually speaks.
     */
    endStep(): string
    /** The turn is over. Whatever was held back and turned out to be prose after all. */
    end(): string
}

/** For a dialect with no in-band protocol, and for an agent with no tools. Holds nothing back. */
export function passThroughFilter(): StreamFilter {
    return {
        push: (delta) => delta,
        endStep: () => "",
        end: () => "",
    }
}

export interface ToolDialect {
    readonly id: DialectId
    /**
     * Slot 1 of the context, pinned and inside cache breakpoint A. Must be byte-stable for a
     * given catalogue: anything varying per turn here silently destroys prompt caching.
     *
     * Empty under `native`, where the catalogue travels in the request instead. See `wireTokens`.
     */
    renderCatalogue(
        specs: readonly ToolSpec[],
        notEnabled?: readonly ToolAvailability[],
    ): readonly ContextBlock[]
    /**
     * The request's `tools` parameter, or `undefined` for a dialect whose protocol is text.
     *
     * The other half of "one schema, two renderings": the same `ToolSpec` becomes prose here or a
     * wire schema there, and never two hand-written descriptions that can disagree.
     */
    requestTools(specs: readonly ToolSpec[]): readonly ToolDefinition[] | undefined
    parse(output: StepOutput): ParsedOutput
    /** One per turn. Built on the same grammar as `parse`, so the two cannot disagree. */
    createStreamFilter(): StreamFilter
    /**
     * The assistant message recording what the model just did, for the next call to read back.
     *
     * A dialect method rather than a line in the loop because the two answers differ in kind: NLT
     * replays the raw text, blocks and all, since that text *is* the call. `native` replays the
     * prose plus the structured calls, and dropping them would leave the following `tool` messages
     * answering calls no message in the history contains — which most endpoints reject outright.
     */
    renderCall(output: StepOutput): ChatMessage
    /**
     * A step's results, in call order.
     *
     * A list rather than one message because `native` requires one `tool` message per call, each
     * naming the id it answers. NLT returns a single message: one per result would repeat the
     * "continue or reply" instruction after every observation.
     */
    renderObservation(results: readonly ToolResult[]): readonly ChatMessage[]
    /**
     * The single repair prompt. There is never a second one.
     *
     * Takes the step's output, not the parsed intents. Under `native` every call the assistant message
     * announced must be answered before the next assistant turn — an unanswered `tool_calls` entry is
     * a protocol error — and the calls that need answering include the ones too malformed to become
     * intents at all. Those are precisely the calls a repair is most often about.
     */
    renderRepair(errors: readonly FieldError[], output: StepOutput): readonly ChatMessage[]
}
