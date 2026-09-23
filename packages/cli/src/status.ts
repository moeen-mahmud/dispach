/**
 * `status` — one screen for "is it running, and is it working?"
 *
 * Three surfaces each answered a third of that: `daemon status` knows the service unit and the
 * attention items in its log, `agents` knows what the sandbox holds and who serves it, and `/status`
 * inside a session knows one agent's channels. Somebody asking the whole question had to know all
 * three names. This prints the service report first (unchanged — it is the part with the verdicts),
 * then every agent with its host, and for each hosted agent what its channels are doing — including
 * a pairing code a host is offering, which is otherwise visible only to whoever ran `init`.
 */

import { agentRows, sandboxAgents } from "#agents"
import { daemonCommand } from "#daemon"
import { EXIT_OK } from "#lib/const"
import { type LiveChannel, liveChannels } from "#lib/host-actions"
import { keyValue, type Row } from "#lib/render"

export interface StatusOptions {
    readonly store?: string
    readonly json?: boolean
}

export async function statusCommand(options: StatusOptions): Promise<number> {
    const agents = await sandboxAgents(options.store)
    const channels = new Map<string, Map<string, LiveChannel>>()
    for (const agent of agents) {
        if (agent.serving === undefined) continue
        const live = await liveChannels(agent.manifestPath, options.store)
        if (live !== undefined) channels.set(agent.ref, live)
    }

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    agents: agents.map((agent) => ({
                        ...agent,
                        channels: [...(channels.get(agent.ref)?.values() ?? [])],
                    })),
                },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    // The service report, verdicts and attention items included. Its exit code is this command's:
    // a service that is failing is the fact that matters, whatever the agents below say.
    const code = await daemonCommand({
        action: "status",
        ...(options.store === undefined ? {} : { store: options.store }),
    })

    process.stdout.write(`${keyValue(agentRows(agents))}\n`)

    const rows: Row[] = []
    for (const [ref, live] of channels) {
        for (const channel of live.values()) {
            rows.push({
                label: `${ref} / ${channel.id}`,
                value: channel.status,
                note:
                    channel.input !== undefined
                        ? `${channel.detail ?? "enter this code"}: ${channel.input.payload}`
                        : (channel.detail ?? ""),
            })
        }
    }
    if (rows.length > 0) process.stdout.write(`\n${keyValue(rows)}\n`)
    return code
}
