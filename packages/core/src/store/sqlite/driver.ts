/**
 * The `bun:sqlite` / `node:sqlite` adapter — the only runtime-conditional code in the tree.
 *
 * The two modules are close enough to look interchangeable and differ in seven ways that all
 * produce the same bug: works under one runtime, misbehaves under the other, with the same
 * source and the same schema. Measured directly rather than read from docs:
 *
 * | | `bun:sqlite` | `node:sqlite` |
 * | --- | --- | --- |
 * | constructor | `Database` | `DatabaseSync` |
 * | `db.run` / `.query` / `.transaction` | present | absent |
 * | `get()` with no rows | `null` | `undefined` |
 * | row prototype | `Object.prototype` | null-prototype |
 * | binding `undefined` | accepted as NULL | throws |
 * | binding a boolean | accepted as 0/1 | throws |
 * | binding a string containing NUL | stored whole | **truncated at the NUL** |
 * | `PRAGMA foreign_keys` default | **off** | **on** |
 *
 * The pragma is the dangerous one, because it is silent in the permissive direction: with
 * foreign keys off, `ON DELETE CASCADE` does nothing and deleting a session leaves its messages
 * behind as orphans. Under `bun test` that passes; under `node --test` it does not. So the
 * driver sets the pragma explicitly instead of inheriting a default, and normalises the others
 * rather than passing them through. An adapter that leaks its differences is not one.
 *
 * **NUL is the exception, and is documented rather than normalised.** Escaping it would mean
 * transforming every bound string and untransforming every column read, on the hot path, for a
 * byte that does not occur in chat text. The cost of the exception is real and was paid once
 * already: an outbox key built with a NUL separator round-tripped truncated under Node, matched
 * nothing, and abandoned no chunks — no error, on one runtime out of two. Anything used as a
 * *key* must therefore be printable; `channels/outbox.ts` percent-encodes for exactly this reason.
 * A NUL inside message content is still truncated under Node and stored under Bun, which is a
 * known and deliberate divergence rather than a handled one.
 */

import { HarnessError } from "../../errors.ts"

/** What SQLite can actually store. Booleans and `undefined` are normalised before binding. */
export type SqlValue = string | number | bigint | Uint8Array | null

/** What callers may pass. The driver narrows this to `SqlValue`. */
export type SqlParam = SqlValue | boolean | undefined

export interface SqlRunResult {
    readonly changes: number
    readonly lastInsertRowid: number
}

export interface SqlStatement {
    run(...params: readonly SqlParam[]): SqlRunResult
    all<TRow>(...params: readonly SqlParam[]): TRow[]
    /** `undefined` when no row matched, on both runtimes. */
    get<TRow>(...params: readonly SqlParam[]): TRow | undefined
}

export interface SqlDatabase {
    /** Runs one or more statements with no parameters and no result. */
    exec(sql: string): void
    prepare(sql: string): SqlStatement
    /** Runs `work` in a transaction, rolling back if it throws. Not reentrant. */
    transaction<T>(work: () => T): T
    close(): void
    /** `":memory:"` or an absolute path. */
    readonly location: string
    /** Which module backs this handle, for diagnostics. */
    readonly runtime: "bun" | "node"
}

// ─── The two shapes we adapt ─────────────────────────────────────────────────────────────

interface NativeStatement {
    run(...params: readonly SqlValue[]): {
        changes?: number | bigint
        lastInsertRowid?: number | bigint
    }
    all(...params: readonly SqlValue[]): unknown[]
    get(...params: readonly SqlValue[]): unknown
}

interface NativeDatabase {
    exec(sql: string): void
    prepare(sql: string): NativeStatement
    close(): void
}

type NativeConstructor = new (path: string) => NativeDatabase

export interface OpenOptions {
    /** `":memory:"` for an anonymous database. Any other value is treated as a file path. */
    readonly path: string
    /**
     * Milliseconds a blocked writer waits for a lock before giving up. Without this, a second
     * process touching the same file fails instantly with SQLITE_BUSY.
     */
    readonly busyTimeoutMs?: number
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000

function isBun(): boolean {
    return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
}

/**
 * Normalise one bound parameter.
 *
 * `undefined` becomes NULL because `exactOptionalPropertyTypes` makes absent optional fields
 * genuinely `undefined`, and mapping those onto nullable columns is the normal case rather than
 * a mistake. Booleans become 0/1 because SQLite has no boolean type. Both conversions are
 * explicit here so that the two runtimes agree; the alternative is Bun quietly accepting what
 * Node rejects, which turns a local pass into a CI failure.
 */
function normalise(param: SqlParam, index: number, sql: string): SqlValue {
    if (param === undefined) return null
    if (typeof param === "boolean") return param ? 1 : 0
    if (
        param === null ||
        typeof param === "string" ||
        typeof param === "number" ||
        typeof param === "bigint" ||
        param instanceof Uint8Array
    ) {
        return param
    }
    throw new HarnessError({
        code: "store_bind_unsupported",
        message: `Cannot bind ${describe(param)} as parameter ${index + 1} of: ${trim(sql)}`,
        hint: 'SQLite stores text, numbers, blobs, and NULL. Serialise objects and arrays to JSON before binding — an implicit stringify would store "[object Object]" and lose the data silently.',
    })
}

function describe(value: unknown): string {
    if (value === null) return "null"
    if (Array.isArray(value)) return "an array"
    if (typeof value === "object") return `a ${(value as object).constructor?.name ?? "object"}`
    return `a ${typeof value}`
}

function trim(sql: string): string {
    const flat = sql.replace(/\s+/g, " ").trim()
    return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

function toCount(value: number | bigint | undefined): number {
    if (value === undefined) return 0
    return typeof value === "bigint" ? Number(value) : value
}

/**
 * Open a database, run the pragmas both runtimes must agree on, and return the adapted handle.
 *
 * Async only because the module import is conditional. No network, no filesystem work beyond
 * opening the file, so this is safe to call before `runtime.ready`.
 */
export async function openDatabase(options: OpenOptions): Promise<SqlDatabase> {
    const runtime = isBun() ? "bun" : "node"
    const specifier = runtime === "bun" ? "bun:sqlite" : "node:sqlite"

    let native: NativeDatabase
    try {
        // The specifier is a variable so no bundler tries to resolve both branches.
        const mod = (await import(specifier)) as Record<string, unknown>
        const Ctor = (runtime === "bun" ? mod.Database : mod.DatabaseSync) as
            | NativeConstructor
            | undefined
        if (typeof Ctor !== "function") {
            throw new Error(`${specifier} does not export the expected constructor`)
        }
        native = new Ctor(options.path)
    } catch (cause) {
        throw new HarnessError({
            code: "store_open_failed",
            message: `Cannot open the SQLite database at ${options.path} using ${specifier}.`,
            hint:
                runtime === "node"
                    ? "node:sqlite needs Node 22.5 or newer, and this project's floor is 24 — check `node --version` first. Otherwise check the path is writable and its parent directory exists; the runtime creates the directory but not a missing mount."
                    : "Check the path is writable and its parent directory exists.",
            cause,
        })
    }

    const db: SqlDatabase = {
        location: options.path,
        runtime,

        exec(sql: string): void {
            native.exec(sql)
        },

        prepare(sql: string): SqlStatement {
            const stmt = native.prepare(sql)
            const bind = (params: readonly SqlParam[]): SqlValue[] =>
                params.map((param, index) => normalise(param, index, sql))

            return {
                run(...params: readonly SqlParam[]): SqlRunResult {
                    const result = stmt.run(...bind(params))
                    return {
                        changes: toCount(result.changes),
                        lastInsertRowid: toCount(result.lastInsertRowid),
                    }
                },
                all<TRow>(...params: readonly SqlParam[]): TRow[] {
                    return stmt.all(...bind(params)) as TRow[]
                },
                get<TRow>(...params: readonly SqlParam[]): TRow | undefined {
                    // Bun returns null for a miss, Node returns undefined. One answer out.
                    const row = stmt.get(...bind(params))
                    return row === null || row === undefined ? undefined : (row as TRow)
                },
            }
        },

        transaction<T>(work: () => T): T {
            // Hand-rolled rather than using Bun's `db.transaction()`, which node:sqlite has no
            // equivalent for. BEGIN/COMMIT via exec is the intersection.
            native.exec("BEGIN")
            try {
                const result = work()
                native.exec("COMMIT")
                return result
            } catch (error) {
                try {
                    native.exec("ROLLBACK")
                } catch {
                    // A failed rollback means the transaction was already resolved — usually
                    // because `work` itself committed. The original error is the useful one.
                }
                throw error
            }
        },

        close(): void {
            native.close()
        },
    }

    // Foreign keys are OFF by default in bun:sqlite and ON in node:sqlite. Set explicitly so
    // ON DELETE CASCADE behaves the same under `bun test` and `node --test`.
    db.exec("PRAGMA foreign_keys = ON")

    // SQLite takes no bound parameter in a PRAGMA, so the value is interpolated — and therefore
    // forced through an integer parse first. Every interpolation into SQL in this file goes
    // through the same narrowing.
    const busyTimeout = Number.parseInt(
        String(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS),
        10,
    )
    db.exec(
        `PRAGMA busy_timeout = ${Number.isSafeInteger(busyTimeout) && busyTimeout >= 0 ? busyTimeout : DEFAULT_BUSY_TIMEOUT_MS}`,
    )

    if (options.path !== ":memory:") {
        // WAL lets a reader run while a writer holds the file, which is what makes a second
        // process able to inspect sessions during a live turn. Meaningless for :memory:.
        db.exec("PRAGMA journal_mode = WAL")
        db.exec("PRAGMA synchronous = NORMAL")
    }

    return db
}

/** Read `PRAGMA user_version`, the migration counter. */
export function userVersion(db: SqlDatabase): number {
    const row = db.prepare("PRAGMA user_version").get<{ user_version: number }>()
    return row?.user_version ?? 0
}

/**
 * Write `PRAGMA user_version`.
 *
 * Interpolated rather than bound because SQLite does not accept a parameter in a PRAGMA, and
 * coerced through `Number.parseInt` so the interpolation cannot carry anything but an integer.
 */
export function setUserVersion(db: SqlDatabase, version: number): void {
    const safe = Number.parseInt(String(version), 10)
    if (!Number.isSafeInteger(safe) || safe < 0) {
        throw new HarnessError({
            code: "store_bad_user_version",
            message: `Refusing to set user_version to ${String(version)}.`,
            hint: "The migration counter is a non-negative integer. This is a bug in the migration list, not in a manifest.",
        })
    }
    db.exec(`PRAGMA user_version = ${safe}`)
}
