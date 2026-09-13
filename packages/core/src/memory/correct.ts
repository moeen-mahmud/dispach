/**
 * Miss-only query-term correction against the indexed vocabulary.
 *
 * FTS5 will not surface a passage whose terms do not overlap the query at all. Typos (`stagng`) and
 * a few stem misses (`analytical` → `analyticl` while the index holds `analytic`) fail before BM25
 * or coverage ever run. Correcting those terms against the corpus vocabulary recovers them without
 * a second index, a synonym list, or embeddings.
 *
 * **Only the empty-candidate path may call this.** A query that already retrieved something has had
 * coverage and the threshold decide; rewriting its terms would turn the 1998 false-positive back on
 * by giving a rare accidental match extra neighbours.
 */

/** Shorter than this, a unique neighbour is too cheap to trust. */
export const MIN_CORRECT_LENGTH = 4

/** Two rewritten terms is enough for a misspelled noun phrase; more is a different query. */
export const MAX_CORRECTIONS = 2

/**
 * Replace absent query terms with their unique nearest neighbour in `vocabulary`.
 *
 * Terms already in the vocabulary are kept. Terms shorter than `MIN_CORRECT_LENGTH` and absent
 * from the vocabulary are ignored — they are not evidence. A long term that is ambiguous, farther
 * than the length-dependent cap, or beyond `MAX_CORRECTIONS` **aborts the rewrite**: a partial
 * MATCH of `cluser` → `cluster` would retrieve the staging note for "parking cluser". Empty means
 * "do not query", never "query what you could guess".
 *
 * The result is the MATCH query, not a rewrite of the user's sentence.
 */
export function correctTerms(
    queryTerms: readonly string[],
    vocabulary: ReadonlySet<string>,
): readonly string[] {
    const out: string[] = []
    let rewritten = 0
    for (const term of queryTerms) {
        if (vocabulary.has(term)) {
            out.push(term)
            continue
        }
        if (term.length < MIN_CORRECT_LENGTH) continue
        if (rewritten >= MAX_CORRECTIONS) return []
        const nearest = uniqueNearest(term, vocabulary)
        if (nearest === undefined) return []
        out.push(nearest)
        rewritten += 1
    }
    return [...new Set(out)]
}

function maxDistance(term: string): number {
    return term.length >= 6 ? 2 : 1
}

function uniqueNearest(term: string, vocabulary: ReadonlySet<string>): string | undefined {
    const max = maxDistance(term)
    const first = term[0]
    let best: string | undefined
    let bestDistance = max + 1
    let ties = 0
    for (const candidate of vocabulary) {
        if (candidate[0] !== first) continue
        if (Math.abs(candidate.length - term.length) > max) continue
        const distance = editDistance(term, candidate, max)
        if (distance > max) continue
        if (distance < bestDistance) {
            best = candidate
            bestDistance = distance
            ties = 1
        } else if (distance === bestDistance) {
            ties += 1
        }
    }
    return ties === 1 ? best : undefined
}

/**
 * Levenshtein distance, aborting at `max + 1`.
 *
 * Banded rather than Damerau: a transposition costs 2, which is inside the cap for terms of length
 * 6 or more (`frankfrut` → `frankfurt`) and refused for short ones, where a swap is too cheap.
 */
export function editDistance(a: string, b: string, max: number): number {
    if (a === b) return 0
    if (Math.abs(a.length - b.length) > max) return max + 1

    const rows = a.length
    const cols = b.length
    let previous = Array.from({ length: cols + 1 }, (_, index) => index)
    for (let i = 1; i <= rows; i += 1) {
        const current = [i]
        let rowMin = i
        for (let j = 1; j <= cols; j += 1) {
            const substitution = a[i - 1] === b[j - 1] ? 0 : 1
            const value = Math.min(
                (previous[j] ?? max) + 1,
                (current[j - 1] ?? max) + 1,
                (previous[j - 1] ?? max) + substitution,
            )
            current[j] = value
            if (value < rowMin) rowMin = value
        }
        if (rowMin > max) return max + 1
        previous = current
    }
    return previous[cols] ?? max + 1
}
