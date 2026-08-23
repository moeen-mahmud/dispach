/**
 * The five stages, as pure transforms over history.
 *
 * Decision 5.1: compaction is progressive from v1, because binary emergency compaction at 95% is the
 * known-bad design — late activation, severe loss, and errors that compound across successive
 * compactions. Each stage here is strictly more destructive than the one before it, and the ladder
 * (`ladder.ts`) is what decides which ones run.
 *
 * | stage | what it does | model |
 * | --- | --- | --- |
 * | `snip` | cuts oversized observations to head + tail | no |
 * | `micro` | replaces an observation body with a pointer | no |
 * | `collapse` | digests all but the newest turns | yes, with a fallback |
 * | `reset` | digests everything; pinned blocks and requests survive | yes, with a fallback |
 * | `trim` | drops working detail the digests declined to summarise | no |
 *
 * ## Four properties that are load-bearing
 *
 * **Nothing is destroyed, only displaced.** `snip` and `micro` return the full original content as a
 * `Displaced` entry for the caller to persist, and leave a pointer the agent can follow. The id is
 * derived from the content, not generated, so a message that is snipped and then micro'd on a later
 * turn produces the *same* id both times — escalation converges on one artifact instead of
 * accumulating one per stage. Same reasoning as the outbox's dedupe key: the duplicate that actually
 * happens is the same work running twice, and only a derived identity collides. `StageOutcome.displaced`
 * is a map keyed by message index for this reason — see its comment; deriving the id afresh in `micro`
 * would hash the text `snip` had already cut.
 *
 * **The protected tail is untouchable.** `turn.ts` appends calls and observations to `history` *during*
 * the turn, so a stage firing at step three could replace the observation the model is about to reason
 * over — the compaction would break the turn it was rescuing. The count comes from the caller because
 * no pure function can know where the current turn's trace begins.
 *
 * **A stage that changes nothing says so.** `changed: false` is not a failure, it is the signal the
 * ladder uses to escalate. A stage reporting success for a no-op would stall the ladder one rung below
 * where it needed to be, and the prompt would then be cut by `assembleContext`'s blunt oldest-first
 * trim with nothing explaining why.
 *
 * **No stage drops what the person said.** Not a preference — an arithmetic result. The person's own
 * messages are 0.3% of history, so dropping every one of them frees nothing, and they are the only
 * record of what the agent was asked to do. A session is full of `"continue"`, `"yes"`, `"where are we
 * at?"`; oldest-first dropped the instruction and kept the continuations, leaving the model a run of
 * acknowledgements with no antecedent. Keeping them needs no definition of "the task" and no model
 * call: `isTurnStart` is a `user` message that is not an observation, and that is the whole predicate.
 * `reset` is included — its contract is that pinned blocks *and the person's words* survive.
 */

import { derivedId } from "../../ids.ts"
import type { ChatMessage } from "../../model/provider.ts"
import { estimateMessageTokens, estimateTokens } from "../tokens.ts"

/**
 * The order the ladder runs them in, and the order the thresholds must ascend in.
 *
 * Ordered by **information destroyed**, which is not the same as bytes freed and is the mistake the
 * first ordering made. Freeing bytes puts `trim` early, because dropping turns frees the most; but
 * `snip` and `micro` leave a followable `artifact_read` pointer, `collapse` and `reset` leave the
 * meaning as a digest, and `trim` leaves nothing at all. On that axis `trim` is the worst rung, not a
 * middle one, and its gentle name is exactly why it was misplaced.
 *
 * Two measurements decided it. First, on a real 47-message session observations were **83.9%** of
 * history bytes, assistant prose 12.6%, tool calls 3.2%, and everything the person had ever typed
 * **0.3%** — 423 bytes of 150 KB. So observations come first and nothing drops the person's words.
 *
 * Second, and this is the forced part: with `trim` third, `collapse` and `reset` could never fire. They
 * only get a turn when `trim` failed to reach target, which means `trim` had already dropped everything
 * it was allowed to — leaving the request spine and nothing else. A digest *plus* the preserved spine
 * cannot be smaller than the spine alone, so both refused, every time. Summarising has to precede
 * destroying or the summary has no subject. Measured: 8316 → 7860 → 5064 → then `collapse` and `reset`
 * both `changed=false` at 495 tokens.
 *
 * `trim` last is therefore the fallback for the case where the digests *declined* — a short history of
 * terse turns, where a digest would grow the prompt and the no-growth guard refuses it. Then there is
 * still working detail to remove and `trim` removes it.
 */
export const STAGE_ORDER = ["snip", "micro", "collapse", "reset", "trim"] as const

export type StageName = (typeof STAGE_ORDER)[number]

/** Content a stage removed from history, for the caller to persist and the agent to re-read. */
export interface Displaced {
    /** Derived from the content. Printable ASCII: it is used as a store key. */
    readonly id: string
    /** The tool that produced it, where the message says. */
    readonly slug?: string
    readonly content: string
    readonly tokens: number
}

export interface StageOutcome {
    readonly messages: readonly ChatMessage[]
    /**
     * Everything displaced so far in this pass, keyed by message index. Supersedes the input map.
     *
     * A map rather than a list, and that is what makes the convergence property true rather than
     * merely claimed: `micro` following `snip` over the same message finds the entry `snip` recorded
     * and reuses its id and its **original** content. Deriving the id afresh would hash the cut text,
     * so the pointer would resolve to a truncation of the thing it promises in full.
     *
     * `trim` reindexes, and since the reorder it runs *after* both. It therefore re-keys this map by the
     * offset it removed rather than returning an empty one: dropping it would mean `persist()` never
     * writes the artifacts `snip` and `micro` created, while the pointers naming them stay in the
     * surviving messages — a live `artifact_read` id resolving to nothing.
     */
    readonly displaced: ReadonlyMap<number, Displaced>
    /** Estimated cost of `messages`, from the same function the budget uses. */
    readonly tokens: number
    /** False when the stage had nothing left to do. The ladder escalates on this. */
    readonly changed: boolean
}

export interface StageInput {
    /** Oldest first, as `assembleContext` expects. */
    readonly history: readonly ChatMessage[]
    /** Tokens the history must fit into after this stage. */
    readonly target: number
    /** Newest messages that must not be altered — the current turn's trace. */
    readonly protectedTail: number
    /** What earlier stages in this same pass have already displaced, by index. */
    readonly displaced?: ReadonlyMap<number, Displaced>
}

const NO_DISPLACEMENTS: ReadonlyMap<number, Displaced> = new Map()

/** `obs_<len>_<hash>`. Length is in the id so two hash collisions still have to agree on size. */
export function displacedId(content: string): string {
    return derivedId("obs", content)
}

/** What a message costs, matching `assembleContext`'s accounting including tool-call arguments. */
function cost(message: ChatMessage): number {
    const calls = message.toolCalls
    if (calls === undefined || calls.length === 0) return estimateMessageTokens(message.content)
    return estimateMessageTokens(message.content) + estimateTokens(JSON.stringify(calls))
}

export function historyTokens(history: readonly ChatMessage[]): number {
    return history.reduce((sum, message) => sum + cost(message), 0)
}

/**
 * Is this message tool output?
 *
 * `origin` is the answer where it is present. `role === "tool"` covers the native dialect, where the
 * wire role really does carry the meaning, and also covers a history loaded from a store written
 * before `origin` existed.
 */
function isObservation(message: ChatMessage): boolean {
    return message.origin === "observation" || message.role === "tool"
}

/** The tool named in an NLT observation header, so a pointer can say what it replaced. */
function slugOf(message: ChatMessage): string | undefined {
    const match = /^OBSERVATION ([^\s—]+)/.exec(message.content)
    return match?.[1]
}

function unchanged(input: StageInput): StageOutcome {
    return {
        messages: input.history,
        displaced: input.displaced ?? NO_DISPLACEMENTS,
        tokens: historyTokens(input.history),
        changed: false,
    }
}

/**
 * The displacement for a message: whatever an earlier stage recorded, or a new entry from its content.
 *
 * This is the single place the original text is preserved across an escalation.
 */
function displacementFor(
    known: ReadonlyMap<number, Displaced>,
    index: number,
    message: ChatMessage,
    tokens: number,
): Displaced {
    const existing = known.get(index)
    if (existing !== undefined) return existing
    const slug = slugOf(message)
    return {
        id: displacedId(message.content),
        ...(slug === undefined ? {} : { slug }),
        content: message.content,
        tokens,
    }
}

/**
 * Where the protected tail starts. Everything from here on is off limits.
 *
 * Clamped rather than trusted: a caller that reports a longer tail than the history it passed would
 * otherwise produce a negative index and a silently reversed slice.
 */
function tailStart(input: StageInput): number {
    return Math.max(0, input.history.length - Math.max(0, input.protectedTail))
}

/**
 * A turn boundary is a `user` message that is not tool output — in practice, something the person said.
 *
 * Exported because `assembleContext`'s blunt trim needs the same predicate. Two definitions of "what
 * the person said" is how one path came to honour "no stage drops a request" while the other, running
 * on the same session a moment later, did not.
 *
 * Under NLT an observation is also a `user` message, which is why this asks `isObservation` rather
 * than looking at the role alone — dropping "everything before the third user message" would
 * otherwise cut a history in the middle of a tool exchange and leave an assistant turn answering a
 * call whose result is gone.
 */
export function isTurnStart(message: ChatMessage): boolean {
    return message.role === "user" && !isObservation(message)
}

/**
 * What the model is told where the working detail used to be.
 *
 * Without it the survivors are a run of bare requests, and the `VOLATILE_HEADER` lesson applies
 * directly: a fact with no frame is a fact a model will not connect to a question. Unframed, the
 * oldest surviving `"add the tests"` reads as the live instruction and gets answered again.
 *
 * Deliberately says the detail is *gone* rather than offering a way back. `snip` and `micro` leave an
 * `artifact_read` id because they have one; this stage does not, and a marker implying otherwise would
 * send the model looking for a pointer that was never written — the same defect as a `snip` marker with
 * no id in it.
 *
 * Kept short because it is charged for on every firing, and the no-growth guard is sensitive to it: a
 * first draft three sentences long made `collapse` refuse on a short history, since the explanation
 * cost more than the one reply it was able to drop. Framing, not prose.
 */
const TRIM_HEADER =
    "Earlier requests, verbatim. The replies and tool output between them were dropped to fit the " +
    "context window and cannot be retrieved."

/**
 * S5 — drop working detail outright, keeping what the person actually said.
 *
 * The obvious version drops whole turns oldest-first, which is what `assembleContext` does bluntly and
 * what this stage used to do at turn granularity. Both throw away the person's own messages, and the
 * arithmetic says not to: measured over a real session they are **0.3%** of history. Dropping every one
 * of them frees nothing and costs the only record of what was asked.
 *
 * So the unit is the message, not the turn, and `isTurnStart` decides. Everything else in the
 * compactable region goes oldest-first until the target is met. Dropping the assistant messages and
 * their observations *together* is what keeps the two broken shapes away: a run of user messages has no
 * assistant turn answering a vanished call, and no observation whose call is gone.
 */
export function trim(input: StageInput): StageOutcome {
    const limit = tailStart(input)
    const known = input.displaced ?? NO_DISPLACEMENTS

    const droppable: number[] = []
    for (let i = 0; i < limit; i += 1) {
        const message = input.history[i]
        // A digest is not working detail, it is the record of working detail — and since the reorder
        // `trim` runs after both digest stages, an unprotected one would be the first thing it ate.
        if (message === undefined || isTurnStart(message) || message.origin === "digest") continue
        droppable.push(i)
    }
    if (droppable.length === 0) return unchanged(input)

    // The header is a message, so it is charged for before deciding how much to remove. Skipping that
    // lets a tight target be missed by exactly the amount of the explanation.
    const header: ChatMessage = { role: "user", content: TRIM_HEADER, origin: "digest" }
    const removed = new Set<number>()
    let tokens = historyTokens(input.history) + cost(header)
    for (const index of droppable) {
        if (tokens <= input.target) break
        const message = input.history[index]
        if (message === undefined) continue
        removed.add(index)
        tokens -= cost(message)
    }
    if (removed.size === 0) return unchanged(input)

    // Re-key as we go. `trim` is the only stage that reindexes, and since the reorder it runs after
    // `snip` and `micro` — returning an empty map here would strand every artifact they displaced,
    // leaving their pointers naming ids that `persist()` was never asked to write.
    const messages: ChatMessage[] = [header]
    const displaced = new Map<number, Displaced>()
    for (let i = 0; i < input.history.length; i += 1) {
        if (removed.has(i)) continue
        const message = input.history[i]
        if (message === undefined) continue
        const entry = known.get(i)
        if (entry !== undefined) displaced.set(messages.length, entry)
        messages.push(message)
    }

    return { messages, displaced, tokens: historyTokens(messages), changed: true }
}

/**
 * How much of an oversized observation `snip` keeps, and in what proportion.
 *
 * Head-heavy on purpose. A tool result states what happened in its first lines — `ok`, an error, a
 * count, the first rows — and trails off into repetition; the tail is kept at all because the *end*
 * of a shell run carries the exit status. Two-thirds head, one-third tail is the split that keeps both
 * without keeping the middle, which is where a 200-row listing spends its bytes.
 */
const SNIP_KEEP_TOKENS = 400
const SNIP_HEAD_SHARE = 2 / 3

/** Below this an observation is left alone: cutting it would cost a marker and save nothing. */
const SNIP_FLOOR_TOKENS = 200

/**
 * Head, tail, and a marker naming the id — the id is not optional and its absence was a live bug.
 *
 * The first real run of this stage against an endpoint produced a marker reading "the whole
 * observation is still readable with artifact_read" with no id in it. Asked to follow it, the model
 * correctly reported that there was no id to pass and then answered from the visible fragment. An
 * invitation the runtime cannot honour is worse than no invitation: it spends a step and teaches the
 * model that the mechanism does not work.
 */
function cutMiddle(content: string, id: string): string {
    const lines = content.split("\n")
    const headLines: string[] = []
    const tailLines: string[] = []
    let headTokens = 0
    let tailTokens = 0
    const headBudget = Math.floor(SNIP_KEEP_TOKENS * SNIP_HEAD_SHARE)
    const tailBudget = SNIP_KEEP_TOKENS - headBudget

    let head = 0
    let tail = lines.length - 1
    while (head <= tail) {
        const line = lines[head]
        if (line === undefined) break
        const lineTokens = estimateTokens(line)
        if (headTokens + lineTokens > headBudget) break
        headLines.push(line)
        headTokens += lineTokens
        head += 1
    }
    while (tail >= head) {
        const line = lines[tail]
        if (line === undefined) break
        const lineTokens = estimateTokens(line)
        if (tailTokens + lineTokens > tailBudget) break
        tailLines.unshift(line)
        tailTokens += lineTokens
        tail -= 1
    }

    const removed = lines.length - headLines.length - tailLines.length
    if (removed <= 0) return content
    return [
        ...headLines,
        `… ${removed} line${removed === 1 ? "" : "s"} cut by compaction — the whole observation is still readable with artifact_read("${id}") …`,
        ...tailLines,
    ].join("\n")
}

/**
 * S1 — cut oversized observations to head and tail.
 *
 * Oldest first, and it stops as soon as the target is met: an observation from three turns ago is
 * worth less than the one from the last turn, and cutting more than necessary spends fidelity the
 * ladder has not yet asked for.
 */
export function snip(input: StageInput): StageOutcome {
    const limit = tailStart(input)
    const messages = [...input.history]
    const displaced = new Map(input.displaced ?? NO_DISPLACEMENTS)
    let tokens = historyTokens(input.history)
    let changed = false

    for (let i = 0; i < limit && tokens > input.target; i += 1) {
        const message = messages[i]
        if (message === undefined || !isObservation(message)) continue
        const before = cost(message)
        if (before <= SNIP_FLOOR_TOKENS) continue

        // The displacement is resolved *before* the cut, because the marker has to name its id and
        // the id is derived from the uncut text — which after this line is no longer what the message
        // holds. Same ordering constraint `micro` relies on, one stage earlier.
        const entry = displacementFor(displaced, i, message, before)
        const cut = cutMiddle(message.content, entry.id)
        if (cut === message.content) continue

        displaced.set(i, entry)
        messages[i] = { ...message, content: cut }
        tokens -= before - cost(messages[i] as ChatMessage)
        changed = true
    }

    if (!changed) return unchanged(input)
    return { messages, displaced, tokens, changed }
}

/**
 * S2 — replace an observation body with a pointer.
 *
 * The pointer names the tool, the size, and the id, in that order, because those are the three facts
 * that let a model decide whether following it is worth a step. It is generated text and not an
 * authored sentence, so writing it is not the rewriting decision 4.19 forbids.
 */
function pointer(displaced: Displaced): string {
    const what = displaced.slug === undefined ? "observation" : `${displaced.slug} observation`
    return `[compacted ${what}, ${displaced.tokens} tokens — read it in full with artifact_read("${displaced.id}")]`
}

export function micro(input: StageInput): StageOutcome {
    const limit = tailStart(input)
    const messages = [...input.history]
    const displaced = new Map(input.displaced ?? NO_DISPLACEMENTS)
    let tokens = historyTokens(input.history)
    let changed = false

    for (let i = 0; i < limit && tokens > input.target; i += 1) {
        const message = messages[i]
        if (message === undefined || !isObservation(message)) continue
        const before = cost(message)

        // `displacementFor` is what preserves the original across an escalation: after a `snip` this
        // returns the entry that stage recorded, carrying the id derived from the *uncut* text. So
        // the pointer written below resolves to the whole observation, not to the truncation.
        const entry = displacementFor(displaced, i, message, before)
        const replaced = pointer(entry)
        if (estimateMessageTokens(replaced) >= before) continue

        displaced.set(i, entry)
        messages[i] = { ...message, content: replaced }
        tokens -= before - cost(messages[i] as ChatMessage)
        changed = true
    }

    if (!changed) return unchanged(input)
    return { messages, displaced, tokens, changed }
}

/** Turns kept verbatim by `collapse`. Two, so the current exchange and the one it answers survive. */
const COLLAPSE_KEEP_TURNS = 2

/**
 * A digest built without a model.
 *
 * Used when no `compactor` role is configured and whenever the model call fails, which is the case
 * that matters: a compaction that throws has failed the turn it existed to rescue. Deliberately
 * factual rather than interpretive — roles, counts, and the tools that ran. It is a worse digest than
 * a model writes and it is never a *wrong* one, which is the right trade for a fallback.
 */
export function mechanicalDigest(messages: readonly ChatMessage[]): string {
    const people = messages.filter((message) => isTurnStart(message)).length
    const observations = messages.filter(isObservation)
    const slugs = [...new Set(observations.map(slugOf).filter((slug) => slug !== undefined))]
    const lines = [
        `Earlier in this conversation: ${people} message${people === 1 ? "" : "s"} from the person and ${observations.length} tool result${observations.length === 1 ? "" : "s"}.`,
    ]
    if (slugs.length > 0) lines.push(`Tools used: ${slugs.join(", ")}.`)
    const firstAsk = messages.find(isTurnStart)
    if (firstAsk !== undefined) {
        lines.push(`It opened with: ${firstAsk.content.slice(0, 200).replace(/\s+/g, " ")}`)
    }
    lines.push(
        "That detail was dropped to stay inside the context window. Ask the person rather than guessing at anything it covered.",
    )
    return lines.join("\n")
}

function digestMessage(text: string): ChatMessage {
    return { role: "user", content: text, origin: "digest" }
}

/**
 * Framing for requests kept beside a digest.
 *
 * Different sentence from `TRIM_HEADER` because the situation is different: there the detail is gone,
 * here it is summarised in the message above. Telling the model detail was destroyed when a digest of
 * it is right there is the kind of small untruth that makes an agent hedge about what it knows.
 */
const DIGEST_SPINE_HEADER =
    "Earlier requests, verbatim. What happened in response is summarised above."

/**
 * The person's own messages from a span that is about to be replaced, with a header explaining them.
 *
 * Empty when the span holds none, so a caller never inserts a header over nothing. This is the one
 * mechanism behind the "no stage drops what the person said" property for the digesting stages —
 * `trim` does its own because it keeps them in place rather than lifting them out.
 */
function requestSpine(
    history: readonly ChatMessage[],
    upto: number,
    header: string,
): readonly ChatMessage[] {
    const requests = history.slice(0, Math.max(0, upto)).filter(isTurnStart)
    if (requests.length === 0) return []
    return [{ role: "user", content: header, origin: "digest" }, ...requests]
}

/**
 * S3 — digest everything but the newest turns.
 *
 * `digest` is supplied by the caller because producing it may be a model call, and a pure function
 * cannot make one. The caller is also where the fallback is chosen, so this stage never has to know
 * whether the text it was handed came from a model.
 */
export function collapse(input: StageInput & { readonly digest: string }): StageOutcome {
    const limit = tailStart(input)
    const boundaries: number[] = []
    for (let i = 0; i < limit; i += 1) {
        const message = input.history[i]
        if (message !== undefined && isTurnStart(message)) boundaries.push(i)
    }
    if (boundaries.length <= COLLAPSE_KEEP_TURNS) return unchanged(input)

    const from = boundaries[boundaries.length - COLLAPSE_KEEP_TURNS] as number
    const messages = [
        digestMessage(input.digest),
        ...requestSpine(input.history, from, DIGEST_SPINE_HEADER),
        ...input.history.slice(from),
    ]
    const tokens = historyTokens(messages)
    // A digest longer than what it replaced is not a compaction. It happens on a short history of
    // terse turns, and accepting it would grow the prompt at the moment the ladder was asked to
    // shrink it.
    if (tokens >= historyTokens(input.history)) return unchanged(input)
    // Empty for the same reason `trim`'s is: a digest replaces a span of messages, so every index
    // after it has moved and a map keyed by the old ones would point at the wrong messages.
    return { messages, displaced: NO_DISPLACEMENTS, tokens, changed: true }
}

/**
 * S4 — everything becomes the digest, except the protected tail.
 *
 * The last rung. Pinned blocks are not history and survive untouched, which is why anything that must
 * always hold lives in slots 0–2 and never here. Firing this twice in one session is a
 * misconfiguration rather than a busy session, and the ladder says so.
 *
 * "Everything" has one exception, and it is deliberate: the person's own requests survive here too. A
 * rung that discards them frees 0.3% and leaves an agent that cannot say what it was asked to do —
 * which is the state a reset is most likely to be reached in, and the worst one to be blind in.
 */
export function reset(input: StageInput & { readonly digest: string }): StageOutcome {
    const limit = tailStart(input)
    if (limit === 0) return unchanged(input)
    const messages = [
        digestMessage(input.digest),
        ...requestSpine(input.history, limit, DIGEST_SPINE_HEADER),
        ...input.history.slice(limit),
    ]
    const tokens = historyTokens(messages)
    if (tokens >= historyTokens(input.history)) return unchanged(input)
    return { messages, displaced: NO_DISPLACEMENTS, tokens, changed: true }
}
