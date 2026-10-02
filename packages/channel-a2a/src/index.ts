/**
 * `@dispach/channel-a2a` — A2A (Agent2Agent) v1.0 over JSON-RPC, as a plugin (Phase 30).
 *
 * Inbound, an agent answers peers at `/v1/agents/<id>/plugins/a2a/` and describes itself at
 * `…/plugins/a2a/.well-known/agent-card.json` (also `/.well-known/agent-card.json` while it is the only
 * agent that does). Outbound, `a2a_send(peer, text)` asks a peer. Public plugin API only: a channel, two
 * routes, a tool provider and an event subscription — see `config.ts` for the manifest shape.
 */

import type { Plugin } from "@dispach/core"
import { a2aTools } from "./client.ts"
import { readConfig } from "./config.ts"
import { A2AServer } from "./server.ts"

export { a2aTools, type FetchLike } from "./client.ts"
export { type A2AConfig, type PeerConfig, readConfig } from "./config.ts"
export { type A2AMessage, A2AServer, type A2ATask, PROTOCOL_VERSION, RPC } from "./server.ts"

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

export default {
    name: "a2a",
    version: VERSION,
    dispachApi: "^0.2",
    permissions: [{ kind: "network", hosts: ["*"] }],
    setup(context) {
        const config = readConfig(context.config)
        const server = new A2AServer(config, context.agentId)
        context.defineChannel("a2a", (channel) => server.transport(channel.id))
        context.defineRoute({
            method: "POST",
            path: "/",
            // Narrower than `chat`: a peer's key reaches this and nothing else on the server.
            capability: "peer",
            handler: (request) => server.rpc(request),
        })
        context.defineRoute({
            method: "GET",
            path: "/.well-known/agent-card.json",
            capability: "open",
            root: "/.well-known/agent-card.json",
            handler: async (request) => server.card(request),
        })
        context.defineToolProvider("a2a", a2aTools(config))
        context.events.on("turn.end", (event) => server.observe(event))
    },
} satisfies Plugin
