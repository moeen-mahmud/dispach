# Changelog

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
| boot to `runtime.ready` | 27 ms idle; the budget is 1000 ms and CI fails at 1200 |
| the published package | 345 files, 2.5 MB packed, 9.0 MB unpacked |
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
