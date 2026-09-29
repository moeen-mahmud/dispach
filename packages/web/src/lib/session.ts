/**
 * A conversation the browser opens gets a key of its own (QA C1).
 *
 * "+ new" used to send with no key, so the server put every new conversation into `api:default` —
 * one session whose whole history the model saw, under a header that said "new conversation". A key
 * minted here makes the header true. Same shape as the terminal's `local:` keys: six symbols from an
 * alphabet with the confusable letters removed, because a key is something people read back.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

export function newConversationKey(random: (count: number) => Uint8Array): string {
    return `web:${[...random(6)].map((byte) => ALPHABET[byte & 0x1f]).join("")}`
}

/** The conversation this tab had open, so a reload reopens it rather than a blank "new conversation". */
export const OPEN_SESSION = "dispach.session"

export function rememberedSession(stored: string | null, agentId: string): string | undefined {
    if (stored === null) return undefined
    const [agent, key] = stored.split("\u001f")
    return agent === agentId && key !== undefined && key !== "" ? key : undefined
}

export function rememberSession(agentId: string, key: string): string {
    return `${agentId}\u001f${key}`
}
