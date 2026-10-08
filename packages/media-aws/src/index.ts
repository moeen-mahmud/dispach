/**
 * `@dispach/media-aws` — Amazon Transcribe and Nova Canvas as the `aws` media provider.
 *
 * ```yaml
 * media:
 *   transcription:
 *     provider: aws
 *     options: { region: eu-west-2, languageCode: en-GB }
 *   image:
 *     provider: aws
 *     model: amazon.nova-canvas-v1:0
 *     options: { region: eu-west-1 }
 * ```
 *
 * **Both SDKs load on the first call, never at boot**, as `model-bedrock`'s does: `create` runs before
 * `runtime.ready`. Credentials are the AWS default chain — environment, container credentials, EKS
 * Pod Identity, instance role, or a named `profile` — so nothing about them is a manifest field.
 *
 * **Transcribe streaming, not batch.** Batch transcription reads from S3, which would add a bucket, a
 * lifecycle and a second IAM surface for a thirty-second voice note. Streaming takes the bytes
 * directly — in OGG/Opus (Telegram, WhatsApp) or FLAC. Anything else (a Slack clip is WebM, a Teams
 * memo M4A) is decoded to 16 kHz PCM by `ffmpeg` first (pilot.15), which the image carries; without
 * it on the PATH those formats are refused with a hint saying so.
 *
 * **Polly for `media.speech`** (pilot.15), asked for `ogg_opus`, which is what a WhatsApp or Telegram
 * voice note already is, so nothing is transcoded on the way out. `voiceId` and `engine` are options.
 */

import { spawn } from "node:child_process"

import type {
    AudioStream,
    StartStreamTranscriptionCommandInput,
    TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming"
import {
    ConfigError,
    MediaError,
    type MediaProvider,
    type MediaProviderFactory,
    type Plugin,
} from "@dispach/core"
import { CredentialsRefusedError, containerCredentials } from "@dispach/model-bedrock"

export interface AwsMediaOptions {
    readonly region: string
    readonly profile?: string
    /** Transcribe's language, `en-US` when absent. */
    readonly languageCode?: string
    /** The Opus sample rate. Voice notes on Telegram and WhatsApp are 48 kHz. */
    readonly sampleRate?: number
    /** Polly's voice for `media.speech`, `Joanna` when absent. */
    readonly voiceId?: string
    /** Polly's engine: `neural` when absent; `standard`, `long-form` or `generative`. */
    readonly engine?: string
}

/** Synthesises one piece of speech; returns the audio and the characters Polly billed. */
export type SpeakSend = (
    input: {
        readonly text: string
        readonly voiceId: string
        readonly engine: string
        readonly languageCode?: string
    },
    signal: AbortSignal,
) => Promise<{ readonly bytes: Uint8Array; readonly characters?: number }>

/** Audio in some container, as 16 kHz mono 16-bit PCM. Rejects when it cannot. */
export type Decode = (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>

/** Opens one Transcribe stream. The default imports the SDK lazily; a test replaces it. */
export type TranscribeSend = (
    input: StartStreamTranscriptionCommandInput,
    signal: AbortSignal,
) => Promise<AsyncIterable<TranscriptResultStream>>

/** Invokes a Bedrock model with a JSON body and returns the JSON answer as text. */
export type InvokeSend = (
    input: { readonly modelId: string; readonly body: string },
    signal: AbortSignal,
) => Promise<string>

export interface AwsClients {
    readonly transcribe: (options: AwsMediaOptions) => Promise<TranscribeSend>
    readonly invoke: (options: AwsMediaOptions) => Promise<InvokeSend>
    readonly speak: (options: AwsMediaOptions) => Promise<SpeakSend>
    readonly decode: Decode
}

/** The sample rate audio is decoded to: what Transcribe recommends for speech. */
const PCM_RATE = 16_000

/**
 * `ffmpeg` reading the bytes on stdin and writing raw PCM on stdout. No shell: the arguments are an
 * array, and the input is the person's own audio, never a path. Killed when the deadline aborts.
 */
export const ffmpegDecode: Decode = (bytes, signal) =>
    new Promise((resolve, reject) => {
        const child = spawn(
            "ffmpeg",
            ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"].concat([
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                String(PCM_RATE),
                "pipe:1",
            ]),
            { stdio: ["pipe", "pipe", "pipe"] },
        )
        const out: Buffer[] = []
        const err: Buffer[] = []
        const onAbort = () => child.kill("SIGKILL")
        signal.addEventListener("abort", onAbort, { once: true })
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
        child.on("error", (cause) => {
            signal.removeEventListener("abort", onAbort)
            reject(cause)
        })
        child.on("close", (code) => {
            signal.removeEventListener("abort", onAbort)
            if (code === 0) resolve(new Uint8Array(Buffer.concat(out)))
            else
                reject(
                    new Error(
                        Buffer.concat(err).toString("utf8").trim() || `ffmpeg exited ${code}`,
                    ),
                )
        })
        // A closed stdin (ffmpeg gave up on a bad header) is reported by `close`, not here.
        child.stdin.on("error", () => {})
        child.stdin.end(Buffer.from(bytes))
    })

/**
 * A named profile when the manifest gives one; otherwise a container-credentials endpoint read by
 * Dispach, the provider Bedrock uses (pilot.15, VelaCrew). The SDK's own container provider refuses
 * a `FULL_URI` host outside its allowlist, so a silo's `169.254.170.2:4000` failed every voice note
 * with "not a valid container metadata service hostname" while Bedrock worked; and read by Dispach,
 * the endpoint's refusal (`credit_exhausted`) reaches the error instead of a generic SDK one.
 */
export function clientCredentials(options: AwsMediaOptions) {
    if (options.profile !== undefined) return { profile: options.profile }
    const container = containerCredentials(process.env)
    return container === undefined ? {} : { credentials: container }
}

export const sdkClients: AwsClients = {
    async transcribe(options) {
        const sdk = await import("@aws-sdk/client-transcribe-streaming")
        const client = new sdk.TranscribeStreamingClient({
            region: options.region,
            ...clientCredentials(options),
        })
        return async (input, signal) => {
            const response = await client.send(new sdk.StartStreamTranscriptionCommand(input), {
                abortSignal: signal,
            })
            if (response.TranscriptResultStream === undefined) {
                throw new Error("Transcribe returned no result stream.")
            }
            return response.TranscriptResultStream
        }
    },
    async invoke(options) {
        const sdk = await import("@aws-sdk/client-bedrock-runtime")
        const client = new sdk.BedrockRuntimeClient({
            region: options.region,
            ...clientCredentials(options),
        })
        return async (input, signal) => {
            const response = await client.send(
                new sdk.InvokeModelCommand({
                    modelId: input.modelId,
                    contentType: "application/json",
                    accept: "application/json",
                    body: input.body,
                }),
                { abortSignal: signal },
            )
            return new TextDecoder().decode(response.body)
        }
    },
    async speak(options) {
        const sdk = await import("@aws-sdk/client-polly")
        const client = new sdk.PollyClient({
            region: options.region,
            ...clientCredentials(options),
        })
        return async (input, signal) => {
            const response = await client.send(
                new sdk.SynthesizeSpeechCommand({
                    Text: input.text,
                    OutputFormat: "ogg_opus",
                    VoiceId: input.voiceId as NonNullable<
                        ConstructorParameters<typeof sdk.SynthesizeSpeechCommand>[0]["VoiceId"]
                    >,
                    Engine: input.engine as ConstructorParameters<
                        typeof sdk.SynthesizeSpeechCommand
                    >[0]["Engine"],
                    ...(input.languageCode === undefined
                        ? {}
                        : {
                              LanguageCode: input.languageCode as ConstructorParameters<
                                  typeof sdk.SynthesizeSpeechCommand
                              >[0]["LanguageCode"],
                          }),
                }),
                { abortSignal: signal },
            )
            if (response.AudioStream === undefined) throw new Error("Polly returned no audio.")
            return {
                bytes: await response.AudioStream.transformToByteArray(),
                ...(response.RequestCharacters === undefined
                    ? {}
                    : { characters: response.RequestCharacters }),
            }
        }
    },
    decode: ffmpegDecode,
}

const OPTION_KEYS = new Set([
    "region",
    "profile",
    "languageCode",
    "sampleRate",
    "voiceId",
    "engine",
])

const optionsSchema = {
    safeParse(value: unknown) {
        const record = (typeof value === "object" && value !== null ? value : {}) as Record<
            string,
            unknown
        >
        const fail = (message: string) => ({
            success: false as const,
            error: { issues: [{ message }] },
        })
        const unknownKey = Object.keys(record).find((key) => !OPTION_KEYS.has(key))
        if (unknownKey !== undefined) {
            return fail(`unknown option "${unknownKey}" (takes ${[...OPTION_KEYS].join(", ")})`)
        }
        if (typeof record.region !== "string" || record.region === "") {
            return fail("region is required, e.g. eu-west-2")
        }
        if (record.sampleRate !== undefined && typeof record.sampleRate !== "number") {
            return fail("sampleRate is a number of hertz")
        }
        for (const key of ["voiceId", "engine", "languageCode"] as const) {
            if (record[key] !== undefined && typeof record[key] !== "string") {
                return fail(
                    `${key} is text, e.g. ${key === "engine" ? "neural" : key === "voiceId" ? "Joanna" : "en-GB"}`,
                )
            }
        }
        return { success: true as const, data: record as unknown as AwsMediaOptions }
    },
}

/** Transcribe's name for a container, or undefined for one it cannot take. */
export function encodingOf(mimeType: string): "ogg-opus" | "flac" | undefined {
    const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? ""
    if (type === "audio/ogg" || type === "audio/opus") return "ogg-opus"
    if (type === "audio/flac" || type === "audio/x-flac") return "flac"
    return undefined
}

/** A few hundred milliseconds of a voice note per event, the size Transcribe's docs recommend. */
const CHUNK_BYTES = 8 * 1024

async function* chunks(bytes: Uint8Array): AsyncIterable<AudioStream> {
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        yield { AudioEvent: { AudioChunk: bytes.subarray(offset, offset + CHUNK_BYTES) } }
    }
}

function refused(cause: unknown, field: string): MediaError {
    // The credentials endpoint said no, and why: its own code (`credit_exhausted`) is the error's, so an
    // embedder that stopped a user's credit sees that rather than an AWS refusal (pilot.15).
    if (cause instanceof CredentialsRefusedError) {
        const own =
            cause.code !== undefined && /^[a-z][a-z0-9_]{1,63}$/.test(cause.code)
                ? cause.code
                : undefined
        return new MediaError({
            code: own ?? "media_credentials_unavailable",
            message: `The AWS credentials endpoint ${cause.status >= 500 ? "could not issue" : "refused"} credentials (status ${cause.status}${own === undefined ? "" : `, ${own}`})${cause.detail === undefined ? "" : `: ${cause.detail.replace(/\.$/, "")}`}.`,
            hint:
                cause.status >= 500
                    ? "The service vending credentials failed rather than declined; it is usually temporary."
                    : "The container-credentials endpoint declined. Its own words are above; nothing here can override it.",
            field,
        })
    }
    const name = cause instanceof Error ? cause.name : ""
    const message = cause instanceof Error ? cause.message : String(cause)
    return new MediaError({
        code: "media_provider_refused",
        message: `AWS refused the request (${name || "error"}): ${message}`,
        hint:
            name === "AccessDeniedException" || name === "UnrecognizedClientException"
                ? "The role needs transcribe:StartStreamTranscription for voice notes, polly:SynthesizeSpeech for spoken replies, and bedrock:InvokeModel on the image model; check the pod's service account or the credentials in the environment."
                : name === "ValidationException"
                  ? "Nova Canvas takes a prompt of at most 1,024 characters and a size whose sides are multiples of 16 between 320 and 4096."
                  : name === "TextLengthExceededException"
                    ? "Lower media.speech.maxCharacters; each voice note is one Polly request."
                    : "AWS's own words are above.",
        field,
    })
}

export function awsMedia(clients: AwsClients = sdkClients): MediaProviderFactory {
    return {
        optionsSchema,
        create(context) {
            if (context.options === undefined) {
                throw new ConfigError({
                    code: "media_aws_region_missing",
                    message: `${context.field}.options.region is required for the aws provider.`,
                    hint: "Name the region, e.g. options: { region: eu-west-2 }. Nova Canvas is in us-east-1, eu-west-1 and ap-northeast-1.",
                    field: `${context.field}.options`,
                })
            }
            const options = context.options as AwsMediaOptions
            // One client per provider, built on first use.
            let transcriber: Promise<TranscribeSend> | undefined
            let invoker: Promise<InvokeSend> | undefined
            let speaker: Promise<SpeakSend> | undefined
            const provider: MediaProvider = {
                async transcribe(audio, signal) {
                    const native = encodingOf(audio.mimeType)
                    let bytes = audio.bytes
                    if (native === undefined) {
                        // Transcribe streaming reads Ogg/Opus, FLAC and PCM; anything else is decoded.
                        try {
                            bytes = await clients.decode(audio.bytes, signal)
                        } catch (cause) {
                            const missing = (cause as { code?: unknown }).code === "ENOENT"
                            throw new MediaError({
                                code: "media_audio_unsupported",
                                message: missing
                                    ? `Amazon Transcribe streaming cannot read ${audio.mimeType}, and ffmpeg, which would convert it, is not installed.`
                                    : `${audio.mimeType} could not be converted for Amazon Transcribe: ${cause instanceof Error ? cause.message : String(cause)}`,
                                hint: missing
                                    ? "Install ffmpeg on the PATH (the container image carries it), or use the openai provider in media.transcription."
                                    : "The file is probably not audio, or is damaged. Ogg/Opus and FLAC are sent as they are.",
                                field: `${context.field}.provider`,
                            })
                        }
                    }
                    transcriber ??= clients.transcribe(options)
                    try {
                        const send = await transcriber
                        const stream = await send(
                            {
                                LanguageCode: (options.languageCode ??
                                    "en-US") as StartStreamTranscriptionCommandInput["LanguageCode"],
                                MediaEncoding: native ?? "pcm",
                                MediaSampleRateHertz:
                                    native === undefined
                                        ? PCM_RATE
                                        : (options.sampleRate ?? 48_000),
                                AudioStream: chunks(bytes),
                            },
                            signal,
                        )
                        const parts: string[] = []
                        let endTime: number | undefined
                        for await (const event of stream) {
                            for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
                                if (result.IsPartial === true) continue
                                const text = result.Alternatives?.[0]?.Transcript
                                if (text !== undefined && text !== "") parts.push(text)
                                if (result.EndTime !== undefined) endTime = result.EndTime
                            }
                        }
                        return {
                            text: parts.join(" "),
                            ...(endTime === undefined ? {} : { durationS: endTime }),
                        }
                    } catch (cause) {
                        if (cause instanceof MediaError) throw cause
                        throw refused(cause, context.field)
                    }
                },
                async synthesize(request, signal) {
                    speaker ??= clients.speak(options)
                    try {
                        const send = await speaker
                        const spoken = await send(
                            {
                                text: request.text,
                                voiceId: options.voiceId ?? "Joanna",
                                engine: options.engine ?? "neural",
                                ...(options.languageCode === undefined
                                    ? {}
                                    : { languageCode: options.languageCode }),
                            },
                            signal,
                        )
                        return {
                            bytes: spoken.bytes,
                            mimeType: "audio/ogg; codecs=opus",
                            ...(spoken.characters === undefined
                                ? {}
                                : { characters: spoken.characters }),
                        }
                    } catch (cause) {
                        throw refused(cause, context.field)
                    }
                },
                async generateImage(request, signal) {
                    const [width, height] = request.size.split("x").map(Number)
                    invoker ??= clients.invoke(options)
                    let answer: string
                    try {
                        const send = await invoker
                        answer = await send(
                            {
                                modelId: context.config.model ?? "amazon.nova-canvas-v1:0",
                                body: JSON.stringify({
                                    taskType: "TEXT_IMAGE",
                                    textToImageParams: { text: request.prompt },
                                    imageGenerationConfig: { numberOfImages: 1, width, height },
                                }),
                            },
                            signal,
                        )
                    } catch (cause) {
                        throw refused(cause, context.field)
                    }
                    const body = JSON.parse(answer) as {
                        images?: readonly string[]
                        error?: string
                    }
                    const image = body.images?.[0]
                    if (image === undefined) {
                        throw new MediaError({
                            code: "media_provider_empty",
                            message: `Nova Canvas returned no image${body.error === undefined ? "" : `: ${body.error}`}.`,
                            hint: "A prompt its content filter refused comes back this way. Rephrasing it is usually what works.",
                            field: context.field,
                        })
                    }
                    return { bytes: Buffer.from(image, "base64"), mimeType: "image/png" }
                },
            }
            return provider
        },
    }
}

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

export default {
    name: "media-aws",
    version: VERSION,
    dispachApi: "^0.2",
    permissions: [
        {
            kind: "network",
            hosts: [
                "transcribestreaming.*.amazonaws.com",
                "bedrock-runtime.*.amazonaws.com",
                "polly.*.amazonaws.com",
            ],
        },
    ],
    setup(context) {
        context.defineMediaProvider("aws", awsMedia())
    },
} satisfies Plugin
