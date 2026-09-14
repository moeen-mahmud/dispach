/**
 * `@dispach/tools-composio` — Composio as a tool provider, over plain HTTP.
 *
 * Composio exposes roughly 25,000 tools across ~1,000 toolkits (25,438 at the time of writing,
 * reported by the live listing). That number is why `tools.pinned` exists: search-then-execute is
 * two-hop reasoning, which is where small models fail, so the catalogue is fixed at load.
 */

import type { Plugin } from "@dispach/core"
import { composioFromConfig } from "./provider.ts"

export { type CacheFile, cachePath, readCache, writeCache } from "./cache.ts"
export {
    type ClientOptions,
    ComposioClient,
    type FetchLike,
    type MetaResult,
    type SessionCreated,
} from "./client.ts"
export {
    composioCacheMiss,
    composioExecuteFailed,
    composioKeyMissing,
    composioNoMatch,
    composioNotConnected,
    composioRequestFailed,
    composioSchemaUnsupported,
    composioSessionKeyMissing,
} from "./errors.ts"
export { type ComposioTool, isMutating, isUnannotated, mapParameters, mapTool } from "./map.ts"
export {
    CONNECT_SLUG,
    CONNECT_SPEC,
    findUrl,
    META_SLUGS,
    type MetaContext,
    metaTools,
    renderConnect,
    renderSearch,
    renderWorkbench,
    SEARCH_SLUG,
    SEARCH_SPEC,
    WORKBENCH_SLUG,
    WORKBENCH_SPEC,
} from "./meta.ts"
export {
    ComposioProvider,
    type ComposioProviderOptions,
    composioFromConfig,
    type RefreshReport,
} from "./provider.ts"
export { readSession, sessionPath, writeSession } from "./session.ts"

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

/**
 * This package as a plugin.
 *
 * Naming it is not a grant. The provider resolves nothing until a manifest selects `composio` under
 * `tools.providers` *and* pins slugs — and naming it while switched off is what makes `available()`
 * run, so an agent can say what it lacks instead of claiming the capability does not exist
 * (decision 4.53's lesson, learned twice).
 */
export default {
    name: "composio",
    version: VERSION,
    dispachApi: "^0.1",
    permissions: [
        { kind: "network", hosts: ["backend.composio.dev"] },
        { kind: "env", vars: ["COMPOSIO_API_KEY"] },
        // The resolution cache, which is what makes a cold boot 27 ms rather than 1,474 ms.
        { kind: "fs", paths: ["<state>/composio"], mode: "write" },
    ],
    setup(context) {
        context.defineToolProvider("composio", composioFromConfig)
    },
} satisfies Plugin
