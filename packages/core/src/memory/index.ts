/**
 * Memory: what the agent knows about the person, across sessions.
 *
 * Two tiers, one writer, and the relationship between them is the whole design:
 *
 *     memory_write ──▶ MEMORY.md          slot 4, carried every turn, budgeted
 *                          │ over budget
 *                          ▼
 *                     memory/YYYY-MM.md   slot 10, retrieved only
 *                          │
 *                          ▼
 *                     FTS5 index          migration 6, per agent, no session link
 *                          ▲
 *                          │ at turn end, prose only, when includeHistory
 *                     messages            source `session:<key>`
 *
 * A fact said a minute ago is still *carried*, so the model does not need to retrieve it to know it —
 * which is the failure a retrieval-only design has, and it is a bad one for a small model that will not
 * think to search. When the carried file passes its budget the oldest notes move down a tier rather than
 * being deleted, so nothing is lost and the file never grows into the load failure that `eviction:
 * oldest` was declared to prevent and did not.
 *
 * The pieces:
 *
 * - `passages.ts` — markdown into retrievable units. Pure, no I/O.
 * - `conversation.ts` — a past conversation as a markdown document. Pure, and refuses tool output.
 * - `writer.ts` — append, then evict, then report. What `memory_write` calls.
 * - `fts5.ts` — the retriever, and the indexer that reconciles it with the files.
 * - `retriever.ts` — the seam, the recency boost, and the three limits.
 *
 * Ranking is **not** here: it is `rank/bm25.ts`, shared with `skills/select.ts`, which is why
 * `memory.threshold` and `skills.threshold` are legitimately the same number.
 */

export {
    type Exchange,
    exchanges,
    isSessionSource,
    MAX_INDEXED_MESSAGE_CHARS,
    renderConversation,
    SESSION_SOURCE_PREFIX,
    sessionSource,
} from "./conversation.ts"
export { correctTerms, editDistance, MAX_CORRECTIONS, MIN_CORRECT_LENGTH } from "./correct.ts"
export {
    enumerateFiles,
    enumerateSessions,
    type Fts5Options,
    fts5Retriever,
    type IndexableFile,
    type IndexableSession,
    type IndexableSource,
    type IndexReport,
    MAX_INDEXED_SESSION_MESSAGES,
    syncFiles,
    syncSessions,
} from "./fts5.ts"
export { document, impliedDate, type Passage, splitPassages } from "./passages.ts"
export {
    boosted,
    type MemoryRetriever,
    RECENCY_HALF_LIFE_DAYS,
    RECENCY_WEIGHT,
    type RetrievedPassage,
    type RetrieveInput,
    recencyBoost,
    retrieveWithContext,
    selectPassages,
} from "./retriever.ts"
export {
    type AppendNoteInput,
    appendNote,
    archiveNameFor,
    entriesIn,
    injectedTokens,
    memoryTargetMissing,
    type NoteResult,
    planEviction,
} from "./writer.ts"
