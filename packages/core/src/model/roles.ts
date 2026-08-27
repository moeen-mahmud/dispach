/**
 * Model role resolution: `main`, `selector`, `compactor`.
 *
 * Selector and compactor fall back to main — and fall back to the *same provider instance*, so
 * an unconfigured role costs nothing. Pointing selector and compactor at a cheap 3B model while
 * main is something larger is the intended production shape and usually the biggest available
 * cost win.
 */

import { unknownModelRole } from "../errors.ts"
import type { EnvSource } from "../manifest/env.ts"
import type { AgentManifest, ModelRole, ModelRoleConfig } from "../manifest/schema.ts"
import { customRoleNames, MODEL_ROLES } from "../manifest/schema.ts"
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

/**
 * The three reserved roles, plus any custom ones a manifest declared.
 *
 * The reserved three stay named properties so `roles.main` type-checks without a lookup and cannot
 * be misspelled. Custom roles are reachable only through `byName`, which **throws** on a name that
 * was never declared — the same rule as `ToolRegistry.resolve` throwing on an unknown tool slug, and
 * for the same reason: silently falling back to `main` turns a config typo into a schedule that runs
 * on the expensive model forever with nothing saying so.
 */
export interface ResolvedRoles {
    readonly main: ResolvedRole
    readonly selector: ResolvedRole
    readonly compactor: ResolvedRole
    /** Declared beside the reserved three. Empty for a manifest that declares none. */
    readonly custom: ReadonlyMap<string, ResolvedRole>
    /** Resolve by name, reserved or custom. Throws if the manifest never declared it. */
    byName(name: string): ResolvedRole
}

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

    const custom = new Map<string, ResolvedRole>()
    for (const name of customRoleNames(manifest.model)) {
        const config = manifest.model[name]
        if (config === undefined) continue
        // A custom role never falls back, because it was written down: `configuredAs` is its own
        // name, so a window report shows its endpoint rather than main's.
        custom.set(name, buildRole(name as ModelRole, name as ModelRole, config, options))
    }

    const selector = derive("selector")
    const compactor = derive("compactor")

    return {
        main,
        selector,
        compactor,
        custom,
        byName(name: string): ResolvedRole {
            if (name === "main") return main
            if (name === "selector") return selector
            if (name === "compactor") return compactor
            const found = custom.get(name)
            if (found !== undefined) return found
            throw unknownModelRole(name, [...MODEL_ROLES, ...custom.keys()])
        },
    }
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
    // Reads the declared keys rather than a hardcoded tuple, so a custom role appears in `validate`,
    // `/context` and `model probe` with nothing further to change. The tuple was the drift this
    // repo keeps finding: a second hand-kept list of the same names.
    const names: string[] = [...MODEL_ROLES, ...customRoleNames(manifest.model)]
    return names.map((role) => {
        const declared = manifest.model[role]
        const config = declared ?? manifest.model.main
        const configuredAs: ModelRole = (declared === undefined ? "main" : role) as ModelRole
        return {
            role: role as ModelRole,
            configuredAs,
            modelId: config.id,
            window: windowProvenance(config.id, config.capabilities),
        }
    })
}
