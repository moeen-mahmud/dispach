/**
 * `GET /v1/agents/:id` carries the main model's resolved capabilities (0.2.2): the registry's row
 * for its id with the manifest's override laid over, which is what the console's override form
 * shows beside each field.
 */

import { afterAll, expect, test } from "bun:test"
import { cleanupWorkspaces, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

test("the detail reports the resolved capabilities, an override included", async () => {
    const { runtime, call } = await harness({
        manifest: `apiVersion: dispach/v1
id: assistant
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    capabilities:
      contextWindow: 32768
`,
    })
    const body = (await (await call("GET", "/v1/agents/assistant")).json()) as {
        window: number
        capabilities: { contextWindow: number; thinking: string; promptStyle: object }
    }
    expect(body.capabilities.contextWindow).toBe(32768)
    expect(typeof body.capabilities.thinking).toBe("string")
    expect(typeof body.capabilities.promptStyle).toBe("object")
    await runtime.stop()
})
