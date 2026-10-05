/**
 * Outbound webhooks: an embedder's backend hears about a turn, an approval or a failed delivery
 * without holding an SSE stream open per agent.
 *
 * ## Three decisions, each with its reason
 *
 * **Standard Webhooks, not a scheme of our own.** `webhook-id`, `webhook-timestamp` and
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, with a `whsec_` secret. A
 * receiver verifies with a library that already exists in its language instead of reimplementing
 * ours, and a signature scheme somebody reimplements is one somebody gets wrong.
 *
 * **The id is derived, never generated.** `webhook-id` is a hash of the subscription and the event
 * envelope, so a retry and a resend after a crash carry the same id and a receiver's dedupe works,
 * and an enqueue that ran twice collides on `UNIQUE (subscription_id, message_id)` instead of
 * sending twice. That is the outbox's `deliveryKey` rule, applied here.
 *
 * **A private receiver is the operator's call; a link-local one is nobody's.** `web_fetch` refuses
 * every private address because the *model* chooses its URL. A webhook URL is chosen by an admin,
 * and for a self-hosted embedder the receiver is normally on a private network: a backend on the
 * same Docker network is `172.x`. So private, loopback and CGNAT addresses are refused **unless the
 * operator lists them** (in the environment, never over the API), and link-local, which is where
 * the cloud metadata endpoint lives, is refused whatever is listed. Every address DNS returns is
 * checked, at subscribe and again at every send, and one that cannot be resolved fails closed.
 *
 * DNS rebinding is not covered, as with `web_fetch`: the check and the connection are separate
 * resolutions, and pinning the checked address into `fetch` is not expressible.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { lookup as dnsLookup } from "node:dns/promises"
import { HarnessError } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { AnyEvent } from "../events/types.ts"
import type { FetchLike } from "../model/provider.ts"
import { classifyAddress, parseIPv4, parseIPv6 } from "../net/address.ts"
import type {
    WebhookDeliveryRecord,
    WebhookScope,
    WebhookStore,
    WebhookSubscription,
} from "../store/store.ts"

// ─── signing ─────────────────────────────────────────────────────────────────────────────

/** A new signing secret, in the Standard Webhooks `whsec_<base64>` form. */
export function newWebhookSecret(): string {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return `whsec_${Buffer.from(bytes).toString("base64")}`
}

function keyOf(secret: string): Buffer {
    return Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64")
}

/** The `webhook-signature` header value for one delivery attempt. `timestamp` is Unix seconds. */
export function signWebhook(input: {
    readonly secret: string
    readonly id: string
    readonly timestamp: number
    readonly body: string
}): string {
    const mac = createHmac("sha256", keyOf(input.secret))
        .update(`${input.id}.${input.timestamp}.${input.body}`)
        .digest("base64")
    return `v1,${mac}`
}

/**
 * Check a delivery the way a receiver should: every `v1,` signature in the header, compared in
 * constant time, and a timestamp within `toleranceSec` of now. Exported so a receiver written in
 * TypeScript has the reference implementation, and so the tests check the scheme they document.
 */
export function verifyWebhook(input: {
    readonly secret: string
    readonly id: string
    readonly timestamp: number
    readonly body: string
    readonly signature: string
    readonly nowSec?: number
    readonly toleranceSec?: number
}): boolean {
    const now = input.nowSec ?? Math.floor(Date.now() / 1000)
    if (Math.abs(now - input.timestamp) > (input.toleranceSec ?? 300)) return false
    const expected = Buffer.from(signWebhook(input).slice(3), "base64")
    return input.signature.split(" ").some((part) => {
        if (!part.startsWith("v1,")) return false
        const given = Buffer.from(part.slice(3), "base64")
        return given.length === expected.length && timingSafeEqual(given, expected)
    })
}

/** The `webhook-id` for an event and a subscription. Stable, so a resend is recognisably a resend. */
export function webhookMessageId(subscriptionId: string, body: string): string {
    return `msg_${createHash("sha256").update(`${subscriptionId}\n${body}`).digest("hex").slice(0, 32)}`
}

// ─── the target ───────────────────────────────────────────────────────────────────────────

export type LookupLike = (host: string) => Promise<readonly { readonly address: string }[]>

const defaultLookup: LookupLike = async (host) => dnsLookup(host, { all: true, verbatim: true })

/**
 * What the operator has allowed besides the public internet: hostnames and CIDR ranges.
 *
 * Read from the environment by the runtime, never from a request: an admin credential decides
 * *which* URL, the operator decides *which networks*. The same line that keeps `writeRoots` off the
 * agent's `config_set`.
 */
export interface WebhookAllowlist {
    readonly hosts: ReadonlySet<string>
    readonly ranges: readonly { readonly bytes: readonly number[]; readonly bits: number }[]
}

export const EMPTY_ALLOWLIST: WebhookAllowlist = { hosts: new Set(), ranges: [] }

/** Parse `velacrew-api, 172.16.0.0/12, fd00::/8`. Throws naming the entry it cannot read. */
export function parseWebhookAllowlist(raw: string | undefined, source: string): WebhookAllowlist {
    if (raw === undefined || raw.trim() === "") return EMPTY_ALLOWLIST
    const hosts = new Set<string>()
    const ranges: { bytes: readonly number[]; bits: number }[] = []
    for (const entry of raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")) {
        const [address, bitsText] = entry.split("/")
        const bytes = parseIPv4(address ?? "") ?? parseIPv6(address ?? "")
        if (bitsText === undefined && bytes === undefined) {
            hosts.add(entry.toLowerCase())
            continue
        }
        const bits = bitsText === undefined ? (bytes?.length ?? 0) * 8 : Number(bitsText)
        if (bytes === undefined || !Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) {
            throw new HarnessError({
                code: "webhook_allowlist_invalid",
                message: `${source} has an entry that is neither a hostname nor an address range: "${entry}".`,
                hint: "List hostnames and CIDR ranges, comma-separated: velacrew-api, 172.16.0.0/12, fd00::/8. A link-local range is refused whatever this says.",
                field: source,
            })
        }
        ranges.push({ bytes, bits })
    }
    return { hosts, ranges }
}

function inRange(bytes: readonly number[], range: WebhookAllowlist["ranges"][number]): boolean {
    if (bytes.length !== range.bytes.length) return false
    for (let bit = 0; bit < range.bits; bit += 1) {
        const byte = Math.floor(bit / 8)
        const mask = 0x80 >> (bit % 8)
        if (((bytes[byte] ?? 0) & mask) !== ((range.bytes[byte] ?? 0) & mask)) return false
    }
    return true
}

/** Kinds never reachable, allowlisted or not. Link-local is where the metadata endpoint lives. */
const NEVER = new Set(["link-local", "unspecified", "multicast"])

/**
 * Refuse a URL a webhook must not be sent to. Resolves the host and checks **every** answer.
 *
 * Throws with a code and a hint; returns nothing on success. Called at subscribe and before every
 * send, because DNS can change between the two.
 */
export async function checkWebhookTarget(
    raw: string,
    options: { readonly allow: WebhookAllowlist; readonly lookup?: LookupLike },
): Promise<void> {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        throw new HarnessError({
            code: "webhook_url_invalid",
            message: `"${raw}" is not a URL.`,
            hint: "Send an absolute http:// or https:// URL, such as https://api.example.com/hooks/dispatch.",
            field: "url",
        })
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new HarnessError({
            code: "webhook_url_invalid",
            message: `"${raw}" is not an http or https URL.`,
            hint: "Webhooks are delivered as an HTTP POST, so the URL must start with https:// (or http:// on a private network the operator has allowed).",
            field: "url",
        })
    }
    if (url.username !== "" || url.password !== "") {
        throw new HarnessError({
            code: "webhook_url_invalid",
            message: "The URL carries credentials.",
            hint: "A password in a URL lands in every log that prints it. Verify deliveries with the signature instead; that is what the secret is for.",
            field: "url",
        })
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    let answers: readonly { readonly address: string }[]
    try {
        answers = await (options.lookup ?? defaultLookup)(host)
    } catch {
        // A lookup that throws and one that returns nothing are the same fact: nothing to check.
        answers = []
    }
    if (answers.length === 0) {
        throw new HarnessError({
            code: "webhook_target_unresolved",
            message: `${host} does not resolve from this server.`,
            hint: "Every address a name resolves to is checked before anything is sent, so a name that does not resolve cannot be checked and is refused. Check the spelling, or that this server can reach your DNS.",
            field: "url",
        })
    }
    for (const { address } of answers) {
        const verdict = classifyAddress(address)
        if (verdict === undefined) {
            throw refused(host, address, "an address this server cannot classify")
        }
        if (verdict.kind === "public") continue
        if (NEVER.has(verdict.kind)) {
            throw refused(
                host,
                address,
                `${verdict.kind} (${verdict.range ?? "reserved"}), which is never allowed`,
            )
        }
        const bytes = parseIPv4(address) ?? parseIPv6(address)
        const listed =
            options.allow.hosts.has(host) ||
            (bytes !== undefined && options.allow.ranges.some((range) => inRange(bytes, range)))
        if (!listed) {
            throw refused(
                host,
                address,
                `${verdict.kind} (${verdict.range ?? ""}), which the operator has not allowed`,
            )
        }
    }
}

function refused(host: string, address: string, why: string): HarnessError {
    return new HarnessError({
        code: "webhook_target_refused",
        message: `${host} resolves to ${address}: ${why}.`,
        hint: "Webhooks go to the public internet by default. An operator allows a private receiver (a backend on the same network, say) by listing its hostname or range in the server's WEBHOOK_ALLOW environment variable. Link-local addresses, where cloud metadata lives, are refused regardless.",
        field: "url",
    })
}

// ─── who hears what ───────────────────────────────────────────────────────────────────────

/**
 * Whether an event type can be subscribed to. Per-token chunks cannot: one per token is a request
 * per token, which is a denial of service against the receiver. `webhook.*` would not exist to be
 * fed back, and does not.
 */
export function webhookDeliverable(type: string): boolean {
    return type !== "model.chunk"
}

/** Whether a subscription hears this event: its types, and its creator's reach. */
export function webhookHears(subscription: WebhookSubscription, event: AnyEvent): boolean {
    if (event.agentId === undefined || !subscription.types.includes(event.type)) return false
    return inScope(subscription.scope, event)
}

function inScope(scope: WebhookScope | undefined, event: AnyEvent): boolean {
    if (scope?.agents !== undefined && !scope.agents.includes(event.agentId ?? "")) return false
    if (scope?.sessionPrefix !== undefined) {
        return (event.sessionKey ?? "").startsWith(scope.sessionPrefix)
    }
    return true
}

// ─── the dispatcher ───────────────────────────────────────────────────────────────────────

/** 30 s, 2 min, 10 min, 1 h, 6 h, then give up: a day of trying, and never forever. */
const DEFAULT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 3_600_000, 21_600_000]
const DEFAULT_POLL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 15_000
const BATCH = 16

export interface WebhookDispatcherOptions {
    readonly store: WebhookStore
    readonly bus: EventBus
    readonly fetch: FetchLike
    readonly allow: WebhookAllowlist
    /**
     * The agents whose deliveries this process sends. The ones it hosts: a delivery row for an agent
     * another process holds is that process's to send, or two senders deliver it twice.
     */
    readonly agents: () => readonly string[]
    readonly lookup?: LookupLike
    readonly now?: () => number
    readonly backoffMs?: readonly number[]
    readonly pollIntervalMs?: number
    readonly timeoutMs?: number
    readonly userAgent: string
}

export class WebhookDispatcher {
    readonly #options: WebhookDispatcherOptions
    readonly #backoff: readonly number[]
    readonly #now: () => number
    #subscriptions: readonly WebhookSubscription[] = []
    #unsubscribe: (() => void) | undefined
    #timer: ReturnType<typeof setInterval> | undefined
    #draining = false

    constructor(options: WebhookDispatcherOptions) {
        this.#options = options
        this.#backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
        this.#now = options.now ?? (() => Date.now())
    }

    /**
     * Listen, and load the subscriptions. No network: enqueueing is a row. Sending starts at
     * `start()`, which the runtime calls after `runtime.ready`.
     */
    async attach(): Promise<void> {
        await this.changed()
        this.#unsubscribe ??= this.#options.bus.on("*", (event) => this.#enqueue(event))
    }

    /**
     * Refuse a URL this dispatcher would refuse to send to, with the same allowlist. For the route
     * that creates a subscription, so the answer at subscribe and the answer at send cannot differ.
     */
    check(url: string): Promise<void> {
        return checkWebhookTarget(url, {
            allow: this.#options.allow,
            ...(this.#options.lookup === undefined ? {} : { lookup: this.#options.lookup }),
        })
    }

    /** Re-read the subscriptions. Called by whoever created or deleted one. */
    async changed(): Promise<void> {
        this.#subscriptions = await this.#options.store.list()
    }

    /** Recover what a dead process left in flight, then drain on a timer. After `runtime.ready`. */
    async start(): Promise<readonly WebhookDeliveryRecord[]> {
        const recovered = await this.#options.store.recoverInflight(
            this.#options.agents(),
            this.#iso(),
        )
        if (this.#timer === undefined) {
            this.#timer = setInterval(() => {
                if (this.#draining) return
                this.#draining = true
                void this.drain().finally(() => {
                    this.#draining = false
                })
            }, this.#options.pollIntervalMs ?? DEFAULT_POLL_MS)
            // A pending delivery is not a reason for a CLI to refuse to exit.
            this.#timer.unref?.()
        }
        return recovered
    }

    stop(): void {
        this.#unsubscribe?.()
        this.#unsubscribe = undefined
        if (this.#timer !== undefined) clearInterval(this.#timer)
        this.#timer = undefined
    }

    /** Send everything due once. Returns how many were attempted. */
    async drain(): Promise<number> {
        const due = await this.#options.store.claimDue(this.#options.agents(), this.#iso(), BATCH)
        await Promise.all(due.map((row) => this.#attempt(row)))
        return due.length
    }

    #enqueue(event: AnyEvent): void {
        if (!webhookDeliverable(event.type) || event.agentId === undefined) return
        const agentId = event.agentId
        let body: string | undefined
        for (const subscription of this.#subscriptions) {
            if (!webhookHears(subscription, event)) continue
            body ??= JSON.stringify(event)
            const text = body
            void this.#options.store
                .enqueue({
                    subscriptionId: subscription.subscriptionId,
                    messageId: webhookMessageId(subscription.subscriptionId, text),
                    agentId,
                    eventType: event.type,
                    body: text,
                    at: this.#iso(),
                })
                .catch((error: unknown) => this.#warn(agentId, error))
        }
    }

    async #attempt(row: WebhookDeliveryRecord): Promise<void> {
        const store = this.#options.store
        const at = this.#iso()
        const subscription = this.#subscriptions.find(
            (s) => s.subscriptionId === row.subscriptionId,
        )
        const secret = await store.secretOf(row.subscriptionId)
        if (subscription === undefined || secret === undefined) {
            await store.markFailed(row.subscriptionId, row.messageId, "subscription deleted", at)
            return
        }
        try {
            await checkWebhookTarget(subscription.url, {
                allow: this.#options.allow,
                ...(this.#options.lookup === undefined ? {} : { lookup: this.#options.lookup }),
            })
        } catch (error) {
            // Permanent, and not retried: a URL that now resolves somewhere refused stays refused,
            // and retrying a refusal is how a checker becomes a scanner on a timer.
            await store.markFailed(row.subscriptionId, row.messageId, messageOf(error), at)
            return
        }
        const timestamp = Math.floor(this.#now() / 1000)
        const controller = new AbortController()
        const timer = setTimeout(
            () => controller.abort(),
            this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        let failure: string | undefined
        let permanent = false
        try {
            const response = await this.#options.fetch(subscription.url, {
                method: "POST",
                redirect: "manual",
                signal: controller.signal,
                headers: {
                    "content-type": "application/json",
                    "user-agent": this.#options.userAgent,
                    "webhook-id": row.messageId,
                    "webhook-timestamp": String(timestamp),
                    "webhook-signature": signWebhook({
                        secret,
                        id: row.messageId,
                        timestamp,
                        body: row.body,
                    }),
                },
                body: row.body,
            })
            await response.body?.cancel()
            if (response.status >= 200 && response.status < 300) {
                await store.markSent(row.subscriptionId, row.messageId, this.#iso())
                return
            }
            failure = `HTTP ${response.status}`
            // 410 Gone is a receiver saying stop; a redirect is not followed, because following one
            // would send the signed body to an address nobody checked.
            permanent = response.status === 410 || (response.status >= 300 && response.status < 400)
        } catch (error) {
            failure = messageOf(error)
        } finally {
            clearTimeout(timer)
        }
        if (permanent || row.attempts > this.#backoff.length) {
            await store.markFailed(row.subscriptionId, row.messageId, failure, this.#iso())
            return
        }
        const delay = this.#backoff[Math.max(0, row.attempts - 1)] ?? this.#backoff.at(-1) ?? 0
        await store.markRetry(
            row.subscriptionId,
            row.messageId,
            new Date(this.#now() + delay).toISOString(),
            failure,
            this.#iso(),
        )
    }

    #warn(agentId: string, error: unknown): void {
        this.#options.bus.emit(
            "agent.warning",
            {
                code: "webhook_enqueue_failed",
                message: `Queueing a webhook delivery failed: ${messageOf(error)}`,
                hint: "The event happened and is on the event stream; this one delivery is missing. A store that cannot be written is usually full or read-only.",
            },
            { agentId },
        )
    }

    #iso(): string {
        return new Date(this.#now()).toISOString()
    }
}

function messageOf(error: unknown): string {
    if (error instanceof HarnessError) return `${error.code}: ${error.message}`
    return error instanceof Error ? error.message : String(error)
}
