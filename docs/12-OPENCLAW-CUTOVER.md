# 12 — Replacing OpenClaw with Dispach in VelaOps

A runbook. `06-VELAOPS-INTEGRATION.md` is the argument — why there is no compat adapter, what must
never enter core, and the call-by-call map. This file is the work: what to change, in what order,
and what breaks if a step is skipped.

**Read this if you are doing the migration.** Read 06 if you are asking why it is shaped this way.

Everything below was checked against a real agent in the shipped container on 2026-09-21, running
`dispach 0.1.0`. Where something was *not* exercised, it says so rather than implying it was.

---

## Before anything

Three facts that change how the rest reads.

**This is a cutover, not a coexistence.** An agent runs OpenClaw or it runs Dispach. There is no
adapter, no dual protocol and no per-call fallback — `agents.runtime` selects an image and a config
generator, nothing more. The reversal is a redeploy of that agent's container back to the old image,
which is why step 4 moves one agent at a time and why nobody is ever forced.

**The protocol is HTTP, not a socket.** OpenClaw's WS RPC on 18789 is replaced by `/v1` over
ordinary HTTP plus Server-Sent Events. There is no handshake, no subscription needed to start a
turn, and no connection that owns the work: `POST /messages` returns `202 {turnId}` with the turn
already running. That single change is what fixes generation dying on a browser refresh, and it is
also the thing most likely to be re-implemented wrongly by code carried over from the old client.

**One npm package.** `dispach` is the CLI *and* the client:

```
npm i -g dispach                                   # the command
npm i dispach                                      # the library

import { createClient } from "dispach/client"      # typed client, reattach, SSE
import type { AnyEvent } from "dispach/wire"       # the event schema, no runtime
```

There is no `@dispach/*` scope. `dispach/client` pulls in no terminal UI — that is asserted by the
package's own tests, because an HTTP client has no business costing the ~170-210 ms that importing
Ink and React does.

---

## Step 0 — a Dispach agent you can poke, before you change any engine code

Do this first and separately. It is twenty minutes and it makes every later step debuggable, because
you will have seen the runtime answer correctly at least once.

```bash
docker run --rm -it \
  -p 7420:7420 \
  -e DISPACH_API_TOKEN=dev-token-not-for-production \
  -e MODEL_ID=... -e MODEL_BASE_URL=https://your-litellm/v1 -e MODEL_API_KEY=... \
  -v "$PWD/my-agent:/agent" \
  ghcr.io/moeen-mahmud/dispach:0.1.0

curl -s localhost:7420/v1/ready
curl -s -H "authorization: Bearer dev-token-not-for-production" localhost:7420/v1/agents | jq
```

If you have no `agent.yaml` yet, make one on the host with `dispach init` and mount the directory it
writes. The container will not create one for you: `POST /v1/agents` is gated to a **loopback** bind
and the image binds `0.0.0.0`, deliberately — provisioning writes files and starts a process, and
that is not something a container's published port should offer.

**The one thing to check before moving on** is the context endpoint, because it is the answer to
almost every "why did it do that" you will have later:

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  localhost:7420/v1/agents/<id>/context | jq '.slots[] | {slot, label, tokens}'
```

You should see `workspace-volatile` with a non-zero token count. That is `MEMORY.md` and `USER.md`
actually reaching the model — the thing OpenClaw's two bootstrap caps silently truncated.

---

## Step 1 — the config generator

`openclaw-sync.ts` is deleted and replaced by something that writes `agent.yaml`. This is a
generator change, not a translation layer: nothing reads the old format.

```
openclaw.json                        agent.yaml
─────────────────────────────────    ─────────────────────────────
model: "openclaw/main"            →  model.main.{id, baseUrl, apiKeyEnv}
modelByChannel: {telegram: X}     →  channels[].modelOverride
delivery.channel + to             →  delivery.default + targets
agents.defaults.bootstrapMaxChars →  context.observationMaxTokens
bootstrapTotalMaxChars            →  context.window budgeting
memorySearch                      →  memory.{retriever, k}
subagents                         →  team
cron jobs (SQLite)                →  schedules
```

### Four rules the generator must follow

**Secrets are env var *names*, never values.** A manifest carrying a literal key fails validation —
this is enforced, not advisory. The LiteLLM virtual key reaches the container through the
environment exactly as it does today; `agent.yaml` names the variable:

```yaml
model:
    main:
        id: your-model-id                 # literal, not ${VAR} — see below
        baseUrl: https://your-litellm/v1  # literal
        apiKeyEnv: MODEL_API_KEY          # a NAME
```

**The model id is written literally, and that is deliberate.** Putting it behind `${MODEL_ID}` costs
three things: `readManifestHeader` does not expand variables, so every agent lists as `${MODEL_ID}`
and a picker cannot tell two apart; any `.env` on the machine changes the model *and* the
capabilities derived from its id; and `validate` then checks whichever agent the environment happens
to describe. Only secrets go behind a variable.

**The bootstrap-cap translation is lossy in the direction of correctness.** In OpenClaw, raising only
the per-file cap starved `MEMORY.md`. Dispach has one budget with per-slot accounting, so do not
port the two numbers — set the budget and then *verify* with `/v1/agents/:id/context` that
`MEMORY.md` lands. Assuming it does is how the original bug survived.

**Strip null-valued keys before writing, and before every POST.** An optional field that is *absent*
is fine; an optional field explicitly set to `null` is refused:

```
{"id":"x","kind":"every","expr":"1h","task":"t","deliver":"none"}                 → 201
{"id":"x","kind":"every","expr":"1h","task":"t","deliver":"none","role":null}    → 400
    schedule_invalid — role Invalid input: expected string, received null
```

This is the one place Dispach reproduces the shape of an OpenClaw gotcha, and it is a deliberate
refusal rather than an oversight: if `null` meant "absent", a caller who wanted to *clear* a field
would have no way to say so. The engine's serialiser almost certainly emits nulls for undefined
optionals today, so this will bite on the first schedule write. One line fixes it:

```ts
const clean = <T extends object>(body: T): Partial<T> =>
    Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) as Partial<T>
```

---

## Step 2 — the client swap

`openclaw-ws.ts` is deleted. `dispach/client` owns reconnect, SSE parsing and typed errors.

```ts
import { createClient, DispachError } from "dispach/client"

const dispach = createClient({
    baseUrl: `http://${container.host}:7420`,
    token: process.env.DISPACH_API_TOKEN,
})

const agent = dispach.agent(agentId)
```

### The shape that carries over wrongly

The old client owns the turn: you open a socket, send, and read the reply off the same socket, so
losing the socket loses the work. The new one does not, and **code written against the old model
looks like it works** — the reply arrives — right up until the case the old model got wrong.

```ts
// Start it. This returns as soon as the turn is accepted; the turn is already running.
const turn = await agent.send(text, { sessionKey })
// Park the id somewhere a refresh can find it. This is the whole fix.
await sessions.rememberLiveTurn(sessionKey, turn.turnId)

for await (const token of turn.tokens()) yield token
```

and on reconnect — a browser refresh, a pod restart, an engine deploy:

```ts
const live = await sessions.liveTurn(sessionKey)
if (live !== undefined) {
    // Not a replay from a buffer: the turn never stopped, and this attaches to it.
    for await (const token of agent.turn(live).tokens()) yield token
}
```

**Test the refresh-mid-generation case first.** It is the one behaviour the old client could not
have, so it is the one nothing in the existing code is shaped for.

### The call map

| OpenClaw | Dispach |
| --- | --- |
| WS `auth.token` on 18789 | `Authorization: Bearer` on every request |
| WS `subscribe` then chat | `POST /v1/agents/:id/messages` → `202 {turnId}` |
| Streamed reply on the same socket | `GET /v1/agents/:id/turns/:turnId/stream?chunks=true` |
| Terminal phase `"result"` | `turn.end` with a `reason` |
| Abort | `POST /v1/agents/:id/turns/:turnId/stop` |
| `/healthz` | `GET /v1/health` and `GET /v1/ready` — two questions |
| `cron.*` | `GET/POST/PATCH/DELETE /v1/agents/:id/schedules` |
| `[boot-phase]` stdout markers | the `runtime.ready` event, or delete the stepper |
| `mcp.update()` | nothing — Composio is called directly |

**`turn.end.reason` is not a boolean.** OpenClaw collapsed every ending into `"result"`. Dispach
distinguishes `final`, `stopped`, `timeout`, `max_steps`, `no_progress` and `truncated`, and the UI
should say which — a turn that hit its step budget currently renders identically to one that
finished, which is the failure the field exists to remove.

**Errors are typed and carry a `code`.** Branch on `code`, never on the message:

```ts
try { await agent.send(text, { sessionKey }) }
catch (error) {
    if (error instanceof DispachError && error.code === "agent_turn_in_flight") { /* retry */ }
    throw error
}
```

---

## Step 3 — the container

| | OpenClaw | Dispach |
| --- | --- | --- |
| image | your OpenClaw tag | `ghcr.io/moeen-mahmud/dispach:0.1.0` |
| port | 18789 (WS) | 7420 (HTTP + SSE) |
| the agent | `openclaw.json` | `agent.yaml`, mounted at `/agent` |
| state | wherever it was | a volume at `/home/dispach` |
| auth | `auth.token` handshake | `DISPACH_API_TOKEN` in the environment |
| health | `/healthz` | `GET /v1/ready`, which needs no token |

```yaml
services:
    agent:
        image: ghcr.io/moeen-mahmud/dispach:0.1.0
        ports: ["7420:7420"]
        environment:
            DISPACH_API_TOKEN: ${DISPACH_API_TOKEN:?}   # a non-loopback bind refuses without one
            MODEL_ID: ${MODEL_ID:?}
            MODEL_BASE_URL: ${MODEL_BASE_URL:?}
            MODEL_API_KEY: ${MODEL_API_KEY:?}
        volumes:
            - "./agents/${AGENT_ID}:/agent"
            - "dispach-home-${AGENT_ID}:/home/dispach"
        read_only: true
        tmpfs: ["/tmp"]
        init: true                                      # reaps what `exec` backgrounds
```

Three things that are not obvious.

**Do not set a `command:`.** The image's `CMD` carries `--host 0.0.0.0`, and a compose `command:`
replaces `CMD` wholesale — so adding one, even to pass a flag, silently drops the bind and the
container answers on loopback only, which from outside looks like a container that did not start.

**`/home/dispach` is a volume, not a tmpfs.** It holds the store, the skills cache and the uv cache.
On a tmpfs, a restart re-clones ~22 MB of skill catalogues and loses every conversation.

**`init: true` matters.** `exec` can background a child, and an unreaped pile of them once took a
machine to a load average of 351. The container's own shutdown reaps its children; `init` handles
the ones a hard kill leaves.

### Readiness

`GET /v1/ready` flips at `runtime.ready` — **before** channels connect. That is deliberate: a
Telegram outage must not read as an unhealthy container, or an orchestrator restarts the pod into
the same outage forever. Channel state lives on the agent resource:

```bash
curl -s -H "authorization: Bearer $TOKEN" localhost:7420/v1/agents/<id> | jq '.channels'
```

---

## Step 4 — credentials, if the browser talks to Dispach directly

Skip this if the engine proxies every call; the container token is enough.

A **scoped key** is how a platform hands a browser a credential without proxying. It narrows an
already-authenticated caller to some agents, a session-key prefix, a set of capabilities and an
expiry:

```bash
curl -sX POST localhost:7420/v1/keys \
  -H "authorization: Bearer $DISPACH_API_TOKEN" -H 'content-type: application/json' \
  -d '{"label":"web · user_8812",
       "scope":{"agents":["milo"],"sessions":"team_42:*","can":["chat","read"],"expiresIn":3600}}'
```

The secret comes back **once**. Four things to know before you build on it:

- **It is not an identity system.** No users, teams, orgs or roles, and there will not be. Better
  Auth stays authoritative. A scope supplies *isolation*; `from` on `POST /messages` supplies
  *attribution*. Those two together are enough for a collaborative app and neither is a user model.
- **Out of scope answers `404`, never `403`** — byte-identical to an id that does not exist, because
  a refusal that confirms existence turns a narrow key into a directory of your other tenants.
- **A session prefix is not a namespace.** `team_4` also matches `team_42:x`. Choose prefixes that
  cannot be prefixes of each other, and print back what a key matches when you mint it.
- **A browser WebSocket sends its credential in the subprotocol**, never in the URL:
  `new WebSocket(url, ["dispach.bearer", key])`. `?token=` still works and is deprecated; a
  credential in a URL lands in access logs, in a `Referer`, and in anything that proxies.

For a third-party page to call the API at all, add its origin to `server.allowedOrigins`. There is no
wildcard, deliberately.

---

## Step 5 — cut one agent over, then stop

```
1  Your own agent. New image, agent.yaml mounted, runtime: dispach.
2  Every row of the gotchas table in 06 against it. They are already verified against a
   reference agent; verify them against *yours*, because your manifest is different.
3  The engine's client swapped behind the same internal interface, so the UI does not
   change in the same commit as the protocol.
4  Opt-in for new agents. Existing agents untouched.
5  Default for new agents. Existing agents migrate on request, one redeploy each.
```

**Never force a migration.** An OpenClaw agent keeps working until nobody runs one.

### What you can delete once an agent is across

| | Why |
| --- | --- |
| `openclaw-ws.ts` | `dispach/client` owns reconnect, SSE and typed errors |
| `openclaw-sync.ts` | the generator writes `agent.yaml` |
| `composio-proxy` | Composio is called directly; there is no MCP in that path |
| the embed service | memory is FTS5 — no embeddings, no vector store |
| `use-boot-progress.ts` | boot is ~55 ms; the stepper existed because boot was slow |
| `check:openclaw` | the version pin inverts — you now pin your own dependency |

`stream-hub.ts` stays and gets simpler: reattach is a server-side guarantee rather than something
the hub reconstructs from a buffer.

---

## What breaks if you skip a step

| Skipped | What you see |
| --- | --- |
| Step 0 | Every later failure is ambiguous between your engine and a runtime you have never seen answer correctly |
| The null-stripping in step 1 | The first schedule write answers `400 schedule_invalid` naming a field you did set — to `null` |
| The reattach in step 2 | Everything works, and a browser refresh mid-generation loses the reply — the exact bug the migration was for |
| `turn.end.reason` in step 2 | A turn stopped by its step budget renders identically to one that finished |
| The volume in step 3 | Conversations vanish on restart and the skills catalogue re-clones every time |
| No `command:` in step 3 | The container binds loopback and looks, from outside, like it never started |
| Cutting more than one agent in step 5 | A failure that could have been one redeploy to reverse is now several |

---

## Where to look when something is wrong

```bash
# What the model was actually given, per slot, with token counts.
curl -s -H "authorization: Bearer $T" localhost:7420/v1/agents/<id>/context | jq

# Everything the runtime is doing, live.
curl -sN -H "authorization: Bearer $T" localhost:7420/v1/events

# What this agent resolved, and what it warned about at boot.
curl -s -H "authorization: Bearer $T" localhost:7420/v1/agents/<id> | jq '.warnings'
docker exec <container> dispach tools /agent/agent.yaml

# Whether the manifest is even loadable, with every derived number.
docker exec <container> dispach validate /agent/agent.yaml
```

`/context` answers "why did it do that" more often than anything else. It is the endpoint OpenClaw
had no equivalent of, and the reason most of these migrations get easier rather than harder.
