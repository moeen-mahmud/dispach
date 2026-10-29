/**
 * The agent picker, the channel, settings and warnings panels, and the two panel lists the sidebar
 * is generated from. Tools, schedules and the newer surfaces live in their own modules.
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

import QRCode from "qrcode"
import type React from "react"
import { useState } from "react"
import type { PanelName } from "./lib/deep-link.ts"
import { asText, canSubmit, type EditableSetting } from "./lib/edit.ts"

/**
 * A boot finding, in the shape `GET /v1/agents/:id` carries it.
 *
 * Declared here rather than imported from the client so the panels stay renderable with props
 * alone — which is what makes `renderToStaticMarkup` a real test with no DOM.
 */
export interface WireError {
    readonly code: string
    readonly message: string
    readonly hint?: string
    readonly field?: string
}

/** The listing's own shape, narrowed to what a sidebar renders. */
export interface AgentRow {
    readonly id: string
    readonly name: string
    readonly status: string
    readonly model?: string
    readonly disabledAt?: string
    readonly reason?: string
    /** `owner`, `peer` or `channel-peer`: whether "new conversation" rotates (since 0.3). */
    readonly sessionScope?: string
}

/**
 * Which agent, with the stopped ones still on the list.
 *
 * A stopped agent is **shown, not hidden** — the same reasoning `listAgents` uses for a broken
 * directory and `GET /v1/agents` for its thin `disabled` row: somebody who set an agent up and
 * cannot find it has no way to discover that it is switched off, which is the launchd trap that
 * the CLI's `stop` was designed around. So the row says it is off, says why if anybody said, and
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

/**
 * `?: string | undefined` rather than `?: string` throughout.
 *
 * The store declares these as `string | undefined` — explicitly present and unset, which under
 * `exactOptionalPropertyTypes` is a *different* type from absent. Writing the narrower form here
 * would make the panel reject the very record the route sends, and the fix would be a remap of
 * nine fields at the call site: which is where a field goes missing and nothing reports it.
 */
export { type ScheduleRow, SchedulesPanel } from "./schedules.tsx"
export { type ToolRow, ToolsPanel } from "./tools.tsx"

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
    /** Runtime state. Absent on a channel that is switched off, which is never constructed. */
    readonly status?: string
    readonly detail?: string
    /** From the manifest, so a disconnected channel still appears and can be switched back on. */
    readonly enabled?: boolean
    /** The variable this channel's credential lives in, when it keeps one in the `.env`. */
    readonly credentialEnv?: string
    /**
     * Whether that variable has a value.
     *
     * The **name and whether it is set**, never the value: no route returns a credential, because a
     * surface that could read one back is one a leaked operator key turns into a credential dump.
     */
    readonly credentialSet?: boolean
    readonly input?: {
        readonly kind: string
        readonly payload: string
        readonly issuedAt: string
        readonly expiresAt?: string
    }
}

/** What a panel asks the page to do. The page owns the request; the panel owns the question. */
export interface ChannelActions {
    readonly onConnect: (channelId: string, enabled: boolean) => void
    readonly onCredential: (channelId: string, value: string) => void
    readonly onUnpair: (channelId: string) => void
    /** The channel a request is in flight for, so its buttons can say so rather than look dead. */
    readonly busy?: string
    readonly note?: string
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
/**
 * What this agent could not do, and why — the boot findings that used to be refusals.
 *
 * Every one of these was a *load failure* before 0.1.3: a channel with no token, a plugin that
 * would not import, a provider nobody registered, a pinned tool nothing could resolve. They became
 * warnings because an agent should start if it can take a turn, and an optional capability it
 * cannot use is not part of that. The whole argument for degrading rested on the failure being
 * **visible**, so a page that did not render them would give the objection back its point — this
 * page showed `agent.warnings` nowhere at all.
 *
 * Rendered above everything else on the overview and never collapsed. A warning behind a tab is one
 * this project has already watched go unread for weeks, and these are the reason a bot is silent.
 */
export function WarningsPanel(props: {
    readonly warnings: readonly WireError[]
}): React.ReactElement | null {
    if (props.warnings.length === 0) return null
    // A one-line headline that is always on screen, with the detail a click away: the count stays
    // visible above every report panel, and a working agent stops reading as an outage.
    return (
        <details className="warnings">
            <summary>
                <span className="dot warn" />
                <h3>
                    {props.warnings.length} thing{props.warnings.length === 1 ? "" : "s"} this agent
                    could not set up
                </h3>
                <span className="sub" style={{ margin: "0 0 0 auto" }}>
                    details
                </span>
            </summary>
            <p className="sub">
                It is running. Each of these is a capability it does not have — fix the cause and
                restart the agent.
            </p>
            {props.warnings.map((warning) => (
                <div className="warning" key={`${warning.code}:${warning.message}`}>
                    <p className="warning-message">
                        {warning.field === undefined ? null : <code>{warning.field}</code>}{" "}
                        {warning.message}
                    </p>
                    {warning.hint === undefined ? null : <p className="hint">{warning.hint}</p>}
                </div>
            ))}
        </details>
    )
}

export function ChannelsPanel(props: {
    readonly channels: readonly ChannelRow[]
    /** Injected so staleness is deterministic. Never `Date.now()` inside a component. */
    readonly now: number
    /** Absent makes the panel read-only, which is what it was before 0.1.3. */
    readonly actions?: ChannelActions
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
                        {/*
                         * Two facts, not one. `enabled` is what the manifest says and `status` is
                         * what the process is doing — a disconnected channel has no status at all,
                         * because a disabled channel is never constructed, and showing only the
                         * runtime would leave the row somebody opened this page to switch back on
                         * with nothing on it.
                         */}
                        <p className={`status status-${channel.status ?? "off"}`}>
                            {channel.enabled === false
                                ? "disconnected"
                                : (channel.status ?? "not started here")}
                            {channel.detail === undefined ? null : ` — ${channel.detail}`}
                        </p>
                        {channel.credentialEnv === undefined ? null : (
                            <p className={channel.credentialSet === true ? "sub" : "warn"}>
                                <code>{channel.credentialEnv}</code>{" "}
                                {channel.credentialSet === true ? "is set" : "is NOT set"}
                            </p>
                        )}
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
                                <QrPayload kind={input.kind} payload={input.payload} />
                                <p className="sub">
                                    {input.kind} · issued {input.issuedAt}
                                    {input.expiresAt === undefined
                                        ? " · no expiry reported"
                                        : ` · expires ${input.expiresAt}`}
                                </p>
                            </div>
                        )}
                        {props.actions === undefined ? null : (
                            <ChannelControls channel={channel} actions={props.actions} />
                        )}
                    </section>
                )
            })}
            {props.actions?.note === undefined ? null : (
                <p className="row note">{props.actions.note}</p>
            )}
        </div>
    )
}

/**
 * The four things a person does to a channel.
 *
 * Controlled and stateless except for the credential box, which holds a secret — **in component
 * state and nowhere else**. Not `localStorage`, not the URL, not a form the browser offers to
 * remember: it is sent once and written into the agent's `.env` at 0600, and no route reads it back,
 * so a browser that remembered it would hold the only recoverable copy anywhere. `type="password"`
 * with `autoComplete="new-password"` is what declines the offer.
 *
 * `unpair` is offered only to a channel that has a pairing to forget, which the page cannot know
 * from the manifest alone — so it is keyed on the channel having *issued input*, or being of a type
 * that does. A button whose only outcome is a refusal is worse than no button, which is the same
 * call the schedules panel makes about a manifest-owned row.
 */
function ChannelControls(props: {
    readonly channel: ChannelRow
    readonly actions: ChannelActions
}): React.ReactElement {
    const [secret, setSecret] = useState("")
    const { channel, actions } = props
    const busy = actions.busy === channel.id
    const connected = channel.enabled !== false
    const pairs = channel.input !== undefined || channel.type === "whatsapp"

    return (
        <div className="channel-actions">
            <button
                type="button"
                disabled={busy}
                onClick={() => actions.onConnect(channel.id, !connected)}
            >
                {connected ? "disconnect" : "connect"}
            </button>
            {pairs ? (
                <button type="button" disabled={busy} onClick={() => actions.onUnpair(channel.id)}>
                    unpair
                </button>
            ) : null}
            {channel.credentialEnv === undefined ? null : (
                <form
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (secret === "") return
                        actions.onCredential(channel.id, secret)
                        // Cleared on submit, not on the response: it has left the page either way,
                        // and leaving it in the box is one screenshot from a leaked token.
                        setSecret("")
                    }}
                >
                    <input
                        type="password"
                        autoComplete="new-password"
                        placeholder={channel.credentialEnv}
                        value={secret}
                        disabled={busy}
                        onChange={(event) => setSecret(event.target.value)}
                    />
                    <button type="submit" disabled={busy || secret === ""}>
                        {channel.credentialSet === true ? "replace" : "set"}
                    </button>
                </form>
            )}
            {busy ? <span className="sub">working…</span> : null}
        </div>
    )
}

/** The sidebar's per-agent group, so the shell does not restate the panel list. */
export const AGENT_PANELS: readonly { readonly panel: PanelName; readonly label: string }[] = [
    { panel: "chat", label: "Chat" },
    { panel: "models", label: "Models" },
    { panel: "team", label: "Team" },
    { panel: "tools", label: "Tools" },
    { panel: "schedules", label: "Schedules" },
    { panel: "channels", label: "Channels" },
    { panel: "turns", label: "Turns" },
    { panel: "usage", label: "Usage" },
    { panel: "files", label: "Files" },
    { panel: "config", label: "Settings" },
]

/** The sidebar's server group. `new` is the shell's own button, since it is the one that writes. */
export const SERVER_PANELS: readonly { readonly panel: PanelName; readonly label: string }[] = [
    { panel: "home", label: "Overview" },
    { panel: "people", label: "People" },
    { panel: "rooms", label: "Rooms" },
    { panel: "actions", label: "Actions" },
    { panel: "memory", label: "Memory" },
    { panel: "webhooks", label: "Webhooks" },
    { panel: "backup", label: "Backup" },
    { panel: "keys", label: "Keys" },
    { panel: "api", label: "API" },
]

/**
 * A `needs_input` payload, drawn as something a phone can actually read.
 *
 * **The payload was rendered as text**, which is true and useless: WhatsApp's is 277 characters of
 * base64 and the whole point of it is to be scanned. Somebody who reached this panel after adding a
 * WhatsApp number saw a wall of string and correctly concluded they had not been shown a QR code.
 *
 * `QRCode.create` is **synchronous** and returns the module matrix, so this stays a pure function of
 * its props and renders to SVG with no canvas, no ref and no effect. That is not a style preference:
 * every test in this package is `renderToStaticMarkup` with no DOM, so a canvas would paint nothing
 * while every assertion still passed — the "a tree that does not paint is invisible to everything
 * except a screenshot" failure that took `app.tsx` entirely black. With a matrix, the encoding is
 * assertable.
 *
 * One `<path>` rather than ~1,800 `<rect>` elements, and a four-module quiet zone because the spec
 * requires one — a QR drawn flush to its container is one many scanners will not read.
 *
 * **Encoding can throw** — a payload past the format's capacity, or a `kind` this build has never
 * heard of — and a throw here would unmount the panel rather than show a QR. So an unknown kind and
 * a failure both fall back to the text, which is what this did for every payload until now.
 */
function QrPayload(props: { readonly kind: string; readonly payload: string }): React.ReactElement {
    /**
     * A pairing code is read by a person and typed into a phone, so it is set large and grouped.
     *
     * WhatsApp issues eight characters and shows them as two groups of four; matching that is what
     * makes somebody confident they are looking at the right thing. Grouped **for display only** —
     * the payload is never rewritten, because a code with a hyphen typed into a field that wants
     * eight characters fails in a way nobody attributes to the panel that drew it.
     */
    if (props.kind === "pairing_code")
        return (
            <p className="payload-code" data-kind={props.kind}>
                {props.payload.length === 8
                    ? `${props.payload.slice(0, 4)} ${props.payload.slice(4)}`
                    : props.payload}
            </p>
        )
    const drawn = props.kind === "qr" ? qrPath(props.payload) : undefined
    if (drawn === undefined)
        return (
            <pre className="payload" data-kind={props.kind}>
                {props.payload}
            </pre>
        )
    return (
        <svg
            className="payload-qr"
            viewBox={`0 0 ${drawn.extent} ${drawn.extent}`}
            data-kind={props.kind}
            data-modules={drawn.size}
            shapeRendering="crispEdges"
            role="img"
            aria-label="Scan this code from WhatsApp, under Linked devices"
        >
            <rect width={drawn.extent} height={drawn.extent} fill="#fff" />
            <path d={drawn.d} fill="#000" />
        </svg>
    )
}

/** The quiet zone the QR spec requires, in modules. Less than this and scanners start refusing. */
const QUIET_ZONE = 4

/** The matrix as one SVG path, or `undefined` when the payload cannot be encoded at all. */
function qrPath(payload: string): { d: string; size: number; extent: number } | undefined {
    try {
        const { modules } = QRCode.create(payload, { errorCorrectionLevel: "L" })
        const size = modules.size
        let d = ""
        for (let y = 0; y < size; y += 1)
            for (let x = 0; x < size; x += 1)
                if (modules.data[y * size + x] === 1)
                    d += `M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z`
        return d === "" ? undefined : { d, size, extent: size + QUIET_ZONE * 2 }
    } catch {
        return undefined
    }
}
