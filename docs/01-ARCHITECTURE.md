# 01 — Architecture

## What Dispach is

A runtime layer that turns a stateless chat-completions endpoint into an agent that lives
in messaging channels, uses tools, remembers, and runs on a schedule.

**It acts on the machine it runs on.** A harness peer to OpenClaw, Hermes Agent and Claude Code runs
shell commands, reads and writes files, and does what it is asked; channels are one surface it can be
reached through, not the limit of what it does. Said positively because the sentence above was once
read as a scope fence — "lives in messaging channels" taken to mean *only* there — and an omission
that misleads a careful reader is a defect in the document, not in the reader.

The formal scope fence — an agent harness is a runtime layer with four necessary and
sufficient elements:

1. **An agent loop**
2. **A tool interface**
3. **Context management**
4. **Control mechanisms**

Anything outside those four is a plugin, not core. Use this every time scope creep argues
with you.

## What Dispach is not

Not an orchestration graph. Not a workflow engine. Not a RAG pipeline. Not a vector
database. Not a browser automator — `web_fetch` reads one page by explicit URL with no JavaScript
execution and no link-following, and a real crawl is a pinned Composio tool. Not a model gateway. Not a provisioning platform —
that's VelaOps, and the boundary is enforced in `06-VELAOPS-INTEGRATION.md`.

---

## Repository layout

Directory names contain no brand string, so a rename touches `brand.ts` and `package.json`
only.

```
dispach/
├── package.json                 # bun workspaces root
├── bunfig.toml
├── biome.json
├── tsconfig.base.json
├── CLAUDE.md                    # standing brief for coding agents
├── docs/
├── packages/
│   ├── core/                    @dispach/core
│   ├── cli/                     @dispach/cli          bin: dispach
│   ├── server/                  @dispach/server
│   ├── channel-telegram/        @dispach/channel-telegram
│   ├── channel-whatsapp/        @dispach/channel-whatsapp   (Baileys)
│   ├── tools-composio/          @dispach/tools-composio
│   ├── tools-system/            @dispach/tools-system       shell + files
│   ├── tools-web/               @dispach/tools-web          search + fetch
│   ├── tools-mcp/               @dispach/tools-mcp
│   └── compat-openclaw/         @dispach/compat-openclaw
├── examples/
│   ├── minimal/                 # smallest thing that runs: one model, no tools
│   ├── reference/               # every agent.yaml field; future phases commented with their phase
│   ├── workspace-template/      # the tiered workspace files, to copy (Phase 3.5)
│   └── telegram-assistant/      # a worked workspace (Phases 3.5 + 4)
├── docker/
│   └── Dockerfile
└── scripts/
    ├── bench-boot.ts
    └── rename-brand.ts
```

### Dependency rule

`core` depends on **nothing outside the standard library plus a YAML parser and a schema
validator**. Everything else — Composio, Baileys, MCP, Telegram — lives in a package that
depends on core, never the reverse. CI enforces this with a dependency check; a PR adding
an import to core from any sibling package fails.

---

## Core module map

```
packages/core/src/
├── brand.ts                 # the only file containing the product name
├── manifest/
│   ├── schema.ts            # zod schema for agent.yaml
│   ├── load.ts              # read + resolve refs + env expansion
│   └── validate.ts          # cross-field validation, loud failures
├── runtime/
│   ├── runtime.ts           # hosts N agents in one process
│   ├── agent.ts             # a single agent instance
│   └── lifecycle.ts         # boot sequence, readiness, shutdown
├── loop/
│   ├── turn.ts              # one inbound message → final reply
│   ├── step.ts              # one model call + tool executions
│   └── phases.ts            # phase-scoped tool visibility
├── context/
│   ├── assemble.ts          # ordered, budgeted block assembly
│   ├── budget.ts            # token accounting + pressure signal
│   ├── blocks.ts            # ContextBlock types, pin flags
│   └── compaction/
│       ├── ladder.ts        # stage selection
│       └── stages.ts        # S1..S5 implementations
├── workspace/
│   ├── load.ts              # tiered load, strips frontmatter + HTML comments
│   └── rules.ts             # imperative count vs reliability target
├── model/
│   ├── provider.ts          # ModelProvider interface
│   ├── chat-completions.ts  # the one transport (fetch + SSE)
│   ├── capabilities.ts      # shipped registry + override merge
│   ├── prompt-style.ts      # render authored markdown per capability
│   └── roles.ts             # main / selector / compactor resolution
├── tools/
│   ├── registry.ts          # pinned manifest, slug validation, budget
│   ├── trust.ts             # untrusted-observation boundary + write gate
│   ├── policy.ts            # deny → allow rules, hardline floor, authorize()
│   ├── sanitise.ts          # terminal escapes out, before model or terminal
│   ├── dialect/
│   │   ├── dialect.ts       # ToolDialect interface
│   │   ├── nlt.ts           # default
│   │   └── native.ts        # opt-in
│   ├── coerce.ts            # text → schema, with repair
│   └── execute.ts           # parallelism, timeouts, error surfaces
├── skills/
│   ├── index.ts             # frontmatter scan + cached index
│   ├── select.ts            # BM25 over descriptions, harness-side
│   ├── load.ts              # body + script registration
│   └── scripts.ts           # subprocess execution (the Python surface)
├── memory/
│   ├── retriever.ts         # Retriever interface
│   ├── fts5.ts              # the shipped implementation
│   └── writer.ts            # memory_write tool → dated markdown
├── store/
│   ├── store.ts             # Store interface
│   └── sqlite/
│       ├── driver.ts        # bun:sqlite | node:sqlite adapter
│       └── migrations/      # numbered SQL, PRAGMA user_version
├── schedule/
│   ├── scheduler.ts         # single timer, nearest-due
│   └── kinds.ts             # cron | every | at
├── channels/
│   ├── channel.ts           # transport interface + declared limits
│   ├── inbox.ts             # dedupe, allowFrom, session routing
│   ├── outbox.ts            # idempotent delivery + retry + ordering
│   └── split.ts             # chunking: graphemes, boundaries, code fences
├── plugins/
│   ├── plugin.ts            # Plugin + PluginContext
│   ├── loader.ts            # boot-time resolution, version gate
│   ├── middleware.ts        # composition
│   └── permissions.ts       # declarative vocabulary (advisory in v1)
├── team/
│   ├── handoff.ts           # typed envelope + artifact validation
│   └── supervisor.ts
├── events/
│   ├── bus.ts
│   └── types.ts             # the event schema (see 04-SPEC-WIRE.md)
└── errors.ts                # typed errors, every one with a fix hint
```

---

## Concepts

| Term | Meaning |
| --- | --- |
| **Runtime** | One process. Hosts N agents. Owns the timer, the event bus, the store. |
| **Agent** | A manifest plus its resolved plugins, tools, skills, and channels. |
| **Session** | A conversation thread, keyed `{channel}:{peerId}[:{thread}]` or an explicit key. |
| **Turn** | One inbound input → one delivered reply. Contains 1..N steps. Has an ID; reattachable. |
| **Step** | One model call plus the tool executions it triggered. |
| **Phase** | A named state carrying a tool allowlist. Default is a single phase. |
| **Skill** | An agentskills.io folder: SKILL.md plus optional scripts and resources. |
| **Plugin** | A module registering channels, providers, stores, skill sources, or middleware. |
| **Artifact** | Any large blob (tool output, file) stored outside context, referenced by pointer. |

---

## The agent loop

```
inbound event
  │
  ├─ resolve agent + session               (store)
  ├─ resolve phase                         (persisted per session)
  ├─ turn.start
  │
  ├─ ASSEMBLE CONTEXT ────────────────────── wrapContext middleware
  │
  ├─ STEP LOOP (until final, or maxSteps)
  │    ├─ model call ────────────────────── wrapModelCall middleware
  │    ├─ dialect.parse(output)
  │    │     ├─ no intents  → final answer, exit loop
  │    │     └─ intents     → continue
  │    ├─ validate + coerce intents against schemas
  │    │     └─ on failure  → one repair step with exact field errors
  │    ├─ execute tools ─────────────────── wrapToolCall middleware
  │    │     (parallel for readOnly, serial otherwise)
  │    ├─ append observations
  │    └─ compaction check → ladder if over threshold
  │
  ├─ deliver via outbox                     (idempotent)
  ├─ persist messages + tool_calls
  └─ turn.end
```

The whole turn is wrapped by `wrapTurn`. Everything is cancellable via `AbortSignal`;
cancellation is a first-class state, not an exception.

**Generation is detached from the client connection.** The turn runs to completion whether
or not anyone is listening. Clients attach and reattach to `GET /v1/agents/:id/turns/:turnId/stream`.
Partial content is persisted only on an explicit stop, never on disconnect.

---

## Context assembly

Fixed order. The prefix must be byte-stable across turns or prompt caching stops working,
and prompt caching is the largest available cost lever.

```
slot  content                                    pinned  cache          phase
────  ─────────────────────────────────────────  ──────  ─────────────  ─────
 0    system: workspace `static` tier              yes     ┐
 1    tool dialect preamble + tool catalogue       yes     │ breakpoint A
 2    this agent's own configuration               yes     ┘                4
 3    user: examples, under `examplesIn: user`     yes     byte-stable
 4    workspace `volatile` tier                    yes
 5    active skill body (0 or 1)                   no      ─ breakpoint B  5
 6    activated knowledge entries                  no
 7    rolling digest (compaction output)           no                      7
 8    recent message window                        no
 9    workspace `reminder` tier                    yes
10    retrieved memory passages (k)                no                      6
11    current input + current task line            yes
12    last error, if any                           yes
```

**Slot number equals prompt position.** The two are kept equal so this table can be read in
order; inserting a slot means renumbering, which is cheap because every reference in the tree
is by name (`SLOT.input`, never `10`). Slots for the workspace tiers, and later for examples and
knowledge, were inserted with no logic or test churn at all.

Slot 3 sits *before* the volatile tier deliberately: extracted examples are byte-stable for the
lifetime of the agent, and OpenAI-compatible prefix caching is contiguous — behind the mutating
volatile tier they would fall out of the cacheable region on every memory write despite never
changing. Slot 6 is the one workspace-derived slot that is **not pinned**: knowledge is retrieved
per turn and compaction may drop it, where it must never drop a tier.

**Slot 2 is the agent's own configuration**, injected rather than left to `config_read`. Knowing how
you are set up was otherwise a two-hop decision — realise you have a configuration, decide to read
it, then act — which is the shape decision 4.7 refuses for tool discovery and which fails here for
the same reason, only worse: a model that does not know a setting exists has no reason to go looking
for it. Asked to put itself on Telegram, an agent with `config_set` pinned, `config_set` in
`policy.allow`, and a commented-out `channels` block in its own manifest proposed a third-party
integration and then began writing a Telegram bridge. It is a *summary* — model, channels, server,
providers, permissions, roughly 200 tokens — and it names what is absent rather than omitting it,
because a missing row reads as "no such concept" where `none` reads as a switch that is off. The
full settable list with current values stays one `config_read` away: the fact is free, the detail is
asked for. Byte-stable, because configuration is fixed until restart.

Slot 0 is the workspace's `static` tier per `07-SPEC-WORKSPACE.md`. `SLOT.identity` is still its
name in code, because that is what the slot *holds* — the tier name says where the text came from,
the slot name says what it is for. A manifest still using the deprecated `context.files` lands in
the same slot, by the same path, with a warning naming `static`.

Pinned blocks survive every compaction stage. This is why anything that must always hold —
identity, guardrails, the tool catalogue — lives in slots 0/1 and never in history.
Compaction reliably eats initial instructions; the fix is structural placement, not a
stronger prompt.

The two workspace tiers are placed by different reasoning, and both are load-bearing. Slot 4
sits *after* breakpoint A because its content changes whenever the agent writes to memory, and
changing content ahead of the breakpoint invalidates the cached prefix on every write — cost
rises with no error anywhere. Slot 9 sits *after* the history because rule adherence decays
across a conversation and attention is stronger at both ends of the context than the middle, so
a rule stated once in slot 0 of a thirty-turn session is effectively in the middle of it.
Retrieved memory sits in slot 10, after the reminder and immediately before the current input:
evidence next to the question. Measured on llama3.2:3b, the same correct passage in the old
slot 7 (ahead of history) was ignored; adjacent to the question it was used.

### Budget

`budget.ts` tracks consumed tokens using the API-reported `prompt_tokens` from the previous
call as the calibration anchor, with a local estimator between calls. The estimator is
allowed to be approximate; the anchor corrects drift each turn.

Configured as fractions of the model's window:

```yaml
context:
  window: 32768          # or inferred from capabilities
  reserveOutput: 4096
  observationMaxTokens: 2000
  thresholds: { trim: 0.60, snip: 0.70, micro: 0.80, collapse: 0.88, reset: 0.95 }
```

---

## Compaction ladder

Progressive, five stages, each strictly more aggressive. Never a single lossy summarise-at-95%.

| Stage | Trigger | Action | Loss |
| --- | --- | --- | --- |
| **S0 observe** | every step | record usage, emit `context.pressure` | none |
| **S1 trim** | 0.60 | any single observation over `observationMaxTokens` → head+tail excerpt, full body written to `.dispach/artifacts/<id>`, replaced by a pointer the agent can re-read | recoverable |
| **S2 snip** | 0.70 | drop superseded observations — same `tool + argsHash`, keep only the latest | low |
| **S3 micro** | 0.80 | summarise the oldest N turn-pairs into a digest delta using the `compactor` model | moderate |
| **S4 collapse** | 0.88 | replace all but the last K turns with the digest plus pinned blocks | high |
| **S5 reset** | 0.95 | pinned blocks plus digest only; emit `context.reset` at warn level | severe |

Every stage emits `compaction.stage` with before/after token counts. If S5 fires more than
once per session, that's a manifest misconfiguration and the event says so.

---

## Tool layer

### Resolution

Tools are resolved **at agent load**, not per turn:

1. Read `tools.pinned` and `tools.local` from the manifest.
2. Ask the local provider first, then each provider in `tools.providers` — a map, in the order it
   was written — to resolve each slug to a schema. Two providers claiming one slug is a load
   failure: a slug is how the model names a tool, so one name cannot mean two things. The local
   provider is the single exception, and it is a precedence rule rather than a collision: it is
   consulted first and cannot be shadowed, and `tools.local` is never sent to a remote provider.
3. **Fail loudly on any unknown slug.** Never silently drop. The failure names the slug, the
   providers actually consulted, the manifest field, and the nearest available match.
4. Enforce `budget.max` (default 24) with `budget.reserveWrite` (default 6) held for
   tools annotated as mutating.
5. Cache resolved schemas to `.dispach/tools.cache.json`; refresh asynchronously after ready.

The two budget rules read as one and are different in kind. Pinning **more slugs than the cap** is a
configuration error — the manifest asked for something arithmetically impossible, and only its author
can say what to give up, so it is refused before any provider is consulted. Resolution **expanding
past the cap**, one toolkit slug yielding thirty tools, is a runtime fact: that trims, holding
`reserveWrite` slots so a large read surface cannot starve the writes, and reports what it dropped as
a warning. The reservation is a floor, not a ceiling — with only write tools resolved they take the
whole budget.

Catalogue order is manifest order, because manifest order is trim priority.

### Phases

```yaml
phases:
  default: { allow: ["*"] }
  triage:  { allow: ["tag:read"] }
  act:     { allow: ["tag:read", "tag:write"] }
```

Only tools visible in the current phase enter the catalogue block. Transition via the
built-in `phase_set` tool, exposed only when more than one phase is declared. This is the
single highest-leverage knob for small-model reliability.

### Dialects

```ts
interface StepOutput {
  text: string
  calls: readonly ToolCallRequest[]     // always empty under a text dialect
}

interface ToolDialect {
  id: "nlt" | "native"
  renderCatalogue(specs: readonly ToolSpec[]): readonly ContextBlock[]
  requestTools(specs: readonly ToolSpec[]): readonly ToolDefinition[] | undefined
  parse(output: StepOutput): { intents: readonly ToolIntent[]; text: string; malformed?: readonly FieldError[] }
  createStreamFilter(): StreamFilter
  renderCall(output: StepOutput): ChatMessage
  renderObservation(results: readonly ToolResult[]): readonly ChatMessage[]
  renderRepair(errors: readonly FieldError[], output: StepOutput): readonly ChatMessage[]
}
```

**A dialect receives both halves of what a step produced**, because which half carries the protocol is
the dialect's decision rather than the loop's. Under NLT the call *is* text and `calls` is empty; under
`native` the call is in `calls` and the text is only prose. `parseNlt` keeps its `string` signature —
it is a text parser and giving it the envelope would imply it might read the other half.

NLT's parser is deliberately **schema-free**: it reports what was written verbatim and `coerce.ts`
alone decides what that means for a given tool, which is why a field-matching change cannot break block
detection. `malformed` exists because `native` has a failure NLT does not — a truncated `arguments`
document is not JSON and no tolerance recovers it. It is reported as unreadable rather than as an empty
argument set, because a tool with no required fields would otherwise *run*, with no arguments, having
been asked for something else.

The three render methods return lists and take the step's output for one forced reason: `native`
requires one `tool` message per call, each naming the id it answers, and an assistant turn whose
`tool_calls` were not all answered is rejected outright. `renderRepair` is driven by `output.calls`
rather than by the parsed intents, since the call whose arguments would not parse never became an
intent — and that is precisely the one a repair is usually about.

`renderObservation` under NLT returns exactly one message however many results there were: one per
result would repeat the "continue or reply" instruction after every observation. Under `native` that
instruction is omitted entirely, because the protocol itself says an assistant turn follows the tool
messages.

### Streaming a dialect that lives in the text

With a line-oriented dialect the invocation *is* the reply text, so a consumer that prints
`model.chunk` deltas as they arrive shows `ACTION:` and `END` to the person and runs them into the
answer that follows. Every streaming surface has this problem — the CLI, the server's SSE clients, a
TUI — so the dialect supplies the fix:

```ts
interface StreamFilter {
  push(delta: string): string   // text safe to show now
  endStep(): string             // a step ended; the next is about to start
  end(): string                 // the turn is over
}
```

Three properties make it correct rather than approximate:

- **It is the same grammar as `parse`.** Both drive one line-at-a-time consumer. A separate
  classifier for display would be a second parser, and a second parser drifts — the version deciding
  what the person sees would eventually disagree with the version deciding what runs. The property is
  asserted directly: a filtered stream equals `parse().text`, at every chunk size.
- **It waits only where it must.** A partial line is held while it could still become `ACTION:` or a
  fence — at most six characters — and never mid-line. A reply is usually one long line, so
  line-buffering would have made streaming decorative.
- **`endStep` owns the paragraph break between steps.** A step's output ends without a newline, so a
  filter carried straight across the boundary glues the next step's first word onto this one's `END`;
  and the loop joins each step's trimmed prose with a blank line. Both belong to the dialect, or every
  consumer reinvents them and they disagree.

Trailing whitespace is held rather than emitted, because `parse` trims the finished reply and a stream
cannot un-emit. What is still held at the end was trailing after all, and is dropped.

**NLT** is the default. The catalogue renders as prose, not JSON schema:

```
### send_email
Sends an email from the owner's connected mailbox.
Use when: the user asks you to email or reply to someone.
Do NOT use when: the user only wants a draft, or has not named a recipient.
Fields:
  to       (required) recipient address
  subject  (required)
  body     (required) plain text
```

The `Do NOT use when` line is required by the skill/tool template — negative examples are
the cheapest available routing-accuracy improvement.

Invocation format is line-oriented, which small models produce far more reliably than
nested JSON:

```
ACTION: send_email
to: moeen@example.com
subject: Weekly report
body: <<<
Numbers are attached.
Second line.
>>>
END
```

Multiple `ACTION` blocks per output are permitted. Text outside blocks is the reply.

The parser is deliberately tolerant — case-insensitive keyword and keys, whitespace trimmed, bullet
and numbered prefixes accepted, `END` optional, a wrapping code fence ignored — then coerces to the
JSON Schema (string → number/boolean/array) and validates. Every accepted variant is one that arrives
in practice, and refusing it would spend a repair step on punctuation rather than on meaning.

Three things it will *not* do, each a failure seen in a real transcript:

- A line merely *containing* `>>>` is heredoc content; only a line that is exactly `>>>` closes one.
- Prose after a blank line inside an unterminated block is the reply, not a continuation of the last
  field. Gluing it on is how a sentence meant for a person ends up as a tool argument.
- A fence is dropped only when it wraps a block. A fence anywhere else is the model writing markdown
  at the person, and eating it would mangle their reply.

On validation failure it emits **one** repair step quoting exact field errors, then gives up and
surfaces an honest error rather than looping. Two failures in a row is a catalogue problem rather than
a model problem, and asking a third time spends the step budget producing the same broken block.

A step is **all-or-nothing**. If any block in it cannot be used, none of them run: the repair asks the
model to rewrite the whole step, and a mutating call that had already succeeded would then happen a
second time. There is no idempotency key available at this layer to make the alternative safe.

**native** uses the provider's `tools` parameter and `tool_calls` response. Opt-in only.
Note that Anthropic's compat endpoint ignores `strict`, so schema conformance is not
guaranteed there even in native mode — the coercion layer runs regardless.

Four things about native are easy to get wrong, and three of them fail silently:

- **`function.description` carries the same guidance as the NLT catalogue entry** — summary,
  `Use when`, `Do NOT use when`, and the state-change warning. Setting it to `spec.summary` is the
  obvious implementation and it rigs the eval: the comparison would be measuring the guidance.
  Asserted by a test in `native.test.ts`.
- **Messages need an explicit wire mapping.** The request body was built with `messages:
  request.messages`, correct only while a message was exactly `{role, content}` — both already wire
  names. A camelCase `toolCalls` reaching the endpoint is a field it has never heard of: the request
  succeeds, the model never sees the call it made, and the agent repeats itself with no error anywhere.
- **The store must persist the call ids.** Migration 2 adds `tool_calls` and `tool_call_id` to
  `messages`. Without them a resumed native session reads back an assistant turn with empty content
  and no calls, and a `tool` message answering nothing — a 400 from a strict endpoint, and a silently
  confused model on a lenient one. Measured: qwen3.5:9b via Ollama accepted the orphaned trace.
- **The catalogue is invisible to the context budget.** It travels in the request body, so slot 1 is
  empty and `assembleContext` cannot see the cost. `ToolRuntime.wireTokens` is subtracted from the
  window, and `describe().catalogueTokens` includes it — otherwise a native catalogue reports as free.

A slug outside `[A-Za-z0-9_-]{1,64}` cannot be a native function name and is **refused at load**
naming the slug and the provider. `gmail.send` is legal under NLT and illegal here; rewriting it is
lossy in both directions, so the loop would have to guess which tool a reply meant.

### The web tools

`@dispach/tools-web` ships `web_search` (one signature over Tavily, Brave or Exa) and `web_fetch`
(one GET, extracted to text). Both read-only, both `trust: "untrusted"` by declaration.

The fetching is a GET; the substance is `address.ts` and `guard.ts`, which decide what the agent may
point one at. Scheme, then credentials, then the hostname's own shape, then DNS, then **every**
address DNS returned — Node connects to whichever answers first, so checking one of several checks an
address the request may not use. Loopback, link-local, RFC-1918, CGNAT, unspecified, multicast and
reserved are refused; `169.254.169.254` is covered by a range rather than a special case. IPv4-in-IPv6
decodes first, and only one spelling of a dotted quad is a literal — a parser accepting more forms
than the checker understands is the bypass. Every redirect hop is re-checked, which is why redirects
are followed by hand.

There is deliberately **no setting that permits a private address**. The one real use of such a flag
is reaching the local network, and the honest way to do that is `exec` with `curl`.

Two limits are stated rather than assumed. **DNS rebinding is not covered**: the guard's lookup and
the client's connection are separate resolutions, and pinning the checked address into the socket is
not expressible through `fetch`. And **none of it binds `exec`** — a policy that allows the shell
allows `curl`. These controls bound the tool, not the agent.

`maxBytes` is enforced while reading rather than after, because `await response.text()` on a 50 MB
page has already spent the 50 MB by the time anything can measure it.

---

## Model layer

```ts
interface ModelProvider {
  id: string
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>
}
```

One implementation: `chat-completions.ts`. Hand-rolled `fetch`, manual SSE parsing, no SDK,
no gateway.

### Capabilities

A shipped registry keyed by model-id glob, merged with any manifest override:

```ts
interface ModelCapabilities {
  nativeTools: boolean
  strictSchema: boolean
  thinking: "none" | "anthropic" | "openai" | "deepseek"
  promptCache: "none" | "anthropic" | "openai"
  parallelToolCalls: boolean
  contextWindow: number
  maxOutput: number
}
```

Capabilities affect **only** thinking-block replay and cache-breakpoint placement. They
never change the tool dialect — that is config, so behaviour cannot drift when the model
changes.

Thinking-block handling matters, and it is not uniform. With `thinking: "anthropic"` the blocks
must be replayed alongside tool results or multi-step reasoning silently degrades. With
`thinking: "deepseek"` reasoning arrives as `reasoning_content` beside `content` and is **not**
replayed — sending it back is accepted and confers nothing. `openai` reasoning is opaque and
server-side. The loop follows the capability rather than a single rule, which is why this is a
four-valued field and not a boolean.

A `deepseek` model also bills reasoning tokens to the **output** budget, so an allowance that
does not cover the thinking returns empty content with `finish_reason: "length"`. The loop
treats that as a failed turn — code `empty_reply_output_exhausted`, naming
`context.reserveOutput` — because an empty reply reported as success is the precise shape of
failure the error philosophy below exists to prevent.

### Roles

`main`, `selector`, `compactor`. Selector and compactor fall back to main. Pointing
selector and compactor at a cheap 3B model while main is a larger one is the intended
production configuration and typically the largest cost win available.

---

## Storage

```ts
interface Store {
  sessions: SessionStore     // Phase 2
  messages: MessageStore     // Phase 2
  turns: TurnStore           // Phase 2
  kv: KVStore                // Phase 2
  toolCalls: ToolCallStore   // Phase 3
  artifacts: ArtifactStore   // Phase 7
  schedules: ScheduleStore   // Phase 8
  location: string
  close(): Promise<void>
}
```

Sub-stores land with their subsystems rather than as stubs. An empty implementation is
indistinguishable from a working one at the type level, which is exactly how a later phase
ships a silent no-op.

**Every method is async** even though SQLite is synchronous. The driver returns resolved
promises and pays an allocation per call; that buys the ability to add the deferred Postgres
driver as a new file rather than as a rewrite of every call site.

Default driver is SQLite. `sqlite/driver.ts` picks `bun:sqlite` or `node:sqlite` — the only
runtime-conditional code in the tree. Migrations are numbered, inline, and gated on
`PRAGMA user_version`; each runs in its own transaction that also bumps the counter, so a
crash leaves the schema at the last fully-applied version rather than halfway through one.

The two bindings differ in six ways that all produce the same class of bug — green under one
runner, wrong under the other. The adapter normalises all six rather than passing them
through, and `PRAGMA foreign_keys` is the one that matters most: **off** by default in
`bun:sqlite` and **on** in `node:sqlite`, so `ON DELETE CASCADE` would silently do nothing
under Bun. The same test suite runs under `bun test` and `node --test` because that is the
only thing that actually demonstrates the adapter works.

**Persistence is opt-in.** `Runtime` defaults to `:memory:`; the CLI passes a file path.
A library that creates a directory in the caller's working directory as a side effect of
construction is badly behaved, and `store.ready` reports `location` either way so which one
is in use is observable rather than assumed. The database location is a `Runtime` option, not
a manifest field — one process hosts N agents from N manifests but has exactly one store.

**Canonicality split:**

- **Files**: manifest, context markdown, skills, memory markdown, artifacts
- **SQLite**: sessions, messages, turns, tool_calls, schedules, phase state, kv, outbox

**Turn durability.** The turn row is written `running` *before* the first model call, so a
turn is durable from the moment it starts rather than the moment it finishes — which is what
lets a crash be distinguished from a turn that never began. A process that dies mid-generation
leaves the row `running`; the next boot marks those `error` with code `turn_abandoned` and
reports them on `store.ready` rather than fixing them quietly. Nothing resumes them: the model
stream that was being read is gone.

A turn record is the audit trail and records every outcome including failures and their hints.
The message history is the conversation, and gets nothing on a failed turn — a half-answer left
in history is a half-answer the next turn is conditioned on. An explicit stop is different: it
persists the partial content, because someone decided to stop it.

---

## Memory

```ts
interface Retriever {
  search(query: string, opts: { k: number; filters?: Filters }): Promise<Passage[]>
  index(doc: MemoryDoc): Promise<void>
}
```

Shipped implementation is SQLite FTS5 over memory markdown plus message history, ranked by
BM25 with a recency boost. The index is maintained incrementally on write and rebuilt when
directory mtime disagrees with the cache.

The agent writes memory through a built-in `memory_write` tool that appends to
`memory/YYYY-MM-DD.md`. The agent is the author; the harness is the librarian.

---

## Skills

**Boot**: read frontmatter only, cache to `<stateDir>/skills.idx.json` keyed by each file's
mtime and size. Bodies are never read at boot. The spec's fields are `name`, `description`,
`license`, `compatibility`, `metadata` and `allowed-tools`; negative guidance lives under
`metadata` because the spec defines no field for it (decision 6.3). Unknown keys are kept and
ignored — a third-party file must survive a spec that grows.

**Selection**: harness-side BM25 over name, description and when-not-to-use, against the
turn input and the previous assistant turn. Score threshold; at most one active skill per
turn by default (`skills.maxActive`). BM25 is a **scorer, not an index** — the ranking seam
and the take-what-fits walk are shared with Tier 3 knowledge, which is what keeps Phase 6
from having two indexes to attach a retriever to (decision 11.44).

**Injection**: the full SKILL.md body enters `SLOT.skill`, referenced by name — the number
has moved once already, when `examples` and `knowledge` were inserted. Its role is
`promptStyle.skillsIn`.

**Scripts**: a skill may ship `scripts/`. Those register as tools named
`skill.<skill>.<script>`, visible **only while the skill is active** — rendered at the end of
the skill's own block, never in the slot-1 catalogue, which is rendered once at load and must
stay byte-identical or prompt caching silently stops. Interpreter selection is a pure
function in core; the subprocess belongs to `tools-system`, which owns the process-group,
concurrency-cap and reaping rules (decisions 6.5, 6.6):

- `pyproject.toml` or `requirements.txt` present → `uv run <script>`
- else `.py` → `python3 <script>`
- else `.ts`/`.js` → the host runtime
- else executable bit → direct exec

If a skill declares a Python script and no Python runtime exists, the skill **fails at
load** with a named error. It does not fail silently at use time.

`allowed-tools` is parsed and displayed and **never honoured** — a downloaded folder does not
widen what the agent may run (decision 11.45).

---

## Multi-agent

One supervisor, typed handoffs, no free-form chat.

```ts
interface HandoffRequest {
  to: string
  task: string
  inputs: Record<string, unknown>
  expect: JSONSchema
  budget: { maxSteps: number; maxTokens: number }
}
```

The sub-agent runs in an isolated session with its own context budget and phase set, and
returns an artifact validated against `expect`. **The parent sees the artifact, never the
sub-agent's transcript** — context isolation is the entire point and is why subagents cost
substantially fewer tokens than the equivalent in-context skill in multi-domain work.

Handoff failure is a typed result, not an exception. The supervisor decides whether to
retry, reassign, or surface it.

---

## CLI

Eleven commands and three renderers. One module per command, and the interesting logic in each
lives in a pure module beside it rather than in the command.

```
packages/cli/src/
  index.ts          parse → dispatch → exit. Imports no Ink and no React.
  lib/              plumbing, one concern per file
    commands.ts       the command, arg and flag table — data only
    args.ts           pure parser
    help.ts           help rendered from the table, actions included
    output.ts         resolveMode(): json | plain | rich
    render.ts         the PLAIN path's vocabulary: keyValue, bytes, duration (pure)
    theme.ts          the RICH path's: colour tokens and glyphs (pure)
    env.ts            every environment read
    ambient.ts        which .env wins
    sandbox.ts        ~/<stateDir>: discovery, ref resolution, the store path
    exit.ts           the single teardown, and who owns SIGTERM
    providers.ts      which tool providers and channels this binary can supply
    launchd.ts        plist rendering and launchctl parsing (pure)
    daemon-plan.ts    preflight findings and status verdicts (pure)
    service.ts        the service-manager seam — the only subprocess in the package
    init-flow.ts wizard.ts select.ts session-commands.ts templates.ts
    const.ts types.ts schema.ts wrap.ts
  transcript.ts     pure AnyEvent → TranscriptState reducer
  keymap.ts         pure key → intent
  editor.ts         pure intent → input line
  init.ts run.ts sessions.ts validate.ts workspace.ts soul.ts
  agents.ts tools.ts serve.ts daemon.ts       one module per command
  components/       App, Transcript, Live, StatusBar, Prompt, Picker, WizardApp, the kit
  hooks/            useTurn, useTerminalSize, useElapsed
```

**`serve` and `daemon` are the long-running half.** `serve` is the only command that binds a socket
or starts a channel; `daemon` installs it as a macOS LaunchAgent so it outlives its terminal. A
runtime lease in the store — one row per agent id, claimed before channels start — is what stops
two processes serving one agent, which the transport cannot detect for itself: a second Telegram
poller produces 409s indistinguishable from the outage the poll loop is built to survive, and
webhook mode produces no signal at all.

**Mode is resolved once**, ordered and total, and reports its reason. `json` is a single document on
stdout; `plain` is line-oriented with no ANSI and no cursor movement; `rich` is the Ink app. A
one-shot `--input` is always plain, so a scripted turn does not depend on whether a human was
watching. `--plain` at a terminal produces exactly what a pipe produces, which is why the terminal
restore fires only when the rich path has actually dirtied the terminal.

**Ink loads lazily.** Importing `react` + `ink` costs ~65 ms under Bun and ~170-210 ms under Node,
against ~70 ms for all of `validate --json`. The renderer sits behind a dynamic `import()` reached
only on the rich path, the build keeps it in a separate chunk, and a structural test fails if a
static import appears on a shared path. Verified by deleting `ink` from `node_modules`: every
non-rich command still exits 0.

**`<Static>` is load-bearing.** Ink erases and redraws its whole *dynamic* tree every frame, so a
transcript in that tree would be redrawn on every streamed token — flicker, CPU, and destroyed
scrollback on a long session. Finished items live in `<Static>`, written once and never touched
again; only the in-flight reply is dynamic, and it is capped in terminal *rows* (not lines, since one
long paragraph is many rows). Two consequences: transcript items must be append-only and immutable,
because mutating one changes something the renderer will never look at again, and their keys come
from a counter in the reducer rather than from an array index.

**The interesting logic is pure.** `transcript.ts`, `keymap.ts`, `editor.ts` and `lib/wrap.ts` import
no renderer, no clock and no `process`, so "what does the reader see when a turn errors mid-stream"
is a unit test rather than something reproduced by hand against a live endpoint. The reducer takes
its durations from `turn.end`, which is why it needs no clock; the one clock in the view layer is
`useElapsed`, whose entire job is to distinguish a slow model from a hung one.

**Ctrl-C cancels the turn, not the process** — the contract Phase 1 measured. `keymap.ts` owns the
decision so it can be tested in both states, and Ink's `exitOnCtrlC` is disabled because its default
would silently undo it.

---

## Boot sequence and budget

**Target: process start → `runtime.ready` in under 1000 ms.** CI fails a PR above 1200 ms.
Measured for one agent, three plugins, twenty skills, on 2 vCPU.

```
1. parse argv / read env                            ~0ms
2. read + validate manifest (zod)                   <10ms
3. open SQLite, run pending migrations              <20ms
4. import plugins, run setup()                      <200ms budget, warned per plugin
5. load skill index from cache (mtime check)        <10ms
6. load tool schemas from cache                     <10ms
7. register channels (construct only, no connect)   <5ms
8. emit runtime.ready ────────────────────────────── READY
9. (async) channels connect, status via events
10.(async) tool schema refresh, skill index rebuild
```

**Hard rules:**

- **No network I/O before step 8.** This is the single rule that separates Dispach from
  OpenClaw, whose gateway blocks roughly four minutes on hook handlers making network calls
  during initialization.
- No filesystem walk deeper than the skills directory, and only frontmatter is read.
- No plugin may `await` a network call in `setup()`. The loader times each one and warns
  past 200 ms.
- Channel connection failure does not block readiness. It is reported as `agent.channel.error`.

`scripts/bench-boot.ts` runs in CI and prints the breakdown per step, so a regression names
its own cause.

---

## Error philosophy

Every error in `errors.ts` is typed and carries a `hint` field naming the likely fix.
Modelled directly on the VelaOps gotcha corpus, where the expensive part was almost never
the failure — it was that the failure didn't say what was wrong.

Specifically:

- Config validation failures name the **field path** and the **expected shape**.
- Unknown tool slugs name the slug and the provider that rejected it.
- Plugin version mismatch names both versions and the required range.
- A skill with a missing runtime names the runtime and the skill.
- Nothing fails silently and exits 0. Ever.
