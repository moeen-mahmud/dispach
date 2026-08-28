/**
 * The one BM25 in this runtime: tokenisation, idf, and the normalisation denominator.
 *
 * Extracted from `skills/select.ts` when Phase 6 landed, because "the retriever reuses Phase 3.5's
 * ranking seam rather than building a second index" is a claim that has to be *structurally* true.
 * Two callers computing the same formula from two copies of it is exactly the drift this repo pays
 * attention to elsewhere — and here it would be invisible, because both copies would keep returning
 * plausible numbers while `skills.threshold` and `memory.threshold` quietly stopped meaning the same
 * thing.
 *
 * Two consumers:
 *
 * - `skills/select.ts` scores a few dozen frontmatter documents with **no index**, recomputing
 *   document frequencies every turn. At that size an index is an optimisation for a corpus this is
 *   not (decision 11.44).
 * - `memory/fts5.ts` scores thousands of passages **through** an index, because a memory corpus grows
 *   without bound and re-tokenising it per turn would put the retrieval budget in the boot budget.
 *
 * ## Why the numbers agree across the two
 *
 * SQLite's FTS5 implements this same BM25 — `idf = log((N - n + 0.5) / (n + 0.5) + 1)`, default
 * `k1 = 1.2`, `b = 0.75`, all three matching the constants below. So the *scores* agree provided the
 * *tokens* do, which is the part that needs work: FTS5's built-in tokenisers apply no stopword list,
 * and `porter` stems differently from `stem()` here. `memory/fts5.ts` therefore indexes the output of
 * `terms()` rather than the prose, leaving FTS5's tokeniser nothing to do but split on the spaces we
 * put there. That is what makes one threshold constant legitimate in both places, and it is asserted
 * rather than assumed — `memory-rank.test.ts` scores one corpus both ways and compares.
 *
 * **Consequence, and it is not optional:** the indexed column is *derived* from this module. Change
 * `stem`, `STOPWORDS` or `MIN_TERM` and every existing index is stale in a way no query can detect.
 * `TOKENISER_VERSION` is what turns that into a rebuild rather than into silently worse retrieval.
 */

/**
 * Standard BM25 parameters. Named so the normalisation below can refer to `k1`.
 *
 * These are also SQLite FTS5's defaults, which is not a coincidence to preserve casually: FTS5's
 * `bm25()` takes no k1/b arguments, so changing either here would make the two scorers disagree with
 * no way to bring the indexed one back into line.
 */
export const K1 = 1.2
export const B = 0.75

/** Single characters carry no routing signal and inflate every document's length. */
export const MIN_TERM = 2

/**
 * Bumped whenever `terms()` output changes for any input.
 *
 * Stored beside a built index so a mismatch forces a rebuild. Without it, editing the stopword list
 * leaves every already-indexed passage tokenised under the old rules while queries arrive under the
 * new ones — retrieval simply gets worse, with nothing anywhere reporting why. Same reasoning as the
 * store's `user_version`, applied to a derived column instead of a schema.
 */
export const TOKENISER_VERSION = 2

/**
 * English function words, dropped from documents and queries alike.
 *
 * A closed list rather than a corpus statistic, because the corpus statistic **cannot work at these
 * sizes** and three separate measurements said so. `discriminating()` excludes a term appearing in more
 * than half the skills, which is sound with fifty and meaningless with three: in the shipped reference
 * workspace, `the` appears in exactly one of three descriptions, so "who won the 1998 world cup" reduced
 * to `{the}` and activated a CSV profiler at 0.446. The same shape appeared at four skills ("capital *of*
 * peru" → a Word-document skill, 0.518) and at eight ("what's *the* weather in dhaka" → 0.771, before the
 * half-corpus rule existed at all).
 *
 * Deliberately only function words: articles, pronouns, auxiliaries, prepositions, conjunctions. Nothing
 * domain-bearing, nothing a skill description would ever hinge on. That is the difference between a
 * stopword list and a tuned blocklist — the first is a statement about English, the second is a statement
 * about this corpus, and the second would need re-tuning every time a skill was added.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
    "about",
    "after",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "been",
    "before",
    "being",
    "both",
    "but",
    "by",
    "can",
    "did",
    "do",
    "does",
    "doing",
    "done",
    "for",
    "from",
    "had",
    "has",
    "have",
    "he",
    "her",
    "here",
    "hers",
    "him",
    "his",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "me",
    "more",
    "most",
    "my",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "only",
    "or",
    "other",
    "our",
    "out",
    "over",
    "own",
    "same",
    "she",
    "so",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "to",
    "too",
    "under",
    "until",
    "up",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
])

/**
 * Crude suffix stripping, so an inflected description meets a base-form query.
 *
 * **Measured against real third-party skills.** `anthropics/skills`' `pdf` description says "combining or
 * merging", "rotating pages"; a person types "merge these two pdfs and rotate page 3". Without this the
 * query's only matching terms were `pdfs` and `page` — and `page` appears in the *docx* description, which
 * is shorter, so `docx` won a question about rotating PDF pages while `pdf` scored nothing on its three
 * strongest signals.
 *
 * Not a Porter stemmer, and deliberately not: the full ruleset is several hundred lines to fix cases a
 * routing decision over a handful of documents does not have. This handles the plural and the gerund,
 * which is what descriptions and requests actually disagree about. `extraction` still does not meet
 * `extract`, and that is an accepted miss rather than an oversight.
 *
 * The `>= 3` floors are what keep it from destroying short words: `bring` must not become `br`, and `sing`
 * must not become `s`.
 */
export function stem(term: string): string {
    let out = term
    if (out.length > 3) {
        for (const suffix of ["ing", "ed", "es", "s"]) {
            if (out.endsWith(suffix) && out.length - suffix.length >= 3) {
                out = out.slice(0, -suffix.length)
                break
            }
        }
    }
    // A trailing `e` last, so `merge` and `merging` both land on `merg` — the pair that motivated this.
    return out.length > 3 && out.endsWith("e") ? out.slice(0, -1) : out
}

/**
 * Text → the terms BM25 scores it on.
 *
 * The output is also what `memory/fts5.ts` stores in its indexed column, so this function's result is
 * on disk as well as in a score. Read `TOKENISER_VERSION` before changing it.
 */
export function terms(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length >= MIN_TERM && !STOPWORDS.has(term))
        .map(stem)
}

export function counted(list: readonly string[]): Map<string, number> {
    const out = new Map<string, number>()
    for (const term of list) out.set(term, (out.get(term) ?? 0) + 1)
    return out
}

/**
 * Inverse document frequency, in the BM25 form that cannot go negative.
 *
 * The textbook `ln((N - df + 0.5) / (df + 0.5))` turns negative once a term is in more than half the
 * corpus, and with fifty skills a common word like "file" easily is — a negative idf would mean a
 * document is *penalised* for containing a query term, which reads as a broken scorer long before
 * anyone suspects the formula. The `1 +` form is the standard fix and stays positive throughout.
 *
 * This is also the exact form FTS5 uses, which is what lets an indexed scorer and an index-free one
 * produce the same number.
 */
export function idf(total: number, df: number): number {
    return Math.log(1 + (total - df + 0.5) / (df + 0.5))
}

/**
 * Whether a query term discriminates between documents: present in the corpus, and in at most half of it.
 *
 * Both halves are load-bearing, and the second was **measured**, not reasoned. Without it, "what's the
 * weather in dhaka tomorrow" scored **0.771** against `git-release` — higher than every one of the
 * seventeen true positives, whose range is 0.370–0.600. The reason is subtle and worth keeping: the
 * normalisation divides by `Σ idf(q)` over the same terms it sums, so **idf cancels out**. With a
 * one-term query, matching `the` scores exactly as well as matching `pdf`; idf survives only as relative
 * weighting *between* several query terms. Every word in that question was absent from the corpus except
 * `the`, so the query reduced to `{the}` and the shortest description containing it most often won.
 *
 * Excluding a term in more than half the corpus is BM25's own logic taken one step further — its idf
 * already says such a term carries almost no information, and this stops it from being the *only* thing
 * a score is built from. The `total >= 3` guard keeps a one- or two-document corpus working, where "more
 * than half" would otherwise exclude everything and nothing could ever activate.
 */
export function discriminating(df: number, total: number): boolean {
    if (df === 0) return false
    return total < 3 || df <= total / 2
}

/**
 * The normalisation denominator: `(k1 + 1) × Σ idf(q)` over the query's informative terms.
 *
 * Bounds a raw BM25 sum in `[0, 1)`, which is what makes a fixed `threshold` mean the same thing for
 * every agent and every corpus size — a raw sum grows with both query length and corpus size, so a
 * floor over it would be a different floor for everybody.
 *
 * A document containing every informative query term once, at average length, scores about `0.45`;
 * twice each takes it to about `0.63`. **The shipped `0.35` defaults are calibrated to this**, so
 * changing the formula invalidates them — a cost already paid twice while the stopword list and stemmer
 * were being settled, and worth re-reading `skills/select.ts`'s calibration note before paying again.
 *
 * Returns 0 for an empty query, and callers must treat that as "score nothing" rather than dividing.
 */
export function ceiling(
    query: readonly string[],
    df: ReadonlyMap<string, number>,
    total: number,
): number {
    return (K1 + 1) * query.reduce((sum, term) => sum + idf(total, df.get(term) ?? 0), 0)
}

/**
 * The query's informative terms: deduplicated, and dropped unless they discriminate.
 *
 * Shared so that "which terms count" cannot differ between an indexed and an unindexed scorer. A term
 * dropped here must also be absent from the MATCH expression, or FTS5 would score a term the ceiling
 * does not divide by — the score would exceed 1 and the threshold would stop bounding anything.
 */
export function informative(
    input: string,
    df: ReadonlyMap<string, number>,
    total: number,
): string[] {
    return [...new Set(terms(input))].filter((term) => discriminating(df.get(term) ?? 0, total))
}

export interface ScoreInput {
    /** Term → frequency within this document. */
    readonly counts: ReadonlyMap<string, number>
    /** This document's term count. */
    readonly length: number
    /** Mean term count across the corpus. Never 0 — the caller substitutes 1. */
    readonly averageLength: number
    /** The query's informative terms, from `informative()`. */
    readonly query: readonly string[]
    readonly df: ReadonlyMap<string, number>
    /** Corpus size, N. */
    readonly total: number
    /** From `ceiling()`. Passed in rather than recomputed per document. */
    readonly denominator: number
}

/**
 * One document's normalised BM25 against one query.
 *
 * The **only** implementation of the summation in this runtime, called by the index-free skill scorer
 * and by the FTS5-backed memory retriever alike. That is what makes "the retriever reuses the ranking
 * seam" a fact about the call graph rather than a claim in a docstring — and it is why `memory.threshold`
 * and `skills.threshold` are legitimately the same number, asserted in `memory-rank.test.ts` by scoring
 * one corpus through both paths.
 *
 * Returns 0 for an empty query rather than dividing by a zero denominator: no informative term means no
 * evidence, and a NaN would sort unpredictably instead of failing.
 */
export function score(input: ScoreInput): number {
    if (input.denominator === 0) return 0
    let raw = 0
    for (const term of input.query) {
        const frequency = input.counts.get(term) ?? 0
        if (frequency === 0) continue
        const normalisedLength = 1 - B + (B * input.length) / input.averageLength
        raw +=
            idf(input.total, input.df.get(term) ?? 0) *
            ((frequency * (K1 + 1)) / (frequency + K1 * normalisedLength))
    }
    return raw / input.denominator
}
