/**
 * The bridge between the event bus and React state.
 *
 * The CLI has always subscribed to `runtime.bus`; this makes it a reducer over that bus rather than
 * a set of callbacks writing to stdout. All the interesting logic lives in `transcript.ts`, which is
 * pure and tested — this hook only owns the subscription, the abort controller, and the promise.
 */

import type { Agent, AnyEvent, EventBus } from "@dispach/core"
import { useCallback, useEffect, useReducer, useRef } from "react"
import type { TranscriptState } from "#lib/types"
import { reduce, type TranscriptAction } from "#transcript"

export interface UseTurn {
    readonly state: TranscriptState
    /** A turn is in flight. Drives the Ctrl-C contract and the status bar. */
    readonly busy: boolean
    send(text: string): void
    cancel(): void
    note(text: string): void
    /**
     * Drop the oldest items if the buffer is over its cap. Safe to call on every change — a buffer
     * under the cap returns identical state and React skips the render.
     *
     * Exposed rather than done inside the reducer because the caller owns the scroll state, and
     * eviction while somebody is parked in history would move rows under them. `App` calls this only
     * while following the tail.
     */
    trim(): void
}

export function useTurn(options: {
    readonly agent: Agent
    readonly bus: EventBus
    readonly sessionKey: string
    readonly initial: TranscriptState
}): UseTurn {
    const { agent, bus, sessionKey, initial } = options
    const [state, dispatch] = useReducer(reduce, initial)
    const controller = useRef<AbortController | undefined>(undefined)

    // A stream filter is stateful and the reducer is pure, so filtering happens here, on the way in.
    // Without it the live pane shows `ACTION:` and `END` and then commits them as the reply: with a
    // line-oriented dialect the invocation *is* text, and only the dialect knows which text.
    const filter = useRef(agent.streamFilter())

    useEffect(() => {
        // One wildcard subscription rather than six by name: the reducer already ignores what it
        // does not own, and a subscription list would silently miss any event a later phase adds.
        //
        // `{ chunks: true }` is not optional here and is the whole reason the TUI streams. A
        // wildcard subscriber receives no `model.chunk` unless it asks — because `/v1/events`, the
        // WebSocket bridge and every plugin watcher are also wildcard and must not be put on the
        // per-token path by accident. This is the one wildcard in the tree that genuinely wants
        // tokens; drop the flag and the TUI silently stops streaming, which is the same shape of
        // failure the per-subscriber opt-in was introduced to remove.
        return bus.on(
            "*",
            (event: AnyEvent) => {
                // Other sessions share this bus — from Phase 4, a channel can be delivering a turn for
                // a different peer while this prompt is open. An event with no session key is
                // runtime-wide and belongs to everyone.
                if (event.sessionKey !== undefined && event.sessionKey !== sessionKey) return

                // Reasoning is never parsed for tool calls, so it is never filtered for them either.
                if (event.type === "model.chunk") {
                    const { delta, kind } = event.data
                    if (kind === "reasoning") {
                        dispatch({ kind: "delta", of: "reasoning", text: delta })
                        return
                    }
                    dispatch({ kind: "delta", of: "text", text: filter.current.push(delta) })
                    return
                }

                // The filter owns the paragraph break between one step's narration and the next's, which
                // is why it is told where a step ends rather than being replaced at each one.
                if (event.type === "model.result") {
                    dispatch({ kind: "delta", of: "text", text: filter.current.endStep() })
                    return
                }

                if (event.type === "turn.end") {
                    // Flush before the reducer commits the reply, or the last line of it is lost.
                    dispatch({ kind: "delta", of: "text", text: filter.current.end() })
                    filter.current = agent.streamFilter()
                }

                dispatch({ kind: "event", event })
            },
            { chunks: true },
        )
    }, [agent, bus, sessionKey])

    const send = useCallback(
        (text: string) => {
            dispatch({ kind: "user", text })
            const next = new AbortController()
            controller.current = next
            // `send` resolves rather than rejects on abort, so cancellation is not an error path.
            // Anything that does reject got past the loop's own handling, and swallowing it would be
            // the silent failure hard rule 8 forbids — so it is reported and the prompt returns.
            agent
                .send(text, { sessionKey, signal: next.signal, source: "repl" })
                .catch((error: unknown) => {
                    dispatch({
                        kind: "event",
                        event: {
                            v: 1,
                            ts: new Date().toISOString(),
                            runtimeId: "cli",
                            sessionKey,
                            type: "error",
                            data: {
                                code: "cli_turn_failed",
                                message: error instanceof Error ? error.message : String(error),
                                hint: "This escaped the turn loop's own error handling. Re-run with DEBUG=1 for a stack trace.",
                            },
                        },
                    })
                })
                .finally(() => {
                    if (controller.current === next) controller.current = undefined
                })
        },
        [agent, sessionKey],
    )

    const cancel = useCallback(() => {
        const current = controller.current
        if (current === undefined || current.signal.aborted) return
        dispatch({ kind: "cancelling" })
        current.abort()
    }, [])

    const note = useCallback(
        (text: string) => dispatch({ kind: "note", text } as TranscriptAction),
        [],
    )

    const trim = useCallback(() => dispatch({ kind: "trim" }), [])

    return { state, busy: state.status !== "idle", send, cancel, note, trim }
}
