/**
 * Four search backends behind one signature.
 *
 * The point of the abstraction is not that the backends are similar — they disagree about the verb,
 * the auth header and the shape of a result — but that **the model must not be able to tell which one
 * is configured**. A catalogue that renders differently per backend makes `web_search` a different
 * tool on different machines, and every prompt written against one becomes a prompt tested against
 * one. So the spec is a constant, the arguments are the same, and everything backend-specific stops
 * here.
 *
 * Each backend is a request builder and a response reader, both pure enough to test with a stub
 * `fetch`. Nothing here retries: a search failure is reported to the model, which can ask again with
 * a better query — a retry loop inside the tool just spends the quota twice on the same bad query.
 */

import { webSearchFailed } from "./errors.ts"

export type BackendId = "tavily" | "brave" | "exa" | "firecrawl"

export const BACKEND_IDS: readonly BackendId[] = ["tavily", "brave", "exa", "firecrawl"]

export interface SearchHit {
    readonly title: string
    readonly url: string
    readonly snippet: string
}

export interface BackendRequest {
    readonly url: string
    readonly init: RequestInit
}

export interface Backend {
    readonly id: BackendId
    /** The env var a manifest defaults to for this backend. Named, never a value. */
    readonly defaultKeyEnv: string
    request(query: string, maxResults: number, apiKey: string): BackendRequest
    read(payload: unknown): readonly SearchHit[]
    /** How the backend bills one search, for `ToolContext.meter`. */
    readonly unit: "credits" | "requests"
    /** What this search cost, read off the response where the backend says; 1 otherwise. */
    units?(payload: unknown): number
}

/** Read a field off an unknown payload without `any` and without trusting its shape. */
function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined
}

function text(value: unknown): string {
    return typeof value === "string" ? value : ""
}

function rows(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : []
}

const TAVILY: Backend = {
    id: "tavily",
    defaultKeyEnv: "TAVILY_API_KEY",
    // A basic-depth search is one credit.
    unit: "credits",
    request(query, maxResults, apiKey) {
        return {
            url: "https://api.tavily.com/search",
            init: {
                method: "POST",
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    query,
                    max_results: maxResults,
                    search_depth: "basic",
                    // Tavily will write a synthesised answer if asked. Deliberately not asked for:
                    // it is a second model's summary of pages nobody checked, arriving as though it
                    // were a search result, and the agent's own model is right there.
                    include_answer: false,
                }),
            },
        }
    },
    read(payload) {
        return rows(field(payload, "results")).map((row) => ({
            title: text(field(row, "title")),
            url: text(field(row, "url")),
            snippet: text(field(row, "content")),
        }))
    },
}

const BRAVE: Backend = {
    id: "brave",
    defaultKeyEnv: "BRAVE_API_KEY",
    unit: "requests",
    request(query, maxResults, apiKey) {
        const url = new URL("https://api.search.brave.com/res/v1/web/search")
        url.searchParams.set("q", query)
        url.searchParams.set("count", String(maxResults))
        return {
            url: url.href,
            init: {
                method: "GET",
                headers: {
                    accept: "application/json",
                    "x-subscription-token": apiKey,
                },
            },
        }
    },
    read(payload) {
        return rows(field(field(payload, "web"), "results")).map((row) => ({
            title: text(field(row, "title")),
            url: text(field(row, "url")),
            snippet: text(field(row, "description")),
        }))
    },
}

const EXA: Backend = {
    id: "exa",
    defaultKeyEnv: "EXA_API_KEY",
    unit: "requests",
    request(query, maxResults, apiKey) {
        return {
            url: "https://api.exa.ai/search",
            init: {
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    query,
                    numResults: maxResults,
                    // A short excerpt per result, not the page. Fetching the page is `web_fetch`'s
                    // job, where it is checked and capped; letting the search backend inline whole
                    // documents would route around both.
                    contents: { text: { maxCharacters: 400 } },
                }),
            },
        }
    },
    read(payload) {
        return rows(field(payload, "results")).map((row) => ({
            title: text(field(row, "title")),
            url: text(field(row, "url")),
            snippet: text(field(row, "text")) || text(field(row, "snippet")),
        }))
    },
}

const FIRECRAWL: Backend = {
    id: "firecrawl",
    defaultKeyEnv: "FIRECRAWL_API_KEY",
    unit: "credits",
    request(query, maxResults, apiKey) {
        return {
            url: "https://api.firecrawl.dev/v2/search",
            init: {
                method: "POST",
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    "content-type": "application/json",
                },
                // No `scrapeOptions`: scraping every hit would inline whole pages into a search and
                // bill a scrape per result. Reading a page is `web_fetch`'s job.
                body: JSON.stringify({ query, limit: maxResults }),
            },
        }
    },
    read(payload) {
        return rows(field(field(payload, "data"), "web")).map((row) => ({
            title: text(field(row, "title")),
            url: text(field(row, "url")),
            snippet: text(field(row, "description")),
        }))
    },
    units(payload) {
        const used = field(payload, "creditsUsed")
        return typeof used === "number" && Number.isFinite(used) ? used : 1
    },
}

const BY_ID: Readonly<Record<BackendId, Backend>> = {
    tavily: TAVILY,
    brave: BRAVE,
    exa: EXA,
    firecrawl: FIRECRAWL,
}

export function backend(id: BackendId): Backend {
    return BY_ID[id]
}

/**
 * Turn a non-2xx into a failure that names the backend.
 *
 * The body is included and capped: a 400 from a search API usually says exactly what was wrong with
 * the query, and dropping it in favour of "search failed" throws away the one useful sentence.
 */
export async function readError(id: BackendId, response: Response): Promise<never> {
    let detail = response.statusText
    try {
        const body = await response.text()
        if (body !== "") detail = body.length > 300 ? `${body.slice(0, 300)}…` : body
    } catch {
        // A body that will not read is not more interesting than the status.
    }
    throw webSearchFailed(id, response.status, detail)
}
