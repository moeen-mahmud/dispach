/**
 * In-process event bus. Synchronous fan-out, no I/O, no queue.
 *
 * A subscriber that throws must not break the emitter or any other subscriber: an
 * observability plugin with a bug would otherwise take down the turn it was observing. So
 * handler failures are caught and reported through `onHandlerError` — never swallowed, never
 * allowed to propagate.
 *
 * ## `model.chunk` and why the opt-in is per subscriber
 *
 * Chunks are per token, so nobody should pay for them by accident. This used to be a *process-wide*
 * boolean — `emitChunks`, plus a `setEmitChunks` whose docstring said "for an attaching stream
 * client" and which **no caller ever called**. `packages/cli/src/serve.ts` built its bus without the
 * flag, so in a served process `model.chunk` never reached SSE or WebSocket at all: token streaming,
 * the stated reason WebSocket exists, was dark and nothing reported it.
 *
 * The wire contract asks for something a process-wide boolean cannot express — `04-SPEC-WIRE.md`
 * says chunks are "suppressed unless subscriber opted in", per *subscriber*. So:
 *
 * - **An exact subscription to `"model.chunk"` is the opt-in.** Nothing to configure; asking for the
 *   event is asking for the event. Every existing exact subscriber keeps working untouched.
 * - **A wildcard subscriber gets none unless it passes `{ chunks: true }`.** `/v1/events`, the
 *   WebSocket bridge, plugin `onEvent` watchers and `TurnStreams` are all wildcard, and none of them
 *   should be put on the per-token path by default.
 *
 * The early return in `emit` is kept in the same position, so the zero-cost property is unchanged:
 * with nobody listening for chunks, an envelope is never built and `#now()` is never called. What
 * changes is that the condition is now *"is anybody listening"* rather than a setting somebody has
 * to remember — which makes the original bug unrepresentable rather than merely fixed.
 *
 * Two designs rejected. Emitting always and filtering downstream builds an envelope and an ISO
 * timestamp per token before any filter can see it, and fills every turn buffer with tokens nobody
 * asked for. A separate emit path is faster in isolation and breaks ordering: `model.chunk` and
 * `model.result` interleave correctly today only because one bus dispatches both, and two consumers
 * flush their stream filter on `model.result` — split the streams and the last line of every reply
 * is truncated.
 */

import type { AnyEvent, EventContext, EventDataMap, EventEnvelope, EventType } from "./types.ts"

export type EventHandler = (event: AnyEvent) => void

/** How a subscription is qualified. Only wildcard subscribers need it. */
export interface SubscribeOptions {
    /**
     * Deliver `model.chunk` to this wildcard subscriber.
     *
     * Meaningless on an exact subscription — asking for `"model.chunk"` by name is already the
     * opt-in — and harmless there, so it is not an error to pass it.
     */
    readonly chunks?: boolean
}

export interface EventBusOptions {
    runtimeId: string
    /** Called when a subscriber throws. Defaults to `console.error`. */
    onHandlerError?: (error: unknown, event: AnyEvent) => void
    /** Injectable for tests; defaults to `() => new Date().toISOString()`. */
    now?: () => string
}

export class EventBus {
    readonly runtimeId: string

    // '#' is used to make these private fields
    #handlers = new Map<string, Set<EventHandler>>()
    /**
     * Wildcard subscribers, with whether each wants chunks.
     *
     * A `Map` rather than a `Set` beside a flag lookup: it preserves insertion order, so dispatch
     * order is unchanged, and it carries the per-handler answer with no extra allocation.
     */
    #wildcard = new Map<EventHandler, boolean>()
    /**
     * How many subscribers would receive a `model.chunk` right now.
     *
     * Maintained rather than computed, because it is read on the hottest path in the runtime — once
     * per token — and computing it would mean a map lookup plus a walk of every wildcard handler
     * *before* deciding not to emit.
     */
    #chunkSubscribers = 0
    #onHandlerError: (error: unknown, event: AnyEvent) => void
    #now: () => string

    constructor(options: EventBusOptions) {
        this.runtimeId = options.runtimeId
        this.#now = options.now ?? (() => new Date().toISOString())
        this.#onHandlerError =
            options.onHandlerError ??
            ((error, event) => {
                console.error(`event handler threw while handling ${event.type}:`, error)
            })
    }

    /**
     * Subscribe to one type, or to `"*"` for everything. Returns an unsubscribe function.
     *
     * The counter is adjusted only when a handler is genuinely added or removed. A handler
     * registered twice is one entry, so counting every call would leak the count upward and leave
     * chunks emitting after the last real subscriber had gone.
     */
    on(type: EventType | "*", handler: EventHandler, options: SubscribeOptions = {}): () => void {
        if (type === "*") {
            const had = this.#wildcard.has(handler)
            const wants = options.chunks === true
            const wanted = had ? (this.#wildcard.get(handler) ?? false) : false
            this.#wildcard.set(handler, wants || wanted)
            if (!had && wants) this.#chunkSubscribers += 1
            else if (had && wants && !wanted) this.#chunkSubscribers += 1
            return () => {
                if (!this.#wildcard.has(handler)) return
                if (this.#wildcard.get(handler) === true) this.#chunkSubscribers -= 1
                this.#wildcard.delete(handler)
            }
        }

        let set = this.#handlers.get(type)
        if (set === undefined) {
            set = new Set()
            this.#handlers.set(type, set)
        }
        const added = !set.has(handler)
        set.add(handler)
        if (added && type === "model.chunk") this.#chunkSubscribers += 1
        return () => {
            if (set?.delete(handler) === true && type === "model.chunk") {
                this.#chunkSubscribers -= 1
            }
        }
    }

    /** Subscribe until the first matching event, then unsubscribe. */
    once(type: EventType | "*", handler: EventHandler, options: SubscribeOptions = {}): () => void {
        const off = this.on(
            type,
            (event) => {
                off()
                handler(event)
            },
            options,
        )
        return off
    }

    /** Resolves on the first matching event. Rejects if `signal` aborts first. */
    next(
        type: EventType | "*",
        signal?: AbortSignal,
        options: SubscribeOptions = {},
    ): Promise<AnyEvent> {
        return new Promise((resolve, reject) => {
            const off = this.on(
                type,
                (event) => {
                    off()
                    signal?.removeEventListener("abort", onAbort)
                    resolve(event)
                },
                options,
            )
            const onAbort = () => {
                off()
                reject(signal?.reason ?? new Error("aborted"))
            }
            signal?.addEventListener("abort", onAbort, { once: true })
        })
    }

    /** How many subscribers would receive a chunk. Exported for the tests that pin the bookkeeping. */
    get chunkSubscribers(): number {
        return this.#chunkSubscribers
    }

    emit<K extends EventType>(type: K, data: EventDataMap[K], context: EventContext = {}): void {
        // Same position as the boolean gate it replaces, so nothing is allocated and `#now()` is
        // not called when nobody is listening. The difference is that this cannot be misconfigured.
        if (type === "model.chunk" && this.#chunkSubscribers === 0) return

        const envelope = {
            v: 1,
            ts: this.#now(),
            runtimeId: this.runtimeId,
            ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
            ...(context.sessionKey === undefined ? {} : { sessionKey: context.sessionKey }),
            ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
            ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
            type,
            data,
        } as EventEnvelope<K, EventDataMap[K]> as AnyEvent

        this.#dispatch(envelope)
    }

    #dispatch(event: AnyEvent): void {
        const chunk = event.type === "model.chunk"
        // Snapshot both collections: a handler that unsubscribes during dispatch must not perturb
        // the iteration order of the current emit.
        const specific = this.#handlers.get(event.type)
        if (specific !== undefined) {
            for (const handler of [...specific]) this.#deliver(handler, event)
        }
        for (const [handler, wantsChunks] of [...this.#wildcard]) {
            // The per-subscriber half: a wildcard that did not ask for chunks is skipped for chunks
            // and receives everything else.
            if (chunk && !wantsChunks) continue
            this.#deliver(handler, event)
        }
    }

    #deliver(handler: EventHandler, event: AnyEvent): void {
        try {
            handler(event)
        } catch (error) {
            this.#onHandlerError(error, event)
        }
    }
}
