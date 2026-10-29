/**
 * The multiplayer surfaces: people, rooms and DMs, the actions queue, and shared memory.
 *
 * Props only, like every panel. These are the Phase 27–29 primitives that had "no TUI or web
 * screens yet" in the wire spec: participants with presence and the agents they own, conversations
 * with mentions and hops, stand-in actions waiting on their owner, and the shared memory scopes
 * with their read audit. Every write is a route the server already had.
 */

import type React from "react"
import { useState } from "react"
import { Markdown } from "./Markdown.tsx"

export interface Person {
    readonly id: string
    readonly name?: string
    readonly role: "admin" | "member"
    readonly presence?: "online" | "offline"
    readonly presenceAt?: string
    readonly createdAt: string
}

export interface AgentRef {
    readonly id: string
    readonly name: string
}

function initial(text: string): string {
    return (text.split(":").pop() ?? text).trim().charAt(0) || "?"
}

/** `user:018f…` → `018f…`, `agent:crew` → `crew`; a label a person recognises. */
export function shortId(id: string): string {
    return id.includes(":") ? (id.split(":").pop() ?? id) : id
}

export function PeoplePanel(props: {
    readonly people: readonly Person[]
    /** Agent id → owner participant id, from `GET /agents/:id/assignee`. */
    readonly assignments: Readonly<Record<string, string>>
    readonly agents: readonly AgentRef[]
    readonly busy?: string
    readonly note?: string
    readonly onRegister?: (input: { id: string; name?: string; role: "admin" | "member" }) => void
    readonly onRemove?: (participantId: string) => void
    readonly onPresence?: (participantId: string, presence: "online" | "offline") => void
    readonly onAssign?: (agentId: string, participantId: string | undefined) => void
}): React.ReactElement {
    const [draft, setDraft] = useState({ id: "", name: "", role: "member" as "admin" | "member" })
    const owned = (participantId: string) =>
        Object.entries(props.assignments)
            .filter(([, owner]) => owner === participantId)
            .map(([agentId]) => agentId)
    return (
        <>
            <div className="page-head">
                <h1>People</h1>
                <p>
                    The humans this server knows, under the ids your own system gave them. An agent
                    assigned to a person works for them: it keeps their personal tools, reads their
                    memory scope, and stands in for them in a DM when they are away.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}
            {props.people.length === 0 ? (
                <div className="empty-state">
                    <h3>Nobody registered</h3>
                    <p>
                        Register a participant below, or <code>POST /v1/participants</code> from
                        your backend. A self-hosted install registers its owner on <code>init</code>
                        .
                    </p>
                </div>
            ) : (
                <div className="grid">
                    {props.people.map((person) => {
                        const agents = owned(person.id)
                        return (
                            <div key={person.id} className="card person">
                                <div className="head">
                                    <span className="avatar">
                                        {initial(person.name ?? person.id)}
                                    </span>
                                    <div style={{ minWidth: 0 }}>
                                        <div className="name">
                                            {person.name ?? shortId(person.id)}
                                        </div>
                                        <div className="id">{person.id}</div>
                                    </div>
                                    <span
                                        className={`pill${person.role === "admin" ? " accent" : ""}`}
                                        style={{ marginLeft: "auto" }}
                                    >
                                        {person.role}
                                    </span>
                                </div>
                                <div className="stats">
                                    <span className="pill">
                                        <span
                                            className={`dot ${person.presence === "offline" ? "off" : "live"}`}
                                        />
                                        {person.presence ?? "online (assumed)"}
                                    </span>
                                    {props.onPresence === undefined ? null : (
                                        <button
                                            type="button"
                                            className="link"
                                            disabled={props.busy === `presence:${person.id}`}
                                            onClick={() =>
                                                props.onPresence?.(
                                                    person.id,
                                                    person.presence === "offline"
                                                        ? "online"
                                                        : "offline",
                                                )
                                            }
                                        >
                                            mark{" "}
                                            {person.presence === "offline" ? "online" : "offline"}
                                        </button>
                                    )}
                                </div>
                                <div>
                                    <div className="facts-label">agents</div>
                                    {agents.length === 0 ? (
                                        <p className="sub" style={{ margin: 0 }}>
                                            none assigned
                                        </p>
                                    ) : (
                                        <div className="stats">
                                            {agents.map((agentId) => (
                                                <span key={agentId} className="pill">
                                                    {props.agents.find((a) => a.id === agentId)
                                                        ?.name ?? agentId}
                                                    {props.onAssign === undefined ? null : (
                                                        <button
                                                            type="button"
                                                            className="link"
                                                            aria-label={`unassign ${agentId}`}
                                                            disabled={
                                                                props.busy === `assign:${agentId}`
                                                            }
                                                            onClick={() =>
                                                                props.onAssign?.(agentId, undefined)
                                                            }
                                                        >
                                                            ×
                                                        </button>
                                                    )}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    {props.onAssign === undefined ? null : (
                                        <select
                                            aria-label={`assign an agent to ${person.id}`}
                                            value=""
                                            style={{ marginTop: 8 }}
                                            disabled={props.busy?.startsWith("assign:")}
                                            onChange={(event) => {
                                                if (event.target.value !== "")
                                                    props.onAssign?.(event.target.value, person.id)
                                            }}
                                        >
                                            <option value="">assign an agent…</option>
                                            {props.agents
                                                .filter(
                                                    (agent) =>
                                                        props.assignments[agent.id] !== person.id,
                                                )
                                                .map((agent) => (
                                                    <option key={agent.id} value={agent.id}>
                                                        {agent.name} ({agent.id})
                                                    </option>
                                                ))}
                                        </select>
                                    )}
                                </div>
                                {props.onRemove === undefined ? null : (
                                    <div
                                        style={{
                                            borderTop: "1px solid var(--line)",
                                            paddingTop: 10,
                                        }}
                                    >
                                        <button
                                            type="button"
                                            className="bad"
                                            disabled={props.busy === `remove:${person.id}`}
                                            onClick={() => props.onRemove?.(person.id)}
                                        >
                                            remove
                                        </button>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
            {props.onRegister === undefined ? null : (
                <form
                    className="card"
                    style={{ marginTop: 18 }}
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (draft.id.trim() === "") return
                        props.onRegister?.({
                            id: draft.id.trim(),
                            ...(draft.name.trim() === "" ? {} : { name: draft.name.trim() }),
                            role: draft.role,
                        })
                        setDraft({ id: "", name: "", role: "member" })
                    }}
                >
                    <h3>Register a person</h3>
                    <div
                        className="model-form"
                        style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
                    >
                        <label>
                            Id{" "}
                            <span className="sub">as your system knows them, e.g. user:018f…</span>
                            <input
                                value={draft.id}
                                placeholder="user:ada"
                                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                            />
                        </label>
                        <label>
                            Name
                            <input
                                value={draft.name}
                                placeholder="Ada"
                                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            />
                        </label>
                        <label>
                            Role
                            <select
                                value={draft.role}
                                onChange={(e) =>
                                    setDraft({
                                        ...draft,
                                        role: e.target.value as "admin" | "member",
                                    })
                                }
                            >
                                <option value="member">member</option>
                                <option value="admin">
                                    admin — may assign agents and write the space
                                </option>
                            </select>
                        </label>
                    </div>
                    <button
                        type="submit"
                        className="primary"
                        style={{ marginTop: 12 }}
                        disabled={draft.id.trim() === "" || props.busy === "register"}
                    >
                        register
                    </button>
                </form>
            )}
        </>
    )
}

export interface Room {
    readonly id: string
    readonly kind: "room" | "dm"
    readonly title?: string
    readonly members: readonly string[]
    readonly createdAt: string
}

export interface RoomMessage {
    readonly id: string
    readonly authorId: string
    readonly origin: "human" | "agent"
    readonly text: string
    readonly mentions: readonly string[]
    readonly hop: number
    readonly onBehalfOf?: string
    readonly createdAt: string
}

export function RoomsPanel(props: {
    readonly rooms: readonly Room[]
    readonly people: readonly Person[]
    readonly agents: readonly AgentRef[]
    readonly selected?: string
    readonly messages: readonly RoomMessage[]
    readonly busy?: string
    readonly note?: string
    readonly onSelect: (roomId: string | undefined) => void
    readonly onCreate?: (input: {
        kind: "room" | "dm"
        members: readonly string[]
        title?: string
    }) => void
    readonly onPost?: (
        roomId: string,
        text: string,
        authorId: string,
        mentions: readonly string[],
    ) => void
    readonly onMembers?: (
        roomId: string,
        change: { add?: readonly string[]; remove?: readonly string[] },
    ) => void
}): React.ReactElement {
    const room = props.rooms.find((entry) => entry.id === props.selected)
    return (
        <>
            <div className="page-head">
                <h1>Rooms</h1>
                <p>
                    Conversations among people and agents. In a room an agent answers only when
                    mentioned; in a DM it always does, and stands in for an absent owner.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}
            <div className="rooms-layout">
                <div className="rooms-list">
                    {props.rooms.length === 0 ? (
                        <p className="empty">no rooms yet</p>
                    ) : (
                        props.rooms.map((entry) => (
                            <button
                                type="button"
                                key={entry.id}
                                className="row-button"
                                aria-current={entry.id === props.selected}
                                onClick={() => props.onSelect(entry.id)}
                            >
                                <span className={`pill ${entry.kind === "dm" ? "" : "accent"}`}>
                                    {entry.kind}
                                </span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {entry.title ?? entry.members.map(shortId).join(", ")}
                                </span>
                            </button>
                        ))
                    )}
                    {props.onCreate === undefined ? null : (
                        <NewRoom
                            people={props.people}
                            agents={props.agents}
                            onCreate={props.onCreate}
                        />
                    )}
                </div>
                <div className="rooms-main">
                    {room === undefined ? (
                        <div className="empty-state">
                            <h3>Pick a room</h3>
                            <p>
                                Or create one on the left: a room for a team, a DM for one person
                                and one agent.
                            </p>
                        </div>
                    ) : (
                        <RoomView
                            room={room}
                            people={props.people}
                            agents={props.agents}
                            messages={props.messages}
                            busy={props.busy === `post:${room.id}`}
                            {...(props.onPost === undefined ? {} : { onPost: props.onPost })}
                            {...(props.onMembers === undefined
                                ? {}
                                : { onMembers: props.onMembers })}
                        />
                    )}
                </div>
            </div>
        </>
    )
}

function NewRoom(props: {
    readonly people: readonly Person[]
    readonly agents: readonly AgentRef[]
    readonly onCreate: (input: {
        kind: "room" | "dm"
        members: readonly string[]
        title?: string
    }) => void
}): React.ReactElement {
    const [open, setOpen] = useState(false)
    const [kind, setKind] = useState<"room" | "dm">("room")
    const [title, setTitle] = useState("")
    const [members, setMembers] = useState<readonly string[]>([])
    const toggle = (id: string) =>
        setMembers(members.includes(id) ? members.filter((m) => m !== id) : [...members, id])
    const humans = members.filter((m) => !m.startsWith("agent:")).length
    const bots = members.length - humans
    const ready = kind === "dm" ? humans === 1 && bots === 1 : members.length > 0
    if (!open)
        return (
            <button type="button" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
                + new room
            </button>
        )
    return (
        <form
            className="card"
            style={{ marginTop: 8 }}
            onSubmit={(event) => {
                event.preventDefault()
                if (!ready) return
                props.onCreate({
                    kind,
                    members,
                    ...(title.trim() === "" || kind === "dm" ? {} : { title: title.trim() }),
                })
                setOpen(false)
                setMembers([])
                setTitle("")
            }}
        >
            <fieldset className="segmented" style={{ marginBottom: 10 }}>
                <button
                    type="button"
                    aria-pressed={kind === "room"}
                    onClick={() => setKind("room")}
                >
                    room
                </button>
                <button type="button" aria-pressed={kind === "dm"} onClick={() => setKind("dm")}>
                    dm
                </button>
            </fieldset>
            {kind === "room" ? (
                <input
                    value={title}
                    placeholder="title"
                    style={{ marginBottom: 10 }}
                    onChange={(e) => setTitle(e.target.value)}
                />
            ) : (
                <p className="sub" style={{ margin: "0 0 10px" }}>
                    one person and one agent
                </p>
            )}
            <div className="members">
                {props.people.map((person) => (
                    <label key={person.id} className="check">
                        <input
                            type="checkbox"
                            checked={members.includes(person.id)}
                            onChange={() => toggle(person.id)}
                        />
                        {person.name ?? shortId(person.id)}
                    </label>
                ))}
                {props.agents.map((agent) => (
                    <label key={agent.id} className="check">
                        <input
                            type="checkbox"
                            checked={members.includes(`agent:${agent.id}`)}
                            onChange={() => toggle(`agent:${agent.id}`)}
                        />
                        <span className="pill accent">agent</span> {agent.name}
                    </label>
                ))}
            </div>
            <div className="cta-row" style={{ marginTop: 10 }}>
                <button type="submit" className="primary" disabled={!ready}>
                    create
                </button>
                <button type="button" onClick={() => setOpen(false)}>
                    cancel
                </button>
            </div>
        </form>
    )
}

function RoomView(props: {
    readonly room: Room
    readonly people: readonly Person[]
    readonly agents: readonly AgentRef[]
    readonly messages: readonly RoomMessage[]
    readonly busy: boolean
    readonly onPost?: (
        roomId: string,
        text: string,
        authorId: string,
        mentions: readonly string[],
    ) => void
    readonly onMembers?: (
        roomId: string,
        change: { add?: readonly string[]; remove?: readonly string[] },
    ) => void
}): React.ReactElement {
    const humans = props.room.members.filter((m) => !m.startsWith("agent:"))
    const agents = props.room.members.filter((m) => m.startsWith("agent:"))
    const [author, setAuthor] = useState(humans[0] ?? "")
    const [text, setText] = useState("")
    const [mentions, setMentions] = useState<readonly string[]>(
        props.room.kind === "dm" ? agents : [],
    )
    const nameOf = (id: string) =>
        id.startsWith("agent:")
            ? (props.agents.find((a) => a.id === id.slice("agent:".length))?.name ?? shortId(id))
            : (props.people.find((p) => p.id === id)?.name ?? shortId(id))
    return (
        <>
            <div className="room-head">
                <strong>{props.room.title ?? props.room.members.map(nameOf).join(", ")}</strong>
                <div className="stats">
                    {props.room.members.map((member) => (
                        <span
                            key={member}
                            className={`pill${member.startsWith("agent:") ? " accent" : ""}`}
                        >
                            {nameOf(member)}
                            {props.onMembers === undefined || props.room.kind === "dm" ? null : (
                                <button
                                    type="button"
                                    className="link"
                                    aria-label={`remove ${member}`}
                                    onClick={() =>
                                        props.onMembers?.(props.room.id, { remove: [member] })
                                    }
                                >
                                    ×
                                </button>
                            )}
                        </span>
                    ))}
                </div>
            </div>
            <div className="room-log">
                {props.messages.length === 0 ? (
                    <p className="empty">nothing said yet</p>
                ) : (
                    props.messages.map((message) => (
                        <div
                            key={message.id}
                            className={`room-msg${message.origin === "agent" ? " agent" : ""}`}
                        >
                            <div className="label">
                                {nameOf(message.authorId)}
                                {message.onBehalfOf === undefined
                                    ? ""
                                    : ` · standing in for ${nameOf(message.onBehalfOf)}`}
                                {message.hop > 0 ? ` · hop ${message.hop}` : ""}
                                {" · "}
                                {message.createdAt.replace("T", " ").slice(0, 16)}
                            </div>
                            {message.origin === "agent" ? (
                                <Markdown text={message.text} />
                            ) : (
                                <p style={{ margin: 0 }}>{message.text}</p>
                            )}
                        </div>
                    ))
                )}
            </div>
            {props.onPost === undefined || humans.length === 0 ? null : (
                <form
                    className="room-post"
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (text.trim() === "" || author === "") return
                        props.onPost?.(props.room.id, text.trim(), author, mentions)
                        setText("")
                    }}
                >
                    <div className="inline" style={{ flexWrap: "wrap" }}>
                        <select
                            aria-label="post as"
                            value={author}
                            onChange={(e) => setAuthor(e.target.value)}
                        >
                            {humans.map((human) => (
                                <option key={human} value={human}>
                                    as {nameOf(human)}
                                </option>
                            ))}
                        </select>
                        {props.room.kind === "dm"
                            ? null
                            : agents.map((agent) => (
                                  <label key={agent} className="check">
                                      <input
                                          type="checkbox"
                                          checked={mentions.includes(agent)}
                                          onChange={() =>
                                              setMentions(
                                                  mentions.includes(agent)
                                                      ? mentions.filter((m) => m !== agent)
                                                      : [...mentions, agent],
                                              )
                                          }
                                      />
                                      @{nameOf(agent)}
                                  </label>
                              ))}
                    </div>
                    <div className="inline" style={{ marginTop: 8 }}>
                        <input
                            value={text}
                            placeholder={
                                props.room.kind === "dm"
                                    ? "say something"
                                    : mentions.length === 0
                                      ? "say something — tick an agent for it to answer"
                                      : "say something"
                            }
                            onChange={(e) => setText(e.target.value)}
                        />
                        <button
                            type="submit"
                            className="primary"
                            disabled={props.busy || text.trim() === ""}
                        >
                            post
                        </button>
                    </div>
                </form>
            )}
        </>
    )
}

export interface Action {
    readonly id: string
    readonly agentId: string
    readonly conversationId: string
    readonly ownerId: string
    readonly requestedBy: string
    readonly slug: string
    readonly args: Readonly<Record<string, unknown>>
    readonly status: "pending" | "done" | "failed" | "denied"
    readonly result?: string
    readonly createdAt: string
    readonly decidedAt?: string
}

export function ActionsPanel(props: {
    readonly actions: readonly Action[]
    readonly busy?: string
    readonly onDecide?: (actionId: string, approve: boolean) => void
}): React.ReactElement {
    const pending = props.actions.filter((action) => action.status === "pending")
    const settled = props.actions.filter((action) => action.status !== "pending")
    return (
        <>
            <div className="page-head">
                <h1>Actions</h1>
                <p>
                    Calls a stand-in wanted to make on somebody's behalf. A stand-in never changes
                    anything itself: the exact call waits here for its owner, and runs as their
                    agent only once approved.
                </p>
            </div>
            {pending.length === 0 ? (
                <div className="empty-state">
                    <h3>Nothing waiting</h3>
                    <p>
                        A queued action appears when an agent standing in for an absent person tries
                        a tool that changes things.
                    </p>
                </div>
            ) : (
                <div className="grid">
                    {pending.map((action) => (
                        <div key={action.id} className="card">
                            <div className="head">
                                <code>{action.slug}</code>
                                <span className="pill warn" style={{ marginLeft: "auto" }}>
                                    pending
                                </span>
                            </div>
                            <p className="sub">
                                for {shortId(action.ownerId)}, asked by{" "}
                                {shortId(action.requestedBy)} · agent {action.agentId} ·{" "}
                                {action.createdAt.replace("T", " ").slice(0, 16)}
                            </p>
                            <pre className="snippet">{JSON.stringify(action.args, null, 2)}</pre>
                            {props.onDecide === undefined ? null : (
                                <div className="cta-row" style={{ marginTop: 10 }}>
                                    <button
                                        type="button"
                                        className="primary"
                                        disabled={props.busy === action.id}
                                        onClick={() => props.onDecide?.(action.id, true)}
                                    >
                                        approve and run
                                    </button>
                                    <button
                                        type="button"
                                        disabled={props.busy === action.id}
                                        onClick={() => props.onDecide?.(action.id, false)}
                                    >
                                        decline
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {settled.length === 0 ? null : (
                <>
                    <div className="section-title">Decided</div>
                    <table className="panel-table">
                        <thead>
                            <tr>
                                <th>call</th>
                                <th>for</th>
                                <th>outcome</th>
                                <th>when</th>
                            </tr>
                        </thead>
                        <tbody>
                            {settled.map((action) => (
                                <tr key={action.id}>
                                    <td>
                                        <code>{action.slug}</code>
                                    </td>
                                    <td>{shortId(action.ownerId)}</td>
                                    <td>
                                        {action.status}
                                        {action.result === undefined ? null : (
                                            <div className="sub">{action.result.slice(0, 200)}</div>
                                        )}
                                    </td>
                                    <td>
                                        {(action.decidedAt ?? action.createdAt)
                                            .replace("T", " ")
                                            .slice(0, 16)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
        </>
    )
}

export interface Note {
    readonly id: string
    readonly scope: string
    readonly text: string
    readonly writtenBy: string
    readonly createdAt: string
}

export interface Project {
    readonly id: string
    readonly name?: string
    readonly agents: readonly string[]
    readonly createdAt: string
}

export interface MemoryRead {
    readonly scope: string
    readonly reader: string
    readonly requestedBy?: string
    readonly onBehalfOf?: string
    readonly at: string
}

export function MemoryPanel(props: {
    readonly scope: string
    readonly scopes: readonly string[]
    readonly notes: readonly Note[] | undefined
    readonly projects: readonly Project[]
    readonly agents: readonly AgentRef[]
    readonly reads?: readonly MemoryRead[]
    readonly busy?: string
    readonly note?: string
    readonly onScope: (scope: string) => void
    readonly onAdd?: (scope: string, text: string) => void
    readonly onDelete?: (noteId: string) => void
    readonly onProject?: (
        projectId: string,
        input: { name?: string; agents?: readonly string[] },
    ) => void
    readonly onDeleteProject?: (projectId: string) => void
    readonly onSpaceWriter?: (writer: string) => void
}): React.ReactElement {
    const [text, setText] = useState("")
    const [newProject, setNewProject] = useState("")
    const [writer, setWriter] = useState("")
    return (
        <>
            <div className="page-head">
                <h1>Memory</h1>
                <p>
                    Shared scopes every agent recalls from when a turn is about them: the{" "}
                    <code>space</code> for everyone, <code>owner:&lt;person&gt;</code> for one
                    person's notes, <code>project:&lt;id&gt;</code> for the agents on a project.
                    Private memory stays on each agent.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}
            <div className="inline" style={{ marginBottom: 14, flexWrap: "wrap" }}>
                <select
                    aria-label="memory scope"
                    value={props.scope}
                    onChange={(e) => props.onScope(e.target.value)}
                    style={{ width: "auto" }}
                >
                    {props.scopes.map((scope) => (
                        <option key={scope} value={scope}>
                            {scope}
                        </option>
                    ))}
                </select>
                <input
                    aria-label="another scope"
                    placeholder="or type one: owner:user:ada"
                    style={{ maxWidth: 280 }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault()
                            const value = (e.target as HTMLInputElement).value.trim()
                            if (value !== "") props.onScope(value)
                        }
                    }}
                />
            </div>
            {props.notes === undefined ? (
                <p className="empty">reading…</p>
            ) : props.notes.length === 0 ? (
                <p className="empty">no notes in {props.scope}</p>
            ) : (
                <div className="notes">
                    {props.notes.map((entry) => (
                        <div key={entry.id} className="card note-card">
                            <p style={{ margin: 0, color: "var(--text)" }}>{entry.text}</p>
                            <div
                                className="sub"
                                style={{ display: "flex", gap: 10, alignItems: "center" }}
                            >
                                <span>
                                    {shortId(entry.writtenBy)} ·{" "}
                                    {entry.createdAt.replace("T", " ").slice(0, 16)}
                                </span>
                                {props.onDelete === undefined ? null : (
                                    <button
                                        type="button"
                                        className="link"
                                        disabled={props.busy === entry.id}
                                        onClick={() => props.onDelete?.(entry.id)}
                                    >
                                        remove
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {props.onAdd === undefined ? null : (
                <form
                    className="inline"
                    style={{ marginTop: 12 }}
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (text.trim() === "") return
                        props.onAdd?.(props.scope, text.trim())
                        setText("")
                    }}
                >
                    <input
                        value={text}
                        placeholder={`a note for ${props.scope}`}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <button
                        type="submit"
                        className="primary"
                        disabled={text.trim() === "" || props.busy === "add"}
                    >
                        add
                    </button>
                </form>
            )}

            <div className="section-title">Projects</div>
            <p className="sub" style={{ marginBottom: 10 }}>
                A project is a memory scope shared by the agents on it. Name the agents and they
                recall its notes.
            </p>
            {props.projects.length === 0 ? <p className="empty">no projects</p> : null}
            <div className="grid">
                {props.projects.map((project) => (
                    <div key={project.id} className="card">
                        <div className="head">
                            <strong>{project.name ?? project.id}</strong>
                            <code style={{ marginLeft: "auto" }}>project:{project.id}</code>
                        </div>
                        <div className="stats" style={{ margin: "8px 0" }}>
                            {props.agents.map((agent) => {
                                const on = project.agents.includes(agent.id)
                                return (
                                    <label key={agent.id} className="check">
                                        <input
                                            type="checkbox"
                                            checked={on}
                                            disabled={
                                                props.onProject === undefined ||
                                                props.busy === `project:${project.id}`
                                            }
                                            onChange={() =>
                                                props.onProject?.(project.id, {
                                                    agents: on
                                                        ? project.agents.filter(
                                                              (a) => a !== agent.id,
                                                          )
                                                        : [...project.agents, agent.id],
                                                })
                                            }
                                        />
                                        {agent.name}
                                    </label>
                                )
                            })}
                        </div>
                        <div className="cta-row">
                            <button
                                type="button"
                                onClick={() => props.onScope(`project:${project.id}`)}
                            >
                                notes
                            </button>
                            {props.onDeleteProject === undefined ? null : (
                                <button
                                    type="button"
                                    className="bad"
                                    disabled={props.busy === `project:${project.id}`}
                                    onClick={() => props.onDeleteProject?.(project.id)}
                                >
                                    delete
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            {props.onProject === undefined ? null : (
                <form
                    className="inline"
                    style={{ marginTop: 12 }}
                    onSubmit={(event) => {
                        event.preventDefault()
                        const id = newProject
                            .trim()
                            .toLowerCase()
                            .replace(/[^a-z0-9_-]+/g, "-")
                        if (id === "") return
                        props.onProject?.(id, { name: newProject.trim(), agents: [] })
                        setNewProject("")
                    }}
                >
                    <input
                        value={newProject}
                        placeholder="new project name"
                        onChange={(e) => setNewProject(e.target.value)}
                    />
                    <button type="submit" disabled={newProject.trim() === ""}>
                        create
                    </button>
                </form>
            )}

            {props.onSpaceWriter === undefined ? null : (
                <>
                    <div className="section-title">Space writer</div>
                    <p className="sub" style={{ marginBottom: 10 }}>
                        The one non-admin who may write <code>space</code>. Name an agent as{" "}
                        <code>agent:&lt;id&gt;</code> and its <code>memory_write</code> goes to the
                        space — so name one that holds nobody's private context.
                    </p>
                    <form
                        className="inline"
                        onSubmit={(event) => {
                            event.preventDefault()
                            if (writer.trim() !== "") props.onSpaceWriter?.(writer.trim())
                        }}
                    >
                        <input
                            value={writer}
                            placeholder="user:ada or agent:crew"
                            onChange={(e) => setWriter(e.target.value)}
                        />
                        <button
                            type="submit"
                            disabled={writer.trim() === "" || props.busy === "space-writer"}
                        >
                            set
                        </button>
                    </form>
                </>
            )}

            {props.reads === undefined ? null : (
                <>
                    <div className="section-title">Reads of this person's scope by others</div>
                    {props.reads.length === 0 ? (
                        <p className="empty">none recorded</p>
                    ) : (
                        <table className="panel-table">
                            <thead>
                                <tr>
                                    <th>when</th>
                                    <th>reader</th>
                                    <th>for</th>
                                </tr>
                            </thead>
                            <tbody>
                                {props.reads.map((read) => (
                                    <tr key={`${read.at}:${read.reader}`}>
                                        <td>{read.at.replace("T", " ").slice(0, 16)}</td>
                                        <td>{shortId(read.reader)}</td>
                                        <td>
                                            {read.requestedBy === undefined
                                                ? "—"
                                                : shortId(read.requestedBy)}
                                            {read.onBehalfOf === undefined
                                                ? ""
                                                : ` (standing in for ${shortId(read.onBehalfOf)})`}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </>
            )}
        </>
    )
}
