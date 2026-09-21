/**
 * `VERSION` and the version anybody actually sees.
 *
 * ## Why this moved out of `packages/core`
 *
 * It lived in `packages/core/test/version.test.ts` and compared `VERSION` against
 * **`packages/core/package.json`**, with a comment calling itself *"the only thing standing between
 * those two facts."* That was true while all nine workspace packages published together. It stopped
 * being true the moment the release became one package.
 *
 * `.changeset/config.json` carries `ignore: ["@dispach/*"]`, so `changeset version` bumps
 * `packages/cli` — the manifest of the published `dispach` — and leaves every sibling at `0.1.0`
 * deliberately. Under the old guard that produced a perfectly green suite for a released binary
 * printing the wrong number:
 *
 *     packages/cli/package.json   0.1.1   ← published as dispach@0.1.1
 *     packages/core/package.json  0.1.0   ← ignored, never bumped again
 *     VERSION                     0.1.0   ← matches core, so the guard passed
 *     dispach --version           0.1.0   ← wrong, and nothing said so
 *
 * So the comparison is against the **published** manifest, and the test lives beside it. No boundary
 * is crossed either way: `packages/cli` already depends on `@dispach/core`, and this reads its own
 * `package.json` rather than reaching into a sibling's — which is what repointing the core test
 * would have done.
 *
 * ## Why `bundle.test.ts` does not already cover this
 *
 * It asserts the built binary prints `VERSION`, importing the same constant it compares against —
 * so it is *circular* with respect to this question. It proves the constant reaches the binary and
 * can never notice the constant being wrong. This is the non-circular half.
 */

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { VERSION } from "@dispach/core"

test("VERSION matches the published package's version", () => {
    // `changeset version` rewrites this manifest and knows nothing about the constant, which is
    // what makes them two facts that have to be tied together by something.
    const manifest: unknown = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    )
    const published = manifest as { name?: unknown; version?: unknown }
    // The name is asserted too, so this cannot quietly start guarding some other manifest if the
    // file it reads ever moves.
    expect(published.name).toBe("dispach")
    expect(published.version).toBe(VERSION)
})
