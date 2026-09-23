/**
 * Serving the browser surface from inside the process that runs the agent.
 *
 * ## The assets are inlined, not read from disk
 *
 * Decision 11.200, and it was measured rather than chosen on taste. `dispach` has to work as a
 * source checkout and as a bundled `dist/` (and, until 0.1.3, as a compiled single-file executable), and
 * `import x from "./f.html" with { type: "file" }` **fails in the middle one** — the emitted sidecar
 * comes back as a *relative* spec that resolves against the process cwd, so any invocation from a
 * directory other than the output one is an `ENOENT`. That is every real invocation:
 * `bun /app/packages/cli/dist/index.js` runs with cwd `/agent`.
 *
 * `with { type: "text" }` works in all three, inlined, with **no sidecar files at all** — so there
 * is nothing to copy into the image, nothing to list in `files`, no `import.meta.url` arithmetic,
 * and the whole `ENOENT` class is gone rather than handled.
 *
 * The constraint it imposes is real and shapes the UI: **no binary assets.** The favicon is an
 * inline SVG data URI and there are no fonts or images. A webfont would be the one thing in the
 * build that could not ride inside the binary.
 *
 * ## Why the shell is reachable without a credential
 *
 * A page load cannot carry a bearer token — there is no header to put one in when a person types a
 * URL. So the shell and its two assets are open, and **everything they display comes from `/v1`
 * with a key.** The page holds no data: an unauthenticated reader learns that a Dispach server is
 * here, which `GET /v1/health` already tells them.
 *
 * ## Stable filenames, and an ETag instead
 *
 * Vite hashes asset names by default; here they are fixed, because an embedded asset list is a list
 * of *import statements* and cannot name a file whose hash moves every build. Freshness comes from
 * an ETag over the bytes, computed once at module load. A hash in a filename only helps a cache that
 * keeps the old file, and there is no old file inside a binary.
 */

// **Relative paths, not `@dispach/web/...`, and this cost a live debugging round.**
//
// The package-subpath form works from source and is destroyed by this package's own build:
// `bun build --packages=external` keeps a *package* import external and **silently drops the
// `with { type: "text" }` attribute**, so `dist/index.js` carries a bare
// `import appJs from "@dispach/web/dist/assets/app.js"` — a module import of a 220 KB browser
// bundle, which fails at load with `Missing 'default' export`. Every test stayed green because
// tests import `src/`, which is the recorded hazard: `bun test` passes against source while the
// bundle is broken. Found by starting the server.
//
// A relative import is not a package boundary, so `--packages=external` does not apply to it and
// the bytes are inlined at build time — which is the whole point. It also says the true thing: this
// is build output of a sibling in the same repo, read at build time, not a runtime dependency.
import appCss from "../../web/dist/assets/app.css" with { type: "text" }
import appJs from "../../web/dist/assets/app.js" with { type: "text" }
import indexHtml from "../../web/dist/index.html" with { type: "text" }

export interface WebAsset {
    readonly body: string
    readonly contentType: string
    /** Quoted, per RFC 9110. Derived from the bytes, so it cannot describe a different build. */
    readonly etag: string
}

/**
 * A cheap, stable digest of the body — FNV-1a over its code units.
 *
 * Not a cryptographic hash and it does not need to be: an ETag answers "is this the same bytes I
 * already have", where the adversary is a stale cache rather than a person. `crypto.subtle.digest`
 * is async and this module is evaluated at import, and making the asset table a promise would put
 * an `await` in front of every static request to save nothing.
 */
function etagOf(body: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < body.length; i += 1) {
        hash ^= body.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return `"${hash.toString(36)}-${body.length.toString(36)}"`
}

function asset(body: string, contentType: string): WebAsset {
    return { body, contentType, etag: etagOf(body) }
}

/**
 * Every path the UI is served at, and there is deliberately **no catch-all**.
 *
 * A wildcard falling back to `index.html` is the usual SPA arrangement and is wrong here for one
 * reason: it makes every mistyped API path answer `200` with a web page. A client calling
 * `/v1/agentss` would get HTML where it expected JSON, and the failure surfaces as a parse error
 * far from the typo — which is exactly the shape `unknown_event_type` was introduced to prevent one
 * layer down. The page has no client-side routes, so nothing needs the fallback.
 */
export const WEB_ASSETS: Readonly<Record<string, WebAsset>> = {
    "/": asset(indexHtml, "text/html; charset=utf-8"),
    "/assets/app.js": asset(appJs, "text/javascript; charset=utf-8"),
    "/assets/app.css": asset(appCss, "text/css; charset=utf-8"),
}

/** The paths above, for the router and for the open-path check, derived so they cannot drift. */
export const WEB_PATHS: readonly string[] = Object.keys(WEB_ASSETS)

/**
 * Answer one asset request, honouring `If-None-Match`.
 *
 * `no-cache` rather than `no-store`: a browser may keep the file and revalidate, which over a
 * loopback socket is one round trip and no bytes. `immutable` would be wrong with stable filenames
 * — it is a promise that the bytes at this URL never change, and a rebuild changes them.
 */
export function serveAsset(path: string, request: Request): Response | undefined {
    const found = WEB_ASSETS[path]
    if (found === undefined) return undefined

    const headers: Record<string, string> = {
        "content-type": found.contentType,
        etag: found.etag,
        "cache-control": "no-cache",
    }

    if (request.headers.get("if-none-match") === found.etag) {
        return new Response(null, { status: 304, headers })
    }
    return new Response(found.body, { status: 200, headers })
}
