/**
 * Model role resolution: `main`, `selector`, `compactor`.
 *
 * Selector and compactor fall back to main — and fall back to the *same provider instance*, so
 * an unconfigured role costs nothing. Pointing selector and compactor at a cheap 3B model while
 * main is something larger is the intended production shape and usually the biggest available
 * cost win.
 */

import type { EnvSource } from "../manifest/env.ts"
import type { AgentManifest, ModelRole, ModelRoleConfig } from "../manifest/schema.ts"
import {
    type ModelCapabilities,
    resolveCapabilities,
    type WindowProvenance,
    windowProvenance,
} from "./capabilities.ts"
import { type ChatCompletionsConfig, createChatCompletionsProvider } from "./chat-completions.ts"
import type { FetchLike, ModelProvider } from "./provider.ts"

export interface ResolvedRole {
    readonly role: ModelRole
    /** The role this configuration came from — `main` when the role fell back. */
    readonly configuredAs: ModelRole
    readonly config: ModelRoleConfig
    readonly capabilities: ModelCapabilities
    /**
     * Where `capabilities.contextWindow` came from, for this role specifically.
     *
     * Per role because an agent can run three models on three endpoints, and until this existed only
     * main's window was reported anywhere at all — so a compactor quietly running on `CONSERVATIVE`'s
     * 8,192 had nothing that could say so. A role that fell back to main carries main's provenance,
     * which is correct: it is main's configuration that decided the number.
     */
    readonly window: WindowProvenance
    readonly provider: ModelProvider
}

export type ResolvedRoles = Readonly<Record<ModelRole, ResolvedRole>>

/** One role's model and window provenance, derived from the manifest alone. */
export interface RoleWindow {
    readonly role: ModelRole
    /** `main` when this role is unconfigured and falls back to it. */
    readonly configuredAs: ModelRole
    readonly modelId: string
    readonly window: WindowProvenance
}

export interface ResolveRolesOptions {
    readonly env?: EnvSource
    readonly fetch?: FetchLike
    readonly onRetry?: NonNullable<ChatCompletionsConfig["onRetry"]>
    readonly onUsageUnsupported?: NonNullable<ChatCompletionsConfig["onUsageUnsupported"]>
    readonly retry?: ChatCompletionsConfig["retry"]
}

function buildRole(
    role: ModelRole,
    configuredAs: ModelRole,
    config: ModelRoleConfig,
    options: ResolveRolesOptions,
): ResolvedRole {
    const capabilities = resolveCapabilities(config.id, config.capabilities)
    const provider = createChatCompletionsProvider({
        id: `chat-completions:${configuredAs}`,
        baseUrl: config.baseUrl,
        field: `model.${configuredAs}`,
        ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(config.streamUsage === undefined ? {} : { streamUsage: config.streamUsage }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
        ...(options.onUsageUnsupported === undefined
            ? {}
            : { onUsageUnsupported: options.onUsageUnsupported }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
    })

    return {
        role,
        configuredAs,
        config,
        capabilities,
        window: windowProvenance(config.id, config.capabilities),
        provider,
    }
}

export function resolveRoles(
    manifest: AgentManifest,
    options: ResolveRolesOptions = {},
): ResolvedRoles {
    const main = buildRole("main", "main", manifest.model.main, options)

    const derive = (role: Exclude<ModelRole, "main">): ResolvedRole => {
        const config = manifest.model[role]
        if (config === undefined) return { ...main, role }
        return buildRole(role, role, config, options)
    }

    return { main, selector: derive("selector"), compactor: derive("compactor") }
}

/** Effective sampling parameters for a role, as sent on the wire. */
export function requestParamsFor(
    role: ResolvedRole,
    window: number,
): {
    temperature?: number
    topP?: number
    /** Absent unless `model.<role>.maxTokens` was configured. See below. */
    maxTokens?: number
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high"
} {
    // `max_tokens` is sent ONLY when someone asked for it.
    //
    // It used to be `min(capabilities.maxOutput, reserveOutput)`, and that conflated two different
    // questions. `context.reserveOutput` answers "how much of the window do I keep free so the
    // prompt cannot crowd out the reply" — a budgeting number, and it still does exactly that in
    // `assembleContext`. `model.<role>.maxTokens` answers "what is the most the endpoint may
    // generate". Feeding the first into the second turned a budget into a hard truncation, and on a
    // reasoning model that truncation lands on the thinking: qwen3.5:9b hit the 8,192 the generated
    // manifest happened to reserve and returned **empty content**, reported as
    // `empty_reply_output_exhausted` on a limit nobody chose.
    //
    // Omitted, the endpoint applies its own default, which is what every other client does and what
    // the endpoint is in a position to get right. `window - 1` still bounds an explicit value,
    // because a cap larger than the window is a request that cannot be served.
    const configured = role.config.maxTokens
    const maxTokens =
        configured === undefined
            ? undefined
            : Math.max(1, Math.min(configured, role.capabilities.maxOutput, window - 1))

    return {
        ...(role.config.temperature === undefined ? {} : { temperature: role.config.temperature }),
        ...(role.config.topP === undefined ? {} : { topP: role.config.topP }),
        ...(role.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: role.config.reasoningEffort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
    }
}

/**
 * Every configured role's model and where its context window came from — without building providers.
 *
 * Pure and manifest-only, which is what lets `validate` call it: that command answers whether a file
 * loads, and constructing three chat-completions providers to print a number would make it answer a
 * different question. `Agent.create` uses the same function for its boot warning, so the thing that
 * warns and the thing that reports cannot come to disagree — the shape CLAUDE.md records as *"a check
 * that only `run` performs is a check `validate` disagrees with"*.
 *
 * A role that falls back to main is listed with `configuredAs: "main"`, so a caller can print `→main`
 * rather than repeating the number three times.
 */
export function windowReport(manifest: AgentManifest): readonly RoleWindow[] {
    return (["main", "selector", "compactor"] as const).map((role) => {
        const config = manifest.model[role] ?? manifest.model.main
        const configuredAs: ModelRole = manifest.model[role] === undefined ? "main" : role
        return {
            role,
            configuredAs,
            modelId: config.id,
            window: windowProvenance(config.id, config.capabilities),
        }
    })
}
