/**
 * `agents` — what one or more manifests produce.
 *
 * Small, and it proves the runtime hosts N agents from one process. It was inline in the entry point
 * before, which is how it ended up being the one command whose flags the usage text never mentioned.
 */

import { processAlive, Runtime } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import { BUILT_IN_PLUGINS, CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { duration, keyValue, type Row } from "#lib/render"
import { storePath } from "#lib/sandbox"
import type { AgentsOptions } from "#lib/schema"

export async function agentsCommand(options: AgentsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [...options.manifestPaths],
        toolProviders: TOOL_PROVIDERS,
        builtInPlugins: BUILT_IN_PLUGINS,
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv(options.manifestPaths),
        // The shared store, so the lease rows below are visible at all — and `lease: false`, so
        // looking does not briefly claim one and refuse a `serve` starting in the same instant.
        store: storePath(),
        lease: false,
    })
    onExit(() => runtime.stop("cli-exit"))

    const described = runtime.list().map((agent) => agent.describe())
    // Whether anything is actually serving each one, read from the runtime lease. That row is
    // written by whichever process holds the agent, so this cannot disagree with reality the way a
    // separate registry would — and it answers in a container, where there is no service manager
    // to ask. A row is a claim rather than a fact, so the pid is checked before it is believed.
    const serving = new Map<string, string>()
    for (const lease of await runtime.store.leases.all()) {
        if (lease.runtimeId === runtime.runtimeId || !processAlive(lease.pid)) continue
        const since = Date.now() - Date.parse(lease.startedAt)
        serving.set(
            lease.agentId,
            `serving · ${lease.mode} · pid ${lease.pid}${
                Number.isFinite(since) ? ` · up ${duration(since)}` : ""
            }`,
        )
    }

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    agents: described.map((agent) => ({
                        ...agent,
                        serving: serving.get(agent.id) ?? null,
                    })),
                },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    // Padded columns, like every other command. This was the one place still emitting tabs, which
    // made the same product look like two depending on which command you had just run.
    const rows: Row[] = described.map((agent) => ({
        label: agent.id,
        value: `${agent.model}  ${String(agent.window).padStart(7)} window`,
        note: serving.get(agent.id) ?? agent.name,
    }))
    process.stdout.write(`${keyValue(rows)}\n`)
    return EXIT_OK
}
