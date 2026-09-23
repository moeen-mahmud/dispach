/**
 * The `web` command — the browser as a second view onto the same running agent.
 *
 * The terminal twin of 17.1, and it exists for the same reason: the server owns the agent, and a
 * front end attaches. `run` opens a terminal onto a host; this opens a browser onto the same one,
 * at the same address, holding the same conversation. Neither starts or stops anything.
 *
 * ## Why this is three verbs and not one
 *
 * `run` is what a person types. It needs a host, so it declares `needsServer` and the first-run
 * bootstrap gets one. `open` assumes a host is already there and says so when it is not — the
 * difference matters on a machine where starting a service is not wanted. `url` prints and opens
 * nothing, which is the only form that works in a pipe, in CI, and over SSH.
 *
 * ## The container
 *
 * There is no browser in a container and there never will be, so `no-opener` is an ordinary answer
 * rather than a failure: the URL is printed and the operator opens it from the machine whose port
 * is published. This is the deployment target, so it is the case the wording is written for.
 */

import { BRAND } from "@dispach/core"
import { openInBrowser, openMessage } from "#lib/browser"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { agentIdFor, anyLiveHost, hostToken, liveHostOf } from "#lib/lifecycle"
import type { WebOptions } from "#lib/schema"
import { webUrl } from "#lib/web-url"

export { webUrl }

export async function webCommand(options: WebOptions): Promise<number> {
    const action = options.action ?? "run"
    const agentId =
        options.manifestPath === undefined ? undefined : agentIdFor(options.manifestPath)

    /**
     * Which host, and the same two-part answer `stop` and `run` use.
     *
     * A lease says who is serving an agent; its `base_url` says where, and is published after the
     * bind rather than derived from a manifest — `--port 0` means the port does not exist until the
     * socket does. With no agent named, any live host will do: the page lists what it hosts.
     */
    const lease =
        agentId === undefined
            ? await anyLiveHost(options.store)
            : await liveHostOf(agentId, options.store)

    if (lease?.baseUrl === undefined || lease.baseUrl === "") {
        process.stderr.write(
            `no ${BRAND.name} server is running${agentId === undefined ? "" : ` for "${agentId}"`}.\n` +
                `  hint: ${BRAND.slug} serve${agentId === undefined ? "" : ` ${agentId}`} starts one in this terminal, and ${BRAND.slug} daemon install keeps it running.\n`,
        )
        return EXIT_FAILURE
    }

    const url = webUrl(lease.baseUrl, agentId)
    if (action === "url") {
        // Only the URL, on stdout, with nothing else — this is the form a script reads.
        process.stdout.write(`${url}\n`)
        return EXIT_OK
    }

    const outcome = await openInBrowser(url, {
        isTty: process.stdout.isTTY === true,
        ...(options.noOpen === true ? { noOpen: true } : {}),
    })
    process.stdout.write(`${openMessage(url, outcome)}\n`)

    // A browser that did not open is not a failed command: the URL is the deliverable and it has
    // been printed. `web url` exists for the caller that wants only that and no sentence around it.
    if (!outcome.opened && options.json === true) {
        process.stdout.write(`${JSON.stringify({ url, opened: false, why: outcome.refusal })}\n`)
    }

    // The credential the page may ask for, named where somebody is already looking — and only when
    // this server has one to demand. A token-less loopback server needs nothing, and telling its
    // operator to mint a key would send them after a problem they do not have.
    if (outcome.opened && hostToken(options.manifestPath ?? "") !== undefined) {
        process.stdout.write(
            `  if the page asks for a credential, mint one:\n` +
                `    ${BRAND.slug} credential create --label 'my browser'\n`,
        )
    }
    return EXIT_OK
}
