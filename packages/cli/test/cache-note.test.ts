/**
 * The `promptCache` explanation in `validate`.
 *
 * `promptCache: "none"` has two causes that want opposite conclusions, and the first version of this
 * function assumed one of them. It fired on a DeepSeek agent saying "no prefix caching on this
 * endpoint" — an hour after that same endpoint was measured serving **89.4%** of its prompt tokens
 * from cache. The field describes what the runtime *sends*, not what the endpoint *does*.
 */

import { describe, expect, test } from "bun:test"
import { cacheNote } from "#validate"

describe("cacheNote", () => {
    test("says nothing when the runtime does send cache directives", () => {
        // A line that always prints is a line nobody reads.
        expect(cacheNote("openai", "gpt-5-6-sol")).toBe("")
        expect(cacheNote("anthropic", "claude-opus-5")).toBe("")
    })

    /**
     * The regression that prompted this file. A note asserting "no caching" on an endpoint that
     * demonstrably caches is worse than no note: it is a runtime contradicting its own measurement.
     */
    test("a non-Claude endpoint is not told it cannot cache", () => {
        const note = cacheNote("none", "deepseek-v4-pro")
        expect(note).toContain("sends no cache directives")
        expect(note).toContain("/context")
        expect(note).not.toContain("does not support")
    })

    test("Claude is told the transport is the limit, not the provider", () => {
        const note = cacheNote("none", "claude-opus-5")
        expect(note).toContain("OpenAI-compatible endpoint does not support")
        expect(note).toContain("Messages API")
        // Not "your provider has no caching" — Anthropic's is first-class on the native API.
        expect(note).not.toContain("sends no cache directives")
    })

    test("a gateway-prefixed Claude id is still recognised", () => {
        // `anthropic/claude-opus-5` is what an OpenRouter-style gateway sends, and the capability
        // matcher already strips the vendor prefix — this has to agree with it or the two disagree
        // about the same model.
        expect(cacheNote("none", "anthropic/claude-sonnet-5")).toContain("Messages API")
    })
})
