/**
 * Resolving a manifest's `plugins:` into an agent's capabilities.
 *
 * ## Resolution order, and why a built-in registry exists at all
 *
 * A bare specifier is looked up in a **built-in registry** first and only then imported; a relative
 * path is only ever a path. The registry is not a shortcut — it is what lets `@dispach/channel-telegram`
 * appear in a manifest and resolve to the copy the binary already bundles.
 *
 * The alternative was importing everything dynamically, and it is unavailable for a structural
 * reason rather than a preference: a module imported both statically and dynamically makes
 * `bun build --splitting` emit its exports twice, and the resulting bundle does not parse
 * (`SyntaxError: Duplicate export`). The CLI statically imports the first-party packages to register
 * them, so a loader that also `import()`ed them by name would produce a binary that fails to start —
 * and `bun test` walks straight past it, because tests import source and the failure is in the
 * bundle. The registry keeps each module imported exactly one way.
 *
 * What an embedder supplies as built-ins is therefore the same list the binary bundles. A spec that
 * is in neither the registry nor `node_modules` is refused, never fetched: hard rule 5.
 *
 * ## Per agent
 *
 * `load()` runs once per agent during that agent's load, because `config` comes from that agent's
 * manifest entry and two agents in one process can configure one plugin differently. The 200 ms
 * budget is therefore per agent per plugin, which is the number that actually affects boot.
 *
 * ## What it returns, and what it does not do
 *
 * Factory maps in exactly the shape `RuntimeOptions` already accepts, merged **over** whatever the
 * embedder registered directly. Nothing in the loop changes; a plugin is a different way to populate
 * the same seams that already existed. Middleware is Phase 9B and deliberately absent — a wrap point
 * is a new seam in `turn.ts` and belongs in its own reviewable change.
 */

import {
    pluginApiMismatch,
    pluginApiRangeUnreadable,
    pluginConfigInvalid,
    pluginMalformed,
    pluginNameCollision,
    pluginNotFound,
    pluginSetupFailed,
} from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { EnvSource } from "../manifest/env.ts"
import type { PluginRef } from "../manifest/schema.ts"
import type { ChannelFactory } from "../runtime/channels.ts"
import type { ScriptRunner, ToolProviderFactory } from "../tools/types.ts"
import { VERSION } from "../version.ts"
import type { Middleware } from "./middleware.ts"
import type { Logger, Permission, Plugin, PluginContext, PluginPaths } from "./plugin.ts"
import { satisfies } from "./semver.ts"

/** Past this, the loader says so. Not a refusal — a slow plugin still works and still costs boot. */
export const SETUP_BUDGET_MS = 200

/**
 * Plugins this host can resolve by name without importing anything.
 *
 * Supplied by whoever assembles the binary. Keyed by the specifier a manifest writes, so
 * `"@dispach/channel-telegram"` is the key rather than `"telegram"` — a manifest should name the
 * package it means, and the short name is what the plugin registers its *channel* under.
 */
export type BuiltInPlugins = Readonly<Record<string, Plugin>>

export interface LoadPluginsOptions {
    readonly refs: readonly PluginRef[]
    readonly builtIn?: BuiltInPlugins
    readonly agentId: string
    readonly paths: PluginPaths
    readonly env: EnvSource
    readonly bus: EventBus
    readonly logger?: Logger
    /**
     * How a bare specifier is imported when it is not built in. Injected so a test can supply a
     * module without writing one to `node_modules`, and so the import is one seam rather than a
     * bare `import()` the bundler has to reason about.
     */
    readonly importModule?: (specifier: string) => Promise<unknown>
}

export interface LoadedPlugins {
    readonly toolProviders: Readonly<Record<string, ToolProviderFactory>>
    readonly channels: Readonly<Record<string, ChannelFactory>>
    readonly scriptRunner: ScriptRunner | undefined
    /** In the order they were added: manifest order across plugins, declaration order within one. */
    readonly middleware: readonly Middleware[]
    /** What loaded, in manifest order — for `plugins` output and for the boot report. */
    readonly loaded: readonly LoadedPlugin[]
}

export interface LoadedPlugin {
    readonly name: string
    readonly version: string
    readonly spec: string
    readonly setupMs: number
    readonly permissions: readonly Permission[]
    /** What this plugin registered, so `plugins` can say what naming it actually bought. */
    readonly registered: readonly string[]
}

/** Normalises the two spellings a `plugins:` entry may take. */
function refParts(ref: PluginRef): { spec: string; config: Readonly<Record<string, unknown>> } {
    return typeof ref === "string"
        ? { spec: ref, config: {} }
        : { spec: ref.spec, config: ref.config }
}

/**
 * Pull the plugin out of a module.
 *
 * Default export only. A named export is not searched for and a factory function is not called —
 * both would be guesses about what an author meant, and a wrong guess here produces a plugin that
 * registers nothing and reports success, which is the failure shape this repo keeps finding.
 */
function pluginFrom(spec: string, module: unknown): Plugin {
    const candidate = (module as { default?: unknown } | undefined)?.default
    if (candidate === undefined || candidate === null || typeof candidate !== "object") {
        return raiseMalformed(spec, "its default export is not an object")
    }
    const plugin = candidate as Partial<Plugin>
    if (typeof plugin.name !== "string" || plugin.name === "") {
        return raiseMalformed(spec, "its default export has no `name`")
    }
    if (typeof plugin.version !== "string" || plugin.version === "") {
        return raiseMalformed(spec, `plugin "${plugin.name}" has no \`version\``)
    }
    if (typeof plugin.dispachApi !== "string" || plugin.dispachApi === "") {
        return raiseMalformed(spec, `plugin "${plugin.name}" has no \`dispachApi\``)
    }
    if (typeof plugin.setup !== "function") {
        return raiseMalformed(spec, `plugin "${plugin.name}" has no \`setup\` function`)
    }
    return plugin as Plugin
}

function raiseMalformed(spec: string, problem: string): never {
    throw pluginMalformed(spec, problem)
}

async function resolve(spec: string, options: LoadPluginsOptions): Promise<Plugin> {
    const builtIn = options.builtIn ?? {}
    const direct = builtIn[spec]
    if (direct !== undefined) return direct

    const importModule =
        options.importModule ?? ((specifier: string) => import(/* @vite-ignore */ specifier))
    // A relative path is resolved against the *manifest's* directory, never `process.cwd()` — the
    // same rule every other path in this runtime follows, and for the same reason: the working
    // directory belongs to whoever launched the process and moves depending on how they did it.
    const specifier = spec.startsWith(".")
        ? new URL(spec, `file://${options.paths.manifest}`).pathname
        : spec

    try {
        return pluginFrom(spec, await importModule(specifier))
    } catch (error) {
        // A malformed plugin already carries its own explanation; re-wrapping it as "not found"
        // would replace a precise message with a vague one.
        if (error instanceof Error && error.name === "ConfigError") throw error
        throw pluginNotFound(spec, Object.keys(builtIn), error)
    }
}

function validateConfig(plugin: Plugin, config: Readonly<Record<string, unknown>>): unknown {
    if (plugin.configSchema === undefined) return config
    const result = plugin.configSchema.safeParse(config)
    if (result.success) return result.data
    const problems = (result.error.issues ?? [])
        .map((issue) => issue.message)
        .filter((message): message is string => message !== undefined)
    throw pluginConfigInvalid(plugin.name, problems.length === 0 ? ["invalid"] : problems)
}

const SILENT_LOGGER: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
}

/**
 * Load an agent's plugins, in manifest order.
 *
 * Order is preserved and load-bearing for the same reason provider order is: a later registration of
 * the same key wins, so the manifest decides which plugin owns a name. Nothing here sorts.
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugins> {
    const toolProviders: Record<string, ToolProviderFactory> = {}
    const channels: Record<string, ChannelFactory> = {}
    const loaded: LoadedPlugin[] = []
    const middleware: Middleware[] = []
    const bySpec = new Map<string, string>()
    let scriptRunner: ScriptRunner | undefined

    for (const ref of options.refs) {
        const { spec, config } = refParts(ref)
        const plugin = await resolve(spec, options)

        const previous = bySpec.get(plugin.name)
        if (previous !== undefined) throw pluginNameCollision(plugin.name, [previous, spec])
        bySpec.set(plugin.name, spec)

        const ok = satisfies(VERSION, plugin.dispachApi)
        if (ok === undefined) throw pluginApiRangeUnreadable(plugin.name, plugin.dispachApi)
        if (!ok) throw pluginApiMismatch(plugin.name, plugin.dispachApi, VERSION)

        const registered: string[] = []
        const context: PluginContext = {
            defineChannel: (id, factory) => {
                channels[id] = factory
                registered.push(`channel:${id}`)
            },
            defineToolProvider: (id, factory) => {
                toolProviders[id] = factory
                registered.push(`toolProvider:${id}`)
            },
            defineScriptRunner: (runner) => {
                scriptRunner = runner
                registered.push("scriptRunner")
            },
            use: (entry) => {
                middleware.push(entry)
                registered.push(`middleware:${entry.name}`)
            },
            config: validateConfig(plugin, config),
            agentId: options.agentId,
            paths: options.paths,
            env: options.env,
            logger: options.logger ?? SILENT_LOGGER,
            events: options.bus,
        }

        const started = performance.now()
        try {
            await plugin.setup(context)
        } catch (error) {
            throw pluginSetupFailed(plugin.name, error)
        }
        const setupMs = Math.round((performance.now() - started) * 100) / 100

        const entry: LoadedPlugin = {
            name: plugin.name,
            version: plugin.version,
            spec,
            setupMs,
            permissions: plugin.permissions ?? [],
            registered,
        }
        loaded.push(entry)

        options.bus.emit(
            "plugin.loaded",
            {
                name: plugin.name,
                version: plugin.version,
                setupMs,
                permissions: entry.permissions.map((permission) => permission.kind),
            },
            { agentId: options.agentId },
        )
        // Reported rather than refused. A slow `setup` is usually one doing work it should have left
        // to a factory, and naming it is what makes that visible — a refusal would turn a
        // performance smell into an agent that will not start.
        if (setupMs > SETUP_BUDGET_MS) {
            options.bus.emit(
                "plugin.slow",
                { name: plugin.name, setupMs },
                { agentId: options.agentId },
            )
        }
    }

    return { toolProviders, channels, scriptRunner, middleware, loaded }
}

/**
 * One agent's plugins and the supply they produce — the function `Runtime.create` and `validate`
 * both call.
 *
 * It exists because they disagreed. `validate` checked `tools.providers` against the host's static
 * table while `run` checked it against the table *plus* whatever the manifest's plugins registered,
 * so a manifest naming a third-party provider booted fine and was reported broken:
 *
 *     validate  tools.providers.metrics names "metrics", which is not registered here.
 *     run       (boots, resolves the provider, works)
 *
 * That is the recorded shape — a check only one of them performs is a check they disagree about —
 * and in this direction it is the worse half, because it tells somebody their working agent is
 * misconfigured. Anything load-bearing goes in one function both call.
 */
export interface AgentPluginSupply {
    readonly toolProviders: Readonly<Record<string, ToolProviderFactory>>
    readonly channels: Readonly<Record<string, ChannelFactory>>
    readonly scriptRunner: ScriptRunner | undefined
    readonly middleware: readonly Middleware[]
    readonly loaded: readonly LoadedPlugin[]
}

export interface AgentPluginSupplyOptions {
    /** Raw `plugins:` entries, from a header read or an object manifest. */
    readonly refs: readonly (string | { spec: string; config?: Record<string, unknown> })[]
    readonly agentId: string
    readonly paths: PluginPaths
    readonly env: EnvSource
    readonly bus: EventBus
    readonly builtIn?: BuiltInPlugins
    readonly importModule?: (specifier: string) => Promise<unknown>
    /** What the host registered directly. Plugin registrations layer over these. */
    readonly base?: {
        readonly toolProviders?: Readonly<Record<string, ToolProviderFactory>>
        readonly channels?: Readonly<Record<string, ChannelFactory>>
        readonly scriptRunner?: ScriptRunner
    }
}

export async function agentPluginSupply(
    options: AgentPluginSupplyOptions,
): Promise<AgentPluginSupply> {
    const base = options.base ?? {}
    if (options.refs.length === 0) {
        return {
            toolProviders: base.toolProviders ?? {},
            channels: base.channels ?? {},
            scriptRunner: base.scriptRunner,
            middleware: [],
            loaded: [],
        }
    }

    const result = await loadPlugins({
        refs: options.refs.map((ref) =>
            typeof ref === "string" ? ref : { spec: ref.spec, config: ref.config ?? {} },
        ),
        agentId: options.agentId,
        paths: options.paths,
        env: options.env,
        bus: options.bus,
        ...(options.builtIn === undefined ? {} : { builtIn: options.builtIn }),
        ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
    })

    // Plugin registrations layer **over** the host's, so a manifest naming a plugin can replace a
    // host default rather than being shadowed by it. Manifest order already decided which plugin
    // wins a key, inside `loadPlugins`.
    return {
        toolProviders: { ...(base.toolProviders ?? {}), ...result.toolProviders },
        channels: { ...(base.channels ?? {}), ...result.channels },
        scriptRunner: result.scriptRunner ?? base.scriptRunner,
        middleware: result.middleware,
        loaded: result.loaded,
    }
}
