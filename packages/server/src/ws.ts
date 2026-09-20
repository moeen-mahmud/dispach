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
import { bearerFromProtocols, PROTOCOL, withBearerHeader } from "./auth.ts"
import { type Principal, reachesAgent, reachesSession } from "./principal.ts"

/** Per-connection state, handed to the socket by `Bun.serve`'s upgrade. */
export interface WsSession {
    readonly agentId: string | undefined
    /**
     * Who opened this socket.
     *
     * Carried on the session rather than re-resolved per frame: the handshake is the only moment a
     * credential is presented, and a scope read once there is a scope every frame answers to. It is
     * also what stops this endpoint being the hole in the boundary — a key narrowed to one agent
     * must not receive another's events over a transport that skipped the check.
     */
    readonly principal: Principal
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
    /**
     * Decide whether to upgrade. A rejection is an ordinary HTTP response.
     *
     * Takes the **request**, not just its URL, because the credential is a header now — and `async`
     * because resolving an operator key is one indexed read. Both are what it costs to authenticate
     * this endpoint the same way every other one is authenticated, instead of with its own
     * comparison against the configured token, which is what made a browser holding a key unable to
     * use WebSocket at all.
     */
    accept(
        request: Request,
    ): Promise<
        | { kind: "accept"; session: WsSession; protocol?: string }
        | { kind: "reject"; response: Response }
    >
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
    /**
     * How to authenticate a handshake — the *same* function the HTTP dispatcher uses.
     *
     * It was `token: string | undefined` and a private `timingSafeEqual` against it, so an operator
     * key authenticated every route except this one. Undocumented, and not a decision: the recorded
     * *"a check only one surface performs is a check the two disagree about"* shape, on the one
     * surface where disagreeing means a credential works everywhere except the socket.
     */
    authenticate: (request: Request) => Promise<Principal | Response>,
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
            /**
             * **The scope, on the socket** — the same boundary `/v1/events` applies, and the one
             * this endpoint had none of.
             *
             * A socket opened with **no** `?agentId=` receives the whole firehose, so without this
             * a key narrowed to one agent could read every other agent's turns, prompts and tool
             * calls by simply omitting a parameter. An event with no `agentId` is runtime-wide and
             * belongs to everyone; a session-scoped one is checked too, because a key narrowed to a
             * session prefix is narrowed for reading as much as for writing.
             */
            if (event.agentId !== undefined && !reachesAgent(ws.data.principal, event.agentId))
                continue
            if (
                event.sessionKey !== undefined &&
                !reachesSession(ws.data.principal, event.sessionKey)
            )
                continue
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
        async accept(request) {
            const url = new URL(request.url)
            /**
             * The credential, from a **header** — with the old query parameter still honoured.
             *
             * A browser cannot set headers on a WebSocket handshake, which is why `?token=` existed.
             * But a credential in a URL is what this project's standing rule forbids: it lands in
             * an access log, in a `Referer`, and in anything that proxies. The subprotocol list is a
             * header the browser *will* send on the caller's behalf —
             * `new WebSocket(url, ["dispach.bearer", key])` — so the credential travels the same
             * way it does everywhere else.
             *
             * `?token=` is accepted for now and documented as deprecated. Removing it in the same
             * change that introduces the replacement would break every client using the form this
             * spec has advertised since Phase 13, for no security gain that a deprecation window
             * does not also get.
             */
            const fromProtocol = bearerFromProtocols(request)
            const fromQuery = url.searchParams.get("token")
            const bearer = fromProtocol ?? fromQuery ?? ""

            const who = await authenticate(withBearerHeader(request, bearer))
            if (who instanceof Response) return { kind: "reject" as const, response: who }

            const agentId = url.searchParams.get("agentId")
            /**
             * A named agent outside the scope is a **404**, exactly as it is over HTTP.
             *
             * Not a 401: the credential is fine. Not a 403: that would confirm the agent exists,
             * which is the disclosure the whole 404-not-403 rule exists to prevent — and a socket
             * is no less able to enumerate than a GET is.
             */
            if (agentId !== null && !reachesAgent(who, agentId)) {
                return {
                    kind: "reject" as const,
                    response: new Response(
                        JSON.stringify({
                            error: {
                                code: "agent_not_found",
                                message: `No agent "${agentId}".`,
                                hint: "Check the id — it is case-sensitive. A key scoped away from an agent sees exactly what a caller asking for one that does not exist sees.",
                            },
                        }),
                        { status: 404, headers: { "content-type": "application/json" } },
                    ),
                }
            }

            // `?chunks=true` on the handshake, the same spelling and the same default-off as the
            // SSE routes. A `subscribe` frame can change it later without reconnecting.
            return {
                kind: "accept" as const,
                session: {
                    agentId: agentId ?? undefined,
                    chunks: url.searchParams.get("chunks") === "true",
                    principal: who,
                },
                // **Echoed, or the browser closes the socket immediately.** A server that accepts a
                // handshake offering subprotocols and names none of them is, to a browser, a server
                // that agreed to nothing — and it hangs up without a readable reason.
                ...(fromProtocol === undefined ? {} : { protocol: PROTOCOL }),
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
                    /**
                     * A `subscribe` frame may re-point the agent, and the **scope is re-checked**.
                     *
                     * The handshake is not the only moment an agent id enters: a socket opened with
                     * no `?agentId=` can name one later, and honouring that without a check would
                     * make the frame a way round the boundary the handshake just applied.
                     */
                    const nextAgent = frame.agentId ?? ws.data.agentId
                    if (nextAgent !== undefined && !reachesAgent(ws.data.principal, nextAgent)) {
                        ws.send(
                            JSON.stringify({
                                type: "ws.error",
                                error: {
                                    code: "agent_not_found",
                                    message: `No agent "${nextAgent}".`,
                                    hint: "Check the id — it is case-sensitive. A key scoped away from an agent sees exactly what a caller asking for one that does not exist sees.",
                                },
                            }),
                        )
                        return
                    }
                    ws.data = {
                        agentId: nextAgent,
                        chunks: wantsChunks,
                        principal: ws.data.principal,
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
