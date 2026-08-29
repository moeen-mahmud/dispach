import { createChatCompletionsProvider } from "../src/model/chat-completions.ts"
import type { ChatChunk, ChatRequest } from "../src/model/provider.ts"
import { describe, expect, sleep, test } from "./_harness.ts"

/**
 * The HTTP transport, driven by an injected `fetch`. Injection rather than a live endpoint
 * because these are the cases that matter and cannot be summoned on demand: a 429 followed by a
 * success, a proxy that ignores `stream: true`, an error page injected mid-stream, a key that
 * rotates between requests.
 */

function sseResponse(frames: string[], init: ResponseInit = {}): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
        },
    })
    return new Response(stream, {
        ...init,
        headers: { "content-type": "text/event-stream", ...(init.headers ?? {}) },
    })
}

function delta(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
    const chunks: ChatChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
}

function textOf(chunks: ChatChunk[]): string {
    return chunks
        .filter((c): c is Extract<ChatChunk, { type: "text" }> => c.type === "text")
        .map((c) => c.delta)
        .join("")
}

const REQUEST: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] }

/** The JSON body one request produced, for asserting what does and does not reach the wire. */
async function captureBody(over: Partial<ChatRequest>): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {}
    const provider = createChatCompletionsProvider({
        baseUrl: "https://api.example.com/v1",
        fetch: async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>
            return sseResponse(["data: [DONE]\n\n"])
        },
    })
    await drain(provider.chat({ ...REQUEST, ...over }, new AbortController().signal))
    return body
}

describe("request shape", () => {
    test("the endpoint path is appended to baseUrl", async () => {
        let seen = ""
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1",
            fetch: async (url) => {
                seen = String(url)
                return sseResponse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toBe("https://api.example.com/v1/chat/completions")
    })

    test("a trailing slash on baseUrl does not double up", async () => {
        let seen = ""
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1/",
            fetch: async (url) => {
                seen = String(url)
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toBe("https://api.example.com/v1/chat/completions")
    })

    test("a query string on baseUrl is preserved, with the path inserted before it", async () => {
        // Azure OpenAI requires ?api-version=. Naive concatenation yields `/v1?x=1/chat/completions`
        // and a 404 that looks like a wrong base URL rather than a wrong join.
        let seen = ""
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x.openai.azure.com/openai/deployments/gpt4?api-version=2024-02-01",
            fetch: async (url) => {
                seen = String(url)
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toBe(
            "https://x.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01",
        )
    })

    test("stream_options is asked for by default — the compaction ladder needs prompt_tokens", async () => {
        // It was omitted by default until Phase 7A, on portability grounds. Portability is kept by the
        // downgrade below instead: defaulting off meant the correction never left 1.0, so every pressure
        // figure carried the estimator's measured 16-20% low bias.
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(body.stream).toBe(true)
        expect(body.stream_options).toEqual({ include_usage: true })
    })

    test("streamUsage: false opts out entirely", async () => {
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            streamUsage: false,
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(body.stream_options).toBeUndefined()
    })

    test("an endpoint that refuses stream_options is retried once without it, and reported", async () => {
        const bodies: Record<string, unknown>[] = []
        const refusals: number[] = []
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            // One attempt, deliberately: the downgrade must not spend a retry. With the budget counted
            // against it this fell out of the loop with no response and returned an empty stream —
            // silent success, which is the shape rule 8 exists to prevent.
            retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
            onUsageUnsupported: (info) => refusals.push(info.status),
            fetch: async (_url, init) => {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>
                bodies.push(body)
                if (body.stream_options !== undefined) {
                    return new Response('{"error":{"message":"unknown field stream_options"}}', {
                        status: 400,
                    })
                }
                return sseResponse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(bodies.length).toBe(2)
        expect(bodies[0]?.stream_options).toEqual({ include_usage: true })
        expect(bodies[1]?.stream_options).toBeUndefined()
        expect(textOf(chunks)).toBe("ok")
        expect(refusals).toEqual([400])

        // Remembered for the life of the provider: support is a property of the endpoint, so paying the
        // extra round trip once is right and paying it every call is not.
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(bodies.length).toBe(3)
        expect(bodies[2]?.stream_options).toBeUndefined()
        expect(refusals).toEqual([400])
    })

    test("a 400 that is not about stream_options is not retried", async () => {
        // A 400 is also what a malformed prompt returns. Retrying that would hide a real error behind
        // an extra request and report the wrong cause.
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
            fetch: async () => {
                calls += 1
                return new Response('{"error":{"message":"messages[0] is not valid"}}', {
                    status: 400,
                })
            },
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            "400",
        )
        expect(calls).toBe(1)
    })

    test("optional sampling parameters are omitted rather than sent as null", async () => {
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect("temperature" in body).toBe(false)
        expect("max_tokens" in body).toBe(false)
    })
})

describe("api key handling", () => {
    test("the key is read on every request, so rotation needs no restart", async () => {
        const env: Record<string, string | undefined> = { KEY: "first" }
        const seen: string[] = []
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            apiKeyEnv: "KEY",
            env,
            fetch: async (_url, init) => {
                const headers = new Headers(init?.headers)
                seen.push(headers.get("authorization") ?? "")
                return sseResponse(["data: [DONE]\n\n"])
            },
        })

        await drain(provider.chat(REQUEST, new AbortController().signal))
        env.KEY = "rotated"
        await drain(provider.chat(REQUEST, new AbortController().signal))

        expect(seen).toEqual(["Bearer first", "Bearer rotated"])
    })

    test("no authorization header is sent when no key is configured", async () => {
        let hasAuth = true
        const provider = createChatCompletionsProvider({
            baseUrl: "http://localhost:11434/v1",
            fetch: async (_url, init) => {
                hasAuth = new Headers(init?.headers).has("authorization")
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(hasAuth).toBe(false)
    })

    test("a configured key that is unset names the variable", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            apiKeyEnv: "ABSENT_KEY",
            env: {},
            fetch: async () => sseResponse([]),
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            "ABSENT_KEY",
        )
    })
})

describe("streaming", () => {
    test("deltas accumulate in order", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([delta("Hel"), delta("lo "), delta("world"), "data: [DONE]\n\n"]),
        })
        expect(textOf(await drain(provider.chat(REQUEST, new AbortController().signal)))).toBe(
            "Hello world",
        )
    })

    test("[DONE] ends the stream and is not emitted as text", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => sseResponse([delta("a"), "data: [DONE]\n\n", delta("never")]),
        })
        expect(textOf(await drain(provider.chat(REQUEST, new AbortController().signal)))).toBe("a")
    })

    test("usage and finish_reason surface as their own chunks", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([
                    delta("a"),
                    `data: ${JSON.stringify({
                        choices: [{ delta: {}, finish_reason: "stop" }],
                        usage: { prompt_tokens: 12, completion_tokens: 3 },
                    })}\n\n`,
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(chunks).toContainEqual({ type: "usage", promptTokens: 12, completionTokens: 3 })
        expect(chunks).toContainEqual({ type: "finish", reason: "stop" })
    })

    /**
     * Three providers, three spellings, one number.
     *
     * The runtime is model-agnostic and the vendors did not agree: OpenAI nests it under
     * `prompt_tokens_details`, DeepSeek reports a hit/miss pair at the top level, and an
     * Anthropic-shaped shim calls reads something else again. Reading only one of the three would
     * report "no cache" on two providers out of three — which is the reading that makes a
     * cache-stable prefix look like it is not working.
     */
    const CACHE_SHAPES: readonly {
        readonly label: string
        readonly extra: Record<string, unknown>
        readonly source: string
    }[] = [
        {
            label: "OpenAI, nested",
            extra: { prompt_tokens_details: { cached_tokens: 900 } },
            source: "prompt_tokens_details.cached_tokens",
        },
        {
            label: "DeepSeek, hit/miss pair",
            extra: { prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 124 },
            source: "prompt_cache_hit_tokens",
        },
        {
            label: "Anthropic-shaped shim",
            extra: { cache_read_input_tokens: 900 },
            source: "cache_read_input_tokens",
        },
    ]

    // A plain loop, not `describe.each`: `_harness.ts` is a shim so the same file runs under Node's
    // runner as well as Bun's, and it declares only the two-argument `describe`. `.each` type-checks
    // against Bun's globals and is absent at runtime under Node.
    for (const { label, extra, source } of CACHE_SHAPES) {
        test(`a cache figure is read from ${label}, and names its field`, async () => {
            const provider = createChatCompletionsProvider({
                baseUrl: "https://x/v1",
                fetch: async () =>
                    sseResponse([
                        `data: ${JSON.stringify({
                            choices: [{ delta: {}, finish_reason: "stop" }],
                            usage: { prompt_tokens: 1024, completion_tokens: 3, ...extra },
                        })}\n\n`,
                        "data: [DONE]\n\n",
                    ]),
            })
            const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
            expect(chunks).toContainEqual({
                type: "usage",
                promptTokens: 1024,
                completionTokens: 3,
                cachedPromptTokens: 900,
                cacheSource: source,
            })
        })
    }

    /**
     * The third state, and the reason every layer carries it rather than defaulting to zero.
     *
     * An endpoint that caches nothing and an endpoint that declines to discuss caching produce an
     * identical bill and want opposite conclusions — one is a prefix worth investigating, the other is
     * a provider that never said. Reported-zero must therefore survive as a number.
     */
    test("an endpoint that reports no cache field leaves the number absent, not zero", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({
                        choices: [{ delta: {}, finish_reason: "stop" }],
                        usage: { prompt_tokens: 12, completion_tokens: 3 },
                    })}\n\n`,
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        const usage = chunks.find((c) => c.type === "usage")
        expect(usage).toEqual({ type: "usage", promptTokens: 12, completionTokens: 3 })
        expect("cachedPromptTokens" in (usage ?? {})).toBe(false)
    })

    test("a reported zero is a measurement and survives as one", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({
                        choices: [{ delta: {}, finish_reason: "stop" }],
                        usage: {
                            prompt_tokens: 12,
                            completion_tokens: 3,
                            prompt_cache_hit_tokens: 0,
                        },
                    })}\n\n`,
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(chunks).toContainEqual({
            type: "usage",
            promptTokens: 12,
            completionTokens: 3,
            cachedPromptTokens: 0,
            cacheSource: "prompt_cache_hit_tokens",
        })
    })

    test("a null usage on every chunk but the last is not a usage chunk", async () => {
        // What `stream_options: {include_usage: true}` actually looks like on the wire: every
        // intermediate chunk carries `"usage": null`, and only the final one carries the counts. The
        // guard tested `!== undefined`, which `null` passes, so the first real call ever made with
        // `streamUsage` threw on `usage.prompt_tokens`. The flag was written for Phase 7 and had
        // never been exercised, so the bug shipped behind an unused option.
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            streamUsage: true,
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }], usage: null })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null })}\n\n`,
                    `data: ${JSON.stringify({
                        choices: [],
                        usage: { prompt_tokens: 4096, completion_tokens: 1 },
                    })}\n\n`,
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        const usage = chunks.filter((chunk) => chunk.type === "usage")
        // Exactly one, from the chunk that had a real object — not three, and not a throw.
        expect(usage).toEqual([{ type: "usage", promptTokens: 4096, completionTokens: 1 }])
        expect(textOf(chunks)).toBe("a")
    })

    test("reasoning content is kept separate from the reply", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`,
                    delta("answer"),
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(chunks).toContainEqual({ type: "reasoning", delta: "thinking" })
        expect(textOf(chunks)).toBe("answer")
    })

    test("a DeepSeek reasoner stream keeps reasoning_content out of the reply", async () => {
        // The failure this guards against is reasoning text arriving in `text` and being delivered
        // to the user as the answer — which is what happens if `reasoning_content` is treated as
        // just another content field.
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.deepseek.com/v1",
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me think. " } }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Both weigh 1kg." } }] })}\n\n`,
                    delta("They weigh the same."),
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))

        expect(textOf(chunks)).toBe("They weigh the same.")
        expect(
            chunks
                .filter(
                    (c): c is Extract<ChatChunk, { type: "reasoning" }> => c.type === "reasoning",
                )
                .map((c) => c.delta)
                .join(""),
        ).toBe("Let me think. Both weigh 1kg.")
    })

    test("a server that ignores stream:true is still understood", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        choices: [{ message: { content: "whole answer" }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 5, completion_tokens: 2 },
                    }),
                    { headers: { "content-type": "application/json" } },
                ),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(textOf(chunks)).toBe("whole answer")
        expect(chunks).toContainEqual({ type: "finish", reason: "stop" })
    })

    test("an error page injected into a stream is a named failure", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => sseResponse([delta("a"), "data: <html>502 Bad Gateway</html>\n\n"]),
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /not JSON/,
        )
    })
})

describe("retries", () => {
    test("a 429 is retried and then succeeds", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => {
                calls += 1
                if (calls === 1) {
                    return new Response("rate limited", {
                        status: 429,
                        headers: { "retry-after": "0" },
                    })
                }
                return sseResponse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        expect(textOf(await drain(provider.chat(REQUEST, new AbortController().signal)))).toBe("ok")
        expect(calls).toBe(2)
    })

    test("a 500 is retried", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => {
                calls += 1
                if (calls === 1) return new Response("boom", { status: 500 })
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(calls).toBe(2)
    })

    test("a 401 is not retried, and the hint points at the key", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => {
                calls += 1
                return new Response("no", { status: 401 })
            },
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /401/,
        )
        expect(calls).toBe(1)
    })

    test("a 404 hint names the version-segment mistake", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => new Response("nope", { status: 404 }),
        })
        try {
            await drain(provider.chat(REQUEST, new AbortController().signal))
            throw new Error("expected a failure")
        } catch (error) {
            expect((error as { hint: string }).hint).toContain("version segment")
        }
    })

    test("retries are reported, so the runtime can emit an event", async () => {
        const seen: number[] = []
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
            onRetry: (info) => seen.push(info.status),
            fetch: async () => {
                calls += 1
                if (calls < 3) return new Response("later", { status: 503 })
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toEqual([503, 503])
    })

    test("exhausting the attempts surfaces the last status", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => new Response("still down", { status: 503 }),
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /503/,
        )
    })

    test("a network failure is retried, then reported as unreachable", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => {
                calls += 1
                throw new TypeError("connection refused")
            },
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /Cannot reach/,
        )
        expect(calls).toBe(2)
    })
})

describe("cancellation", () => {
    test("an already-aborted signal yields nothing and does not throw", async () => {
        const controller = new AbortController()
        controller.abort()
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => sseResponse([delta("a")]),
        })
        expect(await drain(provider.chat(REQUEST, controller.signal))).toEqual([])
    })

    test("aborting mid-stream stops yielding without rejecting", async () => {
        const controller = new AbortController()
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => {
                const stream = new ReadableStream<Uint8Array>({
                    async pull(streamController) {
                        await sleep(5)
                        streamController.enqueue(new TextEncoder().encode(delta("tick")))
                    },
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream" } })
            },
        })

        const chunks: ChatChunk[] = []
        for await (const chunk of provider.chat(REQUEST, controller.signal)) {
            chunks.push(chunk)
            if (chunks.length === 2) controller.abort()
        }

        expect(chunks.length).toBe(2)
    })
})

// ─── native tool calling on the wire ─────────────────────────────────────────────────────

/**
 * Two things here are worth more than the rest of this file put together, because both fail
 * *silently*: the message mapping, and the fragment reassembly.
 *
 * The body used to be built with `messages: request.messages`, correct only for as long as a message
 * was exactly `{role, content}`. A camelCase `toolCalls` on the wire is a field the API has never
 * heard of — the request succeeds, the model simply never sees the call it made, and the symptom is
 * an agent that repeats itself with no error anywhere.
 */

function toolCallFrame(entries: unknown[]): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: entries } }] })}\n\n`
}

function callsOf(chunks: ChatChunk[]) {
    return chunks
        .filter((c): c is Extract<ChatChunk, { type: "tool_call" }> => c.type === "tool_call")
        .map((c) => c.call)
}

async function capture(
    frames: string[],
    request = REQUEST,
): Promise<{ body: Record<string, unknown>; chunks: ChatChunk[] }> {
    let body: Record<string, unknown> = {}
    const provider = createChatCompletionsProvider({
        baseUrl: "https://api.example.com/v1",
        fetch: async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>
            return sseResponse(frames)
        },
    })
    const chunks = await drain(provider.chat(request, new AbortController().signal))
    return { body, chunks }
}

describe("the tools request parameter", () => {
    test("absent entirely when no tools are given — a text-dialect body is unchanged", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"])
        expect("tools" in body).toBe(false)
    })

    test("wrapped in the function envelope the API expects", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            ...REQUEST,
            tools: [{ name: "now", description: "the time", parameters: { type: "object" } }],
        })
        expect(body.tools).toEqual([
            {
                type: "function",
                function: { name: "now", description: "the time", parameters: { type: "object" } },
            },
        ])
    })
})

describe("messages on the wire use wire names", () => {
    test("an assistant message's calls are sent as tool_calls, not toolCalls", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            model: "m",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
                },
            ],
        })
        const [message] = body.messages as Record<string, unknown>[]
        expect(message?.tool_calls).toEqual([
            { id: "c1", type: "function", function: { name: "now", arguments: "{}" } },
        ])
        expect("toolCalls" in (message ?? {})).toBe(false)
    })

    test("content is null beside a call, since some endpoints reject an empty string there", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            model: "m",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
                },
            ],
        })
        expect((body.messages as Record<string, unknown>[])[0]?.content).toBe(null)
    })

    test("a tool message names the call it answers", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            model: "m",
            messages: [{ role: "tool", content: "09:00", toolCallId: "c1" }],
        })
        const [message] = body.messages as Record<string, unknown>[]
        expect(message?.role).toBe("tool")
        expect(message?.tool_call_id).toBe("c1")
    })

    test("an ordinary message is exactly what it always was", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"])
        expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    })
})

describe("reassembling streamed tool_calls", () => {
    test("arguments arrive in fragments and are joined in order", async () => {
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, id: "call_1", function: { name: "now", arguments: "" } }]),
            toolCallFrame([{ index: 0, function: { arguments: '{"time' } }]),
            toolCallFrame([{ index: 0, function: { arguments: 'zone":"UTC"}' } }]),
            "data: [DONE]\n\n",
        ])
        expect(callsOf(chunks)).toEqual([
            { id: "call_1", name: "now", arguments: '{"timezone":"UTC"}' },
        ])
    })

    test("two interleaved calls stay separate, and come back in index order", async () => {
        // Keyed by index rather than arrival, which is the whole reason a buffer exists.
        const { chunks } = await capture([
            toolCallFrame([
                { index: 0, id: "a", function: { name: "now", arguments: "{}" } },
                { index: 1, id: "b", function: { name: "send", arguments: "" } },
            ]),
            toolCallFrame([{ index: 1, function: { arguments: '{"to":"x"}' } }]),
            "data: [DONE]\n\n",
        ])
        expect(callsOf(chunks)).toEqual([
            { id: "a", name: "now", arguments: "{}" },
            { id: "b", name: "send", arguments: '{"to":"x"}' },
        ])
    })

    test("a call is emitted once complete, never as fragments", async () => {
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, id: "a", function: { name: "now", arguments: "{" } }]),
            toolCallFrame([{ index: 0, function: { arguments: "}" } }]),
            "data: [DONE]\n\n",
        ])
        // Three frames, one chunk. Half a JSON document is of no use to any consumer.
        expect(callsOf(chunks).length).toBe(1)
    })

    test("a stream that just ends still yields its calls", async () => {
        // No `[DONE]`. Some endpoints simply close the body, and a flush that only ran on the
        // sentinel would drop the call and report the turn as a plain reply.
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, id: "a", function: { name: "now", arguments: "{}" } }]),
        ])
        expect(callsOf(chunks).length).toBe(1)
    })

    test("a non-streaming JSON reply carries complete calls, with no index", async () => {
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return new Response(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    content: "",
                                    tool_calls: [
                                        {
                                            id: "a",
                                            function: { name: "now", arguments: "{}" },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                    { headers: { "content-type": "application/json" } },
                )
            },
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(body.model).toBe("m")
        expect(callsOf(chunks)).toEqual([{ id: "a", name: "now", arguments: "{}" }])
    })

    test("an endpoint that omits the id gets a synthesised one rather than losing the call", async () => {
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, function: { name: "now", arguments: "{}" } }]),
            "data: [DONE]\n\n",
        ])
        expect(callsOf(chunks)[0]?.id).toBe("call_0")
    })

    test("a cancelled stream drops a half-arrived call rather than executing half a document", async () => {
        const controller = new AbortController()
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1",
            fetch: async () =>
                sseResponse([
                    toolCallFrame([
                        { index: 0, id: "a", function: { name: "now", arguments: '{"t' } },
                    ]),
                    delta("x"),
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks: ChatChunk[] = []
        for await (const chunk of provider.chat(REQUEST, controller.signal)) {
            chunks.push(chunk)
            controller.abort()
        }
        expect(callsOf(chunks)).toEqual([])
    })
})

describe("reasoning effort", () => {
    test("reasoning_effort is sent when set, and absent when not", async () => {
        // Absent rather than null: an endpoint that has never seen the field is not asked to ignore
        // one, which is the same rule `tools` and `stream_options` follow.
        const withEffort = await captureBody({ reasoningEffort: "none" })
        expect(withEffort.reasoning_effort).toBe("none")

        const without = await captureBody({})
        expect("reasoning_effort" in without).toBe(false)
    })

    test("every effort level reaches the wire verbatim", async () => {
        for (const level of ["none", "minimal", "low", "medium", "high"] as const) {
            const body = await captureBody({ reasoningEffort: level })
            expect(body.reasoning_effort).toBe(level)
        }
    })
})
