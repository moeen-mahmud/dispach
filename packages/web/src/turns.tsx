/**
 * Turns: every turn the agent has taken, newest first, across sessions, with how each ended.
 *
 * Props only. The listing already carries `input`, `text`, tokens, steps and the end reason, so a
 * row expands in place rather than fetching again. A turn that ended badly is marked by its reason,
 * never by colour alone — the reason is the one fact the TUI once rendered nowhere (CLAUDE.md,
 * "stats.reason reached the transcript and was rendered nowhere").
 */

import type React from "react"
import { useState } from "react"
import { Markdown } from "./Markdown.tsx"

export interface TurnRow {
    readonly turnId: string
    readonly sessionKey: string
    readonly status: string
    readonly input: string
    readonly text: string
    readonly steps: number
    readonly promptTokens: number
    readonly outputTokens: number
    readonly cachedPromptTokens?: number
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly errorHint?: string
    readonly sender?: string
    readonly senderName?: string
    readonly senderKind?: string
    readonly source?: string
    readonly startedAt?: string
    readonly durationMs?: number
    readonly note?: string
}

/** One stored message of a turn, as `GET …/sessions/:key/messages` returns it. */
export interface ReplayStep {
    readonly id: number
    readonly role: string
    readonly content: string
    readonly origin?: string
    /** Native dialect: the call itself lives here and `content` is often empty. */
    readonly toolCalls?: readonly { readonly name: string; readonly arguments: string }[]
}

/** A step's text: under `native` a call's `content` is empty and the call is in `toolCalls`. */
export function stepText(step: ReplayStep): string {
    const calls = (step.toolCalls ?? []).map((call) => `${call.name}(${call.arguments})`)
    return [step.content, ...calls].filter((part) => part !== "").join("\n")
}

/** A turn's replay: absent until asked for, `loading` while read, then its steps or why not. */
export type Replay =
    | { readonly state: "loading" }
    | { readonly state: "ready"; readonly steps: readonly ReplayStep[] }
    | { readonly state: "failed"; readonly message: string }

/** What a step is, in words: the runtime stamps the text it authored with an `origin`. */
export function stepLabel(step: ReplayStep): string {
    if (step.origin === "call") return "tool call"
    if (step.origin === "observation") return "tool result"
    if (step.origin === "repair") return "repair asked for"
    if (step.origin === "digest") return "compaction digest"
    return step.role === "user" ? "asked" : step.role === "assistant" ? "reply" : step.role
}

/** An observation can be a whole file; the replay shows the start and says it cut it. */
const STEP_CHARS = 4_000

const BAD = new Set(["max_steps", "no_progress", "truncated", "timeout", "error"])

export function endedBadly(status: string): boolean {
    return BAD.has(status)
}

/** `final` is the ordinary end and says nothing; every other status is a sentence. */
export function statusSentence(status: string): string {
    switch (status) {
        case "final":
            return "answered"
        case "running":
            return "still running"
        case "stopped":
            return "stopped by a person"
        case "max_steps":
            return "hit the step budget"
        case "no_progress":
            return "stopped for repeating itself"
        case "truncated":
            return "cut off by the output limit"
        case "timeout":
            return "timed out"
        case "error":
            return "failed"
        default:
            return status
    }
}

export function TurnsPanel(props: {
    readonly turns: readonly TurnRow[]
    readonly hasMore: boolean
    readonly loading?: boolean
    readonly onMore?: () => void
    readonly onOpenSession?: (sessionKey: string) => void
    /** Replays by turn id; a turn whose replay was never asked for has none. */
    readonly replays?: Readonly<Record<string, Replay>>
    readonly onReplay?: (turn: TurnRow) => void
}): React.ReactElement {
    const bad = props.turns.filter((turn) => endedBadly(turn.status)).length
    return (
        <>
            <div className="page-head">
                <h1>Turns</h1>
                <p>
                    Every turn this agent has taken, newest first, across every conversation and
                    schedule.{" "}
                    {bad > 0 ? `${bad} of the ${props.turns.length} shown ended badly.` : ""}
                </p>
            </div>
            {props.turns.length === 0 ? (
                props.loading ? (
                    <p className="empty">reading…</p>
                ) : (
                    <div className="empty-state">
                        <h3>No turns yet</h3>
                        <p>
                            The first message in Chat, a channel, or a schedule firing will appear
                            here.
                        </p>
                    </div>
                )
            ) : (
                <div className="turns">
                    {props.turns.map((turn) => (
                        <TurnCard
                            key={turn.turnId}
                            turn={turn}
                            {...(props.replays?.[turn.turnId] === undefined
                                ? {}
                                : { replay: props.replays[turn.turnId] })}
                            {...(props.onReplay === undefined ? {} : { onReplay: props.onReplay })}
                            {...(props.onOpenSession === undefined
                                ? {}
                                : { onOpenSession: props.onOpenSession })}
                        />
                    ))}
                </div>
            )}
            {props.hasMore && props.onMore !== undefined ? (
                <button
                    type="button"
                    style={{ marginTop: 14 }}
                    disabled={props.loading}
                    onClick={props.onMore}
                >
                    {props.loading ? "loading…" : "older turns"}
                </button>
            ) : null}
        </>
    )
}

function TurnCard(props: {
    readonly turn: TurnRow
    readonly replay?: Replay
    readonly onOpenSession?: (sessionKey: string) => void
    readonly onReplay?: (turn: TurnRow) => void
}): React.ReactElement {
    const { turn } = props
    const [open, setOpen] = useState(false)
    const bad = endedBadly(turn.status)
    const who =
        turn.senderName ??
        turn.sender ??
        (turn.source?.startsWith("schedule:") ? turn.source : undefined)
    return (
        <div className={`card turn${bad ? " bad" : ""}`}>
            <button
                type="button"
                className="turn-head"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <span
                    className={`pill ${bad ? "warn" : turn.status === "running" ? "accent" : "ok"}`}
                >
                    <span
                        className={`dot ${bad ? "warn" : turn.status === "running" ? "busy" : "live"}`}
                    />
                    {statusSentence(turn.status)}
                </span>
                <span className="turn-input">
                    {turn.input.length > 140
                        ? `${turn.input.slice(0, 140)}…`
                        : turn.input || "(no text)"}
                </span>
                <span className="turn-meta">
                    {turn.startedAt === undefined ? null : (
                        <span>{turn.startedAt.replace("T", " ").slice(0, 16)}</span>
                    )}
                    <span>
                        {turn.steps} step{turn.steps === 1 ? "" : "s"}
                    </span>
                    <span>
                        {turn.promptTokens.toLocaleString()} → {turn.outputTokens.toLocaleString()}{" "}
                        tokens
                    </span>
                    {turn.durationMs === undefined ? null : (
                        <span>{(turn.durationMs / 1000).toFixed(1)} s</span>
                    )}
                </span>
            </button>
            {open ? (
                <div className="turn-body">
                    <div className="facts">
                        <dt>session</dt>
                        <dd>
                            {props.onOpenSession === undefined ? (
                                <code>{turn.sessionKey}</code>
                            ) : (
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() => props.onOpenSession?.(turn.sessionKey)}
                                >
                                    {turn.sessionKey}
                                </button>
                            )}
                        </dd>
                        {who === undefined ? null : (
                            <>
                                <dt>from</dt>
                                <dd>
                                    {who}
                                    {turn.senderKind === "agent"
                                        ? " · an agent, so the text was treated as data"
                                        : ""}
                                </dd>
                            </>
                        )}
                        {turn.cachedPromptTokens === undefined ||
                        turn.cachedPromptTokens === 0 ? null : (
                            <>
                                <dt>cached</dt>
                                <dd>
                                    {turn.cachedPromptTokens.toLocaleString()} prompt tokens from
                                    cache
                                </dd>
                            </>
                        )}
                        <dt>id</dt>
                        <dd>
                            <code>{turn.turnId}</code>
                        </dd>
                    </div>
                    {turn.errorCode === undefined ? null : (
                        <p className="note bad">
                            {turn.errorCode}: {turn.errorMessage ?? ""}
                            {turn.errorHint === undefined ? "" : `\nhint: ${turn.errorHint}`}
                        </p>
                    )}
                    {turn.note === undefined ? null : <p className="note">{turn.note}</p>}
                    <div className="label">asked</div>
                    <p className="row user" style={{ margin: "0 0 12px" }}>
                        {turn.input}
                    </p>
                    <div className="label">reply</div>
                    {turn.text === "" ? (
                        <p className="empty">no reply text</p>
                    ) : (
                        <div className="row reply">
                            <Markdown text={turn.text} />
                        </div>
                    )}
                    <ReplayView
                        turn={turn}
                        {...(props.replay === undefined ? {} : { replay: props.replay })}
                        {...(props.onReplay === undefined ? {} : { onReplay: props.onReplay })}
                    />
                </div>
            ) : null}
        </div>
    )
}

/**
 * Every step of the turn as it was stored: the calls the model made and what each returned, in
 * order. Plain text throughout — a tool result is what a tool returned, and a stranger may have
 * written it, so nothing here goes through Markdown.
 */
export function ReplayView(props: {
    readonly turn: TurnRow
    readonly replay?: Replay
    readonly onReplay?: (turn: TurnRow) => void
}): React.ReactElement | null {
    const { replay } = props
    if (replay === undefined) {
        return props.onReplay === undefined ? null : (
            <button
                type="button"
                style={{ marginTop: 12 }}
                onClick={() => props.onReplay?.(props.turn)}
            >
                replay every step
            </button>
        )
    }
    if (replay.state === "loading") return <p className="empty">reading the stored steps…</p>
    if (replay.state === "failed") return <p className="note bad">{replay.message}</p>
    if (replay.steps.length === 0) {
        return (
            <p className="empty">
                No stored steps for this turn: its conversation was cleared, or it is older than the
                last 1,000 messages of it.
            </p>
        )
    }
    return (
        <ol className="replay">
            {replay.steps.map((step) => (
                <li key={step.id}>
                    <div className="label">{stepLabel(step)}</div>
                    <pre className="snippet">
                        {(() => {
                            const text = stepText(step)
                            return text.length > STEP_CHARS
                                ? `${text.slice(0, STEP_CHARS)}\n… (${text.length - STEP_CHARS} more characters)`
                                : text
                        })()}
                    </pre>
                </li>
            ))}
        </ol>
    )
}
