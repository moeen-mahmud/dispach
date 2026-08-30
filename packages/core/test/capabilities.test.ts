import {
    CAPABILITY_REGISTRY,
    describeWindowSource,
    globToRegExp,
    matchCapabilities,
    patternSpecificity,
    resolveCapabilities,
    windowProvenance,
} from "../src/model/capabilities.ts"
import { describe, expect, test } from "./_harness.ts"

describe("glob matching", () => {
    test("a trailing wildcard matches a prefix", () => {
        expect(globToRegExp("gpt-4o*").test("gpt-4o-mini")).toBe(true)
    })

    test("matching is anchored at both ends", () => {
        expect(globToRegExp("gpt-4o").test("my-gpt-4o-proxy")).toBe(false)
    })

    test("matching is case-insensitive", () => {
        expect(globToRegExp("claude-*").test("Claude-Sonnet-4")).toBe(true)
    })

    test("dots are literal, not any-character", () => {
        expect(globToRegExp("gpt-4.1*").test("gpt-4x1-turbo")).toBe(false)
    })
})

describe("specificity", () => {
    test("more literal characters means more specific", () => {
        expect(patternSpecificity("gpt-4o*")).toBeGreaterThan(patternSpecificity("gpt*"))
    })

    test("the catch-all is the least specific thing in the registry", () => {
        expect(patternSpecificity("*")).toBe(0)
    })

    test("the most specific pattern wins, not the first declared", () => {
        // `deepseek-r1*` and `deepseek*` both match. Resolution order must not depend on where
        // someone happened to add an entry.
        expect(matchCapabilities("deepseek-r1-distill-qwen-7b").pattern).toBe("deepseek-r1*")
    })

    test("resolution is deterministic across repeated calls", () => {
        const first = matchCapabilities("gpt-4o-mini").pattern
        for (let i = 0; i < 5; i += 1) expect(matchCapabilities("gpt-4o-mini").pattern).toBe(first)
    })
})

describe("gateway and tag prefixes", () => {
    test("an OpenRouter-style vendor prefix still matches", () => {
        expect(matchCapabilities("openai/gpt-4o").capabilities.contextWindow).toBe(128_000)
    })

    test("an Ollama tag suffix still matches", () => {
        expect(matchCapabilities("qwen3.5:9b").capabilities.contextWindow).toBe(32_768)
    })

    test("a vendor prefix and a tag together still match", () => {
        expect(matchCapabilities("library/llama3.1:70b").capabilities.nativeTools).toBe(true)
    })

    test("an unknown model falls back to the conservative default", () => {
        const capabilities = matchCapabilities("some-inhouse-model-v3").capabilities
        expect(capabilities.contextWindow).toBe(8192)
        expect(capabilities.nativeTools).toBe(false)
        expect(capabilities.thinking).toBe("none")
    })
})

describe("documented provider behaviour", () => {
    test("Anthropic compat reports strictSchema false", () => {
        // Not an oversight. The compat endpoint accepts `strict` and ignores it, so the coercion
        // layer has to run regardless of dialect.
        expect(matchCapabilities("claude-sonnet-4-20250514").capabilities.strictSchema).toBe(false)
    })

    test("Anthropic models report their own thinking protocol", () => {
        expect(matchCapabilities("claude-opus-4-1").capabilities.thinking).toBe("anthropic")
    })

    test("the measured v4 models resolve to the values taken off the wire", () => {
        // Measured 2026-08-12 against api.deepseek.com/v1. `maxOutput` is the endpoint's own
        // stated range ("the valid range of max_tokens is [1, 393216]"), and `contextWindow` is a
        // proven floor: max_tokens=393216 beside an 85-token prompt was accepted.
        const pro = matchCapabilities("deepseek-v4-pro").capabilities
        expect(pro.thinking).toBe("deepseek")
        expect(pro.nativeTools).toBe(true)
        expect(pro.maxOutput).toBe(393_216)
        expect(pro.contextWindow).toBe(393_216)
    })

    test("v4-flash is a reasoning model too, despite the name", () => {
        // A "flash" tier reads like a cheap non-reasoning sibling. It streams reasoning_content,
        // and assuming otherwise would route its scratchpad into the reply.
        expect(matchCapabilities("deepseek-v4-flash").capabilities.thinking).toBe("deepseek")
    })

    test("v4-flash carries a measured ceiling, and its window is not its output cap", () => {
        // Measured 2026-08-25 by `model probe --window`: the endpoint refused a 1,048,576-token
        // prompt and *named* 1,048,576, which is a ceiling. The row previously said 393,216 —
        // inherited from the pro row, where it came from an **acceptance** and was therefore only
        // ever a floor. Asserted because a measured value nothing checks is one that drifts back.
        const flash = matchCapabilities("deepseek-v4-flash").capabilities
        expect(flash.contextWindow).toBe(1_048_576)
        // The pair that must not be collapsed. They were equal on this model before and are not now,
        // which is exactly the case where an assumption that they track each other would break.
        expect(flash.maxOutput).toBe(393_216)
        expect(flash.contextWindow).toBeGreaterThan(flash.maxOutput)
    })

    test("the flash row records how its window was measured, not just that it was", () => {
        // `verified` is prose nothing parses, and that is the point — but a row claiming a
        // measurement has to say which kind. "Refused and named" is a ceiling; "accepted" is a
        // floor, and the two have already been confused once in this very registry.
        const flash = CAPABILITY_REGISTRY.find((entry) => entry.pattern === "deepseek-v4-flash*")
        expect(flash?.verified).toContain("2026-08-25")
        expect(flash?.verified).toContain("ceiling")
    })

    test("an unseen v4 id falls back to the v4 family, not to the pre-v4 defaults", () => {
        const unseen = matchCapabilities("deepseek-v4-turbo").capabilities
        expect(unseen.thinking).toBe("deepseek")
        expect(unseen.contextWindow).toBe(393_216)
    })

    test("measured rows record their provenance, unverified rows say so", () => {
        const pro = CAPABILITY_REGISTRY.find((entry) => entry.pattern === "deepseek-v4-pro*")
        expect(pro?.verified).toContain("2026-08-12")
        const chat = CAPABILITY_REGISTRY.find((entry) => entry.pattern === "deepseek-chat*")
        expect(chat?.verified).toBeUndefined()
        expect(chat?.note).toContain("Unverified")
    })

    test("the hosted DeepSeek reasoner declares its own reasoning protocol", () => {
        // Not `anthropic`: reasoning arrives as `reasoning_content` and is not replayed, so
        // treating the two as one protocol would send text the provider never asked for.
        const capabilities = matchCapabilities("deepseek-reasoner").capabilities
        expect(capabilities.thinking).toBe("deepseek")
        // Deliberately low: this id was not served by the account the registry was tested
        // against, so the row stays conservative rather than borrowing v4's numbers.
        expect(capabilities.contextWindow).toBe(65_536)
    })

    test("deepseek-chat is not a reasoning model", () => {
        const capabilities = matchCapabilities("deepseek-chat").capabilities
        expect(capabilities.thinking).toBe("none")
        expect(capabilities.nativeTools).toBe(true)
    })

    test("the open-weight R1 name resolves like the hosted reasoner", () => {
        // A self-hosted `deepseek-r1` and the hosted `deepseek-reasoner` are the same model behind
        // two names; resolving them differently would make a local eval mean nothing.
        expect(matchCapabilities("deepseek-r1").capabilities.thinking).toBe("deepseek")
        expect(matchCapabilities("deepseek-r1:14b").capabilities.thinking).toBe("deepseek")
        expect(matchCapabilities("deepseek-r1-distill-qwen-7b").capabilities.thinking).toBe(
            "deepseek",
        )
    })

    test("an unknown deepseek id falls back to the family entry, not the reasoner", () => {
        // Guessing `thinking: deepseek` for a non-reasoning model would strip reply text into a
        // reasoning channel nobody reads.
        expect(matchCapabilities("deepseek-v3").capabilities.thinking).toBe("none")
    })

    test("a DeepSeek id behind a gateway prefix still resolves", () => {
        expect(matchCapabilities("deepseek/deepseek-reasoner").capabilities.thinking).toBe(
            "deepseek",
        )
    })

    test("promptCache none does not claim the provider caches nothing", () => {
        // DeepSeek caches context server-side automatically. `none` means the runtime has no
        // breakpoint to place, which is a statement about us rather than about them.
        expect(matchCapabilities("deepseek-chat").capabilities.promptCache).toBe("none")
    })

    test("maxOutput is never derived from the window", () => {
        // A reasoning model handed `window / 4` returns empty with finishReason=length, which looks
        // like a broken agent rather than a misconfigured limit.
        for (const entry of CAPABILITY_REGISTRY) {
            expect(entry.capabilities.maxOutput).toBeLessThanOrEqual(
                entry.capabilities.contextWindow,
            )
            expect(entry.capabilities.maxOutput).toBeGreaterThan(0)
        }
    })

    test("every registry entry is fully specified", () => {
        for (const entry of CAPABILITY_REGISTRY) {
            const c = entry.capabilities
            expect(typeof c.nativeTools).toBe("boolean")
            expect(typeof c.strictSchema).toBe("boolean")
            expect(["none", "anthropic", "openai", "deepseek"]).toContain(c.thinking)
            expect(["none", "anthropic", "openai"]).toContain(c.promptCache)
            expect(typeof c.parallelToolCalls).toBe("boolean")
        }
    })

    test("the registry ends in a catch-all so resolution always succeeds", () => {
        expect(CAPABILITY_REGISTRY.at(-1)?.pattern).toBe("*")
    })
})

describe("manifest override merge", () => {
    test("an override replaces only the keys it names", () => {
        const merged = resolveCapabilities("gpt-4o-mini", { contextWindow: 16_000 })
        expect(merged.contextWindow).toBe(16_000)
        expect(merged.promptCache).toBe("openai")
        expect(merged.maxOutput).toBe(16_384)
    })

    // `promptStyle` is derived from the model id rather than carried on a registry row — the
    // registry's patterns cannot express it, since `qwen3.5*` covers models that want opposite
    // values. So the resolved object is the row plus that one field, and these two compare the row.
    const row = (id: string) => {
        const { promptStyle, ...rest } = resolveCapabilities(id)
        return rest
    }

    test("an empty override changes nothing", () => {
        expect(row("gpt-4o-mini")).toEqual(matchCapabilities("gpt-4o-mini").capabilities)
        expect(resolveCapabilities("gpt-4o-mini", {})).toEqual(resolveCapabilities("gpt-4o-mini"))
    })

    test("an absent override changes nothing", () => {
        expect(row("gpt-4o-mini")).toEqual(matchCapabilities("gpt-4o-mini").capabilities)
    })

    test("promptStyle is present on every resolution, derived rather than looked up", () => {
        expect(resolveCapabilities("gpt-4o-mini").promptStyle.delimiters).toBe("markdown")
        const registryRow: Record<string, unknown> = matchCapabilities("gpt-4o-mini").capabilities
        expect("promptStyle" in registryRow).toBe(false)
    })

    test("an override can correct a wrong registry entry entirely", () => {
        const merged = resolveCapabilities("claude-sonnet-4", {
            strictSchema: true,
            thinking: "none",
            contextWindow: 32_768,
            maxOutput: 2048,
        })
        expect(merged).toEqual({
            nativeTools: true,
            strictSchema: true,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 32_768,
            maxOutput: 2048,
            promptStyle: {
                delimiters: "xml",
                intensity: "neutral",
                examplesIn: "system",
                skillsIn: "system",
            },
        })
    })

    test("false is a real override value, not an absent one", () => {
        // `{...base, ...override}` with a falsy-filtering bug would silently keep `true` here.
        expect(resolveCapabilities("gpt-4o-mini", { nativeTools: false }).nativeTools).toBe(false)
    })
})

describe("window provenance", () => {
    test("a manifest override is the manifest, whatever the registry says", () => {
        const provenance = windowProvenance("deepseek-v4-pro", { contextWindow: 1_048_576 })
        expect(provenance.source).toBe("manifest")
        expect(provenance.contextWindow).toBe(1_048_576)
        // No pattern: the registry did not decide this, and naming a row that lost would read as
        // though it had.
        expect(provenance.pattern).toBe(undefined)
    })

    test("an override of a different field leaves the window with the registry", () => {
        // The check is on `contextWindow` specifically, not on "an override exists". An author
        // setting `nativeTools` has said nothing about the window.
        const provenance = windowProvenance("deepseek-v4-pro", { nativeTools: false })
        expect(provenance.source).toBe("registry")
    })

    test("a matched row is the registry, and names the row", () => {
        // The pattern is the useful half, and it changed meaning once the Claude rows were split:
        // `registry claude-*` used to say one row answered for every Claude model ever released,
        // which is what let a 200K window stand for a 1M one. A named row says the opposite.
        const provenance = windowProvenance("claude-sonnet-5")
        expect(provenance.source).toBe("registry")
        expect(provenance.pattern).toBe("claude-sonnet-5*")
    })

    /**
     * The catch-all stays conservative, and that asymmetry is the whole reason for the split.
     *
     * Under-reporting a window over-compacts and wastes tokens; over-reporting one overflows the
     * endpoint. So the 1M models are named individually and `claude-*` keeps 200K — raising the
     * catch-all would have claimed 1M for Sonnet 4.5, Opus 4.5 and the 3.x line, which are 200K, and
     * that error is the unrecoverable direction.
     */
    test("an unnamed Claude model gets the conservative row, not the 1M one", () => {
        expect(windowProvenance("claude-sonnet-4-5").pattern).toBe("claude-*")
        expect(matchCapabilities("claude-sonnet-4-5").capabilities.contextWindow).toBe(200_000)
        expect(matchCapabilities("claude-3-5-sonnet-20241022").capabilities.contextWindow).toBe(
            200_000,
        )
    })

    test("every Claude row reports no prompt caching, whatever its window", () => {
        // Not a claim about Anthropic — a claim about the OpenAI-compatible endpoint this runtime
        // speaks, which does not support caching at all. A row that says otherwise is describing a
        // transport it is not on.
        for (const id of [
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-haiku-4-5",
            "claude-sonnet-4-5",
        ]) {
            expect(matchCapabilities(id).capabilities.promptCache).toBe("none")
        }
    })

    test("an unmatched id is the fallback, not a registry hit", () => {
        // The whole point of the field: `CONSERVATIVE`'s 8,192 has been indistinguishable from a
        // measured 8,192 since the registry existed.
        const provenance = windowProvenance("some-model-nobody-listed-v9")
        expect(provenance.source).toBe("fallback")
        expect(provenance.contextWindow).toBe(8192)
    })

    test("the fallback's tag says it is a floor; the others stay short", () => {
        expect(describeWindowSource(windowProvenance("claude-sonnet-5"))).toBe(
            "registry claude-sonnet-5*",
        )
        expect(describeWindowSource(windowProvenance("nothing-matches-this"))).toContain("floor")
        expect(describeWindowSource(windowProvenance("x", { contextWindow: 10 }))).toBe("manifest")
    })
})
