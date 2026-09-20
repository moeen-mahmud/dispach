/**
 * The OpenAPI document, **generated** — never written down.
 *
 * ## Why this is safe to have, when a hand-written one would not be
 *
 * `09-API-GUIDE.md` records the argument against a generated reference: *"a third description of a
 * surface that already has two… would drift from both and look the most authoritative."* That
 * lands squarely on a hand-maintained `openapi.yaml`, which would be a **fourth** list of routes in
 * a repo that has paid for `NO_MANIFEST`, `DOCUMENTED_CTRL_LETTERS`, `THRESHOLD_ORDER` and two spec
 * tables. It does not land on a derived one.
 *
 * Both halves come from something that already exists and is already checked:
 *
 * - **Paths and methods** from `Router.routes()`, whose own docstring says a hand-kept copy "is
 *   right when it is written and wrong at the next addition". `OPTIONS`, the `Allow` header and the
 *   spec guard already derive from that table; this is the fourth consumer, not a new list.
 * - **Bodies** from the Zod schemas in `wire-schemas.ts`, via `z.toJSONSchema` — which also carries
 *   each field's `code` and `hint`, so the reference documents the *refusal* rather than only the
 *   happy path.
 *
 * What is left hand-written is one line of prose per route — a summary. That cannot drift silently,
 * because `spec.test.ts` fails when a registered route has none.
 *
 * ## What it deliberately omits
 *
 * **The browser surface.** `/`, `/assets/app.js` and `/assets/app.css` are a served *page*, not an
 * API, and listing them would invite a client to treat the UI's asset paths as a contract. Excluded
 * by prefix rather than by name, so a fourth asset does not need remembering.
 *
 * **Response bodies, mostly.** Every route's success shape is `@dispach/client`'s job — those types
 * are the reference and `tsc` checks them, which is decision 11.10's discipline applied one package
 * over. What this document gives a response is its status codes and the error shape, which is the
 * part a client cannot get from the types.
 */

import { VERSION } from "@dispach/core"
import { z } from "zod"
import {
    ApprovalBody,
    KeyBody,
    MessageBody,
    PhaseBody,
    ProvisionBody,
    StopBody,
} from "./wire-schemas.ts"

/** One line per route, plus its body when it reads one. The only hand-written half. */
interface RouteDoc {
    readonly summary: string
    readonly body?: z.ZodObject
    /** Statuses worth naming beyond the 2xx and the shared 401/404. */
    readonly statuses?: readonly { readonly code: number; readonly when: string }[]
    /** Query parameters, named because a path pattern cannot carry them. */
    readonly query?: readonly { readonly name: string; readonly about: string }[]
}

/**
 * Keyed `METHOD path`, matching `Router.routes()` exactly.
 *
 * A missing entry is a **failing test**, not a blank page: `spec.test.ts` walks the router and
 * demands one. That is what keeps this honest without making it a second route list — it cannot
 * contain a route that does not exist (nothing would read it) and it cannot omit one that does.
 */
const DOCS: Readonly<Record<string, RouteDoc>> = {
    "GET /v1/health": { summary: "Liveness, the version, and how many agents are hosted." },
    "GET /v1/ready": {
        summary: "Whether a turn can be served yet.",
        statuses: [{ code: 503, when: "still starting; channels may still be connecting" }],
    },
    "GET /v1/agents": {
        summary: "Every agent this server knows about, hosted or switched off.",
    },
    "GET /v1/agents/:id": { summary: "One agent, with its dialect, window, counts and warnings." },
    "POST /v1/agents/:id/reload": {
        summary: "Re-read the manifest by replacing the agent with a new instance.",
        statuses: [
            { code: 409, when: "a turn is running — it is not aborted to apply a change" },
            { code: 400, when: "a team member, which has no manifest of its own" },
        ],
    },
    "GET /v1/provision": {
        summary: "The questions creating an agent asks, and whether this server can answer them.",
    },
    "POST /v1/agents": {
        summary: "Create an agent and adopt it into this host, live.",
        body: ProvisionBody,
        statuses: [
            { code: 201, when: "created; `adopted` is empty with an `error` if it is not running" },
            { code: 403, when: "not a loopback bind" },
            { code: 501, when: "this server has no provisioner" },
        ],
    },
    "POST /v1/agents/:id/stop": {
        summary: "Switch an agent off durably and drop it from this host now.",
        body: StopBody,
        statuses: [{ code: 409, when: "a turn is running" }],
    },
    "POST /v1/agents/:id/start": {
        summary: "Switch it back on and have this host adopt it.",
        statuses: [{ code: 501, when: "this server cannot look up manifests" }],
    },
    "POST /v1/agents/:id/messages": {
        summary: "Start a turn. Returns once accepted; the turn runs detached.",
        body: MessageBody,
        statuses: [{ code: 202, when: "accepted" }],
    },
    "POST /v1/agents/:id/turns/:turnId/stop": {
        summary: "Cooperatively stop a turn this API started.",
        statuses: [{ code: 409, when: "no cancel handle — a channel or schedule started it" }],
    },
    /**
     * The two SSE routes, which a generated document can only describe so far.
     *
     * OpenAPI has no vocabulary for an event stream's *frames*, so the summary says what the stream
     * is and `04-SPEC-WIRE.md` remains the place the event table lives — where it is checked
     * against `EVENT_TYPES` by a compile-time assertion, which is a stronger guarantee than any
     * prose here could be.
     */
    "GET /v1/agents/:id/turns/:turnId/stream": {
        summary: "One turn's events as SSE, replayed from the start and then live.",
        query: [
            { name: "chunks", about: "Include per-token frames. Off by default." },
            { name: "types", about: "Narrow to these event types, comma-separated." },
        ],
        statuses: [{ code: 200, when: "an event stream; see the event table in the wire spec" }],
    },
    "GET /v1/events": {
        summary: "Every event this process emits, as SSE. The firehose.",
        query: [
            { name: "agentId", about: "Narrow to one agent." },
            { name: "sessionKey", about: "Narrow to one conversation." },
            { name: "chunks", about: "Include per-token frames. Off by default." },
            { name: "types", about: "Narrow to these event types, comma-separated." },
        ],
        statuses: [{ code: 200, when: "an event stream; see the event table in the wire spec" }],
    },
    "GET /v1/agents/:id/approvals": { summary: "Questions waiting on a person, oldest first." },
    "POST /v1/agents/:id/approvals/:approvalId": {
        summary: "Answer one blocked tool call.",
        body: ApprovalBody,
    },
    "POST /v1/keys": {
        summary: "Mint an operator key. The secret is returned once and never again.",
        body: KeyBody,
        statuses: [{ code: 201, when: "minted" }],
    },
    "GET /v1/keys": { summary: "Every key, live and revoked. Never a secret." },
    "DELETE /v1/keys/:keyId": { summary: "Revoke a key. A soft delete; the row survives." },
    "GET /v1/agents/:id/turns/:turnId": { summary: "One turn's stored row." },
    "GET /v1/agents/:id/sessions": { summary: "Conversations, most recently active first." },
    "GET /v1/agents/:id/sessions/:key": { summary: "One conversation's summary." },
    "GET /v1/agents/:id/sessions/:key/messages": {
        summary: "A page of a conversation's messages.",
        query: [
            { name: "limit", about: "How many to return." },
            { name: "before", about: "Page backwards from this message id." },
        ],
    },
    "DELETE /v1/agents/:id/sessions/:key": {
        summary: "Drop a conversation's history, turns and derived index.",
    },
    "POST /v1/agents/:id/sessions/:key/phase": {
        summary: "Move a session into a declared phase.",
        body: PhaseBody,
    },
    "GET /v1/agents/:id/schedules": { summary: "Every schedule, from the store." },
    "POST /v1/agents/:id/schedules": {
        summary: "Create a schedule. Validated by the manifest's own schedule rules.",
        statuses: [{ code: 201, when: "created" }],
    },
    "GET /v1/agents/:id/schedules/:sid": { summary: "One schedule's row." },
    "PATCH /v1/agents/:id/schedules/:sid": { summary: "Replace a schedule the API created." },
    "DELETE /v1/agents/:id/schedules/:sid": { summary: "Delete a schedule the API created." },
    "POST /v1/agents/:id/schedules/:sid/run": { summary: "Fire a schedule now, out of band." },
    "GET /v1/agents/:id/tools": { summary: "The resolved catalogue, with trust and phases." },
    "GET /v1/agents/:id/skills": { summary: "What the skills index holds." },
    "GET /v1/agents/:id/context": {
        summary: "The prompt the next turn would be given, without running one.",
        query: [
            { name: "sessionKey", about: "Which conversation to assemble for." },
            { name: "input", about: "Pretend this is the next message." },
        ],
    },
    "POST /v1/channels/:channelId/webhook/:agentId": {
        summary: "A channel provider's webhook. Open by design; the provider authenticates itself.",
    },
    "GET /v1/openapi.json": { summary: "This document." },
    "GET /docs": { summary: "A browser reference over this document." },
}

/** Paths that are the browser surface rather than the API. See the module comment. */
function isApiPath(pattern: string): boolean {
    return pattern.startsWith("/v1/") || pattern === "/docs"
}

export interface RouteRef {
    readonly method: string
    readonly pattern: string
}

/** A route that exists and has no summary. Read by `spec.test.ts`, which fails on a non-empty list. */
export function undocumentedRoutes(routes: readonly RouteRef[]): readonly string[] {
    return routes
        .filter((route) => isApiPath(route.pattern))
        .map((route) => `${route.method} ${route.pattern}`)
        .filter((key) => DOCS[key] === undefined)
        .sort()
}

/** A summary for a route nothing registers — the other direction, and just as much a defect. */
export function phantomRoutes(routes: readonly RouteRef[]): readonly string[] {
    const real = new Set(routes.map((route) => `${route.method} ${route.pattern}`))
    return Object.keys(DOCS)
        .filter((key) => !real.has(key))
        .sort()
}

/**
 * Build the document.
 *
 * `:id` becomes `{id}` because OpenAPI spells a path parameter differently from this router — the
 * one translation in here, and the reason it is a function rather than a constant.
 */
export function openapiDocument(input: {
    readonly routes: readonly RouteRef[]
    readonly serverUrl?: string
}): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {}

    for (const route of input.routes) {
        if (!isApiPath(route.pattern)) continue
        const doc = DOCS[`${route.method} ${route.pattern}`]
        if (doc === undefined) continue

        const openapiPath = route.pattern.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
        const params = [...route.pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
            name: match[1],
            in: "path",
            required: true,
            schema: { type: "string" },
        }))
        const query = (doc.query ?? []).map((entry) => ({
            name: entry.name,
            in: "query",
            required: false,
            description: entry.about,
            schema: { type: "string" },
        }))

        const responses: Record<string, unknown> = {}
        for (const status of doc.statuses ?? []) {
            responses[String(status.code)] = { description: status.when }
        }
        // Named once here rather than per route: every authenticated route answers these the same
        // way, and repeating them 30 times is the copy that comes to disagree.
        if (responses["200"] === undefined && responses["201"] === undefined) {
            if (responses["202"] === undefined) responses["200"] = { description: "OK" }
        }
        responses["401"] = { description: "No credential, or one this server does not accept." }
        if (route.pattern.includes(":id")) {
            responses["404"] = { description: "No such agent, or it is switched off." }
        }

        paths[openapiPath] ??= {}
        const operation: Record<string, unknown> = {
            summary: doc.summary,
            ...(params.length + query.length === 0 ? {} : { parameters: [...params, ...query] }),
            responses,
        }
        if (doc.body !== undefined) {
            operation.requestBody = {
                required: true,
                content: {
                    "application/json": {
                        // `io: "input"` matters: a schema with defaults describes a *different*
                        // shape going in than coming out, and this document is about requests.
                        schema: z.toJSONSchema(doc.body, {
                            target: "draft-2020-12",
                            io: "input",
                        }),
                    },
                },
            }
        }
        paths[openapiPath][route.method.toLowerCase()] = operation
    }

    return {
        openapi: "3.1.0",
        info: {
            title: "Dispach agent server",
            version: VERSION,
            description:
                "Generated from the router table and the request schemas — see openapi.ts. The binding contract is docs/04-SPEC-WIRE.md, which is checked against the code; @dispach/client's types are the response reference.",
        },
        ...(input.serverUrl === undefined ? {} : { servers: [{ url: input.serverUrl }] }),
        components: {
            securitySchemes: {
                bearer: {
                    type: "http",
                    scheme: "bearer",
                    description: "An operator key or the configured token.",
                },
            },
            schemas: {
                Error: {
                    type: "object",
                    description:
                        "Every failure has this shape. `hint` is never absent — it is the part that says what to do.",
                    properties: {
                        error: {
                            type: "object",
                            required: ["code", "message", "hint"],
                            properties: {
                                code: { type: "string" },
                                message: { type: "string" },
                                hint: { type: "string" },
                                field: { type: "string" },
                            },
                        },
                    },
                },
            },
        },
        security: [{ bearer: [] }],
        paths,
    }
}
