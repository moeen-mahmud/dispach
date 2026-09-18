/**
 * `stop [agent]` — the switch that turns everything off.
 *
 * Every other way to stop an agent needs you to know what is running first: `daemon stop` needs the
 * label, ctrl-c needs the terminal that started it, `kill` needs the pid. This one needs nothing —
 * it finds the services *and* the loose `serve` you left in a tab three days ago, stops both, and
 * says what it stopped. That is the whole design brief: a person reaching for this is not in a
 * position to go looking.
 *
 * **Stopped means stopped.** A service is disabled as well as unloaded, because `bootout` alone
 * comes back at the next login and "I stopped it and it was running again after lunch" is the exact
 * failure a safety switch may not have. Reversible, loudly: the output names `daemon start`.
 *
 * **SIGTERM first, always.** A graceful stop is the only path that runs `provider.stop()`, which
 * reaps the child processes `exec` backgrounded — so killing hard to be thorough is how you end up
 * with the orphans that took this machine to a load average of 351. SIGKILL is the last resort,
 * after a grace period, and it says out loud what may have been left behind.
 *
 * ## Naming an agent and naming nothing are different commands
 *
 * They were the same command with a filter until one process could host several agents, at which
 * point the filter became wrong: killing the process that holds `milo`'s lease takes `alpha` and
 * `beta` down with it. So:
 *
 * - **`stop <agent>`** writes that agent off in the store and asks its host to drop it. The host
 *   keeps running, every other agent it holds keeps running, and the row is what makes it stay off
 *   across a restart. It does **not** touch any service: a service hosting three agents is not
 *   something to unload because one of them was switched off.
 * - **`stop`** is unchanged — the whole host goes down, services disabled so they stay down, and
 *   nothing per-agent is written. That asymmetry is deliberate: `daemon start` should bring back
 *   exactly what was running, and an agent stopped by name should still be off when it does.
 *
 * The per-agent path falls back to signalling the process when the lease carries no address, which
 * is a `run` REPL or an embedded runtime — real states that serve no HTTP, and the only ones where
 * "stop this agent" and "stop that process" are still the same thing.
 */

import { homedir } from "node:os"
import { BRAND, HarnessError, processAlive, readManifestHeader, SqliteStore } from "@dispach/core"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { labelFor } from "#lib/launchd"
import { liveHostOf, postToHost, writeAgentState } from "#lib/lifecycle"
import { bullet, keyValue, type Row } from "#lib/render"
import { storePath } from "#lib/sandbox"
import { type Exec, resolveServiceManager, type ServiceManager } from "#lib/service"

/** How long a process gets to shut down cleanly before the last resort. */
const GRACE_MS = 12_000
const POLL_MS = 250

export interface StopOptions {
    /**
     * Absolute manifest path. Omitted means the whole host — see the file comment.
     *
     * Present and absent are two different commands rather than one with a filter: naming an agent
     * writes the durable switch and asks its host to drop it, and naming nothing takes the host
     * down. Conflating them is how stopping one agent stopped three.
     */
    readonly manifestPath?: string
    /** Why, recorded on the row and shown wherever the agent is reported as off. */
    readonly reason?: string
    /** The database to read leases and state from. Defaults to the sandbox's. */
    readonly store?: string
    readonly dryRun?: boolean
    readonly json?: boolean
    /** Test seams. Nothing in `src/` outside this file passes them. */
    readonly exec?: Exec
    readonly platform?: string
}

interface Target {
    readonly agentId: string
    /** A LaunchAgent exists for it. */
    readonly service: boolean
    /** A live process holds its runtime lease. */
    readonly pid?: number
    readonly mode?: string
}

type Outcome = Target & {
    readonly stopped: boolean
    /** Present when the graceful stop ran out of time. */
    readonly forced?: boolean
    readonly note: string
}

export async function stopCommand(options: StopOptions): Promise<number> {
    if (options.manifestPath !== undefined) {
        return await stopOneAgent(options, options.manifestPath)
    }
    return await stopEverything(options)
}

/**
 * Switch one agent off and drop it from its host.
 *
 * The state is written **first**, and the order matters: a host told to drop an agent before the row
 * exists would come back hosting it at the next restart with nobody having asked, which is the
 * failure the row exists to prevent. This way round, a host that cannot be reached leaves the agent
 * marked off, and the next start honours it — so the command's promise holds even when the request
 * does not land.
 */
async function stopOneAgent(options: StopOptions, manifestPath: string): Promise<number> {
    const agentId = agentIdOf(manifestPath)
    const notes: string[] = []

    if (options.dryRun === true) {
        const host = await liveHostOf(agentId, options.store)
        process.stdout.write(
            `would stop 1 agent:\n${bullet(
                `${agentId} — ${
                    host === undefined
                        ? "not running; would be switched off for the next start"
                        : host.baseUrl === undefined
                          ? `pid ${host.pid} (${host.mode}), which serves no HTTP — would be signalled`
                          : `pid ${host.pid} (${host.mode}) at ${host.baseUrl}, which would drop it and keep serving`
                }`,
            )}\n`,
        )
        return EXIT_OK
    }

    await writeAgentState(agentId, false, options.reason, options.store)
    notes.push("switched off for the next start")

    const host = await liveHostOf(agentId, options.store)
    let stopped = true
    if (host === undefined) {
        notes.push("nothing was running")
    } else if (host.baseUrl === undefined) {
        // A `run` REPL or an embedded runtime: no HTTP to ask, and stopping the agent really is
        // stopping the process, because that process is hosting exactly this conversation.
        const graceful = await signalAndWait(host.pid, "SIGTERM")
        stopped = graceful || (await signalAndWait(host.pid, "SIGKILL", true))
        notes.push(
            graceful
                ? `pid ${host.pid} stopped cleanly`
                : stopped
                  ? `pid ${host.pid} had to be killed`
                  : `pid ${host.pid} would not stop — check it by hand`,
        )
    } else {
        const reply = await postToHost(
            host,
            `/v1/agents/${encodeURIComponent(agentId)}/stop`,
            options.reason === undefined ? {} : { reason: options.reason },
            manifestPath,
        )
        if (reply.ok) {
            notes.push(`pid ${host.pid} dropped it and kept serving`)
        } else if (reply.status === 409) {
            // A turn is running. The row is already written, so the agent is off at the next start
            // either way — this is the one case where the command reports partial success, because
            // claiming it stopped while a turn is mid-generation would be a lie.
            stopped = false
            notes.push(reply.detail ?? "a turn is running")
        } else if (reply.status === 401) {
            stopped = false
            notes.push(
                `pid ${host.pid} refused the request — set ${BRAND.envPrefix}API_TOKEN to the server's token`,
            )
        } else {
            stopped = false
            notes.push(
                `pid ${host.pid} at ${host.baseUrl} could not be reached${
                    reply.detail === undefined ? "" : `: ${reply.detail}`
                }`,
            )
        }
    }

    const outcome: Outcome = {
        agentId,
        service: false,
        ...(host === undefined ? {} : { pid: host.pid, mode: host.mode }),
        stopped,
        note: notes.join(" · "),
    }

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ stopped: [outcome] }, null, 2)}\n`)
    } else {
        process.stdout.write(
            `${keyValue([
                {
                    label: agentId,
                    value: stopped ? "stopped" : "NOT FULLY STOPPED",
                    note: outcome.note,
                },
            ])}\n`,
        )
        process.stdout.write(
            `\nStays off across restarts. \`${BRAND.slug} start ${agentId}\` switches it back on.\n`,
        )
    }
    return stopped ? EXIT_OK : EXIT_FAILURE
}

async function stopEverything(options: StopOptions): Promise<number> {
    const platform = options.platform ?? process.platform
    // Only launchd is managed, but the lease half works everywhere — a `serve` in a terminal is a
    // process with a pid on any platform, and refusing to stop it because this is not macOS would
    // make the safety switch useless exactly where there is no service manager to fall back on.
    const manager =
        platform === "darwin"
            ? resolveServiceManager(platform, {
                  home: homedir(),
                  uid: process.getuid?.() ?? 0,
                  envPrefix: BRAND.envPrefix,
                  ...(options.exec === undefined ? {} : { exec: options.exec }),
              })
            : undefined

    // No filter any more: naming an agent takes the per-agent path above, and this one is the
    // whole host. A `stop <agent>` that unloaded a service hosting three agents would be the
    // failure 16.2a's shared process introduced.
    const targets = await findTargets(manager, options.store)

    if (targets.length === 0) {
        process.stdout.write(
            options.json === true
                ? `${JSON.stringify({ stopped: [] })}\n`
                : "Nothing is running — no service is installed and no process holds an agent.\n",
        )
        // Zero. For a command whose job is to reach a state, already being in it is success.
        return EXIT_OK
    }

    if (options.dryRun === true) {
        process.stdout.write(
            `would stop ${targets.length} ${targets.length === 1 ? "agent" : "agents"}:\n${targets
                .map((target) => bullet(describe(target)))
                .join("\n")}\n`,
        )
        return EXIT_OK
    }

    const outcomes: Outcome[] = []
    for (const target of targets) outcomes.push(await stopOne(target, manager))

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ stopped: outcomes }, null, 2)}\n`)
    } else {
        const rows: Row[] = outcomes.map((outcome) => ({
            label: outcome.agentId,
            value: outcome.stopped ? "stopped" : "STILL RUNNING",
            note: outcome.note,
        }))
        process.stdout.write(`${keyValue(rows)}\n`)

        if (outcomes.some((outcome) => outcome.service && outcome.stopped)) {
            process.stdout.write(
                `\nServices are disabled as well as unloaded, so they stay stopped across a reboot.\nStart one again with \`${BRAND.slug} daemon start <agent>\`.\n`,
            )
        }
        if (outcomes.some((outcome) => outcome.forced === true)) {
            process.stdout.write(
                `\nSomething had to be killed rather than asked. A forced stop skips the runtime's own\ncleanup, so a command the agent had left running in the background may still be alive —\n\`ps\` will show it if so.\n`,
            )
        }
    }

    return outcomes.every((outcome) => outcome.stopped) ? EXIT_OK : EXIT_FAILURE
}

/**
 * Everything that could be running, from both sources.
 *
 * Two sources because neither is complete. `launchctl` knows about installed services and nothing
 * about the `serve` you started by hand; the lease table knows about any live process and nothing
 * about a service that is installed but currently down. A safety switch that consulted one of them
 * would leave the other running and report success.
 */
async function findTargets(
    manager: ServiceManager | undefined,
    storeFile?: string,
): Promise<readonly Target[]> {
    const prefix = `${BRAND.slug}.agent.`
    const byId = new Map<string, Target>()

    for (const label of manager?.labels(prefix) ?? []) {
        const agentId = label.slice(prefix.length)
        byId.set(agentId, { agentId, service: true })
    }

    try {
        const store = await SqliteStore.open({ path: storeFile ?? storePath() })
        for (const lease of await store.leases.all()) {
            // Not this process, and not a row whose process is already gone — a stale lease is not
            // something to stop, and reporting it as one would make the command lie about its work.
            if (lease.pid === process.pid || !processAlive(lease.pid)) continue
            byId.set(lease.agentId, {
                agentId: lease.agentId,
                service: byId.get(lease.agentId)?.service === true,
                pid: lease.pid,
                mode: lease.mode,
            })
        }
        await store.close()
    } catch {
        // No store yet means nothing has ever run. Not an error for this command.
    }

    return [...byId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId))
}

async function stopOne(target: Target, manager: ServiceManager | undefined): Promise<Outcome> {
    const notes: string[] = []

    // The service first. Unloading it sends SIGTERM to the process itself, so doing this before the
    // direct signal avoids racing launchd's own restart policy — and disabling means it will not be
    // back at the next login.
    if (target.service && manager !== undefined) {
        try {
            manager.stop(labelFor(BRAND.slug, target.agentId))
            notes.push("service disabled and unloaded")
        } catch (error) {
            notes.push(
                `service could not be unloaded: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    if (target.pid === undefined) {
        return { ...target, stopped: true, note: notes.join(" · ") || "no process was running" }
    }

    // Already gone, most likely because unloading the service took it with it.
    if (!processAlive(target.pid)) {
        return { ...target, stopped: true, note: notes.join(" · ") || `pid ${target.pid} exited` }
    }

    const graceful = await signalAndWait(target.pid, "SIGTERM")
    if (graceful) {
        notes.push(`pid ${target.pid} stopped cleanly`)
        return { ...target, stopped: true, note: notes.join(" · ") }
    }

    // Last resort, and by process *group* — `sh -c "a | b | c"` killed by pid orphans two of three,
    // which is the shape decision 4.88 was written about.
    const forced = await signalAndWait(target.pid, "SIGKILL", true)
    notes.push(
        forced
            ? `pid ${target.pid} did not stop in ${Math.round(GRACE_MS / 1000)}s and was killed`
            : `pid ${target.pid} would not stop, even killed — check it by hand`,
    )
    return { ...target, stopped: forced, forced: true, note: notes.join(" · ") }
}

async function signalAndWait(pid: number, signal: NodeJS.Signals, group = false): Promise<boolean> {
    try {
        process.kill(group ? -pid : pid, signal)
    } catch (error) {
        // ESRCH means it went away between the check and the signal, which is the outcome we want.
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
        // A group kill can fail where the single-pid kill would not; fall back rather than give up.
        if (group) {
            try {
                process.kill(pid, signal)
            } catch {
                return !processAlive(pid)
            }
        }
    }

    const deadline = Date.now() + (signal === "SIGKILL" ? 3_000 : GRACE_MS)
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    return !processAlive(pid)
}

function describe(target: Target): string {
    const parts: string[] = []
    if (target.service) parts.push("background service")
    if (target.pid !== undefined)
        parts.push(`pid ${target.pid}${target.mode === undefined ? "" : ` (${target.mode})`}`)
    return `${target.agentId} — ${parts.join(", ")}`
}

function agentIdOf(manifestPath: string): string {
    const header = readManifestHeader(manifestPath)
    if (header.id === undefined || header.id === "") {
        throw new HarnessError({
            code: "cli_stop_agent_id_missing",
            message: `${manifestPath} declares no id, so there is nothing to match a running agent against.`,
            hint: `Add \`id: <name>\` to the manifest, or run \`${BRAND.slug} stop\` with no argument to stop everything.`,
        })
    }
    return header.id
}
