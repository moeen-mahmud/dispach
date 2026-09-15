# 09 — API guide

A worked walkthrough of the agent server, from `docker compose up` to a streamed reply.

This is the *guide*. [`04-SPEC-WIRE.md`](04-SPEC-WIRE.md) is the **contract** — every route, every
event, every error code, checked against the code by `packages/server/test/spec.test.ts`. When the
two disagree, the spec is right and this file is stale.

> **Why there is no generated reference.** Phase 11 listed "API docs generated from types" as a
> deliverable, and this answers it deliberately without a generator. A typedoc build is a
> dependency with its own release cadence producing a third description of a surface that already
> has two — the spec, which is now machine-checked, and `@dispach/client`, whose types *are* the
> reference and are checked by `tsc`. A generated third copy would drift from both and look the
> most authoritative. Decision 11.10's dependency discipline, applied one package over.

---

## 1. Bring it up

```bash
git clone https://github.com/moeen-mahmud/dispach && cd dispach
cp .env.example .env          # then DISPACH_API_TOKEN and MODEL_API_KEY
docker compose up -d --wait
```

`--wait` blocks until the container's own healthcheck passes, which polls `/v1/ready`. Measured on
an arm64 Docker Desktop: **5.8 s** to healthy.

```bash
curl -s localhost:7420/v1/ready
# {"status":"ready","agents":1}
```

`/v1/health` and `/v1/ready` are the only routes that need no token — an orchestrator's probe
cannot hold one, and a probe that got a 401 forever would mark a healthy container unhealthy.

```bash
export TOKEN=$(grep DISPACH_API_TOKEN .env | cut -d= -f2-)
export A=localhost:7420/v1/agents/minimal
```

---

## 2. Ask it something

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"what can you do?"}' $A/messages
# {"turnId":"t_mu2fc3nwjz6r7kfi","sessionKey":"api:default"}
```

`202`, immediately. **The turn is not bound to that connection** — it is already running, and
hanging up does not cancel it. This is the single most important thing about the protocol, and
everything else follows from it:

```bash
curl -s -H "Authorization: Bearer $TOKEN" $A/turns/$TURN
# the finished row: status, text, steps, promptTokens, outputTokens
```

Poll that, or watch it happen.

---

## 3. Watch it happen

```bash
curl -sN -H "Authorization: Bearer $TOKEN" "$A/turns/$TURN/stream?chunks=true"
```

```
event: stream.replay
data: {"turnId":"t_…","state":"running","events":4,"truncated":false,"dropped":0,"chunks":"none"}

event: turn.start
data: {"v":1,"ts":"…","runtimeId":"rt_…","agentId":"minimal","turnId":"t_…","type":"turn.start","data":{"source":"api","inputTokens":10}}

event: model.chunk
data: {…,"type":"model.chunk","data":{"delta":"I can","kind":"text"}}

event: turn.end
data: {…,"type":"turn.end","data":{"reason":"final","steps":1,"tokens":{"prompt":11836,"output":27}}}
```

Four things to know about that stream, each of which exists because its absence was a bug:

**`?chunks=true` is not optional if you want tokens.** Per-token frames are opt-in per reader,
default off. A token event is one envelope and one ISO timestamp per token, and most readers are
watching progress rather than animating text.

**`stream.replay` comes first and may report a hole.** The per-turn buffer is capped and discards
its *oldest* events — precisely where a client reconstructing text is not looking. `truncated`,
`dropped` and `chunks: "start" | "partial" | "none"` arrive **before** the replayed frames, so a
reader learns the front is missing before it starts concatenating rather than after.

**Attaching has four states and three answers.**

| State | Answer |
| --- | --- |
| Buffered here | `200`, replay then live |
| Finished, buffer evicted | `200` + `stream.ended` with the stored status |
| Recorded running, not observable here | `200` + `stream.unavailable` |
| No such turn | `404 turn_not_found` |

That third row is real: one store is shared by every process under a sandbox root, so a served
process can hold a `running` row for a turn another process is executing.

**Reattaching is the normal case.** The turn id is all you need, from any process, after any
refresh. That is what `stream` and `turns/:turnId` are both for.

---

## 3b. When it wasn't you who asked

Two additions turn `POST /messages` from "the token-holder is talking" into a surface a multi-user
front end or a peer agent can be put behind. Both are optional and omitting both is byte-for-byte
the behaviour above.

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: 018f3c2a-relay-0041' \
  -d '{"text":"the nightly build failed on arm64","from":{"id":"agent:ci-bot","name":"CI","kind":"agent"}}' \
  $A/messages
# {"turnId":"t_…","sessionKey":"api:default"}
```

**`from.kind` decides the trust boundary, and there is no second field that can disagree with it.**

| `kind` | What changes |
| --- | --- |
| omitted, or `user` | Nothing. The text reaches `SLOT.input` exactly as before. |
| `agent` | The text is wrapped in the same `UNTRUSTED_TOOL_OUTPUT` fence a fetched web page gets, and the turn starts **tainted** — so `tools.untrusted.onMutate` (default `refuse`) blocks mutating tools from step one. |

That second row is the whole point, and the fence is the *lesser* half of it. A model can be
persuaded by text inside an intact fence; the write gate sits at the tool call, where prose cannot
reach. A peer agent asking your agent to `file_write` gets:

```
memory_write was not run, and nothing was changed.

Content from outside this conversation reached this turn, by way of agent agent:ci-bot. While that
is true, tools that change things are blocked.
```

There is deliberately no `trust` field to set alongside `kind`. The dangerous configuration is a
peer message declared trusted, and the only way to make that unrepresentable is to derive one from
the other — writing `kind: "user"` for a peer is at least a sentence about what you believe.

A peer's message is also excluded from conversation memory, so an injection cannot come back a week
later through `SLOT.memory` after the turn's taint has expired.

**`Idempotency-Key` makes a retry free.** A header rather than a body field, because it is a fact
about the request:

```bash
# the same call again, same key
# 200 {"turnId":"t_…","sessionKey":"api:default","replayed":true}   ← the FIRST turn's id
```

`200` rather than `202`, because nothing was accepted for processing. The same key with different
text is `409 idempotency_key_reused` naming the turn that holds it — a client that recycled a key
by accident must not be told a message it never sent succeeded. Keys are remembered for 24 hours,
per agent, and claimed *before* the turn starts: this endpoint answers before it writes its turn
row, so a claim that waited for the row would leave the exact window between two retries open.

---

## 4. Stop it

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" $A/turns/$TURN/stop
# {"turnId":"t_…","stopping":true}
```

Partial content is persisted on this path and **never** on a disconnect. A `409 turn_not_running`
means this API has no cancel handle for that turn — which includes a turn a channel or a schedule
started, because nothing in core records in-flight turns. The message says exactly that rather
than claiming the turn has finished.

---

## 5. Watch everything

```bash
curl -sN -H "Authorization: Bearer $TOKEN" "localhost:7420/v1/events?types=tool.call,tool.result"
```

```
event: stream.subscribed
data: {"agentId":null,"types":["tool.call","tool.result"],"chunks":false}
```

The first frame always reports the filter the server resolved. Naming `model.chunk` in `types`
turns tokens on by itself and the preamble says `implied` so you can see it happened. An unknown
type is refused:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "localhost:7420/v1/events?types=turn.ended"
# 400 {"error":{"code":"unknown_event_type","message":"No such event type: turn.ended.",
#   "hint":"Did you mean \"turn.end\"? …","field":"types"}}
```

This is the observability surface. **Core emits; consumers persist.** Core writes no rows it does
not own.

---

## 6. Ask what it is

```bash
curl -s -H "Authorization: Bearer $TOKEN" $A
```

```json
{
  "id": "minimal", "name": "Minimal", "status": "loaded",
  "model": "deepseek-v4-pro", "dialect": "nlt", "window": 393216,
  "tools": 40, "skills": 8, "schedules": 0,
  "entryPhase": null, "channels": [], "warnings": []
}
```

`entryPhase`, not `phase` — a phase is per *session*, so an agent hosting three conversations is in
three at once. The agent-level facts are where a new session starts and which names exist
(`phases`, present only when more than one is declared).

```bash
curl -s -H "Authorization: Bearer $TOKEN" $A/tools     # tags, mutating, trust, phase visibility
curl -s -H "Authorization: Bearer $TOKEN" $A/skills    # `configured` distinguishes "no skills block"
curl -s -H "Authorization: Bearer $TOKEN" $A/context   # the prompt the next turn would send
```

`/context` exists because "why did it do that?" is almost always a context question, and guessing
at it is how days get lost.

---

## 7. Or use the client

Everything above, typed, with the sharp edges handled:

```ts
import { createClient, DispachError } from "@dispach/client"

const client = createClient({ baseUrl: "http://localhost:7420", token: process.env.DISPACH_API_TOKEN })
const agent = client.agent("minimal")

const turn = await agent.send("what can you do?")
for await (const token of turn.tokens()) process.stdout.write(token)
```

`tokens()` excludes the model's reasoning from the reply and **refuses a truncated replay** rather
than returning a fragment that looks complete. `stream()` yields the full union when you need it.

```ts
const turn = await agent.send("the nightly build failed", {
    from: { id: "agent:ci-bot", kind: "agent" },
    idempotencyKey: crypto.randomUUID(),
})
if (turn.replayed) return  // a retry; the work was already done
```

See [`packages/client/README.md`](../packages/client/README.md).

---

## Errors

Always the same shape, and `code` is the part to branch on:

```json
{ "error": { "code": "unknown_tool", "message": "…", "hint": "…", "field": "tools.pinned[2]" } }
```

`hint` names the likely fix, and every reachable failure has one —
`packages/server/test/spec.test.ts` drives ten of them and asserts it. The full code table is in
[`04-SPEC-WIRE.md`](04-SPEC-WIRE.md#error-codes), and the same test asserts no code can ship
undocumented.

---

## What this surface deliberately does not do

Worth knowing before you design around it, because each of these is a decision rather than a gap:

| | |
| --- | --- |
| **No agent provisioning.** | An agent exists because a manifest is mounted. There is no `POST /v1/agents`. |
| **No outbound peer calls.** | `from` is the *inbound* half. Your agent reaching another one is a tool, not a route — and `allowFrom` is inbound-only, which is a separate recorded trap. |
| **No per-sender authorisation.** | `from` says who sent a message and confers nothing. A recipient acts under its **own** owner's grants, whoever asked. A sender cannot widen what your agent may do by declaring itself. |
| **No OpenAI-compatible surface.** | `/v1` is its own protocol. Nothing here answers `/v1/chat/completions`. |
| **One agent per container.** | `serve` takes one manifest. A second agent is a second service. |
| **No live reload.** | An agent's configuration is fixed for its process lifetime — the tool catalogue resolves once and the cached prompt prefix depends on it staying fixed. `POST /reload` answers `409` and says so. |
| **No CORS.** | The web UI is same-origin. A default `*` would be catastrophic on a loopback bind, where the spec permits omitting the token entirely. |
| **WebSocket is secondary, and Bun-only.** | Everything achievable over HTTP + SSE stays there. `/v1/ws` answers `501` under Node, which has no upgrade path without a dependency. |
