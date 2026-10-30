/**
 * The transcript and the composer.
 *
 * Rendering only — every decision about *what* a row is lives in `lib/transcript.ts`, which is pure
 * and tested. The split is the point: a reducer test can assert that a two-step turn keeps its
 * order, and no amount of component testing can.
 */

import { useEffect, useRef, useState } from "react"
import type { Row, SubagentBlock, Transcript } from "./lib/transcript.ts"
import { Markdown } from "./Markdown.tsx"

/** One attached image, already read into base64. The wire takes `{data, mediaType}`. */
export interface Attachment {
    readonly name: string
    readonly mediaType: string
    readonly data: string
    /** For the thumbnail only; never sent. */
    readonly url: string
}

export const MAX_IMAGES = 5
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

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
            {props.state.live === "" ? null : (
                <div className="row reply">
                    <Markdown text={props.state.live} />
                </div>
            )}
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
            // Markdown, through a parser with no HTML branch: the text is the model's and the
            // model's text is untrusted. See `lib/markdown.ts`.
            return (
                <div className="row reply">
                    <Markdown text={row.text} />
                </div>
            )

        case "reasoning":
            // Folded rather than shown, and closed by default once committed: a 23-row reasoning
            // block for a one-sentence answer fills the screen on its own. Open while streaming,
            // because a reasoning model with nothing on screen looks hung.
            return <Fold label="thinking" text={row.text} />

        case "tool":
            /**
             * What a call *was* and how it went — and what it was given and returned only when the
             * agent's `tools.eventDetail: redacted` put that on the events.
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
                    {row.args === undefined && row.output === undefined ? null : (
                        // Only under `tools.eventDetail: redacted`, which put them on the events with
                        // credentials replaced. Plain text, never Markdown: the output is what a
                        // tool returned, and a stranger may have written it.
                        <details className="tool-detail">
                            <summary className="tool-detail-summary">details</summary>
                            {row.args === undefined ? null : (
                                <pre className="snippet">{JSON.stringify(row.args, null, 2)}</pre>
                            )}
                            {row.output === undefined ? null : (
                                <pre className="snippet">
                                    {row.output}
                                    {row.outputTruncated === true ? "\n… (first 2 KB)" : ""}
                                </pre>
                            )}
                        </details>
                    )}
                    {row.subagent === undefined ? null : <Subagent block={row.subagent} />}
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

/**
 * A routed call's subagent: one line while folded, the child's calls when opened. Closed by default,
 * like reasoning, because the reply is what a person reads first.
 */
function Subagent(props: { readonly block: SubagentBlock }): React.ReactElement {
    const { block } = props
    const status =
        block.outcome === undefined
            ? "running…"
            : `${block.steps ?? 0} step${block.steps === 1 ? "" : "s"} · ${block.tokens ?? 0} tokens · ${block.outcome.replace("_", " ")}`
    return (
        <details className="subagent">
            <summary>
                subagent {block.name} · {status}
            </summary>
            <ul>
                {block.calls.map((call) => (
                    <li key={call.callId} className={call.ok === false ? "failed" : undefined}>
                        <span className="slug">{call.slug}</span>
                        {call.ok === undefined
                            ? " running…"
                            : `${call.ok ? " ok" : " failed"}${call.latencyMs === undefined ? "" : ` · ${call.latencyMs} ms`}`}
                    </li>
                ))}
            </ul>
        </details>
    )
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
    /** Model roles declared under `model:`; the picker is hidden when there is only `main`. */
    readonly roles?: readonly string[]
    readonly role?: string
    readonly onRole?: (role: string | undefined) => void
    readonly images?: readonly Attachment[]
    readonly onImages?: (images: readonly Attachment[]) => void
}): React.ReactElement {
    const area = useRef<HTMLTextAreaElement>(null)
    const [imageNote, setImageNote] = useState<string>()
    const images = props.images ?? []

    /** Files from a paste or a drop: images only, five at most, read to base64 for the wire. */
    const addFiles = (files: readonly File[]) => {
        const accepted = files.filter((file) => IMAGE_TYPES.includes(file.type))
        if (accepted.length === 0) return
        const room = MAX_IMAGES - images.length
        if (room <= 0) {
            setImageNote(`at most ${MAX_IMAGES} images per message`)
            return
        }
        setImageNote(undefined)
        void Promise.all(
            accepted.slice(0, room).map(
                (file) =>
                    new Promise<Attachment>((resolve, reject) => {
                        const reader = new FileReader()
                        reader.onerror = () => reject(reader.error)
                        reader.onload = () => {
                            const url = String(reader.result)
                            resolve({
                                name: file.name,
                                mediaType: file.type,
                                data: url.slice(url.indexOf(",") + 1),
                                url,
                            })
                        }
                        reader.readAsDataURL(file)
                    }),
            ),
        ).then((read) => props.onImages?.([...images, ...read]))
    }

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
            {images.length === 0 ? null : (
                <div className="attachments">
                    {images.map((image, index) => (
                        <span key={`${image.name}:${image.data.length}`} className="attachment">
                            <img src={image.url} alt={image.name} />
                            <button
                                type="button"
                                aria-label={`remove ${image.name}`}
                                onClick={() =>
                                    props.onImages?.(images.filter((_, at) => at !== index))
                                }
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}
            <div className="inner">
                <textarea
                    ref={area}
                    value={props.value}
                    placeholder="Ask the agent something"
                    onChange={(event) => props.onChange(event.target.value)}
                    onDragOver={(event) => {
                        if (props.onImages !== undefined) event.preventDefault()
                    }}
                    onDrop={(event) => {
                        if (props.onImages === undefined) return
                        event.preventDefault()
                        addFiles(Array.from(event.dataTransfer.files))
                    }}
                    onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files)
                        if (files.length > 0 && props.onImages !== undefined) {
                            event.preventDefault()
                            addFiles(files)
                        }
                    }}
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
                {(props.roles ?? []).length > 1 ? (
                    <select
                        className="role-pick"
                        aria-label="model role for this message"
                        value={props.role ?? ""}
                        disabled={props.busy}
                        onChange={(event) =>
                            props.onRole?.(
                                event.target.value === "" ? undefined : event.target.value,
                            )
                        }
                    >
                        {(props.roles ?? []).map((role) => (
                            <option key={role} value={role === "main" ? "" : role}>
                                {role}
                            </option>
                        ))}
                    </select>
                ) : null}
                {props.busy ? (
                    <button type="button" onClick={props.onStop}>
                        Stop
                    </button>
                ) : (
                    <button
                        type="button"
                        className="primary"
                        disabled={props.value.trim() === "" && images.length === 0}
                        onClick={props.onSend}
                    >
                        Send
                    </button>
                )}
            </div>
            <p className="hint">
                {props.busy
                    ? "Running. Closing this page does not stop it — the turn is detached, and reopening reattaches."
                    : (imageNote ??
                      `Enter sends · shift-enter for a new line${props.onImages === undefined ? "" : " · paste or drop an image"}`)}
            </p>
        </div>
    )
}
