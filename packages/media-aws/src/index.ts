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
 * memo M4A) is refused with a hint naming the `openai` provider, which takes those.
 */

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

export interface AwsMediaOptions {
    readonly region: string
    readonly profile?: string
    /** Transcribe's language, `en-US` when absent. */
    readonly languageCode?: string
    /** The Opus sample rate. Voice notes on Telegram and WhatsApp are 48 kHz. */
    readonly sampleRate?: number
}

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
}

export const sdkClients: AwsClients = {
    async transcribe(options) {
        const sdk = await import("@aws-sdk/client-transcribe-streaming")
        const client = new sdk.TranscribeStreamingClient({
            region: options.region,
            ...(options.profile === undefined ? {} : { profile: options.profile }),
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
            ...(options.profile === undefined ? {} : { profile: options.profile }),
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
}

const OPTION_KEYS = new Set(["region", "profile", "languageCode", "sampleRate"])

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
    const name = cause instanceof Error ? cause.name : ""
    const message = cause instanceof Error ? cause.message : String(cause)
    return new MediaError({
        code: "media_provider_refused",
        message: `AWS refused the request (${name || "error"}): ${message}`,
        hint:
            name === "AccessDeniedException" || name === "UnrecognizedClientException"
                ? "The role needs transcribe:StartStreamTranscription for voice notes and bedrock:InvokeModel on the image model; check the pod's service account or the credentials in the environment."
                : name === "ValidationException"
                  ? "Nova Canvas takes a prompt of at most 1,024 characters and a size whose sides are multiples of 16 between 320 and 4096."
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
            const provider: MediaProvider = {
                async transcribe(audio, signal) {
                    const encoding = encodingOf(audio.mimeType)
                    if (encoding === undefined) {
                        throw new MediaError({
                            code: "media_audio_unsupported",
                            message: `Amazon Transcribe streaming cannot read ${audio.mimeType}.`,
                            hint: "It takes OGG/Opus (Telegram and WhatsApp voice notes) and FLAC. Slack clips (WebM) and Teams memos (M4A) need the openai provider in media.transcription.",
                            field: `${context.field}.provider`,
                        })
                    }
                    transcriber ??= clients.transcribe(options)
                    try {
                        const send = await transcriber
                        const stream = await send(
                            {
                                LanguageCode: (options.languageCode ??
                                    "en-US") as StartStreamTranscriptionCommandInput["LanguageCode"],
                                MediaEncoding: encoding,
                                MediaSampleRateHertz: options.sampleRate ?? 48_000,
                                AudioStream: chunks(audio.bytes),
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
            hosts: ["transcribestreaming.*.amazonaws.com", "bedrock-runtime.*.amazonaws.com"],
        },
    ],
    setup(context) {
        context.defineMediaProvider("aws", awsMedia())
    },
} satisfies Plugin
