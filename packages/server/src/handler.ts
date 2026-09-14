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
    HarnessError,
    newRunId,
    newTurnId,
    prepareScheduleWrite,
    type Runtime,
    type ScheduleRecord,
    scheduleSessionKey,
    VERSION,
} from "@dispach/core"
import { Router } from "./router.ts"
import { sseResponse } from "./sse.ts"

/** Bodies larger than this are refused before a channel plugin sees them. */
const MAX_BODY_BYTES = 1_000_000

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

    /** In-flight turns, so `POST /stop` has something to cancel. */
    const running = new Map<string, AbortController>()

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
        return json({ status: "stopped", pending: [] }, 503)
    })

    // ─── Agents ──────────────────────────────────────────────────────────────────────────

    router.add("GET", "/v1/agents", () =>
        json(runtime.list().map((agent) => summary(runtime, agent))),
    )

    router.add("GET", "/v1/agents/:id", (context) =>
        withAgent(runtime, context, (agent) =>
            json({
                ...summary(runtime, agent),
                dialect: agent.describe().dialect,
                window: agent.window,
                tools: agent.tools.size,
                skills: 0,
                schedules: 0,
                warnings: [...agent.warnings, ...agent.tools.warnings],
            }),
        ),
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

            const turnId = newTurnId()
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
                .send(text, { sessionKey, turnId, source: "api", signal: controller.signal })
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

    router.add("GET", "/v1/agents/:id/turns/:turnId/stream", (context) =>
        // `?chunks=true` — the reader decides, per connection. A reattaching client that wants
        // tokens asks for them here; one watching progress does not have to.
        withAgent(runtime, context, () =>
            streamTurn(runtime, context.params.turnId ?? "", {
                chunks: context.url.searchParams.get("chunks") === "true",
            }),
        ),
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
        withAgent(runtime, context, (agent) =>
            json(
                agent.tools.specs().map((spec) => ({
                    slug: spec.slug,
                    summary: spec.summary,
                    mutating: spec.mutating,
                    trust: spec.trust,
                    provider: spec.provider ?? "local",
                })),
            ),
        ),
    )

    /**
     * Skills are Phase 5. The empty list is accompanied by `supported: false`.
     *
     * An empty array on its own is the silent-nothing shape rule 8 exists to prevent: a client
     * cannot tell "this agent has no skills" from "this build has no skills".
     */
    router.add("GET", "/v1/agents/:id/skills", (context) =>
        withAgent(runtime, context, () => json({ skills: [], supported: false })),
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

    router.add("GET", "/v1/events", (context) => {
        const agentId = context.url.searchParams.get("agentId")
        const types = context.url.searchParams.get("types")?.split(",").filter(Boolean)

        return sseResponse({
            ...(context.request.signal === undefined ? {} : { signal: context.request.signal }),
            start: ({ send }) =>
                runtime.bus.on("*", (event) => {
                    if (agentId !== null && event.agentId !== agentId) return
                    if (types !== undefined && types.length > 0 && !types.includes(event.type))
                        return
                    send({ event: event.type, data: event })
                }),
        })
    })

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

        const match = router.match(request.method, url.pathname)
        if (match.kind === "method") {
            return fail(
                {
                    code: "method_not_allowed",
                    message: `${request.method} is not allowed on ${url.pathname}.`,
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

        // The probes and the webhook are the exceptions, and all for the same reason: the caller
        // cannot hold our token. A load balancer probing with a bearer header it does not have
        // would mark a healthy process unhealthy.
        //
        // **`/v1/ready` belongs here and was missing**, which made the container story not work: a
        // published port needs a non-loopback bind, a non-loopback bind requires a token, and the
        // readiness probe then got 401 forever. An orchestrator's readiness probe is precisely the
        // caller this exemption describes — and `/v1/ready` discloses strictly *less* than
        // `/v1/health`, which was already open: a status and an agent count, without the version.
        // Found by writing the Dockerfile's HEALTHCHECK, not by reading this line.
        const open =
            url.pathname === "/v1/health" ||
            url.pathname === "/v1/ready" ||
            url.pathname.startsWith("/v1/channels/")
        if (!open && token !== undefined) {
            const unauthorized = checkToken(request, token)
            if (unauthorized !== undefined) return unauthorized
        }

        try {
            return await match.handler({ request, url, params: match.params })
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

function notFound(kind: string, id: string): Response {
    return fail(
        {
            code: `${kind}_not_found`,
            message: `No ${kind} "${id}".`,
            hint: `Check the id. A ${kind} id is case-sensitive and, for a session key, includes its channel segment.`,
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

function summary(runtime: Runtime, agent: Agent) {
    return {
        id: agent.id,
        name: agent.manifest.name ?? agent.id,
        status: "loaded",
        model: agent.manifest.model.main.id,
        channels: runtime.channels.statusOf(agent.id),
        phase: null,
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
