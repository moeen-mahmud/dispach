/**
 * A minimal MCP client: Streamable HTTP, protocol `2025-06-18`, and the three methods a tool
 * provider needs — `initialize`, `tools/list`, `tools/call`.
 *
 * Hand-written rather than the SDK, because this is all of it: one POST per JSON-RPC message, a
 * response that is either JSON or an SSE stream carrying it, and a session id to echo. No stdio
 * (VelaCrew keeps credentials inside the server, so HTTP to loopback is the only form needed), no
 * server-initiated requests, no resumption. Verified against a live `@firfi/huly-mcp` 0.52.6.
 *
 * **A stale session is re-initialized once.** The spec answers an expired `Mcp-Session-Id` with 404,
 * and a server restart does exactly that to every client — so the first call after one retries on a
 * fresh session rather than failing. Once: a second 404 means something else.
 */

import { BRAND, VERSION } from "@dispach/core"
import { mcpRequestFailed } from "./errors.ts"

export const PROTOCOL_VERSION = "2025-06-18"

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** The fields of an MCP tool this runtime reads. */
export interface McpTool {
    readonly name: string
    readonly title?: string
    readonly description?: string
    readonly inputSchema?: Readonly<Record<string, unknown>>
    readonly annotations?: {
        readonly readOnlyHint?: boolean
        readonly destructiveHint?: boolean
    }
}

export interface McpContent {
    readonly type: string
    readonly text?: string
}

export interface McpCallResult {
    readonly content?: readonly McpContent[]
    readonly structuredContent?: unknown
    readonly isError?: boolean
}

export interface McpClientOptions {
    readonly server: string
    readonly url: string
    /** Resolved per request, so a missing variable fails the call that needs it rather than the boot. */
    readonly headers: () => Record<string, string>
    readonly fetch?: FetchLike
    readonly timeoutMs: number
}

interface RpcResponse {
    readonly id?: number | string
    readonly result?: unknown
    readonly error?: { readonly code?: number; readonly message?: string }
}

export class McpClient {
    readonly #options: McpClientOptions
    readonly #fetch: FetchLike
    #session: string | undefined
    #initializing: Promise<void> | undefined
    #nextId = 1

    constructor(options: McpClientOptions) {
        this.#options = options
        this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    }

    async listTools(signal?: AbortSignal): Promise<McpTool[]> {
        const tools: McpTool[] = []
        let cursor: string | undefined
        // Bounded, because a server returning the same cursor forever would otherwise be a hang.
        for (let page = 0; page < 100; page += 1) {
            const result = (await this.#call(
                "tools/list",
                cursor === undefined ? {} : { cursor },
                {},
                signal,
            )) as { tools?: McpTool[]; nextCursor?: string }
            for (const tool of result.tools ?? []) {
                if (typeof tool?.name === "string") tools.push(tool)
            }
            cursor = result.nextCursor
            if (cursor === undefined || cursor === "") return tools
        }
        return tools
    }

    async callTool(
        name: string,
        args: Readonly<Record<string, unknown>>,
        extraHeaders: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<McpCallResult> {
        return (await this.#call(
            "tools/call",
            { name, arguments: args },
            extraHeaders,
            signal,
        )) as McpCallResult
    }

    async #call(
        method: string,
        params: Record<string, unknown>,
        extraHeaders: Record<string, string>,
        signal: AbortSignal | undefined,
    ): Promise<unknown> {
        await this.#ensureSession(signal)
        const first = await this.#post(method, params, extraHeaders, signal)
        if (first.status !== 404 || this.#session === undefined) return this.#read(first, method)
        // The session expired or the server restarted: one fresh session, one retry.
        this.#session = undefined
        await this.#ensureSession(signal)
        return this.#read(await this.#post(method, params, extraHeaders, signal), method)
    }

    #ensureSession(signal: AbortSignal | undefined): Promise<void> {
        if (this.#session !== undefined) return Promise.resolve()
        // Shared, so two parallel tool calls on a cold client open one session rather than two.
        this.#initializing ??= this.#initialize(signal).finally(() => {
            this.#initializing = undefined
        })
        return this.#initializing
    }

    async #initialize(signal: AbortSignal | undefined): Promise<void> {
        const response = await this.#post(
            "initialize",
            {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: BRAND.slug, version: VERSION },
            },
            {},
            signal,
        )
        await this.#read(response, "initialize")
        // Absent is legal: a stateless server issues no session and wants none echoed.
        this.#session = response.headers.get("mcp-session-id") ?? ""
        const notified = await this.#send(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            {},
            signal,
        )
        await notified.body?.cancel()
    }

    #post(
        method: string,
        params: Record<string, unknown>,
        extraHeaders: Record<string, string>,
        signal: AbortSignal | undefined,
    ): Promise<Response> {
        const id = this.#nextId
        this.#nextId += 1
        return this.#send({ jsonrpc: "2.0", id, method, params }, extraHeaders, signal)
    }

    async #send(
        message: Record<string, unknown>,
        extraHeaders: Record<string, string>,
        signal: AbortSignal | undefined,
    ): Promise<Response> {
        const timeout = AbortSignal.timeout(this.#options.timeoutMs)
        try {
            return await this.#fetch(this.#options.url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    "mcp-protocol-version": PROTOCOL_VERSION,
                    ...(this.#session === undefined || this.#session === ""
                        ? {}
                        : { "mcp-session-id": this.#session }),
                    ...this.#options.headers(),
                    ...extraHeaders,
                },
                body: JSON.stringify(message),
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            })
        } catch (error) {
            throw this.#failed(
                timeout.aborted
                    ? `no response within ${this.#options.timeoutMs} ms`
                    : error instanceof Error
                      ? error.message
                      : String(error),
            )
        }
    }

    /** The JSON-RPC result from a JSON body or from the SSE event that carries it. */
    async #read(response: Response, method: string): Promise<unknown> {
        const text = await response.text()
        if (!response.ok) {
            throw this.#failed(`${method} answered ${response.status}: ${text.slice(0, 300)}`)
        }
        const type = response.headers.get("content-type") ?? ""
        const messages = type.includes("text/event-stream") ? sseMessages(text) : [text]
        for (const raw of messages) {
            let parsed: RpcResponse
            try {
                parsed = JSON.parse(raw) as RpcResponse
            } catch {
                continue
            }
            // A server may interleave notifications before the response; only a message with a
            // result or an error answers the request.
            if (parsed.error !== undefined) {
                throw this.#failed(
                    `${method} failed (${parsed.error.code ?? "?"}): ${parsed.error.message ?? "no message"}`,
                )
            }
            if (parsed.result !== undefined) return parsed.result
        }
        throw this.#failed(`${method} returned no JSON-RPC result`)
    }

    #failed(detail: string): Error {
        return mcpRequestFailed(this.#options.server, this.#options.url, detail)
    }
}

/** The `data:` payloads of an SSE body, one per event, multi-line data joined as the spec says. */
export function sseMessages(body: string): string[] {
    const out: string[] = []
    for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
        if (data.length > 0) out.push(data.join("\n"))
    }
    return out
}
