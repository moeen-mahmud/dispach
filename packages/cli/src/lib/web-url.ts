/**
 * The address a person opens for an agent's browser view.
 *
 * In `lib/` rather than in `web.ts` because three commands print it — `web`, `init` and
 * `channels pair` — and `web.ts` is imported lazily by the entry point, so a static import of it
 * from another command would make one module both static and dynamic, which the bundler splits
 * into a duplicate export (`boundaries.test.ts` refuses the mix for that reason).
 */

import { browsableHost } from "@dispach/server"

/**
 * No credential is attached. A claim is minted at boot and printed by `serve`, deliberately once —
 * a fresh one per invocation would leave a standing credential in a log — and a durable key in an
 * address bar lands in history, a bookmark and whatever syncs them. The page asks when it has to.
 */
export function webUrl(baseUrl: string, agentId?: string): string {
    const url = new URL(baseUrl)
    url.pathname = "/"
    /**
     * A bind is not an address, and the container is where that stops being theoretical.
     *
     * The lease publishes what was actually bound, which inside the image is `0.0.0.0` — every
     * interface, and a link no browser can open. `browsableHost` is the same substitution
     * `claimUrl` has always made, shared rather than copied a third time. Found by running this
     * *in the container*: on a laptop `serve` binds `127.0.0.1` and the substitution never fires,
     * so the defect is invisible everywhere except where it is deployed.
     */
    url.hostname = browsableHost(url.hostname)
    if (agentId !== undefined && agentId !== "") url.searchParams.set("agent", agentId)
    return url.toString()
}
