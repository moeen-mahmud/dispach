/**
 * `bedrock-converse` against a recorded ConverseStream: the request Bedrock would receive, the chunks
 * the loop would see, and one real turn through the runtime. The sender is injected, so the SDK is
 * never loaded here — which is also the claim `bundle.test.ts` makes about boot.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
    ConverseStreamCommandInput,
    ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime"
import { BRAND, type ChatChunk, type ChatRequest, Runtime } from "@dispach/core"
import {
    bedrockTransport,
    type ConverseSend,
    classify,
    converseInput,
    toChunks,
} from "../src/index.ts"

const MODEL = "eu.anthropic.claude-sonnet-4-6-v1:0"
const CONFIG = { id: MODEL, api: "bedrock-converse", options: { region: "eu-west-1" } }

async function* events(list: ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
    for (const event of list) yield event
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = []
    for await (const chunk of stream) out.push(chunk)
    return out
}

/** A turn that thinks, calls a tool, and reports usage with cache figures. */
const TOOL_STEP: ConverseStreamOutput[] = [
    { messageStart: { role: "assistant" } },
    {
        contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: "Need the time." } },
        },
    },
    {
        contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: "sig-1" } },
        },
    },
    { contentBlockStop: { contentBlockIndex: 0 } },
    {
        contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: "tu_1", name: "now" } },
        },
    },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"zone"' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: ':"UTC"}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: "tool_use" } },
    {
        metadata: {
            usage: {
                inputTokens: 40,
                outputTokens: 12,
                totalTokens: 1052,
                cacheReadInputTokens: 900,
                cacheWriteInputTokens: 100,
            },
            metrics: { latencyMs: 300 },
        },
    },
]

describe("request mapping", () => {
    test("system split, roles merged, cachePoint after each breakpoint, thinking replayed", () => {
        const request: ChatRequest = {
            model: MODEL,
            messages: [
                { role: "system", content: "identity" },
                { role: "system", content: "tools and config", cacheBreakpoint: true },
                { role: "user", content: "what time is it?" },
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "tu_1", name: "now", arguments: '{"zone":"UTC"}' }],
                    thinking: [{ text: "Need the time.", signature: "sig-1" }],
                },
                { role: "tool", content: "12:00", toolCallId: "tu_1" },
                { role: "system", content: "reminder: be brief" },
            ],
            tools: [{ name: "now", description: "the time", parameters: { type: "object" } }],
            maxTokens: 1000,
        }
        const input = converseInput(request, CONFIG)
        expect(input.system).toEqual([
            { text: "identity" },
            { text: "tools and config" },
            { cachePoint: { type: "default" } },
        ])
        expect(input.messages?.map((m) => m.role)).toEqual(["user", "assistant", "user"])
        expect(input.messages?.[1]?.content).toEqual([
            { reasoningContent: { reasoningText: { text: "Need the time.", signature: "sig-1" } } },
            { toolUse: { toolUseId: "tu_1", name: "now", input: { zone: "UTC" } } },
        ])
        // The observation and the late system message merge into one user turn.
        expect(input.messages?.[2]?.content).toEqual([
            { toolResult: { toolUseId: "tu_1", content: [{ text: "12:00" }] } },
            { text: "reminder: be brief" },
        ])
        expect(input.toolConfig?.tools?.[0]).toEqual({
            toolSpec: {
                name: "now",
                description: "the time",
                inputSchema: { json: { type: "object" } },
            },
        })
        expect(input.inferenceConfig).toEqual({ maxTokens: 1000 })
    })

    test("thinking effort becomes a budget, drops temperature and lifts maxTokens above it", () => {
        const input = converseInput(
            {
                model: MODEL,
                messages: [{ role: "user", content: "hi" }],
                reasoningEffort: "medium",
                temperature: 0.3,
            },
            CONFIG,
        )
        expect(input.additionalModelRequestFields).toEqual({
            thinking: { type: "enabled", budget_tokens: 8192 },
        })
        expect(input.inferenceConfig).toEqual({ maxTokens: 8192 + 4096 })
    })

    test("a model family without prompt caching is sent no cachePoint, nor is one opted out", () => {
        const messages = [{ role: "system" as const, content: "s", cacheBreakpoint: true as const }]
        const other = converseInput({ model: "meta.llama3-70b-instruct-v1:0", messages }, CONFIG)
        expect(other.system).toEqual([{ text: "s" }])
        const off = converseInput(
            { model: MODEL, messages },
            { ...CONFIG, capabilities: { promptCache: "none" } },
        )
        expect(off.system).toEqual([{ text: "s" }])
    })
})

describe("stream mapping", () => {
    test("reasoning streams and closes into a signed block; tool input is reassembled; usage is whole", async () => {
        const chunks = await collect(toChunks(events(TOOL_STEP)))
        expect(chunks).toEqual([
            { type: "reasoning", delta: "Need the time." },
            { type: "thinking_block", block: { text: "Need the time.", signature: "sig-1" } },
            { type: "tool_call", call: { id: "tu_1", name: "now", arguments: '{"zone":"UTC"}' } },
            { type: "finish", reason: "tool_calls" },
            {
                type: "usage",
                promptTokens: 1040,
                completionTokens: 12,
                cachedPromptTokens: 900,
                cacheSource: "metadata.usage.cacheReadInputTokens",
                cacheWriteTokens: 100,
            },
        ])
    })
})

describe("errors", () => {
    const sdkError = (name: string, status: number) =>
        Object.assign(new Error(`${name} happened`), {
            name,
            $metadata: { httpStatusCode: status },
        })

    test("throttling retries; access denied is a terminal 403; no credentials names the chain", () => {
        expect(
            classify(sdkError("ThrottlingException", 429), MODEL, "eu-west-1", "model.main")
                .retryable,
        ).toBe(true)
        const denied = classify(
            sdkError("AccessDeniedException", 403),
            MODEL,
            "eu-west-1",
            "model.main",
        )
        expect(denied.retryable).toBe(false)
        expect(denied.error.status).toBe(403)
        expect(denied.error.code).toBe("model_access_denied")
        const noCreds = classify(
            Object.assign(new Error("Could not load credentials from any providers"), {
                name: "CredentialsProviderError",
            }),
            MODEL,
            "eu-west-1",
            "model.main",
        )
        expect(noCreds.error.code).toBe("bedrock_credentials_missing")
        expect(noCreds.error.hint).toContain("AWS_CONTAINER_CREDENTIALS_FULL_URI")
    })

    test("the transport retries before output, reports each retry, and stops on a 403 at once", async () => {
        const throttled = Object.assign(new Error("slow down"), {
            name: "ThrottlingException",
            $metadata: { httpStatusCode: 429 },
        })
        const denied = Object.assign(new Error("no"), {
            name: "AccessDeniedException",
            $metadata: { httpStatusCode: 403 },
        })
        for (const [failure, expectedCalls, expectedRetries] of [
            [throttled, 3, 2],
            [denied, 1, 0],
        ] as const) {
            let calls = 0
            const retries: number[] = []
            const send: ConverseSend = async () => {
                calls += 1
                throw failure
            }
            const provider = bedrockTransport(async () => send).create({
                id: "bedrock-converse:main",
                field: "model.main",
                config: CONFIG,
                options: { region: "eu-west-1" },
                retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
                onRetry: (info) => retries.push(info.status),
            })
            let status: number | undefined
            try {
                await collect(
                    provider.chat({ model: MODEL, messages: [] }, new AbortController().signal),
                )
            } catch (error) {
                status = (error as { status?: number }).status
            }
            expect(calls).toBe(expectedCalls)
            expect(retries.length).toBe(expectedRetries)
            expect(status).toBe(failure === denied ? 403 : 429)
        }
    })
})

describe("through a real turn", () => {
    test("a tool call with thinking completes over two steps, replaying the signed block with a cachePoint", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bedrock-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: bedrocked
model:
  main:
    id: ${MODEL}
    api: bedrock-converse
    options:
      region: eu-west-1
tools:
  dialect: native
  local:
    - now
limits:
  maxSteps: 4
  turnTimeoutMs: 5000
`,
        )
        const inputs: ConverseStreamCommandInput[] = []
        const send: ConverseSend = async (input) => {
            inputs.push(input)
            return inputs.length === 1
                ? events(TOOL_STEP)
                : events([
                      {
                          contentBlockDelta: {
                              contentBlockIndex: 0,
                              delta: { text: "It is noon." },
                          },
                      },
                      { contentBlockStop: { contentBlockIndex: 0 } },
                      { messageStop: { stopReason: "end_turn" } },
                      {
                          metadata: {
                              usage: {
                                  inputTokens: 60,
                                  outputTokens: 4,
                                  totalTokens: 1064,
                                  cacheReadInputTokens: 1000,
                              },
                              metrics: { latencyMs: 200 },
                          },
                      },
                  ])
        }
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: {},
            store: ":memory:",
            modelTransports: { "bedrock-converse": bedrockTransport(async () => send) },
        })
        const reply = await runtime.agent("bedrocked").send("what time is it?")
        await new Promise((resolve) => setTimeout(resolve, 20))
        const [total] = (await runtime.store.usage.report({ by: [] })).buckets
        await runtime.stop()

        expect(reply.text).toBe("It is noon.")
        expect(inputs.length).toBe(2)
        const second = inputs[1]
        expect(second?.system?.some((block) => block.cachePoint !== undefined)).toBe(true)
        const call = second?.messages?.find((m) => m.role === "assistant")
        expect(call?.content?.[0]).toEqual({
            reasoningContent: { reasoningText: { text: "Need the time.", signature: "sig-1" } },
        })
        expect(
            second?.messages?.some((m) =>
                m.content?.some((c) => c.toolResult?.toolUseId === "tu_1"),
            ),
        ).toBe(true)
        expect(total?.cachedPromptTokens).toBe(1900)
        expect(total?.cacheWriteTokens).toBe(100)
    })
})

describe("capabilities through the transport", () => {
    test("Claude on Bedrock caches its prompt; a manifest's own promptCache still wins", async () => {
        const { resolveRoles } = await import("@dispach/core")
        const manifest = (capabilities?: { promptCache: "none" }) =>
            ({
                model: {
                    main: { ...CONFIG, ...(capabilities === undefined ? {} : { capabilities }) },
                },
            }) as unknown as Parameters<typeof resolveRoles>[0]
        const transports = new Map([
            ["bedrock-converse", bedrockTransport(async () => async () => events([]))],
        ])
        const cached = resolveRoles(manifest(), { transports }).main.capabilities
        expect(cached.promptCache).toBe("bedrock")
        expect(cached.nativeTools).toBe(true)
        expect(cached.thinking).toBe("anthropic")
        expect(
            resolveRoles(manifest({ promptCache: "none" }), { transports }).main.capabilities
                .promptCache,
        ).toBe("none")
    })
})
