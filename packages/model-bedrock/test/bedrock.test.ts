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
    roleWarnings,
    toChunks,
} from "../src/index.ts"

const MODEL = "eu.anthropic.claude-sonnet-4-6"
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
        expect(input.inferenceConfig).toEqual({ maxTokens: 8192 + 16_384 })
    })

    describe("reasoning effort by model (VelaCrew tiers, pilot.6)", () => {
        const fields = (
            model: string,
            effort: ChatRequest["reasoningEffort"],
            temperature?: number,
        ) =>
            converseInput(
                {
                    model,
                    messages: [{ role: "user", content: "hi" }],
                    ...(effort === undefined ? {} : { reasoningEffort: effort }),
                    ...(temperature === undefined ? {} : { temperature }),
                },
                CONFIG,
            )

        test("Claude 4.7 and later get adaptive thinking with an effort, never a budget or a temperature", () => {
            for (const model of [
                "eu.anthropic.claude-opus-4-7",
                "global.anthropic.claude-sonnet-5-5",
            ]) {
                const input = fields(model, "xhigh", 0.3)
                expect(input.additionalModelRequestFields).toEqual({
                    thinking: { type: "adaptive" },
                    output_config: { effort: "xhigh" },
                })
                expect(input.inferenceConfig).toEqual({ maxTokens: 32_768 })
            }
            expect(
                fields("global.anthropic.claude-opus-5-5", "max").additionalModelRequestFields,
            ).toEqual({
                thinking: { type: "adaptive" },
                output_config: { effort: "max" },
            })
        })

        test("none is each model's own off switch, or low effort where there is none", () => {
            expect(
                fields("global.anthropic.claude-sonnet-5-5", "none").additionalModelRequestFields,
            ).toEqual({
                thinking: { type: "between_tools" },
            })
            expect(
                fields("global.anthropic.claude-opus-5-5", "none").additionalModelRequestFields,
            ).toEqual({
                thinking: { type: "adaptive" },
                output_config: { effort: "low" },
            })
            expect(
                fields("us.anthropic.claude-opus-5", "none").additionalModelRequestFields,
            ).toEqual({
                thinking: { type: "disabled" },
            })
        })

        test("an unset effort sends nothing, and 4.6 keeps its budget", () => {
            expect(
                fields("global.anthropic.claude-opus-5-5", undefined).additionalModelRequestFields,
            ).toBeUndefined()
            expect(
                fields("eu.anthropic.claude-opus-4-6", "high").additionalModelRequestFields,
            ).toEqual({
                thinking: { type: "enabled", budget_tokens: 16_384 },
            })
        })

        test("an openai model gets the effort as reasoning.effort; Nova gets none", () => {
            // Top-level `reasoning_effort` is a 400 `unknown_parameter` on Bedrock (probed).
            expect(
                fields("global.openai.gpt-6-luna", "xhigh").additionalModelRequestFields,
            ).toEqual({
                reasoning: { effort: "xhigh" },
            })
            expect(
                fields("amazon.nova-micro-v1:0", "high").additionalModelRequestFields,
            ).toBeUndefined()
        })

        test("GPT-6 is never sent a temperature; gpt-oss and Nova still are (VelaCrew, pilot.6)", () => {
            // Bedrock: "This model doesn't support the temperature field" on every turn of Luna.
            expect(
                fields("global.openai.gpt-6-luna", undefined, 0.3).inferenceConfig,
            ).toBeUndefined()
            expect(fields("openai.gpt-oss-120b-1:0", undefined, 0.3).inferenceConfig).toEqual({
                temperature: 0.3,
            })
            expect(fields("amazon.nova-micro-v1:0", undefined, 0.3).inferenceConfig).toEqual({
                temperature: 0.3,
            })
        })

        test("what cannot be honoured is said at load", () => {
            const codes = (id: string, extra: Record<string, unknown>) =>
                roleWarnings({ id, api: "bedrock-converse", ...extra }, "model.main").map(
                    (w) => w.code,
                )
            expect(codes("global.anthropic.claude-opus-5-5", { reasoningEffort: "none" })).toEqual([
                "model_thinking_always_on",
            ])
            expect(codes("global.anthropic.claude-sonnet-5-5", { temperature: 0.2 })).toEqual([
                "model_sampling_unsupported",
            ])
            expect(codes("eu.anthropic.claude-sonnet-4-6", { temperature: 0.2 })).toEqual([])
            expect(codes("global.openai.gpt-6-luna", { temperature: 0.3 })).toEqual([
                "model_sampling_unsupported",
            ])
            expect(codes("openai.gpt-oss-120b-1:0", { temperature: 0.3 })).toEqual([])
        })

        test("a refusal stop reason is a content_filter finish", async () => {
            const chunks = await collect(
                toChunks(events([{ messageStop: { stopReason: "refusal" as never } }])),
            )
            expect(chunks).toContainEqual({ type: "finish", reason: "content_filter" })
        })
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

    test("an image becomes an image block of raw bytes after the text (pilot.5)", () => {
        const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2])
        const input = converseInput(
            {
                model: MODEL,
                messages: [
                    {
                        role: "user",
                        content: "what is this?\n\n[image: files/c1/shot.png]",
                        images: [
                            {
                                mediaType: "image/png",
                                data: Buffer.from(png).toString("base64"),
                                ref: "files/c1/shot.png",
                            },
                        ],
                    },
                ],
            },
            CONFIG,
        )
        expect(input.messages?.[0]?.content).toEqual([
            { text: "what is this?\n\n[image: files/c1/shot.png]" },
            { image: { format: "png", source: { bytes: png } } },
        ])
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

    test("a credentials endpoint that refuses is not a missing chain (pilot.4)", () => {
        // What the SDK's HTTP provider throws once its retry wrapper has re-thrown it: the body is
        // gone, the status survives in the text.
        const refused = classify(
            Object.assign(
                new Error("CredentialsProviderError: Server responded with status: 403"),
                { name: "CredentialsProviderError" },
            ),
            MODEL,
            "eu-west-1",
            "model.main",
        )
        expect(refused.retryable).toBe(false)
        expect(refused.error.code).toBe("bedrock_credentials_refused")
        expect(refused.error.status).toBe(403)
    })

    test("a new account's onboarding refusals name the onboarding step, not the model id or IAM", () => {
        // Both messages verbatim from a live account, 2026-09-28.
        const form = classify(
            {
                name: "ResourceNotFoundException",
                message:
                    "Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model.",
                $metadata: { httpStatusCode: 404 },
            },
            MODEL,
            "eu-west-1",
            "model.main",
        )
        expect(form.error.hint).toContain("use-case form")
        const verifying = classify(
            {
                name: "AccessDeniedException",
                message:
                    "Your account is currently being verified. Verification normally takes less than 2 hours.",
                $metadata: { httpStatusCode: 403 },
            },
            MODEL,
            "eu-west-2",
            "model.main",
        )
        expect(verifying.error.status).toBe(403)
        expect(verifying.error.hint).toContain("still verifying")
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
        // A fresh session opens with the person's message under native too, not the model's call.
        expect(inputs[1]?.messages?.map((m) => m.role)).toEqual(["user", "assistant", "user"])
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

describe("an NLT tool turn on Nova", () => {
    /** One step of plain text, as Nova streams it. */
    const said = (text: string): ConverseStreamOutput[] => [
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "end_turn" } },
    ]

    test("every request starts with a user message, step two included (VelaCrew, pilot.5)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bedrock-nova-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: nova
model:
  main:
    id: amazon.nova-micro-v1:0
    api: bedrock-converse
    options:
      region: eu-west-1
tools:
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
            return events(inputs.length === 1 ? said("ACTION: now\nEND") : said("It is noon."))
        }
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: {},
            store: ":memory:",
            modelTransports: { "bedrock-converse": bedrockTransport(async () => send) },
        })
        const reply = await runtime
            .agent("nova")
            .send("Use your now tool to check the current time")
        await runtime.stop()

        expect(inputs.length).toBe(2)
        for (const input of inputs) expect(input.messages?.[0]?.role).toBe("user")
        // The question, then the call it led to, then what the call returned.
        const second = inputs[1]?.messages ?? []
        expect(second[0]?.content?.[0]).toEqual({
            text: "Use your now tool to check the current time",
        })
        expect(second[1]?.role).toBe("assistant")
        expect(JSON.stringify(second[2]?.content)).toContain("OBSERVATION now")
        expect(reply.text).toBe("It is noon.")
    })
})

test("a transport's load warnings reach the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-warn-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: warned
model:
  main:
    id: global.anthropic.claude-opus-5-5
    api: bedrock-converse
    reasoningEffort: none
    options:
      region: eu-west-1
`,
    )
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: {
            "bedrock-converse": bedrockTransport(async () => async () => events([])),
        },
    })
    const codes = runtime.agent("warned")?.warnings.map((warning) => warning.code) ?? []
    await runtime.stop()
    expect(codes).toContain("model_thinking_always_on")
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
