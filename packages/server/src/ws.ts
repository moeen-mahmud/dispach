/**
 * The WebSocket endpoint: one socket, bidirectional, for a client that needs token streaming plus
 * mid-turn interrupts.
 *
 * Deliberately secondary. The spec is explicit that everything achievable over HTTP + SSE stays
 * there, and this exists for the one case HTTP genuinely cannot serve — an interactive client that
 * wants to interrupt a turn it is watching without opening a second connection.
 *
 * **Authentication is by query parameter**, which is not a preference. A browser's `WebSocket`
 * constructor cannot set headers, so a bearer header is not available on the handshake. The
 * consequence is real and worth stating: a token in a URL lands in proxy access logs. The mitigation
 * is that this endpoint exists for a client that already holds the token, and the token is the same
 * one every other route requires — so nothing is exposed here that a header-bearing client could not
 * already reach. A short-lived ticket endpoint would be the improvement, and belongs with whatever
 * owns identity, which this runtime deliberately does not.
 */

import type { AnyEvent, Runtime } from "@dispach/core"
import { newTurnId } from "@dispach/core"

/** Per-connection state, handed to the socket by `Bun.serve`'s upgrade. */
export interface WsSession {
    readonly agentId: string | undefined
    /**
     * Whether this socket receives `model.chunk`.
     *
     * Per socket, not per bridge, and that is the whole point: token streaming is the stated
     * reason this endpoint exists, and it must not be the case that one client asking for tokens
     * starts billing every other connected client's bandwidth for them.
     */
    readonly chunks: boolean
}

interface Socket {
    data: WsSession
    send(message: string): void
    close(code?: number, reason?: string): void
}

export interface WebSocketBridge {
    /** Decide whether to upgrade. A rejection is an ordinary HTTP response. */
    accept(
        url: URL,
    ): { kind: "accept"; session: WsSession } | { kind: "reject"; response: Response }
    readonly handlers: {
        open(ws: Socket): void
        message(ws: Socket, raw: string | Uint8Array): void
        close(ws: Socket): void
    }
    closeAll(): void
}

/**
 * Wire the runtime's event bus to a set of sockets.
 *
 * One bus subscription for the whole bridge rather than one per socket: a hundred attached clients
 * would otherwise mean a hundred handlers walked on every `model.chunk`, and chunk events are
 * per-token.
 */
export function attachWebSocket(
    runtime: Runtime,
    token: string | undefined,
    /**
     * In-flight turns, shared with the HTTP handler.
     *
     * This bridge used to own a private map, which made "can this turn be stopped" depend on which
     * door the question arrived through: a turn started with `POST /messages` could not be stopped
     * by a `stop` frame, and a turn started over the socket answered 409 on `POST /stop`. Both
     * surfaces reported honestly about a registry that was simply the wrong one.
     */
    running: Map<string, AbortController> = new Map(),
): WebSocketBridge {
    const sockets = new Set<Socket>()
    let unsubscribe: (() => void) | undefined
    /**
     * Chunk interest, refcounted over one exact subscription rather than folded into the wildcard.
     *
     * The wildcard stays chunk-free and a second, exact `model.chunk` subscription is added only
     * while some socket wants tokens — so a bridge with ten progress-watching clients and no token
     * reader costs the bus nothing per token, and the envelope is never built. Subscribing the
     * wildcard with `{ chunks: true }` instead would have been one line and is the shape rejected
     * for the bus itself: build every envelope, then discard most of them.
     *
     * The same handler on both keys delivers exactly once — the wildcard skips chunks because it
     * did not ask, and the exact subscription matches nothing else.
     */
    let chunkSockets = 0
    let unsubscribeChunks: (() => void) | undefined

    const broadcast = (event: AnyEvent) => {
        const chunk = event.type === "model.chunk"
        for (const ws of sockets) {
            // A socket subscribed to one agent does not receive another's traffic. A runtime hosting
            // several agents would otherwise leak one conversation into another client's stream.
            if (ws.data.agentId !== undefined && event.agentId !== ws.data.agentId) continue
            // The per-socket half. One client asking for tokens is what puts them on the bus; this
            // is what stops them reaching the clients that did not ask.
            if (chunk && !ws.data.chunks) continue
            try {
                ws.send(JSON.stringify(event))
            } catch {
                // A send to a socket the platform has already torn down. `close` will follow.
            }
        }
    }

    const takeChunkInterest = () => {
        chunkSockets += 1
        if (unsubscribeChunks === undefined) {
            unsubscribeChunks = runtime.bus.on("model.chunk", broadcast)
        }
    }

    const releaseChunkInterest = () => {
        if (chunkSockets === 0) return
        chunkSockets -= 1
        if (chunkSockets === 0) {
            unsubscribeChunks?.()
            unsubscribeChunks = undefined
        }
    }

    return {
        accept(url) {
            if (token !== undefined) {
                const presented = url.searchParams.get("token") ?? ""
                if (!timingSafeEqual(presented, token)) {
                    return {
                        kind: "reject",
                        response: new Response(
                            JSON.stringify({
                                error: {
                                    code: "unauthorized",
                                    message: "Missing or invalid token.",
                                    hint: "A browser WebSocket cannot set headers, so this endpoint takes ?token=. It is the same token every other route requires.",
                                },
                            }),
                            { status: 401, headers: { "content-type": "application/json" } },
                        ),
                    }
                }
            }
            const agentId = url.searchParams.get("agentId")
            // `?chunks=true` on the handshake, the same spelling and the same default-off as the
            // SSE routes. A `subscribe` frame can change it later without reconnecting.
            return {
                kind: "accept",
                session: {
                    agentId: agentId ?? undefined,
                    chunks: url.searchParams.get("chunks") === "true",
                },
            }
        },

        handlers: {
            open(ws) {
                sockets.add(ws)
                // Subscribed on the first socket rather than at construction, so a runtime with no
                // WS clients pays nothing — including for `model.chunk`.
                if (unsubscribe === undefined) unsubscribe = runtime.bus.on("*", broadcast)
                if (ws.data.chunks) takeChunkInterest()
                ws.send(
                    JSON.stringify({
                        type: "ws.open",
                        agentId: ws.data.agentId ?? null,
                        // Reported, not assumed. A client that mistyped the parameter learns it
                        // here rather than from an absence of tokens twenty seconds later.
                        chunks: ws.data.chunks,
                    }),
                )
            },

            message(ws, raw) {
                let frame: {
                    type?: string
                    text?: string
                    sessionKey?: string
                    turnId?: string
                    /**
                     * Which agent this socket watches. It was missing from this type entirely,
                     * which is how `subscribe` came to read the agent id out of `sessionKey`.
                     */
                    agentId?: string
                    /** Per-token frames on or off, from this frame onward. Omitted leaves it. */
                    chunks?: boolean
                }
                try {
                    frame = JSON.parse(
                        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
                    )
                } catch {
                    ws.send(JSON.stringify({ type: "ws.error", code: "frame_not_json" }))
                    return
                }

                if (frame.type === "ping") {
                    ws.send(JSON.stringify({ type: "pong" }))
                    return
                }

                if (frame.type === "subscribe") {
                    // Read from `agentId`. This read `frame.sessionKey`, and the damage was the
                    // worst available shape: a session key can never equal an `event.agentId`, so
                    // the socket's filter matched nothing, it went **permanently silent**, and it
                    // answered `ws.subscribed` to say the change had worked. Rule 8, over a socket.
                    //
                    // A frame naming only `sessionKey` is refused rather than accepted, because
                    // that is what a client written against the old behaviour sends — and silently
                    // ignoring it would leave the same dead socket with a different cause.
                    if (frame.agentId === undefined && frame.sessionKey !== undefined) {
                        ws.send(
                            JSON.stringify({
                                type: "ws.error",
                                code: "subscribe_needs_agent_id",
                                hint: "Send { type: 'subscribe', agentId: '<agent>' }. A socket filters on the agent an event carries; sessionKey names a conversation and can never match one, so a socket pointed with it receives nothing.",
                            }),
                        )
                        return
                    }
                    // Chunk interest may change without reconnecting — a client that opens a
                    // socket to watch progress and then focuses the conversation wants tokens from
                    // that moment. Omitting the field leaves it as it was, so a `subscribe` that
                    // only re-points the agent does not silently switch streaming off.
                    const wantsChunks =
                        typeof frame.chunks === "boolean" ? frame.chunks : ws.data.chunks
                    if (wantsChunks && !ws.data.chunks) takeChunkInterest()
                    else if (!wantsChunks && ws.data.chunks) releaseChunkInterest()
                    ws.data = {
                        agentId: frame.agentId ?? ws.data.agentId,
                        chunks: wantsChunks,
                    }
                    ws.send(
                        JSON.stringify({
                            type: "ws.subscribed",
                            agentId: ws.data.agentId ?? null,
                            chunks: ws.data.chunks,
                        }),
                    )
                    return
                }

                if (frame.type === "stop") {
                    const controller =
                        frame.turnId === undefined ? undefined : running.get(frame.turnId)
                    controller?.abort()
                    ws.send(
                        JSON.stringify({
                            type: "ws.stopping",
                            turnId: frame.turnId ?? null,
                            found: controller !== undefined,
                        }),
                    )
                    return
                }

                if (frame.type !== "message") {
                    ws.send(JSON.stringify({ type: "ws.error", code: "unknown_frame_type" }))
                    return
                }

                const agentId = ws.data.agentId
                const agent = runtime.list().find((candidate) => candidate.id === agentId)
                if (agent === undefined) {
                    ws.send(JSON.stringify({ type: "ws.error", code: "agent_not_found" }))
                    return
                }
                const text = frame.text ?? ""
                if (text.trim() === "") {
                    ws.send(JSON.stringify({ type: "ws.error", code: "message_text_required" }))
                    return
                }

                const turnId = newTurnId()
                const controller = new AbortController()
                running.set(turnId, controller)
                ws.send(JSON.stringify({ type: "ws.accepted", turnId }))

                // Detached, like the HTTP path. Closing the socket does not cancel the turn — only
                // an explicit `stop` frame does.
                void agent
                    .send(text, {
                        sessionKey: frame.sessionKey ?? "api:default",
                        turnId,
                        source: "ws",
                        signal: controller.signal,
                    })
                    .catch(() => {})
                    .finally(() => running.delete(turnId))
            },

            close(ws) {
                const had = sockets.delete(ws)
                // Gated on the socket having actually been in the set. A `close` the platform
                // delivers twice would otherwise decrement the refcount for one socket twice and
                // drop the chunk subscription out from under another client that is still reading.
                if (had && ws.data.chunks) releaseChunkInterest()
                if (sockets.size === 0) {
                    unsubscribe?.()
                    unsubscribe = undefined
                }
            },
        },

        closeAll() {
            for (const ws of sockets) {
                try {
                    ws.close(1001, "server stopping")
                } catch {
                    // Already gone.
                }
            }
            sockets.clear()
            unsubscribe?.()
            unsubscribe = undefined
            unsubscribeChunks?.()
            unsubscribeChunks = undefined
            chunkSockets = 0
        },
    }
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}
