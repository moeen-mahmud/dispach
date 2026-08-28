/**
 * 100 schedules across 10 agents on one timer: what drift does it actually produce?
 *
 * A measurement, never an assertion. Node "makes no guarantees about the exact timing of when
 * callbacks will fire" and explicitly disclaims callback ordering, so sub-second drift is a property
 * of *this host's* event loop rather than something the timer API promises. The plan's acceptance
 * criterion is a number, and a number has to come from somewhere.
 *
 * What is measured is the gap between a schedule's own `nextRunAt` and the moment its run actually
 * started. Jitter is excluded by construction: it is folded into `nextRunAt` before the comparison,
 * because a deliberate, reproducible displacement is not drift and counting it would make a healthy
 * schedule look permanently late by its own offset.
 *
 * The loop is also given something to do — `monitorEventLoopDelay` runs throughout, because the
 * honest question is not "how late is a timer on an idle process" but "how late is it while the
 * process is doing the work it exists to do".
 */

import { monitorEventLoopDelay } from "node:perf_hooks"
import { EventBus } from "../packages/core/src/events/bus.ts"
import { Scheduler } from "../packages/core/src/schedule/scheduler.ts"
import { SqliteStore } from "../packages/core/src/store/sqlite/store.ts"

const AGENTS = 10
const PER_AGENT = 10
const HORIZON_MS = 30_000

const store = await SqliteStore.open({ path: ":memory:" })
const bus = new EventBus({ runtimeId: "bench" })

const agentIds = Array.from({ length: AGENTS }, (_, index) => `agent-${index}`)
const start = Date.now()

// `at` rather than `every`, for two reasons that both matter to what this measures.
//
// A one-shot carries **no jitter**, so all hundred land on the same instant — which is the
// pathological case for a single timer and the only one worth benchmarking. An `every` schedule is
// deliberately spread by up to 90 seconds precisely so this does not happen, so benching it would
// measure the jitter working rather than the dispatch.
//
// And boot **re-derives `nextRunAt` from `anchorAt`** rather than trusting the stored value, which
// is what keeps an interval drift-free across restarts. Seeding an inconsistent anchor/next pair
// therefore does nothing at all: the first version of this script did exactly that and hung,
// because every schedule was silently rescheduled fifteen minutes out.
let seeded = 0
for (const agentId of agentIds) {
    for (let index = 0; index < PER_AGENT; index += 1) {
        await store.schedules.upsert({
            agentId,
            id: `s-${index}`,
            kind: "at",
            expr: new Date(start + 300).toISOString(),
            task: "bench",
            sessionMode: "isolated",
            enabled: true,
            origin: "manifest",
            // `scripts/` is outside the tsconfig projects, so a required field going missing here
            // is a runtime failure rather than a type error — which is how this line came to be
            // needed. Any non-empty path works: reconciliation never runs in this benchmark.
            sourcePath: "/bench/agent.yaml",
            anchorAt: new Date(start).toISOString(),
            nextRunAt: new Date(start + 300).toISOString(),
            now: new Date(start).toISOString(),
        })
        seeded += 1
    }
}

const drifts: number[] = []
let ran = 0

const histogram = monitorEventLoopDelay({ resolution: 1 })
histogram.enable()

const scheduler = new Scheduler({
    store: store.schedules,
    bus,
    agentIds: () => agentIds,
    horizonMs: HORIZON_MS,
    run: async (schedule) => {
        const due = Date.parse(schedule.nextRunAt ?? "")
        drifts.push(Date.now() - due)
        ran += 1
        // A turn is network-await-bound, so the loop is yielded rather than blocked. Modelling it as
        // synchronous work would measure a different system.
        await new Promise((resolve) => setTimeout(resolve, 1))
    },
})

const armedAt = Date.now()
await scheduler.start()

await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
        // Counts completions, not starts. `#record` runs after the turn, so polling on starts
        // closes the store under a row that is still being written — which is how the in-flight
        // wait in `Scheduler.stop` came to exist.
        if (drifts.length >= seeded) {
            clearInterval(poll)
            resolve()
        }
    }, 5)
})

histogram.disable()
await scheduler.stop()
await store.close()

const sorted = [...drifts].sort((a, b) => a - b)
const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
const worst = sorted[sorted.length - 1] ?? 0

process.stdout.write(
    `\nbench-schedule — ${seeded} schedules across ${AGENTS} agents, one timer\n\n`,
)
process.stdout.write(`  fired                 ${ran}\n`)
process.stdout.write(`  reconcile + arm       ${armedAt - start} ms for ${seeded} rows\n`)
process.stdout.write(`  drift median          ${at(0.5)} ms\n`)
process.stdout.write(`  drift p95             ${at(0.95)} ms\n`)
process.stdout.write(`  drift worst           ${worst} ms\n`)
process.stdout.write(`  loop delay mean       ${(histogram.mean / 1e6).toFixed(2)} ms\n`)
process.stdout.write(`  loop delay max        ${(histogram.max / 1e6).toFixed(2)} ms\n\n`)

// The criterion, checked rather than assumed. Reported either way — a bench that only prints when
// it passes is a bench nobody believes.
const ok = worst < 1_000 && ran === seeded
process.stdout.write(
    ok
        ? "bench-schedule: ok — worst drift under 1 s, every schedule fired\n"
        : `bench-schedule: OVER BUDGET — worst drift ${worst} ms, ${ran}/${seeded} fired\n`,
)
process.exitCode = ok ? 0 : 1
