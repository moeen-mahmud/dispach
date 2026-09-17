/**
 * The transcript and the composer.
 *
 * Rendering only — every decision about *what* a row is lives in `lib/transcript.ts`, which is pure
 * and tested. The split is the point: a reducer test can assert that a two-step turn keeps its
 * order, and no amount of component testing can.
 */

import { useEffect, useRef } from "react"
import type { Row, Transcript } from "./lib/transcript.ts"

export function Rows(props: {
    readonly state: Transcript
    readonly onAnswer: (approvalId: string, granted: boolean) => void
}): React.ReactElement {
    return (
        <>
            {props.state.truncated ? (
                <p className="row note bad">
                    This turn produced more than the server keeps for a reattach, so the beginning
                    of the reply is missing. The stored turn has all of it.
                </p>
            ) : null}
            {props.state.rows.map((row) => (
                <RowView key={row.id} row={row} onAnswer={props.onAnswer} />
            ))}
            {props.state.liveReasoning === "" ? null : (
                <Fold label="thinking" text={props.state.liveReasoning} open />
            )}
            {props.state.live === "" ? null : <p className="row">{props.state.live}</p>}
        </>
    )
}

function RowView(props: {
    readonly row: Row
    readonly onAnswer: (approvalId: string, granted: boolean) => void
}): React.ReactElement | null {
    const row = props.row
    switch (row.kind) {
        case "user":
            return <p className="row user">{row.text}</p>

        case "reply":
            return <p className="row">{row.text}</p>

        case "reasoning":
            // Folded rather than shown, and closed by default once committed: a 23-row reasoning
            // block for a one-sentence answer fills the screen on its own. Open while streaming,
            // because a reasoning model with nothing on screen looks hung.
            return <Fold label="thinking" text={row.text} />

        case "tool":
            /**
             * What a call *was* and how it went — never what it was given or what came back.
             *
             * `tool.call` carries `argsHash` and `tool.result` carries `bytes`, not the text, and
             * that is the wire's decision rather than this page's: arguments can hold a file's
             * contents or a shell script, and an observation is text a stranger wrote, while the
             * firehose is seen by every observer of a session. Rendering either would mean reading
             * the stored messages, which is the reattach path.
             *
             * The first version of this component read `row.args` and `row.result`, fields the
             * events have never had. It type-checked against a `Row` I had also invented, and
             * fifteen reducer tests agreed with it — the fixture encoded the mistake. Found by
             * streaming a real turn and getting a blank reply.
             */
            return (
                <div className={`row tool${row.ok === false ? " failed" : ""}`}>
                    <span className="slug">{row.slug}</span>
                    {row.mutating ? <span className="mut"> changes things</span> : null}
                    <span className="out">{toolOutcome(row)}</span>
                    {row.untrusted === true ? (
                        // Said rather than fenced: there is no text here to fence. The label is the
                        // part that survives anyway — delimiters are advisory and a model can be
                        // talked past them, while the write gate in core is what holds.
                        <div className="fence">
                            <div className="why">
                                this result came from outside the agent — treated as data, and
                                mutating tools are blocked for the rest of the turn
                            </div>
                        </div>
                    ) : null}
                </div>
            )

        case "approval":
            return (
                <div className="row ask">
                    <div>
                        <strong>{row.slug}</strong> needs permission — {row.reason}
                    </div>
                    {row.match === undefined ? null : <div className="what">{row.match}</div>}
                    {row.settled === undefined ? (
                        <div className="buttons">
                            <button
                                type="button"
                                className="primary"
                                onClick={() => props.onAnswer(row.approvalId, true)}
                            >
                                Allow once
                            </button>
                            <button
                                type="button"
                                onClick={() => props.onAnswer(row.approvalId, false)}
                            >
                                Refuse
                            </button>
                        </div>
                    ) : (
                        <div className="settled">{settledText(row.settled)}</div>
                    )}
                </div>
            )

        case "note":
            return <p className={`row note${row.bad ? " bad" : ""}`}>{row.text}</p>
    }
}

/**
 * How a call went, from the fields the event actually carries.
 *
 * `truncated` is worth its own words: it means the observation was cut to fit
 * `observationMaxTokens`, and a model that reads a middle-cut result behaves differently from one
 * that read the whole thing — which is a fact about the turn, not a display detail.
 */
function toolOutcome(row: Extract<Row, { kind: "tool" }>): string {
    if (row.ok === undefined) return " running…"
    const size = row.bytes === undefined ? "" : ` · ${row.bytes} bytes`
    const cut = row.truncated === true ? " · truncated to fit the observation budget" : ""
    const took = row.latencyMs === undefined ? "" : ` · ${row.latencyMs} ms`
    return `${row.ok ? " ok" : " failed"}${size}${took}${cut}`
}

/** Each outcome gets its own sentence, because they call for different responses from a reader. */
function settledText(settled: "granted" | "denied" | "abandoned" | "error"): string {
    switch (settled) {
        case "granted":
            return "Allowed — the call ran."
        case "denied":
            return "Refused. The model was told a person declined it."
        case "abandoned":
            // The distinction 11.188 exists for: nobody said no, so the model is told exactly that.
            return "The turn ended while this was waiting, so the call did not run. Nobody declined it."
        case "error":
            return "The approver itself failed, so the call was refused. That says nothing about what anybody wanted."
    }
}

function Fold(props: {
    readonly label: string
    readonly text: string
    readonly open?: boolean
}): React.ReactElement {
    return (
        <details className="row fold" open={props.open === true}>
            <summary>
                {props.label} · {props.text.length} chars
            </summary>
            <div className="body">{props.text}</div>
        </details>
    )
}

export function Composer(props: {
    readonly value: string
    readonly busy: boolean
    readonly onChange: (value: string) => void
    readonly onSend: () => void
    readonly onStop: () => void
}): React.ReactElement {
    const area = useRef<HTMLTextAreaElement>(null)

    // Grow with the text up to the CSS cap, so a pasted paragraph is visible while being edited.
    // The body reads `area.current`, not `props.value` — so the rule offers to drop it, and without
    // it the box is sized once at mount and never grows again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a deliberate trigger dependency
    useEffect(() => {
        const node = area.current
        if (node === null) return
        node.style.height = "auto"
        node.style.height = `${Math.min(node.scrollHeight, 190)}px`
    }, [props.value])

    return (
        <div className="composer">
            <div className="inner">
                <textarea
                    ref={area}
                    value={props.value}
                    placeholder="Ask the agent something"
                    onChange={(event) => props.onChange(event.target.value)}
                    onKeyDown={(event) => {
                        // Enter sends, shift-enter composes — the opposite of the terminal's paste
                        // rule and the right one here, because a browser textarea has no paste
                        // ambiguity to protect against and every chat surface a person has used
                        // works this way.
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault()
                            props.onSend()
                        }
                    }}
                />
                {props.busy ? (
                    <button type="button" onClick={props.onStop}>
                        Stop
                    </button>
                ) : (
                    <button
                        type="button"
                        className="primary"
                        disabled={props.value.trim() === ""}
                        onClick={props.onSend}
                    >
                        Send
                    </button>
                )}
            </div>
            <p className="hint">
                {props.busy
                    ? "Running. Closing this page does not stop it — the turn is detached, and reopening reattaches."
                    : "Enter sends · shift-enter for a new line"}
            </p>
        </div>
    )
}
