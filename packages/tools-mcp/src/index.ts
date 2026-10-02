/**
 * `@dispach/tools-mcp` — tools from remote MCP servers over Streamable HTTP.
 *
 * A first-party plugin, like Composio's, and supplied by the CLI and the container so a manifest
 * needs no `plugins:` entry. See `provider.ts` for the manifest shape and decision 14.22 for why MCP
 * is a provider here and never the runtime's own architecture.
 */

import type { Plugin } from "@dispach/core"
import { mcpFromConfig } from "./provider.ts"

export { type CachedServer, cachePath, type McpCache, readCache, writeCache } from "./cache.ts"
export {
    type FetchLike,
    type McpCallResult,
    McpClient,
    type McpClientOptions,
    type McpTool,
    PROTOCOL_VERSION,
    sseMessages,
} from "./client.ts"
export {
    mcpCacheMiss,
    mcpConfigInvalid,
    mcpHeaderEnvMissing,
    mcpRequestFailed,
    mcpToolFailed,
} from "./errors.ts"
export { isMutating, SEPARATOR, slugOf, toSpec } from "./map.ts"
export {
    McpProvider,
    type McpProviderOptions,
    type McpServerConfig,
    mcpFromConfig,
    parseServers,
    renderResult,
} from "./provider.ts"

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

export default {
    name: "mcp",
    version: VERSION,
    dispachApi: "^0.2",
    permissions: [
        // Whatever servers the manifest names; loopback in VelaCrew's shape.
        { kind: "network", hosts: ["<tools.providers.mcp.servers.*.url>"] },
        { kind: "fs", paths: ["<state>/mcp.cache.json"], mode: "write" },
    ],
    setup(context) {
        context.defineToolProvider("mcp", (provider) => mcpFromConfig(provider))
    },
} satisfies Plugin
