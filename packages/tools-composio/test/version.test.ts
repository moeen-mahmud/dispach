import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { VERSION } from "../src/index.ts"

test("VERSION matches package.json", () => {
    // Declared to the host in `dispachApi` gating and reported in `plugin.loaded`, so a stale
    // constant misreports which build is running. `changeset version` bumps the manifest and knows
    // nothing about the constant — this is the only thing standing between those two facts. Same
    // arrangement as `@dispach/core`'s own VERSION test.
    const manifest: unknown = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    )
    expect((manifest as { version?: unknown }).version).toBe(VERSION)
})
