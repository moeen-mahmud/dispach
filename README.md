# Dispach

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/moeen-mahmud/dispach/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/moeen-mahmud/dispach/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dispach)](https://www.npmjs.com/package/dispach)
[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/moeen-mahmud/badge.svg)](https://hub.xerj.org/contributors/moeen-mahmud)

**The agent backend your product calls over HTTP.** Open source and self-hosted: one API for agents
with memory, tools, schedules, channels and approvals, on any OpenAI-compatible model.

```bash
npm i -g dispach      # Node 24+, or: brew install moeen-mahmud/tap/dispach
# no Node? curl -fsSL https://github.com/moeen-mahmud/dispach/releases/latest/download/install.sh | sh
dispach init          # name the agent, pick a model, paste a key
dispach run milo      # talk to it in the terminal
```

![The terminal UI: told to give itself write access to the whole home directory, the agent tries, and the settings floor refuses](https://raw.githubusercontent.com/moeen-mahmud/dispach/HEAD/.github/assets/tui.gif)

Told to widen its own write access to `~`, the agent makes the call and the runtime refuses it: an
agent may grant itself abilities, never reach. That floor is measured in the research below.

Or run it as a server: one `docker run`, and [Call it over HTTP](#call-it-over-http) creates an
agent and streams its reply in three requests.

```bash
docker run -d --init -p 7420:7420 -v dispach-home:/home/dispach \
  -e DISPACH_API_TOKEN=pick-a-secret ghcr.io/moeen-mahmud/dispach:0.2.2
```

The named volume is where the store, every agent and every key live; without it a `docker rm` for
an upgrade starts empty. `--init` is there because `exec` backgrounds children and a child whose
parent is PID 1 has nothing to reap it.

**Research:** [*What May an Agent Change About Itself? A Containment Floor for Self-Configuring Agent
Runtimes*](https://arxiv.org/abs/2610.06274) (Hossain and Mahmud, 2026, preprint) measures the floor in
Dispach's settings tool: with it in place, 0 of 167 protected writes were saved, though the models
attempted one in 65 of those cases.

Your backend calls one API and Dispach runs the agents, each with its own memory and settings, on
infrastructure you control and on models as small as local ones. Every turn is detached and
reattachable, every write takes an idempotency key, and the wire contract is published as OpenAPI 3.1
and checked in CI. One process hosts many agents, and scoped keys fence each one off. TypeScript,
shipped on Node, Apache-2.0.

**Where it is going: the multiplayer agent runtime.** 0.2.0 gives every user and every team in your
product their own isolated runtime of agents. Those agents share rooms and memory with the people
they work for, and stand in for them, openly, when they are away. That half ships in 0.2.0 as
**experimental**: on the HTTP API and the browser console (no TUI screens yet), and it may change within 0.2.x.
Everything else described in this README is stable.

**Docs:** [dispach.blivius.com/docs](https://dispach.blivius.com/docs) ·
**New in 0.2.2:** [the changelog, with upgrade notes](CHANGELOG.md) ·
**New in 0.2.0:** [what changed and how to upgrade](developer-docs/runtime/whats-new-0-2-0.md) ·
**Limits:** [what is measured, and what it does not do](developer-docs/runtime/limits-and-evidence.md)

**Contributing:** start with a [good first issue](https://github.com/moeen-mahmud/dispach/labels/good%20first%20issue)
or the [larger pieces that need an owner](https://github.com/moeen-mahmud/dispach/labels/help%20wanted), and
[Start here](https://github.com/moeen-mahmud/dispach/discussions/38) for how a change gets in. The
[roadmap](https://github.com/moeen-mahmud/dispach/discussions/56) says what is planned and where Dispach is behind.

> To dispatch is to send a thing on its way with the authority to see it done — to decide
> what handles it, hand it over, and answer for the result.

## Call it over HTTP

![Starting the server, creating an agent over HTTP, and streaming its reply](https://raw.githubusercontent.com/moeen-mahmud/dispach/HEAD/.github/assets/quickstart.gif)

```bash
export TOKEN=pick-a-secret
docker run -d --init -p 7420:7420 -v dispach-home:/home/dispach -e DISPACH_API_TOKEN=$TOKEN \
  ghcr.io/moeen-mahmud/dispach:0.2.2

curl -s -H "Authorization: Bearer $TOKEN" localhost:7420/v1/agents \
  -d '{"answers":{"user":"you","name":"milo","apiKey":"sk-…"}}'
# → 201 {"id":"milo",…,"adopted":["milo"]}: live now, no restart

T=$(curl -s -H "Authorization: Bearer $TOKEN" localhost:7420/v1/agents/milo/messages \
  -d '{"text":"what can you do?","chunks":true}' | jq -r .turnId)
# → the turn runs whether or not you stay

curl -sN -H "Authorization: Bearer $TOKEN" "localhost:7420/v1/agents/milo/turns/$T/stream?chunks=true"
# → server-sent events: the turn as it happens, then turn.end with the final text
```

The defaults are OpenAI's. For another endpoint, add `"model"` and `"baseUrl"` to the answers, as the
recording above does with `deepseek-v4-flash`; `GET /v1/provision` lists every question with its
default and choices. To run it from a checkout instead, [Hosting with Compose](#hosting-with-compose)
has the `docker compose` version.

**[`docs/09-API-GUIDE.md`](docs/09-API-GUIDE.md) is the walkthrough**: provisioning over the wire,
streaming, reattaching after a dropped connection, approvals and keys. The reference is served at
`http://localhost:7420/docs`, the contract is [`docs/04-SPEC-WIRE.md`](docs/04-SPEC-WIRE.md), and
`dispach/client` is the typed client. The CLI and the full-screen terminal UI below are the same
runtime from a terminal.

## Benchmarks

The same 25 multi-turn tool tasks, run 5 times each, through three agent harnesses on identical tools
and pinned model providers, every harness in its own container. Graded on what the tools were left
holding, never on the reply's wording. Tasks passed out of 125, and the OpenRouter bill for the 125 runs:

<!-- benchmark:start -->
| Model | Dispach | Hermes 0.19.0 | OpenClaw 2026.10.5 |
| --- | --- | --- | --- |
| Claude Opus 5.5 | 125/125 (100%) · $2.05 | 119/125 (95%) · $2.24 | 105/125 (84%) · $7.10 |
| Claude Sonnet 5.5 | 125/125 (100%) · $0.80 | 120/125 (96%) · $1.76 | 105/125 (84%) · $4.21 |
| Claude Haiku 5.5 | 124/125 (99%) · $0.06 | 120/125 (96%) · $0.07 | 102/125 (82%) · $0.21 |
| GPT-6.1 Sol | 125/125 (100%) · $0.54 | 120/125 (96%) · $0.53 | 95/125 (76%) · $1.73 |
| Gemini 4 Argon | 119/125 (95%) · $2.29 | 123/125 (98%) · $2.79 | 108/125 (86%) · $5.47 |
| GLM 5.3 | 125/125 (100%) · $0.80 | 123/125 (98%) · $1.18 | 98/125 (78%) · $4.86 |
| DeepSeek V4 Pro | 125/125 (100%) · $0.31 | 120/125 (96%) · $0.50 | 96/125 (77%) · $2.83 |
| Kimi K3 | 115/125 (92%) · $2.24 | 115/125 (92%) · $2.36 | 98/125 (78%) · $10.27 |
| Gemma 4 26B-A4B | 112/125 (90%) · $0.24 | 108/125 (86%) · $0.41 | 91/125 (73%) · $2.95 |
| qwen3.5-9b | 104/125 (83%) · $0.18 | 112/125 (90%) · $0.42 | 60/125 (48%) · $0.78 |
| gpt-oss-20b | 97/125 (78%) · $0.05 | 111/125 (89%) · $0.10 | 51/125 (41%) · $0.12 |
<!-- benchmark:end -->

One benchmark of our own design, each harness on its own documented defaults; with 125 runs an arm a
gap of a few runs is noise. Hermes leads on Gemini 4 Argon and the two small open models, and the
[benchmark README](evals/harness/README.md) says why, with every run and reply committed.

## Status

**0.2.2**, from npm, Homebrew, the container image or the standalone installer. Every install
runs under Node. [`CHANGELOG.md`](CHANGELOG.md) has what landed in each release.

Built and in use:

- **Core runtime:** the agent loop with the NLT and native tool dialects, the manifest, the tiered
  workspace, the compaction ladder, phase-scoped tools, memory that carries across sessions, skills
  with two catalogues, and scheduling (cron, interval and one-shot, DST-correct).
- **Serving and API:** the HTTP/SSE/WS server with detached turns, the typed client, scoped operator
  keys, approvals over the wire, and provisioning an agent over HTTP with no restart.
- **Models:** any OpenAI-compatible endpoint, AWS Bedrock through a pluggable transport, fallback
  models, vision input, and replayed signed thinking.
- **Channels and tools:** Telegram and WhatsApp (the latter a bundled plugin, with a warning;
  [see below](#whatsapp)), the plugin API with all four middleware wrap points, system and web
  tool providers under a policy engine, remote MCP servers, and subagents.
- **Coordination and delivery:** supervisor delegation with typed handoffs, and an idempotent
  outbox.
- **Front ends and hosting:** a browser UI on the same origin as the API, the TUI, launchd
  services, the Docker image with a compose front door, Kubernetes, and `GET /v1/backup` for the
  whole sandbox.

**Experimental in 0.2.0**: rooms, stand-ins and team memory; the Slack, Microsoft Teams and A2A
channels; and media (transcription, image generation, spoken replies). The first three and the
channels have screens in the browser console since 0.2.2 (People, Rooms, Actions, Memory,
add a channel); media is still API-only.

**MCP is a tool provider, never the substrate** (decision 4.7): remote servers over Streamable HTTP,
their tools pinned by name like any other provider's. Composio is still called directly.

`docs/05-PLAN.md` has every 0.1.x phase with its acceptance criteria and what is ticked.

## Scope

An agent harness is a runtime layer with four necessary and sufficient elements:

1. **An agent loop** — model call, tool execution, observation, repeat
2. **A tool interface** — resolution, validation, execution
3. **Context management** — assembly, budgeting, progressive compaction
4. **Control mechanisms** — phases, limits, cancellation, scheduling

Anything outside those four is a plugin, not core. Dispach is not an orchestration graph,
a workflow engine, a RAG pipeline, a vector database, or a model gateway.

## Design commitments

The ones that would otherwise look like mistakes:

- **`init` writes native function calling where the model supports it, and natural-language tool
  calling (NLT) otherwise.** On the multi-turn harness benchmark native tied or beat NLT on every
  model; NLT fell to 50–68% on four, by announcing a call and not making it
  ([`evals/harness`](evals/harness/)). NLT still wins a single-call test (37 fixtures, no tool
  executed, [`evals/tools`](evals/tools/)), and a 14-model replication reports +14.9pp for it
  ([arXiv 2607.03953](https://arxiv.org/abs/2607.03953)) that did not reproduce on multi-turn work here.
  A manifest without a `dialect` line keeps NLT, as it always has.
- **The tool dialect is config and never auto-detected.** Behaviour must not change silently
  when the model changes.
- **Tools are pinned at load, not searched at runtime.** Search-then-execute is two-hop
  reasoning, which is where small models fail.
- **Compaction is progressive and harness-driven** — five stages from 60% context pressure,
  not one lossy summarise at 95%.
- **Memory is SQLite FTS5, not embeddings.** No model weights, no embedding service, no
  network in the memory path.
- **Zero network I/O before readiness.** Channels connect after `runtime.ready` and report
  status via events.
- **Generation is detached from the client connection.** A browser refresh never kills a
  turn; reattach by turn id is in the wire protocol.

Full rationale for every decision, including the negative ones, is in `docs/00-DECISIONS.md`.

## Getting set up

### Install

**From npm**, which is one package carrying the command and the client:

```bash
npm i -g dispach          # the `dispach` command
dispach --version         # 0.2.2
```

and in an application that talks to a running server:

```bash
npm i dispach
```

```ts
import { createClient } from "dispach/client"
import type { AnyEvent } from "dispach/wire"
```

There is no `@dispach/*` scope, deliberately: the runtime is sixteen workspace packages (and a separately licensed control plane) under one name,
so there is one thing to install, one thing to version and one thing to trust. `dispach/client`
pulls in no terminal UI — asserted by the package's own tests, because an HTTP client has no
business paying the ~170-210 ms that importing Ink and React costs.

### Or without Node

```bash
curl -fsSL https://github.com/moeen-mahmud/dispach/releases/latest/download/install.sh | sh
```

macOS and Linux (glibc), arm64 and x64. Each release attaches one archive per platform: an official
Node 24, checked against nodejs.org's checksums, beside the same npm tarball the other installs use.
It is not a single compiled file on purpose — Bun can compile one, and Bun cannot complete the
WhatsApp handshake (see below), so what ships is Node. The script checks the archive against the
release's `SHA256SUMS`, unpacks it into `~/.dispach/versions/<version>`, links
`~/.dispach/bin/dispach`, and adds that directory to `PATH` in your shell's rc file, saying which.
Nothing needs root. Run it again to upgrade.

| Variable | Effect |
| --- | --- |
| `DISPACH_VERSION=0.2.2` | that release instead of the latest |
| `DISPACH_NO_MODIFY_PATH=1` | change no rc file; it prints the line to add |
| `DISPACH_INSTALL_DIR=<dir>` | install somewhere other than `~/.dispach` |

An upgrade does not move a background server installed with `dispach daemon install`, because the
service names the version directory it was started from; the script says so and keeps that
version, and `dispach daemon install` moves it. To uninstall, delete `~/.dispach/bin` and
`~/.dispach/versions` and the `PATH` line; your agents beside them in `~/.dispach` are left alone.

**Windows:** run it inside WSL (`wsl --install`), or use the container. A native build needs the
shell tool and the service manager ported; that is [open for contributions (#76)](https://github.com/moeen-mahmud/dispach/issues/76).

### Or with Homebrew

```bash
brew install moeen-mahmud/tap/dispach
```

The formula depends on `node` and installs the same npm tarball, so a brew install and an npm
install run identical code — one runtime, one artefact to checksum. (Until 0.1.3 the formula shipped
a Bun-compiled binary, and Bun cannot complete the WhatsApp handshake; see below.)

The name is fully qualified on purpose. Homebrew taps from it with no separate `brew tap`, and
naming a formula in full is *itself* what Homebrew accepts as consent to load a third-party tap —
`brew install dispach` after a plain `brew tap moeen-mahmud/tap` is the same install and refuses
until `brew trust moeen-mahmud/tap` is run, because a bare name carries no such consent.

`brew services start dispach` then runs the always-on server; `brew info` prints the rest.

### Or the container

```bash
docker pull ghcr.io/moeen-mahmud/dispach:0.2.2
```

The [Docker](#docker) and [Compose](#hosting-with-compose) sections below have the run lines and
the reasons behind them. The image is `node:24-trixie-slim` with `git`, `python3`, `uv` and `jq`,
because the agent has a shell.

### Or from a checkout

For working on Dispach itself. The order matters: `bin` points at `dist/`, so a link made before
the build points at nothing.

```bash
git clone https://github.com/moeen-mahmud/dispach && cd dispach
bun install
bun run build                       # builds every package the binary imports
cd packages/cli && bun link         # puts `dispach` on your PATH
cd ../..

dispach --version                   # 0.2.2
dispach --help
```

Four things that are not obvious:

- **`bun link` symlinks the checkout**, so `~/.bun/bin/dispach` resolves to
  `packages/cli/dist/index.js` in your working tree. Re-run `bun run build` after a change and the
  command picks it up; you never re-link. If `dispach: command not found`, `~/.bun/bin` is not on
  your `PATH` — Bun's installer adds it, and a shell opened before you installed Bun will not have it.
- **`bun run build` builds every workspace package, and you need all of them.** The CLI imports
  every provider package — tools, channels, the Bedrock transport, media — from their `dist`
  (`packages/cli/src/lib/providers.ts` is the list), so building only `core` and `cli` leaves the binary running yesterday's provider code — and the symptom is the
  worst kind: your change is correct, a test fails, and the stack trace points into a stale `dist`.
- **Node 24+ must be on your `PATH`.** The built entry's shebang is `#!/usr/bin/env node`; Bun builds
  it and Node runs it — the same runtime every install ships.
- **`DISPACH_HOME` relocates the whole sandbox.** Point it at a temporary directory and every agent,
  the store and the logs go there instead of `~/.dispach` — which is how to try things out, and how
  every test in this repo avoids touching a real one.

```bash
DISPACH_HOME=/tmp/sandbox dispach init      # a throwaway agent
DISPACH_HOME=/tmp/sandbox dispach run
```

You need one model endpoint. `init` asks which, writes the variable name into `agent.yaml` and the
key into a gitignored `.env` beside it — the manifest never holds a secret. Anything OpenAI-compatible
works, including a local Ollama, which needs no key at all.

## Quickstart

```bash
dispach init          # an interactive wizard: your name, the agent's name, an endpoint
dispach run milo      # agents live in ~/.dispach/agents — run them by name, from anywhere
dispach run           # or just this: picks from your agents, or walks you through creating one
```

`init` writes a complete starter agent — a reference-style manifest, a SOUL.md identity pair, an
AGENTS.md operations file, the tiered workspace, `.env` — and validates it with the real loader
before exiting. It asks for your API key at the prompt, masked, and writes it to the gitignored
`.env` beside the manifest; `agent.yaml` only ever names the variable. No flag accepts a key — one
passed on the command line lands in shell history — so a scripted run
(`init --user Ada --name Scout --preset ollama --yes`) leaves the line blank and says where to fill
it in.

**`--preset` carries the endpoints worth not typing from memory** — OpenAI, Anthropic, DeepSeek,
OpenRouter, Groq, NVIDIA NIM, Ollama both local and hosted, and AWS Bedrock — and `custom` is a
first-class answer for anything else. Any OpenAI-compatible `/chat/completions` endpoint works,
because there is no provider branch in the transport: one POST, one body builder. What a preset
actually buys is getting the base URL's *shape* right, which is the part that is easy to get wrong.
It must end at the version segment; the runtime appends `/chat/completions` itself, so a URL copied
from a provider's docs with the full path is refused. Bedrock is the one preset that is not three
strings: `--preset bedrock --region eu-west-1` writes `api: bedrock-converse` and `options.region`,
no URL and no key variable, because credentials come from the AWS default chain (environment, a
named profile, the container or instance role). The web console's Models page offers the same list.

**You talk to an agent in one conversation, wherever you reach it.** `init` makes you the owner of
the agents it creates and writes `sessions.scope: owner`, so what you said on Telegram this morning
is in the web console's chat and the terminal's this afternoon, and each reply goes back to wherever
you asked. "New conversation" starts afresh on all of them at once. Strangers on a channel keep their
own conversations, and anything one of your agents saves about you is recalled by your others.
`dispach owner adopt <agent>` does the same for an agent made before 0.2.2
(`docs/23-SPEC-SESSIONS.md`).

Local Ollama and Ollama Cloud are **two presets on purpose.** Local needs no key, and the absent
`apiKeyEnv` is what makes the manifest omit the field and the provider send no `authorization`
header at all. The hosted endpoint needs one. With a single preset, choosing it and then editing the
base URL to the hosted endpoint — the obvious move — produced a keyless manifest with no route to a
key short of hand-editing the field back in.

**The HTTP API is on by default**, and there is no longer a question about it. It used to ask, and
default to *No*, which is asking whether you want the product: an always-on server is what this is,
and `run` and `dispach web run` are views that attach to it. `--server none` is the opt-out.

## Changing an agent afterwards

Nothing about an agent is fixed at `init`. `config` is the person's editor for it — the agent has its
own (`config_set`), and the two are deliberately not the same: what a tool may do is the agent's to
ask for, but where it writes, who may reach it and what address it listens on are yours.

```bash
dispach config milo                                 # a screen: every setting, edit in place
dispach config list milo                            # every setting, its value, and who may set it
dispach config set milo model.main.id deepseek-v4-pro
dispach config env milo MODEL_API_KEY               # prompted, masked, written 0600
dispach config allow milo @your_handle              # who a channel accepts messages from
```

Since 0.1.1 the **browser does the same job**, against a running server rather than a file on this
machine: `GET` and `PATCH /v1/agents/:id/config` are the same editor reached remotely, and the
Settings panel is generated from the one table in core that both surfaces read, so neither can offer
a field the other does not. It covers tools, policy, model, limits, channels, delivery, schedules and
the server block, asks the same two confirmations, and reports the write and whether it is *in force*
separately — an edit made while a turn is running is saved and applied at the next start rather than
being reported as a failure. Schedules are editable there too; one the manifest declares is shown and
refused, because reconciliation would restore it from the file at the next boot.

`config <agent>` with no action opens the editor, which covers the same fields plus one `allowFrom` row
per channel and every secret the manifest depends on — masked as you type, and never shown afterwards.
Each row is written when you confirm it, so there is no unsaved state to lose; a value the schema
rejects is refused with the schema's own words and nothing is written. `/config` inside a session opens
the same screen, and restarts the agent on the way out so the change is actually in force.

Every edit is placed in the file, re-validated against the real schema and only then written, so a
change that would stop the agent loading is refused instead of discovered at the next boot. Comments
and alignment survive. Two edits — replacing the deny rules, and turning the write gate off — say what
the guard does and ask before applying; nothing else asks.

An agent's settings are fixed for the lifetime of the process running it, so a change lands at the next
start and the command says so, naming the process holding it.

## Where things live

Agents created by `init` live in a sandbox under your home directory, and `run <name>` finds them
from anywhere:

```
~/.dispach/
  store.db          sessions, memory, the outbox — one database, shared
  agents/<name>/    agent.yaml, .env (0600), workspace/, skills/
  logs/<id>.*.log   what a background service wrote
  sources/          skill-catalogue clones, shared by every agent
```

A fresh sandbox holds only `agents/`. The store is created on the first turn, `logs/` by the first
background service, `sources/` by the first catalogue fetch — nothing is made speculatively.

**One database, shared by every agent, isolated by `agent_id` on every table.** Not accidental: the
schema was already keyed that way, and a per-directory default meant the same agent got a different
conversation history depending on which directory you happened to run it from. Two consequences worth
knowing before they surprise you:

- **The store, the logs and the service label are keyed by the manifest `id`; the directory is keyed
  by its own name.** They are usually the same and do not have to be. Two directories with one
  manifest id therefore *share* one conversation history — `run` lists both and says so, and
  `remove` refuses to delete either one's data rather than taking the other's with it.
- **Memory's full-text index is genuinely shared**, which is why ranking is computed in
  `rank/bm25.ts` rather than by SQLite: FTS5's own `bm25()` takes its statistics over the whole
  table, so one agent saving a note would have moved another agent's scores.

Removing an agent means a directory, rows in four tables, two log files and possibly a service, so
there is a command for it rather than a `rm -rf` and a list of things to remember:

```bash
dispach remove milo --dry-run   # exactly what would go, and nothing else happens
dispach remove milo             # shows the same listing, then asks for the name typed back
dispach remove --prune          # data left behind by an agent whose directory is already gone
```

## Keeping an agent up

`run` is a conversation and `serve` is a server: `serve` is the only command that binds a socket or
connects a channel, because a REPL that quietly started answering Telegram while you typed at it
would be a surprise — and because a messaging provider allows exactly one listener per token, so
the two would fight over your bot.

`serve` still dies with its terminal. So `init` asks whether to keep it running — the default is
yes — and puts the service up itself: one service hosts every agent in the sandbox, and the agent
just written is adopted by it before the wizard finishes. By hand, and afterwards:

```bash
dispach daemon install        # one service for every agent; checks it will boot first
dispach status                # the service, every agent, every channel — one screen
dispach restart milo          # reload one agent in place, after editing agent.yaml or .env
dispach restart               # the whole service
dispach logs -f               # the server's stderr; the same as `daemon logs`
dispach agents                # what the sandbox holds and who is serving it
```

If you want everything off — services *and* a `serve` you left in a tab three days ago — there is
one switch that needs to know nothing:

```bash
dispach stop            # every agent; --dry-run lists what it would stop first
dispach stop milo       # or just one
```

It asks each process to stop rather than killing it, because the graceful path is the only one that
reaps commands the agent left running in the background, and it *disables* each service as well as
unloading it — a safety switch that came back at the next login would not be one. `daemon start`
brings an agent back.

A configuration error stops the service **once** rather than restarting it forever — the generated
job restarts on a crash signal and on nothing else, so a missing token leaves a stopped service and
an explanation instead of a log file growing at one line every ten seconds. `status` prints the
exit code and the tail of stderr, and exits non-zero, so it is usable from a monitor.

The service definition contains no secrets, ever. `launchctl print` echoes a job's environment in
plaintext to any local process, so the agent reads its credentials from the `.env` beside its
manifest — which `init` writes `0600` — and the plist carries only `HOME`, `PATH` and the two brand
variables.

**Linux and containers.** On Linux `daemon install` writes a systemd **user** unit and prints the
two commands that start it — it does not run them, because nothing in this project's test
environment can execute `systemctl`, and a unit nobody has started is how a "supported" platform
turns out not to be. Mind `loginctl enable-linger`, or the unit stops with your last session. In a
container, the image's own `serve` is the process and the container runtime supervises it — it
handles SIGTERM, finishes the delivery in flight, and exits 0.

## Hosting with Compose

The one-command path. `docker compose up` brings up a server with **no agents**, an exposed API,
the **web UI on the same origin** and the API reference beside it — nothing to configure but a
token.

```bash
cp .env.example .env               # then DISPACH_API_TOKEN
docker compose up -d --wait        # pulls ghcr.io/moeen-mahmud/dispach, DISPACH_VERSION pins a tag
curl localhost:7420/v1/ready       # {"status":"ready","agents":0}
docker compose logs server         # the claim link — open it once to get a browser key
```

**Zero agents is the supported first state, not an empty one.** The API and the page exist before
there is anything to talk to, which is what makes provisioning through them possible at all — and
it is why no model key is required to start. An earlier version of this file defaulted to mounting
the repository's own `examples/minimal`, so a fresh clone came up hosting a sample assistant nobody
asked for; a sample is a thing you ask for. `http://localhost:7420/docs` is the reference, and
`/v1/openapi.json` is the document behind it — both unauthenticated, because the moment a reference
is most useful is before you have a credential.

An agent reaches the container two ways, and `serve` needs no argument for either:

```bash
docker compose exec server dispach init --user "<you>" --name milo   # inside, onto the volume
echo 'AGENT_DIR=./my-agent' >> .env                                  # or mount one; see the
                                                                     # commented block in compose
```

`init` leaves `MODEL_API_KEY=` empty in the agent's `.env` on purpose — filling it is step 1 of what
it prints. Until it is filled the server **names that agent as not served and stays up**, which it
did not always do: one half-provisioned agent used to exit the host, and `restart: unless-stopped`
turned that into a crash loop that took the API and the page down with it. A host does not get to
fail because one of N agents is misconfigured.

Then open `http://localhost:7420` and paste nothing: the claim link in the logs carries a one-time
token the page exchanges for a key it keeps. From there the page creates agents, holds a streaming
conversation with one, and changes its models, tools, schedules, channels, files and settings; it
also shows usage and every turn, and manages people, rooms, the actions queue, shared memory,
webhooks, backups and scoped keys. Reading the container's own output is what confers
first ownership, which grants nothing new to anyone who could already run `docker compose logs`.

**A plain `up` pulls the published image once and never again.** `image:` names
`ghcr.io/moeen-mahmud/dispach:${DISPACH_VERSION:-latest}` with `pull_policy: missing`, so a machine
that pulled `latest` last month keeps serving it until `docker compose pull`; pin `DISPACH_VERSION`
in `.env` to make an upgrade a visible edit. Working from a checkout, `up -d --build --wait` builds
this tree under the same tag — and then **`--build` is not optional after the first run**, because
compose builds only when the tag is *absent*, so a second `up` reuses whatever was built before,
reports healthy, and serves it. Measured while writing this: a two-day-old image came up green and answered
every request from a binary that predated two whole phases. The recorded stale-`dist` hazard with a
container around it, and the same tell — everything works, nothing is current.

```bash
curl -s -H "Authorization: Bearer $DISPACH_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"what can you do?"}' \
  localhost:7420/v1/agents/milo/messages
# → {"turnId":"t_…","sessionKey":"api:default"}
```

`docker-compose.yml` is at the repo root so a fresh clone needs no `-f`. The full wire surface is
in [`docs/04-SPEC-WIRE.md`](docs/04-SPEC-WIRE.md); `docker compose down` stops it and
`docker compose down -v` also discards the state volume.

Every compose subcommand reads `.env`, not just `up` — so passing the variables inline works for
`up` and then `logs`, `ps` and `down` fail on the same interpolation. Copy the file.

One thing the claim link cannot know: it is built from the port the server **bound**, which is
always 7420 inside the container. Set `HOST_PORT` to anything else and the link needs that port
substituted by hand.

Five things in that file are answers to defaults that bite, and they are commented there rather
than left to be discovered:

- **`name: dispach`.** Compose names a container `<project>-<service>-<n>` and takes the project
  from the *directory name*, a stale brand with nothing in the tree for `git grep` to find, since
  the string was never in a file. Set explicitly, it is `dispach-server-1` wherever you clone to.
- **No `command:` override.** The image's CMD carries `--host 0.0.0.0`; a compose `command:`
  replaces CMD wholesale, so adding one drops the host flag and the process listens on loopback
  *inside* the container, which no published port can reach.
- **A named volume at `/home/dispach`.** That is the agent's home, and the sandbox inside it is a
  laptop's: `~/.dispach/store.db`, `~/.dispach/agents/`, `~/.dispach/logs/`. A named volume inherits
  uid 1000 from the image; a host path keeps host ownership, and a non-root container cannot write
  its own home. It also holds the `uv` cache and the cloned skills catalogues, which used to sit on
  a tmpfs and be discarded on every restart.
- **`/agent` is read-write.** The skills cache and `memory_write` both write beside the manifest.
- **`stop_grace_period: 30s`.** The 10 s default can SIGKILL an outbox flush mid-write.

A **mounted** agent takes its model through the *environment* rather than through a `.env` beside
the manifest, which is the documented precedence: the ambient environment beats an agent's own
file, so an operator can configure the agent their container runs. Those three variables are
commented out alongside the mount they belong to — an agent created *inside* the container has its
own `.env` and needs none of them.

A second agent needs **no second container**: one process hosts N agents (decision 8.5) and a bare
`serve` hosts every enabled agent in the sandbox, so `dispach init` inside this one is enough. A
second container is for *isolation* rather than capacity — a shared process means one agent's
runaway `exec` starves the others — and it needs its own port and **its own home volume**, since
two sharing one would share a `store.db` whose rows are keyed by agent id and each boot would
delete the other's schedules while reporting success. A commented example in the compose file shows
the shape.

## Developing against the container

The container is the honest place to exercise an agent that has a shell, and not only for
containment. Every `exec` test in this repo otherwise runs on macOS, where the shell is a real
bash and `realpath` resolves `/var` through a symlink — the exact conditions the recorded
`$PWD`-comparison bug lived in. In the image it is Debian's `dash` as `/bin/sh` on Linux, with a different PATH
and different `realpath` semantics. Those have never been exercised until now.

```bash
cp .env.example .env                                  # token + a model key
# uncomment the /agent mount and the MODEL_* block in docker-compose.yml, then:
echo 'AGENT_DIR=./examples/shell-agent' >> .env       # an agent that can actually run things
docker compose up -d --build --wait
```

`AGENT_DIR` on its own does nothing now — the mount it feeds is commented out, so that no clone
comes up hosting an example. Uncommenting is the opt-in, and it is two adjacent blocks rather than
one because a mounted agent needs the model variables the server itself does not.

Then the loop. `--build` on `up` rebuilds only what changed, and layer caching means a source-only
edit re-runs `bun run build` and nothing before it:

```bash
docker compose up -d --build --wait     # after any source change
docker compose logs -f                  # what it is saying
docker compose exec server sh           # a shell in the container, as uid 1000
docker compose down                     # stop;  down -v also discards the home volume
```

Verified: `exec` runs inside the container as **uid 1000**, cwd `/agent/workspace`, with output
fenced as untrusted. What the agent's shell can reach is `sh`, `bash`, `git`, `python3`, `uv`, `jq`
and `curl` — `git` because the skills catalogue is fetched with it and its absence *deletes* that
feature rather than degrading it, `python3` and `uv` because a skill shipping scripts needs them.

What is **absent on purpose** (CI asserts Bun and the editors are missing): no Bun — the application is the published npm
package running under Node, exactly what a laptop runs; no `wget`, so there is one obvious HTTP client rather than two; and no pager
and no editor, because `exec` hands a child a file descriptor and never a TTY — anything that pages
or prompts blocks until its deadline and reads as a hung agent. The CI `docker` job asserts both
lists, that the image is glibc, that a C-extension wheel installs with no compiler present, that a
named timezone resolves, and that it still runs as uid 1000 with `$HOME` set.

### What containment the compose file adds

`tools.policy` decides *whether* a command runs. It does not decide *where*, and it cannot: a
write root does not bind `exec`, because `echo x > file` carries its target inside a shell string
nothing can inspect. So the deployment supplies the other half:

| | |
| --- | --- |
| `cap_drop: [ALL]` | The process is uid 1000 and binds 7420, above 1024. Nothing asks for a capability, so an empty set is the true requirement rather than a compromise. |
| `no-new-privileges` | A setuid binary cannot raise privileges. There should be none; this makes that a property rather than an audit. |
| `pids_limit: 512` | **A fork bomb is one `exec` call away.** `init: true` reaps children; only this bounds them. |
| `mem_limit: 2g`, `cpus: 2.0` | An agent asked to process a large file can allocate until the host swaps. Here it is OOM-killed and restarts, which is legible. |
| `read_only: true` | An immutable root filesystem. `/agent` and `/home/dispach` are mounts and stay writable — the skills cache and `memory_write` both need that. |
| `tmpfs` on `/tmp` | Where `exec` hands children a file descriptor rather than buffering their output. There used to be a second entry for `$HOME`, which meant a Python skill rebuilt its venv on every boot; `$HOME` is a volume now, so that trade is gone rather than accepted. |

`examples/shell-agent` is the agent to mount for this, and its README is blunt about the
consequence: run it on a laptop and the policy is the only boundary there is.

## Docker

```bash
docker pull ghcr.io/moeen-mahmud/dispach:0.2.2          # or build it: docker build -f docker/Dockerfile -t dispach .
cp examples/minimal/.env.example examples/minimal/.env  # then MODEL_API_KEY; only the example is tracked
docker run --rm --init -p 7420:7420 \
  --env-file examples/minimal/.env \
  -e DISPACH_API_TOKEN=pick-something \
  -v "$PWD/examples/minimal:/agent" \
  -v dispach-home:/home/dispach \
  ghcr.io/moeen-mahmud/dispach:0.2.2
```

The token is not optional and is not boilerplate. The image binds `0.0.0.0`, because a process
listening on loopback *inside* a container is unreachable through a published port — a container
that looks healthy, answers nothing, and gives no clue why. A non-loopback bind then requires a
token by design, and `serve` refuses to start without one rather than binding the world open.

A manifest goes at `/agent`, and the entrypoint links it into the sandbox as `primary` — so the
mounted agent is reachable by bare ref (`dispach validate primary`) and appears in the same listing
as anything `dispach init` creates inside the container. There is **one agents directory**, which
there was not before: the image used to set `DISPACH_HOME=/state`, so `init` wrote to `/state/agents`
while the CMD served `/agent`, and an agent created in the container was invisible to every listing.

The image is `node:24-trixie-slim` and the runtime stage installs **the published npm tarball** with
`npm i -g` — the container runs byte-for-byte what `npm i -g dispach` runs on a laptop. No Bun: it
is the dev toolchain, and the runtime that cannot finish a WhatsApp pairing. glibc rather than musl
is deliberate and is about Python: PyPI's
C-extension wheels are `manylinux`, so on alpine anything without a `musllinux` build compiles from
source, and this image ships no compiler — a wheel would fail *inside a tool call*. Non-root as
`dispach` (uid 1000) — **a host directory bind-mounted at `/home/dispach` has to be writable by
uid 1000**, or the container starts and fails at the first turn with a permission error, which is
the worse moment to find out.

The healthcheck polls `/v1/ready`, which flips at `runtime.ready` — *before* channels connect,
deliberately. A Telegram outage must not read as an unhealthy container and get it restarted into
the same outage, so the probe answers "can it serve a turn" rather than "is everything connected".
Channel state lives on the agent resource instead.

Measured on an arm64 Docker Desktop at 0.2.0: the image is **867 MB** (701 MB at 0.1.3; the static
`ffmpeg` for voice notes is 104 MB of the difference), and `docker compose up -d --wait` reaches healthy in about six seconds — readiness is tens of
milliseconds in-process and almost all of that is waiting for the first healthcheck probe. Where the
size goes: 110 MB Debian, 160 MB of Node (with npm and corepack, kept so the agent's shell has a
Node toolchain), 158 MB of apt packages (of which `git` alone is **92 MB**, because Debian's git
pulls perl), 47 MB of `uv`, and 58 MB for the installed package with `ink` and `react`. Node costs
about 75 MB more than the compiled binary it replaced in 0.1.3, and buys the one thing the binary
could not do: pair WhatsApp. The healthcheck reports healthy, an
unauthenticated write is refused with 401, `store.db` lands on the home volume owned by uid 1000,
and a real streaming turn against DeepSeek reconstructs from 26 `model.chunk` frames. The CI
`docker` job rebuilds and re-measures on every push, because a figure nobody re-checks is a figure
about one afternoon.

Two notes on reading those numbers. The size is `docker image inspect --format '{{.Size}}'`, which
is what CI reports on every push. Older Docker releases printed a much smaller figure under
`docker images`, a different accounting, so check which one a figure came from before treating it as
a regression. And the boot happened with a **deliberately invalid** model key — no network I/O before
`runtime.ready` is the rule this project exists for, and a container reaching healthy on a fake
credential is that rule visible from outside.

## Development

```bash
bun install
bun run build        # bun build + tsc --emitDeclarationOnly
bun test
bun run test:node    # core only, under Node's runner — proves the sqlite adapter
bun run lint         # biome, not eslint or prettier
bun run typecheck
bun run check:deps   # core imports nothing from a sibling package
bun run bench:boot   # must stay under 1000 ms
bun run bench:schedule  # 100 schedules on one timer — reports drift, does not assert it
```

Bun is the development toolchain: install, build and test. Everything shipped runs under Node 24+.

A few house rules that bite first, all enforced by tests rather than review:

- **The product name appears in exactly one source file.** No directory, type or variable contains it,
  so a rename stays one commit — use `scripts/rename-brand.ts`, never a hand edit.
- **`packages/core` imports nothing from a sibling package.** `check:deps` fails the build.
- **No `any`.** Prefer `Record<string, unknown>`, and a real interface over both.
- **Every error carries a `hint`.** A new error type without one fails review — the expensive part of a
  failure is almost never the failure, it is that the failure did not say what was wrong.
- **Nothing fails silently and exits 0.**
- **Tests are required for `packages/core`.** A harness is a state machine, a scheduler and a tool
  executor; those break in ways manual exercise does not reach.

`CLAUDE.md` is the standing brief — it is written for coding agents and is the fastest way to learn
the hazards this codebase has already paid for. `docs/00-DECISIONS.md` has the rationale for every
locked decision, including the negative ones, which are the ones most likely to look like mistakes.
Public pull requests are welcome; [`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor entry point.

## Boot budget

Process start → `runtime.ready` in under **1000 ms**, enforced in CI at 1200 ms. Every performance
number in this README has a row in [`evals/CLAIMS.md`](evals/CLAIMS.md) naming the file it comes from.

Measured at **~65 ms** at 0.2.0 — 45 ms of interpreter and imports, 21 ms inside `Runtime.create` —
and checked on every phase rather than at the end (it was ~53 ms at 0.1.3; the 0.2.0 packages
account for the difference):

```bash
bun run bench:boot
```

Reported with the machine state it was taken on, because without that a boot number is a number
about somebody's afternoon: the figure above is a 7-run median on an Apple M4 Pro at a load
average of ~3.3, and an earlier run of the same tree at a load average of ~5 measured 91 ms. The budget has
three orders of magnitude of headroom, so the reason to say this is not the arithmetic — it is that
a regression is only visible against a figure you can reproduce.

This single number is why the project exists: the gateway it replaced blocked for minutes on
network calls during hook initialisation, observed on our own deployment and not measured in
[`evals/`](evals/). Nothing here touches the network before readiness.

If you ever see a boot in the tens of seconds, check `uptime` before profiling. Twice it has been the
machine being saturated — once by orphaned shells this runtime had itself failed to reap — and not the
runtime being slow.

## Rebranding

The product name lives in exactly one source file, `packages/core/src/brand.ts`, from which
the env var prefix, state directory, npm scope, and manifest `apiVersion` are all derived:

```bash
bun scripts/rename-brand.ts acme --dry
```

## Plugin security posture

Stated plainly, because the alternative is someone assuming otherwise:

> Dispach plugins run in-process with full privileges. The `permissions` block is
> documentation, not a sandbox. Install plugins you trust, the same way you treat any npm
> dependency. Real isolation requires separate processes or V8 isolates, both of which cost
> the startup time and simplicity this project exists to preserve. If you need to run
> untrusted plugin code, run the whole agent in a container and treat that as the boundary.

`dispach plugins list <agent>` prints what each plugin registered and what it declared, with that
last sentence repeated above the list. Declaring accurately costs nothing today and is the only
thing that will distinguish a plugin from a scramble when enforcement lands.

### WhatsApp

Bundled, like Telegram — no `plugins add` step. But read this first: Baileys reverse-engineers
WhatsApp Web, WhatsApp's terms do not permit it, and there is no appeal path when a number is
banned — including during development. **Pair a spare number.**

`init --whatsapp connected --whatsapp-number <digits>` writes the channel with `pairWith` set to the
account's own number; pairing is then an eight-character code typed into the phone under *Linked
devices › Link with phone number*, offered where the number was typed. Afterwards:

```bash
dispach channels pair milo wa     # start a host if none is up, adopt milo, show the code, wait
dispach channels list milo        # what it is reachable on, and whether it is paired
dispach channels unpair milo wa   # forget the session
```

`pairWith` is the account the agent *runs as*; `allowFrom` is who may message it, and the paired
account is always admitted — `allowFrom` means who *else*. Numbers take a `+` and separators
anywhere they are typed.

`deviceName: milo` on the channel shows as `Google Chrome (milo)` under Linked devices. The left
half is fixed by the protocol; the bracket is yours. Some accounts refuse a non-standard name under
pairing-by-code — the refusal says so, and removing the field fixes it. New pairings only.

**It pairs under Node and not under Bun**, measured against the same bundle, which is why every
install of `dispach` runs under Node since 0.1.3. From a checkout under `bun run` the channel says
so at start rather than connecting to nothing in silence.

### Installing one

```bash
dispach plugins add <agent> moeen-mahmud/some-plugin --ref v1.0.0
dispach plugins list <agent>
dispach plugins remove <agent> some-plugin
```

`add` clones with git into `~/.dispach/plugins/<name>/`, loads it there to read its declarations,
prints them, and only then writes the `plugins:` entry — because a manifest naming a plugin that
will not load *does not load*, so writing the entry first would brick the agent and report success.
The verification is the same `conformance()` suite the plugin's own author runs.

**A plugin is one self-contained bundle.** Nothing is installed while this runtime runs (hard rule
5), so a tree that declares runtime dependencies and ships no `node_modules` is refused by name
rather than half-loading at your next boot. That rule is what makes the npm install and the
container — whose `node_modules` holds only the two declared dependencies — resolve a plugin
exactly as a checkout does.

What git costs, said rather than discovered: no version resolution and no integrity check. `--ref`
pins a tag or a commit, the resolved commit is recorded beside the code and printed by `plugins
list`, and the `dispachApi` gate checks **compatibility, not authenticity** — nothing here verifies
who published what. A local path is accepted too, which is how you test a bundle before publishing
it.

## Commands

Generated from the same `CommandSpec` table the parser and `dispach --help` use — by
`bun scripts/readme-commands.ts`, and a test fails when this copy is stale. It used to be
hand-written, and was missing five commands at once. `dispach <command> --help` has the flags.

<!-- commands:begin — generated by scripts/readme-commands.ts; do not edit by hand -->
| Command | What it does |
| --- | --- |
| `init` | create a new agent: manifest, workspace, and env files |
| `run` | start an interactive session — bare `run` picks from the sandbox |
| `schedules` | list schedules, when they next fire, and how the last run went |
| `sessions` | list stored sessions, or inspect one |
| `memory` | search what the agent remembers, or rebuild the index from the files |
| `config` | read and change an agent's settings, and fill in its secrets |
| `owner` | show who owns this machine's agents, or make an existing agent yours |
| `validate` | load and validate a manifest, then exit |
| `workspace` | check the workspace files against the authoring rules |
| `soul` | scaffold a hand-edited compact identity from a long-form document |
| `skills` | browse the catalogue and install — or list, scaffold, check one agent's skills |
| `sources` | the repositories skills come from: list, add, search |
| `channels` | what an agent is reachable on: connect, disconnect, set a credential, unpair |
| `plugins` | install a plugin, list what an agent loaded, or remove one |
| `agents` | the agents in the sandbox, and whether anything is serving them |
| `restart` | reload one agent on the running host, or restart the whole service |
| `status` | the service, the hosts, every agent and its channels — one screen |
| `logs` | the server's stderr tail — the same as `daemon logs` |
| `tools` | show the resolved tool catalogue, or fetch a remote provider's schemas into the cache |
| `serve` | run the HTTP API and connect the agents' channels |
| `credential` | mint, list and revoke operator credentials, optionally scoped |
| `keys` | press a chord and see the bytes, Ink's reading of them, and the intent |
| `terminal-setup` | teach this terminal to send shift+enter as a new line |
| `remove` | delete a sandbox agent: its directory, sessions, memory, logs and service |
| `stop` | stop one agent for good, or everything — named, it stays stopped across restarts |
| `start` | switch an agent back on, and have a running host adopt it now |
| `model` | ask the endpoint what it can actually do — window, output cap, prompt caching |
| `web` | open the browser view of a running agent |
| `daemon` | keep an agent serving in the background — starts at login, restarts on crash |
<!-- commands:end -->

## Documentation

| Doc | Contents |
| --- | --- |
| `docs/00-DECISIONS.md` | Every locked decision, with rationale |
| `docs/01-ARCHITECTURE.md` | Module map, loop, context assembly, compaction, boot budget |
| `docs/02-SPEC-MANIFEST.md` | `agent.yaml` — the configuration contract |
| `docs/03-SPEC-PLUGIN-API.md` | Plugin and middleware contracts |
| `docs/04-SPEC-WIRE.md` | HTTP/SSE surface and lifecycle event schema |
| `docs/05-PLAN.md` | Every phase with acceptance criteria, and what is ticked |
| `docs/09-API-GUIDE.md` | The agent server, walked through from `compose up` to a streamed reply |
| `packages/client/README.md` | The typed client — turns, streams, reattach, typed errors |
| `docs/07-SPEC-WORKSPACE.md` | Workspace file tiers, budgets, and prompt-style rendering |
| `docs/08-MEMORY.md` | How memory is stored, retrieved and injected, with the measured numbers |
| `docs/12-OPENCLAW-CUTOVER.md` | Moving off the runtime this one replaces |
| `RELEASING.md` | How a release is cut: the changelog, `bun run release`, and what the tag publishes |
| `CHANGELOG.md` | What changed in each release, in bullets |
| `developer-docs/` | Source of the public docs at `/docs`, for integrators and contributors |
| `site/` | The landing page and docs site, built with Next.js and Fumadocs |
| `CONTRIBUTING.md` | Public contribution policy and workflow entry point |
| `CLAUDE.md` | The standing brief: hard rules and the hazards already paid for |
| `evals/` | Every performance claim, with the number and a script to reproduce it |

## License

The runtime — every package this README describes, and everything published to npm, Homebrew and
the container registry — is **Apache-2.0**, and stays Apache-2.0. Copyright 2026 Moeen Mahmud.

**One directory is licensed differently: `packages/control`**, the control plane that places and
suspends one runtime per user, is **FSL-1.1-ALv2** (its own `LICENSE.md`). Anyone may use it,
commercially too, except to offer a competing hosted service, and each release becomes Apache-2.0
two years after it ships. It is never published with the runtime. It imports nothing from the
runtime and nothing in the runtime imports it — `bun run check:deps` enforces both directions, and
`verify:package` checks the npm tarball.
