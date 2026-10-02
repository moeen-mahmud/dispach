/**
 * A Bot Framework activity → `RawInbound`, or nothing.
 *
 * **When the agent answers.** Always in a personal (one-to-one) chat. In a group chat or a channel
 * only when the bot is @mentioned, because an agent answering every message in a busy channel is
 * noise and a model call per line. The reply goes into the thread: a channel post's conversation id
 * already carries `;messageid=<root>`, so it is the thread's own session and its own reply target.
 *
 * **Who wrote it.** `from.aadObjectId` — the Entra id an embedder already knows the member by — else
 * the channel-scoped `from.id`. It becomes the acting participant (`teams:<id>`) and the handle
 * `allowFrom` matches; the conversation is not a person.
 */

import type { RawInbound } from "@dispach/core"

export interface TeamsAccount {
    readonly id: string
    readonly name?: string
    readonly aadObjectId?: string
}

export interface TeamsActivity {
    readonly type: string
    readonly id?: string
    readonly timestamp?: string
    readonly serviceUrl?: string
    readonly channelId?: string
    readonly from?: TeamsAccount
    readonly recipient?: TeamsAccount
    readonly conversation?: {
        readonly id: string
        readonly conversationType?: "personal" | "groupChat" | "channel"
        readonly tenantId?: string
    }
    readonly text?: string
    readonly entities?: readonly {
        readonly type: string
        readonly mentioned?: TeamsAccount
        readonly text?: string
    }[]
    readonly channelData?: { readonly tenant?: { readonly id?: string } }
    readonly attachments?: readonly TeamsAttachment[]
}

export interface TeamsAttachment {
    readonly contentType: string
    readonly contentUrl?: string
    readonly name?: string
    /** For a file: `{downloadUrl, fileType}`, the URL pre-signed and short-lived. */
    readonly content?: { readonly downloadUrl?: string; readonly fileType?: string }
}

const AUDIO_TYPES: Record<string, string> = {
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    webm: "audio/webm",
    aac: "audio/aac",
}

/**
 * The audio an activity carried, and how to fetch it: a shared file comes with a pre-signed
 * `downloadUrl` that needs no token; an inline `audio/*` attachment's `contentUrl` needs the bot's.
 */
export function audioOf(
    activity: TeamsActivity,
): { url: string; mimeType: string; signed: boolean } | undefined {
    for (const attachment of activity.attachments ?? []) {
        const fileType = attachment.content?.fileType?.toLowerCase()
        const downloadUrl = attachment.content?.downloadUrl
        if (
            attachment.contentType === "application/vnd.microsoft.teams.file.download.info" &&
            downloadUrl !== undefined &&
            fileType !== undefined &&
            AUDIO_TYPES[fileType] !== undefined
        ) {
            return { url: downloadUrl, mimeType: AUDIO_TYPES[fileType], signed: true }
        }
        if (attachment.contentType.startsWith("audio/") && attachment.contentUrl !== undefined) {
            return { url: attachment.contentUrl, mimeType: attachment.contentType, signed: false }
        }
    }
    return undefined
}

const ENTITIES: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
}

/** The bot's own mention removed, other mentions reduced to the name, remaining markup dropped. */
export function plainText(activity: TeamsActivity): string {
    const bot = activity.recipient?.id
    let text = activity.text ?? ""
    for (const entity of activity.entities ?? []) {
        if (entity.type !== "mention" || entity.text === undefined) continue
        text = text.replace(
            entity.text,
            entity.mentioned?.id === bot ? "" : (entity.mentioned?.name ?? ""),
        )
    }
    return text
        .replace(/<[^>]+>/g, "")
        .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
        .replace(/\s+/g, " ")
        .trim()
}

export function mentionsBot(activity: TeamsActivity): boolean {
    const bot = activity.recipient?.id
    return (activity.entities ?? []).some(
        (entity) => entity.type === "mention" && entity.mentioned?.id === bot,
    )
}

export function tenantOf(activity: TeamsActivity): string | undefined {
    return activity.channelData?.tenant?.id ?? activity.conversation?.tenantId
}

/** Undefined for anything the agent should not answer: not a message, its own, or not addressed. */
export function toInbound(activity: TeamsActivity): RawInbound | undefined {
    if (activity.type !== "message" || activity.conversation === undefined) return undefined
    if (activity.from === undefined || activity.from.id === activity.recipient?.id) return undefined
    const personal = (activity.conversation.conversationType ?? "personal") === "personal"
    if (!personal && !mentionsBot(activity)) return undefined
    const text = plainText(activity)
    // A voice message with no words is still a message; the runtime transcribes it into some.
    if (text === "" && audioOf(activity) === undefined) return undefined
    const person = activity.from.aadObjectId ?? activity.from.id
    return {
        ...(activity.id === undefined
            ? {}
            : { providerMessageId: `${activity.conversation.id}:${activity.id}` }),
        peerId: activity.conversation.id,
        senderId: person,
        senderHandle: person,
        ...(activity.from.name === undefined ? {} : { senderName: activity.from.name }),
        text,
        receivedAt: activity.timestamp ?? new Date().toISOString(),
    }
}
