/**
 * ConverseStream events as `ChatChunk`s.
 *
 * Content arrives in indexed blocks — text, a tool use whose input streams as JSON fragments, or
 * reasoning whose signature arrives last — so a block's structured chunk is emitted at its
 * `contentBlockStop`, the way chat-completions reassembles a tool call before handing it over. Text
 * and reasoning still stream as deltas, so a person watching sees the reply as it forms.
 *
 * **Usage.** Converse reports `inputTokens` net of cached tokens, as Anthropic does; the runtime's
 * `promptTokens` is the whole prompt, since that is what fills the window. So the prompt figure is
 * input + cache read + cache write, and the two cache figures travel beside it.
 */

import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime"
import type { ChatChunk } from "@dispach/core"

const FINISH: Record<string, string> = {
    end_turn: "stop",
    stop_sequence: "stop",
    tool_use: "tool_calls",
    max_tokens: "length",
    model_context_window_exceeded: "length",
    content_filtered: "content_filter",
    guardrail_intervened: "content_filter",
    // A model's own safety classifier declining (Claude 5.5 and later). One spelling for all three,
    // which the loop ends as `model_refused` rather than as an empty answer.
    refusal: "content_filter",
}

type Open =
    | { readonly kind: "tool"; readonly id: string; readonly name: string; input: string }
    | { readonly kind: "reasoning"; text: string; signature?: string; redacted?: string }

export async function* toChunks(
    events: AsyncIterable<ConverseStreamOutput>,
): AsyncIterable<ChatChunk> {
    const open = new Map<number, Open>()

    for await (const event of events) {
        if (event.contentBlockStart !== undefined) {
            const tool = event.contentBlockStart.start?.toolUse
            if (tool !== undefined) {
                open.set(event.contentBlockStart.contentBlockIndex ?? 0, {
                    kind: "tool",
                    id: tool.toolUseId ?? "",
                    name: tool.name ?? "",
                    input: "",
                })
            }
            continue
        }

        if (event.contentBlockDelta !== undefined) {
            const index = event.contentBlockDelta.contentBlockIndex ?? 0
            const delta = event.contentBlockDelta.delta
            if (delta?.text !== undefined) {
                if (delta.text !== "") yield { type: "text", delta: delta.text }
            } else if (delta?.toolUse !== undefined) {
                const block = open.get(index)
                if (block?.kind === "tool") block.input += delta.toolUse.input ?? ""
            } else if (delta?.reasoningContent !== undefined) {
                let block = open.get(index)
                if (block?.kind !== "reasoning") {
                    block = { kind: "reasoning", text: "" }
                    open.set(index, block)
                }
                const reasoning = delta.reasoningContent
                if (reasoning.text !== undefined && reasoning.text !== "") {
                    block.text += reasoning.text
                    yield { type: "reasoning", delta: reasoning.text }
                }
                if (reasoning.signature !== undefined) block.signature = reasoning.signature
                if (reasoning.redactedContent !== undefined) {
                    block.redacted = Buffer.from(reasoning.redactedContent).toString("base64")
                }
            }
            continue
        }

        if (event.contentBlockStop !== undefined) {
            const index = event.contentBlockStop.contentBlockIndex ?? 0
            const block = open.get(index)
            open.delete(index)
            if (block?.kind === "tool") {
                yield {
                    type: "tool_call",
                    call: { id: block.id, name: block.name, arguments: block.input },
                }
            } else if (block?.kind === "reasoning") {
                yield {
                    type: "thinking_block",
                    block: {
                        text: block.text,
                        ...(block.signature === undefined ? {} : { signature: block.signature }),
                        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
                    },
                }
            }
            continue
        }

        if (event.messageStop !== undefined) {
            const reason = event.messageStop.stopReason ?? "end_turn"
            yield { type: "finish", reason: FINISH[reason] ?? reason }
            continue
        }

        const usage = event.metadata?.usage
        if (usage !== undefined) {
            const read = usage.cacheReadInputTokens
            const written = usage.cacheWriteInputTokens
            yield {
                type: "usage",
                promptTokens: (usage.inputTokens ?? 0) + (read ?? 0) + (written ?? 0),
                completionTokens: usage.outputTokens ?? 0,
                ...(read === undefined
                    ? {}
                    : {
                          cachedPromptTokens: read,
                          cacheSource: "metadata.usage.cacheReadInputTokens",
                      }),
                ...(written === undefined ? {} : { cacheWriteTokens: written }),
            }
            continue
        }

        // An exception carried inside the stream, after output may already have been sent.
        const failure =
            event.throttlingException ??
            event.serviceUnavailableException ??
            event.internalServerException ??
            event.modelStreamErrorException ??
            event.validationException
        if (failure !== undefined) throw failure
    }
}
