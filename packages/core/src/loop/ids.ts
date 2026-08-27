/**
 * Turn and step ids.
 *
 * Client-visible, because reattach needs a handle: deriving one from the session key breaks the
 * moment two turns overlap. Time-prefixed so they sort chronologically in a log without a join.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

function randomSuffix(length: number): string {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    let out = ""
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
    return out
}

function id(prefix: string, now: number): string {
    return `${prefix}_${now.toString(36)}${randomSuffix(8)}`
}

export function newTurnId(now = Date.now()): string {
    return id("t", now)
}

export function newStepId(now = Date.now()): string {
    return id("s", now)
}

/**
 * One scheduled run's identity, which becomes the thread segment of its session key.
 *
 * A scheduled run gets a fresh session every time, so a daily brief never accumulates history it
 * was not asked to carry — and every run stays in the store as its own conversation, which is what
 * makes "what did last Tuesday's brief actually say" a question with an answer.
 */
export function newRunId(now = Date.now()): string {
    return id("r", now)
}
