/**
 * The control plane's own state: one row per silo. SQLite, one file, single instance — the pilot's
 * shape. What a silo *contains* is never here; that lives in the silo's own store, on its volume.
 *
 * Bun cannot load `node:sqlite` and Node cannot load `bun:sqlite`, so the tests (Bun) and the
 * shipped process (Node) each open the one they have. The surface used is four calls both share.
 */

export type SiloStatus = "running" | "paused"

export interface Silo {
    readonly subject: string
    /** Container and volume name. */
    readonly name: string
    readonly baseUrl: string
    /** The silo's own API token (`BRAND.runtime.tokenEnv`). Held here only; never returned by a route. */
    readonly token: string
    readonly status: SiloStatus
    readonly createdAt: string
    readonly lastActiveAt: string
    /** From the silo's `GET /v1/activity`, read when it was paused. */
    readonly nextWakeAt?: string
}

type Param = string | number | null

interface Statement {
    run(...params: Param[]): unknown
    get(...params: Param[]): unknown
    all(...params: Param[]): unknown[]
}

interface Driver {
    exec(sql: string): void
    prepare(sql: string): Statement
    close(): void
}

async function openDriver(path: string): Promise<Driver> {
    if (process.versions.bun !== undefined) {
        const { Database } = await import("bun:sqlite")
        return new Database(path) as unknown as Driver
    }
    const { DatabaseSync } = await import("node:sqlite")
    return new DatabaseSync(path) as unknown as Driver
}

interface SiloRow {
    subject: string
    name: string
    base_url: string
    token: string
    status: SiloStatus
    created_at: string
    last_active_at: string
    next_wake_at: string | null
}

const toSilo = (row: SiloRow): Silo => ({
    subject: row.subject,
    name: row.name,
    baseUrl: row.base_url,
    token: row.token,
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    ...(row.next_wake_at === null ? {} : { nextWakeAt: row.next_wake_at }),
})

export interface MonitorEvent {
    readonly webhookId: string
    readonly subject: string
    readonly type: string
    readonly at: string
    readonly agentId?: string
    readonly turnId?: string
    readonly reason?: string
    readonly steps?: number
    readonly durationMs?: number
    readonly firstTokenMs?: number
    readonly promptTokens?: number
    readonly outputTokens?: number
    readonly ok?: boolean
    readonly detail?: string
}

interface MonitorRow {
    webhook_id: string
    subject: string
    type: string
    at: string
    agent_id: string | null
    turn_id: string | null
    reason: string | null
    steps: number | null
    duration_ms: number | null
    first_token_ms: number | null
    prompt_tokens: number | null
    output_tokens: number | null
    ok: number | null
    detail: string | null
}

const toEvent = (row: MonitorRow): MonitorEvent => ({
    webhookId: row.webhook_id,
    subject: row.subject,
    type: row.type,
    at: row.at,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.steps === null ? {} : { steps: row.steps }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.first_token_ms === null ? {} : { firstTokenMs: row.first_token_ms }),
    ...(row.prompt_tokens === null ? {} : { promptTokens: row.prompt_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.ok === null ? {} : { ok: row.ok === 1 }),
    ...(row.detail === null ? {} : { detail: row.detail }),
})

export class SiloStore {
    readonly #db: Driver

    private constructor(db: Driver) {
        this.#db = db
    }

    static async open(path: string): Promise<SiloStore> {
        const db = await openDriver(path)
        db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS silos (
                subject        TEXT PRIMARY KEY,
                name           TEXT NOT NULL UNIQUE,
                base_url       TEXT NOT NULL,
                token          TEXT NOT NULL,
                status         TEXT NOT NULL CHECK (status IN ('running', 'paused')),
                created_at     TEXT NOT NULL,
                last_active_at TEXT NOT NULL,
                next_wake_at   TEXT
            );
            -- The monitor's subscription inside each silo: where its signed events come from.
            CREATE TABLE IF NOT EXISTS hooks (
                subject         TEXT PRIMARY KEY,
                subscription_id TEXT NOT NULL,
                secret          TEXT NOT NULL
            );
            -- One row per event a silo delivered. webhook_id is the Standard Webhooks id, which a
            -- retry keeps, so a redelivery is ignored rather than counted twice.
            CREATE TABLE IF NOT EXISTS monitor_events (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                webhook_id     TEXT NOT NULL UNIQUE,
                subject        TEXT NOT NULL,
                agent_id       TEXT,
                type           TEXT NOT NULL,
                turn_id        TEXT,
                reason         TEXT,
                steps          INTEGER,
                duration_ms    INTEGER,
                first_token_ms INTEGER,
                prompt_tokens  INTEGER,
                output_tokens  INTEGER,
                ok             INTEGER,
                detail         TEXT,
                at             TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS monitor_events_type ON monitor_events (type, id);
            CREATE INDEX IF NOT EXISTS monitor_events_subject ON monitor_events (subject, type, id);
            -- The peer-ask relay (decision 15.10). Which participant in which silo is one person,
            -- written by the embedder: opaque id pairs, nothing about the person (14.2, 14.6).
            CREATE TABLE IF NOT EXISTS person_links (
                principal      TEXT NOT NULL,
                subject        TEXT NOT NULL,
                participant_id TEXT NOT NULL,
                PRIMARY KEY (principal, subject),
                UNIQUE (subject, participant_id)
            );
            -- A person's own ask rate, when the default is not theirs.
            CREATE TABLE IF NOT EXISTS people (
                principal           TEXT PRIMARY KEY,
                ask_rate_per_minute INTEGER
            );
            CREATE TABLE IF NOT EXISTS relay_config (
                id                  INTEGER PRIMARY KEY CHECK (id = 1),
                ask_rate_per_minute INTEGER NOT NULL
            );
            -- One row per relayed ask: the audit, and the window the rate limit counts. No text.
            CREATE TABLE IF NOT EXISTS relay_asks (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                at           TEXT NOT NULL,
                principal    TEXT NOT NULL,
                from_subject TEXT NOT NULL,
                from_agent   TEXT NOT NULL,
                to_subject   TEXT NOT NULL,
                to_agent     TEXT NOT NULL,
                outcome      TEXT NOT NULL,
                duration_ms  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS relay_asks_principal ON relay_asks (principal, at);
        `)
        // Added after the table shipped, so an existing control.db gains it here rather than in the
        // CREATE above. A SHA-256 of the silo's relay token; the token itself is only in its env.
        const columns = db.prepare("PRAGMA table_info(silos)").all() as { name: string }[]
        if (!columns.some((column) => column.name === "relay_token_hash")) {
            db.exec("ALTER TABLE silos ADD COLUMN relay_token_hash TEXT")
        }
        return new SiloStore(db)
    }

    get(subject: string): Silo | undefined {
        const row = this.#db.prepare("SELECT * FROM silos WHERE subject = ?").get(subject)
        return row === undefined || row === null ? undefined : toSilo(row as SiloRow)
    }

    list(): readonly Silo[] {
        return (
            this.#db.prepare("SELECT * FROM silos ORDER BY created_at, subject").all() as SiloRow[]
        ).map(toSilo)
    }

    insert(silo: Omit<Silo, "nextWakeAt">): void {
        this.#db
            .prepare(
                `INSERT INTO silos (subject, name, base_url, token, status, created_at, last_active_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                silo.subject,
                silo.name,
                silo.baseUrl,
                silo.token,
                silo.status,
                silo.createdAt,
                silo.lastActiveAt,
            )
    }

    setStatus(subject: string, status: SiloStatus, nextWakeAt?: string): void {
        this.#db
            .prepare("UPDATE silos SET status = ?, next_wake_at = ? WHERE subject = ?")
            .run(status, nextWakeAt ?? null, subject)
    }

    /** The address can move: a restarted Docker daemon re-publishes on a new host port. */
    setBaseUrl(subject: string, baseUrl: string): void {
        this.#db.prepare("UPDATE silos SET base_url = ? WHERE subject = ?").run(baseUrl, subject)
    }

    touch(subject: string, at: string): void {
        this.#db.prepare("UPDATE silos SET last_active_at = ? WHERE subject = ?").run(at, subject)
    }

    /** The silo's row and everything recorded about it: account deletion is total. */
    delete(subject: string): void {
        this.#db.prepare("DELETE FROM silos WHERE subject = ?").run(subject)
        this.#db.prepare("DELETE FROM hooks WHERE subject = ?").run(subject)
        this.#db.prepare("DELETE FROM monitor_events WHERE subject = ?").run(subject)
        this.#db.prepare("DELETE FROM person_links WHERE subject = ?").run(subject)
        this.#db
            .prepare("DELETE FROM relay_asks WHERE from_subject = ? OR to_subject = ?")
            .run(subject, subject)
    }

    // ─── the peer-ask relay ──────────────────────────────────────────────────────────────────

    setRelayTokenHash(subject: string, hash: string): void {
        this.#db
            .prepare("UPDATE silos SET relay_token_hash = ? WHERE subject = ?")
            .run(hash, subject)
    }

    /** The silo a relay token belongs to, by its hash. */
    siloByRelayHash(hash: string): Silo | undefined {
        const row = this.#db.prepare("SELECT * FROM silos WHERE relay_token_hash = ?").get(hash)
        return row === undefined || row === null ? undefined : toSilo(row as SiloRow)
    }

    link(principal: string, subject: string, participantId: string): void {
        this.#db
            .prepare(
                `INSERT INTO person_links (principal, subject, participant_id) VALUES (?, ?, ?)
                 ON CONFLICT (principal, subject) DO UPDATE SET participant_id = excluded.participant_id`,
            )
            .run(principal, subject, participantId)
    }

    unlink(principal: string, subject: string): boolean {
        const before = this.links(principal).length
        this.#db
            .prepare("DELETE FROM person_links WHERE principal = ? AND subject = ?")
            .run(principal, subject)
        return this.links(principal).length < before
    }

    links(principal: string): readonly { subject: string; participantId: string }[] {
        return (
            this.#db
                .prepare(
                    "SELECT subject, participant_id FROM person_links WHERE principal = ? ORDER BY subject",
                )
                .all(principal) as { subject: string; participant_id: string }[]
        ).map((row) => ({ subject: row.subject, participantId: row.participant_id }))
    }

    /** Whose a participant in a silo is, or `undefined` when nobody linked them. */
    principalOf(subject: string, participantId: string): string | undefined {
        const row = this.#db
            .prepare("SELECT principal FROM person_links WHERE subject = ? AND participant_id = ?")
            .get(subject, participantId) as { principal: string } | undefined | null
        return row?.principal ?? undefined
    }

    /** `undefined` for no override: the default applies. */
    personRate(principal: string): number | undefined {
        const row = this.#db
            .prepare("SELECT ask_rate_per_minute FROM people WHERE principal = ?")
            .get(principal) as { ask_rate_per_minute: number | null } | undefined | null
        return row?.ask_rate_per_minute ?? undefined
    }

    setPersonRate(principal: string, rate: number | null): void {
        this.#db
            .prepare(
                `INSERT INTO people (principal, ask_rate_per_minute) VALUES (?, ?)
                 ON CONFLICT (principal) DO UPDATE SET ask_rate_per_minute = excluded.ask_rate_per_minute`,
            )
            .run(principal, rate)
    }

    /** `undefined` until an operator sets one. */
    defaultRate(): number | undefined {
        const row = this.#db
            .prepare("SELECT ask_rate_per_minute FROM relay_config WHERE id = 1")
            .get() as { ask_rate_per_minute: number } | undefined | null
        return row?.ask_rate_per_minute ?? undefined
    }

    setDefaultRate(rate: number): void {
        this.#db
            .prepare(
                `INSERT INTO relay_config (id, ask_rate_per_minute) VALUES (1, ?)
                 ON CONFLICT (id) DO UPDATE SET ask_rate_per_minute = excluded.ask_rate_per_minute`,
            )
            .run(rate)
    }

    /** Written when the ask starts, so a burst counts against the limit before any of it finishes. */
    recordAsk(ask: {
        readonly at: string
        readonly principal: string
        readonly fromSubject: string
        readonly fromAgent: string
        readonly toSubject: string
        readonly toAgent: string
        readonly outcome: string
        readonly durationMs: number
    }): number {
        this.#db
            .prepare(
                `INSERT INTO relay_asks (at, principal, from_subject, from_agent, to_subject, to_agent, outcome, duration_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                ask.at,
                ask.principal,
                ask.fromSubject,
                ask.fromAgent,
                ask.toSubject,
                ask.toAgent,
                ask.outcome,
                ask.durationMs,
            )
        const row = this.#db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
        return row.id
    }

    finishAsk(id: number, outcome: string, durationMs: number): void {
        this.#db
            .prepare("UPDATE relay_asks SET outcome = ?, duration_ms = ? WHERE id = ?")
            .run(outcome, durationMs, id)
    }

    /** Asks by one person since an instant, oldest first: the sliding window the limit counts. */
    asksSince(principal: string, since: string): readonly string[] {
        return (
            this.#db
                .prepare("SELECT at FROM relay_asks WHERE principal = ? AND at >= ? ORDER BY at")
                .all(principal, since) as { at: string }[]
        ).map((row) => row.at)
    }

    // ─── the monitor's rows ──────────────────────────────────────────────────────────────────

    setHook(subject: string, subscriptionId: string, secret: string): void {
        this.#db
            .prepare(
                "INSERT OR REPLACE INTO hooks (subject, subscription_id, secret) VALUES (?, ?, ?)",
            )
            .run(subject, subscriptionId, secret)
    }

    deleteHook(subject: string): void {
        this.#db.prepare("DELETE FROM hooks WHERE subject = ?").run(subject)
    }

    hook(subject: string): { subscriptionId: string; secret: string } | undefined {
        const row = this.#db
            .prepare("SELECT subscription_id, secret FROM hooks WHERE subject = ?")
            .get(subject) as { subscription_id: string; secret: string } | undefined | null
        return row === undefined || row === null
            ? undefined
            : { subscriptionId: row.subscription_id, secret: row.secret }
    }

    /** False when this webhook id was already recorded — a retry, not a second event. */
    recordEvent(event: MonitorEvent): boolean {
        const before = this.#db
            .prepare("SELECT 1 FROM monitor_events WHERE webhook_id = ?")
            .get(event.webhookId)
        if (before !== undefined && before !== null) return false
        this.#db
            .prepare(
                `INSERT INTO monitor_events (webhook_id, subject, agent_id, type, turn_id, reason, steps,
                   duration_ms, first_token_ms, prompt_tokens, output_tokens, ok, detail, at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                event.webhookId,
                event.subject,
                event.agentId ?? null,
                event.type,
                event.turnId ?? null,
                event.reason ?? null,
                event.steps ?? null,
                event.durationMs ?? null,
                event.firstTokenMs ?? null,
                event.promptTokens ?? null,
                event.outputTokens ?? null,
                event.ok === undefined ? null : event.ok ? 1 : 0,
                event.detail ?? null,
                event.at,
            )
        return true
    }

    /** The newest `limit` events of a type, newest first, optionally for one silo. */
    events(type: string, limit: number, subject?: string): readonly MonitorEvent[] {
        const rows = (
            subject === undefined
                ? this.#db
                      .prepare(
                          "SELECT * FROM monitor_events WHERE type = ? ORDER BY id DESC LIMIT ?",
                      )
                      .all(type, limit)
                : this.#db
                      .prepare(
                          "SELECT * FROM monitor_events WHERE subject = ? AND type = ? ORDER BY id DESC LIMIT ?",
                      )
                      .all(subject, type, limit)
        ) as MonitorRow[]
        return rows.map(toEvent)
    }

    /** Events of a type recorded at or after `since` (an ISO time), optionally for one silo. */
    eventsSince(type: string, since: string, subject?: string): readonly MonitorEvent[] {
        const rows = (
            subject === undefined
                ? this.#db
                      .prepare(
                          "SELECT * FROM monitor_events WHERE type = ? AND at >= ? ORDER BY id",
                      )
                      .all(type, since)
                : this.#db
                      .prepare(
                          "SELECT * FROM monitor_events WHERE subject = ? AND type = ? AND at >= ? ORDER BY id",
                      )
                      .all(subject, type, since)
        ) as MonitorRow[]
        return rows.map(toEvent)
    }

    close(): void {
        this.#db.close()
    }
}
