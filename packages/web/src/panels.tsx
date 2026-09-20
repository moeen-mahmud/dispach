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
import type { PanelName } from "./lib/deep-link.ts"

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
}): React.ReactElement {
    if (props.schedules.length === 0) {
        return (
            <p className="empty">
                No schedules. A manifest's <code>schedules:</code> block declares them.
            </p>
        )
    }
    return (
        <table className="panel-table">
            <thead>
                <tr>
                    <th>schedule</th>
                    <th>when</th>
                    <th>next</th>
                    <th>delivers to</th>
                </tr>
            </thead>
            <tbody>
                {props.schedules.map((schedule) => (
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
                                : (schedule.nextRunAt ?? "never again — a spent one-shot")}
                        </td>
                        <td>
                            {schedule.deliverChannel === undefined
                                ? "this session only"
                                : `${schedule.deliverChannel}${schedule.deliverTo === undefined ? "" : ` → ${schedule.deliverTo}`}`}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
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
    { panel: "keys", label: "keys" },
]
