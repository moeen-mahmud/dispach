# 09 — API guide

A worked walkthrough of the agent server, from `docker compose up` to a streamed reply.

This is the *guide*. [`04-SPEC-WIRE.md`](04-SPEC-WIRE.md) is the **contract** — every route, every
event, every error code, checked against the code by `packages/server/test/spec.test.ts`. When the
two disagree, the spec is right and this file is stale.

> **There is a generated reference now, at `/docs`.** The paragraph below still holds and is why:
> it argues against a *hand-written* description, and against a generator that produces a third
> account of a surface nobody checks. `openapi.json` is neither — its paths come from the router
> table and its bodies from the request schemas, and `spec.test.ts` fails when a registered route
> has no summary or a summary has no route. What has **not** changed is that response shapes are
> `@dispach/client`'s job: the document carries statuses and the error shape, and the types carry
> the rest. See decision 11.218.
>
> **Why there is no *typedoc* reference.** Phase 11 listed "API docs generated from types" as a
> deliverable, and this answers it deliberately without a generator. A typedoc build is a
> dependency with its own release cadence producing a third description of a surface that already
> has two — the spec, which is now machine-checked, and `@dispach/client`, whose types *are* the
> reference and are checked by `tsc`. A generated third copy would drift from both and look the
> most authoritative. Decision 11.10's dependency discipline, applied one package over.

---

## 1. Bring it up

```bash
git clone https://github.com/moeen-mahmud/dispach && cd dispach
cp .env.example .env          # then DISPACH_API_TOKEN. A model key is NOT required to start
docker compose up -d --wait
```

`--wait` blocks until the container's own healthcheck passes, which polls `/v1/ready`. Measured on
an arm64 Docker Desktop: **5.8 s** to healthy.

```bash
curl -s localhost:7420/v1/ready
# {"status":"ready","agents":0}
```

**Zero, and that is the supported first state.** This guide used to say `agents: 1` and point every
later command at a `minimal` agent, because compose once mounted the repository's own example — so
a fresh clone came up hosting a sample nobody asked for. It does not any more, and following the
old text got a `404` on every request. The API, the page at `/` and the reference at `/docs` exist
*before* there is anything to talk to, which is what makes provisioning through them possible.

Four routes need no token: `GET /v1/health`, `GET /v1/ready`, `GET /docs` and
`GET /v1/openapi.json` (plus the browser UI's own assets). A probe cannot hold a credential, and
the moment a reference is most useful is before you have one.

So make an agent. Either inside the container, or over the wire:

```bash
export TOKEN=$(grep DISPACH_API_TOKEN .env | cut -d= -f2-)

# the terminal way, onto the volume
docker compose exec server dispach init --user "you" --name milo

# or the wire way — GET /v1/provision lists every question, its `fallback` and its `choices`,
# generated from the same walk the terminal wizard performs, so the two cannot drift
curl -s -H "Authorization: Bearer $TOKEN" localhost:7420/v1/provision | jq '.steps[].step'
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"answers":{"user":"you","name":"milo","purpose":"…","preset":"openai",
       "model":"gpt-4o-mini","baseUrl":"https://api.openai.com/v1","apiKey":"sk-…",
       "system":"none","web":"none","composio":"none","telegram":"none",
       "skills":"none"}}' \
  localhost:7420/v1/agents
# → 201 {"id":"milo","dir":"/home/dispach/.dispach/agents/milo","adopted":["milo"], …}
```

`201` with `adopted: ["milo"]` means it is **already live** — served, channels started, schedules
armed — with nothing else the process hosts disturbed. `201` with `adopted: []` and an `error` means
the agent is on disk and not running, which is a success about the file and a failure about the
process; read `adopted`, not the status code. The returned `id` is the **slug**, which is what every
route keys on: a name of "My Bot" yields `my-bot`, and 0.1.1 fixed a bug where the route returned
the name instead and a browser then reported a running agent as not running.

```bash
export A=localhost:7420/v1/agents/milo
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
data: {"v":1,"ts":"…","runtimeId":"rt_…","agentId":"milo","turnId":"t_…","type":"turn.start","data":{"source":"api","inputTokens":10}}

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

## 4b. When it needs permission

A call the policy says to `ask` about — or a mutating call in a tainted turn under
`tools.untrusted.onMutate: "confirm"` — **suspends the turn** and announces itself:

```
event: approval.requested
data: {…,"turnId":"t_…","type":"approval.requested","data":{
  "approvalId":"a_mu2t…","slug":"memory_write","callId":"c1",
  "mutating":true,"reason":"memory_write changes something."}}
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" $A/approvals | python3 -m json.tool
# { "approvals": [ { "approvalId": "a_mu2t…", "slug": "memory_write", … } ] }

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"granted":true}' $A/approvals/a_mu2t…
# {"approvalId":"a_mu2t…","granted":true}
```

The turn resumes. Four things worth knowing, each of which exists because its absence was a gap:

**The runtime emits the event, not the front end.** So the question reaches the firehose, an audit
log, and a second operator watching the same session — not only the surface that draws prompts. The
envelope carries the turn, which is the correlation a UI needs.

**`GET /approvals` is the recovery path.** Refresh the page and the event is gone; the listing is
how a client discovers why a turn has visibly stopped. Same argument as turn reattach.

**`granted` has no default, in either direction.** A missing field would deny a call on a typo or
grant one on a malformed body, and neither is a decision anybody made — so a body the route cannot
read is a `400`.

**There is no approval timeout.** `limits.turnTimeoutMs` bounds the wait. An unanswered question
ends with the turn and reports `approval.resolved` with `by: "abandoned"` — which the model is told
as *"nobody declined it"*, because nobody did. The other two outcomes are `by: "approver"` (somebody
decided) and `by: "error"` (the approver itself broke, so the denial says nothing about what a
person wanted).

Nothing about a settled approval is kept, so a `404` covers answered-already, abandoned-with-its-turn
and never-existed alike. Watch `approval.resolved` if you need to take a prompt down for the right
reason.

```ts
for await (const item of client.events({ types: ["approval.requested"] })) {
    if (item.kind !== "event") continue
    const { approvalId, slug, match } = item.event.data
    if (await askTheHuman(slug, match)) await agent.approve(approvalId, true)
}
```

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
  "id": "milo", "name": "Milo", "status": "loaded",
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

## 6b. Change it

New in 0.1.1, and the part that is easy to get wrong in the other direction — this is **the
person's editor over HTTP**, not the agent's:

```bash
curl -s -H "Authorization: Bearer $TOKEN" $A/config
```

```json
{ "editable": true, "file": "/home/dispach/.dispach/agents/milo/agent.yaml",
  "settings": [
    { "path": "limits.maxSteps", "means": "tool calls allowed in one turn", "value": 40 },
    { "path": "tools.untrusted.onMutate", "means": "refuse | confirm | allow — …",
      "confirm": "Setting this to \"allow\" turns off the check that stops text from outside the conversation driving a tool that changes things. …",
      "value": "refuse" },
    …
  ] }
```

The list is generated from one table in core that the terminal's `dispach config` reads too, so
neither surface can offer a field the other does not. Three things about the shape:

- **`value` is the manifest's source text, unexpanded.** `${MODEL_ID}` comes back as `${MODEL_ID}`.
  An editor that showed the *loaded* value and wrote it back would bake the expansion in, turning a
  manifest that follows its environment into one that does not.
- **`value` absent means the file does not set the field** — which is not the same as set to
  nothing, and is what lets a control tell "unset" from "empty".
- **`confirm` appears on exactly two fields**, the two whose only purpose is to stop a check
  running. Show the sentence; do not send `confirm: true` until somebody has read it.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"limits.maxSteps","value":"12"}' $A/config
# {"path":"limits.maxSteps","before":40,"after":12,"reflowed":false,"applied":true}
```

**`value` is text**, exactly as it is typed at a terminal — a bare word, a number, `true`, a list as
`["a", "b"]`, a map as `{k: v}` — read by the same parser the `config` command uses. One parser,
because two would eventually disagree about whether `["a", "b"]` is a list of two strings.

**Read `applied`, do not assume it.** The file is written before the agent is replaced, and the
replace is refused while a turn is in flight, so a successful write can legitimately come back
`"applied": false` with the reason under `pending` — the edit then takes effect at the next start.
Returning a `409` there and implying nothing had happened would leave a written manifest described
as unwritten. `reflowed: true` means the source editor could not place the path and the document was
re-serialised: correct, and its comments have moved, which is worth a look at the diff.

Both routes are `admin`. That is not a role — there are no users, teams or roles here, and the
browser mints itself an unscoped key because the browser is the owner. It is the *person's* editor,
so nothing in it is floored; the **agent's** editor is the `config_set` tool and that one is, because
an agent able to widen its own inbound gate could be talked into it by the message it is reading.
Two fields are the person's alone and are not settable here at all: `channels[].allowFrom`, which is
a key inside a list entry and has its own action, and `tools.providers.<id>.writeRoots`.

Schedules are writable the same way, with one refusal worth knowing:

```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $A/schedules/morning-brief
# 409 {"error":{"code":"schedule_manifest_owned", …}}
```

A schedule the **manifest** declares is restored from the file by reconciliation at the next boot, so
a write here would be undone — which the route answered `200` to until 0.1.1. Change the
`schedules:` entry through `PATCH /config` instead, or create a separate schedule through
`POST …/schedules`, which is API-owned and fully editable.

---

## 7. Or use the client

Everything above, typed, with the sharp edges handled:

```ts
import { createClient, DispachError } from "@dispach/client"

const client = createClient({ baseUrl: "http://localhost:7420", token: process.env.DISPACH_API_TOKEN })
const agent = client.agent("milo")

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
| ~~**No agent provisioning.**~~ | **This is now wrong and is kept to say so.** `POST /v1/agents` exists (16.5), writes the directory, and the agent is live before the response returns. `GET /v1/provision` serves the question list. A caller may **not** choose the directory (`dir` and `dirChoice` are refused — the sandbox decides), may not have a secret read back, and on a server that required no credential and is reachable from the network the route needs a key carrying `admin`. |
| **No outbound peer calls.** | `from` is the *inbound* half. Your agent reaching another one is a tool, not a route — and `allowFrom` is inbound-only, which is a separate recorded trap. |
| **No per-sender authorisation.** | `from` says who sent a message and confers nothing. A recipient acts under its **own** owner's grants, whoever asked. A sender cannot widen what your agent may do by declaring itself. |
| **No OpenAI-compatible surface.** | `/v1` is its own protocol. Nothing here answers `/v1/chat/completions`. |
| **A second container is for isolation, not capacity.** | One process hosts N agents (decision 8.5), and the image's bare `serve` hosts **every enabled agent in the sandbox** — so `dispach init` inside the container is enough and no second container is needed to add one. What a second container buys is isolation: a shared process means one agent's runaway `exec` starves the others. It needs its own port *and its own home volume*, since two sharing one would share a `store.db` whose rows are keyed by agent id. This row used to say the image runs one agent, which was true of an earlier `CMD`. |
| **No approval history.** | A pending approval lives in the serving process's memory, because the thing it resolves is a suspended turn *in that process*. A row surviving a restart would describe a question nobody is still waiting on. |
| **No live *mutation*** — but reload and config edits work. | An agent's configuration is fixed for the lifetime of its **instance**: the catalogue resolves once and the cached prefix depends on that. So a change produces a **new instance** rather than a mutated one. `POST /reload` re-reads the manifest and answers `{id, status, adopted}`; `PATCH /v1/agents/:id/config` writes one field and then does the same replace. Both answer `409` while a turn is in flight, because tearing one down would close its store under a turn recorded as running — and the config route reports the write and whether it is in force *separately*, so an edit made during a turn is saved and applied at the next start rather than reported as a failure. |
| **No CORS.** | The web UI is same-origin. A default `*` would be catastrophic on a loopback bind, where the spec permits omitting the token entirely. |
| **WebSocket is secondary, and Bun-only.** | Everything achievable over HTTP + SSE stays there. `/v1/ws` answers `501` under Node, which has no upgrade path without a dependency. |
