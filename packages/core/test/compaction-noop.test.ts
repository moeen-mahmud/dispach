/**
 * A compaction ladder that changes nothing must leave the turn's history alone.
 *
 * `runLadder` returns the array it was given when no stage changes anything, and the turn used to
 * clear its history and refill it from that same array, which emptied it. The trigger is ordinary: one
 * large result in the current turn pushes the prompt past `snip`, and `snip` and `micro` may not touch
 * the current turn's trace. The model then lost its own call and result and repeated the call until
 * `no_progress` ended the turn. Found running `eval:subagents` against an 8,192-token window.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { Tool } from "../src/tools/types.ts"
import { expect, test } from "./_harness.ts"

const RESULT = `RESULT-START ${"row of a long listing ".repeat(1000)}`

test("a large result in the current turn survives a ladder that cannot shrink it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compaction-noop-"))
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
tools:
  providers:
    work: {}
  pinned: [listing]
`,
    )
    const bodies: string[] = []
    const fetch: FetchLike = async (_url, init) => {
        bodies.push(String(init?.body ?? ""))
        const content = bodies.length === 1 ? "ACTION: listing\nEND" : "Read it."
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    const listing: Tool = {
        spec: {
            slug: "listing",
            provider: "work",
            summary: "A long listing.",
            whenToUse: "When asked.",
            whenNotToUse: "Otherwise.",
            mutating: false,
            tags: [],
            trust: "trusted",
            trustReason: "A test fixture.",
            parameters: { type: "object", properties: {} },
        },
        handler: () => RESULT,
    }
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "k" },
        fetch,
        toolProviders: { work: () => ({ id: "work", resolve: async () => [listing] }) },
    })
    const stages: string[] = []
    runtime.bus.on("compaction.stage", (event) =>
        stages.push((event.data as { stage: string }).stage),
    )

    const result = await runtime.agent("test")?.send("read the listing", { sessionKey: "api:c" })
    await runtime.stop()

    // The ladder did run, which is the condition this is about.
    expect(stages.length).toBeGreaterThan(0)
    expect(result?.reason).toBe("final")
    expect(bodies.length).toBe(2)
    expect(bodies[1]).toContain("ACTION: listing")
    expect(bodies[1]).toContain("RESULT-START")
})
