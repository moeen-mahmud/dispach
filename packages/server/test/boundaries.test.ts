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

/**
 * Every route declares what a scoped credential must be allowed to do, and the declaration is
 * checked against the spec in **both** directions.
 *
 * The capability is a required field on `router.add` for the reason `CommandSpec.inSession` is
 * required in the CLI — a table kept beside the router would be a second list of routes, which is
 * the shape that has cost this repo `NO_MANIFEST`, `DOCUMENTED_CTRL_LETTERS` and `THRESHOLD_ORDER`.
 * TypeScript already enforces that the field is *present*. What it cannot check is whether the
 * value is the right one, and the first pass over 39 routes got **three** wrong in ways that
 * compile perfectly: `POST /v1/agents/:id/messages` required `admin`, so no chat-scoped key could
 * send a message; `GET /v1/agents/:id` and `GET /v1/agents/:id/turns/:turnId` required nothing at
 * all. Every one of those is invisible to a type and obvious in a table.
 */
describe("what each route requires", () => {
    const handler = readFileSync(join(SRC, "handler.ts"), "utf8")
    const SPEC = resolve(SRC, "..", "..", "..", "docs", "04-SPEC-WIRE.md")

    /**
     * Each registration paired with the capability declared inside it.
     *
     * Bounded by the *next* registration rather than by matching parentheses: a balanced scan has to
     * understand template literals and escapes to know which `)` closes the call, and the version
     * that did not found 18 of 39 routes and silently reported the rest as fine. The next
     * `router.add(` is an unambiguous terminator that needs no lexer.
     */
    function declared(): ReadonlyMap<string, string> {
        const starts = [...handler.matchAll(/router\.add\(\s*"([A-Z]+)",\s*"([^"]+)"/g)]
        const out = new Map<string, string>()
        for (const [index, match] of starts.entries()) {
            const from = match.index
            const to = starts[index + 1]?.index ?? handler.length
            const capability = /\{\s*capability:\s*"([a-z]+)"/.exec(handler.slice(from, to))
            out.set(`${match[1]} ${match[2]}`, capability?.[1] ?? "MISSING")
        }
        return out
    }

    function documented(): ReadonlyMap<string, string> {
        const spec = readFileSync(SPEC, "utf8")
        const out = new Map<string, string>()
        for (const row of spec.matchAll(
            /^\| `([A-Z]+) (\/\S*)` \| `(open|read|chat|write|admin)` \|$/gm,
        )) {
            out.set(`${row[1]} ${row[2]}`, row[3] ?? "")
        }
        return out
    }

    test("every route declares one, and it is a real capability", () => {
        const missing = [...declared()]
            .filter(([, cap]) => cap === "MISSING")
            .map(([route]) => route)
        expect(missing).toEqual([])
        expect(declared().size).toBeGreaterThan(30)
    })

    test("the code and the spec agree, in both directions", () => {
        const code = declared()
        const spec = documented()
        // A route the spec describes and the server does not register is worse than a missing row:
        // a reference naming an endpoint that answers 404 looks authoritative. Same argument the
        // OpenAPI summaries are guarded with.
        expect([...spec.keys()].filter((route) => !code.has(route))).toEqual([])
        expect([...code.keys()].filter((route) => !spec.has(route))).toEqual([])
        const disagreements = [...code]
            .filter(([route, cap]) => spec.get(route) !== cap)
            .map(([route, cap]) => `${route}: code=${cap} spec=${spec.get(route)}`)
        expect(disagreements).toEqual([])
    })

    test("the capabilities that write are not reachable by a read-only key", () => {
        /**
         * A shape check over the table rather than a restatement of it: anything that changes state
         * must be at least `chat`, and the probes and the browser assets must be `open`. This is
         * what would have caught `POST /messages` at `admin` only indirectly — but it catches the
         * far worse direction, a mutating route declared `read` or `open`, which no other assertion
         * here would see.
         */
        for (const [route, cap] of declared()) {
            const method = route.split(" ")[0] ?? ""
            if (method === "GET") continue
            // The webhook is the one deliberate exception: its caller is Telegram, which holds no
            // credential of ours and never will.
            if (route.includes("/webhook/")) {
                expect(cap).toBe("open")
                continue
            }
            expect({ route, open: cap === "open" || cap === "read" }).toEqual({
                route,
                open: false,
            })
        }
    })
})

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
