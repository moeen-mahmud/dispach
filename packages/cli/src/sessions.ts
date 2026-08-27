/**
 * The `sessions` command — inspect what the store holds.
 *
 * This exists to make persistence observable from outside the process that wrote it. A store you
 * cannot look into is a store you cannot debug, and "the history is in there somewhere" is not a
 * claim anyone should have to take on faith.
 *
 * It opens the same database the chat session uses, which is safe while a turn is running: the driver
 * puts the file in WAL mode, so a reader does not block a writer.
 */

import { type Agent, Runtime, type SessionSummary } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { DEFAULT_ROW_LIMIT, EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import { CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { ago } from "#lib/render"
import { storePath } from "#lib/sandbox"
import type { SessionsOptions } from "#lib/schema"

function pad(value: string, width: number): string {
    return value.length >= width ? value : value + " ".repeat(width - value.length)
}

/**
 * Collapse a schedule's per-run sessions into one row.
 *
 * An isolated scheduled run gets a fresh session every time — `schedule:<id>:<runId>` — which is
 * what keeps a daily brief from accumulating history it was never asked to carry, and what makes
 * "what did last Tuesday's brief say" a question with an answer. The cost lands here: a 15-minute
 * schedule writes about 35,000 sessions a year, and unfolded they bury every conversation a person
 * actually had.
 *
 * Folded by the schedule id, newest run's activity shown, with the count beside it. The individual
 * keys are still addressable — `--session schedule:brief:r_…` reads one — so nothing is hidden,
 * only summarized.
 */
interface ListRow {
    readonly sessionKey: string
    readonly phase: string | undefined
    messages: number
    turns: number
    lastActivityAt: string
    runs?: number
}

function foldScheduleRuns(sessions: readonly SessionSummary[]): readonly ListRow[] {
    const folded = new Map<string, ListRow>()
    const out: ListRow[] = []

    for (const session of sessions) {
        const parts = session.sessionKey.split(":")
        // Exactly three segments, the first `schedule`: anything else is somebody's own key and is
        // left alone. A two-segment `schedule:brief` is a shared-session schedule and is a real
        // single conversation, not a run.
        const row: ListRow = {
            sessionKey: session.sessionKey,
            phase: session.phase,
            messages: session.messages,
            turns: session.turns,
            lastActivityAt: session.lastActivityAt,
        }

        if (parts.length !== 3 || parts[0] !== "schedule") {
            out.push(row)
            continue
        }

        const id = `schedule:${parts[1]}`
        const seen = folded.get(id)
        if (seen === undefined) {
            const entry: ListRow = { ...row, sessionKey: `${id}:*`, runs: 1 }
            folded.set(id, entry)
            out.push(entry)
            continue
        }
        seen.runs = (seen.runs ?? 1) + 1
        seen.messages += session.messages
        seen.turns += session.turns
        // The listing sorts by activity, so the fold keeps the most recent of the group.
        if (session.lastActivityAt > seen.lastActivityAt) {
            seen.lastActivityAt = session.lastActivityAt
        }
    }

    return out
}

function printList(sessions: readonly SessionSummary[]): void {
    if (sessions.length === 0) {
        // Exit 0: an agent with no conversations yet is a correct answer to the question asked, not
        // a failure. The line says so rather than printing nothing.
        process.stdout.write("no sessions yet\n")
        return
    }

    const rows = foldScheduleRuns(sessions)
    const keyWidth = Math.max(7, ...rows.map((s) => s.sessionKey.length))
    process.stdout.write(
        `${pad("SESSION", keyWidth)}  ${pad("MSGS", 5)}  ${pad("TURNS", 5)}  ${pad("PHASE", 8)}  LAST\n`,
    )
    for (const session of rows) {
        const runs =
            session.runs === undefined
                ? ""
                : `  (${session.runs} run${session.runs === 1 ? "" : "s"})`
        process.stdout.write(
            `${pad(session.sessionKey, keyWidth)}  ${pad(String(session.messages), 5)}  ` +
                `${pad(String(session.turns), 5)}  ${pad(session.phase ?? "-", 8)}  ${ago(session.lastActivityAt, Date.now())}${runs}\n`,
        )
    }
}

async function printMessages(agent: Agent, sessionKey: string, limit: number): Promise<void> {
    const page = await agent.store.messages.page(agent.id, sessionKey, { limit })
    if (page.messages.length === 0) {
        process.stdout.write(`no messages in ${sessionKey}\n`)
        return
    }
    // Oldest-first for reading, though the page came back newest-first for the cursor.
    for (const message of [...page.messages].reverse()) {
        process.stdout.write(`${message.role}: ${message.content}\n`)
    }
    if (page.nextBefore !== undefined) {
        process.stdout.write("\n… older messages exist; raise --limit\n")
    }
}

async function printTurns(agent: Agent, sessionKey: string, limit: number): Promise<void> {
    const turns = await agent.turns(sessionKey, limit)
    if (turns.length === 0) {
        process.stdout.write(`no turns in ${sessionKey}\n`)
        return
    }
    process.stdout.write(
        `${pad("TURN", 22)}  ${pad("STATUS", 9)}  ${pad("STEPS", 5)}  ${pad("TOKENS", 13)}  ${pad("MS", 6)}  SOURCE\n`,
    )
    for (const turn of turns) {
        process.stdout.write(
            `${pad(turn.turnId, 22)}  ${pad(turn.status, 9)}  ${pad(String(turn.steps), 5)}  ` +
                `${pad(`${turn.promptTokens}/${turn.outputTokens}`, 13)}  ` +
                `${pad(String(turn.durationMs ?? "-"), 6)}  ${turn.source}\n`,
        )
        if (turn.errorCode !== undefined) {
            process.stdout.write(`  ${turn.errorCode}: ${turn.errorMessage}\n`)
            if (turn.errorHint !== undefined) process.stdout.write(`  hint: ${turn.errorHint}\n`)
        }
    }
}

export async function sessionsCommand(options: SessionsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        // The sandbox store — the same default `run` writes to, or `sessions` inspects nothing.
        store: options.store ?? storePath(),
        toolProviders: TOOL_PROVIDERS,
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv([options.manifestPath]),
    })
    onExit(() => runtime.stop("cli-exit"))

    const agent = runtime.list()[0]
    if (agent === undefined) throw new Error("The manifest produced no agent.")

    const limit = options.limit ?? DEFAULT_ROW_LIMIT

    if (options.clear === true) {
        if (options.sessionKey === undefined) {
            throw new Error(
                "--clear needs a session. hint: pass --session <key>; there is deliberately no way to clear every session at once.",
            )
        }
        const before = await agent.store.messages.count(agent.id, options.sessionKey)
        await agent.clearSession(options.sessionKey)
        process.stdout.write(
            `cleared ${options.sessionKey}: ${before} message(s) removed, memory files untouched\n`,
        )
        return EXIT_OK
    }

    if (options.json === true) {
        const payload =
            options.sessionKey === undefined
                ? { store: runtime.store.location, sessions: await agent.sessions() }
                : {
                      store: runtime.store.location,
                      session: await agent.store.sessions.get(agent.id, options.sessionKey),
                      messages: (
                          await agent.store.messages.page(agent.id, options.sessionKey, { limit })
                      ).messages,
                      turns: await agent.turns(options.sessionKey, limit),
                  }
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        return EXIT_OK
    }

    process.stdout.write(`store: ${runtime.store.location}\n\n`)

    if (options.sessionKey === undefined) {
        printList(await agent.sessions())
        return EXIT_OK
    }

    const session = await agent.store.sessions.get(agent.id, options.sessionKey)
    if (session === undefined) {
        // Exit 1: the user named a session that is not there. Printing "0 messages" would answer a
        // question they did not ask and hide the typo.
        process.stderr.write(
            `no session "${options.sessionKey}" for agent ${agent.id}\n` +
                `  hint: run \`sessions ${options.manifestPath}\` to list the keys that exist\n`,
        )
        return EXIT_FAILURE
    }

    if (options.turns === true) await printTurns(agent, options.sessionKey, limit)
    else await printMessages(agent, options.sessionKey, limit)
    return EXIT_OK
}
