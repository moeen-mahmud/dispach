/**
 * Events in, view state out. Pure, and the only place that decides what a turn looks like.
 *
 * The CLI has always been a `runtime.bus` subscriber; this makes it a *reducer* over that bus
 * instead of a set of callbacks writing to stdout. Three things follow from that:
 *
 * - "What does the reader see when a turn errors mid-stream?" is a unit test rather than something
 *   reproduced by hand against a live endpoint.
 * - Finished items are append-only and immutable, which is exactly the contract Ink's `<Static>`
 *   needs: a node written once and never re-rendered. The still-moving reply lives in `live`, so
 *   the dynamic region stays one item regardless of how long the conversation gets.
 * - Phase 4's SSE client and Phase 12's TUI client can consume the same reduction instead of
 *   re-deriving it.
 *
 * No clock and no randomness: ids come from a counter in the state, so the same events always
 * produce the same output and the tests need no fakes.
 */

import { type AnyEvent, endNote } from "@dispach/core"
import { MAX_TRANSCRIPT_ITEMS, REASONING_FOLD_ROWS } from "#lib/const"
import { ROLE_PREFIX } from "#lib/theme"
import type {
    TranscriptItem,
    TranscriptRole,
    TranscriptRow,
    TranscriptState,
    TurnStats,
} from "#lib/types"
import { wrapText } from "#lib/wrap"

/**
 * The transcript is driven by more than the bus — a typed line and a cancellation request are not
 * events — so the reducer takes an action union rather than an event directly.
 */
export type TranscriptAction =
    | { readonly kind: "user"; readonly text: string }
    | { readonly kind: "event"; readonly event: AnyEvent }
    | { readonly kind: "note"; readonly text: string }
    | { readonly kind: "cancelling" }
    /**
     * A model delta that has already been through the dialect's stream filter.
     *
     * Filtering cannot happen in here: a filter is stateful and this reducer is pure. So the caller
     * owns one per step and dispatches what is left. A caller that dispatches the raw `model.chunk`
     * event instead still works — it just shows the invocation blocks, which is right for a dialect
     * with no in-band protocol and wrong for NLT.
     */
    | { readonly kind: "delta"; readonly of: "text" | "reasoning"; readonly text: string }
    /**
     * Drop the oldest items if the buffer is over `MAX_TRANSCRIPT_ITEMS`.
     *
     * An action rather than something `append` does on its own, because whether it is *safe* depends on
     * a fact this reducer cannot see: rows are addressed by position, so dropping any from the front
     * moves every offset below them. A reader parked twelve turns back would keep their offset and
     * silently start reading different text — the appearance of a live session that is not one, which is
     * the failure `ScrollState.pinned` exists to make impossible. Only the layer holding that flag knows
     * when eviction is allowed, so only it can ask.
     */
    | { readonly kind: "trim" }

export const EMPTY_TRANSCRIPT: TranscriptState = {
    items: [],
    live: undefined,
    status: "idle",
    nextId: 0,
    turnFrom: undefined,
}

function append(
    state: TranscriptState,
    role: TranscriptRole,
    text: string,
    extra: {
        readonly stats?: TurnStats
        readonly callId?: string
        readonly pending?: boolean
    } = {},
): TranscriptState {
    const item: TranscriptItem = {
        id: `t${state.nextId}`,
        role,
        text,
        ...(extra.stats === undefined ? {} : { stats: extra.stats }),
        ...(extra.callId === undefined ? {} : { callId: extra.callId }),
        ...(extra.pending === undefined ? {} : { pending: extra.pending }),
    }
    return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
}

/**
 * Commit whatever the model has streamed so far, and clear it.
 *
 * Called at each step boundary rather than once at the end of the turn, which is what puts the
 * transcript back in the order things happened. Committing at `turn.end` alone produced a turn shaped
 * "every tool row, then all the reasoning, then all the text" — so the reasoning that *decided* to call
 * a tool was printed below the tool's result, and step one's reasoning was concatenated onto step two's
 * with no break between them. Live output on a real turn read `…look for it in my workspace.The user is
 * asking me to…`, two sentences from two steps with nothing marking the join.
 *
 * Reasoning goes in ahead of the text it produced. Whether it is *shown* is the view's business — the
 * item is written either way, so `--show-reasoning` can be honoured after the fact.
 */
function flushLive(state: TranscriptState): TranscriptState {
    const live = state.live
    if (live === undefined) return state
    let next = state
    if (live.reasoning !== "") next = append(next, "reasoning", live.reasoning)
    if (live.text !== "") next = append(next, "assistant", live.text)
    return { ...next, live: undefined }
}

/** `data` is typed per event in core's map; narrowing by `type` first is what makes this safe. */
export function reduce(state: TranscriptState, action: TranscriptAction): TranscriptState {
    switch (action.kind) {
        case "user":
            return append(state, "user", action.text)

        case "note":
            return append(state, "note", action.text)

        case "cancelling":
            // A state, not an item. Cancellation that produced partial text still ends in a
            // `turn.end`, and that is what commits the text.
            return state.status === "idle" ? state : { ...state, status: "cancelling" }

        case "delta":
            return applyDelta(state, action.of, action.text)

        case "event":
            return reduceEvent(state, action.event)

        case "trim":
            return trim(state)
    }
}

/**
 * The oldest items above the cap, dropped. Identity when there is nothing to do.
 *
 * Returning the same object rather than a copy is what makes this cheap to ask about: `useReducer`
 * compares by reference and skips the render, so the caller can dispatch on every change without
 * checking first — and a caller that has to check first is a caller that eventually forgets.
 *
 * The banner is an ordinary item and goes with the rest. It is four hundred turns of scrollback above
 * the reader by then, and exempting it would leave the session's opening line pinned above a
 * conversation it no longer describes.
 */
function trim(state: TranscriptState): TranscriptState {
    const over = state.items.length - MAX_TRANSCRIPT_ITEMS
    return over <= 0 ? state : { ...state, items: state.items.slice(over) }
}

function applyDelta(
    state: TranscriptState,
    kind: "text" | "reasoning",
    delta: string,
): TranscriptState {
    if (delta === "") return state
    const live = state.live ?? { text: "", reasoning: "", last: undefined }
    return {
        ...state,
        live: {
            text: kind === "text" ? live.text + delta : live.text,
            reasoning: kind === "reasoning" ? live.reasoning + delta : live.reasoning,
            last: kind,
        },
        // A cancellation already asked for is not undone by another token arriving in flight; the
        // request stands until the turn actually ends.
        status: state.status === "cancelling" ? "cancelling" : "streaming",
    }
}

function reduceEvent(state: TranscriptState, event: AnyEvent): TranscriptState {
    switch (event.type) {
        case "turn.start":
            return {
                ...state,
                live: { text: "", reasoning: "", last: undefined },
                status: "thinking",
                turnFrom: state.items.length,
            }

        case "model.result":
            // The step boundary. `model.result` is emitted once per model call, so this is where a step's
            // reasoning and text stop growing — no new event was needed to find it.
            return flushLive(state)

        case "model.chunk":
            return applyDelta(state, event.data.kind, event.data.delta)

        case "tool.call":
            // Committed the moment the call starts, not when it returns: a tool that takes eight
            // seconds must not leave the screen looking like a stalled model. Anything the model
            // streamed before deciding to call it is flushed first, so the reasoning sits above the
            // call it explains rather than below the call's result.
            return {
                ...append(
                    flushLive(state),
                    "tool",
                    `${event.data.slug}${event.data.mutating ? " (changes state)" : ""}`,
                    { callId: event.data.callId, pending: true },
                ),
                status: state.status === "cancelling" ? "cancelling" : "working",
            }

        case "tool.result": {
            const { slug, callId, ok, latencyMs, truncated } = event.data
            const text = `${slug} — ${ok ? "ok" : "failed"} · ${latencyMs} ms${truncated ? " · observation trimmed" : ""}`
            // The call's own row, completed. Matched on `callId` rather than on position, because calls
            // can overlap and "the last tool row" is then not the row this result belongs to.
            const at = state.items.findIndex(
                (item) => item.callId === callId && item.pending === true,
            )
            if (at === -1) {
                // No row to complete — a result for a call this transcript never saw. Appended rather
                // than dropped: an observation nobody can account for is exactly the thing worth seeing.
                return append(state, ok ? "tool" : "error", text)
            }
            const items = [...state.items]
            const item = items[at] as TranscriptItem
            items[at] = { id: item.id, role: ok ? "tool" : "error", text, callId }
            return { ...state, items }
        }

        case "tool.gated":
            // Deliberately visible. A blocked write is the one tool outcome a person must not have
            // to go looking for — and it is a `note` rather than an `error` because the wire spec is
            // explicit that this is not one: the turn continues and the model reports back.
            return append(state, "note", `${event.data.slug} — blocked: ${event.data.reason}`)

        case "tool.repair":
            // A silent repair is indistinguishable from a slow turn, and it costs a whole step.
            return append(
                state,
                "note",
                `${event.data.slugs.join(", ")} — could not be used, asking the model again`,
            )

        case "model.retry": {
            const { status, attempt, delayMs } = event.data
            return append(
                state,
                "note",
                `retrying after HTTP ${status} — attempt ${attempt}, waiting ${delayMs} ms`,
            )
        }

        case "turn.end": {
            const { reason, steps, tokens, durationMs } = event.data
            const stats: TurnStats = {
                promptTokens: tokens.prompt,
                outputTokens: tokens.output,
                durationMs,
                steps,
                reason,
            }

            // Whatever the last step streamed but never got a `model.result` for — a cancelled turn, or
            // one that ended on an error mid-stream. On a clean turn this is a no-op, because each step
            // committed itself as it finished.
            const next = flushLive(state)
            const from = state.turnFrom ?? 0
            // The reply this turn produced, which is where its cost belongs. Searched from the turn's own
            // first item: without that floor, a turn that produced no text would hang its statistics on
            // the *previous* turn's reply, which reads as that reply having cost twice.
            let reply = -1
            for (let at = next.items.length - 1; at >= from; at -= 1) {
                if (next.items[at]?.role === "assistant") {
                    reply = at
                    break
                }
            }
            // Why the turn stopped, from the formatter the plain path uses. Until this existed
            // `stats.reason` reached the reducer and was rendered nowhere, so a turn the step budget
            // cut off looked exactly like a completed one — which is how an agent came to stop
            // mid-task on "Let me install it" with nothing on screen explaining it.
            const why = endNote(reason, { steps, durationMs })

            if (reply === -1) {
                // A turn that produced nothing is not a normal outcome and must not look like one.
                const said = append(
                    next,
                    "note",
                    why ?? (reason === "final" ? "the model returned no text" : ""),
                    { stats },
                )
                return { ...said, live: undefined, status: "idle", turnFrom: undefined }
            }
            const items = [...next.items]
            const item = items[reply] as TranscriptItem
            items[reply] = { ...item, stats }
            const settled: TranscriptState = {
                ...next,
                items,
                live: undefined,
                status: "idle",
                turnFrom: undefined,
            }
            // Below the reply, not attached to it: the reply is what the model said, and this is what
            // the runtime did. Attaching it to the item would put a harness sentence in the model's
            // voice — the distinction `note` exists for.
            return why === undefined ? settled : append(settled, "note", why)
        }

        case "agent.error":
        case "error": {
            const { code, message, hint } = event.data
            return append(state, "error", `${code}: ${message}\nhint: ${hint}`)
        }

        case "context.dropped": {
            const { messages, budget } = event.data
            // A note, not a stage line: the ladder decided what to compact and this is the budget
            // running out regardless. Worth saying because the agent is now answering without part of
            // the conversation, and nothing else on any surface would mention it.
            return append(
                state,
                "note",
                `context: ${messages} older message(s) did not fit the ${budget}-token budget and were left out`,
            )
        }

        case "agent.warning": {
            const { code, message } = event.data
            return append(state, "note", `${code}: ${message}`)
        }

        case "context.pressure":
            // A gauge, so it replaces rather than accumulates. `source` is deliberately not shown: it
            // is diagnostic and the status line has no room for a word that changes nothing a person
            // would do — it is on the event for whoever is reading events.
            return { ...state, pressure: event.data.fraction }

        case "compaction.stage": {
            const { stage, changed, before, after } = event.data
            // Only the stages that destroy detail get a line. trim, snip and micro are recoverable —
            // the conversation is still in the store and a snipped observation keeps a pointer — while
            // collapse and reset replace a span of the conversation with a summary, and a person who
            // was not watching the gauge still needs to know that happened.
            if (!changed || (stage !== "collapse" && stage !== "reset")) return state
            const what =
                stage === "reset"
                    ? "the conversation so far was replaced by a summary"
                    : "earlier turns were replaced by a summary"
            return append(state, "note", `context: ${what} (${before} → ${after} tokens)`)
        }

        case "phase.changed": {
            const { to, tools } = event.data
            // A line *and* the gauge. The line because a phase change is the reason the agent's
            // abilities changed mid-conversation, and a person scrolling back needs it where it
            // happened; the gauge because "which phase am I in" is a current-state question.
            const next = append(
                state,
                "note",
                `phase: now in ${to} · ${tools} tool${tools === 1 ? "" : "s"} available`,
            )
            return { ...next, phase: to }
        }

        case "context.reset": {
            const { warning } = event.data
            // The count itself is not shown — the note above already said what happened. A *second*
            // reset is a configuration problem rather than a busy session, and that is worth a line.
            return warning === undefined ? state : append(state, "note", `context: ${warning}`)
        }

        default:
            // Boot and bookkeeping events — `runtime.ready`, `store.ready`, `model.call`,
            // `context.assembled`. They belong to the banner and the status bar, not the transcript. Ignored explicitly so that a new event type added in a later
            // phase is inert here rather than a crash.
            return state
    }
}

/** What a renderer writes for a turn's cost. Kept here so the plain and rich paths agree. */
export function formatStats(stats: TurnStats): string {
    return `${stats.promptTokens} prompt · ${stats.outputTokens} output · ${stats.durationMs} ms`
}

/**
 * Opening banner — version, session, store, any turn a previous process left unfinished.
 *
 * One `banner` item rather than N notes, so the rich renderer can box it as a unit. The plain
 * path never calls this — it writes the lines directly — so plain output is unchanged by the
 * boxing.
 */
export function seed(notes: readonly string[]): TranscriptState {
    if (notes.length === 0) return EMPTY_TRANSCRIPT
    return append(EMPTY_TRANSCRIPT, "banner", notes.join("\n"))
}

/** One earlier message, as much of it as a transcript row needs. */
export interface PriorMessage {
    readonly role: "user" | "assistant"
    readonly text: string
}

/**
 * Put the conversation that already happened on the screen.
 *
 * Resuming used to paint an empty transcript over a full history: the messages reached the *model* and
 * never the person, so the banner said `17 message(s)` above a blank screen and the only honest reading
 * was that something had been lost. Rendering them is what makes that count verifiable.
 *
 * A separate function rather than a second argument to `seed`, because an optional parameter here would
 * have to distinguish "no history" from "not asked for" — and under `exactOptionalPropertyTypes` a
 * default parameter fires on an explicitly passed `undefined`, which has already cost this repo a
 * debugging round. `seedHistory(seed(banner), prior)` composes with nothing to remember.
 *
 * **Prose only.** Tool calls and observations are left out for the same reason they are left out of the
 * memory index: an observation is a wall of text a stranger wrote, and replaying forty of them above the
 * composer buries the conversation the person came back for. The turn statistics are left off too — they
 * were true of a process that has exited, and a cost line under a resumed reply reads as this session's.
 */
export function seedHistory(
    state: TranscriptState,
    messages: readonly PriorMessage[],
): TranscriptState {
    let next = state
    for (const message of messages) {
        if (message.text.trim() === "") continue
        next = append(next, message.role, message.text)
    }
    return next
}

/** The most recent completed turn's cost, for the status bar. */
export function lastStats(items: readonly TranscriptItem[]): TurnStats | undefined {
    for (let i = items.length - 1; i >= 0; i -= 1) {
        const stats = items[i]?.stats
        if (stats !== undefined) return stats
    }
    return undefined
}

// ─── the finished conversation, as rows ──────────────────────────────────────────────────

/**
 * Flatten items into the rows a windowed transcript scrolls through.
 *
 * ## Why rows rather than items
 *
 * Scrolling by item is the cheaper thing to build and the wrong unit. One assistant reply is a single
 * item and forty rows on screen, so an item-indexed window either shows the whole answer or none of it —
 * page-up from the bottom of a long reply would jump over the entire thing and land on the question
 * before it. Rows are what a reader moves through, so rows are what the offset counts.
 *
 * Wrapping happens here, not in Ink. A window has to know its content's height before it draws any of
 * it, and a count Ink might disagree with is a window off by however many lines wrapped — which shows up
 * as the last line of a reply hidden under the composer, intermittently, depending on the text.
 *
 * Pure, and one derivation for both halves of the frame: the component renders these rows and the layout
 * asks how many there are.
 */
export function transcriptRows(
    items: readonly TranscriptItem[],
    options: {
        readonly showReasoning: boolean
        readonly quiet: boolean
        readonly columns: number
        /** Reasoning blocks are shown whole rather than folded to `REASONING_FOLD_ROWS`. */
        readonly expandReasoning?: boolean
    },
): readonly TranscriptRow[] {
    const rows: TranscriptRow[] = []
    const visible = items.filter((item) => item.role !== "reasoning" || options.showReasoning)

    for (const [at, item] of visible.entries()) {
        // A blank row between items, and never a trailing one. The rich transcript is read rather than
        // grepped, and two turns that touch each other read as one wall of text; a blank row at the end
        // would instead be a permanent gap above the composer.
        if (at > 0) rows.push({ key: `${item.id}:gap`, role: item.role, text: "" })

        if (item.role === "banner") {
            // The banner keeps its content and loses its border. A bordered box inside a windowed list
            // costs two rows this module cannot count — Ink measures the frame, not us — and the frame
            // was decoration on a surface that is now itself a frame.
            const [title = "", ...lines] = item.text.split("\n")
            rows.push({ key: `${item.id}:title`, role: "banner", text: title, bold: true })
            for (const [n, line] of lines.entries()) {
                for (const [w, wrapped] of wrapText(line, options.columns).entries()) {
                    rows.push({
                        key: `${item.id}:note-${n}-${w}`,
                        role: "banner",
                        text: wrapped,
                        dim: true,
                    })
                }
            }
            continue
        }

        const prefix = ROLE_PREFIX[item.role]
        const pad = " ".repeat([...prefix].length)
        // The prefix is part of the first row's width and an indent on every row after it, so a reply
        // that wraps stays in one column instead of reading as a second message.
        const body = wrapText(item.text, Math.max(1, options.columns - [...prefix].length))

        if (item.role === "reasoning") {
            // A header row and an indented body, rather than a label wide enough to be the indent. Folded
            // unless asked for: the block is secondary, and at full length it routinely fills the screen
            // and pushes the reply it produced out of sight.
            const shown =
                options.expandReasoning === true
                    ? body.length
                    : Math.min(body.length, REASONING_FOLD_ROWS)
            const folded = body.length - shown
            rows.push({
                key: `${item.id}:label`,
                role: "reasoning",
                dim: true,
                text:
                    folded > 0
                        ? `· reasoning · ${body.length} rows · ⌥r expands`
                        : `· reasoning · ${body.length} row${body.length === 1 ? "" : "s"}`,
            })
            for (const [n, line] of body.slice(0, shown).entries()) {
                rows.push({ key: `${item.id}:${n}`, role: "reasoning", text: `${pad}${line}` })
            }
            if (folded > 0) {
                rows.push({
                    key: `${item.id}:folded`,
                    role: "reasoning",
                    dim: true,
                    text: `${pad}… ${folded} more row${folded === 1 ? "" : "s"}`,
                })
            }
            continue
        }

        for (const [n, line] of body.entries()) {
            rows.push({
                key: `${item.id}:${n}`,
                role: item.role,
                text: `${n === 0 ? prefix : pad}${line}`,
            })
        }

        if (item.stats !== undefined && !options.quiet) {
            rows.push({
                key: `${item.id}:stats`,
                role: item.role,
                text: `  ${formatStats(item.stats)}`,
                dim: true,
            })
        }
    }

    return rows
}
