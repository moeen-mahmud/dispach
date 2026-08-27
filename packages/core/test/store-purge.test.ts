/**
 * Removing one agent from a store that holds several.
 *
 * **This is the test the shared store exists to justify.** One sandbox root has one `store.db` and
 * agents are isolated by `agent_id` on every table — so isolation is a property of these queries
 * rather than of the filesystem, and "another agent's rows are untouched" is a thing to assert rather
 * than something the layout guarantees for us. A `DELETE` missing its `WHERE agent_id = ?` would pass
 * every test that only ever puts one agent in the store.
 *
 * The second assertion is that `agentFootprint` and `purgeAgent` agree. They are separately written
 * queries feeding one shape, and the shape exists so a destructive command can *show* what it would
 * take before taking it — a listing derived from a different count than the deletion is how a
 * confirmation comes to describe something other than what happens.
 */

import { openMemoryStore } from "../src/store/sqlite/store.ts"
import type { Store } from "../src/store/store.ts"
import { describe, expect, test } from "./_harness.ts"

const NOW = "2026-08-20T12:00:00.000Z"

async function populate(store: Store, agentId: string, key = "local:aaa111"): Promise<void> {
    await store.sessions.ensure(agentId, key)
    await store.messages.append(agentId, key, [
        { role: "user", content: `a question from ${agentId}` },
        { role: "assistant", content: `an answer for ${agentId}` },
    ])
    await store.turns.start({
        turnId: `turn-${agentId}-${key}`,
        agentId,
        sessionKey: key,
        source: "test",
        input: "a question",
    })
    await store.artifacts.put(
        agentId,
        key,
        [{ id: `art-${agentId}-${key}`, content: "a displaced observation", tokens: 4 }],
        NOW,
    )
    await store.outbox.enqueue([
        {
            agentId,
            dedupeKey: `dedupe-${agentId}-${key}`,
            groupKey: `group-${agentId}-${key}`,
            sessionKey: key,
            channelId: "tg",
            recipient: "@someone",
            chunkIndex: 0,
            chunkTotal: 1,
            body: "a reply going out",
            nextAttemptAt: NOW,
        },
    ])
    await store.schedules.upsert({
        agentId,
        id: `brief-${agentId}`,
        kind: "cron",
        expr: "0 8 * * *",
        task: `a daily brief for ${agentId}`,
        sessionMode: "isolated",
        enabled: true,
        origin: "manifest",
        anchorAt: NOW,
        nextRunAt: NOW,
        now: NOW,
    })
    await store.memory.replaceSource(
        agentId,
        "2026-08.md",
        [
            {
                id: `mem-${agentId}`,
                source: "2026-08.md",
                text: `a note belonging to ${agentId}`,
                terms: "note belong",
                length: 2,
                at: NOW,
                stamped: true,
                tags: [],
                tokens: 5,
            },
        ],
        { mtimeMs: 1, size: 32, tokeniser: 1 },
        NOW,
    )
    await store.leases.claim({
        agentId,
        runtimeId: `rt-${agentId}`,
        pid: 4242,
        mode: "terminal",
        now: NOW,
    })
}

describe("agentFootprint", () => {
    test("it counts what one agent owns and nothing else's", async () => {
        const store = await openMemoryStore()
        await populate(store, "alpha")
        await populate(store, "beta")
        await populate(store, "beta", "local:bbb222")

        const alpha = await store.agentFootprint("alpha")
        expect(alpha.sessions).toBe(1)
        expect(alpha.messages).toBe(2)
        expect(alpha.turns).toBe(1)
        expect(alpha.artifacts).toBe(1)
        expect(alpha.outbox).toBe(1)
        expect(alpha.outboxPending).toBe(1)
        expect(alpha.passages).toBe(1)
        expect(alpha.memorySources).toBe(1)
        expect(alpha.schedules).toBe(1)
        expect(alpha.lease).toBe(true)

        // Two sessions, so a count that quietly returned the whole table would read 3 here.
        expect((await store.agentFootprint("beta")).sessions).toBe(2)
        await store.close()
    })

    test("an agent with nothing is all zeroes rather than an error", async () => {
        const store = await openMemoryStore()
        const empty = await store.agentFootprint("nobody")
        expect(empty.sessions).toBe(0)
        expect(empty.passages).toBe(0)
        expect(empty.lease).toBe(false)
        await store.close()
    })
})

describe("purgeAgent", () => {
    test("it removes one agent and leaves the other completely intact", async () => {
        const store = await openMemoryStore()
        await populate(store, "alpha")
        await populate(store, "beta")

        const before = await store.agentFootprint("beta")
        const went = await store.purgeAgent("alpha")

        // What it reported is what the footprint said it would take.
        expect(went.sessions).toBe(1)
        expect(went.messages).toBe(2)
        expect(went.passages).toBe(1)
        expect(went.lease).toBe(true)

        // Gone, table by table — including the three that cascade rather than being deleted directly.
        const after = await store.agentFootprint("alpha")
        expect(after).toEqual({
            sessions: 0,
            messages: 0,
            turns: 0,
            artifacts: 0,
            outbox: 0,
            outboxPending: 0,
            schedules: 0,
            passages: 0,
            memorySources: 0,
            lease: false,
        })

        // The whole point: beta is byte-for-byte where it was.
        expect(await store.agentFootprint("beta")).toEqual(before)
        expect((await store.messages.history("beta", "local:aaa111")).length).toBe(2)
        expect((await store.memory.stats("beta")).passages).toBe(1)
        expect(await store.leases.get("beta")).not.toBe(undefined)
        // A schedule that survived a sibling's removal is the case a DELETE with no WHERE would
        // silently break — and every test that only ever puts one agent in the store would pass.
        expect((await store.schedules.list("beta")).length).toBe(1)
        await store.close()
    })

    test("the report equals the footprint taken immediately before it", async () => {
        const store = await openMemoryStore()
        await populate(store, "alpha")
        const predicted = await store.agentFootprint("alpha")
        expect(await store.purgeAgent("alpha")).toEqual(predicted)
        await store.close()
    })

    test("purging an agent with nothing is a no-op, not a failure", async () => {
        const store = await openMemoryStore()
        await populate(store, "beta")
        const went = await store.purgeAgent("nobody")
        expect(went.sessions).toBe(0)
        expect((await store.agentFootprint("beta")).sessions).toBe(1)
        await store.close()
    })

    test("memory files are the caller's problem — this only touches rows", async () => {
        // Stated as a test because `memory_passages` deliberately has no session link and no cascade:
        // the markdown on disk is canonical, and a store purge is not a licence to delete it.
        const store = await openMemoryStore()
        await populate(store, "alpha")
        await store.purgeAgent("alpha")
        expect((await store.memory.sources("alpha")).length).toBe(0)
        await store.close()
    })
})

describe("agentIds", () => {
    test("every id with rows anywhere, deduplicated and sorted", async () => {
        const store = await openMemoryStore()
        await populate(store, "beta")
        await populate(store, "alpha")
        expect(await store.agentIds()).toEqual(["alpha", "beta"])
        await store.close()
    })

    test("an agent that owns only a lease is still named", async () => {
        // The case `LeaseStore.orphans` cannot see: no running turn, no inflight delivery, so nothing
        // in that narrower query reaches it — and a directory deleted while idle looks exactly so.
        const store = await openMemoryStore()
        await store.leases.claim({
            agentId: "ghost",
            runtimeId: "rt-1",
            pid: 1,
            mode: "terminal",
            now: NOW,
        })
        expect(await store.agentIds()).toEqual(["ghost"])
        await store.close()
    })

    test("a purged agent stops being named", async () => {
        const store = await openMemoryStore()
        await populate(store, "alpha")
        await populate(store, "beta")
        await store.purgeAgent("alpha")
        expect(await store.agentIds()).toEqual(["beta"])
        await store.close()
    })
})
