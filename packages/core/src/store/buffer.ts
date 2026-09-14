/**
 * Per-turn event buffers, replayable on attach.
 *
 * Reattach is core, not a convenience: a turn survives the client that started it, so a client
 * that comes back has to be able to find out what it missed. The wire spec spells out the
 * contract — `GET /v1/agents/:id/turns/:turnId/stream` "replays buffered events then tails".
 *
 * **The handover has to be gapless and duplicate-free**, and the order of the two operations is
 * the whole problem. Subscribe first and then replay, and every event that arrives during the
 * replay is delivered twice. Replay first and then subscribe, and everything arriving in between
 * is lost. Neither shows up in a test that attaches to an idle turn; both show up under load.
 *
 * This implementation gets it right by doing both in one synchronous block. `EventBus.emit`
 * dispatches synchronously and JavaScript will not interleave another task inside
 * `attach`, so a snapshot taken and a listener registered without an intervening `await` cannot
 * miss or double-count anything. The absence of `async` on `attach` is the mechanism, not a
 * style choice — adding one would reintroduce the gap.
 *
 * Buffers live in memory only. They hold per-token `model.chunk` events, which are far too
 * chatty to persist and are worthless once the turn's text is in the database.
 */

import type { EventBus } from "../events/bus.ts"
import type { AnyEvent } from "../events/types.ts"

export type TurnBufferState = "running" | "ended"

export interface TurnAttachment {
    readonly turnId: string
    /** Everything the turn has emitted so far, in order. */
    readonly replay: readonly AnyEvent[]
    readonly state: TurnBufferState
    /**
     * True when the cap was reached and the **oldest** events were discarded.
     *
     * It was recorded on the buffer and readable nowhere: `truncated` was set, no field carried it
     * out, and nothing ever called `truncated()`. So a client received a replay with a hole in the
     * front and no way to know — hard rule 8, and routine rather than theoretical once chunks
     * stream, because each token is one buffered event.
     */
    readonly truncated: boolean
    /** How many events were discarded. `0` when nothing was. */
    readonly dropped: number
    /**
     * Whether token history is complete.
     *
     * `"start"` — chunk interest existed before the first token, so the replay has all of them.
     * `"partial"` — interest began mid-turn; earlier tokens were never buffered.
     * `"none"` — nobody asked for chunks on this turn, so the replay carries none by design.
     *
     * The honest answer to "why does my reattach have no token history", which an empty replay
     * cannot distinguish from a turn that produced no text.
     */
    readonly chunks: "start" | "partial" | "none"
    /** Detach. Safe to call more than once, and after the turn has ended. */
    unsubscribe(): void
}

interface Buffered {
    readonly turnId: string
    readonly events: AnyEvent[]
    state: TurnBufferState
    /** `performance.now()` at end, for the retention policy. Absent while running. */
    endedAt?: number
    /**
     * Attached listeners, with whether each asked for per-token events.
     *
     * A `Map` rather than a `Set` for the same reason the bus keeps one: chunk interest is
     * per *listener*, and without that this fan-out leaks. Found live, not by test — chunk interest
     * taken by `open` is held until the buffer is evicted 60 s after the turn ends, so for a minute
     * afterwards the bus is still emitting chunks, and a **later** client that never asked was
     * receiving them from here. Every test used a fresh harness, so none of them had a predecessor
     * still holding interest.
     */
    readonly listeners: Map<(event: AnyEvent) => void, boolean>
    /** True once an event was discarded because the cap was reached. */
    truncated: boolean
    /** How many were discarded, so the report can be specific rather than merely alarming. */
    dropped: number
    chunks: "start" | "partial" | "none"
    /** Whether this buffer is holding a unit of chunk interest, to release exactly once. */
    holdsChunkInterest: boolean
}

export interface TurnStreamsOptions {
    /**
     * Hard cap on buffered events per turn. A runaway tool loop must not turn into unbounded
     * memory growth, so the *oldest* events are dropped and the attachment is marked truncated —
     * dropping the newest would make a live tail stop updating, which looks like a hang.
     */
    readonly maxEventsPerTurn?: number
    /** How long an ended turn stays attachable. See `RETENTION` below. */
    readonly retainEndedMs?: number
    /** How many ended turns stay attachable at once, newest first. */
    readonly retainEndedCount?: number
    /** Injectable clock, so retention is testable without waiting. */
    readonly now?: () => number
}

const DEFAULT_MAX_EVENTS = 10_000

/**
 * Retention defaults for an *ended* turn's buffer.
 *
 * A running turn is always retained — there is no question there. The decision is what happens
 * after `turn.end`, and both directions have a real cost:
 *
 * - Evict immediately and a client that reconnects a second after completion gets nothing from
 *   the buffer. It can still read the final text from the `turns` table, but the token-level
 *   `model.chunk` events are gone, so a UI that was mid-stream cannot finish the animation and
 *   has to snap to the final text.
 * - Retain generously and an idle process holds the chunk events of every recent turn. At a few
 *   hundred chunks per turn this is small, but it is unbounded in the number of turns.
 */
/**
 * **Enforced lazily, on the next recorded event — never on a timer.**
 *
 * Deliberate: a timer would be a handle per buffer keeping the process alive, or one interval
 * running forever on an idle runtime, to reclaim memory nothing is contending for. The honest
 * consequence is that a process with no traffic holds its last turns' buffers indefinitely, so
 * `retainEndedMs` is an "at least", not an "at most" — bounded by `count`, which is the reason a
 * count bound exists beside an age one rather than instead of it.
 *
 * Worth knowing when reasoning about a live server: an ended turn is often still attachable well
 * past sixty seconds, and stops being so the moment anything else happens.
 */
const RETENTION = {
    ms: 60_000,
    count: 32,
} as const

export class TurnStreams {
    #buffers = new Map<string, Buffered>()
    #maxEvents: number
    #retainMs: number
    #retainCount: number
    #now: () => number
    #unsubscribeBus: (() => void) | undefined
    #bus: EventBus | undefined
    #chunkInterest = 0
    #unsubscribeChunks: (() => void) | undefined

    constructor(options: TurnStreamsOptions = {}) {
        this.#maxEvents = options.maxEventsPerTurn ?? DEFAULT_MAX_EVENTS
        this.#retainMs = options.retainEndedMs ?? RETENTION.ms
        this.#retainCount = options.retainEndedCount ?? RETENTION.count
        this.#now = options.now ?? (() => performance.now())
    }

    /**
     * Buffer every event carrying a `turnId`.
     *
     * A wildcard subscription rather than an enumerated list of types: the event schema is
     * append-only, and a new event type must show up in a replay without anyone remembering to
     * add it here.
     */
    listen(bus: EventBus): () => void {
        this.#unsubscribeBus?.()
        // Deliberately **without** `{ chunks: true }`. A runtime with nothing streaming registers
        // zero chunk subscribers, so the bus never builds a per-token envelope at all — which is
        // the property that makes token streaming free for a channel-only agent. Interest in chunks
        // is taken per turn instead, by `open` and `attach` below.
        const off = bus.on("*", (event) => {
            this.record(event)
        })
        this.#unsubscribeBus = off
        this.#bus = bus
        return () => {
            off()
            this.#releaseAllChunkInterest()
        }
    }

    /**
     * Take one unit of interest in `model.chunk`, refcounted across every turn being streamed.
     *
     * The bus only builds a chunk envelope when somebody is listening, so the subscription has to
     * exist *before* the first token — which means before `Agent.send` runs, not when an SSE body
     * starts being read. So interest is owned by things with a lifetime: a buffer (released when it
     * is evicted) and an attachment (released on unsubscribe). An SSE `start` callback would be the
     * wrong owner: it fires after the handler returns, and never at all if a client POSTs and does
     * not read the body.
     */
    #takeChunkInterest(): void {
        this.#chunkInterest += 1
        if (this.#chunkInterest === 1 && this.#bus !== undefined) {
            // One exact subscription for the whole runtime, which is the bus's opt-in — and it
            // **records**, rather than merely registering interest.
            //
            // Written with an empty handler first, which was wrong and instructive: the wildcard
            // subscription in `listen` is deliberately chunk-free, so a chunk-less wildcard plus an
            // empty exact handler meant chunks were emitted and buffered by nobody. Replays came
            // back with no token history even for a turn that had asked for it. Recording here is
            // also exactly-once: the wildcard skips chunks, so this is their only path in.
            this.#unsubscribeChunks = this.#bus.on("model.chunk", (event) => {
                this.record(event)
            })
        }
    }

    #releaseChunkInterest(): void {
        if (this.#chunkInterest === 0) return
        this.#chunkInterest -= 1
        if (this.#chunkInterest === 0) {
            this.#unsubscribeChunks?.()
            this.#unsubscribeChunks = undefined
        }
    }

    #releaseAllChunkInterest(): void {
        this.#chunkInterest = 0
        this.#unsubscribeChunks?.()
        this.#unsubscribeChunks = undefined
    }

    /**
     * Open an empty buffer for a turn that has not emitted yet. Idempotent.
     *
     * Needed because a caller that starts a turn and immediately attaches — which is exactly what
     * `POST /messages` with `stream: true` does — gets there before the first event: `Agent.send`
     * awaits the session write before emitting anything. Without this the stream reported "no
     * buffer" for a turn that was about to run, and the client saw the reply nowhere.
     *
     * **`attach` deliberately does not do this itself.** Creating a buffer on demand would make a
     * typo'd turn id indistinguishable from a real one, and the client would tail an empty stream
     * forever instead of being told the id is unknown. Only whoever starts a turn knows it exists.
     */
    open(turnId: string, options: { readonly chunks?: boolean } = {}): void {
        if (this.#buffers.has(turnId)) return
        const chunks = options.chunks === true
        if (chunks) this.#takeChunkInterest()
        this.#buffers.set(turnId, {
            turnId,
            events: [],
            state: "running",
            listeners: new Map(),
            truncated: false,
            dropped: 0,
            // Provenance, so a reattaching client can be told *why* it has no token history rather
            // than left to infer it from an empty replay. "start" means interest existed before the
            // first token; "partial" means it began mid-turn; "none" means never.
            chunks: chunks ? "start" : "none",
            holdsChunkInterest: chunks,
        })
    }

    /** Called for every event. Opens a buffer on first sight of a turn id. */
    record(event: AnyEvent): void {
        const turnId = event.turnId
        if (turnId === undefined) return

        let buffer = this.#buffers.get(turnId)
        if (buffer === undefined) {
            buffer = {
                turnId,
                events: [],
                state: "running",
                listeners: new Map(),
                truncated: false,
                dropped: 0,
                // A buffer created by the first event rather than by `open` holds no chunk
                // interest, so whether chunks reach it is decided by whoever else asked. A stream
                // that attaches later and asks will say `"partial"`, which is the truth.
                chunks: "none",
                holdsChunkInterest: false,
            }
            this.#buffers.set(turnId, buffer)
        }

        buffer.events.push(event)
        if (buffer.events.length > this.#maxEvents) {
            buffer.events.shift()
            buffer.truncated = true
            buffer.dropped += 1
        }
        // Once any chunk has been buffered, the replay does carry token history — even if interest
        // began after the turn did. `"start"` is only claimed by `open`.
        if (event.type === "model.chunk" && buffer.chunks === "none") buffer.chunks = "partial"

        // A listener that throws must not stop the others, nor the turn. Same reasoning as the
        // bus itself: an attached client with a bug is not permitted to break generation.
        const chunk = event.type === "model.chunk"
        for (const [listener, wantsChunks] of [...buffer.listeners]) {
            if (chunk && !wantsChunks) continue
            try {
                listener(event)
            } catch {
                // Deliberately swallowed here: this is a fan-out to observers of a turn, and the
                // bus has already reported the event to its own error channel.
            }
        }

        if (event.type === "turn.end") {
            buffer.state = "ended"
            buffer.endedAt = this.#now()
            this.#evict()
        }
    }

    /**
     * Attach to a turn: get everything so far, plus everything from now on.
     *
     * Returns `undefined` when the turn has no buffer — either it never existed in this process,
     * or it ended and was evicted. The caller distinguishes those two by looking the turn up in
     * the store, and the distinction matters: an unknown turn id is a 404, while a known-but-
     * evicted one is a 200 with the final text and no stream. `state()` exists so that decision can
     * be made *before* a response is constructed, outside the synchronous block below.
     *
     * Not `async`, and must not become so — see the file comment.
     */
    attach(
        turnId: string,
        onEvent: (event: AnyEvent) => void,
        options: { readonly chunks?: boolean } = {},
    ): TurnAttachment | undefined {
        const buffer = this.#buffers.get(turnId)
        if (buffer === undefined) return undefined

        // Interest is taken before the snapshot, so a turn still running starts producing tokens
        // for this attachment from here on rather than from the next event after it.
        const wantsChunks = options.chunks === true
        if (wantsChunks) this.#takeChunkInterest()

        // Snapshot and subscribe with no await between them. This is the gapless handover.
        const replay = [...buffer.events]
        buffer.listeners.set(onEvent, wantsChunks)

        let detached = false
        return {
            turnId,
            replay,
            state: buffer.state,
            truncated: buffer.truncated,
            dropped: buffer.dropped,
            chunks: buffer.chunks,
            unsubscribe: () => {
                if (detached) return
                detached = true
                buffer.listeners.delete(onEvent)
                if (wantsChunks) this.#releaseChunkInterest()
            },
        }
    }

    /** Whether a turn is still attachable, without subscribing to it. */
    state(turnId: string): TurnBufferState | undefined {
        return this.#buffers.get(turnId)?.state
    }

    /** True when the turn's oldest events were dropped to stay under the cap. */
    truncated(turnId: string): boolean {
        return this.#buffers.get(turnId)?.truncated ?? false
    }

    get size(): number {
        return this.#buffers.size
    }

    /**
     * Drop ended buffers that are past the retention policy.
     *
     * Called on every `turn.end` rather than on a timer: a timer would keep an otherwise idle
     * process awake, and the whole point of the boot-time discipline is that this runtime does
     * nothing when nothing is happening. The consequence is that a buffer can outlive its
     * retention window while the process is idle — which is harmless, because nothing is
     * competing for the memory, and it becomes attachable-but-stale rather than incorrect.
     */
    #evict(): void {
        const now = this.#now()
        const ended: Buffered[] = []

        for (const buffer of this.#buffers.values()) {
            if (buffer.state !== "ended" || buffer.endedAt === undefined) continue
            // A buffer someone is still attached to is never evicted by age. A client mid-replay
            // losing its own stream is a bug that looks exactly like a network fault.
            if (buffer.listeners.size > 0) continue
            if (now - buffer.endedAt >= this.#retainMs) {
                this.#drop(buffer)
                continue
            }
            ended.push(buffer)
        }

        if (ended.length <= this.#retainCount) return
        ended.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
        for (const buffer of ended.slice(0, ended.length - this.#retainCount)) {
            this.#drop(buffer)
        }
    }

    /**
     * Forget a buffer and give back whatever chunk interest it held.
     *
     * Both eviction paths go through here rather than calling `delete` directly. A buffer that was
     * opened with chunks and then dropped without releasing would leave the bus emitting per-token
     * envelopes for the rest of the process's life with nobody reading them — a leak that costs
     * nothing visible and everything measurable, which is the kind this repo keeps finding.
     */
    #drop(buffer: Buffered): void {
        if (buffer.holdsChunkInterest) {
            buffer.holdsChunkInterest = false
            this.#releaseChunkInterest()
        }
        this.#buffers.delete(buffer.turnId)
    }

    /** Drop everything and stop listening. Called from `Runtime.stop`. */
    close(): void {
        this.#unsubscribeBus?.()
        this.#unsubscribeBus = undefined
        this.#releaseAllChunkInterest()
        this.#bus = undefined
        this.#buffers.clear()
    }
}
