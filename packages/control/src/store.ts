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
        `)
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
