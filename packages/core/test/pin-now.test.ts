/**
 * A tool pinned mid-turn is callable on the next step when a provider has it cached, and the agent
 * reloads once the turn ends so it is pinned for good (pilot.14, VelaCrew). Asserted at the far end:
 * the second request lists the tool, its handler ran, and `agent.reloaded` fired.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type AnyEvent,
    BRAND,
    type ChatChunk,
    type ChatRequest,
    type ModelTransport,
    Runtime,
    type Tool,
    type ToolProviderFactory,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

function tool(slug: string, handler: Tool["handler"]): Tool {
    return {
        spec: {
            slug,
            provider: "cache",
            summary: `The ${slug} tool.`,
            whenToUse: "When asked.",
            whenNotToUse: "Otherwise.",
            mutating: false,
            tags: [],
            parameters: { type: "object", properties: {} },
        },
        handler,
    }
}

describe("a tool pinned in the middle of a turn", () => {
    test("is callable on the next step, and the agent reloads after the turn", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pin-now-"))
        const path = join(dir, "agent.yaml")
        writeFileSync(
            path,
            `apiVersion: ${BRAND.apiVersion}
id: pinner
model:
  main:
    id: scripted
    api: scripted
    capabilities:
      nativeTools: true
tools:
  dialect: native
  providers:
    cache: {}
  pinned: [pin_it]
limits:
  turnTimeoutMs: 5000
`,
        )
        let lateRan = false
        const cache: ToolProviderFactory = () => ({
            id: "cache",
            resolve: async (slugs) =>
                [
                    tool("pin_it", async (_args, context) => {
                        // What config_set does: write the pin, then ask for it now.
                        writeFileSync(
                            path,
                            readFileSync(path, "utf8").replace(
                                "pinned: [pin_it]",
                                "pinned: [pin_it, late_tool]",
                            ),
                        )
                        const added = (await context.pinTools?.(["pin_it", "late_tool"])) ?? []
                        return `added: ${added.join(", ")}`
                    }),
                    tool("late_tool", async () => {
                        lateRan = true
                        return "late ok"
                    }),
                ].filter((candidate) => slugs.includes(candidate.spec.slug)),
        })
        const requests: ChatRequest[] = []
        const scripted: ModelTransport = {
            create: (context) => ({
                id: context.id,
                async *chat(request): AsyncIterable<ChatChunk> {
                    requests.push(request)
                    const step = requests.length
                    if (step === 1 || step === 2) {
                        yield {
                            type: "tool_call",
                            call: {
                                id: `c${step}`,
                                name: step === 1 ? "pin_it" : "late_tool",
                                arguments: "{}",
                            },
                        }
                        yield { type: "finish", reason: "tool_calls" }
                        return
                    }
                    yield { type: "text", delta: "done" }
                    yield { type: "finish", reason: "stop" }
                },
            }),
        }
        const runtime = await Runtime.create({
            agents: [path],
            env: {},
            store: ":memory:",
            modelTransports: { scripted },
            toolProviders: { cache },
        })
        const events: AnyEvent[] = []
        runtime.bus.on("*", (event) => events.push(event))
        const result = await runtime.agent("pinner").send("enable the late tool and use it")
        for (let i = 0; i < 100 && !events.some((e) => e.type === "agent.reloaded"); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const reloaded = events.find((event) => event.type === "agent.reloaded")
        const pinnedAfter = runtime.agent("pinner").tools.has("late_tool")
        await runtime.stop()

        expect(result.text).toBe("done")
        expect(requests[0]?.tools?.map((spec) => spec.name)).toEqual(["pin_it"])
        expect(requests[1]?.tools?.map((spec) => spec.name)).toContain("late_tool")
        expect(lateRan).toBe(true)
        expect((reloaded?.data as { ok?: boolean } | undefined)?.ok).toBe(true)
        expect(pinnedAfter).toBe(true)
    })
})
