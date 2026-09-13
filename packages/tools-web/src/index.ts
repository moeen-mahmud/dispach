/**
 * `@dispach/tools-web` — searching the web and reading one page of it.
 *
 * Two tools, both read-only, both `untrusted` by declaration rather than by default. The interesting
 * part of this package is not the fetching, which is a GET; it is `address.ts` and `guard.ts`, which
 * decide what the agent is allowed to point a GET at. See `README.md` for the boundary this does and
 * does not draw — in particular, that none of it binds `exec`.
 */

import type { Plugin } from "@dispach/core"
import { webFromConfig } from "./provider.ts"

export {
    type AddressKind,
    type AddressVerdict,
    classifyAddress,
    classifyIPv4,
    classifyIPv6,
    parseIPv4,
    parseIPv6,
} from "./address.ts"
export { BACKEND_IDS, type Backend, type BackendId, backend, type SearchHit } from "./backends.ts"
export {
    decodeEntities,
    extract,
    extractTitle,
    htmlToText,
    isTextual,
} from "./extract.ts"
export {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_CHARS,
    effectiveTimeout,
    FETCH_SPEC,
    type FetchLike,
    type FetchOptions,
    fetchTool,
    MAX_REDIRECTS,
    readCapped,
} from "./fetch.ts"
export {
    assertFetchable,
    checkUrlShape,
    type LookupLike,
    parseUrl,
    systemLookup,
} from "./guard.ts"
export { WEB_PROVIDER_ID } from "./paths.ts"
export {
    WEB_TOOL_SLUGS,
    WebProvider,
    type WebProviderOptions,
    webFromConfig,
} from "./provider.ts"
export {
    clampResults,
    DEFAULT_MAX_RESULTS,
    MAX_MAX_RESULTS,
    render,
    SEARCH_SPEC,
    type SearchOptions,
    searchTool,
} from "./search.ts"

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

/**
 * This package as a plugin.
 *
 * Two read-only tools whose whole risk surface is which address they can be pointed at. Registered
 * separately from `system` on purpose: an agent that reads the web and an agent that runs commands
 * are different grants, and a manifest should be able to make one and not the other.
 */
export default {
    name: "web",
    version: VERSION,
    dispachApi: "^0.1",
    permissions: [
        // Any host the agent is pointed at, which is the honest declaration for a fetch tool. The
        // guard that matters is not this list: `web_fetch` refuses a private address outright and
        // has no setting that permits one.
        { kind: "network", hosts: ["*"] },
    ],
    setup(context) {
        context.defineToolProvider("web", webFromConfig)
    },
} satisfies Plugin
