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
    AssigneeBody,
    ConversationBody,
    ConversationMessageBody,
    DecisionBody,
    DeliveryBody,
    ImportBody,
    KeyBody,
    MembersBody,
    MessageBody,
    NoteBody,
    ParticipantBody,
    PhaseBody,
    PresenceBody,
    ProjectBody,
    ProvisionBody,
    RecallBody,
    SecretsBody,
    SpaceWriterBody,
    StopBody,
    ToolsRefreshBody,
    VarsBody,
    WebhookBody,
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
    "GET /v1/activity": {
        summary:
            "Whether the process is idle, and when it must next be woken. For an external waker.",
        statuses: [{ code: 403, when: "the key is scoped to agents or sessions" }],
    },
    "GET /v1/agents": {
        summary: "Every agent this server knows about, hosted or switched off.",
    },
    "GET /v1/agents/:id": { summary: "One agent, with its dialect, window, counts and warnings." },
    "GET /v1/backup": {
        summary:
            "The silo as a tar.gz: a consistent store snapshot and every hosted agent's directory, with a backup.json manifest. No .env or .git unless asked for. An admin key with no agents scope.",
        query: [
            {
                name: "include",
                about: "Any of env, git, home, comma-separated: each agent's .env (its secrets), its .git directories, and the rest of the state directory under home/.",
            },
        ],
        statuses: [
            {
                code: 400,
                when: "include names something other than env, git or home, or home on a server with no state directory",
            },
            { code: 403, when: "the key is scoped to some agents" },
        ],
    },
    "GET /v1/agents/:id/export": {
        summary:
            "A slice of the agent as a JSON bundle: its carried memory file, memory archive and knowledge. Never the manifest, secrets or skills.",
    },
    "POST /v1/agents/:id/import": {
        summary:
            "Merge a bundle into the agent: memory note by note, knowledge kept or overwritten. Reloads when the carried file or knowledge changed, and restores everything if that reload refuses.",
        body: ImportBody,
        statuses: [
            {
                code: 400,
                when: "a path a bundle cannot carry, or a bundle the agent would not load",
            },
        ],
    },
    "PATCH /v1/agents/:id/vars": {
        summary:
            "Apply changed template variables: re-render the files nobody edited since they were rendered, then reload.",
        body: VarsBody,
        statuses: [
            {
                code: 202,
                when: "files changed and a turn is running: the reload lands when it ends",
            },
            {
                code: 400,
                when: "a secret or undeclared variable, or a result the agent would not load (every file is put back)",
            },
            { code: 409, when: "the agent was not made from a template on 0.2.0-pilot.5 or later" },
            { code: 501, when: "this server has no templates" },
        ],
    },
    "POST /v1/agents/:id/tools/refresh": {
        summary:
            "Fetch the tool providers' catalogues and schemas now, and reload the agent only if what it serves changed.",
        body: ToolsRefreshBody,
        statuses: [
            {
                code: 202,
                when: "something changed and a turn is running: the reload lands when it ends",
            },
            {
                code: 400,
                when: "a provider the agent does not have, or a reload the agent refuses",
            },
        ],
    },
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
        summary:
            "Create an agent, from answers or from a template, and adopt it into this host, live.",
        body: ProvisionBody,
        statuses: [
            { code: 201, when: "created; `adopted` is empty with an `error` if it is not running" },
            { code: 403, when: "not a loopback bind" },
            { code: 501, when: "this server has no provisioner" },
        ],
    },
    "POST /v1/webhooks": {
        summary: "Subscribe a URL to event types. The signing secret is returned once.",
        body: WebhookBody,
        statuses: [
            { code: 201, when: "created; `secret` is in this response and no other" },
            {
                code: 400,
                when: "a refused URL, an undeliverable type, or agents outside this key's reach",
            },
        ],
    },
    "POST /v1/participants": {
        summary: "Register a human participant under the embedder's own id. No account is stored.",
        body: ParticipantBody,
        statuses: [{ code: 201, when: "registered, or updated if the id existed" }],
    },
    "GET /v1/participants": { summary: "The registered human participants." },
    "DELETE /v1/participants/:participantId": {
        summary: "Remove a participant and their conversation memberships.",
    },
    "POST /v1/conversations": {
        summary: "Create a room or a DM among participants and agents (agent:<id>).",
        body: ConversationBody,
        statuses: [
            { code: 201, when: "created" },
            { code: 403, when: "a participant-bound key creating a conversation it is not in" },
        ],
    },
    "GET /v1/conversations": { summary: "The conversations this credential can see." },
    "GET /v1/conversations/:conversationId": { summary: "One conversation and its members." },
    "PATCH /v1/conversations/:conversationId/members": {
        summary: "Add or remove members of a room.",
        body: MembersBody,
    },
    "POST /v1/conversations/:conversationId/messages": {
        summary:
            "Post a human member's message. In a room only the mentioned agents answer; in a DM the agent always does. Their replies arrive as conversation.message.",
        body: ConversationMessageBody,
        statuses: [
            { code: 202, when: "logged; the turns it starts run behind the response" },
            { code: 403, when: "a participant-bound key naming another author" },
        ],
    },
    "GET /v1/conversations/:conversationId/messages": {
        summary: "The conversation's log, oldest first, after a sequence number.",
    },
    "PUT /v1/participants/:participantId/presence": {
        summary:
            "Push whether a person is there. In a DM between two people, an offline person's agent stands in for them.",
        body: PresenceBody,
        statuses: [{ code: 403, when: "a participant-bound key setting someone else's presence" }],
    },
    "POST /v1/memory/notes": {
        summary:
            "Add a note to a shared memory scope — the space, a person's owner scope, or a project. Agents recall it when a turn is about it.",
        body: NoteBody,
        statuses: [
            { code: 403, when: "this participant may not write that scope" },
            { code: 404, when: "the scope's owner or project does not exist" },
        ],
    },
    "GET /v1/memory/notes": {
        summary:
            "Every note in one shared scope, oldest first. An owner scope is readable by its owner.",
    },
    "DELETE /v1/memory/notes/:noteId": {
        summary: "Remove a note. Whoever may write its scope may remove it.",
    },
    "GET /v1/participants/:participantId/memory/reads": {
        summary:
            "The person's audit: every time an agent recalled their owner scope for somebody else, stand-ins included.",
    },
    "GET /v1/projects": { summary: "Projects, each with the agents that share its memory." },
    "PUT /v1/projects/:projectId": {
        summary: "Define a project, or replace which agents share its memory. An admin's act.",
        body: ProjectBody,
    },
    "DELETE /v1/projects/:projectId": {
        summary: "Remove a project and its notes.",
    },
    "PUT /v1/memory/space/writer": {
        summary:
            "Name the one non-admin who may write the space. An agent named here saves its memory_write to the space.",
        body: SpaceWriterBody,
    },
    "GET /v1/actions": {
        summary:
            "Mutating calls stand-ins queued for their owners. A member-bound key sees its own.",
    },
    "POST /v1/actions/:actionId": {
        summary:
            "Approve or decline a queued action. Approved, the exact call runs as the owner's agent and the outcome is posted in the DM.",
        body: DecisionBody,
        statuses: [
            { code: 404, when: "no such action, or not this key's to decide" },
            { code: 409, when: "already decided" },
        ],
    },
    "PUT /v1/agents/:id/assignee": {
        summary: "Record which member an agent works for. An admin participant's act.",
        body: AssigneeBody,
    },
    "GET /v1/agents/:id/assignee": {
        summary:
            "Who the agent is assigned to, as `{id, assignment}`; `assignment` is null when nobody.",
    },
    "DELETE /v1/agents/:id/assignee": { summary: "Clear an agent's assignment." },
    "GET /v1/webhooks": {
        summary:
            "The subscriptions this credential can see, with their delivery health. Never a secret.",
    },
    "DELETE /v1/webhooks/:webhookId": {
        summary: "Delete a subscription and anything it still owed.",
        statuses: [{ code: 404, when: "no such subscription, or one outside this key's reach" }],
    },
    "GET /v1/usage": {
        summary:
            "What every agent in scope cost, per model call, grouped by agent, model, day or sender.",
        statuses: [{ code: 400, when: "an unknown grouping or a date that does not parse" }],
    },
    "GET /v1/agents/:id/usage": {
        summary: "What this agent cost, from the meter.",
        statuses: [{ code: 400, when: "an unknown grouping or a date that does not parse" }],
    },
    "GET /v1/agents/:id/turns": {
        summary:
            "Every turn this agent has taken, newest first, across sessions, paged by `before`.",
        statuses: [{ code: 400, when: "`limit` or `before` is not a positive whole number" }],
    },
    "GET /v1/templates": {
        summary: "The templates an agent can be created from, and the variables each declares.",
    },
    "GET /v1/agents/:id/secrets": {
        summary:
            "Which variables the agent's manifest reads, and whether each is set. Never a value.",
        statuses: [{ code: 501, when: "this server has no credential writer" }],
    },
    "PUT /v1/agents/:id/secrets": {
        summary: "Write the agent's credentials into its .env and apply them: reload or adopt.",
        body: SecretsBody,
        statuses: [
            { code: 200, when: "written; `applied` says whether the agent is running on them" },
            { code: 400, when: "a variable the manifest does not read, or an empty value" },
            { code: 501, when: "this server has no credential writer" },
        ],
    },
    "DELETE /v1/agents/:id": {
        summary:
            "Delete an agent for good: off this host, its rows out of the store, its directory off disk. Needs ?confirm=<id>.",
        statuses: [
            { code: 400, when: "no ?confirm=<id>" },
            { code: 409, when: "two sandbox directories declare this id" },
            { code: 501, when: "this server cannot delete agents" },
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
        statuses: [
            { code: 202, when: "accepted" },
            {
                code: 429,
                when: "over limits.maxConcurrentTurns or limits.tokens; nothing recorded",
            },
        ],
    },
    "POST /v1/agents/:id/deliveries": {
        summary:
            "Send exact text on one of the agent's channels, with no turn. It joins that conversation's history as the agent's.",
        body: DeliveryBody,
        statuses: [
            { code: 202, when: "queued, or already queued under this key" },
            { code: 404, when: "the agent has no running channel with that id" },
        ],
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
    "POST /v1/agents/:id/sessions/:key/recall": {
        summary: "Keep a conversation out of history recall, or put it back; its messages stay.",
        body: RecallBody,
    },
    "GET /v1/agents/:id/config": {
        summary: "Every manifest field this surface may set, what it does, and its current value.",
    },
    "PATCH /v1/agents/:id/config": {
        summary: "Set one manifest field, then replace the agent so it takes effect.",
        statuses: [
            { code: 409, when: "the field carries a confirm sentence and `confirm` was not true" },
            { code: 409, when: "the agent came from an object, so there is no manifest to edit" },
            { code: 400, when: "the path is not settable here, or the result would not validate" },
        ],
    },
    "PATCH /v1/agents/:id/channels/:channelId": {
        summary: "Connect or disconnect a channel, and set its credential.",
        statuses: [
            {
                code: 400,
                when: "neither `enabled` nor `credential` was sent, or the channel is unknown",
            },
            { code: 409, when: "the agent came from an object, so there is no manifest to edit" },
            { code: 501, when: "the host supplied no channel actions" },
        ],
    },
    "POST /v1/agents/:id/channels/:channelId/unpair": {
        summary: "Forget a channel's stored pairing, so the next start offers a new code.",
        statuses: [
            { code: 404, when: "this agent has no such channel" },
            { code: 409, when: "the channel stores no pairing — a typed credential is a PATCH" },
        ],
    },
    "GET /v1/agents/:id/schedules": { summary: "Every schedule, from the store." },
    "POST /v1/agents/:id/schedules": {
        summary: "Create a schedule. Validated by the manifest's own schedule rules.",
        statuses: [{ code: 201, when: "created" }],
    },
    "GET /v1/agents/:id/schedules/:sid": { summary: "One schedule's row." },
    "PATCH /v1/agents/:id/schedules/:sid": {
        summary: "Replace a schedule the API created.",
        statuses: [
            { code: 409, when: "the manifest declares it, so reconciliation would undo the write" },
        ],
    },
    "DELETE /v1/agents/:id/schedules/:sid": {
        summary: "Delete a schedule the API created.",
        statuses: [
            { code: 409, when: "the manifest declares it, so the next boot would re-create it" },
        ],
    },
    "POST /v1/agents/:id/schedules/:sid/run": {
        summary: "Fire a schedule now, out of band.",
        statuses: [{ code: 429, when: "over a governor limit; nothing recorded" }],
    },
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
