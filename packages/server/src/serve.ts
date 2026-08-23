/**
 * Binding the handler to a port.
 *
 * Two adapters, because the runtime targets are Bun (primary) and Node 24+ (soft compat). Both are
 * thin — the handler is a `(Request) => Promise<Response>` and neither adapter contains a route.
 *
 * **WebSocket is Bun-only, and says so rather than pretending.** Bun has an upgrade path built into
 * `Bun.serve`; Node has none without a dependency, and adding `ws` to satisfy an endpoint the spec
 * itself calls secondary ("everything achievable over HTTP + SSE stays there") is the wrong trade.
 * Under Node the endpoint answers 501 naming the reason, which is a better outcome than a silent
 * connection failure a client would read as a network problem.
 */

import { HarnessError } from "@dispach/core"
import { createHandler, type HandlerOptions } from "./handler.ts"
import { HEARTBEAT_MS } from "./sse.ts"
import { attachWebSocket, type WsSession } from "./ws.ts"

export interface ServeOptions extends Omit<HandlerOptions, "allowUnauthenticated"> {
    readonly port: number
    readonly host: string
}

export interface RunningServer {
    readonly url: string
    readonly port: number
    readonly host: string
    /** Whether `/v1/ws` will actually upgrade on this runtime. */
    readonly websocket: boolean
    stop(): Promise<void>
}

/** Loopback in every spelling that resolves to this machine, including IPv6 and the wildcard form. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"])

export function isLoopback(host: string): boolean {
    return LOOPBACK.has(host.toLowerCase())
}

/**
 * Start listening.
 *
 * **A non-loopback bind without a token refuses to start.** From the spec, and the reason is that
 * the failure mode of the alternative is invisible: an agent with shell access exposed on 0.0.0.0
 * behaves identically to one that is not, right up until someone finds it. A refusal at bind time
 * is the one moment where the person who made the choice is present to see it.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
    const { host, port, runtime } = options

    if (!isLoopback(host) && options.token === undefined) {
        throw new HarnessError({
            code: "server_public_without_token",
            message: `Refusing to bind ${host}:${port} with no API token.`,
            hint: "Set the variable named by server.tokenEnv, or bind 127.0.0.1. A public bind with no token exposes every endpoint — including the ones that start a turn — to anyone who can reach the port, and behaves identically to a safe one until someone finds it.",
            field: "server.host",
        })
    }

    const handler = createHandler({
        runtime,
        ...(options.token === undefined ? {} : { token: options.token }),
        // Only reachable on loopback, per the guard above. Stated rather than defaulted.
        ...(options.token === undefined ? { allowUnauthenticated: true } : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
    })

    const underBun = typeof Bun !== "undefined" && typeof Bun.serve === "function"
    if (underBun) return serveWithBun(handler, options)
    return serveWithNode(handler, options)
}

// ─── Bun ─────────────────────────────────────────────────────────────────────────────────

function serveWithBun(
    handler: (request: Request) => Promise<Response>,
    options: ServeOptions,
): RunningServer {
    const bridge = attachWebSocket(options.runtime, options.token)

    const server = Bun.serve<WsSession, never>({
        port: options.port,
        hostname: options.host,
        // Bun's default is 10 seconds, which is *shorter* than the SSE heartbeat — so the server
        // killed its own streams before the first keep-alive frame, printing "request timed out"
        // and closing cleanly, which a client reads as "the turn ended". Derived from the
        // heartbeat rather than hardcoded, so the two cannot drift apart again. Seconds, and Bun
        // caps it at 255.
        idleTimeout: Math.min(255, Math.ceil((HEARTBEAT_MS / 1000) * 3)),
        fetch: (request, self) => {
            const url = new URL(request.url)
            if (url.pathname !== "/v1/ws") return handler(request)

            const attempt = bridge.accept(url)
            if (attempt.kind === "reject") return attempt.response
            // `undefined` tells Bun the response is the upgrade itself.
            if (self.upgrade(request, { data: attempt.session })) return undefined
            return new Response("upgrade failed", { status: 400 })
        },
        websocket: {
            open: (ws) => bridge.handlers.open(ws),
            message: (ws, message) => bridge.handlers.message(ws, message),
            close: (ws) => bridge.handlers.close(ws),
        },
    })

    return {
        url: `http://${options.host}:${server.port}`,
        port: server.port ?? options.port,
        host: options.host,
        websocket: true,
        stop: async () => {
            bridge.closeAll()
            await server.stop(true)
        },
    }
}

// ─── Node ────────────────────────────────────────────────────────────────────────────────

async function serveWithNode(
    handler: (request: Request) => Promise<Response>,
    options: ServeOptions,
): Promise<RunningServer> {
    const { createServer } = await import("node:http")

    const server = createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)

            const url = `http://${req.headers.host ?? `${options.host}:${options.port}`}${req.url ?? "/"}`
            const headers = new Headers()
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === "string") headers.set(key, value)
                else if (Array.isArray(value)) headers.set(key, value.join(", "))
            }

            if (new URL(url).pathname === "/v1/ws") {
                res.writeHead(501, { "content-type": "application/json; charset=utf-8" })
                res.end(
                    JSON.stringify({
                        error: {
                            code: "websocket_unavailable",
                            message:
                                "This process is running under Node, where /v1/ws is not served.",
                            hint: "Run under Bun for WebSocket support, or use GET /v1/events (SSE) plus POST /v1/agents/:id/messages — everything the WS endpoint does is achievable over HTTP, which is why the spec calls it secondary.",
                        },
                    }),
                )
                return
            }

            const method = req.method ?? "GET"
            const response = await handler(
                new Request(url, {
                    method,
                    headers,
                    ...(method === "GET" || method === "HEAD"
                        ? {}
                        : { body: Buffer.concat(chunks) }),
                }),
            )

            const out: Record<string, string> = {}
            response.headers.forEach((value, key) => {
                out[key] = value
            })
            res.writeHead(response.status, out)

            if (response.body === null) {
                res.end()
                return
            }
            // Streamed rather than buffered, or SSE would deliver nothing until the turn ended —
            // which is exactly the symptom `x-accel-buffering: no` exists to prevent one hop later.
            const reader = response.body.getReader()
            res.on("close", () => void reader.cancel().catch(() => {}))
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                res.write(Buffer.from(value))
            }
            res.end()
        })().catch(() => {
            if (!res.headersSent) res.writeHead(500)
            res.end()
        })
    })

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(options.port, options.host, () => {
            server.removeListener("error", reject)
            resolve()
        })
    })

    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : options.port

    return {
        url: `http://${options.host}:${port}`,
        port,
        host: options.host,
        websocket: false,
        stop: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections?.()
                server.close(() => resolve())
            }),
    }
}
