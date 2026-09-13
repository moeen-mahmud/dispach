/**
 * The FTS5-backed retriever, and the indexer that keeps it in step with the files.
 *
 * **FTS5 narrows; it does not rank.** The index answers "which passages contain any of these terms",
 * bounded, and everything after that is `rank/bm25.ts` — the same tokeniser, the same idf, the same
 * summation and the same normalisation the index-free skill selector uses. Two reasons, and the second
 * is the one that would have bitten:
 *
 * 1. `bm25()` computes its statistics over the **whole table**, and one sandbox root has one store
 *    shared by every agent in it. Average document length and N would be corpus-wide while retrieval is
 *    per-agent, so one agent's scores would shift when an unrelated agent saved a note — a ranking that
 *    changes for reasons outside the agent, with nothing reporting it.
 * 2. It makes FTS5's tokeniser irrelevant. `porter` stems differently from `stem()` and no built-in
 *    tokeniser applies a stopword list, so scoring through `bm25()` would have meant `memory.threshold`
 *    and `skills.threshold` were two different floors wearing one number.
 *
 * What is indexed is therefore the output of `terms()`, space-joined — which leaves FTS5's tokeniser
 * nothing to do but split on the spaces we put there. The cost is that the indexed column is *derived*:
 * `TOKENISER_VERSION` rides along in `memory_sources` so a changed tokeniser forces a rebuild instead of
 * silently degrading every query.
 *
 * ## Why the index is trusted about staleness but not about content
 *
 * `syncFiles` skips a source whose mtime **and** size **and** tokeniser version all match. Size is in
 * there because mtime alone is a poor witness: a file rewritten within the same millisecond, or restored
 * from a copy that preserved timestamps, reports unchanged. Both together are still not a proof — the
 * blind spot is an edit that preserves mtime and length, which `memory rebuild` exists for and which is
 * stated rather than papered over.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { estimateTokens } from "../context/tokens.ts"
import {
    ceiling,
    counted,
    discriminating,
    informative,
    score,
    TOKENISER_VERSION,
    terms,
} from "../rank/bm25.ts"
import type {
    MemoryPassageRecord,
    MemoryStore,
    MessageStore,
    SessionStore,
} from "../store/store.ts"
import { isSessionSource, renderConversation, sessionSource } from "./conversation.ts"
import { correctTerms } from "./correct.ts"
import { document, type Passage, splitPassages } from "./passages.ts"
import { boosted, type MemoryRetriever, type RetrievedPassage } from "./retriever.ts"

/**
 * How many candidates to pull per requested result.
 *
 * Over-fetching is required rather than merely prudent, for two independent reasons. The recency boost
 * reorders after scoring, so a passage that FTS5 ranked twelfth can finish third — fetch exactly `limit`
 * and that passage is invisible. And `exclude` drops whole sources *after* the query, so a corpus whose
 * carried file dominates the matches would return almost nothing.
 *
 * Eight, with a floor, because the work is a string split per candidate and 5,000-passage retrieval
 * measures in single-digit milliseconds either way.
 */
const CANDIDATE_FACTOR = 8
const MIN_CANDIDATES = 64

export interface Fts5Options {
    readonly store: MemoryStore
    readonly agentId: string
}

function toPassage(record: MemoryPassageRecord): Passage {
    return {
        id: record.id,
        source: record.source,
        ...(record.heading === undefined ? {} : { heading: record.heading }),
        text: record.text,
        at: record.at,
        tags: record.tags,
        stamped: record.stamped,
    }
}

/**
 * Rank the corpus against one query. Ranking only — the caller applies threshold, `maxActive` and budget.
 *
 * Returns `[]` on an empty corpus and on a query with no informative term, and those are different
 * situations with the same answer: nothing indexed yet, versus a question made entirely of words no
 * passage contains. Neither is an error, and `memory search` distinguishes them from the corpus size.
 */
export function fts5Retriever(options: Fts5Options): MemoryRetriever {
    const { store, agentId } = options

    return async (request) => {
        const stats = await store.stats(agentId)
        if (stats.passages === 0) return []

        const candidateTerms = [...new Set(terms(request.input))]
        if (candidateTerms.length === 0) return []

        let df = await store.frequencies(agentId, candidateTerms)
        // `informative` re-tokenises the input, which is deliberate duplication of a few microseconds:
        // it keeps "which terms count" in one place, and a term dropped here must also be absent from
        // the MATCH expression — a term FTS5 scored that the denominator did not divide by would push a
        // score above 1 and stop the threshold bounding anything.
        let query = informative(request.input, df, stats.passages)
        // Coverage keeps original terms, including ones the corpus does not hold — that is 5.45.
        // Correction replaces that denominator only on the empty-MATCH path, where there is otherwise
        // nothing to cover.
        let coverageTerms = candidateTerms
        if (query.length === 0) {
            const corrected = correctTerms(candidateTerms, await store.vocabulary(agentId))
            if (corrected.length === 0) return []
            df = await store.frequencies(agentId, corrected)
            // Already stemmed — do not run `terms()` again or `staging` becomes `stag`.
            query = [
                ...corrected.filter((term) => discriminating(df.get(term) ?? 0, stats.passages)),
            ]
            if (query.length === 0) return []
            coverageTerms = [...corrected]
        }

        const want = Math.max(MIN_CANDIDATES, request.limit * CANDIDATE_FACTOR)
        const candidates = await store.candidates(agentId, query, want)

        const excluded = new Set(request.exclude ?? [])
        const denominator = ceiling(query, df, stats.passages)
        // A corpus of empty documents cannot happen — `splitPassages` emits no empty passage — but a
        // zero average would produce NaN, and NaN sorts unpredictably instead of failing.
        const averageLength = stats.totalLength === 0 ? 1 : stats.totalLength / stats.passages

        const ranked: RetrievedPassage[] = []
        for (const record of candidates) {
            if (excluded.has(record.source)) continue
            const recordTerms = record.terms === "" ? [] : record.terms.split(" ")
            const lexical = score({
                counts: counted(recordTerms),
                length: record.length,
                averageLength,
                query,
                df,
                total: stats.passages,
                denominator,
            })
            const present = new Set(recordTerms)
            const coverage =
                coverageTerms.filter((term) => present.has(term)).length / coverageTerms.length
            ranked.push({
                passage: toPassage(record),
                lexical,
                coverage,
                score: boosted(lexical, record.at, request.now, coverage),
                tokens: record.tokens,
            })
        }

        ranked.sort(byScoreThenId)
        return ranked.slice(0, request.limit)
    }
}

/**
 * Descending score, then id.
 *
 * The tiebreak is not cosmetic: two passages scoring identically must be injected in the same order on
 * every machine, or one agent behaves differently from another with the same files. Same reasoning as
 * `byScoreThenName` in the skill selector, and the id is the stable key here because two passages can
 * share a source and a timestamp.
 */
function byScoreThenId(a: RetrievedPassage, b: RetrievedPassage): number {
    if (b.score !== a.score) return b.score - a.score
    return a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0
}

/** One file the indexer has been asked to consider. The caller decides which files those are. */
export interface IndexableFile {
    /** Stable identity for the source: a path relative to the memory root, or the carried file's name. */
    readonly source: string
    /**
     * Read on demand, and **only** when the file turns out to have changed.
     *
     * A `string` here would be simpler and would put the whole corpus in the boot path: the acceptance
     * criterion is that boot stays inside its budget *with* a 5,000-passage index, and it only does
     * because an unchanged file costs one `stat` and no read. Making the read lazy is what keeps the
     * skip cheap — otherwise the caller has already paid for every file before the indexer decides it
     * needed none of them.
     */
    readonly read: () => string
    readonly mtimeMs: number
    readonly size: number
}

export interface IndexReport {
    /** Sources re-read because they changed, were new, or were tokenised under older rules. */
    readonly indexed: readonly string[]
    /** Sources whose mtime, size and tokeniser version all matched. */
    readonly skipped: readonly string[]
    /** Sources dropped because the file is gone. */
    readonly dropped: readonly string[]
    /** Passages in the corpus after the sync. */
    readonly passages: number
}

/**
 * Bring the index in line with a set of files.
 *
 * Wholesale per source, incremental across sources: an unchanged file is not even read by the caller,
 * and a changed one is re-split entirely. Per-source rather than per-passage because a markdown file has
 * no stable per-line identity, and content-derived ids make the re-insert idempotent — an unchanged
 * passage in a changed file keeps its row rather than churning.
 *
 * **This reconciles rather than adds, and the distinction bites.** A source present in the index but
 * absent from `files` is **dropped** — so calling this with one file forgets every other source, which
 * is correct for "here is the corpus" and catastrophic for "here is one more file". Written down because
 * the first test against this function made exactly that mistake, indexing five files one call at a time
 * and finding four of them gone. Callers pass the whole set, every time.
 *
 * Dropping is what makes a deleted archive file disappear from retrieval. The alternative — leaving it — would retrieve text that no
 * longer exists anywhere on disk, and a person who deleted a memory file would reasonably expect the
 * memory to be gone.
 */
export async function syncFiles(input: {
    readonly store: MemoryStore
    readonly agentId: string
    readonly files: readonly IndexableFile[]
    readonly now: Date
}): Promise<IndexReport> {
    return await reconcile({ ...input, sources: input.files, owns: (s) => !isSessionSource(s) })
}

/** One conversation the indexer has been asked to consider, in the shape `reconcile` reads. */
export interface IndexableSession extends IndexableSource {
    readonly sessionKey: string
}

/**
 * Bring the index in line with the conversations in the store.
 *
 * The twin of `syncFiles`, and separate from it for one reason that is worth the duplication: each
 * reconciles **only its own namespace**. `syncFiles` drops any source it was not handed, which is the
 * property that makes a deleted archive file disappear from retrieval — and it would delete every
 * indexed conversation on the next turn if the two shared a domain. Recall syncs files per turn and
 * conversations only at turn end, so the two lists genuinely arrive at different moments.
 *
 * An optional `sessions` argument on `syncFiles` was the alternative and was rejected: absent would have
 * to mean "leave conversations alone" while `[]` meant "drop them all", and this repo has already lost a
 * debugging round to a default parameter firing on an explicitly passed `undefined`.
 */
export async function syncSessions(input: {
    readonly store: MemoryStore
    readonly agentId: string
    readonly sessions: readonly IndexableSession[]
    readonly now: Date
}): Promise<IndexReport> {
    return await reconcile({ ...input, sources: input.sessions, owns: isSessionSource })
}

/**
 * Anything the indexer can treat as a document: an identity, a staleness pair, and a lazy read.
 *
 * `read` may be async because a conversation is read from the store rather than from disk. It stays
 * lazy for both, which is what keeps an unchanged source at the cost of one `stat` — or one already
 * fetched summary — and no read at all.
 */
export interface IndexableSource {
    readonly source: string
    readonly read: () => string | Promise<string>
    readonly mtimeMs: number
    readonly size: number
}

async function reconcile(input: {
    readonly store: MemoryStore
    readonly agentId: string
    readonly sources: readonly IndexableSource[]
    readonly now: Date
    /** Which existing sources this pass is responsible for, and may therefore drop. */
    readonly owns: (source: string) => boolean
}): Promise<IndexReport> {
    const { store, agentId, sources: files, now, owns } = input
    const stamp = now.toISOString()
    const known = new Map(
        (await store.sources(agentId))
            .filter((state) => owns(state.source))
            .map((state) => [state.source, state]),
    )

    const indexed: string[] = []
    const skipped: string[] = []

    for (const file of files) {
        const state = known.get(file.source)
        known.delete(file.source)
        if (
            state !== undefined &&
            state.mtimeMs === file.mtimeMs &&
            state.size === file.size &&
            state.tokeniser === TOKENISER_VERSION
        ) {
            skipped.push(file.source)
            continue
        }

        const passages = splitPassages({
            text: await file.read(),
            source: file.source,
            // The file's own mtime is the honest fallback for a passage nobody stamped: it is the last
            // moment the fact could have been written down.
            fallbackAt: new Date(file.mtimeMs).toISOString(),
        })
        await store.replaceSource(
            agentId,
            file.source,
            passages.map(toRecord),
            { mtimeMs: file.mtimeMs, size: file.size, tokeniser: TOKENISER_VERSION },
            stamp,
        )
        indexed.push(file.source)
    }

    const dropped: string[] = []
    for (const source of known.keys()) {
        await store.dropSource(agentId, source)
        dropped.push(source)
    }

    const stats = await store.stats(agentId)
    return { indexed, skipped, dropped, passages: stats.passages }
}

/**
 * A passage as the store wants it: with its terms and their count precomputed.
 *
 * `document()` rather than `text` is tokenised, so a bullet is retrievable on its heading — "prefers
 * tabs" matches nothing useful, "Formatting / prefers tabs" matches `formatting`. `tokens` is estimated
 * from `text` alone, because `text` is what slot 7 pays for.
 */
function toRecord(passage: Passage): MemoryPassageRecord {
    const list = terms(document(passage))
    return {
        ...passage,
        terms: list.join(" "),
        length: list.length,
        tokens: estimateTokens(passage.text),
    }
}

/**
 * Every markdown file under `dir`, plus whatever else the caller names, ready to reconcile.
 *
 * Synchronous and `stat`-only: this runs inside boot, where hard rule 4 puts the network out of reach
 * and the budget puts a corpus read out of reach too. Nothing is opened here — `read` is a closure the
 * indexer calls only for a file whose mtime or size moved.
 *
 * A missing directory is the normal first-run state and yields nothing rather than throwing. Only `.md`
 * files, so a `.gitignore` or an editor's swap file never becomes a source; and non-recursive, because a
 * subdirectory under `memory/` is a person organising something, not more memory to index — guessing
 * otherwise is how a checked-out repository inside a memory folder becomes five thousand passages.
 */
export function enumerateFiles(input: {
    readonly dir: string
    /** Extra files with an explicit source name — the carried workspace file. */
    readonly extra?: readonly { readonly source: string; readonly path: string }[]
}): readonly IndexableFile[] {
    const out: IndexableFile[] = []

    let names: string[] = []
    try {
        names = readdirSync(input.dir)
            .filter((name) => name.endsWith(".md"))
            // A file called `session:notes.md` would be reconciled by whichever pass ran last and
            // dropped by the other, alternating forever. Refused here rather than disambiguated,
            // because the prefix is the discriminator both passes agree on.
            .filter((name) => !isSessionSource(name))
            .sort()
    } catch {
        // No archive directory yet. Eviction creates it on first use, never speculatively.
    }
    for (const name of names) {
        const path = join(input.dir, name)
        const stats = statOf(path)
        if (stats === undefined) continue
        out.push({ source: name, read: () => readFileSync(path, "utf8"), ...stats })
    }

    for (const entry of input.extra ?? []) {
        const stats = statOf(entry.path)
        if (stats === undefined) continue
        out.push({
            source: entry.source,
            read: () => readFileSync(entry.path, "utf8"),
            ...stats,
        })
    }

    return out
}

function statOf(path: string): { mtimeMs: number; size: number } | undefined {
    try {
        const stats = statSync(path)
        if (!stats.isFile()) return undefined
        return { mtimeMs: Math.floor(stats.mtimeMs), size: stats.size }
    } catch {
        return undefined
    }
}

/**
 * How many of a conversation's newest messages are indexed.
 *
 * A cap rather than the whole thing, because the read is per stale session and a conversation has no
 * natural end. Starting mid-turn is safe: `exchanges` drops an assistant message it has no question
 * for, so a cut at the boundary loses one reply rather than mispairing every one after it.
 */
export const MAX_INDEXED_SESSION_MESSAGES = 400

/**
 * Every conversation in the store, as sources the indexer can reconcile.
 *
 * `lastActivityAt` and the message count stand in for a file's mtime and size, and they are already in
 * the summary — so listing every session costs one query and re-reads only the ones that moved. That is
 * what makes it correct to pass *all* sessions on every call: the whole-set invariant `reconcile`
 * depends on is satisfied, and the steady-state cost is the one session that just changed.
 */
export async function enumerateSessions(input: {
    readonly sessions: SessionStore
    readonly messages: MessageStore
    readonly agentId: string
}): Promise<readonly IndexableSession[]> {
    const summaries = await input.sessions.list(input.agentId)
    return summaries.map((summary) => ({
        sessionKey: summary.sessionKey,
        source: sessionSource(summary.sessionKey),
        mtimeMs: Number.isFinite(Date.parse(summary.lastActivityAt))
            ? Date.parse(summary.lastActivityAt)
            : 0,
        size: summary.messages,
        read: async () => {
            const page = await input.messages.page(input.agentId, summary.sessionKey, {
                limit: MAX_INDEXED_SESSION_MESSAGES,
            })
            // `page` is newest-first for a UI; exchanges have to be paired in the order they happened.
            return renderConversation([...page.messages].reverse(), summary.lastActivityAt)
        },
    }))
}
