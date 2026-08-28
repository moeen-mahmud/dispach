/**
 * Who owns a schedule row, and who is allowed to delete it.
 *
 * The store is keyed by agent `id` and nothing else, so two directories declaring the same `id`
 * share every row. Reconciliation ends by dropping the manifest-owned schedules the manifest no
 * longer declares — which, before `sourcePath`, meant loading either manifest deleted the other's.
 * Measured on a real pair: a 15-minute schedule read `in 3m`, the row was deleted by a command run
 * against the sibling directory, and the next load re-created it reading `in 16m`. It never reached
 * its own due time, and nothing reported a fault, because each manifest was right about the rows it
 * could see.
 *
 * Against the real store, because the whole claim is about what survives a write.
 */

import { reconcileSchedules, scheduleRunOfSession } from "../src/runtime/schedules.ts"
import { SqliteStore } from "../src/store/sqlite/store.ts"
import type { Store } from "../src/store/store.ts"
import { describe, expect, test } from "./_harness.ts"

const AGENT = "milo"
const MINE = "/repo/milo/agent.yaml"
const THEIRS = "/home/me/.dispach/agents/milo/agent.yaml"
const NOW = Date.parse("2026-08-27T14:00:00.000Z")

async function freshStore(): Promise<Store> {
    return SqliteStore.open({ path: ":memory:" })
}

const every15 = {
    id: "hi-every-15",
    kind: "every" as const,
    expr: "15m",
    task: "Say exactly: hi",
    deliver: { channel: "tg", to: "1195568132" },
    session: "isolated",
    enabled: true,
}

describe("schedule provenance", () => {
    test("a sibling manifest with the same agent id does not delete this one's schedules", async () => {
        const store = await freshStore()
        await reconcileSchedules({
            agentId: AGENT,
            schedules: [every15],
            store: store.schedules,
            now: NOW,
            sourcePath: MINE,
        })
        const armed = await store.schedules.get(AGENT, every15.id)
        expect(armed?.nextRunAt).toBeDefined()

        // The sibling declares no schedules at all — which is what `dispach schedules milo`
        // resolving to the other directory does.
        const report = await reconcileSchedules({
            agentId: AGENT,
            schedules: [],
            store: store.schedules,
            now: NOW + 60_000,
            sourcePath: THEIRS,
        })

        expect(report.removed).toEqual([])
        const after = await store.schedules.get(AGENT, every15.id)
        expect(after?.nextRunAt).toBe(armed?.nextRunAt)
        // The anchor is the half that made this invisible: a deleted row comes back with a fresh
        // one, so the schedule silently restarts its interval instead of disappearing.
        expect(after?.anchorAt).toBe(armed?.anchorAt)
    })

    test("the owning manifest still removes a schedule it has dropped", async () => {
        const store = await freshStore()
        await reconcileSchedules({
            agentId: AGENT,
            schedules: [every15],
            store: store.schedules,
            now: NOW,
            sourcePath: MINE,
        })
        const report = await reconcileSchedules({
            agentId: AGENT,
            schedules: [],
            store: store.schedules,
            now: NOW + 60_000,
            sourcePath: MINE,
        })
        expect(report.removed).toEqual([every15.id])
        expect(await store.schedules.get(AGENT, every15.id)).toBeUndefined()
    })

    test("a row with no provenance is adopted by the first manifest to reconcile it", async () => {
        // Migration 9 leaves every existing row at `''`. The transition has to be self-cleaning:
        // adoptable once, and protected from every other manifest afterwards.
        const store = await freshStore()
        await store.schedules.upsert({
            agentId: AGENT,
            id: "legacy",
            kind: "cron",
            expr: "0 8 * * *",
            task: "written before migration 9",
            sessionMode: "isolated",
            enabled: true,
            origin: "manifest",
            sourcePath: "",
            anchorAt: "2026-08-28T08:00:00.000Z",
            nextRunAt: "2026-08-28T08:00:00.000Z",
            now: "2026-08-27T08:00:00.000Z",
        })

        await reconcileSchedules({
            agentId: AGENT,
            schedules: [{ ...every15, id: "legacy", kind: "cron", expr: "0 8 * * *" }],
            store: store.schedules,
            now: NOW,
            sourcePath: MINE,
        })
        expect((await store.schedules.get(AGENT, "legacy"))?.sourcePath).toBe(MINE)

        const report = await reconcileSchedules({
            agentId: AGENT,
            schedules: [],
            store: store.schedules,
            now: NOW + 1000,
            sourcePath: THEIRS,
        })
        expect(report.removed).toEqual([])
        expect(await store.schedules.get(AGENT, "legacy")).toBeDefined()
    })

    test("an API row is untouched by any manifest, whatever its path", async () => {
        const store = await freshStore()
        await store.schedules.upsert({
            agentId: AGENT,
            id: "by-api",
            kind: "every",
            expr: "1h",
            task: "created through the API",
            sessionMode: "isolated",
            enabled: true,
            origin: "api",
            sourcePath: "",
            anchorAt: "2026-08-27T15:00:00.000Z",
            nextRunAt: "2026-08-27T15:00:00.000Z",
            now: "2026-08-27T14:00:00.000Z",
        })
        const report = await reconcileSchedules({
            agentId: AGENT,
            schedules: [],
            store: store.schedules,
            now: NOW,
            sourcePath: THEIRS,
        })
        expect(report.removed).toEqual([])
        expect(await store.schedules.get(AGENT, "by-api")).toBeDefined()
    })
})

describe("scheduleRunOfSession", () => {
    test("reads the schedule and run out of an isolated session key", () => {
        expect(scheduleRunOfSession("schedule:hi-every-15:r_abc123")).toEqual({
            id: "hi-every-15",
            runId: "r_abc123",
        })
    })

    test("declines a shared session, a channel session, and a malformed key", () => {
        // `shared:<key>` writes into a session the author named, so nothing about the run is
        // recoverable from it. A real limit, and it must not be guessed at.
        expect(scheduleRunOfSession("standup")).toBeUndefined()
        expect(scheduleRunOfSession("tg:1195568132")).toBeUndefined()
        expect(scheduleRunOfSession("schedule:hi-every-15")).toBeUndefined()
        expect(scheduleRunOfSession("no-colon-at-all")).toBeUndefined()
    })
})

describe("a delivery failure reaches the schedule row", () => {
    async function fired(store: Store, runId: string): Promise<void> {
        await store.schedules.upsert({
            agentId: AGENT,
            id: every15.id,
            kind: "every",
            expr: "15m",
            task: every15.task,
            deliverChannel: "tg",
            deliverTo: "@moeen_mahmud",
            sessionMode: "isolated",
            enabled: true,
            origin: "manifest",
            sourcePath: MINE,
            anchorAt: "2026-08-27T14:15:00.000Z",
            nextRunAt: "2026-08-27T14:15:00.000Z",
            now: "2026-08-27T14:00:00.000Z",
        })
        await store.schedules.markFired(AGENT, every15.id, {
            firedAt: "2026-08-27T14:00:00.000Z",
            anchorAt: "2026-08-27T14:15:00.000Z",
            nextRunAt: "2026-08-27T14:15:00.000Z",
            status: "ok",
            runId,
        })
    }

    test("overwrites the ok the scheduler could not know was wrong", async () => {
        const store = await freshStore()
        await fired(store, "r_one")
        // `markFired` writes `ok` when the *turn* finishes. The send happens later, in the outbox.
        expect((await store.schedules.get(AGENT, every15.id))?.lastStatus).toBe("ok")

        const applied = await store.schedules.markDeliveryFailed(
            AGENT,
            every15.id,
            "r_one",
            "telegram_refused: Bad Request: chat not found",
            "2026-08-27T14:00:04.000Z",
        )
        expect(applied).toBe(true)

        const row = await store.schedules.get(AGENT, every15.id)
        expect(row?.lastStatus).toBe("error")
        expect(row?.lastError).toContain("chat not found")
        // The due time is not the delivery's business — the run already advanced it.
        expect(row?.nextRunAt).toBe("2026-08-27T14:15:00.000Z")
        expect(row?.runs).toBe(1)
    })

    test("a report for a run the schedule has moved past changes nothing", async () => {
        const store = await freshStore()
        await fired(store, "r_two")
        const applied = await store.schedules.markDeliveryFailed(
            AGENT,
            every15.id,
            "r_one",
            "telegram_refused: Bad Request: chat not found",
            "2026-08-27T14:00:04.000Z",
        )
        expect(applied).toBe(false)
        expect((await store.schedules.get(AGENT, every15.id))?.lastStatus).toBe("ok")
    })
})
