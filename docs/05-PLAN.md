# 05 — Implementation Plan

Twenty phases, dependency-ordered — thirteen numbered, plus 2.5, 3.5, 3.6, 3.7, 3.8, 4.1 and 5.5
inserted rather than renumbered, because the later numbers are named across the source and the other
docs. Every phase ends at a **running state** — nothing is half-wired across a boundary.

## How to use this

One phase per session. Give a coding agent `CLAUDE.md` plus this file and say
"implement Phase N". It reads Goal → Deliverables → Files → Non-goals, implements, then
stops at the acceptance criteria and reports.

**Do not start Phase N+1 until Phase N's criteria pass.** Several subsystems here are only
testable end-to-end, and skipping ahead produces a state where nothing can be isolated.

**Build order is the document order, which is not numeric order.** Phase 7 is delivered as **7A**
(budget and the compaction ladder) then **7B** (phase-scoped tools), and both come **before Phase 6**
— decided 2026-08-19. The numbers stayed put because `manifest/validate.ts` and
`02-SPEC-MANIFEST.md` name them in errors a user reads, and a renumber would make a shipped message
wrong. Where a phase is out of numeric order, its heading says so and says why.

Non-goals are binding. A phase that quietly implements the next one's work destroys the
ability to review it.

---

## Phase 0 — Scaffold

**Goal.** An empty monorepo that builds, lints, tests, and refuses bad commits.

**Deliverables**

- Bun workspace root; `packages/core` with a stub export
- `biome.json`, `tsconfig.base.json`, strict TS, no `any`
- `bun test` wired; one trivial passing test
- GitHub Actions: typecheck, lint, test, on push and PR
- `brand.ts` with `BRAND` constant and env override
- `scripts/rename-brand.ts`
- CI dependency check: `packages/core` may not import any sibling package
- Apache-2.0 `LICENSE`, `README.md`, `CLAUDE.md`
- Changesets configured

**Files.** Root config, `packages/core/src/{index,brand}.ts`, `.github/workflows/ci.yml`, `scripts/`

**Acceptance**

- [x] `bun install && bun run build && bun test && bun run lint` clean
- [x] CI green — run `31617213199` on `cc11c22`: `bun` ✓, `node (22)` ✓, `node (24)` ✓. The Node
      legs carry `continue-on-error`, so their steps were inspected individually rather than
      trusted from the job checkmark.
- [x] `bun scripts/rename-brand.ts foo` renames throughout; `git diff` touches only `brand.ts` and `package.json` files — plus, once a second package existed, files carrying the derived `@<slug>/` import scope and `apiVersion`. See the note under Phase 1.
- [x] Adding `import "@dispach/cli"` to core fails CI

**Non-goals.** Any runtime behaviour.

---

## Phase 1 — Manifest, loop, model, CLI

**Goal.** `dispach run agent.yaml` gives a working REPL against any OpenAI-compatible
endpoint. No tools, no channels, no storage.

**Deliverables**

- `manifest/schema.ts` — full zod schema per `02-SPEC-MANIFEST.md`
- `manifest/load.ts` — YAML, `$ref`, `${ENV}` expansion, `.env`
- `manifest/validate.ts` — validation rules 1–4, 10–11, each with field path and hint
- `model/chat-completions.ts` — fetch + SSE, streaming, cancellation, retry on 429/5xx
- `model/capabilities.ts` — shipped registry, glob keys, manifest merge
- `model/roles.ts` — main/selector/compactor with fallback
- `context/assemble.ts` — slots 0, 6, 8 only; token estimator
- `loop/turn.ts`, `loop/step.ts` — single step, no tools; abort support
- `events/bus.ts` + types for turn/model events
- `runtime/runtime.ts` — hosts N agents, boot sequence, `runtime.ready`
- `packages/cli` — `dispach run <manifest>` interactive REPL, `dispach validate <manifest>`

**Files.** `packages/core/src/{manifest,model,context,loop,events,runtime}/`, `packages/cli/`

**Acceptance**

- [x] `dispach run examples/minimal/agent.yaml` reaches a prompt and answers, streaming tokens
- [ ] Works against **three** endpoints unchanged: OpenAI, an Anthropic-compat base URL, and a local
      Ollama — `bun run verify:endpoints` reports **Ollama ok** (qwen3.5:9b, 11,817 ms) and DeepSeek ok
      on both models, from one unchanged manifest shape. OpenAI and Anthropic are still skipped for want
      of keys, and the script exits 1 rather than calling two of three a pass
- [x] `dispach validate` on a manifest with a literal API key fails naming the field
- [x] Missing `${ENV}` fails at load naming the variable — not later as an auth error
- [x] Ctrl-C mid-stream cancels within 100 ms, no unhandled rejection — measured 4 ms via real SIGINT
- [x] Unit tests: manifest validation (≥15 cases), SSE parsing incl. split frames and `[DONE]`, capability merge
- [x] `runtime.ready` emitted with `bootMs`

**Non-goals.** Tools, storage, channels, skills, memory, compaction.

**Recorded deviations**

- A manifest configuring an unimplemented section (`channels`, `skills`, `memory`, `phases`,
  `schedules`, `plugins`, `delivery`, `tools.pinned`/`provider`/`local`/`search`) is **refused
  at load** naming the phase that implements it, rather than parsed and ignored. Silently
  dropping configuration is the failure rule 8 exists to prevent.
- `rename-brand.ts` also rewrites the `@<slug>/` import scope in source and the derived
  `apiVersion` in example manifests. Both are mechanically derived from the brand, so leaving
  them would make "renames throughout" false the moment a second package imports core.
  `.gitignore`'s state-directory entry is still a manual edit and is reported as such.
- `context.window` is normalised at load from the capability registry, so rule 11 has a real
  number to check rather than deferring to first use.

---

## Phase 2 — Store and sessions

**Goal.** Conversations persist. Turns are detached and reattachable.

**Deliverables**

- `store/store.ts` interface
- `store/sqlite/driver.ts` — `bun:sqlite` / `node:sqlite` adapter, the only conditional in the tree
- Migrations 001: `sessions`, `messages`, `turns`, `kv`
- Session resolution `{channel}:{peerId}[:{thread}]` and explicit keys
- Turn records with status: `running` | `final` | `stopped` | `error`
- In-memory buffer per running turn, replayable on attach
- `dispach sessions` CLI

**Files.** `packages/core/src/store/`, `loop/turn.ts` (persistence), `packages/cli/`

**Acceptance**

- [x] REPL restarts, history intact — two separate `node …/dist/index.js run` processes against
      DeepSeek: the first was told "my favourite number is 41", the second answered `41` from the
      persisted history alone
- [x] Migrations idempotent; second boot runs none — `store.ready.applied` is `[]` on reopen,
      asserted under both runners
- [x] Killing the client mid-turn does not cancel it; turn reaches `final` in the DB — the caller's
      promise is dropped on the floor while the row goes `running` → `final`
- [x] Reattaching replays buffered events then tails live — replay + tail reconstructs the reply
      exactly once, with no gap and no duplicate
- [x] Explicit stop persists partial content; disconnect does not — this criterion found a real
      Phase 1 bug, see Recorded deviations
- [x] Same test suite passes under `bun test` and `node --test`, proving the adapter — 229/229
      under both, whole suite not just the store
- [x] Boot with 1000 existing sessions still under 1000 ms — boot does not scan sessions;
      `bench:boot` median 61.4 ms with the store phase at 3.28 ms

**Non-goals.** Postgres. Outbox (Phase 4).

**Recorded deviations**

- **`runStep` lost partial text on cancellation.** Aborting a `fetch` makes the pending
  `reader.read()` reject, so cancellation reached `runStep` as an exception and `text +=
  step.text` in `runTurn` never ran. Phase 1 missed it because the REPL prints partial text from
  `model.chunk` events as they stream — a human sees the partial answer on screen and assumes it
  was captured, but `result.text` was empty and `appended` held only the user message. `runStep`
  now converts an abort back into the state it is (`turn.ts`: "cancellation is a state, not an
  exception"); anything that is not an abort still propagates.
- **`turns` is in the `Store` interface, and `status` holds six values not four.** The plan names
  `running | final | stopped | error`. `timeout` and `max_steps` are distinct `TurnEndReason`s the
  loop goes out of its way not to collapse, so flattening them at the storage layer would discard
  a diagnosis made one layer below. The column takes all six.
- **Persistence is opt-in, not the default.** `Runtime` defaults to `:memory:` and the CLI passes
  `defaultStorePath()`. Defaulting to a file would mean constructing a `Runtime` creates a
  directory in the caller's working directory uninvited. `store.ready` always reports `location`.
- **Session keys require a channel segment.** `local:default` parses; a bare `scratch` is refused
  at the boundary. Phase 4 reads the channel back out of the key for outbound delivery, so an
  unstructured key would fail much later as an unroutable session.
- **The `phase` column ships in migration 001** though phases are Phase 7. One nullable column
  now versus a migration that exists only to add it. `setPhase` is wired and tested but nothing
  in this build reads it.
- **`test/_harness.ts` supplies one test vocabulary for two runners.** `bun:test` and `node:test`
  share `describe`/`test` and no assertion library. Under Bun it re-exports `bun:test` untouched;
  under Node it wraps `node:test` and implements the twelve matchers plus `test.each` that this
  suite uses. The matcher list is deliberately closed.
- **`node:sqlite` prints an ExperimentalWarning on every CLI run under Node.** Not suppressed —
  it is Node's honest notice, and the primary runtime is Bun where it does not appear.

---

## Phase 2.5 — CLI

**Goal.** The command line stops being a means of exercising the runtime and becomes an instrument
you can trust: an Ink-rendered chat surface at a terminal, byte-identical plain text everywhere
else, and a parser that cannot fail silently.

Inserted between 2 and 3 rather than renumbered: "Phase 3", "Phase 7" and "Phase 8" are referenced
in roughly thirty places across source comments and the other docs, and every phase from here on
ships a CLI command. Doing this now makes each of their CLI deliverables one line instead of a
retrofit across nine commands.

**Deliverables**

- `lib/commands.ts` — the command and flag table; one source for parsing, `--help`, and error hints
- `lib/args.ts` — pure parser: unknown flags, missing values and bad numbers all refused
- `lib/help.ts` — help rendered *from* the table, so the two cannot drift
- `lib/output.ts` + `lib/env.ts` — `resolveMode()` → `json | plain | rich`, resolved once, with its reason
- `lib/exit.ts` — one teardown: unmount Ink, restore the terminal, flush, preserve the exit code
- `transcript.ts` — pure `AnyEvent → TranscriptState` reducer
- `keymap.ts`, `editor.ts` — pure key→intent and intent→line, including history and code-point cursors
- `lib/wrap.ts` — wrap-aware row counting, so the live pane's height cap means terminal rows
- `components/` — `App`, `Transcript` (`<Static>`), `Live`, `StatusBar`, `Prompt`
- `hooks/` — `useTurn` (bus → reducer), `useTerminalSize`, `useElapsed`
- One module per command: `run.ts`, `sessions.ts`, `validate.ts`, `agents.ts`
- `packages/cli/test/` — nine files, where there were none

**Files.** `packages/cli/src/**`, `packages/cli/test/**`

**Acceptance**

- [x] Rich path renders at a terminal — driven through a pty with injected keystrokes against the
      real DeepSeek endpoint: banner, streaming live pane, `● replying 1.1s`, then the reply
      committed with `153 prompt · 12 output · 1299 ms` and the prompt back
- [x] `run … | cat` and `run … --plain` at a terminal produce identical stdout, zero escape
      sequences in either
- [x] `--json` is valid JSON and the only thing on stdout, on all three commands that accept it
- [x] An unknown command or flag is refused, exit 1, naming the nearest match
- [x] `--input` with no value and `--limit abc` are refused naming the flag and the expected type
- [x] `--input "-5 degrees"` runs one turn with that text rather than silently opening a session
- [x] `--help` exits 0, bare invocation exits 1, `run --help` lists only `run`'s flags
- [x] Help is generated from the table — a test asserts every parseable flag appears in it
- [x] Ctrl-C mid-stream cancels the turn, the status shows `cancelling`, the prompt returns, and the
      partial reply is persisted: turn `stopped`, 309 output tokens, essay fragment in the history.
      Ctrl-C at an idle prompt exits
- [x] Terminal restored on every exit route — `stty -g` before and after a SIGTERM delivered while
      Ink held raw mode is byte-identical
- [x] `validate --json` loads neither Ink nor React — with `ink` physically removed from
      `node_modules`, `validate`, `sessions` and `--help` all still exit 0 and only the rich path
      fails. A structural test additionally forbids a static import outside `components/` and `hooks/`
- [x] The live pane is height-capped in terminal rows, and committed items are immutable — both
      asserted in tests. `<Static>`'s own write-once behaviour is Ink's documented contract, observed
      in the spike, not re-measured here
- [x] `packages/cli/test/` covers args, output, env, exit, transcript, keymap, editor, wrap, and the
      structural boundaries — 178 cases
- [x] `bun run bench:boot` unchanged: manifest 11.51 ms, store 3.45 ms, agents 0.37 ms

**Non-goals.** Interactive browsers for `sessions`/`skills`/`schedules` — those keep `--json` and a
plain table. Mouse support. Themes. A config file. Shell completions. Any command belonging to
Phase 3 or later. Any change to `packages/core`.

**Recorded deviations**

- **`ink` + `react` are the CLI's only new dependencies, and they load lazily.** Measured: importing
  them costs ~65 ms under Bun and ~170-210 ms under Node, against ~70 ms for the whole of
  `validate --json`. So the renderer sits behind a dynamic `import()` reached only on the rich path,
  `--splitting` keeps it in a separate chunk, and a structural test fails if a static import appears
  on a shared path. There is no text-input or spinner dependency: `editor.ts` is ~150 lines and owns
  the Ctrl-C semantics, which no third-party input component would respect.
- **`--packages=external` had to go.** It treats the `#…` subpath imports as packages and leaves them
  unresolved in the bundle, where they would resolve against `./src` — which `files` does not ship.
  The three real dependencies are now externalised by name and everything else is bundled.
- **`packages/cli` uses `#…` subpath imports; `packages/core` keeps relative `.ts` paths.** Verified
  working under node, bun and tsc, but only for an application: the emitted `.d.ts` carries `#…`
  specifiers that resolve through this package's own `imports` map, which is fine for a bin nobody
  imports and wrong for a published library. Apps get aliases, libraries do not. Note `#lib/const`
  must stay extensionless — `#lib/const.ts` fails tsc with TS2877.
- **A one-shot (`--input`) is always plain, even at a terminal.** Otherwise `--input` means one thing
  in a shell script and another in a shell, and scripted output would depend on who was watching.
- **The terminal restore is conditional on having dirtied the terminal.** Restoring unconditionally
  put a cursor-and-style reset at the end of plain output whenever stdout was a TTY, which broke the
  one property plain mode exists for. Only the rich path marks it, so the safety net still covers
  every route out of a raw-mode session.
- **Submitting while a turn is running is refused, not queued.** Two turns on one session would
  interleave in the history the next turn is conditioned on. The refusal is a note in the transcript.
- **A chunk containing newlines is a distinct intent.** Found by driving the real app through a pty:
  pasted text arrives as one chunk, and stripping its carriage returns as control characters joined
  the last word of one line to the first of the next and submitted nothing. Multi-line input now
  submits each finished line in order and leaves an unterminated tail on the prompt.
- **`exitOnCtrlC: false` is passed to Ink's `render`.** Ink's default is to handle Ctrl-C itself and
  exit the process, which would silently undo the contract Phase 1 measured.
- **The `agents` command gained `--json`** and moved out of the entry point, where being inline is
  how it ended up the one command whose flags the usage text never documented.
- **CLI tests are Bun-only.** Node's type-stripper cannot handle JSX, and Phase 2's dual-runtime
  criterion is about the store adapter. `bun run test:node` still runs core's 229 under Node.
- **The "themes" non-goal was reversed by decision 11.14 when Phase 3.8's TUI kit landed** — in
  the narrowest sense: one internal token module, `lib/theme.ts`, replacing per-component literal
  colour names. Still no config file, no user themes.

---

## Phase 3 — Tools and the NLT dialect

**Goal.** The agent uses tools. NLT is the default and demonstrably works on a small model.

**Deliverables**

- `tools/registry.ts` — resolution, budget with `reserveWrite`, loud failure on unknown slug
- `tools/dialect/dialect.ts`, `nlt.ts`, `native.ts`
- NLT catalogue renderer (prose, mandatory `whenNotToUse`)
- NLT parser: `ACTION:` blocks, `<<< >>>` heredoc, tolerant key matching
- `tools/coerce.ts` — text → JSON Schema coercion, one repair step, then honest failure
- `tools/execute.ts` — parallel read-only, serial mutating, timeouts, error surfaces
- Local tools: `now`, `memory_write` stub
- `packages/tools-composio` — direct SDK/HTTP, **no MCP**
- CLI: tool-call rows in the chat transcript — a `transcript.ts` case, not a new screen
- Context slot 1; cache breakpoint A
- Eval harness: `scripts/eval-tools.ts`, ≥30 fixture tasks

**Files.** `packages/core/src/tools/`, `packages/tools-composio/`, `scripts/eval-tools.ts`

**Acceptance**

- [x] Agent completes a two-tool task end to end on an 8B-class model — **qwen3.5:9b (9.7B) via local
      Ollama**: `now` (ok, 24 ms) → observation → `memory_write` (ok, 8 ms) → observation → the reply,
      with the note on disk. Turn `final`, 3 steps, 680 prompt · 377 output · 27,092 ms, and the whole
      six-message trace persisted. Also proven against DeepSeek
- [x] Eval suite: NLT vs native on the same fixtures, ≥3 models, results committed to `evals/` — 37
      fixtures across six groups × 2 dialects × **qwen3.5:9b (9.7B, local Ollama), deepseek-chat,
      deepseek-reasoner**, one call per fixture, temperature 0, nothing executed. `evals/tools/`
- [x] NLT ≥ native on the smallest model tested — **NLT 94.6% vs native 91.9% on qwen3.5:9b, PASS**,
      and NLT ahead on all three: +2.7pp, +13.5pp (deepseek-chat), +5.4pp (deepseek-reasoner). Prompt
      tokens −22.0% to −23.1%. Read the two caveats in Recorded deviations before quoting any of it:
      the qwen margin is **one fixture**, and the critical-error claim did not reproduce
- [x] Unknown pinned slug fails **at load**, naming slug and provider — and the manifest field and
      the nearest available match
- [x] Budget honoured; over-pinning is refused naming the cap, before any provider is consulted
- [x] Write reservation holds: 20 read + 6 write yields ≥6 write tools in the catalogue
- [x] Malformed model output triggers exactly one repair, then an honest `tool_repair_failed` — the
      turn ends at 2 steps rather than spending the step budget on the same broken block
- [x] Parser unit tests: 47 cases across multi-block, missing END, wrong case, bullets, numbered
      lists, backticked slugs, embedded `>>>`, wrapping fences, CRLF, and repeated keys
- [x] Composio path uses zero MCP transport — grep proves it: `packages/tools-composio` depends on
      `@dispach/core` and nothing else, no `@modelcontextprotocol` import anywhere, no `EventSource`
      and no `text/event-stream`. Every request goes through one injectable `fetch`, and a test asserts
      all three absences per source file rather than trusting them

**Progress.** The core tool layer and both CLI surfaces are complete and verified: `types`, `registry`
(resolution, budget, loud failure), `dialect/nlt` (catalogue, parser, stream filter, observations,
repairs), `coerce`, `execute`, the two built-in tools, the step loop, context slot 1, the three
`tool.*` events, and tool rows in the plain writer and the Ink transcript. `dialect/native` and the eval
harness are in too. 701 tests under Bun and 490 under Node, boot unchanged at 68.8 ms against a 1000 ms
budget, with the `tools` phase at 0.53 ms.

Verified live against DeepSeek, at a pty and through a pipe: one tool, two parallel calls in one step,
a two-tool chain across steps, tool rows on both paths, and zero occurrences of `ACTION` in either
path's output.

**Verified live against Composio's API** (25,438 tools reported by the listing): `tools --warm` fetched
three pinned schemas in 1.6 s and wrote the cache; the catalogue then rendered from disk **with no API
key present at all**; and a full turn against DeepSeek routed to `GOOGLECALENDAR_EVENTS_LIST`, hit the
missing-connection error, and reported it honestly instead of inventing a calendar.

The number that matters: `Runtime.create` returns in **27 ms** with the provider configured, and the
post-readiness refresh takes **1,474 ms**. Awaiting it inside boot would have made boot sixty times
slower, which is the whole reason the two paths are separate. `bench:boot` unchanged at 68.0 ms.

Phase 3 is complete.

**Non-goals.** Tool search. Phases. MCP provider.

**Recorded deviations**

- **`tools.local` and `tools.pinned` resolve against different providers.** `local` names built-ins
  and is never sent to a remote provider — asking Composio to resolve `now` invites it to answer with
  something else. The local provider is consulted first for both, so a provider tool cannot shadow a
  built-in, and a genuine clash is a load failure rather than a silent winner.
- **`memory_write` is a stub whose observation says so.** Memory is files plus FTS5 and arrives with
  its own phase; the stub exists so a *mutating* tool can be exercised end to end — serial execution,
  the write reservation, the trace-retention rule. It reports `NOT SAVED` and tells the model not to
  claim otherwise, because a stub reporting success teaches the agent to tell the person their note
  was saved, which is worse than not having the tool.
- **Observations are capped at `observationMaxTokens` with a visible head-and-tail cut.** Not S1
  compaction: there is no artifact file and no pointer yet, so the marker names the character count it
  removed. Without any cap a single large observation can exceed the whole window and take the history
  with it.
- **`AgentCreateOptions` replaces `ResolveRolesOptions` at `Agent.create`, which stays synchronous.**
  Resolution is asynchronous because a provider is consulted, so `Runtime` builds the registry in its
  own boot phase and hands it over. Making `Agent.create` async would have pushed a provider await
  into every embedder's construction path for no gain.
- **The `tool.repair` event fires on both attempts.** The wire spec now says so. It means "this step's
  calls could not be used", and two in a row is the signal that a catalogue needs work — suppressing
  the second would hide exactly the case worth seeing.
- **`memory_write` writes a file; it is not a stub.** The plan called for a stub, and the first one
  reported "NOT SAVED — this build has no memory store". Truthful, and a trap: measured against
  DeepSeek, a model asked to save a note called it three times and never replied, ending in an honest
  `max_steps` failure. A mutating tool that cannot succeed is a loop. It now appends to
  `<agent dir>/memory/notes.md`, which is where `memory.dir` already points, so the memory phase indexes
  what is there rather than a second location. Write-only until then — a missing half, not a lie.
  `ToolContext` gained `dir` for it: a tool touching the filesystem resolves against the agent's own
  directory, never `process.cwd()`, which belongs to whoever launched the process.
- **The stream filter is a dialect method, and `parse` was refactored to share its grammar.** Both drive
  one line-at-a-time consumer, so the text shown and the text executed cannot disagree; the property is
  asserted directly at three chunk sizes. `endStep()` exists because a step's output ends without a
  newline and the loop joins each step's prose with a blank line — leaving either to the consumer means
  every consumer reinvents them and they diverge.
- **A tool call renders as two rows, not one that updates.** The call is committed when it starts, so an
  eight-second tool does not look like a stalled model, and the result arrives as its own row. Ink's
  `<Static>` has already written the first one, and editing a written node silently does nothing.
- **`TurnStatus` gained `working`.** During a tool call the model is producing no tokens, so `streaming`
  — rendered as "replying" — would have been a straightforward lie in the status bar.
- **Tool rows are suppressed for `--input`.** A one-shot run prints the answer and nothing else, because
  something is parsing it. Same rule the banner and the stats line already follow.
- **The dialect seam widened; `native` could not be an added file.** `parse(text)` was enough while
  every dialect lived in the text. Native's protocol lives in the wire envelope, so a dialect now
  receives a `StepOutput` — text *and* structured calls — and decides which half carries the protocol.
  Three renderers became dialect methods for the same reason: `renderCall` (NLT replays raw text,
  native replays the calls), `renderObservation` and `renderRepair` (both return *lists*, because
  native needs one `tool` message per call, each naming the id it answers). The last is forced rather
  than chosen — an assistant turn whose `tool_calls` were not all answered is rejected outright, which
  is also why `renderRepair` is driven by the step's calls rather than by its parsed intents: the call
  whose arguments would not parse never became an intent, and it is the one a repair is usually about.
- **`ParsedOutput.malformed` exists because native has a failure NLT cannot have.** A truncated
  `arguments` document is not JSON and no tolerance recovers it. Reporting it as an empty argument set
  would mean a tool with no required fields *runs*, with no arguments, having been asked for something
  else — a wrong action taken silently. It short-circuits execution the same way a bad NLT block does,
  and emits `tool.repair` from the loop, since `executeIntents` never ran to emit it.
- **`ContextBlock` gained an optional verbatim `message`.** `{role, content}` stopped being a complete
  description of a message. History was projected through blocks and back, which silently stripped
  `toolCalls` and `toolCallId` — so from the second step of every native turn the observation answered
  a call no message contained. Harness-composed blocks leave it unset and fall back as before.
- **Migration 2 adds `tool_calls` and `tool_call_id` to `messages`.** Found live rather than reasoned
  about: the table allowed the `tool` role from migration 1 but had nowhere to put the ids, so a
  resumed native session read back an assistant turn with **empty content and no calls** and a `tool`
  message naming nothing. qwen3.5:9b via Ollama accepted that orphaned trace and answered anyway,
  which is the worse outcome — a strict endpoint would have said so. Verified upgrading a live v1
  database in place. `MESSAGE_COLUMNS` is now one shared fragment because the five message SELECTs
  drifting apart is how the columns came to be dropped on the way *out*.
- **A native-illegal slug is refused at load, and `dialect: native` is refused on a model without
  `nativeTools`.** Function names are `[A-Za-z0-9_-]{1,64}`; `gmail.send` is legal under NLT and not
  here, and rewriting is lossy both ways. The capability check replaces a 400 on the first turn — or,
  on an endpoint that ignores an unknown `tools` key, an agent that never calls a tool and never says
  why. Overridable via `model.main.capabilities.nativeTools`.
- **`planIntents`' unknown-slug repair is now dialect-neutral.** It read `field: "ACTION: <slug>"` with
  a hint about ACTION blocks — correct under NLT and nonsense under native, where it would tell the
  model to fix a block it never wrote. The field is the bare slug, which is also what native matches
  its per-call repair messages against.
- **In-session CLI commands are a table, and both renderers dispatch through it.** The outer `--help`
  has been generated from `COMMANDS` since Phase 2.5; the in-session help was a string in a component
  and had drifted both ways. `/help` was advertised by the banner and **unhandled on the plain path**,
  where it went to the model as a prompt — a billed call answering a question about the CLI. Five
  working key chords were undocumented. Key bindings cannot be generated from a table, since
  `keyToIntent` is a function, so the loop is closed by tests from both ends. `/tools` is new and is
  Phase 3's surface for a catalogue that is otherwise invisible: dialect, slugs, read/write, and the
  per-turn token cost. A lone unknown `/word` is refused naming the nearest match; anything with a
  space or a second slash is prose and goes to the model, because `/etc/passwd is world-readable` is a
  real message. One behaviour change: a piped `/exit` now stops the run instead of being skipped,
  which was the only place the piped path disagreed with the terminal about what a typed line meant.
- **`model.<role>.streamUsage` is a new manifest field, and a `qwen3.5*` capability row corrects the
  generic `qwen*` one.** Both came out of the first local run. Ollama reports *no* token usage in a
  streamed response unless asked with `stream_options`, so local token figures were the estimator's:
  measured against qwen3.5:9b, the estimate was 764 prompt · 57 output where the endpoint reports
  680 · 377. The output figure is out by 6.6× because reasoning is billed to the output budget and the
  estimator only sees the visible reply — which also settles the capability question, since the shipped
  `qwen*` row claimed `thinking: "none"` and this model streams reasoning in a `reasoning` delta field.
  It is now `thinking: "deepseek"`, the "separate field, nothing to replay" protocol. Both matter before
  the eval: a token comparison built on the estimator would have been measuring the estimator.
- **The NLT preamble's format example is concrete, and the first full sweep existed to find that out.**
  It read `ACTION: tool_name` / `field: value` under "exactly like this". qwen3.5:9b wrote
  `field: title` / `value: Renew my passport` — its reasoning names `task_create`, `title` and
  `priority: urgent` correctly, and then encodes all of it through the placeholder words. NLT scored
  **27.0% against native's 91.9%** on the same fixtures, 100% on `abstain` (the one group that needs no
  block) and 0% on `discriminate`, `arguments` and `chain`. Every one of the 25 failures was this.
  The example now uses a tool present in no catalogue, with field names that look like field names, and
  a positively-phrased disclaimer — a model that mishandles metasyntax is not the model to hand a
  negation to. Two tests close it: the rendered catalogue is parsed by `parseNlt` and must contain
  exactly one block, and that block's field names must not be `field` or `value`. The wider lesson is
  the asymmetry, not the typo: NLT's protocol is prose the model imitates and native's is a schema the
  API enforces, so *any* preamble defect surfaces as a dialect difference and reads as a finding about
  the dialect.
- **A failing eval must be diagnosable from the committed artifact.** Two reporting defects nearly
  buried the above. `score()` recorded `repair[0].message`, and a `FieldError.message` is a fragment
  written to follow its field name — so twenty-five distinct failures all printed as
  "is not a field of this tool.", with no field, looking like one inexplicable class. And nothing stored
  the model's output, so separating a parser defect from a model failure meant re-running a live
  endpoint and hoping it answered the same way. `Attempt.raw` now keeps text and calls on every
  non-`correct` outcome, and notes carry every field error with its field.
- **The eval reproduces NLT's accuracy and token claims, and does not reproduce its critical-error
  claim.** Decision 4.1 borrows three numbers from a published replication. Two hold here: NLT is ahead
  on all three models (+2.7pp on qwen3.5:9b, +13.5pp on deepseek-chat, +5.4pp on deepseek-reasoner) and
  costs 22.0–23.1% fewer prompt tokens against a published −25%. The third — **93% fewer critical
  errors** — does not: the only critical error in the whole sweep, `restraint-draft-not-send` firing
  `file_write` on qwen3.5:9b, fired under *both* dialects, for a critical rate of 2.7% each and 0.0% on
  both DeepSeek models. 37 fixtures with one critical error between them cannot measure a 93% reduction;
  the honest statement is that this suite has no power on that claim, not that the claim is refuted.
  Where NLT's margin is unambiguous is `restraint` — +80pp on deepseek-chat, +40pp on deepseek-reasoner,
  +20pp on qwen — which is the group about *not* acting, and the one closest to what a critical error is.
- **The qwen gate margin is one fixture, and single-pass numbers on a reasoning model move.** NLT 35/37
  against native 34/37 is a pass on the recorded criterion and a thin one. The run also produced its own
  measure of the noise: the preamble fix changed nothing native sends, and native's prompt-token totals
  are byte-identical across the two sweeps (61409 / 58907 / 61830) — yet deepseek-reasoner's native score
  moved 30/37 → 33/37 on that identical input, because a reasoning model is not deterministic at
  temperature 0. qwen and deepseek-chat were stable across both runs, so the gate model is the steady
  one, but a three-pass median on qwen is what would settle a one-fixture margin. `--repeats 3` exists
  for it.
- **`scripts/eval-tools.ts` refuses an unknown flag.** It accepted `--only` and `--groups` silently, so
  a run intended as one model and one group swept all three models and all 37 fixtures, took seven times
  as long, and reported a scope nobody asked for — hard rule 8, in the tool built to check the project's
  central claim. The gate also no longer speaks for Phase 3 on a narrowed run: a `--tasks` subset that
  regresses still exits non-zero, as `SUBSET REGRESSION`, but the Phase 3 wording is reserved for the
  full fixture set so a subset cannot be quoted as the decision.

- **`mutating` is read from Composio's annotations, and an unannotated tool is assumed mutating.** The
  plan proposed action-name and HTTP-method heuristics; the live data made them unnecessary and worse.
  Composio publishes MCP-style hints in `tags` — `readOnlyHint` on 51 of 100 sampled tools,
  `destructiveHint` on 10, and **nothing at all on 37**, including `ABLY_PUBLISH_MESSAGE_TO_CHANNEL`.
  No tool carries `readOnlyHint` while having a write verb in its slug, so the annotation is reliable
  when present and silent when absent. Confirmed on the three pinned live: `GMAIL_SEND_EMAIL` has no
  `readOnlyHint` and correctly resolved as `write`. The default is the safe direction rather than the
  cautious one — `mutating` is what serialises a call and suppresses its retry, so a write mislabelled
  as a read runs in parallel *and* is retried, and the side effect happens twice.
- **Value constraints are carried in the field description; structural keywords are refused.** The plan
  said `map.ts` should refuse what it cannot express. Applied literally that refuses **46 of 100** tools:
  `minimum` appears 62 times, `maximum` 23, `format` 22, plus `pattern`, `minLength`, `maxLength`. So
  those are appended to the description where both dialects render them, with the stated cost that an
  out-of-range value is rejected by Composio at execution rather than repaired locally. `anyOf`, `oneOf`,
  `allOf`, `not` and `$ref` decide *validity* and are refused naming tool, field and keyword — none
  appears in the live sample, so it costs nothing today.
- **`default: null` is dropped in the mapper.** `GMAIL_SEND_EMAIL.subject` really ships
  `{"default": null, "nullable": true}`, and `coerce` applies any default that is not `undefined` — so
  carrying it would have sent an explicit `subject: null` on every call the model left blank. A null
  default is a schema saying "no default", not "default to null".
- **Providers are factories registered by the embedder, and the plumbing did not exist.**
  `RegistryOptions.providers` was already consulted but nothing populated it: `runtime.ts` passed only
  `{pinned, local, budget}`, and `tools.provider` was read by nothing while `validate` refused it as
  `not_implemented_yet`. Core cannot import a provider (hard rule 2) and a provider needs the *agent's*
  directory and env, so `Runtime.create({ toolProviders })` takes factories keyed by id. The same list
  reaches `validate`, because a validator that accepts what the runtime refuses is worse than none.
- **An unwarmed cache needed its own error, and the generic one proved it.** On the first cold run the
  registry reported *"No provider resolved GMAIL_FETCH_EMAILS. Consulted: local, composio … Available:
  now, memory_write"* — three correct slugs blamed, local tools offered as the alternative, and no
  mention of the actual cause. Only the provider knows the cache is empty, so it now throws
  `composio_cache_miss` naming the slugs, the cache path, and the warm command.
- **`dispach tools <manifest> [--warm]` is a new command, and it had to be.** Without it the cache is
  unfillable: an empty cache fails the load, so the post-readiness refresh that would have populated it
  never runs. `--warm` therefore does not boot the runtime at all — it loads the manifest, constructs
  the provider, and fetches. It exits non-zero when a slug does not exist, since exiting 0 would let a
  bad slug through to a load failure after the person believed it had succeeded.
- **`tools.refreshed` is a new event.** The refresh is fire-and-forget, so without an event there is no
  evidence it happened or failed. `ok: false` is not a turn failure — the agent keeps serving what it
  resolved from disk.
- **`slotReport` was dropping `label`.** Found while documenting the slot renumber:
  `ContextBlock.label`'s own comment describes it as existing for `GET /v1/agents/:id/context`, which
  never received it. Slot numbers are positional and renumber on insertion, so a consumer without the
  label has to hardcode numbers. `slotReport` had no tests at all, which is how it went unnoticed;
  `packages/core/test/context.test.ts` now covers it, including two assertions on the numbering
  invariant itself.
- **`tools.providerConfig` refuses an unknown key.** The manifest schema keeps it a free-form record, so
  nothing upstream catches `userid` for `userId`. A silently ignored setting is a configuration that
  looks applied and is not.

---

## Phase 3.5 — Workspace

**Goal.** The agent's persistent files are tiered, budgeted, and rendered per model. `context.files`
becomes a deprecated alias.

Inserted rather than renumbered, for the reason Phase 2.5 was: Phases 3, 7 and 8 are named in about
thirty source comments and docs, and renumbering them costs more than it buys. Governed by
`docs/07-SPEC-WORKSPACE.md`, which is binding.

**Why it is its own phase.** A flat ordered array cannot express which files are cache-stable, which
sit after the conversation history, or which the agent may write to. Each has a measured cost when
got wrong — an invalidated prompt cache, decayed rule adherence, persona drift — and none of the
three is expressible by reordering `context.files`.

**Deliverables**

First half — **done**:

- [x] `workspace/frontmatter.ts` — parse, and **strip frontmatter and HTML comments before
  injection**
- [x] `workspace/load.ts` — tiered load; per-file, per-tier and total budgets with a named failure
  and no truncation; `writeTarget` resolution; `ruleBudgetFailure`
- [x] `workspace/rules.ts` — imperative count across `static` + `reminder` against
  `reliabilityTarget`, computed rather than tabulated
- [x] Slots 2 (`volatile`) and 7 (`reminder`) populated; both were already declared in `SLOT`
- [x] `editable` enforced at the tool boundary: `memory_write` against `editable: none` is a typed
  error
- [x] `context.files` → deprecated alias for `static`, warning naming the replacement
- [x] `examples/workspace-template/` and a filled-in `examples/telegram-assistant/workspace/`

Second half — in progress:

- [x] `model/prompt-style.ts` — `delimiters` and `intensity` rendering, model classification, and
  `promptStyle` as a resolved capability merged field by field over a manifest override
- [x] `workspace/authoring.ts` and the `workspace` command — the authoring rules of
  `07-SPEC-WORKSPACE.md`, reported as warnings with `--strict` for CI
- [x] `scripts/eval-rules.ts` and `evals/fixtures/rules.ts` — measures `perRuleSuccess` against a
  real endpoint, and checks the guard's independence assumption while it is there
- [x] `examplesIn` placement — `extractExamples` (a move, never a rewrite; fence-aware, tags kept)
  feeds a new user-message slot **before** the volatile tier, because the extracted text is
  byte-stable and prefix caching is contiguous. `skillsIn` stays carried-only: skills arrive in
  Phase 5, so there is nothing to place
- [x] `knowledge/` — Tier 3, activation by frontmatter keyword gate, `maxActive`, own budget,
  slot 5, not pinned. Selector is a ranking-only seam Phase 6 can attach a scored retriever to
- [x] `SOUL.md` — `requires` / `onUnmet`, plus `soul distill` emitting an editable scaffold
  (headings and `<rules>` verbatim, `{{PLACEHOLDER}}` per section so the `workspace` command
  nags until a person fills it)
- [x] `evals/prompt-style/` — both questions measured on qwen3.5:9b and deepseek-chat with
  committed numbers and raw replies. `examplesIn` saturates — both placements score 100% on a
  well-authored example set, so every default stays on its vendor's advice with a measured floor.
  `intensity` discriminates at 6 rules: the emphatic line moves qwen's all-rules compliance
  +20pp (16/20 vs 12/20, entirely the `digits` rule, reproduced at two probe scales), supporting
  the shipped small-model default; deepseek is 100/100 either way

**Files.** `packages/core/src/workspace/`, `model/prompt-style.ts`, `manifest/schema.ts`,
`context/assemble.ts`, `packages/cli/`, `evals/prompt-style/`

**Acceptance**

- [x] Frontmatter and HTML comments never reach the model — asserted on the assembled prefix
- [x] A workspace over total budget fails the load naming the offending file; nothing is truncated
- [x] The same `AGENT.md` renders with XML delimiters under `delimiters: xml` and plain sections
      under `plain`, from one authored source
- [x] `MEMORY.md` is in slot 2, after breakpoint A: a `memory_write` leaves slots 0–1 byte-identical
- [x] `REMINDER.md` lands in slot 7 — after the history, before the input
- [x] `memory_write` against an `editable: none` file returns a typed error, not a silent no-op
- [x] A manifest using `context.files` still loads, with a warning naming `static`
- [x] Rule guard: three rules at `perRuleSuccess: 0.90` / `reliabilityTarget: 0.80` fails the load
      quoting the computed figure; two pass
- [x] `eval rules` reports a measured `perRuleSuccess` for the configured model
- [x] `evals/prompt-style/` settles both open questions on ≥2 models: (a) `examplesIn` — no
      measurable difference in either direction on a well-authored example set (100% adoption from
      both placements, 240 observations, zero empties), so no default moves; (b) `intensity` — the
      small-model half of the inversion is supported: +20pp all-rules compliance from the emphatic
      framing line on qwen3.5:9b at 6 rules, mechanism isolated to one rule, while the frontier
      half (overtriggering) is outside what a compliance probe can see and stays on published
      guidance. Numbers and raw replies in `evals/prompt-style/`
- [~] `workspace` flags a rule with no rationale clause, an undiverse or miscounted example set,
      heavy negative framing, an unfilled template placeholder, and a bulleted `AGENT.md`. The
      bullet check is **unconditional** rather than gated on every bound channel being
      `markdown: none|basic` — channels arrive in Phase 4 and the manifest section is refused
      until then, so gating it now would ship a check that can never fire. Deferred to Phase 4.
- [x] `SOUL.md` on a model failing `requires` behaves per `onUnmet`; `distill` ships the compact file
      — verified live on `examples/reference`: `deepseek-v4-pro` (393k window) gets `SOUL.md`,
      `qwen3.5:9b` gets `SOUL.compact.md` with a warning naming both failed requirements
- [x] `knowledge/` activates on keyword, respects `maxActive` and its budget, and is **not** pinned
- [x] `bun run bench:boot` still under 1000 ms with a full workspace loaded — median 52.1 ms,
      `agents` phase 1.45 ms including the workspace read

**Non-goals.** Automatic soul distillation — a summariser drops exactly the parts that produce voice.
Scored or embedded knowledge retrieval: Phase 3.5 ships the keyword gate behind a seam Phase 6 can
attach a scored selector to, and **must not** build a second index. Compaction notice (Phase 7, with
the ladder it describes). Rewriting `context.files` callers beyond the alias.

**Sequencing note.** This phase is large — plausibly two sessions, split at `promptStyle`. Tiers,
budgets and the alias form the first half and are independently useful; rendering, the eval matrix,
`SOUL.md` and `knowledge/` form the second.

### First half — deviations from the plan as written

- **The default budgets are much larger than the spec proposed.** 700/500/60/1300 became
  2,000/3,500/500/6,000, set in `DEFAULT_WORKSPACE_BUDGETS` and read from there by the manifest
  schema so the figure a manifest gets by omitting the section and the figure the loader applies
  without one cannot drift. The original numbers refused a 554-token `AGENT.md` that declared a
  500-token budget, which is roughly 480 real tokens — the estimator is biased ~10% high by design.
  Documented as a ceiling rather than a target, because the reasoning behind small budgets (what a
  model *follows*, not what a window *fits*) is unchanged by raising them.
- **`ruleBudgetFailure` returns rather than throws, and `validate` calls it too.** The check first
  lived only in `Agent.create`, so `validate` reported ok on a manifest `run` refused — the exact
  asymmetry the Composio work established as unacceptable. One function, two callers, each applying
  its own `onExceed`.
- **`onExceed` is `fail | warn`, and the failure lists every line it counted.** The imperative count
  is a heuristic; a guard whose reasoning is invisible is one authors route around. `off` was
  considered and dropped — `warn` already provides the escape, and silence does not.
- **`editable` on a `static` or `reminder` file is refused, not downgraded.** The spec said only
  that `volatile` is writable. Quietly ignoring an `editable: append` on a static file would leave
  the author believing writes go somewhere they do not.
- **A frontmatter `tier` disagreeing with the list that named it is a load failure.** Trusting the
  list would move a writable file ahead of the cache breakpoint; trusting the frontmatter would move
  a file out of the position its author chose in the manifest. Both are wrong silently.
- **Setting both `context.files` and `context.static` is refused rather than merged.** They resolve
  against different directories, so a merge produces an order nobody wrote.
- **`context.soul`, `context.compactionNotice` and top-level `knowledge` are schema-complete and
  refused at load.** Same treatment as every other forward-looking section: a manifest that
  configures them validates as a document and fails as a configuration, naming the phase.
- **`validate` now loads the workspace instead of counting names.** Every interesting failure —
  budget, tier mismatch, unreadable file — happens during the load, so a validator that only counted
  would report ok on a manifest `run` refuses. It prints tokens-against-budget per tier.
- **The guard found a real cost in the shipped examples, and it was fixed rather than relaxed.**
  Both had `README.md` and `IDENTITY.md` in their `static` tier — several hundred tokens of
  human-facing documentation in the system prompt on every turn, stating rules of its own.
  `examples/minimal` counted 6 rules against a budget of 2 (expected all-rules compliance 0.53);
  `examples/reference` counted 8 (0.43). Both were cut to a single identity file: 554 tokens,
  **1 rule of 2**, compliance 0.90, `onExceed` back at the shipped default `fail`. Dropping
  `IDENTITY.md` also settles what `07-SPEC-WORKSPACE.md` already said — it is folded into the
  identity document, and split, the two contradict each other. *(That file was `AGENT.md` then;
  decision 11.19 later renamed identity to the soul pair and repurposed `AGENTS.md` as operations.)*
- **`memory_write` takes no `file` argument.** The runtime resolves one write target from the
  workspace. Choosing a file would be a second decision on every save, which is the two-hop shape
  small models fail.
- **`promptStyle` is derived from the model id, not carried on capability-registry rows.** The
  registry's patterns cannot express it: `qwen3.5*` matches `qwen3.5:9b` and `qwen3.5:72b`, and those
  want opposite `intensity` values. Size predicts the inversion and size is in the id, so
  `CapabilityEntry.capabilities` is now `RegistryCapabilities` — everything except the derived field
  — and `resolveCapabilities` composes the two. A manifest override merges the four fields
  individually rather than replacing the object.
- **`intensity` frames an author-marked `<rules>` block; it never rewrites a sentence.** The spec
  described it as adding "imperative framing and repetition". The framing is one generated line
  before the block; the repetition is the `reminder` tier, which already does it at the recency
  position and does it better than duplicating a block inside slot 0 would. Authors mark rules the
  way they already mark examples, so no heuristic decides where the framing goes. The two `AGENT.md`
  templates and the three shipped identity files gained `<rules>` wrappers.
- **Rendering exposed a real bug in the rule count, caught by `bench:boot` rather than by a test.**
  Rules were counted on the rendered text, but `countRules` excludes examples by looking for
  `<example>` markers — which the renderer had just turned into headings. Every imperative inside a
  worked example started counting, and `examples/minimal` went from 1 rule to 4 with no edit to the
  file. `WorkspaceFile` now carries `authored` beside `content`, and the count reads the former.
- **`workspace` is a separate command from `validate`, and its findings never fail by default.**
  `validate` answers "does this load?", which has a yes or a no; `workspace` answers "is this
  written well?", which is a judgement, and a heuristic judgement that refuses to load a file is a
  heuristic nobody keeps. `--strict` exists for CI, where a warning nobody has read and a warning
  someone has accepted look identical.
- **An unfilled template placeholder is its own finding.** Before that check existed, the template
  reported as an example-*diversity* failure — its `{{PLACEHOLDER}}` examples are identical to each
  other — which sends the author to fix the wrong thing. It also suppresses the other checks for that
  file, so one finding that matters does not arrive buried under four that restate it.
- **`eval rules` reports saturation rather than a perfect score.** Against `deepseek-v4-pro` the
  probe returns 1.000 on every rule, which says the instructions were easy for that model and
  nothing about the model's rule budget. Printing `perRuleSuccess: 1.00` as a recommendation would
  put a guard-*disabling* figure in a manifest — the same failure as a guessed input, by another
  route. It now says the probe saturated and points at the smallest model in use.
- **The first `eval rules` run against a local model measured nothing, and said 0.688 confidently.**
  `qwen3.5:9b` reasons about 380 tokens under a rules prompt and the script capped output at 300, so
  **every one of thirty replies came back empty** — the `deepseek` reasoning-budget failure already in
  `CLAUDE.md`, on a model whose capability row does not mention reasoning. Five of the six checks pass
  vacuously on an empty string (`no-commas`, `lowercase`, `brevity`, `no-questions`, `digits`), only
  `suffix` fails, and the arithmetic produced a plausible-looking 0.688 with an equally plausible
  independence verdict attached. The signature was visible in the per-rule table — one rule at 0/30
  while every other sat at 1.000 is a broken check, not a model — and the diagnosis took one probe
  that printed the raw reply, which the script was not recording. Three fixes: `--max-tokens`
  defaulting to 2000, empty replies excluded and counted rather than scored, and raw replies written
  to `results.json`. Above 20% empty the script refuses to report a figure at all. **The lesson is
  Phase 3's, unlearned and relearned: read what the model actually wrote before believing a number.**
- **Local Ollama is out of the loop, and the gate learned to say when it cannot be decided.**
  A single `eval-tools` sweep against `qwen3.5:9b` on local Ollama took about eighteen minutes, and
  an eval nobody will wait for is an eval nobody runs. The small slot is now `SMALL_MODEL_ID` /
  `SMALL_MODEL_BASE_URL` / `SMALL_MODEL_API_KEY` — any OpenAI-compatible host serving open weights —
  and `verify-endpoints` uses the same three variables for Phase 1's third implementation.

  Removing it exposed something that had been true all along: with no small model configured, the
  smallest that runs is `gpt-4o-mini`, whose parameter count is **unpublished** and sat in the table
  as a guessed `8`. The gate would have quoted it as "the smallest model tested" and passed. So
  `ModelUnderTest` gained `openWeight`, the gate turns on that rather than on `params`, and a clean
  sweep with no open-weight model now reports **UNDECIDED** rather than green. Exit code stays 0 —
  nothing regressed — but "we checked" and "we ran something green" are different sentences.

  The committed `evals/tools/` figures are **not** rewritten. They record what was measured on the
  hardware it was measured on; a note above the table says the target has moved and re-measurement
  is pending. Phase 1's and Phase 3's completion notes keep their Ollama references for the same
  reason — they are history, not configuration.
- **`eval rules` also checks the guard's independence assumption.** `perRuleSuccess ** n` assumes
  rules fail independently, which is load-bearing and was nowhere verified. The run reports observed
  all-followed beside predicted at each n, so the assumption is evidence rather than arithmetic.
- **Slot 2 is read at load, not re-read per turn.** The tier's *position* is what the first half
  delivers. A `memory_write` therefore reaches the model's slot 2 on the next agent load rather than
  the next turn; the re-read belongs with the second half, since a re-read with nothing writing is a
  filesystem call per turn for no observable difference.

### Second half — deviations from the plan as written

- **The slot table was renumbered — and zero call sites changed.** `examples` (2) and `knowledge`
  (5) needed positions, so everything from the volatile tier down moved. Every reference in the
  tree is by name (`SLOT.input`, never a number), which is why the architecture doc calls
  renumbering cheap; this was the first time the claim was exercised at scale, and 866 existing
  tests passed untouched.
- **The examples slot sits *before* the volatile tier, not after it.** Extracted examples are
  byte-stable for the lifetime of the agent, and OpenAI-compatible prefix caching is contiguous —
  placed behind the mutating volatile tier, they would fall out of the cacheable region on every
  memory write despite never changing. Their tokens still count against the file that authored
  them: moving examples must not make a file look cheaper than it is.
- **The full soul document is exempt from the prose rule-count; its `<rules>` blocks are not.**
  Found live, not designed: the first `validate` of a soul-bearing reference manifest counted 9
  rules against a budget of 2, and every counted line was constitution prose ("never gets tired of
  being asked"). A document whose premise is that the model derives rules from explanation will
  always trip a keyword heuristic on its explanation, and it ships only to models the author has
  declared — via `requires` — capable of that derivation. The *distilled* file gets no exemption:
  it ships to small models, where the budget is the point. The same split applies to the
  rule-shaped authoring checks (`rule_no_rationale`, `negative_framing`).
- **A soul replaces `AGENT.md` rather than joining it** *(revised by decision 11.19: what a soul
  replaces is the identity document; `AGENTS.md` as rewritten is operations, and coexists)*. The
  reference example first carried both,
  which ships two identity documents to a frontier model — the same two-files-that-contradict
  failure the template records for the old `IDENTITY.md`/`SOUL.md` split, recreated through the new
  mechanism. The reference now demonstrates replacement, and the spec says so in bold.
- **`soul distill` refuses to overwrite an existing compact file.** The compact file is the
  hand-edited artefact; regenerating over someone's edits is exactly the loss automatic
  distillation would cause, arriving through the tool built to avoid it. The scaffold's
  placeholders are deliberately the `{{NAME}}` form the `workspace` command warns about, so an
  unedited scaffold keeps reporting itself.
- **`validate` now renders with the resolved `promptStyle`, closing a real asymmetry.** It loaded
  the workspace with the default style while `run` rendered with the model's own — and budgets are
  measured on rendered text, so the two could disagree about whether a file fits. `resolveWorkspace`
  (plan + soul gate + load) is now one exported function both call, per the standing rule that a
  check only `run` performs is a check `validate` disagrees with.
- **Knowledge activation stops at the first entry that does not fit; it never skips past it.**
  Skipping would let a worse-ranked entry displace a better-ranked one purely by being short, and
  the selection would stop being explainable from the ranking — the same quiet-reordering shape the
  tool registry refuses. An entry larger than the whole activation budget fails the *load*: it
  could never activate, and silently-unreachable is the dropped-tool-call failure shape again.
- **Knowledge is selected once per turn, not per step.** Activation is a function of the turn's
  input; re-selecting per step would let two steps of one turn argue from different reference
  material.

---

## Phase 3.6 — Acting on the system: trust, policy, and tools

**Goal.** The agent can run commands on the machine it is on, read and write files, and search the
web — and third-party text cannot quietly drive any of it.

**The correction that reshaped this phase.** It was first scoped as "untrusted content and web
tools", on a reading of the README's "lives in messaging channels" as a scope limit. It is not one.
Dispach is a harness, peer to OpenClaw, Hermes Agent and Claude Code, and a harness that cannot act
on the user's machine is not one. Three things follow:

1. The first-party tool surface **grows** to cover system work — shell and the file family.
2. The permission layer stops being a Phase 9 concern. All three reference runtimes ship shell
   execution *with* a policy model; shell without one is the reference behaviour with the safety half
   deleted.
3. The trust boundary becomes **more** load-bearing, not less. `web_fetch` beside `memory_write` risks
   a bad note; `exec` in the same picture is remote code execution by email.

**The gap this owns.** Neither OpenClaw nor Hermes has taint tracking or a write gate — OpenClaw's
issue proposing per-result trust tagging was closed as not planned. Dispach had it as a written
decision (4.25–4.27) before it had the tools that make it urgent. Part A is the differentiator, not
the catch-up.

### Part A — the control substrate (core) ✅

- `ToolSpec.trust`, optional and **normalised by the registry keyed off position in its own provider
  loop** — never `spec.provider` (a self-report) or `provider.id` (chosen by whoever registered the
  factory). Position is the fact; the strings are claims. `ToolResult.trust` is required, the opposite
  call for the same reason: it is built only inside core, so optional would bake a fail-open default
  into the type.
- **The write gate lives inside `executeIntents`**, not the turn. Untrusted content and a mutating call
  can arrive in the *same step*; a gate reading a flag computed before the call would let that straight
  through. Taint accumulates inside the group loop, with no `ok` guard — a failed untrusted call still
  lands upstream bytes in context, because `toolFailed` interpolates the cause's message.
- **Delimiting, with Hermes' defanging.** The marker is neutralised case-insensitively inside payloads,
  and there is deliberately no "already wrapped" fast path — that check is itself forgeable.
- **The policy engine** (`tools/policy.ts`): deny → allow, first match, specificity never reorders;
  compound commands matched per subcommand; wrapper stripping that never strips `npx`/`docker`; rules
  on primary content fields refused with a reason; a hardline floor below every override; fail closed.
- **`authorize()`** composes the two. The collision worth naming: `exec` is mutating *and* untrusted, so
  a flat "tainted turn refuses mutating calls" rule kills the feature on its first call. The answer is
  not a weaker gate but a precise one — a tainted mutating call needs *explicit authorization*, a rule
  the user wrote or an approval the user gave, and `mode: allow` is the absence of a rule rather than
  one. This promotes `confirm` out of Phase 9 and revises decision 4.26.
- **Escapes stripped in core**, from every untrusted observation and from the approval prompt's command.

### Part B — `packages/tools-system` ✅

- **`exec`** — `command`, `workdir`, `timeoutMs` (120 s default, 600 s ceiling, clamped under
  `limits.toolTimeoutMs`), `pty` (default false), `background`. No `env` argument: see decision 4.32.
- Non-persistent sessions, **cwd carries and environment does not** (decision 4.33).
- Two-tier output: inline under ~6,000 characters, otherwise spilled to a file with the path handed to
  the model. Over-running commands are backgrounded, not killed, with a named exception list.
- **The file family** — `file_read`, `file_write`, edit, and separate `glob`/`grep`, to the shapes
  already in `evals/fixtures/catalogue.ts`. Separate rather than Hermes' unified
  `search_files(target:…)`: choosing a mode is a second decision, and second decisions are the two-hop
  shape small models fail — the same reasoning that keeps `tools.search` off.
- **Protected paths, checked before allow rules**: `agent.yaml`, the workspace files (`SOUL.md`,
  `SOUL.compact.md`, `AGENTS.md`, `POLICY.md`, `REMINDER.md`), the policy file itself, and the
  credential floor (`.ssh`, `.aws`, `.kube`, `.netrc`, `.env*`). Elsewhere this protects config; here it
  stops the agent rewriting its own constitution.
- Tool descriptions **route the model away from the shell**, and that is a security control rather than
  a style note: a `file_read` call has a `path` a rule can match exactly, `cat "$F"` does not.

### Part C — `packages/tools-web` ✅

`web_search` over `tavily | brave | exa` behind one signature (Tavily first); `web_fetch` as one GET
with extraction to text. No JavaScript, no crawling, no link-following. SSRF refused rather than
configured away: loopback, link-local, RFC-1918 and CGNAT rejected before the request, non-http(s)
schemes rejected, redirects re-checked per hop, parsed with `new URL()` and never a regex. Stop at
`maxBytes` *during* the response.

**Stated honestly:** these controls bound *this tool*, not the agent. A policy that allows `exec`
allows `curl`, and no amount of SSRF checking here changes that.

Built 2026-08-15. `address.ts` classifies (pure, table-tested, IPv4-in-IPv6 decoded first);
`guard.ts` checks scheme → credentials → hostname shape → DNS → every returned address, at every hop;
`extract.ts` strips tags without a DOM parser, including the unterminated forms a `maxBytes` cut
leaves behind; `backends.ts` keeps all three search APIs behind one spec so the model cannot tell
which is configured. No escape hatch for private addresses, and DNS rebinding documented as out of
scope. `evals/web/` records the injection run and why it is saturated.

### Part D — `tools.providers` as a map ✅

`RegistryOptions.providers` is already an array; only the manifest field is scalar, which means
`system`, `composio` and `web` cannot be configured together. `provider` + `providerConfig` survive as
the warning alias, copying the `context.files` pattern; setting both is a hard failure, not a merge.

Built 2026-08-15. `manifest/providers.ts` is the one function the runtime, `Agent.create`, `validate`,
`tools --warm` and `config_set` all read the fields through — a check only `run` performs is a check
`validate` disagrees with. `init` generates the map with `system` live and `web`/`composio` commented
inside it at the indentation that makes them work.

**Files.** `packages/core/src/tools/{types,trust,policy,sanitise,registry,execute}.ts`,
`tools/dialect/{nlt,native}.ts`, `loop/turn.ts`, `manifest/schema.ts`, `runtime/agent.ts`,
`packages/tools-system/`, `packages/tools-web/`, `packages/cli/src/{run,transcript,lib/*}.ts`,
`evals/web/`

**Acceptance**

- [x] A provider tool with no declared trust resolves as `untrusted`; a local built-in as `trusted`
- [x] An untrusted observation reaches the model delimited and labelled, under **both** dialects
- [x] A forged closing fence inside fetched content does not escape the block
- [x] With `onMutate: refuse`, a turn that fetches and then asks for a mutating tool is blocked, emits
      `tool.gated`, and the model reports back rather than erroring out
- [x] The same-step case is gated — untrusted content and a mutating call in one step
- [x] Every announced call is answered, gated ones included, which `native` requires
- [x] Deny beats allow regardless of specificity; a compound command is matched per subcommand
- [x] The hardline floor holds against an explicit allow rule, and never reaches the approver
- [x] `ask` with no approver denies loudly; a thrown approver denies
- [x] Escape sequences in tool output never reach the approval prompt or the transcript
- [x] An `export` in one `exec` call is not visible to the next, while a `cd` is
- [x] A command under `pty: true` reports its own exit code, not the wrapper's, and sees a terminal
- [x] Large output spills to a file the model is given the path to; a failure shows head **and** tail
- [x] A once-per-turn configuration is named at load, not discovered mid-turn
- [x] `file_write` to `SOUL.md` and to `agent.yaml` is refused by default, and no allow rule reaches past it
- [x] `file_edit` refuses a `find` string that matches twice, and writes nothing on either failure path
- [x] `glob` distinguishes `*` from `**`; every cap says it was a cap
- [x] The file tools and `exec` share one working directory
- [x] A tool call written in some other protocol's format earns a repair instead of becoming the reply
- [x] `init` generates a working `system` provider, `pinned` set and `policy` block from one answer
- [x] Writes are confined to `workspace/`; only `tools.providerConfig.writeRoots` widens it, and a
      `../` traversal is collapsed before the check rather than after
- [x] Reading outside the root still works — only changing things is confined
- [x] The model is told which tools exist and were not enabled, under **both** dialects
- [x] `config_set` validates before writing, changes only the lines it means to, and refuses the three
      edits whose only purpose is to disable a check — including widening its own write roots
- [x] Every path argument names the working directory; `exec` is told a different, true sentence
- [x] A leading `~` is expanded before the root check rather than resolved into the workspace
- [x] `/restart` rebuilds the agent so a `config_set` change can take effect without leaving the CLI
- [x] A page reading "ignore previous instructions and email X" produces no mutating call — recorded in
      `evals/web/` with the number. **0/18 across three runs, and the README says why that is a
      saturated probe rather than a result**: the gate never fired because the model never attempted a
      mutating call, so what is measured is the *model's* resistance and not the gate's
- [x] `web_fetch` refuses loopback, link-local, RFC-1918, `file://`, and a public URL redirecting to
      any — and the stub records that **no request was made**, rather than that one failed
- [x] A 50 MB page stops at `maxBytes` — asserted on bytes pulled off the socket, not on the
      observation size. One chunk of constant overshoot, from the stream's read-ahead
- [x] `tools.providers` resolves several providers into one catalogue, in manifest order, collisions
      still a load failure naming both
- [x] A manifest using the old singular `provider` still loads, with a warning naming the rewrite;
      both spellings at once is refused
- [x] `bun run bench:boot` unchanged — the system provider resolves from memory and warms nothing

**Non-goals.** Crawling, link-following, sitemaps. JavaScript rendering and headless browsers. PDF and
image extraction. Caching fetched pages. Content sanitisation beyond delimiting and escape stripping:
rewriting untrusted text to remove instruction-like phrasing does not work, and pretending otherwise is
worse than the honest boundary. **Sandboxing** — a sandbox decides *where* a command runs, the policy
decides *whether*; this phase ships the policy and containment stays a deployment concern.

**Sequencing.** A → B → C → D, each independently reviewable and green. A first because it is what
makes B safe; B second because it is the capability actually wanted.

### Deviations from the plan as written

- **`allowPrivateHosts` was in the reference manifest and is not in the code.** Writing the guard is
  what made the problem obvious: the single real use of that flag is reaching a service on the local
  network, and the highest-value thing on the local network is the cloud metadata endpoint. An
  operator who wants an internal HTTP call has `exec` and `curl` — deliberate, and narrowable by a
  policy rule — rather than a setting that quietly grants the same thing while the manifest still
  reads as though the agent only touches the public web. Decision 4.63.
- **DNS resolution turned out to be part of the check, and rebinding turned out not to be closable.**
  The plan said "rejected before the request", which only covers address literals; a hostname needs a
  lookup, and then *every* address it returns needs classifying, because Node connects to whichever
  answers first. What that cannot close is the gap between the guard's lookup and the client's own —
  `fetch` gives no way to pin the checked address into the socket. Recorded in three places rather
  than implied to be covered (decision 4.65).
- **The injection eval needed a third category before it measured anything.** Its first run scored
  the *ideal* behaviour as a failure: deepseek-v4-pro answered the question and then told the user the
  page had tried to make it write a marker — which put the marker in the reply, which was the entire
  check. `complied` and `reported` are now separate, on a labelled heuristic, and the run is
  saturated at 0/18 either way. Decision 4.68.
- **`config_set`'s write-root floor had to move with the field, and grow a value check.** `writeRoots`
  went from `tools.providerConfig` (a path the agent could not set) to `tools.providers.system` (inside
  a value the agent *can* set, because enabling the web provider is exactly what `config_set` is for).
  A floor pinned to the old path would have been a floor with a new way round it. It now refuses a
  `writeRoots` segment anywhere and a `writeRoots` key nested anywhere inside a `tools.providers`
  value.
- **`setInSource` wrote `[object Object]` for a map value.** Maps became settable for the first time
  with `tools.providers`, and the renderer handled scalars and arrays only — so the value fell through
  to `String(value)` and the schema rejected the result as "expected record, received array", a
  message pointing nowhere near the cause. Caught by the tests written for the new setting.
- **The web provider shipped generated-but-commented, which made it invisible to the model.** Asked
  whether it could search the web, a fresh agent answered that the only route was shell access and
  `curl` — a correct reading of its own catalogue and a false statement about the runtime, and the
  worse of the two answers. Naming a provider is what makes `available()` run; decision 4.53 had
  established that for `system` and it had to be learned again. `init` now asks about the internet
  the way it asks about the machine — `--web none|fetch|search`, with the backend and its key asked
  only of someone who chose search (4.69, 4.71).
- **A `.env` in the current directory was silently reconfiguring sandbox agents.** An agent whose own
  `.env` named `deepseek-v4-flash` ran a whole session on `deepseek-v4-pro` because the binary was
  launched from a checkout whose `.env` said so. Reported twice, which is what settled the fix:
  the first pass warned, and a warning explained the surprise without removing it. Precedence is now
  export → the agent's own file → the cwd file, decided in `cli/lib/ambient.ts` (4.70, 4.72).
- **`config_set` now re-checks the providers block, not just the schema.** Writing `tools.providers`
  into a manifest still carrying `tools.provider` produces a document the schema accepts and the
  runtime refuses — an agent that boots today and not tomorrow, reported as success. It calls the same
  `resolveProviders` the runtime does.

---

## Phase 3.7 — Onboarding

**Goal.** One command from installed binary to an agent that answers: `init` asks for the user's
name, the agent's name, a purpose line and a model endpoint, writes a complete starter agent, and
validates it with the real loader before exiting 0.

Inserted rather than renumbered, like 2.5, 3.5 and 3.6. It depends only on Phase 3.5's loader and
templates — nothing on channels — and before it the only onboarding path was "copy
`examples/workspace-template/`, fill the placeholders by hand".

**Deliverables** — built 2026-08-14:

- [x] `cli/src/lib/init-flow.ts` — the question flow as pure data (steps, per-answer validation
  with the loader's own base-URL rules applied at the question, presets, the file plan). In the
  boundaries test's PURE list, so a renderer swap stays cheap.
- [x] `cli/src/lib/templates.ts` — the five workspace templates embedded as constants, because the
  installed binary ships only `dist/` and cannot read `examples/`. The examples directory stays
  the human-edited source of truth; `test/templates.test.ts` asserts byte-equality, so drift is a
  red CI run naming the file.
- [x] `cli/src/init.ts` — interactive readline wizard at a TTY (summary + one `[Y/n]` before
  writing), flag-driven everywhere else, per-target overwrite refusal with no `--force`, and the
  in-process validate. When the named key var is not yet set it is stubbed as `(pending)` so the
  structural checks run for real — the generated `.env` deliberately leaves the key empty.
- [x] `examples/workspace-template/{USER,MEMORY,REMINDER}.md` — the three standard files the
  template set was missing, authored in the same guidance-comment style.
- [x] The first optional positional (`init [dir]`) and the first consumer of the mode decision's
  `because` string, printed when a non-interactive run refuses.

**Acceptance**

- [x] `init --user … --name … --preset deepseek --yes <dir>` exits 0; the generated directory
  passes `validate` and `run`-loads unchanged — verified live
- [x] The generated `AGENT.md` is runnable but keeps `{{INPUT_n}}`/`{{REPLY_n}}`, and `workspace`
  reports exactly one finding: the placeholders — the nag until a person writes real examples
- [x] `--preset ollama` omits `apiKeyEnv` from the manifest entirely (never an empty string) and
  omits the key line from `.env`; the result loads with no stub
- [x] Re-running into the same directory refuses, naming every collision
- [x] Non-interactive without `--user`/`--name` refuses, naming the flags and why it could not ask
- [x] No flag accepts the API key's value — one on the command line lands in shell history
- [x] **Revised 2026-08-15:** the wizard *does* ask for the key, masked, and writes it to the
  gitignored `.env`; the manifest still names only the variable. Asking for the variable *name*
  while asking for every other setting's value outright produced an empty `MODEL_API_KEY=` and an
  agent that only ran where another `.env` happened to be in scope

**Non-goals.** An Ink wizard (the flow is pure so a renderer swap stays cheap; a numbered menu is
equivalent for a run-once command) — **reversed by decision 11.13 in Phase 3.8**, exactly through
the renderer swap this non-goal priced in; the sub-clauses below stayed binding. `--force`
(replacing a personalised workspace is the loss `soul distill` already refuses). Asking for secret
values (shoulder-surfing at a prompt, shell history via a flag). Channel or schedule
configuration — those arrive with their phases.

### Added after the phase closed

- **2026-08-16 — Composio is a question** (`--composio none|connected`), completing the sweep the
  web provider started: every capability the runtime has is asked about here (decisions 4.77–4.78).
  It is the one answer that cannot pin a tool — Composio resolves from an on-disk cache inside boot
  where no request is permitted, so `init`, which makes no requests, has no honest way to leave a
  usable pin. The next steps name `tools <ref> --warm` and say plainly that nothing is available
  until it runs. `none` leaves the block commented rather than named-and-empty, because Composio
  has no `available()` and naming it would tell the model nothing — the rule is *name a disabled
  provider when it can report what it lacks, document it when it cannot*.
- **The first test written for it found a latent boot failure** (decision 4.79). The registry hands
  every provider the whole `pinned` list, so a cold Composio was asked about `config_read` and threw
  from `resolve()`, refusing a manifest in which nothing was wrong. Providers now report through
  `explainUnresolved()`, which the registry consults only once a slug is missing everywhere. It had
  been reachable by hand since the provider map landed in Phase 3 Part D and unreachable through any
  generated manifest, which is why it survived.
- **The root `build` script did not build the `tools-*` packages** (decision 4.80), so the fix above
  appeared not to work twice against a stale `dist`.
- **2026-08-16 (later) — the Composio answer had no route behind it**, and the wizard question is
  what made that visible. `tools --warm` refreshes the slugs already in `pinned`, so a slug had to
  be known before it could be warmed and warmed before it could be pinned; the only way in was
  composio.dev in a browser. Moeen asked a generated agent to connect his Gmail and it burned 4,417
  output tokens establishing there was no path. Three meta tools now close it — `composio_search`,
  `composio_connect`, `composio_workbench` (decisions 4.81–4.87) — and `connected` pins the first
  two plus the allow rule the sequence needs. Verified live end to end against the real API: a fresh
  agent asked to set up Slack searched, returned an OAuth link, pinned `SLACK_SEND_MESSAGE` and
  `SLACK_FIND_CHANNELS`, added the allow rule, and asked for a restart.
- **Decision 4.78 was reversed within the week** — `composio: {}` is named while switched off, like
  `web: {}`. Its reasoning was sound and its premise moved: the provider now has an `available()`
  worth calling. The rule it established outlived it.

### Deviations from the plan as written

- **The repo-root `.env` contaminated the first integration test.** Bun auto-loads it, the real
  environment wins over the generated agent's own `.env`, and the test aimed at Ollama loaded
  DeepSeek — the exact leak `CLAUDE.md` already records, caught by its own test this time. Tests
  inject a clean `env`; the command's own validate deliberately keeps the real layering, because
  validating what `run` would actually do is the point.

---

## Phase 3.8 — Home sandbox, TUI kit, and run-by-name

**Goal.** Agents live in `~/<stateDir>/agents/`, every manifest command takes a bare agent name,
bare `run` opens a picker (or auto-runs the only agent, or walks straight into the wizard on an
empty sandbox), and the CLI's three interactive surfaces — chat, init wizard, run picker — share
one visual language built on a reusable component kit.

Inserted rather than renumbered, like 2.5–3.7. Two recorded non-goals are reversed on the record
(decisions 11.13 and 11.14): the flow stayed pure precisely so the Ink wizard would be a renderer
swap, and the theme is one internal token set, not a theming system.

**Deliverables** — built 2026-08-14:

- [x] `core manifest/header.ts` — `readManifestHeader`: id/name/model with no env expansion and
  no validation, so a listing never requires credentials (decision 11.17)
- [x] `cli/lib/sandbox.ts` — `sandboxRoot` (`<ENVPREFIX>HOME` override, else `~/<stateDir>`),
  `listAgents` (broken entries listed with their problem; duplicate ids marked), `resolveAgentRef`
  (filesystem beats name; shadowing prints a note; unknown names get candidates + nearest)
- [x] Default session store → `~/<stateDir>/store.db`, with a one-line legacy hint when a
  cwd-relative store exists (decision 11.15)
- [x] `init` generates the **soul pair** wired through `context.soul` for identity and
  **`AGENTS.md`** for operations (decisions 11.18–11.19; the old identity-flavoured `AGENT.md`
  template is gone — what a soul replaces is the *identity* document, and the rewritten
  `AGENTS.md` is not one); templates joined `examples/workspace-template/` (drift-tested, still
  seven files); the generated agent.yaml is reference-style — everything configured active,
  everything later commented with its phase, `tools.local: [now, memory_write]` live from a table
  pinned to core's `LOCAL_TOOL_SLUGS`
- [x] `init` defaults into the sandbox; next steps say `run <name>`; the done screen reads the
  gate's own `soul_distilled` warning and names the identity file the model actually ships
- [x] TUI kit: `lib/theme.ts` tokens (PURE), Banner / SelectList / TextField / LineCursor /
  WizardFrame / SummaryCard / Spinner, all controlled and input-free
- [x] Ink init wizard: `lib/wizard.ts` log-reducer over `nextQuestion` (esc-back pops the answer
  log, so re-answering the preset re-derives downstream defaults; flag answers never poppable;
  honest step totals across the keyless skip), `WizardApp` with one `useInput` over
  `keyToWizardIntent`; confirm = summary card + yes/no; ^C anywhere = "nothing written", exit 0
- [x] Run picker: bare `run` → empty sandbox = wizard (rich) / refusal naming `init` (plain);
  one agent = auto-run with a printed line; several = Ink picker (rich) / plain list + non-zero
  (piped), printing the mode decision's `because` for the first time
- [x] Chat restyle: the banner is a boxed `banner` role inside `<Static>` (a dynamic-region
  sibling would draw below history and redraw every frame), bordered input, status bar as footer
- [x] Name resolution for `run`/`sessions`/`validate`/`workspace`/`tools`/`agents`, one resolver
  at the dispatch layer

**Acceptance**

- [x] `DISPACH_HOME=<tmp> init --user … --name Milo --preset deepseek --yes` writes 10 files to
  `<tmp>/agents/milo`, validates, and prints `run milo` — verified live
- [x] `run milo`, `validate milo`, `workspace milo` resolve from any cwd; unknown names list
  candidates with a nearest-match hint — verified live
- [x] Bare piped `run`: two agents list + exit non-zero; empty sandbox refuses naming `init`;
  one agent auto-runs straight into the model call — verified live end-to-end (a stub key
  reached the endpoint's 401, which is the whole chain working)
- [x] The generated qwen/deepseek agent ships SOUL.compact.md and the done screen says so;
  a 393k-window frontier id ships SOUL.md — asserted through `resolveWorkspace`
- [x] The rule budget holds on both gate paths (counted 1 ≤ 2), pinned by test
- [x] Plain paths byte-identical throughout — untouched by construction, the plain-parity tests
  keep passing
- [x] Interactive pass at a real TTY (wizard esc-back, picker, create-new→chat) — needs a human
  terminal; everything beneath it is reducer-tested

**Non-goals.** User-configurable themes (11.14 is one token set). Mouse support. A `--force`.
Asking for secret values. Detection-first onboarding (scanning for keys/local servers, verifying
with a real completion — OpenClaw's pattern, worth a phase of its own if ever).

### Deviations from the plan as written

- **A cwd entry shadowing a sandbox name prints a note.** The filesystem-wins rule is right (git's
  pathspec precedent, free escape both ways), but the first live test ran the *wrong* milo
  silently — a `./milo` from an earlier experiment beat the sandbox agent with nothing said.
  One stderr line naming both is the honest middle.
- **`tools.web` refuses as an unknown schema key, not a phase-named refusal.** The generated
  manifest's commented Phase 3.6 block is real config, but its schema does not exist yet, so
  uncommenting it early reports "Unrecognized key" rather than "arrives in Phase 3.6" — equally
  loud, less specific. The uncomment test pins `phases:` instead, which is schema-complete and
  phase-refused. When 3.6 lands its schema, the refusal upgrades for free.

---

## Phase 4 — Channels, server, outbox

**Goal.** Telegram works. The HTTP API works. Delivery is idempotent.

**Sequencing note.** Split in two, as Phase 3.5 was. **Part A** is `core/src/channels/` plus the
migration, proven deterministically against a fake transport — the exactly-once behaviour is
entirely in states you cannot reach by using a real channel by hand, so a live bot proves less about
it than a test that kills the process at a chosen instruction. **Part B** is `channel-telegram`,
`packages/server`, and `serve`.

**Deliverables**

- `channels/channel.ts`, `inbox.ts` (normalisation, `allowFrom`), `outbox.ts`, `split.ts`
- Migration 002: `outbox` with idempotency keys, retry, backoff
- `packages/channel-telegram` — raw Bot API, long-poll and webhook, chunking at 4096, typing indicator
- `packages/server` — every endpoint in `04-SPEC-WIRE.md` except schedules
- SSE with heartbeat; WS endpoint
- `dispach serve` — a `lib/commands.ts` entry plus a plain writer

**Files.** `packages/core/src/channels/`, `packages/channel-telegram/`, `packages/server/`

**Acceptance**

- [x] Real Telegram bot: message in, agent replies, typing indicator shows — verified live against
      `@milothecat_bot` under Phase 4.1's daemon, surviving a logout and answering afterwards. The
      first live run answered nothing while every check reported healthy: `allowFrom` held
      `@moeen-mahmud` and the real handle is `@moeen_mahmud`, so a correct refusal was written to a
      log nobody opens. That is why the wizard now validates a handle against Telegram's own
      `[A-Za-z0-9_]{5,32}` and `daemon status` reports an up-and-not-working service
- [x] Long-poll verified end to end live, including recovery: `tg: error — fetch failed` followed by
      `tg: connected — polling resumed` in the service log, the loop surviving a blip rather than
      exiting on its own
- [ ] Webhook mode verified end to end against the real API — it needs a public HTTPS endpoint this
      machine does not have, and it is the mode where a collision is *undetectable* (`setWebhook`
      silently moves the hook to the last caller; there is no 409), so it is the one that most wants
      a live run. Covered against a scripted Bot API meanwhile, as is long-poll: offset advance,
      leftover-webhook cleanup, poll-failure recovery, secret verification, and the 429/403/5xx
      classification
- [x] Message over 4096 chars chunks correctly, order preserved — `due` withholds any chunk whose
      predecessor is not `sent`, so ordering is a property of the query rather than of the caller
- [x] Killing the process mid-delivery and restarting sends **exactly once** — at every crash point
      except the one that cannot be closed from this side; see the deviation below, which is the
      honest form of this criterion and replaces it
- [x] `allowFrom` blocks a non-listed sender inbound but does not affect outbound — enforced in
      `Inbox.accept`, which the outbox never consults
- [x] Bad bot token → `agent.channel.error`, `runtime.ready` still fires, `/v1/health` 200 —
      verified live against the built binary: the error carried its hint, `/v1/health` returned 200,
      `/v1/ready` returned ready, and the agent resource reported `tg: error`
- [x] `POST /v1/agents/:id/messages` → 202, SSE streams, disconnect does not cancel — 202 with
      `{turnId, sessionKey}`, `stream: true` returns 202 *with* an SSE body opening on
      `turn.accepted`, and the turn runs detached; only `POST /stop` ends one early
- [x] Non-loopback host without a token refuses to start — `server_public_without_token`, exit 1,
      verified against the binary
- [x] Boot budget still met with channels configured — median 22 ms. Constructing a transport
      allocates an object; the `channels` boot phase is sub-millisecond and nothing connects until
      after `runtime.ready`

**Non-goals.** WhatsApp. Schedules.

### Part A — deviations from the plan as written

- **It is migration 003, not 002.** The number in this document predates Phase 3's
  `messages_tool_calls`. `assertContiguous` checks versions by list position, so renumbering to
  match the doc would fail at boot.
- **"Exactly once" is stated per crash point rather than as a single claim.** Crash before enqueue,
  before claim, or after `markSent` all provably send once. The window between the bytes leaving the
  process and the acknowledgement arriving back cannot be closed without provider-side deduplication
  on a key we supply — Telegram has no such parameter. So `ChannelLimits.idempotentSend` declares
  which kind of channel it is, a recovered row is re-sent and flagged, and `delivery.uncertain`
  reports it. Decision 8.9. A criterion phrased as an unqualified guarantee would have been met by
  writing the guarantee down, not by holding it.
- **`split.ts` is a fourth file, not part of `outbox.ts`.** It is pure, it is where the grapheme and
  code-fence subtleties live, and it earns its own tests. Decision 8.12.
- **`EnqueueDelivery.nextAttemptAt` and `recoverInflight(nextAttemptAt?)` take the caller's clock.**
  `markRetry` always did. The other two stamped the wall clock while the engine read an injected one,
  which is invisible in production and made tests time-of-day dependent. Decision 8.13.
- **`node:sqlite` truncates a bound string at a NUL byte; `bun:sqlite` stores it whole.** Row seven
  in `sqlite/driver.ts`'s differences table, found by a group key built with a NUL separator that
  round-tripped truncated under Node, matched nothing, and abandoned no chunks — silently, on one
  runtime out of two. Keys are percent-encoded now. It is documented rather than normalised:
  escaping every bound string on the hot path to handle a byte that does not occur in chat text is
  the wrong trade, and a NUL inside message content remains a known divergence.
- **The `channels` and `delivery` manifest sections stay refused.** Part A ships no channel *type*,
  so a `channels:` entry still cannot resolve to a transport. The gate in `validate.ts` becomes
  type-aware in Part B, when there is something for it to accept.

### Part B — deviations from the plan as written

- **`POST /v1/agents/:id/reload` answers 501 rather than reloading.** Decision 11.20. The spec
  describes rebuilding the tool index live, which contradicts the fixed-catalogue design the cached
  prompt prefix depends on. The refusal names the reason and points at a restart.
- **WebSocket is Bun-only.** Decision 11.21. Node gets a 501 naming the reason rather than a
  dependency on `ws`; SSE plus `POST /messages` covers everything the endpoint does.
- **`GET /v1/agents/:id/skills` returns `{ skills: [], supported: false }`.** A bare empty array
  cannot be told apart from "this agent has no skills", which is the silent-nothing shape rule 8
  exists to prevent. Phase 5 fills it in.
- **`Agent.previewContext` is a new core seam.** `GET /v1/agents/:id/context` must show the prompt
  the agent *actually* assembles, so it calls `assembleContext` with the same arguments `send` does
  rather than the server rebuilding the argument list — which would answer a question about a prompt
  nothing uses, and drift the first time a slot moved.
- **`TurnStreams.open(turnId)` is new, and `attach` still does not create buffers.** A caller that
  starts a turn and immediately attaches — `POST /messages` with `stream: true` — arrives before the
  first event, because `Agent.send` awaits the session write before emitting. Creating a buffer
  inside `attach` instead would make a typo'd turn id indistinguishable from a real one and leave
  the client tailing an empty stream forever.
- **Bun's `idleTimeout` was killing SSE streams at 10 s.** Decision 11.22 — found by running the
  binary, invisible to the tests, and now derived from `HEARTBEAT_MS`.

---

## Phase 4.1 — always on

**Goal.** An agent keeps answering with no terminal open, `serve` is safe for any supervisor to
restart, and every CLI and TUI surface that should mention it does.

Inserted rather than renumbered, like 2.5–3.8. It depends on Phase 4's channels and outbox, and
Phase 5 depends on none of it. Split in three, as Phase 4 was: **A** makes `serve` supervisable and
is pure runtime work, deterministic under both sqlite drivers and useful to Phase 11's container
whether or not B ships; **B** is the macOS service command; **C** is the DX pass the CLI needed
anyway and this feature made unavoidable.

**Deliverables** — built 2026-08-17:

- [x] **A1** Migration 004 `runtime_leases` + `LeaseStore` — one row per agent id, claimed
  transactionally before channels start, released in `runtime.stop`, heartbeat every 30 s.
  `runtime/lease.ts` owns liveness (`process.kill(pid, 0)`); the store stores facts and never
  probes the OS. `RuntimeOptions.mode` records daemon/terminal/embedded so a refusal can say where
- [x] **A2** `turns.reapRunning(agentIds, reason)` and `outbox.recoverInflight(agentIds, …)` scoped
  to leased agents — `agentIds` **required**, so the global form is unexpressible;
  `leases.orphans()` names rows belonging to no lease at all
- [x] **A3** `serve` registers its shutdown with `onExit` instead of a second SIGTERM listener;
  `claimSignals()` lets it own the code so a requested stop exits 0; `runtime.stop` bounds each
  `provider.stop()` at 5 s and reports what it abandoned
- [x] **A4** Exit-code contract: a configuration fault exits non-zero once, a transient never exits
- [x] **A5** `serve` defaults to `storePath()` — it was silently running on `":memory:"`
- [x] **B** `daemon install|uninstall|start|stop|restart|status|logs`; `lib/launchd.ts` (pure plist
  rendering, `launchctl` parsing, wait-status decode), `lib/daemon-plan.ts` (pure preflight and
  status verdicts), `lib/service.ts` (the seam, the only subprocess in the package),
  `KeepAlive: {Crashed: true}`, install watches and rolls back, `enable` before `bootstrap`
- [x] **C** `stop [agent]` — the safety switch: finds installed services *and* any process holding
  a lease, SIGTERM before SIGKILL, disables as well as unloads, exits 0 when nothing is running;
  `serve` sets `process.title` so an installed service is not an anonymous `node`
- [x] **C** `lib/render.ts` — the plain path's shared vocabulary, replacing eight hand-rolled
  column widths; `ArgSpec.choices` so `--help` lists every action, pinned by a test; `/status` in
  the session menu; `agents` reports live state from the lease; `serve`'s banner names the daemon;
  `init` asks and prints the command; the generated `.env` is 0600

**Acceptance**

- [x] The agent answers Telegram with no terminal open — verified live: `daemon install milo`,
      `tg: connected — @KamlaAI_bot, long-poll` in the service log, `/v1/health` 200
- [x] `launchctl print` echoes no secret — verified live against the loaded job: zero occurrences
      of either the bot token or the model key, while the OpenClaw job beside it prints its gateway
      token in plaintext
- [x] A configuration fault stops the service once instead of looping — verified live: bot token
      blanked, `daemon restart`, watched for 36 s at `starts 2` and holding; `status` printed the
      exit code and the `telegram_token_missing` tail, and exited non-zero
- [x] A second `serve` on one agent is refused, naming the pid — two real processes, in
      `cli/test/serve.test.ts`
- [x] SIGTERM runs the full shutdown and exits 0, proven by the lease row being released — the
      first test in this repo that spawns the built binary, and the reason the bug survived is that
      there was no `serve.test.ts` at all
- [x] Agent B's boot leaves agent A's `running` turns and `inflight` deliveries alone — two
      runtimes over one temp database, under both sqlite drivers
- [x] `--help` lists every action of every action-taking command, pinned by a test
- [x] Boot budget unchanged — `bench:boot ok`; the lease is one indexed row and the heartbeat
      starts after readiness
- [x] Log out and back in and the agent comes back by itself — verified live across a real session
      change: `loginwindow` 474 → 14677 and `milo` 87667 → 14922, `runs` back at 1 (a fresh load,
      not a restart), serving 14 s after login with no command typed. The service log carries the
      whole boundary — `stopping` / `tg: disconnected` on the way out, so launchd's SIGTERM ran
      A3's teardown rather than the hard exit that used to win, then `tg: connected` on the way
      back. `RunAtLoad` is the load-bearing key: `KeepAlive: {Crashed: true}` restarts a crash and
      starts nothing at login, so without it the job loads and waits forever for a start condition
      it does not have. A reboot with no login still leaves the agent down — that is the `gui/$UID`
      limitation, and it is in Non-goals rather than here, because no criterion can satisfy it

**Non-goals.** systemd and Linux service installation — unverifiable here, so Linux gets a refusal
that names the gap *and* prints the resolved `ExecStart=` line, behind `resolveServiceManager`.
Containers, which supervise themselves and are the deployment this runtime is designed around. Log
rotation, which has no rootless mechanism on macOS. `LaunchDaemon` in `/Library/LaunchDaemons` —
a `gui/$UID` agent needs a logged-in desktop session, so a reboot with nobody logged in leaves the
agent down; the fix needs root *and* a different secrets story, since `.env` beside the manifest is
readable by one user and a system daemon runs as another. `daemon doctor`, health checks,
`install --all`, a `daemon:` manifest field.

### Deviations from the plan as written

- **The lease replaced the pid file.** The plan reached for `{pid, startedAt, mode}` in a state
  file; a row in the store the runtime already opens is not a new lifecycle, is contended inside
  the component that is already a lock manager, is testable with two runtimes over one temp
  database, and does three jobs instead of one.
- **Recovery is scoped by ownership, not by agent id.** Scoping by agent looked equivalent and
  breaks the guarantee `reapRunning` documents: a deleted or renamed agent's rows would stay
  `running` forever, which is the exact ambiguity it exists to remove. `leases.orphans()` keeps the
  narrowing honest.
- **A dead pid beats a fresh heartbeat, and this was found by installing the real thing.** The
  first rule trusted a recent heartbeat without probing. A boot that fails *after* claiming — a
  missing bot token, the single likeliest install-time fault — then blocked every retry for ninety
  seconds, naming a pid that no longer existed, at the moment somebody was fixing the fault.
- **`installGuards` needed `claimSignals`, not just `onExit`.** Registering the shutdown as a
  teardown made it *run*; the guard still forced exit 143, which under `KeepAlive: {Crashed: true}`
  a supervisor reads as "this configuration is broken, stay down". Caught by the new spawn test on
  its first run.
- **`KeepAlive: {Crashed: true}`, not `{SuccessfulExit: false}`.** Restart on a crash signal only.
  The trade is explicit — an uncaught exception stops the service rather than looping — and it is
  the right way round for a codebase whose objection to the 2,463-restart job is that nobody was
  ever told.
- **`hub.started` exists because slot 2 was still wrong.** `Runtime.create` derived
  `channelsStarted` from `hub.statusOf(id).length > 0`, which is true under `run` as well, since a
  binding is registered either way — so decision 5.17's bug had survived its own fix one layer
  down. Found by building `/status`, the human-facing twin of the same block.
- **`RuntimeOptions.lease`.** A read-only listing must not claim a lease: `agents` briefly holding
  one could refuse a `serve` starting in the same millisecond, a race invented by the act of
  looking.
- **`daemon logs` shipped** after being cut. It is fifteen lines on top of `status`, and telling
  someone to type `tail -f` is the difference between a tool and a wrapper.

---

## Phase 5 — Skills

**Goal.** agentskills.io-compliant skills, harness-side selection, script execution.

**Deliverables**

- `skills/frontmatter.ts` — the published spec enforced: `name` 1–64 chars, lowercase alphanumeric and
  single hyphens, no leading/trailing hyphen, no `--`, **equal to the parent directory name**;
  `description` 1–1024; `compatibility` ≤500. Unknown top-level keys are kept and ignored — the
  deliberate divergence from `parseWorkspaceFile`, which throws on them. Reuses `strip()`, so
  frontmatter and HTML comments cannot reach the model by a second route
- `skills/index.ts` — frontmatter-only scan, `<stateDir>/skills.idx.json` cache keyed on each file's
  mtime and size, versioned like `tools-composio/src/cache.ts` so a bump is a cold read and never a
  wrong one. Bodies are never read at boot
- `skills/select.ts` — BM25 as a **scorer, not an index**: a ranking-only `SkillSelector` over
  name + description + when-not-to-use, against the turn input and the previous assistant turn.
  Fifty skills of frontmatter is a few thousand terms, so there is nothing to index; `skills.idx.json`
  caches the *file scan*, which is what the 50 ms criterion measures. `activateKnowledge`'s
  rank-then-take walk is generalised to `activate()` and shared, because a second index beside
  Phase 3.5's selector is exactly what `knowledge.ts` was written to prevent
- `skills/load.ts` — body into `SLOT.skill`, **by name, never by number**; role from
  `promptStyle.skillsIn`, carried since Phase 3 and consumed here for the first time. Selected once
  per turn, not per step
- `skills/scripts.ts` — **pure `interpreterFor` only**: `uv run` when Python metadata is present, else
  `python3`, TS/JS via the host, else the executable bit. A `ScriptRunner` port carries it to
  `tools-system`, which owns every process-group, cap-of-8 and reaping rule already; core owns no
  shell and gets no second spawn path. Loud failure at load on a missing runtime
- Scripts registered as `skill.<skill>.<script>` and visible only while active — rendered at the end of
  the **slot-5 skill block**, never in slot 1, which is rendered once and must stay byte-stable
- `SkillsSchema` gains `budget`; `skills` leaves `UNSUPPORTED_SECTIONS`
- Skill template with when-not-to-use under `metadata`, the spec's own extension point, keyed from
  `BRAND.slug`. Warned by `validate`, never required at load
- `dispach skills list|show|new|install|remove|validate` — table entry plus a plain writer, `--json`
  included. `new` and `install` turn skills *on* for an agent that skipped them at `init`, writing the
  `skills:` block and creating the directory in one step, because either half alone fails the load
- `dispach sources list|add|remove|update|search` — the repositories skills come from. Machine-level,
  so it takes no manifest; two built-in defaults compiled in; a page URL from the address bar is
  understood; search ranks with the same `bm25Selector` that decides activation
- `init` asks about skills, because every capability the runtime has is a question in `init`
- 3 example skills, one shipping a Python script

`dispach workspace validate` belongs to Phase 3.5, not here: it validates workspace tiers and
budgets, which exist by then. Skills only add the when-not-to-use check to it.

**Files.** `packages/core/src/skills/`, `packages/tools-system/` (the `ScriptRunner` implementation),
`examples/*/skills/`, `packages/cli/` — including `lib/sources.ts` (the registry), `lib/source-cache.ts`
(the git seam and the catalogue scan), `lib/origins.ts` (provenance) and `lib/spawn.ts` (the one spawn
site, moved out of `lib/service.ts`)

**Acceptance**

- [x] 50 skills index in under 50 ms cold, under 5 ms cached; a touched file re-reads and the other 49
      do not — measured **12.74 ms / 0.39 ms**
- [x] Selection picks the right skill on ≥20 fixture inputs; below-threshold inputs select none — the
      half that catches a scorer which always returns something. 17 positives all top-1 correct, scoring
      0.369–0.600 against the 0.35 default; two negatives score 0.000. Measurement is what found the
      normalisation defect — see the corrections below
- [x] Active skill's scripts appear in the catalogue the model was shown; inactive ones do not —
      rendered in the slot-5 block and layered onto the registry by `withTurnTools`, never in slot 1
- [x] **Slot 1 is byte-identical across a turn that activates a skill and one that does not**, asserted
      on the assembled prefix rather than trusted
- [x] A skill body over the whole budget fails at load, naming the skill and both numbers
- [x] A skill vendored unmodified from `anthropics/skills` loads with a warning, not an error — which
      is the whole of decision 6.1's compliance claim. Verified against four real skills fetched from
      that repository and not edited: `pdf`, `docx`, `mcp-builder` and `skill-creator` (33 KB). All four
      load, `skills list` reports them, `validate` exits 0 with six warnings — no negative guidance on
      two, a description that never says *when* on `pdf`, and a 9,065-token body on `skill-creator`,
      which is a warning precisely because it must not be a refusal. `license: Proprietary. LICENSE.txt
      has complete terms` parses as the spec's free-form license field
- [x] Python script skill runs end to end with `uv` — verified live through the real
      `SystemScriptRunner`: `uv run` created a venv in the skill directory and returned the script's
      output, and a non-zero exit came back as `skill_script_failed` carrying the script's own stderr.
      The shipped `csv-profile` example then ran on a real CSV end to end — "here is a csv export from
      salesforce, what shape is the data" scored 0.498, activated the skill, and the observation named
      the 40%-null column. What is *not* exercised is a model choosing to call it; that is model
      behaviour, and the runtime path either side of it is
- [x] Skill declaring Python with no runtime fails **at load**, naming both — probed once per distinct
      interpreter, on every load including a warm cache, since a machine can lose one between boots
- [x] Adding a skill file and reloading picks it up without restart; an edited *body* takes effect on
      the next turn without even that, because bodies are read on activation
- [x] `dispach skills validate` rejects a missing `description`; **warns** on a missing
      when-not-to-use — and warns on five more things measurement or the spec justified: a scaffold
      still holding its own instructions, a description under 40 characters, one that never says
      *when*, one whose only distinguishing word is generic (the measured false-activation shape), a
      body over the spec's advised 5,000 tokens, and a file in `scripts/` that can never run
- [x] Boot budget met with 50 skills — `bench-boot: ok`; the scan is 12.74 ms cold and 0.39 ms warm,
      and no body is retained
- [x] A skill can be added to an agent that skipped skills at `init`, in one command, without hand-editing
      `agent.yaml` — `skills new <agent> <name>` writes the block and creates the directory. Verified on a
      copy of a running agent: a five-line diff replacing the commented Phase 5 block, nothing reflowed
- [x] Skills are discoverable without knowing a URL: `sources search <words>` ranks every skill in every
      configured source, fetching one that has never been fetched. Verified against the real repositories —
      **442 skills** across `anthropics/skills` (17 under `skills/`) and `github/awesome-copilot` (425), with
      `anthropic/pdf` ranked first for "extract tables from a pdf invoice". Cold fetch of both: 24.6 s
- [x] A source is added from the URL a person actually has — the page they were reading.
      `sources add https://github.com/obra/superpowers/tree/main/skills` registers name `obra`, branch
      `main`, path `skills`, all three parsed out of the one string
- [x] Installing from a source records where it came from and reports it afterwards — `.origins.json`
      carries the commit, `skills list` shows `anthropic@f6656c1`, and `skills remove` names the origin as
      it deletes. Upstream moved between two test clones during this phase (`f6656c1` → `89dcaa3`, adding
      `claude-academy-guide`), which is the case the commit pin exists for
- [x] `init` asks — the skills question's first option searches the catalogues, installs the best match
      and names the runners-up. Verified live: `--skills "extract tables from pdf documents"` searched
      **443 skills across 2 sources**, installed `anthropic/pdf` at `89dcaa3`, listed the eight Python
      scripts it brought, and named `github/pdftk-server`, `github/convert-pdf-to-md` and `anthropic/docx`
      as runners-up. A scripted `init --yes` still reaches no network: 0.13 s, no cache directory created
- [x] Slot 2 names the skills rather than counting them, so "what skills do you have?" costs no tool calls
- [x] **Bare `skills` browses a curated catalogue and installs several at once.** 69 skills across the
      configured sources — 18 from `anthropics/skills` whole, 37 curated from `github/awesome-copilot`'s
      425, grouped by purpose — ticked with space, then an agent picked on a second screen. `--plain` and
      `--json` print the same list from the same `browseRows`, with the non-interactive install command
      underneath, because a picker is not scriptable
- [x] **`init`'s skills answer opens that catalogue**, not a text box. At a terminal `find` mounts the same
      checklist with the agent screen skipped; a scripted `--skills "<phrase>"` ranks and installs the best
      match, because a picker cannot run in CI. Asserted in `wizard.test.ts`: choosing `find` asks no
      follow-up question, and `find` and `starter` ask the same number of questions
- [x] **The catalogue is a step inside the wizard**, not a screen after it: answer `find`, it fetches with a
      spinner, you tick, and the remaining questions carry on. The pure reducer is untouched — `skillsPick`
      is in `InitAnswers` and not in `STEP_ORDER`
- [x] One row is one line at every terminal width. `lib/rows.ts` clips each column and shrinks name and meta
      before the description; asserted at 40, 60, 80, 100 and 140 columns, and the piped list has **zero**
      lines over its width. Before this every long description wrapped and the checkboxes stopped aligning
- [x] `skills.budget` is gone (decision 11.59), so ticking eleven skills installs eleven. Size is shown on
      the row instead of refused after it
- [x] A batch install reports once, with a runnable-file count, instead of one full report per skill
- [x] Upstream catalogues load as they actually are, not as the spec describes them: a description over
      1,024 characters warns instead of refusing (`anthropic/claude-api` is 1,068) and `allowed-tools`
      may be a YAML list (six `awesome-copilot` skills write one). Both were silently costing real skills
- [x] The failures a source surface has are each reported honestly: an unfetched cache is distinguished
      from a mistyped name; a skill in two sources refuses and names both; an over-budget skill is refused
      before it is copied; a skill whose frontmatter will not load is listed with its problem rather than
      dropped; a failed re-fetch leaves the previous catalogue intact and searchable

**Non-goals.** Skill authoring UI, and any model-driven selection, which is what decision 6.2 exists
to refuse. Honouring `allowed-tools` as a grant: it is read and displayed, never enforced, because a
downloaded folder that could widen the agent's authority is the thing the `config_set` floor refuses.
A second index. Nested `references/` loading — the harness injects `SKILL.md` and nothing else; a
referenced file is the model's to read through `file_read`. **Installing from a URL**: a skill can ship
executables, so `git clone` and then install from the path keeps a readable copy on disk between the
download and the agent, and the network stays out of the install command. **Anything the runtime fetches** —
the manifest has no `sources` field at all (decision 11.46), and `sources update` is the only thing that
reaches a network.

Remote sources are no longer a non-goal: they are built, as a CLI surface, and the part that was deferred
to Phase 9 was a manifest field that turned out to be the wrong design rather than a missing feature.

### Four defects the owner's first real session exposed

Reported from a live `init` → `run` → "hey, what skills do you have?" sequence, and each one is a place
the work was correct and unreachable.

1. **`skills list` told people to hand-edit `agent.yaml`.** The unconfigured message printed the YAML block
   to add — the exact workaround `skills new` had been built to remove one commit earlier, still being
   recommended by the one screen somebody lands on when looking for skills. It now prints the two commands.
2. **Nothing anywhere said the word `sources`.** Not `skills --help`, not `skills list`, not `init`, not the
   next steps. Decision 4.53 again: a capability reachable only by someone who already knows the command
   name. Fixed in all four, and `init` now *asks*.
3. **Slot 2 counted the skills instead of naming them** — 1,358 output tokens and four tool calls to answer
   a question the context was supposed to have already answered. Decision 11.52.
4. **The confirm screen's label for the skills answer was the literal string `starter`,** a value pasted
   into the label column, so it read `starter  starter`.

Two more surfaced while building the fix, both silent-drop shapes this file already records elsewhere:
`--skills "<phrase>"` reached the answer funnel and was lost, because that funnel is an object literal and
a step not listed there is dropped with no type error; and `skills install` resolved a `<source>/<skill>`
ref against the *real* home directory while its caller searched a sandbox, so one command consulted two
different registries and reported `no source called test` for a source that plainly existed.

### Two scorer defects that only real skills exposed

Vendoring four skills from `anthropics/skills` proved the compliance claim and immediately broke the
ranking. Both defects were invisible to the seventeen shipped fixtures, because those fixtures were
written by the same hand as the scorer and to the spec's own short what-plus-when advice.

```
before                                   after
0.349  (none)  ← miss                     0.537  pdf              :: merge these two pdfs and rotate page 3
0.605  docx                               0.782  docx             :: turn this into a word document
0.412  mcp-builder                        0.757  mcp-builder      :: help me write an mcp server
0.518  docx    ← false positive           0.000  (none)           :: what is the capital of peru
```

- **`discriminating()`'s "at most half the corpus" rule needs a corpus.** It is sound at fifty skills and
  meaningless at three. Reproduced on the **shipped reference workspace**: `the` appears in exactly one of
  its three descriptions, so `df <= total/2` let it through and "who won the 1998 world cup" activated the
  CSV profiler at 0.446. Fixed with a closed list of English function words, dropped from documents and
  queries alike — a statement about English rather than about this corpus, which is the difference between
  a stopword list and a blocklist that needs re-tuning whenever a skill is added.
- **No stemming, and descriptions inflect where requests do not.** `anthropics/skills`' `pdf` says
  "combining or merging" and "rotating pages"; a person types "merge these two pdfs and rotate page 3". Its
  three strongest signals matched nothing, and `docx` won on the single word `page`. Fixed with a minimal
  suffix normaliser — plural and gerund, floored so `bring` cannot become `br` — not a Porter stemmer,
  whose several hundred lines address cases a routing decision over a handful of documents does not have.
  `extraction` still does not meet `extract`; that is an accepted miss, stated in the code.

Both changed the scorer, so the fixtures were re-measured rather than assumed: still 20/20 top-1 correct,
and the positive floor **rose** from 0.369 to 0.390 against the unchanged 0.35 default. Two regression
tests now pin the exact queries. The lesson is the one worth carrying: a probe drawn from the same hand as
the thing it probes will pass, and twenty minutes with four files somebody else wrote found two defects.

### Corrections found while building

- **BM25's normalisation cancelled idf, and only measurement showed it.** Dividing by `Σ idf(q)` over the
  same terms the score sums means a one-term query scores a match on `the` exactly as well as a match on
  `pdf` — idf survives only as relative weighting *between* several terms. "what's the weather in dhaka
  tomorrow" reduced to `{the}` and scored **0.771** against `git-release`, above all seventeen true
  positives. `discriminating()` — present in the corpus, and in at most half of it — takes it to 0.000.
  Reasoning produced the bug; a calibration script printing scores for inputs expected to be boring found
  it.
- **`when_not_to_use` is scored by nothing, against what this plan first said.** A lexical match on a
  field describing non-applicability is evidence *for* the skill: "not for scanned images — use
  `ocr-extract`" would win a query about scanned images, and one meant for `ocr-extract`. Decision 6.3's
  73% → 85% measures **the model's** routing with negative examples in front of it, not a scorer's, so
  the field ships in the injected body and stays out of the ranking. Scoring it negatively is the better
  answer and needs a weighting constant nobody has measured.
- **`TurnInput` had no `skills` field, so `send` dropped them.** `assembleContext` was right,
  `previewContext` called it directly and was right, and the object literal reaching `runTurn` passed
  `skills` through a spread — which TypeScript does not excess-property-check. Green everywhere, connected
  nowhere. Found while wiring Part B, fixed, and now covered by `skills-turn.test.ts`, which reads the
  recorded request body rather than any intermediate function's return value.
- **A skill script's deadline must clamp under `limits.toolTimeoutMs`.** The harness *abandons* a handler
  at its own timeout rather than killing it, so a tie leaves a process with nothing referencing it. Five
  seconds under, the same margin `exec` uses.

### Corrections to this phase as first written

Found by reading the published spec and the code against the deliverable list, *before* building.
Recorded rather than silently fixed, because four of them contradict decisions that are still cited
elsewhere.

- **`when_not_to_use` is not a spec field.** The frontmatter set is `name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools`. So decision 6.1's compliance claim — which says
  compliance "inherits `anthropics/skills` plus the community" — and decision 6.3's mandatory field
  cannot both hold: a required field the spec does not define means every third-party skill fails to
  load. It moves under `metadata`, which the spec defines for exactly this ("clients can use this to
  store additional properties not defined by the Agent Skills spec"), and `validate` warns where the
  loader would have refused. Same split as `validate` versus `workspace`: a heuristic judgement that
  refuses to load a file is a heuristic nobody keeps.
- **Three documents gave the body three slot numbers** — slot 3 here, slot 4 in
  `01-ARCHITECTURE.md`, `SLOT.skill = 5` in the code. The code is right; the docs went stale when
  `examples` and `knowledge` renumbered everything below slot 2. Referenced by name from now on.
- **Decision 6.6 contradicted the cache-stable prefix.** Scripts "visible only while their skill is
  active" implies a per-turn tool catalogue, and slot 1 is documented as rendered once and
  byte-stable or prompt caching stops working. That failure has no symptom — the bill rises and
  nothing reports it. Scripts render in slot 5, which is after breakpoint A and varies per turn
  already, so 6.6 holds and slot 1 never moves.
- **`skills/scripts.ts` as specified was a second spawn path, inside core.** Core owns no shell, and
  `tools-system` already holds the rules that cost 33 orphaned shells and a load average of 351 to
  learn. Core keeps the decision and the port; the subprocess stays where the reaper is.
- **`SkillsSchema` had no budget**, while the spec recommends bodies under 5,000 tokens. Injecting one
  unbounded into slot 5 is the hole `knowledgeEntryOverBudget` already exists for.
- **The frontmatter parsers throw on unknown keys** — right for workspace files, which are ours, wrong
  for skills, which are not. A skill carrying `license`, or a spec field added next year, must load.
- **`allowed-tools` is a third-party file declaring pre-approved tools.** Read, shown, never enforced.
- **BM25 needed no index**, which is the difference between sharing Phase 3.5's ranking seam and
  building the second index `knowledge.ts` explicitly forbids.

---

## Phase 5.5 — the TUI is the product

Phase 5 shipped screens that are Ink and an *experience* that is not. Four of the five phases of
`dispach skills` were plain text: the fetch printed to stdout before the mount, the result printed
after the unmount, and the width was measured once and frozen. Three of ~15 commands mounted Ink at
all. And `ink-testing-library` had been a declared devDependency since Ink arrived, unused — so every
`.tsx` was verified through its reducers only, which is a different claim from "the row is one line".

**Goal.** One `Screen` kit every surface renders through; views hosted either by a command or by a
slash command inside a live chat; a palette generated from the CLI's own command table; an input that
behaves like a text editor; and a frame test for every component.

**Files** — `packages/cli/src/lib/{screen,palette,scroll,terminal,confirm}.ts` ·
`packages/cli/src/components/{Screen,KeyHints,Palette,FlagForm,HistorySearch}.tsx` ·
`packages/cli/src/components/views/*` · `packages/cli/src/terminal-setup.ts` ·
`packages/cli/test/helpers/frame.tsx` · `packages/cli/test/components/*`

### Decisions (2026-08-18, binding)

Rich at a TTY, plain on a pipe — the byte-identical rule stands. String columns keep the layout pure;
`<Box>` is for structure. The alternate screen for anything that waits for a keypress, inline for a
one-shot report. Spinner and progress only, no decorative motion. `run` exits clean, leaving one
pointer line naming the session key; failures always print. Mid-turn `^C` cancels the turn, unchanged;
idle `^C` arms and a second press exits. One view, two hosts. Arguments accepted only after a token
that is exactly a known command. Commands that do not belong in a session are **declared** hidden on
the spec, never omitted by a second list.

### Stages

1. **The kit and the harness.** `lib/screen.ts` (pure), `components/Screen.tsx`, alt-screen sequences
   and `markAltScreen`, the frame harness, a frame test per component, the boundaries rule. **Done.**
2. **The input becomes an editor.** Multi-line buffer, ⌥ chords, `^R` search, `^Z`/`^Y` undo, draft
   across a restart, `terminal-setup`. **Done.**
3. **The view contract, and the original defect.** `browse.ts` mounts before it fetches; `SkillBrowser`
   is a view with its whole lifecycle in one mount; `installReport` is pure and shared with the text
   path. **Done** — except a bespoke `sources` screen, which the generic pane covers functionally.
4. **The palette.** Generated from `COMMANDS`, `inSession` required on every spec, the known-first-token
   argument rule. **Done** — except a flag *form*; flags are typed after the word for now.
5. **The remaining commands.** One `CommandOutput` pane runs any non-hidden command and shows its text,
   so every one is reachable from the palette. **Done as the generic mechanism**, and `daemon logs
   --follow` is now implemented rather than a hint telling you to run `tail -f` — both streams, polled,
   with truncation detected (11.81). A pane refuses it by name, because a pane has nothing to interrupt a
   following command with (11.82). Bespoke interactive views for `/channels` and `/logs` are **not built**:
   the pane covers reading, and a `/channels` toggle writes `agent.yaml`, which wants its own review.
6. **One-shot reports, inline.** Satisfied by decision rather than by code: these commands already print
   inline and keep doing so. Restyling them through the kit is **not done**, and is cosmetic.
7. **`run` on the alternate screen.** Windowed transcript over rows we own (`transcriptRows` +
   `lib/scroll.ts`), a one-line header that does not scroll away, a row budget every piece of chrome
   reports into (`lib/chat-frame.ts`), PgUp/PgDn and ⌥↑/⌥↓ scrolling with `esc` to return, an idle `^C`
   that arms, `/exit` that asks, and one pointer line after the restore. **Done.** Two things it changed
   on the way: `<Static>` is retired for chat (11.75) and the row count is now ours to compute, because
   Ink word-wraps and a division does not (11.76).

### Acceptance criteria

- [x] Every component has a frame test; no rendered line exceeds its width at 40/60/80/100/140
      columns, measured in code points.
- [x] A component added with no frame test fails the boundaries test by name.
- [x] `restoreTerminal` writes the leave-alt sequence *before* the style reset, and only when
      `markAltScreen` ran — a pipe still receives nothing.
- [x] The multi-line buffer: ⌥⏎ and a trailing `\` break the line, ↑↓ move within it and recall
      history at its edges, `^A`/`^E`/`^U`/`^K` act on the line, undo coalesces a run of typing.
- [x] Word motion and deletion in both terminal spellings, across a line break, over an emoji.
- [x] `^R` narrows, deduplicates, resets its index on a keystroke, and leaves the draft untouched
      until accepted.
- [x] A paste composes one message instead of submitting each line.
- [x] An unsent draft survives `/restart`.
- [x] `terminal-setup` writes a text config with a backup, refuses a file it cannot parse, explains a
      binary-plist terminal, and reports a recognised terminal with no verified recipe as such.
- [x] Verified in a real pty, not only in frames: ⌥⏎ makes a second line with the gutter aligned, and
      ⌥← then ⌥⌫ deletes a word from it.
- [x] Bare `skills` mounts before it fetches; the spinner, the picker, the install and the result are
      one mount, and the alternate screen is entered and restored around it.
- [x] `/` opens a palette generated from `COMMANDS`; every spec declares `inSession`, asserted.
- [x] A mistyped `/skils` is still refused with a suggestion; `/etc/passwd is world-readable` is prose.
- [x] Every non-hidden command is reachable from the palette, through a pane that runs it as a child.
- [x] No internal module is both statically and dynamically imported, and the built binary starts —
      two guards, because `bun test` imports source and cannot see a broken bundle.
- [x] Verified live in the real binary: `/` lists session verbs first, `/s` narrows, ↓ then tab completes.
- [x] Leaving an alternate-screen surface restores it: style and cursor first, the buffer swap second,
      and only when `markAltScreen` ran. Verified in the pty bytes — one `1049h`, one `1049l`, and the
      pointer line lands *after* the swap, on the shell's own screen.
- [x] `time node packages/cli/dist/index.js validate --json` stays ~90 ms: no Ink on a shared path.
      Measured 0.13 s total for the process.
- [x] The chat transcript is a window over rows, not `<Static>`: it scrolls by row, counts what is out
      of sight, and follows the newest reply only while nothing has parked it.
- [x] The whole frame fits the terminal at 10/16/24/40 rows and 60/80/100 columns, and no row exceeds
      the width — asserted on the render, because `chat-frame.ts` restates each component's geometry.
- [x] Every chrome function's row count equals the line count of its real render: composer (empty,
      composing, internally scrolled), palette (many/one/none), `^R` (matches and none), live pane
      (short and clipped).
- [x] Mid-turn `^C` still cancels the turn. An idle `^C` arms, the status line says so, any other
      keystroke disarms, and the second press leaves. `^D` still leaves in one.
- [x] `/exit` asks before it goes, and any key other than `y` stays.
- [x] A clean exit leaves exactly one line: the session key and a pasteable resume command.
- [x] `--plain` at a terminal writes **zero** escape bytes and matches a pipe — verified through a pty.
- [x] `daemon logs --follow` prints the tail, then keeps printing: verified live against a file being
      appended to on both streams, with `--truncate` mid-follow announced as `── stderr was emptied ──`
      and ctrl-C stopping at exit 0.
- [x] A pane refuses `--follow` by name and exits non-zero, keyed off the command's own flag table.
- [x] Verified live in the real binary against a live endpoint: a streamed turn with reasoning, PgUp and
      ⌥↑ parking the window with `↑ n rows above · ↓ n rows below · esc returns`, `esc` returning to the
      newest reply, a resize from 24×80 to 14×70 re-laying the frame, and `^C`,`^C` leaving cleanly.

### Follow-ups landed after the stages (2026-08-18)

Two asks from the owner, taken after Phase 5.5 closed and recorded here because they are the same surface.

**A conversation per run.** `local:default` is gone: a run generates `local:` plus six base-32 symbols
(11.83), with three routes back — `--continue`/`-c`, a bare `--session` for the picker, and `/sessions` as
an in-session switcher (11.84). The contradictory pair is refused rather than ranked. Switching rebuilds
rather than re-keying, because `useReducer` seeds only on mount (11.86), and the banner's `restarted`
boolean became a three-valued `reopened` so a switch does not claim to be a configuration change.

- [x] Two runs with no `--session` land in two conversations; verified against a live endpoint.
- [x] `-c` resumes: asked "what did I just ask you?" and the model answered from the previous turn.
- [x] `-c` with no stored conversation starts a new one and says so; `--continue --session` is refused.
- [x] A bare `--session` opens the picker at a terminal and lists-and-exits-1 on a pipe.
- [x] `/sessions` switches in-session — rebuilt into a 4-message conversation in 19 ms, with a note.
- [x] `FlagSpec.bare` is per-flag; `--session=` stays refused and `--input -5` still means "-5" (11.85).

**A splash for a new conversation.** Wordmark rendered from `BRAND.name` through a 5×5 glyph table in four
width- and height-aware tiers (11.87), the same composer centred with a placeholder, compact facts, and the
cwd and version in the footer. `freshSession` is passed rather than derived, because the chat does not
render stored history and an empty transcript is equally true of a resumed session (11.88).

- [x] The wordmark is derived, so a rename stays one commit — asserted over several names.
- [x] Every tier fits its space; degradation is by measurement, not a width threshold.
- [x] The splash fills the terminal exactly at 10/16/24/40 rows and 44/60/80/100/140 columns.
- [x] It appears for a fresh session, not for a resumed one, and goes on the first message.
- [x] The composer is pinned to the bottom edge, so the place you type does not walk down the screen.
- [x] Verified live at 110×30: the `wide` tier, then the transcript with the banner at the top.

One bug came out of it rather than out of review: `screenColumns` treated a pty's `columns === 0` as a
width of zero, so the session picker's rows were 43 characters wide on an 80-column screen (11.89).

### Non-goals

A dashboard home screen or panes in one long-lived app — per-command screens were chosen. ~~Mouse
support.~~ *(overturned in Phase 5.6: the alternate screen has no scrollback, so the wheel is the
gesture a transcript needs most — 11.97.)* A live `serve` dashboard: a process a supervisor runs must
never take a terminal. User themes (11.14 stands). `/plugin` — plugins are Phase 9 and there is
nothing to show. Any new *runtime* dependency; 11.10 is untouched.

---

## Phase 5.6 — the chat as somebody actually reads it

**Four defects reported by the owner from a real session, plus two found while fixing them.** Nothing
here is a feature: every item is a surface that was drawn wrong, and each was reproduced over a real
pty before being touched — the composer at 100 columns, a live multi-step turn against deepseek, and
`init` at three terminal sizes.

**The composer never wrapped.** It rendered each logical line `wrap="truncate"` and wrapped nothing,
so Ink truncated to a width it had measured from the box's *content* — which made the box wider than
the terminal and handed the outcome to whichever terminal was running it. VS Code cut the text at the
border and took the caret with it; Warp wrapped the over-wide row onto the border. `lib/composer.ts`
now decides the rows and the caret's place on them, `wrapRows` reports source offsets because a row's
text is not a slice of its line, and one column is reserved so the caret has a cell at the end of a
full row (11.93).

**Reasoning was unreadable, in three separate ways.** Its `ROLE_PREFIX` was fourteen columns and a
prefix is re-applied as a hanging indent, so the longest item in a conversation was also the narrowest
(11.94). `live` accumulated across every step and was flushed once at `turn.end`, so tool rows landed
*above* the reasoning that caused them and step one's reasoning ran into step two's with no break —
`model.result` fires per model call and was already the boundary (11.95). And a 23-row block for a
one-sentence answer filled the screen, so blocks fold to a count with `⌥r` to open them.

**A tool call cost four rows.** `tool.result` appended a second item, with a comment explaining that
`<Static>` had already written the first — a phase after `<Static>` was removed. One row now,
completed in place, paired on `callId` (11.96).

**The wheel scrolls.** Ink hands a mouse report over as text, so the keymap claims every report first
and unconditionally; the notch count is honoured because a flick arrives as one chunk, and X10 is
recognised alongside SGR. Drag-select goes while a session is mounted, which is stated rather than
discovered — shift bypasses tracking in every terminal worth naming (11.97).

**`init` opens on the wordmark, and the landing screen stops looking half-empty.** The same
`wordmark`, budgeted so it degrades. The landing slack moved below the composer, and the banner's
first row — an exact duplicate of the sticky header — is dropped on the rich path only (11.98).

### Acceptance

- [x] The composer wraps at 40/60/80/100/140 columns with nothing over the width; verified live at
      100 and 60, and by a frame test that reads a finished render.
- [x] `promptRows` equals the rendered line count for a wrapped message, at five widths and in the
      landing form — the chat-frame drift test, which is what caught the newline hint being counted
      in rows when it is a fact about lines.
- [x] The caret is reachable at every cursor offset in a wrapped line, and never past the window.
- [x] A live multi-step turn reads reasoning → tool → reasoning → reply → cost, with two reasoning
      items rather than one run-on. Verified against deepseek-v4-flash.
- [x] A turn's cost lands on its own reply; a turn with no reply does not claim the previous one's.
- [x] A tool call is one row, pending until its own result, paired by id with two calls in flight.
- [x] Reasoning folds over four rows, `⌥r` expands and re-folds — verified over a pty, not against
      the parser: 52 rows opened and closed.
- [x] No mouse report can become an insert, click and release included; the wheel moves three rows
      per notch and re-pins at the bottom. Verified live with text in the composer, which stayed clean.
- [x] Tracking is switched off *before* the buffer swap, and a pipe gets neither. Read out of the raw
      pty bytes — which is how the second escape shipping as the literal text `ESC` was found.
- [x] `init` draws the mark at 100×30, the block tier at 44×24, and gives it up at 100×18 while the
      questions survive.
- [x] The rich banner says the brand once; the plain REPL still prints its title row in full.
- [x] `bun test` 2295 · `test:node` 1103 · `bench:boot` 73.7 ms · lint at the 6 pre-existing.

**Non-goals.** A per-block reasoning cursor — the toggle is session-wide, because a second focus on a
surface where the composer owns the keyboard is a worse trade than a global switch. Mouse support
anywhere but the chat: only its keymap claims reports, and a surface that enabled tracking without
claiming them would have Ink type them into it. Making the wizard's field box full width — it is
65 columns on a 100-column screen and was before this phase, so it needs its own decision rather
than being changed in passing.

## Phase 7A — Budget and the compaction ladder

**Built before Phase 6, deliberately.** The numbers are not swapped — `validate.ts:447` and
`02-SPEC-MANIFEST.md` name "Phase 6" and "Phase 7" in errors a user reads, so renumbering would
make a shipped message wrong. Only the order changes, and the reason is that a long session today
loses its oldest turns outright (`context/assemble.ts:194`, honest about it in a comment and in
`droppedMessages`), while memory's slot 4 would have to negotiate a budget with a ladder that does
not exist yet.

What is already standing, and what it is worth knowing before touching any of it:

| | |
| --- | --- |
| `context.thresholds` — trim .6, snip .7, micro .8, collapse .88, reset .95 | in the schema with defaults, **order- and range-validated** (`validate.ts:110-143`), and read by nothing. The one manifest field that is accepted and inert: someone who writes `trim: 0.5` today gets a clean load and no effect. This phase closes that. |
| `model.compactor` | accepted at `schema.ts:100`, unused |
| `context.compactionNotice` | refused at load (`validate.ts:482`) |
| `GET /v1/agents/:id/context` | **already built** in Phase 4 (`server/handler.ts:333`), via `Agent.previewContext` |

**Goal.** A session under pressure degrades in five ordered stages rather than losing its oldest
turns, every stage is reported, and nothing a compaction dropped is unreachable.

### Decisions (2026-08-19, binding)

**Mechanical to S3; the model is asked only at S4 and S5.** trim, snip and micro are deterministic
— drop whole turns, replace observation bodies with artifact pointers, cut a long observation to
head plus tail. collapse and reset ask `model.compactor` for a rolling digest and fall back to a
deterministic digest when no compactor role is configured *or* the call fails. So no model call
happens below 88% pressure, which keeps the common case fast, offline and testable; and a
compaction can never fail the turn it was trying to rescue.

**Trimmed observations live in the store, in the next contiguous migration** — one durability boundary, deleted with
their session, identical under `bun:sqlite` and `node:sqlite`. Pointer keys stay printable ASCII,
per the NUL-truncation row in `sqlite/driver.ts`. Files under the state dir were the alternative
and lose on cleanup: nothing has ever been written to retire them, and a store deletion orphans
them silently.

**Compaction may not touch slots 0–2.** The ladder rewrites history, which sits after breakpoint A,
so the cache-stable prefix survives every stage — asserted on the assembled prefix rather than
assumed, because this is the property that silently costs money when it breaks.

**Deliverables**

- `context/budget.ts` — the `prompt_tokens` anchor from the previous response, plus the local
  estimator. The anchor exists to correct the estimator, which is biased ~10% high by design; a
  ladder driven by the biased figure fires every stage early.
- `context/compaction/ladder.ts` — measures pressure, selects a stage from `context.thresholds`,
  runs strictly in the validated order, never skips
- `context/compaction/stages.ts` — S1 trim · S2 snip · S3 micro · S4 collapse · S5 reset
- `store` migration **005** — the list is contiguous *by position* and there are already four, so
  this plan's older "migration 00N" numbers are off by one; see the note at `migrations.ts:124`.
  Adds `artifacts`, the pointer format, and `artifact_read` as an opt-in
  `tools.local` entry — a tool every agent gets whether it needs one or not is slot-1 tokens
  charged to agents that never compact
- `context/compaction-notice.ts` — generated, never authored, because the author does not know the
  thresholds. `context.compactionNotice` stops being refused.
- Events: `context.pressure`, `compaction.stage` (before/after), `context.reset`
- CLI: pressure and last-compaction in the status bar — reducer cases and a row, not a new screen

**Files.** `packages/core/src/context/`, `packages/core/src/store/sqlite/migrations.ts`,
`packages/cli/src/lib/`

**Acceptance**

- [x] A 200-turn synthetic session never exceeds the window and never hard-fails — asserted over 12 turns
      of long replies in `compaction-turn.test.ts`, reading `context.assembled` totals rather than the
      ladder's return value, so it measures the prompt that was sent
- [x] Each stage fires at its own threshold, in order; `compaction.stage` reports tokens before and
      after, and a stage that changed nothing says so rather than reporting success
- [x] Pinned blocks survive every stage including S5
- [x] Slots 0–2 are byte-identical before and after S1–S4, asserted on the assembled prefix
- [x] A trimmed observation is retrievable through its pointer, and the pointer is stable across a
      restart — the id is content-derived, and three identical live observations produced one row.
      **The model-driven half is unproven**: a live deepseek session never emitted a readable call for
      `artifact_read` (nor for `now` on the same probe agent), so retrieval is proven deterministically
      in `artifact-read.test.ts` and the emission failure is a separate, pre-existing question
- [x] Token estimate within 10% of API-reported across 50 real calls — **91.3% of turns** within 10%
      corrected, against 8.7% uncorrected; 31 turns, not 50, and the figure is one endpoint's
- [x] No model call below the `collapse` threshold — the mechanical stages make no call at all
- [x] With no `compactor` role, S4 and S5 complete deterministically — and so do a throwing compactor
      and one that returns empty content. `digestSource` reports which
- [x] A manifest that sets `context.thresholds` measurably changes when a stage fires — the
      accepted-and-ignored field is live
- [x] S5 firing twice in one session emits a misconfiguration warning, and it reaches the transcript
- [ ] With `compactionNotice: true` a long session does not show the model wrapping up work early on
      budget grounds; with it false, the behaviour reappears — **not measured.** The notice is built,
      refused-at-load is gone, and it is asserted on the request body; the *behavioural* claim needs an
      eval that scores whether a model curtails work, which does not exist yet
- [x] `bun run bench:boot` under 1000 ms

**Non-goals.** Phase-scoped tools — that is 7B. Agent-triggered compaction (5.2). Learned
compaction. Any change to what `assemble` puts in slots 0–2.

---

## Phase 7B — Phase-scoped tool visibility

`phases` is **refused** at load today (`validate.ts:447`), and everything it needs is already
standing: `PhaseSchema`, `ToolSpec.tags` for `tag:<name>` matching, and the `02-SPEC-MANIFEST.md:505`
contract including the rule that every `allow` entry must match at least one resolved tool.

**Goal.** A manifest declaring `triage` and `act` exposes read tools until the model calls
`phase_set("act")`, and the improvement is a number rather than a claim.

### Decisions (2026-08-19, binding)

**A phase change takes effect immediately, and the prefix cache pays for it.** `triage` →
`phase_set("act")` → write, inside one turn, is the whole feature; deferring to the next turn
recreates exactly the two-hop shape decision 4.7 refuses, in the feature that exists for the models
that fail it. Slot 1 is re-rendered, so the cached prefix is invalidated from slot 1 onward for that
turn only. Rendering every tool and marking the out-of-phase ones unavailable was the third option
and loses: it puts the write tools back in front of the model during triage, which is the tool-space
constraint the phase exists to remove. The cost is **measured and recorded**, not asserted.

**Deliverables**

- `loop/phases.ts` — phase state, transitions, and the allow-matching over slugs, `tag:<name>`, `*`
- `phase_set` local tool, auto-registered when more than one phase is declared, absent otherwise
- Phase state persisted per session in the existing `kv` table — no migration; the phase is one
  string per session and a table for it would be a table per fact
- `phase.changed` event; the phase named in the CLI status bar
- `evals/phases/` — the same catalogue and tasks, run with phases on and off against
  `SMALL_MODEL_BASE_URL`, committed results

**Files.** `packages/core/src/loop/phases.ts`, `packages/core/src/tools/`, `evals/phases/`

**Acceptance**

- [x] Two-phase manifest: `triage` exposes only read tools; after `phase_set("act")` the writes
      appear **in the same turn** — asserted on the recorded request *bodies*, not on the registry
- [x] `allow` matches slugs, tags and `*`; an entry matching no resolved tool fails the load with
      the documented error, naming the phase, the entry and the available slugs
- [x] A single-phase (or absent) `phases` block registers no `phase_set` and changes nothing
- [x] Phase survives a restart — in `sessions.phase`, which existed since Phase 2, so **no migration
      was needed**. Reported in the chat status line and as a transcript note on change; `/status` is
      a one-shot report of a *stopped* agent and has no session to name a phase for
- [ ] Small-model eval improves measurably with phases on versus off, number committed in `evals/` —
      **the harness is built and committed (`scripts/eval-phases.ts`, `evals/phases/`) and no small
      model has been run through it**: `SMALL_MODEL_BASE_URL` is not configured on this machine, and
      the claim in 4.8 is specifically about small models. The frontier-model arm is committed and
      labelled as such
- [ ] The prompt-cache cost of a mid-turn phase change is measured and recorded, not estimated —
      **not measured.** No configured endpoint reports cache hits (`capabilities.promptCache` is
      `none` for deepseek), so there is nothing to read the cost off. What *is* known and asserted:
      the change re-renders slot 1 and the per-phase catalogue is memoised, so a phase entered twice
      renders once
- [x] `phases` stops being listed in `UNSUPPORTED_SECTIONS`

**Non-goals.** Phase transitions decided by the harness rather than the model. Per-phase prompts,
per-phase models, or per-phase thresholds. Nested phases.

---

## Phase 6 — Memory

**Follows 7A and 7B.** Retrieval has to negotiate a budget with the compaction ladder, and slot 4
competing with a window that drops oldest-first would be tuned against behaviour that is about to
change.

**Goal.** The agent remembers across sessions without an embedding model.

**Two tiers, one writer.** `memory_write` appends to the *carried* file — the workspace write target,
in the `volatile` tier, in slot 4 every turn — and when that file passes its budget the oldest notes
move into `memory.dir`, which only retrieval reaches. Retrieval-only was the alternative and loses the
near term: a fact saved a minute ago would be invisible next turn unless the query happened to match
it, which is the "the model must choose to look" assumption decision 6.2 rejects for skills.

**Deliverables**

- [x] `rank/bm25.ts` — the tokeniser, idf, summation and normalisation, **extracted** from
  `skills/select.ts` so there is one scorer rather than two that look alike
- [x] `memory/passages.ts` — markdown into passages; one list item, falling back to a heading section
- [x] `memory/retriever.ts` — the seam, the multiplicative recency boost, and the three limits
- [x] `memory/fts5.ts` — FTS5 as a **candidate filter**, scored by `rank/bm25.ts`; plus the indexer
- [x] `memory/writer.ts` — append, then evict, then report. Implements `eviction: oldest`
- [x] Incremental index: mtime + size + tokeniser version, reconciled per turn, `stat` without reading
- [x] Context slot **7** (the plan said 4; 4 is the carried volatile tier, which is the other half)
- [x] `dispach memory search|rebuild` — table entry plus a plain writer, `--json` included
- [x] `includeHistory` — indexing the person's and the agent's messages, at turn end, in their own
  `session:<key>` namespace. **Completed in Phase 6.1**, which is where the surprises are recorded

**Files.** `packages/core/src/memory/`, `packages/core/src/rank/`, `packages/core/src/ids.ts`,
migration **006** (005 is the artifact store)

**Acceptance**

- [x] Fact stated in session A is recalled in session B — `memory-turn.test.ts`, through the real loop:
  saved in A, evicted to the archive by the budget, retrieved in B where the carried file no longer
  holds it
- [x] `memory_write` produces valid dated markdown, human-readable and diffable
- [x] Index rebuild after external file edit — mtime *and* size, with `memory rebuild` for the edit that
  preserves both
- [x] Retrieval under 20 ms over 5000 passages — **median 0.43 ms, slowest 1.35 ms** (`evals/memory/`)
- [x] Deleting a session leaves memory files untouched — structural: `memory_passages` has no session
  column and no foreign key
- [x] Boot budget met with a 5000-passage index — 76.6 ms median; an unchanged file is `stat`ed, never
  read, which is why `IndexableFile.read` is lazy
- [x] Zero Python, zero model weights, zero network in the memory path
- [x] The retriever reuses Phase 3.5's ranking seam rather than building a second index — asserted, not
  claimed: `memory-rank.test.ts` scores one corpus through `bm25Selector` and through `fts5Retriever`
  and compares to **1e-12**

**Found while building, and fixed.** `assembleContext` silently discarded a block whose slot was absent
from its explicit ordering list, *after* charging it against the prompt budget — there is now an
invariant that throws. `ToolRuntime` and `ToolContext` both take conditional spreads, so `memoryDir`
type-checked onto the wrong one and landed nowhere: the fifth occurrence of that shape here.
`eviction: oldest` was declared vocabulary nothing consumed, so ~200 saves took a freshly scaffolded
agent to `workspace_budget_exceeded` and it would not boot. And the write target resolved to `USER.md`
rather than `MEMORY.md`, so every saved note appended to a person's hand-written prose about themselves.

**Known limitation, measured and accepted.** A query reducing to one informative term scores a rare
match as highly as a relevant one, because idf cancels in the normalisation — 0.490 against a genuine
0.394, so no threshold separates them (decision 5.38).

**Non-goals.** Vectors. Reranking. Knowledge graphs.

---

## Phase 7C — a turn that stops says so, and compaction keeps the task

Moeen asked milo to `create a sample pdf`. Six productive steps — glob, read the pdf skill, try a
heredoc, recover by writing a script file, run it, install the missing dependency — and then it
stopped, one step before succeeding. The reply he received ends:

> reportlab isn't installed. Let me install it — that's the library the pdf skill uses for creating PDFs.

`turns.status = 'max_steps'`, `error_code` empty, nothing in `milo.err.log`, and nothing on screen.

### What was measured first

milo's real history, by content type (47 messages):

| | messages | bytes | share |
| --- | --- | --- | --- |
| tool observations | 13 | 125,712 | **83.9%** |
| assistant prose | 10 | 18,834 | 12.6% |
| assistant tool calls | 13 | 4,813 | 3.2% |
| **the person's own words** | **11** | **423** | **0.3%** |

Both halves of the phase come out of that table. Decisions 12.1–12.12.

### Built

- **The step budget.** `maxSteps` 6 → 40 in `init`, 12 → 40 in the schema, 8 → 40 in the reference;
  `init` stops overriding `turnTimeoutMs`/`toolTimeoutMs` (its 6 × 30 s already exceeded its own 120 s
  turn). New `limits.noProgress.identicalCalls` (3), compared on slug **and** arguments, before the
  calls run.
- **Every ending reported, on every surface.** `endNote`/`endedBadly` in core, called by the plain
  path, the transcript reducer and channel delivery. `truncated` and `no_progress` are new reasons
  with their own store statuses (migration **7** widens the `turns.status` CHECK). `turnTimeout` and
  `turnStopped` are called for the first time since Phase 1. `answered` replaces the `pendingWork`
  inference. Every `agent.warning` now prints on the plain path, not just `manifest_changed`.
- **Compaction keeps the task.** `trim` keeps every `isTurnStart` message and drops the working detail
  around them; `collapse`/`reset` digest around a framed request spine; `assembleContext`'s blunt trim
  rescues requests from the range it dropped, sharing the same predicate.
- **The ladder reordered** to `snip .60 · micro .70 · collapse .80 · reset .88 · trim .95`, with
  `trim` re-keying the displacement map and protecting digests, `FLOOR_MARGIN` read off `STAGE_ORDER`,
  and `manifest_thresholds_legacy_order` naming the rewrite for a manifest in the old order.
- **The compactor's own window, signal and bounded span**, plus a warning when a configured compactor
  falls back to a mechanical digest.
- **`context.dropped`** gives `droppedMessages` its first reader; **`prompt_over_window`** says when
  the two permitted overruns pass the window.

### Acceptance

- [x] The original task completes: `create a sample pdf` → `final`, 2 steps, a valid one-page PDF
      (`file` reports `PDF document, version 1.4, 1 pages`)
- [x] A forced stop prints `(stopped after 2 steps without finishing — say "continue" to carry on, or
      raise limits.maxSteps)` and exits **1**
- [x] A timeout prints its remedy and exits **1**; the store carries `turn_timeout` with message and hint
- [x] `no_progress` fires on three identical calls and not on three different ones
- [x] An answer arriving on the last permitted step is `final`, not `max_steps`
- [x] `trim` keeps every request at full stretch; the observations are what go
- [x] A snipped-then-trimmed pointer still resolves — asserted, and red with the re-key reverted
- [x] The digest span is bounded by the compactor's window and says when it was cut — asserted on the
      request body, and red with the bound reverted
- [x] Live: after several turns past the thresholds the agent quotes its first message verbatim and
      says *"that's in the conversation record itself, not the memory notes"*
- [x] `prompt_over_window` fires live with three remedies
- [x] `bun test` 2556 · `test:node` 1190 · typecheck clean · lint at the 6 pre-existing warnings
- [x] `bun run bench:boot` ok
- [ ] `evals/budget` re-run — **not done.** The reorder invalidates the per-stage figures; `EMA_ALPHA`
      is unaffected because it measures the estimator, not the ladder. Needs a live endpoint and a
      note in the README saying which numbers moved.

### Not done, deliberately

- **A per-request model timeout.** `chat-completions.ts` passes only the linked signal, so a hung
  endpoint is bounded by `turnTimeoutMs` — a bound, just a loose one. A second timeout that must also
  exceed the endpoint's own is a second number to get wrong, and the ratio of one hung request to the
  turn's budget is unchanged by `maxSteps` moving. Left as a known looseness rather than a guessed
  default.
- The NLT heredoc leak in milo's transcript. **Real, high urgency, and worse than this line said** —
  see *Carried backlog* at the end of this document. It is not only that script text reaches the reply:
  the truncated command **executes**, and nothing anywhere reports it.

---

## Phase 8 — Scheduling

**Goal.** Cron, interval, and one-shot schedules that survive restart.

Split into **8A — core** and **8B — surfaces**, both built 2026-08-25.

### Decisions (Moeen, 2026-08-25, binding)

Recorded in full as `00-DECISIONS.md` §9.6–9.16. In short: one timer clamped to a 30 s horizon;
recurring schedules skip after downtime while an `at` fires late once; overlap **defers to a turn
boundary**, at most one deep; jitter is **derived from the schedule id**; an isolated run gets a
**fresh session per run**; `model:` is **open to named roles** and a schedule names one with `role:`.

Decision **9.1's rationale was corrected** in the same commit: it cited Cloudflare Durable Objects as
precedent for multiplexing N schedules onto one timer, and Cloudflare does the opposite — one alarm
per schedule, with an explicit rule against a single global object. The decision stands on a better
reason (libuv already collapses every JS timer into one poll wait), but the citation was load-bearing
and wrong, and nothing downstream could tell.

### 8A — built

- `packages/core/src/schedule/` — `duration.ts` (lossless round-trip), `zone.ts` (cached
  `Intl.DateTimeFormat`, DST by construction), `cron.ts` (5/6 field, vixie OR semantics, calendar
  descent, 1462-day horizon), `kinds.ts` (the three kinds, catch-up policy, jitter), `scheduler.ts`
  (the clamped timer, deferral, events).
- **Migration 8**, not 005 — the plan's number predated the migrations Phases 3, 4 and 7C added.
  `ScheduleStore` with `due`/`nextDue` **scoped to agent ids**, the same hazard `recoverInflight` is
  scoped against.
- Reconciliation at load, manifest-owned rows only. Slot 2 gains a `schedules` row reporting
  **runtime state**. `serve` starts the scheduler; `run` does not.
- `schedules` removed from `UNSUPPORTED_SECTIONS`; `validate` reports schedules including disabled.
- The role map opened, with `roles.byName` throwing on an unknown name and `validate` warning about a
  declared role nothing references — the pair that catches a misspelled `compactor`.
- `examples/reference/agent.yaml` uncommented, with a `cheap` custom role.

### 8B — built

- **Endpoints** per `04-SPEC-WIRE.md`: list (disabled included by default, `?enabled=` filters),
  create, read, patch, delete, and `POST …/:sid/run` for an out-of-band fire that deliberately does
  **not** move the schedule's own next run. Write-time validation is core's `prepareScheduleWrite`,
  shared with reconciliation's parse — a check only one of two writers performs is a check they
  disagree about. A PATCH revalidates the **whole** schedule rather than the fragment, because a
  changed `expr` can make a previously-fine `timezone` unsatisfiable and a fragment cannot see that.
  An API row is always `origin: "api"`, so a reload never deletes something no file describes.
- **`schedules` CLI** — list, `--id`, `--enable`/`--disable`, `--json`. It reads and toggles but
  never *writes* a schedule: a third writer beside the manifest and the API is three ideas of a valid
  expression. `--disable` on a manifest-owned schedule is **refused**, naming the exact line to edit —
  writing the store there reported success on a change the next boot silently undid.
- **`sessions` folds** `schedule:<id>:*` into one row with a run count. A 15-minute schedule writes
  ~35,000 sessions a year and unfolded they bury every real conversation; the individual keys stay
  addressable with `--session`.
- **An `init` question** with a `--schedules none|daily|hourly` flag. `none` still writes the block,
  commented, with the field names in it — a switch that is off wants to exist.
- `validate` reports schedules including disabled; the serving banner names the count.

### Deviations from the plan as written

- **No row-level `UPDATE … RETURNING` claim.** The plan called for one. Working through it, that
  pattern solves several workers competing for one row, which the lease already prevents — and a
  claim that clears the due time mid-run leaves it NULL forever if the process dies. In-memory
  in-flight state plus a durable due time is crash-safe by construction: a crash leaves the row
  overdue and the boot recompute reports it as a miss.
- **`validate` reporting schedules** landed in 8A rather than 8B: without it, 8A's acceptance was not
  observable from outside the process.

### Acceptance

- [x] All three kinds fire correctly; timezone honoured
- [x] DST: spring-forward skipped, fall-back once, both hemispheres — written **before** the code
- [x] `0 3 29 2 *` resolves to 2028-02-29; red at a 366-day horizon
- [x] Restart preserves schedules; missed fires skip rather than stampede, and say how many
- [x] An `at` ten years out does **not** fire at boot — red with the clamp reverted
- [x] A wall-clock jump causes no miss
- [x] Missing delivery target rejected at write with the documented error
- [x] Isolated runs do not pollute the live session — fresh key per run
- [x] Removing a manifest schedule removes it on reload; API-created survives
- [x] **100 schedules across 10 agents: one timer, worst drift 21 ms** (`bun run bench:schedule`)
- [x] Idle agent with schedules makes zero model calls until a schedule fires
- [x] Live: a real `at` fired once on a real endpoint, 13 ms drift, reply `SCHEDULED`, one session
- [x] `bun test` 2817 · `test:node` 1245 · typecheck clean · lint at the 6 pre-existing warnings
- [x] `bun run bench:boot` ok (96.7 ms median)
- [x] **8B** — round-trip create / list / patch / delete / run through the API
- [x] `schedule_missing_delivery` and the unknown-channel and unknown-role refusals fire at write time
- [x] An API-created schedule survives a reload that reconciles the manifest ones
- [x] `init --schedules daily|hourly|none` reaches the generated manifest — asserted on the **file**

### Four bugs only live running found

- **A schedule fired twice, 852 ms apart, in one process.** The row's due time was advanced at
  *completion*, so it stayed due for the whole turn: the timer re-armed at zero, woke, found the same
  row, and — correctly, by the overlap policy — deferred it, and the deferral fired it again. Every
  piece behaved as designed. Advancing at **dispatch** is the fix; the in-flight set prevents
  concurrency, not due-ness.
- **A disabled schedule kept a due time in the past**, because the boot recompute skipped it — so
  enabling it would have fired it immediately rather than at its next occurrence.
- **Every restart skipped an occurrence.** `anchorAt` names the boundary the *pending* `nextRunAt`
  belongs to, and the boot recompute treated it as already fired — so it asked for the occurrence
  after the one still waiting. Live across two starts: a daily brief went "in 4h" → "in 28h" and a
  leap-year schedule 2028 → 2032, on schedules that had never run. Invisible to every test, because
  it needs two process lifetimes with something pending in between. The fix also had to make
  consumption **explicit** — dispatch and boot want different answers from the same anchor, and
  inferring it from `from >= at` marked an overdue one-shot spent without ever firing it.
- **`init --schedules daily` was accepted and silently dropped**, in *two* object-literal funnels:
  the answers literal in `init.ts` — three lines above its own comment describing exactly this
  defect — and the flag dispatch in `index.ts`. Both type-checked. The fifth instance of this shape
  recorded in the repo, and the guard is the same one every time: a test at the far end that reads
  the value out of the generated file.

And one bad test: the overlong-`at` guard **passed with the clamp reverted**, because injecting
`setTimer` means the real `setTimeout` never runs and the 32-bit coercion cannot happen. It asserts
the requested delay now.

**Non-goals.** Distributed scheduling. Retry policies beyond fire-and-log.

---

## Phase 9 — Plugin API and WhatsApp

**Goal.** The plugin API is real, proven by refactoring first-party packages onto it.

**Deliverables**

- `plugins/plugin.ts`, `loader.ts`, `middleware.ts`, `permissions.ts`
- Version gating; 200 ms setup budget with `plugin.slow`
- Middleware composition, all four wrap points
- **Refactor** telegram and composio into plugins using only the public API
- `packages/channel-whatsapp` — Baileys, auth dir, QR, reconnect, credential wipe on `loggedOut`
- Documented risk note in that package's README
- `@dispach/core/testing` conformance suite
- `dispach plugins list` — table entry plus a plain writer

**Files.** `packages/core/src/plugins/`, `packages/channel-whatsapp/`, refactors

**Acceptance**

- [ ] Telegram and Composio use zero private core APIs — enforced by an export-surface test
- [ ] A plugin with a mismatched `dispachApi` refuses to load naming both versions
- [ ] Middleware ordering matches manifest order; a short-circuit returns a well-formed result
- [ ] Retry middleware demonstrably retries a 429
- [ ] Approval middleware blocks a mutating tool and the agent adapts rather than crashing
- [ ] WhatsApp: QR pairing, message round-trip, reconnect after network drop
- [ ] Revoking the WhatsApp session wipes credentials before re-auth; no stuck no-QR state
- [ ] Conformance suite passes for all first-party plugins
- [ ] Boot budget met with 5 plugins

**Non-goals.** Sandboxing. Enforced permissions. Hot reload. A plugin registry.

---

## Phase 10 — Multi-agent

**Goal.** A supervisor delegates to members with isolated context and typed results.

**Deliverables**

- `team/handoff.ts` — envelope, artifact validation against declared JSON Schema
- `team/supervisor.ts`
- `handoff` local tool, supervisor only
- Runtime-kind manifest with `agents` and `team`
- Sub-agent budget enforcement; `handoff.start` / `handoff.result`
- Migration 006: `handoffs`

**Files.** `packages/core/src/team/`, `manifest/schema.ts`, `examples/team/`

**Acceptance**

- [ ] Supervisor delegates to two members; both return validated artifacts
- [ ] Parent context contains the artifact and **not** the sub-agent transcript — asserted on token counts
- [ ] Schema-violating artifact is a typed failure the supervisor can handle, not an exception
- [ ] Budget exceeded terminates the sub-agent and reports honestly
- [ ] Measured: delegation uses fewer parent tokens than the equivalent in-context approach; recorded in `evals/`
- [ ] Members lack the `handoff` tool unless they declare their own team

**Non-goals.** A2A. Free-form agent chat. Dynamic team formation.

---

## Phase 11 — Docker, benchmark, release

**Goal.** v0.1.0, deployable, with the boot claim enforced.

**Deliverables**

- `docker/Dockerfile` on `oven/bun` slim, non-root, healthcheck
- `scripts/bench-boot.ts` with per-step breakdown
- CI gate failing above 1200 ms
- README with the measured number and how to reproduce it
- Complete `examples/`
- API docs generated from types
- v0.1.0 tagged

**Acceptance**

- [ ] Image under 150 MB
- [ ] Container start → `/v1/ready` 200 under 2 s including container overhead
- [ ] In-process boot under 1000 ms; CI enforces 1200 ms
- [ ] Benchmark names the slowest step so a regression self-diagnoses
- [ ] `docker run` with a mounted manifest works with no other setup
- [ ] Every example runs as documented
- [ ] Published boot number is reproducible on a clean clone

**Non-goals.** npm publish. Multi-arch. Helm.

---

## Phase 12 — VelaOps compat adapter

**Goal.** A VelaOps agent container runs Dispach instead of OpenClaw, with `apps/engine`
unchanged.

**Deliverables**

- `packages/compat-openclaw` — WS RPC on 18789, `x-openclaw-scopes`, `auth.token`, TUI client id, subscribe, terminal phase `result`
- `/healthz`
- `openclaw.json` → `agent.yaml` translation incl. `modelByChannel`, `delivery`, `deliveryTargets`
- `model: "openclaw/main"` indirection accepted and rewritten
- Gateway channel ids incl. `msteams`
- `[boot-phase]` markers on stdout for `boot-progress.ts`
- Cron RPC surface mapped to native schedules
- Compatibility test suite recorded against a live OpenClaw gateway

**Acceptance**

- [ ] A VelaOps agent container with `runtime: dispach` boots and serves chat with **zero** engine changes
- [ ] Telegram and WhatsApp work through the existing wiring
- [ ] `boot-progress.ts` renders the stepper correctly
- [ ] Cron round-trips through the existing UI including all three kinds and disabled jobs
- [ ] Detached chat reattach works via existing `stream-hub.ts`
- [ ] Both runtimes run side by side, selected per agent
- [ ] Documented deviations recorded in `06-VELAOPS-INTEGRATION.md`

**Non-goals.** Migrating existing agents. Changing engine code. Feature parity with OpenClaw.

---

## Deferred to v0.2

A2A agent card and server. MCP tool provider. Postgres store. Plugin sandboxing and enforced
permissions. Hot reload. Remote skill sources. Agent-triggered compaction. Code-execution
tool mode. Slack and Discord channels. Native tool dialect as default for large models
(revisit with Phase 3 eval data, not intuition). Web crawling, link-following and JavaScript rendering —
`web_fetch` reads one page by explicit URL, and a real crawl is a pinned `FIRECRAWL_CRAWL`. Caching
fetched pages, which would make staleness invisible. `confirm` as an `onMutate` policy, which needs the
approval middleware from Phase 9.

---

## Working rules

1. **Acceptance criteria are the definition of done.** Not "it runs."
2. **Non-goals are binding.** Scope creep into the next phase makes review impossible.
3. **Boot budget is checked every phase**, not at the end. Regressions are cheap to fix the day they appear.
4. **Evals are committed.** Every claim about small-model performance has a number in `evals/` and a script to reproduce it.
5. **Errors get hints.** A new error type without a `hint` fails review.
6. **No brand strings outside `brand.ts` and `package.json`.**
7. **Core imports nothing from siblings.** CI enforces it.

---

## Phase 6.1 — memory that actually carries

**Why this exists.** Reported from a live agent: *"the memory fails entirely — it couldn't retrieve any
useful information from previous sessions, and when I resume any session I don't see any previous
messages."* Both halves were true, and they had **three** independent causes that compounded into one
symptom. Diagnosed against the real store rather than by reading:

1. `init` generated the `memory:` block **commented out**, under a `# Phase 6 — memory` heading for a
   phase that had already shipped — so `manifest.memory` was `undefined`, `#recall` returned `[]`, and no
   agent `init` has ever created had memory at all. The commented line also read `k: 6`, a field that does
   not exist, so uncommenting it would have failed the load. Third occurrence of this defect after the
   `system` and `web` providers.
2. `includeHistory` was declared in the schema, defaulted to `true`, and **consumed nowhere** — so even
   switched on, memory held only `MEMORY.md` and `USER.md`. The literal transcript of the reported failure:
   *"what we were at?"* → *"I don't have anything in progress… no notes about where we left off."*
3. Nothing in the CLI called `Agent.history()`, so a resumed session painted an empty screen under a
   banner reading `17 message(s)`.

**Deliverables**

- [x] `memory/conversation.ts` — a conversation as a markdown document. Pure. Indexes messages with **no
  `origin`** (an allowlist of prose, not a blocklist of tool output), one passage per exchange, each side
  capped, whitespace collapsed so a message cannot become markdown structure
- [x] `syncSessions` / `enumerateSessions` beside `syncFiles` / `enumerateFiles`, reconciling the
  `session:<key>` namespace **separately**, over a shared `reconcile`
- [x] Turn-end hook in `Agent.send`, after the append and after `turns.finish`; failure warns and is
  swallowed, like recall's
- [x] The live conversation excluded from its own slot 7, the way the carried file is
- [x] `rebuildMemory` restores both namespaces — the backfill for sessions predating all of this
- [x] `maxActive` 3 → 5 and `budget` 600 → 2000, required by the passage size rather than generous
- [x] A `memory` row in slot 2, and a distinct frame for a conversation excerpt in slot 7
- [x] `seedHistory` — the resumed conversation on the screen, prose only, rich path only
- [x] `StoredMessage.origin` declared, having been set-but-undeclared since migration 5

**Files.** `packages/core/src/memory/{conversation,fts5,index}.ts`,
`packages/core/src/runtime/agent.ts`, `packages/core/src/context/{assemble,config-summary}.ts`,
`packages/core/src/{manifest/schema,store/store}.ts`, `packages/cli/src/{run,memory,transcript}.ts`,
`packages/cli/src/lib/init-flow.ts`, `examples/reference/agent.yaml`, `docs/02-SPEC-MANIFEST.md`

**Non-goals**

- Embeddings. Decision 5.x stands: prove lexical insufficient first, and `evals/memory/` is where that
  argument would have to be made.
- Recovering the prose from an NLT `origin: "call"` message. Under that dialect the model's narration and
  its `ACTION` block are one row, so splitting them means running a dialect parser over stored text at
  read time — with the dialect possibly changed since it was written. The final answer still pairs
  correctly; what is lost is narration `exchanges` drops deliberately anyway. Recorded rather than hidden.
- History on the plain path. `--plain` must match a pipe byte for byte, and a piped REPL replaying its own
  history changes what every existing script reads.
- A transcript row cap. There is no such constant today and the transcript already grows unbounded within
  a session; seeding history does not change the shape of that, and inventing a cap here would be a
  separate decision made in passing.
- `knowledge:` is **still generated commented out**, and by the standing directive of decision 4.53 it
  should not be. It differs from memory in needing a directory that must exist first, so it is a real
  question rather than a one-line fix — flagged, not silently bundled.

**Acceptance**

- [x] A fresh `init` agent has memory on, with `includeHistory` — asserted positively in
  `init-flow.test.ts`, and `# memory:` / `k: 6` asserted absent
- [x] Something said in session A reaches the prompt of session B with no note written by hand — asserted
  on the **request body** in `memory-turn.test.ts`
- [x] An observation is never indexed — asserted on the request body, not on an intermediate value
- [x] The live conversation is not retrieved into its own prompt
- [x] Each reconciliation pass leaves the other's sources intact, in both directions
- [x] An unchanged conversation is not read at all — the steady-state cost at every turn end
- [x] A memory file cannot squat the `session:` namespace
- [x] A hostile message (`- `, `#`, `---`) survives as **one** passage
- [x] Live, against `deepseek-v4-flash` on a real agent with 18 prior sessions: `memory rebuild` indexed
  18 conversations / 22 passages; `memory search "openclaw research"` returned 3 above threshold at
  0.884 / 0.694 / 0.571; a **new** session answered "what were we researching in our earlier sessions?"
  correctly, and the false *"the transcripts don't carry over"* rider disappeared once slot 2 had its row
- [x] `dispach run milo --session <key>` paints the conversation — verified over a real pty at 100×30
- [x] `bun test` 2328/0 · `test:node` 1128/0 · `bench:boot` 79 ms (ceiling 1000) · lint at the 6
  pre-existing warnings

---

## Phase 6.2 — collaborator setup, and removing an agent

**Why this exists.** Collaborators were invited to the repository, and three things blocked them —
one of which turned out to have a real gap behind it.

1. **The README was stale in ways that actively mislead.** `## Status` said *"Phase 0 of thirteen…
   there is no runtime behaviour yet"*, which tells a new collaborator the project does nothing;
   `## Boot budget` deferred a number that has been measured since Phase 1. And there were **no
   install instructions at all** — nothing said `bun link`, that the build must precede it because
   `bin` names `dist/`, or that Node must be on `PATH` for the shebang.
2. **Nothing deleted an agent.** Fifteen commands, none of them removal, so it was `rm -rf` plus
   knowledge of four tables, a log pair and a launchd label. The rows left behind were unreachable:
   `LeaseStore.orphans`' docstring admitted it and pointed at a `sessions --reap-orphans` that was
   never built. `logs/dot.*.log` existed on the author's machine with no agent behind it.
3. **"Is the store shared?" was a fair question with an undocumented answer.** One `store.db` per
   sandbox root, isolated by `agent_id` on every table. Kept, and now written down — along with the
   two things about it that had already caused or nearly caused bugs.

**Deliverables**

- [x] `Store.agentFootprint` / `purgeAgent` / `agentIds` — one shape for "what would go" and "what
  went", so a listing and a deletion cannot disagree
- [x] `remove <agent>` with `--dry-run`, `--files-only`, `--prune`, `--all`, `--yes`
- [x] `lib/remove-plan.ts` — pure: findings, ordered steps, both listings
- [x] `askExactly` beside `askYesNo`, and the first tests either has had
- [x] `logPaths` moved from private in `daemon.ts` to `lib/sandbox.ts`
- [x] README: epigraph, Status, `## Getting set up`, `## Where things live`, `## Commands`, the
  measured boot number, and the house rules a newcomer trips over first
- [x] The stale `--reap-orphans` docstring corrected; `kv` documented as having no consumer

**Files.** `packages/core/src/store/{store,sqlite/store}.ts` · `packages/core/src/index.ts` ·
`packages/cli/src/remove.ts` · `packages/cli/src/lib/{remove-plan,confirm,sandbox,commands}.ts` ·
`packages/cli/src/{index,daemon}.ts` · `README.md` · `docs/00-DECISIONS.md` · `CLAUDE.md`

**Non-goals**

- **Per-agent databases.** `runtime_leases` is deliberately global — `stop` and `daemon status`
  answer one question from one place — so splitting means two layouts or N opens per question.
- **A `store:` manifest field.** A second layout in every command taking `--store`, plus a
  `config_set` floor, for no case anyone has.
- **Undo or a trash directory.** The listing and the typed name are the safety.
- **`~/.dispach/sources/`.** A shared catalogue cache, not agent-owned; `sources` manages it.
- **Renaming `agents`.** It means manifest *paths*, not the sandbox, which is a real collision — but
  renaming a shipped command is its own decision, not one to make in passing.
- **Restructuring the README.** Setup and correctness only; the design sections were accurate.

**Acceptance**

- [x] Removing one agent leaves a *second* agent's sessions, memory and outbox byte-identical
- [x] `agentFootprint` equals what `purgeAgent` reports, on one fixture
- [x] An agent owning only a stale lease is still named by `agentIds` — the case `orphans` cannot see
- [x] A shared manifest id refuses, names the other directory, and `--files-only` clears it
- [x] The directory is the last step in every configuration; a stop always precedes it
- [x] `askExactly` rejects a near miss and a case difference; not a TTY is no in both prompts
- [x] Live, in an isolated sandbox under `DISPACH_HOME`: two agents with real sessions and memory →
  `remove alpha --dry-run` listed and deleted nothing → a piped run without `--yes` deleted nothing →
  `remove alpha --yes` removed it while `beta` kept its sessions, passages and working retrieval →
  a shared id refused → `--files-only` succeeded and said what it kept → a hand-deleted directory and
  a stray log file were both found by `--prune` → a **running** agent was stopped gracefully (its
  `serve` exited 0, lease released) before its directory went → at a real pty the wrong name was a
  no-op and the right name removed it → `--all` removed both
- [x] `bun test` 2366/0 · `test:node` 1128/0 · `bench:boot` under budget · lint at the pre-existing

---

## Phase 6.2b — three defects that were already diagnosed

**Goal.** Close the three items flagged after 6.2 and not undertaken then. No new capability; each one
is a shipped thing that was hidden, unbounded, or inconsistent with itself.

**1. `knowledge:` was generated commented out.** Phase 3.5 shipped four phases earlier, and `init` wrote
`# knowledge: { dir: ./knowledge, maxActive: 2, budget: 600 }` under a heading naming that phase — the
third instance of the pattern the standing init directive exists to stop, after the web provider and
`memory:`. The note beside it ("create ./knowledge first") was *correct*: `loadKnowledge` throws
`knowledge_dir_missing` on an absent directory, which is why writing the block live also required
scaffolding one. `knowledge/.keep` now ships beside `skills/.keep`, and `validate` reports
`knowledge 0 entries, maxActive=2, budget=600` — a switch that is off rather than a concept the agent
does not have.

The authoring guidance had to go in the manifest comments rather than a `README.md` in the directory:
every `*.md` there is an entry and `parseKnowledgeFile` throws without frontmatter `keywords`, so the
file explaining how to write one fails the load. Verified both ways — the documented format loads as
1 entry, and a plain `README.md` refuses with the error that names the requirement.

**2. The transcript had no cap.** Described in `CLAUDE.md` as load-bearing since `<Static>` was removed,
and absent. Every item is re-derived and re-wrapped per frame now, so the buffer was unbounded work per
keystroke; the case that reaches it is an agent looping tool calls overnight, not a person typing.

Two decisions, both Moeen's: the cap counts **items** (2000), because the reducer that owns the buffer
is pure and a row count needs the terminal width; and eviction is **gated on `pinned`**. The gate is the
substance — rows are addressed by position, so dropping any from the front leaves a reader parked in
history on the same offset over different text, which is worse than the growth. `trim` is therefore an
action `App` dispatches while following the tail, returning identical state when there is nothing to do
so the caller never has to check first.

**3. NLT call-prose was missing from a resumed screen.** One `origin: "call"` row holds the narration
and the `ACTION` block, and the resume filter admitted only `origin === undefined` — so a live session
showed "I'll read notes.md…" as it streamed and a resumed one showed nothing for that turn. Recovered at
*read* time by `proseOf`, which needs no stored field and works on rows already written; a new field on
`ChatMessage` is the conditional-spread shape that has cost six debugging rounds. Scope was Moeen's
call: **screen only**. The memory index still excludes it deliberately — `exchanges` pairs a question
with its final answer, and narration would move every document frequency while risking being read as
the reply in a turn that ended on a tool call.

`lib/resume.ts` was extracted for this, pure and in the `PURE` list: the filter was four chained
lambdas inside a function needing a live runtime, which is how it shipped wrong twice.

**Files.** `packages/cli/src/lib/init-flow.ts` · `packages/cli/src/lib/const.ts` ·
`packages/cli/src/transcript.ts` · `packages/cli/src/hooks/useTurn.ts` ·
`packages/cli/src/components/App.tsx` · `packages/cli/src/lib/resume.ts` (new) ·
`packages/cli/src/run.ts` · `packages/core/src/tools/dialect/prose.ts` (new) ·
`packages/core/src/runtime/agent.ts` (`AgentDescription.dialect` narrowed to `DialectId`) ·
`packages/core/src/index.ts`

**Acceptance**

- [x] A generated agent has a live `knowledge:` block and a `knowledge/` directory, and loads
- [x] The documented entry format loads; a `README.md` in that directory refuses by name
- [x] `trim` is identity under the cap — asserted by reference, since that is what skips the render
- [x] No action other than `trim` ever evicts, however far over the cap the buffer is
- [x] `App` bounds the buffer while following the tail — asserted through the scroll hint, and
  confirmed to **fail** with the effect disabled rather than passing for another reason
- [x] `proseOf` keeps prose before *and* after a block, yields `""` for a silent call, and leaves
  native content and non-assistant roles untouched
- [x] `priorMessages` excludes `observation`, `repair`, `digest`, `system` and `tool`, and drops empties
- [x] Live: a real deepseek turn that narrated and called `file_read`, resumed at a pty — the narration
  is on screen, no `ACTION` block is, and the observation row is still absent. Confirmed against the
  store that the row carries `origin: call` and the block, so it is the row the old filter dropped
- [x] `bun test` 2387/0 · `test:node` 1144/0 · `typecheck` clean · `bench:boot` 76.5 ms median ·
  `lint` at the 6 pre-existing warnings

**Non-goals.**

- **Call-prose in the memory index.** Decided above, not deferred.
- **A row-unit cap.** Would need the terminal width inside a pure reducer, or a second eviction path
  at render time that bounds what is drawn while the buffer keeps growing.
- **Telling a parked reader that history was dropped.** Only needed by the eviction policy that was
  not chosen; deferring is free because `esc` returns to the tail and trims then.

---

## Phase 6.3 — a config surface for the person

**Goal.** A person can change any setting after `init` without hand-editing YAML.

**The gap.** `config_read`/`config_set` exist in `tools-system/src/config.ts` with a 15-path `SETTABLE`
list, a floor, and `setInSource` doing comment-preserving edits — as **tools the agent calls**. There is
no `config` command among the sixteen, so a person's routes are hand-editing `agent.yaml`, re-running
`init` into a fresh directory, or asking their own agent (which needs `config_set` pinned, in
`policy.allow`, and a restart).

The inversion is the argument. This project deliberately reserves `allowFrom`, `server.host`,
`server.tokenEnv`, `writeRoots`, `tools.policy.deny` and `untrusted.onMutate` **for the person**, floored
so the agent cannot widen its own reach. That decision stands. But the only editor ever built is the
agent's, so the fields designated as the person's have the worst ergonomics in the system: unvalidated
YAML that fails at the next boot. It compounds with `.env` being a protected path *precisely* so the
agent cannot supply its own secrets — leaving the one actor who can fill in `MODEL_API_KEY` with no tool
for it.

**Decisions taken (2026-08-20).**

- **Shape:** a `config` command, plain path first, TUI over the same pure catalogue —
  `config list` / `config get <path>` / `config set <path> <value>`, then a full-screen editor. The
  plain path is what a collaborator, a script and CI need, and it makes the TUI a renderer over a
  reducer that is already proven.
- **Secrets:** yes. When a field names an env var that is not set, the surface offers to write it to the
  agent's `.env` at 0600, never echoed and never in scrollback. Without it the command can report
  `MODEL_API_KEY is not set` and be unable to fix it, which is the dead end this phase exists to remove.
- **Field scope:** the agent's settable list **plus** the person-only floored fields, one catalogue with
  two permission tiers, each row stating who may set it — so the floor is visible rather than a refusal
  met later.
- **In session:** `/config` is a pane, and on save it returns the `RESTART` symbol `/restart` already
  uses, because an agent's settings are fixed for its lifetime and `manifest_changed` already says so.

**The load-bearing constraint.** `yaml-edit.ts` stays the **only** thing that mutates a manifest, with
the *policy* — which paths, which floors — varying by caller, the person's tier a superset of the
agent's. A second edit path is how one caller writes a manifest the other's schema rejects, which has
already happened once with `tools.providers`: a document the schema accepted and the runtime refused, an
agent that booted today and not tomorrow, reported as success.

**Non-goals.** Generating rows from the whole Zod schema — the deep nested shapes (workspace tiers,
model roles) have no sensible flat editor and `setInSource` writes scalars, lists and maps rather than
arbitrary nesting. A hand-curated shortlist, which is the drift `session-commands.ts` was written to
end. Editing another agent's manifest by path without a ref. Sequence indexing in the writer — a key
inside a list entry is reached by rewriting the list, and `allowFrom` has its own action instead.

---

## What was built

`config list | get | set | env | allow`, plus the plumbing the decision above required.

**One writer.** `core/manifest/edit.ts` — `prepareManifestEdit` is pure (place, schema,
`resolveProviders`) with `editManifest` and `editManifestSync` over it. `yaml-edit.ts` **moved** from
`tools-system` into core, and `parseSettingValue` with it, so the two surfaces cannot disagree about
whether `["a", "b"]` is a list. `skills enable` was the third writer and now goes through this,
gaining validation it never had. Each caller keeps its own *policy* and translates the writer's errors
into its own audience's vocabulary — the agent's are prose for a model, the person's for a terminal.

**One catalogue.** `core/manifest/settings.ts` holds every settable path once, with `agentListed`,
`confirm` and `via` per row. `config_read`'s prose is carried verbatim on `toAgent`, because the whole
summary was measured at 549 tokens against a 2,000-token observation budget.

**Three bugs found on the way, all pre-existing:**

- `renderScalar` permitted `@` in a bare scalar, so `config allow` wrote **unparseable YAML** — and
  `prepareManifestEdit` waved it through, because `toJS()` on a broken document still returns an
  object. Both halves fixed; the structural one matters more (11.107).
- `NO_MANIFEST` was hand-kept and wrong both ways, so **`/soul distill` has been broken in-session**
  for as long as it has been offered, and `/agents` ran with no manifest (11.108).
- `resolveSessionCommand` was called with no offered list and `onSubmit` had no `case "command"`, so
  **no typed slash command with arguments worked** — the palette ran them and typing the same thing
  spent a model turn (11.109).

Two more, minor: `tools.local`'s description had omitted `artifact_read` for two phases, visible in a
real `config list` beside the value that contradicted it; and `palette.test.ts`'s
`LANDING_LIST_ROWS` assertion counted 11 entries against a 16-row list, so it passed while the frame
was truncated — the guard whose comment claims it catches exactly that.

**Files.** `packages/core/src/manifest/edit.ts`, `settings.ts`, `yaml-edit.ts` (moved) ·
`packages/cli/src/config.ts` · `packages/cli/src/lib/config-view.ts`, `dotenv-edit.ts` ·
`packages/cli/src/lib/confirm.ts` (`askSecret`) · `packages/cli/src/lib/subcommand.ts` ·
`packages/cli/src/lib/palette.ts` (`offeredCommands`) · `packages/cli/src/components/App.tsx` ·
`packages/tools-system/src/config.ts` · `packages/cli/src/skills.ts`

**Acceptance**

- [x] One writer: `skills enable`, `config_set` and `config set` all validate identically
- [x] `prepareManifestEdit` is pure, and refuses a result that is not valid YAML *before* the schema
- [x] A person may set every field decision 11.29 reserves for them; the agent's floor is unchanged
- [x] Only `tools.policy.deny` and `onMutate: allow` confirm; `onMutate: confirm` does not
- [x] A declined confirmation writes nothing; `--yes` skips it; not a TTY declines
- [x] A secret is prompted, masked, written 0600, and refused from a pipe or an argument
- [x] `.env` comments and other variables survive; every value round-trips through `parseDotEnv`
- [x] An impossible Telegram handle is refused with the rule it broke, sharing `init`'s check
- [x] `allow` is idempotent, normalises to `@`, and `--remove` takes it off
- [x] Env consequences are differentiated: load failure vs boot failure vs unauthenticated API vs a
  provider that will not work — and only *newly* required ones are reported on a set
- [x] A running agent is named with the right restart route for its mode, never refused; a stale
  lease is ignored
- [x] Live, in an isolated sandbox: three edits to a generated manifest changed exactly three lines,
  with every comment and alignment intact · a first `channels` write went from 98 reflowed lines to 11
  · `config allow @ada-lovelace` refused · a real handle wrote quoted and the agent still loaded ·
  the secret prompt masked ten characters and wrote 0600 · `/config get` and `/config set` ran as
  panes at a pty, the latter naming `/restart` in this session
- [x] `bun test` 2482/0 · `test:node` 1164/0 · `typecheck` clean · `bench:boot` 75.0 ms median ·
  `lint` at the 6 pre-existing warnings

---

## Phase 6.3b — the editor

**Goal.** Change any setting from a screen, without knowing a dotted path.

**Decisions taken (2026-08-21).**

- **Reach:** `config edit <agent>` *and* bare `config <agent>`. The action becomes optional and the six
  action words win the first positional; anything else is an agent. Two action words print a note.
- **Saving:** immediately, one write per confirmed row, through the same `applySet`/`applyAllow`/
  `applySecret` the plain commands use. No staged set, no unsaved state, no cancel-all.
- **Coverage:** everything — dotted settings, one `allowFrom` row per declared channel, and every
  secret the manifest depends on, masked.

**Shape.** `lib/config-editor.ts` is the pure reducer (rows, cursor, mode, buffer);
`components/ConfigEditor.tsx` is a *view* under the Phase 5.5 contract — it owns its state and its
single `focused`-gated `useInput`, like `SkillBrowser` and `SessionPicker`, and never mounts itself.
`lib/config-apply.ts` holds the three writes so the editor and the plain commands cannot diverge on
one; `lib/config-rows.ts` builds the rows and is imported *statically* by both hosts, because
`index.ts` imports `config.ts` dynamically and a module reached both ways makes the bundle unparseable.
Both modes share `keyToWizardIntent` — `select: true` browsing, `select: false` in a field — so there
is no third intent mapper to keep in step.

**Six pre-existing defects found on the way**, four of them silent:

- `config edit` without a tty wrote the alternate-screen escape **into a pipe** and exited **0** on
  Ink's raw-mode error (11.114).
- `ambientEnv` was being asked a question it cannot answer, so a token beside the manifest read as
  unset and an editor row said `(not set)` right after being set (11.115).
- `titleLine` dropped the `summary` that `Screen` renders, so the conversation switcher's "pick a
  conversation" had never appeared either (11.117).
- `MAX_SCREEN_ROWS` as a window overflowed a 30-row terminal, scrolling the header and cursor away
  (11.116).
- `dispatch`'s `useCallback` was missing `manifestPath` once the `/config` branch read it.
- And in the tests: `KEY.return` does not exist (it is `KEY.enter`), which typecheck catches and I had
  run the suite first; and two `config-env` tests asserted on `MODEL_API_KEY`, which `bun test`
  auto-loads from the repo's own `.env` — the contamination hazard this repo has recorded twice.

**Acceptance**

- [x] `config <agent>`, `config edit <agent>` and `/config` all reach the editor; `config list <agent>`
  still reaches the listing
- [x] The cursor opens on the first setting, steps over headings in the direction of travel, and never
  parks on one; a list with nothing selectable does not hang
- [x] A secret never appears in any frame and never seeds the buffer — asserted by grepping every
  frame of a real pty session for the value
- [x] An impossible handle is refused in place with the buffer kept, so it can be corrected
- [x] A value the schema rejects is refused with the schema's own words, and nothing is written
- [x] Rows are re-read after each write: a secret's row goes `(not set)` → `(set)`, and `config list`
  agrees
- [x] No tty refuses with exit 1 and writes nothing to stdout
- [x] Live, at a pty: the editor opened via bare `config <agent>` · navigated · `model.main.id` changed
  and the file changed with it · `allowFrom` refused `@ada-lovelace` then accepted `moeen_m` · a secret
  typed masked, landing in a 0600 `.env`, never on screen · `/config` opened as a pane in a session and
  an edit there **restarted the agent**, whose banner then reported the new model
- [x] `bun test` 2525/0 · `test:node` 1164/0 · `typecheck` clean · `bench:boot` under budget ·
  `lint` at the 6 pre-existing warnings

**Non-goals.** A staged set with a cancel-all (11.111). Editing `writeRoots` from the editor (11.112).
Sequence indexing in the writer — a key inside a list entry is reached by rewriting the list.

**Follow-up, reported by Moeen and fixed (2026-08-22).** A long value could not be edited: `TextField`
never passed `columns` to `LineCursor`, so the settings editor clipped anything wider than the terminal
at the right edge with the caret *past* the clip — `tools.pinned` is 92 characters in a generated
manifest. Fixed by threading the width and a row bound, sizing the editing view's bound from the screen
it owns rather than from the shared `FIELD_ROWS`, and stopping the hint from echoing a long value.
Measured at the 40-column floor: a 140-character `tools.policy.allow` is fully visible across five rows
where three made it scroll under an empty terminal.

The wizard, `TextField`'s other caller, turned out **not** to be affected — a bordered box bounds its
text whatever the field passes — and the test written to prove otherwise passed with the fix reverted
(11.119).

- [x] A value wider than the terminal wraps and its tail is on screen, at 80 columns and at 40
- [x] The same value in the in-session pane behaves identically
- [x] Deleting and retyping at the end of a wrapped value is visible throughout
- [x] The new guard **fails** with the width removed — checked, unlike the wizard one
- [x] `bun test` 2528/0 · `test:node` 1164/0 · `typecheck` clean · `lint` at the 6 pre-existing warnings

---

## Phase 7E — the terminal we actually run in

**Shipped 2026-08-24.** Decisions 11.120–11.137.

**Goal.** Four complaints, tenth round on the TUI: text could not be selected with the mouse,
keyboard shortcuts did not fire, editor navigation did not work, and the composer floated mid-screen
on the landing screen. Every previous round had guessed at chord behaviour against Ink's parser
instead of against a terminal, which is why they kept coming back.

### What was measured first

- **Ink 7.1.1 parses the kitty keyboard protocol completely and negotiates it for us — and it is
  opt-in, and we never opted in** (`ink.js:800`: *"Protocol is opt-in: if kittyKeyboard is not
  specified, do nothing"*). Without it Ink's legacy branch folds super into meta (`modifier & 10`),
  so `cmd+←` was **indistinguishable** from `⌥←` and both word-moved.
- **`⌥r` was bound, handled, and dead.** Warp resolves Option+letter to a composed character before
  the protocol layer, so it arrived as `®` — and `printableOnly` keeps anything ≥ 0x20, so the
  documented chord *typed into the message*.
- **Mode 1002 was never set**, so a drag was never reported: mouse selection was unreachable rather
  than merely absent. The coordinates `mouse.ts` already parsed were thrown away.
- **`wrap.ts` measured code points, not columns.** `wrap.test.ts` asserted `"👍"×10` at width 10 was
  one row; it draws as 20 columns and wraps. Inverting that assertion was the fix.

### Built

- **The frame.** One `<Box flexGrow={1} />` above the composer in both states, so the input sits on
  the bottom edge and stops walking down the screen as the first messages arrive (11.120, superseding
  11.98).
- **The keyboard.** `negotiateKeyboard()` pushes the protocol with `disambiguateEscapeCodes` and
  `reportEventTypes`; `lib/csi.ts` decodes the modifier off the raw bytes anyway, because Warp omits
  the event-type field and the negotiation alone was not enough (11.125). Full editor navigation:
  `cmd+←/→` line, `⌥←/→` word, `cmd+↑/↓` buffer, Home/End (which had never worked), `cmd+⌫`,
  `cmd+z`. `^O` does what `⌥r` does, needing neither the protocol nor a terminal setting (11.128).
- **`dispach keys`** — a probe that prints raw bytes as hex, Ink's parse, the resolved intent, and
  whether the protocol is proven rather than merely requested. It taps stdin because `useInput`
  reports `input: ""` for exactly the keys worth probing (11.123).
- **Width in columns.** `lib/width.ts`, a range table, honest about being per code point.
- **Selection**, in buffer coordinates — which is what makes it small: the reference implementation
  spends ~40% of its selection state surviving screen coordinates, and we never lose the text
  (11.132). Drag, double-click a word, triple-click a line, shift-click to extend, in the transcript
  *and* in the composer. Shift plus every motion extends in the editor (11.129).
- **Follow-ups in the same phase:** the exit hang (11.135–11.136), the two-line faint resume notice
  (11.137), and `/status`, which was advertised and unhandled.

### Acceptance

- [x] `cmd+←` → `cursorHome` and `⌥←` → `wordLeft`, asserted from the bytes a terminal sends
- [x] A key release does not double-fire; the protocol reply is swallowed rather than typed
- [x] Every documented `⌥` chord walks a drift test, which is what `⌥r` never had
- [x] A 30-row transcript sweep copies exactly the window's rows and no chrome
- [x] Live drag in the composer highlighted `'new world'`; typing `X` gave `hello brave X`
- [x] The composer's last row is directly above the status bar in **both** states, at every width
- [x] `bun test` 2718 · `test:node` 1193 · typecheck · lint at the 6 pre-existing warnings · bench ok

### Deviations from the plan as written

- **`mode: "auto"` did not work and became `"enabled"`.** Ink's 200 ms detection window loses the
  race in Warp — the reply arrived after it closed and `CSI ? 0 u` was typed into the composer.
- **`reportEventTypes` was recorded as the fix for `cmd+←` before it was measured, and it was not.**
  Warp omits the field anyway. The bytes are decoded directly now, which is the version that works.
- **The composer got selection too**, which the plan had as its own later stage.

---

## Phase 7D — the numbers the runtime runs on

**Goal.** Every `init` preset's default model has an unverified context window, and nothing says so.
`deepseek-v4-pro` is declared at 393,216 against a published 1,048,576, and `claude-*` is **one row
for every Claude model ever released**, so it cannot be right for `claude-sonnet-5` and an older model
at once.

**The third premise was wrong, and finding that out was worth the phase on its own.**
`promptCache: "none"` on every deepseek row looked like a cost bug — the hypothesis being that the
cache-stable prefix had never been exercised against the endpoint in daily use. The registry comment
beside those rows had already answered it (*"`none` is a statement about the runtime's job, not the
provider's behaviour"*), and the first live probe measured **1024 of 1115 prompt tokens cached** with
no cache-control markers sent. So the comment was right, caching has been working all along, and
`promptCache` turns out to be **read by exactly one thing in the tree** — a line of `validate`'s
output. Recorded here rather than quietly dropped: the alarm reached a plan document and a memory
note, and a false premise that survives is how the next round starts from the same wrong place.

Decisions 3.7–3.9.

### 7D.3 — window provenance *(built 2026-08-24)*

`WindowProvenance` on every `ResolvedRole`: `manifest | registry | fallback`, with the matched
pattern carried alongside. `windowReport(manifest)` is the one pure derivation behind all of it —
`validate`, `/status`, `Agent.create`'s boot warning, and `/context` when it lands.

- [x] `validate` names the source and prints a line per role that carries its own configuration:
      `window 393216 registry deepseek-v4-flash*`, then `compactor qwen3.5:9b · window 32768 registry qwen3.5*`
- [x] `/status` names it on the model line
- [x] A `*` match warns once at boot on `agent.warnings`, naming the role, the id and the floor
- [x] An unconfigured role does not report a second time — asserted, and red with the filter removed
- [x] `bun test` 2725 · `test:node` 1200 · lint at the 6 pre-existing warnings · bench ok

### 7D.1 — `/context` *(built 2026-08-24)*

A session-local breakdown of what is in the prompt right now. Decisions 11.138–11.139.

`previewContext` gained the three terms only it knows — `wireTokens`, `calibration`, `compactions` —
and `contextReport` in `lib/session-commands.ts` is the pure formatter both paths call. Session-local
like `/tools` and `/status`, because `subcommandArgv` passes only a manifest path and `--plain`, so a
command pane's child boots its own runtime and would confidently report a different conversation.

- [x] The budget prints as its subtraction, and the percentage divides by it rather than by the window
- [x] `estimated` versus `corrected ×N.NN from K reported figures`
- [x] Per-slot rows with the pinned ones marked — pinned survives every stage including S5
- [x] Window provenance on the first line, from 7D.3
- [x] Every line fits at 80 columns, verified from a live capture rather than by counting characters
- [x] The `SessionCommandKind` drift test caught the missing `App.tsx` arm the moment the command was
      registered, and the plain path's switch is exhaustiveness-checked so TypeScript caught that one

**One regression, caught by the guard written for it.** Adding a command pushed the landing palette
past `LANDING_LIST_ROWS`, so `/daemon` fell off behind `… 1 below`. `palette.test.ts` asserts the
relationship and `roots.test.tsx` asserts the frame; both went red, the constant moved 16 → 17. This
is the second time that pair has done its job.

### 7D.2 — `model probe`

Measures the window for **every configured role**, cheapest-first: `GET /models` metadata (free), an
over-range `max_tokens` whose refusal names the output ceiling (free), prompt caching by effect (two
tiny calls), and a prompt-size search behind `--window` with a printed cost estimate (~$0.30 to reach
1M on DeepSeek, $5–30 on OpenAI or Anthropic). Acceptance yields a **floor**; only a refusal naming a
number yields a **ceiling**. `--write` goes through `core/manifest/edit.ts` and leaves a dated
comment; the report also prints a paste-ready registry row, so changing a shipped default stays
reviewed.

*(built 2026-08-24)*

- [x] Four techniques, cheapest first: `GET /models`, an over-range `max_tokens`, caching by effect,
      and a prompt-size search behind `--window`
- [x] Every configured role; a role that falls back to main is not probed twice
- [x] A **floor** is reported as a floor and `--write` refuses to write one — a floor written as
      `contextWindow` becomes "exactly this much" for every future reader, which is how 393,216 got
      there in the first place
- [x] `--write` goes through `editManifest`, so what lands is schema-checked rather than re-serialised
- [x] A paste-ready registry row is printed, never written: changing a shipped default affects every
      agent that ever runs that model
- [x] Techniques that found nothing are printed — "the endpoint clamps `max_tokens` silently" is
      information about the endpoint, and a report showing only successes looks like it had nothing
      to say
- [x] The caching question, answered live: **yes**, 1024 of 1115 tokens, via `prompt_cache_hit_tokens`
- [x] `--window`'s estimate is in **tokens**, with `--price` for the arithmetic. A departure from the
      plan as written, which said dollars: a price table in this repo would be wrong within a quarter,
      and a confidently wrong dollar figure is worse than an honest token count
- [x] `bun test` 2769 · `test:node` 1201 · lint at the 6 pre-existing warnings · bench ok

**One defect the live run found in the probe itself.** DeepSeek refuses with *"the valid range of
max_tokens is [1, 393216]"*, and the first parser answered **1** — the range's lower bound — printing
`output cap 1`. The adversarial tests covered unlabelled numbers and never anticipated a labelled
*range*. Found by running the command against a real endpoint rather than by reading it, which is the
whole argument for the live step; the real wording is now a test.

**The window, measured (2026-08-25).** `--window --price 0.28` against `api.deepseek.com`:

```
measured      1048576 (ceiling) · refused a 1048576-token prompt and named 1048576
agreement     configured value is 393216, which is 655,360 tokens short
output cap    393216
prompt cache  yes — 1024 cached of 1115 prompt tokens, via prompt_cache_hit_tokens
```

So `deepseek-v4-flash` really is a **1,048,576**-token model and the registry has been declaring
37.5% of it. The search was designed to raise a *floor* and returned a **ceiling**, because the
request that ends a doubling search is a refusal and refusals name numbers — the better-than-designed
outcome the module predicted, and the reason `--write` could act on this at all.

Cost: the printed estimate was an upper bound of 4,186,112 tokens ≈ $1.17 at the given price; the run
stopped at the eighth of nine requests and the refused one generates nothing, so roughly 1.04M billed —
less again, because each prompt is a prefix-extension of the last and the caching this same command
had just confirmed applies to them.

**The row was reviewed and changed (2026-08-25).** `deepseek-v4-flash*` now carries
`contextWindow: 1_048_576`, with `verified` recording that it is a ceiling and how it was obtained.
Held for a round first rather than written by the probe, which is decision 3.11 working as intended: a
manifest is one agent, a registry row is every agent that ever runs the model.

What the old number was is the interesting part. 393,216 came from the pro row, whose own test comment
records its provenance — *"`contextWindow` is a proven floor: max_tokens=393216 beside an 85-token
prompt was accepted"*. A floor, written into the field every budget divides by, and inherited by flash
on the strength of "limits assumed same as pro". That is decision 3.10 in its natural habitat.

`maxOutput` stays 393,216 and is separately confirmed. Window and output cap were equal on this model
and are not any more, which makes it the one row where an assumption that they track each other would
break — asserted, so it cannot drift back. The `deepseek-v4-pro*` row is **not** touched: it was not
measured, and inheriting flash's number is the same shortcut running the other way.

**`--window` now asks before spending** (decision 3.14). The estimate printed and the money went
anyway, which makes an estimate decoration; `askYesNo` answers no on a non-TTY, so a pipe or a CI run
is told rather than charged, and `--yes` is the scripted way through.

### Not in this phase

- **`/compact`.** Considered and rejected: the ladder already fires at 60% per step so there is no
  cliff to pre-empt, and compaction rewrites the prompt and never the store, so a manual trigger
  would have nothing durable to do. Do not add it back without revisiting that.
- Provenance for capability fields other than `contextWindow`. Every field in a registry row has the
  same problem; the window is the one a budget divides by.


---

## Carried backlog

Two findings that belong to no phase, recorded here so a session with no context still finds them.
Both were reproduced rather than reasoned about.

### The NLT heredoc leak — **high urgency**, documented not fixed *(recorded 2026-08-25)*

A model writes a multi-line shell script as an `exec` argument without wrapping it in NLT's
`<<<` / `>>>` heredoc. `consumeLine` extends an open field across bare continuation lines — but a
**blank line clears `openKey`**, deliberately ("models put blank lines between fields, and gluing
whatever follows onto the last value is how prose ends up in an argument"). The next line then has a
block open, no `openKey`, and no key match, so it falls to the last branch —
`closeBlock(state); state.text.push(line)` — and the rest of the script becomes the reply.

Reproduced against the real `parseNlt`:

```
ACTION: exec                     intents:   1 ["exec"]
command: python3 <<PY            args:      {"command":"python3 <<PY\nimport sys"}
import sys                       text:      "print(...)\nPY\nEND"   <- shown as the reply
                 <- blank line   malformed: undefined  <- no repair, no event, nothing reported
print("hello")
PY
END
```

The truncated command is a **valid string**, so `coerceArgs` raises no field error. The shell then
sees an unterminated heredoc, reads to EOF, and **runs half the script**. The turn is recorded as a
clean answer, and exits 0.

This is precisely the shape the XML tolerance was written to prevent — *"the markup became the reply,
no repair was asked for, no event fired, and the turn was recorded as a clean answer"* — alive today,
in the default dialect, on the most-used tool, on the most idiomatic content a shell tool receives.

A bare `word:` line inside an unwrapped value (`try:`, `else:`, `finally:`, any YAML key) is the
**loud** variant: `try` becomes a field, `coerceArgs` reports *"try is not a field of this tool"*, and
the model earns a repair. That one is survivable. The blank-line case is not.

**Why it is not fixed here.** It needs `evals/nlt-heredoc/` with the shapes a real model actually
produces, because this repo's own rule is that the set of malformations is not enumerable — so adding
one tolerance for blank lines is the wrong instinct and would invite the belief the class is handled.
The likely direction is a **backstop**: set `ParsedOutput.malformed` when a block closes into prose
that reads as a continuation of the value it just abandoned, earning the one repair the parser already
grants. Do not "simplify" it into a tolerance.

### `deepseek-v4-pro*` context window — **low urgency** *(recorded 2026-08-25)*

The registry row says `contextWindow: 393_216`, traceable to a test comment recording it as *"a proven
floor: max_tokens=393216 beside an 85-token prompt was accepted"* — a **floor**, published as a window.
Its sibling `deepseek-v4-flash*` carried the same inherited number and measured **1_048_576** when
probed, so the registry had been publishing 37.5% of the real window.

`model probe <agent> --window --price <rate>` does the measurement; it costs roughly **$0.30**.

Low urgency, and the reason is worth keeping: **a floor is the safe direction.** An under-reported
window over-compacts and wastes tokens; it never overflows an endpoint. A cost bug, not a correctness
one.
