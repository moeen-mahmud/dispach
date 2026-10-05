/**
 * Voice notes in and images out (doc 16 R8), read at the far end: what the turn was given, what the
 * channel was handed, what the ledger recorded.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChannelFactory,
    type ChannelHost,
    type ChatChunk,
    type ErrorDetail,
    editManifest,
    type InboundAudio,
    type InboundImage,
    isHarnessError,
    type MediaProviderFactory,
    type ModelTransport,
    OPENAI_MEDIA_PROVIDER,
    type OutboundMessage,
    Runtime,
    resolveMedia,
    withDeadline,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
        if (check()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${what}`)
}

async function refusal(work: () => unknown): Promise<{ code: string; message: string }> {
    try {
        await work()
    } catch (error) {
        if (isHarnessError(error)) return { code: error.code, message: error.message }
        throw error
    }
    throw new Error("expected a refusal")
}

/** A model that calls `image_generate` once per input when asked to draw, then answers. */
function scripted(inputs: string[]): ModelTransport {
    const drew = new Set<string>()
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                const last = request.messages.findLast((message) => message.role === "user")
                const seen = last?.images?.map((image) => image.mediaType).join(",")
                const input = `${String(last?.content)}${seen === undefined ? "" : ` <${seen}>`}`
                if (!drew.has(input)) inputs.push(input)
                if (input.includes("draw") && !drew.has(input)) {
                    drew.add(input)
                    yield {
                        type: "tool_call",
                        call: {
                            id: "c1",
                            name: "image_generate",
                            arguments: JSON.stringify({ prompt: "a red cube" }),
                        },
                    }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                drew.add(input)
                yield { type: "text", delta: input.includes("draw") ? "Here it is." : "Heard you." }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

type Transcribe = () => Promise<{ text: string; durationS?: number }>

function fakeMedia(transcribe: Transcribe): MediaProviderFactory {
    return {
        create: () => ({
            transcribe: () => transcribe(),
            generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
        }),
    }
}

async function boot(options: {
    media?: string
    transcribe?: Transcribe
    attachments?: boolean
    allowFrom?: string
    vision?: boolean
}) {
    const dir = mkdtempSync(join(tmpdir(), "media-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: crew
model:
  main:
    id: scripted
    api: scripted
    capabilities:
      nativeTools: true${options.vision === true ? "\n      vision: true" : ""}
tools:
  dialect: native
channels:
  - type: stub
    id: tg
    allowFrom: ["${options.allowFrom ?? "*"}"]
${options.media ?? ""}`,
    )
    const sent: OutboundMessage[] = []
    const errors: ErrorDetail[] = []
    let host: ChannelHost | undefined
    const stub: ChannelFactory = (context) => ({
        id: context.id,
        type: "stub",
        limits: {
            maxMessageChars: 4096,
            idempotentSend: false,
            ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
        },
        start: async (h: ChannelHost) => {
            host = h
        },
        stop: async () => {},
        send: async (message) => {
            sent.push(message)
            return { ok: true as const }
        },
    })
    const inputs: string[] = []
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        startChannels: true,
        modelTransports: { scripted: scripted(inputs) },
        mediaProviders: {
            fake: fakeMedia(
                options.transcribe ?? (async () => ({ text: "hello there", durationS: 4 })),
            ),
        },
        channels: { stub },
    })
    runtime.bus.on("agent.channel.error", (event) => {
        if (event.type === "agent.channel.error") errors.push(event.data)
    })
    const deliver = (
        text: string,
        audio?: InboundAudio,
        senderId = "42",
        images?: readonly InboundImage[],
    ) =>
        host?.receive({
            providerMessageId: `m${Math.random()}`,
            peerId: "900",
            senderId,
            senderHandle: senderId,
            text,
            ...(audio === undefined ? {} : { audio }),
            ...(images === undefined ? {} : { images }),
            receivedAt: new Date().toISOString(),
        })
    return { runtime, dir, sent, errors, inputs, deliver }
}

const voice = (fetched: string[]): InboundAudio => ({
    mimeType: "audio/ogg",
    durationS: 3,
    fetch: async () => {
        fetched.push("fetched")
        return new Uint8Array([1, 2, 3])
    },
})

describe("the openai media provider", () => {
    test("posts the audio as a file with an extension the endpoint can sniff, and reads the text", async () => {
        const seen: { url: string; form: FormData; authorization: string }[] = []
        const provider = OPENAI_MEDIA_PROVIDER.create({
            field: "media.transcription",
            config: { provider: "openai", model: "whisper-1", timeoutMs: 1000, maxBytes: 1000 },
            options: undefined,
            env: { OPENAI_API_KEY: "sk-test" },
            fetch: async (url, init) => {
                seen.push({
                    url: String(url),
                    form: init?.body as FormData,
                    authorization: new Headers(init?.headers).get("authorization") ?? "",
                })
                return Response.json({ text: " hello ", duration: 2.5 })
            },
        })
        const transcript = await provider.transcribe?.(
            { bytes: new Uint8Array([1]), mimeType: "audio/ogg; codecs=opus" },
            new AbortController().signal,
        )
        expect(transcript).toEqual({ text: " hello ", durationS: 2.5 })
        expect(seen[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions")
        expect(seen[0]?.authorization).toBe("Bearer sk-test")
        const form = seen[0]?.form
        expect(form?.get("model")).toBe("whisper-1")
        expect((form?.get("file") as File | null)?.name).toBe("voice.ogg")
    })

    test("a missing key, an unknown provider and a provider that cannot do the job are refused at load", async () => {
        const manifest = (media: object) => ({ media }) as Parameters<typeof resolveMedia>[0]
        expect(
            (
                await refusal(() =>
                    resolveMedia(
                        manifest({ image: { provider: "openai", timeoutMs: 1, size: "1x1" } }),
                        {
                            env: {},
                        },
                    ),
                )
            ).code,
        ).toBe("media_key_missing")
        const unknown = await refusal(() =>
            resolveMedia(manifest({ image: { provider: "aws", timeoutMs: 1, size: "1x1" } }), {
                env: {},
            }),
        )
        expect(unknown.code).toBe("media_provider_unknown")
        expect(unknown.message).toContain("Registered: openai")
        expect(
            (
                await refusal(() =>
                    resolveMedia(
                        manifest({ image: { provider: "ears", timeoutMs: 1, size: "1x1" } }),
                        {
                            env: {},
                            providers: new Map([
                                [
                                    "ears",
                                    { create: () => ({ transcribe: async () => ({ text: "" }) }) },
                                ],
                            ]),
                        },
                    ),
                )
            ).code,
        ).toBe("media_provider_incapable")
    })

    test("a deadline holds against a provider that ignores its signal", async () => {
        const started = Date.now()
        const refused = await refusal(() =>
            withDeadline(40, "Hanging", () => new Promise(() => {})),
        )
        expect(refused.code).toBe("media_timeout")
        expect(Date.now() - started).toBeLessThan(1000)
    })
})

const TRANSCRIPTION = "media:\n  transcription:\n    provider: fake\n    model: ears-1\n"

describe("voice notes on a channel", () => {
    test("become the turn's input, framed as a transcription, and are metered in seconds", async () => {
        const { runtime, inputs, sent, deliver } = await boot({ media: TRANSCRIPTION })
        const results: string[] = []
        runtime.bus.on("media.result", (event) => {
            if (event.type === "media.result") {
                results.push(`${event.data.kind}:${event.data.audioSeconds}`)
            }
        })
        deliver("", voice([]))
        await until(() => sent.length === 1, "the reply")
        expect(inputs).toEqual(["[Voice note, transcribed]\nhello there"])
        expect(sent[0]?.text).toBe("Heard you.")
        // The provider's duration wins over the channel's when both are known.
        expect(results).toEqual(["transcription:4"])
        const report = await runtime.store.usage.report({ by: ["model"] })
        const row = report.buckets.find((bucket) => bucket.model === "ears-1")
        expect(row?.audioSeconds).toBe(4)
        expect(row?.promptTokens).toBe(0)
        // Tokens zero and reported: a media call must not read as an estimate.
        expect(row?.estimatedCalls).toBe(0)
        await runtime.stop()
    })

    test("with no transcription configured, the sender is told and no turn runs", async () => {
        const { runtime, inputs, sent, errors, deliver } = await boot({})
        const fetched: string[] = []
        deliver("", voice(fetched))
        await until(() => sent.length === 1, "the refusal")
        expect(sent[0]?.text).toContain("can't listen to voice notes")
        expect(inputs).toEqual([])
        expect(fetched).toEqual([])
        expect(errors.map((error) => error.code)).toEqual(["media_transcription_unconfigured"])
        await runtime.stop()
    })

    test("a hung transcription is abandoned at the deadline, the sender is told, and the conversation is not stuck", async () => {
        const { runtime, inputs, sent, errors, deliver } = await boot({
            media: `${TRANSCRIPTION}    timeoutMs: 50\n`,
            transcribe: () => new Promise(() => {}),
        })
        deliver("", voice([]))
        deliver("still there?")
        await until(() => sent.length === 2, "both replies")
        expect(sent[0]?.text).toContain("in time")
        expect(sent[1]?.text).toBe("Heard you.")
        expect(inputs).toEqual(["still there?"])
        expect(errors[0]?.code).toBe("media_timeout")
        await runtime.stop()
    })

    test("a sender allowFrom refuses never has their audio downloaded", async () => {
        const { runtime, deliver } = await boot({ media: TRANSCRIPTION, allowFrom: "7" })
        const fetched: string[] = []
        deliver("", voice(fetched), "42")
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(fetched).toEqual([])
        await runtime.stop()
    })
})

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])

const photo = (fetched: string[], bytes: Uint8Array = JPEG, sizeBytes?: number): InboundImage => ({
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    fetch: async () => {
        fetched.push("fetched")
        return bytes
    },
})

describe("photos on a channel", () => {
    test("reach the model with the turn, typed by their bytes, with the caption as the text", async () => {
        const { runtime, inputs, sent, deliver } = await boot({ vision: true })
        deliver("what is this?", undefined, "42", [photo([]), photo([], PNG)])
        await until(() => sent.length === 1, "the reply")
        expect(inputs).toEqual([
            "what is this?\n\n[image: photo 1]\n[image: photo 2] <image/jpeg,image/png>",
        ])
        await runtime.stop()
    })

    test("on a model that cannot read images, the sender is told and nothing is downloaded", async () => {
        const { runtime, inputs, sent, errors, deliver } = await boot({})
        const fetched: string[] = []
        deliver("", undefined, "42", [photo(fetched)])
        await until(() => sent.length === 1, "the refusal")
        expect(sent[0]?.text).toContain("can't see photos")
        expect(inputs).toEqual([])
        expect(fetched).toEqual([])
        expect(errors.map((error) => error.code)).toEqual(["model_no_vision"])
        await runtime.stop()
    })

    test("too large by the provider's figure is refused before the download; not an image after it", async () => {
        const { runtime, inputs, sent, errors, deliver } = await boot({ vision: true })
        const fetched: string[] = []
        deliver("", undefined, "42", [photo(fetched, JPEG, 50_000_000)])
        await until(() => sent.length === 1, "the size refusal")
        expect(fetched).toEqual([])
        deliver("", undefined, "42", [photo(fetched, new Uint8Array([1, 2, 3]))])
        await until(() => sent.length === 2, "the type refusal")
        expect(sent[0]?.text).toContain("too large")
        expect(sent[1]?.text).toContain("PNG, JPEG")
        expect(errors.map((error) => error.code)).toEqual(["image_too_large", "image_unsupported"])
        expect(inputs).toEqual([])
        await runtime.stop()
    })

    test("past five, the rest are not fetched and the turn still runs", async () => {
        const { runtime, inputs, sent, deliver } = await boot({ vision: true })
        const fetched: string[] = []
        deliver(
            "album",
            undefined,
            "42",
            Array.from({ length: 7 }, () => photo(fetched)),
        )
        await until(() => sent.length === 1, "the reply")
        expect(fetched.length).toBe(5)
        expect(inputs[0]).toContain("[image: photo 5]")
        await runtime.stop()
    })
})

const IMAGE = "media:\n  image:\n    provider: fake\n    model: canvas-1\n"

describe("image_generate", () => {
    test("saves under media/, and the channel is handed the reply, then the image", async () => {
        const { runtime, dir, sent, deliver } = await boot({ media: IMAGE, attachments: true })
        const ends: unknown[] = []
        runtime.bus.on("turn.end", (event) => {
            if (event.type === "turn.end") ends.push(event.data.attachments)
        })
        deliver("draw me a cube")
        await until(() => sent.length === 2, "text and image")
        expect(sent[0]?.text).toBe("Here it is.")
        const image = sent[1]?.attachment
        expect(image?.mimeType).toBe("image/png")
        expect(image?.path.startsWith(join(dir, "media"))).toBe(true)
        expect(existsSync(image?.path ?? "")).toBe(true)
        const ended = ends[0] as { path: string; mimeType: string }[]
        expect(ended.length).toBe(1)
        expect(ended[0]?.path).toMatch(/^media\/.+\.png$/)
        expect(ended[0]?.mimeType).toBe("image/png")
        const report = await runtime.store.usage.report({ by: ["model"] })
        expect(report.buckets.find((bucket) => bucket.model === "canvas-1")?.images).toBe(1)
        await runtime.stop()
    })

    test("a channel that cannot carry files names the image in the text instead of dropping it", async () => {
        const { runtime, sent, deliver } = await boot({ media: IMAGE })
        deliver("draw me a cube")
        await until(() => sent.length === 1, "the reply")
        expect(sent[0]?.attachment).toBeUndefined()
        expect(sent[0]?.text).toMatch(
            /^Here it is\.\n\n\(.+\.png is in my workspace; this channel cannot carry files\.\)$/,
        )
        await runtime.stop()
    })

    test("is not in the catalogue unless media.image is declared", async () => {
        const { runtime } = await boot({ media: TRANSCRIPTION })
        expect(runtime.agent("crew").tools.has("image_generate")).toBe(false)
        await runtime.stop()
    })
})

describe("changing media through settings never takes the agent down", () => {
    test("the writer refuses a provider that does not exist, and lets a missing key through", async () => {
        const { runtime, dir } = await boot({})
        await runtime.stop()
        const file = join(dir, "agent.yaml")
        const before = readFileSync(file, "utf8")
        const providers = { fake: fakeMedia(async () => ({ text: "x" })) }
        const refused = await refusal(() =>
            editManifest({
                file,
                path: ["media"],
                value: { image: { provider: "midjourney" } },
                mediaProviders: providers,
            }),
        )
        expect(refused.code).toBe("media_provider_unknown")
        expect(readFileSync(file, "utf8")).toBe(before)
        // The key is the person's next step, not a mistake: enabling first is the intended order.
        await editManifest({
            file,
            path: ["media"],
            value: { image: { provider: "openai", apiKeyEnv: "NOT_SET_YET" } },
            mediaProviders: providers,
        })
        expect(readFileSync(file, "utf8")).toContain("NOT_SET_YET")
    })

    test("a reload onto a manifest the agent cannot be built from fails, and the old agent keeps answering", async () => {
        const { runtime, dir, sent, deliver } = await boot({ media: IMAGE, attachments: true })
        const file = join(dir, "agent.yaml")
        writeFileSync(
            file,
            readFileSync(file, "utf8").replace("provider: fake", "provider: midjourney"),
        )
        const failed = await refusal(() => runtime.reload("crew"))
        expect(failed.code).toBe("media_provider_unknown")
        expect(runtime.agent("crew").tools.has("image_generate")).toBe(true)
        deliver("still there?")
        await until(() => sent.length === 1, "a reply from the old agent")
        expect(sent[0]?.text).toBe("Heard you.")
        await runtime.stop()
    })
})
