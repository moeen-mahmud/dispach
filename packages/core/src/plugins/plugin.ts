/**
 * The plugin contract.
 *
 * Plugins are how this runtime varies. Core ships the loop, the context manager, the SQLite store and
 * the chat-completions transport; every channel, tool provider, alternative store and skill source
 * arrives through here — **including the first-party ones**. That is not a stylistic preference: if a
 * first-party package needs something this API cannot express, the API is wrong and gets fixed, and
 * the only way to find that out is to make the first-party packages live on it.
 *
 * ## What a plugin registers, and what it does not
 *
 * `setup()` **registers capabilities and does not do work**. Everything it hands over is a *factory*,
 * because the thing being built needs the agent's own directory and resolved environment — and
 * because hard rule 4 forbids network I/O before `runtime.ready`. A channel connects in its `start()`,
 * which runs after readiness; a provider fetches in its post-readiness refresh. A `setup` that opens a
 * socket is the exact cost this project exists to remove, so the loader budgets it and says so.
 *
 * ## Per agent, not per runtime
 *
 * `setup` runs **once per agent**, during that agent's load. It has to: `config` comes from that
 * agent's `plugins:` entry, `paths` from its manifest directory, and two agents in one process can
 * configure the same plugin differently. A runtime-level `setup` would have to pretend otherwise and
 * would make `ctx.agentId` a lie.
 *
 * ## Trusted code, stated plainly
 *
 * Plugins run in-process with full privileges. `permissions` is **advisory vocabulary in v1** —
 * recorded, surfaced, unenforced. vm2 has had twenty-plus sandbox escapes, `node:vm` documents itself
 * as not a security mechanism, and worker threads are not a boundary; real isolation means separate
 * processes or V8 isolates, both of which cost the startup time this runtime is built around. Shipping
 * the vocabulary now means enforcing it later is not a breaking change. The honest version of this
 * paragraph belongs in the README, verbatim, and decision 7.4 says so.
 */

import type { EventBus } from "../events/bus.ts"
import type { EnvSource } from "../manifest/env.ts"
import type { ChannelFactory } from "../runtime/channels.ts"
import type { ScriptRunner, ToolProviderFactory } from "../tools/types.ts"
import type { Middleware } from "./middleware.ts"

/**
 * What a plugin says it needs.
 *
 * Declarative in v1 and unenforced, so the only thing that makes it worth anything is authors
 * declaring accurately before there is a reason to. The trade is stated in the README rather than
 * implied: declare honestly now and be grandfathered, or scramble when enforcement lands.
 */
export type Permission =
    | { readonly kind: "network"; readonly hosts: readonly string[] }
    | { readonly kind: "env"; readonly vars: readonly string[] }
    | { readonly kind: "fs"; readonly paths: readonly string[]; readonly mode: "read" | "write" }
    | { readonly kind: "exec"; readonly commands: readonly string[] }
    | { readonly kind: "store"; readonly tables: readonly string[] }

/**
 * A validator for a plugin's slice of the manifest.
 *
 * Structurally a Zod schema's `safeParse` and deliberately not typed as one: core depends on Zod, but
 * a plugin is separately installed and may carry its own copy — and two Zod instances are two
 * `instanceof` identities, so requiring the class would refuse a perfectly good schema for a reason
 * nobody could see from the error. Anything with this method satisfies it, Zod included.
 */
export interface ConfigSchema {
    safeParse(value: unknown):
        | { readonly success: true; readonly data: unknown }
        | {
              readonly success: false
              readonly error: { readonly issues?: readonly { readonly message?: string }[] }
          }
}

/** Where a plugin's files and its agent's files live. Absolute, resolved, never `process.cwd()`. */
export interface PluginPaths {
    /** The agent's workspace — where its documents are, and where a shell starts. */
    readonly workspace: string
    /** This runtime's state directory. */
    readonly state: string
    /** The manifest that named this plugin. */
    readonly manifest: string
}

export interface Logger {
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void
    info(message: string, fields?: Readonly<Record<string, unknown>>): void
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void
    error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

/**
 * What `setup()` is handed.
 *
 * The `define*` methods are the whole extension surface. Each registers under a key a manifest then
 * *selects* — `tools.provider` names a provider id, a `channels[]` entry names a `type` — which keeps
 * availability and grant separate: naming a plugin makes a capability *reachable*, and the manifest
 * still has to ask for it. That separation is why `plugins: ["@dispach/tools-system"]` does not hand
 * an agent a shell.
 */
export interface PluginContext {
    /** Register a channel transport under the `type` a `channels[]` entry names. */
    defineChannel(id: string, factory: ChannelFactory): void
    /** Register a tool provider under the id `tools.provider` names. */
    defineToolProvider(id: string, factory: ToolProviderFactory): void
    /**
     * Supply the runner for skill scripts.
     *
     * Unkeyed, because there is nothing for a manifest to select between: a process either can be
     * started or cannot. Last registration wins and the loader warns, since two plugins each claiming
     * to own process spawning is a configuration mistake rather than a preference.
     */
    defineScriptRunner(runner: ScriptRunner): void
    /**
     * Add middleware around turns, context assembly, model calls and tool calls.
     *
     * Unkeyed, and order is the order it was added — which is manifest order across plugins, and
     * declaration order within one. Composition is outermost-first, so the first plugin listed sees a
     * call first and its result last.
     */
    use(middleware: Middleware): void

    /** Validated against `configSchema` when one is declared; `{}` when the entry carried no config. */
    readonly config: unknown
    readonly agentId: string
    readonly paths: PluginPaths
    /** The agent's environment — the manifest's `.env` layered over the ambient one, as core resolved it. */
    readonly env: EnvSource
    readonly logger: Logger
    /**
     * Subscribe only. Emitting is core's, deliberately: an event is a claim about what the runtime
     * did, and a plugin that could forge one would make every surface reading the bus unreliable.
     */
    readonly events: Pick<EventBus, "on">
}

export interface Plugin {
    /** Unique within a runtime. A collision is a load failure naming both specs. */
    readonly name: string
    /** Semver. Reported in `plugin.loaded`. */
    readonly version: string
    /**
     * Semver **range** this plugin was written against. The host refuses to load on a mismatch and
     * names both versions and the range.
     *
     * Loud on purpose, and the reason is borrowed from the runtime this replaces: a config that
     * silently rolled back on version skew was a debugging nightmare, because the symptom appears
     * somewhere else entirely and nothing points back at the skew.
     */
    readonly dispachApi: string
    readonly permissions?: readonly Permission[]
    readonly configSchema?: ConfigSchema
    /**
     * Runs once per agent, at load. Registers; does not work.
     *
     * Throwing fails that agent's load with this plugin named, which is right for a genuine
     * misconfiguration and wrong for anything transient — so do not throw on what could be retried
     * later. A channel that cannot reach its API yet is not a load failure; a channel with no token
     * configured is.
     */
    setup(context: PluginContext): void | Promise<void>
}
