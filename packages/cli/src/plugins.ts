/**
 * `plugins` — what an agent's `plugins:` actually loaded.
 *
 * The surface decision 7.5 promised: `permissions` is advisory vocabulary, recorded and **surfaced**,
 * and a vocabulary nobody can read is a vocabulary nobody declares accurately. So this prints the
 * declarations beside what each plugin registered, which together answer the only two questions
 * worth asking of a plugin list — what did naming this buy me, and what did it ask for.
 *
 * Built as a command rather than a line in `validate` because the answer is per agent and includes
 * timing: `plugin.loaded` fires during boot, before anything can subscribe, so the runtime carries
 * the report and this reads it.
 */

import { Runtime } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import {
    BUILT_IN_PLUGIN_SPECS,
    BUILT_IN_PLUGINS,
    CHANNELS,
    scriptRunner,
    TOOL_PROVIDERS,
} from "#lib/providers"
import { keyValue, type Row } from "#lib/render"
import { storePath } from "#lib/sandbox"
import type { PluginsOptions } from "#lib/schema"

export async function pluginsCommand(options: PluginsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        toolProviders: TOOL_PROVIDERS,
        builtInPlugins: BUILT_IN_PLUGINS,
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv([options.manifestPath]),
        store: storePath(),
        lease: false,
    })
    onExit(() => runtime.stop("cli-exit"))

    const loaded = [...runtime.plugins.values()].flat()

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ plugins: loaded, available: BUILT_IN_PLUGIN_SPECS }, null, 2)}\n`,
        )
        return EXIT_OK
    }

    if (loaded.length === 0) {
        // Names what could be written rather than printing an empty table. A capability reachable
        // only by somebody who already knows the field names is a capability the surface is hiding —
        // the same reason `init` asks about every provider the runtime has.
        process.stdout.write(
            `No plugins. This binary can resolve these by name:\n\n${BUILT_IN_PLUGIN_SPECS.map(
                (spec) => `  - "${spec}"`,
            ).join("\n")}\n\nAdd a \`plugins:\` block to agent.yaml naming the ones you want.\n`,
        )
        return EXIT_OK
    }

    const rows: Row[] = loaded.map((plugin) => ({
        label: plugin.name,
        value: `${plugin.version}  ${`${plugin.setupMs} ms`.padStart(9)}`,
        note: plugin.registered.length === 0 ? "registered nothing" : plugin.registered.join(", "),
    }))
    process.stdout.write(`${keyValue(rows)}\n`)

    // Printed separately, and only when something declared one. Advisory in v1 — the line says so,
    // because a permission list that reads as enforcement is worse than none: it invites the belief
    // that installing a plugin is bounded by what it declared.
    const declaring = loaded.filter((plugin) => plugin.permissions.length > 0)
    if (declaring.length > 0) {
        process.stdout.write("\nDeclared access — advisory in v1, recorded and not enforced:\n")
        for (const plugin of declaring) {
            for (const permission of plugin.permissions) {
                const detail =
                    permission.kind === "network"
                        ? permission.hosts.join(", ")
                        : permission.kind === "env"
                          ? permission.vars.join(", ")
                          : permission.kind === "fs"
                            ? `${permission.paths.join(", ")} (${permission.mode})`
                            : permission.kind === "exec"
                              ? permission.commands.join(", ")
                              : permission.tables.join(", ")
                process.stdout.write(`  ${plugin.name}  ${permission.kind}  ${detail}\n`)
            }
        }
    }
    return EXIT_OK
}
