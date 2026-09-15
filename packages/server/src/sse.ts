/**
 * Server-sent events: framing, heartbeat, and clean teardown.
 *
 * The event *name* mirrors the envelope's `type` so a browser's `EventSource` can register handlers
 * per type without parsing a payload first — that is the whole reason the spec fixes the framing
 * rather than leaving it to each endpoint.
 *
 * Two failure modes this exists to avoid, both of which look like a working stream until they do not:
 *
 * - **A proxy closing an idle connection.** Nginx and most cloud load balancers drop a stream with
 *   no bytes for 60 s. A turn that thinks for 90 s would be cut off mid-generation, and the client
 *   would see a clean close rather than an error. Hence a comment frame every 15 s.
 * - **A stream that keeps the process alive.** The heartbeat is an interval, and an interval holds
 *   the event loop open. It is unref'd, so a runtime that is otherwise finished can still exit.
 */

/**
 * Comment frame interval. Must stay comfortably below every idle timeout between here and a client.
 *
 * Exported because `serve.ts` derives Bun's `idleTimeout` from it: **Bun.serve defaults to 10
 * seconds**, which is shorter than this, so an SSE stream was being killed by our own server before
 * the first heartbeat could fire. It printed `[Bun.serve]: request timed out after 10 seconds` and
 * closed the stream — a clean close, which a client reads as "the turn ended". Found by running it,
 * not by a test: the tests read a stream to completion in milliseconds.
 */
export const HEARTBEAT_MS = 15_000

export interface SseFrame {
    /** Becomes `event:`. Omitted for an anonymous message. */
    readonly event?: string
    readonly data: unknown
    readonly id?: string
}

/** Encode one frame. Exported because the framing is a contract, and contracts get asserted. */
export function encodeFrame(frame: SseFrame): string {
    const lines: string[] = []
    if (frame.event !== undefined) lines.push(`event: ${frame.event}`)
    if (frame.id !== undefined) lines.push(`id: ${frame.id}`)
    // A data payload containing a newline would otherwise terminate the frame early, so every line
    // is prefixed. JSON.stringify never emits a literal newline, but this is not only fed JSON.
    const payload = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data)
    for (const line of payload.split("\n")) lines.push(`data: ${line}`)
    return `${lines.join("\n")}\n\n`
}

export interface SseStreamOptions {
    /**
     * Called once, with a `send` the source can push frames through and a `close` to end the stream.
     *
     * Returns a teardown function — unsubscribing from a bus, cancelling a turn subscription. It is
     * invoked exactly once, whether the stream ended by itself or the client disconnected.
     */
    readonly start: (controls: {
        send: (frame: SseFrame) => void
        close: () => void
    }) => (() => void) | undefined
    /** Fired when the client goes away. */
    readonly signal?: AbortSignal
    readonly heartbeatMs?: number
    /**
     * 200 for a plain stream; 202 for `POST /messages` with `stream: true`.
     *
     * The spec says that call "returns 202 … then streams SSE", and a response has one status. So
     * the accepted status rides on the stream rather than becoming a second response nobody could
     * receive.
     */
    readonly status?: number
}

/**
 * Build the `Response` for an SSE endpoint.
 *
 * `X-Accel-Buffering: no` is not decoration: nginx buffers proxied responses by default, and a
 * buffered SSE stream delivers nothing until it is large enough to flush — which for a token stream
 * means the whole reply arrives at once, at the end, looking exactly like a runtime that does not
 * stream.
 */
export function sseResponse(options: SseStreamOptions): Response {
    const encoder = new TextEncoder()
    let teardown: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let closed = false

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const finish = () => {
                if (closed) return
                closed = true
                if (heartbeat !== undefined) clearInterval(heartbeat)
                teardown?.()
                teardown = undefined
                try {
                    controller.close()
                } catch {
                    // Already closed by the platform when the socket went away. Not an error —
                    // the client disconnecting is the normal way an SSE stream ends.
                }
            }

            const send = (frame: SseFrame) => {
                if (closed) return
                try {
                    controller.enqueue(encoder.encode(encodeFrame(frame)))
                } catch {
                    // Enqueue after the consumer is gone. Treated as a disconnect rather than
                    // propagated: the producer is a turn, and a turn must not fail because a
                    // browser tab closed.
                    finish()
                }
            }

            options.signal?.addEventListener("abort", finish, { once: true })

            // **Assigned only if the stream is still open.** `start` is permitted to `close()`
            // synchronously — `streamTurn` does exactly that when it attaches to a turn that has
            // already ended, and so does any single-frame stream — and when it does, `finish()`
            // runs *here*, before this assignment, with `teardown` still undefined. It called
            // nothing, set `closed`, and returned; then the real teardown landed in a variable
            // only `cancel()` reads, and `cancel()` bails on `closed`. So the subscription leaked.
            //
            // The cost was not a tidiness one. A leaked buffer listener pins its buffer against
            // eviction — `#evict` skips anything with listeners *before* the count cap can even
            // consider it, so the buffer escaped both the age and the count bound — and a leaked
            // attachment holding chunk interest leaves the bus building a per-token envelope for
            // the life of the process with nobody reading it. Found by watching a real server
            // hold an ended turn's buffer through two sweeps, ninety seconds after it ended.
            const started = options.start({ send, close: finish })
            if (closed) {
                started?.()
                return
            }
            teardown = started

            heartbeat = setInterval(() => {
                if (closed) return
                try {
                    // A bare comment. Ignored by every SSE client and enough to keep a proxy from
                    // deciding the connection is idle.
                    controller.enqueue(encoder.encode(": ping\n\n"))
                } catch {
                    finish()
                }
            }, options.heartbeatMs ?? HEARTBEAT_MS)
            heartbeat.unref?.()
        },
        cancel() {
            if (closed) return
            closed = true
            if (heartbeat !== undefined) clearInterval(heartbeat)
            teardown?.()
            teardown = undefined
        },
    })

    return new Response(stream, {
        status: options.status ?? 200,
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        },
    })
}
