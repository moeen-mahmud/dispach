/**
 * A refused reply ends the turn as an error (pilot.6). `content_filter` is chat-completions' finish
 * reason for it and the Bedrock transport's for a refusal or a guardrail; recorded as the answer, a
 * refusal that returned no text was an empty `final` turn that exited 0.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { resolveCapabilities } from "../src/model/capabilities.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { expect, test } from "./_harness.ts"

test("a content_filter finish ends the turn as model_refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-refused-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
    )
    const fetch: FetchLike = async () => {
        const frame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "k" },
        fetch,
    })
    const result = await runtime.agent("test")?.send("something refused", { sessionKey: "api:r" })
    await runtime.stop()
    expect(result?.reason).toBe("error")
    expect(result?.error?.code).toBe("model_refused")
})

test("a gpt-6 id on Bedrock resolves to its own row", () => {
    const capabilities = resolveCapabilities("global.openai.gpt-6-luna")
    expect(capabilities.contextWindow).toBe(1_050_000)
    expect(capabilities.maxOutput).toBe(128_000)
    expect(capabilities.nativeTools).toBe(true)
})
