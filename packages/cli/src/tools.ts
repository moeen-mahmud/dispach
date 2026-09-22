/**
 * The `tools` command: `<binary> tools <manifest> [--warm]`.
 *
 * Two jobs, and the split matters.
 *
 * Without `--warm` it boots the runtime and prints the catalogue the model will actually see. That is
 * the same view the in-session `/tools` command renders, from the same `toolsReport` — a second
 * formatter would eventually disagree with the first about what is pinned.
 *
 * With `--warm` it does **not** boot. It loads the manifest, constructs the provider directly, and
 * fetches every pinned slug into the resolution cache. Booting would be circular: a remote provider
 * resolves from disk so that nothing touches the network before `runtime.ready`, so an empty cache
 * fails the load on unresolved slugs — which means the post-readiness refresh that would have filled
 * the cache never runs. This command is how the cache gets its first contents.
 */

import { loadManifest, Runtime, resolveProviders } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { BUILT_IN_PLUGINS, CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { pluginRoot } from "#lib/sandbox"
import { toolsReport, toolsView } from "#lib/session-commands"

export interface ToolsOptions {
    readonly manifestPath: string
    readonly warm?: boolean
    readonly json?: boolean
}

interface WarmResult {
    readonly provider: string
    readonly fetched: number
    readonly changed: readonly string[]
    readonly missing: readonly string[]
    readonly cachePath: string
}

export async function toolsCommand(options: ToolsOptions): Promise<number> {
    return options.warm === true ? await warm(options) : await show(options)
}

async function warm(options: ToolsOptions): Promise<number> {
    const loaded = loadManifest(options.manifestPath, {
        env: ambientEnv([options.manifestPath]),
    })
    const selections = resolveProviders(loaded.manifest.tools).selections
    const pinned = loaded.manifest.tools.pinned

    if (selections.length === 0) {
        // Not an error worth exiting 1 for, but saying nothing would leave someone waiting for a
        // network call that was never going to happen.
        process.stdout.write(
            "nothing to warm — this manifest configures no tools.providers, so every tool it pins resolves locally.\n",
        )
        return EXIT_OK
    }
    if (pinned.length === 0) {
        process.stdout.write(
            `nothing to warm — ${selections.map((entry) => entry.id).join(", ")} configured but tools.pinned is empty, so there are no schemas to fetch.\n`,
        )
        return EXIT_OK
    }

    const results: WarmResult[] = []
    /** Slugs some configured provider can serve after this run. Not per provider — see below. */
    const covered = new Set<string>()

    // Every configured provider, not the first: with `system` listed before `composio` — which is the
    // order anyone would write them in — warming only the first would print "nothing to warm" and
    // leave the cold cache that fails the next boot.
    for (const selection of selections) {
        // `loadManifest` already refused an unregistered id, so this is present.
        const factory = TOOL_PROVIDERS[selection.id]
        if (factory === undefined) return EXIT_FAILURE

        const provider = factory({
            dir: loaded.dir,
            env: loaded.env,
            config: selection.config,
            agentId: loaded.manifest.id,
        })

        if (provider.refresh === undefined) {
            // Nothing to fetch, but it still answers for its own slugs — and without asking, every
            // `exec` and `file_read` in `pinned` would be reported missing by a command that only
            // ever looked at the provider with a cache.
            for (const tool of await provider.resolve(pinned)) covered.add(tool.spec.slug)
            if (options.json !== true) {
                process.stdout.write(
                    `${selection.id}: nothing to warm — it resolves without a cache.\n`,
                )
            }
            continue
        }

        const report = await provider.refresh(pinned)
        for (const slug of pinned) {
            if (!report.missing.includes(slug)) covered.add(slug)
        }
        results.push({
            provider: selection.id,
            fetched: report.fetched,
            changed: [...report.changed],
            missing: [...report.missing],
            cachePath:
                "cachePath" in report && typeof report.cachePath === "string"
                    ? report.cachePath
                    : "",
        })
    }

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
    } else {
        for (const result of results) {
            process.stdout.write(
                `${result.fetched} of ${pinned.length} pinned tools fetched from ${result.provider}\n`,
            )
            if (result.changed.length > 0) {
                process.stdout.write(`  changed: ${result.changed.join(", ")}\n`)
            }
            if (result.cachePath !== "") process.stdout.write(`  cache: ${result.cachePath}\n`)
        }
    }

    // A slug no provider has is a manifest error, and exiting 0 here would let it through to a load
    // failure on the next start — after the person believed this had succeeded. Reported against the
    // *set*: with two providers configured, a slug only one of them has is not missing at all, and
    // the per-provider `missing` lists would each blame the other's tools.
    const missing = pinned.filter((slug) => !covered.has(slug))
    for (const slug of missing) {
        process.stdout.write(
            `  missing: ${slug} — no configured provider has a tool with that slug\n`,
        )
    }
    return missing.length > 0 ? EXIT_FAILURE : EXIT_OK
}

async function show(options: ToolsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        toolProviders: TOOL_PROVIDERS,
        builtInPlugins: BUILT_IN_PLUGINS,
        pluginRoot: pluginRoot(),
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv([options.manifestPath]),
    })
    try {
        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("The manifest produced no agent.")

        const view = toolsView(agent)
        process.stdout.write(
            options.json === true ? `${JSON.stringify(view, null, 2)}\n` : `${toolsReport(view)}\n`,
        )
        return EXIT_OK
    } finally {
        await runtime.stop("cli-exit")
    }
}
