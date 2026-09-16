/**
 * The wire protocol, as a `(Request) => Promise<Response>`.
 *
 * A plain function rather than a bound server, and that is the design decision worth defending: a
 * handler can be exercised in full without opening a port, so every route in `04-SPEC-WIRE.md` is
 * tested by constructing a `Request` and asserting on a `Response`. Binding is `serve.ts`'s job and
 * is four lines per runtime. Tests that need a real socket are then only the ones about sockets.
 *
 * **A turn is not bound to the connection that started it.** `POST /messages` runs the turn
 * detached and returns immediately; disconnecting an SSE stream unsubscribes a listener and nothing
 * else. The only thing that ends a turn early is `POST /stop`. This is core to the spec and it is
 * why `TurnStreams` exists — a client that comes back has to be able to find out what it missed.
 */

import {
    type Agent,
    type AnyEvent,
    type ErrorDetail,
    EVENT_TYPES,
    entryPhase,
    HarnessError,
    isPhased,
    nearest,
    newRunId,
    newTurnId,
    phasesFor,
    prepareScheduleWrite,
    type Runtime,
    type ScheduleRecord,
    SENDER_KINDS,
    type SenderKind,
    scheduleSessionKey,
    type TurnRecord,
    type TurnSender,
    VERSION,
} from "@dispach/core"
import { type ApprovalRegistry, createApprovalRegistry } from "./approvals.ts"
import { Router } from "./router.ts"
import { sseResponse } from "./sse.ts"

/** Bodies larger than this are refused before a channel plugin sees them. */
const MAX_BODY_BYTES = 1_000_000

/**
 * Caps on the sender fields and the idempotency key.
 *
 * Small, and each for a stated reason rather than for tidiness. The id is rendered into the
 * prompt's fence label, so an unbounded one spends the window the message needs. The name is
 * rendered inside the fence and is attacker-supplied in exactly the case the fence exists for, so
 * it is truncated rather than refused — a long display name is rude, not an error. The key is a
 * database key with a unique index over it.
 */
const MAX_SENDER_ID = 256
const MAX_SENDER_NAME = 128
const MAX_IDEMPOTENCY_KEY = 255

export interface HandlerOptions {
    readonly runtime: Runtime
    /**
     * Bearer token. Absent means unauthenticated, which `createServer` permits only on loopback.
     *
     * The check is here rather than only at bind time so an embedder mounting this handler behind
     * its own router cannot accidentally expose it — the handler refuses to be built without either
     * a token or an explicit `allowUnauthenticated`.
     */
    readonly token?: string
    /** Required to build a token-less handler. Names the decision rather than defaulting it. */
    readonly allowUnauthenticated?: boolean
    /** Injectable for tests. Defaults to `Date.now`. */
    readonly now?: () => number
    /**
     * In-flight turns this process can cancel, shared with every other surface that starts one.
     *
     * Passed in rather than owned, because the WebSocket bridge starts turns too and kept its own
     * map — so a turn started over HTTP could not be stopped from a socket, and one started over a
     * socket answered 409 on `POST /stop`. Two registries meant the answer to "can this be
     * stopped" depended on which door the question came through, which is not a property of the
     * turn. `serve.ts` creates one and hands it to both.
     *
     * It still does not reach a turn a channel or a schedule started: nothing in core records
     * in-flight turns, so there is no handle to share. The 409 says exactly that.
     */
    readonly running?: Map<string, AbortController>
    /**
     * Where a blocked call's question waits for an answer.
     *
     * Created **before** the runtime, because `Runtime.create({ approve })` needs the registry's
     * approver and a runtime cannot hand back the function it was constructed with. That ordering
     * is why this is passed in rather than owned here, and why the CLI creates it rather than
     * `serve` — the same reason the `running` map is shared, one layer further out.
     *
     * Absent is a coherent state, not a broken one: nothing is ever pending, so every answer gets
     * `approval_not_found` and the routes still exist and still say something true. An agent whose
     * runtime was built without an approver keeps its `confirm_without_approver` warning, which is
     * the honest signal that no question can be asked here.
     */
    readonly approvals?: ApprovalRegistry
}

type Handler = (context: RequestContext) => Promise<Response> | Response

interface RequestContext {
    readonly request: Request
    readonly url: URL
    readonly params: Readonly<Record<string, string>>
}

export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
    const { runtime } = options
    const token = options.token
    const now = options.now ?? (() => Date.now())
    const startedAt = now()

    if (token === undefined && options.allowUnauthenticated !== true) {
        throw new HarnessError({
            code: "server_token_missing",
            message: "createHandler was called with no token and no allowUnauthenticated.",
            hint: "Pass token, or pass allowUnauthenticated: true to state that this handler is mounted somewhere already protected. Defaulting to open would make the safe configuration the one you have to remember.",
        })
    }

    /** In-flight turns, so `POST /stop` has something to cancel. Shared when one is supplied. */
    const running = options.running ?? new Map<string, AbortController>()
    /**
     * Pending approvals. An empty one is correct when nothing wired an approver.
     *
     * Defaulted rather than left optional so the routes have one code path. The alternative was a
     * branch answering `501 no_approver` — which reads as a missing feature when the truth is that
     * this deployment chose not to attach one, and the agent's own `confirm_without_approver`
     * warning already says so where somebody is looking.
     */
    const approvals = options.approvals ?? createApprovalRegistry()

    const router = new Router<Handler>()

    // ─── Health ──────────────────────────────────────────────────────────────────────────

    router.add("GET", "/v1/health", () =>
        json({
            status: "ok",
            version: VERSION,
            uptimeMs: now() - startedAt,
            agents: runtime.list().length,
        }),
    )

    /**
     * Readiness flips at `runtime.ready` — *before* channels connect.
     *
     * Deliberate, and spelled out in the spec: a channel that cannot connect must not make the
     * process look dead to an orchestrator, which would restart it into the same outage. Channel
     * state is on the agent resource instead.
     */
    router.add("GET", "/v1/ready", () => {
        if (runtime.ready) return json({ status: "ready", agents: runtime.list().length })
        // `"starting"`, not `"stopped"`. A runtime that has not reached readiness is on its way up,
        // and "stopped" is what an orchestrator reads as "give up on this container". The
        // `pending: []` this used to carry was a promise nothing filled: agents load inside
        // `Runtime.create`, so there is no moment at which this route can be reached *and* name
        // which agent it is waiting for. An empty array that is always empty says less than
        // omitting it, because a reader cannot tell it from "nothing is pending".
        return json({ status: "starting", agents: runtime.list().length }, 503)
    })

    // ─── Agents ──────────────────────────────────────────────────────────────────────────

    router.add("GET", "/v1/agents", () =>
        json(runtime.list().map((agent) => summary(runtime, agent))),
    )

    router.add("GET", "/v1/agents/:id", (context) =>
        withAgent(runtime, context, async (agent) => {
            // Both of these were the literal `0`, for every agent, whatever was configured — and
            // the spec advertises them as "tool count, skills indexed, schedule count". A number
            // that is always zero is worse than an absent field: it reads as a measurement.
            //
            // The schedule count comes from the **store**, which is the reconciled truth — what is
            // armed right now, including rows the API created and rows a disabled manifest entry
            // left behind. That is deliberately a different number from the one `agent.loaded`
            // reports, which is the manifest's declared count because that event fires before
            // reconciliation has run. Two honest numbers about two different moments; the spec
            // says which is which.
            const schedules = await agent.store.schedules.list(agent.id)
            const team = runtime.team(agent.id)
            return json({
                ...summary(runtime, agent),
                dialect: agent.describe().dialect,
                window: agent.window,
                tools: agent.tools.size,
                skills: agent.skills?.skills.length ?? 0,
                schedules: schedules.length,
                /**
                 * Who this agent delegates to.
                 *
                 * Members are excluded from `GET /v1/agents` and from every route behind
                 * `withAgent`, deliberately: an addressable member is a route around whatever
                 * policy its supervisor carries. This is how they stay *observable* without
                 * becoming reachable — the debugging value of a roster without a way to run one
                 * directly. Absent rather than `[]` for an agent with no team, matching `phases`.
                 */
                ...(team.length === 0
                    ? {}
                    : {
                          team: team.map((member) => ({
                              id: member.id,
                              task: member.task,
                              // What the supervisor gets back, not the whole schema: a UI showing
                              // a delegation needs the field names, and the member's own
                              // `/tools` has the full version.
                              artifact: Object.keys(member.artifact.properties),
                          })),
                      }),
                warnings: [...agent.warnings, ...agent.tools.warnings],
            })
        }),
    )

    /**
     * Reload is refused, and the refusal is the honest answer.
     *
     * The spec describes it as re-reading the manifest and rebuilding the tool index. That
     * contradicts a decision this runtime is built on: the catalogue resolves once and slot 1
     * renders once, so a session's cached prefix stays byte-stable and `config_set` cannot change
     * behaviour underneath a conversation. `/restart` exists in the CLI for exactly this reason.
     * Implementing a partial reload that silently did not apply would be worse than saying no.
     */
    router.add("POST", "/v1/agents/:id/reload", (context) =>
        withAgent(runtime, context, () =>
            fail(
                {
                    code: "reload_not_supported",
                    message: "An agent's configuration is fixed for the lifetime of its process.",
                    hint: "Restart the runtime to pick up a manifest change. The tool catalogue resolves once and the cached prompt prefix depends on it staying fixed, so a live reload would change behaviour mid-conversation. This endpoint is specified in 04-SPEC-WIRE.md and deliberately not implemented.",
                },
                501,
            ),
        ),
    )

    // ─── Turns ───────────────────────────────────────────────────────────────────────────

    router.add("POST", "/v1/agents/:id/messages", async (context) =>
        withAgent(runtime, context, async (agent) => {
            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)

            const input = body.value as {
                text?: unknown
                sessionKey?: unknown
                deliver?: unknown
                stream?: unknown
                chunks?: unknown
                from?: unknown
            }
            // Per-token frames are opt-in, and the *reader* decides — so the query parameter on the
            // stream routes is the primary control and this is the writer's way to ask on the
            // inline-stream path, where there is no second request to carry one. Strict `=== true`,
            // like `stream`: a client sending the string "false" must not be read as asking.
            const wantsChunks = input.chunks === true
            const text = typeof input.text === "string" ? input.text : ""
            if (text.trim() === "") {
                return fail(
                    {
                        code: "message_text_required",
                        message: "The request body has no text.",
                        hint: 'Send { "text": "..." }. An empty turn would be billed for a full prompt and produce nothing.',
                        field: "text",
                    },
                    400,
                )
            }

            const sessionKey =
                typeof input.sessionKey === "string" ? input.sessionKey : "api:default"
            const deliver = parseDeliver(input.deliver)
            if (deliver.kind === "error") return fail(deliver.error, 400)

            const from = parseFrom(input.from)
            if (from.kind === "error") return fail(from.error, 400)

            const idempotency = parseIdempotencyKey(context.request)
            if (idempotency.kind === "error") return fail(idempotency.error, 400)

            const turnId = newTurnId()

            /**
             * The key is claimed **here**, before `agent.send`, and awaited.
             *
             * This handler answers `202` and lets the turn run detached, so the turn row appears
             * some milliseconds later — a claim that waited for the row would leave the window
             * between two retries wide open, and that window is the only thing the feature exists
             * to close. Claiming synchronously makes the second request deterministic rather than
             * a race: it either wins the insert or reads the winner's turn id.
             *
             * A mismatch is a `409` rather than a replay. A client that recycled a key by accident
             * would otherwise be told its second, different message succeeded — the one new failure
             * an idempotency key introduces that not having one does not.
             */
            if (idempotency.key !== undefined) {
                const claim = await agent.store.turns.claimInboundKey({
                    agentId: agent.id,
                    key: idempotency.key,
                    turnId,
                    inputHash: await inputHash(sessionKey, text),
                    now: new Date(),
                })
                if (claim.kind === "replay") {
                    return json({ turnId: claim.turnId, sessionKey, replayed: true }, 200)
                }
                if (claim.kind === "mismatch") {
                    return fail(
                        {
                            code: "idempotency_key_reused",
                            message: `Idempotency-Key "${idempotency.key}" was already used for a different message.`,
                            hint: `It belongs to turn ${claim.turnId}, whose text or session differed from this request's. Nothing was run. Use a fresh key for a new message, or resend the original text byte for byte to get that turn back. A key is remembered for 24 hours.`,
                            field: "Idempotency-Key",
                        },
                        409,
                    )
                }
            }
            const controller = new AbortController()
            running.set(turnId, controller)
            // Before `send`, and **unconditionally** — the condition was the bug.
            //
            // `Agent.send` awaits the session write before emitting anything, so a caller who POSTs
            // without `stream` and then immediately GETs the stream with the turn id it was just
            // handed arrived before `turn.start` and was told "no buffer for this turn in this
            // process" — for a turn that was about to run. Opening here makes that deterministic
            // rather than a race: the buffer exists before this handler's next statement, so it
            // exists before the caller can possibly hold the id.
            //
            // The cost is an empty buffer per turn nobody streams, evicted by the retention policy
            // that already runs on `turn.end`. `attach` still refuses to create one for an unknown
            // id, which is the decision that keeps a typo'd turn id distinguishable from a real one.
            // Chunk interest is declared here, synchronously, because the bus only builds a
            // per-token envelope while somebody is listening — and an SSE `start` callback runs
            // after this handler returns, by which point the first tokens are already gone.
            runtime.streams.open(turnId, { chunks: wantsChunks })

            // Detached on purpose. The response returns before this settles, and nothing about the
            // turn's lifetime depends on the connection that started it.
            const work = agent
                .send(text, {
                    sessionKey,
                    turnId,
                    source: "api",
                    ...(from.from === undefined ? {} : { from: from.from }),
                    signal: controller.signal,
                })
                .then(async (result) => {
                    if (deliver.target === undefined || result.text.trim() === "") return
                    await runtime.channels.deliver({
                        agentId: agent.id,
                        sessionKey,
                        channelId: deliver.target.channel,
                        recipient: deliver.target.to,
                        turnId,
                        text: result.text,
                    })
                })
                .catch(() => {
                    // The turn's own error event already carries the cause, and the turn row records
                    // it. Swallowed here so a detached rejection does not become an unhandled one.
                })
                .finally(() => {
                    running.delete(turnId)
                })
            void work

            if (input.stream !== true) return json({ turnId, sessionKey }, 202)

            // 202 with an SSE body, whose first frame is the same object the non-streaming path
            // returns. That is what "returns 202 … then streams SSE" means without inventing a
            // second response.
            return streamTurn(runtime, turnId, {
                accepted: { turnId, sessionKey },
                status: 202,
                chunks: wantsChunks,
            })
        }),
    )

    /**
     * Attach to a turn. `?chunks=true` — the reader decides, per connection. A reattaching client
     * that wants tokens asks for them here; one watching progress does not have to.
     *
     * **Four states, three answers.** This route used to give one: 200 with a `stream.unavailable`
     * frame, for a turn that finished an hour ago and for a turn id with a typo in it alike — so
     * the only way to tell a mistake from a completed turn was to make a second request. The states
     * are genuinely distinct and each gets what is true of it:
     *
     * | State | Answer |
     * | --- | --- |
     * | A buffer in this process | `200`, replay then tail |
     * | No buffer, turn finished | `200` + `stream.ended` carrying the final status |
     * | No buffer, turn still running | `200` + `stream.unavailable` — running, not observable here |
     * | No turn at all | `404 turn_not_found` |
     *
     * The third row is the one the plan did not anticipate and is not hypothetical: a turn row is
     * written at turn *start*, and one `store.db` is shared by every process under a sandbox root,
     * so `serve` can hold a row for a turn `run` is executing in the next terminal. Answering
     * `stream.ended` there would state that a running turn had finished — and a client would go
     * read a final text that does not exist yet. It is terminal-or-not, `status !== "running"`, so
     * a new `TurnEndReason` cannot be silently misfiled as still-running.
     *
     * The buffer is checked before the store, so the common case costs no query. The window between
     * that check and `attach` is real and benign: eviction can land in it, and `streamTurn`'s own
     * fallback frame covers it.
     */
    router.add(
        "GET",
        "/v1/agents/:id/turns/:turnId/stream",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const turnId = context.params.turnId ?? ""
                if (runtime.streams.state(turnId) === undefined) {
                    const record = await agent.store.turns.get(turnId)
                    if (record === undefined)
                        return notFound(
                            "turn",
                            turnId,
                            "No turn with this id has ever run on this agent. A turn id is the `turnId` from POST /v1/agents/:id/messages — check the agent in the path too, since a turn belongs to one.",
                        )
                    return finishedStream(record)
                }
                return streamTurn(runtime, turnId, {
                    chunks: context.url.searchParams.get("chunks") === "true",
                })
            }),
        { streaming: true },
    )

    router.add("POST", "/v1/agents/:id/turns/:turnId/stop", (context) =>
        withAgent(runtime, context, () => {
            const turnId = context.params.turnId ?? ""
            const controller = running.get(turnId)
            if (controller === undefined) {
                return fail(
                    {
                        code: "turn_not_running",
                        // What is actually true, which is narrower than what this used to claim.
                        // It said "not running in this process" — false of a turn a channel or a
                        // schedule started, which *is* running here and simply left no cancel
                        // handle on this surface. Nothing in core records in-flight turns, so the
                        // handle exists only for turns this API started.
                        message: `No cancel handle for turn ${turnId} on this API.`,
                        hint: "This surface can stop a turn it started. A turn that has already finished cannot be stopped at all — read its final state from GET /v1/agents/:id/turns/:turnId. A turn started by a channel, a schedule, or another process is running without a handle here.",
                    },
                    409,
                )
            }
            controller.abort()
            // Partial content is persisted on explicit stop — this path — and never on disconnect.
            return json({ turnId, stopping: true }, 202)
        }),
    )

    // ─── Approvals ───────────────────────────────────────────────────────────────────────

    /**
     * What is waiting on a person right now.
     *
     * The recovery path, and the reason approvals are usable from a browser at all: a client that
     * missed `approval.requested` — opened after the turn blocked, refreshed, a second operator —
     * otherwise sees a turn that has visibly stopped with no way to discover why. Same argument as
     * turn reattach, which the spec calls core rather than a convenience.
     *
     * Not scoped by agent even though the path names one. The registry is per *process* and a
     * pending approval's turn belongs to whichever agent raised it; filtering here would need the
     * registry to carry an agent id it has no use for otherwise, and `serve` hosts one agent. The
     * path keeps the agent segment so the route reads like its neighbours and so scoping later is
     * additive rather than a URL change.
     */
    router.add("GET", "/v1/agents/:id/approvals", (context) =>
        withAgent(runtime, context, async () => json({ approvals: approvals.pending() })),
    )

    /**
     * Answer one.
     *
     * `granted` is required and must be a real boolean. There is no default, for the reason the
     * whole mechanism exists: a missing field defaulting to `false` would deny a call on a typo,
     * and defaulting to `true` would grant one on a malformed request — so a body this route
     * cannot read is a `400` rather than a decision nobody made.
     *
     * A `404` covers every way an id can fail to be waiting: answered already, abandoned when its
     * turn ended, never existed. They are deliberately one answer — distinguishing them would mean
     * keeping a record of settled approvals, and a client that can ask "was this one denied an hour
     * ago" is a client relying on state this registry says plainly that it does not keep.
     */
    router.add("POST", "/v1/agents/:id/approvals/:approvalId", (context) =>
        withAgent(runtime, context, async () => {
            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            const input = body.value as { granted?: unknown }
            if (typeof input.granted !== "boolean") {
                return fail(
                    {
                        code: "approval_decision_required",
                        message: "The request body has no boolean `granted`.",
                        hint: 'Send { "granted": true } or { "granted": false }. There is no default: one direction would deny a call over a typo and the other would grant one, and neither is a decision anybody made.',
                        field: "granted",
                    },
                    400,
                )
            }

            const approvalId = context.params.approvalId ?? ""
            if (!approvals.resolve(approvalId, input.granted)) {
                return fail(
                    {
                        code: "approval_not_found",
                        message: `No approval with id ${approvalId} is waiting.`,
                        hint: 'It was answered already, or its turn ended while it waited — a stopped or timed-out turn abandons its question, and `approval.resolved` reports that as `by: "abandoned"`. GET /v1/agents/:id/approvals lists what is actually waiting. Nothing about a settled approval is kept, so this is also the answer for an id that was never real.',
                    },
                    404,
                )
            }
            return json({ approvalId, granted: input.granted })
        }),
    )

    // ─── Turns, continued ────────────────────────────────────────────────────────────────

    router.add("GET", "/v1/agents/:id/turns/:turnId", (context) =>
        withAgent(runtime, context, async (agent) => {
            const record = await agent.store.turns.get(context.params.turnId ?? "")
            if (record === undefined) return notFound("turn", context.params.turnId ?? "")
            return json(record)
        }),
    )

    // ─── Sessions ────────────────────────────────────────────────────────────────────────

    router.add("GET", "/v1/agents/:id/sessions", (context) =>
        withAgent(runtime, context, async (agent) =>
            json(await agent.store.sessions.list(agent.id)),
        ),
    )

    router.add("GET", "/v1/agents/:id/sessions/:key", (context) =>
        withAgent(runtime, context, async (agent) => {
            const key = context.params.key ?? ""
            const record = await agent.store.sessions.get(agent.id, key)
            if (record === undefined) return notFound("session", key)
            return json(record)
        }),
    )

    router.add("GET", "/v1/agents/:id/sessions/:key/messages", (context) =>
        withAgent(runtime, context, async (agent) => {
            const before = context.url.searchParams.get("before")
            const limit = context.url.searchParams.get("limit")
            const page = await agent.store.messages.page(agent.id, context.params.key ?? "", {
                ...(before === null ? {} : { before: Number.parseInt(before, 10) }),
                ...(limit === null ? {} : { limit: Number.parseInt(limit, 10) }),
            })
            return json(page)
        }),
    )

    router.add("DELETE", "/v1/agents/:id/sessions/:key", (context) =>
        withAgent(runtime, context, async (agent) => {
            // History only. Memory markdown is a file artifact and is never deleted by an API call.
            await agent.store.sessions.clear(agent.id, context.params.key ?? "")
            return json({ cleared: context.params.key ?? "", memoryFilesKept: true })
        }),
    )

    router.add("POST", "/v1/agents/:id/sessions/:key/phase", (context) =>
        withAgent(runtime, context, async (agent) => {
            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            const phase = (body.value as { phase?: unknown }).phase
            if (typeof phase !== "string" && phase !== null) {
                return fail(
                    {
                        code: "phase_invalid",
                        message: "phase must be a string, or null to clear it.",
                        hint: 'Send { "phase": "triage" }. Phase-scoped tool visibility arrives in Phase 7; the column is written now so a session carries the value across a restart.',
                        field: "phase",
                    },
                    400,
                )
            }
            await agent.store.sessions.setPhase(
                agent.id,
                context.params.key ?? "",
                phase === null ? undefined : phase,
            )
            return json({ phase })
        }),
    )

    // ─── Introspection ───────────────────────────────────────────────────────────────────

    // ── Schedules ────────────────────────────────────────────────────────────────────────
    //
    // Listing includes disabled by default — decision 9.4, and the reason is that hiding a
    // switched-off schedule makes it indistinguishable from one that was never written. `?enabled=`
    // filters when somebody actually wants that.
    router.add("GET", "/v1/agents/:id/schedules", (context) =>
        withAgent(runtime, context, async (agent) => {
            const enabled = context.url.searchParams.get("enabled")
            const rows = await agent.store.schedules.list(
                agent.id,
                enabled === null ? {} : { enabled: enabled === "true" },
            )
            return json({ schedules: rows })
        }),
    )

    router.add("POST", "/v1/agents/:id/schedules", (context) =>
        withAgent(runtime, context, async (agent) => {
            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            return writeSchedule(runtime, agent, body.value, undefined)
        }),
    )

    router.add("GET", "/v1/agents/:id/schedules/:sid", (context) =>
        withAgent(runtime, context, async (agent) => {
            const sid = context.params.sid ?? ""
            const row = await agent.store.schedules.get(agent.id, sid)
            return row === undefined ? notFound("schedule", sid) : json(row)
        }),
    )

    router.add("PATCH", "/v1/agents/:id/schedules/:sid", (context) =>
        withAgent(runtime, context, async (agent) => {
            const sid = context.params.sid ?? ""
            const existing = await agent.store.schedules.get(agent.id, sid)
            if (existing === undefined) return notFound("schedule", sid)

            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            const patch =
                body.value === null || typeof body.value !== "object" || Array.isArray(body.value)
                    ? {}
                    : (body.value as Record<string, unknown>)

            // The whole schedule is revalidated, never the patch alone: a change to `expr` can make
            // a previously-fine `timezone` unsatisfiable, and validating a fragment cannot see that.
            const { id: _ignoredId, ...fields } = patch
            const merged: Record<string, unknown> = {
                kind: existing.kind,
                expr: existing.expr,
                task: existing.task,
                deliver:
                    existing.deliverChannel === undefined || existing.deliverTo === undefined
                        ? "none"
                        : { channel: existing.deliverChannel, to: existing.deliverTo },
                session: existing.sessionMode,
                enabled: existing.enabled,
                ...(existing.timezone === undefined ? {} : { timezone: existing.timezone }),
                ...(existing.role === undefined ? {} : { role: existing.role }),
                ...fields,
                // The id is the row's identity and the key reconciliation matches on, so a patch
                // that renamed it would create a second schedule and orphan the first. Dropped from
                // the incoming fields above rather than overwritten after them, which TypeScript
                // rejects as a duplicate key — and rightly: two spellings of the same intent in one
                // literal is how the wrong one eventually wins.
                id: existing.id,
            }
            return writeSchedule(runtime, agent, merged, existing)
        }),
    )

    router.add("DELETE", "/v1/agents/:id/schedules/:sid", (context) =>
        withAgent(runtime, context, async (agent) => {
            const sid = context.params.sid ?? ""
            const removed = await agent.store.schedules.remove(agent.id, sid)
            if (!removed) return notFound("schedule", sid)
            runtime.scheduler.changed()
            return json({ removed: sid })
        }),
    )

    // Out of band: fires now, and does **not** move the schedule's own next run. Someone testing a
    // schedule at 15:00 must not find that its 08:00 slot has moved.
    router.add("POST", "/v1/agents/:id/schedules/:sid/run", (context) =>
        withAgent(runtime, context, async (agent) => {
            const sid = context.params.sid ?? ""
            const row = await agent.store.schedules.get(agent.id, sid)
            if (row === undefined) return notFound("schedule", sid)

            const runId = newRunId()
            const sessionKey = scheduleSessionKey(row.sessionMode, row.id, runId)
            const turnId = newTurnId()
            // This route mints a turn id and hands it back at 202, so it owes the same buffer the
            // message route does — and did not open one at all, which made `GET …/stream` on a
            // manually fired schedule answer "no buffer" for a turn that was running.
            //
            // The invariant, worth stating because there are exactly three places that mint an id
            // and give it to a caller: **whoever hands out a turn id opens its buffer first.**
            runtime.streams.open(turnId)
            // Detached, like every other turn on this surface: the client gets a handle and reads
            // the stream, and a disconnect never cancels the work.
            void agent
                .send(row.task, {
                    sessionKey,
                    turnId,
                    source: `schedule:${row.id}:manual`,
                    ...(row.role === undefined ? {} : { role: row.role }),
                })
                .catch(() => {
                    // Reported on the bus by the turn itself; swallowed here so an unhandled
                    // rejection cannot take the server down.
                })
            return json({ scheduleId: row.id, turnId, sessionKey, outOfBand: true }, 202)
        }),
    )

    router.add("GET", "/v1/agents/:id/tools", (context) =>
        withAgent(runtime, context, (agent) => {
            // `tags` and phase visibility are both in the spec's own description of this route and
            // neither was here. `tags` is the vocabulary `phases.*.allow` matches as `tag:<name>`,
            // so without it a reader cannot tell why a tool is in a phase it did not name.
            //
            // `phases` is **omitted** rather than `[]` on an unphased agent. An empty array reads
            // as "visible in no phase", which is the opposite of the truth — an unphased agent
            // shows every tool always — and `isPhased` is the same one-line question the runtime
            // asks before registering `phase_set` at all.
            const phases = agent.manifest.phases
            const phased = isPhased(phases)
            return json(
                agent.tools.specs().map((spec) => ({
                    slug: spec.slug,
                    summary: spec.summary,
                    mutating: spec.mutating,
                    trust: spec.trust,
                    provider: spec.provider ?? "local",
                    tags: spec.tags,
                    ...(phased ? { phases: phasesFor(phases, spec) } : {}),
                })),
            )
        }),
    )

    /**
     * The agent's indexed skills.
     *
     * This answered `{ skills: [], supported: false }` — correct when it was written and false
     * from the moment Phase 5 shipped, which was several phases before this line was read again.
     * `supported` becomes **`configured`**, and the distinction it draws is the one that still
     * matters: an agent with no `skills:` block and an agent whose skills directory is empty are
     * different states, and an empty array alone cannot tell them apart. What is gone is the third
     * reading it used to carry — "this build cannot do skills" — which is no longer a thing.
     *
     * The spec also promised a "last-selected time" per skill. Nothing tracks it: selection
     * happens per turn in the harness and is written nowhere, so the field would need a store
     * column. The spec drops the promise rather than this route faking it with a null.
     */
    router.add("GET", "/v1/agents/:id/skills", (context) =>
        withAgent(runtime, context, (agent) => {
            const catalogue = agent.skills
            if (catalogue === undefined) return json({ skills: [], configured: false })
            return json({
                configured: true,
                maxActive: catalogue.maxActive,
                threshold: catalogue.threshold,
                // Whether every entry came off the cache, which is what the boot criterion
                // measures — and the difference between a cold scan and a warm one is seconds.
                cached: catalogue.cached,
                skills: catalogue.skills.map((skill) => ({
                    name: skill.name,
                    description: skill.frontmatter.description,
                    tokens: skill.tokens,
                    // Selection is BM25 over the description, so there is no keyword list to
                    // report here — that is knowledge's gate, not skills'. `whenNotToUse` is
                    // reported because it is the half of a skill's guidance that has no other
                    // surface, and absent is a valid and warned-about state rather than an error.
                    ...(skill.frontmatter.whenNotToUse === undefined
                        ? {}
                        : { whenNotToUse: skill.frontmatter.whenNotToUse }),
                    // Runnable entries in `scripts/`, exposed as tools only while the skill is
                    // active. Named rather than counted: a skill's scripts are the part an
                    // operator has to have approved.
                    scripts: skill.scripts.map((plan) => plan.slug),
                })),
            })
        }),
    )

    router.add("GET", "/v1/agents/:id/context", (context) =>
        withAgent(runtime, context, async (agent) => {
            const sessionKey = context.url.searchParams.get("sessionKey")
            const input = context.url.searchParams.get("input")
            return json(
                await agent.previewContext({
                    ...(sessionKey === null ? {} : { sessionKey }),
                    ...(input === null ? {} : { input }),
                }),
            )
        }),
    )

    // ─── Channel webhooks ────────────────────────────────────────────────────────────────

    /**
     * Unauthenticated by design: the provider does not carry our bearer token.
     *
     * Verification is the transport's, because only it knows what its provider signs. Core caps the
     * body and routes by id. `handleWebhook` answers 404 for both an unknown agent and an unknown
     * channel, so probing this path cannot enumerate the runtime.
     */
    router.add("POST", "/v1/channels/:channelId/webhook/:agentId", async (context) => {
        const body = await readJson(context.request)
        if (body.kind === "error") return fail(body.error, 400)

        const headers: Record<string, string> = {}
        context.request.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value
        })

        const outcome = await runtime.channels.handleWebhook(
            context.params.agentId ?? "",
            context.params.channelId ?? "",
            { body: body.value, headers },
        )
        return new Response(outcome.detail ?? "", {
            status: outcome.status,
            headers: { "content-type": "text/plain; charset=utf-8" },
        })
    })

    // ─── Event stream ────────────────────────────────────────────────────────────────────

    /**
     * The firehose. Every event the runtime emits, optionally narrowed by agent and by type.
     *
     * This is a **wildcard** subscriber, which after the per-subscriber chunk opt-in means it
     * receives no `model.chunk` unless it asks — and that turned `?types=model.chunk` into a
     * request that streamed nothing, forever, with no error. Rule 8 wearing a query string.
     *
     * So naming `model.chunk` in `types` *is* the opt-in, alongside the explicit `?chunks=true`.
     * Asking for a type is asking for it, and refusing the obvious spelling of the request would
     * be an error nobody learns anything from. What keeps an implication honest is that it is
     * reported rather than assumed: the `stream.subscribed` preamble states the filter and the
     * resolved chunk decision, so a reader sees what it got instead of inferring it from silence.
     * `implied` names *why* it is on, which is the difference between a resolved state and a
     * surprising one.
     */
    router.add(
        "GET",
        "/v1/events",
        (context) => {
            const agentId = context.url.searchParams.get("agentId")
            const types = context.url.searchParams.get("types")?.split(",").filter(Boolean)
            const asked = context.url.searchParams.get("chunks") === "true"
            const implied = types?.includes("model.chunk") === true
            const chunks = asked || implied

            // **An unknown type is refused rather than filtered.** This accepted any string at
            // all, so `?types=turn.ended` — the plural nobody can keep straight — opened a stream
            // that matched nothing and stayed open forever: no error, no frames, and a client with
            // every reason to believe the runtime was idle. Rule 8 with a query parameter in front
            // of it, and unfixable until `EVENT_TYPES` existed, because `EventDataMap` is a *type*
            // and nothing at runtime could enumerate it.
            const unknown = types?.filter(
                (type) => !(EVENT_TYPES as readonly string[]).includes(type),
            )
            if (unknown !== undefined && unknown.length > 0) {
                const suggestion = nearest(unknown[0] ?? "", EVENT_TYPES)
                return fail(
                    {
                        code: "unknown_event_type",
                        message: `No such event type: ${unknown.join(", ")}.`,
                        hint:
                            suggestion === undefined
                                ? "The full catalogue is the event table in docs/04-SPEC-WIRE.md. Omit ?types= to receive every event."
                                : `Did you mean "${suggestion}"? The full catalogue is the event table in docs/04-SPEC-WIRE.md.`,
                        field: "types",
                    },
                    400,
                )
            }

            return sseResponse({
                ...(context.request.signal === undefined ? {} : { signal: context.request.signal }),
                start: ({ send }) => {
                    send({
                        event: "stream.subscribed",
                        data: {
                            agentId: agentId ?? null,
                            types: types ?? null,
                            chunks,
                            ...(chunks && !asked ? { implied: "types names model.chunk" } : {}),
                        },
                    })
                    return runtime.bus.on(
                        "*",
                        (event) => {
                            if (agentId !== null && event.agentId !== agentId) return
                            if (
                                types !== undefined &&
                                types.length > 0 &&
                                !types.includes(event.type)
                            )
                                return
                            send({ event: event.type, data: event })
                        },
                        { chunks },
                    )
                },
            })
        },
        { streaming: true },
    )

    // ─── Dispatch ────────────────────────────────────────────────────────────────────────

    return async (request: Request): Promise<Response> => {
        let url: URL
        try {
            url = new URL(request.url)
        } catch {
            return fail(
                {
                    code: "bad_request_url",
                    message: "The request URL could not be parsed.",
                    hint: "This usually means the server was handed a relative URL. A handler mounted inside another framework needs an absolute request.url.",
                },
                400,
            )
        }

        /**
         * `HEAD` and `OPTIONS`, answered from the route table at dispatch.
         *
         * At dispatch and not per route, because `Allow` is only correct if it is derived: a route
         * added next week would otherwise accept `GET` and advertise nothing, and the header
         * nobody looks at is the one that goes stale silently. `router.match` already computes the
         * method set for a path — a request whose method matches no route comes back as
         * `kind: "method"` carrying every method that path does accept, which is exactly the
         * `Allow` value.
         */
        const method = request.method.toUpperCase()

        if (method === "OPTIONS") {
            const paths = router.match("OPTIONS", url.pathname)
            if (paths.kind === "method") {
                // `HEAD` is advertised wherever `GET` is answered, and only there — see below for
                // the streams, where it is not.
                const head = router.match("HEAD", url.pathname)
                const streams = head.kind === "method" && streamingAt(router, url.pathname)
                const allow = [
                    ...paths.allowed,
                    ...(paths.allowed.includes("GET") && !streams ? ["HEAD"] : []),
                    "OPTIONS",
                ]
                return new Response(null, {
                    status: 204,
                    headers: { allow: allow.join(", ") },
                })
            }
            // Falls through to the 404 below. An OPTIONS for a path that does not exist is a 404,
            // not a 204 listing nothing — the second reads as "this path exists and accepts
            // nothing", which is a different and wrong statement.
        }

        if (method === "HEAD") {
            const get = router.match("GET", url.pathname)
            if (get.kind === "found") {
                /**
                 * **A stream refuses `HEAD`, and that is deliberate rather than an oversight.**
                 *
                 * Answering it as `GET` would run the handler, which subscribes to the bus or
                 * attaches to a turn buffer — and then discard the body. Nothing ever reads that
                 * stream, so its `cancel()` never fires and the subscription is never torn down:
                 * one leaked listener per probe, and a leaked buffer listener pins its buffer
                 * against eviction (decision 11.158, found the hard way one stage ago). A
                 * monitoring system polling `HEAD /v1/events` every thirty seconds would walk the
                 * process into the ground while every endpoint kept answering correctly.
                 *
                 * So: 405 naming the reason, rather than a leak or a lie about the body.
                 */
                if (get.streaming) {
                    return fail(
                        {
                            code: "method_not_allowed",
                            message: `HEAD is not allowed on ${url.pathname}.`,
                            hint: "This path answers with an open event stream. A HEAD would have to start one and then throw the body away, leaving a subscription nothing ever closes — so it is refused rather than leaked. Use GET, or GET /v1/health to check the server is up.",
                        },
                        405,
                        { allow: "GET, OPTIONS" },
                    )
                }

                if (!isOpenPath(url.pathname) && token !== undefined) {
                    const unauthorized = checkToken(request, token)
                    if (unauthorized !== undefined) return unauthorized
                }

                // The headers GET would return, with no body. The handler really runs — that is
                // what makes the status and the content-type true rather than guessed.
                const response = await runHandler(get.handler, {
                    request,
                    url,
                    params: get.params,
                })
                return new Response(null, { status: response.status, headers: response.headers })
            }
        }

        const match = router.match(method, url.pathname)
        if (match.kind === "method") {
            return fail(
                {
                    code: "method_not_allowed",
                    message: `${method} is not allowed on ${url.pathname}.`,
                    hint: `This path accepts ${match.allowed.join(", ")}.`,
                },
                405,
                { allow: match.allowed.join(", ") },
            )
        }
        if (match.kind === "none") {
            return fail(
                {
                    code: "not_found",
                    message: `No route for ${request.method} ${url.pathname}.`,
                    hint: "Every path is under /v1. See docs/04-SPEC-WIRE.md for the surface.",
                },
                404,
            )
        }

        if (!isOpenPath(url.pathname) && token !== undefined) {
            const unauthorized = checkToken(request, token)
            if (unauthorized !== undefined) return unauthorized
        }

        return await runHandler(match.handler, { request, url, params: match.params })
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * One write path for POST and PATCH.
 *
 * The validation itself is core's `prepareScheduleWrite`, so the API and the manifest reconciler
 * accept and refuse exactly the same things — a check only one of two writers performs is a check
 * they disagree about.
 */
async function writeSchedule(
    runtime: Runtime,
    agent: Agent,
    body: unknown,
    existing: ScheduleRecord | undefined,
): Promise<Response> {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return fail(
            {
                code: "schedule_invalid",
                message: "A schedule must be a JSON object.",
                hint: "Send { id, kind, expr, task, deliver } — see docs/02-SPEC-MANIFEST.md.",
            },
            400,
        )
    }

    try {
        const row = prepareScheduleWrite({
            agentId: agent.id,
            body: body as Record<string, unknown>,
            channelIds: agent.manifest.channels.map((channel) => channel.id),
            roleNames: Object.keys(agent.manifest.model),
            now: Date.now(),
            // Never `manifest`: a row written here must survive a reload, and marking it as the
            // manifest's would let the next reconciliation delete something no file describes.
            origin: "api",
            ...(existing === undefined ? {} : { existing }),
        })
        const saved = await agent.store.schedules.upsert(row)
        // The timer is armed to the nearest due time, so a new schedule sooner than that would
        // otherwise wait out the current horizon before being noticed.
        runtime.scheduler.changed()
        return json(saved, existing === undefined ? 201 : 200)
    } catch (error) {
        const detail =
            error instanceof HarnessError
                ? error.toDetail()
                : {
                      code: "schedule_invalid",
                      message: error instanceof Error ? error.message : String(error),
                      hint: "See docs/02-SPEC-MANIFEST.md for the schedule fields.",
                  }
        return fail(detail, 400)
    }
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    })
}

/** Every error goes out in the one envelope the spec fixes. */
function fail(
    error: ErrorDetail,
    status: number,
    extraHeaders: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    })
}

/**
 * Paths reachable without the token.
 *
 * The probes and the webhook, all for the same reason: the caller cannot hold our token, and a
 * load balancer probing with a bearer header it does not have would mark a healthy process
 * unhealthy.
 *
 * **`/v1/ready` belongs here and was missing**, which made the container story not work: a
 * published port needs a non-loopback bind, a non-loopback bind requires a token, and the
 * readiness probe then got 401 forever. An orchestrator's readiness probe is precisely the caller
 * this exemption describes — and `/v1/ready` discloses strictly *less* than `/v1/health`, which
 * was already open: a status and an agent count, without the version. Found by writing the
 * Dockerfile's HEALTHCHECK, not by reading this list.
 *
 * A function rather than an expression inside the dispatcher because `HEAD` has to ask the same
 * question, and two copies of an auth exemption is how one of them gains an entry the other does
 * not.
 */
function isOpenPath(pathname: string): boolean {
    return (
        pathname === "/v1/health" ||
        pathname === "/v1/ready" ||
        pathname.startsWith("/v1/channels/")
    )
}

/** Whether the `GET` route at this path answers with an open stream. */
function streamingAt(router: Router<Handler>, pathname: string): boolean {
    const get = router.match("GET", pathname)
    return get.kind === "found" && get.streaming
}

/** Run a matched handler, turning a throw into a response. Shared with the `HEAD` path. */
async function runHandler(handler: Handler, context: RequestContext): Promise<Response> {
    try {
        return await handler(context)
    } catch (error) {
        if (error instanceof HarnessError) return fail(error.toDetail(), 400)
        return fail(
            {
                code: "internal_error",
                message: error instanceof Error ? error.message : String(error),
                hint: "An unexpected failure in the server. The runtime's event stream carries what happened around it.",
            },
            500,
        )
    }
}

/**
 * `hint` is overridable because the generic sentence talks about session keys, and it became the
 * answer to a common client mistake the moment attaching to an unknown turn started returning 404
 * — advice about channel segments is noise on a turn id, and noise in a hint is what teaches people
 * to stop reading them.
 */
function notFound(kind: string, id: string, hint?: string): Response {
    return fail(
        {
            code: `${kind}_not_found`,
            message: `No ${kind} "${id}".`,
            hint:
                hint ??
                // No indefinite article: `A ${kind}` printed "A agent id is case-sensitive" on the
                // most common 404 this server returns, which is the kind of blemish that only ever
                // shows up in real output and makes the rest of the sentence read as unproofed.
                `Check the id — it is case-sensitive, and a session key includes its channel segment.`,
        },
        404,
    )
}

/**
 * Compared in constant time, and the failure never says which part was wrong.
 *
 * A message distinguishing "no token" from "wrong token" tells an attacker their request shape is
 * right, which is the more useful half of the answer.
 */
function checkToken(request: Request, expected: string): Response | undefined {
    const header = request.headers.get("authorization") ?? ""
    const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
    if (timingSafeEqual(presented, expected)) return undefined
    return fail(
        {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
            hint: "Send Authorization: Bearer <token>, where the token is the value of the variable named by server.tokenEnv.",
        },
        401,
    )
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

function withAgent(
    runtime: Runtime,
    context: RequestContext,
    work: (agent: Agent) => Promise<Response> | Response,
): Promise<Response> | Response {
    const id = context.params.id ?? ""
    const agent = runtime.list().find((candidate) => candidate.id === id)
    if (agent === undefined) return notFound("agent", id)
    return work(agent)
}

/**
 * The shared shape of an agent in the listing and at the head of its detail.
 *
 * **There is no current phase here, and the field is named to say so.** It was `phase: null` for
 * every agent — the spec's own listing promises `phase` — and filling that in with the phase the
 * agent is "in" would be decision 5.19's failure on an HTTP surface: a phase is per *session*, and
 * an agent hosting three conversations is in three phases at once. The agent-level facts are the
 * phase a new session **starts** in and the names that exist, so those are what it reports, under
 * a name a reader cannot mistake for the other thing.
 *
 * `phases` is present only when the manifest declares more than one, matching the question the
 * runtime itself asks before registering `phase_set`. An unphased agent has no entry phase to
 * name, so `entryPhase` is `null` there rather than inventing a name for the single implicit one.
 */
function summary(runtime: Runtime, agent: Agent) {
    const phases = agent.manifest.phases
    const phased = isPhased(phases)
    return {
        id: agent.id,
        name: agent.manifest.name ?? agent.id,
        status: "loaded",
        model: agent.manifest.model.main.id,
        channels: runtime.channels.statusOf(agent.id),
        entryPhase: phased ? (entryPhase(phases) ?? null) : null,
        ...(phased ? { phases: Object.keys(phases) } : {}),
    }
}

async function readJson(
    request: Request,
): Promise<{ kind: "ok"; value: unknown } | { kind: "error"; error: ErrorDetail }> {
    // Checked before reading, so a declared 500 MB body is refused rather than buffered. A body
    // with no content-length is still bounded by the read below.
    const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return {
            kind: "error",
            error: {
                code: "body_too_large",
                message: `The request body declares ${declared} bytes; the limit is ${MAX_BODY_BYTES}.`,
                hint: "This cap is enforced before a channel plugin sees anything, so a plugin never has to defend against a large POST.",
            },
        }
    }

    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) {
        return {
            kind: "error",
            error: {
                code: "body_too_large",
                message: `The request body is ${raw.length} bytes; the limit is ${MAX_BODY_BYTES}.`,
                hint: "Send less. A message longer than this is not a message.",
            },
        }
    }
    if (raw === "") return { kind: "ok", value: {} }

    try {
        return { kind: "ok", value: JSON.parse(raw) }
    } catch (cause) {
        return {
            kind: "error",
            error: {
                code: "body_not_json",
                message: `The request body is not valid JSON: ${
                    cause instanceof Error ? cause.message : String(cause)
                }`,
                hint: "Send application/json. A shell quoting mistake is the usual cause — check for unescaped quotes inside the payload.",
            },
        }
    }
}

/** `"none"` | a channel id | `{ channel, to }`. Absent means none. */
/**
 * The `from` field on `POST /messages`.
 *
 * Validated strictly rather than coerced, and the strictness is the point on this one field: `kind`
 * decides whether the turn is gated, so an unrecognised value must **refuse** rather than fall to a
 * default. Both defaults are wrong — `"user"` silently un-gates a peer message somebody tried to
 * declare, and `"agent"` gates an operator's own turn for a typo — so there is no default at all.
 *
 * The id is capped because it is carried onto a row, an event and a fence label, and a megabyte of
 * "identity" in a prompt is a cheap way to push everything else out of the window.
 */
function parseFrom(
    value: unknown,
): { kind: "ok"; from: TurnSender | undefined } | { kind: "error"; error: ErrorDetail } {
    if (value === undefined || value === null) return { kind: "ok", from: undefined }

    const invalid = (
        message: string,
        hint: string,
        field = "from",
    ): { kind: "error"; error: ErrorDetail } => ({
        kind: "error",
        error: { code: "sender_invalid", message, hint, field },
    })

    if (typeof value !== "object") {
        return invalid(
            "from must be an object.",
            'Send { "from": { "id": "agent:ops-bot", "kind": "agent" } }, or omit it entirely for a turn the token-holder is sending itself.',
        )
    }

    const raw = value as { id?: unknown; name?: unknown; kind?: unknown }
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
        return invalid(
            "from.id is required and must be a non-empty string.",
            "Use a stable identity in your own namespace — `agent:ops-bot`, `user:018f…`, an email address. It is opaque to this runtime and is recorded on the turn so an audit can answer who asked.",
            "from.id",
        )
    }
    if (raw.id.length > MAX_SENDER_ID) {
        return invalid(
            `from.id is ${raw.id.length} characters, over the ${MAX_SENDER_ID} limit.`,
            "A sender id is an identifier, not a payload. It is rendered into the prompt's fence label, so an unbounded one spends the context window the message needs.",
            "from.id",
        )
    }
    if (typeof raw.kind !== "string" || !(SENDER_KINDS as readonly string[]).includes(raw.kind)) {
        const suggestion =
            typeof raw.kind === "string" ? nearest(raw.kind, SENDER_KINDS) : undefined
        return invalid(
            `from.kind must be one of: ${SENDER_KINDS.join(", ")}.`,
            `${suggestion === undefined ? "" : `Did you mean "${suggestion}"? `}This field decides the trust boundary — "agent" fences the message and blocks mutating tools for the turn, "user" does not — so there is no default and an unknown value is refused rather than guessed at. A turn the token-holder is sending itself omits "from".`,
            "from.kind",
        )
    }
    if (raw.name !== undefined && typeof raw.name !== "string") {
        return invalid(
            "from.name must be a string when present.",
            "It is a display name only and is rendered inside the fence, never above it. Omit it if you have none.",
            "from.name",
        )
    }

    return {
        kind: "ok",
        from: {
            id: raw.id,
            kind: raw.kind as SenderKind,
            ...(raw.name === undefined ? {} : { name: raw.name.slice(0, MAX_SENDER_NAME) }),
        },
    }
}

/**
 * The `Idempotency-Key` header.
 *
 * A **header** rather than a body field, because it is a fact about the request rather than about
 * the message — the same reason it is a header everywhere else this convention appears — and
 * because that makes it uniform for any later POST without each one growing its own field.
 *
 * Refused when present and unusable rather than ignored. A client that sends a malformed key
 * believes its retries are safe; silently dropping it is the one outcome that leaves them wrong
 * about exactly the guarantee they asked for.
 */
function parseIdempotencyKey(
    request: Request,
): { kind: "ok"; key: string | undefined } | { kind: "error"; error: ErrorDetail } {
    const raw = request.headers.get("idempotency-key")
    if (raw === null) return { kind: "ok", key: undefined }
    const key = raw.trim()
    const bad = (message: string): { kind: "error"; error: ErrorDetail } => ({
        kind: "error",
        error: {
            code: "idempotency_key_invalid",
            message,
            hint: `Send 1-${MAX_IDEMPOTENCY_KEY} printable ASCII characters that are unique per logical request — a UUID is the usual choice. Omit the header entirely to accept that a retry runs the turn again. Printable ASCII because the key is a database key, and node:sqlite truncates a bound string at a NUL byte where bun:sqlite stores it whole.`,
            field: "Idempotency-Key",
        },
    })
    if (key === "") return bad("Idempotency-Key is present but empty.")
    if (key.length > MAX_IDEMPOTENCY_KEY) {
        return bad(
            `Idempotency-Key is ${key.length} characters, over the ${MAX_IDEMPOTENCY_KEY} limit.`,
        )
    }
    if (!/^[\x20-\x7e]+$/.test(key)) {
        return bad("Idempotency-Key contains characters that are not printable ASCII.")
    }
    return { kind: "ok", key }
}

/**
 * What the key is matched against, so a reused key with different text can be refused.
 *
 * SHA-256 of the session key and the text together: the *same* text in two different sessions is
 * two different logical requests, and treating them as one replay would silently drop the second
 * conversation's message. Hashed rather than stored so the table does not hold a second copy of
 * every message for a day.
 */
async function inputHash(sessionKey: string, text: string): Promise<string> {
    const bytes = new TextEncoder().encode(`${sessionKey}\u0000${text}`)
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
}

function parseDeliver(
    value: unknown,
):
    | { kind: "ok"; target: { channel: string; to: string } | undefined }
    | { kind: "error"; error: ErrorDetail } {
    if (value === undefined || value === null || value === "none") {
        return { kind: "ok", target: undefined }
    }
    if (typeof value === "object") {
        const target = value as { channel?: unknown; to?: unknown }
        if (typeof target.channel === "string" && typeof target.to === "string") {
            return { kind: "ok", target: { channel: target.channel, to: target.to } }
        }
    }
    return {
        kind: "error",
        error: {
            code: "deliver_invalid",
            message: 'deliver must be "none" or { channel, to }.',
            hint: 'A bare channel id is not enough on an API turn: the request has no originating conversation, so there is no recipient to infer. Send { "channel": "tg", "to": "12345" }, or "none" to read the reply from the event stream.',
            field: "deliver",
        },
    }
}

/**
 * A turn with no buffer, answered from its stored row rather than from memory.
 *
 * One frame and a close, so a client written as "open the stream and loop over it" needs no special
 * case — it sees a terminal frame and the loop ends, exactly as it would for a turn it watched to
 * completion. The alternative was a 404 for an evicted turn, which is wrong in the direction that
 * matters: the turn happened, the answer exists, and the client is one GET away from it.
 *
 * `stream.ended` for a finished turn; `stream.unavailable` for one still running somewhere this
 * process cannot see. Both carry the row's own `status`, never a status this function decided.
 */
function finishedStream(record: TurnRecord): Response {
    const running = record.status === "running"
    return sseResponse({
        start: ({ send, close }) => {
            send({
                event: running ? "stream.unavailable" : "stream.ended",
                data: {
                    turnId: record.turnId,
                    status: record.status,
                    sessionKey: record.sessionKey,
                    ...(running
                        ? {
                              reason: "no buffer for this turn in this process",
                              hint: "The turn is recorded as running but is not observable here — its events are buffered in whichever process is executing it, and buffers are in-memory and per-process. Poll GET /v1/agents/:id/turns/:turnId for the outcome.",
                          }
                        : {
                              steps: record.steps,
                              ...(record.errorCode === undefined
                                  ? {}
                                  : { errorCode: record.errorCode }),
                              hint: "This turn finished before you attached and its buffer has been evicted. Its full text is in GET /v1/agents/:id/turns/:turnId.",
                          }),
                },
            })
            close()
            return undefined
        },
    })
}

/**
 * Attach to a turn: replay what it has emitted, then tail.
 *
 * `TurnStreams.attach` does both in one synchronous block — a snapshot and a subscription with no
 * `await` between them — which is what makes the handover gapless *and* duplicate-free. Neither
 * failure shows up attaching to an idle turn; both show up under load.
 */
function streamTurn(
    runtime: Runtime,
    turnId: string,
    extra?: { accepted?: unknown; status?: number; chunks?: boolean },
): Response {
    return sseResponse({
        ...(extra?.status === undefined ? {} : { status: extra.status }),
        start: ({ send, close }) => {
            if (extra?.accepted !== undefined)
                send({ event: "turn.accepted", data: extra.accepted })

            // Interest is per *attachment*, so two clients can watch one turn with only one of
            // them paying for tokens — and a client that did not ask never receives them even
            // while another does. That per-listener filter is not a nicety: chunk interest taken
            // by `open` outlives its turn by the retention window, so without it a later
            // non-asking client was served tokens from the buffer's fan-out.
            const attachment = runtime.streams.attach(
                turnId,
                (event: AnyEvent) => {
                    send({ event: event.type, data: event })
                    if (event.type === "turn.end") close()
                },
                { chunks: extra?.chunks === true },
            )

            if (attachment === undefined) {
                // Never buffered here, or ended and evicted. Either way there is nothing to tail;
                // the final state is in the store and the client is told where to look.
                send({
                    event: "stream.unavailable",
                    data: {
                        turnId,
                        reason: "no buffer for this turn in this process",
                        hint: "Read the final state from GET /v1/agents/:id/turns/:turnId. Buffers are in-memory and are evicted after a turn ends.",
                    },
                })
                close()
                return undefined
            }

            // **Before** the replay frames, not after. A client reconstructing text has to learn
            // that a hole exists before it starts concatenating, or it silently builds a shorter
            // reply and believes it. The cap discards the *oldest* events, so the hole is at the
            // front — which is precisely where a client is not looking.
            //
            // One frame carries all three honesty facts rather than three frame types: how much
            // was dropped, whether token history is complete, and what state the turn is in.
            send({
                event: "stream.replay",
                data: {
                    turnId,
                    state: attachment.state,
                    events: attachment.replay.length,
                    truncated: attachment.truncated,
                    dropped: attachment.dropped,
                    chunks: attachment.chunks,
                    ...(attachment.truncated
                        ? {
                              hint: `The oldest ${attachment.dropped} event(s) of this turn were discarded to stay under the buffer cap, so this replay starts mid-turn. The turn's final text is complete in GET /v1/agents/:id/turns/:turnId.`,
                          }
                        : {}),
                },
            })

            for (const event of attachment.replay) {
                send({ event: event.type, data: event })
            }
            if (attachment.state === "ended") close()

            return () => attachment.unsubscribe()
        },
    })
}
