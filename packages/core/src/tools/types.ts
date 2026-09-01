/**
 * The tool layer's vocabulary.
 *
 * **One schema, two renderings.** A tool declares its parameters as a JSON Schema object — which
 * is what a provider hands over anyway — and the dialect decides how the model sees it: NLT renders
 * prose, `native` passes the schema to the provider's `tools` parameter. Anything else would mean
 * two descriptions of the same tool that can disagree, and an eval comparing the dialects would no
 * longer be comparing the same tools.
 *
 * The schema subset here is deliberately small. It covers what a line-oriented invocation format
 * can actually express, and a provider tool needing more than this is a tool whose arguments a
 * small model was never going to get right.
 */

import type { ConfigError, ErrorDetail } from "../errors.ts"
import type { Trust } from "./trust.ts"

export type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object"

export interface JsonSchemaNode {
    readonly type: JsonType
    readonly description?: string
    /** Coercion matches case-insensitively against these, then reports the allowed set. */
    readonly enum?: readonly (string | number | boolean)[]
    readonly items?: JsonSchemaNode
    readonly properties?: Readonly<Record<string, JsonSchemaNode>>
    readonly required?: readonly string[]
    readonly default?: unknown
}

/** A tool's arguments are always an object at the top level, as in every provider's format. */
export interface ToolParameters {
    readonly type: "object"
    readonly properties: Readonly<Record<string, JsonSchemaNode>>
    readonly required?: readonly string[]
}

export interface ToolSpec {
    /** Unique across the catalogue. Case-sensitive, matched tolerantly when parsing. */
    readonly slug: string
    /** Which provider resolved it. Named in a resolution failure so the fix is obvious. */
    readonly provider: string
    /** One line: what it does. */
    readonly summary: string
    /** When the model should reach for it. */
    readonly whenToUse: string
    /**
     * When it should not. Optional in the type, required by the catalogue: negative examples are
     * the cheapest available routing-accuracy improvement, so a spec without one renders a visible
     * placeholder and the registry warns naming the slug. Fabricating the line would be worse than
     * admitting the provider did not supply it.
     */
    readonly whenNotToUse?: string
    /** Mutating tools serialise, hold reserved budget slots, and are never retried. */
    readonly mutating: boolean
    /**
     * Whether this tool's output may contain text a stranger wrote.
     *
     * Optional here and **normalised by the registry**, which defaults anything a remote provider
     * resolved to `untrusted`. Optional rather than required on purpose: a provider package that
     * forgot the field would otherwise ship trusted, and decision 4.25's whole premise is that a
     * provider cannot know what its upstream returns. Declaring `trusted` explicitly is honoured
     * and warned about, so opting out of the boundary is visible at load.
     */
    readonly trust?: Trust
    /**
     * Why this tool declares `trust: "trusted"` when the registry would have defaulted it to
     * `untrusted`.
     *
     * The registry warns about a provider tool that opts out of the boundary, because opting out
     * silently is how an email body ends up unfenced. That warning fired on every boot of every agent
     * using the system provider — four tools whose output is a sentence the runtime composed — and a
     * warning that appears every time for a correct configuration is how people learn to ignore
     * warnings.
     *
     * So the requirement is not "never declare trusted", it is **say why**. A reason here suppresses
     * the warning and is shown by `tools` instead, where a person looking at the catalogue can read it.
     * A tool that declares trusted with no reason still warns, which is the case worth catching: a
     * package that forgot rather than a package that decided.
     */
    readonly trustReason?: string
    /**
     * Which argument a `tools.policy` pattern matches against — `command` for a shell tool, `path`
     * for a file tool.
     *
     * Named by the tool rather than guessed by the engine, because only the tool knows which of its
     * arguments *is* the call. A tool that names none can still be addressed by a bare `Tool` rule;
     * it simply cannot be narrowed, which is honest for something like `now`.
     */
    readonly policyArg?: string
    /** Matched by `phases.*.allow` as `tag:<name>`. */
    readonly tags: readonly string[]
    readonly parameters: ToolParameters
}

/**
 * What a handler is given besides its arguments.
 *
 * `now` is injected rather than read from the global clock so that a tool reading the time is
 * testable without freezing the process clock.
 */
export interface ToolContext {
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    /**
     * The agent's own directory — the one its manifest sits in. A tool that touches the filesystem
     * resolves against this, never against `process.cwd()`, which belongs to whoever launched the
     * process and moves depending on how they did it.
     */
    readonly dir: string
    /** The turn's signal. A handler that ignores it will be abandoned, not killed. */
    readonly signal: AbortSignal
    /**
     * How long the harness will wait for this call before abandoning it, in milliseconds.
     *
     * Handed to the tool rather than kept private because *abandoned* is the operative word: nothing
     * in the executor can kill a handler, so a tool holding an operating-system resource — a child
     * process above all — has to finish its own cleanup before the outer timeout fires, or it leaks
     * one per call with nothing reporting it.
     *
     * It also decides whether a tool's own gentler behaviour is reachable at all. `exec` backgrounds
     * a long command instead of killing it, which it can only do if it times out first; without this
     * number its default and `limits.toolTimeoutMs` are both 120 s and which of them wins is a race.
     */
    readonly deadlineMs: number
    readonly now: () => Date
    /**
     * Where a durable note goes, when a workspace declares somewhere for it.
     *
     * Resolved by the runtime rather than chosen by the model, and deliberately not exposed as a
     * tool argument. Picking a file would be a second decision on every save, and a second decision
     * is exactly the two-hop shape small models fail — the same reasoning that keeps `tools.search`
     * off by default.
     *
     * Absent means no workspace declared a writable file, and the tool falls back to its own
     * directory. Present-and-refusing is a different thing entirely and says so: see
     * `WorkspaceWriteTarget.reason`.
     */
    readonly writeTarget?: WorkspaceWriteTarget
    /**
     * Reads back what compaction displaced. Resolved by the runtime, scoped to this session.
     *
     * A narrow function rather than the store itself, for the same reason `writeTarget` is a resolved
     * path rather than a filesystem: a tool handed the store could read another session's history, and
     * the seam is the only place that can be true or false.
     *
     * Absent when the runtime has no store behind it — `previewContext`, a bare `toolContext()` in a
     * test — and `artifact_read` says so rather than reporting an empty artifact.
     */
    readonly readArtifact?: (id: string) => Promise<DisplacedArtifact | undefined>
    /**
     * Moves the session to another phase. Resolved by the turn, which owns the current one.
     *
     * A seam rather than state on the context, because the change has to reach three places the tool
     * cannot see: the visible catalogue for the rest of this turn, the store, and the `phase.changed`
     * event. Absent means nothing runs turns here — `previewContext`, a bare `toolContext()` — and
     * `phase_set` refuses rather than reporting a move that did not happen.
     */
    readonly setPhase?: (to: string) => Promise<void>
    /**
     * Absolute path of the archive directory eviction writes to — `memory.dir`, resolved.
     *
     * Absent means the runtime has no memory configured, and `memory_write` then appends without
     * evicting: the previous behaviour, which is honest about what it does rather than silently
     * dropping notes on the floor because nowhere was configured to keep them.
     */
    readonly memoryDir?: string
}

/** What `artifact_read` needs to know about a displaced observation. Structural on purpose. */
export interface DisplacedArtifact {
    readonly content: string
    /** Estimated cost of the original, so the reader can be told the size before paging through it. */
    readonly tokens: number
    readonly slug?: string
}

/**
 * The workspace's answer to "where does a note go?".
 *
 * A refusal is carried here rather than thrown at load, because `editable: none` on every volatile
 * file is a legitimate configuration — an agent with a read-only user model that never writes. It
 * only becomes an error at the moment something tries to write, and then it must be an error, not a
 * no-op: a save the model believes succeeded and disk never received is worse than a failed call,
 * which at least the model can report.
 */
export interface WorkspaceWriteTarget {
    /** Absolute path, when one is writable. */
    readonly path?: string
    /** As declared in the manifest, for the observation and the error. */
    readonly name: string
    readonly mode: "append" | "replace" | "refused"
    /** Set when `mode` is `refused`: the `editable` value that refused it. */
    readonly reason?: string
    /**
     * The file's effective token budget — its own `budget:` or its tier's.
     *
     * Carried because `memory_write` is what makes the file grow, so it is the only caller in a
     * position to evict before the *next load* fails on it. The budget is a hard load failure, not a
     * truncation, so a tool that appends without knowing the ceiling is a tool that can brick the agent.
     */
    readonly budget?: number
    /**
     * The file's `eviction:` declaration. **Eviction only runs when this is `oldest`.**
     *
     * Not a convenience — it is what stops the memory tool rewriting the wrong file. `writeTarget`
     * prefers a writable volatile file that declared `eviction: oldest` over declared order, so a
     * workspace that lists `USER.md` before `MEMORY.md` still writes notes here: hand-written prose
     * about the person has no `eviction` field and no intention of being trimmed. Evicting there
     * would delete an author's sentences into a dated archive. `eviction: oldest` is the author
     * saying "this file accumulates notes and may be trimmed", and nothing else grants that.
     */
    readonly eviction?: "oldest" | "none"
}

/** Returns the observation text the model will see. Throwing is a failed call, reported as one. */
export type ToolHandler = (
    args: Readonly<Record<string, unknown>>,
    context: ToolContext,
) => Promise<string> | string

export interface Tool {
    readonly spec: ToolSpec
    readonly handler: ToolHandler
}

/**
 * One line about a tool that exists but was not pinned.
 *
 * Slug and summary only. The full spec would be the whole catalogue again, and the point of this is to
 * cost a few tokens rather than to be a second catalogue.
 */
export interface ToolAvailability {
    readonly slug: string
    readonly summary: string
}

export interface ToolProvider {
    readonly id: string
    /**
     * Resolve slugs to tools. Return one entry per slug understood, in any order, and **omit**
     * the rest — the registry diffs what came back against what was asked for and fails loudly on
     * the difference. A provider must never substitute a near match of its own.
     *
     * One slug may resolve to several tools (a toolkit name expanding to its members). The
     * registry's budget applies to the result, not to the request.
     */
    resolve(slugs: readonly string[]): Promise<readonly Tool[]>
    /** Optional, and only used to suggest a nearest match when resolution fails. */
    list?(): Promise<readonly string[]>
    /**
     * Bring a cached catalogue up to date. **Called after `runtime.ready`, never before.**
     *
     * This exists because `resolve` runs inside the boot sequence, where hard rule 4 forbids network
     * I/O — so a remote provider resolves from disk there and catches up here. A provider with nothing
     * to refresh omits it; the runtime skips what is absent rather than requiring an empty
     * implementation.
     */
    refresh?(slugs: readonly string[], signal?: AbortSignal): Promise<ToolProviderRefresh>
    /**
     * Everything this provider offers, pinned or not, so the model can be told what it *could* have.
     *
     * Optional, and the reason it is optional is the whole design: a provider with twenty-five
     * thousand tools has nothing useful to say here and omits it, while a provider with eight can list
     * them for a handful of tokens. `list()` is not enough — a bare slug tells the model nothing about
     * whether it is the tool the request needs.
     *
     * What this buys is the difference between "I can't do that" and "I can't do that *yet*, and here
     * is the one line that would let me". Without it a pinned-down agent is silently less capable than
     * its own runtime, and only the person reading the manifest can work out why.
     */
    available?(): Promise<readonly ToolAvailability[]>
    /**
     * Why these slugs came back unresolved, when the provider knows something the registry cannot.
     *
     * Consulted **only** when a slug is genuinely missing after every provider has been asked — which
     * is the half neither side can decide alone, and getting that wrong is how a correct manifest
     * stopped booting. The registry asks every provider for the whole pinned list, so a cold Composio
     * sees `config_read` and `config_set` and has no way to know the system provider is about to
     * answer for both. Throwing there refused an agent whose every pinned tool resolved.
     *
     * The other direction is just as wrong: left to the registry alone, an empty cache reports
     * "no provider resolved GMAIL_FETCH_EMAILS … Available: now, memory_write", which blames three
     * correct slugs. Only the provider knows the cache is the reason. So the provider supplies the
     * sentence and the registry decides whether anyone needs to hear it.
     */
    explainUnresolved?(slugs: readonly string[]): ConfigError | undefined
    /**
     * Release anything this provider owns outside the process. Called once, from `Runtime.stop`.
     *
     * Added because a provider can own an **OS process**, and one that does had no way to be told
     * the runtime was going away. `exec` backgrounds a command that outruns its deadline rather than
     * discarding its work — deliberate — and then nothing ever reaped it. Thirty-three orphaned
     * shells accumulated on the author's machine over one day, each spinning a busy loop, and the
     * measured effect was a load average of 351 and a `runtime.ready` that took 132 seconds. The
     * boot budget this project exists to defend was being blown by the runtime's own litter.
     *
     * Returns what it released, rather than logging it, for the same reason `TurnStore.reapRunning`
     * does: the caller decides whether anyone needs to hear about it, and a cleanup nobody can see
     * is indistinguishable from one that did not happen.
     */
    stop?(): Promise<readonly string[]>
}

export interface ToolProviderRefresh {
    readonly fetched: number
    /** Slugs the provider no longer has. Reported, never silently dropped from the catalogue. */
    readonly missing: readonly string[]
    /** Slugs whose schema differs from the copy resolved at boot. */
    readonly changed: readonly string[]
}

/**
 * How a provider is supplied to the runtime.
 *
 * A factory rather than an instance, because `packages/core` may not import a sibling package (hard
 * rule 2) and because a provider needs the *agent's* directory and resolved environment — which only
 * exist once its manifest is loaded. The embedder registers factories by id; the manifest's
 * `tools.provider` selects one. Phase 9's plugin loader replaces this with registration, and keeps the
 * same shape.
 */
export type ToolProviderFactory = (context: ToolProviderContext) => ToolProvider

/**
 * How a skill's script is run, from the one package allowed to start a process.
 *
 * The same shape and the same reason as `ToolProviderFactory` above: core decides *what* to run —
 * `skills/scripts.ts` picks the interpreter, purely, from a directory listing — and something outside
 * core actually runs it. `tools-system` implements this on the machinery `exec` already uses, so a skill
 * script inherits process groups, the concurrency cap, the file-descriptor-not-a-pipe rule, and reaping
 * through `ToolProvider.stop()`. Without the port, core would need `node:child_process` and would be
 * rebuilding all four.
 *
 * An embedder that supplies no runner gets skills without scripts, which is a coherent configuration:
 * a skill carrying only prose is a valid skill.
 */
export interface ScriptRunner {
    run(request: ScriptRunRequest): Promise<ScriptRunResult>
    /**
     * Whether an interpreter is reachable — filesystem only, no execution.
     *
     * Called during the boot scan so a skill declaring Python on a machine with no Python fails **at
     * load**, naming both, rather than at the moment the model finally reaches for it. A tool that
     * refuses on first use after an agent has already told someone it can do the job is the worse
     * failure, and it arrives hours later.
     */
    has(command: string): boolean
}

export interface ScriptRunRequest {
    readonly command: string
    /** Interpreter arguments, then the absolute script path, then the model's own arguments. */
    readonly args: readonly string[]
    /** The skill's own directory, so a script's relative paths mean what its author meant. */
    readonly cwd: string
    /**
     * Wall-clock ceiling, and it must be **under** `limits.toolTimeoutMs`.
     *
     * The harness *abandons* a handler at its own timeout rather than killing it, so a race between the
     * two leaves a process running with nothing referencing it. `exec` clamps five seconds under the
     * deadline for exactly this, and a script runner has the same obligation.
     */
    readonly timeoutMs: number
    readonly signal: AbortSignal
}

export interface ScriptRunResult {
    /** Exit code 0 and nothing killed it. */
    readonly ok: boolean
    /** Merged stdout and stderr, already capped by the runner. */
    readonly output: string
    readonly code?: number
    /** Set when the deadline ended it, so the observation can say so rather than showing empty output. */
    readonly timedOut: boolean
}

export interface ToolProviderContext {
    /** The agent's own directory — where a resolution cache belongs, never `process.cwd()`. */
    readonly dir: string
    /** The manifest's env, layered over the ambient one. Holds values; the manifest holds names. */
    readonly env: Readonly<Record<string, string | undefined>>
    /** `tools.providerConfig`, verbatim. */
    readonly config: Readonly<Record<string, unknown>>
    readonly agentId: string
}

export interface ToolIntent {
    /** Stable within a step. Synthesised for NLT; the provider's id under `native`. */
    readonly callId: string
    readonly slug: string
    /** Pre-coercion: NLT yields strings, `native` yields already-parsed JSON. */
    readonly args: Readonly<Record<string, unknown>>
}

/** One field's worth of "what you sent cannot work", quoted back in the single repair step. */
export interface FieldError {
    readonly field: string
    readonly message: string
    readonly hint: string
}

export interface ToolResult {
    readonly callId: string
    readonly slug: string
    readonly ok: boolean
    /** What the model sees. On failure this is the error text, not an empty string. */
    readonly output: string
    readonly error?: ErrorDetail
    readonly latencyMs: number
    readonly bytes: number
    /** True when the observation was capped. Never silent — the marker is in `output`. */
    readonly truncated: boolean
    /**
     * Stamped from the spec so a dialect can delimit without reaching for the registry.
     *
     * **Required**, unlike `ToolSpec.trust` — the opposite call for the same reason. A `ToolResult`
     * is built only inside core, so an optional field here would mean "absent reads as trusted",
     * which is a fail-open default baked into the type.
     */
    readonly trust: Trust
    /**
     * The write gate refused this call. It did not run, and retrying will not change that — which
     * is why a dialect renders it as "blocked" rather than "failed".
     */
    readonly gated?: boolean
}
