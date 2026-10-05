/**
 * The model transport contract.
 *
 * One shape, one implementation (`chat-completions.ts`). Implement this only for a genuinely
 * different wire protocol — a native Messages-API adapter, an in-process local runner. Not for
 * a different vendor: a different vendor is a different base URL.
 */

/**
 * The slice of `fetch` this runtime uses. Narrower than `typeof globalThis.fetch` on purpose:
 * the platform type carries extras (Bun adds `preconnect`) that make an injected test double
 * fail to typecheck, and the injection seam is worth more than the extra members.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * One call the model asked for, as the transport reported it.
 *
 * `arguments` is the **raw JSON text**, deliberately unparsed. It mirrors the rule the NLT parser
 * follows: report what was written, and let `coerce.ts` alone decide what it means. It also means a
 * truncated or invalid argument document survives to the layer that can produce a useful repair,
 * rather than becoming an exception inside the transport.
 */
export interface ToolCallRequest {
    readonly id: string
    readonly name: string
    readonly arguments: string
}

/**
 * A tool as the provider's `tools` parameter wants it. Used by the `native` dialect only; under NLT
 * the catalogue is prose in the context and nothing is sent here.
 */
export interface ToolDefinition {
    readonly name: string
    readonly description: string
    /** The tool's JSON Schema, passed through unchanged. One schema, two renderings. */
    readonly parameters: Readonly<Record<string, unknown>>
}

/**
 * One block of a model's extended thinking, as the endpoint signed it.
 *
 * Anthropic-family models (directly or through Bedrock) require the thinking that led to a tool call
 * to be sent back, **unaltered and with its signature**, alongside the tool's result; without it the
 * next step either is refused or reasons from nothing about why it called the tool. A transport that
 * produces these emits a `thinking_block` chunk when one completes; the loop attaches the step's
 * blocks to the assistant message that made the call, and a transport replays them. Opaque to
 * everything in between: the text is not re-rendered and the signature is never inspected.
 */
export interface ThinkingBlock {
    readonly text: string
    readonly signature?: string
    /** Encrypted thinking the endpoint would not show, replayed as-is. */
    readonly redacted?: string
}

export interface ChatMessage {
    /** `tool` carries an observation answering a specific `toolCalls` entry. Native only. */
    readonly role: "system" | "user" | "assistant" | "tool"
    readonly content: string
    /** Set on an assistant message that asked for tools. Native only. */
    readonly toolCalls?: readonly ToolCallRequest[]
    /** Set on a `tool` message: which call it answers. Native only, and required there. */
    readonly toolCallId?: string
    /**
     * Who wrote this message, when it was the harness rather than a person or the model.
     *
     * Harness metadata, never sent: `wireMessage` builds the request body field by field, so this
     * cannot reach an endpoint. It exists because compaction has to know which messages are tool
     * output and, under a text dialect, **role does not say**. NLT sends an observation back as a
     * `user` message (`nlt.ts:738`) whose content opens `OBSERVATION <slug> — ok`, so the only
     * alternative is matching that string — and classifying a message by regex would let a person who
     * happens to type the word have their own message truncated, while a dialect that changes its
     * framing would silently stop compacting anything at all.
     *
     * Optional because a message loaded from a store written before the column existed has no origin,
     * and the honest degradation is to treat it as prose: the stages that need this leave it alone and
     * the ladder reaches for the ones that do not.
     */
    readonly origin?: "observation" | "call" | "repair" | "digest"
    /**
     * The model wrote this prose after untrusted tool output entered the turn.
     *
     * Harness metadata, never sent to an endpoint. Conversation memory excludes tainted assistant
     * prose so an indirect prompt injection cannot be laundered into a clean cross-session passage.
     */
    readonly tainted?: boolean
    /**
     * The model's signed thinking before this assistant message's tool calls. Set only within a
     * turn, only when `capabilities.thinking` is `anthropic`, and never stored: it is replayed to the
     * transport for the rest of the tool loop and has no meaning after it. `chat-completions` does
     * not send it.
     */
    readonly thinking?: readonly ThinkingBlock[]
    /**
     * The cache-stable prefix ends at this message. Harness metadata: a transport with an explicit
     * cache protocol (Bedrock's `cachePoint`) places a marker after it; `chat-completions` never sends
     * it. Set by context assembly on the last message of the static slots (breakpoint A) and on the
     * active skill (breakpoint B) — positions only assembly knows, which is why it travels with the
     * message rather than being recomputed by each transport.
     */
    readonly cacheBreakpoint?: true
    /**
     * This is the current turn's input. Harness metadata like `cacheBreakpoint`, never sent: assembly
     * puts the input after the turn's own calls and observations, which an endpoint with a strict
     * conversation shape (Bedrock Converse: the first message must be the user's) needs to undo.
     */
    readonly turnInput?: true
    /**
     * Images sent with this message (pilot.5, #12). Set only on the current turn's input, never stored:
     * history keeps a `[image: <ref>]` line in `content` instead, so a later turn neither pays for the
     * image again nor loses the fact that one was sent. Each transport maps it to its own shape.
     */
    readonly images?: readonly ImageInput[]
}

/** One image, ready for a transport. */
export interface ImageInput {
    readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    /** Base64, no `data:` prefix. */
    readonly data: string
    /** What the stored message says was sent: the workspace path, or `upload` for inline data. */
    readonly ref: string
}

export interface ChatRequest {
    readonly model: string
    readonly messages: readonly ChatMessage[]
    readonly temperature?: number
    readonly topP?: number
    readonly maxTokens?: number
    /**
     * How much the model may deliberate before answering. OpenAI-standard, sent as
     * `reasoning_effort`, omitted entirely when unset.
     *
     * `none` is the one that earns this field. Measured against `qwen3.5:9b` on 2026-08-14, same
     * prompt and same machine: with reasoning on, six simultaneous rules produced 2,000 completion
     * tokens of deliberation in 104 s and **empty content** — the model reasoned past its own
     * budget and never answered. With `reasoning_effort: "none"`, ten tokens in 2.1 s, obeying all
     * six rules. Fifty times faster and the only one of the two that replied at all.
     *
     * Not every endpoint honours it, and the ones that do not are silent about it rather than
     * refusing — `chat_template_kwargs` and `think` were both accepted and ignored by the same
     * endpoint in the same test. So treat it as a request, verify it per endpoint, and never assume
     * a lower setting took effect.
     */
    readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    /** Omitted entirely under a text dialect, so the request body is unchanged from Phase 1. */
    readonly tools?: readonly ToolDefinition[]
}

/** Streamed output. `text` accumulates into the reply; `reasoning` is kept separate. */
export type ChatChunk =
    | { readonly type: "text"; readonly delta: string }
    | { readonly type: "reasoning"; readonly delta: string }
    /**
     * One complete call. Emitted once the whole call has arrived, not per fragment: a streamed
     * `tool_calls` entry is delivered as index-keyed pieces of a JSON document, and half of one is
     * of no use to any consumer. The reassembly stays in the transport, which is the layer that
     * owns wire quirks.
     */
    | { readonly type: "tool_call"; readonly call: ToolCallRequest }
    | {
          readonly type: "usage"
          readonly promptTokens: number
          readonly completionTokens: number
          /**
           * Prompt tokens the endpoint served from its cache, when it says so.
           *
           * `undefined` means *not reported*, which is a different fact from zero and must stay
           * distinguishable: an endpoint that caches nothing and an endpoint that declines to talk
           * about caching produce the same bill and want opposite conclusions. Every consumer of this
           * field has to carry the third state rather than defaulting it to 0.
           */
          readonly cachedPromptTokens?: number
          /** Which wire field the figure came from, so a surprising ratio can be traced to its source. */
          readonly cacheSource?: string
          /** Prompt tokens this call wrote to the cache, when the endpoint says so. Same third state. */
          readonly cacheWriteTokens?: number
      }
    /**
     * Which model answered, when it was not the one requested: a fallback (`model/fallback.ts`)
     * emits this before its first chunk. Absent, the requested model answered.
     */
    | { readonly type: "model"; readonly id: string }
    /** A signed thinking block, once complete. The `reasoning` deltas still stream beside it. */
    | { readonly type: "thinking_block"; readonly block: ThinkingBlock }
    | { readonly type: "finish"; readonly reason: string }

export interface ModelProvider {
    readonly id: string
    /**
     * Stream a completion. Must return promptly and yield as bytes arrive.
     *
     * On abort the generator returns rather than throwing: cancellation is a state, not an
     * exception, and a rejected promise here becomes an unhandled rejection somewhere else.
     */
    chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>
}
