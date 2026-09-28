/**
 * The Slack transport: Socket Mode in, `chat.postMessage` out.
 *
 * **Socket Mode, not the Events API webhook.** `apps.connections.open` with the app-level token hands
 * back a WebSocket URL and Slack pushes events down it, so a silo behind a NAT or a default-deny
 * ingress policy needs no public endpoint and nothing to verify — the socket is authenticated by the
 * token that opened it. The platform `WebSocket` (Node 22+, Bun) is the whole client.
 *
 * **Every envelope is acknowledged before it is handled.** Slack redelivers anything not acked within
 * three seconds, so acking after the turn would be the same message many times; the inbox
 * deduplicates by `channel:ts` regardless.
 *
 * **The loop never stops on its own.** Slack closes a socket every few hours (`disconnect`,
 * `refresh_requested`) and on its own deploys; a bad token fails every open. Either way the loop
 * opens again, backing off after failures and reporting the first and every eighth — only `stop()`
 * ends it, because a loop that exits leaves a bot that is running and deaf with nothing saying so.
 */

import type {
    ChannelHost,
    ChannelLimits,
    ChannelTransport,
    ErrorDetail,
    OutboundMessage,
    SendResult,
} from "@dispach/core"
import { type SlackEvent, toInbound } from "./events.ts"

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** The part of the platform `WebSocket` the transport uses; injectable for tests. */
export type SocketFactory = (url: string) => WebSocket

export const SLACK_API = "https://slack.com/api/"

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const

export interface SlackTransportOptions {
    readonly id: string
    /** `xapp-…`, the app-level token with `connections:write`. Opens the socket. */
    readonly appToken: string
    /** `xoxb-…`, the bot token with `chat:write`. Sends replies. */
    readonly botToken: string
    readonly fetch?: FetchLike
    readonly socket?: SocketFactory
    readonly backoffMs?: readonly number[]
    /** Where the Web API lives. A test points it at a fake. */
    readonly apiBase?: string
}

interface Envelope {
    readonly type?: string
    readonly envelope_id?: string
    readonly payload?: {
        readonly event?: SlackEvent
        readonly authorizations?: readonly { readonly user_id?: string }[]
    }
}

class OpenRefused extends Error {
    readonly detail: ErrorDetail
    constructor(detail: ErrorDetail) {
        super(detail.message)
        this.detail = detail
    }
}

export class SlackTransport implements ChannelTransport {
    readonly id: string
    readonly type = "slack"
    // The markdown block's cumulative cap per message. Slack rate-limits chat.postMessage near one
    // per second per channel, so chunks are paced.
    readonly limits: ChannelLimits = {
        maxMessageChars: 12_000,
        idempotentSend: false,
        minSendIntervalMs: 1_000,
    }
    readonly #appToken: string
    readonly #botToken: string
    readonly #fetch: FetchLike
    readonly #socket: SocketFactory
    readonly #backoff: readonly number[]
    readonly #api: string
    #host: ChannelHost | undefined
    #abort: AbortController | undefined
    #loop: Promise<void> | undefined

    constructor(options: SlackTransportOptions) {
        this.id = options.id
        this.#appToken = options.appToken
        this.#botToken = options.botToken
        this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
        this.#socket = options.socket ?? ((url) => new WebSocket(url))
        this.#backoff = options.backoffMs ?? BACKOFF_MS
        this.#api = options.apiBase ?? SLACK_API
    }

    /** Returns at once; the socket is opened by the detached loop, so an outage cannot delay boot. */
    async start(host: ChannelHost): Promise<void> {
        if (this.#abort !== undefined) return
        this.#host = host
        this.#abort = new AbortController()
        this.#loop = this.#run(host, this.#abort.signal)
    }

    async stop(): Promise<void> {
        this.#abort?.abort()
        await this.#loop?.catch(() => {})
        this.#abort = undefined
        this.#loop = undefined
        this.#host?.status("disconnected")
        this.#host = undefined
    }

    async #run(host: ChannelHost, signal: AbortSignal): Promise<void> {
        let failures = 0
        let connected = false
        while (!signal.aborted) {
            try {
                const url = await this.#open(signal)
                const greeted = await this.#session(host, url, signal, () => {
                    failures = 0
                    if (!connected) host.status("connected", "Socket Mode")
                    connected = true
                })
                if (signal.aborted) return
                // A socket Slack closed after greeting us is the routine refresh: open again now.
                if (greeted) continue
                throw new OpenRefused({
                    code: "slack_socket_closed",
                    message: "Slack closed the Socket Mode connection before it was established.",
                    hint: "Usually transient and retried. If it persists, check that Socket Mode is enabled for the app (Settings → Socket Mode).",
                })
            } catch (cause) {
                if (signal.aborted) return
                failures += 1
                connected = false
                if (failures === 1 || failures % 8 === 0) {
                    const detail =
                        cause instanceof OpenRefused
                            ? cause.detail
                            : {
                                  code: "slack_unreachable",
                                  message: `Cannot reach Slack: ${cause instanceof Error ? cause.message : String(cause)}`,
                                  hint: "Allow outbound HTTPS to slack.com and wss to *.slack.com. Retried with backoff.",
                              }
                    host.status("error", detail.message)
                    host.error(detail)
                }
                const wait = this.#backoff[Math.min(failures, this.#backoff.length) - 1] ?? 30_000
                await sleep(wait, signal)
            }
        }
    }

    async #open(signal: AbortSignal): Promise<string> {
        const response = await this.#fetch(`${this.#api}apps.connections.open`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.#appToken}` },
            signal,
        })
        const body = (await response.json().catch(() => ({}))) as {
            ok?: boolean
            url?: string
            error?: string
        }
        if (body.ok === true && typeof body.url === "string") return body.url
        const error = body.error ?? `HTTP ${response.status}`
        throw new OpenRefused({
            code: "slack_app_token_refused",
            message: `Slack would not open a Socket Mode connection: ${error}.`,
            hint:
                error === "not_allowed_token_type"
                    ? "That is not an app-level token. appTokenEnv must hold the xapp-… token from Basic Information → App-Level Tokens, with the connections:write scope."
                    : "Check the app-level token (xapp-…, scope connections:write) and that Socket Mode is enabled for the app. Retried with backoff.",
        })
    }

    /** Resolves when the socket closes: true if Slack said hello first. */
    #session(
        host: ChannelHost,
        url: string,
        signal: AbortSignal,
        onHello: () => void,
    ): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = this.#socket(url)
            let greeted = false
            const close = () => socket.close()
            signal.addEventListener("abort", close, { once: true })
            socket.addEventListener("message", (message) => {
                let envelope: Envelope
                try {
                    envelope = JSON.parse(String(message.data)) as Envelope
                } catch {
                    return
                }
                if (envelope.envelope_id !== undefined) {
                    socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
                }
                if (envelope.type === "hello") {
                    greeted = true
                    onHello()
                } else if (envelope.type === "disconnect") {
                    socket.close()
                } else if (envelope.type === "events_api" && envelope.payload?.event) {
                    const bot = envelope.payload.authorizations?.[0]?.user_id
                    const inbound = toInbound(envelope.payload.event, bot)
                    if (inbound !== undefined) host.receive(inbound)
                }
            })
            // An error event is always followed by close, which is where the outcome is decided.
            socket.addEventListener("close", () => {
                signal.removeEventListener("abort", close)
                resolve(greeted)
            })
        })
    }

    async send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult> {
        let response: Response
        try {
            response = await this.#fetch(`${this.#api}chat.postMessage`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.#botToken}`,
                    "content-type": "application/json; charset=utf-8",
                },
                body: JSON.stringify({
                    channel: message.recipient,
                    // The notification and fallback text; the markdown block is what renders,
                    // and it takes standard markdown where `text` would take Slack's mrkdwn.
                    text: message.text,
                    blocks: [{ type: "markdown", text: message.text }],
                    ...(message.thread === undefined ? {} : { thread_ts: message.thread }),
                }),
                ...(signal === undefined ? {} : { signal }),
            })
        } catch (cause) {
            return {
                ok: false,
                retryable: true,
                error: {
                    code: "slack_unreachable",
                    message: `Cannot reach Slack: ${cause instanceof Error ? cause.message : String(cause)}`,
                    hint: "Allow outbound HTTPS to slack.com. Retried.",
                },
            }
        }
        const body = (await response.json().catch(() => ({}))) as {
            ok?: boolean
            ts?: string
            error?: string
        }
        if (body.ok === true) {
            return { ok: true, ...(body.ts === undefined ? {} : { providerMessageId: body.ts }) }
        }
        const error = body.error ?? `HTTP ${response.status}`
        const retryAfter = Number(response.headers.get("retry-after"))
        return {
            ok: false,
            retryable: response.status === 429 || response.status >= 500 || RETRYABLE.has(error),
            ...(Number.isFinite(retryAfter) && retryAfter > 0
                ? { retryAfterMs: retryAfter * 1000 }
                : {}),
            error: {
                code: "slack_send_failed",
                message: `Slack refused the reply to ${message.recipient}: ${error}.`,
                hint:
                    SEND_HINTS[error] ??
                    "Slack's own error code is above. Rate limits and server errors are retried; anything else is not.",
            },
        }
    }
}

const RETRYABLE = new Set([
    "ratelimited",
    "internal_error",
    "fatal_error",
    "service_unavailable",
    "request_timeout",
])

const SEND_HINTS: Record<string, string> = {
    not_in_channel:
        "The app is not a member of that channel. Invite it (/invite @<app>) and message it again.",
    channel_not_found:
        "No channel with that id is visible to the bot: it was deleted, or it is private and the app was never added.",
    is_archived: "The channel is archived. Unarchive it or deliver somewhere else.",
    missing_scope:
        "The bot token lacks chat:write. Add the scope under OAuth & Permissions and reinstall the app.",
    invalid_auth: "The bot token (xoxb-…) is wrong. Check the env var botTokenEnv names.",
    token_revoked:
        "The bot token was revoked, usually by uninstalling the app. Reinstall it and update the token.",
    account_inactive:
        "The bot token belongs to an app that was uninstalled. Reinstall it and update the token.",
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
