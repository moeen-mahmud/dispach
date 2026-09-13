/**
 * Miss-only term correction: unique nearest neighbour, fail closed on a partial rewrite.
 */

import { correctTerms, editDistance } from "../src/memory/correct.ts"
import { describe, expect, test } from "./_harness.ts"

const VOCAB = new Set([
    "stag",
    "cluster",
    "frankfurt",
    "backup",
    "verifi",
    "analytic",
    "replica",
    "approv",
    "deploi",
])

describe("correctTerms", () => {
    test("a unique neighbour of each missing term is rewritten", () => {
        expect(correctTerms(["stagng", "cluser"], VOCAB)).toEqual(["stag", "cluster"])
        expect(correctTerms(["frankfrut"], VOCAB)).toEqual(["frankfurt"])
    })

    test("an incomplete rewrite returns nothing rather than a partial MATCH", () => {
        // `cluser` → `cluster` is unique; `parking` has no neighbour. Querying `cluster` alone
        // would retrieve the staging note for a parking question.
        expect(correctTerms(["parking", "cluser"], VOCAB)).toEqual([])
    })

    test("terms already in the vocabulary are kept", () => {
        expect(correctTerms(["frankfurt", "cluser"], VOCAB)).toEqual(["frankfurt", "cluster"])
    })

    test("a short unknown term is ignored, not guessed", () => {
        expect(correctTerms(["cup", "frankfurt"], VOCAB)).toEqual(["frankfurt"])
    })
})

describe("editDistance", () => {
    test("a transposition costs 2, so it is inside the cap only for longer terms", () => {
        expect(editDistance("frankfrut", "frankfurt", 2)).toBe(2)
        expect(editDistance("from", "form", 1)).toBe(2)
    })
})
