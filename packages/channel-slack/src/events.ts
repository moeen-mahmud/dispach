/**
 * A Slack Events API event → `RawInbound`, or nothing.
 *
 * **When the agent answers.** Always in a direct message (`message` with `channel_type: "im"`). In
 * a channel, a private channel or a group DM only on `app_mention`, because an agent answering
 * every line of a busy channel is noise and a model call per message. A mention is answered in its
 * thread — `thread_ts`, or the mention's own `ts` when it started one — so a thread is its own
 * session and its own reply target. The recipient is the channel id and the thread rides beside it,
 * which is why Slack needs no stored reply address where Teams does.
 *
 * **Who wrote it.** `event.user`, the member id (`U…`): the handle `allowFrom` matches and the acting
 * participant (`slack:<id>`). Anything a bot wrote (`bot_id`) or any subtype — edits, joins, the
 * bot's own replies — is not a person saying something new, and is dropped.
 */

import type { RawInbound } from "@dispach/core"

export interface SlackEvent {
    readonly type: string
    readonly subtype?: string
    readonly user?: string
    readonly bot_id?: string
    readonly text?: string
    readonly ts?: string
    readonly thread_ts?: string
    readonly channel?: string
    readonly channel_type?: string
}

/** Slack escapes exactly these three in message text. */
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" }

/** The bot's own mention removed and Slack's three escapes undone. Other markup is left readable. */
export function plainText(text: string, botUserId: string | undefined): string {
    const mention =
        botUserId === undefined ? /^\s*<@[A-Z0-9]+>/ : new RegExp(`<@${botUserId}>`, "g")
    return text
        .replace(mention, "")
        .replace(/&(amp|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity)
        .replace(/\s+/g, " ")
        .trim()
}

/** Undefined for anything the agent should not answer. `botUserId` is from the envelope's authorizations. */
export function toInbound(event: SlackEvent, botUserId?: string): RawInbound | undefined {
    if (event.subtype !== undefined || event.bot_id !== undefined) return undefined
    if (event.user === undefined || event.user === botUserId) return undefined
    if (event.channel === undefined || event.ts === undefined) return undefined
    const direct = event.type === "message" && event.channel_type === "im"
    if (!direct && event.type !== "app_mention") return undefined
    const text = plainText(event.text ?? "", botUserId)
    if (text === "") return undefined
    const thread = direct ? event.thread_ts : (event.thread_ts ?? event.ts)
    return {
        // Channel plus ts is Slack's own message identity; a mention in a DM arriving as both
        // `message` and `app_mention` collapses to one here.
        providerMessageId: `${event.channel}:${event.ts}`,
        peerId: event.channel,
        senderId: event.user,
        senderHandle: event.user,
        ...(thread === undefined ? {} : { thread }),
        text,
        receivedAt: new Date(Number(event.ts) * 1000).toISOString(),
    }
}
