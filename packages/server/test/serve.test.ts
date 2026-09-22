import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("every option this wrapper can forward, it forwards", () => {
    /**
     * `serve()` builds the handler's options one field at a time, and a field it forgets is a
     * capability the caller supplied that the routes then report as **not supported** — a 501 that
     * reads as a product limitation rather than a wiring bug. Its own source carries four comments
     * saying "same trap, Nth field", and then it happened a fifth time: `channels` was dropped, and
     * the only symptom was a browser button that did nothing.
     *
     * Four comments did not stop the fifth, so this is a test. It reads the **source**, because what
     * goes wrong is a missing line in an object literal and nothing about the types can see it:
     * `ServeOptions extends HandlerOptions`, so every field is legal to accept and silently ignore.
     *
     * It asserts only that the name is **mentioned** in the literal. A stricter shape would have to
     * know that `runtime` is passed as shorthand while the optional ones are conditional spreads,
     * and a guard that encodes today's spelling is one the next refactor breaks for no reason.
     */
    const NOT_FORWARDABLE = new Set([
        // `Omit`ted from `ServeOptions`: the bind host is already an argument, so a caller cannot
        // hand over an origin policy that disagrees with what was actually bound.
        "origin",
        // Derived from whether a token was given, for the same reason.
        "allowUnauthenticated",
    ])

    const read = (name: string): string =>
        readFileSync(join(import.meta.dir, "..", "src", name), "utf8")

    test("the createHandler literal names every field HandlerOptions declares", () => {
        const handler = read("handler.ts")
        const declaration = handler.slice(handler.indexOf("export interface HandlerOptions {"))
        const fields = [
            ...declaration.slice(0, declaration.indexOf("\n}")).matchAll(/readonly (\w+)\??:/g),
        ]
            .map((match) => match[1] as string)
            .filter((name) => !NOT_FORWARDABLE.has(name))

        // The guard only means something if it found the fields at all — a changed declaration
        // shape would otherwise make this pass by checking nothing.
        expect(fields.length).toBeGreaterThan(5)
        expect(fields).toContain("channels")

        const source = read("serve.ts")
        const literal = source.slice(source.indexOf("createHandler({"))
        // **Comments stripped before asserting.** The first version of this guard could not fail:
        // every field name it looked for also appeared in a comment *inside* the literal explaining
        // why forwarding it mattered, so deleting the line left the word behind and the test stayed
        // green. This repo has made that exact mistake before, matching a manifest's own
        // explanatory comment instead of its configuration.
        const body = literal
            .slice(0, literal.indexOf("\n    })"))
            .split("\n")
            .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
            .join("\n")
        expect(fields.filter((name) => !body.includes(name))).toEqual([])
    })
})
