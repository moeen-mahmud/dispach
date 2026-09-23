/**
 * The browser payload has a ceiling, because "lightweight" is one number and this is it.
 *
 * `packages/web` has zero runtime dependencies (decision 11.201) — React and Vite are compiled into
 * the output, so nothing enters the image or the published dependency tree. What that leaves is the
 * bundle, and a bundle grows silently: every test passes, `tsc` passes, `docker compose up` works,
 * and the only symptom is a slower page. So it is measured on the **built** output rather than
 * argued about from the imports.
 *
 * Measured at the time of writing: 220 KB of JS, 4.9 KB of CSS, 1.3 KB of HTML — 69.4 KB gzipped,
 * most of it `react-dom`. The ceiling is roughly half again, which catches a second framework or an
 * accidentally-bundled `@dispach/core` and does not catch a real feature.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { gzipSync } from "node:zlib"

const DIST = join(dirname(import.meta.dir), "dist")

/** Raw bytes of every emitted file. The figure a cache-cold loopback request actually pays. */
const RAW_CEILING = 340_000
/** Gzipped, which is what crosses a network. */
const GZIP_CEILING = 110_000

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    )
}

describe("the built page", () => {
    test("exists and is not stale", () => {
        /**
         * Two failures, and the second one caught this file's own revert-check out.
         *
         * A ceiling over an empty directory passes perfectly, so the directory is asserted first.
         * And **a ceiling over a stale directory passes too** — which is how revert-checking this
         * guard went green: the probe made the Vite build *fail*, `dist/` kept the previous output,
         * and the ceiling measured bytes from before the change. The recorded stale-`dist` hazard,
         * reappearing inside a test written to catch a different one.
         *
         * So the output must be newer than every source file it is built from. Not a timestamp
         * fetish: it is the only local signal that separates "this passed" from "this measured
         * something else".
         */
        expect(statSync(DIST).isDirectory()).toBe(true)
        expect(files(DIST).length).toBeGreaterThan(2)

        const built = Math.min(...files(DIST).map((path) => statSync(path).mtimeMs))
        const sources = files(join(dirname(import.meta.dir), "src"))
        const newest = Math.max(...sources.map((path) => statSync(path).mtimeMs))
        expect(sources.length).toBeGreaterThan(3)
        if (built < newest) {
            throw new Error(
                `packages/web/dist is older than src — run \`bun run build\`. Every ceiling below would otherwise measure the previous build, which is exactly how this guard was caught passing on stale bytes.`,
            )
        }
    })

    test("is under its raw and gzipped ceilings", () => {
        const all = files(DIST)
        const raw = all.reduce((total, path) => total + statSync(path).size, 0)
        const gzip = all.reduce((total, path) => total + gzipSync(readFileSync(path)).byteLength, 0)
        expect(raw).toBeLessThan(RAW_CEILING)
        expect(gzip).toBeLessThan(GZIP_CEILING)
    })

    test("carries no schema validator and no YAML parser", () => {
        /**
         * The `packages/client` defect (11.199) one layer out, and the reason this names the
         * culprits rather than only measuring bytes.
         *
         * A byte count says *that* something grew; a fingerprint says *what*, which is the
         * difference between a failure somebody acts on and a number somebody raises. Asserted on
         * booleans, never `toContain`, because that matcher prints its haystack and the haystack
         * here is a 220 KB bundle.
         */
        const js = readFileSync(join(DIST, "assets", "app.js"), "utf8")
        expect(js.includes("invalid_type")).toBe(false)
        expect(js.includes("YAMLParseError")).toBe(false)
    })

    test("has no binary assets", () => {
        // The constraint `with { type: "text" }` imposes. A font or an image here would build fine
        // and break the bundled `dist/` — the shape every install runs.
        for (const path of files(DIST)) {
            expect(/\.(html|js|css)$/.test(path)).toBe(true)
        }
    })

    test("references no external origin", () => {
        // No CDN, no Google Fonts, no analytics. The page is served by the agent over loopback as
        // often as not, where an external request is a round trip that may simply never resolve —
        // and a third-party script would have the operator's live credential in scope.
        const html = readFileSync(join(DIST, "index.html"), "utf8")
        expect(/https?:\/\/(?!www\.w3\.org)/.test(html)).toBe(false)
    })
})
