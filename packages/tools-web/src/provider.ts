/**
 * The web `ToolProvider`.
 *
 * Like `tools-system` and unlike `tools-composio`, there is no catalogue to fetch: the two tools are
 * module constants, so `resolve()` touches nothing and there is no `refresh()`. A provider that makes
 * network calls *when a tool runs* is fine; a provider that makes them *to know what its tools are*
 * is the thing hard rule 4 forbids during boot, and this has nothing to look up.
 *
 * ## Everything here is untrusted, declared rather than defaulted
 *
 * The registry would default a provider tool to `untrusted` anyway. Declaring it is what keeps the
 * `tool_trust_overridden` warning meaningful — a package that says nothing is indistinguishable from
 * a package that forgot — and it is the more honest statement in this case besides. There is no
 * version of `web_fetch` whose output is trustworthy: the whole tool is "go and read what a stranger
 * wrote".
 *
 * ## The escape hatch nobody gets
 *
 * There is no `allowPrivateAddresses`, no host allowlist, no "internal mode". The single legitimate
 * use of such a setting is reaching a service on the local network, and the honest way to do that is
 * `exec` with `curl`, which is a grant a person makes deliberately and a policy rule can narrow. A
 * flag here would be a quiet way to obtain the same thing while the manifest still reads as though
 * the agent only touches the public web.
 */

import {
    ConfigError,
    type Tool,
    type ToolAvailability,
    type ToolProvider,
    type ToolProviderContext,
} from "@dispach/core"
import { BACKEND_IDS, type BackendId, backend } from "./backends.ts"
import { webConfigInvalid } from "./errors.ts"
import { DEFAULT_MAX_BYTES, type FetchLike, fetchTool } from "./fetch.ts"
import { crawlTool, type FirecrawlConfig, firecrawlFetchTool, mapTool } from "./firecrawl.ts"
import { type LookupLike, systemLookup } from "./guard.ts"
import { WEB_PROVIDER_ID } from "./paths.ts"
import { searchTool } from "./search.ts"

/**
 * What this client calls itself.
 *
 * A real name rather than a browser string. Spoofing Chrome would get past a few bot walls and would
 * also make the request undistinguishable from a person in the logs of whoever is being fetched —
 * which is a thing to do to someone, not a thing to do by default. Sites that block this are sites
 * that have said what they want.
 */
const USER_AGENT = "dispach-agent/0.1 (+https://github.com/moeen-mahmud/dispach)"

export interface WebProviderOptions {
    readonly env: Readonly<Record<string, string | undefined>>
    readonly backend?: BackendId
    /** Env var *name*. Never a key. Defaults to the chosen backend's conventional variable. */
    readonly apiKeyEnv?: string
    readonly maxBytes?: number
    /**
     * Firecrawl, when configured: `web_fetch` reads through its scrape, and `web_crawl` and `web_map`
     * exist. Absent, `web_fetch` is the plain client it always was and the other two are not offered.
     */
    readonly firecrawl?: FirecrawlConfig
    readonly fetch?: FetchLike
    readonly lookup?: LookupLike
}

export const WEB_TOOL_SLUGS: readonly string[] = ["web_search", "web_fetch"]
/** Offered only with Firecrawl configured. */
export const FIRECRAWL_TOOL_SLUGS: readonly string[] = ["web_crawl", "web_map"]

function normalise(slug: string): string {
    return slug.toLowerCase().replace(/[\s_.-]+/g, "")
}

export class WebProvider implements ToolProvider {
    readonly id = WEB_PROVIDER_ID

    readonly #tools: readonly Tool[]

    constructor(options: WebProviderOptions) {
        const id = options.backend ?? "tavily"
        const chosen = backend(id)
        const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
        const lookup = options.lookup ?? systemLookup

        this.#tools = [
            searchTool({
                backend: id,
                apiKeyEnv: options.apiKeyEnv ?? chosen.defaultKeyEnv,
                env: options.env,
                fetch: fetchImpl,
            }),
            ...(options.firecrawl === undefined
                ? [
                      fetchTool({
                          lookup,
                          fetch: fetchImpl,
                          maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
                          userAgent: USER_AGENT,
                      }),
                  ]
                : (() => {
                      const firecrawl = {
                          config: options.firecrawl,
                          env: options.env,
                          fetch: fetchImpl,
                          lookup,
                      }
                      return [
                          firecrawlFetchTool(firecrawl),
                          crawlTool(firecrawl),
                          mapTool(firecrawl),
                      ]
                  })()),
        ]
    }

    /** Every entry, so an agent with none pinned can still say the capability exists. */
    available(): Promise<readonly ToolAvailability[]> {
        return Promise.resolve(
            this.#tools.map((tool) => ({ slug: tool.spec.slug, summary: tool.spec.summary })),
        )
    }

    resolve(slugs: readonly string[]): Promise<readonly Tool[]> {
        const wanted = new Set(slugs.map(normalise))
        return Promise.resolve(this.#tools.filter((tool) => wanted.has(normalise(tool.spec.slug))))
    }

    list(): Promise<readonly string[]> {
        return Promise.resolve(this.#tools.map((tool) => tool.spec.slug))
    }
}

const CONFIG_KEYS = ["backend", "apiKeyEnv", "maxBytes", "firecrawl"] as const
const FIRECRAWL_KEYS = ["apiKeyEnv", "onlyMainContent", "maxAge", "timeoutMs"] as const

export function webFromConfig(context: ToolProviderContext): WebProvider {
    const unknown = Object.keys(context.config).filter(
        (key) => !CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number]),
    )
    if (unknown.length > 0) {
        throw new ConfigError({
            code: "web_config_unknown",
            message: `The web provider's configuration has ${unknown.length === 1 ? "a key" : "keys"} it does not read: ${unknown.join(", ")}.`,
            hint: `Accepted keys are ${CONFIG_KEYS.join(", ")}. Refused rather than ignored, because a setting that looks applied and is not is worse than a rejected manifest. There is deliberately no setting that permits private addresses.`,
            field: "tools.providers.web",
        })
    }

    const backendId = context.config.backend
    if (backendId !== undefined && !BACKEND_IDS.includes(String(backendId) as BackendId)) {
        throw webConfigInvalid(
            "backend",
            `must be one of ${BACKEND_IDS.join(", ")} — got ${JSON.stringify(backendId)}.`,
        )
    }

    const apiKeyEnv = context.config.apiKeyEnv
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || apiKeyEnv === "")) {
        throw webConfigInvalid(
            "apiKeyEnv",
            "must be the non-empty name of an environment variable — never the key itself, which fails validation.",
        )
    }

    const maxBytes = context.config.maxBytes
    if (
        maxBytes !== undefined &&
        (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes < 1_000)
    ) {
        throw webConfigInvalid("maxBytes", "must be a number of at least 1000.")
    }

    const firecrawl = firecrawlConfig(
        context.config.firecrawl,
        backendId === "firecrawl",
        typeof apiKeyEnv === "string" ? apiKeyEnv : undefined,
    )
    return new WebProvider({
        env: context.env,
        ...(firecrawl === undefined ? {} : { firecrawl }),
        ...(backendId === undefined ? {} : { backend: String(backendId) as BackendId }),
        ...(typeof apiKeyEnv === "string" ? { apiKeyEnv } : {}),
        ...(typeof maxBytes === "number" ? { maxBytes } : {}),
    })
}

/**
 * `firecrawl:` read into a config, or `undefined` when Firecrawl is not in use. `backend: firecrawl`
 * turns it on with defaults, so search and fetch never disagree about which service is configured;
 * its key is the search key unless the block names its own.
 */
function firecrawlConfig(
    raw: unknown,
    isSearchBackend: boolean,
    searchKeyEnv: string | undefined,
): FirecrawlConfig | undefined {
    if (raw === undefined && !isSearchBackend) return undefined
    const block = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
    if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
        throw webConfigInvalid("firecrawl", "must be a map, e.g. `firecrawl: {}` for the defaults.")
    }
    const unknownKey = Object.keys(block).find(
        (key) => !FIRECRAWL_KEYS.includes(key as (typeof FIRECRAWL_KEYS)[number]),
    )
    if (unknownKey !== undefined) {
        throw webConfigInvalid(
            `firecrawl.${unknownKey}`,
            `is not a setting. Accepted: ${FIRECRAWL_KEYS.join(", ")}.`,
        )
    }
    const keyEnv = block.apiKeyEnv
    if (keyEnv !== undefined && (typeof keyEnv !== "string" || keyEnv === "")) {
        throw webConfigInvalid(
            "firecrawl.apiKeyEnv",
            "must be the non-empty name of an environment variable.",
        )
    }
    const only = block.onlyMainContent
    if (only !== undefined && typeof only !== "boolean") {
        throw webConfigInvalid("firecrawl.onlyMainContent", "must be true or false.")
    }
    const number = (key: "maxAge" | "timeoutMs", min: number, max: number) => {
        const value = block[key]
        if (value === undefined) return undefined
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
            throw webConfigInvalid(
                `firecrawl.${key}`,
                `must be a number of milliseconds from ${min} to ${max}.`,
            )
        }
        return value
    }
    const maxAgeMs = number("maxAge", 0, 30 * 24 * 60 * 60_000)
    const timeoutMs = number("timeoutMs", 1_000, 300_000)
    return {
        apiKeyEnv:
            typeof keyEnv === "string"
                ? keyEnv
                : isSearchBackend && searchKeyEnv !== undefined
                  ? searchKeyEnv
                  : "FIRECRAWL_API_KEY",
        onlyMainContent: only ?? true,
        ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
}
