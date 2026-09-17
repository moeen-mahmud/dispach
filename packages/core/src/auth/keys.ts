/**
 * Operator key secrets: minting one, and turning a presented one into a lookup.
 *
 * A key is a **labelled bearer credential with no identity attached**. There is no username, no
 * password, no role and no signup — decision 15.1 — because the thing being solved is "a person
 * reaching this server from a browser needs a credential that can be revoked without restarting
 * the process", and every field beyond a label is a user model nobody asked for. Authorisation is
 * not in scope either: every key sees every session, and the UI says so rather than leaving it to
 * be discovered.
 *
 * ## Why a single SHA-256 and not scrypt
 *
 * The plan named `scrypt`, and writing it is what made the reason it is wrong here visible. A slow
 * KDF exists to make a *guessable* secret expensive to guess: it buys work per candidate, and its
 * value is proportional to how small the candidate space is. `newKeySecret` returns 160 bits from
 * the platform CSPRNG, so there is no candidate space to search — the attack a KDF defends against
 * does not exist for a secret nobody chose.
 *
 * What a salted KDF *would* cost is concrete and lands on every request:
 *
 * 1. **A per-key salt cannot be indexed.** Verification would have to try each stored key in turn,
 *    so authenticating one request costs one KDF run *per key in the table* — an O(n) hot path that
 *    gets slower as an operator adds credentials, which is the wrong direction for a security
 *    feature to scale.
 * 2. **It runs on every authenticated request**, including opening an SSE stream. At scrypt's whole
 *    point of ~100 ms that is 100 ms added to every call a browser makes.
 *
 * A fingerprint is `SHA-256(secret)`, unsalted and therefore *unique*, which is what makes the
 * lookup a single indexed read. Unsalted is safe for exactly the reason the KDF is unnecessary: a
 * rainbow table over 160-bit random strings is not a thing that can be built. A store leak yields
 * digests, and a digest is not a credential.
 *
 * The property being defended is preimage resistance, and that is the property SHA-256 has.
 */

import { BRAND } from "../brand.ts"

/**
 * Human-recognisable prefix, derived from the brand so a rename moves it.
 *
 * It is **not** used to decide which credential path a request takes — `checkToken` tries the
 * configured token first and the key table second, whatever the presented string looks like, so an
 * operator whose `server.tokenEnv` value happens to start with this prefix is not locked out. The
 * prefix earns its place by making a leaked key *identifiable*: a secret scanner, a log review or a
 * person reading a pasted snippet can tell what it is, which an anonymous blob of base32 cannot.
 */
export const OPERATOR_KEY_PREFIX = `${BRAND.slug}_`

/**
 * Symbols with no confusable pair, and exactly 32 of them.
 *
 * Both halves matter and the second is the load-bearing one. `i`, `l`, `o` and `u` are gone because
 * a credential gets read off a container log and pasted, and a misread is indistinguishable from a
 * wrong key. Thirty-two symbols is what makes the encoding **unbiased**: five bits map onto one
 * symbol exactly, so masking the low five bits is uniform. `loop/ids.ts` reduces a byte modulo 36
 * for ids, which is fine for a collision-resistance argument and not fine here — a modulo over an
 * alphabet that does not divide 256 makes the early symbols likelier than the late ones, and for a
 * *secret* that is entropy quietly removed from the only number that matters.
 *
 * `cli/src/lib/session-key.ts` holds the same 32 symbols for local session keys. Deliberately not
 * shared: that one is half of a *parsed* key format with its own length and its own regex, so
 * importing one into the other would couple a credential's encoding to a session key's grammar.
 */
const SECRET_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** 32 symbols × 5 bits. Far past brute force, and short enough to paste without wrapping. */
const SECRET_SYMBOLS = 32

/**
 * A fresh secret, prefixed. Shown once at issue and never recoverable.
 *
 * Returned whole rather than as parts, because the only correct thing to do with it is hand it over
 * intact — a caller that assembled it from pieces would be a caller able to assemble it *wrongly*.
 */
export function newKeySecret(): string {
    const bytes = new Uint8Array(SECRET_SYMBOLS)
    crypto.getRandomValues(bytes)
    let out = ""
    for (const byte of bytes) out += SECRET_ALPHABET[byte & 0x1f] ?? "0"
    return `${OPERATOR_KEY_PREFIX}${out}`
}

/**
 * What gets stored, and what a presented secret is looked up by.
 *
 * Hex rather than base64, because it is the value of a `TEXT` column with a `UNIQUE` index over it
 * and hex is the spelling that survives every driver, console and dump identically. Row seven of
 * `sqlite/driver.ts`'s table is the reason to care: `node:sqlite` truncates a bound string at a NUL
 * byte, so anything used as a **key** in this store is printable ASCII on purpose.
 */
export async function keyFingerprint(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Labels are shown in listings and in the UI, so they are bounded and single-line. */
export const MAX_KEY_LABEL = 64

/** Control characters, including the newline and tab a label must not carry. */
const CONTROL = new RegExp(`[${"\\u0000-\\u001f\\u007f"}]`)

/**
 * Whether a label is usable, and the refusal is about *display* rather than safety.
 *
 * A label is the only thing distinguishing two credentials in a list, so an empty one makes the
 * list useless and a multi-line one breaks every row it appears in — the same column arithmetic
 * that moved the `handoff` roster off a tool summary one phase ago. Control characters go for the
 * reason `stripControl` exists in the tool path: a label reaches a terminal, and an escape sequence
 * in it renders as a different label than the one stored.
 */
export function keyLabelProblem(label: string): string | undefined {
    if (label.trim() === "") return "A key label cannot be empty."
    if (label.length > MAX_KEY_LABEL)
        return `A key label is at most ${MAX_KEY_LABEL} characters; this one is ${label.length}.`
    if (CONTROL.test(label))
        return "A key label cannot contain control characters, including newlines and tabs."
    return undefined
}
