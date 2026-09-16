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

/** One delegation's identity. Time-prefixed, so a turn's handoffs sort in the order they ran. */
export function newHandoffId(now = Date.now()): string {
    return id("h", now)
}

/**
 * One approval's identity, and it has to be minted rather than derived.
 *
 * `callId` is the obvious candidate and cannot be used: a dialect numbers calls **within a step**
 * (`c1`, `c2`, …), so two steps of one turn — let alone two concurrent turns — both have a `c1`.
 * An approval id reaches a client, comes back in a URL, and decides which blocked call resumes; a
 * colliding one would resume the wrong call in the wrong turn, which is the worst available
 * outcome for a mechanism whose whole job is asking permission.
 */
export function newApprovalId(now = Date.now()): string {
    return id("a", now)
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
