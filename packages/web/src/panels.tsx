/**
 * The read-only surfaces, and the agent picker.
 *
 * Every component here takes its data as **props** and fetches nothing. That is not ceremony: it
 * is what lets the rendered output be asserted with `renderToStaticMarkup` and no DOM, which is the
 * browser counterpart of the lesson `packages/cli` paid for — *"a reducer test and a frame test are
 * different claims"*, learned when `rows.ts` was asserted as strings and correct while the rendered
 * list wrapped at 40 columns. The shell owns the client; these own the markup.
 *
 * What they are for: the picker replaces `agents[0]`, which was a comment apologising for itself
 * since Phase 15, and the channel panel is where 16.6's `needs_input` finally becomes visible to
 * somebody who can act on it.
 */

import type React from "react"
import { useState } from "react"
import type { PanelName } from "./lib/deep-link.ts"
import { asText, canSubmit, type EditableSetting } from "./lib/edit.ts"

/** The listing's own shape, narrowed to what a sidebar renders. */
export interface AgentRow {
    readonly id: string
    readonly name: string
    readonly status: string
    readonly model?: string
    readonly disabledAt?: string
    readonly reason?: string
}

/**
 * Which agent, with the stopped ones still on the list.
 *
 * A stopped agent is **shown, not hidden** — the same reasoning `listAgents` uses for a broken
 * directory and `GET /v1/agents` for its thin `disabled` row: somebody who set an agent up and
 * cannot find it has no way to discover that it is switched off, which is the launchd trap that
 * `dispach stop` was designed around. So the row says it is off, says why if anybody said, and
 * offers the one action that makes it reachable again.
 *
 * **`start` is offered and `stop` is not.** From a browser, stopping is one click from making an
 * agent unreachable for everyone, durably and across restarts, with nothing like the typed
 * confirmation `remove` demands. The terminal keeps that authority; this direction only ever turns
 * something on.
 */
export function AgentList(props: {
    readonly agents: readonly AgentRow[]
    readonly current: string | undefined
    readonly onSelect: (id: string) => void
    readonly onStart: (id: string) => void
    readonly starting?: string
}): React.ReactElement {
    if (props.agents.length === 0) {
        return (
            <div className="empty" style={{ fontSize: 12, padding: "4px 8px" }}>
                no agents on this server
            </div>
        )
    }
    return (
        <>
            {props.agents.map((agent) => {
                const off = agent.status === "disabled"
                return (
                    <div key={agent.id} className="agent-row">
                        <button
                            type="button"
                            className="row-button"
                            aria-current={agent.id === props.current}
                            // A stopped agent's resource answers 404, so selecting one would open a
                            // chat where every send fails. The row is informative, not a target.
                            disabled={off}
                            onClick={() => props.onSelect(agent.id)}
                        >
                            {agent.name}
                            {off ? <span className="agent-off"> · stopped</span> : null}
                        </button>
                        {off ? (
                            <div className="agent-note">
                                {agent.reason ?? "switched off"}
                                <button
                                    type="button"
                                    className="link"
                                    disabled={props.starting === agent.id}
                                    onClick={() => props.onStart(agent.id)}
                                >
                                    {props.starting === agent.id ? "starting…" : "start"}
                                </button>
                            </div>
                        ) : null}
                    </div>
                )
            })}
        </>
    )
}

export interface ToolRow {
    readonly slug: string
    readonly summary: string
    readonly mutating: boolean
    readonly trust: string
    readonly trustReason?: string
    readonly provider: string
}

/**
 * The catalogue, with the two columns that are not cosmetic.
 *
 * `trust` is shown because an untrusted tool **taints the turn**: after it has run, a mutating call
 * needs an explicit rule or a live approval, and "why did my second `exec` get blocked?" is
 * answered by this column and by nothing else on this surface. `trustReason` is shown for the
 * reason it exists at all — the boot warning fired on every start of every system-provider agent,
 * and a warning always present for a correct configuration is one people stop reading, so the
 * reason belongs where somebody is already looking at the catalogue.
 */
export function ToolsPanel(props: { readonly tools: readonly ToolRow[] }): React.ReactElement {
    if (props.tools.length === 0) {
        return (
            <p className="empty">
                No tools are pinned. An agent with none can still hold a conversation; a manifest's{" "}
                <code>tools.pinned</code> is what grants the rest.
            </p>
        )
    }
    return (
        <table className="panel-table">
            <thead>
                <tr>
                    <th>tool</th>
                    <th>provider</th>
                    <th>writes</th>
                    <th>trust</th>
                </tr>
            </thead>
            <tbody>
                {props.tools.map((tool) => (
                    <tr key={tool.slug}>
                        <td>
                            <code>{tool.slug}</code>
                            <div className="sub">{tool.summary}</div>
                        </td>
                        <td>{tool.provider}</td>
                        <td>{tool.mutating ? "yes" : "no"}</td>
                        <td>
                            {tool.trust}
                            {tool.trustReason === undefined ? null : (
                                <div className="sub">{tool.trustReason}</div>
                            )}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

/**
 * `?: string | undefined` rather than `?: string` throughout.
 *
 * The store declares these as `string | undefined` — explicitly present and unset, which under
 * `exactOptionalPropertyTypes` is a *different* type from absent. Writing the narrower form here
 * would make the panel reject the very record the route sends, and the fix would be a remap of
 * nine fields at the call site: which is where a field goes missing and nothing reports it.
 */
export interface ScheduleRow {
    readonly id: string
    readonly kind: string
    readonly expr: string
    readonly task: string
    readonly enabled: boolean
    readonly nextRunAt?: string | undefined
    readonly timezone?: string | undefined
    readonly deliverChannel?: string | undefined
    readonly deliverTo?: string | undefined
    /**
     * `manifest` or `api`, and it decides whether this row may be edited here at all.
     *
     * Shown rather than kept for the buttons' benefit: reconciliation restores every field of a
     * manifest-declared schedule from the file at the next boot, so an edit through the API is
     * undone — which the route now refuses with `schedule_manifest_owned`. A panel that offered the
     * button anyway would be offering a 409, and the column is what explains why it does not.
     */
    readonly origin?: string | undefined
}

/**
 * What is armed, and — the part that matters — what is not.
 *
 * `nextRunAt` absent means **never again**: a spent one-shot. It is printed as that rather than
 * left blank, because a blank cell in a row that looks otherwise healthy is how a schedule comes to
 * be believed in. The same reasoning as the `serve` banner naming schedules: this is the last place
 * somebody looks before walking away, and "it is set up" is exactly the belief a schedule that
 * never fires depends on going unchecked.
 */
export function SchedulesPanel(props: {
    readonly schedules: readonly ScheduleRow[]
    /** Undefined while the listing is still being read, so the form does not offer to write early. */
    readonly onCreate?: (schedule: Readonly<Record<string, unknown>>) => void
    readonly onDelete?: (scheduleId: string) => void
    readonly onRun?: (scheduleId: string) => void
    readonly onToggle?: (scheduleId: string, enabled: boolean) => void
    /** The id currently being written, so one row can say so without freezing the rest. */
    readonly busy?: string
}): React.ReactElement {
    return (
        <>
            {props.schedules.length === 0 ? (
                <p className="empty">
                    No schedules. Add one below, or declare it in the manifest's{" "}
                    <code>schedules:</code> block — a declared one survives a rebuild and shows up
                    in a diff.
                </p>
            ) : (
                <table className="panel-table">
                    <thead>
                        <tr>
                            <th>schedule</th>
                            <th>when</th>
                            <th>next</th>
                            <th>delivers to</th>
                            <th>declared in</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {props.schedules.map((schedule) => {
                            /**
                             * A manifest-declared row is **shown and not editable here**, and the
                             * cell says which file decides it.
                             *
                             * Reconciliation restores every field from the manifest at the next
                             * boot, `enabled` included, so a write through this surface lasts until
                             * the next start — the route refuses it for that reason and the terminal
                             * already did. Offering a button whose only outcome is a 409 is worse
                             * than not offering one, and worse again than the old behaviour, which
                             * reported success on a change that quietly went away.
                             */
                            const owned = schedule.origin === "manifest"
                            const working = props.busy === schedule.id
                            return (
                                <tr key={schedule.id} className={schedule.enabled ? "" : "off"}>
                                    <td>
                                        <code>{schedule.id}</code>
                                        <div className="sub">{schedule.task}</div>
                                    </td>
                                    <td>
                                        {schedule.kind} {schedule.expr}
                                        {schedule.timezone === undefined ? null : (
                                            <div className="sub">{schedule.timezone}</div>
                                        )}
                                    </td>
                                    <td>
                                        {!schedule.enabled
                                            ? "disabled"
                                            : (schedule.nextRunAt ??
                                              "never again — a spent one-shot")}
                                    </td>
                                    <td>
                                        {schedule.deliverChannel === undefined
                                            ? "this session only"
                                            : `${schedule.deliverChannel}${schedule.deliverTo === undefined ? "" : ` → ${schedule.deliverTo}`}`}
                                    </td>
                                    <td>
                                        {owned ? "agent.yaml" : "the API"}
                                        {owned ? (
                                            <div className="sub">
                                                the manifest decides it — edit the file, or the{" "}
                                                <code>schedules</code> field under config
                                            </div>
                                        ) : null}
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                        {/*
                                         * `run` is offered for a manifest-declared schedule too:
                                         * it writes nothing and does not move the next run, so it
                                         * is the one action reconciliation cannot undo — and
                                         * "does it work" is the question somebody has about a
                                         * schedule they cannot see fire.
                                         */}
                                        {props.onRun === undefined ? null : (
                                            <button
                                                type="button"
                                                disabled={working}
                                                onClick={() => props.onRun?.(schedule.id)}
                                            >
                                                run now
                                            </button>
                                        )}
                                        {props.onToggle === undefined || owned ? null : (
                                            <button
                                                type="button"
                                                disabled={working}
                                                onClick={() =>
                                                    props.onToggle?.(schedule.id, !schedule.enabled)
                                                }
                                            >
                                                {schedule.enabled ? "disable" : "enable"}
                                            </button>
                                        )}
                                        {props.onDelete === undefined || owned ? null : (
                                            <button
                                                type="button"
                                                disabled={working}
                                                onClick={() => props.onDelete?.(schedule.id)}
                                            >
                                                delete
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            )}
            {props.onCreate === undefined ? null : <ScheduleForm onCreate={props.onCreate} />}
        </>
    )
}

/**
 * Arm a new schedule.
 *
 * Deliberately five fields and no expression builder. `expr` is validated by
 * `prepareScheduleWrite` in core — the same function the manifest path uses, so a cron this accepts
 * is one a file accepts — and the refusal it produces names the field and says what is wrong. A
 * builder here would be a second, worse opinion about what a valid expression is.
 *
 * `deliver` is the field worth the sentence under it: on Telegram it is the **numeric chat id**, not
 * an `@handle`. Measured live before that note existed — an agent copied the handle out of
 * `allowFrom`, the obvious move since that is the recognisable form, and every send came back
 * `Bad Request: chat not found` while the schedule fired perfectly every 15 minutes.
 */
function ScheduleForm(props: {
    readonly onCreate: (schedule: Readonly<Record<string, unknown>>) => void
}): React.ReactElement {
    const [id, setId] = useState("")
    const [kind, setKind] = useState("cron")
    const [expr, setExpr] = useState("")
    const [task, setTask] = useState("")
    const [channel, setChannel] = useState("")
    const [to, setTo] = useState("")

    const ready = id.trim() !== "" && expr.trim() !== "" && task.trim() !== ""

    return (
        <section style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>Add a schedule</h3>
            <div className="form-grid">
                <label htmlFor="sched-id">id</label>
                <input
                    id="sched-id"
                    value={id}
                    placeholder="morning-brief"
                    onChange={(event) => setId(event.target.value)}
                />

                <label htmlFor="sched-kind">kind</label>
                <select
                    id="sched-kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                >
                    <option value="cron">cron — a 5- or 6-field expression</option>
                    <option value="every">every — a duration like 15m</option>
                    <option value="at">at — one ISO instant, once</option>
                </select>

                <label htmlFor="sched-expr">expr</label>
                <input
                    id="sched-expr"
                    value={expr}
                    placeholder={kind === "cron" ? "0 8 * * *" : kind === "every" ? "15m" : ""}
                    onChange={(event) => setExpr(event.target.value)}
                />

                <label htmlFor="sched-task">task</label>
                <input
                    id="sched-task"
                    value={task}
                    placeholder="Summarise today's calendar."
                    onChange={(event) => setTask(event.target.value)}
                />

                <label htmlFor="sched-channel">deliver</label>
                <div>
                    <input
                        id="sched-channel"
                        value={channel}
                        placeholder="channel id — blank for this session only"
                        onChange={(event) => setChannel(event.target.value)}
                    />
                    {channel.trim() === "" ? null : (
                        <>
                            <input
                                value={to}
                                placeholder="address"
                                onChange={(event) => setTo(event.target.value)}
                            />
                            <p className="sub">
                                The address a reply is <em>sent</em> to — on Telegram the numeric
                                chat id, never an <code>@handle</code>, which addresses a channel
                                and not a person. It is the id inbound messages arrive on.
                            </p>
                        </>
                    )}
                </div>
            </div>
            <button
                type="button"
                disabled={!ready}
                style={{ marginTop: 10 }}
                onClick={() =>
                    props.onCreate({
                        id: id.trim(),
                        kind,
                        expr: expr.trim(),
                        task: task.trim(),
                        // `"none"` is the literal the schema expects, not an omitted field: a
                        // schedule with no delivery returns its result through the event stream,
                        // which is a choice rather than an absence.
                        deliver:
                            channel.trim() === ""
                                ? "none"
                                : { channel: channel.trim(), to: to.trim() },
                    })
                }
            >
                add
            </button>
        </section>
    )
}

/**
 * The person's editor, in a browser.
 *
 * Generated from the server's own list rather than a hand-written form, which is the rule this repo
 * keeps relearning: `SETTINGS` in core is the one table both of the person's editors read, so a
 * field added there reaches this panel with nothing to remember. A hand-kept copy is always right
 * on the day it is written.
 *
 * Every row carries `means`, because that sentence is the difference between a settings screen and
 * a list of YAML paths. The two rows that carry `confirm` get the sentence *and* a tick box: they
 * are the only edits whose purpose is to stop a check running, and the server refuses them without
 * the acknowledgement anyway.
 */
export function ConfigPanel(props: {
    readonly settings: readonly EditableSetting[]
    readonly editable: boolean
    readonly file?: string
    readonly onSet: (path: string, value: string, options: { confirm: boolean }) => void
    /** The path currently being written. */
    readonly busy?: string
    /** What the last write reported, when it was written but not applied. */
    readonly note?: string
}): React.ReactElement {
    if (!props.editable) {
        return (
            <p className="empty">
                This agent was loaded from an object rather than a file, so there is no manifest to
                change. An embedder holding new settings passes the new object to its runtime.
            </p>
        )
    }
    return (
        <>
            <p className="sub" style={{ marginTop: 0 }}>
                {props.file === undefined ? null : (
                    <>
                        <code>{props.file}</code>.{" "}
                    </>
                )}
                An agent's settings are fixed for its instance's lifetime, so saving one replaces
                the agent — the conversation history is in the store and survives it.
            </p>
            {props.note === undefined ? null : <p className="row note">{props.note}</p>}
            {props.settings.map((setting) => (
                <ConfigRow
                    key={setting.path}
                    setting={setting}
                    busy={props.busy === setting.path}
                    onSet={props.onSet}
                />
            ))}
        </>
    )
}

/**
 * One field.
 *
 * Its own component so each row owns its draft text. One shared draft in the panel would make
 * typing in one field clear another, and a single `Record<path, string>` would have to be
 * invalidated on every refetch — which is how a form comes to show a value the file no longer has.
 */
function ConfigRow(props: {
    readonly setting: EditableSetting
    readonly busy: boolean
    readonly onSet: (path: string, value: string, options: { confirm: boolean }) => void
}): React.ReactElement {
    const current = asText(props.setting.value)
    const [text, setText] = useState(current)
    const [confirmed, setConfirmed] = useState(false)
    // Keyed on the value so a refetch after a save re-seeds the box from the file rather than
    // leaving the text somebody typed sitting above a different stored value.
    const [seen, setSeen] = useState(current)
    if (seen !== current) {
        setSeen(current)
        setText(current)
        setConfirmed(false)
    }

    const ready = canSubmit({ setting: props.setting, text, confirmed })
    const long = current.length > 48 || current.includes("{") || current.includes("[")

    return (
        <section className="config-row">
            <div className="config-head">
                <code>{props.setting.path}</code>
                {props.setting.value === undefined ? <span className="sub"> not set</span> : null}
            </div>
            <p className="sub">{props.setting.means}</p>
            {long ? (
                <textarea
                    rows={2}
                    value={text}
                    aria-label={props.setting.path}
                    onChange={(event) => setText(event.target.value)}
                />
            ) : (
                <input
                    value={text}
                    aria-label={props.setting.path}
                    onChange={(event) => setText(event.target.value)}
                />
            )}
            {props.setting.confirm === undefined ? null : (
                <label className="row note bad" style={{ display: "block" }}>
                    <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                    />{" "}
                    {props.setting.confirm}
                </label>
            )}
            <button
                type="button"
                disabled={!ready || props.busy}
                onClick={() => props.onSet(props.setting.path, text, { confirm: confirmed })}
            >
                {props.busy ? "saving…" : "save"}
            </button>
        </section>
    )
}

export interface ChannelRow {
    readonly id: string
    readonly type: string
    readonly status: string
    readonly detail?: string
    readonly input?: {
        readonly kind: string
        readonly payload: string
        readonly issuedAt: string
        readonly expiresAt?: string
    }
}

/**
 * Channel state, and the one status that is about a **person** rather than a network.
 *
 * `needs_input` is why 16.6 exists and this is where it pays off: the transport is running and
 * cannot finish connecting until somebody acts — WhatsApp's link-device QR being the first
 * instance. Two things are non-negotiable in rendering it.
 *
 * **Staleness has to be visible.** WhatsApp rotates its QR roughly every 20 seconds, so a payload
 * fetched a minute ago will not scan; a code nobody can tell is expired reads as a broken scanner
 * rather than an old picture. `expiresAt` against `now` is what makes the difference sayable, and
 * `now` is a **prop** so the rendering is deterministic — a component reading the clock is one
 * whose test passes or fails depending on the time of day, which this repo has paid for in the
 * outbox already.
 *
 * **An unknown `kind` must render as something.** The set can grow inside `v: 1` while the field's
 * type cannot, so a `kind` this build has never heard of shows the payload as text rather than
 * nothing — which is the difference between a page a newer server can still be used from and one
 * that silently shows an empty box.
 */
export function ChannelsPanel(props: {
    readonly channels: readonly ChannelRow[]
    /** Injected so staleness is deterministic. Never `Date.now()` inside a component. */
    readonly now: number
}): React.ReactElement {
    if (props.channels.length === 0) {
        return (
            <p className="empty">
                No channels. This agent is reached through this page and the HTTP API only.
            </p>
        )
    }
    return (
        <div className="channels">
            {props.channels.map((channel) => {
                const input = channel.input
                const expired =
                    input?.expiresAt !== undefined && Date.parse(input.expiresAt) <= props.now
                return (
                    <section key={channel.id} className="channel">
                        <h3>
                            <code>{channel.id}</code> <span className="sub">{channel.type}</span>
                        </h3>
                        <p className={`status status-${channel.status}`}>
                            {channel.status}
                            {channel.detail === undefined ? null : ` — ${channel.detail}`}
                        </p>
                        {input === undefined ? null : (
                            <div className={`channel-input ${expired ? "stale" : "fresh"}`}>
                                {expired ? (
                                    // Said plainly, and the payload still shown: hiding it would
                                    // leave nothing on screen at the moment the next one arrives,
                                    // which reads as the page having broken.
                                    <p className="warn">
                                        this expired — the channel will issue another
                                    </p>
                                ) : null}
                                <pre className="payload" data-kind={input.kind}>
                                    {input.payload}
                                </pre>
                                <p className="sub">
                                    {input.kind} · issued {input.issuedAt}
                                    {input.expiresAt === undefined
                                        ? " · no expiry reported"
                                        : ` · expires ${input.expiresAt}`}
                                </p>
                            </div>
                        )}
                    </section>
                )
            })}
        </div>
    )
}

/** The sidebar's server group, so the shell does not restate the panel list. */
export const SERVER_PANELS: readonly { readonly panel: PanelName; readonly label: string }[] = [
    { panel: "tools", label: "tools" },
    { panel: "schedules", label: "schedules" },
    { panel: "channels", label: "channels" },
    { panel: "config", label: "config" },
    { panel: "keys", label: "keys" },
]
