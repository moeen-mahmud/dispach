/**
 * The shell: a credential gate, a session list, the chat, and the keys panel.
 *
 * ## Why the turn is streamed here and not in a hook per component
 *
 * One `stream()` loop owns the transcript, because a turn is one thing. The recorded terminal
 * failure is instructive: the TUI once committed accumulated text at `turn.end` and produced "every
 * tool row, then all the reasoning" — a turn rendered out of order because two places were deciding
 * when text became a row. The loop here feeds `reduce`, and nothing else writes rows.
 *
 * ## Reattach is not a feature here, it is the default
 *
 * `POST /messages` returns and the turn runs detached; a refresh mid-turn must not lose it. So the
 * live turn id goes into `sessionStorage` and the page re-attaches on mount. That is the same
 * property `GET /approvals` exists for one layer down — a client that only *listens* loses a
 * pending question to a page reload.
 */

import type {
    AgentClient,
    AgentConfig,
    DispachClient,
    PendingApproval,
    ProvisionedAgentLike,
    ProvisionOfferLike,
    ScheduleRecord,
    SessionSummary,
    ToolSummary,
} from "@dispach/client"
import { DispachError } from "@dispach/client"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Composer, Rows } from "./chat.tsx"
import { Keys } from "./keys.tsx"
import {
    type Credential,
    exchangeClaim,
    forgetKey,
    client as makeClient,
    rememberKey,
    resolveCredential,
} from "./lib/auth.ts"
import { hrefFor, type PanelName, placeFrom } from "./lib/deep-link.ts"
import { type LiveStream, liveStream } from "./lib/live.ts"
import { initialAnswers, missingAnswers, payloadFor } from "./lib/provision-form.ts"
import { EMPTY, emptyFor, reduce, type Transcript, withUser } from "./lib/transcript.ts"
import { Onboarding } from "./onboarding.tsx"
import {
    AgentList,
    type AgentRow,
    type ChannelRow,
    ChannelsPanel,
    ConfigPanel,
    SchedulesPanel,
    SERVER_PANELS,
    ToolsPanel,
} from "./panels.tsx"

/** Where a live turn id is parked so a refresh can reattach. Per tab, not per browser. */
const LIVE_TURN = "dispach.turn"

export function App(props: { readonly baseUrl: string }): React.ReactElement {
    const [credential, setCredential] = useState<Credential | undefined>()
    const [failure, setFailure] = useState<string>()

    useEffect(() => {
        resolveCredential(props.baseUrl)
            .then(setCredential)
            .catch((error: unknown) =>
                // A transport failure is not an authentication answer (see `auth.ts`): showing a
                // paste-a-token screen to somebody whose server is down sends them after the wrong
                // problem entirely.
                setFailure(error instanceof Error ? error.message : String(error)),
            )
    }, [props.baseUrl])

    if (failure !== undefined) {
        return (
            <Gate title="Cannot reach the server">
                <p>{failure}</p>
                <button type="button" onClick={() => window.location.reload()}>
                    Try again
                </button>
            </Gate>
        )
    }
    if (credential === undefined) return <Gate title="Connecting…" />
    if (credential.kind === "needed")
        return <PasteCredential baseUrl={props.baseUrl} because={credential.because} />

    return (
        <Workspace
            baseUrl={props.baseUrl}
            token={credential.kind === "key" ? credential.secret : undefined}
        />
    )
}

function Gate(props: {
    readonly title: string
    readonly children?: React.ReactNode
}): React.ReactElement {
    return (
        <div className="gate">
            <div className="card">
                <h2>{props.title}</h2>
                {props.children}
            </div>
        </div>
    )
}

/**
 * The fourth credential state: something is needed and we have none.
 *
 * Two ways in, and both are offered because they belong to different people. A **claim** is what
 * `serve` printed, which the operator has in a terminal or in `docker logs`. A **key** is what a
 * platform minted through `POST /v1/keys` and handed over. The container token is deliberately not
 * mentioned: it would work, and pasting the credential every scheduled caller shares into a browser
 * is exactly what operator keys exist to stop.
 */
function PasteCredential(props: {
    readonly baseUrl: string
    readonly because: string
}): React.ReactElement {
    const [value, setValue] = useState("")
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)

    const submit = async (asClaim: boolean) => {
        setBusy(true)
        setError(undefined)
        try {
            const secret = asClaim ? await exchangeClaim(props.baseUrl, value.trim()) : value.trim()
            rememberKey(secret)
            window.location.reload()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
            setBusy(false)
        }
    }

    return (
        <Gate title="This server needs a credential">
            <p>{props.because}</p>
            <input
                value={value}
                placeholder="paste a claim or an operator key"
                onChange={(event) => setValue(event.target.value)}
            />
            <p className="hint" style={{ margin: "8px 0 12px" }}>
                <code>dispach serve</code> prints a one-time claim at boot while no key exists. A
                claim is exchanged for a key this browser keeps; a key is used directly.
            </p>
            <div className="ask">
                <div className="buttons">
                    <button
                        type="button"
                        className="primary"
                        disabled={busy || value.trim() === ""}
                        onClick={() => submit(true)}
                    >
                        Exchange a claim
                    </button>
                    <button
                        type="button"
                        disabled={busy || value.trim() === ""}
                        onClick={() => submit(false)}
                    >
                        Use as a key
                    </button>
                </div>
            </div>
            {error === undefined ? null : (
                <p className="note bad" style={{ marginTop: 12 }}>
                    {error}
                </p>
            )}
        </Gate>
    )
}

/**
 * Where you are. A name rather than a variant object, because it is also what goes in the URL.
 *
 * It was `{kind:"chat"} | {kind:"keys"}` — a discriminated union carrying no data, which is a
 * string with extra steps. Now that a place is round-tripped through the address bar, the string
 * *is* the state, and `lib/deep-link.ts` owns which names are real so the shell cannot invent one.
 */
/**
 * Whether a thrown error is the agent having gone, rather than anything else.
 *
 * At module scope on purpose. Defined inside the component it is stable-looking and is not —
 * recreated every render, so the exhaustive-deps rule wants it in three dependency lists, and
 * putting it there makes every memo around it change on every render. It reads nothing from the
 * component, so the honest fix is that it is not part of one. (Not the rule's *offered* fix, which
 * is to add the dependency — this repo has a recorded case where taking that offer enforced a cap
 * once at mount and never again.)
 */
const isGone = (caught: unknown): boolean => caught instanceof DispachError && caught.status === 404

type Panel = PanelName

/** What the bar says for a panel that is not the chat. Keyed, so a new panel needs a title. */
const TITLES: Readonly<Record<Exclude<Panel, "chat">, string>> = {
    new: "New agent",
    tools: "Tools",
    schedules: "Schedules",
    channels: "Channels",
    config: "Settings",
    keys: "Operator keys",
}

function Workspace(props: {
    readonly baseUrl: string
    readonly token: string | undefined
}): React.ReactElement {
    const clientRef = useRef<DispachClient>(makeClient(props.baseUrl, props.token))
    const [agents, setAgents] = useState<readonly AgentRow[]>([])
    const [agentId, setAgentId] = useState<string>()
    const [agentName, setAgentName] = useState<string>()
    const [starting, setStarting] = useState<string>()
    /** Any question already waiting, for a page that opened after the turn blocked. */
    const [pending, setPending] = useState<readonly PendingApproval[]>([])

    /**
     * The current agent is no longer hosted. Stop asking, and say so.
     *
     * **Found in a browser, and only visible there.** With a page open on an agent that was then
     * stopped, every agent-scoped fetch — approvals on a 5-second timer, plus the panels — answered
     * 404 in a loop, dozens of times, with nothing on screen. The approvals poller's own comment
     * justified it: *"a failed poll is not worth a banner; the next one will say so"*, which is true
     * of a transient failure and false of a 404, because the next one says the same thing forever.
     *
     * A 404 on an agent route means exactly one thing — `withAgent` could not resolve it — so it is
     * not a poll to retry, it is a selection that has expired. The listing is re-read because that
     * is what turns this into something actionable: the agent reappears as a stopped row in the
     * picker, with the `start` that fixes it.
     */
    const agentGone = useCallback(async () => {
        setAgentId(undefined)
        setAgentName(undefined)
        setPending([])
        setError("this agent is no longer running on this server — start it from the list")
        try {
            setAgents(await clientRef.current.agents())
        } catch {
            // The listing failing too means the server itself is unreachable, which the next
            // interaction reports. Replacing the sentence above with a transport error would trade
            // a useful message for a vaguer one.
        }
    }, [])

    const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
    const [sessionKey, setSessionKey] = useState<string>()
    // Seeded from the address, so a bookmark of a panel opens on it. `useState`'s initialiser
    // semantics are what make this a seed rather than a prop that would fight a later navigation.
    const [panel, setPanel] = useState<Panel>(() => placeFrom(window.location.href).panel)
    const [state, setState] = useState<Transcript>(EMPTY)
    const [draft, setDraft] = useState("")
    const [error, setError] = useState<string>()
    const stopRef = useRef<(() => Promise<void>) | undefined>(undefined)
    /**
     * One stream per turn, owned outside this component so it can be tested.
     *
     * `lib/live.ts` holds the reasoning. The short version: this file is where the untested code
     * was, and a guard written against a component whose effects never mount could not fail.
     */
    const liveRef = useRef<LiveStream>(liveStream())

    /**
     * Which agent, and its name for the title.
     *
     * `?agent=` first, then the first one running. The query parameter is what `web run <agent>`
     * puts there, and reading it here is what stops that URL being a lie — a link naming an agent
     * that the page then ignores is declared vocabulary nothing consumes, which this repo has paid
     * for more than once (`kv`, `eviction: oldest`, `includeHistory`).
     *
     * **A path was the alternative and costs five things** a query parameter does not: a route, a
     * `WEB_ASSETS` entry, a spec row, a `spec.test.ts` change, and either a catch-all — which would
     * make `/v1/agentss` answer `200 text/html` — or a 404 on reload. The no-catch-all decision
     * stands; this is how a deep link works without it.
     *
     * An id that names nothing **falls back** rather than erroring, and says nothing about it: the
     * ordinary cause is a bookmark to an agent that has since been stopped or removed, and a blank
     * screen with "no such agent" would be a worse answer than the one running agent there is.
     */
    useEffect(() => {
        const asked = new URL(window.location.href).searchParams.get("agent") ?? undefined
        clientRef.current
            .agents()
            .then((agents) => {
                // **The first agent that is actually running.** The listing carries a thin row for
                // a stopped one so a picker can offer to start it, and taking `agents[0]` blindly
                // would open a chat against an agent with no runtime behind it — every send a 404.
                // The whole list is kept, stopped rows included: a picker that hid them would
                // leave somebody who switched an agent off with no way to discover that they had.
                setAgents(agents)
                const running = agents.filter((entry) => entry.status !== "disabled")
                const first = running.find((entry) => entry.id === asked) ?? running[0]
                if (first === undefined) {
                    /**
                     * Nothing to show, so show the thing that fixes it.
                     *
                     * This is the shape the whole phase is for: install, open the page, create an
                     * agent, talk to it. Without this an empty server paints a chat against no
                     * agent — a composer whose every send is a 404 and a sidebar with one greyed
                     * group, which reads as broken rather than as new.
                     *
                     * **An explicit `?panel=` wins**, because a link somebody followed says where
                     * they meant to go and `placeFrom` cannot tell "no parameter" from
                     * "`panel=chat`". The address bar is deliberately not rewritten: this is a
                     * consequence of the listing being empty, not a place that was navigated to,
                     * and a reload re-derives it.
                     */
                    if (new URL(window.location.href).searchParams.get("panel") === null) {
                        setPanel("new")
                    }
                    return
                }
                setAgentId(first.id)
                setAgentName(first.name)
                // The dialect decides whether the token stream needs filtering, and it is known
                // once and never changes for an agent —  is config, never auto-detected. Defaulted
                // because the field is optional on the listing's disabled rows, and a running agent
                // always carries it.
                setState((previous) => ({
                    ...previous,
                    filter: emptyFor(first.dialect ?? "nlt").filter,
                }))
                document.title = `${first.name} · Dispach`
            })
            .catch((caught: unknown) => setError(describe(caught)))
    }, [])

    /**
     * The per-agent facade, **memoised on the id** — and this one line is load-bearing.
     *
     * `client.agent(id)` builds a fresh object literal on every call, so calling it in the render
     * body gave `agent` a new identity every render. Everything keyed on it followed:
     * `refreshSessions`, then `follow`, then the reattach effect below — which has no cleanup, so
     * each render started *another* `/stream?chunks=true` for the same turn, and each stream's
     * `setState` committed a render that started another.
     *
     * Every one of those streams folded into one `Transcript` and one **mutable** `StreamFilter`, so
     * a real session rendered `DoingDoingDoingDoing good good good…` and then the finished reply
     * eight more times. The proof was in the screenshot: the first block read `thinking · 1068
     * chars` and every repeat `178`, and 1068 = 178 × 6 — six streams interleaving into one buffer,
     * then eight late attaches each replaying the turn and committing a clean copy of their own.
     *
     * The same loop hammered `GET /sessions` until the browser refused new connections and reported
     * a *same-origin* fetch as `Failed to fetch`. The CLI has never had this: `lib/source.ts:281`
     * guards with `if (pump !== undefined) return` on a subscription mounted on stable deps.
     */
    const agent: AgentClient | undefined = useMemo(
        () => (agentId === undefined ? undefined : clientRef.current.agent(agentId)),
        [agentId],
    )

    const refreshSessions = useCallback(async () => {
        if (agent === undefined) return
        try {
            setSessions(await agent.sessions())
            // **Cleared on success, or one transient failure is permanent.** The old code set the
            // error and never unset it, and because the string was identical every time React
            // bailed out of the re-render — so the banner sat there with nothing retrying behind
            // it. A poll that recovers has to say so on the surface that reported the fault.
            setError(undefined)
        } catch (caught) {
            // Routed through the same predicate as every other agent-scoped fetch. Left to set a
            // raw error, this races the sentence `agentGone` writes and sometimes wins — so the
            // page would report `agent_not_found` where it has one plain explanation to give.
            if (isGone(caught)) void agentGone()
            else setError(describe(caught))
        }
    }, [agent, agentGone])

    useEffect(() => {
        void refreshSessions()
    }, [refreshSessions])

    /**
     * Follow one turn to its end, folding every frame into the transcript.
     *
     * **One stream per turn, enforced rather than hoped for.** The gate is `lib/live.ts`, which is
     * this package's spelling of `cli/src/lib/source.ts:281`'s `if (pump !== undefined) return`.
     * The memo above stops the effect below from re-firing; the gate stops everything else — a
     * second `send`, a `StrictMode` double-invoke, a future effect that gains a dependency — from
     * opening a second subscription into the same accumulator. The memo alone would have fixed
     * today's symptom and left the shape that produced it.
     *
     * The abort is the other half, and it comes from the same place. `AgentClient.stream` has taken
     * a `signal` since the client was written and this call site passed none, so a stream outlived
     * the agent and session it was started for: `goTo` and `openSession` both reset the transcript
     * and neither could stop a stream still writing into it. `handle.stop()` is a *server-side turn
     * cancel* and was never the same thing as hanging up.
     */
    const follow = useCallback(
        async (turnId: string, forAgent: AgentClient) => {
            const live = liveRef.current
            const signal = live.begin(turnId)
            // Already following this turn. Opening a second stream is what produced six copies of
            // one reply interleaved into a single accumulator.
            if (signal === undefined) return
            const handle = forAgent.turn(turnId)
            stopRef.current = () => handle.stop()
            try {
                sessionStorage.setItem(LIVE_TURN, turnId)
                for await (const item of handle.stream({ chunks: true, signal })) {
                    setState((previous) => reduce(previous, item))
                }
            } catch (caught) {
                // An abort is this page closing the stream on purpose — a session switch, an agent
                // switch, an unmount. Reporting it would put a transport error on screen for an
                // action the reader just took.
                if (!signal.aborted) {
                    setError(describe(caught))
                    setState((previous) => ({ ...previous, running: false }))
                }
            } finally {
                live.finish(turnId)
                sessionStorage.removeItem(LIVE_TURN)
                stopRef.current = undefined
                if (!signal.aborted) void refreshSessions()
            }
        },
        [refreshSessions],
    )

    /**
     * Reattach on mount, before anything else can start a turn.
     *
     * The turn is detached from the connection by design, so a refresh mid-turn leaves one running
     * with nobody watching. Without this the page would come back looking idle while the agent was
     * still working — which is the "looks live and is not" shape the TUI's `pinned` flag exists to
     * prevent, one layer out.
     */
    useEffect(() => {
        if (agent === undefined) return
        const parked = sessionStorage.getItem(LIVE_TURN)
        if (parked === null) return
        setState((previous) => ({ ...previous, running: true }))
        void follow(parked, agent)
        // The cleanup this never had. Without it, a change of agent left the previous agent's
        // stream writing into a transcript the page had already replaced.
        return () => liveRef.current.abort()
    }, [agent, follow])

    useEffect(() => {
        if (agent === undefined) return
        let live = true
        const tick = () => {
            agent
                .approvals()
                .then((list) => {
                    if (live) setPending(list)
                })
                .catch((caught: unknown) => {
                    // A transient failure is not worth a banner and the next poll will say so. A
                    // 404 is not transient: the agent is gone, and retrying every five seconds
                    // forever is the silent failure this used to be.
                    if (live && isGone(caught)) void agentGone()
                })
        }
        tick()
        // Polled rather than pushed, because a page that only listens loses a prompt to a reload —
        // the recovery path `GET /approvals` exists for. Slow, because it is a backstop: the live
        // stream is what shows a question promptly.
        const timer = window.setInterval(tick, 5_000)
        return () => {
            live = false
            window.clearInterval(timer)
        }
    }, [agent, agentGone])

    const send = async () => {
        const text = draft.trim()
        if (text === "" || agent === undefined) return
        setDraft("")
        setError(undefined)
        setState((previous) => withUser(previous, text))
        try {
            const handle = await agent.send(text, {
                ...(sessionKey === undefined ? {} : { sessionKey }),
            })
            if (sessionKey === undefined) setSessionKey(handle.sessionKey)
            await follow(handle.turnId, agent)
        } catch (caught) {
            setError(describe(caught))
            setState((previous) => ({ ...previous, running: false }))
        }
    }

    const answer = async (approvalId: string, granted: boolean) => {
        if (agent === undefined) return
        try {
            await agent.approve(approvalId, granted)
        } catch (caught) {
            // `approval_not_found` covers answered-already and abandoned-with-its-turn alike, and
            // neither is worth an error banner — `approval.resolved` is already arriving on the
            // stream and will settle the row with the right sentence.
            if (!(caught instanceof DispachError && caught.code === "approval_not_found"))
                setError(describe(caught))
        }
    }

    const openSession = async (key: string | undefined) => {
        // Close the live stream *before* replacing the transcript it is writing into. Without this
        // a turn started in one conversation went on appending rows to the next one — the
        // transcript was reset, the stream was not, and nothing connected the two.
        liveRef.current.abort()
        setPanel("chat")
        setSessionKey(key)
        setState(EMPTY)
        setDraft("")
        if (key === undefined || agent === undefined) return
        // The stored conversation, so switching does not look like starting over. Prose only: turn
        // statistics were true of a process that has exited, which the TUI's `seedHistory` records.
        try {
            const messages = await history(props.baseUrl, props.token, agentId ?? "", key)
            setState({ ...EMPTY, rows: messages })
        } catch (caught) {
            setError(describe(caught))
        }
    }

    /**
     * The report panels' data, fetched when one is opened rather than at mount.
     *
     * Lazily because it is read-only and nobody is billed for what they do not look at, and
     * **re-fetched on every open** rather than cached: a tool catalogue changes on a reload and a
     * schedule's next run moves every time it fires, so a cached panel is one that quietly shows
     * yesterday. `/v1/agents/:id` is one request for the channels, and its `channels[]` carries the
     * `needs_input` payload precisely so a page that opened *after* the QR was issued still has it.
     */
    const [report, setReport] = useState<{
        readonly tools: readonly ToolSummary[]
        readonly schedules: readonly ScheduleRecord[]
        readonly channels: readonly ChannelRow[]
        readonly config?: AgentConfig
    }>({ tools: [], schedules: [], channels: [] })

    /**
     * Re-read the panels' data.
     *
     * A function rather than only an effect, because the **writing** panels need it: a schedule
     * added or a setting saved changes what the listing says, and patching the local copy from a
     * response would be a second opinion about the server's state — the same reasoning `startAgent`
     * and `createAgent` already use for re-reading the agent listing instead of trusting `adopted`.
     */
    const refreshReport = useCallback(async (target: AgentClient) => {
        const [tools, schedules, described, config] = await Promise.all([
            target.tools(),
            target.schedules(),
            target.describe(),
            // Fetched with the rest rather than on its own panel, because a *write* to it has
            // to refresh everything: setting `schedules` or `tools.pinned` through the config
            // panel changes what the schedule and tool panels say, and one round trip that
            // leaves two panels stale is how a surface comes to disagree with itself.
            target.config(),
        ])
        setReport({ tools, schedules, channels: described.channels ?? [], config })
    }, [])

    useEffect(() => {
        if (agent === undefined) return
        if (
            panel !== "tools" &&
            panel !== "schedules" &&
            panel !== "channels" &&
            panel !== "config"
        )
            return
        let cancelled = false
        void (async () => {
            try {
                await refreshReport(agent)
                // The panel may have changed while these were in flight, and a late write would
                // repaint a surface nobody is looking at with data for one they left.
                if (cancelled) return
            } catch (caught) {
                if (cancelled) return
                if (isGone(caught)) void agentGone()
                else setError(describe(caught))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [agent, panel, agentGone, refreshReport])

    /**
     * One writer for both editing panels, and the reason it is one function.
     *
     * Every write here has the same three obligations: say which row is busy so the rest of the
     * page stays usable, re-read the listing rather than patch it, and report a refusal with the
     * server's own words. Four call sites each doing that is four places for one of the three to go
     * missing — and the one that goes missing silently is the re-read, which leaves a panel showing
     * a schedule that has been deleted.
     */
    const [writing, setWriting] = useState<string>()
    const [writeNote, setWriteNote] = useState<string>()
    const write = useCallback(
        async (key: string, work: (target: AgentClient) => Promise<string | undefined>) => {
            if (agent === undefined) return
            setWriting(key)
            setError(undefined)
            setWriteNote(undefined)
            try {
                const note = await work(agent)
                setWriteNote(note)
                await refreshReport(agent)
            } catch (caught) {
                if (isGone(caught)) void agentGone()
                else setError(describe(caught))
            } finally {
                setWriting(undefined)
            }
        },
        [agent, agentGone, refreshReport],
    )

    /**
     * Save one setting.
     *
     * `applied` is read rather than assumed. The file is written before the agent is replaced and
     * `dispose` refuses while a turn is in flight, so a successful write can legitimately come back
     * unapplied — and saying "saved" alone would describe a change that is not in force. The
     * server's own `pending.message` is passed through, because it knows why far better than this
     * page does.
     */
    const saveSetting = useCallback(
        (path: string, value: string, options: { confirm: boolean }) =>
            void write(path, async (target) => {
                const result = await target.setConfig(path, value, {
                    ...(options.confirm ? { confirm: true } : {}),
                })
                if (result.applied) {
                    return result.reflowed
                        ? `${path} saved. The manifest was re-serialised, so its comments have moved — worth a look at the diff.`
                        : undefined
                }
                return `${path} was written to the manifest and is not in force yet: ${result.pending?.message ?? "the agent could not be replaced"} It takes effect at the next start.`
            }),
        [write],
    )

    /**
     * What this server will ask to create an agent, and whether it will at all.
     *
     * Fetched when the panel is opened, like the report panels and for the same reason — nobody is
     * billed for a surface they do not look at. Kept once opened rather than re-fetched: the step
     * list is generated from a walk over a fixed order, so unlike a tool catalogue or a schedule's
     * next run it cannot change while somebody is filling the form in.
     *
     * **Fetched even when provisioning is refused.** `GET /v1/provision` answers with `available`
     * and `local` precisely so a page can say *which* reason applies; a `501` or a `403` from
     * `POST /v1/agents` would only say that it did not work, after somebody had typed a form.
     */
    const [offer, setOffer] = useState<ProvisionOfferLike>()
    const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({})
    const [touched, setTouched] = useState(false)
    const [creating, setCreating] = useState(false)
    const [created, setCreated] = useState<ProvisionedAgentLike>()

    useEffect(() => {
        if (panel !== "new" || offer !== undefined) return
        let cancelled = false
        void (async () => {
            try {
                const next = await clientRef.current.provision()
                if (cancelled) return
                setOffer(next)
                // Seeded from the server's own defaults, so the form opens on the same agent
                // `init --yes` would write. A default resolved here would be a second answer to a
                // question the wire already answers.
                setAnswers(initialAnswers(next.steps))
            } catch (caught) {
                if (!cancelled) setError(describe(caught))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [panel, offer])

    /**
     * Create the agent, and let the response decide what is said next.
     *
     * The gate is checked here as well as in the form because the form's marker is advisory: the
     * route answers one field at a time, and three round trips to learn about three empty fields is
     * a form that feels broken. `touched` is set first either way, so the markers appear on the
     * attempt rather than on load.
     *
     * A `400` carries a `field` naming the step to fix, and it is shown as the route worded it —
     * the implementation knows why far better than this page does, which is the same reasoning
     * `POST /v1/agents` uses for passing `HarnessError`'s hint through untouched.
     *
     * **The listing is re-read on success**, not patched: `adopted` can be empty for a reason this
     * page cannot know, and the listing is the source of truth about what is running — the same
     * choice `startAgent` makes one function up.
     */
    const createAgent = useCallback(async () => {
        if (offer === undefined) return
        setTouched(true)
        if (missingAnswers(offer.steps, answers).length > 0) return
        setCreating(true)
        setError(undefined)
        try {
            const result = await clientRef.current.createAgent(payloadFor(offer.steps, answers))
            setCreated(result)
            setAgents(await clientRef.current.agents())
        } catch (caught) {
            setError(describe(caught))
        } finally {
            setCreating(false)
        }
    }, [offer, answers])

    /**
     * Move, and put it in the address bar.
     *
     * `replaceState` rather than `pushState`: the browser's back button would otherwise walk the
     * panel history, and a person who opened tools and pressed back expects to leave the page
     * rather than return to the chat they were on two clicks ago. The same choice `lib/auth.ts`
     * makes for a spent claim, for a different reason.
     */
    const goTo = useCallback(
        (next: { readonly panel?: Panel; readonly agentId?: string }) => {
            const panelNext = next.panel ?? panel
            const agentNext = next.agentId ?? agentId
            setPanel(panelNext)
            if (next.agentId !== undefined && next.agentId !== agentId) {
                setAgentId(next.agentId)
                setAgentName(agents.find((entry) => entry.id === next.agentId)?.name)
                // A different agent is a different conversation and a different transcript. Reset
                // rather than carry: showing one agent's reply under another's name is the worst
                // available outcome, and the store has the history either way.
                setSessionKey(undefined)
                setState(EMPTY)
                setDraft("")
            }
            window.history.replaceState(
                null,
                "",
                hrefFor(window.location.href, {
                    ...(agentNext === undefined ? {} : { agentId: agentNext }),
                    panel: panelNext,
                }),
            )
        },
        [agentId, agents, panel],
    )

    /**
     * Switch a stopped agent back on, and re-read the listing rather than assuming it worked.
     *
     * `POST /start` answers with the lifecycle row and `adopted[]`, but adoption can fail for a
     * reason this page cannot know — a missing key, a manifest that no longer loads — and the route
     * reports that by putting the row back. So the listing is the source of truth afterwards, not
     * the response.
     */
    const startAgent = useCallback(async (id: string) => {
        setStarting(id)
        try {
            await clientRef.current.agent(id).start()
            setAgents(await clientRef.current.agents())
        } catch (caught) {
            setError(describe(caught))
        } finally {
            setStarting(undefined)
        }
    }, [])

    return (
        <div className="shell">
            <aside className="side">
                <header>
                    <div className="brand">Dispach</div>
                    <div style={{ fontSize: 12, color: "var(--dim)" }}>{agentName ?? "…"}</div>
                </header>
                <nav>
                    {/*
                     * Agents first, and only when there is more than one.
                     *
                     * A picker on a single-agent server is a control with one option — noise on the
                     * shape this runtime is most often deployed in, one agent per container. The
                     * *stopped* rows are the exception: those appear whatever the count, because an
                     * agent that is off and invisible is the failure `dispach stop` was designed
                     * around, and here it would leave a blank page with nothing explaining it.
                     */}
                    {agents.length > 1 || agents.some((entry) => entry.status === "disabled") ? (
                        <>
                            <div className="group">Agents</div>
                            <AgentList
                                agents={agents}
                                current={agentId}
                                onSelect={(id) => goTo({ agentId: id })}
                                onStart={(id) => void startAgent(id)}
                                {...(starting === undefined ? {} : { starting })}
                            />
                        </>
                    ) : null}
                    <div className="group">Conversation</div>
                    <button
                        type="button"
                        className="row-button"
                        aria-current={panel === "chat" && sessionKey === undefined}
                        onClick={() => void openSession(undefined)}
                    >
                        + new
                    </button>
                    {sessions.map((session) => (
                        <button
                            type="button"
                            key={session.sessionKey}
                            className="row-button"
                            aria-current={panel === "chat" && sessionKey === session.sessionKey}
                            onClick={() => void openSession(session.sessionKey)}
                        >
                            {session.sessionKey}
                        </button>
                    ))}
                    <div className="group">Server</div>
                    {/*
                     * `new agent` is not in `SERVER_PANELS` and that is deliberate: those are the
                     * read-only report panels, and this is the only surface on the page that
                     * *writes*. It is offered whenever the panel has been opened or a link named
                     * it, and while the offer is unknown — because hiding it until a fetch that
                     * only happens on open has happened would mean it could never be opened.
                     */}
                    <button
                        type="button"
                        className="row-button"
                        aria-current={panel === "new"}
                        onClick={() => goTo({ panel: "new" })}
                    >
                        + new agent
                    </button>
                    {/*
                     * Generated from `SERVER_PANELS`, so a panel added to the union appears here
                     * with nothing to remember. A hand-kept copy of this list is the shape this
                     * repo has paid for repeatedly — `NO_MANIFEST` omitting `soul`, the wire doc's
                     * six phantom event rows — and it is always right on the day it is written.
                     */}
                    {SERVER_PANELS.map((entry) => (
                        <button
                            type="button"
                            key={entry.panel}
                            className="row-button"
                            aria-current={panel === entry.panel}
                            onClick={() => goTo({ panel: entry.panel })}
                        >
                            {entry.label}
                        </button>
                    ))}
                </nav>
                <footer>
                    <span className={`dot ${state.running ? "busy" : "live"}`} />
                    <span style={{ fontSize: 11, color: "var(--dim)" }}>
                        {state.running ? "working" : "ready"}
                    </span>
                    {props.token === undefined ? (
                        <span style={{ fontSize: 11, color: "var(--warn)", marginLeft: "auto" }}>
                            unauthenticated
                        </span>
                    ) : (
                        <button
                            type="button"
                            style={{ marginLeft: "auto", padding: "3px 8px", fontSize: 11 }}
                            onClick={() => {
                                forgetKey()
                                window.location.reload()
                            }}
                        >
                            forget key
                        </button>
                    )}
                </footer>
            </aside>

            <main className="main">
                <div className="bar">
                    <strong>{panel === "chat" ? (agentName ?? "") : TITLES[panel]}</strong>
                    {panel === "chat" ? <span>{sessionKey ?? "new conversation"}</span> : null}
                    <span className="spacer" />
                    {pending.length > 0 ? (
                        <span style={{ color: "var(--warn)" }}>
                            {pending.length} waiting on you
                        </span>
                    ) : null}
                </div>

                {panel !== "chat" ? (
                    <div className="scroll">
                        <div className="pad">
                            {error === undefined ? null : <p className="row note bad">{error}</p>}
                            {panel === "new" ? (
                                offer === undefined ? (
                                    <p className="empty">reading this server's questions…</p>
                                ) : (
                                    <Onboarding
                                        offer={offer}
                                        answers={answers}
                                        busy={creating}
                                        touched={touched}
                                        {...(error === undefined ? {} : { error })}
                                        {...(created === undefined ? {} : { result: created })}
                                        onAnswer={(step, value) =>
                                            setAnswers((previous) => ({
                                                ...previous,
                                                [step]: value,
                                            }))
                                        }
                                        onSubmit={() => void createAgent()}
                                        /*
                                         * Straight into the new agent's chat, and the listing was
                                         * already re-read — so the picker has it and `goTo` can
                                         * find its name. Offered only when it was adopted: an
                                         * agent that is on disk and not running would answer 404
                                         * on every send, which is the loop 11.224 removed.
                                         */
                                        onOpen={(id) => {
                                            setCreated(undefined)
                                            setOffer(undefined)
                                            setTouched(false)
                                            goTo({ agentId: id, panel: "chat" })
                                        }}
                                    />
                                )
                            ) : null}
                            {panel === "keys" ? (
                                <Keys
                                    client={clientRef.current}
                                    baseUrl={props.baseUrl}
                                    token={props.token}
                                />
                            ) : null}
                            {panel === "tools" ? <ToolsPanel tools={report.tools} /> : null}
                            {panel === "schedules" ? (
                                <SchedulesPanel
                                    schedules={report.schedules}
                                    {...(writing === undefined ? {} : { busy: writing })}
                                    onCreate={(schedule) =>
                                        void write(String(schedule.id), (target) =>
                                            target.createSchedule(schedule).then(() => undefined),
                                        )
                                    }
                                    onDelete={(id) =>
                                        void write(id, (target) =>
                                            target.deleteSchedule(id).then(() => undefined),
                                        )
                                    }
                                    /*
                                     * Out of band, and it does **not** move the next scheduled run.
                                     * Said on the row rather than left to the route's docs: "run it
                                     * now" and "pretend it fired" are different things, and
                                     * somebody who believed the second would find the real one
                                     * firing a minute later.
                                     */
                                    onRun={(id) =>
                                        void write(id, async (target) => {
                                            const fired = await target.runSchedule(id)
                                            return `${id} fired out of band as ${fired.turnId} — its next scheduled run has not moved.`
                                        })
                                    }
                                    onToggle={(id, enabled) =>
                                        void write(id, (target) =>
                                            target
                                                .updateSchedule(id, { enabled })
                                                .then(() => undefined),
                                        )
                                    }
                                />
                            ) : null}
                            {panel === "config" ? (
                                report.config === undefined ? (
                                    <p className="empty">reading this agent's settings…</p>
                                ) : (
                                    <ConfigPanel
                                        settings={report.config.settings}
                                        editable={report.config.editable}
                                        {...(report.config.file === undefined
                                            ? {}
                                            : { file: report.config.file })}
                                        {...(writing === undefined ? {} : { busy: writing })}
                                        {...(writeNote === undefined ? {} : { note: writeNote })}
                                        onSet={saveSetting}
                                    />
                                )
                            ) : null}
                            {panel === "channels" ? (
                                // `now` is passed rather than read inside the component, so a stale
                                // payload is judged against one clock and the rendering stays
                                // deterministic — a component reading the clock is one whose test
                                // passes or fails depending on the time of day.
                                <ChannelsPanel channels={report.channels} now={Date.now()} />
                            ) : null}
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="scroll">
                            <div className="pad">
                                {error === undefined ? null : (
                                    <p className="row note bad">{error}</p>
                                )}
                                <Rows state={state} onAnswer={(id, ok) => void answer(id, ok)} />
                                <Tail state={state} />
                            </div>
                        </div>
                        <Composer
                            value={draft}
                            busy={state.running}
                            onChange={setDraft}
                            onSend={() => void send()}
                            onStop={() => void stopRef.current?.()}
                        />
                    </>
                )}
            </main>
        </div>
    )
}

/**
 * Keeps the newest row in view — and only while the reader is already at the bottom.
 *
 * Scrolling unconditionally is the recorded `pinned` bug in a browser: a reader who has deliberately
 * scrolled up to read something gets yanked back down the instant a token arrives. The 40-pixel
 * tolerance is for fractional scroll heights, not for taste.
 */
function Tail(props: { readonly state: Transcript }): React.ReactElement {
    const anchor = useRef<HTMLDivElement>(null)
    // Depends on the row count and the live text, named rather than left to an un-keyed effect: the
    // lint rule offers to delete an unused dependency array, and taking that offer would scroll on
    // every render of the whole tree instead of when the transcript actually grew — the recorded
    // `trim` trigger mistake, one component over.
    const depth = props.state.rows.length + props.state.live.length
    // `depth` is never read inside the body, so the rule offers to delete it — and taking that
    // offer scrolls once at mount and never again, which lints clean and does nothing. Recorded in
    // CLAUDE.md for the TUI's `trim` action and true here for the same reason.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a deliberate trigger dependency
    useEffect(() => {
        const node = anchor.current
        const box = node?.closest(".scroll")
        if (node === null || box === null || box === undefined) return
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
        if (atBottom) node.scrollIntoView({ block: "end" })
    }, [depth])
    return <div ref={anchor} />
}

/**
 * Stored messages for a session, as transcript rows.
 *
 * Read through `fetch` rather than the client because the client has no messages method — and
 * adding one for a page that needs prose only would widen its surface for a convenience. The
 * origins the runtime stamps are what make this a filter rather than a guess: `observation`,
 * `call`, `repair` and `digest` are the runtime's own text, and only unstamped messages are prose
 * somebody wrote.
 */
async function history(
    baseUrl: string,
    token: string | undefined,
    agentId: string,
    sessionKey: string,
): Promise<Transcript["rows"]> {
    const response = await fetch(
        `${baseUrl}/v1/agents/${agentId}/sessions/${encodeURIComponent(sessionKey)}/messages?limit=200`,
        { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } },
    )
    if (!response.ok) return []
    const body = (await response.json()) as {
        messages?: { role?: string; content?: string; origin?: string }[]
    }
    /**
     * **Reversed, because the page is newest-first and the screen is oldest-first.**
     *
     * `GET …/messages` pages *backwards* on purpose — `store.ts`'s `pageFirst` is `ORDER BY id DESC`
     * and `nextBefore` is the page's oldest id, which is how a chat scrolls up. Rendered in wire
     * order the whole conversation came out upside down, with each assistant reply sitting *above*
     * the question that prompted it, because the reply has the higher rowid. The CLI has always
     * reversed here (`cli/src/lib/source.ts:393`) and said why; this consumer never did, and the
     * wire spec documented no order at all, which is what let the two disagree.
     */
    return [...(body.messages ?? [])]
        .reverse()
        .filter(
            // `origin` is what separates prose from what the runtime authored — an observation, a
            // tool call, a repair, a digest. Under NLT the invocation *is* the content, so without
            // this a resumed conversation shows `ACTION:` blocks as replies. It needs the field to
            // actually be on the wire to do anything; see `MessagePage` in the wire spec.
            (message) =>
                message.origin === undefined &&
                (message.role === "user" || message.role === "assistant") &&
                (message.content ?? "") !== "",
        )
        .map((message, index) => ({
            kind: message.role === "user" ? ("user" as const) : ("reply" as const),
            id: `h${index}`,
            text: message.content ?? "",
        }))
}

/**
 * One sentence for the screen — and **it does not re-append the hint**.
 *
 * `DispachError`'s constructor already embeds it: `super(`${message}\n  hint: ${hint}`)`. Appending
 * `— ${hint}` on top of that rendered every transport failure with the hint printed twice, in one
 * paragraph, which is how the sessions banner came to read `hint: Check the base URL … — Check the
 * base URL …`. `message` is the whole readable error; `detail` is the part before the hint.
 */
function describe(error: unknown): string {
    if (error instanceof DispachError) return error.message
    return error instanceof Error ? error.message : String(error)
}
