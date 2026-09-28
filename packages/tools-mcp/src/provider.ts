/**
 * The MCP tool provider: remote Streamable-HTTP servers, their tools pinned by name.
 *
 * ```yaml
 * tools:
 *   providers:
 *     mcp:
 *       servers:
 *         huly:
 *           url: http://127.0.0.1:3000/mcp
 *           headersEnv: { Authorization: HULY_MCP_AUTH }   # header → env var NAME
 *           participantHeader: X-Acting-Participant        # who the turn acts for (doc 16 R7)
 *           policyArgs: { invoke_tool: toolName }          # a proxy tool's inner tool, for policy
 *   pinned: [huly__search_tools, huly__get_tool_schema, huly__invoke_tool]
 * ```
 *
 * The same shape as Composio, on purpose (decision 14.22): **boot resolves from the cache and
 * contacts no server**, so a server that is down cannot hold `runtime.ready`; `refresh` runs after
 * readiness and rewrites the cache; a cold cache names `tools --warm` rather than blaming the slugs.
 * MCP is how an agent reaches somebody else's tools. It is not how this runtime is built — Composio
 * stays a direct client (decision 4.7).
 */

import type {
    ConfigError,
    Tool,
    ToolAvailability,
    ToolContext,
    ToolProvider,
    ToolProviderContext,
    ToolProviderRefresh,
} from "@dispach/core"
import { type CachedServer, cachePath, type McpCache, readCache, writeCache } from "./cache.ts"
import { type FetchLike, type McpCallResult, McpClient, type McpTool } from "./client.ts"
import {
    mcpCacheMiss,
    mcpConfigInvalid,
    mcpHeaderEnvMissing,
    mcpRequestFailed,
    mcpToolFailed,
} from "./errors.ts"
import { SEPARATOR, slugOf, toSpec } from "./map.ts"

export interface McpServerConfig {
    readonly name: string
    readonly url: string
    /** Header name → the env var holding its value. Names only (hard rule 10). */
    readonly headersEnv: Readonly<Record<string, string>>
    readonly participantHeader?: string
    /** MCP tool name → the argument a policy rule matches. */
    readonly policyArgs: Readonly<Record<string, string>>
    readonly timeoutMs: number
}

const SERVER_KEYS = ["url", "headersEnv", "participantHeader", "policyArgs", "timeoutMs"] as const
const DEFAULT_TIMEOUT_MS = 30_000
/** `available()` is billed every turn; a server in native mode lists hundreds. */
const AVAILABLE_LIMIT = 40

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined
}

function stringMap(value: unknown, field: string, check?: RegExp): Record<string, string> {
    if (value === undefined) return {}
    const map = record(value)
    const entries = map === undefined ? undefined : Object.entries(map)
    const valid = entries?.every(
        ([, entry]) => typeof entry === "string" && (check === undefined || check.test(entry)),
    )
    if (entries === undefined || valid !== true) {
        throw mcpConfigInvalid(
            `${field} must map names to ${check === undefined ? "strings" : "environment variable names"}.`,
            check === undefined
                ? `Write it as a map, e.g. { invoke_tool: toolName }.`
                : `Write it as { Authorization: HULY_MCP_AUTH }: the header name, then the variable holding its value. A value never goes in the manifest.`,
            field,
        )
    }
    return Object.fromEntries(entries) as Record<string, string>
}

/** `tools.providers.mcp` → server configs, refusing anything it would otherwise ignore. */
export function parseServers(config: Readonly<Record<string, unknown>>): McpServerConfig[] {
    const extra = Object.keys(config).filter((key) => key !== "servers")
    if (extra.length > 0) {
        throw mcpConfigInvalid(
            `tools.providers.mcp has keys the MCP provider does not read: ${extra.join(", ")}.`,
            "Everything goes under servers.<name>: url, headersEnv, participantHeader, policyArgs, timeoutMs. Refused rather than ignored, because a setting that looks applied and is not is worse than a rejected manifest.",
        )
    }
    const servers = record(config.servers)
    if (servers === undefined || Object.keys(servers).length === 0) {
        throw mcpConfigInvalid(
            "tools.providers.mcp names no servers.",
            "Add servers.<name>.url, e.g. servers: { huly: { url: http://127.0.0.1:3000/mcp } }.",
            "tools.providers.mcp.servers",
        )
    }
    return Object.entries(servers).map(([name, raw]) => {
        const field = `tools.providers.mcp.servers.${name}`
        // No underscore, so `<server>__<tool>` always splits at the first `__`.
        if (!/^[a-z][a-z0-9-]{0,23}$/.test(name)) {
            throw mcpConfigInvalid(
                `The MCP server name "${name}" is not usable in a tool slug.`,
                "Use lowercase letters, digits and hyphens, starting with a letter, at most 24 characters. It prefixes every tool: huly → huly__search_tools.",
                field,
            )
        }
        const entry = record(raw) ?? {}
        const unknown = Object.keys(entry).filter(
            (key) => !SERVER_KEYS.includes(key as (typeof SERVER_KEYS)[number]),
        )
        if (unknown.length > 0) {
            throw mcpConfigInvalid(
                `${field} has keys the MCP provider does not read: ${unknown.join(", ")}.`,
                `Accepted keys are ${SERVER_KEYS.join(", ")}.`,
                field,
            )
        }
        let url: URL
        try {
            url = new URL(String(entry.url))
        } catch {
            throw mcpConfigInvalid(
                `${field}.url is not a URL.`,
                "Give the server's Streamable HTTP endpoint, e.g. http://127.0.0.1:3000/mcp.",
                `${field}.url`,
            )
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw mcpConfigInvalid(
                `${field}.url is ${url.protocol} — only HTTP servers are supported.`,
                "Streamable HTTP is the one transport this provider speaks. A stdio server needs an HTTP front (most servers have an MCP_TRANSPORT=http mode).",
                `${field}.url`,
            )
        }
        if (url.username !== "" || url.password !== "") {
            throw mcpConfigInvalid(
                `${field}.url carries a credential.`,
                "A manifest never holds a secret. Put it in an env var and name it in headersEnv, e.g. { Authorization: HULY_MCP_AUTH }.",
                `${field}.url`,
            )
        }
        const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs
        if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw mcpConfigInvalid(
                `${field}.timeoutMs must be a positive whole number of milliseconds.`,
                `Omit it for ${DEFAULT_TIMEOUT_MS} ms.`,
                `${field}.timeoutMs`,
            )
        }
        const participantHeader = entry.participantHeader
        if (participantHeader !== undefined && typeof participantHeader !== "string") {
            throw mcpConfigInvalid(
                `${field}.participantHeader must be a header name.`,
                "e.g. X-Acting-Participant. Each call then carries the id of the person the turn acts for, and none on a schedule or peer-agent turn.",
                `${field}.participantHeader`,
            )
        }
        return {
            name,
            url: url.toString(),
            headersEnv: stringMap(
                entry.headersEnv,
                `${field}.headersEnv`,
                /^[A-Za-z_][A-Za-z0-9_]*$/,
            ),
            ...(participantHeader === undefined ? {} : { participantHeader }),
            policyArgs: stringMap(entry.policyArgs, `${field}.policyArgs`),
            timeoutMs,
        }
    })
}

/** What a call returns to the model: the text parts, and a note for anything that is not text. */
export function renderResult(result: McpCallResult): string {
    const parts = (result.content ?? []).map((part) =>
        part.type === "text" && typeof part.text === "string"
            ? part.text
            : `[${part.type} content omitted]`,
    )
    if (parts.length > 0) return parts.join("\n")
    return result.structuredContent === undefined
        ? "(no content)"
        : JSON.stringify(result.structuredContent, null, 2)
}

export interface McpProviderOptions {
    readonly dir: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly servers: readonly McpServerConfig[]
    readonly fetch?: FetchLike
}

export class McpProvider implements ToolProvider {
    readonly id = "mcp"
    readonly #dir: string
    readonly #env: Readonly<Record<string, string | undefined>>
    readonly #servers: ReadonlyMap<string, McpServerConfig>
    readonly #fetch: FetchLike | undefined
    readonly #clients = new Map<string, McpClient>()
    #cache: McpCache

    constructor(options: McpProviderOptions) {
        this.#dir = options.dir
        this.#env = options.env
        this.#servers = new Map(options.servers.map((server) => [server.name, server]))
        this.#fetch = options.fetch
        this.#cache = readCache(options.dir)
    }

    /** The cached tools of a server, or none when its cache entry is for a different URL. */
    #cached(server: McpServerConfig): readonly McpTool[] | undefined {
        const entry: CachedServer | undefined = this.#cache[server.name]
        return entry === undefined || entry.url !== server.url ? undefined : entry.tools
    }

    /** Cache only: this runs inside boot, before any network call is allowed. */
    async resolve(slugs: readonly string[]): Promise<readonly Tool[]> {
        const out: Tool[] = []
        for (const server of this.#servers.values()) {
            for (const tool of this.#cached(server) ?? []) {
                if (!slugs.includes(slugOf(server.name, tool.name))) continue
                out.push(this.#toTool(server, tool))
            }
        }
        return out
    }

    async list(): Promise<readonly string[]> {
        return [...this.#servers.values()].flatMap((server) =>
            (this.#cached(server) ?? []).map((tool) => slugOf(server.name, tool.name)),
        )
    }

    async available(): Promise<readonly ToolAvailability[]> {
        const out: ToolAvailability[] = []
        for (const server of this.#servers.values()) {
            for (const tool of this.#cached(server) ?? []) {
                if (out.length >= AVAILABLE_LIMIT) return out
                out.push({
                    slug: slugOf(server.name, tool.name),
                    summary: toSpec(server.name, tool, undefined).summary,
                })
            }
        }
        return out
    }

    explainUnresolved(slugs: readonly string[]): ConfigError | undefined {
        const cold = new Set<string>()
        const ours: string[] = []
        for (const slug of slugs) {
            const server = this.#servers.get(slug.split(SEPARATOR)[0] ?? "")
            if (server === undefined || !slug.includes(SEPARATOR)) continue
            if (this.#cached(server) !== undefined) continue
            cold.add(server.name)
            ours.push(slug)
        }
        return ours.length === 0 ? undefined : mcpCacheMiss([...cold], ours, cachePath(this.#dir))
    }

    /**
     * List every server's tools and rewrite the cache. **After readiness only.**
     *
     * One server down does not cost the others their refresh: the ones that answered are written,
     * then the failure is thrown so `tools.refreshed` reports it. The agent keeps the tools it
     * resolved at boot either way.
     */
    async refresh(slugs: readonly string[], signal?: AbortSignal): Promise<ToolProviderRefresh> {
        const next: Record<string, CachedServer> = { ...this.#cache }
        const failures: { server: McpServerConfig; detail: string }[] = []
        const changed: string[] = []
        let fetched = 0
        for (const server of this.#servers.values()) {
            try {
                const tools = await this.#client(server).listTools(signal)
                const before = new Map(
                    (this.#cached(server) ?? []).map((tool) => [tool.name, JSON.stringify(tool)]),
                )
                for (const tool of tools) {
                    const slug = slugOf(server.name, tool.name)
                    if (!slugs.includes(slug)) continue
                    // Pinned tools, as `tools --warm` reports "N of M pinned tools fetched".
                    fetched += 1
                    if (before.get(tool.name) !== JSON.stringify(tool)) changed.push(slug)
                }
                next[server.name] = { url: server.url, fetchedAt: new Date().toISOString(), tools }
            } catch (error) {
                failures.push({
                    server,
                    detail: error instanceof Error ? error.message : String(error),
                })
            }
        }
        this.#cache = next
        writeCache(this.#dir, next)
        if (failures.length > 0) {
            throw mcpRequestFailed(
                failures.map((failure) => failure.server.name).join(", "),
                failures.map((failure) => failure.server.url).join(", "),
                failures.map((failure) => failure.detail).join("; "),
            )
        }
        const known = new Set(await this.list())
        const missing = slugs.filter(
            (slug) => this.#servers.has(slug.split(SEPARATOR)[0] ?? "") && !known.has(slug),
        )
        return { fetched, missing, changed }
    }

    #client(server: McpServerConfig): McpClient {
        let client = this.#clients.get(server.name)
        if (client === undefined) {
            client = new McpClient({
                server: server.name,
                url: server.url,
                timeoutMs: server.timeoutMs,
                ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
                headers: () => {
                    const headers: Record<string, string> = {}
                    for (const [header, envVar] of Object.entries(server.headersEnv)) {
                        const value = this.#env[envVar]
                        if (value === undefined || value === "") {
                            throw mcpHeaderEnvMissing(server.name, header, envVar)
                        }
                        headers[header] = value
                    }
                    return headers
                },
            })
            this.#clients.set(server.name, client)
        }
        return client
    }

    #toTool(server: McpServerConfig, tool: McpTool): Tool {
        return {
            spec: toSpec(server.name, tool, server.policyArgs[tool.name]),
            handler: async (args: Readonly<Record<string, unknown>>, context: ToolContext) => {
                // Only a person is forwarded. A schedule or a peer agent sends no header, which is
                // how the server tells "nobody in particular" from somebody (decision 14.21).
                const participant = context.actingParticipant
                const extra =
                    server.participantHeader === undefined || participant == null
                        ? {}
                        : { [server.participantHeader]: participant.id }
                const result = await this.#client(server).callTool(
                    tool.name,
                    args,
                    extra,
                    context.signal,
                )
                if (result.isError === true) {
                    throw mcpToolFailed(server.name, tool.name, renderResult(result))
                }
                return renderResult(result)
            },
        }
    }
}

export function mcpFromConfig(context: ToolProviderContext, fetch?: FetchLike): McpProvider {
    return new McpProvider({
        dir: context.dir,
        env: context.env,
        servers: parseServers(context.config),
        ...(fetch === undefined ? {} : { fetch }),
    })
}
