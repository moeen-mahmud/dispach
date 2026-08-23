/**
 * Ordered, budgeted context assembly.
 *
 * Phase 1 filled slots 0 (identity), 8 (recent history) and 10 (current input); Phase 3 added slot 1
 * (tools) and Phase 3.5 slots 2 (extracted examples), 3 (workspace volatile), 5 (knowledge) and 9
 * (workspace reminder). Still empty: 4 with skills, 6 with memory, 7 with compaction. The slot order
 * is fixed in advance so that filling them later cannot disturb the cache-stable prefix.
 *
 * History is trimmed from the oldest end when the budget is tight. That is a window, not
 * compaction — dropping the oldest turn outright is what Phase 7's ladder replaces with
 * something that summarizes before it forgets.
 */

import { isSessionSource, SESSION_SOURCE_PREFIX } from "../memory/conversation.ts"
import type { ChatMessage } from "../model/provider.ts"
import { type ContextBlock, SLOT, skillHeader, VOLATILE_HEADER } from "./blocks.ts"
import { isTurnStart } from "./compaction/stages.ts"
import { estimateMessageTokens, estimateTokens } from "./tokens.ts"

export interface AssembleInput {
    /** Slot 0: the workspace's `static` tier, read once at agent load. Byte-stable per turn. */
    readonly identity: string
    /**
     * Slot 3: the workspace's `volatile` tier — the user model and working memory.
     *
     * Separate from `identity` for one reason, and it is not organisational: this content changes
     * when the agent writes to memory, and it sits *after* the cache breakpoint so that a write
     * leaves slots 0 and 1 byte-identical. Folding it into `identity` would invalidate the cached
     * prefix on every memory write, and the only symptom would be the bill.
     */
    readonly volatile?: string
    /**
     * Slot 2: the workspace's extracted example blocks, delivered as a **user** message under
     * `examplesIn: user`.
     *
     * Before `volatile` rather than after it, because this content is byte-stable and prefix
     * caching is contiguous: behind the mutating volatile tier it would fall out of the cacheable
     * region on every memory write despite never changing. Absent under `examplesIn: system`,
     * where the blocks never left the static tier.
     */
    readonly examples?: string
    /**
     * Slot 2: what this agent is — model, channels, server, providers, permissions.
     *
     * Injected rather than left to a tool call, because knowing your own configuration was
     * otherwise a two-hop decision the model does not make. See `config-summary.ts` for the failure
     * that produced it. Built once at agent load and byte-stable for the process's lifetime, which
     * is what lets it sit ahead of the cache breakpoint.
     */
    readonly configSummary?: string
    /**
     * `SLOT.skill`: the activated skill bodies, already selected and budgeted by the caller.
     *
     * **Not pinned**, for the same reason as knowledge: a procedure applies to the turn that summoned
     * it, and carrying it through compaction would keep an agent following last hour's instructions.
     *
     * Its `role` comes from `promptStyle.skillsIn`, which has been in the schema since Phase 3 and is
     * read here for the first time. Any script the skill offers is rendered by the caller into
     * `content` — never into the slot-1 catalogue, which is built once and must stay byte-identical.
     */
    readonly skills?: readonly { name: string; content: string; role: "system" | "user" }[]
    /**
     * `SLOT.knowledge`: activated knowledge entries, already selected and budgeted by the caller.
     *
     * **Not pinned.** Tier 3 is retrieved per turn, never carried, so compaction may drop it —
     * the exact opposite of the workspace tiers, which must survive every stage.
     */
    readonly knowledge?: readonly { name: string; content: string }[]
    /**
     * `SLOT.memory`: retrieved memory passages, already ranked, filtered and budgeted by the caller.
     *
     * **Not pinned**, like knowledge and for the same reason: this tier is retrieved per turn rather
     * than carried, so compaction may drop it where it must never drop a workspace tier. A passage that
     * must always hold belongs in the volatile tier, which is what the carried `MEMORY.md` is for.
     *
     * Framed rather than injected bare. The lesson is recorded for the volatile tier, which arrived as
     * an unframed paragraph and produced an agent that had "Moeen is the person I work for" in its
     * context and answered "each session starts fresh": **a fact with no frame is a fact a small model
     * will not connect to a question.** Each passage carries where it came from and when it was learned,
     * because "you told me in June" is a different claim from "you told me a minute ago".
     */
    readonly memory?: readonly {
        readonly source: string
        readonly at: string
        readonly text: string
    }[]
    /**
     * Slot 9: the workspace's `reminder` tier, one or two re-asserted rules.
     *
     * Placed after the history rather than with the other pinned instruction blocks, because rule
     * adherence decays across a conversation and attention is stronger at both ends of a context
     * than in the middle. A rule stated once at the top of a thirty-turn session is, positionally,
     * in the middle.
     */
    readonly reminder?: string
    /**
     * Slot 1: the dialect preamble and tool catalogue, rendered once at agent load.
     *
     * Rendered at load rather than here, and for the same reason identity is read at load: slots 0
     * and 1 are the cache-stable prefix, and a catalogue that varies per turn — re-sorted, or with a
     * timestamp in it — silently stops prompt caching working, with no error and no symptom beyond
     * the bill.
     */
    readonly toolBlocks?: readonly ContextBlock[]
    /** Oldest first. */
    readonly history: readonly ChatMessage[]
    /**
     * Newest messages that must survive the budget: the current turn's own trace.
     *
     * The walk below goes newest-first and stops at the first message that will not fit, dropping
     * everything older. When the message that will not fit *is* the newest one — a single tool
     * observation larger than what the pinned blocks left over — the stop happens immediately and the
     * whole history goes, including the call and result the model is about to reason over. It then
     * answers as though the tool had never run.
     *
     * Optional because `previewContext` has no turn in flight and nothing to protect.
     */
    readonly protectedTail?: number
    readonly input: string
    /** Surfaced in the pinned error slot so a failure survives compaction. */
    readonly lastError?: string
    /** Total window, after capability resolution. */
    readonly window: number
    /** Held back for the response. */
    readonly reserveOutput: number
}

export interface AssembledContext {
    readonly blocks: readonly ContextBlock[]
    readonly messages: readonly ChatMessage[]
    readonly totalTokens: number
    /** Budget available to the prompt: `window - reserveOutput`. */
    readonly promptBudget: number
    /** History messages dropped to fit. Reported, never silent. */
    readonly droppedMessages: number
}

function block(
    slot: ContextBlock["slot"],
    role: ContextBlock["role"],
    content: string,
    pinned: boolean,
    label: string,
): ContextBlock {
    return { slot, role, content, pinned, tokens: estimateMessageTokens(content), label }
}

/**
 * What one history message costs.
 *
 * `content` is not the whole message under the `native` dialect: an assistant turn carries the
 * argument documents of the calls it made, and those are billed like any other tokens. Counting only
 * the content undercounts a tool-heavy history — the same invisible-cost mistake `wireTokens` exists
 * to correct for the catalogue, arriving here by a different route.
 */
function messageCost(message: ChatMessage): number {
    const calls = message.toolCalls
    if (calls === undefined || calls.length === 0) return estimateMessageTokens(message.content)
    return estimateMessageTokens(message.content) + estimateTokens(JSON.stringify(calls))
}

export function assembleContext(input: AssembleInput): AssembledContext {
    const promptBudget = Math.max(1, input.window - input.reserveOutput)

    const pinned: ContextBlock[] = []

    if (input.identity.trim() !== "") {
        pinned.push(block(SLOT.identity, "system", input.identity, true, "identity"))
    }
    for (const toolBlock of input.toolBlocks ?? []) pinned.push(toolBlock)
    if (input.configSummary !== undefined && input.configSummary.trim() !== "") {
        pinned.push(block(SLOT.config, "system", input.configSummary, true, "configuration"))
    }
    if (input.examples !== undefined && input.examples.trim() !== "") {
        pinned.push(block(SLOT.examples, "user", input.examples, true, "workspace-examples"))
    }
    if (input.volatile !== undefined && input.volatile.trim() !== "") {
        // Framed, never bare. See VOLATILE_HEADER: a small model asked "do you know me?" answered
        // no, with the answer sitting unlabelled in this very block.
        pinned.push(
            block(
                SLOT.volatile,
                "system",
                `${VOLATILE_HEADER}\n\n${input.volatile}`,
                true,
                "workspace-volatile",
            ),
        )
    }
    for (const entry of input.skills ?? []) {
        if (entry.content.trim() === "") continue
        pinned.push(
            block(
                SLOT.skill,
                entry.role,
                `${skillHeader(entry.name)}\n\n${entry.content}`,
                false,
                `skill:${entry.name}`,
            ),
        )
    }
    // In the budget like everything else, but `pinned: false`: Tier 3 is retrieved, never carried,
    // so compaction may drop it where it must never drop a workspace tier.
    for (const entry of input.knowledge ?? []) {
        if (entry.content.trim() === "") continue
        pinned.push(
            block(SLOT.knowledge, "system", entry.content, false, `knowledge:${entry.name}`),
        )
    }
    // Slot 7, retrieved: unpinned for the same reason knowledge is, and framed so the model can tell a
    // remembered fact from an instruction. One block per passage, so compaction can drop the weakest
    // rather than all of them.
    //
    // A note and a conversation excerpt get **different** sentences, and the reason is measured. With one
    // frame for both, an agent handed three excerpts of its own earlier sessions answered the question
    // correctly and then added *"that's what the saved notes say; the actual transcripts don't carry
    // over"* — a wrong statement about its own state, made while holding the transcripts. `From
    // session:local:3c2dc5, learned …` requires the model to decode a source string to work out what it
    // is looking at, and it decoded it wrongly. Naming it is the `VOLATILE_HEADER` lesson: a fact with no
    // frame is a fact a small model will not connect to the question. Structure only — the passage's own
    // words are untouched, which is the line decision 4.19 draws.
    //
    // `isSessionSource` is imported rather than a `kind` field being threaded down from `#recall`,
    // deliberately: five separate debugging rounds here have gone to a field declared in one place and
    // dropped by a conditional spread in another, and the source string already carries the answer.
    for (const passage of input.memory ?? []) {
        if (passage.text.trim() === "") continue
        const provenance = isSessionSource(passage.source)
            ? `From an earlier conversation in this session's store (${passage.source.slice(SESSION_SOURCE_PREFIX.length)}), on ${passage.at}:`
            : `From ${passage.source}, learned ${passage.at}:`
        pinned.push(
            block(
                SLOT.memory,
                "system",
                `# Remembered\n\n${provenance}\n\n${passage.text}`,
                false,
                `memory:${passage.source}`,
            ),
        )
    }
    if (input.reminder !== undefined && input.reminder.trim() !== "") {
        pinned.push(block(SLOT.reminder, "system", input.reminder, true, "workspace-reminder"))
    }
    const inputBlock = block(SLOT.input, "user", input.input, true, "input")
    pinned.push(inputBlock)
    if (input.lastError !== undefined && input.lastError !== "") {
        pinned.push(
            block(SLOT.error, "system", `Last error: ${input.lastError}`, true, "last-error"),
        )
    }

    const pinnedTokens = pinned.reduce((sum, b) => sum + b.tokens, 0)

    // Whatever the pinned blocks leave over goes to history, newest first.
    let remaining = promptBudget - pinnedTokens
    const kept: ChatMessage[] = []
    let dropped = 0

    // Clamped rather than trusted, like the ladder's: a caller reporting a longer tail than the
    // history it passed would otherwise protect a negative range.
    const tailFrom = Math.max(
        0,
        input.history.length -
            Math.max(0, Math.min(input.protectedTail ?? 0, input.history.length)),
    )

    for (let i = input.history.length - 1; i >= 0; i -= 1) {
        const message = input.history[i]
        if (message === undefined) continue
        const cost = messageCost(message)
        // The tail goes in whatever it costs. Over budget is a loud failure at the endpoint; a turn
        // reasoning about a tool result that was silently removed from its own prompt is not.
        if (cost > remaining && i < tailFrom) {
            dropped = i + 1
            break
        }
        remaining -= cost
        kept.unshift(message)
    }

    // What the person said, rescued from the dropped range.
    //
    // The walk above stops at the first message it cannot afford and drops everything older, which
    // keeps history contiguous — the property the ladder's `trim` docstring is about, since an
    // assistant turn answering a vanished call makes a model redo work. So the requests are re-added
    // afterwards rather than skipped during the walk: a run of `user` messages has no dangling pair.
    //
    // Kept for the reason `trim` keeps them: measured over a real session they are **0.3%** of
    // history, so dropping them frees nothing and costs the only record of what was asked. And this
    // path is reached exactly when the ladder fell short, which is the worst moment to also lose the
    // instruction. Found live rather than by reading — on an agent whose window could not fit its own
    // workspace the ladder could do nothing, and this trim was dropping the turn that set the task on
    // every single turn.
    // Two things here are allowed past `promptBudget`: the protected tail above, and these requests.
    // Both eat into `reserveOutput`, which is a reserve rather than a wall — but neither may pass the
    // *window*, which is one. Measured live at a 6,000-token window: with no ceiling the prompt reached
    // 6,424, which an endpoint whose real window is larger accepted silently and one whose window
    // matched would have refused. Newest-first, because the recent request is the live one.
    const ceiling = Math.max(promptBudget, input.window)
    let spent = pinnedTokens + kept.reduce((sum, message) => sum + messageCost(message), 0)
    const rescued: ChatMessage[] = []
    for (const message of input.history.slice(0, dropped).filter(isTurnStart).reverse()) {
        const cost = messageCost(message)
        if (spent + cost > ceiling) break
        spent += cost
        rescued.unshift(message)
    }
    kept.unshift(...rescued)
    // What was reported as lost is what was actually lost, so the count and the prompt agree.
    const droppedMessages = dropped - rescued.length

    // Carrying the message itself, not just its role and content. A `tool` observation names the call
    // it answers and an assistant turn carries the calls it made; a block describes neither, so
    // rebuilding messages from blocks alone would quietly strip both back out on the next step.
    const historyBlocks = kept.map((message) => ({
        ...block(SLOT.history, message.role, message.content, false, "history"),
        // `tokens` from the same function the trimming loop used, so the reported total and the budget
        // that produced it cannot disagree about what a message costs.
        tokens: messageCost(message),
        message,
    }))

    // Slot order, not insertion order: 0–3 lead so the cached prefix is the same bytes every
    // turn, 4 opens the uncached region, and the pinned tail follows the history it applies to.
    const blocks = [
        ...pinned.filter((b) => b.slot === SLOT.identity),
        ...pinned.filter((b) => b.slot === SLOT.tools),
        ...pinned.filter((b) => b.slot === SLOT.config),
        ...pinned.filter((b) => b.slot === SLOT.examples),
        ...pinned.filter((b) => b.slot === SLOT.volatile),
        ...pinned.filter((b) => b.slot === SLOT.skill),
        ...pinned.filter((b) => b.slot === SLOT.knowledge),
        ...pinned.filter((b) => b.slot === SLOT.memory),
        ...historyBlocks,
        ...pinned.filter((b) => b.slot === SLOT.reminder),
        ...pinned.filter((b) => b.slot === SLOT.input || b.slot === SLOT.error),
    ]

    // Every block that was built must appear in the output, and this is a real defect it catches
    // rather than a defensive flourish. The list above is an *explicit* slot ordering, so a new slot
    // pushed into `pinned` but forgotten here is silently discarded — after being counted in
    // `pinnedTokens`, which means it takes budget away from the history and produces no other symptom.
    // `SLOT.memory` was exactly that for the length of one debugging round: the passage was retrieved,
    // ranked, selected, charged for, and never sent.
    if (blocks.length !== pinned.length + historyBlocks.length) {
        const missing = pinned
            .filter((b) => !blocks.includes(b))
            .map((b) => `${b.label} (slot ${b.slot})`)
        throw new Error(
            `assembleContext built ${pinned.length + historyBlocks.length} blocks and emitted ` +
                `${blocks.length}: ${missing.join(", ")} did not match any slot in the ordering. ` +
                "hint: a slot added to SLOT and pushed into `pinned` must also be listed in the " +
                "`blocks` array below, or it costs prompt budget and reaches nothing.",
        )
    }

    return {
        blocks,
        messages: blocks.map((b) => b.message ?? { role: b.role, content: b.content }),
        totalTokens: blocks.reduce((sum, b) => sum + b.tokens, 0),
        promptBudget,
        droppedMessages,
    }
}

/** Slot-level report for `GET /v1/agents/:id/context` and the `context.assembled` event. */
export function slotReport(
    blocks: readonly ContextBlock[],
): { slot: number; label: string; tokens: number; pinned: boolean }[] {
    // `label` is carried because slot numbers are positional: inserting a slot renumbers the ones
    // after it, so a consumer that reads meaning from the number breaks the next time one is added.
    // `ContextBlock.label` was documented as existing for this endpoint and then not sent to it.
    const bySlot = new Map<
        number,
        { slot: number; label: string; tokens: number; pinned: boolean }
    >()
    for (const b of blocks) {
        const existing = bySlot.get(b.slot)
        if (existing === undefined) {
            bySlot.set(b.slot, { slot: b.slot, label: b.label, tokens: b.tokens, pinned: b.pinned })
        } else {
            existing.tokens += b.tokens
        }
    }
    return [...bySlot.values()].sort((a, b) => a.slot - b.slot)
}

export { estimateTokens }
