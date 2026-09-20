/**
 * `start <agent>` — the other half of `stop <agent>`.
 *
 * Switches the durable flag back on and, when something is already serving, asks that host to adopt
 * the agent so it is live before this command returns. Nothing else restarts: the host keeps its
 * other agents, their conversations and their channels.
 *
 * **Why this is not `daemon start`.** That one starts a *service* — a process. This one starts an
 * *agent*, which since 16.2a is a different thing: one process hosts several, and the question "is
 * milo running" stopped being answerable by looking at pids. `daemon start` brings the host back;
 * this decides what the host holds.
 *
 * **The row is written even when no host is reachable**, and that is the point rather than a
 * fallback. `stop` persists, so the only thing that can undo it is a write — and an agent enabled
 * while nothing is running comes up at the next start, which is exactly what somebody switching it
 * back on at 2am before a morning restart is asking for.
 */

import { BRAND, HarnessError, readManifestHeader } from "@dispach/core"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { agentStateOf, anyLiveHost, postToHost, writeAgentState } from "#lib/lifecycle"
import { keyValue } from "#lib/render"

export interface StartOptions {
    /** Absolute manifest path. Required — there is no "start everything", see below. */
    readonly manifestPath: string
    /** The database to read leases and state from. Defaults to the sandbox's. */
    readonly store?: string
    readonly json?: boolean
}

export async function startCommand(options: StartOptions): Promise<number> {
    const agentId = agentIdOf(options.manifestPath)
    const before = await agentStateOf(agentId, options.store)
    const notes: string[] = []

    if (before?.enabled === true) {
        // Not an error. The caller asked for a state that already holds, and refusing would make a
        // retried command look like a mistake — the same reasoning `AgentStateStore` applies to
        // disabling something already off.
        notes.push("was already switched on")
    }
    await writeAgentState(agentId, true, undefined, options.store)

    /**
     * **Any** live host, not the one holding this agent's lease — it has none.
     *
     * `stop` disposed the agent, which released its lease, so the obvious lookup finds nothing and
     * this command would announce that nothing was running with a host sitting right there. Caught
     * by running `stop` and `start` in order against a real process; each read correctly on its own.
     */
    const host = await anyLiveHost(options.store)
    let running = false
    if (host === undefined) {
        notes.push("nothing is serving yet — it will be hosted at the next start")
    } else if (host.baseUrl === undefined) {
        // A `run` REPL holds the lease. It built its own runtime around one agent and has no HTTP
        // surface to ask, so there is nothing to adopt into — and the agent is already reachable in
        // that session anyway. Said rather than silently skipped.
        notes.push(`pid ${host.pid} is a ${host.mode} session, which serves no HTTP to adopt into`)
    } else {
        const reply = await postToHost(
            host,
            `/v1/agents/${encodeURIComponent(agentId)}/start`,
            {},
            options.manifestPath,
        )
        if (reply.ok) {
            running = true
            notes.push(`adopted by pid ${host.pid}, live now`)
        } else if (reply.status === 501) {
            // A host built without the sandbox lookup — an embedder, or the container image, which
            // passes none on purpose. The flag is still written, so a restart picks it up.
            notes.push(`pid ${host.pid} cannot look up manifests — restart it to pick this up`)
        } else if (reply.status === 401) {
            notes.push(
                `pid ${host.pid} refused the request — set ${BRAND.envPrefix}API_TOKEN to the server's token`,
            )
        } else {
            notes.push(
                `pid ${host.pid} could not adopt it${
                    reply.detail === undefined ? "" : `: ${reply.detail}`
                }`,
            )
        }
    }

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    started: [
                        {
                            agentId,
                            enabled: true,
                            running,
                            ...(host === undefined ? {} : { pid: host.pid, mode: host.mode }),
                            note: notes.join(" · "),
                        },
                    ],
                },
                null,
                2,
            )}\n`,
        )
    } else {
        process.stdout.write(
            `${keyValue([
                {
                    label: agentId,
                    value: running ? "running" : "switched on",
                    note: notes.join(" · "),
                },
            ])}\n`,
        )
        if (!running && host !== undefined && host.baseUrl !== undefined) {
            // The one case worth a second line: the flag is on and the agent is not, so somebody
            // walking away now would believe it was running. The 57 MB log's lesson — say it where
            // the person is looking.
            process.stdout.write(
                `\nSwitched on but not yet running. \`${BRAND.slug} daemon restart\` picks it up.\n`,
            )
        }
    }

    // Zero when the flag is on, which is what was asked for even if no host could be reached: the
    // command's promise is the durable state, and the note says whether it is live as well.
    return host !== undefined && host.baseUrl !== undefined && !running ? EXIT_FAILURE : EXIT_OK
}

function agentIdOf(manifestPath: string): string {
    const header = readManifestHeader(manifestPath)
    if (header.id === undefined || header.id === "") {
        throw new HarnessError({
            code: "cli_start_agent_id_missing",
            message: `${manifestPath} declares no id, so there is nothing to switch on.`,
            hint: "Add `id: <name>` to the manifest. The id is what the switch, the sessions and the API paths are all keyed by.",
        })
    }
    return header.id
}
