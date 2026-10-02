/**
 * Media providers: speech to text for voice notes, text to image for `image_generate`.
 *
 * One contract with two optional halves, because the real backends come in pairs — an OpenAI-shaped
 * endpoint has `/audio/transcriptions` and `/images/generations`, AWS has Transcribe and Nova Canvas
 * — and a second registry for the second half would be a second thing every plugin, loader and
 * runtime path has to thread. A manifest names a provider per capability, so the pair can differ.
 *
 * `openai` is built in: `fetch` and `FormData` are the whole client. `aws` is a plugin
 * (`media-aws`), because its SDKs are not core's to carry.
 */

import { ConfigError, HarnessError } from "../errors.ts"
import type { EnvSource } from "../manifest/env.ts"
import type { AgentManifest, ImageConfig, TranscriptionConfig } from "../manifest/schema.ts"
import type { FetchLike } from "../model/provider.ts"
import type { ConfigSchema } from "../plugins/plugin.ts"

export interface AudioInput {
    readonly bytes: Uint8Array
    /** As the channel reported it: `audio/ogg`, `audio/mp4`, `audio/webm`… */
    readonly mimeType: string
    /** Seconds, when the channel knows. What usage bills when the provider reports none. */
    readonly durationS?: number
}

export interface Transcript {
    readonly text: string
    /** Seconds of audio the provider processed, when it says. */
    readonly durationS?: number
}

export interface ImageRequest {
    readonly prompt: string
    /** `WIDTHxHEIGHT`. */
    readonly size: string
}

export interface GeneratedImage {
    readonly bytes: Uint8Array
    readonly mimeType: string
}

export interface MediaProvider {
    transcribe?(audio: AudioInput, signal: AbortSignal): Promise<Transcript>
    generateImage?(request: ImageRequest, signal: AbortSignal): Promise<GeneratedImage>
}

export interface MediaProviderContext {
    /** `media.transcription` or `media.image`, for errors that name a field. */
    readonly field: string
    readonly config: TranscriptionConfig | ImageConfig
    /** `config.options` after the provider's own `optionsSchema`. */
    readonly options: unknown
    readonly env: EnvSource
    readonly fetch?: FetchLike
}

export interface MediaProviderFactory {
    readonly optionsSchema?: ConfigSchema
    /** Build the provider. Must not touch the network: this runs before `runtime.ready`. */
    create(context: MediaProviderContext): MediaProvider
}

/** A media call that did not produce a result. Always carries a hint the sender's reply can use. */
export class MediaError extends HarnessError {
    static override readonly ERROR_NAME = "MediaError"
}

/**
 * The provider a section names, built, with its options checked. Throws on an unknown name rather
 * than falling back — the same rule as an unknown model transport or tool slug.
 */
export function mediaProviderFor(
    field: "media.transcription" | "media.image",
    config: TranscriptionConfig | ImageConfig,
    factories: ReadonlyMap<string, MediaProviderFactory>,
    context: { readonly env: EnvSource; readonly fetch?: FetchLike },
): MediaProvider {
    const factory = factories.get(config.provider)
    if (factory === undefined) {
        throw new ConfigError({
            code: "media_provider_unknown",
            message: `${field}.provider is "${config.provider}", and no media provider by that name is registered. Registered: ${[...factories.keys()].sort().join(", ")}.`,
            hint:
                config.provider === "aws"
                    ? "Amazon Transcribe and Nova Canvas come from the media-aws plugin, which the CLI and the image include. An embedder calling the runtime directly passes it in `builtInPlugins`."
                    : 'Use "openai" for any endpoint speaking the OpenAI audio and image routes, or add the plugin that provides this one.',
            field: `${field}.provider`,
        })
    }
    let options: unknown = config.options
    if (factory.optionsSchema !== undefined && config.options !== undefined) {
        const parsed = factory.optionsSchema.safeParse(config.options)
        if (!parsed.success) {
            throw new ConfigError({
                code: "media_provider_options_invalid",
                message: `${field}.options are not valid for the ${config.provider} provider: ${parsed.error.issues?.[0]?.message ?? "invalid"}.`,
                hint: `See the ${config.provider} media provider's documentation for the fields it takes.`,
                field: `${field}.options`,
            })
        }
        options = parsed.data
    }
    const provider = factory.create({
        field,
        config,
        options,
        env: context.env,
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
    })
    const half = field === "media.transcription" ? provider.transcribe : provider.generateImage
    if (half === undefined) {
        throw new ConfigError({
            code: "media_provider_incapable",
            message: `The ${config.provider} media provider does not ${field === "media.transcription" ? "transcribe audio" : "generate images"}.`,
            hint: "Name a provider that does in this section; the two sections may name different providers.",
            field: `${field}.provider`,
        })
    }
    return provider
}

/**
 * Run `work` under a deadline that holds whether or not `work` honours its signal.
 *
 * The signal is aborted at the deadline *and* the race resolves then, because the failure this
 * exists for is a provider that ignores its signal: awaiting it would hold the conversation's queue
 * for as long as it hangs, which is forever.
 */
export async function withDeadline<T>(
    ms: number,
    what: string,
    work: (signal: AbortSignal) => Promise<T>,
    outer?: AbortSignal,
): Promise<T> {
    const controller = new AbortController()
    const onOuter = () => controller.abort()
    outer?.addEventListener("abort", onOuter, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort()
            reject(
                new MediaError({
                    code: "media_timeout",
                    message: `${what} did not finish within ${ms} ms and was abandoned.`,
                    hint: "Raise timeoutMs in the media section if long inputs are normal, or check the provider's status — it accepted the request and did not answer.",
                }),
            )
        }, ms)
    })
    try {
        return await Promise.race([work(controller.signal), deadline])
    } finally {
        clearTimeout(timer)
        outer?.removeEventListener("abort", onOuter)
    }
}

const EXTENSIONS: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
}

/** The file extension an OpenAI-shaped endpoint sniffs the format from. Parameters are dropped. */
export function audioExtension(mimeType: string): string {
    return EXTENSIONS[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "ogg"
}

async function failure(response: Response, what: string, field: string): Promise<MediaError> {
    const detail = (await response.text().catch(() => "")).slice(0, 300)
    return new MediaError({
        code: "media_provider_refused",
        message: `${what} was refused (${response.status}): ${detail}`,
        hint:
            response.status === 401 || response.status === 403
                ? `Check the key in the env var ${field}.apiKeyEnv names, and that it may use this model.`
                : "The provider's own words are above.",
        field,
    })
}

/**
 * `openai`: `/audio/transcriptions` and `/images/generations` on any endpoint that speaks them —
 * OpenAI, Groq, a gateway fronting Deepgram or a local Whisper server.
 */
export const OPENAI_MEDIA_PROVIDER: MediaProviderFactory = {
    create(context) {
        const { config, field } = context
        const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")
        const keyName = config.apiKeyEnv ?? "OPENAI_API_KEY"
        const key = context.env[keyName]
        if (key === undefined || key === "") {
            throw new ConfigError({
                code: "media_key_missing",
                message: `${field} needs ${keyName}, which is not set.`,
                hint: `Put the endpoint's key in ${keyName}, in the environment or the .env beside the manifest, or name another variable with ${field}.apiKeyEnv.`,
                field: `${field}.apiKeyEnv`,
            })
        }
        const doFetch = context.fetch ?? ((input, init) => fetch(input, init))
        const authorization = `Bearer ${key}`
        return {
            async transcribe(audio, signal) {
                const form = new FormData()
                form.set(
                    "file",
                    new Blob([audio.bytes], { type: audio.mimeType }),
                    `voice.${audioExtension(audio.mimeType)}`,
                )
                form.set("model", config.model ?? "whisper-1")
                const response = await doFetch(`${baseUrl}/audio/transcriptions`, {
                    method: "POST",
                    headers: { authorization },
                    body: form,
                    signal,
                })
                if (!response.ok) throw await failure(response, "The transcription", field)
                const body = (await response.json()) as { text?: unknown; duration?: unknown }
                return {
                    text: typeof body.text === "string" ? body.text : "",
                    ...(typeof body.duration === "number" ? { durationS: body.duration } : {}),
                }
            },
            async generateImage(request, signal) {
                const response = await doFetch(`${baseUrl}/images/generations`, {
                    method: "POST",
                    headers: { authorization, "content-type": "application/json" },
                    body: JSON.stringify({
                        model: config.model ?? "gpt-image-1",
                        prompt: request.prompt,
                        size: request.size,
                        n: 1,
                    }),
                    signal,
                })
                if (!response.ok) throw await failure(response, "The image request", field)
                const body = (await response.json()) as {
                    data?: readonly { b64_json?: string; url?: string }[]
                }
                const first = body.data?.[0]
                if (first?.b64_json !== undefined) {
                    return { bytes: Buffer.from(first.b64_json, "base64"), mimeType: "image/png" }
                }
                // DALL-E answers with a short-lived URL unless asked otherwise; fetch it now.
                if (first?.url !== undefined) {
                    const image = await doFetch(first.url, { signal })
                    if (!image.ok) throw await failure(image, "Downloading the image", field)
                    return {
                        bytes: new Uint8Array(await image.arrayBuffer()),
                        mimeType: image.headers.get("content-type") ?? "image/png",
                    }
                }
                throw new MediaError({
                    code: "media_provider_empty",
                    message: "The image endpoint answered with no image.",
                    hint: "Some endpoints return an empty list for a refused prompt. Rephrasing it is usually what works.",
                    field,
                })
            },
        }
    },
}

export const BUILT_IN_MEDIA_PROVIDERS: ReadonlyMap<string, MediaProviderFactory> = new Map([
    ["openai", OPENAI_MEDIA_PROVIDER],
])

export interface ResolvedMedia {
    readonly transcription?: {
        readonly config: TranscriptionConfig
        readonly provider: MediaProvider
    }
    readonly image?: { readonly config: ImageConfig; readonly provider: MediaProvider }
}

/**
 * Both media sections, built. The function `Agent.create` and `validate` both call, so a provider
 * the runtime refuses is one the validator refuses too. Opens no socket.
 */
export function resolveMedia(
    manifest: AgentManifest,
    context: {
        readonly env: EnvSource
        readonly fetch?: FetchLike
        /** Plugin-supplied factories, layered over the built-in `openai`. */
        readonly providers?: ReadonlyMap<string, MediaProviderFactory>
    },
): ResolvedMedia {
    const factories = new Map([...BUILT_IN_MEDIA_PROVIDERS, ...(context.providers ?? [])])
    const transcription = manifest.media?.transcription
    const image = manifest.media?.image
    return {
        ...(transcription === undefined
            ? {}
            : {
                  transcription: {
                      config: transcription,
                      provider: mediaProviderFor(
                          "media.transcription",
                          transcription,
                          factories,
                          context,
                      ),
                  },
              }),
        ...(image === undefined
            ? {}
            : {
                  image: {
                      config: image,
                      provider: mediaProviderFor("media.image", image, factories, context),
                  },
              }),
    }
}
