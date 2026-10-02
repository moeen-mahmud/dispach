/**
 * A `ChatRequest` as a ConverseStream input.
 *
 * Pure, and typed against the SDK with `import type` only, so it is testable and bundles without the
 * SDK itself. Converse differs from chat-completions in four ways that matter here:
 *
 * - **System is not a message.** The leading `system` messages become `system[]`. A `system` message
 *   after the conversation has started (the reminder, retrieved memory) becomes user text, since
 *   Converse has nowhere else to put it — its content is unchanged.
 * - **Roles must alternate.** Consecutive messages of one role are merged into one message, and a
 *   tool observation is a `toolResult` block in a user message.
 * - **Caching is explicit.** A `cachePoint` goes after each message assembly marked
 *   `cacheBreakpoint`, for a model family that caches; elsewhere it would be refused.
 * - **Thinking is replayed as content.** An assistant call carrying signed thinking sends it back as
 *   `reasoningContent` ahead of its text and tool use, which Anthropic models require with tool
 *   results.
 */

import type {
    ContentBlock,
    ConverseStreamCommandInput,
    Message,
    SystemContentBlock,
    ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime"
import type { ChatMessage, ChatRequest, ModelRoleConfig } from "@dispach/core"

const CACHE_POINT = { cachePoint: { type: "default" as const } }

/** `ImageBlock.format`, by the media type the loader sniffed. Raw bytes: the SDK encodes them. */
const IMAGE_FORMAT = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
} as const

/** The SDK's JSON document type. A parsed JSON value is one by construction. */
type Document = NonNullable<ToolUseBlock["input"]>

/** Families whose Bedrock models take `cachePoint` blocks. Anything else is sent none. */
export function cachesPrompts(modelId: string): boolean {
    return /(^|[./])anthropic\.claude|(^|[./])amazon\.nova/.test(modelId)
}

/** Anthropic models on Bedrock take extended thinking through `additionalModelRequestFields`. */
export function thinksWithBudget(modelId: string): boolean {
    return /(^|[./])anthropic\.claude/.test(modelId)
}

/** `reasoningEffort` as an Anthropic thinking budget. `none` and unset mean no thinking requested. */
/** Output left for the answer after a thinking budget, when no `maxTokens` was configured. */
const ANSWER_HEADROOM = 16_384

const THINKING_BUDGET: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16_384,
}

function parseArguments(raw: string): Document {
    try {
        const parsed = JSON.parse(raw === "" ? "{}" : raw) as Document
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : { value: parsed }
    } catch {
        // A malformed argument document still has to reach the model as the call it made; the
        // loop's own coercion has already reported it.
        return { raw }
    }
}

function assistantContent(message: ChatMessage): ContentBlock[] {
    const blocks: ContentBlock[] = []
    for (const block of message.thinking ?? []) {
        blocks.push(
            block.redacted !== undefined
                ? {
                      reasoningContent: {
                          redactedContent: Uint8Array.from(Buffer.from(block.redacted, "base64")),
                      },
                  }
                : {
                      reasoningContent: {
                          reasoningText: {
                              text: block.text,
                              ...(block.signature === undefined
                                  ? {}
                                  : { signature: block.signature }),
                          },
                      },
                  },
        )
    }
    if (message.content !== "") blocks.push({ text: message.content })
    for (const call of message.toolCalls ?? []) {
        blocks.push({
            toolUse: {
                toolUseId: call.id,
                name: call.name,
                input: parseArguments(call.arguments),
            },
        })
    }
    return blocks
}

function contentOf(message: ChatMessage): { role: "user" | "assistant"; content: ContentBlock[] } {
    if (message.role === "assistant")
        return { role: "assistant", content: assistantContent(message) }
    if (message.role === "tool") {
        return {
            role: "user",
            content: [
                {
                    toolResult: {
                        toolUseId: message.toolCallId ?? "",
                        content: [
                            { text: message.content === "" ? "(no output)" : message.content },
                        ],
                    },
                },
            ],
        }
    }
    // `user`, and a `system` message after the conversation started.
    const content: ContentBlock[] = message.content === "" ? [] : [{ text: message.content }]
    for (const image of message.images ?? []) {
        content.push({
            image: {
                format: IMAGE_FORMAT[image.mediaType],
                source: { bytes: Uint8Array.from(Buffer.from(image.data, "base64")) },
            },
        })
    }
    return { role: "user", content }
}

export function converseInput(
    request: ChatRequest,
    config: ModelRoleConfig,
): ConverseStreamCommandInput {
    const caching = cachesPrompts(request.model) && config.capabilities?.promptCache !== "none"
    const system: SystemContentBlock[] = []
    const messages: Message[] = []

    let leading = true
    for (const message of request.messages) {
        if (leading && message.role === "system") {
            if (message.content !== "") system.push({ text: message.content })
            if (caching && message.cacheBreakpoint === true) system.push(CACHE_POINT)
            continue
        }
        leading = false
        const { role, content } = contentOf(message)
        if (caching && message.cacheBreakpoint === true && content.length > 0) {
            content.push(CACHE_POINT)
        }
        if (content.length === 0) continue
        const last = messages.at(-1)
        if (last !== undefined && last.role === role)
            last.content = [...(last.content ?? []), ...content]
        else messages.push({ role, content })
    }

    const budget =
        thinksWithBudget(request.model) && request.reasoningEffort !== undefined
            ? THINKING_BUDGET[request.reasoningEffort]
            : undefined
    // Anthropic requires the output cap to exceed the thinking budget, and refuses a sampling
    // temperature beside it. The headroom past the budget is what the answer gets once thinking has
    // spent it: 4,096 cut long tool calls off mid-argument (VelaCrew, pilot.4), so it is 16,384 —
    // under every thinking-capable Claude's output ceiling even at the `high` budget.
    const maxTokens =
        budget === undefined
            ? request.maxTokens
            : Math.max(request.maxTokens ?? 0, budget + ANSWER_HEADROOM)
    const inference = {
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(budget !== undefined || request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
        ...(budget !== undefined || request.topP === undefined ? {} : { topP: request.topP }),
    }

    return {
        modelId: request.model,
        messages,
        ...(system.length === 0 ? {} : { system }),
        ...(Object.keys(inference).length === 0 ? {} : { inferenceConfig: inference }),
        ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : {
                  toolConfig: {
                      tools: request.tools.map((tool) => ({
                          toolSpec: {
                              name: tool.name,
                              description: tool.description,
                              inputSchema: { json: tool.parameters as Document },
                          },
                      })),
                  },
              }),
        ...(budget === undefined
            ? {}
            : {
                  additionalModelRequestFields: {
                      thinking: { type: "enabled", budget_tokens: budget },
                  },
              }),
    }
}
