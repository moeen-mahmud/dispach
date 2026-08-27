/**
 * What removing an agent would actually take, and what should stop it.
 *
 * Facts in, a listing and an ordered plan out. Gathering the facts needs the filesystem, the store and
 * `launchctl`; deciding what to do with them needs none of that — and the interesting cases here are
 * exactly the ones that are painful to produce on a real machine: a manifest id shared by two
 * directories, a live lease, an installed service, rows nobody claims. A table beats breaking a
 * sandbox nine different ways.
 *
 * ## Why the listing and the deletion come from one place
 *
 * The confirmation is a listing plus the agent's name typed back, and the listing *is* `--dry-run` —
 * one code path, so what a dry run shows is what a real run does. Deriving the two separately is how a
 * confirmation comes to describe something other than what happens, which for an irreversible command
 * is the worst available failure: the person read it, agreed to it, and got something else.
 *
 * No `node:*`, no `process`. This module is on the boundaries test's `PURE` list.
 */

import type { AgentFootprint } from "@dispach/core"
import { bytes, keyValue, type Row } from "#lib/render"

export interface Finding {
    readonly code: string
    readonly message: string
    /** Never optional. Hard rule 7, and a test asserts it over every finding this can produce. */
    readonly hint: string
}

/** A file the removal would delete, and what it costs to keep. */
export interface FileFacts {
    readonly path: string
    readonly bytes: number
}

export interface RemovalFacts {
    /** The directory name — what was typed, and what the confirmation asks to be typed back. */
    readonly ref: string
    /** The manifest id. Keys the store, the logs and the service label; may differ from `ref`. */
    readonly agentId: string
    readonly dir: string
    /** Files under `dir`, counted and summed. Empty when the directory could not be read. */
    readonly files: { readonly count: number; readonly bytes: number }
    /** What the store holds for `agentId`. */
    readonly footprint: AgentFootprint
    /** Log files that exist. Absent entries are simply not listed. */
    readonly logs: readonly FileFacts[]
    /**
     * Other sandbox directories whose manifest id is also `agentId`.
     *
     * The refusal case. Store rows, logs and the service label are all keyed by id, so removing this
     * agent's *data* would remove theirs.
     */
    readonly sharesIdWith: readonly string[]
    /** A live process holding the lease, if any. */
    readonly running?: { readonly pid: number; readonly mode: string }
    /** The launchd label, when a service is installed under it. */
    readonly service?: string
    /** Only the directory goes; the store, the logs and the service are left alone. */
    readonly filesOnly: boolean
}

/**
 * What must not be removed, and why.
 *
 * **A shared manifest id blocks, rather than degrading to a partial removal.** Deleting store rows by
 * `agent_id` when two directories answer to that id destroys the other agent's conversations and
 * memory, and reports success — the silent-loss shape hard rule 8 exists to prevent. Falling back to
 * files-only automatically was the alternative and is worse in a quieter way: it leaves rows that
 * `agentIds` will list forever as belonging to nobody, having told the person their agent was gone.
 *
 * `--files-only` clears it, because then the id is not being acted on at all.
 */
export function removalFindings(facts: RemovalFacts): readonly Finding[] {
    if (facts.filesOnly || facts.sharesIdWith.length === 0) return []
    const others = facts.sharesIdWith.join(", ")
    return [
        {
            code: "cli_agent_id_shared",
            message: `"${facts.ref}" has the manifest id "${facts.agentId}", which is also used by ${others} — removing its data would take that agent's sessions and memory too.`,
            hint: `Change one manifest's id and run \`memory rebuild\` for it, or pass --files-only to delete just the ${facts.ref} directory and leave the store alone.`,
        },
    ]
}

export type StepKind = "stop" | "service" | "store" | "logs" | "directory"

export interface Step {
    readonly kind: StepKind
    /** What this step will do, in the imperative. Shown before it happens. */
    readonly detail: string
}

/**
 * The steps, in the order they must run.
 *
 * The order is not cosmetic:
 *
 * 1. **Stop first.** A process holding the lease is still writing sessions, and a graceful stop is the
 *    only path that runs `provider.stop()` — the sole reaper for backgrounded `exec` children. Deleting
 *    a running agent's directory would leave a live process serving from a manifest that no longer
 *    exists, with orphaned shells behind it.
 * 2. **Service next.** `disable` persists across boots and `bootout` does not, so both are needed: a
 *    label left enabled comes back at the next login and fails forever against a deleted manifest.
 * 3. **Store, then logs, then the directory last.** Every earlier step is recoverable — an agent whose
 *    rows are gone still loads and still runs. The directory is the only irreplaceable part, so it goes
 *    when nothing else can fail; the reverse order leaves a manifest-less agent whose data is
 *    unreachable and whose name nothing can name.
 */
export function removalSteps(facts: RemovalFacts): readonly Step[] {
    const steps: Step[] = []
    if (facts.running !== undefined) {
        steps.push({
            kind: "stop",
            detail: `stop pid ${facts.running.pid} (${facts.running.mode}) — gracefully, so anything it left running in the background is reaped`,
        })
    }
    if (!facts.filesOnly && facts.service !== undefined) {
        steps.push({
            kind: "service",
            detail: `disable and unload ${facts.service}`,
        })
    }
    if (!facts.filesOnly) {
        const f = facts.footprint
        steps.push({
            kind: "store",
            detail: `delete ${plural(f.sessions, "conversation")}, ${plural(f.messages, "message")}, ${plural(f.passages, "memory passage")}`,
        })
        if (facts.logs.length > 0) {
            steps.push({ kind: "logs", detail: `delete ${plural(facts.logs.length, "log file")}` })
        }
    }
    steps.push({ kind: "directory", detail: `delete ${facts.dir}` })
    return steps
}

/**
 * The listing shown before anything happens, and printed on its own by `--dry-run`.
 *
 * Every row is a number somebody might want to stop over. A zero row is still shown where its absence
 * would be ambiguous — `service  not installed` is information, and omitting it invites the reading
 * that a service was quietly left behind.
 */
export function renderRemoval(facts: RemovalFacts): string {
    const f = facts.footprint
    const rows: Row[] = [
        {
            label: "directory",
            value: `${facts.dir}`,
            note: `${plural(facts.files.count, "file")}, ${bytes(facts.files.bytes)}`,
        },
    ]
    if (facts.agentId !== facts.ref) {
        // Worth its own row whenever they differ: everything except the directory is keyed by the id,
        // so a person who only knows the ref is reading a listing about a name they have not seen.
        rows.push({
            label: "manifest id",
            value: facts.agentId,
            note: "keys the store, logs and service",
        })
    }
    if (facts.filesOnly) {
        rows.push({
            label: "keeping",
            value: `${plural(f.sessions, "conversation")}, ${plural(f.passages, "memory passage")}, and the logs`,
            note: "--files-only",
        })
    } else {
        rows.push(
            {
                label: "sessions",
                value: `${plural(f.sessions, "conversation")}, ${plural(f.messages, "message")}, ${plural(f.turns, "turn")}`,
            },
            {
                label: "memory",
                value: `${plural(f.passages, "passage")} from ${plural(f.memorySources, "source")}`,
            },
            {
                label: "outbox",
                value:
                    f.outbox === 0
                        ? "nothing queued"
                        : `${plural(f.outbox, "delivery")}${f.outboxPending === 0 ? "" : `, ${f.outboxPending} not yet sent`}`,
                // A pending delivery is a reply somebody is waiting for, and removal abandons it.
                ...(f.outboxPending === 0 ? {} : { note: "abandoned" }),
            },
            {
                label: "schedules",
                value: f.schedules === 0 ? "none" : plural(f.schedules, "schedule"),
                // A schedule is the one thing here that would keep *firing* if it survived, so its
                // removal is the part of this listing least likely to be regretted and most likely
                // to be missed if it were absent.
                ...(f.schedules === 0 ? {} : { note: "stops firing" }),
            },
            {
                label: "logs",
                value:
                    facts.logs.length === 0
                        ? "none"
                        : `${plural(facts.logs.length, "file")}, ${bytes(facts.logs.reduce((n, l) => n + l.bytes, 0))}`,
            },
            { label: "service", value: facts.service ?? "not installed" },
        )
    }
    rows.push({
        label: "running",
        value:
            facts.running === undefined ? "no" : `pid ${facts.running.pid} (${facts.running.mode})`,
    })
    return keyValue(rows)
}

/** An agent id with rows or logs in the sandbox that no directory claims. */
export interface Orphan {
    readonly agentId: string
    readonly footprint: AgentFootprint
    readonly logs: readonly FileFacts[]
}

/**
 * The listing for `--prune`.
 *
 * Separate from `renderRemoval` because it answers a different question — not "what does this agent
 * own" but "what is left over" — and because an orphan has no directory, no ref and no manifest, so
 * most of the other rows would be empty or a lie.
 */
export function renderOrphans(orphans: readonly Orphan[]): string {
    if (orphans.length === 0) return ""
    return orphans
        .map((orphan) => {
            const f = orphan.footprint
            const parts: string[] = []
            if (f.sessions > 0) {
                parts.push(
                    `${plural(f.sessions, "conversation")}, ${plural(f.messages, "message")}`,
                )
            }
            if (f.passages > 0) parts.push(`${plural(f.passages, "memory passage")}`)
            if (f.outbox > 0) parts.push(`${plural(f.outbox, "queued delivery")}`)
            if (f.schedules > 0) parts.push(`${plural(f.schedules, "schedule")}`)
            if (f.lease) parts.push("a stale lease")
            if (orphan.logs.length > 0) {
                parts.push(
                    `${plural(orphan.logs.length, "log file")}, ${bytes(orphan.logs.reduce((n, l) => n + l.bytes, 0))}`,
                )
            }
            // Never empty: an orphan is only listed because *something* references the id, so an empty
            // parts list would mean the caller found it by some route this cannot describe.
            return `  ${orphan.agentId}  ${parts.length === 0 ? "rows with no detail" : parts.join(" · ")}`
        })
        .join("\n")
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`
}
