/**
 * The scheduler's behaviour: the clamp, catch-up after downtime, overlap, and the acceptance
 * criterion that an idle agent with schedules does nothing at all.
 *
 * Against the **real** store rather than a fake, because half of what is being asserted is that the
 * durable state is right after each step — `nextRunAt`, `anchorAt`, and whether a run was counted.
 * A fake would agree with whatever the scheduler asked it, which is exactly the question.
 *
 * The clock is injected. A scheduler test that read the wall clock would be a test of what time it
 * is when CI runs, and the two moments this code exists to get right are in March and November.
 */

import { EventBus } from "../src/events/bus.ts"
import { SCHEDULER_HORIZON_MS, Scheduler } from "../src/schedule/scheduler.ts"
import { SqliteStore } from "../src/store/sqlite/store.ts"
import type { ScheduleRecord, Store } from "../src/store/store.ts"
import { describe, expect, test } from "./_harness.ts"

const AGENT = "assistant"
const at = (value: string): number => Date.parse(value)

async function freshStore(): Promise<Store> {
    return SqliteStore.open({ path: ":memory:" })
}

class Rig {
    readonly store: Store
    readonly bus: EventBus
    readonly scheduler: Scheduler
    readonly runs: ScheduleRecord[] = []
    readonly events: { type: string; data: Record<string, unknown> }[] = []
    now: number
    /** Resolves the held run, for the overlap tests. */
    release: (() => void) | undefined
    /** The pending timer callback and its delay, so a test decides when a wake happens. */
    pending: { fire: () => void; ms: number } | undefined

    constructor(store: Store, options: { readonly hold?: boolean; readonly now: string }) {
        this.store = store
        this.bus = new EventBus({ runtimeId: "test" })
        this.now = at(options.now)

        this.bus.on("*", (event) => {
            if (event.type.startsWith("schedule.")) {
                this.events.push({
                    type: event.type,
                    data: event.data as Record<string, unknown>,
                })
            }
        })

        this.scheduler = new Scheduler({
            store: store.schedules,
            bus: this.bus,
            agentIds: () => [AGENT],
            now: () => this.now,
            horizonMs: 30_000,
            // Short, because two of these tests deliberately leave a run held: the grace is the
            // thing being relied on, not the thing being measured.
            stopGraceMs: 20,
            setTimer: (fire, ms) => {
                this.pending = { fire, ms }
                return () => {
                    this.pending = undefined
                }
            },
            run: async (schedule) => {
                this.runs.push(schedule)
                if (options.hold === true) {
                    await new Promise<void>((resolve) => {
                        this.release = resolve
                    })
                }
            },
        })
    }

    typesOf(type: string): { type: string; data: Record<string, unknown> }[] {
        return this.events.filter((event) => event.type === type)
    }

    /** Fire the armed timer and let the wake settle. The scheduler re-arms as part of waking. */
    async tick(): Promise<void> {
        const armed = this.pending
        this.pending = undefined
        armed?.fire()
        await settle()
    }
}

async function rig(options: { readonly hold?: boolean; readonly now: string }): Promise<Rig> {
    return new Rig(await freshStore(), options)
}

/** Let queued microtasks and the arming promise settle. */
async function settle(): Promise<void> {
    for (let index = 0; index < 6; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * A row shaped the way the real writers shape one.
 *
 * **`anchorAt` is the boundary the pending `nextRunAt` belongs to**, not the previous occurrence —
 * both `reconcileSchedules` and the scheduler maintain that, and three tests here originally seeded
 * it the other way. They passed against a `#recompute` that treated the anchor as already-fired and
 * therefore skipped one occurrence per restart; fixing the scheduler turned them red, which is the
 * right way round. Overriding `anchorAt` alone is almost always a mistake.
 */
async function seed(
    store: Store,
    over: Partial<Parameters<Store["schedules"]["upsert"]>[0]> = {},
): Promise<ScheduleRecord> {
    const nextRunAt =
        over.nextRunAt === undefined && "nextRunAt" in over
            ? undefined
            : (over.nextRunAt ?? "2026-08-25T08:00:00.000Z")
    return store.schedules.upsert({
        agentId: AGENT,
        id: "brief",
        kind: "cron",
        expr: "0 8 * * *",
        timezone: "UTC",
        task: "Summarise the day.",
        sessionMode: "isolated",
        enabled: true,
        origin: "manifest",
        sourcePath: "/agents/scheduler-test/agent.yaml",
        now: "2026-08-24T08:00:00.000Z",
        ...over,
        // After the spread, and derived rather than overridable: a test that sets `nextRunAt` means
        // the pending occurrence, and the anchor is a fact about that rather than a second knob.
        anchorAt: over.anchorAt ?? nextRunAt ?? "2026-08-25T08:00:00.000Z",
        nextRunAt,
    })
}

describe("the store keeps schedules", () => {
    test("a spent one-shot has a null next run, and the partial index excludes it", async () => {
        const store = await freshStore()
        await seed(store, {
            id: "once",
            kind: "at",
            expr: "2026-08-25T06:00:00Z",
            nextRunAt: undefined,
        })
        const row = await store.schedules.get(AGENT, "once")
        expect(row?.nextRunAt).toBe(undefined)
        expect(await store.schedules.due([AGENT], "2030-01-01T00:00:00.000Z")).toEqual([])
        expect(await store.schedules.nextDue([AGENT])).toBe(undefined)
    })

    test("disabled schedules are listed by default and excluded from due", async () => {
        // Decision 9.4 — hiding rows by default is a footgun.
        const store = await freshStore()
        await seed(store, { id: "off", enabled: false })
        expect((await store.schedules.list(AGENT)).length).toBe(1)
        expect((await store.schedules.list(AGENT, { enabled: true })).length).toBe(0)
        expect(await store.schedules.due([AGENT], "2030-01-01T00:00:00.000Z")).toEqual([])
    })

    test("due is scoped to the agents asked about", async () => {
        // One store file serves every agent in a sandbox root, and two runtimes may share it. An
        // unscoped query hands this process another live process's schedules to fire.
        const store = await freshStore()
        await seed(store)
        await store.schedules.upsert({
            agentId: "other",
            id: "theirs",
            kind: "cron",
            expr: "0 8 * * *",
            task: "not ours",
            sessionMode: "isolated",
            enabled: true,
            origin: "manifest",
            sourcePath: "/agents/other/agent.yaml",
            // Anchor equals the pending next run — the invariant both real writers maintain.
            anchorAt: "2026-08-25T08:00:00.000Z",
            nextRunAt: "2026-08-25T08:00:00.000Z",
            now: "2026-08-24T08:00:00.000Z",
        })
        const mine = await store.schedules.due([AGENT], "2026-08-26T00:00:00.000Z")
        expect(mine.map((row) => row.id)).toEqual(["brief"])
    })

    test("reconciliation removes manifest rows the manifest dropped and leaves API rows alone", async () => {
        const store = await freshStore()
        await seed(store, { id: "kept", origin: "manifest" })
        await seed(store, { id: "dropped", origin: "manifest" })
        await seed(store, { id: "by-api", origin: "api" })

        const removed = await store.schedules.removeManifestExcept(
            AGENT,
            ["kept"],
            "/agents/scheduler-test/agent.yaml",
        )
        expect(removed).toEqual(["dropped"])
        const left = (await store.schedules.list(AGENT)).map((row) => row.id).sort()
        expect(left).toEqual(["by-api", "kept"])
    })

    test("a deferral moves the due time without counting as a run", async () => {
        // Two different questions, and conflating them makes both numbers a person reads to judge a
        // schedule's health wrong in the same direction.
        const store = await freshStore()
        await seed(store)
        await store.schedules.reschedule(AGENT, "brief", {
            anchorAt: "2026-08-25T08:00:00.000Z",
            nextRunAt: "2026-08-26T08:00:00.000Z",
            now: "2026-08-25T08:00:00.000Z",
        })
        const after = await store.schedules.get(AGENT, "brief")
        expect(after?.runs).toBe(0)
        expect(after?.lastStatus).toBe(undefined)
        expect(after?.nextRunAt).toBe("2026-08-26T08:00:00.000Z")

        await store.schedules.markFired(AGENT, "brief", {
            firedAt: "2026-08-26T08:00:00.000Z",
            anchorAt: "2026-08-26T08:00:00.000Z",
            nextRunAt: "2026-08-27T08:00:00.000Z",
            status: "ok",
        })
        const fired = await store.schedules.get(AGENT, "brief")
        expect(fired?.runs).toBe(1)
        expect(fired?.lastStatus).toBe("ok")
    })

    test("removing an agent takes its schedules and leaves another agent's alone", async () => {
        const store = await freshStore()
        await seed(store)
        await store.schedules.upsert({
            agentId: "other",
            id: "theirs",
            kind: "every",
            expr: "15m",
            task: "x",
            sessionMode: "isolated",
            enabled: true,
            origin: "api",
            sourcePath: "",
            // Anchor equals the pending next run — the invariant both real writers maintain.
            anchorAt: "2026-08-25T08:00:00.000Z",
            nextRunAt: "2026-08-25T08:00:00.000Z",
            now: "2026-08-24T08:00:00.000Z",
        })
        const went = await store.purgeAgent(AGENT)
        expect(went.schedules).toBe(1)
        expect((await store.schedules.list("other")).length).toBe(1)
    })
})

describe("catch-up after downtime", () => {
    test("a recurring schedule skips to the next occurrence and reports what it dropped", async () => {
        // The machine was asleep. Firing the whole backlog is the stampede the policy prevents;
        // dropping it silently is what the event exists to stop.
        const r = await rig({ now: "2026-08-30T09:00:00.000Z" })
        await seed(r.store, { nextRunAt: "2026-08-25T08:00:00.000Z" })
        await r.scheduler.start()
        await settle()

        expect(r.runs.length).toBe(0)
        const skipped = r.typesOf("schedule.skipped")
        expect(skipped.length).toBe(1)
        expect(skipped[0]?.data.missed).toBe(6)
        expect(skipped[0]?.data.reason).toBe("downtime")

        const row = await r.store.schedules.get(AGENT, "brief")
        expect((row?.nextRunAt ?? "").slice(0, 10)).toBe("2026-08-31")
        expect(row?.runs).toBe(0)
        await r.scheduler.stop()
    })

    test("a one-shot whose moment passed fires once, late and flagged", async () => {
        // Nobody else will ever fire it, so dropping it silently is rule 8's shape.
        const r = await rig({ now: "2026-08-25T09:00:00.000Z" })
        await seed(r.store, {
            id: "remind",
            kind: "at",
            expr: "2026-08-25T06:00:00.000Z",
            nextRunAt: "2026-08-25T06:00:00.000Z",
        })
        await r.scheduler.start()
        await settle()
        // Already overdue, so the arm is at the floor rather than at a negative delay.
        expect(r.pending?.ms).toBe(0)
        await r.tick()

        expect(r.runs.map((run) => run.id)).toEqual(["remind"])
        const fired = r.events.find((event) => event.type === "schedule.fired")
        expect(fired?.data.late).toBe(true)

        // Spent: it never fires again.
        const row = await r.store.schedules.get(AGENT, "remind")
        expect(row?.nextRunAt).toBe(undefined)
        expect(row?.runs).toBe(1)
        await r.scheduler.stop()
    })
})

describe("the timer", () => {
    test("an idle agent with schedules makes no runs at all", async () => {
        // The plan's own acceptance criterion, and what catches an accidental catch-up at boot.
        const r = await rig({ now: "2026-08-25T07:00:00.000Z" })
        await seed(r.store)
        await r.scheduler.start()
        await settle()
        expect(r.runs.length).toBe(0)
        expect(r.typesOf("schedule.fired").length).toBe(0)
        await r.scheduler.stop()
    })

    test("a ten-year `at` does not fire at boot", async () => {
        // The measured trap: setTimeout coerces its delay to a signed 32-bit integer, so anything
        // past 24.86 days is set to 1 ms and fires immediately. A raw setTimeout(dueAt - now) here
        // delivers a 2036 reminder now, marks the one-shot spent, and reports success.
        const r = await rig({ now: "2026-08-25T09:00:00.000Z" })
        await seed(r.store, {
            id: "far",
            kind: "at",
            expr: "2036-01-01T00:00:00.000Z",
            nextRunAt: "2036-01-01T00:00:00.000Z",
        })
        await r.scheduler.start()
        await settle()
        await settle()

        expect(r.runs.length).toBe(0)
        const row = await r.store.schedules.get(AGENT, "far")
        expect(row?.nextRunAt).toBe("2036-01-01T00:00:00.000Z")
        expect(row?.runs).toBe(0)

        // **This is the assertion that makes the test a guard.** The one above only shows the
        // scheduler did not *decide* to fire; it cannot show the arming is safe, because the
        // injected timer records the delay instead of handing it to a real setTimeout — so the
        // 32-bit coercion that causes the bug never happens under test. Asserting the requested
        // delay is what fails when the clamp is removed. Verified by removing it and watching this
        // go red; without this line the whole test passed with the fix reverted.
        expect(r.pending?.ms).toBeLessThanOrEqual(30_000)
        expect(r.pending?.ms).toBeLessThan(2 ** 31 - 1)
        await r.scheduler.stop()
    })

    test("the armed delay never exceeds the horizon, whatever the next due time is", () => {
        // Stated as a property rather than only as a case, because every schedule kind can produce
        // a far-future due time and the clamp is the single thing standing between that and an
        // immediate misfire.
        expect(SCHEDULER_HORIZON_MS).toBeLessThan(2 ** 31 - 1)
    })

    test("a due schedule fires once the clock reaches it", async () => {
        const r = await rig({ now: "2026-08-25T07:59:59.000Z" })
        await seed(r.store)
        await r.scheduler.start()
        await settle()
        expect(r.runs.length).toBe(0)

        // A pending occurrence is honoured as stored rather than recomputed, so this is the seeded
        // instant. The jitter was applied when the row was written — by `reconcileSchedules` in
        // production, and not at all by this helper.
        const armed = await r.store.schedules.get(AGENT, "brief")
        expect(armed?.nextRunAt).toBe("2026-08-25T08:00:00.000Z")

        r.now = Date.parse(armed?.nextRunAt ?? "")
        await r.tick()
        expect(r.runs.map((run) => run.id)).toEqual(["brief"])

        const row = await r.store.schedules.get(AGENT, "brief")
        expect(row?.runs).toBe(1)
        expect(row?.lastStatus).toBe("ok")
        expect((row?.nextRunAt ?? "").slice(0, 10)).toBe("2026-08-26")
        await r.scheduler.stop()
    })

    test("a failing run is recorded and the schedule keeps its next occurrence", async () => {
        // The failure is in the turn, not in the schedule. One bad run must not stop the series.
        const store = await freshStore()
        const bus = new EventBus({ runtimeId: "test" })
        const events: string[] = []
        bus.on("*", (event) => {
            if (event.type.startsWith("schedule.")) events.push(event.type)
        })
        let pending: (() => void) | undefined
        let now = at("2026-08-25T08:00:00.000Z")
        const scheduler = new Scheduler({
            store: store.schedules,
            bus,
            agentIds: () => [AGENT],
            now: () => now,
            setTimer: (fire) => {
                pending = fire
                return () => {
                    pending = undefined
                }
            },
            run: async () => {
                throw new Error("the endpoint refused")
            },
        })
        await seed(store)
        await scheduler.start()
        await settle()
        // Past the jittered due time, so the wake finds it.
        const armed = await store.schedules.get(AGENT, "brief")
        now = Date.parse(armed?.nextRunAt ?? "")
        pending?.()
        await settle()

        expect(events).toContain("schedule.error")
        const row = await store.schedules.get(AGENT, "brief")
        expect(row?.lastStatus).toBe("error")
        expect(row?.lastError).toContain("refused")
        expect(row?.nextRunAt).not.toBe(undefined)
        await scheduler.stop()
    })
})

describe("overlap", () => {
    test("a fire arriving mid-run is deferred, then taken at the turn boundary", async () => {
        // Not skipped and not concurrent. N concurrent turns is N concurrent model calls with no
        // cap, and the first thing anybody notices is the bill.
        const r = await rig({ hold: true, now: "2026-08-25T00:00:00.000Z" })
        await r.store.schedules.upsert({
            agentId: AGENT,
            id: "pulse",
            kind: "every",
            expr: "15m",
            timezone: "UTC",
            task: "poll",
            sessionMode: "isolated",
            enabled: true,
            sourcePath: "/agents/scheduler-test/agent.yaml",
            origin: "manifest",
            anchorAt: "2026-08-25T00:00:00.000Z",
            nextRunAt: "2026-08-25T00:15:00.000Z",
            now: "2026-08-25T00:00:00.000Z",
        })
        await r.scheduler.start()
        await settle()

        const first = await r.store.schedules.get(AGENT, "pulse")
        r.now = Date.parse(first?.nextRunAt ?? "")
        await r.tick()
        expect(r.runs.length).toBe(1)

        // The run is still held. Drive the clock past the next occurrence and wake again.
        r.now += 20 * 60_000
        await r.tick()
        expect(r.runs.length).toBe(1)
        expect(r.typesOf("schedule.deferred").length).toBe(1)

        // A deferral is not a run: the counter has not moved and the status is untouched.
        const held = await r.store.schedules.get(AGENT, "pulse")
        expect(held?.runs).toBe(0)

        // Release the turn. The held fire is taken now.
        r.release?.()
        await settle()
        expect(r.runs.length).toBe(2)
        await r.scheduler.stop()
    })

    test("further fires during one run collapse into the single held one", async () => {
        const r = await rig({ hold: true, now: "2026-08-25T00:00:00.000Z" })
        await r.store.schedules.upsert({
            agentId: AGENT,
            id: "pulse",
            kind: "every",
            expr: "15m",
            timezone: "UTC",
            task: "poll",
            sessionMode: "isolated",
            enabled: true,
            sourcePath: "/agents/scheduler-test/agent.yaml",
            origin: "manifest",
            anchorAt: "2026-08-25T00:00:00.000Z",
            nextRunAt: "2026-08-25T00:15:00.000Z",
            now: "2026-08-25T00:00:00.000Z",
        })
        await r.scheduler.start()
        await settle()
        const first = await r.store.schedules.get(AGENT, "pulse")
        r.now = Date.parse(first?.nextRunAt ?? "")
        await r.tick()
        expect(r.runs.length).toBe(1)

        for (let index = 0; index < 4; index += 1) {
            r.now += 20 * 60_000
            await r.tick()
        }
        // One deferral held, not four — and the event fires once, so a log does not fill with them.
        expect(r.typesOf("schedule.deferred").length).toBe(1)

        r.release?.()
        await settle()
        expect(r.runs.length).toBe(2)
        await r.scheduler.stop()
    })
})

describe("disabled schedules", () => {
    test("a disabled schedule is still moved forward, so enabling it does not fire it at once", async () => {
        // Measured live: a disabled `every 15m` kept a due time six seconds in the past, because
        // the boot recompute skipped it entirely. Enabling it would have fired it immediately rather
        // than at its next occurrence — a switch that does something surprising the moment you flip
        // it. Its occurrences are not reported as *missed*, though: it was off, which is the
        // configuration working rather than a fault.
        const r = await rig({ now: "2026-08-30T09:00:00.000Z" })
        await seed(r.store, {
            id: "off",
            enabled: false,
            nextRunAt: "2026-08-25T08:00:00.000Z",
        })
        await r.scheduler.start()
        await settle()

        const row = await r.store.schedules.get(AGENT, "off")
        expect(Date.parse(row?.nextRunAt ?? "")).toBeGreaterThan(r.now)
        expect(r.typesOf("schedule.skipped").length).toBe(0)
        expect(r.runs.length).toBe(0)
        await r.scheduler.stop()
    })
})

describe("a run in flight", () => {
    test("a one-shot fires exactly once even though its run outlives several wakes", async () => {
        // **Found live, not by these tests.** A real `at` schedule ran twice, 852 ms apart, in one
        // process. The row's due time was only advanced when the run *finished*, so for the whole
        // duration of the turn it was still due: `#arm` read a due time in the past, armed a zero
        // delay, woke immediately, found the same row, and — correctly, by the overlap policy —
        // deferred it. The deferral then fired it again on completion. Every piece behaved as
        // designed. The in-flight set stops concurrency; only advancing at dispatch stops the row
        // being due, and those are different questions.
        const r = await rig({ hold: true, now: "2026-08-25T09:00:00.000Z" })
        await seed(r.store, {
            id: "smoke",
            kind: "at",
            expr: "2026-08-25T09:00:05.000Z",
            nextRunAt: "2026-08-25T09:00:05.000Z",
        })
        await r.scheduler.start()
        await settle()

        r.now = at("2026-08-25T09:00:05.000Z")
        await r.tick()
        expect(r.runs.length).toBe(1)

        // Spent the moment it was dispatched, so nothing is due while the turn is still running.
        const during = await r.store.schedules.get(AGENT, "smoke")
        expect(during?.nextRunAt).toBe(undefined)
        expect(r.pending?.ms).toBe(30_000)

        // Several more wakes while the run is held. None of them may start anything.
        for (let index = 0; index < 3; index += 1) {
            r.now += 1_000
            await r.tick()
        }
        expect(r.runs.length).toBe(1)
        expect(r.typesOf("schedule.deferred").length).toBe(0)

        r.release?.()
        await settle()
        expect(r.runs.length).toBe(1)
        const after = await r.store.schedules.get(AGENT, "smoke")
        expect(after?.runs).toBe(1)
        await r.scheduler.stop()
    })

    test("a recurring schedule whose run outlives its interval still fires once per wake at most", async () => {
        const r = await rig({ hold: true, now: "2026-08-25T00:00:00.000Z" })
        await r.store.schedules.upsert({
            agentId: AGENT,
            id: "pulse",
            kind: "every",
            expr: "15m",
            timezone: "UTC",
            task: "poll",
            sessionMode: "isolated",
            enabled: true,
            sourcePath: "/agents/scheduler-test/agent.yaml",
            origin: "manifest",
            anchorAt: "2026-08-25T00:00:00.000Z",
            nextRunAt: "2026-08-25T00:15:00.000Z",
            now: "2026-08-25T00:00:00.000Z",
        })
        await r.scheduler.start()
        await settle()
        const armed = await r.store.schedules.get(AGENT, "pulse")
        r.now = Date.parse(armed?.nextRunAt ?? "")
        await r.tick()
        expect(r.runs.length).toBe(1)

        // The row has already moved to the next occurrence, so an immediate re-wake finds nothing.
        const during = await r.store.schedules.get(AGENT, "pulse")
        expect(Date.parse(during?.nextRunAt ?? "")).toBeGreaterThan(r.now)
        await r.tick()
        expect(r.runs.length).toBe(1)
        r.release?.()
        await settle()
        await r.scheduler.stop()
    })
})

describe("shutdown", () => {
    test("stop waits for a run that is still writing its result", async () => {
        // Found by the benchmark, not by reading: `#record` runs *after* the turn, so a stop that
        // returned immediately let the caller close the store while the row saying whether the run
        // happened was still being written — `Database has closed`, out of markFired. On a real
        // shutdown that is a torn write on the one row that answers "did it run", and silent.
        const r = await rig({ hold: true, now: "2026-08-25T07:59:59.000Z" })
        await seed(r.store)
        await r.scheduler.start()
        await settle()
        const armed = await r.store.schedules.get(AGENT, "brief")
        r.now = Date.parse(armed?.nextRunAt ?? "")
        await r.tick()
        expect(r.runs.length).toBe(1)

        let stopped = false
        const stopping = r.scheduler.stop().then(() => {
            stopped = true
        })
        await settle()
        // Still waiting: the run has not finished.
        expect(stopped).toBe(false)

        r.release?.()
        await stopping
        expect(stopped).toBe(true)

        // And the result did land, rather than being lost to the shutdown.
        const after = await r.store.schedules.get(AGENT, "brief")
        expect(after?.runs).toBe(1)
    })
})

describe("the wall clock", () => {
    test("due-ness is recomputed from the clock, so a jump forward is noticed on the next wake", async () => {
        // Timers run on a monotonic clock, so an NTP step does not move an armed timer. If a wake
        // asked "did my timer fire?" rather than "what time is it?", a clock jump would leave the
        // schedule silently late by the size of the jump.
        const r = await rig({ now: "2026-08-25T00:00:00.000Z" })
        await seed(r.store, { nextRunAt: "2026-08-25T08:00:00.000Z" })
        await r.scheduler.start()
        await settle()
        expect(r.runs.length).toBe(0)

        // The clock jumps nine hours; the timer is unchanged. The next wake still finds the row due.
        r.now = at("2026-08-25T09:00:00.000Z")
        await r.tick()
        expect(r.runs.map((run) => run.id)).toEqual(["brief"])
        await r.scheduler.stop()
    })
})

describe("restarting", () => {
    test("a pending occurrence survives a restart instead of being skipped", async () => {
        // **Found live across two starts of the same agent**, and invisible to every other test
        // here because it needs two process lifetimes with something pending in between. A daily
        // brief went from "in 4h" to "in 28h" and a leap-year schedule from 2028 to 2032 — one
        // occurrence lost per restart, silently, on a schedule that had never run.
        //
        // The cause: `anchorAt` names the boundary the pending `nextRunAt` belongs to, and the boot
        // recompute treated it as already fired, so it asked for the occurrence *after* the one
        // still waiting.
        const store = await freshStore()
        const bus = new EventBus({ runtimeId: "test" })
        const now = at("2026-08-25T04:00:00.000Z")
        const build = (): Scheduler =>
            new Scheduler({
                store: store.schedules,
                bus,
                agentIds: () => [AGENT],
                now: () => now,
                setTimer: () => () => {},
                run: async () => {},
            })

        await seed(store, { nextRunAt: "2026-08-25T08:00:00.000Z" })

        // Five boots in a row, none of which fires anything: the pending occurrence must not move.
        for (let restart = 0; restart < 5; restart += 1) {
            const scheduler = build()
            await scheduler.start()
            await settle()
            await scheduler.stop()

            const row = await store.schedules.get(AGENT, "brief")
            expect(row?.nextRunAt).toBe("2026-08-25T08:00:00.000Z")
            expect(row?.runs).toBe(0)
        }
    })

    test("an overdue occurrence still advances, and is reported once", async () => {
        // The other half: leaving a pending row alone must not also leave an *overdue* one alone,
        // or a schedule that was missed during downtime never recovers.
        const r = await rig({ now: "2026-08-26T09:00:00.000Z" })
        await seed(r.store, { nextRunAt: "2026-08-25T08:00:00.000Z" })
        await r.scheduler.start()
        await settle()

        const row = await r.store.schedules.get(AGENT, "brief")
        expect(Date.parse(row?.nextRunAt ?? "")).toBeGreaterThan(r.now)
        expect(r.typesOf("schedule.skipped").length).toBe(1)
        await r.scheduler.stop()
    })
})
