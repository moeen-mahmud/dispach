/**
 * Recognising one of our own errors when two copies of this module exist.
 *
 * ## The failure this is about
 *
 * `instanceof` compares prototypes, so it answers "was this built by *this* copy of the class". In
 * a `bun build --compile` binary that is not the same question as "is this a `HarnessError`":
 * measured in the shipped image, the bundler resolved `@dispach/core` to this package's
 * `src/index.ts` for `packages/cli`'s source and to its `dist/index.js` for the prebuilt
 * `@dispach/server` it bundled. Two classes, one process. `handler.ts`'s
 * `error instanceof HarnessError` was false for every error the CLI-injected provisioner threw, and
 * each refusal — code, hint, and the `field` a form marks — arrived as `500 internal_error`.
 *
 * ## Why this test can fail, when the suite cannot reproduce the bundle
 *
 * `bun test` imports source, so there is one copy of everything and `instanceof` is correct here.
 * Importing the **built** `dist` alongside the source is what puts a genuinely foreign class in the
 * same process — no bundler needed, and it fails for exactly the reason the image did. It needs
 * `dist` to exist, which `bun run build` produces and CI runs before the tests; the guard says so
 * rather than passing silently when it does not.
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ConfigError, HarnessError, isHarnessError } from "../src/errors.ts"
import { describe, expect, test } from "./_harness.ts"

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js")

describe("isHarnessError", () => {
    test("it recognises one built by a different copy of this module", async () => {
        // `bun run build` writes this and CI builds before testing. Named rather than skipped:
        // a guard that quietly does nothing when its subject is absent is not a guard.
        expect(existsSync(DIST)).toBe(true)

        // `pathToFileURL`, because Node's ESM loader refuses a bare absolute path while Bun accepts
        // one — the same dual-runtime rule `_harness.ts` exists for.
        const built = (await import(pathToFileURL(DIST).href)) as {
            readonly HarnessError: typeof HarnessError
        }
        const foreign = new built.HarnessError({ code: "foreign", message: "m", hint: "h" })

        // The premise: genuinely two classes, exactly as the compiled binary had.
        expect(built.HarnessError).not.toBe(HarnessError)
        expect(foreign instanceof HarnessError).toBe(false)
        // And the point.
        expect(isHarnessError(foreign)).toBe(true)
        // Usable, not merely recognised — the route calls this on what it caught.
        expect(isHarnessError(foreign) ? foreign.toDetail().code : undefined).toBe("foreign")
    })

    test("a subclass carries the mark with nothing to remember", () => {
        // Set in the base constructor rather than declared per class, which is why.
        expect(isHarnessError(new ConfigError({ code: "c", message: "m", hint: "h" }))).toBe(true)
    })

    test("it is not fooled by something that merely looks like one", () => {
        /**
         * A deserialised error is exactly `{code, message, hint}` and has no `toDetail`, so a
         * duck-type on those fields would hand a route an object it then calls a method on. The
         * wire carries details, never live errors.
         */
        expect(isHarnessError({ code: "c", message: "m", hint: "h" })).toBe(false)
        expect(isHarnessError(new Error("plain"))).toBe(false)
        expect(isHarnessError(undefined)).toBe(false)
        expect(isHarnessError(null)).toBe(false)
        expect(isHarnessError("HarnessError")).toBe(false)
    })

    test("the mark never reaches a serialisation", () => {
        // Symbol-keyed, so `JSON.stringify` cannot see it and a stored error is unchanged.
        const mine = new HarnessError({ code: "c", message: "m", hint: "h" })
        expect(Object.keys(mine)).not.toContain("HARNESS_ERROR")
        expect(JSON.stringify(mine.toDetail())).toBe(
            JSON.stringify({ code: "c", message: "m", hint: "h" }),
        )
    })
})
