/**
 * A provider configured through settings — the TUI editor, the web app, `PATCH /config` — is checked by
 * the provider before it is written, and its tools appear without a second reload once its cache warms.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type AnyEvent,
    BRAND,
    ConfigError,
    editManifest,
    Runtime,
    type ToolProviderFactory,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/** Refuses a config holding a credential in its URL, the way the MCP provider does. */
const strict: ToolProviderFactory = (context) => {
    const url = String((context.config as { url?: unknown }).url ?? "")
    if (url.includes("@")) {
        throw new ConfigError({
            code: "fake_config_invalid",
            message: "the url carries a credential",
            hint: "Name an env var instead.",
            field: "tools.providers.fake",
        })
    }
    return { id: "fake", resolve: async () => [] }
}

function manifestFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "provider-settings-"))
    const file = join(dir, "agent.yaml")
    writeFileSync(
        file,
        `apiVersion: ${BRAND.apiVersion}\nid: settings-agent\nmodel:\n  main:\n    id: m\n    baseUrl: http://127.0.0.1:9/v1\n${body}`,
    )
    return file
}

describe("the settings writer asks the provider", () => {
    test("a config the provider refuses is not written, and the provider's own error says why", async () => {
        const file = manifestFile("tools:\n  providers:\n    fake: { url: http://ok/mcp }\n")
        const before = readFileSync(file, "utf8")
        let code: string | undefined
        try {
            await editManifest({
                file,
                path: ["tools", "providers"],
                value: { fake: { url: "http://user:pw@host/mcp" } },
                providers: { fake: strict },
            })
        } catch (error) {
            code = (error as { code?: string }).code
        }
        expect(code).toBe("fake_config_invalid")
        expect(readFileSync(file, "utf8")).toBe(before)
    })

    test("an unknown provider id is refused, naming the ones there are", async () => {
        const file = manifestFile("")
        let message = ""
        try {
            await editManifest({
                file,
                path: ["tools", "providers"],
                value: { nope: {} },
                providers: { fake: strict },
            })
        } catch (error) {
            message = (error as Error).message
        }
        expect(message).toContain('"nope"')
        expect(message).toContain("fake")
    })

    test("a valid one is written; a caller with no factories keeps today's behaviour", async () => {
        const file = manifestFile("")
        await editManifest({
            file,
            path: ["tools", "providers"],
            value: { fake: { url: "http://ok/mcp" } },
            providers: { fake: strict },
        })
        expect(readFileSync(file, "utf8")).toContain("http://ok/mcp")
        await editManifest({
            file,
            path: ["tools", "providers"],
            value: { fake: { url: "http://user:pw@host/mcp" } },
        })
        expect(readFileSync(file, "utf8")).toContain("user:pw")
    })
})

describe("a provider whose cache warms after startup", () => {
    /** Resolves `late_tool` only once a refresh has run, like MCP or Composio on a cold cache. */
    function warming(refreshes: { count: number }, resolvable: boolean): ToolProviderFactory {
        return () => ({
            id: "warming",
            resolve: async (slugs) =>
                refreshes.count > 0 && resolvable && slugs.includes("late_tool")
                    ? [
                          {
                              spec: {
                                  slug: "late_tool",
                                  provider: "warming",
                                  summary: "A tool that arrives late.",
                                  whenToUse: "Always.",
                                  mutating: false,
                                  tags: [],
                                  parameters: { type: "object", properties: {} },
                              },
                              handler: async () => "ok",
                          },
                      ]
                    : [],
            list: async () => (refreshes.count > 0 ? ["late_tool"] : []),
            refresh: async () => {
                refreshes.count += 1
                return { fetched: 1, missing: [], changed: ["late_tool"] }
            },
        })
    }

    async function boot(resolvable: boolean) {
        const refreshes = { count: 0 }
        const file = manifestFile("tools:\n  providers:\n    warming: {}\n  pinned: [late_tool]\n")
        const events: AnyEvent[] = []
        const runtime = await Runtime.create({
            agents: [file],
            env: {},
            store: ":memory:",
            toolProviders: { warming: warming(refreshes, resolvable) },
        })
        runtime.bus.on("*", (event) => events.push(event))
        return { runtime, events, refreshes }
    }

    async function settle(until: () => boolean): Promise<void> {
        for (let i = 0; i < 200 && !until(); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
    }

    test("the agent reloads itself once, and the tool is there", async () => {
        const { runtime, events } = await boot(true)
        await settle(() => events.some((event) => event.type === "agent.reloaded"))
        const reloaded = events.find((event) => event.type === "agent.reloaded")
        expect((reloaded?.data as { ok?: boolean } | undefined)?.ok).toBe(true)
        expect(runtime.agent("settings-agent").tools.has("late_tool")).toBe(true)
        // The new instance refreshes too, finds nothing missing, and does not reload again.
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(events.filter((event) => event.type === "agent.reloaded").length).toBe(1)
        await runtime.stop()
    })

    test("a tool the provider lists and still cannot resolve costs one reload, not a loop", async () => {
        const { runtime, events } = await boot(false)
        await settle(() => events.some((event) => event.type === "agent.reloaded"))
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(events.filter((event) => event.type === "agent.reloaded").length).toBe(1)
        expect(runtime.agent("settings-agent").tools.has("late_tool")).toBe(false)
        await runtime.stop()
    })
})
