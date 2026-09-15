/**
 * One iterable over a turn, covering every way a stream can go.
 *
 * This is the part of the client that is not just request plumbing. A turn stream is not a flat
 * sequence of events: it may open with an acceptance frame, it announces a replay whose front may
 * be missing, it carries runtime events, and it can end in three different ways — the turn
 * finishing, the turn having finished before you attached, or the turn being recorded but not
 * observable from the process you asked. A caller should be able to write one `for await` and
 * still be able to tell those apart.
 *
 * So the iterable yields a **discriminated union** rather than bare events. That is a deliberate
 * cost: `for await (const item of ...)` needs a `switch` instead of reading `.type` directly. The
 * alternative was yielding only events and exposing the rest on the handle, which reads better and
 * loses the one thing 13.3 exists to surface — a client that concatenates a truncated replay
 * builds a shorter reply and believes it. Making the hole a value in the sequence means the code
 * that assembles text has to have seen it.
 *
 * `tokens()` and `text()` in `index.ts` are the ergonomic layer over this, and they *refuse* a
 * truncated replay rather than quietly returning a short answer.
 */

import { type AnyEvent, EVENT_TYPES, parseSSE } from "@dispach/core"
import { DispachError } from "./errors.ts"

/** What a replay says about itself, from the `stream.replay` preamble. */
export interface ReplayReport {
    /** Whether the turn was still running when the buffer was snapshotted. */
    readonly state: "running" | "ended"
    /** How many events the replay carries. */
    readonly events: number
    /** The buffer discarded its oldest events to stay under its cap. */
    readonly truncated: boolean
    /** How many were discarded. Zero unless `truncated`. */
    readonly dropped: number
    /**
     * Whether token history is complete in the replay.
     *
     * `"start"` from the first token, `"partial"` from somewhere in the middle, `"none"` at all.
     * A reattaching client reconstructing text needs this: `"partial"` and `"none"` mean the
     * replay's tokens are not the whole reply even when `truncated` is false, because chunk
     * interest is taken when somebody asks and the turn may have been running before that.
     */
    readonly chunks: "start" | "partial" | "none"
}

export type TurnStreamItem =
    /** The first frame on an inline stream: the same object a non-streaming POST returns. */
    | { readonly kind: "accepted"; readonly turnId: string; readonly sessionKey: string }
    /** Always before any replayed event, so a hole is known before text is assembled. */
    | { readonly kind: "replay"; readonly report: ReplayReport }
    /** A runtime event, enveloped and typed. */
    | { readonly kind: "event"; readonly event: AnyEvent }
    /**
     * The turn finished before you attached and its buffer has been evicted.
     *
     * Not an error: the turn happened and its answer exists. `status` is the stored outcome and
     * the full text is one `GET /v1/agents/:id/turns/:turnId` away.
     */
    | {
          readonly kind: "ended"
          readonly turnId: string
          readonly status: string
          readonly steps: number | undefined
          readonly errorCode: string | undefined
      }
    /**
     * Recorded as running, and not observable from the process you asked.
     *
     * One store is shared by every process under a sandbox root, so a served process can hold a
     * `running` row for a turn another process is executing. Distinct from `ended` because
     * treating it as finished would send a reader after a final text that does not exist yet.
     */
    | { readonly kind: "unavailable"; readonly turnId: string; readonly reason: string }

/** The `stream.subscribed` preamble on the firehose, reporting the filter the server resolved. */
export interface SubscribedReport {
    readonly agentId: string | null
    readonly types: readonly string[] | null
    readonly chunks: boolean
    /** Present when `chunks` is on because `types` named `model.chunk`. */
    readonly implied: string | undefined
}

export type EventStreamItem =
    | { readonly kind: "subscribed"; readonly report: SubscribedReport }
    | { readonly kind: "event"; readonly event: AnyEvent }

const REAL_EVENTS: ReadonlySet<string> = new Set(EVENT_TYPES)

/**
 * Bytes to `{event, data}` frames.
 *
 * `parseSSE` comes from core rather than being written again here, which matters more than saving
 * sixty lines: it already handles a trailing frame with no terminating blank line, decodes
 * multi-byte characters across chunk boundaries, and is the parser the runtime itself reads model
 * responses with. A second implementation would be a second set of edge cases to get wrong, and
 * the ones it gets wrong would show up as a truncated last token.
 */
async function* frames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ name: string; data: unknown }> {
    for await (const frame of parseSSE(streamToIterable(body))) {
        if (frame.event === undefined || frame.data === "") continue
        let data: unknown
        try {
            data = JSON.parse(frame.data)
        } catch {
            // A frame whose data is not JSON is not something this server sends. Skipped rather
            // than thrown: a heartbeat comment or a proxy's injected keep-alive must not end a
            // stream that is otherwise fine.
            continue
        }
        yield { name: frame.event, data }
    }
}

/** `ReadableStream` is async-iterable in Bun and Node 22+, and is not in every browser yet. */
async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return
            if (value !== undefined) yield value
        }
    } finally {
        // Releasing matters on an early `break` out of the caller's `for await`: without it the
        // response body stays locked and the connection is never freed.
        reader.releaseLock()
    }
}

/** Map a turn stream's frames onto the union. */
export async function* turnStreamItems(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<TurnStreamItem> {
    for await (const { name, data } of frames(body)) {
        // The discriminator is `EVENT_TYPES` — the runtime's own catalogue — rather than a list of
        // control-frame names kept here. A frame this package has never heard of is therefore
        // treated as an event if the runtime says it is one, and ignored otherwise, so a new
        // control frame cannot be mistaken for an event by a client built before it existed.
        if (REAL_EVENTS.has(name)) {
            yield { kind: "event", event: data as AnyEvent }
            continue
        }

        const record = (data ?? {}) as Record<string, unknown>
        switch (name) {
            case "turn.accepted":
                yield {
                    kind: "accepted",
                    turnId: String(record.turnId ?? ""),
                    sessionKey: String(record.sessionKey ?? ""),
                }
                break
            case "stream.replay":
                yield {
                    kind: "replay",
                    report: {
                        state: record.state === "ended" ? "ended" : "running",
                        events: Number(record.events ?? 0),
                        truncated: record.truncated === true,
                        dropped: Number(record.dropped ?? 0),
                        chunks:
                            record.chunks === "start" || record.chunks === "partial"
                                ? record.chunks
                                : "none",
                    },
                }
                break
            case "stream.ended":
                yield {
                    kind: "ended",
                    turnId: String(record.turnId ?? ""),
                    status: String(record.status ?? "unknown"),
                    steps: typeof record.steps === "number" ? record.steps : undefined,
                    errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined,
                }
                break
            case "stream.unavailable":
                yield {
                    kind: "unavailable",
                    turnId: String(record.turnId ?? ""),
                    reason: String(record.reason ?? "not observable from this process"),
                }
                break
            default:
                // An unknown control frame. Ignored deliberately: the event catalogue is
                // append-only within `v: 1`, so a newer server may send a frame this client has
                // no case for, and stopping the stream over it would make an additive change
                // breaking.
                break
        }
    }
}

/** Map the firehose's frames onto its own, smaller union. */
export async function* eventStreamItems(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamItem> {
    for await (const { name, data } of frames(body)) {
        if (REAL_EVENTS.has(name)) {
            yield { kind: "event", event: data as AnyEvent }
            continue
        }
        if (name === "stream.subscribed") {
            const record = (data ?? {}) as Record<string, unknown>
            yield {
                kind: "subscribed",
                report: {
                    agentId: typeof record.agentId === "string" ? record.agentId : null,
                    types: Array.isArray(record.types) ? (record.types as string[]) : null,
                    chunks: record.chunks === true,
                    implied: typeof record.implied === "string" ? record.implied : undefined,
                },
            }
        }
    }
}

/**
 * The text deltas of a turn, and nothing else.
 *
 * **Refuses a truncated replay** unless told not to. A caller reaching for `tokens()` is
 * assembling a reply, and a replay missing its front produces a shorter one with no symptom —
 * the failure `stream.replay` was introduced to make visible. Returning the fragment anyway would
 * put the honesty back behind a field nobody checks, so the default is to throw and the opt-out is
 * a named argument, which is the shape `--yes` already has elsewhere in this project.
 *
 * `kind: "reasoning"` deltas are excluded: they are the model thinking, not the reply, and
 * concatenating them into the answer is a bug a UI would ship once and never notice in tests.
 */
export async function* textDeltas(
    items: AsyncIterable<TurnStreamItem>,
    options: { readonly allowTruncated?: boolean } = {},
): AsyncGenerator<string> {
    for await (const item of items) {
        if (item.kind === "replay" && item.report.truncated && options.allowTruncated !== true) {
            throw new DispachError({
                code: "replay_truncated",
                message: `This turn's replay is missing its oldest ${item.report.dropped} event(s), so the text reconstructed from it would be incomplete.`,
                hint: "Read the finished text from GET /v1/agents/:id/turns/:turnId, or pass { allowTruncated: true } to accept a fragment. Streaming from the start of a turn is never truncated — this only happens when reattaching to one that has already produced more events than the buffer holds.",
            })
        }
        if (item.kind === "unavailable") {
            throw new DispachError({
                code: "turn_not_observable",
                message: `Turn ${item.turnId} is recorded as running but is not observable here: ${item.reason}.`,
                hint: "Its events are buffered in whichever process is executing it. Poll GET /v1/agents/:id/turns/:turnId for the outcome.",
            })
        }
        if (item.kind !== "event") continue
        if (item.event.type !== "model.chunk") continue
        const data = item.event.data as { delta?: unknown; kind?: unknown }
        if (data.kind === "reasoning") continue
        if (typeof data.delta === "string") yield data.delta
    }
}
