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

---

## Endpoints

### Health and readiness

```
GET /v1/health   → 200 { status, version, uptimeMs, agents: number }
GET /v1/ready    → 200 when every agent has loaded; 503 with { pending: [...] } otherwise
```

`/ready` flips at `runtime.ready` — before channels connect. Channel state is separately
visible on the agent resource. This distinction is deliberate: a channel that cannot
connect must not make the process look dead to an orchestrator.

### Agents

```
GET /v1/agents           → [{ id, name, status, model, channels[], phase }]
GET /v1/agents/:id       → full status incl. tool count, skills indexed, schedule count
POST /v1/agents/:id/reload
```

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
  "stream": true
}
```

Returns `202` with `{ turnId, sessionKey }` immediately, then streams SSE if `stream` is
true. **The turn is not bound to this connection.** Disconnecting does not cancel it.

```
GET  /v1/agents/:id/turns/:turnId/stream   → SSE, replays buffered events then tails
POST /v1/agents/:id/turns/:turnId/stop     → cooperative cancel; persists partial content
GET  /v1/agents/:id/turns/:turnId          → final state once complete
```

Reattach is core, not a convenience. Generation must survive a client refresh; partial
content is saved on explicit stop only, never on disconnect.

`deliver` accepts `"none"` (result via API only), a channel id, or `{ channel, to }`.

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
GET /v1/agents/:id/tools     → resolved catalogue with tags, mutating, phase visibility
GET /v1/agents/:id/skills    → indexed skills with description and last-selected time
GET /v1/agents/:id/context   → the assembled context for the next turn, with token counts per slot
```

`/context` exists because "why did it do that?" is almost always a context question, and
guessing at it is how days get lost.

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
GET /v1/events?agentId=&types=   → SSE, all lifecycle events
```

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
  agentId: string
  sessionKey?: string
  turnId?: string
  stepId?: string
  type: string
  data: unknown
}
```

| Type | When | Key `data` |
| --- | --- | --- |
| `runtime.ready` | boot complete | `bootMs`, `phases: {step: ms}` |
| `store.ready` | store open, migrations done | `location`, `driver`, `from`, `to`, `applied[]`, `reaped[]` |
| `runtime.stopping` | shutdown begins | `reason` |
| `plugin.loaded` | per plugin | `name`, `version`, `setupMs`, `permissions` |
| `plugin.slow` | setup over budget | `name`, `setupMs` |
| `agent.loaded` | per agent | `tools`, `skills`, `schedules` |
| `agent.error` | load failure | `code`, `message`, `hint` |
| `agent.channel.status` | connect/disconnect | `channelId`, `channelType`, `status`, `detail?` |
| `agent.channel.error` | channel failure that did not stop the channel | `channelId`, `code`, `message`, `hint` |
| `agent.channel.rejected` | inbound not turned into a turn | `channelId`, `reason` (`duplicate` \| `denied`), `sender`, `detail` |
| `turn.start` | inbound accepted | `source`, `inputTokens` |
| `context.assembled` | per turn | `slots: [{slot, label, tokens, pinned}]`, `total` |
| `context.pressure` | per step, after compaction | `fraction` (of the prompt actually sent), `tokens`, `budget`, `source: reported \| corrected \| estimated`, `peak?` (what the ladder faced) |
| `compaction.stage` | per stage that ran | `stage`, `before`, `after`, `changed`, `digest?: model \| mechanical` |
| `context.reset` | per S5 firing | `count`, `warning?` |
| `context.dropped` | history the budget could not fit | `messages`, `budget`, `keptTokens` |
| `phase.changed` | per `phase_set` that moved | `to`, `tools` (count now visible) |
| `model.call` | request sent | `role`, `model`, `promptTokens`, `cached`, `attempt` |
| `model.chunk` | streaming | `delta` — suppressed unless subscriber opted in |
| `model.result` | response done | `outputTokens`, `finishReason`, `latencyMs`, `costUsd?` |
| `tool.call` | before execute | `slug`, `callId`, `argsHash`, `mutating` |
| `tool.result` | after execute | `slug`, `callId`, `ok`, `latencyMs`, `bytes`, `truncated`, `trust` |
| `tool.gated` | a call was blocked | `slug`, `callId`, `reason`, `policy` |
| `tool.repair` | step unusable | `slugs[]`, `errors[]` |
| `tools.refreshed` | after `runtime.ready` | `provider`, `ok`, `fetched`, `changed[]`, `missing[]`, `latencyMs`, `error?` |
| `handoff.start` | delegation | `to`, `task` |
| `handoff.result` | returned | `to`, `ok`, `steps`, `tokens` |
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

Six rows were removed from this table rather than corrected: a second `context.pressure` naming
`used`/`window`, a second `compaction.stage` naming `dropped`, a `context.reset` naming `sessionKey`,
a duplicate `phase.changed` naming `from`/`by`, and `skill.selected`/`skill.none`, which have never
existed as events at all. They were an early draft left below the accurate rows in the same table, so
anything written against them would have read `undefined` from a field this document promised.

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
GET /v1/ws?agentId=&token=
```

Client frames: `{ type: "message" | "stop" | "subscribe" | "ping" }`.
Server frames: the same event objects as SSE.

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
