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

    delete(subject: string): void {
        this.#db.prepare("DELETE FROM silos WHERE subject = ?").run(subject)
    }

    close(): void {
        this.#db.close()
    }
}
