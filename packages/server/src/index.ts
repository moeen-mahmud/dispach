/**
 * `@dispach/server` — the wire protocol in `docs/04-SPEC-WIRE.md`.
 *
 * ```ts
 * const running = await serve({ runtime, host: "127.0.0.1", port: 7420, token })
 * ```
 *
 * `createHandler` is exported separately and is the more useful export for an embedder: it is a
 * plain `(Request) => Promise<Response>`, so it mounts inside any framework and is testable without
 * a socket.
 */

export {
    type ApprovalRegistry,
    createApprovalRegistry,
    type PendingApproval,
} from "./approvals.ts"
export { createHandler, type HandlerOptions } from "./handler.ts"
export { type Route, type RouteMatch, Router } from "./router.ts"
export { isLoopback, type RunningServer, type ServeOptions, serve } from "./serve.ts"
export {
    encodeFrame,
    HEARTBEAT_MS,
    type SseFrame,
    type SseStreamOptions,
    sseResponse,
} from "./sse.ts"
export { attachWebSocket, type WebSocketBridge, type WsSession } from "./ws.ts"
