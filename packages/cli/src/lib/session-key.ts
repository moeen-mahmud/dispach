/**
 * Naming a conversation.
 *
 * Every `run` used to land in `local:default`, which made the store one long transcript per agent:
 * yesterday's debugging session and this morning's question shared a history, so the model was
 * conditioned on both and neither could be resumed without the other. A key per run fixes that, and it
 * moves the cost — you now have to *say* which conversation you mean, which is what `--continue` and the
 * exit pointer are for.
 *
 * ## Why six random characters rather than a timestamp
 *
 * A timestamp sorts and reads well and is twenty characters somebody has to type. `sessions` already
 * sorts by `lastActivityAt`, so the ordering a timestamp would carry is information the *listing* has and
 * the key does not need — and the two things a person actually does with a key are read it off a pointer
 * line and type it back. Six symbols is one glance and one word.
 *
 * ## Why the prefix stays
 *
 * `local:` says which surface opened the conversation, and it is already load-bearing: Telegram writes
 * `tg:<chat>`, so the prefix is what stops a chat id colliding with a terminal session. A bare key would
 * work today and break the first time two surfaces agreed on a name.
 *
 * Pure: the randomness arrives as bytes, so a test gets the key it asked for.
 */

/**
 * Base-32 without the symbols that look like each other.
 *
 * `i`, `l`, `o` and `u` are out — a key is read off a screen and typed back, and `local:1i0o` is one
 * nobody transcribes reliably. Exactly 32 symbols also divides a byte's low five bits, so there is no
 * modulo bias: an alphabet that does not divide evenly makes its first symbols more likely than its last,
 * which matters here not for secrecy but because it makes collisions more likely than the count below
 * claims.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** Symbols after the prefix. Six gives 32^6 ≈ 1.07 billion, so a 50% collision needs ~39,000 sessions. */
export const SESSION_KEY_LENGTH = 6

/** The surface that opened the conversation. A terminal session; Telegram writes its own prefix. */
export const LOCAL_SESSION_PREFIX = "local"

/**
 * A key from six bytes.
 *
 * Only the low five bits of each byte are read, which is why the alphabet is exactly 32 long.
 */
export function sessionKeyFrom(bytes: Uint8Array): string {
    const symbols: string[] = []
    for (let at = 0; at < SESSION_KEY_LENGTH; at += 1) {
        const byte = bytes[at] ?? 0
        symbols.push(ALPHABET[byte & 0x1f] ?? "0")
    }
    return `${LOCAL_SESSION_PREFIX}:${symbols.join("")}`
}

/**
 * A freshly minted key, from an injected source of randomness.
 *
 * The one derivation. `resolveSession` computed `sessionKeyFrom(random(SESSION_KEY_LENGTH))` inline and
 * `/new` needed the same line — two copies of "what a generated session is called" is how two surfaces
 * come to disagree about it, the same reason `logPaths` moved into `lib/sandbox.ts` rather than being
 * copied into `remove`.
 *
 * `random` is a parameter rather than a `crypto` call so a test gets the key it asked for, and so the
 * component layer never has to reach for crypto to open a conversation.
 */
export function newSessionKey(random: (count: number) => Uint8Array): string {
    return sessionKeyFrom(random(SESSION_KEY_LENGTH))
}

/**
 * True for a key this module could have produced.
 *
 * Used to *explain* a key rather than to validate one — a hand-written `--session mine` is perfectly
 * valid and must stay so. It exists because a generated key is the one a person did not choose, and a
 * listing can say so.
 */
export function isGeneratedSessionKey(key: string): boolean {
    return new RegExp(`^${LOCAL_SESSION_PREFIX}:[${ALPHABET}]{${SESSION_KEY_LENGTH}}$`).test(key)
}
