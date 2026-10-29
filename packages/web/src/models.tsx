/**
 * Models: which one the agent runs on, how hard it thinks, and the named roles beside it.
 *
 * Props only, like every panel here. Every write goes through `PATCH /config` (`onChange`, one
 * request and one reload however many fields) and a key through `PUT /secrets` — the same two
 * routes `config` and `init` use, so there is no second definition of a valid model here. Values are
 * sent as JSON text, which is YAML flow syntax and therefore what `parseSettingValue` reads.
 */

import type React from "react"
import { useState } from "react"
import { PRESETS, type Preset } from "../../cli/src/lib/presets.ts"

export interface SettingRow {
    readonly path: string
    readonly means: string
    readonly value?: unknown
}

export interface SecretRow {
    readonly name: string
    readonly set: boolean
}

export type ModelChange =
    | { readonly path: string; readonly value: string }
    | { readonly path: string; readonly remove: true }

/** `reasoningEffort`'s values, in order. Mirrors the manifest schema's enum. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

type Role = Readonly<Record<string, unknown>>

function asRole(value: unknown): Role {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Role)
        : {}
}

const text = (value: unknown): string => (typeof value === "string" ? value : "")

/** The preset whose endpoint this is, for a label a person recognises. */
function providerOf(baseUrl: string): Preset | undefined {
    const clean = baseUrl.replace(/\/+$/, "")
    return PRESETS.find((preset) => preset.baseUrl !== "" && preset.baseUrl === clean)
}

/** A role's whole value, with `fields` laid over what was there — so a switch keeps its tuning. */
function merged(previous: Role, fields: Readonly<Record<string, unknown>>): string {
    const next: Record<string, unknown> = { ...previous }
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === "") delete next[key]
        else next[key] = value
    }
    return JSON.stringify(next)
}

/** What a transport is called on a pill: the preset's short label, or the endpoint, or Bedrock + region. */
function transportLabel(role: Role): string {
    if (text(role.api) === "bedrock-converse") {
        const options = asRole(role.options)
        return `Bedrock · ${text(options.region) || "no region"}`
    }
    const baseUrl = text(role.baseUrl)
    return providerOf(baseUrl)?.label.split(" (")[0] ?? (baseUrl || "default endpoint")
}

/** The role's connection fields as the form holds them. */
function fieldsOf(role: Role): ModelFields {
    const options = asRole(role.options)
    return {
        id: text(role.id),
        api: text(role.api) === "bedrock-converse" ? "bedrock-converse" : "chat-completions",
        baseUrl: text(role.baseUrl),
        apiKeyEnv: text(role.apiKeyEnv),
        region: text(options.region),
        profile: text(options.profile),
    }
}

/** The manifest fields a `ModelFields` writes: one transport's fields set, the other's cleared. */
function connection(fields: ModelFields): Record<string, unknown> {
    if (fields.api === "bedrock-converse") {
        return {
            id: fields.id,
            api: "bedrock-converse",
            options: {
                region: fields.region,
                ...(fields.profile === "" ? {} : { profile: fields.profile }),
            },
            baseUrl: undefined,
            apiKeyEnv: undefined,
        }
    }
    return {
        id: fields.id,
        api: undefined,
        options: undefined,
        baseUrl: fields.baseUrl,
        apiKeyEnv: fields.apiKeyEnv,
    }
}

export function ModelsPanel(props: {
    readonly settings: readonly SettingRow[]
    readonly secrets: readonly SecretRow[]
    readonly busy?: string
    readonly note?: string
    readonly onChange: (key: string, changes: readonly ModelChange[]) => void
    readonly onSecret: (name: string, value: string) => void
}): React.ReactElement {
    const main = asRole(props.settings.find((row) => row.path === "model.main")?.value)
    const roles = props.settings
        .filter((row) => /^model\.[^.<]+$/.test(row.path) && row.path !== "model.main")
        .map((row) => ({ name: row.path.slice("model.".length), role: asRole(row.value) }))
    const keySet = (name: string) => props.secrets.find((secret) => secret.name === name)?.set

    return (
        <>
            <div className="page-head">
                <h1>Models</h1>
                <p>
                    The model this agent runs on, how hard it reasons, and named roles a schedule or
                    a message can run on instead. Saving replaces the agent; history survives.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}

            <RoleCard
                name="main"
                role={main}
                keySet={keySet(text(main.apiKeyEnv))}
                busy={props.busy === "model.main"}
                onChange={(changes) => props.onChange("model.main", changes)}
                onSecret={props.onSecret}
                primary
            />

            <div className="section-title">Roles</div>
            {roles.length === 0 ? (
                <p className="empty" style={{ marginBottom: 14 }}>
                    No roles yet. A role is a second model — a cheap one for a nightly digest, a
                    stronger one for a hard question — that a schedule names with <code>role:</code>{" "}
                    or a message with <code>{'"role"'}</code>.
                </p>
            ) : (
                roles.map(({ name, role }) => (
                    <RoleCard
                        key={name}
                        name={name}
                        role={role}
                        keySet={keySet(text(role.apiKeyEnv))}
                        busy={props.busy === `model.${name}`}
                        onChange={(changes) => props.onChange(`model.${name}`, changes)}
                        onSecret={props.onSecret}
                    />
                ))
            )}
            <AddRole
                taken={["main", ...roles.map((entry) => entry.name)]}
                busy={props.busy === "model.new"}
                onAdd={(name, value) =>
                    props.onChange("model.new", [{ path: `model.${name}`, value }])
                }
            />
        </>
    )
}

function RoleCard(props: {
    readonly name: string
    readonly role: Role
    readonly keySet: boolean | undefined
    readonly busy: boolean
    readonly primary?: boolean
    readonly onChange: (changes: readonly ModelChange[]) => void
    readonly onSecret: (name: string, value: string) => void
}): React.ReactElement {
    const { role } = props
    const path = `model.${props.name}`
    const effort = text(role.reasoningEffort)
    const temperature = typeof role.temperature === "number" ? role.temperature : undefined
    const maxTokens = typeof role.maxTokens === "number" ? String(role.maxTokens) : ""
    const baseUrl = text(role.baseUrl)
    const keyEnv = text(role.apiKeyEnv)
    const fallbacks = Array.isArray(role.fallbacks) ? role.fallbacks.map(asRole) : []
    const [editing, setEditing] = useState(false)
    const [addingFallback, setAddingFallback] = useState(false)
    const [temp, setTemp] = useState<number | undefined>(temperature)
    const [tokens, setTokens] = useState(maxTokens)

    /** One field of this role, written whole so the main role and a named role take one path. */
    const set = (field: string, value: string | undefined) =>
        props.onChange([{ path, value: merged(role, { [field]: value }) }])

    return (
        <div className={`card model-card${props.primary === true ? " primary" : ""}`}>
            <div className="model-head">
                <span className="avatar">{props.name.charAt(0)}</span>
                <div style={{ minWidth: 0 }}>
                    <div className="model-role">
                        {props.primary === true ? "main model" : props.name}
                    </div>
                    <div className="model-id">{text(role.id) || "no model set"}</div>
                </div>
                <div className="stats" style={{ marginLeft: "auto" }}>
                    <span className="pill">{transportLabel(role)}</span>
                    {keyEnv === "" ? (
                        <span className="pill">no key</span>
                    ) : (
                        <span className={`pill ${props.keySet === true ? "ok" : "warn"}`}>
                            <span className={`dot ${props.keySet === true ? "live" : "warn"}`} />
                            {keyEnv} {props.keySet === true ? "set" : "missing"}
                        </span>
                    )}
                    {props.busy ? <span className="pill accent">saving…</span> : null}
                </div>
            </div>

            <div className="control">
                <div className="control-label">
                    Reasoning effort
                    <span className="sub">
                        How long a reasoning model thinks before answering. Lower is faster and
                        cheaper; not every endpoint honours it.
                    </span>
                </div>
                <fieldset className="segmented">
                    <button
                        type="button"
                        aria-pressed={effort === ""}
                        disabled={props.busy}
                        onClick={() => set("reasoningEffort", undefined)}
                    >
                        default
                    </button>
                    {EFFORTS.map((level) => (
                        <button
                            type="button"
                            key={level}
                            aria-pressed={effort === level}
                            disabled={props.busy}
                            onClick={() => set("reasoningEffort", level)}
                        >
                            {level}
                        </button>
                    ))}
                </fieldset>
            </div>

            <div className="control-row">
                <div className="control">
                    <div className="control-label">
                        Temperature
                        <span className="mono-value">
                            {temp === undefined ? "default" : temp.toFixed(1)}
                        </span>
                    </div>
                    <div className="inline">
                        <input
                            type="range"
                            min={0}
                            max={2}
                            step={0.1}
                            value={temp ?? 1}
                            disabled={props.busy}
                            onChange={(event) => setTemp(Number(event.target.value))}
                            onMouseUp={() =>
                                temp === undefined
                                    ? undefined
                                    : props.onChange([
                                          {
                                              path,
                                              value: JSON.stringify({ ...role, temperature: temp }),
                                          },
                                      ])
                            }
                            onKeyUp={() =>
                                temp === undefined
                                    ? undefined
                                    : props.onChange([
                                          {
                                              path,
                                              value: JSON.stringify({ ...role, temperature: temp }),
                                          },
                                      ])
                            }
                        />
                        <button
                            type="button"
                            disabled={props.busy || temperature === undefined}
                            onClick={() => {
                                setTemp(undefined)
                                const { temperature: _, ...rest } = role
                                props.onChange([{ path, value: JSON.stringify(rest) }])
                            }}
                        >
                            reset
                        </button>
                    </div>
                </div>
                <div className="control">
                    <div className="control-label">
                        Max output tokens
                        <span className="sub">Blank lets the endpoint decide.</span>
                    </div>
                    <form
                        className="inline"
                        onSubmit={(event) => {
                            event.preventDefault()
                            const { maxTokens: _, ...rest } = role
                            const n = Number(tokens)
                            props.onChange([
                                {
                                    path,
                                    value: JSON.stringify(
                                        tokens.trim() === "" || !Number.isInteger(n) || n <= 0
                                            ? rest
                                            : { ...rest, maxTokens: n },
                                    ),
                                },
                            ])
                        }}
                    >
                        <input
                            inputMode="numeric"
                            placeholder="default"
                            value={tokens}
                            onChange={(event) =>
                                setTokens(event.target.value.replace(/[^0-9]/g, ""))
                            }
                        />
                        <button type="submit" disabled={props.busy || tokens === maxTokens}>
                            save
                        </button>
                    </form>
                </div>
            </div>

            <div className="control">
                <div className="control-label">
                    Fallbacks
                    <span className="sub">
                        Tried in order when this model is unreachable or answers 5xx/429 before the
                        first token. Each is a whole role, so a fallback can be another provider.
                    </span>
                </div>
                {fallbacks.length === 0 ? null : (
                    <ol className="fallbacks">
                        {fallbacks.map((fallback, index) => (
                            <li key={JSON.stringify(fallback)}>
                                <code>{text(fallback.id) || "?"}</code>
                                <span className="sub" style={{ margin: 0 }}>
                                    {transportLabel(fallback)}
                                </span>
                                <button
                                    type="button"
                                    className="link"
                                    disabled={props.busy}
                                    onClick={() =>
                                        props.onChange([
                                            {
                                                path,
                                                value: merged(role, {
                                                    fallbacks: fallbacks.filter(
                                                        (_, at) => at !== index,
                                                    ),
                                                }),
                                            },
                                        ])
                                    }
                                >
                                    remove
                                </button>
                            </li>
                        ))}
                    </ol>
                )}
                {addingFallback ? (
                    <ModelForm
                        initial={{ ...fieldsOf({}), apiKeyEnv: "MODEL_API_KEY" }}
                        busy={props.busy}
                        submitLabel="add fallback"
                        onSubmit={(fields, key) => {
                            const entry = Object.fromEntries(
                                Object.entries(connection(fields)).filter(
                                    ([, v]) => v !== undefined,
                                ),
                            )
                            props.onChange([
                                { path, value: merged(role, { fallbacks: [...fallbacks, entry] }) },
                            ])
                            if (key !== "" && fields.apiKeyEnv !== "")
                                props.onSecret(fields.apiKeyEnv, key)
                            setAddingFallback(false)
                        }}
                    />
                ) : (
                    <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => setAddingFallback(true)}
                    >
                        + add a fallback
                    </button>
                )}
            </div>

            <div className="model-foot">
                <span className="sub" style={{ margin: 0 }}>
                    {text(role.api) === "bedrock-converse"
                        ? `AWS Bedrock Converse${text(asRole(role.options).profile) === "" ? "" : ` · profile ${text(asRole(role.options).profile)}`} · credentials from the AWS chain`
                        : baseUrl === ""
                          ? "transport default"
                          : baseUrl}
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    {props.primary === true ? null : (
                        <button
                            type="button"
                            className="bad"
                            disabled={props.busy}
                            onClick={() => props.onChange([{ path, remove: true }])}
                        >
                            remove
                        </button>
                    )}
                    <button type="button" onClick={() => setEditing(!editing)}>
                        {editing ? "close" : "change model"}
                    </button>
                </span>
            </div>
            {editing ? (
                <ModelForm
                    initial={fieldsOf(role)}
                    busy={props.busy}
                    submitLabel="save model"
                    onSubmit={(fields, key) => {
                        props.onChange([{ path, value: merged(role, connection(fields)) }])
                        if (key !== "" && fields.apiKeyEnv !== "")
                            props.onSecret(fields.apiKeyEnv, key)
                        setEditing(false)
                    }}
                />
            ) : null}
        </div>
    )
}

type ModelFields = {
    readonly id: string
    readonly api: "chat-completions" | "bedrock-converse"
    readonly baseUrl: string
    readonly apiKeyEnv: string
    /** Bedrock only. */
    readonly region: string
    readonly profile: string
}

/** Provider, model, endpoint and key. A preset fills the three strings; every one stays editable. */
function ModelForm(props: {
    readonly initial: ModelFields
    readonly busy: boolean
    readonly submitLabel: string
    readonly extra?: React.ReactNode
    readonly onSubmit: (fields: ModelFields, key: string) => void
}): React.ReactElement {
    const [fields, setFields] = useState<ModelFields>(props.initial)
    const [key, setKey] = useState("")
    const bedrock = fields.api === "bedrock-converse"
    const preset = bedrock ? "bedrock" : (providerOf(fields.baseUrl)?.id ?? "custom")
    const field = (name: keyof ModelFields) => (event: React.ChangeEvent<HTMLInputElement>) =>
        setFields({ ...fields, [name]: event.target.value })
    const ready =
        fields.id.trim() !== "" &&
        (!bedrock || /^[a-z]{2}(-[a-z]+)+-\d$/.test(fields.region.trim()))
    return (
        <form
            className="model-form"
            onSubmit={(event) => {
                event.preventDefault()
                if (!ready) return
                props.onSubmit(
                    {
                        id: fields.id.trim(),
                        api: fields.api,
                        baseUrl: bedrock ? "" : fields.baseUrl.trim(),
                        apiKeyEnv: bedrock ? "" : fields.apiKeyEnv.trim(),
                        region: bedrock ? fields.region.trim() : "",
                        profile: bedrock ? fields.profile.trim() : "",
                    },
                    key,
                )
                setKey("")
            }}
        >
            {props.extra}
            <label>
                Provider
                <select
                    value={preset}
                    onChange={(event) => {
                        const chosen = PRESETS.find((entry) => entry.id === event.target.value)
                        if (chosen === undefined || chosen.id === "custom") return
                        setFields({
                            id: chosen.modelId,
                            api: chosen.api ?? "chat-completions",
                            baseUrl: chosen.baseUrl,
                            apiKeyEnv: chosen.apiKeyEnv ?? "",
                            region: chosen.region ?? "",
                            profile: "",
                        })
                    }}
                >
                    {PRESETS.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.label}
                        </option>
                    ))}
                </select>
            </label>
            <label>
                Model id
                <input value={fields.id} placeholder="deepseek-v4-pro" onChange={field("id")} />
            </label>
            {bedrock ? (
                <>
                    <label>
                        AWS region
                        <input
                            value={fields.region}
                            placeholder="eu-west-1"
                            onChange={field("region")}
                        />
                    </label>
                    <label>
                        AWS profile{" "}
                        <span className="sub">
                            optional — otherwise the environment, container or instance role
                        </span>
                        <input
                            value={fields.profile}
                            placeholder="default chain"
                            onChange={field("profile")}
                        />
                    </label>
                </>
            ) : (
                <>
                    <label>
                        Endpoint
                        <input
                            value={fields.baseUrl}
                            placeholder="https://api.example.com/v1"
                            onChange={field("baseUrl")}
                        />
                    </label>
                    <label>
                        Key variable
                        <input
                            value={fields.apiKeyEnv}
                            placeholder="MODEL_API_KEY (blank for a keyless local model)"
                            onChange={field("apiKeyEnv")}
                        />
                    </label>
                </>
            )}
            {bedrock ? null : (
                <label>
                    API key{" "}
                    <span className="sub">
                        optional — written to the agent's .env, never shown again
                    </span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        value={key}
                        placeholder={
                            fields.apiKeyEnv === ""
                                ? "no key variable"
                                : "leave blank to keep the current key"
                        }
                        disabled={fields.apiKeyEnv === ""}
                        onChange={(event) => setKey(event.target.value)}
                    />
                </label>
            )}
            <div>
                <button type="submit" className="primary" disabled={props.busy || !ready}>
                    {props.submitLabel}
                </button>
            </div>
        </form>
    )
}

/** A role name the manifest can hold as a key, and that `model.<name>` addresses. */
const ROLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/

function AddRole(props: {
    readonly taken: readonly string[]
    readonly busy: boolean
    readonly onAdd: (name: string, value: string) => void
}): React.ReactElement {
    const [open, setOpen] = useState(false)
    const [name, setName] = useState("")
    const [effort, setEffort] = useState("")
    const problem =
        name === ""
            ? undefined
            : !ROLE_NAME.test(name)
              ? "lowercase letters, digits, - and _"
              : props.taken.includes(name)
                ? "already a role"
                : undefined
    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)}>
                + add a role
            </button>
        )
    }
    const first = PRESETS[0]
    return (
        <div className="card">
            <h3>New role</h3>
            <ModelForm
                initial={{
                    id: first?.modelId ?? "",
                    api: first?.api ?? "chat-completions",
                    baseUrl: first?.baseUrl ?? "",
                    apiKeyEnv: first?.apiKeyEnv ?? "",
                    region: first?.region ?? "",
                    profile: "",
                }}
                busy={props.busy || name === "" || problem !== undefined}
                submitLabel="add role"
                extra={
                    <>
                        <label>
                            Role name{" "}
                            {problem === undefined ? null : (
                                <span className="error">{problem}</span>
                            )}
                            <input
                                value={name}
                                placeholder="fast"
                                onChange={(event) => setName(event.target.value.trim())}
                            />
                        </label>
                        <label>
                            Reasoning effort
                            <select
                                value={effort}
                                onChange={(event) => setEffort(event.target.value)}
                            >
                                <option value="">default</option>
                                {EFFORTS.map((level) => (
                                    <option key={level} value={level}>
                                        {level}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
                }
                onSubmit={(fields) => {
                    props.onAdd(
                        name,
                        merged({}, { ...connection(fields), reasoningEffort: effort }),
                    )
                    setOpen(false)
                    setName("")
                }}
            />
        </div>
    )
}
