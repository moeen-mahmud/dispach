/**
 * A declared model role no schedule names: refused only when it looks like a typo of a built-in one
 * (pilot.4). A role declared ahead of the schedules that use it — the API creates those — must load.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { loadManifest } from "../src/manifest/load.ts"
import { describe, expect, test } from "./_harness.ts"

function load(role: string) {
    const dir = mkdtempSync(join(tmpdir(), "roles-"))
    const role_block = `  ${role}:\n    id: small-model\n    baseUrl: https://example.invalid/v1\n    apiKeyEnv: MODEL_API_KEY\n`
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}\nid: roles\nmodel:\n  main:\n    id: test-model\n    baseUrl: https://example.invalid/v1\n    apiKeyEnv: MODEL_API_KEY\n${role_block}`,
    )
    return () => loadManifest(join(dir, "agent.yaml"), { env: { MODEL_API_KEY: "k" } })
}

describe("unreferenced model roles", () => {
    test("a typo of a built-in role is still refused", () => {
        expect(load("compacter")).toThrow(/model_role_unreferenced|no schedule names it/)
    })

    test("a role declared ahead of its schedules loads", () => {
        expect(Object.keys(load("fast")().manifest.model).includes("fast")).toBe(true)
    })
})
