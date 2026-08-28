/**
 * The `schedules` command — what is scheduled, when it fires next, and whether the last run worked.
 *
 * **It reads, enables and disables. It does not write a schedule.** Creating one here would be a
 * third writer beside the manifest and the API, each with its own idea of a valid expression, and
 * the manifest is where a schedule belongs — it survives a rebuild and shows up in a diff. What the
 * CLI adds is the two questions a file cannot answer: when this actually fires next, and how the
 * last run went.
 *
 * The distinction the listing exists to make is the one `status` had to learn: **running and working
 * are different questions.** A schedule can be perfectly configured, listed, enabled, and silently
 * failing every night — so `LAST` carries the outcome, not just the time.
 */

import { Runtime, type ScheduleRecord } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import { CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { ago } from "#lib/render"
import { storePath } from "#lib/sandbox"
import type { SchedulesOptions } from "#lib/schema"

function pad(value: string, width: number): string {
    return value.length >= width ? value : value + " ".repeat(width - value.length)
}

/**
 * When it next fires, in words.
 *
 * A schedule that is *disabled* has a due time — it is kept current so enabling it does not fire it
 * at once — and printing that time would say it is about to run. `off` is the true answer.
 */
function nextIn(schedule: ScheduleRecord, now: number): string {
    if (!schedule.enabled) return "off"
    if (schedule.nextRunAt === undefined) return "done"
    const delta = Date.parse(schedule.nextRunAt) - now
    if (delta <= 0) return "due"
    const minutes = Math.round(delta / 60_000)
    if (minutes < 60) return `in ${minutes}m`
    const hours = Math.round(delta / 3_600_000)
    return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`
}

/** The outcome of the last run, which is the half of "is this working" a due time cannot answer. */
function lastRun(schedule: ScheduleRecord, now: number): string {
    if (schedule.lastFiredAt === undefined) return "never run"
    const when = ago(schedule.lastFiredAt, now)
    if (schedule.lastStatus === "error") return `FAILED ${when}`
    return `ok ${when}`
}

function printList(schedules: readonly ScheduleRecord[], now: number): void {
    if (schedules.length === 0) {
        // Exit 0: an agent with no schedules is a correct answer to the question asked. The line
        // says where they come from, because "none" alone leaves somebody looking for a subcommand.
        process.stdout.write("no schedules — add a `schedules:` block to the manifest\n")
        return
    }

    const idWidth = Math.max(8, ...schedules.map((s) => s.id.length))
    const whenWidth = Math.max(4, ...schedules.map((s) => `${s.kind} ${s.expr}`.length))
    process.stdout.write(
        `${pad("SCHEDULE", idWidth)}  ${pad("WHEN", whenWidth)}  ${pad("NEXT", 7)}  LAST\n`,
    )
    for (const schedule of schedules) {
        process.stdout.write(
            `${pad(schedule.id, idWidth)}  ${pad(`${schedule.kind} ${schedule.expr}`, whenWidth)}  ` +
                `${pad(nextIn(schedule, now), 7)}  ${lastRun(schedule, now)}\n`,
        )
    }

    // Named once at the bottom rather than as a column: it is true of every row and a column would
    // spend width repeating it.
    const failing = schedules.filter((s) => s.lastStatus === "error")
    if (failing.length > 0) {
        process.stdout.write(
            `\n${failing.length} failing — \`schedules --id ${failing[0]?.id}\` for the error\n`,
        )
    }
}

function printOne(schedule: ScheduleRecord): void {
    const rows: [string, string][] = [
        ["kind", `${schedule.kind} ${schedule.expr}`],
        ["timezone", schedule.timezone ?? "(host)"],
        ["task", schedule.task],
        [
            "deliver",
            schedule.deliverChannel === undefined
                ? "none — the reply reaches the event stream only"
                : `${schedule.deliverChannel} → ${schedule.deliverTo}`,
        ],
        ["session", schedule.sessionMode],
        ["model role", schedule.role ?? "main"],
        ["enabled", schedule.enabled ? "yes" : "no"],
        ["declared in", schedule.origin === "manifest" ? "agent.yaml" : "the API"],
        ["next run", schedule.nextRunAt ?? "(never again)"],
        ["runs", String(schedule.runs)],
        ["last run", schedule.lastFiredAt ?? "never"],
        ["last status", schedule.lastStatus ?? "-"],
    ]
    if (schedule.lastError !== undefined) rows.push(["last error", schedule.lastError])

    const width = Math.max(...rows.map(([label]) => label.length))
    process.stdout.write(`${schedule.id}\n`)
    for (const [label, value] of rows) {
        process.stdout.write(`  ${pad(label, width)}  ${value}\n`)
    }
}

/** One address this agent has actually been reached on, and can therefore deliver to. */
export interface Recipient {
    readonly channelId: string
    readonly address: string
    readonly lastSeen: string
}

/**
 * Addresses `deliver.to` can name, derived from sessions this agent has actually had.
 *
 * **Observed, never guessed.** The alternative — asking the transport to resolve a handle — is the
 * thing that cannot work: Telegram will not tell a bot the chat id behind an `@name`, and a private
 * chat has no other address. What the store holds is the id a real inbound message arrived on, which
 * is the one value known to route.
 *
 * Filtered to *declared channel ids*, so `local`, `api` and `schedule` sessions are left out. They
 * are sessions and they are not places a reply can be sent, and listing them under a heading that
 * says "what deliver.to takes" would be four wrong answers beside one right one.
 *
 * Pure, and takes plain rows rather than a store, so the shaping is testable without a runtime.
 */
export function recipientsFrom(
    sessions: readonly {
        readonly channel: string
        readonly peerId: string
        readonly lastActivityAt: string
    }[],
    channelIds: readonly string[],
): readonly Recipient[] {
    const declared = new Set(channelIds)
    const latest = new Map<string, Recipient>()

    for (const session of sessions) {
        if (!declared.has(session.channel)) continue
        const key = `${session.channel}\u0000${session.peerId}`
        const seen = latest.get(key)
        // One row per address, carrying the most recent contact: the same peer opens a new session
        // per thread, and three rows for one person is a list that has to be read twice.
        if (seen !== undefined && seen.lastSeen >= session.lastActivityAt) continue
        latest.set(key, {
            channelId: session.channel,
            address: session.peerId,
            lastSeen: session.lastActivityAt,
        })
    }

    return [...latest.values()].sort((a, b) =>
        a.channelId === b.channelId
            ? b.lastSeen.localeCompare(a.lastSeen)
            : a.channelId.localeCompare(b.channelId),
    )
}

function printRecipients(recipients: readonly Recipient[], now: number): void {
    if (recipients.length === 0) {
        // Exit 0 and say why it is empty. "None" on its own reads as a broken query, and the real
        // cause is almost always that nobody has messaged the agent yet.
        process.stdout.write(
            "no addresses yet — this agent has had no conversation on a declared channel.\n" +
                "  An address appears here once a first message arrives on one.\n",
        )
        return
    }

    const channelWidth = Math.max(7, ...recipients.map((r) => r.channelId.length))
    const addressWidth = Math.max(7, ...recipients.map((r) => r.address.length))
    process.stdout.write(
        `${pad("CHANNEL", channelWidth)}  ${pad("ADDRESS", addressWidth)}  LAST SEEN\n`,
    )
    for (const recipient of recipients) {
        process.stdout.write(
            `${pad(recipient.channelId, channelWidth)}  ${pad(recipient.address, addressWidth)}  ` +
                `${ago(recipient.lastSeen, now)}\n`,
        )
    }

    // The whole reason the listing exists, so it is not left to be inferred from the shape of the
    // values. A handle is what `allowFrom` holds and what a person recognises, and for a private
    // chat it is the one thing that cannot work.
    process.stdout.write(
        "\nUse an ADDRESS in deliver.to. On Telegram an @name addresses a channel and\n" +
            "never a person — a private chat is reached by the numeric id above.\n",
    )
}

export async function schedulesCommand(options: SchedulesOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        // The sandbox store — the same one `serve` writes to, or this inspects nothing.
        store: options.store ?? storePath(),
        toolProviders: TOOL_PROVIDERS,
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv([options.manifestPath]),
        // Read-only, and a lease is a claim to *serve*. Taking one here would make a listing refuse
        // to run while the agent is actually being served, which is when it is most wanted.
        lease: false,
    })
    onExit(() => runtime.stop("cli-exit"))

    const agent = runtime.list()[0]
    if (agent === undefined) throw new Error("The manifest produced no agent.")
    const now = Date.now()

    for (const [id, enabled] of [
        [options.enable, true],
        [options.disable, false],
    ] as const) {
        if (id === undefined) continue
        const existing = await agent.store.schedules.get(agent.id, id)
        if (existing === undefined) {
            process.stderr.write(
                `no schedule "${id}" on ${agent.id}\n` +
                    "  hint: run `schedules` with no flags to see what this agent has.\n",
            )
            return EXIT_FAILURE
        }

        // **Refused for a manifest-owned schedule, rather than written and silently undone.**
        //
        // The manifest owns the schedules it declares — reconciliation at the next boot restores
        // every field from the file, `enabled` included. Writing the store here therefore reported
        // success on a change that lasted until the next start of the process, which is rule 8's
        // exact shape: the flag worked, the listing agreed, and one restart later it was back on.
        // Caught by running the two commands in sequence rather than by reading either.
        //
        // Not fixed by editing `agent.yaml` from here: `manifest/edit.ts` is deliberately the one
        // writer, and a schedule lives in a sequence whose index this command has no business
        // knowing. Naming the edit is more useful than performing it — it is one line, it shows up
        // in a diff, and it survives.
        if (existing.origin === "manifest") {
            process.stderr.write(
                `${id} is declared in agent.yaml, so the manifest decides whether it runs.\n` +
                    `  Writing it here would last until the next start — reconciliation restores every\n` +
                    `  field from the file, enabled included.\n\n` +
                    `  hint: set \`enabled: ${enabled}\` on the "${id}" entry under schedules: in\n` +
                    `  ${options.manifestPath}\n`,
            )
            return EXIT_FAILURE
        }

        await agent.store.schedules.setEnabled(agent.id, id, enabled, new Date(now).toISOString())
        // Said plainly, because the surprising reading is the other one: enabling does not fire.
        process.stdout.write(
            enabled
                ? `${id} enabled — it fires at its next occurrence, not now\n`
                : `${id} disabled — still listed, and it keeps its place in the sequence\n`,
        )
    }

    if (options.recipients === true) {
        const recipients = recipientsFrom(
            await agent.store.sessions.list(agent.id),
            agent.manifest.channels.map((channel) => channel.id),
        )
        if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ recipients }, null, 2)}\n`)
            return EXIT_OK
        }
        printRecipients(recipients, now)
        return EXIT_OK
    }

    const schedules = await agent.store.schedules.list(agent.id)

    if (options.json) {
        process.stdout.write(`${JSON.stringify({ schedules }, null, 2)}\n`)
        return EXIT_OK
    }

    if (options.id !== undefined) {
        const one = schedules.find((schedule) => schedule.id === options.id)
        if (one === undefined) {
            process.stderr.write(`no schedule "${options.id}" on ${agent.id}\n`)
            return EXIT_FAILURE
        }
        printOne(one)
        return EXIT_OK
    }

    if (options.enable === undefined && options.disable === undefined) {
        printList(schedules, now)
    }
    return EXIT_OK
}
