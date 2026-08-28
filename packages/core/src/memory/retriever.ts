/**
 * The retrieval seam, and the deterministic ranking signals around BM25: coverage and recency.
 *
 * `MemoryRetriever` is a function-shaped contract for the same reason `SkillSelector` and
 * `KnowledgeSelector` are: it **ranks and nothing else**. The caller owns `threshold`, `maxActive` and
 * `budget`, so a retriever cannot quietly widen any of the three limits it is not allowed to widen. A
 * different retrieval strategy — the vectors this phase explicitly refuses until lexical is proven
 * insufficient — arrives as a different function, not as a different pipeline.
 *
 * ## The recency boost multiplies; it never subtracts
 *
 * The obvious formula blends: `base × (1 - w) + recency × w`. It is wrong here, and the reason is the
 * threshold. Original-query coverage deliberately lowers an incomplete lexical match before the floor;
 * age should not lower it a second time. A blend can push a strong covered match *below* the floor purely
 * for being old, so the threshold would answer a mixed relevance/freshness question nobody measured.
 *
 * So the boost can only lift: `final = coveredBase × (1 + w × 2^(-age / halfLife))`. Recency only
 * reorders or lifts after coverage has answered how much of the current query the passage covers. The
 * consequence is that scores range over
 * `[0, 1 + w)` rather than `[0, 1)`, which is harmless for a floor and is stated here because a reader
 * checking "normalised means under one" would otherwise think they had found a bug.
 *
 * ## The two constants are a documented guess
 *
 * Ship-as-a-guess, the same call as `snip`'s 400-token keep and its two-thirds split, and for the same
 * reason: there is no fixture yet that can distinguish a good half-life from a bad one, and inventing
 * one to justify a number chosen in advance measures nothing. `evals/memory/` records what a fixture
 * would have to show. What *is* reasoned rather than guessed is the shape — multiplicative, bounded,
 * monotonic in age — because that is what keeps the threshold meaningful.
 */

import { terms } from "../rank/bm25.ts"
import type { Passage } from "./passages.ts"

/**
 * How much a brand-new passage may outrank an ancient one of identical lexical strength: 25%.
 *
 * Small on purpose. Memory's failure mode is not "it surfaced something slightly stale", it is "it
 * surfaced something irrelevant", and every point of weight moved from lexical evidence to a clock is a
 * point spent making the second failure more likely.
 */
export const RECENCY_WEIGHT = 0.25

/** Days for the boost to halve. A month: long enough that last week and this week rank alike. */
export const RECENCY_HALF_LIFE_DAYS = 30

const MS_PER_DAY = 86_400_000

/**
 * `1` for something learned an epoch ago, `1 + RECENCY_WEIGHT` for something learned now.
 *
 * An unparseable or future `at` returns the full boost rather than throwing. Future is the interesting
 * case and it is real: a machine whose clock was wrong when a note was written, or a hand-edited stamp.
 * Clamping to "as recent as possible" is the honest reading of "we do not know when, but not before
 * now", and a passage cannot be *penalised* for a bad timestamp — which matters because the timestamp
 * is frequently one a person typed.
 */
export function recencyBoost(at: string, now: Date): number {
    const when = Date.parse(at)
    if (Number.isNaN(when)) return 1 + RECENCY_WEIGHT
    const ageDays = (now.getTime() - when) / MS_PER_DAY
    if (ageDays <= 0) return 1 + RECENCY_WEIGHT
    return 1 + RECENCY_WEIGHT * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS)
}

/** Lexical score × original-query coverage × recency. */
export function boosted(lexical: number, at: string, now: Date, coverage = 1): number {
    return lexical * coverage * recencyBoost(at, now)
}

export interface RetrievedPassage {
    readonly passage: Passage
    /** Lexical × original-query coverage × recency. Comparable to `memory.threshold`. */
    readonly score: number
    /**
     * Normalised BM25 before the boost, on exactly the scale `skills/select.ts` produces.
     *
     * Kept because a ranking nobody can explain is a ranking nobody trusts: `memory search` prints both,
     * so "this was retrieved because it is *about* your question" and "this was retrieved because it is
     * *recent*" are distinguishable without reading the code.
     */
    readonly lexical: number
    /**
     * Fraction of the original informative query terms present in this passage.
     *
     * Unlike BM25's query, this denominator retains terms absent from the corpus. That is what
     * distinguishes a passage matching the lone shared term in a four-term question from a genuine
     * one-term query such as `frankfurt`.
     */
    readonly coverage: number
    /** Estimated tokens of `passage.text`, so the caller can spend its budget without re-estimating. */
    readonly tokens: number
    /**
     * Prior-reply slice that recovered this hit. Present when bounded expansion found the passage
     * (or raised it over the current turn's own ranking). Absent when the current turn already
     * ranked it highest. The passage text is unchanged.
     */
    readonly because?: string
}

export interface RetrieveInput {
    /** The turn's input, and whatever else the caller decided is the query. Concatenated by them. */
    readonly input: string
    readonly now: Date
    /**
     * Sources already present in the prompt, excluded from the result.
     *
     * This is what stops slot 7 repeating slot 4. `MEMORY.md` is *carried* — every one of its passages
     * is in the prompt already — and it is also indexed, because `memory search` must be able to find a
     * note saved a minute ago. Excluding at retrieval rather than at indexing is what lets both be true.
     */
    readonly exclude?: readonly string[]
    /**
     * How many ranked passages to return. The caller then applies its threshold, `maxActive` and budget,
     * so this is a bound on work rather than a policy.
     */
    readonly limit: number
}

/**
 * Ranking only, best first. Never filters by threshold and never counts tokens against a budget.
 *
 * Async because the corpus lives in SQLite. `SkillSelector` is synchronous because fifty frontmatter
 * documents fit in memory and are re-scored per turn; a memory corpus does not and is not.
 */
export type MemoryRetriever = (input: RetrieveInput) => Promise<readonly RetrievedPassage[]>

/** Enough prior prose to recover a follow-up's subject without turning history into the query. */
export const MAX_QUERY_CONTEXT_CHARS = 600

/**
 * Retrieve against a bounded prior reply only when the current query is both underspecified and weak.
 *
 * A broad second query on every turn makes yesterday's subject leak into an unrelated request. The
 * current turn therefore remains authoritative: a result already clearing the configured floor stops
 * expansion, and a query with more than two content terms is specific enough to stand alone.
 */
export async function retrieveWithContext(
    retrieve: MemoryRetriever,
    request: RetrieveInput & {
        readonly minimumScore: number
        readonly previousAssistant?: string
    },
): Promise<readonly RetrievedPassage[]> {
    const { minimumScore, previousAssistant, ...direct } = request
    const primary = await retrieve(direct)
    const previous = previousAssistant?.trim()
    if (
        previous === undefined ||
        previous === "" ||
        terms(request.input).length > 2 ||
        (primary[0]?.score ?? 0) >= minimumScore
    ) {
        return primary
    }

    const context = previous.slice(-MAX_QUERY_CONTEXT_CHARS)
    const expanded = await retrieve({ ...direct, input: `${context}\n${request.input}` })
    const primaryById = new Map(primary.map((hit) => [hit.passage.id, hit]))
    const byId = new Map<string, RetrievedPassage>(primaryById)
    for (const hit of expanded) {
        const prior = primaryById.get(hit.passage.id)
        if (prior === undefined) {
            const current = byId.get(hit.passage.id)
            if (current === undefined || hit.score > current.score) {
                byId.set(hit.passage.id, { ...hit, because: context })
            }
            continue
        }
        if (hit.score > prior.score) {
            byId.set(hit.passage.id, { ...hit, because: context })
        }
    }
    return [...byId.values()].sort(byScoreThenId).slice(0, request.limit)
}

function byScoreThenId(a: RetrievedPassage, b: RetrievedPassage): number {
    if (b.score !== a.score) return b.score - a.score
    return a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0
}

/**
 * Apply the three limits, in the one order that is not arbitrary.
 *
 * Threshold first (relevance is not negotiable), then `maxActive`, then the budget — and the budget
 * **stops at the first passage that does not fit rather than skipping past it**, which is the rule
 * `workspace/knowledge.ts` established for the same reason: skipping would let a worse-ranked short
 * passage displace a better-ranked long one purely by being short, so the ranking would stop being the
 * thing that decides what the model sees.
 */
export function selectPassages(
    ranked: readonly RetrievedPassage[],
    limits: { readonly threshold: number; readonly maxActive: number; readonly budget: number },
): readonly RetrievedPassage[] {
    const out: RetrievedPassage[] = []
    let spent = 0
    for (const candidate of ranked) {
        if (out.length >= limits.maxActive) break
        if (candidate.score < limits.threshold) break
        if (spent + candidate.tokens > limits.budget) break
        out.push(candidate)
        spent += candidate.tokens
    }
    return out
}
