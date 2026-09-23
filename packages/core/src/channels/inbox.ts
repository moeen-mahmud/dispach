/**
 * Inbound normalisation: raw provider message → a turn, or a refusal that says why.
 *
 * Three jobs, in this order, and the order is the design:
 *
 * 1. **Deduplicate.** A long-poll replays an unacknowledged update; a webhook is retried on any
 *    non-2xx. Both are correct provider behaviour and both would otherwise run the turn twice.
 * 2. **Authorise.** `allowFrom` is checked *here*, before anything is persisted, so a refused
 *    sender leaves no session behind. A channel that policed its own allowlist would be a channel
 *    that could get it wrong privately.
 * 3. **Route.** Compose the session key. `store/session-key.ts` has enforced its grammar since
 *    Phase 2 precisely so this step is a string build rather than a lookup.
 *
 * **`allowFrom` is inbound-only.** It grants nothing on the way out and denies nothing on the way
 * out. Conflating the two is what produces the "chat not found" class of failure the architecture
 * notes warn about: an operator adds a handle to `allowFrom`, assumes delivery is now configured,
 * and discovers otherwise only when a scheduled run has nowhere to go.
 */

import { formatSessionKey } from "../store/session-key.ts"
import type { InboundMessage, RawInbound } from "./channel.ts"

/** Why a message was refused, or that it was not. */
export type InboundDecision =
    | { readonly kind: "accept"; readonly message: InboundMessage }
    | { readonly kind: "duplicate"; readonly providerMessageId: string }
    | { readonly kind: "denied"; readonly sender: string; readonly reason: string }

export interface InboxOptions {
    readonly channelId: string
    readonly channelType: string
    /** Absent or containing `"*"` permits anyone. */
    readonly allowFrom?: readonly string[]
    /** How many recent provider message ids to remember. See `Inbox` for why this is bounded. */
    readonly dedupeWindow?: number
}

const DEFAULT_DEDUPE_WINDOW = 512

/**
 * Per-channel inbound gate.
 *
 * The duplicate window is **in-memory and bounded**, which is a deliberate limit rather than an
 * oversight. It covers the case that actually happens — a provider retrying within seconds — at the
 * cost of one `Set` and no I/O on the hot path. It does not survive a restart, so a webhook retried
 * across a crash runs the turn again. Persisting it would mean a synchronous write before every
 * inbound message to close a window measured in the seconds a process spends restarting, and the
 * duplicate work it prevents is one turn rather than a duplicate side effect: the outbox, which is
 * where a duplicate would actually be visible to a person, keys on the *turn* and dedupes there.
 */
export class Inbox {
    readonly channelId: string
    readonly channelType: string

    readonly #allowFrom: readonly string[] | undefined
    readonly #seen = new Set<string>()
    readonly #window: number

    constructor(options: InboxOptions) {
        this.channelId = options.channelId
        this.channelType = options.channelType
        this.#allowFrom = options.allowFrom
        this.#window = options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW
    }

    accept(raw: RawInbound): InboundDecision {
        const id = raw.providerMessageId
        if (id !== undefined && id !== "") {
            if (this.#seen.has(id)) return { kind: "duplicate", providerMessageId: id }
            this.#remember(id)
        }

        const sender = raw.senderHandle ?? raw.peerId
        if (!isAllowed(raw, this.#allowFrom)) {
            // The unconfigured case names the sender that was just refused, so the fix is a copy
            // and paste rather than a trip to the docs to find out what the field wants.
            const unconfigured = this.#allowFrom === undefined || this.#allowFrom.length === 0
            return {
                kind: "denied",
                sender,
                reason: unconfigured
                    ? `Channel "${this.channelId}" has no allowFrom, which permits nobody. Add allowFrom: ["${sender}"] to let this sender in, or ["*"] for anyone.`
                    : `Sender "${sender}" is not in channel "${this.channelId}"'s allowFrom list.`,
            }
        }

        return { kind: "accept", message: this.normalise(raw) }
    }

    /** Compose the runtime-shaped message. Public so a transport test can build one without a gate. */
    normalise(raw: RawInbound): InboundMessage {
        return {
            ...raw,
            channelId: this.channelId,
            channelType: this.channelType,
            sessionKey: formatSessionKey({
                channel: this.channelId,
                peerId: raw.peerId,
                ...(raw.thread === undefined ? {} : { thread: raw.thread }),
            }),
        }
    }

    /**
     * Insertion-ordered eviction, relying on `Set` preserving it.
     *
     * Evicting one at a time rather than clearing the whole set: a clear would make the window
     * momentarily empty, and a provider retrying at exactly that moment would get through — a bug
     * that reproduces once every few hundred messages and never in a test.
     */
    #remember(id: string): void {
        this.#seen.add(id)
        while (this.#seen.size > this.#window) {
            const oldest = this.#seen.values().next()
            if (oldest.done === true) break
            this.#seen.delete(oldest.value)
        }
    }
}

/**
 * Whether `raw`'s sender is permitted by `allowFrom`.
 *
 * **Closed by default.** An omitted `allowFrom` permits nobody, which reads as unfriendly until you
 * consider what the alternative defaults to: a Telegram bot is discoverable by anyone who guesses
 * its username, and this runtime's agents can hold a shell. Open-by-default would make a leaked
 * token an open agent, and — worse — would make *forgetting the field* indistinguishable from
 * choosing to be public. A refusal is loud (`agent.channel.rejected` names the sender and says what
 * to add), so a closed default costs one clear message. An open one costs whatever the stranger
 * asks for.
 *
 * Matching is deliberately tolerant, because the field is written by a person from memory:
 * `"@Moeen"`, `"moeen"` and `"@moeen"` are one person and three strings. Case is folded, a leading
 * `@` is optional on both sides, and an entry is compared against the handle *and* the peer id —
 * a Telegram user with no username has only the latter, and handle-only matching would make them
 * impossible to allow. The cost is that `allowFrom` cannot express two handles differing only by
 * case, which no provider issues.
 */
export function isAllowed(raw: RawInbound, allowFrom: readonly string[] | undefined): boolean {
    if (allowFrom === undefined || allowFrom.length === 0) return false

    const candidates = new Set([normaliseSender(raw.peerId)])
    if (raw.senderHandle !== undefined && raw.senderHandle !== "") {
        candidates.add(normaliseSender(raw.senderHandle))
    }

    for (const entry of allowFrom) {
        if (entry === "*") return true
        if (candidates.has(normaliseSender(entry))) return true
    }
    return false
}

/**
 * Fold case and drop one leading `@`, so the same person written three ways compares equal.
 *
 * **A phone number is folded to its digits.** `+880 1711-223344` is how a number reads off a
 * contact card, `8801711223344` is how a WhatsApp JID carries it, and they are one person — the
 * same argument the `@` tolerance above makes for handles. Compared literally, an `allowFrom`
 * copied from a contact matched nobody, and the refusal that names the sender printed the digits
 * form as the line to add, so the person had to notice that their `+` was the whole problem.
 *
 * Applied only when the value is a number with punctuation and nothing else: a Telegram handle
 * containing a `+` does not exist, and `abc-def` is left alone because stripping separators from
 * a name would fold two different handles into one.
 */
function normaliseSender(value: string): string {
    const trimmed = value.trim()
    const bare = (trimmed.startsWith("@") ? trimmed.slice(1) : trimmed).toLowerCase()
    return /^\+?[0-9][0-9 .()-]*$/.test(bare) ? bare.replace(/[^0-9]/g, "") : bare
}
