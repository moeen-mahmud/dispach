/**
 * `Runtime.refreshTools` (pilot.5, VelaCrew #20): fetch the providers now, reload only if what the
 * agent serves moved.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { AnyEvent } from "../src/events/types.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { Tool, ToolProviderFactory, ToolProviderRefresh } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

function tool(slug: string): Tool {
    return {
        spec: {
            slug,
            provider: "work",
            summary: `The ${slug} tool.`,
            whenToUse: "When asked.",
            whenNotToUse: "Otherwise.",
            mutating: false,
            tags: [],
            parameters: { type: "object", properties: {} },
        },
        handler: () => "ok",
    }
}

/** A provider whose catalogue the test changes between boot and the refresh. */
function work(state: { slugs: string[]; next?: ToolProviderRefresh }) {
    let refreshes = 0
    const factory: ToolProviderFactory = () => ({
        id: "work",
        resolve: async (slugs) => state.slugs.filter((slug) => slugs.includes(slug)).map(tool),
        list: async () => state.slugs,
        refresh: async () => {
            refreshes += 1
            return state.next ?? { fetched: state.slugs.length, changed: [], missing: [] }
        },
    })
    return { factory, refreshes: () => refreshes }
}

function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "tools-refresh-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  providers:
    work: {}
  pinned: [ticket_read, ticket_update]
`,
    )
    return join(dir, "agent.yaml")
}

async function boot(state: { slugs: string[]; next?: ToolProviderRefresh }) {
    const provider = work(state)
    const runtime = await Runtime.create({
        agents: [manifest()],
        env: { MODEL_API_KEY: "k" },
        toolProviders: { work: provider.factory },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("agent.tools.refreshed", (event) => events.push(event))
    return { runtime, events, provider }
}

const slugs = (runtime: Runtime) =>
    runtime
        .agent("test")
        ?.tools.specs()
        .map((spec) => spec.slug)

describe("refreshing an agent's tools", () => {
    test("nothing moved: nothing reloads, and the same instance keeps serving", async () => {
        const { runtime, events, provider } = await boot({
            slugs: ["ticket_read", "ticket_update"],
        })
        const before = runtime.agent("test")
        const outcome = await runtime.refreshTools("test")
        expect(outcome.reload).toBe("none")
        expect(runtime.agent("test")).toBe(before)
        expect(provider.refreshes()).toBeGreaterThan(0)
        expect(events.at(-1)?.data).toEqual({ added: [], removed: [], changed: [], reload: "none" })
        await runtime.stop()
    })

    test("a pinned tool the provider now has is added, and the agent reloads with it", async () => {
        // Cold at boot: `ticket_update` was pinned and nothing resolved it.
        const state: { slugs: string[] } = { slugs: ["ticket_read"] }
        const { runtime } = await boot(state)
        expect(slugs(runtime)).toEqual(["ticket_read"])

        state.slugs = ["ticket_read", "ticket_update"]
        const outcome = await runtime.refreshTools("test")
        expect(outcome.added).toEqual(["ticket_update"])
        expect(outcome.reload).toBe("loaded")
        expect(slugs(runtime)).toEqual(["ticket_read", "ticket_update"])
        await runtime.stop()
    })

    test("a changed schema reloads; an unknown provider is refused by name", async () => {
        const state = {
            slugs: ["ticket_read", "ticket_update"],
            next: { fetched: 2, changed: ["ticket_read"], missing: [] },
        }
        const { runtime } = await boot(state)
        const outcome = await runtime.refreshTools("test", { providers: ["work"] })
        expect(outcome.changed).toEqual(["ticket_read"])
        expect(outcome.reload).toBe("loaded")

        let code: string | undefined
        try {
            await runtime.refreshTools("test", { providers: ["composio"] })
        } catch (error) {
            code = (error as { code?: string }).code
        }
        expect(code).toBe("tools_refresh_provider_unknown")
        await runtime.stop()
    })

    test("a provider is never asked to refresh a slug another provider resolved (pilot.12)", async () => {
        // `work` owns the two tickets; a Composio-like provider resolves nothing it was not warmed
        // with. Before, it was handed both on every boot and reload and fetched each (a 404 apiece).
        const asked: string[][] = []
        const remote: ToolProviderFactory = () => ({
            id: "remote",
            resolve: async () => [],
            list: async () => [],
            refresh: async (slugs) => {
                asked.push([...slugs])
                return { fetched: 0, changed: [], missing: [...slugs] }
            },
        })
        const dir = mkdtempSync(join(tmpdir(), "tools-refresh-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  providers:
    work: {}
    remote: {}
  pinned: [ticket_read, ticket_update, NOT_YET_CACHED]
`,
        )
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_API_KEY: "k" },
            toolProviders: {
                work: work({ slugs: ["ticket_read", "ticket_update"] }).factory,
                remote,
            },
        })
        await new Promise((done) => setTimeout(done, 20))
        await runtime.refreshTools("test")
        await runtime.stop()
        // The boot refresh and the explicit one: only the slug nobody resolved, which is what lets a
        // refresh still heal a tool the cache did not have yet.
        expect(asked).toEqual([["NOT_YET_CACHED"], ["NOT_YET_CACHED"]])
    })
})
