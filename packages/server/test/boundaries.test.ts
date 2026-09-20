/**
 * Structural rules this package cannot express in its types.
 *
 * One rule so far, and it was learned in the shipped container rather than here.
 *
 * ## Why `instanceof HarnessError` is banned in this package
 *
 * Every `catch` in `handler.ts` is catching an error that was thrown **somewhere else** — by
 * `@dispach/core`, or by a callback `packages/cli` injected (`provision.create`, `resolveAgent`).
 * `instanceof` compares prototypes, so it is only as reliable as the guarantee that one process
 * holds one copy of `@dispach/core`. That guarantee does not hold in a `bun build --compile`
 * binary, and the failure is silent.
 *
 * **Measured.** The image builds with a newer bun than this repo pins, and that bun resolves
 * `@dispach/core` to core's `src/index.ts` for `packages/cli`'s source while the prebuilt
 * `@dispach/server` it bundles carries core's `dist/index.js` — two `HarnessError` classes in one
 * binary. So every provisioning refusal, each with a code, a hint and the `field` a form needs,
 * came back `500 internal_error` with a message about the event stream. `dir` had been refused that
 * way since 16.5.
 *
 * **Why the guard is source text and not a running binary.** A test that starts the built binary
 * and asserts a `400` passes on the bun this repo pins, because that version resolves both sides to
 * `dist` and agrees with itself — a guard that can only go red on somebody else's toolchain is the
 * "passes with the fix reverted" shape in a new costume. Reading the source is deterministic
 * everywhere, and the rule it encodes is the durable one: the resolution behaviour was never ours
 * to depend on.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const SRC = resolve(import.meta.dir, "..", "src")

function sources(dir: string): readonly string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...sources(path))
        else if (entry.name.endsWith(".ts")) out.push(path)
    }
    return out
}

describe("errors thrown in another package", () => {
    test("nothing here narrows one with `instanceof`", () => {
        const offenders = sources(SRC)
            .map((path) => ({ path, text: readFileSync(path, "utf8") }))
            .filter((file) => /instanceof\s+HarnessError/.test(file.text))
            .map((file) => file.path.slice(SRC.length + 1))
        // `isHarnessError` from `@dispach/core` is the replacement: it tests a
        // `Symbol.for`-registered mark, which every copy of that module computes identically.
        expect(offenders).toEqual([])
    })

    test("and the check it must use is actually imported and used", () => {
        /**
         * Or the rule above passes by there being no checks at all — the empty-result-reads-like-a-
         * pass shape this repo keeps catching. Seven call sites exist; this asserts they are still
         * there rather than counting them, because a route added later should not fail this.
         */
        const handler = readFileSync(join(SRC, "handler.ts"), "utf8")
        expect(handler).toContain("isHarnessError")
        expect((handler.match(/isHarnessError\(/g) ?? []).length).toBeGreaterThan(3)
    })
})
