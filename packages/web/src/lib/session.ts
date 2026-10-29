/**
 * A conversation the browser opens gets a key of its own (QA C1).
 *
 * "+ new" used to send with no key, so the server put every new conversation into `api:default` —
 * one session whose whole history the model saw, under a header that said "new conversation". A key
 * minted here makes the header true. Same shape as the terminal's `local:` keys: six symbols from an
 * alphabet with the confusable letters removed, because a key is something people read back.
 */

import { DEFAULT_BRAND } from "@dispach/core/wire"

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

export function newConversationKey(random: (count: number) => Uint8Array): string {
    return `web:${[...random(6)].map((byte) => ALPHABET[byte & 0x1f]).join("")}`
}

/** The conversation this tab had open, so a reload reopens it rather than a blank "new conversation". */
export const OPEN_SESSION = `${DEFAULT_BRAND.slug}.session`

export function rememberedSession(stored: string | null, agentId: string): string | undefined {
    if (stored === null) return undefined
    const [agent, key] = stored.split("\u001f")
    return agent === agentId && key !== undefined && key !== "" ? key : undefined
}

export function rememberSession(agentId: string, key: string): string {
    return `${agentId}\u001f${key}`
}

/** A rotation's suffix: `~` and six symbols (`docs/23-SPEC-SESSIONS.md`). */
const ROTATION = /~[0-9a-hjkmnp-tv-z]{6}$/

/**
 * How the sidebar names a conversation. A person's own conversation across surfaces is "You", the
 * one before a "new conversation" is "You · earlier" with the day it was last used, and a registered
 * participant's is their id. Anything else is its key, which is what it has always shown.
 */
export function conversationLabel(session: {
    readonly sessionKey: string
    readonly head?: boolean
    readonly lastActivityAt?: string
}): string {
    const key = session.sessionKey
    const earlier =
        session.head === false
            ? ` · earlier${session.lastActivityAt === undefined ? "" : `, ${session.lastActivityAt.slice(0, 10)}`}`
            : ""
    if (key.startsWith("owner:")) return `You${earlier}`
    if (key.startsWith("peer:"))
        return `${key.slice("peer:".length).replace(ROTATION, "")}${earlier}`
    return key
}

/** Whether `scope` puts a person's turns in one conversation, so "new conversation" is a rotation. */
export function sharesConversations(scope: string | undefined): boolean {
    return scope === "owner" || scope === "peer"
}
