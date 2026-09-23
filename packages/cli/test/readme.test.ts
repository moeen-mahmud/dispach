/**
 * The README's command table is generated, and this is what makes "generated" mean anything.
 *
 * `README.md` and `packages/cli/README.md` are byte-identical on purpose (the second is what npm
 * shows), and both carry the table between two markers. A command added to `COMMANDS` without
 * `bun scripts/readme-commands.ts` fails here rather than shipping a README that lists everything
 * but the newest verb — which is what the hand-written table did for five commands at once.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { withCommandTable } from "../src/lib/readme-table.ts"

const ROOT = resolve(import.meta.dirname, "..", "..", "..")

describe("the README command table", () => {
    test("matches the command specs in both copies", () => {
        for (const path of ["README.md", join("packages", "cli", "README.md")]) {
            const readme = readFileSync(join(ROOT, path), "utf8")
            const rendered = withCommandTable(readme)
            expect(rendered, `${path} has no command-table markers`).toBeDefined()
            expect(rendered, `${path} is stale — run bun scripts/readme-commands.ts`).toBe(readme)
        }
    })

    test("the two READMEs are one file", () => {
        expect(readFileSync(join(ROOT, "packages", "cli", "README.md"), "utf8")).toBe(
            readFileSync(join(ROOT, "README.md"), "utf8"),
        )
    })
})
