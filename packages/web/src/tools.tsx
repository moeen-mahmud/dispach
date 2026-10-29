/**
 * Tools: the resolved catalogue grouped by provider, what it costs per turn, what is pinned, the
 * policy rules, and the providers' own state.
 *
 * Props only. Editing goes through the same two routes the Settings page uses — `tools.pinned` and
 * `tools.policy.allow/deny` are `PATCH /config` rows, so a pin written here is the same write as a
 * pin written in the terminal — and the refresh is `POST /tools/refresh`, which reloads only when the
 * catalogue actually moved.
 */

import type React from "react"
import { useMemo, useState } from "react"

export interface ToolRow {
    readonly slug: string
    readonly summary: string
    readonly mutating: boolean
    readonly trust: string
    readonly trustReason?: string
    readonly provider: string
    readonly tags?: readonly string[]
    /** Absent on an unphased agent. */
    readonly phases?: readonly string[]
}

/** One provider named under `tools.providers`, with whether its key variable is set. */
export interface ProviderRow {
    readonly id: string
    readonly keyEnv?: string
    readonly keySet?: boolean
}

export interface RefreshReport {
    readonly providers: readonly {
        readonly provider: string
        readonly ok: boolean
        readonly fetched: number
        readonly error?: string
    }[]
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
}

const RULE = /^[a-z][a-z0-9_]*(\([^)]*\))?$/i

export function ToolsPanel(props: {
    readonly tools: readonly ToolRow[]
    /** What the catalogue costs on every turn, from `GET /agents/:id`. */
    readonly catalogueTokens?: number
    readonly pinned?: readonly string[]
    readonly allow?: readonly string[]
    readonly deny?: readonly string[]
    readonly providers?: readonly ProviderRow[]
    readonly busy?: string
    readonly note?: string
    readonly onPin?: (pinned: readonly string[]) => void
    readonly onRules?: (kind: "allow" | "deny", rules: readonly string[]) => void
    readonly onRefresh?: () => void
    readonly lastRefresh?: RefreshReport
}): React.ReactElement {
    const [query, setQuery] = useState("")
    const [newRule, setNewRule] = useState<{ kind: "allow" | "deny"; text: string }>({
        kind: "allow",
        text: "",
    })
    const groups = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const shown = props.tools.filter(
            (tool) =>
                needle === "" ||
                tool.slug.toLowerCase().includes(needle) ||
                tool.summary.toLowerCase().includes(needle) ||
                (tool.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)),
        )
        const byProvider = new Map<string, ToolRow[]>()
        for (const tool of shown) {
            const list = byProvider.get(tool.provider) ?? []
            list.push(tool)
            byProvider.set(tool.provider, list)
        }
        return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
    }, [props.tools, query])

    const pinned = props.pinned ?? []
    const mutating = props.tools.filter((tool) => tool.mutating).length
    const untrusted = props.tools.filter((tool) => tool.trust !== "trusted").length

    return (
        <>
            <div className="page-head">
                <h1>Tools</h1>
                <p>
                    What this agent may call. Every tool here is in its prompt on every turn, so the
                    catalogue has a price; a tool that is not pinned is not offered.
                </p>
            </div>
            {props.note === undefined ? null : <p className="note">{props.note}</p>}

            <div className="stats" style={{ marginBottom: 18 }}>
                <span className="pill">
                    {props.tools.length} tool{props.tools.length === 1 ? "" : "s"}
                </span>
                {props.catalogueTokens === undefined ? null : (
                    <span className="pill accent">{props.catalogueTokens} tokens / turn</span>
                )}
                <span className="pill">{mutating} change things</span>
                <span className={`pill${untrusted > 0 ? " warn" : ""}`}>{untrusted} untrusted</span>
                {props.onRefresh === undefined ? null : (
                    <button
                        type="button"
                        style={{ marginLeft: "auto" }}
                        disabled={props.busy === "tools.refresh"}
                        onClick={props.onRefresh}
                    >
                        {props.busy === "tools.refresh" ? "refreshing…" : "refresh catalogue"}
                    </button>
                )}
            </div>

            {props.lastRefresh === undefined ? null : (
                <div className="card refresh-report">
                    <h3>Last refresh</h3>
                    <ul>
                        {props.lastRefresh.providers.map((entry) => (
                            <li key={entry.provider}>
                                <code>{entry.provider}</code>{" "}
                                {entry.ok
                                    ? `${entry.fetched} fetched`
                                    : `failed: ${entry.error ?? "unknown"}`}
                            </li>
                        ))}
                    </ul>
                    <p style={{ margin: 0 }}>
                        {props.lastRefresh.added.length +
                            props.lastRefresh.removed.length +
                            props.lastRefresh.changed.length ===
                        0
                            ? "Nothing moved, so nothing reloaded."
                            : [
                                  props.lastRefresh.added.length > 0
                                      ? `added ${props.lastRefresh.added.join(", ")}`
                                      : undefined,
                                  props.lastRefresh.removed.length > 0
                                      ? `removed ${props.lastRefresh.removed.join(", ")}`
                                      : undefined,
                                  props.lastRefresh.changed.length > 0
                                      ? `changed ${props.lastRefresh.changed.join(", ")}`
                                      : undefined,
                              ]
                                  .filter((part) => part !== undefined)
                                  .join(" · ")}
                    </p>
                </div>
            )}

            {(props.providers ?? []).length === 0 ? null : (
                <>
                    <div className="section-title">Providers</div>
                    <div className="stats" style={{ marginBottom: 18 }}>
                        {(props.providers ?? []).map((provider) => (
                            <span key={provider.id} className="pill">
                                {provider.id}
                                {provider.keyEnv === undefined ? null : (
                                    <>
                                        {" · "}
                                        <span
                                            className={`dot ${provider.keySet === true ? "live" : "warn"}`}
                                        />
                                        {provider.keyEnv}{" "}
                                        {provider.keySet === true ? "set" : "missing"}
                                    </>
                                )}
                            </span>
                        ))}
                    </div>
                </>
            )}

            <div className="section-title">Catalogue</div>
            <input
                className="search"
                value={query}
                placeholder="search slug, summary or tag"
                onChange={(event) => setQuery(event.target.value)}
            />
            {props.tools.length === 0 ? (
                <div className="empty-state">
                    <h3>No tools pinned</h3>
                    <p>
                        An agent with none can still hold a conversation; a manifest's{" "}
                        <code>tools.pinned</code> is what grants the rest.
                    </p>
                </div>
            ) : groups.length === 0 ? (
                <p className="empty">Nothing matches "{query}".</p>
            ) : (
                groups.map(([provider, tools]) => (
                    <section key={provider} className="tool-group">
                        <h3>
                            {provider} <span className="sub">{tools.length}</span>
                        </h3>
                        <table className="panel-table">
                            <thead>
                                <tr>
                                    <th>tool</th>
                                    <th>writes</th>
                                    <th>trust</th>
                                    {props.tools.some((tool) => tool.phases !== undefined) ? (
                                        <th>phases</th>
                                    ) : null}
                                    {props.onPin === undefined ? null : <th />}
                                </tr>
                            </thead>
                            <tbody>
                                {tools.map((tool) => (
                                    <tr key={tool.slug}>
                                        <td>
                                            <code>{tool.slug}</code>
                                            <div className="sub">{tool.summary}</div>
                                            {(tool.tags ?? []).length === 0 ? null : (
                                                <div className="stats" style={{ marginTop: 4 }}>
                                                    {(tool.tags ?? []).map((tag) => (
                                                        <span key={tag} className="pill">
                                                            {tag}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </td>
                                        <td>{tool.mutating ? "yes" : "no"}</td>
                                        <td>
                                            <span
                                                className={tool.trust === "trusted" ? "" : "warn"}
                                            >
                                                {tool.trust}
                                            </span>
                                            {tool.trustReason === undefined ? null : (
                                                <div className="sub">{tool.trustReason}</div>
                                            )}
                                        </td>
                                        {props.tools.some((entry) => entry.phases !== undefined) ? (
                                            <td>
                                                {tool.phases === undefined
                                                    ? "all"
                                                    : tool.phases.join(", ")}
                                            </td>
                                        ) : null}
                                        {props.onPin === undefined ? null : (
                                            <td style={{ whiteSpace: "nowrap" }}>
                                                {/*
                                                 * Built-ins (`tools.local`) are not in `pinned`, so
                                                 * only a tool that is can be unpinned here.
                                                 */}
                                                {pinned.includes(tool.slug) ? (
                                                    <button
                                                        type="button"
                                                        disabled={props.busy === "tools.pinned"}
                                                        onClick={() =>
                                                            props.onPin?.(
                                                                pinned.filter(
                                                                    (slug) => slug !== tool.slug,
                                                                ),
                                                            )
                                                        }
                                                    >
                                                        unpin
                                                    </button>
                                                ) : null}
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                ))
            )}

            {props.onPin === undefined ? null : (
                <PinForm
                    pinned={pinned}
                    served={props.tools.map((tool) => tool.slug)}
                    busy={props.busy === "tools.pinned"}
                    onPin={props.onPin}
                />
            )}

            {props.onRules === undefined ? null : (
                <>
                    <div className="section-title">Policy</div>
                    <p className="sub" style={{ marginBottom: 10 }}>
                        A rule names a tool and optionally an argument pattern:{" "}
                        <code>exec(git status:*)</code>. An <strong>allow</strong> rule lets a call
                        run without asking; a <strong>deny</strong> rule refuses it. Protected paths
                        and the floor hold whatever is written here.
                    </p>
                    <div className="control-row">
                        {(["allow", "deny"] as const).map((kind) => {
                            const rules = (kind === "allow" ? props.allow : props.deny) ?? []
                            return (
                                <div key={kind} className="card">
                                    <h3>{kind}</h3>
                                    {rules.length === 0 ? (
                                        <p className="empty">no {kind} rules</p>
                                    ) : (
                                        <ul className="rules">
                                            {rules.map((rule) => (
                                                <li key={rule}>
                                                    <code>{rule}</code>
                                                    <button
                                                        type="button"
                                                        className="link"
                                                        disabled={
                                                            props.busy === `tools.policy.${kind}`
                                                        }
                                                        onClick={() =>
                                                            props.onRules?.(
                                                                kind,
                                                                rules.filter(
                                                                    (entry) => entry !== rule,
                                                                ),
                                                            )
                                                        }
                                                    >
                                                        remove
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    <form
                                        className="inline"
                                        onSubmit={(event) => {
                                            event.preventDefault()
                                            if (newRule.kind !== kind) return
                                            const text = newRule.text.trim()
                                            if (!RULE.test(text) || rules.includes(text)) return
                                            props.onRules?.(kind, [...rules, text])
                                            setNewRule({ kind, text: "" })
                                        }}
                                    >
                                        <input
                                            aria-label={`new ${kind} rule`}
                                            value={newRule.kind === kind ? newRule.text : ""}
                                            placeholder={
                                                kind === "allow" ? "memory_write" : "exec(rm:*)"
                                            }
                                            onFocus={() =>
                                                setNewRule({
                                                    kind,
                                                    text: newRule.kind === kind ? newRule.text : "",
                                                })
                                            }
                                            onChange={(event) =>
                                                setNewRule({ kind, text: event.target.value })
                                            }
                                        />
                                        <button
                                            type="submit"
                                            disabled={
                                                props.busy === `tools.policy.${kind}` ||
                                                newRule.kind !== kind ||
                                                !RULE.test(newRule.text.trim())
                                            }
                                        >
                                            add
                                        </button>
                                    </form>
                                </div>
                            )
                        })}
                    </div>
                </>
            )}
        </>
    )
}

/** Pin a slug by name. The server's `resolve()` refuses one no provider has, by name. */
function PinForm(props: {
    readonly pinned: readonly string[]
    readonly served: readonly string[]
    readonly busy: boolean
    readonly onPin: (pinned: readonly string[]) => void
}): React.ReactElement {
    const [slug, setSlug] = useState("")
    const clean = slug.trim()
    const taken = props.pinned.includes(clean) || props.served.includes(clean)
    return (
        <form
            className="inline"
            style={{ marginTop: 12 }}
            onSubmit={(event) => {
                event.preventDefault()
                if (clean === "" || taken) return
                props.onPin([...props.pinned, clean])
                setSlug("")
            }}
        >
            <input
                aria-label="pin a tool by slug"
                value={slug}
                placeholder="pin a slug — exec, web_search, GMAIL_FETCH_EMAILS…"
                onChange={(event) => setSlug(event.target.value)}
            />
            <button type="submit" disabled={props.busy || clean === "" || taken}>
                pin
            </button>
        </form>
    )
}
