/**
 * Package version, surfaced on the wire (`GET /v1/health`) and in `plugin.loaded` events.
 *
 * The package is **`dispach`**, whose manifest is `packages/cli/package.json` — and that is where
 * the guard reads it from, in `packages/cli/test/version.test.ts`. It used to be compared against
 * `packages/core/package.json`, which was right while all nine workspace packages published
 * together and became a guard that passes on a wrong version the moment the release became one
 * package: `ignore: ["@dispach/*"]` leaves every sibling at `0.1.0` on purpose, so a constant
 * matching *core's* manifest would have shipped `0.1.1` printing `0.1.0`.
 *
 * Kept in step by that test rather than by discipline — `changeset version` rewrites the manifest
 * and knows nothing about this line, so a bump turns the suite red until somebody edits it here.
 */
export const VERSION = "0.1.2"
