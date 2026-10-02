/**
 * An MCP tool → this runtime's `ToolSpec`.
 *
 * **Slugs are `<server>__<tool>`.** Namespaced so two servers can each have a `search`, and the
 * separator is two underscores because a native tool name must match `^[a-zA-Z0-9_-]{1,64}$` at
 * every major endpoint — a dot would be refused by the model API, not by us. Characters outside that
 * set become `_`, and the original name is what the call sends.
 *
 * **Mutating unless the server says read-only.** `readOnlyHint: true` without `destructiveHint` is a
 * read; anything else, including no annotations at all, is a write. That is the fail-closed
 * direction: `mutating` serialises a call, suppresses its retry and puts it behind the write gate.
 *
 * **Untrusted, always.** A remote server's output is a stranger's text, which is the provider-tool
 * default; this module never sets `trust`.
 */

import { parametersFromJsonSchema, type ToolSpec } from "@dispach/core"
import type { McpTool } from "./client.ts"
import { mcpConfigInvalid } from "./errors.ts"

export const SEPARATOR = "__"

export function slugOf(server: string, name: string): string {
    return `${server}${SEPARATOR}${name.replace(/[^A-Za-z0-9_-]/g, "_")}`
}

export function isMutating(tool: McpTool): boolean {
    const hints = tool.annotations
    return hints?.readOnlyHint !== true || hints.destructiveHint === true
}

function firstSentence(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim()
    const stop = trimmed.search(/\.\s|\.$/)
    return stop === -1 ? trimmed : trimmed.slice(0, stop + 1)
}

/**
 * `policyArg` names the argument a policy rule matches, and for a proxy tool that is the inner
 * tool's name — so `deny huly__invoke_tool(delete_issue)` reaches the call the proxy would make.
 */
/**
 * The one-line summary, without converting the schema. `available()` lists every cached tool, and
 * one it could not convert used to throw there and refuse the whole agent (QA pilot.3).
 */
export function summaryOf(server: string, tool: McpTool): string {
    const description = (tool.description ?? tool.title ?? "").trim()
    return description === "" ? `The ${tool.name} tool on ${server}.` : firstSentence(description)
}

export function toSpec(server: string, tool: McpTool, policyArg: string | undefined): ToolSpec {
    const slug = slugOf(server, tool.name)
    const description = (tool.description ?? tool.title ?? "").trim()
    const mutating = isMutating(tool)
    return {
        slug,
        provider: "mcp",
        summary: summaryOf(server, tool),
        whenToUse: description === "" ? `the task needs ${tool.name} from ${server}` : description,
        mutating,
        tags: [server, mutating ? "write" : "read"],
        ...(policyArg === undefined ? {} : { policyArg }),
        parameters: parametersFromJsonSchema(tool.inputSchema, {
            // An MCP schema node with no type is any JSON. Huly's `invoke_tool.arguments` is one, and
            // read as a string it would ask the model to stringify an object.
            untyped: "object",
            rootPath: "inputSchema",
            unsupported: (path, keyword) =>
                mcpConfigInvalid(
                    `The MCP tool "${slug}" declares "${keyword}" at ${path}, which this runtime's schema subset cannot express.`,
                    "Refused rather than dropped: that keyword decides which arguments are valid, so ignoring it would hand the model a schema the server disagrees with. Unpin this tool, or ask the server for a flatter one.",
                    "tools.pinned",
                ),
        }),
    }
}
