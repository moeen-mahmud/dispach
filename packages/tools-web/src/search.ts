/**
 * `web_search` — a query in, a list of results out.
 *
 * **This is not `tools.search`.** That field searches the *provider's tool catalogue* and is off by
 * design; this searches the internet. The two have been confused once already, which is why the
 * distinction is written into `whenNotToUse` where the model reads it rather than only into a doc.
 *
 * The results are `untrusted` and it is worth being explicit about why, because "search results" can
 * sound like data rather than content: every title and every snippet is a string somebody else wrote
 * and chose to have indexed, and a page whose `<title>` is an instruction is a page anyone can
 * publish. The snippet reaches the model inside the untrusted delimiter, and a mutating call after it
 * needs authorisation the turn does not have by default.
 */

import type { Tool, ToolContext, ToolHandler } from "@dispach/core"
import { type BackendId, backend, readError, type SearchHit } from "./backends.ts"
import { webSearchKeyMissing } from "./errors.ts"
import type { FetchLike } from "./fetch.ts"
import { WEB_PROVIDER_ID } from "./paths.ts"

export const DEFAULT_MAX_RESULTS = 5
export const MAX_MAX_RESULTS = 10
/** Long enough to judge a result, short enough that ten of them fit the observation budget. */
const SNIPPET_CHARS = 300

const DEADLINE_MARGIN_MS = 3_000
const DEFAULT_TIMEOUT_MS = 15_000

export interface SearchOptions {
    readonly backend: BackendId
    readonly apiKeyEnv: string
    /** The API's address before the path. The backend's own when absent. */
    readonly baseUrl?: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly fetch: FetchLike
}

export const SEARCH_SPEC: Tool["spec"] = {
    slug: "web_search",
    provider: WEB_PROVIDER_ID,
    summary: "Searches the web and returns titles, addresses and short extracts.",
    whenToUse:
        "you need something current, something you are unsure about, or a page whose address you do not know — prices, news, documentation, whether a thing still exists",
    whenNotToUse:
        "you already have the URL, which is web_fetch; the answer is in a file or in this conversation; or you want to find a tool rather than a page, which this cannot do",
    mutating: false,
    trust: "untrusted",
    policyArg: "query",
    tags: ["read", "web", "search"],
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description:
                    "What to search for, written the way you would type it into a search box. Keywords work better than a full sentence.",
            },
            maxResults: {
                type: "integer",
                description: `How many results to return, 1 to ${MAX_MAX_RESULTS}.`,
                default: DEFAULT_MAX_RESULTS,
            },
        },
        required: ["query"],
    },
}

export function searchTool(options: SearchOptions): Tool {
    return { spec: SEARCH_SPEC, handler: searchHandler(options) }
}

function searchHandler(options: SearchOptions): ToolHandler {
    const chosen = backend(options.backend)

    return async (args: Readonly<Record<string, unknown>>, context: ToolContext) => {
        const query = String(args.query ?? "").trim()
        if (query === "") {
            return "No query was given, so nothing was searched for. Call this again with the words you want to look up."
        }

        const apiKey = options.env[options.apiKeyEnv] ?? ""
        // Checked at call time rather than at construction: a manifest that pins `web_fetch` and not
        // `web_search` is a perfectly good configuration on a machine with no search key, and
        // refusing to build the provider would fail its boot over a tool it never asked for.
        if (apiKey === "") throw webSearchKeyMissing(chosen.id, options.apiKeyEnv)

        const maxResults = clampResults(args.maxResults)
        const { url, init } = chosen.request(
            query,
            maxResults,
            apiKey,
            options.baseUrl ?? chosen.defaultBase,
        )

        const controller = new AbortController()
        const abort = () => {
            controller.abort()
        }
        context.signal.addEventListener("abort", abort, { once: true })
        const timer = setTimeout(
            abort,
            Math.min(DEFAULT_TIMEOUT_MS, Math.max(1_000, context.deadlineMs - DEADLINE_MARGIN_MS)),
        )

        try {
            const response = await options.fetch(url, { ...init, signal: controller.signal })
            if (!response.ok) await readError(chosen.id, response)

            const payload: unknown = await response.json()
            context.meter?.({
                provider: chosen.id,
                operation: "search",
                unit: chosen.unit,
                units: chosen.units?.(payload) ?? 1,
            })
            return render(query, chosen.read(payload).slice(0, maxResults))
        } finally {
            clearTimeout(timer)
            context.signal.removeEventListener("abort", abort)
        }
    }
}

export function clampResults(value: unknown): number {
    const asked = typeof value === "number" ? value : Number(value)
    if (!Number.isFinite(asked)) return DEFAULT_MAX_RESULTS
    return Math.min(MAX_MAX_RESULTS, Math.max(1, Math.trunc(asked)))
}

/**
 * The observation.
 *
 * Numbered, one block per result, address on its own line so the model can hand it straight to
 * `web_fetch`. No ranking commentary and no "top result" framing: the order is the backend's opinion,
 * and dressing it up as a judgement this runtime made would be inventing a fact.
 */
export function render(query: string, hits: readonly SearchHit[]): string {
    if (hits.length === 0) {
        return `No results for ${JSON.stringify(query)}. The search ran and came back empty — a narrower or differently worded query may find something, but do not assume the subject does not exist.`
    }

    const blocks = hits.map((hit, index) => {
        const snippet =
            hit.snippet.length > SNIPPET_CHARS
                ? `${hit.snippet.slice(0, SNIPPET_CHARS).trimEnd()}…`
                : hit.snippet
        return [
            `${index + 1}. ${hit.title === "" ? "(untitled)" : hit.title}`,
            `   ${hit.url}`,
            ...(snippet === "" ? [] : [`   ${snippet.replace(/\s+/g, " ")}`]),
        ].join("\n")
    })

    return [
        `${hits.length} result${hits.length === 1 ? "" : "s"} for ${JSON.stringify(query)}:`,
        "",
        ...blocks,
    ].join("\n")
}
