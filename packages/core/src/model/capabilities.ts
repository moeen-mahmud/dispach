/**
 * Per-model capability descriptors.
 *
 * A base URL and a key are not enough to drive a model correctly. Anthropic's compat endpoint
 * ignores `strict` on function calls; extended-thinking blocks must be replayed alongside tool
 * results or multi-step reasoning silently degrades; prompt-cache breakpoints are
 * provider-specific. Those are behavioural facts the loop has to know.
 *
 * **Capabilities never choose the tool dialect.** The dialect is config, so behaviour cannot
 * drift when someone swaps the model. Capabilities drive thinking-block replay and
 * cache-breakpoint placement, and nothing else.
 *
 * **This registry is conservative, not authoritative.** It is a shipped default that keeps a
 * misidentified model working badly rather than catastrophically — under-reporting a context
 * window wastes budget, while over-reporting it produces empty responses with
 * `finishReason: length`, which is the failure mode that costs a day to diagnose. Anything
 * wrong for your endpoint is one `model.<role>.capabilities` block away from fixed.
 */

import type { ModelCapabilitiesOverride } from "../manifest/schema.ts"
import { defaultPromptStyle, type PromptStyle } from "./prompt-style.ts"

export interface ModelCapabilities {
    /** Whether the endpoint implements the `tools` parameter and `tool_calls` responses. */
    readonly nativeTools: boolean
    /** Whether `strict` schema conformance is honoured. Anthropic's compat endpoint ignores it. */
    readonly strictSchema: boolean
    /**
     * Reasoning protocol. Not a "does it think" flag — it says what the loop must *do* with
     * reasoning, and the non-`none` cases disagree with each other:
     *
     * - `anthropic` — blocks arrive separately and **must be replayed** alongside tool results,
     *   or multi-step reasoning silently degrades.
     * - `openai` — reasoning is server-side and opaque. Nothing to replay.
     * - `deepseek` — arrives as `reasoning_content`, separately from `content`, and is **not**
     *   replayed. Measured against api.deepseek.com on 2026-08-12: sending it back is *accepted*
     *   rather than rejected, but it buys nothing, and DeepSeek's own guidance for earlier
     *   reasoning models was to omit it. So the loop drops it.
     *
     * The distinction earns a fourth case rather than a boolean: collapsing `deepseek` into
     * `none` would let the model's scratchpad be delivered to the user as the reply, and
     * collapsing it into `anthropic` would replay text the provider never asked for.
     *
     * A separate consequence, and the one that actually bites: on a `deepseek` model, reasoning
     * tokens are billed against the **output** budget. A `max_tokens` too small to cover
     * reasoning returns empty content with `finish_reason: "length"` — verified, not theoretical.
     * `context.reserveOutput` has to be generous enough for reasoning plus the reply.
     */
    readonly thinking: "none" | "anthropic" | "openai" | "deepseek"
    /** Prompt-cache protocol, which determines where breakpoints go. */
    readonly promptCache: "none" | "anthropic" | "openai"
    readonly parallelToolCalls: boolean
    readonly contextWindow: number
    /** Max completion tokens. Never derive this from the window — see the note above. */
    readonly maxOutput: number
    /**
     * How authored workspace files are rendered for this model.
     *
     * Derived from the model id rather than tabulated per row, and that is not a shortcut: the
     * registry's patterns cannot express it. `qwen3.5*` matches both `qwen3.5:9b` and
     * `qwen3.5:72b`, and those two want opposite `intensity` values — size is what predicts the
     * inversion, and size is in the id, not in the pattern. See `prompt-style.ts`.
     */
    readonly promptStyle: PromptStyle
}

/**
 * A registry row. Everything in `ModelCapabilities` except the parts that are derived from the
 * model id rather than looked up by it.
 */
export type RegistryCapabilities = Omit<ModelCapabilities, "promptStyle">

export interface CapabilityEntry {
    /** Glob over the model id. `*` matches any run of characters. */
    readonly pattern: string
    readonly capabilities: RegistryCapabilities
    readonly note?: string
    /**
     * Provenance. Set when the values were measured against a live endpoint, with the date —
     * otherwise they came from provider documentation and are a conservative guess. Worth stating
     * explicitly: an unverified row that looks authoritative is how a wrong number survives.
     */
    readonly verified?: string
}

const CONSERVATIVE: RegistryCapabilities = {
    nativeTools: false,
    strictSchema: false,
    thinking: "none",
    promptCache: "none",
    parallelToolCalls: false,
    contextWindow: 8192,
    maxOutput: 4096,
}

/**
 * Ordered for readability only — resolution picks the most specific match, not the first.
 */
/**
 * What every Claude row shares, because every one of them describes the **OpenAI-compatible**
 * endpoint rather than the native Messages API.
 *
 * Two fields turn on that distinction. `strict` is accepted and not honoured, so the coercion layer
 * runs regardless of dialect. And **prompt caching is not supported at all** on that endpoint —
 * Anthropic's compatibility page says so outright and lists `usage.prompt_tokens_details` as
 * "Always empty" — so `promptCache` is `none` here. That is a statement about the transport, not
 * about Anthropic's caching, which is first-class on `/v1/messages`; sending `cache_control` through
 * this endpoint would not help. The consequence worth writing down: the cache-stable prefix ordering
 * this runtime is built around buys nothing on Claude models, measured at 89.4% on a DeepSeek
 * endpoint and structurally 0% here.
 *
 * The row this replaced declared `promptCache: "anthropic"` directly beneath a comment reading
 * "Anthropic, via its OpenAI-compatible endpoint" — and directly beneath `strictSchema: false`,
 * whose comment had already made this exact argument for the field above it.
 */
const CLAUDE_BASE = {
    nativeTools: true,
    strictSchema: false,
    thinking: "anthropic",
    promptCache: "none",
    parallelToolCalls: true,
} as const

const CLAUDE_NOTE =
    "Thinking blocks must be replayed with tool results or multi-step reasoning degrades silently. Prompt caching is unavailable on the OpenAI-compatible endpoint; the native Messages API is the only route to it."

export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = [
    // ── OpenAI ─────────────────────────────────────────────────────────────────────────────
    {
        pattern: "gpt-4o*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "none",
            promptCache: "openai",
            parallelToolCalls: true,
            contextWindow: 128_000,
            maxOutput: 16_384,
        },
    },
    {
        pattern: "gpt-4.1*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "none",
            promptCache: "openai",
            parallelToolCalls: true,
            contextWindow: 1_000_000,
            maxOutput: 32_768,
        },
    },
    {
        pattern: "gpt-4-turbo*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 128_000,
            maxOutput: 4096,
        },
    },
    {
        pattern: "gpt-3.5*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 16_385,
            maxOutput: 4096,
        },
    },
    {
        pattern: "gpt-5*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: true,
            contextWindow: 200_000,
            maxOutput: 32_768,
        },
        note: "Deliberately conservative on window and output. Override if your endpoint serves more.",
    },
    {
        pattern: "o1*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: false,
            contextWindow: 200_000,
            maxOutput: 100_000,
        },
    },
    {
        pattern: "o3*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: false,
            contextWindow: 200_000,
            maxOutput: 100_000,
        },
    },
    {
        pattern: "o4*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: false,
            contextWindow: 200_000,
            maxOutput: 100_000,
        },
    },

    // ── Anthropic, via its OpenAI-compatible endpoint ──────────────────────────────────────
    //
    // Every row here describes that endpoint, not the native Messages API, and the difference is
    // load-bearing for two fields. `strict` is accepted and not honoured; **prompt caching is not
    // supported at all** — Anthropic's own compatibility page says so, and lists
    // `usage.prompt_tokens_details` as "Always empty". So `promptCache` is `none` on every Claude
    // row: not a statement about Anthropic's caching, which is excellent, but about this transport,
    // which cannot reach it. Sending `cache_control` would not help. The cache-stable prefix
    // ordering therefore buys nothing here — measured at 89.4% on a DeepSeek endpoint and
    // structurally 0% on this one — and the only route to it is a native `/v1/messages` transport
    // this runtime does not have.
    //
    // The window rows split deliberately. `claude-*` is a catch-all that also matches Sonnet 4.5,
    // Opus 4.5 and the 3.x line, all of which are 200K — so it keeps the conservative number and
    // the 1M models are named. Under-reporting a window over-compacts and wastes tokens; over-
    // reporting one overflows the endpoint, and only the second is unrecoverable.
    // The 1M-window generation, one row each. `globToRegExp` escapes braces, so `{a,b}` would be a
    // literal and match nothing — a brace group here is a silent no-match, not a shorthand.
    ...(
        [
            "claude-fable-5*",
            "claude-opus-5*",
            "claude-opus-4-8*",
            "claude-opus-4-7*",
            "claude-opus-4-6*",
            "claude-sonnet-5*",
            "claude-sonnet-4-6*",
        ] as const
    ).map((pattern) => ({
        // 1M context, 128K output — Anthropic's model comparison table, read 2026-08-29.
        pattern,
        capabilities: { ...CLAUDE_BASE, contextWindow: 1_000_000, maxOutput: 128_000 },
        note: CLAUDE_NOTE,
    })),
    {
        // 200K context, 64K output — same table, same date.
        pattern: "claude-haiku-*",
        capabilities: { ...CLAUDE_BASE, contextWindow: 200_000, maxOutput: 64_000 },
        note: CLAUDE_NOTE,
    },
    {
        // The catch-all, deliberately conservative: it matches every Claude model not named above,
        // including the 200K-window generations, and 8192 is a floor every one of them clears.
        pattern: "claude-*",
        capabilities: { ...CLAUDE_BASE, contextWindow: 200_000, maxOutput: 8192 },
        note: CLAUDE_NOTE,
    },

    // ── Google, via its OpenAI-compatible endpoint ─────────────────────────────────────────
    {
        pattern: "gemini*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 1_000_000,
            maxOutput: 8192,
        },
    },

    // ── Open weights, typically local via Ollama or vLLM ───────────────────────────────────
    //
    // More specific patterns first: `patternSpecificity` decides, but reading order should match.
    {
        // qwen3.5 reasons, and the generic `qwen*` row below says it does not. Measured through
        // Ollama's OpenAI-compatible endpoint: reasoning arrives in a `reasoning` delta field,
        // separately from `content`, which is the `deepseek` protocol — separate field, nothing to
        // replay. Left as `none` it would be the "model's scratchpad delivered as the reply" case
        // the fourth enum value exists to prevent, and the empty-reply-at-`length` diagnosis would
        // name the wrong cause.
        pattern: "qwen3.5*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
        note: "Served locally by Ollama, which reports no token usage unless model.<role>.streamUsage is set — token figures come from the estimator until it is. Reasoning is billed to the output budget, so context.reserveOutput must cover reasoning plus the reply.",
        verified: "2026-08-13 against qwen3.5:9b on localhost:11434/v1",
    },
    {
        pattern: "qwen*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
    },
    {
        pattern: "llama*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 128_000,
            maxOutput: 4096,
        },
    },
    {
        pattern: "mistral*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
    },
    {
        pattern: "mixtral*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
    },
    // ── DeepSeek ───────────────────────────────────────────────────────────────────────────
    // `promptCache: "none"` is not "no caching" anywhere below. DeepSeek caches context
    // automatically server-side — its responses carry `prompt_cache_hit_tokens` — with no
    // breakpoints for a client to place. `none` is a statement about the runtime's job, not the
    // provider's behaviour.
    //
    // The v4 rows were measured; the older rows came from documentation. See `verified`.
    {
        pattern: "deepseek-v4-pro*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            // One `tool_calls` entry came back for a single-tool prompt, which demonstrates tool
            // calling but not parallelism. Left conservative until something proves otherwise.
            parallelToolCalls: false,
            // A floor, not a ceiling: `max_tokens: 393216` alongside an 85-token prompt was
            // accepted, so the real window is at least 393,301. Claiming only what was shown.
            contextWindow: 393_216,
            // Authoritative — the endpoint's own rejection message names the range:
            // "the valid range of max_tokens is [1, 393216]".
            maxOutput: 393_216,
        },
        note: "Reasoning tokens are billed to the output budget. With max_tokens=16 this model returned empty content and finish_reason=length; context.reserveOutput must cover reasoning plus the reply.",
        verified: "2026-08-12 against api.deepseek.com/v1",
    },
    {
        pattern: "deepseek-v4-flash*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            // Verified: flash streams reasoning_content too. It is a reasoning model, not a
            // cheap non-reasoning sibling, which is the assumption a "flash" name invites.
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            // A **ceiling**, not a floor: the endpoint refused a 1,048,576-token prompt and named
            // 1,048,576 in the refusal. That is the distinction decision 3.10 exists for — this row
            // previously carried 393,216, inherited from the pro row, where it had been established
            // by an *acceptance* (`max_tokens=393216` beside an 85-token prompt) and was therefore
            // only ever a floor. The registry was publishing 37.5% of the real window.
            contextWindow: 1_048_576,
            // Unchanged and separately confirmed: the output cap really is 393,216, from the
            // endpoint's own stated range. A window and an output limit are different numbers, and
            // this model is the reason to say so — they were equal before and are not now.
            maxOutput: 393_216,
        },
        verified:
            "2026-08-12 against api.deepseek.com/v1 (reasoning confirmed). Measured 2026-08-25 by `model probe --window`: contextWindow 1048576 as a ceiling — the endpoint refused a 1048576-token prompt and named that number; maxOutput 393216 from a refusal naming the range [1, 393216]; automatic prompt caching confirmed at 1024 of 1115 prompt tokens with no breakpoints sent, which is why promptCache stays `none` (it describes the runtime's job, not the provider's behaviour).",
    },
    {
        pattern: "deepseek-v4*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 393_216,
            maxOutput: 393_216,
        },
        note: "Family fallback for v4 ids this registry has not seen. Assumes reasoning, because both measured v4 models emit it.",
    },
    {
        pattern: "deepseek-reasoner*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
        note: "Not served by the account this registry was tested against. Numbers are from provider documentation and are deliberately low — override them if your endpoint serves this id.",
    },
    {
        pattern: "deepseek-chat*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
        note: "Unverified, from provider documentation.",
    },
    {
        pattern: "deepseek-r1*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
        note: "The open-weight name for the reasoner, used by self-hosted and Ollama deployments.",
    },
    {
        pattern: "deepseek*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
    },
    {
        pattern: "gemma*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 8192,
            maxOutput: 4096,
        },
    },
    {
        pattern: "phi*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 16_384,
            maxOutput: 4096,
        },
    },

    { pattern: "*", capabilities: CONSERVATIVE },
]

export function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
        char === "*" ? ".*" : `\\${char}`,
    )
    return new RegExp(`^${escaped}$`, "i")
}

/** Literal characters in the pattern. More literal characters means more specific. */
export function patternSpecificity(pattern: string): number {
    return pattern.replace(/\*/g, "").length
}

/**
 * Candidate ids to match against, most qualified first. Gateways prefix ids with a vendor
 * (`openai/gpt-4o`, `anthropic/claude-3-5-sonnet`), so the bare model name is tried too.
 */
function candidateIds(modelId: string): string[] {
    const slash = modelId.lastIndexOf("/")
    const bare = slash === -1 ? undefined : modelId.slice(slash + 1)
    const colon = modelId.indexOf(":")
    // Ollama tags: `qwen3.5:9b`.
    const untagged = colon === -1 ? undefined : modelId.slice(0, colon)
    const candidates = [modelId, bare, untagged]
    if (bare !== undefined) {
        const bareColon = bare.indexOf(":")
        if (bareColon !== -1) candidates.push(bare.slice(0, bareColon))
    }
    return candidates.filter((id): id is string => id !== undefined && id !== "")
}

/**
 * The most specific matching entry. Ties break toward the longer pattern, then toward
 * declaration order — resolution has to be deterministic or two identical deployments
 * behave differently.
 */
export function matchCapabilities(modelId: string): CapabilityEntry {
    const candidates = candidateIds(modelId)
    let best:
        | { entry: CapabilityEntry; specificity: number; length: number; index: number }
        | undefined

    for (const [index, entry] of CAPABILITY_REGISTRY.entries()) {
        const regex = globToRegExp(entry.pattern)
        if (!candidates.some((candidate) => regex.test(candidate))) continue

        const specificity = patternSpecificity(entry.pattern)
        const length = entry.pattern.length
        if (
            best === undefined ||
            specificity > best.specificity ||
            (specificity === best.specificity && length > best.length) ||
            (specificity === best.specificity && length === best.length && index < best.index)
        ) {
            best = { entry, specificity, length, index }
        }
    }

    // The registry ends in `*`, so this is unreachable in practice. Keeping the fallback means a
    // future edit that removes it degrades instead of throwing.
    return best?.entry ?? { pattern: "*", capabilities: CONSERVATIVE }
}

/**
 * Where a role's context window came from.
 *
 * `CONSERVATIVE`'s 8,192 for an unmatched model id has been indistinguishable from a measured 8,192
 * since the registry existed, and the registry's own comment is honest about why the number is low —
 * *"A floor, not a ceiling… Claiming only what was shown"*. That honesty is exactly how it stays
 * wrong: nothing downstream can tell a floor from a fact, so nobody corrects one.
 *
 * The conservative *value* stays. Over-reporting a window produces empty replies at
 * `finishReason: length`, which is a worse failure than budgeting small. What changes is that nothing
 * pretends to know.
 *
 * There is deliberately no `measured` case. `model probe --write` puts its number in the manifest like
 * any other, and once written the honest answer to "where did this come from" *is* the manifest — the
 * probe leaves a dated comment beside it for the person, which nothing parses. A schema field whose
 * only job is to label another field would also be settable by hand, which turns a fact into a claim.
 */
export type WindowSource = "manifest" | "registry" | "fallback"

export interface WindowProvenance {
    readonly source: WindowSource
    /**
     * The registry pattern that matched, or `undefined` when the manifest decided.
     *
     * Carried because it is the more useful half of the diagnostic: `registry` says a row was found,
     * and `claude-*` says the row found is **one row for every Claude model ever released**, which is
     * the thing worth acting on. Required-but-undefined rather than optional — under
     * `exactOptionalPropertyTypes` an optional field cannot be cleared by assignment, and a
     * conditionally-spread field is the shape that has cost this repo six debugging rounds.
     */
    readonly pattern: string | undefined
    readonly contextWindow: number
}

/**
 * Which of the three decided this role's window, and what the number is.
 *
 * Answers for `contextWindow` alone rather than for the whole capability set. Every field in a
 * registry row has the same problem, but the window is the one a budget divides by, so it is the one
 * whose being a guess changes what the runtime does.
 */
export function windowProvenance(
    modelId: string,
    override?: ModelCapabilitiesOverride,
): WindowProvenance {
    if (override?.contextWindow !== undefined) {
        return { source: "manifest", pattern: undefined, contextWindow: override.contextWindow }
    }
    const entry = matchCapabilities(modelId)
    return {
        // The registry ends in `*`, so this is the "nothing matched" case wearing the only pattern
        // that could have caught it.
        source: entry.pattern === "*" ? "fallback" : "registry",
        pattern: entry.pattern,
        contextWindow: entry.capabilities.contextWindow,
    }
}

/**
 * The provenance as one short tag, for a line that already carries the number.
 *
 * In core because three surfaces print it — `validate`, `/status` and `/context` — and a second
 * wording is how two of them come to describe the same number differently. Same reasoning as the
 * turn-end note: one formatter, several callers.
 *
 * The registry case names the **pattern**, which is the half worth reading: `registry claude-*` tells
 * you at a glance that one row is answering for every Claude model ever released. The fallback case
 * spends more words than the others because it is the one that means "nobody knows".
 */
export function describeWindowSource(provenance: WindowProvenance | undefined): string {
    if (provenance === undefined) return ""
    switch (provenance.source) {
        case "manifest":
            return "manifest"
        case "registry":
            return `registry ${provenance.pattern ?? "?"}`
        case "fallback":
            return "fallback (no row matched — a floor, not a measurement)"
    }
}

/** Registry match merged with a manifest override. Only defined override keys are applied. */
export function resolveCapabilities(
    modelId: string,
    override?: ModelCapabilitiesOverride,
): ModelCapabilities {
    const base: ModelCapabilities = {
        ...matchCapabilities(modelId).capabilities,
        promptStyle: defaultPromptStyle(modelId),
    }
    if (override === undefined) return base

    const defined: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(override)) {
        if (key === "promptStyle") continue
        if (value !== undefined) defined[key] = value
    }

    // `promptStyle` merges field by field rather than replacing wholesale. An author setting
    // `intensity: emphatic` for a small model is not thereby asking for the default `delimiters`,
    // and making them restate all four to change one is how a config grows stale copies of a
    // default that has since moved.
    const style = override.promptStyle
    return {
        ...base,
        ...defined,
        promptStyle:
            style === undefined
                ? base.promptStyle
                : {
                      delimiters: style.delimiters ?? base.promptStyle.delimiters,
                      intensity: style.intensity ?? base.promptStyle.intensity,
                      examplesIn: style.examplesIn ?? base.promptStyle.examplesIn,
                      skillsIn: style.skillsIn ?? base.promptStyle.skillsIn,
                  },
    } as ModelCapabilities
}
