/**
 * Turning a turn's event stream into rows, as a pure reducer.
 *
 * Pure because it is the only part of this UI worth testing: React renders it, `bun test` exercises
 * it, and the two cannot disagree. The TUI's chat reducer is the same shape and this is not shared
 * with it — `cli/src/lib/scroll.ts` is a *window over rows in a terminal*, which a browser gets from
 * the scrollbar for free, so reusing it would mean carrying an offset model to solve a problem that
 * does not exist here. What transfers is the set of mistakes it made, each of which is a rule below.
 *
 * ## Four rules learned in the terminal, all of them non-obvious
 *
 * 1. **`model.result` is the step boundary, not `turn.end`.** Committing accumulated text once at
 *    the end of a turn destroys its chronology: every tool row lands first and all the reasoning
 *    after it, so the reasoning that *decided* to call a tool prints below that tool's result, and
 *    step one's prose concatenates onto step two's with nothing marking the join.
 * 2. **A tool result is paired to its call on `callId`.** Calls overlap, so "the last tool row" is
 *    not the row a result belongs to.
 * 3. **A turn's ending is a row, not a silence.** `stats.reason` reached the terminal transcript and
 *    was rendered nowhere for three phases, which made a turn stopped by its step budget
 *    pixel-identical to a completed one.
 * 4. **An approval is a row in the transcript**, not a modal. It happened at a point in the
 *    conversation, the answer belongs beside what prompted it, and a modal that is dismissed leaves
 *    a turn suspended with nothing on screen explaining why.
 */

import type { TurnStreamItem } from "@dispach/client"
import {
    type AnyEvent,
    createNltStreamFilter,
    type EventDataMap,
    endedBadly,
    endNote,
    passThroughFilter,
    type StreamFilter,
} from "@dispach/core/wire"

export type Row =
    | { readonly kind: "user"; readonly id: string; readonly text: string }
    /** Model prose. One row per model call, so two steps never merge into one paragraph. */
    | { readonly kind: "reply"; readonly id: string; readonly text: string }
    /** Thinking, when the model reports it. Folded in the UI; a row here either way. */
    | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
    | {
          readonly kind: "tool"
          readonly id: string
          readonly callId: string
          readonly slug: string
          /** Whether this call can change something. From the event, not inferred from the slug. */
          readonly mutating: boolean
          /** Absent until the result arrives — which is what makes a row show as still running. */
          readonly ok?: boolean
          readonly bytes?: number
          readonly truncated?: boolean
          readonly latencyMs?: number
          /**
           * The result was text a stranger wrote. The UI says so; the write gate is what holds.
           *
           * There is no `result` field on purpose: `tool.result` carries `bytes` and not the
           * observation, because the firehose is seen by every observer of a session and a tool's
           * output can be anything. The text is in the stored session, on the reattach path.
           */
          readonly untrusted?: boolean
      }
    | {
          readonly kind: "approval"
          readonly id: string
          readonly approvalId: string
          readonly slug: string
          readonly match?: string
          readonly reason: string
          readonly settled?: "granted" | "denied" | "abandoned" | "error"
      }
    /** How the turn ended, and anything the runtime wanted a person to read. */
    | { readonly kind: "note"; readonly id: string; readonly text: string; readonly bad: boolean }

export interface Transcript {
    /**
     * Strips the dialect's in-band call markup out of the token stream.
     *
     * **The wire is deliberately unfiltered**, so this is the client's job — see the note on the
     * export in `core/src/wire/index.ts`. Without it a real turn puts `ACTION: now / format: human
     * / END` in a chat bubble, which is exactly what happened before this existed; the CLI does the
     * same work at `cli/src/run.ts:821` with the same three calls.
     *
     * Held on the transcript rather than in a closure because it is **stateful across chunks** — it
     * withholds a partial `ACTION` until it knows whether the line is prose — so a reducer making a
     * fresh one per event would filter nothing at all.
     */
    readonly filter: StreamFilter
    readonly rows: readonly Row[]
    /** Text arriving token by token, not yet committed to a row. Rendered as the tail. */
    readonly live: string
    /** Reasoning arriving token by token. Separate, because it is folded separately. */
    readonly liveReasoning: string
    /** Whether a turn is in flight, so the composer can say so. */
    readonly running: boolean
    /** Set when a replay lost its front, so the UI can say the text is incomplete. */
    readonly truncated: boolean
}

/**
 * A fresh transcript for one dialect.
 *
 * `native` needs no filter — the call is in `toolCalls` and never in the text — and saying so here
 * rather than filtering anyway is `proseOf`'s own reasoning: a parse that cannot change the answer
 * is a line somebody later reads as necessary.
 */
export function emptyFor(dialect: string): Transcript {
    return { ...EMPTY, filter: dialect === "nlt" ? createNltStreamFilter() : passThroughFilter() }
}

export const EMPTY: Transcript = {
    filter: passThroughFilter(),
    rows: [],
    live: "",
    liveReasoning: "",
    running: false,
    truncated: false,
}

let counter = 0
/** Row ids are local and monotonic — React keys only. Never shown, never sent anywhere. */
function nextId(): string {
    counter += 1
    return `r${counter}`
}

export function withUser(state: Transcript, text: string): Transcript {
    return {
        ...state,
        rows: [...state.rows, { kind: "user", id: nextId(), text }],
        running: true,
    }
}

/**
 * Fold one stream item in.
 *
 * Returns the **same object** when there is nothing to do, so React can skip a render on the
 * frames this UI does not draw — the same "identical state when nothing changed" property the
 * TUI's scroll reducer needs for a different reason.
 */
export function reduce(state: Transcript, item: TurnStreamItem): Transcript {
    switch (item.kind) {
        case "accepted":
            return state
        case "replay":
            // A hole is known *before* text is assembled from what follows, which is the whole
            // reason the preamble arrives first.
            return item.report.truncated ? { ...state, truncated: true } : state
        case "ended":
            return {
                ...state,
                running: false,
                rows: [
                    ...state.rows,
                    {
                        kind: "note",
                        id: nextId(),
                        text: `This turn finished before the page attached — ${item.status}. Its reply is stored.`,
                        bad: item.status !== "final",
                    },
                ],
            }
        case "unavailable":
            return {
                ...state,
                running: false,
                rows: [...state.rows, { kind: "note", id: nextId(), text: item.reason, bad: true }],
            }
        case "event":
            return onEvent(state, item.event)
    }
}

function onEvent(state: Transcript, event: AnyEvent): Transcript {
    switch (event.type) {
        case "turn.start":
            return { ...state, running: true }

        case "model.chunk": {
            const data = event.data as EventDataMap["model.chunk"]
            // Reasoning is not filtered: it is the model's own thinking channel and carries no
            // invocation, so pushing it through would make the filter withhold a line that is never
            // going to become a call.
            if (data.kind === "reasoning")
                return { ...state, liveReasoning: state.liveReasoning + data.delta }
            const shown = state.filter.push(data.delta)
            return shown === "" ? state : { ...state, live: state.live + shown }
        }

        /**
         * The step boundary. Rule 1 — this is what keeps a multi-step turn in the order it
         * happened, and it needs no event that did not already exist.
         */
        /**
         * The step boundary, and **both `endStep()` and `end()` are called — which took three
         * wrong answers to establish.**
         *
         * `endStep()` is not optional: without it the filter's parse state does not reset after a
         * completed `ACTION` block, and **every following step's prose is silently swallowed**.
         * Measured directly — push a block, skip `endStep`, push ordinary prose, and the filter
         * returns `""`. Found by streaming a real two-step turn and getting `reasoning → tool →
         * reasoning` with the answer missing, while the stored turn held it in full.
         *
         * The reason that is easy to get wrong is worth keeping. An earlier probe pushed *prose*
         * through step one, which never enters the block state, so skipping `endStep` looked
         * harmless — and two revert-checks agreed, because no fixture had a completed block
         * followed by another step. **An incomplete probe is a measurement of the wrong thing**, and
         * this one cost three rounds.
         *
         * Its cost is real and is paid in `commit`: `endStep` queues the blank line that separates
         * two steps' prose for a renderer building one growing string, so the next `push` returns
         * `"\n\nSecond answer."`. Each step is its own row here, so `commit` trims — which makes
         * both properties true at once rather than trading one for the other.
         *
         * `end()` costs nothing and is called for the contract rather than for this implementation:
         * this filter never withholds a partial, so there is nothing to release today, and a filter
         * that did would truncate the last reply of every turn without it.
         */
        case "model.result":
            return commit({ ...state, live: state.live + state.filter.endStep() })

        case "tool.call": {
            const data = event.data as EventDataMap["tool.call"]
            const committed = commit(state)
            return {
                ...committed,
                rows: [
                    ...committed.rows,
                    {
                        kind: "tool",
                        id: nextId(),
                        callId: data.callId,
                        slug: data.slug,
                        mutating: data.mutating,
                    },
                ],
            }
        }

        /**
         * Rule 2: matched on `callId`, never on position.
         *
         * And **the observation is not here either** — the event reports `bytes`, `truncated`,
         * `latencyMs`, `ok` and `trust`, for the same reason `tool.call` reports a hash: a tool's
         * output is the text a stranger wrote, and the firehose is not where it belongs. So a live
         * row says how a call went and how much it produced; the text is in the stored session.
         */
        case "tool.result": {
            const data = event.data as EventDataMap["tool.result"]
            const index = state.rows.findIndex(
                (row) => row.kind === "tool" && row.callId === data.callId,
            )
            if (index === -1) return state
            const row = state.rows[index]
            if (row === undefined || row.kind !== "tool") return state
            const rows = [...state.rows]
            rows[index] = {
                ...row,
                ok: data.ok,
                bytes: data.bytes,
                truncated: data.truncated,
                latencyMs: data.latencyMs,
                ...(data.trust === "untrusted" ? { untrusted: true } : {}),
            }
            return { ...state, rows }
        }

        /** Rule 4: a row where it happened, so answering it is answering something visible. */
        case "approval.requested": {
            const data = event.data as EventDataMap["approval.requested"]
            const committed = commit(state)
            return {
                ...committed,
                rows: [
                    ...committed.rows,
                    {
                        kind: "approval",
                        id: nextId(),
                        approvalId: data.approvalId,
                        slug: data.slug,
                        ...(data.match === undefined ? {} : { match: data.match }),
                        reason: data.reason,
                    },
                ],
            }
        }

        case "approval.resolved": {
            const data = event.data as EventDataMap["approval.resolved"]
            const index = state.rows.findIndex(
                (row) => row.kind === "approval" && row.approvalId === data.approvalId,
            )
            if (index === -1) return state
            const row = state.rows[index]
            if (row === undefined || row.kind !== "approval") return state
            const rows = [...state.rows]
            // `by` rather than `granted` alone, because a UI with a prompt on screen needs the
            // three outcomes apart: `abandoned` means take it down, `error` means the approver
            // itself is broken and the denial says nothing about what a person wanted.
            rows[index] = {
                ...row,
                settled:
                    data.by === "abandoned"
                        ? "abandoned"
                        : data.by === "error"
                          ? "error"
                          : data.granted
                            ? "granted"
                            : "denied",
            }
            return { ...state, rows }
        }

        /**
         * The turn failed, and this is the only event that says why.
         *
         * `endNote("error")` deliberately returns `undefined` — its comment reads "the `error` event
         * carries code, message and hint, and both paths render it in full". That was true of the two
         * CLI paths and **this is the third consumer**, which had no case for it at all: a turn that
         * died on the model call fell to `default`, `turn.end` added no note, `running` went false,
         * and the page showed a message going out and nothing coming back. Measured live in the
         * container — a 401 from the model endpoint, with a hint naming `model.main.apiKeyEnv`,
         * reaching a reader who could only conclude the product was broken.
         *
         * Same three lines the CLI renders, in the same order, so the two surfaces cannot describe
         * one failure differently.
         */
        case "error": {
            const data = event.data as EventDataMap["error"]
            const committed = commit({ ...state, live: state.live + state.filter.end() })
            return {
                ...committed,
                running: false,
                rows: [
                    ...committed.rows,
                    {
                        kind: "note",
                        id: nextId(),
                        text: `${data.code}: ${data.message}\nhint: ${data.hint}`,
                        bad: true,
                    },
                ],
            }
        }

        case "agent.warning": {
            const data = event.data as { message?: string }
            return {
                ...state,
                rows: [
                    ...state.rows,
                    { kind: "note", id: nextId(), text: data.message ?? "", bad: false },
                ],
            }
        }

        /**
         * Rule 3: an ending that is not `final` says so, rather than looking like a clean answer.
         *
         * **The sentence comes from core's `endNote`, because this is its fourth caller.** The event
         * carries `reason` and no prose — deliberately, since the CLI, the plain path and the
         * channel path all need the same words and three copies is how one turn came to be reported
         * three different ways, including not at all. Composing a fourth version here would be the
         * same mistake with a browser in front of it.
         */
        case "turn.end": {
            const data = event.data as EventDataMap["turn.end"]
            const committed = commit({ ...state, live: state.live + state.filter.end() })
            const note = endNote(data.reason, { steps: data.steps })
            return {
                ...committed,
                running: false,
                rows:
                    note === undefined
                        ? committed.rows
                        : [
                              ...committed.rows,
                              {
                                  kind: "note",
                                  id: nextId(),
                                  text: note,
                                  bad: endedBadly(data.reason),
                              },
                          ],
            }
        }

        default:
            return state
    }
}

/** Move whatever has streamed so far into rows. Identical state when there is nothing to move. */
function commit(state: Transcript): Transcript {
    if (state.live === "" && state.liveReasoning === "") return state
    const rows = [...state.rows]
    // Reasoning first: it is what produced the prose that follows, and reversing them reads as the
    // model explaining a decision it had already announced.
    const thinking = state.liveReasoning.trim()
    if (thinking !== "") rows.push({ kind: "reasoning", id: nextId(), text: thinking })
    // Trimmed, so a row never opens or closes with whitespace. Belt and braces against the
    // filter's step-join behaviour above, and against a model that pads its own prose.
    const prose = state.live.trim()
    if (prose !== "") rows.push({ kind: "reply", id: nextId(), text: prose })
    return { ...state, rows, live: "", liveReasoning: "" }
}
