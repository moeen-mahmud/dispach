/**
 * The browser surface on the wire.
 *
 * Two properties matter more than the rest and both are easy to get wrong in the *permissive*
 * direction, which no passing request reveals: the shell must be reachable with no credential, and
 * `/v1` must not be. A catch-all route would satisfy every test about serving a page and quietly
 * turn every mistyped API path into HTML.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { WEB_ASSETS, WEB_PATHS } from "../src/web.ts"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

describe("serving the shell", () => {
    test("every asset answers with its own content type", async () => {
        const { call } = await harness({ token: TOKEN })
        const expected: Record<string, string> = {
            "/": "text/html",
            "/assets/app.js": "text/javascript",
            "/assets/app.css": "text/css",
        }
        for (const path of WEB_PATHS) {
            const response = await call("GET", path, { token: null })
            expect(response.status).toBe(200)
            expect(response.headers.get("content-type")).toContain(expected[path] ?? "?")
        }
    })

    test("the page really is the built one", async () => {
        const { call } = await harness({ token: TOKEN })
        const html = await (await call("GET", "/", { token: null })).text()
        // Asserted on the *built* output rather than on a string this test also writes: Vite emits
        // the script tag, so this is what proves the shipped HTML references the shipped bundle.
        expect(html).toContain("/assets/app.js")
        expect(html).toContain('<div id="root">')
    })

    test("no binary asset crept in", () => {
        /**
         * The constraint `with { type: "text" }` imposes (decision 11.200), guarded rather than
         * remembered.
         *
         * A webfont or a PNG cannot be inlined as text, so adding one would break the compiled
         * binary — the distribution that is hardest to test and easiest to forget. Every asset here
         * is text by construction; this asserts the *list* has not grown something that only looks
         * like text.
         */
        for (const [path, asset] of Object.entries(WEB_ASSETS)) {
            expect(typeof asset.body).toBe("string")
            expect(/\.(html|js|css)$/.test(path) || path === "/").toBe(true)
        }
    })
})

describe("the credential boundary", () => {
    test("the shell is open and /v1 is not, on the same server", async () => {
        // The pair is the assertion. Either half alone is satisfied by a server that is entirely
        // open or entirely closed, and both of those are wrong.
        const { call } = await harness({ token: TOKEN })
        for (const path of WEB_PATHS) {
            expect((await call("GET", path, { token: null })).status).toBe(200)
        }
        expect((await call("GET", "/v1/agents", { token: null })).status).toBe(401)
    })

    test("a live operator key does not close the shell", async () => {
        // The latch (11.193) makes an otherwise-open server demand a credential. It must not take
        // the page with it: a locked-out shell is a page that cannot even ask for a key.
        const { call } = await harness()
        await call("POST", "/v1/keys", { body: { label: "browser" } })
        expect((await call("GET", "/v1/agents", { token: null })).status).toBe(401)
        expect((await call("GET", "/", { token: null })).status).toBe(200)
    })
})

describe("there is no catch-all", () => {
    /**
     * **What actually prevents a catch-all is the router, not these tests.**
     *
     * `Router` matches segment by segment and `:name` captures exactly one segment — there is no
     * wildcard to register, which revert-checking proved the hard way: adding `router.add("GET",
     * "/*rest", …)` left every test here **green**, because it registers a route matching the
     * literal segment `*rest` and never fires. So the structural guarantee is the real one.
     *
     * These two still earn their place, because the *reachable* mistake is a fallback in the
     * dispatcher — `if (match.kind === "none" && !pathname.startsWith("/v1")) return the shell` —
     * which is how an SPA fallback would really get added, and which the second test does catch.
     */
    test("a mistyped API path is a JSON 404, never the page", async () => {
        // With a fallback, `/v1/agentss` answers `200 text/html` and a client parsing JSON fails far
        // from the typo with a message about an unexpected `<`. Same shape as `unknown_event_type`
        // one layer down: refuse the unknown name rather than answering something plausible.
        const { call } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/agentss")
        expect(response.status).toBe(404)
        expect(response.headers.get("content-type")).toContain("application/json")
    })

    test("an unknown top-level path is a 404, not the shell", async () => {
        const { call } = await harness({ token: TOKEN })
        for (const path of ["/dashboard", "/assets/app.map", "/index.html"]) {
            const response = await call("GET", path, { token: null })
            expect(response.status).toBe(404)
        }
    })
})

describe("caching", () => {
    test("an ETag is offered and honoured", async () => {
        const { call } = await harness({ token: TOKEN })
        const first = await call("GET", "/assets/app.js", { token: null })
        const etag = first.headers.get("etag")
        expect(etag).toMatch(/^".+"$/)

        const second = await call("GET", "/assets/app.js", {
            token: null,
            headers: { "if-none-match": etag ?? "" },
        })
        // 304 and no body: the point of stable filenames plus an ETag rather than a content hash in
        // the name, which cannot work when the asset list is a list of import statements.
        expect(second.status).toBe(304)
        expect(await second.text()).toBe("")
    })

    test("the ETag changes with the bytes", () => {
        // Derived from the content, so it cannot describe a different build — the failure a
        // hand-maintained version string has.
        const etags = new Set(Object.values(WEB_ASSETS).map((asset) => asset.etag))
        expect(etags.size).toBe(WEB_PATHS.length)
    })

    test("nothing is marked immutable", async () => {
        const { call } = await harness({ token: TOKEN })
        const cache = (await call("GET", "/assets/app.js", { token: null })).headers.get(
            "cache-control",
        )
        // `immutable` promises the bytes at this URL never change, and with stable filenames a
        // rebuild changes them — so a cached page would keep running the previous build's JS
        // against the current build's API with nothing to explain it.
        expect(cache).not.toContain("immutable")
        expect(cache).toContain("no-cache")
    })
})

describe("HEAD and OPTIONS", () => {
    test("HEAD answers like GET with no body", async () => {
        // They are registered in the router rather than short-circuited ahead of it precisely so
        // this works without a second code path deciding what a method means.
        const { call } = await harness({ token: TOKEN })
        const response = await call("HEAD", "/", { token: null })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        expect(await response.text()).toBe("")
    })

    test("a POST to the shell is a 405 naming GET", async () => {
        const { call } = await harness({ token: TOKEN })
        const response = await call("POST", "/", { token: null, body: {} })
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toContain("GET")
    })
})
