/**
 * What a channel package implements, and what the runtime promises it in return.
 *
 * A channel is a *transport*, not a policy. It moves bytes to and from a messaging provider and
 * declares two facts about itself — how long a message may be, and whether the provider accepts a
 * client-supplied idempotency key. Everything else (allowlists, session routing, chunking,
 * ordering, retry, deduplication) is core's, so that two channels cannot disagree about it.
 *
 * The split matters most for **exactly-once delivery**, which is not achievable in general and is
 * achievable in parts. Core closes the window it owns: a re-enqueue of the same logical delivery
 * collides on a derived key and is a no-op. The window it does not own is between the bytes leaving
 * this process and the provider's acknowledgement arriving back — closing *that* requires the
 * provider to deduplicate on a key we supply, and Telegram's `sendMessage` has no such parameter
 * while WhatsApp Cloud API does. `ChannelLimits.idempotentSend` is how a channel says which it is,
 * so the outbox can be honest per-channel instead of uniformly optimistic.
 */

import type { ErrorDetail } from "../errors.ts"

/** A message as it arrived, before normalisation. Channel-shaped, not yet runtime-shaped. */
export interface RawInbound {
    /**
     * The provider's own id for this message, when it has one.
     *
     * Used to drop a redelivery: Telegram's long-poll replays an update whose offset was never
     * acknowledged, and a webhook is retried on any non-2xx. Absent is allowed — a channel with no
     * message ids simply gets no inbound deduplication, which is honest, and better than
     * synthesising an id that looks stable and is not.
     */
    readonly providerMessageId?: string
    /** The provider's id for the conversation. Becomes the peer segment of the session key. */
    readonly peerId: string
    /**
     * A human-facing handle for the sender: `@moeen`, a phone number, an email.
     *
     * Distinct from `peerId` because `allowFrom` is written by a person, who knows the handle and
     * not the numeric id. Both are matched — see `inbox.ts`.
     */
    readonly senderHandle?: string
    readonly senderName?: string
    /** Thread, topic, or forum sub-id. Keeps a forum topic from sharing one session with its group. */
    readonly thread?: string
    readonly text: string
    /** RFC 3339 UTC. The provider's timestamp when it has one, ours otherwise. */
    readonly receivedAt: string
}

/** A `RawInbound` that passed the allowlist, with its session resolved. */
export interface InboundMessage extends RawInbound {
    readonly channelId: string
    readonly channelType: string
    /** `{channel}:{peerId}[:{thread}]` — see `store/session-key.ts`. */
    readonly sessionKey: string
}

/** One chunk, addressed. What a transport is actually handed. */
export interface OutboundMessage {
    readonly channelId: string
    /** Provider-addressable destination. Usually the `peerId` the turn came from. */
    readonly recipient: string
    readonly text: string
    readonly thread?: string
    /**
     * The outbox's derived key for this delivery.
     *
     * Supplied to every transport whether or not it can use one: a transport that declares
     * `idempotentSend` passes it to the provider, and one that cannot ignores it. Handing it over
     * unconditionally means enabling provider-side deduplication later is a change inside the
     * channel package rather than a new field on this interface.
     */
    readonly idempotencyKey: string
    /** 0-based position within the reply. `total` lets a transport render "1/3" if it wants to. */
    readonly chunkIndex: number
    readonly chunkTotal: number
}

export type SendResult =
    | {
          readonly ok: true
          /** The provider's id for what it just created. Recorded on the row and on `delivery.sent`. */
          readonly providerMessageId?: string
      }
    | {
          readonly ok: false
          /**
           * Whether trying again could plausibly work.
           *
           * A transport decides this because only it knows the provider's taxonomy: a 429 and a 503
           * are retryable, "chat not found" and "bot was blocked by the user" are not. Getting it
           * wrong in the safe direction costs a few pointless attempts; getting it wrong in the other
           * direction abandons a message that would have gone through on the next try.
           */
          readonly retryable: boolean
          readonly error: ErrorDetail
          /** Honoured verbatim when the provider names a wait — Telegram's 429 `retry_after`. */
          readonly retryAfterMs?: number
      }

export interface ChannelLimits {
    /**
     * The provider's hard cap on one message, in UTF-16 code units.
     *
     * Code units rather than characters because that is what providers count: Telegram's 4096 is
     * measured the way `String.prototype.length` measures. Splitting is core's job (`split.ts`), so
     * this number exists in exactly one place per channel.
     */
    readonly maxMessageChars: number
    /**
     * Whether `OutboundMessage.idempotencyKey` reaches the provider and is deduplicated there.
     *
     * `false` is the honest default and is not a defect — it means the outbox reports a recovered
     * in-flight delivery as `delivery.uncertain` rather than claiming exactly-once it cannot
     * deliver. Setting it `true` without provider support converts a visible ambiguity into a
     * silent duplicate, which is strictly worse than the ambiguity.
     */
    readonly idempotentSend: boolean
    /**
     * Minimum gap between two sends on this channel, or 0 for none.
     *
     * Providers rate-limit per conversation. Pacing here costs a few hundred milliseconds on a
     * chunked reply and avoids a 429 that would cost a full backoff cycle.
     */
    readonly minSendIntervalMs?: number
}

/**
 * A channel's last reported state.
 *
 * `needs_input` is the one that is not about the network: the transport is running and cannot
 * finish connecting until a *person* does something — WhatsApp's link-device QR is the first
 * instance and a re-auth after a session expires is the second. It exists before either ships
 * because a client that has learned to read four states will not grow a fifth quietly, and
 * without it "live but waiting for somebody" is indistinguishable from a hang.
 *
 * Deliberately not a discriminated object. The states that carry nothing would gain a wrapper
 * they do not need, and `status` is a string on the wire (`agent.channel.status`) where changing
 * a field's type inside `v: 1` breaks every consumer that already reads it. The structured half
 * travels beside it as `ChannelInput`.
 */
export type ChannelStatus = "starting" | "connected" | "disconnected" | "error" | "needs_input"

/**
 * What a person has to supply, when a channel reports `needs_input`.
 *
 * `kind` has one member on purpose. A second with no producer is the dead-vocabulary shape this
 * runtime keeps finding (`kv`, `eviction: oldest`, `declined`) — and a reader needs a fallback
 * branch for an unknown kind regardless, since the set can always grow, so growing it later
 * costs a consumer nothing.
 */
export interface ChannelInput {
    /**
     * How to present `payload`.
     *
     * `qr` — render it as a 2D barcode. `pairing_code` — show it as text to be typed in, which is
     * WhatsApp's alternative to scanning and the only route that works on a surface that cannot
     * draw a barcode.
     *
     * The set grows inside `v: 1` because this is a **string on the wire**; a client that has never
     * heard of a kind must still show the payload rather than an empty box, which is why every
     * renderer here has an unknown-kind branch.
     */
    readonly kind: "qr" | "pairing_code"
    /** The bytes to render or display, verbatim. Never a sentence — that is `detail`. */
    readonly payload: string
    /**
     * When it stops working, if the transport knows. RFC 3339.
     *
     * WhatsApp rotates its QR roughly every 20 seconds, so a stored payload goes stale fast and a
     * code nobody can tell is expired is worse than none — it reads as a broken scanner rather
     * than an old picture. Absent means the transport does not know, never "it does not expire".
     */
    readonly expiresAt?: string
}

/**
 * A `ChannelInput` as a reader gets it: stamped with when the runtime recorded it.
 *
 * The stamp is the runtime's rather than the transport's so one clock decides it, and it is
 * required rather than optional because a payload whose age is unknown cannot be shown safely.
 */
export type IssuedChannelInput = ChannelInput & { readonly issuedAt: string }

/** What the runtime hands a transport at `start`. The transport's only way back in. */
export interface ChannelHost {
    /**
     * Hand a received message to the runtime. Never throws and never rejects.
     *
     * Fire-and-forget on purpose: a transport's read loop must not be able to stall behind turn
     * execution, and a long-poll that awaited each turn would stop reading updates for the duration
     * of one. Failures surface as events, not as a rejected promise the poll loop has to handle.
     */
    receive(message: RawInbound): void
    /**
     * Report a connection state change. Reaches `agent.channel.status`.
     *
     * Two signatures rather than one optional argument: `needs_input` with nothing for a person to
     * act on is a state no client can render, so it is a *compile* error here. A plugin written in
     * JavaScript reaches the same refusal at runtime, where the hub keeps the previous state and
     * reports `channel_input_missing` — a status nobody can act on must not displace one they can.
     */
    status(status: Exclude<ChannelStatus, "needs_input">, detail?: string): void
    status(status: "needs_input", detail: string | undefined, input: ChannelInput): void
    /**
     * Report a failure that did not stop the channel.
     *
     * A channel failing to connect never blocks `runtime.ready` — it says so here and keeps
     * retrying. A runtime that refuses to boot because Telegram is down is a runtime that cannot
     * serve its HTTP API during a Telegram outage.
     */
    error(detail: ErrorDetail): void
}

export interface ChannelTransport {
    /** Unique within an agent. Becomes the channel segment of every session key it produces. */
    readonly id: string
    /** Registered type name: `telegram`, `whatsapp`. */
    readonly type: string
    readonly limits: ChannelLimits
    /**
     * Begin receiving. Must return once the transport is *running*, not once it is connected.
     *
     * The distinction is the whole reason channel failures do not block readiness: a long-poll that
     * awaited its first successful poll would make a bad token an unbootable runtime.
     */
    start(host: ChannelHost): Promise<void>
    stop(): Promise<void>
    send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult>
    /**
     * Show a "typing" indicator, if the provider has one. Optional, and never awaited by the caller.
     *
     * Fire-and-forget because it is cosmetic and the turn must not wait on it — nor fail with it.
     * Telegram's indicator expires after about five seconds, so the hub re-sends it on a timer while
     * a turn runs; a provider without one simply does not implement this.
     */
    typing?(recipient: string, thread?: string): Promise<void>
    /**
     * Handle one webhook delivery. Present only on transports with a webhook mode.
     *
     * **Verifying the request is the transport's job**, because only it knows what the provider
     * signs and how. Core does what is common to all of them and nothing more: it caps the body
     * size and routes by channel id, so a plugin never has to defend against a 500 MB POST. A
     * transport that cannot verify a delivery returns 401 and receives nothing — the messages
     * inside an unverified body are exactly the ones an attacker chose.
     */
    webhook?(delivery: WebhookDelivery): Promise<WebhookOutcome>
    /**
     * Forget any stored pairing and start over. Optional, because most channels have none.
     *
     * A **credential a person pasted** — Telegram's bot token — is edited where it lives, in the
     * `.env` beside the manifest, and this method has nothing to do with it. What it is for is a
     * credential the *channel itself* obtained: WhatsApp's linked-device session, which exists only
     * because somebody scanned a QR and which no `.env` can express.
     *
     * The only way to relink such a channel to a different phone was finding its directory and
     * deleting it by hand — a filesystem operation nobody should have to discover, and exactly the
     * shape this project keeps finding, where the remedy exists and is reachable from no surface.
     *
     * Implementations must be safe to call while running and while stopped, and must leave the
     * channel in the state a first start produces: no session, and pairing offered again.
     */
    reset?(): Promise<void>
    /**
     * Senders this transport vouches for, admitted whether or not `allowFrom` names them.
     *
     * One case, and it is the account owner: a WhatsApp channel paired to a number *is* that
     * number, and the person who typed the pairing code is the first person who will talk to
     * it — in the chat with themselves. Measured: a freshly paired agent refused its own owner
     * with *"has no allowFrom, which permits nobody"* until they edited the manifest and
     * restarted. OpenClaw admits the linked number regardless of `allowFrom` for the same reason.
     *
     * Merged into the gate by core rather than checked by the transport, so there is still one
     * place that decides who gets in — and so `allowFrom` keeps meaning "who else".
     */
    readonly alwaysAllow?: readonly string[]
}

export interface WebhookDelivery {
    /** Parsed JSON, or the raw string when the body was not JSON. */
    readonly body: unknown
    /** Lowercased header names. Providers disagree about case and none of them should have to care. */
    readonly headers: Readonly<Record<string, string>>
}

export interface WebhookOutcome {
    /** What to answer the provider. 200 for accepted; 401 for a delivery that failed verification. */
    readonly status: number
    /** Optional plain-text body. Telegram ignores it; a human debugging with `curl` does not. */
    readonly detail?: string
}

/**
 * A transport plus the configuration core applies around it.
 *
 * `allowFrom` lives here rather than on the transport because it is enforced in `inbox.ts`, before
 * a transport-supplied message becomes a turn. A channel that policed its own allowlist would be a
 * channel that could get it wrong privately.
 */
export interface ChannelBinding {
    readonly transport: ChannelTransport
    /** Inbound allowlist. Absent or `["*"]` permits anyone. **Inbound only.** */
    readonly allowFrom?: readonly string[]
    readonly enabled: boolean
    /**
     * Why this channel could not be built, when it could not be.
     *
     * Present means `transport` is `brokenTransport`'s placeholder and this channel will never
     * receive or send. It is a *binding* rather than an omission so that every surface already
     * reading `statusOf` reports it — the `serve` banner, `GET /v1/agents/:id`, `/status` and the
     * web panel — because a channel that is silently absent is the failure this replaced.
     */
    readonly broken?: ErrorDetail
}

/**
 * Stands in for a channel that could not be constructed, so one missing credential cannot stop an
 * agent from starting.
 *
 * A channel is **optional**: nothing about taking a turn depends on one. `init --telegram connected`
 * generated a manifest whose factory threw `telegram_token_missing` at load, so a token nobody had
 * pasted yet made `run`, `serve` *and* `validate` all refuse — the wizard produced an agent that
 * could not start and printed nine next steps under it. The same shape as a skill whose size failed
 * the load, where the command that undid it sat behind the load it broke.
 *
 * It is a placeholder rather than a dropped entry for three reasons. `statusOf` reports it, so every
 * existing surface says which channel is broken and why with nothing new to remember. The outbox
 * keeps a transport for that channel id, so a delivery already queued for it fails **permanently and
 * visibly** instead of sitting in a queue nothing can drain. And `id`/`type` are the entry's, so a
 * reader sees the channel the manifest declares rather than a gap where it was.
 *
 * `retryable: false` is the point of the send arm: this cannot be fixed by trying again, only by
 * fixing the manifest or the environment and restarting.
 */
export function brokenTransport(id: string, type: string, detail: ErrorDetail): ChannelTransport {
    return {
        id,
        type,
        limits: { maxMessageChars: 4096, idempotentSend: false },
        // Reported again on start, because a warning read at boot has usually scrolled away by the
        // time somebody wonders why the bot is quiet.
        async start(host: ChannelHost): Promise<void> {
            host.status("error", detail.message)
            host.error(detail)
        },
        async stop(): Promise<void> {},
        async send(): Promise<SendResult> {
            return { ok: false, retryable: false, error: detail }
        },
    }
}
