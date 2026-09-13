/**
 * The one transport: OpenAI-compatible `/chat/completions` over hand-rolled `fetch`.
 *
 * No SDK. The `openai` package is heavy and leans toward the Responses API, which most compat
 * proxies do not implement; the Vercel AI SDK routes through a gateway when handed a model
 * string, which is a hidden network dependency in a runtime that advertises none.
 *
 * Three behaviours worth knowing about:
 *
 * - **The API key is read from the environment on every request**, never captured at
 *   construction. Rotating a key therefore needs no restart, which is a bug class deleted
 *   rather than a feature added.
 * - **Retries happen only before the first byte.** Once tokens are flowing, a retry would
 *   silently duplicate output. A mid-stream failure is surfaced, not papered over.
 * - **A server that ignores `stream: true` still works.** If the response is JSON rather than
 *   an event stream, it is read as a single completion. Compat proxies do this often enough
 *   that treating it as a hard error would cost real endpoints.
 */

import { apiKeyMissing, modelHttpError, modelStreamMalformed, modelUnreachable } from "../errors.ts"
import type { EnvSource } from "../manifest/env.ts"
import type {
    ChatChunk,
    ChatMessage,
    ChatRequest,
    FetchLike,
    ModelProvider,
    ToolCallRequest,
} from "./provider.ts"
import { parseSSE } from "./sse.ts"

export interface RetryPolicy {
    /** Total attempts, including the first. `1` disables retrying. */
    readonly attempts: number
    readonly baseDelayMs: number
    readonly maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400, maxDelayMs: 8000 }

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export interface ChatCompletionsConfig {
    /** Provider id, for events. Defaults to `chat-completions`. */
    readonly id?: string
    /** Must end at the version segment; `/chat/completions` is appended. */
    readonly baseUrl: string
    /** Name of the env var holding the key. Omit for endpoints that need none. */
    readonly apiKeyEnv?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly retry?: RetryPolicy
    /**
     * Ask for usage in the streamed response. **On by default since Phase 7A.**
     *
     * It was off because `stream_options` is an OpenAI extension and some compat endpoints reject
     * unknown body fields with a 400 — portability against an accounting nicety. It stopped being a
     * nicety when the compaction ladder started running on a corrected estimate: without
     * `prompt_tokens` there is no anchor, the correction never leaves 1.0, and every pressure figure
     * carries the estimator's measured 16-20% low bias on exactly the observation-heavy prompts that
     * need compacting.
     *
     * Portability is kept by *downgrading* rather than by defaulting off: a 400 naming
     * `stream_options` is retried once without the field and remembered for the life of this provider,
     * with `onUsageUnsupported` reporting it. So a compliant endpoint gets the anchor with nothing to
     * configure, and a non-compliant one costs one extra request per process and says so. Set it to
     * `false` to opt out entirely.
     */
    readonly streamUsage?: boolean
    /**
     * Called once when an endpoint refuses `stream_options` and the request is retried without it.
     *
     * Exists so the refusal reaches `agent.warning` instead of a log nobody opens: the agent still
     * works, and the only visible consequence is that pressure figures stay `estimated` forever.
     */
    readonly onUsageUnsupported?: (info: { readonly status: number; readonly body: string }) => void
    /** Injectable for tests. Defaults to global `fetch`. */
    readonly fetch?: FetchLike
    /** Injectable for tests. Defaults to `process.env`, read per request. */
    readonly env?: EnvSource
    /** Called before a retry sleeps, so the runtime can emit `model.retry`. */
    readonly onRetry?: (info: { status: number; attempt: number; delayMs: number }) => void
    /** Field path for error reporting, e.g. `model.main`. */
    readonly field?: string
}

interface WireToolCall {
    index?: unknown
    id?: unknown
    function?: { name?: unknown; arguments?: unknown }
}

interface WireDelta {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
    tool_calls?: WireToolCall[]
}

interface DeltaShape {
    choices?: {
        delta?: WireDelta
        message?: WireDelta
        finish_reason?: unknown
    }[]
    /** `null` on every chunk but the last, when `stream_options.include_usage` is set. */
    usage?: {
        prompt_tokens?: unknown
        completion_tokens?: unknown
        /** OpenAI, and everything that copies it. */
        prompt_tokens_details?: { cached_tokens?: unknown } | null
        /** DeepSeek reports the split directly rather than nesting it. */
        prompt_cache_hit_tokens?: unknown
        prompt_cache_miss_tokens?: unknown
        /** Anthropic through an OpenAI-shaped shim. Reads are what were served; creation was billed. */
        cache_read_input_tokens?: unknown
    } | null
}

/**
 * Prompt tokens the endpoint served from cache, and which field said so.
 *
 * Three spellings because the runtime is model-agnostic and the providers did not agree: OpenAI nests
 * it under `prompt_tokens_details`, DeepSeek reports a hit/miss pair at the top level, and an
 * Anthropic-shaped shim calls reads something else again. Checked in that order and the first hit
 * wins; an endpoint that reports none returns `undefined`, which is deliberately not zero — see
 * `StreamEvent`'s `cachedPromptTokens`.
 *
 * The field name is carried back with the number. A cache ratio is the kind of figure that gets
 * disbelieved, and "which field is this" is the first question anyone asks of a surprising one.
 */
function cacheUsage(
    usage: NonNullable<DeltaShape["usage"]>,
): { readonly cached: number; readonly source: string } | undefined {
    const nested = asNumber(usage.prompt_tokens_details?.cached_tokens)
    if (nested !== undefined)
        return { cached: nested, source: "prompt_tokens_details.cached_tokens" }
    const hit = asNumber(usage.prompt_cache_hit_tokens)
    if (hit !== undefined) return { cached: hit, source: "prompt_cache_hit_tokens" }
    const read = asNumber(usage.cache_read_input_tokens)
    if (read !== undefined) return { cached: read, source: "cache_read_input_tokens" }
    return undefined
}

/**
 * A `ChatMessage` in the shape the API expects.
 *
 * **This function is why tool calling works at all, and its absence would be silent.** The body used
 * to be built with `messages: request.messages`, which was correct only because a message was
 * exactly `{role, content}` — both already wire names. The moment a message carries `toolCalls`, that
 * shortcut sends a field OpenAI has never heard of: the request succeeds, the model simply never
 * sees the call it made, and the symptom is an agent that repeats itself. So the mapping is explicit
 * and in one place.
 */
function wireMessage(message: ChatMessage): Record<string, unknown> {
    const calls = message.toolCalls ?? []
    return {
        role: message.role,
        // `null` rather than `""` beside tool calls: the API documents null for a message that is
        // only a call, and some compat endpoints treat an empty string as a malformed turn.
        content: message.content === "" && calls.length > 0 ? null : message.content,
        ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
        ...(calls.length === 0
            ? {}
            : {
                  tool_calls: calls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                  })),
              }),
    }
}

/**
 * Reassembles streamed `tool_calls` fragments.
 *
 * A streamed call arrives as pieces keyed by `index`: the id and name usually on the first fragment,
 * the arguments accumulated across many. Keyed by index rather than by arrival order because two
 * calls in one step interleave.
 */
class ToolCallBuffer {
    #calls = new Map<number, { id: string; name: string; args: string }>()

    add(entries: readonly WireToolCall[]): void {
        for (const [position, entry] of entries.entries()) {
            // A non-streaming response carries no `index`; position in the array is the identity.
            const index = asNumber(entry.index) ?? position
            const existing = this.#calls.get(index) ?? { id: "", name: "", args: "" }
            this.#calls.set(index, {
                id: asString(entry.id) ?? existing.id,
                name: asString(entry.function?.name) ?? existing.name,
                args: existing.args + (asStringLoose(entry.function?.arguments) ?? ""),
            })
        }
    }

    /** In index order, because a step's calls run in the order the model asked for them. */
    drain(): readonly ToolCallRequest[] {
        const ordered = [...this.#calls.entries()].sort(([a], [b]) => a - b)
        this.#calls.clear()
        return ordered.map(([index, call]) => ({
            // A synthesised id keeps the observation answerable even from an endpoint that omits
            // one. Dropping the call instead would lose work the model actually asked for.
            id: call.id === "" ? `call_${index}` : call.id,
            name: call.name,
            arguments: call.args,
        }))
    }
}

/**
 * Append `/chat/completions` to the base URL, keeping any query string intact.
 *
 * Naive string concatenation puts the path *after* the query — `…/v1?x=1/chat/completions` —
 * which 404s. Azure OpenAI carries a mandatory `?api-version=`, so this is a real endpoint
 * shape rather than a hypothetical one.
 */
/**
 * The chat endpoint for a base URL.
 *
 * Exported so a diagnostic reaches the *same* URL a turn does. A probe that built its own would be
 * measuring a URL nothing sends to, and the trailing-slash handling below is exactly the kind of
 * detail two copies come to disagree about.
 */
export function endpointUrl(baseUrl: string): string {
    try {
        const url = new URL(baseUrl)
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`
        return url.toString()
    } catch {
        // Not absolute. `validateManifest` rejects this at load; if a caller constructs a
        // provider directly, fall back rather than throwing from a URL parse.
        return `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    }
}

/**
 * The sibling `GET /models` URL, for the one technique that costs nothing.
 *
 * Same base, same trailing-slash rule, different leaf — kept beside `endpointUrl` so the pair moves
 * together if a gateway ever needs the path rewritten.
 */
export function modelsUrl(baseUrl: string): string {
    return endpointUrl(baseUrl).replace(/\/chat\/completions$/, "/models")
}

/**
 * The `authorization` header for a role, or `{}` when the manifest names no key variable.
 *
 * Throws the same `apiKeyMissing` a turn would, with the same field path, so a probe run against a
 * misconfigured agent fails the way the agent will rather than in some new way.
 */
export function bearerHeaders(
    apiKeyEnv: string | undefined,
    env: Record<string, string | undefined>,
    field: string,
): Record<string, string> {
    if (apiKeyEnv === undefined) return {}
    const key = env[apiKeyEnv]
    if (key === undefined || key === "") throw apiKeyMissing(apiKeyEnv, `${field}.apiKeyEnv`)
    return { authorization: `Bearer ${key}` }
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * As `asString`, but an empty string is a value rather than an absence.
 *
 * Needed for argument fragments only. `asString` treats `""` as missing, which is right for a
 * content delta and wrong here: a tool taking no arguments streams `arguments: ""`, and reading that
 * as "no fragment yet" leaves the call looking incomplete.
 */
function asStringLoose(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number | undefined {
    if (header === null) return undefined
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
    return undefined
}

function backoffMs(policy: RetryPolicy, attempt: number): number {
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1)
    const capped = Math.min(exponential, policy.maxDelayMs)
    // Full jitter. Synchronised retries from several agents are their own outage.
    return Math.round(capped * (0.5 + Math.random() / 2))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            resolve()
        }
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

function* chunksFromPayload(payload: DeltaShape, calls: ToolCallBuffer): Generator<ChatChunk> {
    const choice = payload.choices?.[0]

    const delta = choice?.delta ?? choice?.message
    const reasoning = asString(delta?.reasoning_content) ?? asString(delta?.reasoning)
    if (reasoning !== undefined) yield { type: "reasoning", delta: reasoning }

    const text = asString(delta?.content)
    if (text !== undefined) yield { type: "text", delta: text }

    // Buffered, not yielded: a fragment is not a call. The buffer is drained once the stream ends.
    if (delta?.tool_calls !== undefined) calls.add(delta.tool_calls)

    // `null`, not just absent. An OpenAI-compatible endpoint with `include_usage` set sends
    // `"usage": null` on every chunk but the last, and `!== undefined` lets that through to be
    // dereferenced. It threw on the first real call ever made with `streamUsage: true` — the flag was
    // written for this phase and had never been exercised, so the bug shipped behind an unused option.
    const usage = payload.usage
    if (usage !== undefined && usage !== null) {
        const cache = cacheUsage(usage)
        yield {
            type: "usage",
            promptTokens: asNumber(usage.prompt_tokens) ?? 0,
            completionTokens: asNumber(usage.completion_tokens) ?? 0,
            ...(cache === undefined
                ? {}
                : { cachedPromptTokens: cache.cached, cacheSource: cache.source }),
        }
    }

    const finish = asString(choice?.finish_reason)
    if (finish !== undefined) yield { type: "finish", reason: finish }
}

async function* iterateBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = body.getReader()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return
            if (value !== undefined) yield value
        }
    } finally {
        // Releasing the lock lets an aborted fetch tear the socket down promptly, which is what
        // makes cancellation land inside a hundred milliseconds rather than at end of stream.
        reader.releaseLock()
    }
}

export function createChatCompletionsProvider(config: ChatCompletionsConfig): ModelProvider {
    const url = endpointUrl(config.baseUrl)
    const policy = config.retry ?? DEFAULT_RETRY
    const doFetch = config.fetch ?? globalThis.fetch
    const field = config.field ?? "model.main"
    /**
     * Usage is asked for unless a manifest says otherwise, and stops being asked for once refused.
     *
     * `usageRefused` is per provider instance rather than per request: an endpoint's support for
     * `stream_options` is a property of the endpoint, so paying the extra round trip once is right and
     * paying it on every call is not.
     */
    const usageWanted = config.streamUsage !== false
    let usageRefused = false

    function authHeaders(): Record<string, string> {
        if (config.apiKeyEnv === undefined) return {}
        const env = config.env ?? process.env
        const key = env[config.apiKeyEnv]
        if (key === undefined || key === "")
            throw apiKeyMissing(config.apiKeyEnv, `${field}.apiKeyEnv`)
        return { authorization: `Bearer ${key}` }
    }

    async function* chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
        // Rebuilt inside the loop, because the one thing that can change between attempts is whether
        // `stream_options` is included. Everything else is fixed for the request.
        const buildBody = (withUsage: boolean) =>
            JSON.stringify({
                model: request.model,
                messages: request.messages.map(wireMessage),
                stream: true,
                // Absent entirely under NLT, so a text-dialect request is byte-for-byte what Phase 1
                // sent. An endpoint that has never seen a `tools` key is not asked to ignore one.
                ...(request.tools === undefined || request.tools.length === 0
                    ? {}
                    : {
                          tools: request.tools.map((tool) => ({
                              type: "function",
                              function: {
                                  name: tool.name,
                                  description: tool.description,
                                  parameters: tool.parameters,
                              },
                          })),
                      }),
                ...(withUsage ? { stream_options: { include_usage: true } } : {}),
                ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
                ...(request.topP === undefined ? {} : { top_p: request.topP }),
                ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
                // Omitted when unset, like every other optional field: an endpoint that has never seen
                // `reasoning_effort` is not asked to ignore one.
                ...(request.reasoningEffort === undefined
                    ? {}
                    : { reasoning_effort: request.reasoningEffort }),
            })

        // Read the key *before* the retry loop. Inside it, a missing-key ConfigError would be
        // caught by the network-failure branch, retried twice, and finally reported as "cannot reach
        // the endpoint" — a config mistake wearing a connectivity error's clothes. Reading here is
        // still per-request, so rotation continues to work without a restart.
        const auth = authHeaders()

        let response: Response | undefined

        /**
         * `attempt` is incremented by the loop body, not by the header, because one path through it is
         * not a retry: dropping `stream_options` re-sends the *same* request in a form the endpoint
         * accepts. Counting it against the budget would make the downgrade spend a real retry, and on a
         * single-attempt policy it would fall out of the loop with no response at all — which returns an
         * empty stream and reports nothing, the exact silent-success shape rule 8 forbids.
         */
        let attempt = 1
        while (attempt <= policy.attempts) {
            if (signal.aborted) return

            const body = buildBody(usageWanted && !usageRefused)

            let candidate: Response
            try {
                candidate = await doFetch(url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        accept: "text/event-stream",
                        ...auth,
                        ...(config.headers ?? {}),
                    },
                    body,
                    signal,
                })
            } catch (cause) {
                if (signal.aborted) return
                if (attempt >= policy.attempts) throw modelUnreachable(url, cause)
                const delayMs = backoffMs(policy, attempt)
                config.onRetry?.({ status: 0, attempt, delayMs })
                attempt += 1
                await sleep(delayMs, signal)
                continue
            }

            if (candidate.ok) {
                response = candidate
                break
            }

            const retryable = RETRYABLE_STATUS.has(candidate.status)
            if (!retryable || attempt >= policy.attempts) {
                const text = await candidate.text().catch(() => "")
                // The one non-retryable status worth a second attempt, and only once per provider:
                // an endpoint that rejects `stream_options` is not broken, it is older. Retrying the
                // whole request without the field keeps portability without defaulting the anchor
                // off for everyone. Matched on the field name in the body, not on the status alone —
                // a 400 is also what a malformed prompt returns, and retrying that would hide a real
                // error behind an extra request.
                if (
                    usageWanted &&
                    !usageRefused &&
                    candidate.status === 400 &&
                    text.includes("stream_options")
                ) {
                    usageRefused = true
                    config.onUsageUnsupported?.({
                        status: candidate.status,
                        body: text.slice(0, 400),
                    })
                    continue
                }
                throw modelHttpError(candidate.status, text, url)
            }

            // Drain so the connection can be reused rather than left half-read.
            await candidate.text().catch(() => "")
            const delayMs =
                retryAfterMs(candidate.headers.get("retry-after")) ?? backoffMs(policy, attempt)
            config.onRetry?.({ status: candidate.status, attempt, delayMs })
            attempt += 1
            await sleep(delayMs, signal)
        }

        if (response === undefined) return
        if (signal.aborted) return

        const contentType = response.headers.get("content-type") ?? ""
        const calls = new ToolCallBuffer()

        /**
         * Whatever tool calls arrived, once no more can.
         *
         * Every exit from the read loop below goes through this, including the `[DONE]` sentinel and
         * a stream that simply ends. A `return` that skipped it would drop a call the model made —
         * the turn would then read as a plain reply, which is the quiet-wrong-answer shape rather
         * than a failure anyone would notice.
         */
        function* flush(): Generator<ChatChunk> {
            for (const call of calls.drain()) yield { type: "tool_call", call }
        }

        // A server that ignored `stream: true` and answered with one JSON document.
        if (!contentType.includes("text/event-stream")) {
            const text = await response.text()
            let payload: DeltaShape
            try {
                payload = JSON.parse(text) as DeltaShape
            } catch (cause) {
                throw modelStreamMalformed(text, cause)
            }
            yield* chunksFromPayload(payload, calls)
            yield* flush()
            return
        }

        if (response.body === null) return

        for await (const event of parseSSE(iterateBody(response.body))) {
            // An aborted turn drops what it had: a partially-streamed call is not a call, and
            // executing half a JSON document is worse than reporting the cancellation.
            if (signal.aborted) return

            const data = event.data.trim()
            if (data === "") continue
            if (data === "[DONE]") {
                yield* flush()
                return
            }

            let payload: DeltaShape
            try {
                payload = JSON.parse(data) as DeltaShape
            } catch (cause) {
                throw modelStreamMalformed(data, cause)
            }

            yield* chunksFromPayload(payload, calls)
        }

        yield* flush()
    }

    return { id: config.id ?? "chat-completions", chat }
}
