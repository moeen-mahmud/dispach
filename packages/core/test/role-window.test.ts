/**
 * A turn on another model role is budgeted against that role's window (pilot.7, VelaCrew): a schedule
 * or a message on a small model, sized against a large main, overflowed it; the reverse compacted for
 * nothing. Read off `context.pressure`, which carries the budget the turn assembled against.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { expect, test } from "./_harness.ts"

test("a role's turn is budgeted against its own model's window, main's against main's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "role-window-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  small:
    id: tiny-model
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    capabilities:
      contextWindow: 16000
context:
  reserveOutput: 1000
`,
    )
    const fetch: FetchLike = async () => {
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "k" },
        fetch,
    })
    const budgets: number[] = []
    runtime.bus.on("context.pressure", (event) =>
        budgets.push((event.data as { budget: number }).budget),
    )
    const agent = runtime.agent("test")
    await agent?.send("hi", { sessionKey: "api:a", role: "small" })
    const small = budgets.at(-1)
    await agent?.send("hi", { sessionKey: "api:b" })
    const main = budgets.at(-1)
    await runtime.stop()

    expect(small).toBe(16000 - 1000)
    expect(main).toBe((agent?.window ?? 0) - 1000)
    expect(main).toBeGreaterThan(small ?? 0)
})
