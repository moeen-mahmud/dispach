/**
 * Numbered migrations gated on `PRAGMA user_version`.
 *
 * Migrations are inline strings rather than `.sql` files on disk. A `.sql` file has to be found
 * at runtime, which means a path that differs between the source tree, the bundled `dist`, and
 * the Docker image — three chances for a migration to be silently skipped because the directory
 * was not copied. A missing migration is not the kind of failure worth making possible to save
 * a little syntax highlighting.
 *
 * Rules for adding one: append, never edit. An already-applied migration is history; changing
 * it means installed databases and fresh ones disagree about their own schema while both report
 * the same `user_version`.
 */

import { HarnessError } from "../../errors.ts"
import { type SqlDatabase, setUserVersion, userVersion } from "./driver.ts"

export interface Migration {
    /** 1-based and contiguous. Checked at load, because a gap would skip a migration. */
    readonly version: number
    readonly name: string
    readonly sql: string
}

export const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        name: "sessions_messages_turns_kv",
        sql: `
CREATE TABLE sessions (
    agent_id    TEXT NOT NULL,
    session_key TEXT NOT NULL,
    channel     TEXT NOT NULL,
    peer_id     TEXT NOT NULL,
    thread      TEXT,
    phase       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_key)
);

-- Channel and peer are indexed because Phase 4 resolves an inbound message to a session by
-- them, before it knows the composed key.
CREATE INDEX sessions_by_peer ON sessions (agent_id, channel, peer_id);

CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    session_key TEXT NOT NULL,
    turn_id     TEXT,
    role        TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);

-- The covering index for history reads: the id tail makes "last N in order" an index scan.
CREATE INDEX messages_by_session ON messages (agent_id, session_key, id);

CREATE TABLE turns (
    turn_id       TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    session_key   TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (
                      status IN ('running', 'final', 'max_steps', 'stopped', 'timeout', 'error')
                  ),
    source        TEXT NOT NULL,
    input         TEXT NOT NULL,
    text          TEXT NOT NULL DEFAULT '',
    reasoning     TEXT NOT NULL DEFAULT '',
    steps         INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error_code    TEXT,
    error_message TEXT,
    error_hint    TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    duration_ms   INTEGER,
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);

CREATE INDEX turns_by_session ON turns (agent_id, session_key, started_at DESC);

-- Partial index: crash recovery at boot scans only what is actually running, so the cost of
-- reaping does not grow with turn history.
CREATE INDEX turns_running ON turns (status) WHERE status = 'running';

CREATE TABLE kv (
    scope      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);
`,
    },
    {
        version: 2,
        name: "messages_tool_calls",
        /**
         * Native tool calling needs two more facts about a message than `{role, content}` carries.
         *
         * Without them a resumed native session is broken in a way that only shows on its *second*
         * turn: the assistant message recording what the model called comes back with empty content
         * and no calls, and the `tool` message answering it comes back naming nothing. Against a
         * strict endpoint that is a 400; against a lenient one the model is handed an observation
         * with no idea what produced it, which is worse for being silent. Measured — qwen3.5:9b via
         * Ollama accepted the orphaned trace and answered from context anyway.
         *
         * Both columns are nullable and unused under NLT, where the call *is* the content.
         */
        sql: `
ALTER TABLE messages ADD COLUMN tool_calls TEXT;
ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
`,
    },
    {
        version: 3,
        name: "outbox",
        /**
         * The delivery queue. `05-PLAN.md` calls this "migration 002" — that number was written
         * before Phase 3 added one, and the list is contiguous by position, so it is 003 here.
         *
         * The load-bearing line is `UNIQUE (agent_id, dedupe_key)`. It is what makes a re-enqueue a
         * no-op rather than a second message, and the key is *derived* by the caller from facts it
         * can reproduce after a crash — see `DeliveryRecord.dedupeKey`. There is deliberately no
         * server-generated identity column serving that role: `id` exists only to order rows and to
         * name one in a later `UPDATE`.
         *
         * `session_key` carries no foreign key to `sessions`, unlike `messages` and `turns`. A
         * delivery outlives its conversation on purpose — `sessions.clear()` must not silently
         * discard replies that have not been sent yet, and `ON DELETE CASCADE` would do exactly
         * that at the moment a person is least expecting it.
         */
        sql: `
CREATE TABLE outbox (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id            TEXT NOT NULL,
    dedupe_key          TEXT NOT NULL,
    group_key           TEXT NOT NULL,
    session_key         TEXT NOT NULL,
    turn_id             TEXT,
    channel_id          TEXT NOT NULL,
    recipient           TEXT NOT NULL,
    thread              TEXT,
    chunk_index         INTEGER NOT NULL,
    chunk_total         INTEGER NOT NULL,
    body                TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (
                            status IN ('pending', 'inflight', 'sent', 'failed')
                        ),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT NOT NULL,
    uncertain           INTEGER NOT NULL DEFAULT 0,
    provider_message_id TEXT,
    error_code          TEXT,
    error_message       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- Idempotency. Enqueueing the same logical delivery twice hits this and does nothing.
CREATE UNIQUE INDEX outbox_dedupe ON outbox (agent_id, dedupe_key);

-- The drain query: pending rows whose time has come, oldest first.
CREATE INDEX outbox_due ON outbox (agent_id, status, next_attempt_at, id);

-- Head-of-line lookup. The drain asks, per candidate row, whether an earlier chunk of the same
-- group is still unsent; without this index that question is a scan per row.
CREATE INDEX outbox_group ON outbox (agent_id, group_key, chunk_index);

-- Crash recovery at boot scans only what was in flight, so its cost does not grow with history.
CREATE INDEX outbox_inflight ON outbox (status) WHERE status = 'inflight';

CREATE INDEX outbox_by_session ON outbox (agent_id, session_key, id DESC);
`,
    },
    {
        version: 4,
        name: "runtime_leases",
        /**
         * Which process is serving which agent, right now.
         *
         * Two problems, one row, and they are the same problem seen from either end.
         *
         * **Nobody may serve an agent twice.** Telegram allows exactly one `getUpdates` poller per
         * bot token, and the poll loop is specified never to exit on its own — it catches
         * everything and backs off — so a 409 from a second poller is indistinguishable *by
         * construction* from the outage that loop exists to survive. Both processes back off, both
         * run forever, messages land with whichever wins each race, and both append to one session
         * history. Webhook mode produces no 409 at all: `setWebhook` silently moves the hook to the
         * last caller. The transport cannot detect this, so the store does.
         *
         * **Boot recovery must not reach across processes.** `turns.reapRunning` and
         * `outbox.recoverInflight` were both unfiltered, which is correct for one process on one
         * database and wrong the moment two share a file — the second one's boot would mark the
         * first's live turn failed and flip its in-flight delivery back to pending, re-sending a
         * Telegram message that had already gone. A lease says which rows are *this* process's to
         * recover.
         *
         * Scoped by ownership rather than by agent id, and the difference is not academic: an
         * agent id that no longer boots — deleted directory, edited `id:` — would never be passed
         * again, so its rows would stay `running` forever, which is precisely the ambiguity
         * `reapRunning` exists to remove. Rows with no live lease are recoverable by whoever finds
         * them.
         *
         * `PRIMARY KEY (agent_id)` is the mutual exclusion. Claiming is an upsert inside a
         * transaction that first re-reads the row, so two simultaneous starts cannot both win —
         * which is why this is a table and not a `kv` entry, since `kv` has no compare-and-set.
         *
         * `pid` is advisory and known to be imperfect: pids are reused, and a lease whose process
         * died without releasing looks identical to one whose process is merely wedged. The
         * caller decides liveness (`process.kill(pid, 0)`) and passes the verdict in; the store
         * stores facts and does not probe the operating system.
         */
        sql: `
CREATE TABLE runtime_leases (
    agent_id      TEXT PRIMARY KEY,
    runtime_id    TEXT NOT NULL,
    pid           INTEGER NOT NULL,
    -- How the process was started, so a refusal can say "in a terminal" or "as a service"
    -- instead of only naming a number the person then has to go and look up.
    mode          TEXT NOT NULL CHECK (mode IN ('daemon', 'terminal', 'embedded')),
    started_at    TEXT NOT NULL,
    heartbeat_at  TEXT NOT NULL
);
`,
    },
    {
        version: 5,
        name: "artifacts_and_message_origin",
        /**
         * What compaction displaced, and who wrote each message.
         *
         * **`artifacts`.** The compaction ladder replaces an oversized tool observation with a pointer
         * and puts the whole thing here, so nothing a compaction removed is unreachable — `artifact_read`
         * follows the pointer. The id is *derived from the content* (FNV-1a plus its length, see
         * `compaction/stages.ts`), never generated, for the same reason the outbox derives its dedupe
         * key: the duplicate that actually happens is the same work running twice, and only a derived
         * identity collides. That is what makes `INSERT OR IGNORE` correct here, and it is why a
         * message snipped on one turn and pointer-replaced on a later one resolves to one row rather
         * than two.
         *
         * `id` is printable ASCII by construction. Row seven of the table in `sqlite/driver.ts` is why
         * that matters: `node:sqlite` truncates a bound string at a NUL byte while `bun:sqlite` stores
         * it whole, so a key containing one would resolve on one runtime and silently miss on the other.
         *
         * Scoped by session and cascading with it. An artifact is a fragment of one conversation's
         * history and outliving it would leave rows nothing can ever name again — the opposite call
         * from `outbox`, which deliberately survives its session because an unsent reply still has to
         * go out.
         *
         * **`messages.origin`.** Compaction has to know which messages are tool output, and under a
         * text dialect the *role does not say*: NLT sends an observation back as a `user` message. The
         * alternative is matching the `OBSERVATION <slug> —` header with a regex, which would let a
         * person who types the word have their own message truncated, and would silently stop
         * compacting anything the day a dialect changed its framing. Nullable, because a session
         * written before this migration has no origins to read — the honest degradation is that its
         * old messages are treated as prose, so the stages that need this decline and the ladder
         * reaches for the ones that do not.
         */
        sql: `
ALTER TABLE messages ADD COLUMN origin TEXT;

CREATE TABLE artifacts (
    -- Derived from the content, printable ASCII. Unique per session, not globally: the same
    -- observation in two conversations is two facts about two histories.
    id          TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    session_key TEXT NOT NULL,
    -- The tool that produced it, where the observation named one. Shown in the pointer.
    slug        TEXT,
    content     TEXT NOT NULL,
    -- Estimated cost of the original, so a reader can be told the size before spending a step on it.
    tokens      INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_key, id),
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);
`,
    },
    {
        version: 6,
        name: "memory_passages",
        /**
         * The memory corpus: what the agent knows about the person, across sessions.
         *
         * **Not scoped to a session, and with no foreign key to one.** Every other per-conversation
         * table here cascades from `sessions`; this one deliberately does not, which is what makes
         * "deleting a session leaves memory untouched" a property of the schema rather than a promise
         * in a docstring. A memory is a fact about the person, and the conversation it was learned in
         * is an implementation detail of how it arrived.
         *
         * `id` is content-derived (`derivedId("mem", text)`, see `ids.ts`) and printable ASCII, for the
         * same two reasons artifacts are: the duplicate that happens is a re-index of unchanged text,
         * which only a recomputable identity collapses; and `node:sqlite` truncates a bound string at a
         * NUL byte while `bun:sqlite` keeps it, so a key carrying one resolves on one runtime and
         * silently misses on the other. It also means a passage that *moves* — which is exactly what
         * eviction does, carrying a note out of `MEMORY.md` into an archive — keeps its row and only
         * changes `source`.
         *
         * ## Why `terms` and `length` are columns
         *
         * FTS5 is used as a **candidate filter, not as the scorer**. `bm25()` would have been free, and
         * it computes its statistics over the whole table — which holds every agent's passages, since
         * one sandbox root has one store. Average document length and N would therefore be corpus-wide
         * while retrieval is per-agent, so an agent's scores would shift when an unrelated agent wrote
         * a note. Storing the pre-tokenised `terms` and its `length` lets `memory/fts5.ts` score the
         * candidates with the shared BM25 in `rank/bm25.ts` — per-agent statistics, the same formula and
         * the same tokeniser as `skills/select.ts`, so `memory.threshold` and `skills.threshold` mean
         * the same thing. It also makes FTS5's own tokeniser and k1/b defaults irrelevant.
         *
         * `terms` is derived from `rank/bm25.ts`, so `memory_sources.tokeniser` records the version that
         * produced it. A stale value forces a rebuild; without it, editing the stopword list would leave
         * the index tokenised under old rules while queries arrive under new ones, and retrieval would
         * simply get worse with nothing reporting why.
         *
         * The FTS5 table is external-content with the standard three triggers, so `memory_passages` is
         * the single writable surface: an upsert, a delete by source, and a whole-corpus wipe all keep
         * the index in step with no second code path to forget. Verified identical on both drivers,
         * including `ON CONFLICT DO UPDATE` firing the update trigger exactly once.
         */
        sql: `
CREATE TABLE memory_passages (
    agent_id    TEXT NOT NULL,
    -- Content-derived. Printable ASCII: it is a bound key.
    id          TEXT NOT NULL,
    -- Path relative to the memory root, or session:<key> for an indexed message.
    source      TEXT NOT NULL,
    -- Nearest enclosing markdown heading, scored with the text. Null at top level.
    heading     TEXT,
    -- Verbatim as authored. What slot 7 injects; never rewritten.
    text        TEXT NOT NULL,
    -- rank/bm25.ts terms(), space-joined. The indexed column, and what BM25 counts.
    terms       TEXT NOT NULL,
    -- Term count, so average document length is a SUM rather than a scan.
    length      INTEGER NOT NULL,
    -- When the fact was learned. From the passage's own stamp where it had one.
    at          TEXT NOT NULL,
    -- 1 when at is the passage's own stamp, 0 when it was implied by a filename or an mtime.
    stamped     INTEGER NOT NULL,
    -- Comma-joined, for display only. Not scored: a tag is already in the text.
    tags        TEXT NOT NULL,
    -- Estimated cost of text, so the slot budget applies without re-estimating every turn.
    tokens      INTEGER NOT NULL,
    indexed_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, id)
);

CREATE INDEX memory_passages_source ON memory_passages (agent_id, source);

CREATE VIRTUAL TABLE memory_fts USING fts5(
    terms,
    content='memory_passages',
    content_rowid='rowid'
);

CREATE TRIGGER memory_passages_ai AFTER INSERT ON memory_passages BEGIN
    INSERT INTO memory_fts(rowid, terms) VALUES (new.rowid, new.terms);
END;

CREATE TRIGGER memory_passages_ad AFTER DELETE ON memory_passages BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, terms) VALUES ('delete', old.rowid, old.terms);
END;

CREATE TRIGGER memory_passages_au AFTER UPDATE ON memory_passages BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, terms) VALUES ('delete', old.rowid, old.terms);
    INSERT INTO memory_fts(rowid, terms) VALUES (new.rowid, new.terms);
END;

-- What has been indexed and under which rules, so a changed file or a changed tokeniser is
-- detectable without re-reading the corpus.
CREATE TABLE memory_sources (
    agent_id    TEXT NOT NULL,
    source      TEXT NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    -- rank/bm25.ts TOKENISER_VERSION at index time. A mismatch forces a rebuild.
    tokeniser   INTEGER NOT NULL,
    passages    INTEGER NOT NULL,
    indexed_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, source)
);
`,
    },
    {
        version: 7,
        name: "turn_status_truncated_no_progress",
        /**
         * Two more ways a turn can end: `truncated` and `no_progress`.
         *
         * Both existed as behaviour before they existed as statuses. A reply cut off at the output
         * limit with text on the floor fell through to `final` — a truncated answer recorded as a
         * complete one — and a model repeating one call until the step cap ran out was recorded as
         * `max_steps`, which sends whoever reads it to raise a budget that was not the problem.
         *
         * A rebuild, because SQLite cannot alter a CHECK constraint. Nothing references `turns`
         * (`messages.turn_id` is a plain column with no foreign key), so the ordinary create-copy-
         * drop-rename is safe and the outgoing key to `sessions` is simply restated. The indexes are
         * dropped with the table and recreated verbatim — including the partial one on `running`,
         * without which crash recovery at boot goes from an index scan to a full scan of every turn
         * the agent has ever taken, silently and only on a large store.
         */
        sql: `
CREATE TABLE turns_new (
    turn_id       TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    session_key   TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (
                      status IN (
                          'running', 'final', 'max_steps', 'no_progress',
                          'truncated', 'stopped', 'timeout', 'error'
                      )
                  ),
    source        TEXT NOT NULL,
    input         TEXT NOT NULL,
    text          TEXT NOT NULL DEFAULT '',
    reasoning     TEXT NOT NULL DEFAULT '',
    steps         INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error_code    TEXT,
    error_message TEXT,
    error_hint    TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    duration_ms   INTEGER,
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);

INSERT INTO turns_new SELECT * FROM turns;

DROP TABLE turns;

ALTER TABLE turns_new RENAME TO turns;

CREATE INDEX turns_by_session ON turns (agent_id, session_key, started_at DESC);
CREATE INDEX turns_running ON turns (status) WHERE status = 'running';
`,
    },
    {
        version: 8,
        name: "schedules",
        /**
         * Durable schedules. `05-PLAN.md` calls this "migration 005" — that number was written
         * before Phases 3, 4 and 7C each added one, and the list is contiguous by position.
         *
         * **`schedules_due` is deliberately not keyed on `agent_id`, and it is the only index here
         * that is not.** Every other table in this store is queried per agent, because isolation is
         * a property of the queries rather than of the file. The scheduler is the one component that
         * is cross-agent by design: a single multiplexed timer asks "what is due anywhere" once,
         * rather than asking N times and taking the minimum. An agent-first index would make that
         * question a scan per agent, which is the shape the single timer exists to avoid.
         *
         * `anchor_at` and `next_run_at` are two different instants and both are needed. `next_run_at`
         * is jittered and is what the tick compares against; `anchor_at` is the nominal boundary the
         * *following* run is computed from. Persisting only the jittered one makes the offset
         * compound — measured at 16m19s between fires of a 15-minute schedule — which is the
         * cumulative drift the whole design exists to prevent, reintroduced by the mechanism meant to
         * spread load.
         *
         * `next_run_at` is nullable, and NULL is a real state rather than a missing value: it means
         * *never again*, which is what a spent one-shot is. The partial index excludes those rows, so
         * a store full of fired `at` schedules costs the tick nothing.
         *
         * `origin` is what makes reconciliation safe. A manifest owns the rows it declared and
         * nothing else, so a schedule created through the API survives a reload that removes every
         * manifest schedule around it.
         */
        sql: `
CREATE TABLE schedules (
    agent_id        TEXT NOT NULL,
    id              TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('cron', 'every', 'at')),
    expr            TEXT NOT NULL,
    timezone        TEXT,
    task            TEXT NOT NULL,
    -- Both NULL together means deliver: "none" — results reach the event stream only.
    deliver_channel TEXT,
    deliver_to      TEXT,
    session_mode    TEXT NOT NULL DEFAULT 'isolated',
    -- Model role override. NULL is main, which is why it is not defaulted to the string.
    role            TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    origin          TEXT NOT NULL CHECK (origin IN ('manifest', 'api')),
    anchor_at       TEXT NOT NULL,
    next_run_at     TEXT,
    last_fired_at   TEXT,
    last_status     TEXT CHECK (last_status IN ('ok', 'error', 'skipped')),
    last_error      TEXT,
    runs            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (agent_id, id)
);

-- The tick's only query. Not agent-scoped, on purpose — see above.
CREATE INDEX schedules_due ON schedules (next_run_at)
    WHERE enabled = 1 AND next_run_at IS NOT NULL;

-- Reconciliation reads one agent's manifest-owned rows to diff them against the manifest.
CREATE INDEX schedules_by_origin ON schedules (agent_id, origin);
`,
    },
    {
        version: 9,
        name: "schedule_provenance",
        /**
         * Who wrote a schedule row, and which run last touched it.
         *
         * **`source_path` exists because the store is keyed by manifest `id` and nothing else.** Two
         * directories may declare the same `id` — usually equal to the directory name and not
         * required to be — and they then share one store. Reconciliation ends by dropping the
         * manifest-owned rows the manifest no longer declares, so loading the *other* manifest
         * deleted the first one's schedules and the next load re-created them with a fresh anchor.
         * Measured on a real pair: `in 3m` before, row gone, `in 16m` after. A 15-minute schedule
         * whose owner was reloaded every few minutes never reached its own due time, and neither
         * side reported anything, because each was correct about the rows it could see.
         *
         * `''` is a real value and means *unknown provenance*: a row written before this column
         * existed. `removeManifestExcept` matches it as well as the caller's path, so the transition
         * cleans up after itself — a legacy row is adopted by the first manifest to reconcile it, and
         * is protected from every other manifest from that moment on. API-created rows carry `''`
         * too and are never eligible: that delete is scoped to `origin = 'manifest'`.
         *
         * `last_run_id` is what lets a delivery failure find the run it belongs to. The scheduler
         * records `ok` when the *turn* finishes, which is honest and is not the question an operator
         * asks — `hub.deliver` only enqueues, so the send fails later, in the outbox, on another
         * tick. Matching the id means a failure arriving after the schedule has already fired again
         * is discarded rather than written onto the wrong run.
         */
        sql: `
ALTER TABLE schedules ADD COLUMN source_path TEXT NOT NULL DEFAULT '';
ALTER TABLE schedules ADD COLUMN last_run_id TEXT;
`,
    },
]

export interface MigrationReport {
    readonly from: number
    readonly to: number
    readonly applied: readonly string[]
}

/**
 * Apply every migration above the database's current `user_version`.
 *
 * The whole run is one transaction per migration, and `user_version` is bumped inside it. A
 * crash therefore leaves the database at the last fully-applied version rather than halfway
 * through one — which is the only reason "migrations are idempotent" can be true of a process
 * that can be killed.
 */
export function migrate(db: SqlDatabase): MigrationReport {
    assertContiguous(MIGRATIONS)

    const from = userVersion(db)
    const target = MIGRATIONS.length
    const applied: string[] = []

    if (from > target) {
        throw new HarnessError({
            code: "store_version_ahead",
            message: `The database is at schema version ${from}, but this build only knows ${target}.`,
            hint: "This database was written by a newer build. Downgrading is not supported — a newer schema can hold rows an older build would misread. Use the newer build, or point at a different database file.",
        })
    }

    for (const migration of MIGRATIONS) {
        if (migration.version <= from) continue
        db.transaction(() => {
            db.exec(migration.sql)
            setUserVersion(db, migration.version)
        })
        applied.push(`${migration.version}_${migration.name}`)
    }

    return { from, to: userVersion(db), applied }
}

function assertContiguous(migrations: readonly Migration[]): void {
    for (const [index, migration] of migrations.entries()) {
        if (migration.version !== index + 1) {
            throw new HarnessError({
                code: "store_migrations_not_contiguous",
                message: `Migration ${index + 1} in the list declares version ${migration.version}.`,
                hint: "Migration versions are 1-based and contiguous, in list order. A gap means user_version would jump past a migration and skip it forever.",
            })
        }
    }
}
