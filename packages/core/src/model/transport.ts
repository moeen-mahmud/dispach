/**
 * Model transports: what `model.<role>.api` names.
 *
 * `ModelProvider` has always been the contract; until a second wire protocol existed, one
 * implementation was constructed in `roles.ts` and nothing chose between them. A transport is the
 * choosing half — a factory from a role's configuration to a provider — so a protocol that needs a
 * dependency core may not carry (Bedrock's SDK, hard rule 2) arrives through a plugin, the way a
 * channel or a tool provider does. `chat-completions` is registered the same way rather than as a
 * special case, so there is exactly one path from a role to its provider.
 */

import { ConfigError } from "../errors.ts"
import type { EnvSource } from "../manifest/env.ts"
import { DEFAULT_MODEL_API, type ModelRoleConfig } from "../manifest/schema.ts"
import type { ConfigSchema } from "../plugins/plugin.ts"
import { type ChatCompletionsConfig, createChatCompletionsProvider } from "./chat-completions.ts"
import type { FetchLike, ModelProvider } from "./provider.ts"

/** What a transport is handed to build one role's provider. */
export interface ModelTransportContext {
    /** The provider id, `<api>:<role>`. */
    readonly id: string
    /** The manifest path of the role, `model.main`, for errors that name a field. */
    readonly field: string
    readonly config: ModelRoleConfig
    /** `config.options` after the transport's own `optionsSchema`; `undefined` when absent. */
    readonly options: unknown
    readonly env?: EnvSource
    readonly fetch?: FetchLike
    readonly retry?: ChatCompletionsConfig["retry"]
    readonly onRetry?: NonNullable<ChatCompletionsConfig["onRetry"]>
    readonly onUsageUnsupported?: NonNullable<ChatCompletionsConfig["onUsageUnsupported"]>
}

export interface ModelTransport {
    /** Validates `model.<role>.options`. Checked at load, so a bad option refuses the boot. */
    readonly optionsSchema?: ConfigSchema
    /** Build the provider. Must not touch the network: this runs before `runtime.ready`. */
    create(context: ModelTransportContext): ModelProvider
}

export const CHAT_COMPLETIONS_TRANSPORT: ModelTransport = {
    create(context) {
        const { config } = context
        if (config.baseUrl === undefined) {
            // The schema refuses this first; this is the guard for a caller that skipped it.
            throw new ConfigError({
                code: "manifest_base_url_invalid",
                message: `${context.field}.baseUrl is required for the chat-completions transport.`,
                hint: "Give the endpoint's base URL ending at the version segment, e.g. https://api.openai.com/v1.",
                field: `${context.field}.baseUrl`,
            })
        }
        return createChatCompletionsProvider({
            id: context.id,
            baseUrl: config.baseUrl,
            field: context.field,
            ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
            ...(config.headers === undefined ? {} : { headers: config.headers }),
            ...(config.streamUsage === undefined ? {} : { streamUsage: config.streamUsage }),
            ...(context.env === undefined ? {} : { env: context.env }),
            ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
            ...(context.onRetry === undefined ? {} : { onRetry: context.onRetry }),
            ...(context.onUsageUnsupported === undefined
                ? {}
                : { onUsageUnsupported: context.onUsageUnsupported }),
            ...(context.retry === undefined ? {} : { retry: context.retry }),
        })
    },
}

/** The transports every runtime has, before any plugin adds one. */
export const BUILT_IN_TRANSPORTS: ReadonlyMap<string, ModelTransport> = new Map([
    [DEFAULT_MODEL_API, CHAT_COMPLETIONS_TRANSPORT],
])

/**
 * The transport a role names, with its options checked. Throws on an unknown `api` rather than
 * falling back to chat-completions: a fallback would send a Bedrock model id to an OpenAI-shaped
 * endpoint and report whatever that endpoint made of it.
 */
export function transportFor(
    config: ModelRoleConfig,
    field: string,
    transports: ReadonlyMap<string, ModelTransport>,
): { readonly transport: ModelTransport; readonly options: unknown } {
    const api = config.api ?? DEFAULT_MODEL_API
    const transport = transports.get(api)
    if (transport === undefined) {
        const known = [...transports.keys()].sort()
        throw new ConfigError({
            code: "model_transport_unknown",
            message: `${field}.api is "${api}", and no transport by that name is registered. Registered: ${known.join(", ")}.`,
            hint:
                api === "bedrock-converse"
                    ? "Bedrock comes from the model-bedrock plugin, which the CLI and the image include. An embedder calling the runtime directly passes it in `builtInPlugins`."
                    : "Name a registered transport, or add the plugin that provides this one to the manifest's plugins.",
            field: `${field}.api`,
        })
    }
    if (transport.optionsSchema === undefined || config.options === undefined) {
        return { transport, options: config.options }
    }
    const parsed = transport.optionsSchema.safeParse(config.options)
    if (!parsed.success) {
        const reason = parsed.error.issues?.[0]?.message ?? "invalid"
        throw new ConfigError({
            code: "model_transport_options_invalid",
            message: `${field}.options are not valid for the ${api} transport: ${reason}.`,
            hint: `See the ${api} transport's documentation for the fields it takes.`,
            field: `${field}.options`,
        })
    }
    return { transport, options: parsed.data }
}
