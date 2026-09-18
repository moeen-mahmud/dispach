# Dispach

A lightweight, model-agnostic AI agent runtime.

Dispach turns a stateless OpenAI-compatible `/chat/completions` endpoint into an agent that
uses tools, remembers across sessions, acts on your machine under a policy you set, and lives in
messaging channels. Scheduling and delegation to other agents are designed and not yet built —
see Status. Bun-first TypeScript, Apache-2.0.

> To dispatch is to send a thing on its way with the authority to see it done — to decide
> what handles it, hand it over, and answer for the result.

## Status

**Pre-release, and it runs.** Install a single binary, or work from a checkout (both below).

Built and in use: the manifest and agent loop, the store and sessions, tools with the NLT and
native dialects, the tiered workspace, system and web tool providers with a policy engine, the
Telegram channel, the HTTP/SSE server, an idempotent outbox, launchd services, skills with two
catalogues, the full-screen TUI, the compaction ladder, phase-scoped tools, memory that carries
across sessions, and scheduling — cron, interval and one-shot, DST-correct, on one timer.

Also built since: the plugin API with all four middleware wrap points, supervisor delegation with
typed handoffs, the Docker image and a compose front door, a typed client, operator keys, approvals
over the wire, and a browser UI on the same origin as the API.

Not built yet: WhatsApp. `docs/05-PLAN.md` has every phase with its acceptance criteria and what is
ticked.

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

### Install the binary

One file, no Node and no `node_modules`. `bun build --compile` embeds the runtime, which is also
why it starts *faster* than a `node_modules` install — there is no module resolution left to do at
boot. Measured on an M-series mac, `validate --json`: **70–90 ms compiled against 90–110 ms through
Node**.

```bash
brew tap moeen-mahmud/dispach https://github.com/moeen-mahmud/dispach
brew install moeen-mahmud/dispach/dispach
```

Or take the asset straight from a release — `darwin-arm64`, `darwin-x64`, `linux-x64` and
`linux-arm64`, each with a `.sha256` beside it:

```bash
base=https://github.com/moeen-mahmud/dispach/releases/latest/download
curl -fsSL -O "$base/dispach-darwin-arm64"
curl -fsSL -O "$base/dispach-darwin-arm64.sha256"
shasum -a 256 -c dispach-darwin-arm64.sha256      # must print "OK"
chmod +x dispach-darwin-arm64
sudo mv dispach-darwin-arm64 /usr/local/bin/dispach
```

Download with `-O`, not `-o dispach`: the checksum file names the asset, so renaming before the
check makes `shasum -c` look for a file that is not there.

Two things worth knowing about the macOS asset, because the failure has no error message:

- **The release binary is ad-hoc signed, and it has to be.** A compiled Bun binary arrives
  *linker-signed*, which macOS refuses on exec — **exit 137 with no output at all**, which reads as
  a crash rather than as a policy. `codesign -dv` reports such a file as signed, so the obvious
  check passes on a binary that cannot run. The release re-signs every darwin asset, and
  `scripts/build-binary.ts` refuses to produce an unsigned one.
- **Gatekeeper still applies to a downloaded file.** A binary fetched with a browser carries a
  quarantine attribute; `xattr -d com.apple.quarantine dispach` clears it. `curl` does not set it.

### Or from a checkout

For working on Dispach itself. The order matters: `bin` points at `dist/`, so a link made before
the build points at nothing.

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

## Hosting with Compose

The one-command path. `docker compose up` brings up a server with an agent, an exposed API and the
**web UI on the same origin** — nothing to configure but a token and a model key.

```bash
cp .env.example .env               # then DISPACH_API_TOKEN and MODEL_API_KEY
docker compose up -d --build --wait
curl localhost:7420/v1/ready
docker compose logs agent          # the claim link — open it once to get a browser key
```

Then open `http://localhost:7420` and paste nothing: the claim link in the logs carries a one-time
token the page exchanges for a key it keeps. Reading the container's own output is what confers
first ownership, which grants nothing new to anyone who could already run `docker compose logs`.

**`--build` is not optional after the first run.** `image: dispach:local` names a tag, and compose
builds only when that tag is *absent* — so a second `up` reuses whatever was built before, reports
healthy, and serves it. Measured while writing this: a two-day-old image came up green and answered
every request from a binary that predated two whole phases. The recorded stale-`dist` hazard with a
container around it, and the same tell — everything works, nothing is current.

```bash
curl -s -H "Authorization: Bearer $DISPACH_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"what can you do?"}' \
  localhost:7420/v1/agents/minimal/messages
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

Four things in that file are answers to defaults that bite, and they are commented there rather
than left to be discovered:

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

The model reaches the container through the *environment* rather than through a `.env` beside the
manifest, which is the documented precedence: the ambient environment beats an agent's own file,
so an operator can configure the agent their container runs.

One agent per container **by choice, not by limitation**: `serve` accepts several manifests and one
process hosts N agents (decision 8.5), but a shared process means one agent's runaway `exec` starves
the others, so the image runs one. A second agent is a second service with its
own port, its own agent directory and **its own state volume** — a commented example in the
compose file shows the shape, including why sharing a volume would have two boots deleting each
other's schedules.

## Developing against the container

The container is the honest place to exercise an agent that has a shell, and not only for
containment. Every `exec` test in this repo otherwise runs on macOS, where the shell is a real
bash and `realpath` resolves `/var` through a symlink — the exact conditions the recorded
`$PWD`-comparison bug lived in. In the image it is busybox `sh` on Linux, with a different PATH
and different `realpath` semantics. Those have never been exercised until now.

```bash
cp .env.example .env                                  # token + a model key
echo 'AGENT_DIR=./examples/shell-agent' >> .env       # an agent that can actually run things
docker compose up -d --build --wait
```

Then the loop. `--build` on `up` rebuilds only what changed, and layer caching means a source-only
edit re-runs `bun run build` and nothing before it:

```bash
docker compose up -d --build --wait     # after any source change
docker compose logs -f                  # what it is saying
docker compose exec agent sh            # a shell in the container, as uid 1000
docker compose down                     # stop;  down -v also discards the home volume
```

Verified: `exec` runs inside the container as **uid 1000**, cwd `/agent/workspace`, with output
fenced as untrusted. What the agent's shell can reach is `sh`, `bash`, `git`, `python3`, `uv`, `jq`
and `curl` — `git` because the skills catalogue is fetched with it and its absence *deletes* that
feature rather than degrading it, `python3` and `uv` because a skill shipping scripts needs them.

What is **absent on purpose**, and asserted as such: no Bun and no Node, because the application is
one compiled binary; no `wget`, so there is one obvious HTTP client rather than two; and no pager
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
docker build -f docker/Dockerfile -t dispach .
docker run --rm -p 7420:7420 \
  --env-file examples/minimal/.env \
  -e DISPACH_API_TOKEN=pick-something \
  -v "$PWD/examples/minimal:/agent" \
  -v dispach-home:/home/dispach \
  dispach
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

The image is `debian:trixie-slim` and the runtime stage contains **one file** — the compiled binary.
No Bun, no Node, no `node_modules`. glibc rather than musl is deliberate and is about Python: PyPI's
C-extension wheels are `manylinux`, so on alpine anything without a `musllinux` build compiles from
source, and this image ships no compiler — a wheel would fail *inside a tool call*. Non-root as
`dispach` (uid 1000) — **a host directory bind-mounted at `/home/dispach` has to be writable by
uid 1000**, or the container starts and fails at the first turn with a permission error, which is
the worse moment to find out.

The healthcheck polls `/v1/ready`, which flips at `runtime.ready` — *before* channels connect,
deliberately. A Telegram outage must not read as an unhealthy container and get it restarted into
the same outage, so the probe answers "can it serve a turn" rather than "is everything connected".
Channel state lives on the agent resource instead.

Measured on an arm64 Docker Desktop, 2026-09-17, after the base-image change: the image is
**570 MB** against a 700 MB ceiling and `docker compose up -d --wait` reaches healthy in **5.7 s** —
the same as before, because readiness is tens of milliseconds in-process and almost all of that is
waiting for the first healthcheck probe. Where the size goes: 109 MB debian-slim, 180 MB of apt
packages (of which `git` alone is **92 MB**, because Debian's git pulls perl), 47 MB of `uv`, and
85 MB of compiled binary. `git` is the price of glibc and glibc is the price of Python wheels that
install rather than compile. The healthcheck reports healthy, an
unauthenticated write is refused with 401, `store.db` lands on the home volume owned by uid 1000,
and a real streaming turn against DeepSeek reconstructs from 26 `model.chunk` frames. The CI
`docker` job rebuilds and re-measures on every push, because a figure nobody re-checks is a figure
about one afternoon.

Two notes on reading those numbers. The size is `docker image inspect --format '{{.Size}}'`, which
is what the CI gate uses; `docker images` prints **180 MB** for the same image on the same machine,
a different accounting, so check which one a figure came from before treating it as a regression.
And the boot happened with a **deliberately invalid** model key — no network I/O before
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

Measured at **~53 ms** — 37 ms of interpreter and imports, 16 ms inside `Runtime.create` — and
checked on every phase rather than at the end:

```bash
bun run bench:boot
```

Reported with the machine state it was taken on, because without that a boot number is a number
about somebody's afternoon: the figure above is a 7-run median on an M-series laptop at a load
average of ~5, and the same tree measured 58 ms with four builds running beside it. The budget has
three orders of magnitude of headroom, so the reason to say this is not the arithmetic — it is that
a regression is only visible against a figure you can reproduce.

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

`dispach plugins <manifest>` prints what each plugin registered and what it declared, with that
last sentence repeated above the list. Declaring accurately costs nothing today and is the only
thing that will distinguish a plugin from a scramble when enforcement lands.

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
| `docs/09-API-GUIDE.md` | The agent server, walked through from `compose up` to a streamed reply |
| `packages/client/README.md` | The typed client — turns, streams, reattach, typed errors |
| `docs/07-SPEC-WORKSPACE.md` | Workspace file tiers, budgets, and prompt-style rendering |
| `CLAUDE.md` | The standing brief: hard rules and the hazards already paid for |
| `evals/` | Every performance claim, with the number and a script to reproduce it |

## License

Apache-2.0. Copyright 2026 Moeen Mahmud.
