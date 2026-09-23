#!/usr/bin/env bun
/**
 * Rewrite the command table in `README.md` from the command specs. `packages/cli/README.md` is a
 * gitignored copy that `prepack` makes at publish time, so it is never written here.
 *
 *     bun scripts/readme-commands.ts
 *
 * `packages/cli/test/readme.test.ts` fails when either file disagrees with the render, so a new
 * command is one run of this rather than a sentence remembered.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { withCommandTable } from "../packages/cli/src/lib/readme-table.ts"

const ROOT = resolve(import.meta.dirname, "..")
for (const path of [join(ROOT, "README.md")]) {
    const next = withCommandTable(readFileSync(path, "utf8"))
    if (next === undefined) {
        process.stderr.write(
            `\n  ${path} has no command-table markers\n  hint: see packages/cli/src/lib/readme-table.ts for the two comment lines the table sits between.\n\n`,
        )
        process.exit(1)
    }
    writeFileSync(path, next)
    process.stdout.write(`${path}: table written\n`)
}
