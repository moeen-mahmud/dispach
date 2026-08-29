/**
 * One step: one model call plus the tool executions it triggers.
 *
 * Phase 1 has no tools, so a step is a single model call whose text is the reply. The shape is
 * already the shape the tool loop needs — parse, execute, observe slot into `runStep`'s caller
 * rather than into `runStep` itself — so Phase 3 adds a dialect and an executor without
 * reorganizing this.
 */

import type { EventBus } from "../events/bus.ts"
import type { EventContext } from "../events/types.ts"
import type {
    ChatMessage,
    ModelProvider,
    ToolCallRequest,
    ToolDefinition,
} from "../model/provider.ts"
import type { ResolvedRole } from "../model/roles.ts"

export interface StepInput {
    readonly role: ResolvedRole
    readonly provider: ModelProvider
    readonly messages: readonly ChatMessage[]
    readonly params: { temperature?: number; topP?: number; maxTokens?: number }
    readonly promptTokens: number
    /** Wire-level tool definitions. Present under `native`, absent under a text dialect. */
    readonly tools?: readonly ToolDefinition[]
    readonly bus: EventBus
    readonly context: EventContext
    readonly signal: AbortSignal
    readonly attempt?: number
}

export interface StepResult {
    readonly text: string
    readonly reasoning: string
    readonly finishReason: string
    readonly promptTokens: number
    /**
     * Whether `promptTokens` came from the endpoint or from our own estimator.
     *
     * It has to be said explicitly, because the field is *seeded* with the estimate and overwritten
     * only if a `usage` chunk arrives — so the two are indistinguishable by value, and a caller
     * calibrating the estimator against this number would be calibrating it against itself. That
     * failure is silent and self-congratulatory: the correction converges instantly on 1.0 and every
     * accuracy check passes by construction.
     *
     * A `usage` object with no `prompt_tokens` field decodes to 0 (`chat-completions.ts:248`), which
     * is why this is keyed on a positive count rather than on the chunk's arrival.
     */
    readonly promptTokensReported: boolean
    /**
     * Prompt tokens the endpoint served from cache, when it said so.
     *
     * Undefined means the endpoint reported no figure — which is most of them, and is deliberately
     * distinct from a reported zero. Unlike `promptTokens` this is never seeded with an estimate:
     * there is nothing to estimate it from, and a guessed cache ratio is worse than none.
     */
    readonly cachedPromptTokens?: number
    readonly cacheSource?: string
    readonly outputTokens: number
    readonly latencyMs: number
    /**
     * Calls the transport reported structurally. Always empty under NLT, where a call *is* text and
     * `text` carries it — which is why the dialect gets both and decides which one it reads.
     */
    readonly calls: readonly ToolCallRequest[]
    /** True when the signal fired before the stream finished. */
    readonly aborted: boolean
}

export async function runStep(input: StepInput): Promise<StepResult> {
    const started = performance.now()

    input.bus.emit(
        "model.call",
        {
            role: input.role.role,
            model: input.role.config.id,
            promptTokens: input.promptTokens,
            // Prompt caching lands with slot 1 and the breakpoint placement it implies; reporting
            // `false` now is honest, whereas omitting the field would make the event schema move.
            cached: false,
            attempt: input.attempt ?? 1,
        },
        input.context,
    )

    let text = ""
    let reasoning = ""
    let finishReason = ""
    let promptTokens = input.promptTokens
    let promptTokensReported = false
    let cachedPromptTokens: number | undefined
    let cacheSource: string | undefined
    let reportedOutputTokens: number | undefined
    const calls: ToolCallRequest[] = []

    const stream = input.provider.chat(
        {
            model: input.role.config.id,
            messages: input.messages,
            ...(input.tools === undefined ? {} : { tools: input.tools }),
            ...input.params,
        },
        input.signal,
    )

    try {
        for await (const chunk of stream) {
            switch (chunk.type) {
                case "text":
                    text += chunk.delta
                    input.bus.emit(
                        "model.chunk",
                        { delta: chunk.delta, kind: "text" },
                        input.context,
                    )
                    break
                case "reasoning":
                    reasoning += chunk.delta
                    input.bus.emit(
                        "model.chunk",
                        { delta: chunk.delta, kind: "reasoning" },
                        input.context,
                    )
                    break
                case "tool_call":
                    // No `model.chunk` for these. There is nothing a person would read — a JSON
                    // argument document is not prose — and the call becomes visible as `tool.call`
                    // the moment the executor starts it, which is the same row NLT produces.
                    calls.push(chunk.call)
                    break
                case "usage":
                    // The API-reported number is authoritative; the local estimate was a stand-in.
                    promptTokens = chunk.promptTokens
                    promptTokensReported = chunk.promptTokens > 0
                    reportedOutputTokens = chunk.completionTokens
                    // Assigned only when present, so an endpoint that reports usage without a cache
                    // field leaves this undefined rather than claiming a measured zero.
                    if (chunk.cachedPromptTokens !== undefined) {
                        cachedPromptTokens = chunk.cachedPromptTokens
                        cacheSource = chunk.cacheSource
                    }
                    break
                case "finish":
                    finishReason = chunk.reason
                    break
            }
        }
    } catch (error) {
        // Aborting a fetch makes the pending `reader.read()` reject, so cancellation reaches this
        // loop as an exception. Rethrowing it would lose `text` — the caller never gets to add the
        // partial reply — and would report a deliberate stop as a failure. `turn.ts` states the
        // rule this restores: cancellation is a state, not an exception. Anything that is *not* a
        // cancellation still propagates untouched.
        if (!input.signal.aborted) throw error
    }

    const latencyMs = Math.round(performance.now() - started)
    const aborted = input.signal.aborted
    const outputTokens = reportedOutputTokens ?? Math.ceil(text.length / 3.8)

    input.bus.emit(
        "model.result",
        {
            outputTokens,
            promptTokens,
            finishReason: finishReason === "" ? (aborted ? "aborted" : "stop") : finishReason,
            latencyMs,
        },
        input.context,
    )

    return {
        text,
        reasoning,
        finishReason,
        promptTokens,
        promptTokensReported,
        ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
        ...(cacheSource === undefined ? {} : { cacheSource }),
        outputTokens,
        latencyMs,
        calls,
        aborted,
    }
}
