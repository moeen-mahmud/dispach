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
export function attachWebSocket(runtime: Runtime, token: string | undefined): WebSocketBridge {
    const sockets = new Set<Socket>()
    const running = new Map<string, AbortController>()
    let unsubscribe: (() => void) | undefined

    const broadcast = (event: AnyEvent) => {
        for (const ws of sockets) {
            // A socket subscribed to one agent does not receive another's traffic. A runtime hosting
            // several agents would otherwise leak one conversation into another client's stream.
            if (ws.data.agentId !== undefined && event.agentId !== ws.data.agentId) continue
            try {
                ws.send(JSON.stringify(event))
            } catch {
                // A send to a socket the platform has already torn down. `close` will follow.
            }
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
            return { kind: "accept", session: { agentId: agentId ?? undefined } }
        },

        handlers: {
            open(ws) {
                sockets.add(ws)
                // Subscribed on the first socket rather than at construction, so a runtime with no
                // WS clients pays nothing — including for `model.chunk`.
                if (unsubscribe === undefined) unsubscribe = runtime.bus.on("*", broadcast)
                ws.send(JSON.stringify({ type: "ws.open", agentId: ws.data.agentId ?? null }))
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
                    ws.data = { agentId: frame.agentId ?? ws.data.agentId }
                    ws.send(
                        JSON.stringify({ type: "ws.subscribed", agentId: ws.data.agentId ?? null }),
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
                sockets.delete(ws)
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
        },
    }
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}
