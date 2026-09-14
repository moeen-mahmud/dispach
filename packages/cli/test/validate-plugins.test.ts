/**
 * `validate` and `run` must agree about which provider and channel ids exist.
 *
 * They did not, for exactly as long as plugins existed without this. `validate` checked
 * `tools.providers` against the binary's static table while `Runtime.create` checked it against the
 * table *plus* whatever the manifest's plugins had registered, so this manifest booted fine and
 * validated as broken:
 *
 *     validate  tools.providers.metrics names "metrics", which is not registered here.
 *     plugins   metrics  0.2.0  0.01 ms  toolProvider:metrics
 *
 * Which is the recorded shape — a check only one of them performs is a check they disagree about —
 * in the direction that tells somebody their working agent is misconfigured. `agentPluginSupply` is
 * the one function both call now, and this asserts the agreement rather than the implementation, so
 * a future third caller that skips it fails here.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, Runtime } from "@dispach/core"
import { BUILT_IN_PLUGINS, CHANNELS, TOOL_PROVIDERS } from "#lib/providers"
import { validateCommand } from "#validate"

const ENV = { MODEL_API_KEY: "test-key" }

/** A plugin on disk, because the dynamic-import path is the one that was broken. */
function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "validate-plugins-"))
    writeFileSync(
        join(dir, "metrics.mjs"),
        `export default {
  name: "metrics",
  version: "0.2.0",
  dispachApi: "^0.1",
  setup(ctx) {
    ctx.defineToolProvider("metrics", () => ({
      id: "metrics",
      resolve: async () => [],
      list: async () => [],
    }))
  },
}
`,
    )
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: validateplugins
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
plugins:
  - "./metrics.mjs"
tools:
  providers:
    metrics: {}
`,
    )
    writeFileSync(join(dir, ".env"), "MODEL_API_KEY=test-key\n")
    return dir
}

describe("a provider id that only a plugin supplies", () => {
    test("validate accepts it", async () => {
        const dir = workspace()
        const written: string[] = []
        const original = process.stdout.write.bind(process.stdout)
        // biome-ignore lint/suspicious/noExplicitAny: capturing stdout for one call
        ;(process.stdout as any).write = (chunk: string) => {
            written.push(String(chunk))
            return true
        }
        let code: number
        try {
            code = await validateCommand({ manifestPath: join(dir, "agent.yaml"), json: true })
        } finally {
            // biome-ignore lint/suspicious/noExplicitAny: restoring
            ;(process.stdout as any).write = original
        }
        expect({ code, output: written.join("") }).toEqual({
            code: 0,
            output: expect.stringContaining('"ok": true') as unknown as string,
        })
    })

    test("and the runtime boots it — the two halves of the same claim", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            toolProviders: TOOL_PROVIDERS,
            builtInPlugins: BUILT_IN_PLUGINS,
            channels: CHANNELS,
            fetch: async () => new Response("{}"),
            lease: false,
        })
        expect(runtime.plugins.get("validateplugins")?.[0]?.name).toBe("metrics")
        await runtime.stop()
    })
})
