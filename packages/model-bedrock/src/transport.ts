/**
 * `bedrock-converse`: the transport itself.
 *
 * **The SDK is imported on the first call, never at load.** `create` runs during boot, before
 * `runtime.ready`, and must neither touch the network nor pay for a multi-megabyte module that an
 * agent on another transport never uses. The import is behind `loadSdk`, which is the one seam a test
 * replaces, and the client is built once per provider.
 *
 * **Credentials are the AWS default chain and nothing else**: the process environment, a
 * container-credentials endpoint, EKS Pod Identity, the instance role — or a named `profile`. The SDK
 * resolves and refreshes them, so a rotated credential needs no restart, and no key is ever a
 * manifest field. The SDK's own retries are turned off (`maxAttempts: 1`) so the runtime's policy
 * decides, and each retry is a `model.retry` event like any other transport's.
 */

import type {
    ConverseStreamCommandInput,
    ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime"
import {
    type ChatChunk,
    ConfigError,
    DEFAULT_RETRY,
    type ModelProvider,
    type ModelTransport,
    type RetryPolicy,
} from "@dispach/core"
import { classify } from "./errors.ts"
import { cachesPrompts, converseInput } from "./request.ts"
import { toChunks } from "./stream.ts"

export interface BedrockOptions {
    readonly region: string
    readonly profile?: string
}

/** Sends one ConverseStream request and returns its event stream. */
export type ConverseSend = (
    input: ConverseStreamCommandInput,
    signal: AbortSignal,
) => Promise<AsyncIterable<ConverseStreamOutput>>

/** Builds a sender for a region and profile. The default imports the SDK lazily. */
export type SenderFactory = (options: BedrockOptions) => Promise<ConverseSend>

export const sdkSender: SenderFactory = async (options) => {
    const sdk = await import("@aws-sdk/client-bedrock-runtime")
    const client = new sdk.BedrockRuntimeClient({
        region: options.region,
        maxAttempts: 1,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
    })
    return async (input, signal) => {
        const response = await client.send(new sdk.ConverseStreamCommand(input), {
            abortSignal: signal,
        })
        if (response.stream === undefined) {
            throw new Error("Bedrock returned a ConverseStream response with no stream.")
        }
        return response.stream
    }
}

const optionsSchema = {
    safeParse(value: unknown) {
        const record = (typeof value === "object" && value !== null ? value : {}) as Record<
            string,
            unknown
        >
        const unknownKey = Object.keys(record).find((key) => key !== "region" && key !== "profile")
        if (unknownKey !== undefined) {
            return {
                success: false as const,
                error: {
                    issues: [{ message: `unknown option "${unknownKey}" (takes region, profile)` }],
                },
            }
        }
        if (typeof record.region !== "string" || record.region === "") {
            return {
                success: false as const,
                error: { issues: [{ message: "region is required, e.g. eu-west-1" }] },
            }
        }
        if (record.profile !== undefined && typeof record.profile !== "string") {
            return {
                success: false as const,
                error: { issues: [{ message: "profile must be a string" }] },
            }
        }
        return { success: true as const, data: record }
    },
}

function backoffMs(policy: RetryPolicy, attempt: number): number {
    const capped = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
    return Math.round(capped * (0.5 + Math.random() / 2))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve()
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

export function bedrockTransport(senderFactory: SenderFactory = sdkSender): ModelTransport {
    return {
        optionsSchema,
        // The registry's Claude rows say `promptCache: none`, which is true of Anthropic's
        // OpenAI-compatible endpoint and false here: Converse takes explicit cache points. A manifest
        // that set `promptCache` itself keeps its value.
        capabilities: (resolved, config) =>
            config.capabilities?.promptCache === undefined && cachesPrompts(config.id)
                ? { ...resolved, promptCache: "bedrock" }
                : resolved,
        create(context): ModelProvider {
            const options = context.options as BedrockOptions | undefined
            if (options === undefined) {
                throw new ConfigError({
                    code: "model_transport_options_invalid",
                    message: `${context.field}.options are required for the bedrock-converse transport.`,
                    hint: "Set options.region to the Bedrock region, e.g. eu-west-1, and options.profile for a named AWS profile.",
                    field: `${context.field}.options`,
                })
            }
            const policy = context.retry ?? DEFAULT_RETRY
            let sender: Promise<ConverseSend> | undefined

            return {
                id: context.id,
                async *chat(request, signal): AsyncIterable<ChatChunk> {
                    sender ??= senderFactory(options)
                    const send = await sender
                    const input = converseInput(request, context.config)
                    for (let attempt = 1; ; attempt += 1) {
                        let started = false
                        try {
                            for await (const chunk of toChunks(await send(input, signal))) {
                                started = true
                                yield chunk
                            }
                            return
                        } catch (error) {
                            // Cancellation is a state, not an exception.
                            if (signal.aborted) return
                            const failure = classify(
                                error,
                                request.model,
                                options.region,
                                context.field,
                            )
                            if (started || !failure.retryable || attempt >= policy.attempts) {
                                throw failure.error
                            }
                            const delayMs = backoffMs(policy, attempt)
                            context.onRetry?.({ status: failure.status ?? 0, attempt, delayMs })
                            await sleep(delayMs, signal)
                            if (signal.aborted) return
                        }
                    }
                },
            }
        },
    }
}
