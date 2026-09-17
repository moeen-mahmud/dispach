/**
 * The bootstrap credential: one ticket, spent once, gone on restart.
 *
 * ## The problem it solves
 *
 * A container's operator token lives in the environment, which is right for a platform calling
 * server-to-server and useless for a person opening a browser: pasting the long-lived credential
 * that every scheduled job also uses into a web form makes the one secret that cannot be rotated
 * the one most widely handled. Operator keys exist so a browser session has its own revocable
 * credential — and minting the *first* one needs an authority that exists before any key does.
 *
 * The answer is that **reading the server's own log output confers first ownership**. `serve` prints
 * a claim URL at boot; whoever can see it can exchange it for exactly one key. That is a real
 * privilege boundary rather than a convenience: `docker logs` is already enough to read the agent's
 * conversations, so it is not a new capability — and it survives a public bind, because a claim is
 * not guessable and not reachable by anyone who has not seen the line.
 *
 * ## Why it is in memory and not in the store
 *
 * "Dies on restart" is a property worth having and a persisted ticket cannot have it: a row would
 * outlive the process that printed it, so a claim URL scrolled past three restarts ago would still
 * work. Holding it in the process makes the lifetime structural rather than a cleanup job — the
 * same argument `approvals.ts` makes for keeping pending approvals out of the database, one layer
 * down. The cost is stated: a restart invalidates an unclaimed ticket, and the next boot prints a
 * new one.
 *
 * ## Why it is created outside and injected
 *
 * `serve` prints it, the handler consumes it, and neither can be the owner — a handler that minted
 * one could not hand it back for printing, and a CLI that owned the consumption would be deciding
 * an authentication question. Same shape as `running` and `approvals`: created once by the caller
 * that knows whether it is wanted, passed to both surfaces.
 */

import { newKeySecret } from "@dispach/core"

export interface ClaimTicket {
    /**
     * The single-use secret, in full. Printed once and never stored.
     *
     * A whole key secret rather than a shorter nonce, because it travels the same path a key does —
     * an `Authorization` header — and a second format would mean a second parser and a second set
     * of length assumptions on the one code path where a mistake is a bypass.
     */
    readonly token: string
    /** Whether it can still be exchanged. `false` once spent. */
    live(): boolean
    /**
     * Spend it. `true` exactly once, for the caller that got there first.
     *
     * Synchronous and self-contained so the check and the spend cannot be separated by an `await` —
     * two simultaneous claims against a read-then-write would both see an unspent ticket and both
     * succeed, which is the one thing a single-use credential must not do.
     */
    spend(): boolean
}

export function createClaimTicket(): ClaimTicket {
    const token = newKeySecret()
    let spent = false
    return {
        token,
        live: () => !spent,
        spend: () => {
            if (spent) return false
            spent = true
            return true
        },
    }
}

/**
 * The line to print, given where the server is actually listening.
 *
 * **A command rather than a URL, and the plan said URL.** Two reasons, and the second is the one
 * that decides it. A claim mints a credential, so it has to be a `POST` — a `GET` that spends a
 * single-use token is one a link preview, a crawler or a browser pre-fetch can burn before the
 * person clicks it, and the failure would look like a ticket that never worked. And a URL implies a
 * page that reads it, which is 15.3's job: printing one now would be printing a link to a `404`.
 *
 * So the claim travels as a bearer token like every other credential here, on the one code path
 * where a second format would mean a second parser. When the UI lands it can carry the same token
 * in a query string to a page that POSTs it — at which point the token is in a browser's history,
 * which is a cost worth stating then rather than assuming now.
 *
 * The host is the *bound* one rather than the manifest's, because a manifest can say `0.0.0.0` and
 * a command naming that is one nobody can run. The wildcard forms are shown as loopback for display
 * only; the server really is on every interface.
 */
export function claimCommand(host: string, port: number, token: string): string {
    const shown = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host
    const bracketed = shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown
    return `curl -sX POST http://${bracketed}:${port}/v1/keys -H 'Authorization: Bearer ${token}' -H 'content-type: application/json' -d '{"label":"my browser"}'`
}
