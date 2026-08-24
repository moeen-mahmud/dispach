# Dispach

A lightweight, model-agnostic AI agent runtime.

Dispach turns a stateless OpenAI-compatible `/chat/completions` endpoint into an agent that
uses tools, remembers across sessions, acts on your machine under a policy you set, and lives in
messaging channels. Scheduling and delegation to other agents are designed and not yet built —
see Status. Bun-first TypeScript, Apache-2.0.

> To dispatch is to send a thing on its way with the authority to see it done — to decide
> what handles it, hand it over, and answer for the result.

## Status

**Pre-release, and it runs.** Not published to npm during v0.1 — install it from a checkout
(below).

Built and in use: the manifest and agent loop, the store and sessions, tools with the NLT and
native dialects, the tiered workspace, system and web tool providers with a policy engine, the
Telegram channel, the HTTP/SSE server, an idempotent outbox, launchd services, skills with two
catalogues, the full-screen TUI, the compaction ladder, phase-scoped tools, and memory that
carries across sessions.

Not built yet: scheduling, the plugin API, WhatsApp, multi-agent delegation, and the Docker
image. `docs/05-PLAN.md` has every phase with its acceptance criteria and what is ticked.

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

- **Natural-language tool calling is the default dialect**, not native function calling.
  Published replication across 14 models: +14.9pp accuracy, 93% fewer critical errors, −25%
  tokens; +24 to +43pp on small models specifically. `native` is an explicit opt-in.
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

There is no published package yet, so the binary comes from a checkout. The order matters:
`bin` points at `dist/`, so a link made before the build points at nothing.

```bash
git clone https://github.com/moeen-mahmud/dispach && cd dispach
bun install
bun run build                       # builds every package the binary imports
cd packages/cli && bun link         # puts `dispach` on your PATH
cd ../..

dispach --version                   # 0.1.0
dispach --help
```

Four things that are not obvious:

- **`bun link` symlinks the checkout**, so `~/.bun/bin/dispach` resolves to
  `packages/cli/dist/index.js` in your working tree. Re-run `bun run build` after a change and the
  command picks it up; you never re-link. If `dispach: command not found`, `~/.bun/bin` is not on
  your `PATH` — Bun's installer adds it, and a shell opened before you installed Bun will not have it.
- **`bun run build` builds every workspace package, and you need all of them.** The CLI imports
  `tools-system`, `tools-web`, `tools-composio` and `channel-telegram` from their `dist`, so building
  only `core` and `cli` leaves the binary running yesterday's provider code — and the symptom is the
  worst kind: your change is correct, a test fails, and the stack trace points into a stale `dist`.
- **Node 24+ must be on your `PATH`.** The built binary's shebang is `#!/usr/bin/env node`; Bun builds
  it and Node runs it.
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

`serve` still dies with its terminal. On macOS:

```bash
dispach daemon install milo   # checks it will boot, then installs a LaunchAgent
dispach daemon status         # running? how many restarts? why did it stop?
dispach daemon restart milo   # after editing agent.yaml or .env
dispach daemon logs milo
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

**Linux and containers.** There is no `daemon` on Linux: nothing in this project's test environment
can run `systemctl`, and shipping a unit file nobody has executed is how a "supported" platform
turns out not to be. `daemon` there refuses and prints the `ExecStart=` line with the paths already
resolved, which is the part that is hard to get right by hand. In a container, run `serve` in the
foreground and let the container runtime supervise it — it handles SIGTERM, finishes the delivery
in flight, and exits 0.

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
```

Requires Bun. Node 24+ is supported as a soft goal, tested in CI, never a merge blocker.

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

## Boot budget

Process start → `runtime.ready` in under **1000 ms**, enforced in CI at 1200 ms.

Measured at **~79 ms** on an idle machine — 57 ms of interpreter and imports, 22 ms inside
`Runtime.create` — and checked on every phase rather than at the end:

```bash
bun run bench:boot
```

This single number is why the project exists: the runtime it replaces spends roughly four minutes on
network calls during hook initialisation. Nothing here touches the network before readiness.

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

## Commands

`dispach --help` prints this from the same table the parser uses, so the two cannot drift.
`dispach <command> --help` has the flags.

| Command | What it does |
| --- | --- |
| `init` | create an agent — manifest, workspace, env, validated before it exits |
| `run` | an interactive session; bare `run` picks from the sandbox |
| `serve` | the HTTP API and the agent's channels. The only command that binds a socket |
| `daemon` | install, start, stop and inspect a background service (macOS) |
| `stop` | stop everything — services and any loose `serve` |
| `remove` | delete an agent: directory, sessions, memory, logs, service |
| `config` | read and change an agent's settings, and fill in its secrets |
| `sessions` | list stored conversations, or inspect one |
| `memory` | search what an agent remembers, or rebuild the index |
| `skills` | browse the catalogues and install, or check one agent's skills |
| `sources` | the repositories skills come from: list, add, search |
| `tools` | the resolved tool catalogue, or warm a remote provider's cache |
| `validate` | load a manifest and report what it resolved to |
| `workspace` | check the workspace files against the authoring rules |
| `soul` | scaffold a compact identity file from a long-form one |
| `agents` | what one or more manifest *paths* produce |
| `keys` | press a chord and see the bytes, Ink's reading of them, and the intent |
| `model probe` | ask the endpoint what it can actually do — window, output cap, prompt caching |
| `terminal-setup` | teach a terminal to send shift+enter as a newline |

## Documentation

| Doc | Contents |
| --- | --- |
| `docs/00-DECISIONS.md` | Every locked decision, with rationale |
| `docs/01-ARCHITECTURE.md` | Module map, loop, context assembly, compaction, boot budget |
| `docs/02-SPEC-MANIFEST.md` | `agent.yaml` — the configuration contract |
| `docs/03-SPEC-PLUGIN-API.md` | Plugin and middleware contracts |
| `docs/04-SPEC-WIRE.md` | HTTP/SSE surface and lifecycle event schema |
| `docs/05-PLAN.md` | Every phase with acceptance criteria, and what is ticked |
| `docs/07-SPEC-WORKSPACE.md` | Workspace file tiers, budgets, and prompt-style rendering |
| `CLAUDE.md` | The standing brief: hard rules and the hazards already paid for |
| `evals/` | Every performance claim, with the number and a script to reproduce it |

## License

Apache-2.0. Copyright 2026 Moeen Mahmud.
