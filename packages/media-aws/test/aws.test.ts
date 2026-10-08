/**
 * The `aws` media provider against injected clients: the request each SDK would be sent, and how
 * each answer is read. The real endpoints need VelaCrew's account; these are what can be settled
 * without one.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
    StartStreamTranscriptionCommandInput,
    TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming"
import { isHarnessError, type MediaProvider } from "@dispach/core"
import { type AwsClients, awsMedia, encodingOf, ffmpegDecode } from "../src/index.ts"

const signal = new AbortController().signal

function provider(clients: Partial<AwsClients>, model?: string): MediaProvider {
    return awsMedia({
        transcribe: async () => {
            throw new Error("no transcribe client")
        },
        invoke: async () => {
            throw new Error("no invoke client")
        },
        speak: async () => {
            throw new Error("no speak client")
        },
        decode: async () => {
            throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })
        },
        ...clients,
    }).create({
        field: "media.transcription",
        config: {
            provider: "aws",
            ...(model === undefined ? {} : { model }),
            timeoutMs: 1000,
            maxBytes: 1000,
        },
        options: { region: "eu-west-2", languageCode: "en-GB" },
        env: {},
    })
}

async function refusal(work: () => Promise<unknown>) {
    try {
        await work()
    } catch (error) {
        if (isHarnessError(error)) return error
        throw error
    }
    throw new Error("expected a refusal")
}

describe("Amazon Transcribe", () => {
    test("streams the note in chunks and joins the finished results, skipping partial ones", async () => {
        const inputs: StartStreamTranscriptionCommandInput[] = []
        const chunks: number[] = []
        const voice = provider({
            transcribe: async () => async (input) => {
                inputs.push(input)
                for await (const event of input.AudioStream ?? []) {
                    chunks.push(event.AudioEvent?.AudioChunk?.byteLength ?? 0)
                }
                const events: TranscriptResultStream[] = [
                    {
                        TranscriptEvent: {
                            Transcript: {
                                Results: [
                                    { IsPartial: true, Alternatives: [{ Transcript: "hel" }] },
                                ],
                            },
                        },
                    },
                    {
                        TranscriptEvent: {
                            Transcript: {
                                Results: [
                                    {
                                        IsPartial: false,
                                        EndTime: 1.2,
                                        Alternatives: [{ Transcript: "Hello." }],
                                    },
                                ],
                            },
                        },
                    },
                    {
                        TranscriptEvent: {
                            Transcript: {
                                Results: [
                                    {
                                        IsPartial: false,
                                        EndTime: 3.4,
                                        Alternatives: [{ Transcript: "Book the room." }],
                                    },
                                ],
                            },
                        },
                    },
                ]
                return (async function* () {
                    yield* events
                })()
            },
        })
        const transcript = await voice.transcribe?.(
            { bytes: new Uint8Array(20_000), mimeType: "audio/ogg; codecs=opus" },
            signal,
        )
        expect(transcript).toEqual({ text: "Hello. Book the room.", durationS: 3.4 })
        expect(inputs[0]).toMatchObject({
            LanguageCode: "en-GB",
            MediaEncoding: "ogg-opus",
            MediaSampleRateHertz: 48_000,
        })
        expect(chunks).toEqual([8192, 8192, 3616])
    })

    test("a container it cannot read, with no ffmpeg to convert it, is refused before any call", async () => {
        let called = false
        const voice = provider({
            transcribe: async () => {
                called = true
                return async () => (async function* () {})()
            },
        })
        const error = await refusal(async () =>
            voice.transcribe?.({ bytes: new Uint8Array(1), mimeType: "audio/webm" }, signal),
        )
        expect(error.code).toBe("media_audio_unsupported")
        expect(error.hint).toContain("ffmpeg")
        expect(error.hint).toContain("openai provider")
        expect(called).toBe(false)
        expect(encodingOf("audio/flac")).toBe("flac")
    })

    test("a WebM or M4A note is decoded to 16 kHz PCM and streamed as that (pilot.15)", async () => {
        let sent: StartStreamTranscriptionCommandInput | undefined
        const decoded: string[] = []
        const voice = provider({
            decode: async (bytes) => {
                decoded.push(String(bytes.byteLength))
                return new Uint8Array(32)
            },
            transcribe: async () => async (input) => {
                sent = input
                return (async function* () {
                    yield {
                        TranscriptEvent: {
                            Transcript: {
                                Results: [
                                    { IsPartial: false, Alternatives: [{ Transcript: "hi" }] },
                                ],
                            },
                        },
                    } as TranscriptResultStream
                })()
            },
        })
        const heard = await voice.transcribe?.(
            { bytes: new Uint8Array(5), mimeType: "audio/mp4" },
            signal,
        )
        expect(heard?.text).toBe("hi")
        expect(decoded).toEqual(["5"])
        expect(sent?.MediaEncoding).toBe("pcm")
        expect(sent?.MediaSampleRateHertz).toBe(16_000)
    })

    test("Ogg/Opus is never decoded", async () => {
        let decoded = false
        const voice = provider({
            decode: async () => {
                decoded = true
                return new Uint8Array(0)
            },
            transcribe: async () => async () => (async function* () {})(),
        })
        await voice.transcribe?.({ bytes: new Uint8Array(3), mimeType: "audio/ogg" }, signal)
        expect(decoded).toBe(false)
    })

    test("an access refusal names the IAM actions", async () => {
        const voice = provider({
            transcribe: async () => async () => {
                const denied = new Error("not authorized")
                denied.name = "AccessDeniedException"
                throw denied
            },
        })
        const error = await refusal(async () =>
            voice.transcribe?.({ bytes: new Uint8Array(1), mimeType: "audio/ogg" }, signal),
        )
        expect(error.hint).toContain("transcribe:StartStreamTranscription")
    })
})

describe("Nova Canvas", () => {
    test("asks for one image at the configured size and decodes the answer", async () => {
        const bodies: { modelId: string; body: unknown }[] = []
        const images = provider(
            {
                invoke: async () => async (input) => {
                    bodies.push({ modelId: input.modelId, body: JSON.parse(input.body) })
                    return JSON.stringify({ images: [Buffer.from([1, 2, 3]).toString("base64")] })
                },
            },
            "amazon.nova-canvas-v1:0",
        )
        const image = await images.generateImage?.(
            { prompt: "a red cube", size: "512x768" },
            signal,
        )
        expect([...(image?.bytes ?? [])]).toEqual([1, 2, 3])
        expect(image?.mimeType).toBe("image/png")
        expect(bodies).toEqual([
            {
                modelId: "amazon.nova-canvas-v1:0",
                body: {
                    taskType: "TEXT_IMAGE",
                    textToImageParams: { text: "a red cube" },
                    imageGenerationConfig: { numberOfImages: 1, width: 512, height: 768 },
                },
            },
        ])
    })

    test("an answer with no image is a refusal carrying Nova's reason", async () => {
        const images = provider({
            invoke: async () => async () =>
                JSON.stringify({ images: [], error: "blocked by filter" }),
        })
        const error = await refusal(async () =>
            images.generateImage?.({ prompt: "x", size: "1024x1024" }, signal),
        )
        expect(error.code).toBe("media_provider_empty")
        expect(error.message).toContain("blocked by filter")
    })

    test("options are checked at load", () => {
        const parsed = awsMedia().optionsSchema?.safeParse({ regoin: "eu-west-2" })
        expect(parsed?.success).toBe(false)
    })
})

describe("speech (pilot.15)", () => {
    const speaker = (clients: Partial<AwsClients>, options: Record<string, unknown> = {}) =>
        awsMedia({
            transcribe: async () => {
                throw new Error("no transcribe client")
            },
            invoke: async () => {
                throw new Error("no invoke client")
            },
            decode: async () => new Uint8Array(0),
            speak: async () => {
                throw new Error("no speak client")
            },
            ...clients,
        }).create({
            field: "media.speech",
            config: { provider: "aws", timeoutMs: 1000, maxCharacters: 3000 },
            options: { region: "eu-west-2", ...options },
            env: {},
        })

    test("asks Polly for Ogg/Opus with the voice and engine, defaulting to Joanna and neural", async () => {
        const asked: unknown[] = []
        const make = (options: Record<string, unknown>) =>
            speaker(
                {
                    speak: async () => async (input) => {
                        asked.push(input)
                        return { bytes: new Uint8Array([1, 2]), characters: 5 }
                    },
                },
                options,
            )
        const spoken = await make({}).synthesize?.({ text: "Hello" }, signal)
        expect(spoken).toEqual({
            bytes: new Uint8Array([1, 2]),
            mimeType: "audio/ogg; codecs=opus",
            characters: 5,
        })
        await make({ voiceId: "Amy", engine: "generative", languageCode: "en-GB" }).synthesize?.(
            { text: "Hi" },
            signal,
        )
        expect(asked).toEqual([
            { text: "Hello", voiceId: "Joanna", engine: "neural" },
            { text: "Hi", voiceId: "Amy", engine: "generative", languageCode: "en-GB" },
        ])
    })

    test("an access refusal names polly:SynthesizeSpeech", async () => {
        const error = await refusal(async () =>
            speaker({
                speak: async () => async () => {
                    throw Object.assign(new Error("no"), { name: "AccessDeniedException" })
                },
            }).synthesize?.({ text: "x" }, signal),
        )
        expect(error.hint).toContain("polly:SynthesizeSpeech")
    })
})

describe("ffmpegDecode", () => {
    const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0
    test.skipIf(!hasFfmpeg)("turns an M4A clip into 16 kHz mono PCM", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decode-"))
        const path = join(dir, "tone.m4a")
        spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=d=1", path])
        const pcm = await ffmpegDecode(new Uint8Array(readFileSync(path)), signal)
        // One second, mono, 16-bit, 16 kHz — within an encoder frame of 32,000 bytes.
        expect(Math.abs(pcm.byteLength - 32_000)).toBeLessThan(4096)
    })
    test.skipIf(!hasFfmpeg)("rejects bytes that are not audio", async () => {
        await expect(ffmpegDecode(new Uint8Array([1, 2, 3]), signal)).rejects.toThrow()
    })
})
