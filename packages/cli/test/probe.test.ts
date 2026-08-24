/**
 * The probe's parsing, against the shapes endpoints actually send.
 *
 * This is where the command can quietly lie. Every number it prints is scraped out of a response that
 * was written for a human, and the failure mode is not a crash — it is a plausible number, written
 * into somebody's manifest, that came from a request id.
 *
 * So the tests are mostly adversarial: messages with several numbers in them, a `/models` listing
 * where the wanted row is not the first, and the distinction the whole feature rests on — a floor
 * against a ceiling.
 */

import { describe, expect, test } from "bun:test"
import {
    bestFinding,
    cacheFromUsage,
    cacheVerdict,
    ceilingFromRefusal,
    contextFromModels,
    registryRow,
    searchCost,
    type WindowFinding,
} from "#lib/probe"

describe("context length from GET /models", () => {
    test("the wanted row is found even when it is not the first", () => {
        // An endpoint serving several models returns several rows, and the first one is somebody
        // else's window. Taking `data[0]` would be right on a single-model host and silently wrong
        // everywhere else.
        const payload = {
            data: [
                { id: "gpt-4o", context_length: 128_000 },
                { id: "deepseek-v4-flash", context_length: 393_216 },
            ],
        }
        expect(contextFromModels(payload, "deepseek-v4-flash")?.tokens).toBe(393_216)
    })

    test("a vendor prefix on either side still matches", () => {
        // Gateways prefix ids (`openai/gpt-4o`); a manifest usually does not.
        expect(
            contextFromModels({ data: [{ id: "openai/gpt-4o", context_length: 5 }] }, "gpt-4o"),
        ).toBeDefined()
        expect(
            contextFromModels({ data: [{ id: "gpt-4o", context_length: 5 }] }, "openai/gpt-4o"),
        ).toBeDefined()
    })

    test("a substring is not a match", () => {
        // `gpt-4o` is a substring of `gpt-4o-mini`. A loose contains would report the wrong model's
        // window with full confidence, which is the worst outcome available to this command.
        expect(
            contextFromModels({ data: [{ id: "gpt-4o-mini", context_length: 8 }] }, "gpt-4o"),
        ).toBe(undefined)
    })

    test("vLLM's spelling is understood", () => {
        // An open-weights host is usually vLLM, which calls it `max_model_len`.
        expect(
            contextFromModels({ data: [{ id: "qwen3.5:9b", max_model_len: 32_768 }] }, "qwen3.5:9b")
                ?.tokens,
        ).toBe(32_768)
    })

    test("a matched row with no context field yields nothing rather than scanning on", () => {
        // OpenAI's `/models` is exactly this: the row exists and carries no window.
        expect(
            contextFromModels(
                {
                    data: [
                        { id: "gpt-4o", owned_by: "openai" },
                        { id: "other", context_length: 99 },
                    ],
                },
                "gpt-4o",
            ),
        ).toBe(undefined)
    })

    test("junk is not a listing", () => {
        for (const payload of [undefined, null, 7, "data", {}, { data: "no" }]) {
            expect(contextFromModels(payload, "any")).toBe(undefined)
        }
    })
})

describe("a number named in a refusal", () => {
    test("the OpenAI wording", () => {
        expect(
            ceilingFromRefusal(
                "This model's maximum context length is 128000 tokens. However, you requested 130512 tokens.",
            ),
        ).toBe(128_000)
    })

    test("an output cap", () => {
        expect(ceilingFromRefusal("max_tokens must be <= 8192")).toBe(8192)
        expect(ceilingFromRefusal("max_tokens: must be less than or equal to 4096")).toBe(4096)
    })

    test("a labelled range gives its upper bound, not its lower", () => {
        // DeepSeek's real wording, captured from a live run on 2026-08-24. The first version of this
        // parser answered **1** — the lower bound — and the report printed `output cap 1`, which is
        // exactly the plausible-but-wrong number this whole file exists to prevent. It was found by
        // running the command against a real endpoint, not by reading it.
        expect(
            ceilingFromRefusal(
                "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]",
            ),
        ).toBe(393_216)
    })

    test("separators inside the number survive", () => {
        expect(ceilingFromRefusal("maximum context length is 1,048,576 tokens")).toBe(1_048_576)
    })

    test("an unlabelled number is never taken", () => {
        // The whole reason the patterns are narrow. An error body is full of numbers that mean
        // nothing here, and a parser reaching for the largest integer would eventually write a
        // request id into a manifest as a context window.
        expect(ceilingFromRefusal("rate limit exceeded, retry after 20s (request 918273645)")).toBe(
            undefined,
        )
        expect(ceilingFromRefusal("Internal server error 500")).toBe(undefined)
    })

    test("when a message names two, the larger labelled one wins", () => {
        // "128000 tokens, however you requested 130512" reads in either order across vendors, and the
        // window is the larger of the pair in every real message seen — except this one, where the
        // request is larger, which is why only *labelled* matches are candidates at all.
        expect(
            ceilingFromRefusal("maximum context length is 128000 tokens; you requested 130512"),
        ).toBe(128_000)
    })
})

describe("cache reporting", () => {
    test("all three vendor spellings are read", () => {
        expect(cacheFromUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 8 })?.cached).toBe(8)
        expect(
            cacheFromUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 6 } })
                ?.cached,
        ).toBe(6)
        expect(cacheFromUsage({ prompt_tokens: 10, cache_read_input_tokens: 4 })?.cached).toBe(4)
    })

    test("a reported zero is an answer; a missing field is not", () => {
        // The distinction the finding exists for. Collapsing them would let "the endpoint never
        // mentioned caching" be reported as "the endpoint says no", which is how every deepseek row
        // came to say `promptCache: "none"`.
        expect(cacheFromUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 0 })?.cached).toBe(0)
        expect(cacheFromUsage({ prompt_tokens: 10 })?.cached).toBe(undefined)
        expect(cacheFromUsage({ prompt_tokens: 10 })?.field).toBe(undefined)
    })

    test("a hit on the repeat proves caching", () => {
        const verdict = cacheVerdict(
            { cached: 0, promptTokens: 1024, field: "prompt_cache_hit_tokens" },
            { cached: 1024, promptTokens: 1024, field: "prompt_cache_hit_tokens" },
            1024,
        )
        expect(verdict.supported).toBe(true)
        expect(verdict.detail).toContain("1024 cached")
    })

    test("a miss is evidence, and says so rather than concluding", () => {
        // A miss can mean the prefix was under the endpoint's minimum. Reporting it as proof is the
        // exact overreach that put `promptCache: "none"` on every deepseek row.
        const verdict = cacheVerdict(
            { cached: 0, promptTokens: 1024, field: "prompt_cache_hit_tokens" },
            { cached: 0, promptTokens: 1024, field: "prompt_cache_hit_tokens" },
            1024,
        )
        expect(verdict.supported).toBe(false)
        expect(verdict.detail).toContain("not proof")
    })

    test("no usage at all is unknown, not negative", () => {
        expect(cacheVerdict(undefined, undefined, 1024).supported).toBe(undefined)
        expect(
            cacheVerdict(
                { cached: undefined, promptTokens: 10, field: undefined },
                { cached: undefined, promptTokens: 10, field: undefined },
                1024,
            ).supported,
        ).toBe(undefined)
    })
})

describe("choosing between findings", () => {
    const ceiling = (tokens: number): WindowFinding => ({
        technique: "refusal",
        tokens,
        bound: "ceiling",
        detail: "",
    })
    const floor = (tokens: number): WindowFinding => ({
        technique: "search",
        tokens,
        bound: "floor",
        detail: "",
    })

    test("a ceiling beats a larger floor", () => {
        // Not competing estimates — different claims. A floor of 900,000 beside a ceiling of 128,000
        // means the search measured something other than the window, and publishing the larger would
        // state a number the endpoint has already contradicted.
        expect(bestFinding([floor(900_000), ceiling(128_000)])?.tokens).toBe(128_000)
    })

    test("among floors the largest wins, because a bigger floor is a stronger floor", () => {
        expect(bestFinding([floor(8192), floor(65_536)])?.tokens).toBe(65_536)
    })

    test("nothing measured is undefined rather than zero", () => {
        expect(bestFinding([])).toBe(undefined)
    })
})

describe("the registry row it offers", () => {
    test("the pattern drops an Ollama tag and the number is underscored", () => {
        const row = registryRow("qwen3.5:9b", 32_768, 4096)
        expect(row).toContain('pattern: "qwen3.5*"')
        expect(row).toContain("contextWindow: 32_768")
        expect(row).toContain("maxOutput: 4_096")
    })

    test("no output ceiling means no maxOutput line, rather than a guessed one", () => {
        expect(registryRow("gpt-4o", 128_000, undefined).includes("maxOutput")).toBe(false)
    })
})

describe("what a --window search will spend", () => {
    test("the total is a hair under twice the largest request, not the sum of a linear scan", () => {
        // The geometric-series result, asserted because a reader checking the estimate against the
        // requests will otherwise expect a much larger number.
        const cost = searchCost(8192, 65_536)
        // 8192 + 16384 + 32768 + 65536
        expect(cost.tokens).toBe(122_880)
        expect(cost.requests).toBe(4)
        expect(cost.tokens).toBeLessThan(65_536 * 2)
    })
})
