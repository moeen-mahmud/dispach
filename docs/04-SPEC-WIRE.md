# 04 — Wire Protocol

The HTTP surface exposed by `@dispach/server`. Deliberately boring: HTTP + JSON for
control, SSE for streaming, WebSocket only where genuinely bidirectional. **`curl` must be
sufficient to drive everything.**

This is Dispach's *own* protocol. The OpenClaw-compatible surface VelaOps currently
speaks is a separate adapter documented in `06-VELAOPS-INTEGRATION.md`, and it is not part
of this spec.

---

## Conventions

- Base path `/v1`. The version changes only on a breaking change.
- `Authorization: Bearer <token>`, from `server.tokenEnv`. Loopback binds may omit it;
  a non-loopback host without a token refuses to start.
- All bodies JSON. All timestamps RFC 3339 UTC.
- Errors:

```json
{ "error": { "code": "unknown_tool", "message": "...", "hint": "...", "field": "tools.pinned[2]" } }
```

`code` is stable and machine-readable. `hint` names the likely fix. Every error type in
`errors.ts` populates it.

### Error codes

`code` is the part a client branches on, so it is the part that must not move. Every code the HTTP
and WebSocket surfaces can return:

| Code | Status | Means |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or invalid token. Never distinguishes which, and never says the token was absent rather than wrong. |
| `origin_not_allowed` | 403 | A browser sent an `Origin` this server does not answer to. Checked **before** authentication, because `POST /v1/channels/…` needs no credential and changes state. An absent `Origin` is allowed — a curl, a webhook and a healthcheck all send none. Port is not compared: a published port mapping and a dev proxy both change it legitimately. |
| `host_not_allowed` | 403 | A request reached a **loopback** bind addressed to a name that is not a loopback name. That is what a DNS-rebinding attack cannot hide, since the browser sends the name it resolved — so this is the check that closes the hole. Widen it with `server.allowedHosts`; ignored on a public bind, where the legitimate names are the operator's to know. |
| `not_found` | 404 | No route for this method and path. |
| `agent_not_found` | 404 | No agent with that id in this runtime. |
| `session_not_found` | 404 | No session with that key for this agent. |
| `turn_not_found` | 404 | No turn with that id has ever run for this agent. |
| `schedule_not_found` | 404 | No schedule with that id for this agent. |
| `approval_not_found` | 404 | No approval with that id is waiting — answered, abandoned with its turn, or never real. |
| `key_not_found` | 404 | No operator key with that id. Distinct from an already-revoked one, which is a `200`. |
| `method_not_allowed` | 405 | The path exists under another method. `Allow` names them. Also the answer to `HEAD` on a stream route. |
| `body_not_json` | 400 | The request body did not parse. |
| `body_too_large` | 400 | Over the 1 MB cap, refused before a channel plugin sees it. |
| `bad_request_url` | 400 | `request.url` could not be parsed — usually a relative URL from a host framework. |
| `message_text_required` | 400 | `POST /messages` with no `text`. |
| `deliver_invalid` | 400 | `deliver` named a channel with no recipient, or an unknown shape. |
| `sender_invalid` | 400 | `from` is malformed, or `from.kind` is not `user` or `agent`. Refused rather than defaulted — `kind` decides the trust boundary. |
| `idempotency_key_invalid` | 400 | `Idempotency-Key` is empty, over 255 characters, or not printable ASCII. |
| `idempotency_key_reused` | 409 | The key belongs to a turn whose text or session differed. Nothing ran. |
| `phase_invalid` | 400 | The phase is not declared in the manifest. |
| `approval_decision_required` | 400 | `POST /approvals/:id` with no boolean `granted`. No default in either direction. |
| `key_label_required` | 400 | `POST /v1/keys` with no string `label`. Required rather than defaulted — it is the only thing distinguishing two credentials. |
| `key_label_invalid` | 400 | The label is empty, over 64 characters, or carries a control character. |
| `claim_spent` | 401 | The boot claim was recognised and has already been exchanged. A claim from an earlier boot is `unauthorized` instead — this process has never seen it. |
| `web_asset_missing` | 500 | The routes serving the browser surface and the table backing them diverged. A broken build, not a missing file. |
| `schedule_invalid` | 400 | The schedule failed validation — a bad cron expression, or a field the schema refuses. |
| `unknown_event_type` | 400 | `?types=` named an event that does not exist. Carries the nearest real name. |
| `reload_not_supported` | 409 | An agent's configuration is fixed for its process lifetime, deliberately. |
| `start_not_supported` | 501 | This server has no way to find the manifest for an agent it is not hosting. An embedder over its own agent store, or the container image, which passes none on purpose. |
| `agent_turn_in_flight` | 409 | `stop` was asked for an agent with a turn running. Tearing it down would close its store under a turn recorded as running. |
| `agent_stopped` | 400 | Adoption was asked for an agent that is switched off. `start` is the way back, and it is the one caller that enables before adopting. |
| `turn_not_running` | 409 | No cancel handle for that turn **on this API** — a channel- or schedule-started turn has none. |
| `internal_error` | 500 | An unexpected throw. The event stream carries what happened around it. |
| `websocket_unavailable` | 501 | `/v1/ws` under Node, which has no upgrade path without a dependency. |
| `server_token_missing` | — | `createHandler` was built with neither a token nor `allowUnauthenticated`. Thrown at construction, not returned. |
| `server_public_without_token` | — | A non-loopback bind with no token. Thrown at construction. |
| `frame_not_json` | — | WebSocket frame did not parse. Sent as a `ws.error` frame. |
| `unknown_frame_type` | — | WebSocket frame `type` is not one this endpoint answers. |
| `subscribe_needs_agent_id` | — | A `subscribe` frame naming only `sessionKey`. Refused rather than leaving a silent socket. |
| `message_text_required` (ws) | — | A `message` frame with empty text. |
| `agent_not_found` (ws) | — | The socket's `agentId` names no agent. |

The last rows have no status because they are not HTTP responses: two are thrown while building the
server, and the rest are `ws.error` frames on an open socket. `spec.test.ts` asserts every `code:`
literal under `packages/server/src` appears in this table, plus the four `<kind>_not_found` codes
that are built rather than written — so a new error cannot ship undocumented.

**`HEAD` and `OPTIONS` are answered from the route table, not per route.** `OPTIONS` returns `204`
with an `Allow` header listing what the path accepts, plus `OPTIONS`, plus `HEAD` wherever a `GET`
is really answered; `OPTIONS` on a path that does not exist is a `404`, since a `204` advertising
nothing would read as "this path exists and accepts no methods". `HEAD` runs the `GET` handler and
returns its status and headers with no body, and still requires the token — the probe exemptions
below are the only paths without one.

**The two SSE routes refuse `HEAD` with `405`.** Answering it would mean starting a stream and
discarding the body, leaving a subscription nothing ever closes — one leaked listener per probe,
and a leaked turn-buffer listener also pins its buffer against eviction. A monitoring system
polling `HEAD /v1/events` would degrade the process while every endpoint kept answering correctly,
so it is refused with a hint naming the reason. `OPTIONS` on those paths does not advertise `HEAD`.

---

## Endpoints

### Health and readiness

```
GET /v1/health   → 200 { status, version, uptimeMs, agents: number }
GET /v1/ready    → 200 when every agent has loaded; 503 { status: "starting" } otherwise
```

`/ready` flips at `runtime.ready` — before channels connect. Channel state is separately
visible on the agent resource. This distinction is deliberate: a channel that cannot
connect must not make the process look dead to an orchestrator.

### Agents

```
GET /v1/agents           → [{ id, name, status, model, channels[], entryPhase, phases? }]
                           plus a thin { id, name, status: "disabled", disabledAt?, reason? }
                           row per stopped agent
GET /v1/agents/:id       → the above plus dialect, window, tool count, skills indexed,
                           schedule count, warnings[], team? [{ id, task, artifact[] }]
POST /v1/agents/:id/stop   { reason? } → 200 { id, status: "disabled", disabledAt, reason? }
POST /v1/agents/:id/start           → 200 { id, status: "loaded", adopted[] }
POST /v1/agents/:id/reload
```

**`stop` and `start` are the durable switch, not a signal.** `stop` writes the agent off in the
store *and* drops it from this host now; the row is what makes it survive a restart, and the drop is
what makes the request mean something today — one process hosts several agents, so killing the
process that holds a lease takes every other agent down with it. Both are idempotent: asking for a
state that already holds is `200`, never `404`. `stop` answers `409 agent_turn_in_flight` while a
turn is running, and `404` only when the id is neither hosted nor recorded. `start` answers
`501 start_not_supported` on a server built without a manifest lookup — an embedder over its own
agent store, or the Docker image, which passes none deliberately.

**A stopped agent is listed and its resource is `404`**, and the asymmetry is deliberate: the
listing answers "what exists" and the resource answers "what is running". The row is thin because a
stopped agent is not loaded — there is no manifest in memory to report a model or channels from, and
loading one to fill the row in would make a listing depend on credentials being present.

**Team members are not listed and not addressable.** `GET /v1/agents` returns only served agents,
and every route above resolves through the same list — so a member has no URL. That is a boundary
rather than tidiness: a member is an implementation detail of its supervisor, its catalogue may be
wider, and an addressable one is a route around whatever policy the supervisor was carrying with
nobody having asked the supervisor. `team?` on the supervisor's own resource is how they stay
observable, and it is absent rather than `[]` for an agent with no team.

`reload` re-reads the manifest and context files and rebuilds the tool and skill indexes.
It does **not** restart channels unless their config changed, and it never drops in-flight
turns. Returns a diff of what changed.

**This build answers `501 reload_not_supported`.** An agent's catalogue resolves once and slot 1
renders once, so a session's cached prompt prefix depends on the configuration staying fixed for the
lifetime of the process — which is also why the CLI has `/restart`. A partial reload that silently
did not apply would be worse than a refusal, so the endpoint stays specified and declines, naming
the reason. Decision 11.20.

### Turns

```
POST /v1/agents/:id/messages
```

```json
{
  "text": "what's on my calendar today?",
  "sessionKey": "api:moeen",
  "deliver": "none",
  "stream": true,
  "chunks": true,
  "from": { "id": "agent:ops-bot", "name": "Ops Bot", "kind": "agent" }
}
```

Returns `202` with `{ turnId, sessionKey }` immediately, then streams SSE if `stream` is
true. **The turn is not bound to this connection.** Disconnecting does not cancel it.

#### `from` — who sent it, and what follows

Optional. Omitting it means the token-holder is sending the message itself, which is what every
caller before this field existed was doing — the REPL, a schedule, a channel turn, an operator's
own `curl`. Absent is therefore **not** "unknown".

| Field | |
| --- | --- |
| `id` | Required. A stable identity in the caller's own namespace — `agent:ops-bot`, `user:018f…`, an email address. Opaque to the runtime, capped at 256 characters, recorded on the turn row. |
| `name` | Optional display name. Truncated at 128 characters. Rendered *inside* the fence, never above it. |
| `kind` | Required. `user` or `agent`. **No default.** |

`kind` decides the trust boundary and nothing else may:

| `kind` | Prompt | Tools |
| --- | --- | --- |
| absent / `user` | The input reaches `SLOT.input` unchanged | Unaffected |
| `agent` | The input is wrapped in the same `UNTRUSTED_TOOL_OUTPUT` fence an untrusted observation gets, labelled with the sender | The turn starts **tainted**, so `tools.untrusted.onMutate` applies from step one |

There is deliberately **no `trust` field beside `kind`**. The dangerous configuration is a peer
message declared trusted, and the only way to make it unrepresentable is to derive one from the
other — a caller who wants a peer's text treated as trusted has to write `kind: "user"`, which is a
sentence about what they believe rather than a flag that quietly widens a boundary.

The fence is advisory: a model can be persuaded by text inside an intact one. The part that holds
is the write gate, which sits at the tool call where prose cannot reach. Both halves are the
existing mechanism — see decision 4.25 and `packages/core/src/tools/trust.ts`.

A peer's message is also excluded from conversation memory (`tainted` on the stored row), so an
injection cannot become durable by being retrieved into a later session's `SLOT.memory`.

#### `Idempotency-Key` — making a retry safe

Optional request **header**, 1–255 printable ASCII characters, unique per logical request. A header
rather than a body field because it is a fact about the request rather than about the message.

| Second request | Answer |
| --- | --- |
| Same key, same text and session | `200 { turnId, sessionKey, replayed: true }` — the **first** turn's id. Nothing ran. |
| Same key, different text or session | `409 idempotency_key_reused`, naming the turn that holds it. Nothing ran. |
| No key | `202`. The turn runs again — two turns, two bills. |

Remembered for 24 hours, per agent. The key is claimed before the turn starts, not after, because
this endpoint answers `202` and writes its turn row asynchronously: a claim that waited for the row
would leave the window between two retries — the only window this exists to close — wide open.

`replayed` is absent on a `202` rather than `false`, and `@dispach/client` normalises it to a
boolean on the handle.

`chunks` is here because `stream: true` on its own gives you lifecycle events and no tokens.
Per-token `model.chunk` frames are **opt-in per reader**, default off, and the reason is cost
rather than caution: a token event is one envelope and one ISO timestamp per token, and a client
watching a turn's progress — most of them — wants none of that. So the reader says whether it
wants to be billed for the resolution. `stream` asks for a stream; `chunks` asks for the tokens
in it.

```
GET  /v1/agents/:id/turns/:turnId/stream?chunks=  → SSE, replays buffered events then tails
POST /v1/agents/:id/turns/:turnId/stop            → cooperative cancel; persists partial content
GET  /v1/agents/:id/turns/:turnId                 → final state once complete, with `sender*`
```

Reattach is core, not a convenience. Generation must survive a client refresh; partial
content is saved on explicit stop only, never on disconnect.

### Approvals

```
GET  /v1/agents/:id/approvals              → { approvals: [...] }, oldest first
POST /v1/agents/:id/approvals/:approvalId  → { granted: true | false }
```

A call the policy says to `ask` about, or a mutating call under `tools.untrusted.onMutate:
"confirm"` in a tainted turn, suspends the turn and emits **`approval.requested`**. Answering with
a POST resumes it. The runtime emits **`approval.resolved`** either way, and the two are paired on
`approvalId` — a request always gets exactly one resolution.

`approvalId` is minted per question and is **not** `callId`: a dialect numbers calls within a step,
so two steps of one turn both have a `c1`, and an id that decides which blocked call resumes cannot
collide.

Each entry carries `agentId`, and the listing is **scoped to the agent in the path**. It was not:
the registry is per process and `:id` was discarded, so one operator read every agent's pending
questions — slug, matched command and reason included. Harmless while a served process hosted one
agent, which is precisely how it stayed unnoticed. `POST …/:approvalId` stays keyed by the approval
id alone, because that id is minted per question and is already unique across agents.

**The event comes from the runtime, not from whichever front end asks.** So the question is visible
to the firehose, to a second observer of the same session, and to an audit log — not only to the
surface that implements the prompt. The envelope carries `agentId`, `sessionKey` and `turnId`, which
is the correlation a client needs and which the approval payload deliberately does not repeat.

**The listing is the recovery path**, for the same reason turn reattach is: a client that missed the
event — opened after the turn blocked, refreshed the page, a second operator — otherwise sees a turn
that has visibly stopped with no way to discover why.

| Outcome | `by` | What it means |
| --- | --- | --- |
| answered | `approver` | Somebody decided. `granted` is their decision. |
| the approver failed | `error` | Denied, and the denial says nothing about what a person wanted. A crashed prompt is not consent. |
| the turn ended first | `abandoned` | Denied, and **nobody declined it**. Take the prompt down. |

**There is no approval timeout.** `limits.turnTimeoutMs` bounds the wait: the runtime races the
approver against the turn's own signal, so an unanswered question ends with the turn rather than on
a second clock. Two deadlines racing each other is the shape that leaves a tool running with nothing
referencing it.

Nothing about a settled approval is kept. A pending one lives in the serving process's memory and
dies with it, because the thing it resolves is a suspended turn *in that process* — a row surviving
a restart would describe a question nobody is still waiting on. A restart abandons the turn, which
`by: "abandoned"` already says.

A deployment that attached no approver still answers both routes: the listing is empty and every
POST is a `404`. The agent's own `confirm_without_approver` warning is where that is reported.

**Attaching has four states and three answers.** A turn id you hold is in exactly one of them, and
each gets what is true of it rather than one shared "cannot stream this":

| State | Answer |
| --- | --- |
| Buffered in this process | `200`, `stream.replay` then the replayed events, then live |
| No buffer, turn finished | `200` + `stream.ended` carrying the stored `status` and `steps` |
| No buffer, turn still `running` | `200` + `stream.unavailable` — recorded, not observable here |
| No such turn | `404 turn_not_found` |

The third row is not hypothetical. A turn row is written at turn *start*, and one store is shared
by every process under a sandbox root — so a served process can hold a `running` row for a turn
another process is executing. Reporting that as ended would send a client to read a final text
that does not exist yet.

A stream that opens with `stream.replay` may be missing its oldest events: the per-turn buffer is
capped and discards from the **front**, which is precisely where a client reconstructing text is
not looking. The preamble arrives *before* the replayed frames and carries `truncated`, `dropped`
and `chunks: "start" | "partial" | "none"` so a reader learns a hole exists before it starts
concatenating rather than after.

`deliver` accepts `"none"` (result via API only), a channel id, or `{ channel, to }`.


### The browser surface

```
GET /
GET /assets/app.js
GET /assets/app.css
```

Three paths, **no catch-all**. A wildcard falling back to `index.html` is the usual single-page
arrangement and is wrong here: it makes every mistyped API path answer `200` with a web page, so a
client calling `/v1/agentss` receives HTML where it expected JSON and the failure surfaces as a
parse error far from the typo. The page has no client-side routes.

**These three need no credential**, and that is not a relaxation: a page load has no header to carry
a bearer token in, so a credential-gated shell is a shell nobody can reach. The page holds no data —
every value it displays comes from `/v1` with an operator key. An unauthenticated reader learns that
a Dispach server is here, which `GET /v1/health` already tells them.

Filenames are **stable rather than content-hashed**, because the server embeds these assets as text
at build time (decision 11.200) and an embedded asset list is a list of import statements, which
cannot name a file whose hash moves every build. Freshness is an `ETag` over the bytes with
`Cache-Control: no-cache`, so a browser may store the file and revalidate. `immutable` would be a
promise that the bytes at this URL never change, and a rebuild changes them.

### Operator keys

```
POST   /v1/keys          → { keyId, label, createdAt, secret }   — the secret, once
GET    /v1/keys          → { keys: [...], scope }                — never a secret
DELETE /v1/keys/:keyId   → the revoked record
```

A key is a **labelled bearer credential with no identity attached** — no username, no password, no
role, no signup. It exists so a browser session has a credential that can be revoked without
restarting the process, which the container's `server.tokenEnv` value cannot be.

**Keys are authentication, not authorisation.** Every key reaches every route for every agent this
server holds. `GET /v1/keys` says so in its own `scope` field rather than leaving each client to
rediscover it.

Three credentials authenticate a request, tried in this order:

1. The value of the variable named by `server.tokenEnv`. Unchanged, still first-class, and **not
   revocable through this API** — it belongs to the environment, and a route that could revoke it
   would be a route that locks an operator out of their own container.
2. An operator key, matched by an unsalted `SHA-256` of the presented secret against a unique index.
   A single hash rather than a KDF: the secret is 160 bits of CSPRNG output, so there is no
   candidate space for a work factor to protect, while a per-key salt would make authenticating one
   request cost one derivation *per key in the table* — on every call, including each stream open.
3. The boot claim, which authenticates `POST /v1/keys` and nothing else. Scoped to that method and
   path together: `/v1/keys` is shared with the listing, so a path-only scope would let a claim
   enumerate every credential on the server before exchanging itself for one.

`POST /v1/keys` is the only response that ever carries a `secret`, and `OperatorKeyRecord` has no
field for one — so there is no shape in which a stored or listed key could carry it.

**A live key makes an otherwise-open server demand a credential.** On loopback with no
`server.tokenEnv` the surface is open, as it has always been; the moment one key exists, every
non-open path requires one. Without that, minting a key would do nothing and a browser could show a
key-management page on a server anybody on the machine can reach. It latches on and never off:
revoking the last key does **not** reopen the server, because a `DELETE` whose real effect is to
remove authentication from every route is not what anybody revoking a credential is asking for.

**The bootstrap is a one-time claim printed at boot**, while no key is live. Reading the server's
own output is what confers first ownership — `docker logs` already reveals the agent's
conversations, so it grants nothing new to whoever can see it. It is held in the process rather than
the database, so it never outlives the boot that printed it; `serve --claim` prints one when a key
already exists, which is the only route back from a lost credential on a token-less server.

It is exchanged with a `POST`, not by opening a URL: a `GET` that spends a single-use token can be
burned by a link preview or a browser pre-fetch before the person clicks, and the failure would look
like a ticket that never worked. The spend happens **after** the body validates, so a rejected label
leaves the ticket usable.

### Sessions

```
GET    /v1/agents/:id/sessions
GET    /v1/agents/:id/sessions/:key
GET    /v1/agents/:id/sessions/:key/messages?before=&limit=
DELETE /v1/agents/:id/sessions/:key          → clears history; keeps memory files
POST   /v1/agents/:id/sessions/:key/phase    → { phase }
```

`DELETE` clears conversation state only. Memory markdown is a file artifact and is never
deleted by an API call.

A message in the `messages` listing carries `role`, `content`, and — under the `native` tool
dialect only — `toolCalls` on an assistant turn that asked for tools, and `toolCallId` on a `tool`
message saying which call it answers. Both are absent under `nlt`, where the invocation is the
content. They are part of the message rather than decoration: a client reconstructing a prompt from
this listing and dropping them would produce a trace an endpoint rejects.

### Schedules

```
GET    /v1/agents/:id/schedules              → all, including disabled
POST   /v1/agents/:id/schedules
GET    /v1/agents/:id/schedules/:sid
PATCH  /v1/agents/:id/schedules/:sid
DELETE /v1/agents/:id/schedules/:sid
POST   /v1/agents/:id/schedules/:sid/run     → fire now, out of band
```

```json
{
  "id": "morning-brief",
  "kind": "cron",
  "expr": "0 8 * * *",
  "timezone": "Asia/Dhaka",
  "task": "Summarise today's calendar and unread email.",
  "deliver": { "channel": "tg", "to": "@moeen" },
  "session": "isolated",
  "enabled": true
}
```

Validation is at write time, not fire time. Missing delivery target:

```json
{ "error": {
  "code": "schedule_missing_delivery",
  "message": "Schedule 'morning-brief' has no delivery target.",
  "hint": "Set deliver to { channel, to }, or the literal \"none\" to return results only via the event stream.",
  "field": "deliver"
}}
```

Listing includes disabled schedules by default. `?enabled=true` filters.

### Tools and skills (introspection)

```
GET /v1/agents/:id/tools     → resolved catalogue with tags, mutating, trust, phase visibility
GET /v1/agents/:id/skills    → indexed skills with description, token cost and script slugs
GET /v1/agents/:id/context   → the assembled context for the next turn, with token counts per slot
```

`/context` exists because "why did it do that?" is almost always a context question, and
guessing at it is how days get lost.

Three things about these two that are easy to misread.

**`phases` on a tool is omitted, not empty, when the agent is unphased** — an empty array reads as
"visible in no phase", which is the opposite of the truth for an agent that shows every tool
always. **`phase_set` is not in the catalogue** and that is correct: it is a *turn* tool, built per
turn because its description names the current phase and what each other phase would add, so there
is no static description to report.

**An agent has an `entryPhase`, not a `phase`.** A phase is per session, so an agent hosting three
conversations is in three phases at once; the agent-level facts are where a new session starts and
which names exist. A session's actual phase is `GET /v1/agents/:id/sessions/:key`.

**Two schedule counts exist and they are different numbers.** `GET /v1/agents/:id` reports what the
store holds — the reconciled truth, including rows the API created — while the `agent.loaded` event
reports the *manifest's declared* count, because that event fires before reconciliation has run.
Neither is wrong; a reader comparing them needs to know which is which.

Skills carry `configured`, distinguishing an agent with no `skills:` block from one whose skills
directory is empty. There is no last-selected time: selection happens per turn in the harness and
is recorded nowhere, so the field would need a store column, and this document previously promised
it anyway.

Slot numbers in the `slots` array are the ones in `01-ARCHITECTURE.md`, where slot number equals
prompt position. Slot 2 is the agent's own configuration, injected so that knowing it is not a
decision the model has to make. They are **positional, not stable identifiers** — inserting a slot renumbers the
ones after it, as slots 2 and 7 did when the workspace tiers were specified. Read a slot's meaning
from its `label`, never from its number. This is not covered by the append-only rule below, which
governs event *types*.

### Channel webhooks

```
POST /v1/channels/:channelId/webhook/:agentId
```

Signature verification is the channel plugin's responsibility. Core enforces a body-size
cap and rate limit before the plugin sees anything.

### Runtime event stream

```
GET /v1/events?agentId=&types=&chunks=   → SSE, all lifecycle events
```

The first frame is always `stream.subscribed`, carrying the resolved `agentId`, `types` and
`chunks` — a control frame about the subscription, so it is **not** subject to the `types` filter.
A reader that set a filter needs to see the filter it got.

`chunks` works as it does on a turn stream, with one addition: **naming `model.chunk` in `types`
turns it on**, and the preamble says so with `implied`. Asking for a type is asking for it, and
without the implication `?types=model.chunk` was a request that streamed nothing forever with
nothing reporting why. The implication is reported rather than silent, which is the difference
between a resolved state and a surprising one.

Filterable. This is the observability surface — VelaOps subscribes here to populate
`sub_agent_invocations` and `tool_calls`. **Core emits; consumers persist.** Core writes no
rows it does not own.

---

## Event schema

Every event:

```ts
interface Event {
  v: 1
  ts: string          // RFC 3339
  runtimeId: string
  agentId?: string
  sessionKey?: string
  turnId?: string
  stepId?: string
  type: string
  data: unknown
}
```

**`agentId` is optional and this document said it was required for several phases.** Runtime-scoped
events — `runtime.ready`, `store.ready`, `runtime.stopping` — belong to the process rather than to
any agent, so they carry no id. A client that trusted the old declaration and dereferenced it was
reading the field on exactly the events that report the runtime coming up. `sessionKey`, `turnId`
and `stepId` narrow the same way: present when the event happened inside one, absent otherwise.

| Type | When | Key `data` |
| --- | --- | --- |
| `runtime.ready` | boot complete | `bootMs`, `phases: {step: ms}` |
| `store.ready` | store open, migrations done | `location`, `driver`, `from`, `to`, `applied[]`, `reaped[]` |
| `runtime.stopping` | shutdown begins | `reason` |
| `runtime.released` | a lease this process held is given back | `agentId`, `kind` |
| `plugin.loaded` | per plugin | `name`, `version`, `setupMs`, `permissions` |
| `plugin.slow` | setup over budget | `name`, `setupMs` |
| `agent.loaded` | per agent | `tools`, `skills`, `schedules` (the manifest's **declared** count — this fires before reconciliation), `model` |
| `agent.disposed` | this process stopped hosting an agent, without exiting | `reason` (`requested` \| `replaced` \| `stopped`) |
| `agent.warning` | a fact true for the whole session, said at load | `code`, `message`, `hint`, `field?` |
| `agent.channel.status` | connect/disconnect | `channelId`, `channelType`, `status`, `detail?` |
| `agent.channel.error` | channel failure that did not stop the channel | `channelId`, `code`, `message`, `hint` |
| `agent.channel.rejected` | inbound not turned into a turn | `channelId`, `reason` (`duplicate` \| `denied`), `sender`, `detail` |
| `handoff.start` | a delegation began | `member`, `task`, `sessionKey` |
| `handoff.result` | how it ended | `member`, `sessionKey`, `outcome`, `steps`, `tokens`, `errorCode?` |
| `approval.requested` | a call is waiting on a person | `approvalId`, `slug`, `callId`, `match?`, `mutating`, `reason` |
| `approval.resolved` | how it ended | `approvalId`, `slug`, `granted`, `by` |
| `turn.start` | inbound accepted | `source`, `inputTokens`, `trust`, `from?` |
| `context.assembled` | per turn | `slots: [{slot, label, tokens, pinned}]`, `total` |
| `context.pressure` | per step, after compaction | `fraction` (of the prompt actually sent), `tokens`, `budget`, `source: reported \| corrected \| estimated`, `peak?` (what the ladder faced) |
| `compaction.stage` | per stage that ran | `stage`, `before`, `after`, `changed`, `digest?: model \| mechanical` |
| `context.reset` | per S5 firing | `count`, `warning?` |
| `context.dropped` | history the budget could not fit | `messages`, `budget`, `keptTokens` |
| `phase.changed` | per `phase_set` that moved | `to`, `tools` (count now visible) |
| `model.call` | request sent | `role`, `model`, `promptTokens`, `cached`, `attempt` |
| `model.chunk` | streaming | `delta`, `kind: text \| reasoning` — emitted only while some subscriber has opted in, per subscriber |
| `model.retry` | a retryable model failure, before the next attempt | `status`, `attempt`, `delayMs` |
| `model.result` | response done | `outputTokens`, `promptTokens`, `promptTokensReported`, `finishReason`, `latencyMs` |
| `tool.call` | before execute | `slug`, `callId`, `argsHash`, `mutating` |
| `tool.result` | after execute | `slug`, `callId`, `ok`, `latencyMs`, `bytes`, `truncated`, `trust` |
| `tool.gated` | a call was blocked | `slug`, `callId`, `reason`, `policy` |
| `tool.repair` | step unusable | `slugs[]`, `errors[]` |
| `tools.refreshed` | after `runtime.ready` | `provider`, `ok`, `fetched`, `changed[]`, `missing[]`, `latencyMs`, `error?` |
| `delivery.sent` | outbox success | `channelId`, `providerMessageId?`, `chunkIndex`, `chunkTotal`, `attempts`, `uncertain` |
| `delivery.retry` | retryable send failed | `channelId`, `chunkIndex`, `attempts`, `delayMs`, `error` |
| `delivery.failed` | chunk abandoned | `channelId`, `chunkIndex`, `chunkTotal`, `attempts`, `exhausted`, `abandoned`, `error` |
| `delivery.uncertain` | in-flight row recovered at boot | `channelId`, `chunkIndex`, `chunkTotal`, `attempts`, `idempotentSend` |
| `schedules.reconciled` | per agent at load | `created`, `updated`, `removed`, `total` |
| `schedule.fired` | timer | `scheduleId`, `kind`, `driftMs`, `late` |
| `schedule.skipped` | occurrences passed with nothing running | `scheduleId`, `kind`, `reason`, `missed`, `missedAtLeast` |
| `schedule.deferred` | a fire arrived mid-run | `scheduleId`, `kind` |
| `schedule.error` | unreadable schedule, or the turn it started failed | `scheduleId`, `code`, `message`, `hint` |
| `turn.end` | complete | `reason`, `steps`, `tokens`, `durationMs` |
| `error` | anything uncaught | `code`, `message`, `hint`, `stack?` |

### Planned

Types this document intends and **no runtime emits yet**. Separated rather than deleted, because
the shape is designed and a reader planning against it should be able to see it — and separated
rather than mixed in, because a row in the table above is a promise that subscribing works today.

**Nothing is planned and unshipped.** The last two rows here, `handoff.start` and `handoff.result`,
moved up into the live table when Phase 10B shipped them — which is what this section exists to
force. A row returns the moment a document describes an event before a runtime emits it.

| Event | When | Data | Blocked on |
| --- | --- | --- | --- |

**It worked.** Adding `handoff.start` to `EVENT_TYPES` in Phase 10B turned this guard red in both
directions at once — `undocumented: ["handoff.start", "handoff.result"]` — and the rows only moved
up once the live table above described them. The move also corrected two field names the planned
rows had guessed at: `member` rather than `to`, and `outcome` rather than `ok`, because a delegation
ends four ways and a boolean collapses "the task was too large" into "it failed".

> **What the guard does not check: field lists.** It compares the first column against
> `EVENT_TYPES`, so a *name* cannot drift — and a row's `Data` column can. Found the hard way in
> 10B: `model.result` was documented as carrying `costUsd?`, which has never existed, and as not
> carrying `promptTokens`, which it always has. Both corrected above. Deriving the field lists from
> `EventDataMap` is the obvious next guard and is not built; until it is, **read the type before
> writing against a `Data` column.**

`packages/server/test/spec.test.ts` asserts this table's rows are **absent** from `EVENT_TYPES`, so
the day a planned event ships the guard goes red until the row is moved up. That is the whole mechanism:
the one moment anybody is thinking about a planned event is when they implement it.

### How this table is kept true

Everything above is checked against the code, because for several phases it was not and it drifted
badly. `EVENT_TYPES` in `packages/core/src/events/types.ts` is the list as a *value*, with a
compile-time assertion in both directions — a type added to `EventDataMap` and not to the tuple
fails `tsc`, and a typo in the tuple is rejected at the literal. `spec.test.ts` then compares this
document against that value, asserts every documented event is really emitted somewhere, and checks
the envelope, the routes and the error codes the same way.

Two rounds of corrections are worth recording, because the second happened *after* this document
claimed to have finished the first.

Six rows were removed earlier rather than corrected: a second `context.pressure` naming
`used`/`window`, a second `compaction.stage` naming `dropped`, a `context.reset` naming `sessionKey`,
a duplicate `phase.changed` naming `from`/`by`, and `skill.selected`/`skill.none`, which have never
existed as events at all. They were an early draft left below the accurate rows in the same table, so
anything written against them would have read `undefined` from a field this document promised.

The guard then found six more this paragraph had missed. `agent.error` was documented and declared
in `EventDataMap` and **emitted by nothing, ever** — it is deleted from both. `handoff.start` and
`handoff.result` moved to *Planned* above. And `agent.warning`, `model.retry` and `runtime.released`
were emitted by the runtime and documented nowhere, which is the same defect pointing the other way:
a consumer cannot subscribe to what it is never told exists. **Prose saying the table was cleaned up
is not a mechanism, which is the transferable half.**

`tools.refreshed` is the only evidence a remote provider caught its cached catalogue up, and it is
deliberately the only evidence: the refresh is detached, because awaiting it would put a network round
trip back inside the boot path. `ok: false` is not a turn failure — the agent keeps serving the
catalogue it resolved from disk. Watch `changed`: a slug whose schema moved under a running agent is
one the model has already been told about in the current session's cached prefix.

The delivery events describe **one chunk each**, not one reply — a reply over the channel's
`maxMessageChars` is several rows with the same `chunkTotal`. `delivery.failed` carries `abandoned`,
the count of later chunks in the same reply dropped as a consequence, because half a message is
worse than none; one fault produces one failure event rather than N.

`delivery.uncertain` is the honest edge of exactly-once. A row found `inflight` at boot belonged to a
process that died between sending the bytes and recording the acknowledgement, and nothing local can
say which happened. It is re-sent, because a lost reply in a chat reads as the agent ignoring you and
produces no signal at all, whereas a duplicate produces both a message and this event. `uncertain`
then rides onto the eventual `delivery.sent`, so a duplicate stays explicable after the fact.
`idempotentSend` reports whether the channel's provider deduplicates on a key we supply — Telegram's
`sendMessage` does not, WhatsApp Cloud API does — so the event says how much doubt there actually is
instead of implying a fixed amount.

`agent.channel.rejected` fires for a duplicate the provider replayed and for an `allowFrom` refusal.
Refusals are reported rather than dropped silently: an allowlist that quietly discards a message is
indistinguishable from a channel that is not receiving at all. `sender` is the handle where the
provider exposes one and the peer id otherwise — never the message body.

`tool.gated` fires when a mutating call is refused because untrusted content entered the turn. It is
not an error: the model is told to report back and ask instead, and the turn continues. `policy` names
the `tools.untrusted.onMutate` setting that decided it, so a surprised operator can see whether they
were on the default.

`callId` identifies a call within its step; the envelope's `stepId` makes it unique. Arguments
themselves never appear on the wire — `argsHash` is a stable hash over them, because arguments carry
whatever the conversation carried and an event stream is the wrong place to copy it to.

`tool.repair` fires whenever a step's calls cannot be used as written, which includes a slug the
model invented and a field that failed coercion. The first occurrence is followed by one correction
request; a second in a row ends the turn with `tool_repair_failed` rather than asking again, so two
of these back to back is the signal that a catalogue needs work rather than that a model does.

`turn.end.reason`: `final` \| `max_steps` \| `no_progress` \| `truncated` \| `stopped` \| `timeout` \|
`error`. Everything that is not `final` is reported honestly rather than dressed up as a normal
completion, and each has its own sentence from `endNote` — the plain CLI, the transcript and the
channel delivery path all call it, so no surface describes an ending in words of its own.

`no_progress` and `truncated` are separate reasons rather than shades of `max_steps` and `final`
because each needs a different remedy: a stalled turn names the call that repeated, and a truncated
one names an output limit and whose it was. `turns.status` accepts both from migration 7.

### SSE framing

```
event: tool.call
data: {"v":1,"ts":"2026-08-12T09:15:04Z","agentId":"assistant","turnId":"t_01H...","type":"tool.call","data":{...}}
```

The event name mirrors `type` so `EventSource` handlers work without parsing. Heartbeat
comment every 15 s to survive proxies.

---

## WebSocket

One endpoint, for genuinely bidirectional use — an interactive client needing token
streaming plus mid-turn interrupts:

```
GET /v1/ws?agentId=&token=&chunks=
```

Client frames: `{ type: "message" | "stop" | "subscribe" | "ping" }`.
Server frames: the same event objects as SSE, plus the control frames `ws.open`, `ws.subscribed`,
`ws.accepted`, `ws.stopping` and `ws.error`.

`chunks` is **per socket**, not per server: one client asking for tokens must not start sending
them to every other connected client. It is set on the handshake and reported back on `ws.open`,
and `{ type: "subscribe", chunks }` changes it without reconnecting — omitting the field leaves it
as it was, so re-pointing the agent cannot silently switch streaming off.

A `subscribe` frame must name `agentId`. A frame carrying only `sessionKey` is refused with
`subscribe_needs_agent_id` rather than accepted: a socket filters on the agent an event carries, a
session key can never match one, and a socket pointed with it goes permanently silent. It used to
be accepted, and answered `ws.subscribed` to say so.

**`stop` reaches any turn this process started**, over either surface — the cancel registry is one
per process, shared by the HTTP handler and this bridge. It does not reach a turn a channel or a
schedule began: nothing in core records in-flight turns, so there is no handle to share, and
`POST /stop` says exactly that with `turn_not_running`.

**Served under Bun only.** Bun has an upgrade path in `Bun.serve`; Node has none without a
dependency, and adding one for an endpoint this section itself calls secondary is the wrong trade.
Under Node the route answers `501 websocket_unavailable` naming the reason — better than a
connection failure a client reads as a network problem. Authentication is `?token=` because a
browser's `WebSocket` constructor cannot set headers; the token therefore reaches proxy access logs,
which is stated rather than hidden. Decision 11.21.

Everything achievable over HTTP + SSE stays there. WS exists for interactive clients, not
as the primary API. VelaOps' web chat is the intended consumer.

---

## Design notes

**Why turn IDs are client-visible.** Reattach needs a handle. Deriving one from a session
key breaks the moment two turns overlap.

**Why `/context` exists.** Debugging an agent means inspecting what it was actually shown.
Without this, that's guesswork against a prompt you can't see.

**Why `deliver` is per-request.** A single agent serves a Telegram user, a schedule, and an
API caller. Where output goes is a property of the request, not the agent.

**Why no batch endpoint.** Fan-out is the caller's job. A batch endpoint is a queue with
extra steps, and Dispach is not a queue.

**Why no auth beyond a bearer token.** Dispach is a runtime, not a multi-tenant service.
Identity, RBAC, and per-user scoping belong to whatever embeds it — VelaOps has Better
Auth, its own session store, and per-agent `.pem` keys already. Duplicating that here would
create two sources of truth for authorization, which is worse than none.
