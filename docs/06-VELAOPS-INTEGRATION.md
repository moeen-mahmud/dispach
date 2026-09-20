# 06 — VelaOps Integration

VelaOps is Dispach's first consumer and its most demanding one. That is useful — a
runtime with one real production consumer beats a runtime with none — and dangerous,
because the pressure to let VelaOps' concerns bleed into core will be constant, and you are
the only person who can refuse.

This document exists to make that refusal mechanical rather than a judgement call each time.

---

## The boundary

**Dispach is the process inside `velaops-{agentId}`. Nothing else.**

Everything in `apps/engine` stays where it is: the provisioner, `docker.ts`, `terminal.ts`,
`stream-hub.ts`, `litellm.ts`, `agent-keys.ts`, Traefik routing, MinIO backups,
`docker-socket-proxy`. Dispach replaces exactly one thing: the OpenClaw gateway process.

### What must never enter core

Write this list somewhere you'll see it during code review:

| VelaOps concern | Where it stays | Why |
| --- | --- | --- |
| Per-agent RSA-3072 `.pem` challenge | `lib/agent-keys.ts` | VelaOps' isolation model, not a runtime concern |
| LiteLLM virtual keys, budgets, 25% markup | `lib/litellm.ts` | Dispach sees a base URL and a token |
| Traefik labels, subdomain routing | `docker.ts` | Deployment topology |
| MinIO backup envelopes | `lib/backup.ts` | Storage policy |
| `velaops-net` DNS assumptions | compose | Network topology |
| Billing, entitlements, tier quotas | engine | Business logic |
| Better Auth sessions, user identity | engine | Dispach has no user model |
| `[boot-phase]` marker **format** | engine | Core emits `runtime.ready` with a `phases` breakdown; whatever wants a stepper subscribes and formats it |

The last one is the pattern for all of these. Core emits `runtime.ready` with a `phases`
breakdown; anything that wants `[boot-phase]` lines subscribes to `GET /v1/events` and formats
them. Core never learns that `boot-progress.ts` exists — and as it happens, boot is now fast
enough that the stepper is deletable rather than reformattable.

**The test:** if a feature request would make the runtime less useful to someone who has
never heard of VelaOps, it belongs in the adapter or the engine.

---

## Migration strategy — a cutover, not a coexistence

**There is no compat adapter, and that is a decision rather than a delay.**

The original plan was Phase 12: `packages/compat-openclaw`, a WS RPC server on 18789 reproducing
OpenClaw's protocol, so `apps/engine` could stay untouched and both runtimes could run side by side
per agent. That phase is **deleted**. The reasons, in the order they matter:

1. **It asks Dispach to impersonate the thing it replaces.** Every quirk in the table below — a
   model field that only accepts `openclaw/main`, `auth.token` rather than `auth.password`, a
   terminal phase called `result` rather than `end`, `teams` spelled `msteams` — would have to be
   reproduced *exactly*, including the ones that are bugs. A runtime whose job is to be a better
   OpenClaw cannot also be bug-compatible with it.
2. **The adapter is a second protocol to keep working.** `04-SPEC-WIRE.md` is now machine-checked
   against the code; an adapter would be a second surface with no such guard, and the one nobody
   checks is the one that drifts.
3. **`/v1` is a better target than the surface it would emulate.** Detached turns and reattach are
   core here, which is the fix for "generation dies on browser refresh" — a gotcha the adapter
   would have had to preserve the *shape* of while fixing the behaviour.
4. **Engine changes are smaller than the adapter.** The call-by-call mapping below is the whole of
   it: one client, typed, replacing a hand-rolled WS RPC client and its reconnect logic.

**The cost is real and is stated rather than hidden.** Without the adapter there is no incremental
path: an agent runs OpenClaw or it runs Dispach, and the switch is a redeploy of that agent's
container. The original plan budgeted for weeks of side-by-side dogfooding; this trades that for a
per-agent cutover that is reversible only by redeploying back. That is why this document has to be
good enough to act on, and why the sequence below moves one agent at a time.

```
Step 1   One agent — yours. `runtime: dispach`, new image, `agent.yaml` mounted.
Step 2   Every row in the gotchas table below, checked against it.
Step 3   The engine's OpenClaw client replaced by @dispach/client behind the same
         internal interface, so the UI does not change in the same commit.
Step 4   Opt-in for new agents. Existing agents untouched.
Step 5   Default for new agents. Existing agents migrate on request, one redeploy each.
Never    Forced migration. An OpenClaw agent keeps working until nobody runs one.
```

`agents.runtime` — `'openclaw' | 'dispach'` — still earns its place: it selects an image and a
config generator, not two protocols inside one process. What it no longer buys is a *shared* RPC
surface, so step 3 is a real piece of engine work rather than a no-op.

---

## The OpenClaw RPC surface, mapped onto `/v1`

Call by call. This is the table to work from in step 3.

| OpenClaw | Dispach | Notes |
| --- | --- | --- |
| WS `auth.token` on 18789 | `Authorization: Bearer` on every request | No handshake. The token is `server.tokenEnv`; a non-loopback bind refuses to start without one. |
| WS `subscribe` then chat | `POST /v1/agents/:id/messages` → `202 {turnId}` | The turn is already running when this returns. No subscription needed to start one. |
| Streamed reply over the same socket | `GET /v1/agents/:id/turns/:turnId/stream?chunks=true` | A separate connection **on purpose**: the turn is not bound to it, so a refresh reattaches with the same turn id. |
| Terminal phase `"result"` | `turn.end` event, with `reason` | `reason` distinguishes `final`, `stopped`, `timeout`, `max_steps`, `no_progress`, `truncated` — the states OpenClaw collapsed into one. |
| Abort | `POST /v1/agents/:id/turns/:turnId/stop` | Partial content persists on this path and never on a disconnect. |
| `x-openclaw-scopes` header | `scope` on `POST /v1/keys` | **Changed in 18.2, from a refusal to a mapping.** A key can be narrowed to agents, a session-key prefix, a capability set (`read`/`chat`/`write`/`admin`) and an expiry — so a platform can mint a browser-usable credential per end-user instead of proxying every call. A scope supplies *isolation*; `from` on `POST /messages` supplies *attribution*. It is **not** an identity system and must not be described as one: there are still no users, teams, orgs or roles, and "No user model. Better Auth stays authoritative" below is unchanged. |
| `/healthz` | `GET /v1/health`, `GET /v1/ready` | Two questions, deliberately: `/ready` flips at `runtime.ready`, **before** channels connect, so a Telegram outage does not read as an unhealthy container. Both need no token. |
| `cron.list` / `add` / `update` / `remove` | `GET/POST/PATCH/DELETE /v1/agents/:id/schedules` | Disabled schedules are listed by default. `POST …/:sid/run` fires one out of band. |
| `[boot-phase]` stdout markers | `runtime.ready` event, `phases` breakdown | Subscribe to `GET /v1/events` and format. Or delete the stepper: boot is ~55 ms. |
| Model hot-patch of `openclaw.json` | `agent.yaml` `model.main.id` + a restart | **Not a live reload** — see the warning below. |
| `mcp.update()` to rebind tools | — | No MCP in this path. Composio is called directly; a pinned slug resolves at boot. |
| Nothing equivalent | `GET /v1/agents/:id/context` | The assembled prompt with per-slot token counts. "Why did it do that?" is almost always a context question. |
| Nothing equivalent | `GET /v1/events` | Every lifecycle event, filterable. This is where `sub_agent_invocations` and `tool_calls` come from. |

> **`POST /v1/agents/:id/reload` replaces the agent; it does not hot-patch one, and it returns no
> diff.** Two rows of this document once promised that a channel change "applies on `reload`
> without restart" and that reload "returns a diff". Both were false. What is true since 17.1: the
> agent is **disposed and re-created** from its manifest, so it comes back as a new instance with a
> freshly resolved catalogue — `200 { id, status: "loaded", adopted[] }`. Nothing is mutated in
> place, because an agent's configuration is fixed for the lifetime of its instance: the catalogue
> resolves once and the cached prompt prefix depends on it staying fixed.
>
> Two consequences for engine code. A reload **during a turn** answers `409 agent_turn_in_flight`
> rather than aborting it, so a caller applying a config change has to retry rather than assume
> success. And the *sessions* survive — they are the store's, not the instance's — so this is not a
> container restart and does not need to be: at a ~55 ms boot either is cheap, but a reload leaves
> every other agent in the process untouched, which a restart does not. This document previously
> said reload "answers 409 and always will"; that sentence is withdrawn, and 409 is now the
> in-flight case only.

### Config translation

The provisioner emits `agent.yaml` instead of `openclaw.json`. There is no adapter reading the old
format, so this is a generator change rather than a translation layer.

```
openclaw.json                        agent.yaml
─────────────────────────────────    ─────────────────────────────
model: "openclaw/main"            →  model.main.{id,baseUrl,apiKeyEnv}   (LiteLLM base URL)
modelByChannel: {telegram: X}     →  channels[].modelOverride
delivery.channel + to             →  delivery.default + targets
agents.defaults.bootstrapMaxChars →  context.observationMaxTokens (converted)
bootstrapTotalMaxChars            →  context.window budgeting
memorySearch                      →  memory.{retriever,k}
subagents                         →  team
cron jobs (SQLite)                →  schedules
```

Two things to get right. The **bootstrap caps**: in OpenClaw, raising only the per-file cap starved
`MEMORY.md`. Dispach has one budget with explicit per-slot accounting, so the translation is lossy
in the direction of correctness — verify `MEMORY.md` actually lands via `GET /v1/agents/:id/context`
rather than assuming it. And **secrets are env var names, never values**: a manifest carrying a
literal key fails validation, so the LiteLLM virtual key reaches the container through the
environment exactly as it does today.

### What the engine actually changes

| File | Change |
| --- | --- |
| `openclaw-ws.ts` | Deleted. Replaced by `@dispach/client`, which owns reconnect, SSE parsing and typed errors. |
| `openclaw-sync.ts` | Deleted. The config generator writes `agent.yaml`. |
| `stream-hub.ts` | Kept, and simplified: reattach is now a server-side guarantee rather than something the hub reconstructs. |
| `docker.ts` | The image tag, the `/agent` and `/state` mounts, and `DISPACH_API_TOKEN`. |
| `composio-proxy` | Deleted. Composio is called directly, never through MCP. |
| the embed-service | Deleted. Memory is FTS5. |
| `use-boot-progress.ts` | Deletable. Boot is ~55 ms; the stepper exists because boot was slow. |
| `check:openclaw` | Deleted. The version pin inverts — see *Operational notes*. |

---

## Gotchas that become acceptance tests

`02-GOTCHAS.md` is an executable spec for the migration. Each row is a thing to check against a
real Dispach agent in step 2 — not against an adapter reproducing the old behaviour, which is what
makes the right-hand column a claim about the runtime rather than about a translation layer.

| VelaOps gotcha | Dispach behaviour to verify |
| --- | --- |
| Model field only accepts `openclaw/main` | `model.main.id` is the real model id, written literally — only secrets go behind `${VAR}` |
| Config silently rolls back on version skew | `apiVersion` mismatch fails loudly at boot |
| Two bootstrap caps truncate `MEMORY.md` | One budget; `/context` shows `MEMORY.md` present with token count |
| Channel change needs external gateway restart | Still a restart — but of **this** process, not an external gateway, and boot is ~55 ms. `POST /reload` answers `409` by design. |
| Plugin crash-loop from install-record trust gate | No runtime install, no trust gate; version mismatch fails by name |
| `dmPolicy: "open"` boots healthy, drops every DM | Incoherent channel config fails validation, not a warning |
| OpenAI-compat HTTP drops tool + thinking streams | One transport; thinking blocks replayed per capabilities |
| Cron in SQLite, CLI writes scope-denied | Cron is a first-class API and CLI resource |
| `cron.list` hides disabled unless asked | Disabled listed by default |
| `cron.add` rejects `payload.model: null` | Omitted optional fields are omitted, never null-rejected |
| Keyless implicit isolated crons hard-refused | Delivery validated at write with a specific error |
| 7.1 hard-fails boot on legacy memory layouts | Migrations are ours; layout changes are versioned |
| Reasoning models empty with `stopReason=length` | `maxOutput` from capabilities, never `window/4` |
| Tool count is a shared budget, writes starved | Explicit `budget.max` + `reserveWrite` |
| Dead slugs dropped silently | `resolve()` throws naming slug and provider |
| Composio MCP 405s the GET leg | No MCP in the Composio path — `composio-proxy` deleted |
| `mcp.update()` doesn't rebind tools | Not applicable; direct SDK |
| Tools vanish after rotating `COMPOSIO_API_KEY` | Key read from env at call time, not baked at create |
| Agent → LiteLLM TCP dies after 4–5h idle | Connection re-established per request; no warmup ticker needed |
| Generation dies on browser refresh | Detached turns + reattach are core |
| Tokens arrive in ~40ms clumps | Server sets `TCP_NODELAY` |
| Turn aborts at `stopReason=aborted` | `limits.turnTimeoutMs`, reported as `turn.end.reason=timeout` |
| `openclaw.json` regeneration must fire on deploy/reload/restart | Single load path, and one writer (`core/manifest/edit.ts`). No reload: a manifest change takes effect at the next boot, which `manifest_changed` says out loud. |

Step 2 is not done until each of these has been checked against a real agent, or has a recorded
and justified deviation. Several already have automated coverage in this repo — detached turns and
reattach, `resolve()` throwing on a dead slug, the reasoning-budget fix, disabled schedules being
listed — and those are the rows to spend the least time on.

---

## What VelaOps gains beyond parity

Not the pitch — the specific things that become possible once the runtime is yours.

**Container weight.** The current agent container runs the gateway, a Python embed-service
with model weights, the Baileys bridge, the Teams channel, and `composio-proxy`. Dispach
is one process. FTS5 replaces the embed-service, which is the single largest per-agent cost
line and the reason `EMBED_MODEL` exists. Direct Composio deletes `composio-proxy`. One
ingress port also resolves the unverified whatsapp-bridge/Teams 3978 collision flagged in
`01-SYSTEM-CONTEXT.md` §8.

**Free tier economics.** Free is "1 agent, auto-pause 7d idle" — a hibernation requirement
expressed as a business constraint. Sub-second cold start makes pausing invisible, which
makes aggressive auto-pause viable, which is where the margin is.

**The first-boot stepper becomes deletable.** `use-boot-progress.ts` exists because boot is
slow enough to need narration. Removing it is the visible proof the runtime changed.

**Model routing stops being a hot-patch.** `POST /api/agents/:id/model` currently
hot-patches `openclaw.json`. Against Dispach it's a manifest field.

**Upgrades stop being a treadmill.** `pnpm check:openclaw` guards a version pin on a
runtime you don't control. That constant disappears.

---

## What VelaOps must keep doing

Dispach does not replace these, and requests to make it do so should be declined:

- **Identity and auth.** No user model. Better Auth stays authoritative.
- **Cost control.** No budgets, no markup, no quotas. LiteLLM stays.
- **Isolation.** No opinion on containers. The `.pem` model stays.
- **Provisioning.** No agent lifecycle management. That is literally VelaOps.
- **Persistence beyond its own tables.** Core emits events; the engine subscribes and writes
  `sub_agent_invocations` and `tool_calls`. Dispach never writes to the `velaops` database.

That last one is the cleanest boundary in the whole design. Core owns its SQLite file inside
the container. Everything the platform wants to know arrives over `GET /v1/events`.

---

## Operational notes

**Verification stays Docker Compose.** The VelaOps standing mandate is unchanged for
engine-side work. Dispach itself has `bun test`, and those are different questions.

**Version pinning inverts.** Today `OPENCLAW_RUNTIME_VERSION` pins a foreign runtime and
`check:openclaw` asserts agreement. With Dispach, VelaOps pins a git SHA or version range
of its own dependency. Same discipline, but a bump is now a decision rather than an
emergency.

**Two runtimes means two debugging paths** for as long as both exist, and the cutover shape does
not remove that — it removes the *protocol* sharing, not the coexistence. An agent on OpenClaw and
an agent on Dispach are two systems to reason about until nobody runs the first. What changed is
that the boundary between them is now a container rather than an adapter, so a confusing failure
belongs to one of them rather than to the seam.

**The thing to watch during step 3.** The engine's OpenClaw client handles reconnect, and
`@dispach/client` handles it differently: a dropped stream is reattached by turn id rather than
replayed from a socket buffer, because the turn never stopped. Code written against the old model
will look like it works — the reply arrives — and then differ on exactly the case the old model
got wrong, which is a refresh mid-generation. Test that case first.
