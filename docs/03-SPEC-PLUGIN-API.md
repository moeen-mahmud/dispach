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

A `plugins:` entry resolves in one of three ways, and never by installing anything (hard rule 5).

1. **A built-in registry, keyed by the specifier a manifest writes.** `@dispach/channel-telegram`
   resolves to the copy the host already bundles, with no import at all.
2. **The host's plugin root** — `~/.dispach/plugins/<name>/`, where `plugins add` puts one. A bare
   name (no separator) resolves to that directory and the entry its `package.json` names in `main`,
   defaulting to `index.js`.
3. **A module import** for anything else — a relative path, resolved against the *manifest's*
   directory rather than the working directory, or a package name resolved from beside the agent.

The order is not arbitrary and neither end can move. The registry is first because a host's own
bundled copy must always win: a vendored directory shadowing `@dispach/channel-telegram` would load
a second copy of a package already inside the binary, which is `instanceof`'s failure one layer up.
The import is last because it is the only lookup that can reach a `node_modules` an operator
installed themselves.

`LoadedPlugin.lookup` records which one answered — `registry`, `installed` or `import` — and
`plugins list` prints it beside the commit an installed plugin was fetched at. With one lookup
"which code is loaded" was derivable from the manifest; with three it is not, and a plugin shadowed
by a same-named bundled one would otherwise be invisible.

A directory that exists and cannot be entered is a **refusal** (`plugin_entry_missing`), never a
fall-through to the import. The import would report `cannot find module <name>`, which sends a
reader to a package registry when the problem is a half-fetched directory two paths away. A `main`
pointing outside its own directory is refused for the same reason `root.ts` resolves before
comparing.

The plugin root is supplied by the **host** (`RuntimeOptions.pluginRoot`) and never derived in core.
One module owns every sandbox path — `cli/src/lib/sandbox.ts` — precisely so a test can redirect it;
a caller that computed its own once wrote three agents into the author's real home directory. Ten
object literals have to pass it, which is the shape this project has lost a field to six times, so
`packages/cli/test/boundaries.test.ts` asserts that every `Runtime.create` and `agentPluginSupply`
call site names it. Absent, the lookup simply does not happen and behaviour is what it was before.

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

### One self-contained bundle

**An installed plugin is one directory with a runnable entry and nothing to resolve.** That is the
rule the whole install mechanism is built on, and it is what makes it small enough to be worth
having: nothing installs dependencies, ever, so the compiled binary and the container — neither of
which has a `node_modules` — load a plugin exactly as a checkout does.

`plugins add` is what keeps it true. A fetched tree that declares runtime `dependencies` and ships no
`node_modules` is refused by name (`plugin_not_self_contained`) before anything is renamed into place
or written to a manifest. A committed `node_modules` clears the check: vendoring the dependencies is
a perfectly good way of being self-contained, and refusing a tree that already has what it declares
would be refusing the thing being asked for.

The corollary for an author: **publish the built entry file.** A source checkout whose `main` points
at a `dist/` that is not committed is the commonest failure, and `plugins add` names it as itself
rather than as a missing module.

### `plugins add | list | remove`

```
dispach plugins add <agent> <owner/repo | url | local path> [--ref <tag>] [--name <name>]
dispach plugins list <agent>
dispach plugins remove <agent> <name>
```

`add` fetches with git into `<pluginRoot>/<name>.partial`, verifies it there, renames it into place,
and only then writes the `plugins:` entry through `manifest/edit.ts` — the one manifest writer. That
order is the point: a manifest naming a plugin that will not load **does not load**, so an `add`
that wrote the entry first would brick the agent and report success, with the command that undoes it
reachable only by hand-editing YAML. This is the recorded `skills install` failure exactly.

The verification is `conformance()` from `@dispach/core/testing` — the same suite the plugin's own
author runs, rather than a second definition of "well-formed" living in the CLI. It calls `setup`
once into a void, so nothing is constructed and no credential is read. Two things it warns about are
**refusals** at install time, because the loader refuses them at boot: a `dispachApi` range that does
not admit this host, and anything the suite reports as an error.

Reading the declarations runs the plugin's module scope, and `add` says so out loud. There is no way
around it — what a plugin declares *is* its default export — and a second place to declare it would
be a second thing to keep in step. The disclosure names the plugin, its version, the resolved commit,
the host range, everything `setup` registered, and every permission declared, with the sentence that
`permissions` is advisory in v1. A plugin declaring nothing gets that said too, because "declares no
access" read as a boundary is worse than no list at all.

**What git costs, stated rather than discovered.** No version resolution and no integrity check: a
bare spec is whatever that branch points at today. `--ref` pins a tag or a commit and the resolved
commit is recorded in `.origin.json` beside the code, so `plugins list` can answer "which code is
loaded". The `dispachApi` gate is a **compatibility** check and not an authenticity one — nothing
here verifies who published what. npm specs are what would buy real integrity, and they are out of
scope: a registry fetch plus a tar extractor, and a change to decision 11.237's one npm name that is
worth its own decision rather than a side effect.

`.git` is dropped from an installed plugin. A skills source is a working copy that `sources update`
re-clones; a plugin directory is a vendored artefact that `.origin.json` describes, and leaving a
checkout there invites a `git pull` that moves the code out from under the recorded commit with
nothing reporting it.

**There is no plugin registry file**, and that is deliberate. `sources` needs `sources.json` because
a source is machine-level and nothing else records it; a plugin is selected by each agent's own
`plugins:` block, so the manifest *is* the registry and a second list would be the drift this
project keeps paying for. What lives beside the code is provenance, not selection.

`remove` drops the manifest entry always, and deletes the directory only when no other sandbox agent
names it. The directory is machine-level: deleting it while another agent named it would break that
agent at its next start, with the damage done by a command somebody ran about a *different* agent —
so it is named rather than deleted, the same call `remove` makes about two directories sharing one
manifest id.

### Loading

Loading happens **once per agent**, before that agent's manifest is validated. That ordering is
forced: `loadManifest` checks `tools.provider` and a channel `type` against the ids the host can
supply, and once plugins exist half of those ids come from the manifest itself. The refs are read
from a shallow header parse, which needs no credentials and expands no environment — a plugin spec
is a package name, never a secret.

---

## Extension points

### Channel

**This section described an interface that does not exist** for as long as it has been here — a
`ChannelSpec`/`Channel` pair with `capabilities.maxMessageLength` and `ctx.inbound(event)`, none of
which is in `packages/core/src/channels/channel.ts`. Rewritten against the real one in 0.1.3,
because it is what the second channel gets written from. `channels/channel.ts` is the authority; the
shapes below are copied from it.

```ts
type ChannelFactory = (context: ChannelFactoryContext) => ChannelTransport

interface ChannelFactoryContext {
  readonly agentId: string
  readonly dir: string                              // the agent's directory
  readonly env: EnvSource                           // the manifest's .env over the ambient one
  readonly config: Readonly<Record<string, unknown>> // the entry minus id/type/enabled/allowFrom
  readonly id: string                               // the entry's id — report it back verbatim
}

interface ChannelTransport {
  readonly id: string        // === context.id
  readonly type: string      // === the name passed to defineChannel
  readonly limits: ChannelLimits
  start(host: ChannelHost): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult>
  typing?(recipient: string, thread?: string): Promise<void>
  webhook?(delivery: WebhookDelivery): Promise<WebhookOutcome>
}

interface ChannelLimits {
  readonly maxMessageChars: number
  readonly idempotentSend: boolean
  readonly minSendIntervalMs?: number
}

interface ChannelHost {
  receive(message: RawInbound): void
  status(status: "starting" | "connected" | "disconnected" | "error", detail?: string): void
  status(status: "needs_input", detail: string | undefined, input: ChannelInput): void
  error(detail: ErrorDetail): void
}

type SendResult =
  | { readonly ok: true; readonly providerMessageId?: string }
  | {
      readonly ok: false
      readonly retryable: boolean
      readonly error: ErrorDetail
      readonly retryAfterMs?: number
    }
```

Inbound arrives by calling `host.receive(raw)` with a `RawInbound` — `peerId`, `text`,
`receivedAt`, and optionally `providerMessageId`, `senderHandle`, `senderName`, `thread`. Core adds
the `channelId`, `channelType` and `sessionKey`.

**Rules for channel authors:**

- **`id` and `type` must be the ones you were given.** `id` is `context.id` and `type` is the name
  passed to `defineChannel`; a transport that disagrees is refused at load
  (`channel_transport_mismatch`). Both are read elsewhere as facts: `id` becomes the channel segment
  of every session key this channel produces, and `type` is what `GET /v1/agents/:id` and the
  `serve` banner report. TypeScript cannot make this check for a plugin — by the time a factory runs
  it is plain JavaScript — and the first third-party channel to run put the literal text
  `echo (undefined)` on the banner and left the documented `type` absent from the wire.
- **`start(host)` returns once *running*, not once connected.** Awaiting a first successful poll or
  a completed pairing makes a provider outage an unbootable runtime, and an orchestrator watching
  `/v1/ready` would restart the process into the same outage. Report progress through
  `host.status()`; `/ready` deliberately flips before channels connect.
- **A polling or reconnecting loop must never exit on its own.** Catch everything, back off, report
  on the first failure and periodically after that, and let only `stop()` end it. A loop that throws
  and returns leaves a process that is running, reports nothing and receives nothing forever.
- **`limits.idempotentSend` is `false` unless the provider deduplicates on a key you supply.**
  `false` is the honest default: the outbox reports a recovered in-flight delivery as `uncertain`
  rather than claiming exactly-once it cannot deliver. `true` without provider support converts a
  visible ambiguity into a silent duplicate, which is strictly worse.
- **`send` classifies its own failures.** Only the transport knows the provider's taxonomy — a 429
  and a 503 are `retryable`, "chat not found" and "blocked by the user" are not. Wrong in the safe
  direction costs a few attempts; wrong the other way abandons a message that would have gone
  through. Return `retryAfterMs` when the provider names a wait.
- **Do not chunk in `send`.** The outbox chunks at *enqueue* against `maxMessageChars`, because a
  delivery's identity is derived from its content and re-splitting later would produce different
  keys for the same reply and stop the deduplication working.
- **Never throw from an inbound handler.** Report through `host.error` and drop.
- **`allowFrom` is applied by core before your handler is invoked, and is inbound-only.** It confers
  nothing on outbound delivery; conflating the two produces a confusing "chat not found" class of
  failure. Validate the identifier against the system that issues it — a handle that cannot exist
  matches nobody, and everything downstream is then correct behaviour applied to a wrong fact.
- **`needs_input` carries its payload or it is refused.** `status("needs_input", detail, input)` is
  a separate overload for that reason, and the hub refuses a payload-free one from a JavaScript
  plugin too — keeping the previous state, because recording it would turn a channel that is waiting
  into one that looks broken. `issuedAt` is the runtime's and is always present, since a rotating QR
  nobody can tell is expired reads as a broken scanner rather than an old picture.
- **`enabled: false` means your factory is never called.** Reading a token in the factory is
  therefore fine; doing work there is not. A factory that refused for a missing token would make
  switching a broken channel off impossible, which is the one thing `enabled: false` is for.

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
- [ ] A channel transport reports the `id` and `type` it was given
- [ ] `send()` is idempotent
- [ ] Middleware calls `next()` and respects `ctx.signal`
- [ ] `onEvent` never throws and never blocks
- [ ] Permissions declared honestly
- [ ] `bun test` passes against `@dispach/core`'s plugin conformance suite

**For distribution** — what `plugins add` checks, so checking it yourself is cheaper:

- [ ] The published tree has a runnable entry: `main` (or `index.js`) is **committed**, not built
      from a `dist/` that is gitignored
- [ ] No runtime `dependencies`, or a committed `node_modules` that satisfies them
- [ ] One ES module — no bare `require`, no unresolved import, nothing to install
- [ ] A tag per release, so `--ref` can pin it

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

**`plugins add` runs it too**, which is the useful half of it being assertions rather than a test
file: an install verifies with exactly the suite the author ran, and there is no second definition
of "well-formed" in the CLI to drift from this one. Two of its *warnings* become refusals there, and
only there — a `dispachApi` range that does not admit this host, and any error-level finding —
because installing is not the same as testing. Running the suite against a newer host than you
support is a normal thing for an author to do; writing a `plugins:` entry the loader will refuse at
boot is an agent that will not start, reported as a success.
