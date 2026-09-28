/**
 * The Telegram `ChannelTransport`: long-poll or webhook in, `sendMessage` out.
 *
 * Two modes, one code path for everything after an update arrives. `#ingest` is where a
 * `TelegramUpdate` becomes a `RawInbound`, and both modes go through it — so an agent behaves
 * identically whichever way it is deployed, which is the only reason having two modes is
 * defensible.
 *
 * **Long-poll's read loop must never stop on its own.** A poll that throws and exits leaves a bot
 * that is running, reports no error, and silently receives nothing forever. So the loop catches
 * everything, reports through the host, backs off, and continues — the only thing that ends it is
 * `stop()`.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type {
    ChannelHost,
    ChannelLimits,
    ChannelTransport,
    OutboundMessage,
    RawInbound,
    SendResult,
    WebhookDelivery,
    WebhookOutcome,
} from "@dispach/core"
import { TelegramApi, TelegramApiError, type TelegramMessage, type TelegramUpdate } from "./api.ts"

/** Telegram's own cap, in UTF-16 code units — the unit `String.length` counts in. */
const MAX_MESSAGE_CHARS = 4096

/**
 * Long-poll hold time, in seconds.
 *
 * 30 rather than Telegram's 50 maximum: a shutdown waits for the in-flight poll to return, and the
 * request is aborted on stop, but a proxy that swallows the abort turns the hold time into the
 * shutdown time. 30 s bounds that without making the poll chatty.
 */
const POLL_TIMEOUT_S = 30

/** After a failed poll. Capped, because a bot that stops asking is a bot that never recovers. */
const POLL_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const

/**
 * Telegram sends messages one at a time per chat and rate-limits at roughly one per second.
 *
 * Pacing chunks here costs a few hundred milliseconds on a long reply and avoids a 429 that would
 * cost a full backoff cycle — and, worse, would arrive out of order relative to the chunk after it.
 */
const MIN_SEND_INTERVAL_MS = 350

export type TelegramMode = "longpoll" | "webhook"

export interface TelegramTransportOptions {
    readonly id: string
    readonly token: string
    readonly mode: TelegramMode
    /**
     * Public URL Telegram should POST to. Required in webhook mode.
     *
     * Registered with `setWebhook` at start. Telegram requires HTTPS and will not deliver to a
     * plain-HTTP URL, which is why a misconfigured webhook shows up as silence rather than an error.
     */
    readonly webhookUrl?: string
    /** Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. */
    readonly secretToken?: string
    readonly api?: TelegramApi
}

export class TelegramTransport implements ChannelTransport {
    readonly id: string
    readonly type = "telegram"
    readonly limits: ChannelLimits = {
        maxMessageChars: MAX_MESSAGE_CHARS,
        // Telegram's sendMessage takes no client-supplied idempotency key. Declaring true here
        // would convert the outbox's visible `uncertain` flag into a silent duplicate.
        idempotentSend: false,
        minSendIntervalMs: MIN_SEND_INTERVAL_MS,
        attachments: true,
    }

    readonly #api: TelegramApi
    readonly #mode: TelegramMode
    readonly #webhookUrl: string | undefined
    readonly #secretToken: string | undefined

    #host: ChannelHost | undefined
    #offset = 0
    #running = false
    #abort: AbortController | undefined
    #loop: Promise<void> | undefined

    constructor(options: TelegramTransportOptions) {
        this.id = options.id
        this.#api = options.api ?? new TelegramApi({ token: options.token })
        this.#mode = options.mode
        this.#webhookUrl = options.webhookUrl
        this.#secretToken = options.secretToken
    }

    /**
     * Begin receiving. Returns once *running*, not once connected.
     *
     * The distinction is decision 8.9's neighbour and just as load-bearing: awaiting a first
     * successful poll would make a Telegram outage an unbootable runtime, and an orchestrator
     * watching `/v1/ready` would restart the process into the same outage.
     */
    async start(host: ChannelHost): Promise<void> {
        if (this.#running) return
        this.#running = true
        this.#host = host
        this.#abort = new AbortController()

        if (this.#mode === "webhook") {
            const url = this.#webhookUrl
            if (url === undefined || url === "") {
                host.status("error", "no webhookUrl")
                host.error({
                    code: "telegram_webhook_url_missing",
                    message: `Channel "${this.id}" is in webhook mode but declares no webhookUrl.`,
                    hint: "Set webhookUrl to the public HTTPS address this runtime is reachable at, ending in /v1/channels/<channelId>/webhook/<agentId>. Telegram will not deliver to plain HTTP, and a missing registration looks identical to a bot nobody is messaging.",
                    field: `channels[${this.id}].webhookUrl`,
                })
                return
            }
            // Registration is one call and it is awaited: unlike a poll, its failure is
            // actionable immediately and silently skipping it produces a bot that never receives.
            try {
                await this.#api.setWebhook({
                    url,
                    ...(this.#secretToken === undefined ? {} : { secretToken: this.#secretToken }),
                })
                host.status("connected", `webhook at ${url}`)
            } catch (cause) {
                host.status("error", cause instanceof Error ? cause.message : String(cause))
                host.error(detailOf(cause, `registering the webhook for channel "${this.id}"`))
            }
            return
        }

        // Long-poll. A webhook left over from a previous deployment silently steals every update,
        // so it is cleared before polling — Telegram allows only one delivery method at a time.
        this.#loop = this.#poll(host, this.#abort.signal)
    }

    async stop(): Promise<void> {
        if (!this.#running) return
        this.#running = false
        this.#abort?.abort()
        // Awaited so a shutdown does not race the loop's own catch into a closed store.
        await this.#loop?.catch(() => {})
        this.#loop = undefined
        this.#host?.status("disconnected")
        this.#host = undefined
    }

    async send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult> {
        const threadId = threadIdOf(message.thread)
        try {
            const attachment = message.attachment
            const sent =
                attachment === undefined
                    ? await this.#api.sendMessage(
                          {
                              chatId: message.recipient,
                              text: message.text,
                              ...(threadId === undefined ? {} : { threadId }),
                          },
                          signal,
                      )
                    : await this.#api.sendPhoto(
                          {
                              chatId: message.recipient,
                              photo: new Blob([await readFile(attachment.path)], {
                                  type: attachment.mimeType,
                              }),
                              filename: basename(attachment.path),
                              caption: message.text,
                              ...(threadId === undefined ? {} : { threadId }),
                          },
                          signal,
                      )
            return { ok: true, providerMessageId: String(sent.message_id) }
        } catch (cause) {
            if (cause instanceof TelegramApiError) {
                return {
                    ok: false,
                    retryable: cause.retryable,
                    error: cause.detail,
                    ...(cause.retryAfterMs === undefined
                        ? {}
                        : { retryAfterMs: cause.retryAfterMs }),
                }
            }
            return {
                ok: false,
                retryable: true,
                error: {
                    code: "telegram_send_failed",
                    message: cause instanceof Error ? cause.message : String(cause),
                    hint: "An unclassified failure from the Telegram transport. Retried, because a failure nobody recognised is not a failure known to be permanent.",
                },
            }
        }
    }

    async typing(recipient: string, thread?: string): Promise<void> {
        const threadId = threadIdOf(thread)
        await this.#api.sendChatAction({
            chatId: recipient,
            ...(threadId === undefined ? {} : { threadId }),
        })
    }

    /**
     * One webhook delivery.
     *
     * The secret is compared in constant time. A plain `!==` on a short shared secret is a timing
     * oracle in principle; the cost of not having to reason about whether it is exploitable here is
     * four lines.
     */
    async webhook(delivery: WebhookDelivery): Promise<WebhookOutcome> {
        if (this.#secretToken !== undefined) {
            const presented = delivery.headers["x-telegram-bot-api-secret-token"] ?? ""
            if (!timingSafeEqual(presented, this.#secretToken)) {
                return { status: 401, detail: "bad secret token" }
            }
        }

        const host = this.#host
        if (host === undefined) return { status: 503, detail: "channel not started" }

        const update = delivery.body as TelegramUpdate | undefined
        if (update === undefined || typeof update !== "object") {
            return { status: 400, detail: "not an update" }
        }

        this.#ingest(host, update)
        // 200 immediately, before the turn runs. Telegram retries any non-2xx, and a webhook that
        // waited for generation would be retried mid-turn and deliver the same message again.
        return { status: 200 }
    }

    async #poll(host: ChannelHost, signal: AbortSignal): Promise<void> {
        let failures = 0
        // Announced once, not once per cycle. The first version keyed this on `offset === 0`,
        // which stays true until the first message ever arrives — so an idle bot reported
        // "connected — long-poll" every 30 seconds forever, and a status line repeating on a
        // timer is one a reader learns to ignore, including when it changes.
        let announced = false

        try {
            await this.#api.deleteWebhook(signal)
        } catch {
            // Best effort. A token that cannot delete a webhook cannot poll either, and the poll
            // below will say so with a better message than this call could.
        }

        // `getMe` before the first poll, and this is not decoration. A long-poll *holds* for 30
        // seconds, so reporting "connected" from its first return meant a correctly configured bot
        // sat silent for half a minute after start with no way to tell it apart from a broken one.
        // This is one fast call, it names the bot so you know which one to message, and it is
        // inside the detached loop rather than in `start()` — so a Telegram outage still cannot
        // delay boot.
        try {
            const me = await this.#api.getMe(signal)
            announced = true
            host.status(
                "connected",
                me.username === undefined ? "long-poll" : `@${me.username}, long-poll`,
            )
        } catch (cause) {
            if (signal.aborted) return
            // Not fatal and not announced as connected: the poll below retries and reports with
            // the same backoff as any other failure. A 401 here is the fast path to the real news.
            host.status("error", cause instanceof Error ? cause.message : String(cause))
            host.error(detailOf(cause, `checking the bot token for channel "${this.id}"`))
        }

        while (this.#running && !signal.aborted) {
            try {
                const updates = await this.#api.getUpdates(
                    { offset: this.#offset, timeout: POLL_TIMEOUT_S },
                    signal,
                )
                if (failures > 0) {
                    failures = 0
                    announced = true
                    host.status("connected", "polling resumed")
                } else if (!announced) {
                    announced = true
                    host.status("connected", "long-poll")
                }

                for (const update of updates) {
                    // Advanced before handling, and *unconditionally*: an update that throws on
                    // the way to a turn must not be re-fetched forever. The outbox is where
                    // durability lives; the poll offset is a cursor, not a queue.
                    this.#offset = Math.max(this.#offset, update.update_id + 1)
                    this.#ingest(host, update)
                }
            } catch (cause) {
                if (signal.aborted) return
                const delay =
                    POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length - 1)] ?? 1000
                failures += 1
                // Reported on the first failure and then every eighth, so a long outage leaves a
                // trail without burying every other event in the stream.
                if (failures === 1 || failures % 8 === 0) {
                    host.status("error", cause instanceof Error ? cause.message : String(cause))
                    host.error(detailOf(cause, `polling channel "${this.id}"`))
                }
                await sleep(delay, signal)
            }
        }
    }

    /** `TelegramUpdate` → `RawInbound`, or nothing. The one place both modes converge. */
    #ingest(host: ChannelHost, update: TelegramUpdate): void {
        const message = update.message
        if (message === undefined) return

        // `caption` covers a photo or document sent with text. A media message with no caption
        // produces nothing — answering "" would be a turn with no input — unless it is a voice note,
        // which the runtime transcribes into one.
        const text = message.text ?? message.caption ?? ""
        const heard = message.voice ?? message.audio
        if (text.trim() === "" && heard === undefined) return
        if (message.from?.is_bot === true) return

        const raw = toInbound(message, text)
        if (heard === undefined) {
            host.receive(raw)
            return
        }
        host.receive({
            ...raw,
            audio: {
                // A voice note is OGG/Opus whether or not Telegram says so.
                mimeType: heard.mime_type ?? "audio/ogg",
                ...(heard.duration === undefined ? {} : { durationS: heard.duration }),
                ...(heard.file_size === undefined ? {} : { sizeBytes: heard.file_size }),
                fetch: async (signal) => {
                    const file = await this.#api.getFile(heard.file_id, signal)
                    if (file.file_path === undefined) {
                        throw new Error("Telegram returned no file path for the voice note")
                    }
                    return this.#api.download(file.file_path, signal)
                },
            },
        })
    }
}

/** Exported for the transport test, which asserts on the mapping rather than on a live bot. */
export function toInbound(message: TelegramMessage, text: string): RawInbound {
    const username = message.from?.username
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ")
    return {
        // Unique per chat, not globally — which is why it is combined with the chat id. Telegram
        // reuses message_id across chats, and a bare id would make two people's first messages
        // look like one replayed update.
        providerMessageId: `${message.chat.id}:${message.message_id}`,
        peerId: String(message.chat.id),
        ...(message.from === undefined ? {} : { senderId: String(message.from.id) }),
        ...(username === undefined ? {} : { senderHandle: `@${username}` }),
        ...(name === "" ? {} : { senderName: name }),
        ...(message.message_thread_id === undefined
            ? {}
            : { thread: String(message.message_thread_id) }),
        text,
        receivedAt: new Date(message.date * 1000).toISOString(),
    }
}

/** Session keys carry the thread as a string; Telegram wants the number back. */
function threadIdOf(thread: string | undefined): number | undefined {
    if (thread === undefined) return undefined
    const parsed = Number.parseInt(thread, 10)
    return Number.isFinite(parsed) ? parsed : undefined
}

function detailOf(cause: unknown, context: string) {
    if (cause instanceof TelegramApiError) return cause.detail
    return {
        code: "telegram_channel_error",
        message: `${context} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: "The channel keeps retrying and the rest of the runtime is unaffected. If this repeats, check network access to api.telegram.org and the token named by tokenEnv.",
    }
}

/** Length is compared first and separately — it is not secret, and it bounds the loop. */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                resolve()
            },
            { once: true },
        )
    })
}
