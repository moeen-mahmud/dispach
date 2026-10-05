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
import type { ChatMessage, ChatRequest, ErrorDetail, ModelRoleConfig } from "@dispach/core"

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
    return thinkingStyle(modelId) === "budget"
}

/** A Claude model's family and version, from a Bedrock id: `eu.anthropic.claude-sonnet-4-6`. */
function claudeVersion(
    modelId: string,
): { readonly family: string; readonly version: number } | undefined {
    // Current ids put the family first (`claude-opus-5-5`, `claude-sonnet-4-20250514-v1:0`); older ones
    // put it last (`claude-3-7-sonnet-20250219-v1:0`). A dated suffix is not a minor version.
    const current = /anthropic\.claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(
        modelId,
    )
    if (current !== null) {
        const minor = Number(current[3] ?? "0")
        return {
            family: current[1] ?? "",
            version: Number(current[2]) + (minor < 100 ? minor / 10 : 0),
        }
    }
    const older = /anthropic\.claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/.exec(modelId)
    if (older !== null) {
        return { family: older[3] ?? "", version: Number(older[1]) + Number(older[2] ?? "0") / 10 }
    }
    return /anthropic\.claude/.test(modelId) ? { family: "", version: 0 } : undefined
}

/**
 * How a Bedrock model takes reasoning: a Claude token budget, Claude's adaptive thinking with an effort,
 * or an `openai.*` effort. Adaptive from 4.7, the first version that refuses a budget with a 400; 4.6
 * still accepts one (deprecated), so its requests stay exactly as they were.
 */
export function thinkingStyle(modelId: string): "budget" | "adaptive" | "openai" | undefined {
    if (/(^|[./])openai\./.test(modelId)) return "openai"
    const claude = claudeVersion(modelId)
    if (claude === undefined) return undefined
    if (claude.family === "fable" || claude.family === "mythos") return "adaptive"
    return claude.family !== "haiku" && claude.version >= 4.7 ? "adaptive" : "budget"
}

/**
 * How `reasoningEffort: none` is spelled for an adaptive Claude model, which differs by model: most
 * accept `disabled`, Sonnet 5.5 refuses it and turns thinking off with `between_tools`, and Opus 5.5,
 * Fable and Mythos cannot turn it off at all, so `none` runs at the lowest effort instead.
 */
export function thinkingOff(modelId: string): "disabled" | "between_tools" | "low" {
    const claude = claudeVersion(modelId)
    if (claude === undefined) return "disabled"
    if (claude.family === "fable" || claude.family === "mythos") return "low"
    if (claude.family === "opus" && claude.version >= 5.5) return "low"
    if (claude.family === "sonnet" && claude.version >= 5.5) return "between_tools"
    return "disabled"
}

/**
 * Whether the model refuses `temperature` and `topP`. Claude 4.7 and later (Sonnet 5.5 a non-default
 * value), and GPT-6 (VelaCrew, pilot.6: "This model doesn't support the temperature field" on every
 * turn of `global.openai.gpt-6-luna`). Other `openai.*` models, gpt-oss among them, still take both.
 */
export function refusesSampling(modelId: string): boolean {
    return thinkingStyle(modelId) === "adaptive" || /(^|[./])openai\.gpt-6/.test(modelId)
}

/**
 * What this transport adjusts in a role's config, said at load rather than discovered as a 400 or as
 * a setting that quietly did nothing.
 */
export function roleWarnings(config: ModelRoleConfig, field: string): readonly ErrorDetail[] {
    const warnings: ErrorDetail[] = []
    if (
        thinkingStyle(config.id) === "adaptive" &&
        config.reasoningEffort === "none" &&
        thinkingOff(config.id) === "low"
    ) {
        warnings.push({
            code: "model_thinking_always_on",
            message: `${config.id} cannot turn thinking off, so ${field}.reasoningEffort: none runs at low effort.`,
            hint: `Set ${field}.reasoningEffort: low to say so explicitly, which also silences this.`,
            field: `${field}.reasoningEffort`,
        })
    }
    if (
        refusesSampling(config.id) &&
        (config.temperature !== undefined || config.topP !== undefined)
    ) {
        warnings.push({
            code: "model_sampling_unsupported",
            message: `${config.id} does not accept temperature or topP, so ${field} sends neither.`,
            hint: `Remove temperature and topP from ${field}; steer this model with reasoningEffort instead.`,
            field,
        })
    }
    return warnings
}

/** Output a reply gets when adaptive thinking is on and no `maxTokens` was configured. */
const ADAPTIVE_MAX_TOKENS = 32_768

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

/**
 * The messages with the turn's input moved ahead of its own trace when they would otherwise open with
 * the assistant. Assembly puts the input last, after the calls and observations of the turn so far,
 * so on a fresh session's second step the first non-system message is the model's own call, and
 * Converse refuses that for Nova ("A conversation must start with a user message", VelaCrew, pilot.5)
 * and tolerates it for Claude when the call is a `toolUse`. Moved in both cases, so every model gets
 * the canonical order (the question, the call, the result); a request that already opened with the
 * user is unchanged.
 */
export function conversationOrder(messages: readonly ChatMessage[]): readonly ChatMessage[] {
    const first = messages.findIndex((message) => message.role !== "system")
    if (first === -1 || messages[first]?.role === "user") return messages
    const input = messages.findIndex((message) => message.turnInput === true)
    if (input === -1 || input < first) return messages
    const moved = messages[input] as ChatMessage
    return [
        ...messages.slice(0, first),
        moved,
        ...messages.slice(first, input),
        ...messages.slice(input + 1),
    ]
}

export function converseInput(
    request: ChatRequest,
    config: ModelRoleConfig,
): ConverseStreamCommandInput {
    const caching = cachesPrompts(request.model) && config.capabilities?.promptCache !== "none"
    const system: SystemContentBlock[] = []
    const messages: Message[] = []

    let leading = true
    for (const message of conversationOrder(request.messages)) {
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

    const style = thinkingStyle(request.model)
    const effort = request.reasoningEffort
    const budget =
        style === "budget" && effort !== undefined
            ? THINKING_BUDGET[effort === "xhigh" || effort === "max" ? "high" : effort]
            : undefined
    const adaptive = style === "adaptive" ? adaptiveFields(request.model, effort) : undefined
    // Claude 4.7 and later and GPT-6 refuse a sampling setting, so it is never sent to them;
    // `warnings` says so at load.
    const sampling = budget === undefined && !refusesSampling(request.model)
    // Anthropic requires the output cap to exceed the thinking budget, and refuses a sampling
    // temperature beside it. The headroom past the budget is what the answer gets once thinking has
    // spent it: 4,096 cut long tool calls off mid-argument (VelaCrew, pilot.4), so it is 16,384 —
    // under every thinking-capable Claude's output ceiling even at the `high` budget.
    const maxTokens =
        budget !== undefined
            ? Math.max(request.maxTokens ?? 0, budget + ANSWER_HEADROOM)
            : adaptive?.thinking === true
              ? (request.maxTokens ?? ADAPTIVE_MAX_TOKENS)
              : request.maxTokens
    const inference = {
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(!sampling || request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
        ...(!sampling || request.topP === undefined ? {} : { topP: request.topP }),
    }
    const extra =
        budget !== undefined
            ? { thinking: { type: "enabled", budget_tokens: budget } }
            : adaptive !== undefined
              ? adaptive.fields
              : style === "openai" && effort !== undefined && effort !== "none"
                ? // Nested, as OpenAI's Responses API spells it. Probed on Bedrock (gpt-6-luna, 2026-10-05):
                  // a top-level `reasoning_effort` is a 400 `unknown_parameter`, and `reasoning.effort`
                  // is accepted. Whether it is honoured a one-word probe could not show.
                  { reasoning: { effort: effort === "minimal" ? "low" : effort } }
                : undefined

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
        ...(extra === undefined ? {} : { additionalModelRequestFields: extra }),
    }
}

/**
 * Adaptive thinking's request fields for one effort. `thinking` is whether thinking stays on, which
 * decides the output headroom. Unset effort sends nothing: the model's own default.
 */
function adaptiveFields(
    modelId: string,
    effort: ChatRequest["reasoningEffort"],
): { readonly fields: Record<string, Document>; readonly thinking: boolean } | undefined {
    if (effort === undefined) return undefined
    if (effort === "none") {
        const off = thinkingOff(modelId)
        if (off === "low") {
            return {
                fields: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
                thinking: true,
            }
        }
        return { fields: { thinking: { type: off } }, thinking: false }
    }
    return {
        fields: {
            thinking: { type: "adaptive" },
            output_config: { effort: effort === "minimal" ? "low" : effort },
        },
        thinking: true,
    }
}
