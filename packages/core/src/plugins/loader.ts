/**
 * Resolving a manifest's `plugins:` into an agent's capabilities.
 *
 * ## Resolution order, and why a built-in registry exists at all
 *
 * A bare specifier is looked up in a **built-in registry** first, then in the host's plugin root, and
 * only then imported; a relative path is only ever a path. The registry is not a shortcut — it is what
 * lets `@dispach/channel-telegram` appear in a manifest and resolve to the copy the binary already
 * bundles.
 *
 * The middle lookup is what `plugins add` installs into: `<pluginRoot>/<name>/` and the `main` its
 * package.json names. It sits between the two because a host's own bundled copy must always win — a
 * vendored directory shadowing `@dispach/channel-telegram` would load a second copy of a package that
 * is already in the binary — and because `import()` has to stay last, since it is the only lookup that
 * can reach a `node_modules` the operator installed themselves. `LoadedPlugin.lookup` records which
 * one answered, so "which code is loaded" has an answer that is not a guess.
 *
 * A plugin installed there is **one self-contained bundle**: nothing installs dependencies, ever, so
 * the compiled binary and the container — neither of which has a `node_modules` — resolve a plugin
 * exactly as a checkout does. `plugins add` is what refuses a tree that would need an install; by the
 * time this runs, a directory is either enterable or a refusal.
 *
 * The alternative was importing everything dynamically, and it is unavailable for a structural
 * reason rather than a preference: a module imported both statically and dynamically makes
 * `bun build --splitting` emit its exports twice, and the resulting bundle does not parse
 * (`SyntaxError: Duplicate export`). The CLI statically imports the first-party packages to register
 * them, so a loader that also `import()`ed them by name would produce a binary that fails to start —
 * and `bun test` walks straight past it, because tests import source and the failure is in the
 * bundle. The registry keeps each module imported exactly one way.
 *
 * What an embedder supplies as built-ins is therefore the same list the binary bundles. A spec in none
 * of the three lookups is refused, never fetched: hard rule 5.
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

import { existsSync, readFileSync } from "node:fs"
import { join, resolve as resolvePath, sep } from "node:path"
import {
    type ErrorDetail,
    isHarnessError,
    pluginApiMismatch,
    pluginApiRangeUnreadable,
    pluginConfigInvalid,
    pluginEntryMissing,
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

/** Which of the three lookups answered for a spec. Reported by `plugins`. */
export type PluginLookup = "registry" | "installed" | "import"

export interface LoadPluginsOptions {
    readonly refs: readonly PluginRef[]
    readonly builtIn?: BuiltInPlugins
    /**
     * Directory holding installed plugins, one per subdirectory, or absent to skip that lookup.
     *
     * Supplied by the host rather than derived here, for the reason every sandbox path in this project
     * is: one module owns them (`cli/src/lib/sandbox.ts`) so a test can redirect them, and a second
     * derivation is how one command writes where another does not look.
     */
    readonly pluginRoot?: string
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
    /**
     * What did not load, and why.
     *
     * **A plugin is optional and a broken one is a warning, not a dead agent.** This used to throw,
     * so a plugin directory somebody deleted, a version skew, or a `setup` that threw made the whole
     * agent unstartable — and the capability it would have supplied is by definition one the agent
     * did not have a minute earlier either. Whatever *selected* that capability still reports: a
     * `channels[].type` it would have registered degrades to a broken channel, and a tool provider
     * it would have registered is named as unregistered.
     *
     * Not silent: each detail reaches `agent.warnings`, `validate` prints it, and `plugins list`
     * names it. Silence was the objection to skipping; refusing to start was the cost.
     */
    readonly failed: readonly ErrorDetail[]
}

export interface LoadedPlugin {
    readonly name: string
    readonly version: string
    readonly spec: string
    readonly setupMs: number
    readonly permissions: readonly Permission[]
    /** What this plugin registered, so `plugins` can say what naming it actually bought. */
    readonly registered: readonly string[]
    /** Which lookup answered — the registry, the plugin root, or a module import. */
    readonly lookup: PluginLookup
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

/**
 * The entry file of an installed plugin, or `undefined` when there is no directory to enter.
 *
 * Bare names only, and the `/` test is the guard rather than a tidiness rule: a spec is a string
 * from a manifest, and `../../anything` under `join` would walk straight out of the root. A scoped
 * name contains a separator too, which is correct — `@dispach/channel-telegram` belongs to the
 * registry above or to `import()` below, never to a vendored directory shadowing the binary's own copy.
 *
 * A directory that exists and cannot be entered throws instead of falling through. `import()` would
 * then report "cannot find module dispach-whatsapp", which sends a reader to a package registry when
 * the problem is a half-fetched directory.
 */
function installedEntry(spec: string, root: string): string | undefined {
    if (spec.startsWith(".") || spec.includes("/") || spec.includes("\\")) return undefined
    const dir = join(root, spec)
    if (!existsSync(dir)) return undefined

    let main = "index.js"
    const packageFile = join(dir, "package.json")
    if (existsSync(packageFile)) {
        let parsed: unknown
        try {
            parsed = JSON.parse(readFileSync(packageFile, "utf8"))
        } catch (cause) {
            throw pluginEntryMissing(
                spec,
                dir,
                `its package.json is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
            )
        }
        const field = (parsed as { main?: unknown } | null)?.main
        if (typeof field === "string" && field !== "") main = field
    }

    // Resolved before the containment test, for the reason `root.ts` already records: an unresolved
    // `<dir>/../../evil.js` passes a prefix test while landing nowhere near the directory.
    const entry = resolvePath(dir, main)
    const base = resolvePath(dir)
    if (entry !== base && !entry.startsWith(base + sep)) {
        throw pluginEntryMissing(spec, dir, `its \`main\` points outside the plugin directory`)
    }
    if (!existsSync(entry)) throw pluginEntryMissing(spec, dir, `${main} is not there`)
    return entry
}

async function resolve(
    spec: string,
    options: LoadPluginsOptions,
): Promise<{ plugin: Plugin; lookup: PluginLookup }> {
    const builtIn = options.builtIn ?? {}
    const direct = builtIn[spec]
    if (direct !== undefined) return { plugin: direct, lookup: "registry" }

    const importModule =
        options.importModule ?? ((specifier: string) => import(/* @vite-ignore */ specifier))
    // A relative path is resolved against the *manifest's* directory, never `process.cwd()` — the
    // same rule every other path in this runtime follows, and for the same reason: the working
    // directory belongs to whoever launched the process and moves depending on how they did it.
    const installed =
        options.pluginRoot === undefined ? undefined : installedEntry(spec, options.pluginRoot)
    const specifier =
        installed ??
        (spec.startsWith(".") ? new URL(spec, `file://${options.paths.manifest}`).pathname : spec)

    try {
        return {
            plugin: pluginFrom(spec, await importModule(specifier)),
            lookup: installed === undefined ? "import" : "installed",
        }
    } catch (error) {
        // A malformed plugin already carries its own explanation; re-wrapping it as "not found"
        // would replace a precise message with a vague one.
        if (error instanceof Error && error.name === "ConfigError") throw error
        throw pluginNotFound(spec, Object.keys(builtIn), error, options.pluginRoot)
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
    const failed: ErrorDetail[] = []
    let scriptRunner: ScriptRunner | undefined

    for (const ref of options.refs) {
        const { spec, config } = refParts(ref)

        // **Staged, and merged only once `setup` has returned.** A plugin whose setup throws
        // half-way would otherwise leave whatever it registered before the throw in place — a
        // partially loaded plugin, which is a worse state than an absent one and is invisible from
        // the outside. Nothing here is shared until the whole plugin has worked.
        const staged: {
            channels: Record<string, ChannelFactory>
            toolProviders: Record<string, ToolProviderFactory>
            middleware: Middleware[]
            scriptRunner: ScriptRunner | undefined
            registered: string[]
        } = {
            channels: {},
            toolProviders: {},
            middleware: [],
            scriptRunner: undefined,
            registered: [],
        }

        let entry: LoadedPlugin
        try {
            const { plugin, lookup } = await resolve(spec, options)

            const previous = bySpec.get(plugin.name)
            if (previous !== undefined) throw pluginNameCollision(plugin.name, [previous, spec])

            const ok = satisfies(VERSION, plugin.dispachApi)
            if (ok === undefined) throw pluginApiRangeUnreadable(plugin.name, plugin.dispachApi)
            if (!ok) throw pluginApiMismatch(plugin.name, plugin.dispachApi, VERSION)

            const registered = staged.registered
            const context: PluginContext = {
                defineChannel: (id, factory) => {
                    staged.channels[id] = factory
                    registered.push(`channel:${id}`)
                },
                defineToolProvider: (id, factory) => {
                    staged.toolProviders[id] = factory
                    registered.push(`toolProvider:${id}`)
                },
                defineScriptRunner: (runner) => {
                    staged.scriptRunner = runner
                    registered.push("scriptRunner")
                },
                use: (item) => {
                    staged.middleware.push(item)
                    registered.push(`middleware:${item.name}`)
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

            bySpec.set(plugin.name, spec)
            Object.assign(channels, staged.channels)
            Object.assign(toolProviders, staged.toolProviders)
            middleware.push(...staged.middleware)
            if (staged.scriptRunner !== undefined) scriptRunner = staged.scriptRunner

            entry = {
                name: plugin.name,
                version: plugin.version,
                spec,
                setupMs,
                permissions: plugin.permissions ?? [],
                registered,
                lookup,
            }
        } catch (error) {
            failed.push(
                isHarnessError(error)
                    ? error.toDetail()
                    : {
                          code: "plugin_load_failed",
                          message: `plugins names "${spec}", which did not load: ${
                              error instanceof Error ? error.message : String(error)
                          }`,
                          hint: "The agent starts without it. Anything selecting a capability it would have supplied — a `channels[].type`, a `tools.providers` entry — reports separately. `plugins list` names this, and `plugins add` re-fetches one that is installed.",
                          field: "plugins",
                      },
            )
            continue
        }
        loaded.push(entry)

        options.bus.emit(
            "plugin.loaded",
            {
                name: entry.name,
                version: entry.version,
                setupMs: entry.setupMs,
                permissions: entry.permissions.map((permission) => permission.kind),
            },
            { agentId: options.agentId },
        )
        // Reported rather than refused. A slow `setup` is usually one doing work it should have left
        // to a factory, and naming it is what makes that visible — a refusal would turn a
        // performance smell into an agent that will not start.
        if (entry.setupMs > SETUP_BUDGET_MS) {
            options.bus.emit(
                "plugin.slow",
                { name: entry.name, setupMs: entry.setupMs },
                { agentId: options.agentId },
            )
        }
    }

    return { toolProviders, channels, scriptRunner, middleware, loaded, failed }
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
    /** Plugins that did not load. See `LoadedPlugins.failed`. */
    readonly failed: readonly ErrorDetail[]
}

export interface AgentPluginSupplyOptions {
    /** Raw `plugins:` entries, from a header read or an object manifest. */
    readonly refs: readonly (string | { spec: string; config?: Record<string, unknown> })[]
    readonly agentId: string
    readonly paths: PluginPaths
    readonly env: EnvSource
    readonly bus: EventBus
    readonly builtIn?: BuiltInPlugins
    /** Where installed plugins live. See `LoadPluginsOptions.pluginRoot`. */
    readonly pluginRoot?: string
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
            failed: [],
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
        ...(options.pluginRoot === undefined ? {} : { pluginRoot: options.pluginRoot }),
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
        failed: result.failed,
    }
}
