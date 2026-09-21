/**
 * What `npm publish` would actually upload.
 *
 * ## Why this file exists
 *
 * The runtime is nine workspace packages and **one** npm name. That is a decision the directory
 * layout cannot express and nothing enforced, so the first `npm pack --dry-run` of this repo
 * offered to publish **2,693 files, 201 MB unpacked, 45.6 MB compressed** — because no build ever
 * cleaned `dist/`, `files: ["dist"]` ships whatever is in it, and `dist/` is gitignored so a diff
 * never showed it. A hundred of those files still imported `@castellan/core`, a package that has
 * not existed since the rename a month earlier.
 *
 * Every assertion below is a thing that was wrong once, in a directory nobody looks at.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BRAND } from "@dispach/core"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ROOT = resolve(CLI, "..", "..")
const manifest = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")) as {
    name: string
    version: string
    bin: Record<string, string>
    files: string[]
    exports: Record<string, unknown>
    dependencies: Record<string, string>
    private?: boolean
}

describe("one published package", () => {
    test("this one is it, and every sibling is private", () => {
        /**
         * The registry surface is a single name, so there is one thing to own and one thing to
         * transfer. A sibling that lost its `private` flag would be published by the next
         * `changeset publish` under a scope that does not exist — which fails loudly, and only
         * after somebody has tagged a release.
         */
        expect(manifest.private).toBeUndefined()
        const publishable = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
            // Directories only: macOS leaves a `.DS_Store` beside them, and reading it as a package
            // threw `ENOTDIR` — which is a broken test rather than a broken repo.
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(ROOT, "packages", entry.name, "package.json"))
            .map(
                (path) =>
                    JSON.parse(readFileSync(path, "utf8")) as { name: string; private?: boolean },
            )
            .filter((pkg) => pkg.private !== true)
            .map((pkg) => pkg.name)
        expect(publishable).toEqual([manifest.name])
    })

    test("it is named for the brand, not for a directory", () => {
        // `packages/cli` is where it lives; `dispach` is what somebody installs.
        expect(manifest.name).toBe(BRAND.slug)
        expect(Object.keys(manifest.bin)).toEqual([BRAND.slug])
    })

    test("the default import is the library, and the CLI is reached through `bin`", () => {
        /**
         * `exports["."]` pointed at the CLI entry, which carries a shebang and runs on import — so
         * `import "dispach"` printed the banner and exited. A package that offers both a command and
         * a client has to give each caller the thing they asked for, and `bin` is not governed by
         * `exports`, so there is no conflict to resolve.
         */
        expect(manifest.exports["."]).toEqual(manifest.exports["./client"] as never)
        expect(JSON.stringify(manifest.exports["."])).not.toContain("index")
        expect(manifest.bin[BRAND.slug]).toContain("index")
    })

    test("its runtime dependencies are only what is deliberately not bundled", () => {
        /**
         * Everything else — core, the server, the client, the tools, the channels, `yaml`, `zod` —
         * is bundled, which is what makes this one package rather than nine. `ink` and `react` stay
         * external **on purpose**: the lazy `import("ink")` is what keeps ~170-210 ms off the
         * startup path of every non-interactive command, and inlining them would defeat it.
         */
        expect(Object.keys(manifest.dependencies).sort()).toEqual(["ink", "react"])
        expect(Object.keys(manifest.dependencies).some((name) => name.startsWith("@"))).toBe(false)
    })
})

describe("what ships in dist", () => {
    /**
     * Read from the built directory, so this is skipped rather than green when nothing is built —
     * a guard that quietly passes on an absent subject is not a guard. CI builds before testing.
     */
    const dist = join(CLI, "dist")
    const built = (() => {
        try {
            return readdirSync(dist)
        } catch {
            return undefined
        }
    })()

    test("there is a build to check", () => {
        expect(built).toBeDefined()
    })

    test("no file references a package that does not exist", () => {
        if (built === undefined) return
        /**
         * The 2,693-file finding, as an assertion. A hundred stale chunks from before the rename
         * were still importing `@castellan/core`; nothing could see them because `dist/` is
         * gitignored and no test read it as a *set*. `rm -rf dist` in every build script is the fix
         * and this is what proves the fix is still in the script.
         */
        const offenders = built
            .filter((name) => name.endsWith(".js"))
            .filter((name) =>
                /from\s*"@[a-z-]+\/(?!dispach)/.test(readFileSync(join(dist, name), "utf8")),
            )
        expect(offenders).toEqual([])
    })

    /**
     * **"Every bare import is declared" is not asserted here, and the reason is worth recording.**
     *
     * The first version scanned the built files for `from "x"`. The shipped bundle is minified, so
     * that regex matched the word `from` inside string literals and reported ten "undeclared
     * dependencies" that were fragments of a help screen. Scanning minified text for module syntax
     * is the same mistake as scanning source text for `router.add(` with a balanced-paren scan: the
     * tool cannot see what it is reading.
     *
     * The honest check is to pack the tarball, install it somewhere with nothing else, and run it —
     * which is an integration property rather than a unit one. `bun run verify:package` does exactly
     * that and is part of the release checklist.
     */

    test("the library entry pulls in no terminal UI", () => {
        if (built === undefined) return
        /**
         * An application importing `dispach/client` must not pay for Ink and React. They are
         * measured at ~170-210 ms under Node — more than the entire runtime of `validate --json` —
         * and an HTTP client has no business costing that. Built as its own entry with no code
         * splitting precisely so this can be asserted on the finished file.
         */
        for (const entry of ["client.js", "wire.js"]) {
            const text = readFileSync(join(dist, entry), "utf8")
            expect({ entry, ink: /from\s*"ink"/.test(text) }).toEqual({ entry, ink: false })
            expect({ entry, react: /from\s*"react/.test(text) }).toEqual({ entry, react: false })
        }
    })
})
