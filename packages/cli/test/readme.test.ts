/**
 * The README's command table is generated, and this is what makes "generated" mean anything.
 *
 * The root `README.md` carries the table between two markers. `packages/cli/README.md` is **not**
 * tracked — `prepack` copies the root one at publish time, and it is gitignored — so only the root
 * file is checked; reading the copy passed on a machine that had packed once and failed in CI. A
 * command added to `COMMANDS` without `bun scripts/readme-commands.ts` fails here rather than
 * shipping a README that lists everything but the newest verb.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { withCommandTable } from "../src/lib/readme-table.ts"

const ROOT = resolve(import.meta.dirname, "..", "..", "..")

describe("the README command table", () => {
    test("matches the command specs", () => {
        const readme = readFileSync(join(ROOT, "README.md"), "utf8")
        const rendered = withCommandTable(readme)
        expect(rendered, "README.md has no command-table markers").toBeDefined()
        expect(rendered, "README.md is stale — run bun scripts/readme-commands.ts").toBe(readme)
    })
})
