/**
 * The Telegram Bot API, over `fetch`, with no client library.
 *
 * Decision 8.2: the Bot API is small, stable, and entirely JSON-over-POST. A library would add a
 * dependency, a release cadence, and an opinion about retries — and this runtime already has an
 * opinion about retries that lives in the outbox.
 *
 * The part worth reading is `classify`. Every failure a send can produce has to be sorted into
 * "try again" or "never", because the outbox asks the transport that question and only the
 * transport knows Telegram's taxonomy. Getting it wrong toward retry costs a few pointless attempts;
 * getting it wrong toward permanent silently abandons a reply that would have gone through.
 */

import type { ErrorDetail } from "@dispach/core"

/** Telegram's envelope. `ok: false` carries a human string and sometimes a `parameters` block. */
export interface TelegramResponse<T> {
    readonly ok: boolean
    readonly result?: T
    readonly error_code?: number
    readonly description?: string
    readonly parameters?: {
        readonly retry_after?: number
        readonly migrate_to_chat_id?: number
    }
}

export interface TelegramChat {
    readonly id: number
    readonly type: string
    readonly title?: string
    readonly username?: string
}

export interface TelegramUser {
    readonly id: number
    readonly is_bot: boolean
    readonly first_name?: string
    readonly last_name?: string
    readonly username?: string
}

export interface TelegramMessage {
    readonly message_id: number
    readonly from?: TelegramUser
    readonly chat: TelegramChat
    readonly date: number
    readonly text?: string
    readonly caption?: string
    /** A voice note recorded in the app: OGG/Opus. */
    readonly voice?: TelegramAudio
    /** An audio file sent as music. */
    readonly audio?: TelegramAudio
    /** A photo, in every size Telegram made of it, smallest first. */
    readonly photo?: readonly TelegramPhotoSize[]
    /** A file sent as a file. An image sent this way is read like a photo. */
    readonly document?: {
        readonly file_id: string
        readonly mime_type?: string
        readonly file_size?: number
    }
    /** Forum topic id. Present only in a supergroup with topics enabled. */
    readonly message_thread_id?: number
}

export interface TelegramAudio {
    readonly file_id: string
    readonly duration?: number
    readonly mime_type?: string
    readonly file_size?: number
}

export interface TelegramPhotoSize {
    readonly file_id: string
    readonly width: number
    readonly height: number
    readonly file_size?: number
}

export interface TelegramUpdate {
    readonly update_id: number
    readonly message?: TelegramMessage
    readonly edited_message?: TelegramMessage
    readonly channel_post?: TelegramMessage
}

export interface TelegramMe {
    readonly id: number
    readonly username?: string
    readonly first_name?: string
}

/** A call that reached Telegram and was refused, or never reached it at all. */
export class TelegramApiError extends Error {
    readonly status: number
    readonly retryable: boolean
    readonly retryAfterMs: number | undefined
    readonly detail: ErrorDetail

    constructor(init: {
        message: string
        status: number
        retryable: boolean
        retryAfterMs?: number
        detail: ErrorDetail
    }) {
        super(init.message)
        this.name = "TelegramApiError"
        this.status = init.status
        this.retryable = init.retryable
        this.retryAfterMs = init.retryAfterMs
        this.detail = init.detail
    }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TelegramApiOptions {
    readonly token: string
    readonly fetch?: FetchLike
    /** Overridable for tests and for a self-hosted Bot API server. */
    readonly baseUrl?: string
}

const DEFAULT_BASE = "https://api.telegram.org"

export class TelegramApi {
    readonly #token: string
    readonly #fetch: FetchLike
    readonly #base: string

    constructor(options: TelegramApiOptions) {
        this.#token = options.token
        this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
        this.#base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
    }

    /**
     * The token never appears in an error message, only in the URL.
     *
     * A Bot API token is a bearer credential in a path segment, so any message quoting the URL
     * leaks it into logs and into whatever collects them. `method` is what a reader needs.
     */
    async call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        let response: Response
        try {
            response = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
                method: "POST",
                // A form carries its own multipart boundary in the content type, so none is set.
                ...(body instanceof FormData
                    ? { body }
                    : {
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify(body ?? {}),
                      }),
                ...(signal === undefined ? {} : { signal }),
            })
        } catch (cause) {
            // No HTTP status: DNS, TLS, a reset, or our own abort. Retryable — the request never
            // reached a decision, so nothing about it is known to be permanent.
            throw new TelegramApiError({
                message: `Telegram ${method} did not complete: ${
                    cause instanceof Error ? cause.message : String(cause)
                }`,
                status: 0,
                retryable: true,
                detail: {
                    code: "telegram_unreachable",
                    message: `Could not reach the Telegram Bot API for ${method}.`,
                    hint: "Check network access from this host. api.telegram.org is blocked in some networks and from some cloud regions; a webhook deployment behind a proxy still needs outbound access for sendMessage.",
                },
            })
        }

        const payload = (await response.json().catch(() => ({}))) as TelegramResponse<T>
        if (response.ok && payload.ok && payload.result !== undefined) return payload.result

        throw classify(method, response.status, payload)
    }

    /** Who this token belongs to. The cheapest proof that a token is valid. */
    getMe(signal?: AbortSignal): Promise<TelegramMe> {
        return this.call<TelegramMe>("getMe", {}, signal)
    }

    getUpdates(
        input: { offset: number; timeout: number; limit?: number },
        signal?: AbortSignal,
    ): Promise<TelegramUpdate[]> {
        return this.call<TelegramUpdate[]>(
            "getUpdates",
            {
                offset: input.offset,
                timeout: input.timeout,
                limit: input.limit ?? 100,
                // Only what this channel turns into a turn. Narrowing here means Telegram does not
                // hold back the offset for update kinds nothing will ever acknowledge.
                allowed_updates: ["message"],
            },
            signal,
        )
    }

    sendMessage(
        input: { chatId: string; text: string; threadId?: number },
        signal?: AbortSignal,
    ): Promise<TelegramMessage> {
        return this.call<TelegramMessage>(
            "sendMessage",
            {
                chat_id: input.chatId,
                text: input.text,
                ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
            },
            signal,
        )
    }

    /** An image, as a photo: Telegram compresses it and shows it inline. */
    sendPhoto(
        input: {
            chatId: string
            photo: Blob
            filename: string
            caption?: string
            threadId?: number
        },
        signal?: AbortSignal,
    ): Promise<TelegramMessage> {
        const form = new FormData()
        form.set("chat_id", input.chatId)
        form.set("photo", input.photo, input.filename)
        if (input.caption !== undefined && input.caption !== "") form.set("caption", input.caption)
        if (input.threadId !== undefined) form.set("message_thread_id", String(input.threadId))
        return this.call<TelegramMessage>("sendPhoto", form, signal)
    }

    getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }> {
        return this.call<{ file_path?: string }>("getFile", { file_id: fileId }, signal)
    }

    /**
     * A file's bytes, from the path `getFile` returned. The token is in this URL too, so the error
     * names the file and never the URL.
     */
    async download(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
        const response = await this.#fetch(`${this.#base}/file/bot${this.#token}/${filePath}`, {
            ...(signal === undefined ? {} : { signal }),
        })
        if (!response.ok) {
            throw new TelegramApiError({
                message: `Downloading ${filePath} failed with HTTP ${response.status}`,
                status: response.status,
                retryable: response.status >= 500,
                detail: {
                    code: "telegram_download_failed",
                    message: `Telegram would not serve ${filePath} (${response.status}).`,
                    hint: "Bots may download files up to 20 MB; a larger voice note cannot be fetched through the Bot API.",
                },
            })
        }
        return new Uint8Array(await response.arrayBuffer())
    }

    sendChatAction(input: { chatId: string; threadId?: number }): Promise<boolean> {
        return this.call<boolean>("sendChatAction", {
            chat_id: input.chatId,
            action: "typing",
            ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
        })
    }

    setWebhook(
        input: { url: string; secretToken?: string; dropPending?: boolean },
        signal?: AbortSignal,
    ): Promise<boolean> {
        return this.call<boolean>(
            "setWebhook",
            {
                url: input.url,
                allowed_updates: ["message"],
                ...(input.secretToken === undefined ? {} : { secret_token: input.secretToken }),
                ...(input.dropPending === undefined
                    ? {}
                    : { drop_pending_updates: input.dropPending }),
            },
            signal,
        )
    }

    deleteWebhook(signal?: AbortSignal): Promise<boolean> {
        return this.call<boolean>("deleteWebhook", {}, signal)
    }
}

/**
 * Sort a refusal into retryable or permanent.
 *
 * Telegram signals rate limiting with 429 and `parameters.retry_after` **in seconds**, which is
 * honoured verbatim: it is the one case where the provider knows better than any backoff table, and
 * ignoring it walks straight into the next 429.
 *
 * 400 and 403 are permanent by default, because the common members of that set — a chat that does
 * not exist, a bot the user blocked, a bot removed from a group — do not improve with time. The
 * exception is 400 "message is too long", which is our bug rather than theirs and is called out so
 * the hint does not send someone looking at their chat settings.
 */
function classify(
    method: string,
    status: number,
    payload: TelegramResponse<unknown>,
): TelegramApiError {
    const description = payload.description ?? `HTTP ${status}`
    const code = payload.error_code ?? status
    const retryAfter = payload.parameters?.retry_after

    if (code === 429) {
        return new TelegramApiError({
            message: `Telegram rate-limited ${method}: ${description}`,
            status: code,
            retryable: true,
            ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter * 1000 }),
            detail: {
                code: "telegram_rate_limited",
                message: `Telegram rate-limited ${method}.`,
                hint:
                    retryAfter === undefined
                        ? "The outbox will back off and retry. Sustained rate limiting on one chat usually means replies are being split into many chunks — check the reply length."
                        : `Telegram asked for ${retryAfter}s. The outbox honours that verbatim rather than applying its own backoff.`,
            },
        })
    }

    if (code === 401) {
        return new TelegramApiError({
            message: `Telegram rejected the bot token on ${method}: ${description}`,
            status: code,
            retryable: false,
            detail: {
                code: "telegram_unauthorized",
                message: "The Telegram bot token was rejected.",
                hint: "Check the variable named by the channel's tokenEnv. A token is revoked whenever /revoke is sent to @BotFather, and a regenerated token invalidates the old one immediately.",
            },
        })
    }

    // 409 is retryable and its cause is never transient in the way the generic message implies:
    // Telegram allows exactly one `getUpdates` consumer per bot, so a Conflict means a *second
    // instance is polling* — another terminal, a container that did not exit, or a webhook that
    // was never deleted. Falling through to the generic 4xx branch told the reader "a 5xx from
    // Telegram is usually brief", which is wrong twice and sends them to look at the network.
    if (code === 409) {
        return new TelegramApiError({
            message: `Telegram reports a conflicting ${method}: ${description}`,
            status: code,
            retryable: true,
            detail: {
                code: "telegram_conflict",
                message: "Another instance of this bot is already receiving updates.",
                hint: "Telegram allows one getUpdates consumer per bot token. Stop the other process — another terminal, a container that did not exit — or, if a webhook was registered earlier, this channel's own start clears it. Retried, so it recovers on its own once the other side stops.",
            },
        })
    }

    if (code === 400 && /too long/i.test(description)) {
        return new TelegramApiError({
            message: `Telegram refused ${method}: ${description}`,
            status: code,
            retryable: false,
            detail: {
                code: "telegram_message_too_long",
                message: "A chunk exceeded Telegram's message limit.",
                hint: "This is a chunking bug, not a configuration problem: the transport declares maxMessageChars and core splits to it. Report the reply length — the splitter reserves room for a code-fence reopen, so the effective limit is slightly under 4096.",
            },
        })
    }

    const permanent = code === 400 || code === 403
    return new TelegramApiError({
        message: `Telegram refused ${method}: ${description}`,
        status: code,
        retryable: !permanent,
        detail: {
            code: permanent ? "telegram_refused" : "telegram_error",
            message: `Telegram refused ${method}: ${description}`,
            hint: permanent
                ? "Telegram reports this as a client error, so it is not retried. The usual causes are a chat the bot was removed from, a user who blocked it, or a chat id from a different bot — a chat id is not portable between bots."
                : "Treated as transient and retried with backoff. A 5xx from Telegram is usually brief.",
        },
    })
}
