/**
 * Every first-party plugin runs the conformance suite.
 *
 * The acceptance criterion Phase 9 states, and the thing that makes the suite worth shipping: if the
 * packages this repo controls do not pass it, no third-party author has any reason to. It lives in
 * the CLI's tests because that is the package which already imports all four — `packages/core` may
 * not (hard rule 2), and asserting from inside one of the four would only ever check itself.
 *
 * What passing means is narrow and stated in the suite's own docstring: **well-formed**, not safe.
 * The setup budget, the version range, the declared permissions and the fact that `setup` registers
 * something and survives an empty environment. Whether `send()` is idempotent is not checkable here.
 */

import { describe, expect, test } from "bun:test"
import { conformance, formatFindings } from "@dispach/core/testing"
import { BUILT_IN_PLUGINS } from "#lib/providers"

describe("the first-party plugins", () => {
    for (const [spec, plugin] of Object.entries(BUILT_IN_PLUGINS)) {
        test(`${spec} passes conformance`, async () => {
            const result = await conformance(plugin)
            // The formatted findings are the failure message, so a break says what broke rather
            // than `expected true to be false`.
            expect({
                spec,
                ok: result.ok,
                detail: result.ok ? "" : formatFindings(result),
            }).toEqual({ spec, ok: true, detail: "" })
        })

        test(`${spec} registers what naming it is supposed to buy`, async () => {
            // A plugin that passes every shape check and registers nothing extends nothing. The
            // suite only warns about that, because a middleware-only plugin is legitimate from
            // Phase 9B — so the assertion that it is *not* the case here belongs with the packages.
            const result = await conformance(plugin)
            expect(result.registered.length).toBeGreaterThan(0)
        })

        test(`${spec} declares an API range that admits this host`, async () => {
            const result = await conformance(plugin)
            const skew = result.findings.filter((finding) => finding.check === "dispachApi")
            expect(skew).toEqual([])
        })
    }
})

test("every built-in is registered under the package name a manifest would write", () => {
    // The registry is keyed by specifier, and the plugin's own `name` is a different namespace —
    // `@dispach/tools-system` versus `system`. Conflating them is how a manifest comes to name
    // something the loader cannot find.
    for (const spec of Object.keys(BUILT_IN_PLUGINS)) {
        expect(spec.startsWith("@")).toBe(true)
    }
})
