/**
 * Creating an agent from the browser — the form, and what it says afterwards.
 *
 * Props only, and it fetches nothing, for the reason every component in `panels.tsx` is built that
 * way: `renderToStaticMarkup` then asserts the markup with no DOM and no new dependency. The shell
 * owns the client and the state; this owns the fields.
 *
 * ## The whole point of the stage
 *
 * `POST /v1/agents` ends in `Runtime.adopt`, not in a restart — so the agent is served, its
 * channels are up and its schedules are armed before the response returns. That is what makes a
 * browser a real front door rather than a way to write a file somebody then has to go and start.
 *
 * ## The three things that are easy to get wrong here
 *
 * **A hidden field is not sent.** Visibility is `lib/provision-form.ts`'s job, computed from the
 * `requires` the wire declares. An answer to a question that was never asked is the
 * "accepted and acted on by nobody" shape the route was just corrected for.
 *
 * **A secret is masked, never round-tripped, and never stored.** It lives in the shell's React
 * state, is sent once, is written into the agent's `.env` at `0600`, and no route reads it back.
 * `autoComplete="off"` because a browser offering to save it puts a copy where nothing here can
 * reach, and `spellCheck={false}` because a red underline under a key reads as a typo.
 *
 * **A blank secret is reported after the fact.** `.env` is a **protected path**: neither the agent
 * nor any route can fill it in later, so an agent provisioned with an empty token is one that needs
 * a terminal visit — and saying so beside the directory is the difference between a working agent
 * and a silent one.
 */

import type { ProvisionedAgentLike, ProvisionOfferLike, ProvisionStepLike } from "@dispach/client"
import type React from "react"
import { type Answers, blankSecrets, missingAnswers, visibleSteps } from "./lib/provision-form.ts"

/**
 * Why this server will not create an agent, or `undefined` when it will.
 *
 * `GET /v1/provision` answers even when it cannot provision, and reports the two reasons
 * separately, precisely so a page can say which — a `501` and a `403` would each only say "no".
 * Rendered rather than hidden for the same reason a stopped agent is listed: somebody following a
 * link to this panel needs to know why it is empty.
 */
function refusal(offer: ProvisionOfferLike): React.ReactElement | undefined {
    if (!offer.available) {
        return (
            <p className="empty">
                This server has no provisioner, so it cannot create an agent — the case for an
                embedder mounting the API over its own agent store. Run <code>dispach init</code>{" "}
                where the sandbox is, or mount an agent directory.
            </p>
        )
    }
    if (!offer.local) {
        return (
            <p className="empty">
                Creating an agent is allowed only on a loopback bind, and this server is reachable
                from elsewhere. That is also what refuses it inside the container, whose{" "}
                <code>CMD</code> binds <code>0.0.0.0</code>: mount a written agent at{" "}
                <code>/agent</code>, or run <code>dispach init</code> on the host.
            </p>
        )
    }
    return undefined
}

/** One field, drawn from what the wire said about it. */
function Field(props: {
    readonly step: ProvisionStepLike
    readonly value: string
    readonly invalid: boolean
    readonly disabled: boolean
    readonly onChange: (value: string) => void
}): React.ReactElement {
    const { step, value } = props
    const id = `provision-${step.step}`
    return (
        <div className={props.invalid ? "field invalid" : "field"}>
            <label htmlFor={id}>
                {step.prompt}
                {step.optional ? <span className="sub"> optional</span> : null}
                {step.secret ? (
                    <span className="sub"> · written to .env, never read back</span>
                ) : null}
            </label>
            {step.choices === undefined ? (
                <input
                    id={id}
                    name={step.step}
                    // `password` is what masks it and what keeps it out of a browser's form history.
                    type={step.secret ? "password" : "text"}
                    value={value}
                    disabled={props.disabled}
                    autoComplete={step.secret ? "new-password" : "off"}
                    spellCheck={false}
                    onChange={(event) => props.onChange(event.target.value)}
                />
            ) : (
                <select
                    id={id}
                    name={step.step}
                    value={value}
                    disabled={props.disabled}
                    onChange={(event) => props.onChange(event.target.value)}
                >
                    {step.choices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                            {choice.hint === undefined
                                ? choice.label
                                : `${choice.label} — ${choice.hint}`}
                        </option>
                    ))}
                </select>
            )}
            {props.invalid ? <div className="sub error">needs an answer</div> : null}
        </div>
    )
}

/**
 * What was written, and whether it is running.
 *
 * `adopted` empty with an `error` is **not** a failed creation: the agent is on disk either way, so
 * reporting failure while a complete agent sits in the sandbox would send somebody to create a
 * second one. The directory is printed in both cases because it is the thing they need next.
 */
export function Created(props: {
    readonly result: ProvisionedAgentLike
    readonly blank: readonly ProvisionStepLike[]
    readonly onOpen: (id: string) => void
}): React.ReactElement {
    const live = props.result.adopted.includes(props.result.id)
    return (
        <div className="created">
            <h3>
                Created <code>{props.result.id}</code>
            </h3>
            <p>
                <code>{props.result.dir}</code>
                <span className="sub"> · {props.result.files.length} files</span>
            </p>
            {live ? (
                <p className="ok">adopted · live on this host, with its channels and schedules</p>
            ) : (
                <p className="error">
                    written, and <strong>not running</strong>
                    {props.result.error === undefined ? null : (
                        <>
                            {": "}
                            {props.result.error.message}
                            {props.result.error.hint === undefined ? null : (
                                <span className="sub"> {props.result.error.hint}</span>
                            )}
                        </>
                    )}
                </p>
            )}
            {props.blank.length === 0 ? null : (
                <div className="blank-secrets">
                    <p>
                        Left empty, and needed before this works:{" "}
                        {props.blank.map((step) => step.prompt).join(", ")}.
                    </p>
                    <p className="sub">
                        Fill them in <code>{props.result.dir}/.env</code> at a terminal —{" "}
                        <code>.env</code> is a protected path, so neither the agent nor this API can
                        write it. The file names each variable in its own comments.
                    </p>
                </div>
            )}
            {live ? (
                <button type="button" onClick={() => props.onOpen(props.result.id)}>
                    open {props.result.id}
                </button>
            ) : null}
        </div>
    )
}

/**
 * The form.
 *
 * `answers` holds every step including the hidden ones, so changing a choice back does not discard
 * what was typed under it; `payloadFor` is what decides what is actually sent. `touched` gates the
 * "needs an answer" markers — flagging an empty required field before anybody has tried to submit
 * is a form that opens looking broken.
 */
export function Onboarding(props: {
    readonly offer: ProvisionOfferLike
    readonly answers: Answers
    readonly busy: boolean
    readonly touched: boolean
    readonly error?: string
    readonly result?: ProvisionedAgentLike
    readonly onAnswer: (step: string, value: string) => void
    readonly onSubmit: () => void
    readonly onOpen: (id: string) => void
}): React.ReactElement {
    if (props.result !== undefined) {
        return (
            <Created
                result={props.result}
                blank={blankSecrets(props.offer.steps, props.answers)}
                onOpen={props.onOpen}
            />
        )
    }

    const blocked = refusal(props.offer)
    if (blocked !== undefined) return blocked

    const visible = visibleSteps(props.offer.steps, props.answers)
    const missing = missingAnswers(props.offer.steps, props.answers)
    const missingSteps = new Set(missing.map((step) => step.step))

    return (
        <form
            className="provision"
            onSubmit={(event) => {
                event.preventDefault()
                props.onSubmit()
            }}
        >
            <p className="sub">
                The same questions <code>dispach init</code> asks, served from the same walk. What
                you leave alone takes its default. The agent is adopted into this server as it is
                created — there is no second command.
            </p>
            {visible.map((step) => (
                <Field
                    key={step.step}
                    step={step}
                    value={props.answers[step.step] ?? ""}
                    invalid={props.touched && missingSteps.has(step.step)}
                    disabled={props.busy}
                    onChange={(value) => props.onAnswer(step.step, value)}
                />
            ))}
            {props.error === undefined ? null : <p className="error">{props.error}</p>}
            <button type="submit" disabled={props.busy}>
                {props.busy ? "creating…" : "create agent"}
            </button>
            {props.touched && missing.length > 0 ? (
                <p className="sub error">
                    {missing.map((step) => step.prompt).join(", ")} — still needed.
                </p>
            ) : null}
        </form>
    )
}
