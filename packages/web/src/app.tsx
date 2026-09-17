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

import type { AgentClient, DispachClient, PendingApproval, SessionSummary } from "@dispach/client"
import { DispachError } from "@dispach/client"
import { useCallback, useEffect, useRef, useState } from "react"
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
import { EMPTY, emptyFor, reduce, type Transcript, withUser } from "./lib/transcript.ts"

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

type Panel = { readonly kind: "chat" } | { readonly kind: "keys" }

function Workspace(props: {
    readonly baseUrl: string
    readonly token: string | undefined
}): React.ReactElement {
    const clientRef = useRef<DispachClient>(makeClient(props.baseUrl, props.token))
    const [agentId, setAgentId] = useState<string>()
    const [agentName, setAgentName] = useState<string>()
    const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
    const [sessionKey, setSessionKey] = useState<string>()
    const [panel, setPanel] = useState<Panel>({ kind: "chat" })
    const [state, setState] = useState<Transcript>(EMPTY)
    const [draft, setDraft] = useState("")
    const [error, setError] = useState<string>()
    const stopRef = useRef<(() => Promise<void>) | undefined>(undefined)

    // Which agent, and its name for the title. `serve` takes one manifest, so the first is the one
    // — but the list is read rather than assumed, because `runtime.list()` is what every route
    // resolves through and a member of a team is deliberately absent from it.
    useEffect(() => {
        clientRef.current
            .agents()
            .then((agents) => {
                const first = agents[0]
                if (first === undefined) return
                setAgentId(first.id)
                setAgentName(first.name)
                // The dialect decides whether the token stream needs filtering, and it is known
                // once and never changes for an agent —  is config, never auto-detected.
                setState((previous) => ({ ...previous, filter: emptyFor(first.dialect).filter }))
                document.title = `${first.name} · Dispach`
            })
            .catch((caught: unknown) => setError(describe(caught)))
    }, [])

    const agent: AgentClient | undefined =
        agentId === undefined ? undefined : clientRef.current.agent(agentId)

    const refreshSessions = useCallback(async () => {
        if (agent === undefined) return
        try {
            setSessions(await agent.sessions())
        } catch (caught) {
            setError(describe(caught))
        }
    }, [agent])

    useEffect(() => {
        void refreshSessions()
    }, [refreshSessions])

    /** Follow one turn to its end, folding every frame into the transcript. */
    const follow = useCallback(
        async (turnId: string, forAgent: AgentClient) => {
            const handle = forAgent.turn(turnId)
            stopRef.current = () => handle.stop()
            try {
                sessionStorage.setItem(LIVE_TURN, turnId)
                for await (const item of handle.stream({ chunks: true })) {
                    setState((previous) => reduce(previous, item))
                }
            } catch (caught) {
                setError(describe(caught))
                setState((previous) => ({ ...previous, running: false }))
            } finally {
                sessionStorage.removeItem(LIVE_TURN)
                stopRef.current = undefined
                void refreshSessions()
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
    }, [agent, follow])

    /** Any question already waiting, for a page that opened after the turn blocked. */
    const [pending, setPending] = useState<readonly PendingApproval[]>([])
    useEffect(() => {
        if (agent === undefined) return
        let live = true
        const tick = () => {
            agent
                .approvals()
                .then((list) => {
                    if (live) setPending(list)
                })
                .catch(() => {
                    /* a failed poll is not worth a banner; the next one will say so */
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
    }, [agent])

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
        setPanel({ kind: "chat" })
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

    return (
        <div className="shell">
            <aside className="side">
                <header>
                    <div className="brand">Dispach</div>
                    <div style={{ fontSize: 12, color: "var(--dim)" }}>{agentName ?? "…"}</div>
                </header>
                <nav>
                    <div className="group">Conversation</div>
                    <button
                        type="button"
                        className="row-button"
                        aria-current={panel.kind === "chat" && sessionKey === undefined}
                        onClick={() => void openSession(undefined)}
                    >
                        + new
                    </button>
                    {sessions.map((session) => (
                        <button
                            type="button"
                            key={session.sessionKey}
                            className="row-button"
                            aria-current={
                                panel.kind === "chat" && sessionKey === session.sessionKey
                            }
                            onClick={() => void openSession(session.sessionKey)}
                        >
                            {session.sessionKey}
                        </button>
                    ))}
                    <div className="group">Server</div>
                    <button
                        type="button"
                        className="row-button"
                        aria-current={panel.kind === "keys"}
                        onClick={() => setPanel({ kind: "keys" })}
                    >
                        keys
                    </button>
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
                    <strong>{panel.kind === "keys" ? "Operator keys" : (agentName ?? "")}</strong>
                    {panel.kind === "chat" ? <span>{sessionKey ?? "new conversation"}</span> : null}
                    <span className="spacer" />
                    {pending.length > 0 ? (
                        <span style={{ color: "var(--warn)" }}>
                            {pending.length} waiting on you
                        </span>
                    ) : null}
                </div>

                {panel.kind === "keys" ? (
                    <div className="scroll">
                        <div className="pad">
                            <Keys
                                client={clientRef.current}
                                baseUrl={props.baseUrl}
                                token={props.token}
                            />
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
    return (body.messages ?? [])
        .filter(
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

function describe(error: unknown): string {
    if (error instanceof DispachError)
        return error.hint === "" ? error.message : `${error.message} — ${error.hint}`
    return error instanceof Error ? error.message : String(error)
}
