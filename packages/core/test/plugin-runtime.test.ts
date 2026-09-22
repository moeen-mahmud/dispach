/**
 * Plugins through a real `Runtime.create` — the part the loader's unit tests cannot prove.
 *
 * The claim under test is not "the loader returns a map". It is that a manifest naming a plugin gets
 * a capability it would otherwise be **refused** for naming, which means the plugin phase has to run
 * before the manifest is validated. That ordering is invisible in a unit test and is the whole
 * structural change in Phase 9A: `loadManifest` checks `tools.providers` and a channel `type` against
 * the ids this host supplies, and once plugins exist half of those ids arrive from the manifest
 * itself. The negative case is therefore as load-bearing as the positive one — without it, a test
 * could pass because the host happened to register the same id directly.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { Plugin } from "../src/plugins/plugin.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { Tool, ToolProvider } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }

function workspace(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "plugin-runtime-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
  files:
    - IDENTITY.md
${body}`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
    return dir
}

/** A provider supplying one tool, so the catalogue can be asserted rather than the map. */
function fixtureProvider(): ToolProvider {
    const tool: Tool = {
        spec: {
            slug: "ping",
            provider: "fixture",
            summary: "Returns pong.",
            whenToUse: "never — this is a fixture",
            whenNotToUse: "always",
            mutating: false,
            tags: [],
            parameters: { type: "object", properties: {}, required: [] },
        },
        handler: async () => "pong",
    }
    return {
        id: "fixture",
        resolve: async (slugs) => (slugs.includes("ping") ? [tool] : []),
        list: async () => ["ping"],
    }
}

const FIXTURE_PLUGIN: Plugin = {
    name: "fixture",
    version: "1.0.0",
    dispachApi: "^0.1",
    permissions: [{ kind: "network", hosts: ["example.invalid"] }],
    setup(context) {
        context.defineToolProvider("fixture", () => fixtureProvider())
    },
}

const USES_PLUGIN = `plugins:
  - "@fixture/tools"
tools:
  providers:
    fixture: {}
  pinned:
    - ping
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`

describe("a manifest that names a plugin", () => {
    test("gets the provider the plugin registered", async () => {
        const dir = workspace(USES_PLUGIN)
        const events: AnyEvent[] = []
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            builtInPlugins: { "@fixture/tools": FIXTURE_PLUGIN },
            fetch: async () => new Response("{}"),
        })
        runtime.bus.on("*", (event) => events.push(event))

        const agent = runtime.agent("test")
        expect(agent.tools?.specs().map((spec) => spec.slug)).toContain("ping")
        await runtime.stop()
    })

    test("and warns for the same manifest with the plugins: line removed", async () => {
        // The negative half, and it has to remove the *plugins* line rather than the built-in
        // registry. Dropping only the registry fails at `plugin_not_found` — a different finding —
        // which would prove the loader can miss a module and nothing about where the ids come from.
        // Written the wrong way first, and caught by reading the code the refusal actually carried.
        const dir = workspace(USES_PLUGIN.replace('plugins:\n  - "@fixture/tools"\n', ""))
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async () => new Response("{}"),
        })
        // The id is unknown because nothing supplied it — which is exactly what the plugin supplies
        // in the test above. A warning rather than a refusal since 0.1.3: an agent starts if it can
        // take a turn, and a tool provider is not part of that.
        const agent = runtime.agent("test")
        expect(agent?.warnings.some((w) => w.field === "tools.providers.fixture")).toBe(true)
        expect(agent?.tools.specs().map((spec) => spec.slug)).not.toContain("ping")
        await runtime.stop()
    })

    test("a plugin spec that resolves to nothing is its own warning, and the agent starts", async () => {
        /**
         * A plugin is optional, so this is a warning rather than a refusal — the agent starts
         * without whatever it would have registered, which is what stops a deleted plugin
         * directory from making an agent unstartable.
         *
         * Three findings rather than one, and the chain is the point: `plugin_not_found` is the
         * *cause*, `tool_provider_unknown` is what it cost, and the pinned slug that provider would
         * have answered for is reported unresolved. Collapsing them would leave a reader with a
         * plugin failure and no idea what it cost, or a missing tool with no idea why.
         */
        const dir = workspace(USES_PLUGIN)
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async () => new Response("{}"),
        })
        const codes = runtime.agent("test")?.warnings.map((warning) => warning.code) ?? []
        expect(codes).toContain("plugin_not_found")
        expect(codes).toContain("tool_provider_unknown")
        expect(runtime.agent("test")?.tools.warnings.map((w) => w.code)).toContain("unknown_tool")
        await runtime.stop()
    })

    test("emits plugin.loaded on the bus that was passed in", async () => {
        // Boot events fire inside `create`, so a listener attached afterwards misses them — the
        // recorded empty-room trap. `RuntimeOptions.bus` exists for exactly this.
        const { EventBus } = await import("../src/events/bus.ts")
        const bus = new EventBus({ runtimeId: "test" })
        const events: AnyEvent[] = []
        bus.on("*", (event) => events.push(event))

        const dir = workspace(USES_PLUGIN)
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            bus,
            builtInPlugins: { "@fixture/tools": FIXTURE_PLUGIN },
            fetch: async () => new Response("{}"),
        })

        const loaded = events.find((event) => event.type === "plugin.loaded")
        expect(loaded).toBeDefined()
        expect((loaded?.data as { name: string } | undefined)?.name).toBe("fixture")
        expect(loaded?.agentId).toBe("test")
        await runtime.stop()
    })
})

describe("what naming no plugins costs", () => {
    test("the phase runs and reports, and an agent without plugins is unaffected", async () => {
        const dir = workspace("limits:\n  maxSteps: 2\n  turnTimeoutMs: 5000\n")
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async () => new Response("{}"),
        })
        // Present rather than absent: a phase that vanishes when unused is a phase whose cost
        // nobody notices when it stops being unused.
        expect(runtime.boot.phases.plugins).toBeDefined()
        expect(runtime.boot.phases.plugins).toBeLessThan(5)
        await runtime.stop()
    })
})

describe("middleware through a real turn", () => {
    /**
     * The claim the unit tests cannot make: that a plugin's `use()` reaches the loop.
     *
     * Every layer between is a conditional spread — `TurnInput.middleware`, `AgentOptions.middleware`,
     * `AgentSupply.middleware` — which is the shape that has cost this repo six debugging rounds, and
     * each one type-checks while dropping the value. So this asserts at the far end: a middleware that
     * short-circuits a turn, observed through what `send` actually returns.
     */
    const MIDDLEWARE_PLUGIN: Plugin = {
        name: "gate",
        version: "1.0.0",
        dispachApi: "^0.1",
        setup(context) {
            context.use({
                name: "refuse-everything",
                async wrapTurn() {
                    return { text: "refused by middleware", reason: "error", steps: 0 }
                },
            })
        },
    }

    test("a plugin's wrapTurn short-circuits a real send", async () => {
        const dir = workspace(`plugins:
  - "@fixture/gate"
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`)
        let called = false
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            builtInPlugins: { "@fixture/gate": MIDDLEWARE_PLUGIN },
            fetch: async () => {
                called = true
                return new Response("{}")
            },
        })

        const result = await runtime.agent("test").send("hello")
        expect({ text: result.text, endpointCalled: called }).toEqual({
            text: "refused by middleware",
            endpointCalled: false,
        })
        await runtime.stop()
    })

    test("registering middleware shows up in what the plugin registered", async () => {
        const dir = workspace(`plugins:
  - "@fixture/gate"
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`)
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            builtInPlugins: { "@fixture/gate": MIDDLEWARE_PLUGIN },
            fetch: async () => new Response("{}"),
        })
        expect(runtime.plugins.get("test")?.[0]?.registered).toEqual([
            "middleware:refuse-everything",
        ])
        await runtime.stop()
    })
})
