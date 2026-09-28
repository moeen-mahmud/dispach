/**
 * The Teams transport: activities in through the runtime's webhook route, replies out to the
 * activity's `serviceUrl`.
 *
 * **Webhook only.** Teams pushes activities to a public HTTPS endpoint registered on the bot
 * (`https://<silo>/v1/channels/<id>/webhook/<agent>`); there is no polling mode to fall back to. So
 * `start` touches no network and reports the endpoint, and "connected" means "ready to be called".
 *
 * **Where a reply goes is remembered.** A reply is POSTed to the `serviceUrl` the conversation's
 * activities arrived from, which the outbox does not carry — it knows a recipient, the conversation
 * id. The mapping is written beside the agent, so a schedule delivering to a chat after a restart
 * still knows where that chat lives. A conversation never seen has nowhere to go and fails
 * permanently, naming why, rather than being guessed at.
 *
 * 200 is answered before the turn runs: the connector retries a slow webhook, and a retried delivery
 * mid-turn would be the same message twice (the inbox deduplicates by activity id either way).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
    BRAND,
    type ChannelHost,
    type ChannelLimits,
    type ChannelTransport,
    type OutboundMessage,
    type SendResult,
    type WebhookDelivery,
    type WebhookOutcome,
} from "@dispach/core"
import { type TeamsActivity, tenantOf, toInbound } from "./activity.ts"
import { AuthRefused, type BotFrameworkAuth, type FetchLike, TokenRefused } from "./auth.ts"

export interface TeamsTransportOptions {
    readonly id: string
    readonly auth: BotFrameworkAuth
    /** The agent's directory, where the conversation → serviceUrl map is kept. */
    readonly dir: string
    /** Activities from any other Entra tenant are dropped. Absent: any tenant the bot is in. */
    readonly tenantId?: string
    readonly fetch?: FetchLike
}

export class TeamsTransport implements ChannelTransport {
    readonly id: string
    readonly type = "teams"
    // Teams caps a message near 28 KB of HTML; 4,000 characters of markdown stays well inside it and
    // matches how long a single chat message can usefully be.
    readonly limits: ChannelLimits = { maxMessageChars: 4000, idempotentSend: false }
    readonly #auth: BotFrameworkAuth
    readonly #tenantId: string | undefined
    readonly #fetch: FetchLike
    readonly #file: string
    #host: ChannelHost | undefined
    #services: Record<string, string>

    constructor(options: TeamsTransportOptions) {
        this.id = options.id
        this.#auth = options.auth
        this.#tenantId = options.tenantId
        this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
        this.#file = join(options.dir, BRAND.stateDir, `teams-${options.id}.json`)
        this.#services = readServices(this.#file)
    }

    async start(host: ChannelHost): Promise<void> {
        this.#host = host
        host.status("connected", `webhook — POST /v1/channels/${this.id}/webhook/<agent>`)
    }

    async stop(): Promise<void> {
        this.#host?.status("disconnected")
        this.#host = undefined
    }

    async webhook(delivery: WebhookDelivery): Promise<WebhookOutcome> {
        const activity = delivery.body as TeamsActivity | undefined
        if (
            activity === undefined ||
            typeof activity !== "object" ||
            typeof activity.type !== "string"
        ) {
            return { status: 400, detail: "not an activity" }
        }
        try {
            await this.#auth.verify(delivery.headers.authorization, activity)
        } catch (cause) {
            if (cause instanceof AuthRefused) return { status: 401, detail: cause.message }
            // The connector's keys could not be fetched: not the sender's fault, and worth a retry.
            this.#host?.status("error", `cannot verify activities: ${String(cause)}`)
            return { status: 503, detail: "cannot verify right now" }
        }

        const host = this.#host
        if (host === undefined) return { status: 503, detail: "channel not started" }
        if (this.#tenantId !== undefined && tenantOf(activity) !== this.#tenantId) {
            // Verified, and from another organisation the bot was added to. Accepted so the connector
            // does not retry it, and not read.
            return { status: 200, detail: "other tenant" }
        }

        if (
            activity.serviceUrl?.startsWith("https://") === true &&
            activity.conversation !== undefined
        ) {
            this.#remember(activity.conversation.id, activity.serviceUrl)
        }
        const inbound = toInbound(activity)
        if (inbound !== undefined) host.receive(inbound)
        return { status: 200 }
    }

    async send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult> {
        return this.#post(
            message.recipient,
            { type: "message", text: message.text, textFormat: "markdown" },
            signal,
        )
    }

    async typing(recipient: string): Promise<void> {
        await this.#post(recipient, { type: "typing" })
    }

    async #post(
        conversationId: string,
        activity: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<SendResult> {
        const serviceUrl = this.#services[conversationId]
        if (serviceUrl === undefined) {
            return {
                ok: false,
                retryable: false,
                error: {
                    code: "teams_conversation_unknown",
                    message: `No Teams message has arrived from conversation ${conversationId}, so there is no service address to reply to.`,
                    hint: "Teams gives a bot the address of a conversation only when a message arrives from it. Have someone message the bot in that chat once; a schedule can deliver there afterwards.",
                },
            }
        }
        let token: string
        try {
            token = await this.#auth.token(signal)
        } catch (cause) {
            const status = cause instanceof TokenRefused ? cause.status : 0
            return {
                ok: false,
                retryable: status === 0 || status >= 500,
                error: {
                    code: "teams_token_refused",
                    message: `Entra ID did not issue the bot a token: ${cause instanceof Error ? cause.message : String(cause)}`,
                    hint: "Check the app id, the password in the env var the channel names, and tenantId (the bot's own tenant for a single-tenant registration). A wrong secret is permanent; an outage is retried.",
                },
            }
        }
        const url = `${serviceUrl.replace(/\/?$/, "/")}v3/conversations/${encodeURIComponent(conversationId)}/activities`
        let response: Response
        try {
            response = await this.#fetch(url, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify(activity),
                ...(signal === undefined ? {} : { signal }),
            })
        } catch (cause) {
            return {
                ok: false,
                retryable: true,
                error: {
                    code: "teams_unreachable",
                    message: `Cannot reach ${serviceUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
                    hint: "Allow outbound HTTPS to smba.trafficmanager.net (the Teams service URLs) and login.microsoftonline.com. Retried.",
                },
            }
        }
        if (response.ok) {
            const body = (await response.json().catch(() => ({}))) as { id?: string }
            return { ok: true, ...(body.id === undefined ? {} : { providerMessageId: body.id }) }
        }
        const detail = (await response.text().catch(() => "")).slice(0, 300)
        const retryAfter = Number(response.headers.get("retry-after"))
        return {
            ok: false,
            retryable: response.status === 429 || response.status >= 500,
            ...(Number.isFinite(retryAfter) && retryAfter > 0
                ? { retryAfterMs: retryAfter * 1000 }
                : {}),
            error: {
                code: "teams_send_failed",
                message: `Teams refused the reply (${response.status}): ${detail}`,
                hint:
                    response.status === 403
                        ? "The bot is not a member of that conversation any more (removed from the chat or team), or its registration does not allow this tenant."
                        : "Teams' own words are above. 429 and 5xx are retried; anything else is not.",
            },
        }
    }

    #remember(conversationId: string, serviceUrl: string): void {
        if (this.#services[conversationId] === serviceUrl) return
        this.#services = { ...this.#services, [conversationId]: serviceUrl }
        mkdirSync(dirname(this.#file), { recursive: true })
        const partial = `${this.#file}.partial`
        writeFileSync(partial, `${JSON.stringify(this.#services, null, 2)}\n`)
        renameSync(partial, this.#file)
    }
}

function readServices(file: string): Record<string, string> {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
        if (typeof parsed !== "object" || parsed === null) return {}
        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
        )
    } catch {
        return {}
    }
}
