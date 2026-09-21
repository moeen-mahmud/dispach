# Changelog

## 0.1.1 — 2026-09-21

The first release was opened in a browser and every defect below came out of one sitting. Four of
the six were **one bug**, and the two features are the half of the web UI that was read-only by
design and should not have been.

```bash
npm i -g dispach@0.1.1
brew upgrade dispach
docker pull ghcr.io/moeen-mahmud/dispach:0.1.1
```

### The web chat works

**One reply per question, in order, once.** A live turn was opening **one event stream per React
render**. `client.agent(id)` returns a fresh object every call and the shell called it in its render
body, so every callback keyed on that identity was new each render, the reattach effect re-fired
with no cleanup, and each stream's `setState` committed a render that opened another — self-feeding,
bounded only by how long the turn took. Six concurrent streams folded into one transcript and one
*stateful* token filter, which is how a real reply arrived as `DoingDoingDoing good good good…` and
was then repeated eight more times. The arithmetic named it before the source did: the first
thinking block was 1068 characters and each repeat was 178, and 1068 = 178 × 6.

The fix is not only the memo. Subscription ownership moved out of the component into
`packages/web/src/lib/live.ts`, where a second stream for one turn is **refused** rather than merely
unlikely — because the memo stops today's loop and not the shape, and the next effect to gain a
dependency would reopen it. The reattach effect now aborts on cleanup, which also fixes a turn
started in one conversation appending rows into the next one.

**The permanent `Failed to fetch` banner** was the same bug: `/sessions` refetching per render until
the browser's per-origin budget ran out and started rejecting calls with a `TypeError`. It was
*permanent* because the error path never cleared on a later success.

**The transcript reads oldest-first.** The message page is newest-first by design, and the wire spec
documented the message shape and **no order at all** — so the CLI reversed it with a comment saying
why and the browser did not. The unstated contract was the defect; the order is documented now.

**An agent created over HTTP answers to one name.** `POST /v1/agents` returned the name where every
route keys on the slug, so creating "Milo" wrote `agents/Milo`, declared `id: milo`, returned
`{ id: "Milo", adopted: ["milo"] }`, and the browser compared those two and said **"written, and not
running"** about an agent that was running — with no error text, because there had been no error.

### You can change an agent from the browser

`GET` and `PATCH /v1/agents/:id/config` are the person's editor reached remotely: the same unfloored
fields `dispach config` offers, the same two confirmations, and the same single writer, so an edit is
checked against the schema, the schedule parser and the provider resolver before anything is
written. The panel is **generated from `SETTINGS` in core**, so it covers tools, policy, model,
limits, channels, delivery, schedules and the server block at once, and a field added there appears
with nothing to remember. Saving replaces the agent, because an agent's settings are fixed for its
instance's lifetime — and the reply reports the write and the application separately, so an edit
made during a turn is reported as written-and-pending rather than as a failure.

This is not `config_set` with a URL in front of it, and it is not a role. `config_set` is the
*agent's* editor and is floored, because an agent that could widen its own inbound gate could be
talked into it by the message it is reading. There are no users, teams or roles; the browser mints
itself an unscoped key because the browser is the owner.

Schedules gained create, enable, disable, delete and run-now — wiring client methods that had
existed with **zero callers** since they were written.

**One defect found by building that UI:** `PATCH` and `DELETE` on a schedule the *manifest* declares
answered `200` and were silently undone at the next boot, because reconciliation restores every
field from the file. The terminal had refused that since Phase 8; the API never learned to. Both
answer `409` now, and the panel shows which file owns a row rather than offering a button whose only
outcome is that refusal.

### `defineChannel` works

`PluginContext.defineChannel` is documented public API, implemented and conformance-tested, and it
had **never worked through the binary**. `Runtime.create` was always right — load the plugins, then
validate `channels[].type` against what they registered — but every CLI command pre-loads the
manifest first against the binary's static table, so a manifest naming a plugin-supplied channel was
refused before the plugin that would satisfy it was imported. It stayed invisible because `telegram`
arrives from the CLI's own table and never through the plugin path, so the central function of the
plugin spec had no in-tree consumer. It has one now, loaded by the real binary under `serve`.

The load also moved inside the skip-and-report loop, so a plugin that throws on import now makes one
discovered agent broken-and-skipped instead of taking the whole host down.

**And the docs stopped claiming a WhatsApp package that has never been committed on any branch** —
listed in the architecture tree, given a channel type and two fields in the manifest spec that no
code reads, and named in the package map in `CLAUDE.md`. The plugin spec's own example showed a
`defineChannel({…})` signature the implementation replaced with `(id, factory)`, while the same file
spelled it correctly forty lines down. `needs_input` and plugin middleware are now recorded as
having no producer and no first-party consumer, where a reader will find it.

### Under the hood

Versioning moves to Changesets, releasing `dispach` as one package: the siblings are ignored rather
than fixed, so one changelog is written instead of nine meaningless ones. The tag stays a human
action — a tag pushed by `GITHUB_TOKEN` triggers no other workflow, so letting `changeset publish`
create it would silently stop producing the binaries, the image and the formula with a green run.

The version guard moved with it. It compared `VERSION` against `packages/core/package.json`, which
under the new shape would have passed while `dispach --version` printed `0.1.0` for a `0.1.1`
release; it reads the published manifest now.

## 0.1.0 — 2026-09-21

The first release. A model-agnostic agent runtime that turns a stateless OpenAI-compatible
`/chat/completions` endpoint into an agent that lives in messaging channels, uses tools, remembers,
runs on a schedule, and delegates.

Installed as one package:

```bash
npm i -g dispach        # the command
brew install dispach    # or the formula, from the release
docker run ghcr.io/moeen-mahmud/dispach:0.1.0
```

and imported as one package:

```ts
import { createClient } from "dispach/client"
import type { AnyEvent } from "dispach/wire"
```

### What it does

**An always-on server, not a CLI that can serve.** Install and a server runs. Provision and the
agent is live — served, channels polling, schedules armed — with no second command. `dispach run`
and `dispach web run` are *views*: they attach to the host that owns the agent and start nothing.
`dispach stop <agent>` is the only off switch, and it persists across restarts.

**The loop.** A step loop with progressive five-stage compaction, phase-scoped tool visibility, and
a fixed context slot order that keeps the cache-stable prefix intact. NLT is the default tool
dialect rather than native function calling, on published data: +14.9pp accuracy and 93% fewer
critical errors across 14 models, and +24 to +43pp on small models specifically.

**Tools.** Shell and files with a policy engine and a hardline floor, web fetch and search with an
SSRF guard that checks every address DNS returned, and Composio called directly rather than through
MCP. A tool result carries a trust level, and the write gate — not a filter on instruction-like
phrasing — is what holds against prompt injection.

**Memory and skills.** FTS5 with BM25 scored in-process, not embeddings. Skills selected by the
harness rather than by the model, installable from GitHub catalogues.

**Channels.** Telegram, with an idempotent outbox whose delivery identity is derived rather than
generated, so a crash mid-send cannot double-post.

**Schedules.** Cron and interval, DST-correct by construction, with jitter that cannot compound and
a 24-day timer clamp that stops a 2036 reminder firing at boot.

**A wire surface.** 39 routes under `/v1`, machine-checked against `docs/04-SPEC-WIRE.md`, with SSE
streams, detached turns and reattach-by-id — so a browser refresh mid-generation loses nothing. A
generated OpenAPI document and a browser reference at `/docs`.

**Credentials.** Operator keys that can be scoped to agents, a session-key prefix, a capability set
and an expiry, so a platform can hand a browser a credential instead of proxying every call. Out of
scope answers `404`, never `403`. It is not an identity system and does not want to be.

**A browser UI.** Chat, an agent picker, deep links, read-only panels for tools, schedules and
channels, and provisioning — served from the same process on the same port.

**A container.** `debian:trixie-slim`, non-root, a real home directory on one volume, with `git`,
`python3`, `uv` and `jq` on the PATH because the agent has a shell and its documented features need
them.

### Numbers, each reproducible from `evals/` or `scripts/`

| | |
| --- | --- |
| boot, process start → ready | 56 ms median, 17 ms of it inside `Runtime.create`; the budget is 1000 ms and CI fails at 1200 |
| the published package | 346 files, 2.5 MB packed, 7.9 MB unpacked |
| the compiled binary | 60-85 MB, four targets, ad-hoc signed on macOS |
| streaming | 108 chunks on a live turn at p50 0.0 ms between them |
| NLT vs native | +13.5pp on deepseek-chat, almost entirely on tasks whose right answer is to call nothing |
| phase scoping | 2/10 → 10/10 on a small-model benchmark subset with no model change |
| `estimateTokens` | runs 16-20% low on observation-heavy sessions; corrected from the endpoint's own `prompt_tokens` |

### Known limits, stated rather than discovered

- **Plugins are trusted in-process code.** `permissions` is advisory vocabulary in v1.
- **DNS rebinding is not covered** by the web-fetch SSRF guard: the check and the connection are
  separate resolutions, and pinning the checked address into the socket is not expressible through
  `fetch`. Said in three places rather than implied anywhere.
- **`PluginContext.defineChannel` does not work through the CLI.** Every CLI surface pre-loads with
  the built-in channel list, so a manifest naming a plugin-supplied channel is refused before the
  plugin that would satisfy it is imported. Carried in `docs/05-PLAN.md`.
- **An explicit `null` for an optional field is refused** where omitting it is fine. Deliberate: if
  `null` meant absent, a caller who wanted to clear a field would have no way to say so.
- **One agent per container is a deployment choice**, not a limit — a process hosts N agents — but a
  shared process means one agent's runaway `exec` starves the others.

### For anyone migrating from OpenClaw

`docs/12-OPENCLAW-CUTOVER.md` is the runbook and `docs/06-VELAOPS-INTEGRATION.md` is the argument
behind it. There is no compatibility adapter, deliberately: a runtime whose job is to be a better
OpenClaw cannot also be bug-compatible with it.
