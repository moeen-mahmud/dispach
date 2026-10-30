/**
 * Schedules: what is armed, when it fires next, where it delivers, and a form that previews before
 * it writes.
 *
 * Props only. `now` is injected so "in 3 h" is a function of the props and a test is not a function
 * of the day it runs on. The expression is never parsed here: `onPreview` asks the server, which
 * uses the same `parseSchedule` the write does, so the sentence under the field cannot disagree with
 * the save that follows.
 */

import type React from "react"
import { useEffect, useState } from "react"

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
     * `manifest` or `api`, and it decides whether this row may be edited here at all: reconciliation
     * restores a manifest-declared schedule from the file at the next boot, so the route refuses a
     * write with `schedule_manifest_owned` and this panel does not offer one.
     */
    readonly origin?: string | undefined
    readonly role?: string | undefined
    readonly toolsAllow?: readonly string[] | undefined
    readonly timeoutMs?: number | undefined
    readonly maxSteps?: number | undefined
    readonly sessionMode?: string | undefined
    /** How the last run went: `ok`, `error` (the turn, or its delivery, failed) or `skipped`. */
    readonly lastStatus?: string | undefined
    readonly lastError?: string | undefined
    readonly lastFiredAt?: string | undefined
    readonly runs?: number | undefined
}

/** An address a reply can be sent to, offered from what has actually arrived (see `recipients`). */
export interface Recipient {
    readonly channel: string
    readonly to: string
    readonly label: string
}

export interface PreviewResult {
    readonly zone: string
    readonly next: readonly string[]
    readonly jitterMs: number
}

const CRON_PRESETS: readonly { readonly label: string; readonly expr: string }[] = [
    { label: "every morning at 08:00", expr: "0 8 * * *" },
    { label: "weekdays at 09:00", expr: "0 9 * * 1-5" },
    { label: "every hour", expr: "0 * * * *" },
    { label: "Monday 09:00", expr: "0 9 * * 1" },
    { label: "first of the month", expr: "0 9 1 * *" },
]

/** `every 15m`, `cron 0 8 * * * (Asia/Dhaka)`, `once at 2026-01-01T00:00:00Z`. */
export function whenSentence(row: Pick<ScheduleRow, "kind" | "expr" | "timezone">): string {
    const zone = row.timezone === undefined ? "" : ` (${row.timezone})`
    if (row.kind === "every") return `every ${row.expr}`
    if (row.kind === "at") return `once at ${row.expr}${zone}`
    return `cron ${row.expr}${zone}`
}

/** "in 3 h 12 min", "in 2 d", "due now", "4 min ago". */
/**
 * `in 5 min`, `5 min ago`. Under a minute it depends on what the instant is: a next run that has
 * just come is "due now", a run that just happened is "just now". `event` says it is the second.
 */
export function relative(iso: string, now: number, event = false): string {
    const delta = Date.parse(iso) - now
    if (Number.isNaN(delta)) return iso
    const abs = Math.abs(delta)
    const minutes = Math.round(abs / 60_000)
    const words =
        minutes < 1
            ? "now"
            : minutes < 60
              ? `${minutes} min`
              : minutes < 60 * 48
                ? `${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`
                : `${Math.round(minutes / 1440)} d`
    if (words === "now") return event ? "just now" : delta < 0 ? "due now" : "now"
    return delta < 0 ? `${words} ago` : `in ${words}`
}

export function SchedulesPanel(props: {
    readonly schedules: readonly ScheduleRow[]
    /** Injected clock, for "in 3 h". */
    readonly now: number
    readonly roles?: readonly string[]
    readonly recipients?: readonly Recipient[]
    readonly onPreview?: (input: {
        readonly kind: "cron" | "every" | "at"
        readonly expr: string
        readonly timezone?: string
    }) => Promise<PreviewResult>
    /** Undefined while the listing is still being read, so the form does not offer to write early. */
    readonly onCreate?: (schedule: Readonly<Record<string, unknown>>) => void
    readonly onDelete?: (scheduleId: string) => void
    readonly onRun?: (scheduleId: string) => void
    readonly onToggle?: (scheduleId: string, enabled: boolean) => void
    /** The id currently being written, so one row can say so without freezing the rest. */
    readonly busy?: string
}): React.ReactElement {
    const [adding, setAdding] = useState(false)
    return (
        <>
            <div className="page-head">
                <h1>Schedules</h1>
                <p>
                    Turns the agent takes on its own. Each runs as the scheduler would: a fresh
                    session unless it names one, the role it asks for, and only the tools it allows.
                </p>
            </div>
            {props.schedules.length === 0 ? (
                <div className="empty-state">
                    <h3>Nothing scheduled</h3>
                    <p>
                        Add one below, or declare it in the manifest's <code>schedules:</code> block
                        — a declared one survives a rebuild and shows up in a diff.
                    </p>
                </div>
            ) : (
                <div className="grid">
                    {props.schedules.map((row) => (
                        <ScheduleCard
                            key={row.id}
                            row={row}
                            now={props.now}
                            working={props.busy === row.id}
                            {...(props.onRun === undefined ? {} : { onRun: props.onRun })}
                            {...(props.onToggle === undefined ? {} : { onToggle: props.onToggle })}
                            {...(props.onDelete === undefined ? {} : { onDelete: props.onDelete })}
                        />
                    ))}
                </div>
            )}
            {props.onCreate === undefined ? null : adding ? (
                <ScheduleForm
                    roles={props.roles ?? []}
                    recipients={props.recipients ?? []}
                    {...(props.onPreview === undefined ? {} : { onPreview: props.onPreview })}
                    onCancel={() => setAdding(false)}
                    onCreate={(schedule) => {
                        props.onCreate?.(schedule)
                        setAdding(false)
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="primary"
                    style={{ marginTop: 18 }}
                    onClick={() => setAdding(true)}
                >
                    + New schedule
                </button>
            )}
        </>
    )
}

/**
 * The last run, and above all whether it failed. A schedule that fires every fifteen minutes and
 * delivers nothing ("chat not found") is armed, due and wrong; without this row the card said only
 * the first two.
 */
function LastOutcome(props: {
    readonly row: ScheduleRow
    readonly now: number
}): React.ReactElement {
    const { row } = props
    if (row.lastStatus === undefined || row.lastFiredAt === undefined) return <>never run</>
    const when = relative(row.lastFiredAt, props.now, true)
    const runs = row.runs === undefined ? "" : ` · ${row.runs} run${row.runs === 1 ? "" : "s"}`
    if (row.lastStatus === "error") {
        return (
            <>
                <span className="pill bad">failed</span> {when}
                {runs}
                {row.lastError === undefined ? null : (
                    <div className="error-line">{row.lastError}</div>
                )}
            </>
        )
    }
    return (
        <>
            <span className={`pill ${row.lastStatus === "ok" ? "ok" : "warn"}`}>
                {row.lastStatus}
            </span>{" "}
            {when}
            {runs}
        </>
    )
}

function ScheduleCard(props: {
    readonly row: ScheduleRow
    readonly now: number
    readonly working: boolean
    readonly onRun?: (scheduleId: string) => void
    readonly onToggle?: (scheduleId: string, enabled: boolean) => void
    readonly onDelete?: (scheduleId: string) => void
}): React.ReactElement {
    const { row } = props
    const owned = row.origin === "manifest"
    const next = !row.enabled
        ? "disabled"
        : row.nextRunAt === undefined
          ? "never again — a spent one-shot"
          : `${relative(row.nextRunAt, props.now)} · ${row.nextRunAt}`
    return (
        <div className={`card schedule-card${row.enabled ? "" : " off"}`}>
            <div className="head">
                <code className="schedule-id">{row.id}</code>
                <span className={`pill ${row.enabled ? "ok" : ""}`}>
                    <span className={`dot ${row.enabled ? "live" : "off"}`} />
                    {row.enabled ? "armed" : "disabled"}
                </span>
                {owned ? (
                    <span className="pill" title="declared in agent.yaml; the file decides it">
                        agent.yaml
                    </span>
                ) : null}
            </div>
            <p className="task">{row.task}</p>
            <dl className="facts">
                <dt>when</dt>
                <dd>{whenSentence(row)}</dd>
                <dt>next</dt>
                <dd>{next}</dd>
                <dt>last</dt>
                <dd>
                    <LastOutcome row={row} now={props.now} />
                </dd>
                <dt>delivers to</dt>
                <dd>
                    {row.deliverChannel === undefined
                        ? "this session only"
                        : `${row.deliverChannel}${row.deliverTo === undefined ? "" : ` → ${row.deliverTo}`}`}
                </dd>
                {row.role === undefined ? null : (
                    <>
                        <dt>role</dt>
                        <dd>
                            <code>{row.role}</code>
                        </dd>
                    </>
                )}
                {row.toolsAllow === undefined ? null : (
                    <>
                        <dt>tools</dt>
                        <dd>{row.toolsAllow.join(", ")}</dd>
                    </>
                )}
                {row.timeoutMs === undefined && row.maxSteps === undefined ? null : (
                    <>
                        <dt>limits</dt>
                        <dd>
                            {[
                                row.maxSteps === undefined ? undefined : `${row.maxSteps} steps`,
                                row.timeoutMs === undefined
                                    ? undefined
                                    : `${Math.round(row.timeoutMs / 1000)} s`,
                            ]
                                .filter((part) => part !== undefined)
                                .join(" · ")}
                        </dd>
                    </>
                )}
            </dl>
            <div className="actions">
                {/* `run` is offered for a manifest-declared schedule too: it writes nothing and does
                    not move the next run, so reconciliation cannot undo it. */}
                {props.onRun === undefined ? null : (
                    <button
                        type="button"
                        disabled={props.working}
                        onClick={() => props.onRun?.(row.id)}
                    >
                        run now
                    </button>
                )}
                {props.onToggle === undefined || owned ? null : (
                    <button
                        type="button"
                        disabled={props.working}
                        onClick={() => props.onToggle?.(row.id, !row.enabled)}
                    >
                        {row.enabled ? "disable" : "enable"}
                    </button>
                )}
                {props.onDelete === undefined || owned ? null : (
                    <button
                        type="button"
                        className="bad"
                        disabled={props.working}
                        onClick={() => props.onDelete?.(row.id)}
                    >
                        delete
                    </button>
                )}
                {owned ? (
                    <span className="sub" style={{ margin: 0 }}>
                        the manifest decides it — edit the file, or <code>schedules</code> under
                        Settings
                    </span>
                ) : null}
            </div>
        </div>
    )
}

/**
 * Arm a new schedule. Every field `ScheduleSchema` has, and no expression builder: the preview
 * under the expression is the server's reading of it, so what is shown is what will be saved.
 *
 * `deliver` is the field worth the sentence under it: on Telegram it is the numeric chat id, never
 * an `@handle`. Measured live — an agent copied the handle out of `allowFrom` and every send came
 * back `chat not found` while the schedule fired perfectly. The recipients offered are addresses a
 * message has actually arrived from, which is the one trustworthy source.
 */
function ScheduleForm(props: {
    readonly roles: readonly string[]
    readonly recipients: readonly Recipient[]
    readonly onPreview?: (input: {
        readonly kind: "cron" | "every" | "at"
        readonly expr: string
        readonly timezone?: string
    }) => Promise<PreviewResult>
    readonly onCreate: (schedule: Readonly<Record<string, unknown>>) => void
    readonly onCancel: () => void
}): React.ReactElement {
    const [id, setId] = useState("")
    const [kind, setKind] = useState<"cron" | "every" | "at">("cron")
    const [expr, setExpr] = useState("0 8 * * *")
    const [timezone, setTimezone] = useState(
        typeof Intl === "object" ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "") : "",
    )
    const [task, setTask] = useState("")
    const [channel, setChannel] = useState("")
    const [to, setTo] = useState("")
    const [role, setRole] = useState("")
    const [tools, setTools] = useState("")
    const [maxSteps, setMaxSteps] = useState("")
    const [timeoutS, setTimeoutS] = useState("")
    const [session, setSession] = useState("")
    const [preview, setPreview] = useState<PreviewResult | { readonly error: string } | undefined>()

    // Debounced: the preview is a request, and one per keystroke is a request per keystroke.
    const { onPreview } = props
    useEffect(() => {
        if (onPreview === undefined || expr.trim() === "") {
            setPreview(undefined)
            return
        }
        let cancelled = false
        const handle = setTimeout(() => {
            onPreview({ kind, expr: expr.trim(), ...(timezone === "" ? {} : { timezone }) })
                .then((result) => {
                    if (!cancelled) setPreview(result)
                })
                .catch((caught: unknown) => {
                    if (!cancelled)
                        setPreview({
                            error: caught instanceof Error ? caught.message : String(caught),
                        })
                })
        }, 350)
        return () => {
            cancelled = true
            clearTimeout(handle)
        }
    }, [kind, expr, timezone, onPreview])

    const ready =
        id.trim() !== "" &&
        expr.trim() !== "" &&
        task.trim() !== "" &&
        (channel.trim() === "" || to.trim() !== "") &&
        !(preview !== undefined && "error" in preview)

    return (
        <form
            className="card schedule-form"
            onSubmit={(event) => {
                event.preventDefault()
                if (!ready) return
                const steps = Number(maxSteps)
                const timeout = Number(timeoutS)
                props.onCreate({
                    id: id.trim(),
                    kind,
                    expr: expr.trim(),
                    task: task.trim(),
                    // `"none"` is the literal the schema expects: a schedule with no delivery
                    // returns its result through the event stream, a choice rather than an absence.
                    deliver:
                        channel.trim() === "" ? "none" : { channel: channel.trim(), to: to.trim() },
                    ...(timezone === "" ? {} : { timezone }),
                    ...(role === "" ? {} : { role }),
                    ...(tools.trim() === ""
                        ? {}
                        : {
                              tools: {
                                  allow: tools
                                      .split(",")
                                      .map((t) => t.trim())
                                      .filter(Boolean),
                              },
                          }),
                    ...(Number.isInteger(steps) && steps > 0 ? { maxSteps: steps } : {}),
                    ...(Number.isInteger(timeout) && timeout > 0
                        ? { timeoutMs: timeout * 1000 }
                        : {}),
                    ...(session.trim() === "" ? {} : { session: `shared:${session.trim()}` }),
                })
            }}
        >
            <h3>New schedule</h3>
            <div className="model-form" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}>
                <label>
                    Id
                    <input
                        value={id}
                        placeholder="morning-brief"
                        onChange={(e) => setId(e.target.value)}
                    />
                </label>
                <label>
                    Kind
                    <select
                        value={kind}
                        onChange={(e) => setKind(e.target.value as "cron" | "every" | "at")}
                    >
                        <option value="cron">cron — on a calendar</option>
                        <option value="every">every — on an interval</option>
                        <option value="at">at — once, at an instant</option>
                    </select>
                </label>
                <label style={{ gridColumn: "1 / -1" }}>
                    {kind === "cron" ? "Expression" : kind === "every" ? "Interval" : "Instant"}
                    <input
                        value={expr}
                        placeholder={
                            kind === "cron"
                                ? "0 8 * * *"
                                : kind === "every"
                                  ? "15m"
                                  : "2026-12-25T09:00:00+06:00"
                        }
                        onChange={(e) => setExpr(e.target.value)}
                    />
                    {kind === "cron" ? (
                        <span className="chips">
                            {CRON_PRESETS.map((preset) => (
                                <button
                                    type="button"
                                    key={preset.expr}
                                    className="pill"
                                    onClick={() => setExpr(preset.expr)}
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </span>
                    ) : null}
                    <span
                        className={`sub preview${preview !== undefined && "error" in preview ? " bad" : ""}`}
                    >
                        {preview === undefined
                            ? props.onPreview === undefined
                                ? ""
                                : "…"
                            : "error" in preview
                              ? preview.error
                              : preview.next.length === 0
                                ? "never fires"
                                : `next: ${preview.next.map((iso) => new Date(iso).toLocaleString()).join(" · ")} (${preview.zone}${preview.jitterMs > 0 ? `, ±${Math.round(preview.jitterMs / 1000)} s jitter` : ""})`}
                    </span>
                </label>
                {kind === "every" ? null : (
                    <label>
                        Timezone
                        <input
                            value={timezone}
                            placeholder="Asia/Dhaka"
                            onChange={(e) => setTimezone(e.target.value)}
                        />
                    </label>
                )}
                <label style={{ gridColumn: "1 / -1" }}>
                    Task
                    <textarea
                        value={task}
                        rows={2}
                        placeholder="Summarise today's calendar and unread email."
                        onChange={(e) => setTask(e.target.value)}
                    />
                </label>
                <div className="field-like">
                    <span className="field-label">Deliver to</span>
                    {props.recipients.length > 0 ? (
                        <select
                            aria-label="deliver to"
                            value={channel === "" ? "" : `${channel}\u0001${to}`}
                            onChange={(e) => {
                                const [c, t] = e.target.value.split("\u0001")
                                setChannel(c ?? "")
                                setTo(t ?? "")
                            }}
                        >
                            <option value="">this session only (event stream)</option>
                            {props.recipients.map((recipient) => (
                                <option
                                    key={`${recipient.channel}\u0001${recipient.to}`}
                                    value={`${recipient.channel}\u0001${recipient.to}`}
                                >
                                    {recipient.label}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            aria-label="deliver channel"
                            value={channel}
                            placeholder="channel id — blank for this session only"
                            onChange={(e) => setChannel(e.target.value)}
                        />
                    )}
                    {props.recipients.length === 0 && channel.trim() !== "" ? (
                        <input
                            aria-label="deliver address"
                            value={to}
                            placeholder="address — on Telegram the numeric chat id"
                            onChange={(e) => setTo(e.target.value)}
                        />
                    ) : null}
                    <span className="sub">
                        Addresses offered are ones a message has arrived from. On Telegram it is the
                        numeric chat id, never an <code>@handle</code>.
                    </span>
                </div>
                <label>
                    Model role
                    <select value={role} onChange={(e) => setRole(e.target.value)}>
                        <option value="">main</option>
                        {props.roles
                            .filter((r) => r !== "main")
                            .map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                    </select>
                </label>
                <label>
                    Tools allowed{" "}
                    <span className="sub">comma-separated slugs; blank is the agent's own</span>
                    <input
                        value={tools}
                        placeholder="now, web_search"
                        onChange={(e) => setTools(e.target.value)}
                    />
                </label>
                <label>
                    Max steps
                    <input
                        inputMode="numeric"
                        value={maxSteps}
                        placeholder="agent default"
                        onChange={(e) => setMaxSteps(e.target.value.replace(/\D/g, ""))}
                    />
                </label>
                <label>
                    Timeout (seconds)
                    <input
                        inputMode="numeric"
                        value={timeoutS}
                        placeholder="agent default"
                        onChange={(e) => setTimeoutS(e.target.value.replace(/\D/g, ""))}
                    />
                </label>
                <label>
                    Shared session{" "}
                    <span className="sub">
                        blank runs isolated; a key appends to that conversation
                    </span>
                    <input
                        value={session}
                        placeholder="briefings"
                        onChange={(e) => setSession(e.target.value)}
                    />
                </label>
            </div>
            <div className="cta-row" style={{ marginTop: 14 }}>
                <button type="submit" className="primary" disabled={!ready}>
                    arm schedule
                </button>
                <button type="button" onClick={props.onCancel}>
                    cancel
                </button>
            </div>
        </form>
    )
}
