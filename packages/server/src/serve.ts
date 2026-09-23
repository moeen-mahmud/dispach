/**
 * Binding the handler to a port.
 *
 * Two adapters, because a checkout runs under Bun and everything shipped runs under Node. Both are
 * thin — the handler is a `(Request) => Promise<Response>` and neither adapter contains a route.
 *
 * **WebSocket works under both, since 0.1.3.** Node has no upgrade path without a dependency, and
 * until 0.1.3 the endpoint answered 501 under Node on the argument that the spec calls it secondary.
 * That held while the container ran under Bun. With Node the only shipped runtime, "secondary" had
 * become "absent from every install", so `ws` is the dependency — one adapter around the same
 * `attachWebSocket` bridge, so the two runtimes cannot disagree about a frame.
 */

import { HarnessError } from "@dispach/core"
import { createHandler, type HandlerOptions, type ServerHandler } from "./handler.ts"
import { isLoopback, originProblem } from "./origin.ts"
import { HEARTBEAT_MS } from "./sse.ts"
import { attachWebSocket, type WsSession } from "./ws.ts"

export interface ServeOptions extends Omit<HandlerOptions, "allowUnauthenticated" | "origin"> {
    readonly port: number
    readonly host: string
    /** `server.allowedOrigins`. The bind host is already known here, so the policy is derived. */
    readonly allowedOrigins?: readonly string[]
    /** `server.allowedHosts`. Only consulted on a loopback bind. */
    readonly allowedHosts?: readonly string[]
    /**
     * Which adapter binds the port. Detected from the runtime when omitted; a test running under
     * Bun passes `"node"` to exercise the adapter every install ships, which nothing else reaches.
     */
    readonly engine?: "bun" | "node"
}

export interface RunningServer {
    readonly url: string
    readonly port: number
    readonly host: string
    /** Whether `/v1/ws` will actually upgrade on this runtime. */
    readonly websocket: boolean
    stop(): Promise<void>
}

// `isLoopback` moved to `origin.ts` — the module that decides what a host string means — because
// `handler.ts` needs it too and `serve.ts` imports `handler.ts`. Re-exported so every existing
// caller and the public surface are unchanged.
export { isLoopback }

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

    /**
     * One cancel registry for the whole process, shared by every surface that can start a turn.
     *
     * Created here rather than inside either surface because it is a fact about the *process*: a
     * turn is in flight or it is not, and which connection started it is not part of that. Each
     * surface owning its own map made `POST /stop` answer 409 for a turn a socket had started and
     * a `stop` frame find nothing for a turn `POST /messages` had started — two honest reports
     * about the wrong registry, which is the least debuggable shape a wrong answer has.
     */
    const running = new Map<string, AbortController>()

    const handler = createHandler({
        runtime,
        ...(options.token === undefined ? {} : { token: options.token }),
        // Only reachable on loopback, per the guard above. Stated rather than defaulted.
        ...(options.token === undefined ? { allowUnauthenticated: true } : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
        running,
        // Forwarded explicitly. This object is hand-built rather than spread from `options`, so a
        // field inherited through `ServeOptions` type-checks here and reaches nothing — the shape
        // that has cost this repo six debugging rounds (`apiKeyEnv`, `ChatMessage.toolCalls`,
        // `TurnInput.skills`, `ToolContext.readArtifact`, `ToolContext.memoryDir`,
        // `StoredMessage.origin`). It was wrong here on the first write: `approvals` was declared,
        // accepted, and dropped, so a registry handed to `serve` would have answered every POST
        // with `approval_not_found` while the turn waited on the *other* registry forever.
        ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
        // Same trap, eighth field. A dropped claim would print a working-looking bootstrap line
        // whose token authenticates nothing — a first-run failure with no way to tell it from a
        // mistyped paste.
        ...(options.claim === undefined ? {} : { claim: options.claim }),
        // Same trap, ninth field. Dropped, `POST /v1/agents/:id/start` would answer 501 on a server
        // whose caller had supplied the lookup — a route reporting "this server cannot" about a
        // capability it was given, which reads as a product limitation rather than a wiring bug.
        ...(options.resolveAgent === undefined ? {} : { resolveAgent: options.resolveAgent }),
        // Same trap, tenth field. Dropped, `POST /v1/agents` would answer 501 on a server whose
        // caller had supplied a provisioner — a route reporting "this server cannot create agents"
        // about a capability it was handed, which reads as a product limit rather than a wiring bug.
        ...(options.provision === undefined ? {} : { provision: options.provision }),
        // Same trap, eleventh field — and it happened again, which is why there is now a test rather
        // than a fifth comment. `PATCH /v1/agents/:id/channels/:channelId` answered 501 on a server
        // whose caller had supplied the actions, and the only symptom was a browser button that did
        // nothing. `serve.test.ts` walks this literal against `HandlerOptions` now.
        ...(options.channels === undefined ? {} : { channels: options.channels }),
        // **Derived, not forwarded.** The bind host is already an argument here, so a caller cannot
        // hand over a policy that disagrees with what was actually bound — which is the whole input
        // to how strict the guard is. `origin` is `Omit`ted from `ServeOptions` for the same reason:
        // two ways to say one thing is how they come to differ.
        origin: {
            host: options.host,
            ...(options.allowedOrigins === undefined
                ? {}
                : { allowedOrigins: options.allowedOrigins }),
            ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
        },
    })

    const underBun =
        options.engine === "bun" ||
        (options.engine === undefined &&
            typeof Bun !== "undefined" &&
            typeof Bun.serve === "function")
    if (underBun) return serveWithBun(handler, options, running)
    return serveWithNode(handler, options, running)
}

// ─── Bun ─────────────────────────────────────────────────────────────────────────────────

function serveWithBun(
    handler: ServerHandler,
    options: ServeOptions,
    running: Map<string, AbortController>,
): RunningServer {
    const bridge = attachWebSocket(options.runtime, handler.authenticate, running)

    const server = Bun.serve<WsSession, never>({
        port: options.port,
        hostname: options.host,
        // Bun's default is 10 seconds, which is *shorter* than the SSE heartbeat — so the server
        // killed its own streams before the first keep-alive frame, printing "request timed out"
        // and closing cleanly, which a client reads as "the turn ended". Derived from the
        // heartbeat rather than hardcoded, so the two cannot drift apart again. Seconds, and Bun
        // caps it at 255.
        idleTimeout: Math.min(255, Math.ceil((HEARTBEAT_MS / 1000) * 3)),
        fetch: async (request, self) => {
            const url = new URL(request.url)
            if (url.pathname !== "/v1/ws") return handler(request)

            /**
             * **The origin guard again, because this path never reaches `handler`.**
             *
             * Duplicated deliberately and it is the more important of the two: a browser does
             * **not** apply same-origin to `WebSocket`, so the handshake is cross-origin reachable
             * by construction — no preflight, no opt-in, nothing to refuse it but this. And
             * `/v1/ws` authenticates from a query parameter, which a rebinding page can supply as
             * easily as any other.
             */
            const problem = originProblem(request, {
                host: options.host,
                ...(options.allowedOrigins === undefined
                    ? {}
                    : { allowedOrigins: options.allowedOrigins }),
                ...(options.allowedHosts === undefined
                    ? {}
                    : { allowedHosts: options.allowedHosts }),
            })
            if (problem !== undefined) {
                return new Response(JSON.stringify({ error: problem }), {
                    status: 403,
                    headers: { "content-type": "application/json; charset=utf-8" },
                })
            }

            const attempt = await bridge.accept(request)
            if (attempt.kind === "reject") return attempt.response
            /**
             * `undefined` tells Bun the response is the upgrade itself.
             *
             * The chosen subprotocol is echoed in the handshake headers, or a browser that offered
             * one closes the socket the instant it opens — with no readable reason, which is the
             * worst kind of handshake failure to debug from the far side.
             */
            const upgraded = self.upgrade(request, {
                data: attempt.session,
                ...(attempt.protocol === undefined
                    ? {}
                    : { headers: { "sec-websocket-protocol": attempt.protocol } }),
            })
            if (upgraded) return undefined
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
    handler: ServerHandler,
    options: ServeOptions,
    running: Map<string, AbortController>,
): Promise<RunningServer> {
    const { createServer } = await import("node:http")
    const { WebSocketServer } = await import("ws")
    const bridge = attachWebSocket(options.runtime, handler.authenticate, running)

    /** A fetch `Request` for a Node request — the shape the handler and the bridge both read. */
    const toRequest = (req: import("node:http").IncomingMessage, body?: Buffer): Request => {
        const url = `http://${req.headers.host ?? `${options.host}:${options.port}`}${req.url ?? "/"}`
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") headers.set(key, value)
            else if (Array.isArray(value)) headers.set(key, value.join(", "))
        }
        const method = req.method ?? "GET"
        return new Request(url, {
            method,
            headers,
            ...(method === "GET" || method === "HEAD" || body === undefined ? {} : { body }),
        })
    }

    const server = createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            const response = await handler(toRequest(req, Buffer.concat(chunks)))

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

    /**
     * The upgrade, on Node's own `upgrade` event — the one HTTP request the request listener above
     * never sees. `noServer` because the decision to upgrade is the bridge's, made from the fetch
     * `Request` exactly as under Bun; `ws` only completes the handshake once that decision is
     * "accept". The subprotocol the bridge chose travels through a map keyed by the request,
     * because `handleProtocols` is a server-wide option and the choice is per handshake.
     */
    const chosenProtocol = new WeakMap<import("node:http").IncomingMessage, string>()
    const wss = new WebSocketServer({
        noServer: true,
        // Echoed, or the browser closes the socket the instant it opens — the same rule the Bun
        // adapter states beside its `headers`. `false` aborts the handshake for an offer the
        // bridge did not name, which is the other half of the same rule.
        handleProtocols: (_protocols, request) => chosenProtocol.get(request) ?? false,
    })
    // `end`, never `write` then `destroy`: destroying drops what has not been flushed, and the
    // client then sees a reset where a 403 was written — a refusal with its reason deleted.
    const refuse = (socket: import("node:stream").Duplex, status: number, body: string) => {
        socket.end(
            `HTTP/1.1 ${status} Refused\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
        )
    }
    server.on("upgrade", (req, socket, head) => {
        void (async () => {
            const request = toRequest(req)
            if (new URL(request.url).pathname !== "/v1/ws") {
                socket.destroy()
                return
            }
            // The origin guard, duplicated here for the reason the Bun adapter gives: a browser does
            // not apply same-origin to `WebSocket`, so nothing but this refuses a cross-origin
            // handshake.
            const problem = originProblem(request, {
                host: options.host,
                ...(options.allowedOrigins === undefined
                    ? {}
                    : { allowedOrigins: options.allowedOrigins }),
                ...(options.allowedHosts === undefined
                    ? {}
                    : { allowedHosts: options.allowedHosts }),
            })
            if (problem !== undefined) {
                refuse(socket, 403, JSON.stringify({ error: problem }))
                return
            }
            const attempt = await bridge.accept(request)
            if (attempt.kind === "reject") {
                refuse(socket, attempt.response.status, await attempt.response.text())
                return
            }
            if (attempt.protocol !== undefined) chosenProtocol.set(req, attempt.protocol)
            wss.handleUpgrade(req, socket, head, (ws) => {
                const adapted = {
                    data: attempt.session,
                    send: (message: string) => ws.send(message),
                    close: (code?: number, reason?: string) => ws.close(code, reason),
                }
                ws.on("message", (raw, isBinary) => {
                    const bytes = Array.isArray(raw)
                        ? Buffer.concat(raw)
                        : raw instanceof ArrayBuffer
                          ? Buffer.from(raw)
                          : raw
                    bridge.handlers.message(
                        adapted,
                        isBinary ? new Uint8Array(bytes) : bytes.toString("utf8"),
                    )
                })
                ws.on("close", () => bridge.handlers.close(adapted))
                bridge.handlers.open(adapted)
            })
        })().catch(() => socket.destroy())
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
        websocket: true,
        stop: () =>
            new Promise<void>((resolve) => {
                bridge.closeAll()
                wss.close()
                server.closeAllConnections?.()
                server.close(() => resolve())
            }),
    }
}
