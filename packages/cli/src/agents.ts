/**
 * `agents` — what is in the sandbox, and whether anything is serving it.
 *
 * Bare, it lists every agent the sandbox holds: the question "what agents do I have" had no
 * command until 0.1.3 — `agents` required manifest paths, `serve` defaulted to the sandbox, and
 * the listing lived only inside `run`'s picker. Given paths or names, it boots a runtime over them
 * and describes each in full, which is the older shape and still the one that proves one process
 * hosts N agents.
 */

import { processAlive, Runtime } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import { agentStateOf, liveHosts } from "#lib/lifecycle"
import { BUILT_IN_PLUGINS, CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { duration, keyValue, type Row } from "#lib/render"
import { listAgents, pluginRoot, type SandboxAgent, storePath } from "#lib/sandbox"
import type { AgentsOptions } from "#lib/schema"

export interface SandboxAgentStatus extends SandboxAgent {
    /** `false` when `stop <agent>` switched it off durably. */
    readonly enabled: boolean
    readonly reason?: string
    /** `serving · <mode> · pid N · up …` from the lease, when a live process holds it. */
    readonly serving?: string
    readonly pid?: number
}

/** Every sandbox agent with its durable switch and its live host, from the lease table. */
export async function sandboxAgents(store?: string): Promise<readonly SandboxAgentStatus[]> {
    const hosts = await liveHosts(store)
    const out: SandboxAgentStatus[] = []
    for (const agent of listAgents()) {
        const id = agent.id ?? agent.ref
        const state = (await agentStateOf(id, store)) ?? { enabled: true }
        const lease = hosts.find((row) => row.agentId === id)
        const since = lease === undefined ? Number.NaN : Date.now() - Date.parse(lease.startedAt)
        out.push({
            ...agent,
            enabled: state.enabled,
            ...(state.reason === undefined ? {} : { reason: state.reason }),
            ...(lease === undefined
                ? {}
                : {
                      pid: lease.pid,
                      serving: `serving · ${lease.mode} · pid ${lease.pid}${
                          Number.isFinite(since) ? ` · up ${duration(since)}` : ""
                      }`,
                  }),
        })
    }
    return out
}

export function agentRows(agents: readonly SandboxAgentStatus[]): readonly Row[] {
    if (agents.length === 0) {
        return [{ label: "agents", value: "none in the sandbox", note: "init creates one" }]
    }
    return agents.map((agent) => ({
        label: agent.ref,
        value: agent.problem !== undefined ? "broken" : agent.enabled ? "on" : "off",
        note:
            agent.problem ??
            agent.serving ??
            (agent.enabled
                ? `not hosted${agent.modelId === undefined ? "" : ` · ${agent.modelId}`}`
                : `switched off${agent.reason === undefined ? "" : ` — ${agent.reason}`}`),
    }))
}

export async function agentsCommand(options: AgentsOptions): Promise<number> {
    if (options.manifestPaths.length === 0) {
        const agents = await sandboxAgents(options.store)
        if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ agents }, null, 2)}\n`)
        } else {
            process.stdout.write(`${keyValue(agentRows(agents))}\n`)
        }
        return EXIT_OK
    }

    const runtime = await Runtime.create({
        agents: [...options.manifestPaths],
        toolProviders: TOOL_PROVIDERS,
        builtInPlugins: BUILT_IN_PLUGINS,
        pluginRoot: pluginRoot(),
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv(options.manifestPaths),
        // The shared store, so the lease rows below are visible at all — and `lease: false`, so
        // looking does not briefly claim one and refuse a `serve` starting in the same instant.
        store: options.store ?? storePath(),
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
