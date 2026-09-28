/**
 * Idempotent outbound delivery.
 *
 * The queue exists for one reason: **a crash mid-delivery must not double-send.** Everything else
 * here — backoff, ordering, chunk abandonment — is in service of that or falls out of it.
 *
 * How much of "exactly once" is actually delivered, stated precisely, because the honest version is
 * the useful one:
 *
 * | Crash point | Outcome |
 * | --- | --- |
 * | before `enqueue` | nothing was promised; the turn is retried and enqueues against the same keys |
 * | after `enqueue`, before `claim` | row is `pending`, sent once on the next drain |
 * | after `claim`, before the provider replies | **ambiguous** — see below |
 * | after the provider replies, before `markSent` | **ambiguous** — same window |
 * | after `markSent` | row is terminal, never resent |
 *
 * The ambiguous window is real and cannot be closed from this side: the bytes may have arrived and
 * the acknowledgement may have died with the process. Closing it requires the *provider* to
 * deduplicate on a key we supply, which is what `ChannelLimits.idempotentSend` declares. Telegram's
 * `sendMessage` has no such parameter. So a recovered row is re-sent and flagged `uncertain`,
 * carrying that flag onto `delivery.sent` — the duplicate stays explicable after the fact instead of
 * appearing as an unexplained second message. Retrying rather than holding is the deliberate choice:
 * in a conversational channel a lost reply reads as the agent ignoring you, and produces no signal
 * anywhere, while a duplicate produces both a message and an event.
 *
 * The duplicate source this *does* eliminate entirely is the one that actually happens — the
 * enqueuer running twice. See `deliveryKey`.
 */

import { basename } from "node:path"
import type { ErrorDetail } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type {
    DeliveryAttachment,
    DeliveryRecord,
    EnqueueDelivery,
    OutboxStore,
} from "../store/store.ts"
import type { ChannelTransport, OutboundMessage } from "./channel.ts"
import { splitMessage } from "./split.ts"

/**
 * Delays before attempts 2..N, in milliseconds.
 *
 * Ends at ten minutes rather than continuing to grow: past that the useful action is a person
 * looking at `delivery.failed`, not a queue quietly retrying into a channel that has been
 * misconfigured since yesterday.
 */
const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 5_000, 25_000, 120_000, 600_000]

const DEFAULT_CONCURRENCY = 4
const DEFAULT_SEND_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
/** A drain pass sends the head of each group, so a long reply needs one pass per chunk. */
const MAX_PASSES = 64

/**
 * The identity of one reply to one recipient.
 *
 * `turnId` is the discriminator in the normal case; a delivery with no turn — a channel-level
 * notice, a Phase 8 schedule tick with its own natural key — passes `key` instead. One of the two
 * is required, and that is enforced by the type rather than by a runtime check.
 */
export type DeliveryGroupParts = {
    readonly sessionKey: string
    readonly channelId: string
    readonly recipient: string
} & ({ readonly turnId: string } | { readonly key: string })

/**
 * Components are percent-encoded and joined with `|`.
 *
 * Encoded rather than trusting a separator to be absent: `recipient` is provider-supplied and
 * `sessionKey`'s peer segment is arbitrary, so any literal delimiter is one an input could
 * contain — and two groups colliding on one key means the second reply is silently never sent.
 *
 * The separator is printable ASCII for a reason learned the hard way here. An earlier version
 * used \u0000, which **node:sqlite truncates a bound string at and bun:sqlite stores whole**.
 * The key round-tripped as `tg%3A1` under Node, matched nothing, and the only symptom was
 * chunks quietly never being abandoned — no error, on one runtime out of two.
 */
const SEP = "|"

function part(value: string): string {
    return encodeURIComponent(value)
}

export function deliveryGroup(parts: DeliveryGroupParts): string {
    const discriminator = "turnId" in parts ? `t:${part(parts.turnId)}` : `k:${part(parts.key)}`
    return [
        part(parts.sessionKey),
        part(parts.channelId),
        part(parts.recipient),
        discriminator,
    ].join(SEP)
}

/**
 * The per-chunk dedupe key. **Derived, never generated.**
 *
 * Every component is a fact the caller can reproduce after a crash, which is the entire property:
 * a replayed turn recomputes the identical key, collides with the existing row, and sends nothing.
 * A UUID minted here would dedupe the outbox against itself — a problem it does not have — while
 * leaving the one that does wide open.
 */
export function deliveryKey(groupKey: string, chunkIndex: number): string {
    return `${groupKey}${SEP}${chunkIndex}`
}

export interface OutboxOptions {
    readonly store: OutboxStore
    readonly bus: EventBus
    /** Transport per channel id. A delivery naming an absent channel fails permanently. */
    readonly channels: ReadonlyMap<string, ChannelTransport>
    /** Total attempts before a row is `failed`. Defaults to `backoffMs.length + 1`. */
    readonly maxAttempts?: number
    readonly backoffMs?: readonly number[]
    readonly concurrency?: number
    readonly sendTimeoutMs?: number
    readonly pollIntervalMs?: number
    /** Injectable for tests. Defaults to `Date.now`. */
    readonly now?: () => number
}

export interface EnqueueReply {
    readonly agentId: string
    readonly sessionKey: string
    readonly channelId: string
    readonly recipient: string
    readonly turnId?: string
    /** Required when `turnId` is absent — see `DeliveryGroupParts`. */
    readonly key?: string
    readonly thread?: string
    readonly text: string
    /**
     * Files sent after the text, one chunk each, in order. On a channel whose transport declares no
     * `limits.attachments`, each is named in the text instead — never dropped without a word.
     */
    readonly attachments?: readonly DeliveryAttachment[]
}

export interface DrainReport {
    readonly sent: number
    readonly retried: number
    readonly failed: number
}

export class Outbox {
    readonly #store: OutboxStore
    readonly #bus: EventBus
    readonly #channels: ReadonlyMap<string, ChannelTransport>
    readonly #backoff: readonly number[]
    readonly #maxAttempts: number
    readonly #concurrency: number
    readonly #sendTimeoutMs: number
    readonly #pollIntervalMs: number
    readonly #now: () => number

    #timer: ReturnType<typeof setInterval> | undefined
    #draining = false
    /** Per channel, when the next send may start. Enforces `ChannelLimits.minSendIntervalMs`. */
    readonly #nextSendAt = new Map<string, number>()

    constructor(options: OutboxOptions) {
        this.#store = options.store
        this.#bus = options.bus
        this.#channels = options.channels
        this.#backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
        this.#maxAttempts = options.maxAttempts ?? this.#backoff.length + 1
        this.#concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
        this.#sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
        this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
        this.#now = options.now ?? (() => Date.now())
    }

    /**
     * Split a reply into chunks and queue them. Idempotent for a given `(turnId, channel, recipient)`.
     *
     * Splitting happens here rather than at send time so `chunk_index` is fixed at enqueue: a
     * message re-split later against a different `maxMessageChars` — a channel reconfigured, a
     * provider raising its limit — would produce different keys for the same reply, and the
     * collision that makes replay safe would stop happening.
     */
    async enqueue(reply: EnqueueReply): Promise<readonly DeliveryRecord[]> {
        const transport = this.#channels.get(reply.channelId)
        if (transport === undefined) {
            throw new Error(
                `No channel "${reply.channelId}" is configured for agent ${reply.agentId}. ` +
                    `hint: known channels are ${[...this.#channels.keys()].join(", ") || "(none)"}. ` +
                    "Delivery targets name a channel id from the manifest's channels list, not a channel type.",
            )
        }
        if (reply.turnId === undefined && reply.key === undefined) {
            throw new Error(
                "A delivery needs either a turnId or an explicit key. " +
                    "hint: the dedupe key is derived from one of them, and without either there is nothing " +
                    "for a replayed enqueue to collide with — every retry would send another copy.",
            )
        }

        const groupKey = deliveryGroup({
            sessionKey: reply.sessionKey,
            channelId: reply.channelId,
            recipient: reply.recipient,
            ...(reply.turnId === undefined
                ? { key: reply.key as string }
                : { turnId: reply.turnId }),
        })

        const attachments = reply.attachments ?? []
        const carried = transport.limits.attachments === true ? attachments : []
        const named =
            carried.length === attachments.length
                ? ""
                : attachments
                      .map(
                          (file) =>
                              `\n\n(${basename(file.path)} is in my workspace; this channel cannot carry files.)`,
                      )
                      .join("")
        const text = `${reply.text}${named}`.trim()
        // An empty text with an attachment is an image on its own, not an empty message before it.
        const chunks: { body: string; attachment?: DeliveryAttachment }[] = [
            ...(text === ""
                ? []
                : splitMessage(text, {
                      maxChars: transport.limits.maxMessageChars,
                      fenceAware: true,
                  }).map((body) => ({ body }))),
            ...carried.map((attachment) => ({ body: "", attachment })),
        ]

        // The engine's clock, not the store's. `due` is asked with this same clock, and two
        // different ones make readiness depend on wall-clock time rather than on the queue.
        const stampedAt = new Date(this.#now()).toISOString()
        const deliveries: EnqueueDelivery[] = chunks.map(({ body, attachment }, index) => ({
            agentId: reply.agentId,
            nextAttemptAt: stampedAt,
            dedupeKey: deliveryKey(groupKey, index),
            groupKey,
            sessionKey: reply.sessionKey,
            ...(reply.turnId === undefined ? {} : { turnId: reply.turnId }),
            channelId: reply.channelId,
            recipient: reply.recipient,
            ...(reply.thread === undefined ? {} : { thread: reply.thread }),
            chunkIndex: index,
            chunkTotal: chunks.length,
            body,
            ...(attachment === undefined ? {} : { attachment }),
        }))

        const results = await this.#store.enqueue(deliveries)
        return results.map((result) => result.record)
    }

    /**
     * Send everything due, repeatedly, until nothing is.
     *
     * `due` returns only the head of each group, so a three-chunk reply takes three passes. The
     * loop is bounded rather than open: a bug that left a row perpetually due would otherwise spin
     * forever inside one call, and a bounded loop turns that into a slow queue rather than a hung
     * process.
     */
    async drain(agentId: string): Promise<DrainReport> {
        let sent = 0
        let retried = 0
        let failed = 0

        for (let pass = 0; pass < MAX_PASSES; pass += 1) {
            const due = await this.#store.due(
                agentId,
                new Date(this.#now()).toISOString(),
                this.#concurrency,
            )
            if (due.length === 0) break

            const outcomes = await Promise.all(due.map((row) => this.#attempt(row)))
            let progressed = false
            for (const outcome of outcomes) {
                if (outcome === "sent") {
                    sent += 1
                    progressed = true
                } else if (outcome === "retry") {
                    retried += 1
                } else if (outcome === "failed") {
                    failed += 1
                    progressed = true
                }
            }

            // A pass where every row went to backoff made no forward progress; looping would just
            // re-read the same rows before their time. The poll loop picks them up later.
            if (!progressed) break
        }

        return { sent, retried, failed }
    }

    /**
     * Re-queue deliveries a dead process left in flight. Call once, at boot, before `start`.
     *
     * Returns what it recovered so the caller reports it rather than this method logging into a
     * void — the same reason `TurnStore.reapRunning` returns its ids.
     *
     * `agentIds` are the agents this process holds a runtime lease for. Recovering another live
     * process's in-flight rows makes *it* re-send a message it had already sent, so the scope is
     * not an optimisation.
     */
    async recover(agentIds: readonly string[]): Promise<readonly DeliveryRecord[]> {
        const recovered = await this.#store.recoverInflight(
            agentIds,
            new Date(this.#now()).toISOString(),
        )
        for (const row of recovered) {
            this.#bus.emit(
                "delivery.uncertain",
                {
                    channelId: row.channelId,
                    chunkIndex: row.chunkIndex,
                    chunkTotal: row.chunkTotal,
                    attempts: row.attempts,
                    idempotentSend:
                        this.#channels.get(row.channelId)?.limits.idempotentSend ?? false,
                },
                {
                    agentId: row.agentId,
                    sessionKey: row.sessionKey,
                    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
                },
            )
        }
        return recovered
    }

    /** Begin polling. Overlapping ticks are suppressed rather than queued. */
    start(agentId: string): void {
        if (this.#timer !== undefined) return
        this.#timer = setInterval(() => {
            if (this.#draining) return
            this.#draining = true
            void this.drain(agentId).finally(() => {
                this.#draining = false
            })
        }, this.#pollIntervalMs)
        // Node and Bun both keep the process alive for a pending interval. A delivery queue is not
        // a reason for a CLI to refuse to exit.
        this.#timer.unref?.()
    }

    stop(): void {
        if (this.#timer === undefined) return
        clearInterval(this.#timer)
        this.#timer = undefined
    }

    async #attempt(row: DeliveryRecord): Promise<"sent" | "retry" | "failed" | "skipped"> {
        const transport = this.#channels.get(row.channelId)
        if (transport === undefined) {
            // Permanent by construction: no amount of waiting adds a channel to a running runtime.
            await this.#fail(row, {
                code: "delivery_channel_unknown",
                message: `Channel "${row.channelId}" is not configured on this runtime.`,
                hint: "The manifest's channels list changed, or a delivery target names a channel that was removed. Queued rows keep the channel id they were enqueued with — restore the channel or drop the rows.",
            })
            return "failed"
        }

        const wait = (this.#nextSendAt.get(row.channelId) ?? 0) - this.#now()
        if (wait > 0) return "skipped"

        const claimed = await this.#store.claim(row.id)
        // Lost to a concurrent drain. Not an error: the other claimant owns it now.
        if (claimed === undefined) return "skipped"

        const message: OutboundMessage = {
            channelId: row.channelId,
            recipient: row.recipient,
            text: row.body,
            ...(row.thread === undefined ? {} : { thread: row.thread }),
            idempotencyKey: row.dedupeKey,
            chunkIndex: row.chunkIndex,
            chunkTotal: row.chunkTotal,
            ...(row.attachment === undefined ? {} : { attachment: row.attachment }),
        }

        const controller = new AbortController()
        const timer = setTimeout(() => {
            controller.abort()
        }, this.#sendTimeoutMs)

        let result: Awaited<ReturnType<ChannelTransport["send"]>>
        try {
            result = await transport.send(message, controller.signal)
        } catch (cause) {
            // A transport that throws is a transport with a bug or a network stack that gave up.
            // Treated as retryable: the alternative is abandoning a message because a channel
            // package forgot a try/catch.
            result = {
                ok: false,
                retryable: true,
                error: {
                    code: "delivery_transport_threw",
                    message: cause instanceof Error ? cause.message : String(cause),
                    hint: "The channel's send() rejected instead of returning a SendResult. This is retried, but a transport should classify its own failures — only it knows which of the provider's errors are permanent.",
                },
            }
        } finally {
            clearTimeout(timer)
        }

        const interval = transport.limits.minSendIntervalMs ?? 0
        if (interval > 0) this.#nextSendAt.set(row.channelId, this.#now() + interval)

        const context = {
            agentId: row.agentId,
            sessionKey: row.sessionKey,
            ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
        }

        if (result.ok) {
            await this.#store.markSent(row.id, result.providerMessageId)
            this.#bus.emit(
                "delivery.sent",
                {
                    channelId: row.channelId,
                    ...(result.providerMessageId === undefined
                        ? {}
                        : { providerMessageId: result.providerMessageId }),
                    chunkIndex: row.chunkIndex,
                    chunkTotal: row.chunkTotal,
                    attempts: row.attempts + 1,
                    // Carried through so a duplicate that reaches a person is explicable from the
                    // event stream, not only from whatever was logged at recovery time.
                    uncertain: row.uncertain,
                },
                context,
            )
            return "sent"
        }

        const attempts = row.attempts + 1
        const exhausted = attempts >= this.#maxAttempts
        if (!result.retryable || exhausted) {
            await this.#fail(row, result.error, exhausted && result.retryable)
            return "failed"
        }

        const delay = result.retryAfterMs ?? this.#delayFor(attempts)
        const nextAttemptAt = new Date(this.#now() + delay).toISOString()
        await this.#store.markRetry(row.id, nextAttemptAt, result.error)
        this.#bus.emit(
            "delivery.retry",
            {
                channelId: row.channelId,
                chunkIndex: row.chunkIndex,
                attempts,
                delayMs: delay,
                error: result.error,
            },
            context,
        )
        return "retry"
    }

    async #fail(row: DeliveryRecord, error: ErrorDetail, exhausted = false): Promise<void> {
        await this.#store.markFailed(row.id, error)
        const abandoned = await this.#store.abandonGroupAfter(
            row.agentId,
            row.groupKey,
            row.chunkIndex,
            {
                code: "delivery_chunk_abandoned",
                message: `Chunk ${row.chunkIndex + 1} of ${row.chunkTotal} could not be delivered, so the rest of this message was not sent.`,
            },
        )
        this.#bus.emit(
            "delivery.failed",
            {
                channelId: row.channelId,
                chunkIndex: row.chunkIndex,
                chunkTotal: row.chunkTotal,
                attempts: row.attempts + 1,
                exhausted,
                // Reported as a count rather than as N more failure events: one cause, one report.
                // A reader seeing three `delivery.failed` for one reply would look for three faults.
                abandoned: abandoned.length,
                error,
            },
            {
                agentId: row.agentId,
                sessionKey: row.sessionKey,
                ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
            },
        )
    }

    /** `attempt` is 1-based; attempt 1 has already happened when this is asked. */
    #delayFor(attempt: number): number {
        const index = Math.min(attempt - 1, this.#backoff.length - 1)
        return this.#backoff[Math.max(0, index)] ?? 0
    }
}
