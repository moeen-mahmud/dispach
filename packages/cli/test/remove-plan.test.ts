/**
 * What removing an agent would take, what stops it, and in what order.
 *
 * Two of these carry real weight.
 *
 * **A shared manifest id must block.** The store is one database keyed by `agent_id`, so two
 * directories answering to one id share every session, passage and log file between them. Deleting
 * "one" of those agents' data deletes both, and reports success — the silent-loss shape hard rule 8
 * exists to prevent. It has to be a refusal rather than a quiet fallback to files-only, because the
 * quiet version tells somebody their agent is gone while leaving rows `agentIds` will list forever.
 *
 * **The order is the safety.** Every step but the last is recoverable: an agent whose rows are gone
 * still loads and still runs, while a deleted directory is not coming back. So the directory goes last
 * and the stop goes first, and asserting that without performing it is the whole reason this module is
 * pure.
 */

import { describe, expect, test } from "bun:test"
import type { AgentFootprint } from "@dispach/core"
import {
    type Orphan,
    type RemovalFacts,
    removalFindings,
    removalSteps,
    renderOrphans,
    renderRemoval,
} from "#lib/remove-plan"

const EMPTY: AgentFootprint = {
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
}

const BUSY: AgentFootprint = {
    sessions: 21,
    messages: 88,
    turns: 43,
    artifacts: 3,
    outbox: 2,
    outboxPending: 1,
    schedules: 4,
    passages: 25,
    memorySources: 19,
    lease: true,
}

function facts(over: Partial<RemovalFacts> = {}): RemovalFacts {
    return {
        ref: "milo",
        agentId: "milo",
        dir: "/home/moeen/.dispach/agents/milo",
        files: { count: 12, bytes: 49_152 },
        footprint: BUSY,
        logs: [
            { path: "/home/moeen/.dispach/logs/milo.out.log", bytes: 1_200_000 },
            { path: "/home/moeen/.dispach/logs/milo.err.log", bytes: 4_096 },
        ],
        sharesIdWith: [],
        filesOnly: false,
        ...over,
    }
}

describe("removalFindings", () => {
    test("a clean agent has nothing to say", () => {
        expect(removalFindings(facts())).toEqual([])
    })

    test("a shared manifest id blocks, and names the other directory", () => {
        const found = removalFindings(facts({ sharesIdWith: ["milo-copy", "milo-backup"] }))
        expect(found.length).toBe(1)
        expect(found[0]?.code).toBe("cli_agent_id_shared")
        // Naming them is the point: the person has to know which other agent is at risk.
        expect(found[0]?.message.includes("milo-copy, milo-backup")).toBe(true)
        expect(found[0]?.message.includes("sessions and memory")).toBe(true)
    })

    test("--files-only clears the block, because the id is no longer being acted on", () => {
        expect(removalFindings(facts({ sharesIdWith: ["milo-copy"], filesOnly: true }))).toEqual([])
    })

    test("every finding carries a hint", () => {
        // Hard rule 7, asserted over the whole set rather than trusted per site.
        for (const found of removalFindings(facts({ sharesIdWith: ["other"] }))) {
            expect(found.hint.length > 0).toBe(true)
        }
    })
})

describe("removalSteps", () => {
    test("the directory is always last, and it is the only guaranteed step", () => {
        // The invariant that makes a partial failure survivable: everything before this is recoverable.
        for (const f of [
            facts(),
            facts({ filesOnly: true }),
            facts({ running: { pid: 4242, mode: "terminal" } }),
            facts({ service: "dispach.agent.milo" }),
            facts({ logs: [] }),
        ]) {
            const steps = removalSteps(f)
            expect(steps.at(-1)?.kind).toBe("directory")
            expect(steps.filter((step) => step.kind === "directory").length).toBe(1)
        }
    })

    test("stopping comes before anything is deleted", () => {
        const steps = removalSteps(
            facts({ running: { pid: 4242, mode: "terminal" }, service: "dispach.agent.milo" }),
        )
        expect(steps.map((step) => step.kind)).toEqual([
            "stop",
            "service",
            "store",
            "logs",
            "directory",
        ])
    })

    test("a graceful stop is named as such, because that is what reaps the children", () => {
        const steps = removalSteps(facts({ running: { pid: 4242, mode: "daemon" } }))
        expect(steps[0]?.detail.includes("4242")).toBe(true)
        expect(steps[0]?.detail.includes("daemon")).toBe(true)
        expect(steps[0]?.detail.includes("background")).toBe(true)
    })

    test("--files-only is one step, whatever else exists", () => {
        const steps = removalSteps(
            // No `running` key at all rather than `running: undefined` — under
            // `exactOptionalPropertyTypes` those are different types, and the base facts have none.
            facts({ filesOnly: true, service: "dispach.agent.milo" }),
        )
        expect(steps.map((step) => step.kind)).toEqual(["directory"])
    })

    test("--files-only still stops a running process first", () => {
        // Deleting the directory under a live process leaves it serving a manifest that is gone.
        const steps = removalSteps(
            facts({ filesOnly: true, running: { pid: 7, mode: "terminal" } }),
        )
        expect(steps.map((step) => step.kind)).toEqual(["stop", "directory"])
    })

    test("no logs means no log step, rather than a step that deletes nothing", () => {
        expect(removalSteps(facts({ logs: [] })).map((step) => step.kind)).toEqual([
            "store",
            "directory",
        ])
    })
})

describe("renderRemoval", () => {
    test("it names every number somebody might stop over", () => {
        const out = renderRemoval(facts())
        expect(out.includes("21 conversations")).toBe(true)
        expect(out.includes("88 messages")).toBe(true)
        expect(out.includes("25 passages")).toBe(true)
        expect(out.includes("19 sources")).toBe(true)
        expect(out.includes("12 files")).toBe(true)
    })

    test("a pending delivery is flagged as abandoned", () => {
        // A reply somebody is waiting for. Removing the agent means it never goes.
        expect(renderRemoval(facts()).includes("abandoned")).toBe(true)
        expect(renderRemoval(facts({ footprint: EMPTY })).includes("abandoned")).toBe(false)
    })

    test("an absent service says so rather than being omitted", () => {
        // A missing row reads as "no such concept"; `not installed` reads as a switch that is off.
        expect(renderRemoval(facts()).includes("not installed")).toBe(true)
        expect(
            renderRemoval(facts({ service: "dispach.agent.milo" })).includes("dispach.agent.milo"),
        ).toBe(true)
    })

    test("the manifest id gets its own row only when it differs from the ref", () => {
        // Everything except the directory is keyed by the id, so a person who only knows the directory
        // name is otherwise reading a listing about a name they have never seen.
        expect(renderRemoval(facts()).includes("manifest id")).toBe(false)
        const renamed = renderRemoval(facts({ ref: "milo-copy", agentId: "milo" }))
        expect(renamed.includes("manifest id")).toBe(true)
        expect(renamed.includes("keys the store")).toBe(true)
    })

    test("--files-only says what it is keeping, not what it is deleting", () => {
        const out = renderRemoval(facts({ filesOnly: true }))
        expect(out.includes("keeping")).toBe(true)
        expect(out.includes("21 conversations")).toBe(true)
        // No delete-shaped rows: they would read as things about to go.
        expect(out.includes("outbox")).toBe(false)
        expect(out.includes("service")).toBe(false)
    })

    test("an idle agent reports not running, and a live one reports its pid", () => {
        expect(renderRemoval(facts()).includes("running")).toBe(true)
        expect(
            renderRemoval(facts({ running: { pid: 99, mode: "daemon" } })).includes("pid 99"),
        ).toBe(true)
    })

    test("nothing wraps a singular into a plural", () => {
        const out = renderRemoval(
            facts({
                footprint: { ...EMPTY, sessions: 1, messages: 1, passages: 1, memorySources: 1 },
                files: { count: 1, bytes: 10 },
                logs: [{ path: "/x/milo.out.log", bytes: 1 }],
            }),
        )
        expect(out.includes("1 conversation,")).toBe(true)
        expect(out.includes("1 passage from 1 source")).toBe(true)
        expect(out.includes("1 file")).toBe(true)
        expect(out.includes("1 conversations")).toBe(false)
    })
})

describe("renderOrphans", () => {
    const orphan = (over: Partial<Orphan>): Orphan => ({
        agentId: "oldbot",
        footprint: EMPTY,
        logs: [],
        ...over,
    })

    test("nothing left over renders nothing", () => {
        expect(renderOrphans([])).toBe("")
    })

    test("rows and logs are both described", () => {
        const out = renderOrphans([
            orphan({ footprint: { ...EMPTY, sessions: 42, messages: 310, passages: 18 } }),
            orphan({ agentId: "dot", logs: [{ path: "/x/dot.err.log", bytes: 0 }] }),
        ])
        expect(out.includes("42 conversations, 310 messages")).toBe(true)
        expect(out.includes("18 memory passages")).toBe(true)
        // The real case on the author's machine: logs with no store rows at all.
        expect(out.includes("dot")).toBe(true)
        expect(out.includes("1 log file")).toBe(true)
    })

    test("a stale lease alone is enough to be listed", () => {
        // The case `LeaseStore.orphans` cannot see — no running turn, no inflight delivery.
        expect(
            renderOrphans([orphan({ footprint: { ...EMPTY, lease: true } })]).includes(
                "stale lease",
            ),
        ).toBe(true)
    })

    test("an orphan with nothing describable still says something", () => {
        // Never a blank line: it was listed because *something* referenced the id, and a row with no
        // detail is a bug report rather than a silent gap.
        expect(renderOrphans([orphan({})]).trim().length > "oldbot".length).toBe(true)
    })
})
