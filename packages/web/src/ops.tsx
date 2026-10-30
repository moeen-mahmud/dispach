/**
 * Operator surfaces: webhooks, backup and bundles, templates, workspace files, and adding a channel.
 *
 * Props only. Each is a thin screen over one or two routes the server already had and the
 * console never offered: `/v1/webhooks`, `/v1/backup` + `/export` + `/import`, `/v1/templates` +
 * `POST /v1/agents {template}`, `/workspace/:file`, and `channels` through `PATCH /config`.
 */

import type React from "react"
import { useState } from "react"

/* ─── webhooks ─────────────────────────────────────────────────────────────── */

export interface Webhook {
    readonly subscriptionId: string
    readonly url: string
    readonly types: readonly string[]
    readonly scope?: { readonly agents?: readonly string[]; readonly sessionPrefix?: string }
    readonly createdAt: string
    readonly failing: boolean
    readonly consecutiveFailures: number
    readonly lastError?: string
    readonly lastSuccessAt?: string
    readonly lastFailureAt?: string
    readonly pending: number
}

export function WebhooksPanel(props: {
    readonly webhooks: readonly Webhook[]
    readonly eventTypes: readonly string[]
    readonly agents: readonly { readonly id: string; readonly name: string }[]
    readonly secret?: string
    readonly busy?: string
    readonly note?: string
    readonly onCreate?: (input: {
        url: string
        types: readonly string[]
        agents?: readonly string[]
    }) => void
    readonly onDelete?: (subscriptionId: string) => void
    readonly onDismissSecret?: () => void
}): React.ReactElement {
    const [url, setUrl] = useState("")
    const [types, setTypes] = useState<readonly string[]>(["turn.end"])
    const [agentIds, setAgentIds] = useState<readonly string[]>([])
    const [filter, setFilter] = useState("")
    const shownTypes = props.eventTypes.filter(
        (type) => type !== "model.chunk" && type.includes(filter.trim()),
    )
    const ready = /^https:\/\/\S+$/.test(url.trim()) && types.length > 0
    return (
        <>
            <div className="page-head">
                <h1>Webhooks</h1>
                <p>
                    Events POSTed to a URL you own, signed per Standard Webhooks. A subscription
                    hears only the agents its creating key could reach. <code>model.chunk</code> is
                    never delivered.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}
            {props.secret === undefined ? null : (
                <div className="card">
                    <h3>Signing secret</h3>
                    <div className="secret">{props.secret}</div>
                    <p className="hint" style={{ margin: 0 }}>
                        Shown once. Verify <code>webhook-signature</code> with it.{" "}
                        <button type="button" className="link" onClick={props.onDismissSecret}>
                            I have copied it
                        </button>
                    </p>
                </div>
            )}
            {props.webhooks.length === 0 ? (
                <div className="empty-state">
                    <h3>No subscriptions</h3>
                    <p>
                        Add one below to be told when a turn ends, an approval is needed, or a
                        delivery fails.
                    </p>
                </div>
            ) : (
                <table className="panel-table">
                    <thead>
                        <tr>
                            <th>url</th>
                            <th>events</th>
                            <th>health</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {props.webhooks.map((hook) => (
                            <tr key={hook.subscriptionId}>
                                <td>
                                    <code>{hook.url}</code>
                                    {hook.scope?.agents === undefined ? null : (
                                        <div className="sub">
                                            agents: {hook.scope.agents.join(", ")}
                                        </div>
                                    )}
                                </td>
                                <td>
                                    <div className="stats">
                                        {hook.types.map((type) => (
                                            <span key={type} className="pill">
                                                {type}
                                            </span>
                                        ))}
                                    </div>
                                </td>
                                <td>
                                    <span className={`pill ${hook.failing ? "warn" : "ok"}`}>
                                        <span className={`dot ${hook.failing ? "warn" : "live"}`} />
                                        {hook.failing
                                            ? `failing (${hook.consecutiveFailures})`
                                            : "healthy"}
                                    </span>
                                    {hook.pending > 0 ? (
                                        <div className="sub">{hook.pending} pending</div>
                                    ) : null}
                                    {hook.lastError === undefined ? null : (
                                        <div className="sub">{hook.lastError}</div>
                                    )}
                                </td>
                                <td>
                                    {props.onDelete === undefined ? null : (
                                        <button
                                            type="button"
                                            className="bad"
                                            disabled={props.busy === hook.subscriptionId}
                                            onClick={() => props.onDelete?.(hook.subscriptionId)}
                                        >
                                            delete
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {props.onCreate === undefined ? null : (
                <form
                    className="card"
                    style={{ marginTop: 18 }}
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (!ready) return
                        props.onCreate?.({
                            url: url.trim(),
                            types,
                            ...(agentIds.length === 0 ? {} : { agents: agentIds }),
                        })
                        setUrl("")
                    }}
                >
                    <h3>New subscription</h3>
                    <div
                        className="model-form"
                        style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}
                    >
                        <label style={{ gridColumn: "1 / -1" }}>
                            URL{" "}
                            <span className="sub">
                                https only; a private address needs WEBHOOK_ALLOW on the server
                            </span>
                            <input
                                value={url}
                                placeholder="https://example.com/hooks/agent-events"
                                onChange={(e) => setUrl(e.target.value)}
                            />
                        </label>
                        <div className="field-like" style={{ gridColumn: "1 / -1" }}>
                            <span className="field-label">
                                Events <span className="sub">{types.length} selected</span>
                            </span>
                            <input
                                aria-label="filter event types"
                                value={filter}
                                placeholder="filter…"
                                onChange={(e) => setFilter(e.target.value)}
                            />
                            <div className="members" style={{ marginTop: 8 }}>
                                {shownTypes.map((type) => (
                                    <label key={type} className="check">
                                        <input
                                            type="checkbox"
                                            checked={types.includes(type)}
                                            onChange={() =>
                                                setTypes(
                                                    types.includes(type)
                                                        ? types.filter((t) => t !== type)
                                                        : [...types, type],
                                                )
                                            }
                                        />
                                        <code>{type}</code>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div className="field-like" style={{ gridColumn: "1 / -1" }}>
                            <span className="field-label">
                                Agents{" "}
                                <span className="sub">
                                    none ticked hears every agent this key reaches
                                </span>
                            </span>
                            <div className="members">
                                {props.agents.map((agent) => (
                                    <label key={agent.id} className="check">
                                        <input
                                            type="checkbox"
                                            checked={agentIds.includes(agent.id)}
                                            onChange={() =>
                                                setAgentIds(
                                                    agentIds.includes(agent.id)
                                                        ? agentIds.filter((a) => a !== agent.id)
                                                        : [...agentIds, agent.id],
                                                )
                                            }
                                        />
                                        {agent.name}
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>
                    <button
                        type="submit"
                        className="primary"
                        style={{ marginTop: 12 }}
                        disabled={!ready || props.busy === "webhook"}
                    >
                        subscribe
                    </button>
                </form>
            )}
        </>
    )
}

/* ─── backup, export, import ───────────────────────────────────────────────── */

export interface ImportReport {
    readonly added: readonly string[]
    readonly merged: readonly { readonly path: string; readonly notes: number }[]
    readonly skipped: readonly string[]
    readonly overwritten: readonly string[]
    readonly evicted: number
    readonly reload: "none" | "loaded" | "pending"
}

export function BackupPanel(props: {
    readonly agents: readonly { readonly id: string; readonly name: string }[]
    readonly busy?: string
    readonly note?: string
    readonly lastImport?: ImportReport
    readonly onBackup?: (include: readonly ("env" | "git" | "home")[]) => void
    readonly onExport?: (agentId: string) => void
    readonly onImport?: (agentId: string, file: File, mode: "skip" | "overwrite") => void
}): React.ReactElement {
    const [include, setInclude] = useState<readonly ("env" | "git" | "home")[]>([])
    // The listing arrives after the first render, so an empty choice means "the first agent".
    const [chosenAgent, setAgentId] = useState("")
    const agentId = chosenAgent === "" ? (props.agents[0]?.id ?? "") : chosenAgent
    const [mode, setMode] = useState<"skip" | "overwrite">("skip")
    const [file, setFile] = useState<File>()
    const toggle = (what: "env" | "git" | "home") =>
        setInclude(include.includes(what) ? include.filter((w) => w !== what) : [...include, what])
    return (
        <>
            <div className="page-head">
                <h1>Backup</h1>
                <p>
                    The whole server as a tar.gz, or one agent's memory and knowledge as a bundle
                    another agent can take in.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}
            <div className="card">
                <h3>Server backup</h3>
                <p>
                    A consistent store snapshot and every hosted agent's directory, with a{" "}
                    <code>backup.json</code> manifest. Needs an unscoped key. Secrets, git history
                    and the rest of the state directory are left out unless asked for.
                </p>
                <div className="members" style={{ marginBottom: 12 }}>
                    {(["env", "git", "home"] as const).map((what) => (
                        <label key={what} className="check">
                            <input
                                type="checkbox"
                                checked={include.includes(what)}
                                onChange={() => toggle(what)}
                            />
                            {what === "env"
                                ? "each agent's .env (its secrets)"
                                : what === "git"
                                  ? ".git directories"
                                  : "the rest of the state directory"}
                        </label>
                    ))}
                </div>
                <button
                    type="button"
                    className="primary"
                    disabled={props.onBackup === undefined || props.busy === "backup"}
                    onClick={() => props.onBackup?.(include)}
                >
                    {props.busy === "backup" ? "preparing…" : "download backup"}
                </button>
            </div>
            <div className="card">
                <h3>Agent bundle</h3>
                <p>
                    <code>MEMORY.md</code>, the memory archive and <code>knowledge/</code>. Never
                    the manifest, secrets or skills. Importing merges memory note by note and keeps
                    or overwrites a knowledge file.
                </p>
                <div className="inline" style={{ flexWrap: "wrap", gap: 10 }}>
                    <select
                        aria-label="agent"
                        value={agentId}
                        onChange={(e) => setAgentId(e.target.value)}
                        style={{ width: "auto" }}
                    >
                        {props.agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                                {agent.name}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        disabled={
                            props.onExport === undefined ||
                            agentId === "" ||
                            props.busy === `export:${agentId}`
                        }
                        onClick={() => props.onExport?.(agentId)}
                    >
                        export bundle
                    </button>
                </div>
                <div className="inline" style={{ flexWrap: "wrap", gap: 10, marginTop: 12 }}>
                    <input
                        type="file"
                        accept="application/json,.json"
                        aria-label="bundle file"
                        onChange={(e) => setFile(e.target.files?.[0])}
                        style={{ width: "auto" }}
                    />
                    <select
                        aria-label="knowledge mode"
                        value={mode}
                        onChange={(e) => setMode(e.target.value as "skip" | "overwrite")}
                        style={{ width: "auto" }}
                    >
                        <option value="skip">keep an existing knowledge file</option>
                        <option value="overwrite">overwrite knowledge files</option>
                    </select>
                    <button
                        type="button"
                        className="primary"
                        disabled={
                            props.onImport === undefined ||
                            file === undefined ||
                            agentId === "" ||
                            props.busy === `import:${agentId}`
                        }
                        onClick={() => {
                            if (file !== undefined) props.onImport?.(agentId, file, mode)
                        }}
                    >
                        import into {props.agents.find((a) => a.id === agentId)?.name ?? "agent"}
                    </button>
                </div>
                {props.lastImport === undefined ? null : (
                    <p className="sub" style={{ marginTop: 10 }}>
                        imported: {props.lastImport.added.length} added,{" "}
                        {props.lastImport.merged.reduce((n, m) => n + m.notes, 0)} notes merged,{" "}
                        {props.lastImport.skipped.length} kept,{" "}
                        {props.lastImport.overwritten.length} overwritten
                        {props.lastImport.evicted > 0
                            ? `, ${props.lastImport.evicted} evicted`
                            : ""}{" "}
                        · reload {props.lastImport.reload}
                    </p>
                )}
            </div>
        </>
    )
}

/* ─── templates ────────────────────────────────────────────────────────────── */

export interface Template {
    readonly name: string
    readonly description?: string
    readonly vars: readonly {
        readonly name: string
        readonly description?: string
        readonly required: boolean
        readonly default?: string
        readonly secret: boolean
    }[]
    readonly problem?: { readonly code: string; readonly message: string; readonly hint?: string }
}

export function TemplateForm(props: {
    readonly templates: readonly Template[]
    readonly busy: boolean
    readonly error?: string
    readonly onCreate: (input: {
        template: string
        name: string
        vars: Readonly<Record<string, string>>
    }) => void
}): React.ReactElement {
    const usable = props.templates.filter((template) => template.problem === undefined)
    const [chosen, setChosen] = useState(usable[0]?.name ?? "")
    const [name, setName] = useState("")
    const [vars, setVars] = useState<Readonly<Record<string, string>>>({})
    const template = props.templates.find((entry) => entry.name === chosen)
    const missing = (template?.vars ?? []).filter(
        (v) => v.required && (vars[v.name] ?? v.default ?? "") === "",
    )
    const ready = template !== undefined && name.trim() !== "" && missing.length === 0
    if (props.templates.length === 0)
        return (
            <div className="empty-state">
                <h3>No templates</h3>
                <p>
                    A template is an agent directory under the sandbox's{" "}
                    <code>templates/&lt;name&gt;/</code> with a <code>template.yaml</code> declaring
                    its variables.
                </p>
            </div>
        )
    return (
        <form
            className="provision"
            onSubmit={(event) => {
                event.preventDefault()
                if (!ready || template === undefined) return
                const filled = Object.fromEntries(
                    template.vars
                        .map((v) => [v.name, vars[v.name] ?? v.default ?? ""])
                        .filter(([, value]) => value !== ""),
                )
                props.onCreate({ template: template.name, name: name.trim(), vars: filled })
            }}
        >
            <div className="field">
                <label htmlFor="tpl">Template</label>
                <select id="tpl" value={chosen} onChange={(e) => setChosen(e.target.value)}>
                    {props.templates.map((entry) => (
                        <option
                            key={entry.name}
                            value={entry.name}
                            disabled={entry.problem !== undefined}
                        >
                            {entry.name}
                            {entry.problem === undefined ? "" : " (broken)"}
                        </option>
                    ))}
                </select>
                {template?.description === undefined ? null : (
                    <p className="sub">{template.description}</p>
                )}
                {template?.problem === undefined ? null : (
                    <p className="error">{template.problem.message}</p>
                )}
            </div>
            <div className="field">
                <label htmlFor="tpl-name">Agent name</label>
                <input
                    id="tpl-name"
                    value={name}
                    placeholder="Acme store"
                    onChange={(e) => setName(e.target.value)}
                />
                <p className="sub">Its slug becomes the id every route keys on.</p>
            </div>
            {(template?.vars ?? []).map((v) => (
                <div key={v.name} className={`field${missing.includes(v) ? " invalid" : ""}`}>
                    <label htmlFor={`var-${v.name}`}>
                        {v.name}
                        {v.required ? "" : " (optional)"}
                        {v.secret ? " · secret, goes to .env" : ""}
                    </label>
                    <input
                        id={`var-${v.name}`}
                        type={v.secret ? "password" : "text"}
                        autoComplete={v.secret ? "new-password" : "off"}
                        value={vars[v.name] ?? ""}
                        placeholder={v.default ?? ""}
                        onChange={(e) => setVars({ ...vars, [v.name]: e.target.value })}
                    />
                    {v.description === undefined ? null : <p className="sub">{v.description}</p>}
                </div>
            ))}
            {props.error === undefined ? null : <p className="error">{props.error}</p>}
            <button type="submit" className="primary" disabled={!ready || props.busy}>
                {props.busy ? "creating…" : "create from template"}
            </button>
        </form>
    )
}

/* ─── workspace files ──────────────────────────────────────────────────────── */

export interface WorkspaceEntry {
    readonly name: string
    readonly tier: string
    readonly field: string
    readonly exists: boolean
    readonly bytes: number
}

/**
 * An agent made from a template: the values it was rendered with, editable. A save re-renders only
 * the files nobody edited since, so the result names what was kept as well as what changed. Secret
 * vars are listed and never shown or set here: they live in `.env`, which no route returns.
 */
export function TemplateVars(props: {
    readonly template: string
    /** The template's declarations; absent when the template has since left the server. */
    readonly declared?: Template["vars"]
    readonly values: Readonly<Record<string, string>>
    readonly busy?: boolean
    readonly onSave?: (vars: Readonly<Record<string, string>>) => void
}): React.ReactElement {
    const [draft, setDraft] = useState<Readonly<Record<string, string>>>({})
    const plain = (
        props.declared ?? Object.keys(props.values).map((name) => ({ name, secret: false }))
    ).filter((entry) => !entry.secret)
    const secrets = (props.declared ?? []).filter((entry) => entry.secret)
    const changed = Object.fromEntries(
        Object.entries(draft).filter(([name, value]) => value !== (props.values[name] ?? "")),
    )
    return (
        <form
            className="card"
            style={{ marginBottom: 18 }}
            onSubmit={(event) => {
                event.preventDefault()
                props.onSave?.(changed)
                setDraft({})
            }}
        >
            <h3>
                Made from <code>{props.template}</code>
            </h3>
            <p className="sub">
                Changing a value re-renders the files nobody has edited since they were made; an
                edited file and the agent's memory are kept as they are.
            </p>
            <div className="model-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}>
                {plain.map((entry) => (
                    <label key={entry.name}>
                        {entry.name}
                        {"description" in entry && entry.description !== undefined ? (
                            <span className="sub"> {entry.description}</span>
                        ) : null}
                        <input
                            value={draft[entry.name] ?? props.values[entry.name] ?? ""}
                            // A default was rendered without being recorded as a value; say what it is.
                            placeholder={
                                "default" in entry && entry.default !== undefined
                                    ? entry.default
                                    : ""
                            }
                            onChange={(e) => setDraft({ ...draft, [entry.name]: e.target.value })}
                        />
                    </label>
                ))}
            </div>
            {secrets.length === 0 ? null : (
                <p className="sub">
                    Secret, kept in <code>.env</code> and not shown:{" "}
                    {secrets.map((entry) => entry.name).join(", ")}.
                </p>
            )}
            <button
                type="submit"
                className="primary"
                style={{ marginTop: 12 }}
                disabled={
                    Object.keys(changed).length === 0 || props.onSave === undefined || props.busy
                }
            >
                {props.busy === true ? "saving…" : "save and re-render"}
            </button>
        </form>
    )
}

export function FilesPanel(props: {
    /** Shown under the page heading: the template vars, for an agent made from one. */
    readonly above?: React.ReactNode
    readonly files: readonly WorkspaceEntry[] | undefined
    readonly selected?: string
    readonly content?: string
    readonly busy?: string
    readonly note?: string
    readonly onSelect: (name: string | undefined) => void
    readonly onSave?: (name: string, content: string) => void
}): React.ReactElement {
    const [draft, setDraft] = useState<string>()
    const current = draft ?? props.content ?? ""
    const dirty = draft !== undefined && draft !== props.content
    return (
        <>
            <div className="page-head">
                <h1>Files</h1>
                <p>
                    The workspace files the prompt is built from. Static files are cached and
                    read-only for the agent; volatile ones are what <code>memory_write</code> fills.
                    A save replaces the file whole and reloads the agent; a text it would not load
                    with is refused.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}
            {props.above}
            {props.files === undefined ? (
                <p className="empty">reading…</p>
            ) : props.files.length === 0 ? (
                <div className="empty-state">
                    <h3>No workspace files declared</h3>
                    <p>
                        Add names under <code>context.static</code> or <code>context.volatile</code>{" "}
                        in Settings.
                    </p>
                </div>
            ) : (
                <div className="rooms-layout">
                    <div className="rooms-list">
                        {props.files.map((file) => (
                            <button
                                type="button"
                                key={file.name}
                                className="row-button"
                                aria-current={file.name === props.selected}
                                onClick={() => {
                                    setDraft(undefined)
                                    props.onSelect(file.name)
                                }}
                            >
                                <span className="pill">{file.tier}</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {file.name}
                                </span>
                                <span className="sub" style={{ margin: "0 0 0 auto" }}>
                                    {file.exists ? `${file.bytes} B` : "missing"}
                                </span>
                            </button>
                        ))}
                    </div>
                    <div className="rooms-main" style={{ minHeight: 480 }}>
                        {props.selected === undefined ? (
                            <div className="empty-state">
                                <h3>Pick a file</h3>
                                <p>
                                    Frontmatter and HTML comments are stripped before the model sees
                                    it.
                                </p>
                            </div>
                        ) : props.content === undefined ? (
                            <p className="empty" style={{ padding: 16 }}>
                                reading…
                            </p>
                        ) : (
                            <>
                                <div className="room-head">
                                    <strong>{props.selected}</strong>
                                </div>
                                <textarea
                                    className="editor"
                                    aria-label={`contents of ${props.selected}`}
                                    value={current}
                                    spellCheck={false}
                                    onChange={(e) => setDraft(e.target.value)}
                                />
                                <div className="room-post cta-row">
                                    <button
                                        type="button"
                                        className="primary"
                                        disabled={
                                            !dirty ||
                                            props.onSave === undefined ||
                                            props.busy === props.selected
                                        }
                                        onClick={() => {
                                            if (props.selected !== undefined)
                                                props.onSave?.(props.selected, current)
                                            setDraft(undefined)
                                        }}
                                    >
                                        {props.busy === props.selected
                                            ? "saving…"
                                            : "save and reload"}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!dirty}
                                        onClick={() => setDraft(undefined)}
                                    >
                                        discard
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </>
    )
}

/* ─── add a channel ────────────────────────────────────────────────────────── */

/**
 * The channel types the binary bundles, with the manifest fields each one takes. Kept here rather
 * than derived from the manifest schema because that schema is deliberately loose (`type: slug`,
 * the plugin validates the rest): the fields below are what each plugin reads.
 */
export const CHANNEL_TYPES: readonly {
    readonly type: string
    readonly label: string
    readonly fields: readonly {
        readonly key: string
        readonly label: string
        readonly hint: string
        readonly default?: string
    }[]
}[] = [
    {
        type: "telegram",
        label: "Telegram",
        fields: [
            {
                key: "tokenEnv",
                label: "Bot token variable",
                hint: "the .env variable holding the BotFather token",
                default: "TELEGRAM_BOT_TOKEN",
            },
        ],
    },
    {
        type: "whatsapp",
        label: "WhatsApp",
        fields: [
            { key: "pairWith", label: "Phone number", hint: "digits, no +; blank pairs by QR" },
        ],
    },
    {
        type: "slack",
        label: "Slack (Socket Mode)",
        fields: [
            {
                key: "appTokenEnv",
                label: "App token variable",
                hint: "xapp-… in .env",
                default: "SLACK_APP_TOKEN",
            },
            {
                key: "botTokenEnv",
                label: "Bot token variable",
                hint: "xoxb-… in .env",
                default: "SLACK_BOT_TOKEN",
            },
        ],
    },
    {
        type: "teams",
        label: "Microsoft Teams",
        fields: [
            { key: "appId", label: "App id", hint: "the Bot Framework app id" },
            { key: "tenantId", label: "Tenant id", hint: "optional: single-tenant bots" },
        ],
    },
    {
        type: "a2a",
        label: "A2A (agent-to-agent)",
        fields: [
            {
                key: "tokenEnv",
                label: "Token variable",
                hint: "optional: a key peers present",
                default: "A2A_TOKEN",
            },
        ],
    },
]

export function AddChannel(props: {
    readonly existing: readonly string[]
    readonly busy: boolean
    readonly onAdd: (entry: Readonly<Record<string, unknown>>) => void
}): React.ReactElement {
    const [open, setOpen] = useState(false)
    const [type, setType] = useState(CHANNEL_TYPES[0]?.type ?? "telegram")
    const [id, setId] = useState("")
    const [allow, setAllow] = useState("")
    const [values, setValues] = useState<Readonly<Record<string, string>>>({})
    const spec = CHANNEL_TYPES.find((entry) => entry.type === type)
    const cleanId = id.trim() || type
    const taken = props.existing.includes(cleanId)
    if (!open)
        return (
            <button type="button" style={{ marginTop: 14 }} onClick={() => setOpen(true)}>
                + add a channel
            </button>
        )
    return (
        <form
            className="card"
            style={{ marginTop: 14 }}
            onSubmit={(event) => {
                event.preventDefault()
                if (taken || spec === undefined) return
                const entry: Record<string, unknown> = { id: cleanId, type }
                for (const field of spec.fields) {
                    const value = (values[field.key] ?? field.default ?? "").trim()
                    if (value !== "") entry[field.key] = value
                }
                const handles = allow
                    .split(",")
                    .map((h) => h.trim())
                    .filter(Boolean)
                if (handles.length > 0) entry.allowFrom = handles
                props.onAdd(entry)
                setOpen(false)
                setId("")
                setAllow("")
                setValues({})
            }}
        >
            <h3>Add a channel</h3>
            <div className="model-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}>
                <label>
                    Type
                    <select value={type} onChange={(e) => setType(e.target.value)}>
                        {CHANNEL_TYPES.map((entry) => (
                            <option key={entry.type} value={entry.type}>
                                {entry.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Id{" "}
                    {taken ? (
                        <span className="error">already a channel</span>
                    ) : (
                        <span className="sub">how schedules and the API name it</span>
                    )}
                    <input value={id} placeholder={type} onChange={(e) => setId(e.target.value)} />
                </label>
                {(spec?.fields ?? []).map((field) => (
                    <label key={field.key}>
                        {field.label} <span className="sub">{field.hint}</span>
                        <input
                            value={values[field.key] ?? ""}
                            placeholder={field.default ?? ""}
                            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                        />
                    </label>
                ))}
                <label style={{ gridColumn: "1 / -1" }}>
                    Who may message it{" "}
                    <span className="sub">
                        comma-separated handles or ids; empty permits nobody, and the log names the
                        line to add
                    </span>
                    <input
                        value={allow}
                        placeholder="@you, 123456789"
                        onChange={(e) => setAllow(e.target.value)}
                    />
                </label>
            </div>
            <p className="sub" style={{ margin: "10px 0" }}>
                A token variable named here is read from the agent's <code>.env</code>; set its
                value on the channel card after adding.
            </p>
            <div className="cta-row">
                <button type="submit" className="primary" disabled={taken || props.busy}>
                    add
                </button>
                <button type="button" onClick={() => setOpen(false)}>
                    cancel
                </button>
            </div>
        </form>
    )
}
