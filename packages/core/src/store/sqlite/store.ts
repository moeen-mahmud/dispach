/**
 * The SQLite `Store`.
 *
 * Statements are prepared once in the constructor and reused. That is not micro-optimisation:
 * boot has a 1000 ms budget and a turn should not be paying SQL parse cost per message, but more
 * importantly a prepare-at-construction failure surfaces at boot with the offending SQL rather
 * than mid-turn.
 *
 * Every row-mapping function builds a fresh plain object. That is load-bearing beyond taste —
 * `node:sqlite` hands back null-prototype rows and `bun:sqlite` hands back `Object.prototype`
 * ones, so mapping is also where the two runtimes stop being distinguishable.
 */

import { sessionSource } from "../../memory/conversation.ts"
import type { ChatMessage, ToolCallRequest } from "../../model/provider.ts"
import { parseSessionKey } from "../session-key.ts"
import type {
    AgentFootprint,
    ArtifactRecord,
    ArtifactStore,
    DeliveryRecord,
    DeliveryStatus,
    KVStore,
    LeaseClaim,
    LeaseRecord,
    LeaseStore,
    MemoryPassageRecord,
    MemorySourceState,
    MemoryStore,
    MessagePage,
    MessageStore,
    OutboxStore,
    RuntimeMode,
    SessionRecord,
    SessionStore,
    SessionSummary,
    Store,
    StoredMessage,
    TurnRecord,
    TurnStatus,
    TurnStore,
} from "../store.ts"
import type { OpenOptions, SqlDatabase, SqlStatement } from "./driver.ts"
import { openDatabase } from "./driver.ts"
import { type MigrationReport, migrate } from "./migrations.ts"

const DEFAULT_PAGE = 50

interface SessionRow {
    agent_id: string
    session_key: string
    channel: string
    peer_id: string
    thread: string | null
    phase: string | null
    created_at: string
    updated_at: string
}

interface SummaryRow extends SessionRow {
    messages: number
    turns: number
    last_activity_at: string
}

interface MessageRow {
    id: number
    session_key: string
    turn_id: string | null
    role: string
    content: string
    /** JSON array of `ToolCallRequest`, or null. Native only — under NLT the call is the content. */
    tool_calls: string | null
    tool_call_id: string | null
    /** Who wrote it, when the harness did. Null for anything written before migration 005. */
    origin: string | null
    tainted: number
    created_at: string
}

/**
 * The message columns every read needs, as one fragment.
 *
 * One list rather than five, because the five queries below drifting apart is how `tool_calls` came
 * to be dropped on the way back out in the first place: the column existed on the row type and two
 * of the SELECTs simply did not ask for it, so a native session's history came back orphaned with
 * nothing failing.
 */
const MESSAGE_COLUMNS =
    "id, session_key, turn_id, role, content, tool_calls, tool_call_id, origin, tainted, created_at"

/**
 * The origin union without `undefined`.
 *
 * `ChatMessage["origin"]` includes it, and under `exactOptionalPropertyTypes` spreading a possibly-
 * undefined value into an optional property is an error rather than a no-op — which is the compiler
 * doing its job: the whole point of the conditional spread is that the key is absent, not present
 * and undefined.
 */
type MessageOrigin = NonNullable<ChatMessage["origin"]>

/** Parsed defensively: a row written by a future version must not crash a history read. */
function toolCallsFrom(raw: string | null): readonly ToolCallRequest[] | undefined {
    if (raw === null || raw === "") return undefined
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) && parsed.length > 0
            ? (parsed as ToolCallRequest[])
            : undefined
    } catch {
        return undefined
    }
}

interface MemoryPassageRow {
    id: string
    source: string
    heading: string | null
    text: string
    terms: string
    length: number
    at: string
    stamped: number
    tags: string
    tokens: number
}

interface MemorySourceRow {
    source: string
    mtime_ms: number
    size: number
    tokeniser: number
    passages: number
    indexed_at: string
}

interface ArtifactRow {
    id: string
    session_key: string
    slug: string | null
    content: string
    tokens: number
    created_at: string
}

interface TurnRow {
    turn_id: string
    agent_id: string
    session_key: string
    status: string
    source: string
    input: string
    text: string
    reasoning: string
    steps: number
    prompt_tokens: number
    output_tokens: number
    error_code: string | null
    error_message: string | null
    error_hint: string | null
    started_at: string
    ended_at: string | null
    duration_ms: number | null
}

interface DeliveryRow {
    id: number
    agent_id: string
    dedupe_key: string
    group_key: string
    session_key: string
    turn_id: string | null
    channel_id: string
    recipient: string
    thread: string | null
    chunk_index: number
    chunk_total: number
    body: string
    status: string
    attempts: number
    next_attempt_at: string
    /** SQLite has no boolean. 0 or 1. */
    uncertain: number
    provider_message_id: string | null
    error_code: string | null
    error_message: string | null
    created_at: string
    updated_at: string
}

function nowIso(): string {
    return new Date().toISOString()
}

// Nullable columns are spread in conditionally rather than assigned `undefined`, because
// `exactOptionalPropertyTypes` distinguishes an absent optional property from one present with
// the value `undefined` — and the wire surface serializes those two differently.
function toSession(row: SessionRow): SessionRecord {
    return {
        agentId: row.agent_id,
        sessionKey: row.session_key,
        channel: row.channel,
        peerId: row.peer_id,
        ...(row.thread === null ? {} : { thread: row.thread }),
        ...(row.phase === null ? {} : { phase: row.phase }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

function toSummary(row: SummaryRow): SessionSummary {
    return {
        ...toSession(row),
        messages: row.messages,
        turns: row.turns,
        lastActivityAt: row.last_activity_at,
    }
}

function toMessage(row: MessageRow): StoredMessage {
    const calls = toolCallsFrom(row.tool_calls)
    return {
        id: row.id,
        sessionKey: row.session_key,
        ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(calls === undefined ? {} : { toolCalls: calls }),
        ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
        ...(row.origin === null ? {} : { origin: row.origin as MessageOrigin }),
        ...(row.tainted === 0 ? {} : { tainted: true }),
        createdAt: row.created_at,
    }
}

/**
 * A row as the model layer wants it: exactly a `ChatMessage`, with no store bookkeeping.
 *
 * Separate from `toMessage` because the two have different jobs — that one is the API surface for
 * reading a session, this one feeds a prompt — but both must carry the tool fields, and having them
 * in one file makes it hard for only one to be updated.
 */
function toChatMessage(row: MessageRow): ChatMessage {
    const calls = toolCallsFrom(row.tool_calls)
    return {
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(calls === undefined ? {} : { toolCalls: calls }),
        ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
        // Compaction reads this to tell a tool observation from a human message, so a history that
        // came back without it would be silently uncompactable in two of five stages.
        ...(row.origin === null ? {} : { origin: row.origin as MessageOrigin }),
        ...(row.tainted === 0 ? {} : { tainted: true }),
    }
}

function toMemoryPassage(row: MemoryPassageRow): MemoryPassageRecord {
    return {
        id: row.id,
        source: row.source,
        ...(row.heading === null ? {} : { heading: row.heading }),
        text: row.text,
        terms: row.terms,
        length: row.length,
        at: row.at,
        stamped: row.stamped === 1,
        // An empty `tags` column must produce no tags, not one empty tag — `"".split(",")` is `[""]`,
        // which would render as `_()_` and score as a term.
        tags: row.tags === "" ? [] : row.tags.split(","),
        tokens: row.tokens,
    }
}

function toMemorySource(row: MemorySourceRow): MemorySourceState {
    return {
        source: row.source,
        mtimeMs: row.mtime_ms,
        size: row.size,
        tokeniser: row.tokeniser,
        passages: row.passages,
        indexedAt: row.indexed_at,
    }
}

/**
 * Terms → one FTS5 MATCH expression, OR-joined.
 *
 * **Every term is double-quoted, and that is not decoration.** FTS5's query language reserves `AND`,
 * `OR`, `NOT` and `NEAR`; the first three are in `STOPWORDS` and never reach here, but `near` is an
 * ordinary English word that `terms()` passes through, and unquoted it is a syntax error rather than a
 * search. Quoting makes every term a string literal, so the expression cannot be anything but a query.
 *
 * OR rather than the default AND: BM25 scores partial matches, and requiring every term would turn a
 * five-word question into a demand that one passage contain all five.
 */
/**
 * The FTS5 table drives both memory queries, and the unary `+` is what makes it.
 *
 * `memory_passages_source` is an index on `(agent_id, source)`, so given
 * `WHERE memory_fts MATCH ? AND +p.agent_id = ?` a planner can read the agent filter as the cheaper
 * entry point and probe the virtual table once per row it finds. Measured over one 5,000-passage
 * corpus, same code, `:memory:`:
 *
 *     sqlite 3.51.0 (bun 1.3.5)   SCAN f VIRTUAL TABLE INDEX 0:M1                  0.7 ms
 *     sqlite 3.51.3 (node 22)     SEARCH p USING COVERING INDEX … (agent_id=?)   260.5 ms
 *                                 SCAN f VIRTUAL TABLE INDEX 0:=M1
 *     sqlite 3.53.3 (node 24)     SCAN f VIRTUAL TABLE INDEX 0:M1                  0.7 ms
 *
 * The `=` in `0:=M1` is the whole story: it is SQLite saying the virtual table will be probed once
 * per row of the *other* table rather than scanned once, so the cost is linear in corpus size and
 * grows as an agent remembers more — the one direction a retrieval path must not scale in. That the
 * three versions disagree, and that the slow one sits **between** the two fast ones, is the reason
 * this is pinned rather than left to the planner: it is not a version to wait out.
 *
 * `+p.agent_id` suppresses index use on that term only, which pins `SCAN f` on all three at
 * 0.5–0.8 ms. Results are identical either way — SQLite applies the whole `WHERE` before `LIMIT`, so
 * the agent filter still bounds what reaches it.
 *
 * Exported because `store.test.ts` runs `EXPLAIN QUERY PLAN` over these exact strings. A test holding
 * its own copy of the SQL would go on passing after somebody edited the statement it was guarding.
 */
export const MEMORY_DF_SQL = `SELECT count(*) AS df FROM memory_fts f
   JOIN memory_passages p ON p.rowid = f.rowid
  WHERE memory_fts MATCH ? AND +p.agent_id = ?`

export const MEMORY_CANDIDATES_SQL = `SELECT p.id, p.source, p.heading, p.text, p.terms, p.length,
        p.at, p.stamped, p.tags, p.tokens
   FROM memory_fts f
   JOIN memory_passages p ON p.rowid = f.rowid
  WHERE memory_fts MATCH ? AND +p.agent_id = ?
  ORDER BY bm25(memory_fts)
  LIMIT ?`

/** Distinct from the FTS path: we want the `agent_id` index, so this one is not pinned with `+`. */
export const MEMORY_VOCABULARY_SQL = `SELECT terms FROM memory_passages WHERE agent_id = ?`

function matchExpression(terms: readonly string[]): string {
    return terms.map((term) => `"${term}"`).join(" OR ")
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
    return {
        id: row.id,
        sessionKey: row.session_key,
        ...(row.slug === null ? {} : { slug: row.slug }),
        content: row.content,
        tokens: row.tokens,
        createdAt: row.created_at,
    }
}

function toTurn(row: TurnRow): TurnRecord {
    return {
        turnId: row.turn_id,
        agentId: row.agent_id,
        sessionKey: row.session_key,
        status: row.status as TurnStatus,
        source: row.source,
        input: row.input,
        text: row.text,
        reasoning: row.reasoning,
        steps: row.steps,
        promptTokens: row.prompt_tokens,
        outputTokens: row.output_tokens,
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
        ...(row.error_hint === null ? {} : { errorHint: row.error_hint }),
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    }
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
    return {
        id: row.id,
        agentId: row.agent_id,
        dedupeKey: row.dedupe_key,
        groupKey: row.group_key,
        sessionKey: row.session_key,
        ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
        channelId: row.channel_id,
        recipient: row.recipient,
        ...(row.thread === null ? {} : { thread: row.thread }),
        chunkIndex: row.chunk_index,
        chunkTotal: row.chunk_total,
        body: row.body,
        status: row.status as DeliveryStatus,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        uncertain: row.uncertain !== 0,
        ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

interface LeaseRow {
    agent_id: string
    runtime_id: string
    pid: number
    mode: string
    started_at: string
    heartbeat_at: string
}

function toLease(row: LeaseRow): LeaseRecord {
    return {
        agentId: row.agent_id,
        runtimeId: row.runtime_id,
        pid: row.pid,
        mode: row.mode as RuntimeMode,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
    }
}

export interface SqliteStoreOptions extends OpenOptions {}

export class SqliteStore implements Store {
    readonly sessions: SessionStore
    readonly messages: MessageStore
    readonly turns: TurnStore
    readonly outbox: OutboxStore
    readonly leases: LeaseStore
    readonly kv: KVStore
    readonly artifacts: ArtifactStore
    readonly memory: MemoryStore
    readonly location: string
    /** What `migrate` did at open. Reported by boot rather than logged and forgotten. */
    readonly migrations: MigrationReport
    // Assigned in the constructor rather than declared as methods, because they close over `q` — the
    // prepared statements are constructor-local, the same as every store above.
    readonly agentFootprint: (agentId: string) => Promise<AgentFootprint>
    readonly purgeAgent: (agentId: string) => Promise<AgentFootprint>
    readonly agentIds: () => Promise<readonly string[]>

    #db: SqlDatabase
    #closed = false

    private constructor(db: SqlDatabase, migrations: MigrationReport) {
        this.#db = db
        this.location = db.location
        this.migrations = migrations

        const q = {
            sessionGet: db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND session_key = ?"),
            sessionInsert: db.prepare(
                `INSERT INTO sessions (agent_id, session_key, channel, peer_id, thread, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (agent_id, session_key) DO NOTHING`,
            ),
            sessionTouch: db.prepare(
                "UPDATE sessions SET updated_at = ? WHERE agent_id = ? AND session_key = ?",
            ),
            sessionList: db.prepare(
                `SELECT s.*,
                        (SELECT COUNT(*) FROM messages m
                          WHERE m.agent_id = s.agent_id AND m.session_key = s.session_key) AS messages,
                        (SELECT COUNT(*) FROM turns t
                          WHERE t.agent_id = s.agent_id AND t.session_key = s.session_key) AS turns,
                        MAX(
                            s.updated_at,
                            COALESCE((SELECT MAX(created_at) FROM messages m
                                       WHERE m.agent_id = s.agent_id AND m.session_key = s.session_key), '')
                        ) AS last_activity_at
                   FROM sessions s
                  WHERE s.agent_id = ?
                  ORDER BY last_activity_at DESC`,
            ),
            sessionSetPhase: db.prepare(
                "UPDATE sessions SET phase = ?, updated_at = ? WHERE agent_id = ? AND session_key = ?",
            ),
            sessionDelete: db.prepare(
                "DELETE FROM sessions WHERE agent_id = ? AND session_key = ?",
            ),
            messagesDelete: db.prepare(
                "DELETE FROM messages WHERE agent_id = ? AND session_key = ?",
            ),
            turnsDelete: db.prepare("DELETE FROM turns WHERE agent_id = ? AND session_key = ?"),

            messageInsert: db.prepare(
                `INSERT INTO messages
                     (agent_id, session_key, turn_id, role, content, tool_calls, tool_call_id,
                      origin, tainted, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ),
            messageById: db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`),
            artifactPut: db.prepare(
                // `OR IGNORE`, and it is correct rather than lazy: the id is derived from the
                // content, so a colliding insert is the identical observation arriving again.
                `INSERT OR IGNORE INTO artifacts
                     (id, agent_id, session_key, slug, content, tokens, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ),
            artifactGet: db.prepare(
                `SELECT id, session_key, slug, content, tokens, created_at FROM artifacts
                  WHERE agent_id = ? AND session_key = ? AND id = ?`,
            ),
            artifactList: db.prepare(
                `SELECT id, session_key, slug, content, tokens, created_at FROM artifacts
                  WHERE agent_id = ? AND session_key = ? ORDER BY created_at DESC, id DESC`,
            ),
            memoryPut: db.prepare(
                // The update path exists for a passage that has *moved*: eviction carries a note out
                // of the carried file into an archive, and because the id is derived from the text the
                // row is the same row with a new `source`. Without DO UPDATE the insert would be
                // ignored and the passage would still claim to live in a file it has left.
                `INSERT INTO memory_passages
                     (agent_id, id, source, heading, text, terms, length, at, stamped, tags, tokens,
                      indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (agent_id, id) DO UPDATE SET
                     source = excluded.source,
                     heading = excluded.heading,
                     text = excluded.text,
                     terms = excluded.terms,
                     length = excluded.length,
                     at = excluded.at,
                     stamped = excluded.stamped,
                     tags = excluded.tags,
                     tokens = excluded.tokens,
                     indexed_at = excluded.indexed_at`,
            ),
            memoryDeleteSource: db.prepare(
                "DELETE FROM memory_passages WHERE agent_id = ? AND source = ?",
            ),
            memoryDeleteAll: db.prepare("DELETE FROM memory_passages WHERE agent_id = ?"),
            memorySourcePut: db.prepare(
                `INSERT INTO memory_sources
                     (agent_id, source, mtime_ms, size, tokeniser, passages, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (agent_id, source) DO UPDATE SET
                     mtime_ms = excluded.mtime_ms,
                     size = excluded.size,
                     tokeniser = excluded.tokeniser,
                     passages = excluded.passages,
                     indexed_at = excluded.indexed_at`,
            ),
            memorySourceDelete: db.prepare(
                "DELETE FROM memory_sources WHERE agent_id = ? AND source = ?",
            ),
            memorySourceDeleteAll: db.prepare("DELETE FROM memory_sources WHERE agent_id = ?"),
            memorySources: db.prepare(
                `SELECT source, mtime_ms, size, tokeniser, passages, indexed_at
                   FROM memory_sources WHERE agent_id = ? ORDER BY source ASC`,
            ),
            memoryStats: db.prepare(
                `SELECT count(*) AS passages, coalesce(sum(length), 0) AS total_length
                   FROM memory_passages WHERE agent_id = ?`,
            ),
            // One term per call. The whole MATCH expression is a single bound parameter, so this stays
            // a cached statement rather than being rebuilt per query.
            memoryDf: db.prepare(MEMORY_DF_SQL),
            memoryCandidates: db.prepare(MEMORY_CANDIDATES_SQL),
            memoryVocabulary: db.prepare(MEMORY_VOCABULARY_SQL),
            historyAll: db.prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM messages
                  WHERE agent_id = ? AND session_key = ? ORDER BY id ASC`,
            ),
            historyTail: db.prepare(
                `SELECT * FROM (
                     SELECT ${MESSAGE_COLUMNS} FROM messages
                      WHERE agent_id = ? AND session_key = ?
                      ORDER BY id DESC LIMIT ?
                 ) ORDER BY id ASC`,
            ),
            pageFirst: db.prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM messages
                  WHERE agent_id = ? AND session_key = ?
                  ORDER BY id DESC LIMIT ?`,
            ),
            pageBefore: db.prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM messages
                  WHERE agent_id = ? AND session_key = ? AND id < ?
                  ORDER BY id DESC LIMIT ?`,
            ),
            messageCount: db.prepare(
                "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND session_key = ?",
            ),
            messageOldest: db.prepare(
                "SELECT MIN(id) AS m FROM messages WHERE agent_id = ? AND session_key = ?",
            ),

            turnInsert: db.prepare(
                `INSERT INTO turns (turn_id, agent_id, session_key, status, source, input, started_at)
                 VALUES (?, ?, ?, 'running', ?, ?, ?)`,
            ),
            turnFinish: db.prepare(
                `UPDATE turns
                    SET status = ?, text = ?, reasoning = ?, steps = ?,
                        prompt_tokens = ?, output_tokens = ?, duration_ms = ?,
                        error_code = ?, error_message = ?, error_hint = ?, ended_at = ?
                  WHERE turn_id = ?`,
            ),
            turnGet: db.prepare("SELECT * FROM turns WHERE turn_id = ?"),
            turnList: db.prepare(
                `SELECT * FROM turns WHERE agent_id = ? AND session_key = ?
                  ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            ),
            // Both take one agent id and are run once per owned agent inside a transaction, rather
            // than building an `IN (?,?,…)` list. A dynamic arity needs a fresh `prepare` per call
            // shape, which defeats the statement cache for the overwhelmingly common case of one
            // agent per runtime. The partial index means each pass scans only what is running.
            turnsRunning: db.prepare(
                "SELECT turn_id FROM turns WHERE status = 'running' AND agent_id = ?",
            ),
            turnsReap: db.prepare(
                `UPDATE turns
                    SET status = 'error', ended_at = ?,
                        error_code = 'turn_abandoned', error_message = ?, error_hint = ?
                  WHERE status = 'running' AND agent_id = ?`,
            ),
            turnsRunningOrphan: db.prepare(
                `SELECT DISTINCT agent_id FROM turns
                  WHERE status = 'running'
                    AND agent_id NOT IN (SELECT agent_id FROM runtime_leases)`,
            ),

            leaseGet: db.prepare("SELECT * FROM runtime_leases WHERE agent_id = ?"),
            leaseAll: db.prepare("SELECT * FROM runtime_leases ORDER BY agent_id"),
            leaseInsert: db.prepare(
                `INSERT INTO runtime_leases
                     (agent_id, runtime_id, pid, mode, started_at, heartbeat_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (agent_id) DO UPDATE SET
                     runtime_id = excluded.runtime_id, pid = excluded.pid, mode = excluded.mode,
                     started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
            ),
            leaseBeat: db.prepare(
                "UPDATE runtime_leases SET heartbeat_at = ? WHERE agent_id = ? AND runtime_id = ?",
            ),
            leaseRelease: db.prepare(
                "DELETE FROM runtime_leases WHERE agent_id = ? AND runtime_id = ?",
            ),

            outboxInsert: db.prepare(
                `INSERT INTO outbox
                     (agent_id, dedupe_key, group_key, session_key, turn_id, channel_id, recipient,
                      thread, chunk_index, chunk_total, body, status, next_attempt_at,
                      created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                 ON CONFLICT (agent_id, dedupe_key) DO NOTHING`,
            ),
            outboxById: db.prepare("SELECT * FROM outbox WHERE id = ?"),
            outboxByKey: db.prepare("SELECT * FROM outbox WHERE agent_id = ? AND dedupe_key = ?"),
            /**
             * Due rows, head-of-line per group.
             *
             * The `NOT EXISTS` is the ordering guarantee. A chunk is withheld while any earlier
             * chunk of its group is not `sent` — including one that is `failed`, which is the
             * fail-closed direction: a half-message that ships because its first part gave up is
             * worse than a queue that visibly stops. `abandonGroupAfter` is what clears it.
             */
            outboxDue: db.prepare(
                `SELECT o.* FROM outbox o
                  WHERE o.agent_id = ?
                    AND o.status = 'pending'
                    AND o.next_attempt_at <= ?
                    AND NOT EXISTS (
                        SELECT 1 FROM outbox e
                         WHERE e.agent_id = o.agent_id
                           AND e.group_key = o.group_key
                           AND e.chunk_index < o.chunk_index
                           AND e.status <> 'sent'
                    )
                  ORDER BY o.id ASC
                  LIMIT ?`,
            ),
            outboxClaim: db.prepare(
                `UPDATE outbox SET status = 'inflight', updated_at = ?
                  WHERE id = ? AND status = 'pending'`,
            ),
            outboxSent: db.prepare(
                `UPDATE outbox
                    SET status = 'sent', provider_message_id = ?, attempts = attempts + 1,
                        error_code = NULL, error_message = NULL, updated_at = ?
                  WHERE id = ?`,
            ),
            outboxRetry: db.prepare(
                `UPDATE outbox
                    SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?,
                        error_code = ?, error_message = ?, updated_at = ?
                  WHERE id = ?`,
            ),
            outboxFailed: db.prepare(
                `UPDATE outbox
                    SET status = 'failed', attempts = attempts + 1,
                        error_code = ?, error_message = ?, updated_at = ?
                  WHERE id = ?`,
            ),
            outboxAbandonList: db.prepare(
                `SELECT id FROM outbox
                  WHERE agent_id = ? AND group_key = ? AND chunk_index > ?
                    AND status IN ('pending', 'inflight')
                  ORDER BY chunk_index ASC`,
            ),
            outboxAbandon: db.prepare(
                `UPDATE outbox
                    SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
                  WHERE agent_id = ? AND group_key = ? AND chunk_index > ?
                    AND status IN ('pending', 'inflight')`,
            ),
            outboxInflight: db.prepare(
                "SELECT * FROM outbox WHERE status = 'inflight' AND agent_id = ?",
            ),
            outboxRecover: db.prepare(
                `UPDATE outbox
                    SET status = 'pending', uncertain = 1, next_attempt_at = ?, updated_at = ?
                  WHERE status = 'inflight' AND agent_id = ?`,
            ),
            outboxInflightOrphan: db.prepare(
                `SELECT DISTINCT agent_id FROM outbox
                  WHERE status = 'inflight'
                    AND agent_id NOT IN (SELECT agent_id FROM runtime_leases)`,
            ),
            outboxPrune: db.prepare(
                "DELETE FROM outbox WHERE status IN ('sent', 'failed') AND updated_at < ?",
            ),
            /**
             * One statement with optional filters rather than four prepared variants.
             *
             * Each filter is bound twice — once to the null test, once to the comparison. Ugly at
             * the call site and worth it: four near-identical SELECTs are four places for the
             * column list to drift, which is the same failure `MESSAGE_COLUMNS` exists to prevent.
             */
            outboxList: db.prepare(
                `SELECT * FROM outbox
                  WHERE agent_id = ?
                    AND (? IS NULL OR session_key = ?)
                    AND (? IS NULL OR status = ?)
                  ORDER BY id DESC
                  LIMIT ?`,
            ),

            kvGet: db.prepare("SELECT value FROM kv WHERE scope = ? AND key = ?"),
            kvSet: db.prepare(
                `INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            ),
            kvDelete: db.prepare("DELETE FROM kv WHERE scope = ? AND key = ?"),
            kvAll: db.prepare("SELECT key, value FROM kv WHERE scope = ? ORDER BY key"),

            // ── one agent's footprint, and its removal ──
            //
            // Counted per table rather than derived from `sessionList`, because three of these do not
            // hang off a session at all: memory is deliberately session-free (migration 6), the outbox
            // survives its session on purpose, and a lease is about a process.
            countSessions: db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE agent_id = ?"),
            countMessages: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE agent_id = ?"),
            countTurns: db.prepare("SELECT COUNT(*) AS c FROM turns WHERE agent_id = ?"),
            countArtifacts: db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE agent_id = ?"),
            countOutbox: db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE agent_id = ?"),
            countOutboxPending: db.prepare(
                "SELECT COUNT(*) AS c FROM outbox WHERE agent_id = ? AND status IN ('pending', 'inflight')",
            ),
            countMemorySources: db.prepare(
                "SELECT COUNT(*) AS c FROM memory_sources WHERE agent_id = ?",
            ),
            // `messages`, `turns` and `artifacts` all cascade from `sessions`, so they are not deleted
            // here — deleting them explicitly would work and would also mean two places had to agree
            // about the cascade. The foreign keys are the single statement of it.
            sessionsDeleteAll: db.prepare("DELETE FROM sessions WHERE agent_id = ?"),
            outboxDeleteAll: db.prepare("DELETE FROM outbox WHERE agent_id = ?"),
            leaseDeleteAll: db.prepare("DELETE FROM runtime_leases WHERE agent_id = ?"),
            // A union rather than a join: an agent can own rows in any one of these and none of the
            // others — a directory deleted while idle leaves sessions and memory with no lease, and an
            // agent that only ever failed to boot leaves a lease with nothing else.
            allAgentIds: db.prepare(
                `SELECT agent_id FROM sessions
                  UNION SELECT agent_id FROM outbox
                  UNION SELECT agent_id FROM memory_passages
                  UNION SELECT agent_id FROM memory_sources
                  UNION SELECT agent_id FROM runtime_leases
                  ORDER BY agent_id`,
            ),
        }

        const ensureSession = (agentId: string, sessionKey: string): SessionRecord => {
            const existing = q.sessionGet.get<SessionRow>(agentId, sessionKey)
            if (existing !== undefined) return toSession(existing)

            const parts = parseSessionKey(sessionKey)
            const ts = nowIso()
            q.sessionInsert.run(
                agentId,
                sessionKey,
                parts.channel,
                parts.peerId,
                parts.thread,
                ts,
                ts,
            )
            const created = q.sessionGet.get<SessionRow>(agentId, sessionKey)
            if (created === undefined) {
                // ON CONFLICT DO NOTHING plus an immediately absent row means the insert was
                // rejected for a reason the conflict clause does not cover. Better to say so than
                // to hand back a record that is not in the database.
                throw new Error(
                    `Session ${agentId}/${sessionKey} could not be created. ` +
                        "hint: this indicates the sessions table is not writable — check disk space and file permissions on the database.",
                )
            }
            return toSession(created)
        }

        this.sessions = {
            ensure: async (agentId, sessionKey) => ensureSession(agentId, sessionKey),
            get: async (agentId, sessionKey) => {
                const row = q.sessionGet.get<SessionRow>(agentId, sessionKey)
                return row === undefined ? undefined : toSession(row)
            },
            list: async (agentId) => q.sessionList.all<SummaryRow>(agentId).map(toSummary),
            setPhase: async (agentId, sessionKey, phase) => {
                ensureSession(agentId, sessionKey)
                q.sessionSetPhase.run(phase, nowIso(), agentId, sessionKey)
            },
            clear: async (agentId, sessionKey) => {
                // Files remain canonical and untouched. The session projection is derived from the
                // rows being cleared, so keeping it would make deleted prose retrievable until a
                // later reconciliation happened to notice.
                db.transaction(() => {
                    q.messagesDelete.run(agentId, sessionKey)
                    q.turnsDelete.run(agentId, sessionKey)
                    q.memoryDeleteSource.run(agentId, sessionSource(sessionKey))
                    q.memorySourceDelete.run(agentId, sessionSource(sessionKey))
                    q.sessionTouch.run(nowIso(), agentId, sessionKey)
                })
            },
            delete: async (agentId, sessionKey) => {
                db.transaction(() => {
                    q.sessionDelete.run(agentId, sessionKey)
                    q.memoryDeleteSource.run(agentId, sessionSource(sessionKey))
                    q.memorySourceDelete.run(agentId, sessionSource(sessionKey))
                })
            },
        }

        this.messages = {
            append: async (agentId, sessionKey, messages, turnId) => {
                if (messages.length === 0) return []
                return db.transaction(() => {
                    // Ensuring inside the transaction is what keeps the foreign key from being a
                    // failure mode callers have to know about.
                    ensureSession(agentId, sessionKey)
                    const ts = nowIso()
                    const stored: StoredMessage[] = []
                    for (const message of messages) {
                        const result = q.messageInsert.run(
                            agentId,
                            sessionKey,
                            turnId,
                            message.role,
                            message.content,
                            // Serialised rather than normalised into their own table: they are read
                            // and written only as a whole message, never queried across.
                            message.toolCalls === undefined || message.toolCalls.length === 0
                                ? null
                                : JSON.stringify(message.toolCalls),
                            message.toolCallId ?? null,
                            message.origin ?? null,
                            message.tainted === true,
                            ts,
                        )
                        const row = q.messageById.get<MessageRow>(result.lastInsertRowid)
                        if (row !== undefined) stored.push(toMessage(row))
                    }
                    q.sessionTouch.run(ts, agentId, sessionKey)
                    return stored
                })
            },
            history: async (agentId, sessionKey, limit) => {
                const rows =
                    limit === undefined
                        ? q.historyAll.all<MessageRow>(agentId, sessionKey)
                        : q.historyTail.all<MessageRow>(agentId, sessionKey, limit)
                // Via `toChatMessage` rather than `{role, content}`: a native assistant turn carries
                // the calls it made and a `tool` message names the call it answers, and a history read
                // that drops either hands the next turn an orphaned trace.
                return rows.map(toChatMessage)
            },
            page: async (agentId, sessionKey, options) => {
                const limit = options?.limit ?? DEFAULT_PAGE
                const rows =
                    options?.before === undefined
                        ? q.pageFirst.all<MessageRow>(agentId, sessionKey, limit)
                        : q.pageBefore.all<MessageRow>(agentId, sessionKey, options.before, limit)

                const messages = rows.map(toMessage)
                const last = messages.at(-1)
                if (last === undefined) return { messages }

                const oldest = q.messageOldest.get<{ m: number | null }>(agentId, sessionKey)
                const page: MessagePage =
                    oldest?.m === null || oldest === undefined || last.id <= oldest.m
                        ? { messages }
                        : { messages, nextBefore: last.id }
                return page
            },
            count: async (agentId, sessionKey) =>
                q.messageCount.get<{ c: number }>(agentId, sessionKey)?.c ?? 0,
        }

        this.turns = {
            start: async (record) => {
                const ts = nowIso()
                db.transaction(() => {
                    ensureSession(record.agentId, record.sessionKey)
                    q.turnInsert.run(
                        record.turnId,
                        record.agentId,
                        record.sessionKey,
                        record.source,
                        record.input,
                        ts,
                    )
                })
                const row = q.turnGet.get<TurnRow>(record.turnId)
                if (row === undefined) {
                    throw new Error(
                        `Turn ${record.turnId} was not persisted. ` +
                            "hint: a duplicate turn id is the likely cause — turn ids come from newTurnId() and must be unique.",
                    )
                }
                return toTurn(row)
            },
            finish: async (turnId, outcome) => {
                q.turnFinish.run(
                    outcome.status,
                    outcome.text,
                    outcome.reasoning,
                    outcome.steps,
                    outcome.promptTokens,
                    outcome.outputTokens,
                    outcome.durationMs,
                    outcome.errorCode,
                    outcome.errorMessage,
                    outcome.errorHint,
                    nowIso(),
                    turnId,
                )
            },
            get: async (turnId) => {
                const row = q.turnGet.get<TurnRow>(turnId)
                return row === undefined ? undefined : toTurn(row)
            },
            list: async (agentId, sessionKey, options) =>
                q.turnList
                    .all<TurnRow>(agentId, sessionKey, options?.limit ?? DEFAULT_PAGE)
                    .map(toTurn),
            reapRunning: async (agentIds, reason) => {
                if (agentIds.length === 0) return []
                const ts = nowIso()
                return db.transaction(() => {
                    const reaped: string[] = []
                    for (const agentId of agentIds) {
                        const ids = q.turnsRunning
                            .all<{ turn_id: string }>(agentId)
                            .map((row) => row.turn_id)
                        if (ids.length === 0) continue
                        q.turnsReap.run(
                            ts,
                            `The process holding this turn exited before it finished (${reason}).`,
                            "A turn cannot be resumed by a different process — the model stream it was reading is gone. Send the input again. This row was left running by an earlier crash and is marked failed at boot rather than left ambiguous.",
                            agentId,
                        )
                        reaped.push(...ids)
                    }
                    return reaped
                })
            },
        }

        this.outbox = {
            enqueue: async (deliveries) => {
                if (deliveries.length === 0) return []
                return db.transaction(() => {
                    const ts = nowIso()
                    const results: { record: DeliveryRecord; inserted: boolean }[] = []
                    for (const d of deliveries) {
                        const result = q.outboxInsert.run(
                            d.agentId,
                            d.dedupeKey,
                            d.groupKey,
                            d.sessionKey,
                            d.turnId ?? null,
                            d.channelId,
                            d.recipient,
                            d.thread ?? null,
                            d.chunkIndex,
                            d.chunkTotal,
                            d.body,
                            // Due immediately unless the caller says otherwise. A first attempt
                            // that waited would add latency to every reply to buy nothing —
                            // backoff starts at the first failure.
                            d.nextAttemptAt ?? ts,
                            ts,
                            ts,
                        )
                        const inserted = result.changes === 1
                        // Read back by key rather than by `lastInsertRowid`: on the conflict path
                        // there was no insert, and `lastInsertRowid` still holds whatever this
                        // connection inserted last — a different row, returned as if it were this one.
                        const row = q.outboxByKey.get<DeliveryRow>(d.agentId, d.dedupeKey)
                        if (row === undefined) {
                            throw new Error(
                                `Delivery ${d.agentId}/${d.dedupeKey} could not be enqueued. ` +
                                    "hint: the outbox table is not writable — check disk space and file permissions on the database.",
                            )
                        }
                        results.push({ record: toDelivery(row), inserted })
                    }
                    return results
                })
            },
            due: async (agentId, now, limit) =>
                q.outboxDue.all<DeliveryRow>(agentId, now, limit ?? DEFAULT_PAGE).map(toDelivery),
            claim: async (id) => {
                const result = q.outboxClaim.run(nowIso(), id)
                if (result.changes !== 1) return undefined
                const row = q.outboxById.get<DeliveryRow>(id)
                return row === undefined ? undefined : toDelivery(row)
            },
            markSent: async (id, providerMessageId) => {
                q.outboxSent.run(providerMessageId ?? null, nowIso(), id)
            },
            markRetry: async (id, nextAttemptAt, error) => {
                q.outboxRetry.run(nextAttemptAt, error.code, error.message, nowIso(), id)
            },
            markFailed: async (id, error) => {
                q.outboxFailed.run(error.code, error.message, nowIso(), id)
            },
            abandonGroupAfter: async (agentId, groupKey, chunkIndex, error) =>
                db.transaction(() => {
                    // Ids are collected before the UPDATE, because after it the rows no longer
                    // match its own WHERE clause and there is nothing left to report.
                    const ids = q.outboxAbandonList
                        .all<{ id: number }>(agentId, groupKey, chunkIndex)
                        .map((row) => row.id)
                    if (ids.length === 0) return []
                    q.outboxAbandon.run(
                        error.code,
                        error.message,
                        nowIso(),
                        agentId,
                        groupKey,
                        chunkIndex,
                    )
                    return ids
                }),
            recoverInflight: async (agentIds, nextAttemptAt) => {
                if (agentIds.length === 0) return []
                return db.transaction(() => {
                    const ts = nextAttemptAt ?? nowIso()
                    const recovered: DeliveryRecord[] = []
                    for (const agentId of agentIds) {
                        const rows = q.outboxInflight.all<DeliveryRow>(agentId)
                        if (rows.length === 0) continue
                        q.outboxRecover.run(ts, nowIso(), agentId)
                        // The pre-update rows, with the two fields the update changed applied by
                        // hand: a caller reporting recovery wants to see the state it is about to
                        // be in, and re-reading every row would double the query count for no new
                        // fact.
                        recovered.push(
                            ...rows.map((row) => ({
                                ...toDelivery(row),
                                status: "pending" as const,
                                uncertain: true,
                                nextAttemptAt: ts,
                            })),
                        )
                    }
                    return recovered
                })
            },
            get: async (id) => {
                const row = q.outboxById.get<DeliveryRow>(id)
                return row === undefined ? undefined : toDelivery(row)
            },
            byDedupeKey: async (agentId, dedupeKey) => {
                const row = q.outboxByKey.get<DeliveryRow>(agentId, dedupeKey)
                return row === undefined ? undefined : toDelivery(row)
            },
            list: async (agentId, options) => {
                const session = options?.sessionKey ?? null
                const status = options?.status ?? null
                return q.outboxList
                    .all<DeliveryRow>(
                        agentId,
                        session,
                        session,
                        status,
                        status,
                        options?.limit ?? DEFAULT_PAGE,
                    )
                    .map(toDelivery)
            },
            prune: async (before) => q.outboxPrune.run(before).changes,
        }

        this.leases = {
            claim: async (input) =>
                // The read and the write are one transaction, which is the whole mechanism: two
                // processes starting at the same instant would otherwise both read "no holder" and
                // both insert, and the second would win the upsert without anyone being told.
                db.transaction((): LeaseClaim => {
                    const held = q.leaseGet.get<LeaseRow>(input.agentId)
                    if (held !== undefined && held.runtime_id !== input.runtimeId) {
                        // `stealFrom` names the holder the caller established is dead. Matching on
                        // it — rather than on a bare "force" flag — is what makes the probe safe:
                        // if the lease changed hands between the probe and here, this is a
                        // different, living process and the claim is refused.
                        if (input.stealFrom !== held.runtime_id) {
                            return { ok: false, held: toLease(held) }
                        }
                    }
                    q.leaseInsert.run(
                        input.agentId,
                        input.runtimeId,
                        input.pid,
                        input.mode,
                        input.now,
                        input.now,
                    )
                    const lease: LeaseRecord = {
                        agentId: input.agentId,
                        runtimeId: input.runtimeId,
                        pid: input.pid,
                        mode: input.mode,
                        startedAt: input.now,
                        heartbeatAt: input.now,
                    }
                    return held === undefined || held.runtime_id === input.runtimeId
                        ? { ok: true, lease }
                        : { ok: true, lease, tookOver: toLease(held) }
                }),
            beat: async (agentId, runtimeId, now) =>
                q.leaseBeat.run(now, agentId, runtimeId).changes > 0,
            release: async (agentId, runtimeId) => {
                q.leaseRelease.run(agentId, runtimeId)
            },
            get: async (agentId) => {
                const row = q.leaseGet.get<LeaseRow>(agentId)
                return row === undefined ? undefined : toLease(row)
            },
            all: async () => q.leaseAll.all<LeaseRow>().map(toLease),
            orphans: async () => {
                const ids = new Set<string>()
                for (const row of q.turnsRunningOrphan.all<{ agent_id: string }>()) {
                    ids.add(row.agent_id)
                }
                for (const row of q.outboxInflightOrphan.all<{ agent_id: string }>()) {
                    ids.add(row.agent_id)
                }
                return [...ids].sort()
            },
        }

        this.kv = {
            get: async (scope, key) => q.kvGet.get<{ value: string }>(scope, key)?.value,
            set: async (scope, key, value) => {
                q.kvSet.run(scope, key, value, nowIso())
            },
            delete: async (scope, key) => {
                q.kvDelete.run(scope, key)
            },
            all: async (scope) => {
                const out: Record<string, string> = {}
                for (const row of q.kvAll.all<{ key: string; value: string }>(scope)) {
                    out[row.key] = row.value
                }
                return out
            },
        }

        this.artifacts = {
            put: async (agentId, sessionKey, artifacts, now) => {
                if (artifacts.length === 0) return
                // One transaction: a compaction displaced these together, and a crash that persisted
                // half of them would leave pointers in the surviving history resolving to nothing.
                this.#db.transaction(() => {
                    for (const artifact of artifacts) {
                        q.artifactPut.run(
                            artifact.id,
                            agentId,
                            sessionKey,
                            artifact.slug ?? null,
                            artifact.content,
                            artifact.tokens,
                            now,
                        )
                    }
                })
            },
            get: async (agentId, sessionKey, id) => {
                const row = q.artifactGet.get<ArtifactRow>(agentId, sessionKey, id)
                return row === undefined ? undefined : toArtifact(row)
            },
            list: async (agentId, sessionKey) =>
                q.artifactList.all<ArtifactRow>(agentId, sessionKey).map(toArtifact),
        }
        this.memory = {
            replaceSource: async (agentId, source, passages, state, now) => {
                // One transaction, and the delete comes first so a source that lost passages loses
                // their rows. A passage that moved to another source is *not* caught by this delete —
                // the upsert has already changed its `source` — which is the behaviour wanted: the row
                // follows the text, and eviction is exactly that move.
                this.#db.transaction(() => {
                    q.memoryDeleteSource.run(agentId, source)
                    for (const passage of passages) {
                        q.memoryPut.run(
                            agentId,
                            passage.id,
                            passage.source,
                            passage.heading ?? null,
                            passage.text,
                            passage.terms,
                            passage.length,
                            passage.at,
                            passage.stamped ? 1 : 0,
                            passage.tags.join(","),
                            passage.tokens,
                            now,
                        )
                    }
                    q.memorySourcePut.run(
                        agentId,
                        source,
                        state.mtimeMs,
                        state.size,
                        state.tokeniser,
                        passages.length,
                        now,
                    )
                })
            },
            sources: async (agentId) =>
                q.memorySources.all<MemorySourceRow>(agentId).map(toMemorySource),
            dropSource: async (agentId, source) => {
                this.#db.transaction(() => {
                    q.memoryDeleteSource.run(agentId, source)
                    q.memorySourceDelete.run(agentId, source)
                })
            },
            clear: async (agentId) => {
                this.#db.transaction(() => {
                    q.memoryDeleteAll.run(agentId)
                    q.memorySourceDeleteAll.run(agentId)
                })
            },
            stats: async (agentId) => {
                const row = q.memoryStats.get<{ passages: number; total_length: number }>(agentId)
                return {
                    passages: row?.passages ?? 0,
                    totalLength: row?.total_length ?? 0,
                }
            },
            frequencies: async (agentId, terms) => {
                const out = new Map<string, number>()
                for (const term of terms) {
                    if (out.has(term)) continue
                    const row = q.memoryDf.get<{ df: number }>(matchExpression([term]), agentId)
                    out.set(term, row?.df ?? 0)
                }
                return out
            },
            candidates: async (agentId, terms, limit) => {
                if (terms.length === 0 || limit <= 0) return []
                return q.memoryCandidates
                    .all<MemoryPassageRow>(matchExpression(terms), agentId, limit)
                    .map(toMemoryPassage)
            },
            vocabulary: async (agentId) => {
                const out = new Set<string>()
                for (const row of q.memoryVocabulary.all<{ terms: string }>(agentId)) {
                    if (row.terms === "") continue
                    for (const term of row.terms.split(" ")) {
                        if (term !== "") out.add(term)
                    }
                }
                return out
            },
        }

        const count = (statement: SqlStatement, agentId: string): number =>
            statement.get<{ c: number }>(agentId)?.c ?? 0

        const footprint = (agentId: string): AgentFootprint => ({
            sessions: count(q.countSessions, agentId),
            messages: count(q.countMessages, agentId),
            turns: count(q.countTurns, agentId),
            artifacts: count(q.countArtifacts, agentId),
            outbox: count(q.countOutbox, agentId),
            outboxPending: count(q.countOutboxPending, agentId),
            passages: q.memoryStats.get<{ passages: number }>(agentId)?.passages ?? 0,
            memorySources: count(q.countMemorySources, agentId),
            lease: q.leaseGet.get(agentId) !== undefined,
        })

        this.agentFootprint = async (agentId) => footprint(agentId)

        this.purgeAgent = async (agentId) =>
            // Counted inside the transaction, before anything is deleted: counting outside it would
            // report a number taken at a different moment from the one the deletion acted on, which is
            // the same class of lie as a gauge reporting pre-compaction pressure.
            this.#db.transaction(() => {
                const went = footprint(agentId)
                // Sessions first, so the cascade runs while the foreign keys still resolve.
                q.sessionsDeleteAll.run(agentId)
                q.outboxDeleteAll.run(agentId)
                q.memoryDeleteAll.run(agentId)
                q.memorySourceDeleteAll.run(agentId)
                q.leaseDeleteAll.run(agentId)
                return went
            })

        this.agentIds = async () =>
            q.allAgentIds.all<{ agent_id: string }>().map((row) => row.agent_id)
    }

    /** Which module backs this store: `bun:sqlite` or `node:sqlite`. */
    get driver(): "bun" | "node" {
        return this.#db.runtime
    }

    static async open(options: SqliteStoreOptions): Promise<SqliteStore> {
        const db = await openDatabase(options)
        try {
            const report = migrate(db)
            return new SqliteStore(db, report)
        } catch (error) {
            // A half-opened database with no store to close it is a leaked file handle, and on
            // Windows a leaked handle is an unopenable file next time.
            db.close()
            throw error
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return
        this.#closed = true
        this.#db.close()
    }
}

/**
 * An anonymous, migrated in-memory database.
 *
 * This is the whole "in-memory store" — there is no second hand-written implementation of
 * `Store`. A separate one would be a second thing to keep in sync with the interface, and the
 * bug it would hide is the interesting kind: tests passing against a mock whose semantics have
 * drifted from the driver everything actually runs on.
 */
export function openMemoryStore(): Promise<SqliteStore> {
    return SqliteStore.open({ path: ":memory:" })
}
