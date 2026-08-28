/**
 * Past conversations as retrievable passages.
 *
 * `memory.includeHistory` is what makes "what were we at?" answerable. Without it the corpus holds only
 * what the agent deliberately wrote down, so a session nobody thought to save is gone — and the agent
 * reports that as *"I don't have notes from our earlier session"*, which reads as nothing having been
 * said rather than as a feature being switched off.
 *
 * ## What is indexed, and what is refused
 *
 * **Only messages with no `origin`.** That field is set by the runtime for everything it authored
 * itself — `observation`, `call`, `repair`, `digest` — so the rule is an allowlist of prose rather than
 * a blocklist of the four kinds known today, and a fifth kind added later is excluded by default. The
 * direction matters because of what `observation` holds: text a stranger wrote, fetched from a page or
 * returned by a provider. Indexing that would make prompt injection **durable** — retrieved into slot 7
 * in a later session, long after the write gate that fenced it stopped applying. A blocklist that
 * forgot one origin would open exactly that hole silently.
 *
 * A session written before migration 5 has no origins at all, so its observations are indistinguishable
 * from prose and *are* indexed. That is stated rather than hidden: the alternative is refusing to index
 * any pre-migration session, which throws away the real conversations to avoid a risk that only exists
 * for an agent that was already running fetched text through an ungated store.
 *
 * ## The document is derived, and says so
 *
 * `messages` is canonical for a conversation; this is a projection of it built to be split, ranked and
 * injected. So two liberties are taken that would be forbidden in a workspace file, where the bytes on
 * disk are the authority:
 *
 * - **Whitespace is collapsed per message.** A person's message is arbitrary text, and a line of it
 *   beginning `- ` or `#` would *become structure* once wrapped in a bullet — a second passage, or a
 *   heading over unrelated notes. One line per side removes that class of bug rather than escaping it
 *   case by case.
 * - **Each side is capped.** `selectPassages` stops at the first passage that does not fit the budget
 *   and never skips past it, so one enormous exchange would not merely cost a lot — it would sit at the
 *   top of the ranking and block everything behind it. A capped passage still carries its stamp and its
 *   source, which is what a reader needs to go and find the whole thing.
 *
 * Words are never changed, reordered or summarised. Decision 4.19's line holds: framing is allowed,
 * rewriting an authored sentence is not.
 */

import type { StoredMessage } from "../store/store.ts"

/**
 * Namespace for a conversation source, so one reconciliation pass cannot delete the other's rows.
 *
 * Recorded in migration 6's own schema comment — *"or `session:<key>` for an indexed message"* — before
 * any of this existed. Printable ASCII, like every other bound key here: `node:sqlite` truncates a bound
 * string at a NUL byte where `bun:sqlite` stores it whole, so a key containing one resolves on one
 * runtime and silently misses on the other.
 */
export const SESSION_SOURCE_PREFIX = "session:"

/** The index source for one conversation. */
export function sessionSource(sessionKey: string): string {
    return `${SESSION_SOURCE_PREFIX}${sessionKey}`
}

/**
 * Whether a source names a conversation rather than a file.
 *
 * The discriminator both indexers reconcile against. `enumerateFiles` refuses a memory file whose name
 * starts with this prefix for that reason — a file called `session:notes.md` would otherwise be
 * reconciled by whichever pass ran last and dropped by the other, alternating on every turn.
 */
export function isSessionSource(source: string): boolean {
    return source.startsWith(SESSION_SOURCE_PREFIX)
}

/**
 * Characters kept from each side of an exchange.
 *
 * Sized against the shipped `memory.budget` divided by `maxActive`: at 2,000 tokens across 5 passages a
 * passage has roughly 400 to spend, and 600 characters a side is about 320 tokens for the pair with
 * slack for the stamp — `estimateTokens` runs low on exactly this kind of mixed text, so the slack is
 * not optional.
 */
export const MAX_INDEXED_MESSAGE_CHARS = 600

/** One thing said and the reply to it. The retrievable unit of a conversation. */
export interface Exchange {
    /** The reply's timestamp where there is one, else the question's. When the exchange happened. */
    readonly at: string
    readonly asked: string
    /** Empty when the turn produced no text — a failure, or a cancellation. */
    readonly replied: string
}

/**
 * Pair each thing the person said with what the agent answered.
 *
 * The **last** non-empty assistant message wins rather than all of them concatenated. A multi-step turn
 * emits text beside its tool calls, and that text is mostly narration of what it is about to do — while
 * the final message is the answer. Keeping every one of them would triple the passage for a marginal
 * gain in recall and push the exchange against the cap, where the cut would fall on the answer.
 *
 * A question with no answer is still an exchange. A turn that failed or was cancelled is exactly the
 * thing somebody asks "where did we get to" about, and dropping it would lose the last one.
 */
export function exchanges(messages: readonly StoredMessage[]): readonly Exchange[] {
    const out: Exchange[] = []
    let open: { asked: string; askedAt: string; replied: string; repliedAt: string } | undefined

    const flush = () => {
        if (open === undefined) return
        const asked = collapse(open.asked)
        if (asked !== "") {
            out.push({
                at: open.replied === "" ? open.askedAt : open.repliedAt,
                asked,
                replied: collapse(open.replied),
            })
        }
        open = undefined
    }

    for (const message of messages) {
        // Prose only. `origin` is set for everything the runtime wrote itself, so its absence is the
        // allowlist — see the header on why this is not a blocklist of the known kinds.
        if (message.origin !== undefined || message.tainted === true) continue
        if (message.role === "user") {
            flush()
            open = {
                asked: message.content,
                askedAt: message.createdAt,
                replied: "",
                repliedAt: "",
            }
            continue
        }
        if (message.role !== "assistant" || open === undefined) continue
        if (message.content.trim() === "") continue
        open.replied = message.content
        open.repliedAt = message.createdAt
    }
    flush()
    return out
}

/**
 * One conversation as a markdown document `splitPassages` can split.
 *
 * Deliberately headingless. `document()` scores the heading with the text, and a heading repeated across
 * every passage of every session lands in more than half the corpus, where `discriminating()` drops it
 * as uninformative — so it would cost bytes on every row and contribute nothing to ranking. The source
 * already carries the provenance a reader needs.
 *
 * `you:` and `me:` because this document is read *by the agent*, in its own prompt, which is the same
 * voice `USER.md` is written in.
 */
export function renderConversation(messages: readonly StoredMessage[], fallbackAt: string): string {
    const lines: string[] = []
    for (const exchange of exchanges(messages)) {
        const at = exchange.at === "" ? fallbackAt : exchange.at
        lines.push(`- **${at}** _(conversation)_ you: ${cap(exchange.asked)}`)
        if (exchange.replied !== "") lines.push(`  me: ${cap(exchange.replied)}`)
    }
    return lines.join("\n")
}

/** Every run of whitespace to one space, so a message cannot become markdown structure. */
function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim()
}

function cap(text: string): string {
    return text.length <= MAX_INDEXED_MESSAGE_CHARS
        ? text
        : `${text.slice(0, MAX_INDEXED_MESSAGE_CHARS - 1).trimEnd()}…`
}
