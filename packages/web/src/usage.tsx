/**
 * Usage: what the agent (or the server) cost, from the meter.
 *
 * Props only. One form per question: tokens by day is magnitude over time, so a single-hue bar
 * chart in inline SVG (no library — the page ships no binary assets and no charting dependency);
 * by model and by sender are identity with a magnitude, so tables. One hue, no legend (one
 * series), direct labels on the largest bars only, a hover tooltip per bar, and the same numbers
 * in a table under the chart so nothing is colour-alone.
 */

import type React from "react"
import { useState } from "react"

export interface UsageBucket {
    readonly agentId?: string
    readonly model?: string
    readonly day?: string
    readonly sender?: string
    readonly calls: number
    readonly promptTokens: number
    readonly cachedPromptTokens: number
    readonly cacheWriteTokens: number
    readonly outputTokens: number
    readonly estimatedCalls: number
}

export interface UsageReport {
    readonly byDay: readonly UsageBucket[]
    readonly byModel: readonly UsageBucket[]
    readonly bySender: readonly UsageBucket[]
    readonly byAgent?: readonly UsageBucket[]
    readonly meteredSince?: string
}

export const RANGES = [
    { key: "7d", label: "7 days", days: 7 },
    { key: "30d", label: "30 days", days: 30 },
    { key: "90d", label: "90 days", days: 90 },
] as const
export type RangeKey = (typeof RANGES)[number]["key"]

export function compact(n: number): string {
    const trim = (text: string) => text.replace(/\.0$/, "")
    if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1))}M`
    if (n >= 1_000) return `${trim((n / 1_000).toFixed(n >= 10_000 ? 0 : 1))}k`
    return String(n)
}

function total(
    buckets: readonly UsageBucket[],
    key: "calls" | "promptTokens" | "outputTokens" | "cachedPromptTokens",
): number {
    return buckets.reduce((sum, bucket) => sum + bucket[key], 0)
}

export function UsagePanel(props: {
    readonly report: UsageReport | undefined
    readonly range: RangeKey
    readonly onRange: (range: RangeKey) => void
    /** The agent the figures are for; absent is the whole server. */
    readonly agentName?: string
    readonly loading?: boolean
}): React.ReactElement {
    const report = props.report
    const all = report?.byModel ?? []
    const prompt = total(all, "promptTokens")
    const cached = total(all, "cachedPromptTokens")
    const output = total(all, "outputTokens")
    const calls = total(all, "calls")
    const estimated = all.reduce((sum, bucket) => sum + bucket.estimatedCalls, 0)
    return (
        <>
            <div className="page-head">
                <h1>Usage</h1>
                <p>
                    What {props.agentName === undefined ? "this server" : props.agentName} spent,
                    per model call, as the endpoint reported it.
                    {report?.meteredSince === undefined
                        ? ""
                        : ` Metered since ${report.meteredSince.slice(0, 10)}.`}
                </p>
            </div>
            <fieldset className="segmented" style={{ marginBottom: 18 }}>
                {RANGES.map((range) => (
                    <button
                        type="button"
                        key={range.key}
                        aria-pressed={props.range === range.key}
                        onClick={() => props.onRange(range.key)}
                    >
                        {range.label}
                    </button>
                ))}
            </fieldset>

            {props.loading && report === undefined ? (
                <p className="empty">reading the meter…</p>
            ) : null}
            {report === undefined && !props.loading ? (
                <p className="empty">nothing metered yet</p>
            ) : null}

            {report === undefined ? null : (
                <>
                    <div className="tiles">
                        <Tile label="model calls" value={compact(calls)} />
                        <Tile
                            label="prompt tokens"
                            value={compact(prompt)}
                            sub={
                                prompt === 0
                                    ? undefined
                                    : `${Math.round((cached / prompt) * 100)}% from cache`
                            }
                        />
                        <Tile label="output tokens" value={compact(output)} />
                        <Tile
                            label="estimated"
                            value={
                                estimated === 0
                                    ? "none"
                                    : `${estimated} call${estimated === 1 ? "" : "s"}`
                            }
                            sub={
                                estimated === 0
                                    ? "every figure reported by the endpoint"
                                    : "the endpoint reported no usage; counted by the estimator"
                            }
                        />
                    </div>

                    <div className="section-title">Tokens by day</div>
                    <DayChart buckets={report.byDay} />

                    <div className="control-row" style={{ gap: 24 }}>
                        <div>
                            <div className="section-title">By model</div>
                            <BucketTable
                                buckets={report.byModel}
                                keyOf={(b) => b.model ?? "?"}
                                head="model"
                            />
                        </div>
                        <div>
                            <div className="section-title">By sender</div>
                            <BucketTable
                                buckets={report.bySender}
                                keyOf={(b) => b.sender ?? "operator (API)"}
                                head="sender"
                            />
                        </div>
                    </div>
                    {report.byAgent === undefined ? null : (
                        <>
                            <div className="section-title">By agent</div>
                            <BucketTable
                                buckets={report.byAgent}
                                keyOf={(b) => b.agentId ?? "?"}
                                head="agent"
                            />
                        </>
                    )}
                </>
            )}
        </>
    )
}

function Tile(props: {
    readonly label: string
    readonly value: string
    readonly sub?: string | undefined
}): React.ReactElement {
    return (
        <div className="tile">
            <div className="tile-label">{props.label}</div>
            <div className="tile-value">{props.value}</div>
            {props.sub === undefined ? null : <div className="sub">{props.sub}</div>}
        </div>
    )
}

/** Thin bars, one hue, 2px gaps, direct labels on the top three, a tooltip per bar. */
export function DayChart(props: { readonly buckets: readonly UsageBucket[] }): React.ReactElement {
    const [hover, setHover] = useState<number>()
    const days = [...props.buckets]
        .filter((bucket) => bucket.day !== undefined)
        .sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""))
    if (days.length === 0) return <p className="empty">no calls in this range</p>
    const values = days.map((bucket) => bucket.promptTokens + bucket.outputTokens)
    const max = Math.max(...values, 1)
    const width = 640
    const height = 160
    const pad = { top: 18, bottom: 22, left: 4, right: 4 }
    const slot = (width - pad.left - pad.right) / days.length
    const bar = Math.max(2, slot - 2)
    const plotH = height - pad.top - pad.bottom
    const top3 = [...values].sort((a, b) => b - a).slice(0, 3)
    const hovered = hover === undefined ? undefined : days[hover]
    return (
        <div className="chart">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                role="img"
                aria-label={`tokens per day over ${days.length} days`}
                onMouseLeave={() => setHover(undefined)}
                onMouseMove={(event) => {
                    // One listener on the svg, which already has a role: the hit target is the
                    // whole column, bigger than the mark, derived from the pointer's x.
                    const box = event.currentTarget.getBoundingClientRect()
                    const x = ((event.clientX - box.left) / box.width) * width - pad.left
                    const index = Math.floor(x / slot)
                    setHover(index >= 0 && index < days.length ? index : undefined)
                }}
            >
                <title>tokens per day</title>
                <line
                    x1={pad.left}
                    x2={width - pad.right}
                    y1={height - pad.bottom}
                    y2={height - pad.bottom}
                    className="axis"
                />
                {days.map((bucket, index) => {
                    const value = values[index] ?? 0
                    const h = Math.max(value === 0 ? 0 : 2, (value / max) * plotH)
                    const x = pad.left + index * slot + 1
                    const y = height - pad.bottom - h
                    const labelled = value > 0 && top3.includes(value) && days.length <= 90
                    return (
                        <g key={bucket.day}>
                            <rect
                                className={`bar${hover === index ? " hot" : ""}`}
                                x={x}
                                y={y}
                                width={bar}
                                height={h}
                                rx={bar >= 6 ? 2 : 0}
                            />
                            {labelled ? (
                                <text
                                    x={x + bar / 2}
                                    y={y - 4}
                                    textAnchor="middle"
                                    className="value"
                                >
                                    {compact(value)}
                                </text>
                            ) : null}
                        </g>
                    )
                })}
                {days.length <= 14
                    ? days.map((bucket, index) => (
                          <text
                              key={`l${bucket.day}`}
                              x={pad.left + index * slot + slot / 2}
                              y={height - 6}
                              textAnchor="middle"
                              className="tick"
                          >
                              {(bucket.day ?? "").slice(5)}
                          </text>
                      ))
                    : [0, Math.floor(days.length / 2), days.length - 1].map((index) => (
                          <text
                              key={`l${days[index]?.day}`}
                              x={pad.left + index * slot + slot / 2}
                              y={height - 6}
                              textAnchor={
                                  index === 0
                                      ? "start"
                                      : index === days.length - 1
                                        ? "end"
                                        : "middle"
                              }
                              className="tick"
                          >
                              {(days[index]?.day ?? "").slice(5)}
                          </text>
                      ))}
            </svg>
            <div className="tooltip" aria-live="polite">
                {hovered === undefined
                    ? " "
                    : `${hovered.day}: ${compact(hovered.promptTokens)} prompt (${compact(hovered.cachedPromptTokens)} cached) · ${compact(hovered.outputTokens)} output · ${hovered.calls} call${hovered.calls === 1 ? "" : "s"}`}
            </div>
        </div>
    )
}

function BucketTable(props: {
    readonly buckets: readonly UsageBucket[]
    readonly keyOf: (bucket: UsageBucket) => string
    readonly head: string
}): React.ReactElement {
    const rows = [...props.buckets].sort(
        (a, b) => b.promptTokens + b.outputTokens - (a.promptTokens + a.outputTokens),
    )
    if (rows.length === 0) return <p className="empty">nothing in this range</p>
    return (
        <table className="panel-table">
            <thead>
                <tr>
                    <th>{props.head}</th>
                    <th>calls</th>
                    <th>prompt</th>
                    <th>cached</th>
                    <th>output</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((bucket) => (
                    <tr key={props.keyOf(bucket)}>
                        <td>
                            <code>{props.keyOf(bucket)}</code>
                            {bucket.estimatedCalls > 0 ? (
                                <div className="sub">{bucket.estimatedCalls} estimated</div>
                            ) : null}
                        </td>
                        <td>{bucket.calls}</td>
                        <td>{compact(bucket.promptTokens)}</td>
                        <td>{compact(bucket.cachedPromptTokens)}</td>
                        <td>{compact(bucket.outputTokens)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
