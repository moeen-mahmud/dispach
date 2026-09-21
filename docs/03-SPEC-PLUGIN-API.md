# 03 — Plugin API Specification

Plugins are how Dispach varies. Core ships the loop, the context manager, the SQLite
store, and the chat-completions transport; every channel, tool provider, alternative store,
skill source, and cross-cutting behaviour arrives as a plugin — including the first-party
ones. If a first-party package needs something the plugin API can't express, the API is
wrong and gets fixed. No private back doors.

---

## The contract

```ts
import type { Plugin, PluginContext } from "@dispach/core"

export default {
  name: "telegram",
  version: "0.1.0",
  dispachApi: "^0.1",
  permissions: [
    { kind: "network", hosts: ["api.telegram.org"] },
    { kind: "env", vars: ["TELEGRAM_BOT_TOKEN"] },
  ],
  configSchema: TelegramConfig,          // zod schema, optional
  async setup(ctx) {
    // `(id, factory)`, not an object. The id is the `type` a manifest's `channels[]` entry names.
    ctx.defineChannel("telegram", (channel) => new TelegramTransport(channel))
  },
} satisfies Plugin
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Unique within a runtime. Collision is a load failure. |
| `version` | yes | Semver. Reported in `plugin.loaded` events. |
| `dispachApi` | yes | Semver **range**. Host refuses to load on mismatch, naming both versions and the range. |
| `permissions` | no | Declarative. Advisory in v1 — recorded, surfaced, unenforced. |
| `configSchema` | no | Zod schema. Manifest `config` is validated against it before `setup` runs. |
| `setup` | yes | Runs once at boot. **Must not await network I/O.** |

### The setup contract

`setup()` registers capabilities. It does not do work.

- Budget: **200 ms**. The loader times each plugin and emits `plugin.slow` past the budget.
- No network calls. Connect in the channel's `start()`, which runs after readiness.
- No filesystem walks beyond your own package.
- Throwing fails the agent load with your plugin named. That is the correct behaviour for
  a genuine misconfiguration and the wrong behaviour for a transient failure — do not
  throw on anything you could retry later.

---

## PluginContext

**Built in Phase 9A** — the shipped surface, and the whole of it:

```ts
interface PluginContext {
  // registration
  defineChannel(id: string, factory: ChannelFactory): void
  defineToolProvider(id: string, factory: ToolProviderFactory): void
  defineScriptRunner(runner: ScriptRunner): void
  use(middleware: Middleware): void          // Phase 9B

  // ambient
  readonly config: unknown          // validated against configSchema
  readonly agentId: string
  readonly paths: { workspace: string; state: string; manifest: string }
  readonly env: EnvSource            // the manifest's .env over the ambient one, as core resolved it
  readonly logger: Logger
  readonly events: Pick<EventBus, "on">   // subscribe only; emit is core's
}
```

Two departures from the shape this document first described, both deliberate.

**`define*` takes an id and a factory rather than a spec object.** The id is what a manifest
*selects* — `tools.provider` names a provider id, a `channels[]` entry names a `type` — so
registration and selection are the same namespace, and naming a plugin stays separate from granting
what it offers. The factory is what already existed: `ChannelFactory` and `ToolProviderFactory` are
the seams `Runtime.create` has taken since Phase 3, and a plugin registering one means core's wiring
did not change at all. A spec object would have been a second description of the same thing.

**`defineScriptRunner` is unkeyed**, because there is nothing for a manifest to choose between: a
process can be started or cannot. Last registration wins.

`brand` is not exposed. Nothing needed it, and hard rule 3 makes a brand string in a plugin a
liability rather than a convenience.

### Not built yet

| Point | Status |
| --- | --- |
| `defineModelProvider` | Deferred. The chat-completions transport is the only one, and a second implementation is what would tell us what the seam needs. |
| `defineStore` | Deferred with the Postgres driver (open item O.5). The `Store` interface exists; nothing has needed to register one. |
| `defineSkillSource` | Deferred. Skill sources resolve through `lib/sources.ts` in the CLI, which is a fetch a person triggers rather than something an agent boots with. |
| `defineTools` | Deferred. `tools.local` covers the built-ins and a plugin wanting to add tools registers a provider, which is the same capability with a name a manifest can select. |

Each is absent rather than stubbed. A `define*` that records something nothing reads is the shape
this repo keeps finding — declared vocabulary with no consumer — and it reads to an author as a
capability that exists.

---

## Resolution

A `plugins:` entry resolves in one of two ways, and never by installing anything (hard rule 5).

1. **A built-in registry, keyed by the specifier a manifest writes.** `@dispach/channel-telegram`
   resolves to the copy the host already bundles, with no import at all.
2. **A module import** for anything else — a relative path, resolved against the *manifest's*
   directory rather than the working directory, or a package name resolved from beside the agent.

The registry is not an optimisation. A module imported both statically and dynamically makes
`bun build --splitting` emit its exports twice and the bundle stops parsing — `SyntaxError:
Duplicate export`, which `bun test` walks straight past because tests import source and the failure
is in the bundle. The CLI statically imports the first-party packages to register them, so a loader
that also `import()`ed them by name would produce a binary that fails to start. The registry keeps
each module imported exactly one way.

**Any surface that pre-loads a manifest must do the same two passes, and for three phases one of
them did not.** `Runtime.create` has always been right — plugins, then `loadManifest` with
`knownChannels: Object.keys(supply.channels)`. Every CLI command pre-loads a manifest of its own
first, and `serve` did that against the binary's static channel table: so a manifest naming a
plugin-supplied channel was refused with `channel_type_unknown` *before the plugin that would have
satisfied it was imported*, and `defineChannel` — documented here, implemented, conformance-tested
— did not work through the binary at all. Fixed in 0.1.1 for `serve` and `validate`, the two that
host and check channels.

It stayed invisible because `telegram` reaches the runtime as `channels: { telegram }` from the
CLI's own table and never through the plugin path, so this page's central registration function had
**no in-tree consumer**. `packages/cli/test/serve.test.ts` is now that consumer: a two-field plugin
defining one channel, loaded by the real binary. A public API with no caller is a public API that is
wrong for as long as it has none.

Loading happens **once per agent**, before that agent's manifest is validated. That ordering is
forced: `loadManifest` checks `tools.provider` and a channel `type` against the ids the host can
supply, and once plugins exist half of those ids come from the manifest itself. The refs are read
from a shallow header parse, which needs no credentials and expands no environment — a plugin spec
is a package name, never a secret.

---

## Extension points

### Channel

```ts
interface ChannelSpec {
  type: string
  configSchema?: ZodSchema
  create(config: unknown, ctx: ChannelContext): Channel
}

interface Channel {
  readonly id: string
  readonly capabilities: ChannelCapabilities
  start(): Promise<void>
  stop(): Promise<void>
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>
  setTyping?(peerId: string, on: boolean): Promise<void>
}

interface ChannelCapabilities {
  typingIndicator: boolean
  markdown: "none" | "basic" | "full"
  attachments: boolean
  maxMessageLength: number
  edits: boolean
}
```

Inbound arrives by calling `ctx.inbound(event)`:

```ts
interface InboundEvent {
  channelId: string
  peerId: string          // stable per-user identifier
  threadId?: string
  text: string
  attachments?: Attachment[]
  providerMessageId: string
  raw: unknown            // preserved for debugging; never enters context
}
```

**Rules for channel authors:**

- `start()` may take as long as it needs. It runs after readiness, and failure is reported
  as `agent.channel.error` rather than blocking boot.
- `send()` must be idempotent given the same `idempotencyKey` — the outbox retries.
- Chunk long messages against `maxMessageLength` yourself and return the last message id.
- Never throw from an inbound handler. Report and drop.
- `allowFrom` filtering is applied by core before your handler is invoked. It is
  **inbound-only** and confers nothing on outbound delivery.

### Tool provider

```ts
interface ToolProviderSpec {
  id: string
  configSchema?: ZodSchema
  create(config: unknown, ctx: ProviderContext): ToolProvider
}

interface ToolProvider {
  resolve(slugs: string[]): Promise<ToolSpec[]>       // omits what it does not own; never throws for that
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  explainUnresolved?(slugs: string[]): ConfigError | undefined
  search?(query: string, k: number): Promise<ToolSpec[]>
}

interface ToolSpec {
  slug: string
  description: string
  whenToUse: string
  whenNotToUse: string          // required — negative examples improve routing materially
  schema: JSONSchema
  tags: string[]                // "read" | "write" | custom; drives phases and write quota
  mutating: boolean             // counts against reserveWrite; never parallelised
}
```

**An unknown slug must fail the load, naming it — but `resolve()` is not where that happens.**
Silently dropping dead slugs is the exact failure that starves write tools and produces "tool not
found" at runtime instead of at load, so the registry diffs what came back against what was asked
for and fails on the difference, naming every missing slug at once with the nearest match.

`resolve()` therefore **omits** a slug it does not own rather than throwing. It has to: the registry
hands every provider the whole pinned list, so a remote provider is routinely asked about slugs a
local one owns. Throwing there refuses a manifest in which nothing is actually wrong.

`explainUnresolved()` is the seam for a provider that knows something the registry cannot — that its
cache is cold, say, rather than that the slug is a typo. It is consulted **only** once a slug is
still missing after every provider has answered, and returning `undefined` falls through to the
generic nearest-match failure. Return a reason only while it is the better explanation: a provider
that blames its cache forever turns every future typo into a misleading message.

`whenNotToUse` is not optional. If you have nothing to say, say what the adjacent tool is
for instead.

### Model provider

```ts
interface ModelProviderSpec {
  id: string
  create(config: unknown): ModelProvider
}
```

Core ships `chat-completions`. Implement this only for a genuinely different wire protocol
(a native Messages-API adapter, a local in-process runner). Not for a different vendor —
that's a base URL.

### Store driver

```ts
interface StoreSpec {
  id: string
  create(config: unknown): Promise<Store>
}
```

Core ships `sqlite`. A Postgres driver is the expected second implementation. The interface
lives in `store/store.ts` and is deliberately narrow — no query builder, no ORM, no
transactions spanning subsystems.

### Skill source

```ts
interface SkillSourceSpec {
  id: string
  list(): Promise<SkillMeta[]>              // frontmatter only — called at boot
  load(id: string): Promise<SkillBody>      // called on activation
}
```

`list()` runs inside the boot budget. Cache aggressively; a network-backed skill source
must serve `list()` from a local cache and refresh after readiness.

### Local tools

```ts
interface LocalTool {
  slug: string
  description: string
  whenToUse: string
  whenNotToUse: string
  schema: JSONSchema
  tags: string[]
  mutating: boolean
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}
```

In-process functions. Same catalogue, same budget, same phase rules as provider tools.

---

## Middleware

Built in Phase 9B, and **no first-party plugin uses it.** Recorded rather than left to be
discovered: this runtime's own name for a declaration with no consumer is the `includeHistory`
shape, and the cost of one is that its types assert a contract nothing has ever exercised. The four
wrap points are covered by tests in `packages/core`; what has no in-tree caller is a *plugin* that
registers one, which is the same gap `defineChannel` had until 0.1.1 and which was worth exactly one
sentence then too.

The wrapping shape, not before/after events. Wrapping permits retry, substitution, and
short-circuit; events permit only observation. Events are derived from the wrap points, so
nothing is lost by choosing wrapping.

```ts
interface Middleware {
  name: string
  wrapTurn?(ctx, next: () => Promise<TurnMiddlewareResult>): Promise<TurnMiddlewareResult>
  wrapContext?(ctx, next: () => Promise<readonly ContextBlock[]>): Promise<readonly ContextBlock[]>
  wrapModelCall?(ctx, next: () => Promise<StepResult>): Promise<StepResult>
  wrapToolCall?(ctx, next: () => Promise<ToolResult>): Promise<ToolResult>
  onEvent?(event: AnyEvent): void
}
```

Three departures from the shape first sketched here, each found by building it.

**`wrapModelCall` wraps a step, not an `AsyncIterable<ChatChunk>`.** A stream that has already been
partially consumed cannot be replayed, so a middleware over the chunk stream could observe a 429 and
do nothing about it — the canonical use would have been unimplementable. `next()` re-runs the whole
request. The cost, stated: a middleware here cannot transform individual deltas, so a redaction
belongs in `wrapContext`, before the prompt is sent, which is the only place one is reliable anyway.

**`wrapTurn` returns `{text, reason, steps}`, not a whole `TurnResult`.** A short-circuited turn ran
nothing, so it appended nothing and spent nothing; letting a plugin fabricate the rest would put
invented token counts and message lists in the store.

**`wrapContext` returns blocks and core re-derives the rest** — and recomputes every block's token
count from its content rather than trusting what came back. A middleware that rewrites content and
leaves the count alone is the obvious mistake, and its consequence is invisible: the budget, the
pressure gauge and every compaction decision downstream would be arithmetic on a number that stopped
being true.

### Where the seams sit, and the safety property

`wrapToolCall` wraps the **policy decision as well as the execution**. So a middleware that
short-circuits *refuses* a call and can never grant one, because granting means calling `next()` and
`next()` is the policy engine. An approval middleware can only narrow what runs. That is a fact
about where the seam sits rather than about a plugin author being careful — and it makes middleware
approval a *second* gate rather than a replacement for `tools.policy`, with the answer being the
intersection.

Composition is manifest order, outermost first. Given plugins `[a, b]`:

```
a.wrapTurn( b.wrapTurn( core.turn ) )
```

### What middleware is for

| Use | Hook |
| --- | --- |
| Redact PII before it reaches the model | `wrapContext` |
| Retry on 429 with backoff | `wrapModelCall` |
| Swap to a fallback model on failure | `wrapModelCall` |
| Require approval for mutating tools | `wrapToolCall` |
| Per-tenant rate limiting | `wrapTurn` |
| Cost accounting | `wrapModelCall` + `onEvent` |
| Export traces to OTel | `onEvent` |

### Rules

1. **Always call `next()`** unless deliberately short-circuiting, and when short-circuiting
   return a well-formed result — never `undefined`.
2. **Never mutate the context argument.** Return a new array from `wrapContext`.
3. Respect `ctx.signal`. A middleware that ignores cancellation makes stop unreliable.
4. Errors propagate. Do not swallow. If you handle an error, return a valid result and
   record why.
5. `onEvent` is fire-and-forget, must not throw, and must not block. Anything slow goes on
   a queue you own. A throw is caught, reported as an `agent.warning`, and the event still reaches
   every other watcher — one plugin's broken observer must not stop the runtime reporting to
   everybody else's. Watchers see only their own agent's events.
6. **`onEvent` never receives `model.chunk`.** Per-token frames are opt-in per subscriber, and a
   watcher that gets them by default would put an envelope, a timestamp and a call through every
   installed middleware on every token of every reply. A plugin that genuinely wants tokens
   subscribes for itself — `context.events.on("model.chunk", handler)`, where an exact subscription
   *is* the opt-in, or `context.events.on("*", handler, { chunks: true })` for everything. That is
   why this is an absence rather than a `wantsChunks` field: the capability is already reachable
   through the API a plugin has, and declaring a second way to ask for it would be vocabulary with
   nothing behind it.

**What is enforced.** A middleware returning `undefined` is a named failure rather than a silently
empty result: short-circuiting is legitimate and returning a fabricated result is how it is spelled,
but returning nothing at all is a forgotten `return`, and without the check it surfaces as an empty
reply or a prompt with no blocks — confusing symptoms that name nothing. "Never mutate the context
argument" is **documentation**: freezing would cost real time on the hot path and the argument
objects hold references a deep freeze would break.

### Shipped examples

`retryMiddleware` and `approvalMiddleware` are exported from `@dispach/core` rather than printed
here, because an example nobody runs is an example that rots. Both are constructed by a caller — an
embedder, or a plugin that wants them — never switched on by a manifest: middleware that appeared
without anybody naming it would be the opposite of what the plugin list is for.

### Short-circuit example

```ts
const approvals: Middleware = {
  name: "approvals",
  async wrapToolCall(ctx, next) {
    if (!ctx.tool.mutating) return next()
    const ok = await requestApproval(ctx.tool.slug, ctx.args)
    if (!ok) {
      return {
        ok: false,
        error: { code: "denied_by_policy", message: "Operator denied this action." },
      }
    }
    return next()
  },
}
```

The denial returns a well-formed `ToolResult`, so the agent sees an honest observation and
can adapt, rather than an exception that kills the turn.

---

## Permissions vocabulary

Declarative in v1. Recorded at load, surfaced by `dispach plugins` and in the
`plugin.loaded` event. Not enforced.

```ts
type Permission =
  | { kind: "network"; hosts: string[] }
  | { kind: "env"; vars: string[] }
  | { kind: "fs"; paths: string[]; mode: "read" | "write" }
  | { kind: "exec"; commands: string[] }
  | { kind: "store"; tables: string[] }
```

Shipping the vocabulary now means enforcement later is not a breaking change. Plugin
authors who declare accurately today get grandfathered; those who don't will have to
scramble. That trade is stated in the README.

**The honest position, printed in the README verbatim:**

> Dispach plugins run in-process with full privileges. The `permissions` block is
> documentation, not a sandbox. Install plugins you trust, the same way you treat any npm
> dependency. Real isolation requires separate processes or V8 isolates, both of which cost
> the startup time and simplicity this project exists to preserve. If you need to run
> untrusted plugin code, run the whole agent in a container and treat that as the boundary.

---

## Authoring checklist

- [ ] `dispachApi` range is accurate and narrow
- [ ] `setup()` does no network I/O and returns under 200 ms
- [ ] `configSchema` covers every field, secrets referenced by env var name
- [ ] Every tool declares `whenNotToUse`
- [ ] `resolve()` throws on unknown slugs
- [ ] `send()` is idempotent
- [ ] Middleware calls `next()` and respects `ctx.signal`
- [ ] `onEvent` never throws and never blocks
- [ ] Permissions declared honestly
- [ ] `bun test` passes against `@dispach/core`'s plugin conformance suite

Core ships `@dispach/core/testing` with `conformance(plugin)`. It returns findings and throws
nothing, because a plugin author's test runner is theirs — a suite that assumed one would be
unusable by most of them.

**It checks the mechanical half only, and says so in its own docstring**: the shape, the version
range, the setup budget, that `setup` registers something and survives an empty environment with a
workspace that does not exist. It does **not** check that `send()` is idempotent, that `resolve()`
throws on an unknown slug, or that the plugin avoids the network — those are properties of code the
suite calls once, under conditions a conformance run does not create. Passing means *well-formed*,
not safe. A suite advertised as proving more than it does is worse than none, because it invites the
belief that passing means the plugin is bounded by what it declared.

Every first-party plugin runs it: `packages/cli/test/plugin-conformance.test.ts`, which lives there
because the CLI is the package that imports all four — `packages/core` may not (hard rule 2), and a
package asserting against itself would only ever check itself.
