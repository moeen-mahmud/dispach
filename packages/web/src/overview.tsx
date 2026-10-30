/**
 * The server-level surfaces: every agent at a glance, one agent's team, and how to call the API.
 *
 * Props only and no fetching, for the reason `panels.tsx` gives — `renderToStaticMarkup` with no DOM
 * is a real test of what these draw.
 */

import { DEFAULT_BRAND } from "@dispach/core/wire"
import type React from "react"
import { useState } from "react"

/** A listing row, with the optional fields `GET /v1/agents` carries for a running agent. */
export interface OverviewAgent {
    readonly id: string
    readonly name: string
    readonly status: string
    readonly model?: string
    readonly dialect?: string
    readonly reason?: string
    readonly channels?: readonly {
        readonly id: string
        readonly type: string
        readonly status: string
    }[]
}

function initial(name: string): string {
    return name.trim().charAt(0) || "?"
}

/**
 * Every agent on the server, running and stopped.
 *
 * A stopped one is a card with the `start` that fixes it and no way in — its resource answers 404,
 * the same reason `AgentList` disables the row. `stop` is not offered, as everywhere in this page.
 */
export function HomePanel(props: {
    readonly agents: readonly OverviewAgent[]
    readonly onOpen: (id: string) => void
    readonly onStart: (id: string) => void
    readonly onNew: () => void
    readonly starting?: string
}): React.ReactElement {
    const running = props.agents.filter((agent) => agent.status !== "disabled").length
    return (
        <>
            <div className="page-head">
                <h1>Agents</h1>
                <p>
                    {props.agents.length} on this server · {running} running
                </p>
            </div>
            {props.agents.length === 0 ? (
                <div className="empty-state">
                    <h3>No agents yet</h3>
                    <p>Create one here, or run `{DEFAULT_BRAND.slug} init` in a terminal.</p>
                    <p style={{ marginTop: 14 }}>
                        <button type="button" className="primary" onClick={props.onNew}>
                            New agent
                        </button>
                    </p>
                </div>
            ) : (
                <div className="grid">
                    {props.agents.map((agent) => (
                        <AgentCard
                            key={agent.id}
                            agent={agent}
                            onOpen={props.onOpen}
                            onStart={props.onStart}
                            starting={props.starting === agent.id}
                        />
                    ))}
                </div>
            )}
        </>
    )
}

function AgentCard(props: {
    readonly agent: OverviewAgent
    readonly onOpen: (id: string) => void
    readonly onStart: (id: string) => void
    readonly starting: boolean
}): React.ReactElement {
    const { agent } = props
    const off = agent.status === "disabled"
    const body = (
        <>
            <div className="head">
                <span className="avatar">{initial(agent.name)}</span>
                <div style={{ minWidth: 0 }}>
                    <div className="name">{agent.name}</div>
                    <div className="id">{agent.id}</div>
                </div>
                <span style={{ marginLeft: "auto" }} className={`pill ${off ? "warn" : "ok"}`}>
                    <span className={`dot ${off ? "off" : "live"}`} />
                    {off ? "stopped" : "running"}
                </span>
            </div>
            {agent.model === undefined ? null : <div className="model">{agent.model}</div>}
            <div className="stats">
                {agent.dialect === undefined ? null : (
                    <span className="pill accent">{agent.dialect}</span>
                )}
                {(agent.channels ?? []).map((channel) => (
                    <span key={channel.id} className="pill">
                        <span
                            className={`dot ${channel.status === "connected" ? "live" : "off"}`}
                        />
                        {channel.type}
                    </span>
                ))}
            </div>
        </>
    )
    if (off) {
        return (
            <div className="agent-card off">
                {body}
                <div className="sub" style={{ margin: 0 }}>
                    {agent.reason ?? "switched off"}{" "}
                    <button
                        type="button"
                        className="link"
                        disabled={props.starting}
                        onClick={() => props.onStart(agent.id)}
                    >
                        {props.starting ? "starting…" : "start"}
                    </button>
                </div>
            </div>
        )
    }
    return (
        <button type="button" className="agent-card" onClick={() => props.onOpen(agent.id)}>
            {body}
        </button>
    )
}

/** One member, as `GET /v1/agents/:id` reports it. */
export interface TeamMember {
    readonly id: string
    readonly task: string
    readonly artifact: readonly string[]
}

/** An agent `ask_agent` can ask, as `GET /v1/agents/:id` reports it (`peers`). */
export interface Peer {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly shared: boolean
    readonly remote: boolean
}

/**
 * The supervisor and who it delegates to, then the person's other agents it can ask. Members are
 * read-only by design: they are excluded from every agent route so a member cannot be driven around
 * its supervisor's policy. The ask switch is `delegation.ask`, the person's setting.
 */
export function TeamPanel(props: {
    readonly lead: { readonly id: string; readonly name: string }
    readonly team: readonly TeamMember[] | undefined
    readonly peers?: readonly Peer[]
    /** `delegation.ask` as the manifest has it. */
    readonly ask?: boolean
    readonly busy?: boolean
    readonly onAsk?: (on: boolean) => void
}): React.ReactElement {
    const team = props.team ?? []
    const peers = props.peers ?? []
    return (
        <>
            <AskSection
                name={props.lead.name}
                peers={peers}
                ask={props.ask === true}
                busy={props.busy === true}
                {...(props.onAsk === undefined ? {} : { onAsk: props.onAsk })}
            />
            <div className="page-head">
                <h1>Team</h1>
                <p>
                    Who {props.lead.name} delegates to. Members are reached through it, never
                    directly, so its policy holds for every call they make.
                </p>
            </div>
            <div className="lead">
                <span className="avatar" style={{ width: 32, height: 32 }}>
                    {initial(props.lead.name)}
                </span>
                <div>
                    <div style={{ fontWeight: 600 }}>{props.lead.name}</div>
                    <div className="sub" style={{ margin: 0 }}>
                        supervisor · {team.length} member{team.length === 1 ? "" : "s"}
                    </div>
                </div>
            </div>
            {team.length === 0 ? (
                <div className="empty-state">
                    <h3>No team</h3>
                    <p>
                        Add a <code>team:</code> block to this agent's <code>agent.yaml</code> to
                        give it members it can hand work to.
                    </p>
                </div>
            ) : (
                <div className="grid">
                    {team.map((member) => (
                        <div key={member.id} className="member">
                            <div className="head">
                                <span className="avatar">{initial(member.id)}</span>
                                <strong>{member.id}</strong>
                            </div>
                            <p className="task">{member.task}</p>
                            <div className="stats">
                                {member.artifact.map((field) => (
                                    <span key={field} className="pill">
                                        {field}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </>
    )
}

/** Peer ask (`ask_agent`): the switch, and whom it reaches. */
function AskSection(props: {
    readonly name: string
    readonly peers: readonly Peer[]
    readonly ask: boolean
    readonly busy: boolean
    readonly onAsk?: (on: boolean) => void
}): React.ReactElement {
    return (
        // Spaced from the Team section below it, which starts with its own page heading.
        <section style={{ marginBottom: 40 }}>
            <div className="page-head">
                <h1>Peers</h1>
                <p>
                    The other agents working for the same person, which {props.name} can ask a
                    question. Both sides have to switch this on.
                </p>
            </div>
            <label className="check" style={{ marginBottom: 16 }}>
                <input
                    type="checkbox"
                    checked={props.ask}
                    disabled={props.busy || props.onAsk === undefined}
                    onChange={(event) => props.onAsk?.(event.target.checked)}
                />
                <span>
                    Ask and be asked <code>delegation.ask</code>
                </span>
            </label>
            {props.peers.length === 0 ? (
                <div className="empty-state">
                    <h3>Nobody to ask</h3>
                    <p>
                        {props.ask
                            ? "Either no other agent of this person, and no shared agent, has peer ask on, or this agent is assigned to nobody: a shared agent is asked but never asks."
                            : "Switch it on to let this agent ask the person's other agents, and be asked by them."}
                    </p>
                </div>
            ) : (
                <div className="grid">
                    {props.peers.map((peer) => (
                        <div key={peer.id} className="member">
                            <div className="head">
                                <span className="avatar">{initial(peer.name ?? peer.id)}</span>
                                <strong>{peer.name ?? peer.id}</strong>
                            </div>
                            {peer.description === undefined ? null : (
                                <p className="task">{peer.description}</p>
                            )}
                            <div className="stats">
                                {peer.name === undefined ? null : (
                                    <span className="pill">{peer.id}</span>
                                )}
                                {peer.shared ? <span className="pill">shared</span> : null}
                                {peer.remote ? <span className="pill">another silo</span> : null}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    )
}

/** Copy to the clipboard, saying so for a moment. Silent when the browser refuses. */
function CopyButton(props: { readonly text: string }): React.ReactElement {
    const [done, setDone] = useState(false)
    return (
        <button
            type="button"
            onClick={() => {
                void navigator.clipboard
                    ?.writeText(props.text)
                    .then(() => {
                        setDone(true)
                        setTimeout(() => setDone(false), 1200)
                    })
                    .catch(() => undefined)
            }}
        >
            {done ? "copied" : "copy"}
        </button>
    )
}

function Snippet(props: { readonly title: string; readonly code: string }): React.ReactElement {
    return (
        <div style={{ marginBottom: 16 }}>
            <div className="snippet-head">
                <h3>{props.title}</h3>
                <CopyButton text={props.code} />
            </div>
            <pre className="snippet">{props.code}</pre>
        </div>
    )
}

const ENDPOINTS: readonly {
    readonly method: string
    readonly path: string
    readonly what: string
}[] = [
    { method: "GET", path: "/v1/agents", what: "every agent, running or stopped" },
    { method: "POST", path: "/v1/agents/:id/messages", what: "start a turn" },
    { method: "GET", path: "/v1/agents/:id/turns/:turnId/stream", what: "a turn's events (SSE)" },
    { method: "GET", path: "/v1/agents/:id/sessions", what: "conversations" },
    { method: "GET", path: "/v1/agents/:id/approvals", what: "questions waiting on you" },
    { method: "POST", path: "/v1/keys", what: "mint an operator key" },
]

/**
 * How to drive this server from code. The token sentence is the one that matters: it is the
 * *server's* token — one per process, the container's when it runs in one — never an agent's.
 */
export function ApiPanel(props: {
    readonly baseUrl: string
    readonly agentId: string | undefined
}): React.ReactElement {
    const base = props.baseUrl.replace(/\/$/, "")
    const agent = props.agentId ?? "<agent>"
    const tokenVar = `${DEFAULT_BRAND.envPrefix}API_TOKEN`
    const send = `curl -X POST ${base}/v1/agents/${agent}/messages \\
  -H "Authorization: Bearer $${tokenVar}" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "hello", "stream": true}'`
    const list = `curl ${base}/v1/agents \\
  -H "Authorization: Bearer $${tokenVar}"`
    const mint = `${DEFAULT_BRAND.slug} credential create --label my-app`
    return (
        <>
            <div className="page-head">
                <h1>API</h1>
                <p>
                    Everything on this page is one HTTP API. Your backend sends a message; the agent
                    runs with its memory, tools, schedules and channels.
                </p>
            </div>
            <div className="cta-row" style={{ marginBottom: 24 }}>
                <a className="primary" href={`${base}/docs`} target="_blank" rel="noreferrer">
                    API reference ↗
                </a>
                <a href={`${base}/v1/openapi.json`} target="_blank" rel="noreferrer">
                    openapi.json
                </a>
            </div>

            <div className="card">
                <h3>Authentication</h3>
                <p style={{ margin: 0 }}>
                    Send <code>Authorization: Bearer &lt;token&gt;</code>. Two kinds work: the
                    server's own <code>{tokenVar}</code> — one per process, from the environment the
                    server was started with (in a container, the container's), not an agent's{" "}
                    <code>.env</code> — or an operator key minted with <code>{mint}</code> or{" "}
                    <code>POST /v1/keys</code>, which can be scoped and revoked.
                </p>
            </div>

            <div className="section-title">Quickstart</div>
            <Snippet title="List agents" code={list} />
            <Snippet title="Send a message, streamed" code={send} />

            <div className="section-title">Common endpoints</div>
            <div className="endpoints">
                {ENDPOINTS.map((endpoint) => (
                    <div key={`${endpoint.method} ${endpoint.path}`} className="endpoint">
                        <span className={`method ${endpoint.method === "GET" ? "get" : ""}`}>
                            {endpoint.method}
                        </span>
                        <code>{endpoint.path}</code>
                        <span className="what">{endpoint.what}</span>
                    </div>
                ))}
            </div>
        </>
    )
}

type Theme = "dark" | "light"
const THEME_KEY = `${DEFAULT_BRAND.slug}.theme`

/** The saved choice, applied before first paint by `main.tsx`. Storage can throw; dark is the default. */
export function savedTheme(): Theme | undefined {
    try {
        const value = localStorage.getItem(THEME_KEY)
        return value === "dark" || value === "light" ? value : undefined
    } catch {
        return undefined
    }
}

export function applyTheme(theme: Theme | undefined): void {
    if (theme === undefined) document.documentElement.removeAttribute("data-theme")
    else document.documentElement.setAttribute("data-theme", theme)
}

export function ThemeToggle(): React.ReactElement {
    const [theme, setTheme] = useState<Theme>(
        () =>
            savedTheme() ??
            (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
                ? "light"
                : "dark"),
    )
    const next: Theme = theme === "dark" ? "light" : "dark"
    return (
        <button
            type="button"
            className="ghost"
            aria-label={`switch to ${next} theme`}
            title={`switch to ${next} theme`}
            onClick={() => {
                setTheme(next)
                applyTheme(next)
                try {
                    localStorage.setItem(THEME_KEY, next)
                } catch {
                    // A private window: the choice lasts this page and no longer.
                }
            }}
        >
            {theme === "dark" ? "☾" : "☀"}
        </button>
    )
}
