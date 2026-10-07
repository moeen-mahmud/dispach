/**
 * A template placeholder that reached the model unrendered is a warning on the agent (pilot.14,
 * VelaCrew): a REMINDER.md copied raw carried `{{vars.userName}}`, and the model told the person they
 * had pasted its instructions. One check, in `resolveWorkspace`, so `validate` says the same.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

async function boot(reminder: string) {
    const dir = mkdtempSync(join(tmpdir(), "unrendered-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: templated
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  workspace: .
  reminder: REMINDER.md
`,
    )
    writeFileSync(join(dir, "REMINDER.md"), reminder)
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "k" },
        store: ":memory:",
    })
    const warnings = runtime.agent("templated").warnings
    await runtime.stop()
    return warnings
}

describe("unrendered template placeholders", () => {
    test("are named in a warning on the agent", async () => {
        const warnings = await boot(
            "When {{vars.userName}} asks, confirm first. {{ vars.userName }}",
        )
        const found = warnings.find((warning) => warning.code === "workspace_unrendered_var")
        expect(found?.message).toContain("REMINDER.md")
        expect(found?.message).toContain("{{vars.userName}}")
    })

    test("are not flagged inside a comment the model never sees", async () => {
        const warnings = await boot("<!-- {{vars.userName}} is filled at provision -->\nBe brief.")
        expect(warnings.some((warning) => warning.code === "workspace_unrendered_var")).toBe(false)
    })
})
