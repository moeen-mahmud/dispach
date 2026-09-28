/**
 * Every way the MCP provider fails, each with the hint that names the fix.
 *
 * `ConfigError` for what a manifest edit fixes, `ToolError` for what happened during a call. A call
 * failure reaches the model as a failed observation, so its hint is written for whoever reads the
 * transcript afterwards as much as for the model.
 */

import { BRAND, ConfigError, ToolError } from "@dispach/core"

const FIELD = "tools.providers.mcp"

export function mcpConfigInvalid(message: string, hint: string, field = FIELD): ConfigError {
    return new ConfigError({ code: "mcp_config_invalid", message, hint, field })
}

export function mcpCacheMiss(
    servers: readonly string[],
    slugs: readonly string[],
    path: string,
): ConfigError {
    return new ConfigError({
        code: "mcp_cache_miss",
        message: `${slugs.length === 1 ? "A pinned MCP tool is" : `${slugs.length} pinned MCP tools are`} not in the cache: ${slugs.join(", ")}. Nothing is cached yet for ${servers.join(", ")}.`,
        hint: `Boot resolves MCP tools from ${path} and contacts no server, because nothing may touch the network before runtime.ready, and a server that is down must not stop an agent booting. Run \`${BRAND.slug} tools <manifest> --warm\` once with the server running to fill it, then start again.`,
        field: "tools.pinned",
    })
}

export function mcpHeaderEnvMissing(server: string, header: string, envVar: string): ToolError {
    return new ToolError({
        code: "mcp_header_env_missing",
        message: `The MCP server "${server}" needs the ${header} header from ${envVar}, which is not set.`,
        hint: `Set ${envVar} in the environment or in the .env beside the manifest. The manifest names the variable (${FIELD}.servers.${server}.headersEnv), never the value.`,
    })
}

export function mcpRequestFailed(server: string, url: string, detail: string): ToolError {
    return new ToolError({
        code: "mcp_request_failed",
        message: `The MCP server "${server}" at ${url} did not answer: ${detail}`,
        hint: "Check the server is running and reachable from this host (a loopback URL means the same machine or pod). If it needs a token, headersEnv names the variable that holds it. An agent keeps serving the tools it cached; only calls fail while the server is down.",
    })
}

export function mcpToolFailed(server: string, tool: string, detail: string): ToolError {
    return new ToolError({
        code: "mcp_tool_failed",
        message: `The MCP tool "${tool}" on "${server}" reported an error: ${detail}`,
        hint: "The server received the call and refused it; its own words are above. A tool outside the server's allowlist, a missing upstream credential or an invalid argument are the usual causes, and none of them is fixed by retrying the same call.",
    })
}
