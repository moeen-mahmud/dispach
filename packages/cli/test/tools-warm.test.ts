/**
 * `tools --warm` with a provider that cannot be warmed (QA K3): `init` names `composio: {}` with no key
 * so the model knows the route exists, and its refusal used to abort the whole run.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@dispach/core"
import { toolsCommand } from "../src/tools.ts"

let out: string[] = []
let write: ReturnType<typeof spyOn>
beforeEach(() => {
    out = []
    write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        out.push(String(chunk))
        return true
    })
})
afterEach(() => write.mockRestore())

function manifest(pinned: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "warm-"))
    const path = join(dir, "agent.yaml")
    writeFileSync(
        path,
        `apiVersion: ${BRAND.apiVersion}\nid: warm\nmodel:\n  main:\n    id: m\n    baseUrl: http://127.0.0.1:9/v1\ntools:\n  providers:\n    composio: {}\n    system: {}\n  pinned: [${pinned.join(", ")}]\n`,
    )
    return path
}

describe("tools --warm", () => {
    test("a provider that cannot be warmed is named and skipped; the ones after it still run", async () => {
        const code = await toolsCommand({ manifestPath: manifest(["file_read"]), warm: true })
        const text = out.join("")
        expect(text).toContain("composio: not warmed")
        expect(text).toContain("system: nothing to warm")
        expect(code).toBe(0)
    })

    test("it still fails when a pinned tool is left uncovered by the skip", async () => {
        const code = await toolsCommand({
            manifestPath: manifest(["file_read", "GMAIL_FETCH_EMAILS"]),
            warm: true,
        })
        expect(out.join("")).toContain("missing: GMAIL_FETCH_EMAILS")
        expect(code).toBe(1)
    })
})
