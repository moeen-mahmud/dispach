/**
 * The client stays small enough to put in a browser, and the regression that breaks it is silent.
 *
 * `packages/web` is built on this package, so its browser bundle *is* the UI's floor. One barrel
 * import from core put a schema validator and a YAML parser in it — 1.18 MB and 159 modules, for a
 * page that can never load a manifest — and nothing failed: the tests pass, `tsc` passes, the
 * bundle builds, and the only symptom is a slower page. That is the whole reason this file bundles
 * for real rather than reading the imports.
 *
 * Every content assertion is on a **boolean**, never on the text — `expect(text).not.toContain(…)`
 * prints its haystack, and the haystack here is the failure case's 1.2 MB bundle. A guard that
 * floods a terminal with a megabyte of minified JS is one somebody scrolls past, so the failure
 * says `Expected false, received true` and the size line above it says how big.
 *
 * It asserts a **ceiling**, not a figure, and the ceiling is generous on purpose: a test that fails
 * when a legitimate feature adds four kilobytes is one somebody raises without reading, which is
 * how a budget stops being one. What it catches is the order-of-magnitude mistake, which is the
 * only kind that has ever happened here.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const dirs: string[] = []

afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Bundle one entry for a browser, in a **subprocess**, and report its size and its text.
 *
 * Two decisions in here, both learned by getting them wrong.
 *
 * `target: "browser"` rather than `node` is load-bearing: under the node target a `node:` import
 * resolves to an external and costs nothing, so the measurement would be of a platform the UI does
 * not run on — and would have stayed green throughout the defect this file guards.
 *
 * The subprocess is not tidiness. In-process `Bun.build` failed with `Unexpected reading file:
 * core/dist/wire/index.js` — but only when the whole package's tests ran together, because
 * `client.test.ts` imports the client, which imports that exact path, so it is already a *loaded
 * module* in this process and the bundler cannot also read it as a source file. Passing when run
 * alone and failing in the suite is the worst version of that, so the bundle happens where nothing
 * else has an opinion about the module graph.
 */
async function browserBundle(source: string): Promise<{ bytes: number; text: string }> {
    const dir = mkdtempSync(join(tmpdir(), "client-bundle-"))
    dirs.push(dir)
    // Written inside the package, because a relative import from a tmpdir cannot reach `src/` and
    // the workspace name does not resolve outside the monorepo's own node_modules.
    const entry = join(dirname(import.meta.dir), `_bundle_probe_${Date.now()}.ts`)
    writeFileSync(entry, source)
    try {
        const built = Bun.spawnSync(["bun", "build", entry, "--target", "browser", "--outdir", dir])
        expect(built.exitCode).toBe(0)
        const out = join(dir, `${basename(entry, ".ts")}.js`)
        return { bytes: statSync(out).size, text: readFileSync(out, "utf8") }
    } finally {
        rmSync(entry, { force: true })
    }
}

describe("the browser bundle", () => {
    /**
     * 120 KB against a measured 14.7 KB.
     *
     * Eight times the current size, and still a hundredth of what one barrel import cost — which is
     * the band this assertion has to sit in. Tight enough that re-importing the runtime is caught;
     * loose enough that adding real client features never makes somebody edit this number without
     * thinking about why.
     */
    const CEILING = 120_000

    test("the whole client fits in a browser", async () => {
        const { bytes, text } = await browserBundle(
            'import { createClient, isEvent } from "./src/index.ts"\nconsole.log(createClient, isEvent)\n',
        )
        expect(bytes).toBeLessThan(CEILING)

        /**
         * A floor and a content check, because a ceiling alone cannot tell "the client is lean"
         * from "the bundler silently dropped everything" — and an empty bundle satisfies every
         * size assertion perfectly. The recorded version of this mistake is "an empty reply is not
         * a passing reply": a check that a value is *under* a limit is satisfied by no value at all.
         */
        expect(bytes).toBeGreaterThan(5_000)
        // Proves `EVENT_TYPES` really came through the `./wire` subpath rather than being shaken out.
        expect(text.includes("turn.start")).toBe(true)
    })

    test("core's ./wire subpath is small on its own, not merely unused", async () => {
        /**
         * The gap the first revert-check exposed.
         *
         * Reverting `stream.ts` to the barrel turns the two tests around this one red, as it should.
         * Adding `loadManifest` to `core/src/wire/index.ts` left them **green** — because the client
         * does not call it, so tree-shaking removes it and the bundle never grows. That makes the
         * rule in the wire entry's own docstring unenforced, and the rule is the point: `./wire` is a
         * *public* subpath, so `packages/web` may import anything from it, and shaking only helps a
         * consumer that happens not to. A heavy export there is a trap set for the next caller.
         *
         * So this bundles the namespace and *uses* every member, which is what stops the bundler
         * shaking out the thing being measured.
         */
        const { bytes, text } = await browserBundle(
            'import * as wire from "@dispach/core/wire"\nconsole.log(Object.keys(wire).length, wire)\n',
        )
        // 30 KB. The entry was 2.8 KB with two exports and is ~10 KB now that it carries
        // `endNote` (the fourth caller of one formatter) and the NLT stream filter (which every SSE
        // consumer needs, because the wire is deliberately unfiltered). Still two orders of
        // magnitude under what one barrel import cost, which is the band this has to sit in.
        expect(bytes).toBeLessThan(30_000)
        expect(text.includes("turn.start")).toBe(true)
        expect(text.includes("invalid_type")).toBe(false)
        expect(text.includes("YAMLParseError")).toBe(false)
    })

    test("no schema validator and no YAML parser reach it", async () => {
        /**
         * The two things one barrel import put in a browser, named by their own fingerprints rather
         * than by a size.
         *
         * A byte count says *that* something grew; these say *what*, which is the difference between
         * a failure somebody acts on and a number somebody raises. Both strings appear dozens of
         * times in the 1.18 MB bundle this replaced — `invalid_type` 79 times, `YAMLParseError`
         * seven — and zero times in the 14.7 KB one.
         */
        const { text } = await browserBundle(
            'import { createClient } from "./src/index.ts"\nconsole.log(createClient)\n',
        )
        expect(text.includes("invalid_type")).toBe(false)
        expect(text.includes("YAMLParseError")).toBe(false)
    })
})
