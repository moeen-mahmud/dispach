# Changelog

Short bullets per release; the reasoning lives in `docs/00-DECISIONS.md`. `bun run release <version>`
turns the Unreleased section into a dated one, and the release workflow publishes that section as the
GitHub Release notes. See `RELEASING.md`.

## Unreleased

```bash
npm i -g dispach@0.1.3
brew upgrade moeen-mahmud/tap/dispach
docker pull ghcr.io/moeen-mahmud/dispach:0.1.3
```

### Node is the runtime, everywhere

- **Every install runs under Node**: the npm bin (as before), the Homebrew formula (now
  `depends_on "node"` and installs the npm tarball) and the container (`node:24-trixie-slim`, the
  same tarball via `npm i -g`). Bun stays the dev toolchain — install, bundle, test.
- **Compiled single-file binaries are dropped.** Bun cannot complete the WhatsApp handshake, so the
  brew and Docker installs carried a channel they could not pair. One runtime to reason about.
- `/v1/ws` works under Node. It answered `501 websocket_unavailable` there; with Node the only
  shipped runtime that had become "absent from every install". `ws` is the dependency.
- Image: 701 MB (was 542). Node costs ~75 MB more than the binary it replaces; ceiling moved to 800.
- `docker-compose.yml` pulls `ghcr.io/moeen-mahmud/dispach:${DISPACH_VERSION:-latest}`; `--build`
  still builds from a checkout.

### Pairing finishes the job

- **`init` starts the host, then pairs through it.** With the background service (now the default
  answer), the wizard puts the server up, has it adopt the new agent, and the WhatsApp code comes
  from that host — so when the phone accepts, the agent is already answering. No `serve` afterwards.
- **`channels pair <agent> <channel>` does the same**: starts a host if none is up, adopts the agent,
  shows the host's code, waits for the phone. Telegram reloads the agent on the live host after the
  token is written. Both print where to chat.
- `init --daemon service` **never installed the service** — it called the retired per-agent
  install, and the failure was swallowed. Fixed, and `service` is now the default answer.
- **Device name is opt-in**: `deviceName: milo` on the WhatsApp channel shows as `Google Chrome (milo)`
  under Linked devices. The left half is fixed by the protocol; some accounts refuse a non-standard
  name under pairing-by-code, and the refusal says so. Default stays `Google Chrome (Ubuntu)`.

### CLI

- `dispach agents` — bare, lists the sandbox: on/off, who serves it, or why it is broken.
- `dispach restart <agent>` reloads one agent on its host in place; bare, restarts the service.
- `dispach status` — the service, every agent, every channel and any pending pairing code, one screen.
- `dispach logs` — alias for `daemon logs`, flags and all.
- Slash commands in `--plain` mode went to the model as prose: `/config get x`, `/channels` and every
  other CLI command. Fixed; a guard now reads both input paths.
- `web` recommended `keys new`, which is the keyboard diagnostic. It is `credential create`. A guard
  now checks every `dispach <verb>` in a hint against the command table — and caught the generated
  manifest naming `dispach eval`, which was a script.

### Releases

- **Changesets are gone.** `CHANGELOG.md` is hand-written; `bun run release <version>` bumps the
  three version spots and dates the section; the tag publishes. `RELEASING.md` has the five steps.
- The workflow **fails by name** when `NPM_TOKEN` or `TAP_TOKEN` is missing — it used to skip the
  publish and go green. The formula is committed to `moeen-mahmud/homebrew-tap` automatically.
- The GitHub Release body is the changelog section; a tag with no section is refused before publish.

### Channels

- **WhatsApp is bundled**, like Telegram. No `plugins add` step — name the channel and it works.
- **Pairing is an 8-character code**, not a QR. `pairWith` names the account; omit it for a QR.
- `pairWith` is **not** `allowFrom`: the account the agent runs as, versus who may message it.
- **The paired account is always admitted.** `allowFrom` means who *else*.
- **The chat with yourself works.** The owner's `fromMe` messages were discarded as the agent's echo.
- **Numbers take a `+` and separators everywhere**; a literal comparison used to match nobody.
- LID-addressed chats report the phone number from `remoteJidAlt`.
- The code is shown by `channels list`, `status`, the `serve` banner, `GET /v1/agents/:id` and the web UI.
- **A second pairing code was requested mid-login**, clobbering the one about to finish. The guard
  keys on pair-success (`account`), not on `registered`.
- A refused pairing reconnected every second forever, burning codes; it backs off and stops after three.
- `channels <agent> [connect | disconnect | credential | unpair]`, and the matching routes. Credentials
  are write-only.

**Read this before pairing a number.** Baileys reverse-engineers WhatsApp Web. WhatsApp's terms do
not permit it and a banned number has no appeal. **Use a spare one.**

### Plugins

- `plugins add | list | remove` — a plugin can be installed. Three lookups: built-in → `~/.dispach/plugins/` → import.
- One self-contained bundle; `add` refuses a tree with unbundled runtime dependencies and runs `conformance()` first.
- `--ref` pins a tag or commit. No integrity check — the `dispachApi` gate is compatibility, not authenticity.
- **Breaking:** `dispach plugins <agent>` is now `dispach plugins list <agent>`.

### An agent starts if it can take a turn

- A broken channel, plugin, tool provider or pinned tool is a **warning**, not a refusal. Reported on
  `agent.warnings`, the `serve` banner, `GET /v1/agents/:id` and a browser panel.
- Still fatal: the model block, the schema, workspace files, the rule budget, a duplicate channel `id`.
- `validate` builds the tool registry the way `run` does.

### Serving

- **A taken port moves the server** to the next free one and says so. An explicit `--port` still refuses.
- **A failed turn says why.** The browser and `serve` render the `error` event like the CLI does.

### Fixes

- `channels list` said `connected` when it meant `enabled`, and `paired` for a `creds.json` Baileys
  writes before linking. It reports the manifest plus live host status.
- The QR is drawn in the browser instead of printed as base64.
- A transport whose `id` or `type` disagrees with its manifest entry is refused at load.
- `serve()` dropped its fifth forwarded option — a supplied capability answered `501`.
- `stop()` immediately after `start()` could hang the WhatsApp transport.
- The landing palette overflowed a 30-row terminal.
- `docs/03-SPEC-PLUGIN-API.md` documented a Channel interface that never existed.

## 0.1.2 — 2026-09-22

Four defects in creating an agent, all reported from use, and all of them the kind that reads as
working. Plus a shell command that could run in half.

```bash
npm i -g dispach@0.1.2
brew upgrade dispach
docker pull ghcr.io/moeen-mahmud/dispach:0.1.2
```

### The model id was a silent 37.5% downgrade

Reported as "deepseek v4.1 flash seems not working" — and it matched a row perfectly well. The
capability registry globs `*` and picks by **specificity**, so `deepseek-v4.1-flash` matched
`deepseek-v4*` (11 non-`*` characters) instead of the measured `deepseek-v4-flash*` (17), because
the registry cannot spell "v4.`<anything>`-flash" as a literal prefix. The agent budgeted against
**393,216 tokens against a measured 1,048,576**.

The part worth fixing is that *nothing said so*. `validate` printed `registry deepseek-v4*`, which
is what a precise match prints, and the boot warning only fires when no row matched at all — so a
family net and a measurement were indistinguishable. There is now a third provenance, `family`, with
its own warning that says a measured sibling may be one version segment away; and a guard asserts
that any pattern a longer one extends is marked as a net, which is what adding `deepseek-v4-flash*`
failed to do to the row beneath it.

**No pattern was added for v4.1 ids.** That would claim a measured number for something nobody has
probed — the same mistake inverted. `model probe <agent> --window` is the honest route.

### The endpoints people actually use

OpenRouter, Groq, NVIDIA NIM and Ollama Cloud join `init --preset`, and the flag's help text is now
derived from the table rather than written beside it, where it had drifted to five names against
nine rows. Any OpenAI-compatible endpoint always worked — there is no provider branch in the
transport — so what a preset buys is the base URL's *shape*: it ends at the version segment, and the
runtime appends `/chat/completions` itself.

Local Ollama and Ollama Cloud are **two presets on purpose**. Local needs no key, and the absent
`apiKeyEnv` is what makes the provider send no `authorization` header at all; the hosted endpoint
needs one. With a single preset, choosing it and editing the URL to the hosted endpoint — the obvious
move — left a keyless manifest with no route to a key.

Found in the same file: two validators iterated a hardcoded list of three roles while the loader
walks custom ones too, so a **custom role's** key and base URL were never checked — and those three
checks are the entirety of that field's validation.

### "Serve the HTTP API?" is not a question

It defaulted to **No**, so `--yes` and the provisioning route both produced an agent with its API
switched off. Which is asking whether you want the product: an always-on server is what this is, and
`run` and `web run` are views that attach to a live host and start nothing. The question is gone,
`--server none` is the opt-out, and the default moved to the funnel both paths pass through — because
a question removed without moving its default is how `init` once shipped agents with no key
configuration at all.

### A shell command cut in half is refused, not run

The NLT parser clears an open field on a blank line, deliberately, so prose cannot glue onto the
last value. It already caught a value spanning lines unwrapped, and a heredoc whose terminator never
arrived. What it could not catch is a value cut after a *single* line that looks complete:
`command: ./deploy.sh --stage` is valid, so nothing raised, the shell ran it, and the flags after
the blank line were delivered as the reply.

The obvious detector is unusable — that shape is **textually identical** to a call followed by an
ordinary reply, so firing on it would spend a repair on every model that omits `END`. The
discriminator is the **orphan `END`**: a closer with no block open can only mean the model believed
it was still inside the block the prose interrupted. Exact, and it needs no guess about the prose.
Replaying the committed corpus gives identical counts before and after: no regression, no false
positive, and a gap closed that no recorded attempt had exhibited.

### Under the hood

Phase 10A's seven acceptance boxes, unchecked under a `complete` header for a week, are ticked
against the test that covers each — with **the one that is genuinely still open left open**. Three
irreconcilable container image sizes are reconciled and re-measured at 542 MB (the README said 570;
the base image moves, which is why CI re-measures every push). A decision recording the image
ceiling as 350 MB was one renegotiation behind the 700 MB CI actually gates on. Two decisions shared
the number 7.7. And a `TODO` asked for messages written immediately below it.

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
