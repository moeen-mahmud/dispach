/**
 * `restart` — reload one agent where it is running, or restart the service that runs them all.
 *
 * Two different sizes of the same verb. Named an agent, this asks the host holding it to rebuild
 * that agent from disk (`POST /v1/agents/:id/reload`): the pairing written a moment ago, the token
 * added to `.env`, the edited `agent.yaml` — picked up without touching the other agents in the
 * process. Bare, it is `daemon restart`: the whole service, which is what you want when the *host*
 * is the thing that changed (a new version, a bad state).
 *
 * An agent nothing is hosting is adopted rather than refused, when a host exists to adopt it:
 * "restart this" on an agent that was never started means "make it run", and answering "it is not
 * running" to that is correct and useless.
 */

import { BRAND, HarnessError } from "@dispach/core"
import { daemonCommand } from "#daemon"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { adoptOnHost, reloadOnHost } from "#lib/host-actions"
import { agentIdFor, anyLiveHost } from "#lib/lifecycle"
import { keyValue } from "#lib/render"

export interface RestartOptions {
    /** Absent restarts the background service. */
    readonly manifestPath?: string
    readonly store?: string
    readonly json?: boolean
}

export async function restartCommand(options: RestartOptions): Promise<number> {
    if (options.manifestPath === undefined) {
        return await daemonCommand({
            action: "restart",
            ...(options.store === undefined ? {} : { store: options.store }),
            ...(options.json === undefined ? {} : { json: options.json }),
        })
    }

    const agentId = agentIdFor(options.manifestPath)
    const result = await reloadOnHost(options.manifestPath, options.store)

    let value: string
    let note: string
    let code = EXIT_OK
    switch (result.kind) {
        case "reloaded":
            value = "reloaded"
            note = `pid ${result.pid} rebuilt it from disk${
                result.adopted.length > 0 ? ` · adopted ${result.adopted.join(", ")}` : ""
            }`
            break
        case "busy":
            value = "not reloaded"
            note = `pid ${result.pid} has a turn in flight — try again when it finishes`
            code = EXIT_FAILURE
            break
        case "failed":
            value = "not reloaded"
            note = `pid ${result.pid} answered ${result.status}${
                result.detail === undefined ? "" : `: ${result.detail}`
            }${result.hint === undefined ? "" : ` — ${result.hint}`}`
            code = EXIT_FAILURE
            break
        case "no-host": {
            // Nobody holds it. A host that exists can take it; none at all is the service's problem.
            const host = await anyLiveHost(options.store)
            if (host === undefined) {
                throw new HarnessError({
                    code: "cli_restart_nothing_running",
                    message: `Nothing is hosting ${agentId}, and no server is running to adopt it.`,
                    hint: `\`${BRAND.slug} serve ${agentId}\` runs it in this terminal; \`${BRAND.slug} daemon install\` keeps a server running that hosts every agent. Then \`${BRAND.slug} restart ${agentId}\` reloads it in place.`,
                })
            }
            const adopted = await adoptOnHost(host, options.manifestPath, options.store)
            if (adopted.ok) {
                value = "started"
                note = `nothing was hosting it — adopted by pid ${host.pid}`
            } else {
                value = "not started"
                note = `pid ${host.pid} did not adopt it${
                    adopted.detail === undefined ? "" : `: ${adopted.detail}`
                }`
                code = EXIT_FAILURE
            }
            break
        }
    }

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ agentId, result, ok: code === EXIT_OK }, null, 2)}\n`,
        )
    } else {
        process.stdout.write(`${keyValue([{ label: agentId, value, note }])}\n`)
    }
    return code
}
