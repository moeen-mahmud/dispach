/**
 * Store, driver, and migration behaviour.
 *
 * This file imports `./_harness.ts` rather than `bun:test` so it runs under `bun test` *and*
 * `node --test`. That is the whole point: the adapter's job is to make two different SQLite
 * bindings behave identically, and the only way to demonstrate that is to run the same
 * assertions against both. A green run under one runner proves nothing about the other.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatSessionKey, isSessionKey, parseSessionKey } from "../src/store/session-key.ts"
import { openDatabase, userVersion } from "../src/store/sqlite/driver.ts"
import { MIGRATIONS, migrate } from "../src/store/sqlite/migrations.ts"
import {
    MEMORY_CANDIDATES_SQL,
    MEMORY_DF_SQL,
    openMemoryStore,
    SqliteStore,
} from "../src/store/sqlite/store.ts"
import { describe, expect, runner, test } from "./_harness.ts"

const AGENT = "assistant"
const KEY = "local:default"

function tempDb(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "store-test-"))
    return {
        path: join(dir, "store.db"),
        cleanup: () => {
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

describe("session keys", () => {
    test("splits channel, peer and thread", () => {
        expect(parseSessionKey("telegram:12345")).toEqual({ channel: "telegram", peerId: "12345" })
        expect(parseSessionKey("telegram:12345:99")).toEqual({
            channel: "telegram",
            peerId: "12345",
            thread: "99",
        })
    })

    test("a thread containing a colon round-trips", () => {
        const parts = parseSessionKey("telegram:123:topic:9")
        expect(parts.thread).toBe("topic:9")
        expect(formatSessionKey(parts)).toBe("telegram:123:topic:9")
    })

    test("refuses a key with no channel segment", () => {
        expect(() => parseSessionKey("nocolon")).toThrow("no channel segment")
        expect(isSessionKey("nocolon")).toBe(false)
    })

    test("refuses empty and non-slug segments", () => {
        expect(() => parseSessionKey("telegram:")).toThrow("empty peer segment")
        expect(() => parseSessionKey("Telegram:1")).toThrow("invalid channel segment")
        expect(() => parseSessionKey("1telegram:1")).toThrow("invalid channel segment")
        expect(() => parseSessionKey(":1")).toThrow("invalid channel segment")
    })

    test("the default session key is itself well formed", () => {
        expect(isSessionKey("local:default")).toBe(true)
    })
})

describe("driver", () => {
    test("reports which binding it is using", async () => {
        const db = await openDatabase({ path: ":memory:" })
        expect(db.runtime).toBe(runner)
        db.close()
    })

    test("foreign keys are on regardless of the binding's default", async () => {
        // bun:sqlite defaults this off and node:sqlite defaults it on. Without the explicit
        // pragma, ON DELETE CASCADE would be a no-op under Bun and work under Node.
        const db = await openDatabase({ path: ":memory:" })
        const row = db.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>()
        expect(row?.foreign_keys).toBe(1)
        db.close()
    })

    test("get() returns undefined for a miss on both bindings", async () => {
        // Bun returns null here, Node returns undefined.
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT)")
        expect(db.prepare("SELECT * FROM t WHERE a = ?").get("nope")).toBeUndefined()
        db.close()
    })

    test("binds undefined as NULL and booleans as 0/1", async () => {
        // node:sqlite throws on both; bun:sqlite accepts both. The adapter picks one behaviour.
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT, b INTEGER, c INTEGER)")
        db.prepare("INSERT INTO t (a, b, c) VALUES (?, ?, ?)").run(undefined, true, false)
        expect(db.prepare("SELECT * FROM t").get()).toEqual({ a: null, b: 1, c: 0 })
        db.close()
    })

    test("refuses to bind a value SQLite cannot store", async () => {
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT)")
        const insert = db.prepare("INSERT INTO t (a) VALUES (?)")
        // An implicit stringify would store "[object Object]" and lose the data silently.
        expect(() => insert.run({ nested: true } as unknown as string)).toThrow("Cannot bind")
        db.close()
    })

    test("run() reports changes and lastInsertRowid as numbers", async () => {
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)")
        const result = db.prepare("INSERT INTO t (a) VALUES (?)").run("x")
        expect(result.changes).toBe(1)
        expect(result.lastInsertRowid).toBe(1)
        expect(typeof result.lastInsertRowid).toBe("number")
        db.close()
    })

    test("a transaction rolls back on throw", async () => {
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT)")
        const insert = db.prepare("INSERT INTO t (a) VALUES (?)")
        expect(() =>
            db.transaction(() => {
                insert.run("kept?")
                throw new Error("nope")
            }),
        ).toThrow("nope")
        expect(db.prepare("SELECT COUNT(*) AS c FROM t").get<{ c: number }>()?.c).toBe(0)
        db.close()
    })
})

describe("migrations", () => {
    test("a fresh database migrates to the current version", async () => {
        const db = await openDatabase({ path: ":memory:" })
        expect(userVersion(db)).toBe(0)
        const report = migrate(db)
        expect(report.from).toBe(0)
        expect(report.to).toBe(MIGRATIONS.length)
        expect(report.applied.length).toBe(MIGRATIONS.length)
        db.close()
    })

    test("a second run applies nothing", async () => {
        const db = await openDatabase({ path: ":memory:" })
        migrate(db)
        const second = migrate(db)
        expect(second.applied).toEqual([])
        expect(second.from).toBe(MIGRATIONS.length)
        expect(second.to).toBe(MIGRATIONS.length)
        db.close()
    })

    test("reopening a file runs no migrations the second time", async () => {
        const { path, cleanup } = tempDb()
        try {
            const first = await SqliteStore.open({ path })
            expect(first.migrations.applied.length).toBe(MIGRATIONS.length)
            await first.close()

            const second = await SqliteStore.open({ path })
            expect(second.migrations.applied).toEqual([])
            expect(second.migrations.from).toBe(MIGRATIONS.length)
            await second.close()
        } finally {
            cleanup()
        }
    })

    test("refuses a database written by a newer build", async () => {
        const { path, cleanup } = tempDb()
        try {
            const db = await openDatabase({ path })
            db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`)
            db.close()
            await expect(SqliteStore.open({ path })).rejects.toThrow("only knows")
        } finally {
            cleanup()
        }
    })

    test("migration versions are contiguous", () => {
        for (const [index, migration] of MIGRATIONS.entries()) {
            expect(migration.version).toBe(index + 1)
        }
    })

    test("message taint migration preserves old prose and defaults it clean", async () => {
        const { path, cleanup } = tempDb()
        try {
            const db = await openDatabase({ path })
            for (const migration of MIGRATIONS.slice(0, -1)) db.exec(migration.sql)
            db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`)
            db.prepare(
                `INSERT INTO sessions
                     (agent_id, session_key, channel, peer_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(AGENT, KEY, "local", "default", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z")
            db.prepare(
                `INSERT INTO messages (agent_id, session_key, role, content, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            ).run(AGENT, KEY, "assistant", "old clean prose", "2026-08-01T00:00:00Z")
            db.close()

            const store = await SqliteStore.open({ path })
            expect(store.migrations.applied).toEqual(["8_message_taint"])
            expect((await store.messages.history(AGENT, KEY))[0]?.tainted).toBeUndefined()
            await store.close()
        } finally {
            cleanup()
        }
    })
})

describe("sessions", () => {
    test("ensure is idempotent", async () => {
        const store = await openMemoryStore()
        const first = await store.sessions.ensure(AGENT, KEY)
        const second = await store.sessions.ensure(AGENT, KEY)
        expect(second.createdAt).toBe(first.createdAt)
        expect(first.channel).toBe("local")
        expect(first.peerId).toBe("default")
        expect(first.thread).toBeUndefined()
        await store.close()
    })

    test("stores the parsed thread segment", async () => {
        const store = await openMemoryStore()
        const session = await store.sessions.ensure(AGENT, "telegram:123:topic:9")
        expect(session.thread).toBe("topic:9")
        await store.close()
    })

    test("a malformed key is refused at the boundary", async () => {
        const store = await openMemoryStore()
        await expect(store.sessions.ensure(AGENT, "nocolon")).rejects.toThrow("no channel segment")
        await store.close()
    })

    test("list reports message and turn counts", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [{ role: "user", content: "a" }])
        await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "test",
            input: "a",
        })
        const list = await store.sessions.list(AGENT)
        expect(list.length).toBe(1)
        expect(list[0]?.messages).toBe(1)
        expect(list[0]?.turns).toBe(1)
        await store.close()
    })

    test("sessions are scoped per agent", async () => {
        const store = await openMemoryStore()
        await store.messages.append("a", KEY, [{ role: "user", content: "for a" }])
        await store.messages.append("b", KEY, [{ role: "user", content: "for b" }])
        expect((await store.messages.history("a", KEY)).map((m) => m.content)).toEqual(["for a"])
        expect((await store.messages.history("b", KEY)).map((m) => m.content)).toEqual(["for b"])
        await store.close()
    })

    test("clear empties history but keeps the session", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [{ role: "user", content: "a" }])
        await store.sessions.clear(AGENT, KEY)
        expect(await store.messages.count(AGENT, KEY)).toBe(0)
        expect(await store.sessions.get(AGENT, KEY)).toBeDefined()
        await store.close()
    })

    test("delete cascades to messages and turns", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [{ role: "user", content: "a" }])
        await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "test",
            input: "a",
        })
        await store.sessions.delete(AGENT, KEY)
        expect(await store.messages.count(AGENT, KEY)).toBe(0)
        expect(await store.turns.get("t_1")).toBeUndefined()
        await store.close()
    })

    test("phase round-trips", async () => {
        const store = await openMemoryStore()
        await store.sessions.setPhase(AGENT, KEY, "triage")
        expect((await store.sessions.get(AGENT, KEY))?.phase).toBe("triage")
        await store.sessions.setPhase(AGENT, KEY, undefined)
        expect((await store.sessions.get(AGENT, KEY))?.phase).toBeUndefined()
        await store.close()
    })
})

describe("messages", () => {
    test("history is oldest-first and limit keeps the newest", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [
            { role: "user", content: "1" },
            { role: "assistant", content: "2" },
            { role: "user", content: "3" },
        ])
        expect((await store.messages.history(AGENT, KEY)).map((m) => m.content)).toEqual([
            "1",
            "2",
            "3",
        ])
        expect((await store.messages.history(AGENT, KEY, 2)).map((m) => m.content)).toEqual([
            "2",
            "3",
        ])
        await store.close()
    })

    test("appending an empty list writes nothing", async () => {
        const store = await openMemoryStore()
        expect(await store.messages.append(AGENT, KEY, [])).toEqual([])
        expect(await store.sessions.get(AGENT, KEY)).toBeUndefined()
        await store.close()
    })

    test("append creates the session, so a foreign key is never the caller's problem", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, "api:moeen", [{ role: "user", content: "hi" }])
        expect(await store.sessions.get(AGENT, "api:moeen")).toBeDefined()
        await store.close()
    })

    test("paging walks backwards and stops", async () => {
        const store = await openMemoryStore()
        await store.messages.append(
            AGENT,
            KEY,
            [1, 2, 3, 4, 5].map((n) => ({ role: "user" as const, content: String(n) })),
        )

        const first = await store.messages.page(AGENT, KEY, { limit: 2 })
        expect(first.messages.map((m) => m.content)).toEqual(["5", "4"])
        expect(first.nextBefore).toBeDefined()

        const second = await store.messages.page(AGENT, KEY, {
            limit: 2,
            before: first.nextBefore,
        })
        expect(second.messages.map((m) => m.content)).toEqual(["3", "2"])

        const third = await store.messages.page(AGENT, KEY, {
            limit: 2,
            before: second.nextBefore,
        })
        expect(third.messages.map((m) => m.content)).toEqual(["1"])
        expect(third.nextBefore).toBeUndefined()
        await store.close()
    })

    test("the turn id travels with the messages", async () => {
        const store = await openMemoryStore()
        const stored = await store.messages.append(
            AGENT,
            KEY,
            [{ role: "user", content: "hi" }],
            "t_7",
        )
        expect(stored[0]?.turnId).toBe("t_7")
        await store.close()
    })

    test("taint survives both stored-message and model-history reads", async () => {
        const store = await openMemoryStore()
        const stored = await store.messages.append(AGENT, KEY, [
            { role: "assistant", content: "derived from a page", tainted: true },
        ])

        expect(stored[0]?.tainted).toBe(true)
        expect((await store.messages.page(AGENT, KEY)).messages[0]?.tainted).toBe(true)
        expect((await store.messages.history(AGENT, KEY))[0]?.tainted).toBe(true)
        await store.close()
    })
})

describe("turns", () => {
    test("start writes a running row before any model call", async () => {
        const store = await openMemoryStore()
        const turn = await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "hello",
        })
        expect(turn.status).toBe("running")
        expect(turn.endedAt).toBeUndefined()
        expect(turn.input).toBe("hello")
        await store.close()
    })

    test("finish records the outcome and its error detail", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })
        await store.turns.finish("t_1", {
            status: "error",
            text: "",
            reasoning: "",
            steps: 1,
            promptTokens: 10,
            outputTokens: 0,
            durationMs: 42,
            errorCode: "empty_reply_output_exhausted",
            errorMessage: "no text",
            errorHint: "raise reserveOutput",
        })
        const turn = await store.turns.get("t_1")
        expect(turn?.status).toBe("error")
        expect(turn?.errorCode).toBe("empty_reply_output_exhausted")
        expect(turn?.errorHint).toBe("raise reserveOutput")
        expect(turn?.durationMs).toBe(42)
        expect(turn?.endedAt).toBeDefined()
        await store.close()
    })

    test("timeout and max_steps survive as themselves", async () => {
        // The loop deliberately keeps these distinct from `error`; flattening them here would
        // discard the diagnosis one layer below where it was made.
        const store = await openMemoryStore()
        for (const status of ["timeout", "max_steps", "stopped"] as const) {
            await store.turns.start({
                turnId: status,
                agentId: AGENT,
                sessionKey: KEY,
                source: "test",
                input: "x",
            })
            await store.turns.finish(status, {
                status,
                text: "",
                reasoning: "",
                steps: 1,
                promptTokens: 0,
                outputTokens: 0,
                durationMs: 1,
            })
            expect((await store.turns.get(status))?.status).toBe(status)
        }
        await store.close()
    })

    test("reapRunning marks abandoned turns and is idempotent", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_live",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })

        const reaped = await store.turns.reapRunning([AGENT], "test")
        expect(reaped).toEqual(["t_live"])

        const turn = await store.turns.get("t_live")
        expect(turn?.status).toBe("error")
        expect(turn?.errorCode).toBe("turn_abandoned")
        expect(turn?.errorHint).toContain("cannot be resumed")

        expect(await store.turns.reapRunning([AGENT], "test")).toEqual([])
        await store.close()
    })

    test("a finished turn is not reaped", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_done",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })
        await store.turns.finish("t_done", {
            status: "final",
            text: "hi",
            reasoning: "",
            steps: 1,
            promptTokens: 1,
            outputTokens: 1,
            durationMs: 1,
        })
        expect(await store.turns.reapRunning([AGENT], "test")).toEqual([])
        expect((await store.turns.get("t_done"))?.status).toBe("final")
        await store.close()
    })

    /**
     * The regression the whole lease exists for.
     *
     * Unfiltered, this call marked *every* running turn in the database failed. One process on one
     * file makes that correct; two processes sharing a file makes it a live turn reported as dead,
     * with the row's own error text claiming the process had exited. Nothing failed, nothing was
     * logged, and the only evidence was a turn record nobody reads.
     */
    test("reapRunning leaves another agent's running turn alone", async () => {
        const store = await openMemoryStore()
        for (const [id, agent] of [
            ["t_mine", AGENT],
            ["t_theirs", "other"],
        ] as const) {
            await store.turns.start({
                turnId: id,
                agentId: agent,
                sessionKey: KEY,
                source: "repl",
                input: "x",
            })
        }

        expect(await store.turns.reapRunning([AGENT], "test")).toEqual(["t_mine"])
        expect((await store.turns.get("t_theirs"))?.status).toBe("running")
        // And an empty list is not "everything" — the shape a careless default would take.
        expect(await store.turns.reapRunning([], "test")).toEqual([])
        expect((await store.turns.get("t_theirs"))?.status).toBe("running")
        await store.close()
    })

    test("a duplicate turn id is refused rather than overwriting", async () => {
        const store = await openMemoryStore()
        const record = {
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        }
        await store.turns.start(record)
        // Both bindings surface SQLite's own text here, which is the same even though the error
        // class and `code` around it differ.
        await expect(store.turns.start(record)).rejects.toThrow("constraint failed")
        await store.close()
    })
})

describe("runtime leases", () => {
    const T0 = "2026-08-17T02:00:00.000Z"
    const T1 = "2026-08-17T02:00:30.000Z"

    function claim(runtimeId: string, pid: number, now: string, stealFrom?: string) {
        return {
            agentId: AGENT,
            runtimeId,
            pid,
            mode: "terminal" as const,
            now,
            ...(stealFrom === undefined ? {} : { stealFrom }),
        }
    }

    test("the first claim wins and the second is refused, naming the holder", async () => {
        const store = await openMemoryStore()
        const first = await store.leases.claim(claim("rt_a", 100, T0))
        expect(first.ok).toBe(true)

        const second = await store.leases.claim(claim("rt_b", 200, T1))
        expect(second.ok).toBe(false)
        // The refusal has to carry enough for a person to act: which process, and since when.
        if (!second.ok) {
            expect(second.held.pid).toBe(100)
            expect(second.held.runtimeId).toBe("rt_a")
            expect(second.held.startedAt).toBe(T0)
        }
        await store.close()
    })

    test("re-claiming your own lease is not a conflict", async () => {
        const store = await openMemoryStore()
        await store.leases.claim(claim("rt_a", 100, T0))
        const again = await store.leases.claim(claim("rt_a", 100, T1))
        expect(again.ok).toBe(true)
        // Not reported as a takeover — you cannot take over from yourself, and saying so would put
        // a spurious "recovered a dead process" line in front of a person on every restart.
        if (again.ok) expect(again.tookOver).toBeUndefined()
        await store.close()
    })

    test("a lease is taken over only from the holder the caller probed", async () => {
        const store = await openMemoryStore()
        await store.leases.claim(claim("rt_a", 100, T0))

        // The caller established rt_a is dead — but by the time it claims, rt_c holds the lease.
        // Stealing here would evict a process that has only just legitimately started, which is
        // exactly the double-poller the lease exists to prevent.
        await store.leases.claim(claim("rt_c", 300, T1, "rt_a"))
        const stale = await store.leases.claim(claim("rt_b", 200, T1, "rt_a"))
        expect(stale.ok).toBe(false)

        const fresh = await store.leases.claim(claim("rt_b", 200, T1, "rt_c"))
        expect(fresh.ok).toBe(true)
        if (fresh.ok) expect(fresh.tookOver?.runtimeId).toBe("rt_c")
        await store.close()
    })

    test("release frees it, and only for the holder", async () => {
        const store = await openMemoryStore()
        await store.leases.claim(claim("rt_a", 100, T0))
        await store.leases.release(AGENT, "rt_b")
        expect((await store.leases.get(AGENT))?.runtimeId).toBe("rt_a")

        await store.leases.release(AGENT, "rt_a")
        expect(await store.leases.get(AGENT)).toBeUndefined()
        expect(await store.leases.all()).toEqual([])
        await store.close()
    })

    test("beat refreshes the holder and is a no-op for anyone else", async () => {
        const store = await openMemoryStore()
        await store.leases.claim(claim("rt_a", 100, T0))
        expect(await store.leases.beat(AGENT, "rt_b", T1)).toBe(false)
        expect((await store.leases.get(AGENT))?.heartbeatAt).toBe(T0)

        expect(await store.leases.beat(AGENT, "rt_a", T1)).toBe(true)
        expect((await store.leases.get(AGENT))?.heartbeatAt).toBe(T1)
        await store.close()
    })

    /**
     * Scoping recovery to leaseholders means a deleted or renamed agent's rows are nobody's to
     * reap — which is the exact ambiguity `reapRunning` exists to remove, reintroduced by the fix
     * for a different bug. `orphans` is what keeps the narrowing honest.
     */
    test("orphans names agents with running rows and no lease", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_ghost",
            agentId: "deleted-agent",
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })
        await store.turns.start({
            turnId: "t_held",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })
        await store.leases.claim(claim("rt_a", 100, T0))

        expect(await store.leases.orphans()).toEqual(["deleted-agent"])
        await store.close()
    })
})

describe("the memory queries are driven by the FTS index", () => {
    // Two assertions, and the second is the one that fires.
    //
    // Not a timing test: that would have to be generous enough to pass on a loaded runner, while the
    // plan is deterministic. The bad shape is the FTS table reported with an `=` in its index string
    // (`INDEX 0:=M1`) — SQLite saying it will probe the virtual table once per row of the *other*
    // table instead of scanning it once. Measured at 260 ms against 0.7 ms over 5,000 passages.
    //
    // But **the plan check cannot fail on either runner CI now runs**: bun 1.3.5 bundles SQLite
    // 3.51.0 and node 24 bundles 3.53.3, and both choose correctly without the `+`. The only version
    // measured to get it wrong is 3.51.3, in the node 22 that decision 13.5 just dropped from the
    // matrix — so the plan assertion documents the claim and cannot go red anywhere. That is the
    // "passes with the fix reverted" shape this repo has been caught by three times, which is why the
    // `+` is asserted in the SQL text as well. Pinning that much syntax is the price of a guard that
    // still holds once the version that found the bug is gone.
    test.each([
        ["memoryDf", MEMORY_DF_SQL, ['"a"', AGENT]],
        ["memoryCandidates", MEMORY_CANDIDATES_SQL, ['"a"', AGENT, 5]],
    ] as [string, string, (string | number)[]][])(
        "%s scans the virtual table rather than probing it per row",
        async (_name, sql, params) => {
            expect(sql).toContain("+p.agent_id = ?")

            const db = await openDatabase({ path: ":memory:" })
            migrate(db)
            const plan = db
                .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all<{ detail: string }>(...params)
                .map((row) => row.detail)
            db.close()

            const virtual = plan.find((line) => line.includes("VIRTUAL TABLE"))
            expect(virtual).toBeDefined()
            expect(String(virtual)).toContain("SCAN")
            expect(String(virtual)).not.toContain(":=")
            // First, or something other than the index is driving the join.
            expect(plan[0]).toBe(virtual)
        },
    )
})

describe("kv", () => {
    test("set, get, upsert, delete", async () => {
        const store = await openMemoryStore()
        expect(await store.kv.get("scope", "missing")).toBeUndefined()
        await store.kv.set("scope", "k", "one")
        expect(await store.kv.get("scope", "k")).toBe("one")
        await store.kv.set("scope", "k", "two")
        expect(await store.kv.get("scope", "k")).toBe("two")
        await store.kv.delete("scope", "k")
        expect(await store.kv.get("scope", "k")).toBeUndefined()
        await store.close()
    })

    test("scopes do not collide", async () => {
        const store = await openMemoryStore()
        await store.kv.set("a", "k", "1")
        await store.kv.set("b", "k", "2")
        expect(await store.kv.all("a")).toEqual({ k: "1" })
        expect(await store.kv.all("b")).toEqual({ k: "2" })
        await store.close()
    })
})

describe("persistence across processes", () => {
    test("history survives closing and reopening the file", async () => {
        const { path, cleanup } = tempDb()
        try {
            const first = await SqliteStore.open({ path })
            await first.messages.append(AGENT, KEY, [
                { role: "user", content: "my name is Moeen" },
                { role: "assistant", content: "noted" },
            ])
            await first.close()

            const second = await SqliteStore.open({ path })
            expect((await second.messages.history(AGENT, KEY)).map((m) => m.content)).toEqual([
                "my name is Moeen",
                "noted",
            ])
            await second.close()
        } finally {
            cleanup()
        }
    })

    test("close is idempotent", async () => {
        const store = await openMemoryStore()
        await store.close()
        await store.close()
    })
})

describe("native tool calls survive the round trip", () => {
    /**
     * The regression this locks down was found live, not reasoned about. `messages` allowed the `tool`
     * role from migration 1 but had nowhere to put the call ids, so a resumed native session read back
     * an assistant turn with empty content and no calls, and a `tool` message answering nothing.
     * qwen3.5:9b via Ollama accepted that trace and replied anyway — a strict endpoint would 400, and
     * the lenient one just quietly denied the model any record of what it had called.
     */
    const TRACE = [
        { role: "user" as const, content: "what time is it?" },
        {
            role: "assistant" as const,
            content: "",
            toolCalls: [{ id: "call_1", name: "now", arguments: '{"timezone":"UTC"}' }],
        },
        { role: "tool" as const, content: "13:48 UTC", toolCallId: "call_1" },
        { role: "assistant" as const, content: "It is 13:48 UTC." },
    ]

    test("history reads back exactly what was appended", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure("a", "local:x")
        await store.messages.append("a", "local:x", TRACE, "t1")
        expect(await store.messages.history("a", "local:x")).toEqual(TRACE)
        await store.close()
    })

    test("a tail read carries them too — every SELECT, not just the full one", async () => {
        // The failure mode being guarded: one query updated and the others not. `history` with a limit
        // is a different statement from `history` without one.
        const store = await openMemoryStore()
        await store.sessions.ensure("a", "local:x")
        await store.messages.append("a", "local:x", TRACE, "t1")
        const tail = await store.messages.history("a", "local:x", 3)
        expect(tail.length).toBe(3)
        expect(tail[0]?.toolCalls?.[0]?.id).toBe("call_1")
        expect(tail[1]?.toolCallId).toBe("call_1")
        await store.close()
    })

    test("the paged read surfaces them as well", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure("a", "local:x")
        await store.messages.append("a", "local:x", TRACE, "t1")
        const page = await store.messages.page("a", "local:x", { limit: 10 })
        const observation = page.messages.find((message) => message.role === "tool")
        expect(observation?.toolCallId).toBe("call_1")
        await store.close()
    })

    test("an NLT trace stores no tool columns at all", async () => {
        // Both columns nullable and unused under NLT, where the call *is* the content.
        const store = await openMemoryStore()
        await store.sessions.ensure("a", "local:x")
        await store.messages.append(
            "a",
            "local:x",
            [{ role: "assistant", content: "ACTION: now\nEND" }],
            "t1",
        )
        expect(await store.messages.history("a", "local:x")).toEqual([
            { role: "assistant", content: "ACTION: now\nEND" },
        ])
        await store.close()
    })
})
