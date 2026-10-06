/**
 * Firecrawl, first-class (pilot.9): `web_fetch` through its scrape when it is configured, and the two
 * tools only it can back — `web_crawl` (a site's pages) and `web_map` (a site's addresses).
 *
 * **`web_fetch` keeps its spec.** The model must not be able to tell which engine read the page, for
 * the reason `backends.ts` gives for search: a tool that renders differently per machine is a
 * different tool on each. What changes is what it can read — a page that needs JavaScript, or one a
 * plain client is turned away from, comes back as markdown.
 *
 * **The address guard still runs first.** Firecrawl fetches from its own servers, so a private
 * address cannot reach this machine's network through it — but handing a third party the names of
 * hosts on this network is a disclosure of its own, and a refusal that depends on which engine is
 * configured is a refusal nobody can reason about.
 *
 * **Every call is metered** through `ToolContext.meter` in Firecrawl's own unit, credits, read off the
 * response when it says and counted otherwise, so an embedder bills a user's web spend like a model
 * call's. And nothing retries: a failed scrape spent its credit, and a second identical call spends
 * another.
 */

import type { Tool, ToolContext, ToolHandler } from "@dispach/core"
import { webFirecrawlFailed, webFirecrawlKeyMissing, webStatusFailed } from "./errors.ts"
import { FETCH_SPEC, type FetchLike, render } from "./fetch.ts"
import { assertFetchable, type LookupLike, parseUrl } from "./guard.ts"
import { WEB_PROVIDER_ID } from "./paths.ts"

const BASE = "https://api.firecrawl.dev/v2"

/** Clamped this far under the harness deadline, as every tool here is. */
const DEADLINE_MARGIN_MS = 3_000
/** Firecrawl's own default for a scrape, and its documented ceiling. */
const SCRAPE_TIMEOUT_MS = 60_000
/** Between crawl status checks. A crawl of a handful of pages takes seconds, not minutes. */
const POLL_MS = 2_000
/** What a crawl's pages may take of the observation, together. */
const CRAWL_CHARS = 12_000
const MAP_CHARS = 6_000

export const DEFAULT_CRAWL_PAGES = 5
export const MAX_CRAWL_PAGES = 20
export const DEFAULT_MAP_LINKS = 100
export const MAX_MAP_LINKS = 500

export interface FirecrawlConfig {
    /** Env var *name*. Never a key. */
    readonly apiKeyEnv: string
    readonly onlyMainContent: boolean
    /** Its API's address before the path, for a relay that adds the real key (pilot.10). */
    readonly baseUrl?: string
    /** Accept Firecrawl's cached copy this recent, in milliseconds. Its own default when absent. */
    readonly maxAgeMs?: number
    readonly timeoutMs?: number
}

export interface FirecrawlOptions {
    readonly config: FirecrawlConfig
    readonly env: Readonly<Record<string, string | undefined>>
    readonly fetch: FetchLike
    readonly lookup: LookupLike
}

/** Read a field off an unknown payload without trusting its shape. */
function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined
}

function text(value: unknown): string {
    if (typeof value === "string") return value
    // `metadata.title` is "string or array" in Firecrawl's own schema.
    if (Array.isArray(value) && typeof value[0] === "string") return value[0]
    return ""
}

function credits(payload: unknown, fallback: number): number {
    const used = field(payload, "creditsUsed")
    return typeof used === "number" && Number.isFinite(used) ? used : fallback
}

async function call(
    options: FirecrawlOptions,
    operation: string,
    path: string,
    init: { readonly method: "GET" | "POST" | "DELETE"; readonly body?: unknown },
    signal: AbortSignal,
): Promise<unknown> {
    const key = options.env[options.config.apiKeyEnv] ?? ""
    // At call time, like search's key: a manifest naming Firecrawl on a machine without the key
    // must still boot, and say so only when a tool that needs it runs.
    if (key === "") throw webFirecrawlKeyMissing(options.config.apiKeyEnv)
    const response = await options.fetch(`${options.config.baseUrl ?? BASE}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
    })
    if (!response.ok) {
        let detail = response.statusText
        try {
            const body = await response.text()
            const said = text(field(safeJson(body), "error"))
            detail = said !== "" ? said : body.length > 300 ? `${body.slice(0, 300)}…` : body
        } catch {
            // The status is the information.
        }
        throw webFirecrawlFailed(operation, response.status, detail)
    }
    return (await response.json()) as unknown
}

function safeJson(body: string): unknown {
    try {
        return JSON.parse(body) as unknown
    } catch {
        return undefined
    }
}

/** The call's own deadline, joined to the turn's cancellation. */
function bounded(
    context: ToolContext,
    ceilingMs: number,
): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController()
    const abort = () => controller.abort()
    context.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(
        abort,
        Math.min(ceilingMs, Math.max(1_000, context.deadlineMs - DEADLINE_MARGIN_MS)),
    )
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer)
            context.signal.removeEventListener("abort", abort)
        },
    }
}

async function guarded(raw: string, options: FirecrawlOptions): Promise<URL> {
    const url = parseUrl(raw)
    await assertFetchable(url, options.lookup)
    return url
}

/** `web_fetch`, read through Firecrawl's scrape. Same spec, same observation. */
export function firecrawlFetchTool(options: FirecrawlOptions): Tool {
    const handler: ToolHandler = async (args, context) => {
        const raw = String(args.url ?? "")
        const url = await guarded(raw, options)
        // Firecrawl's own timeout sits inside this call's, so its answer arrives before ours gives up.
        const timeout = Math.max(
            1_000,
            Math.min(
                options.config.timeoutMs ?? SCRAPE_TIMEOUT_MS,
                context.deadlineMs - 2 * DEADLINE_MARGIN_MS,
            ),
        )
        const { signal, done } = bounded(context, timeout + DEADLINE_MARGIN_MS)
        try {
            const payload = await call(
                options,
                "scrape",
                "/scrape",
                {
                    method: "POST",
                    body: {
                        url: url.href,
                        formats: ["markdown"],
                        onlyMainContent: options.config.onlyMainContent,
                        timeout,
                        ...(options.config.maxAgeMs === undefined
                            ? {}
                            : { maxAge: options.config.maxAgeMs }),
                    },
                },
                signal,
            )
            context.meter?.({
                provider: "firecrawl",
                operation: "scrape",
                unit: "credits",
                units: credits(payload, 1),
            })
            const data = field(payload, "data")
            const metadata = field(data, "metadata")
            const status = field(metadata, "statusCode")
            const final =
                text(field(metadata, "url")) || text(field(metadata, "sourceURL")) || url.href
            if (typeof status === "number" && status >= 400) {
                throw webStatusFailed(final, status, text(field(metadata, "error")))
            }
            const title = text(field(metadata, "title"))
            const markdown = text(field(data, "markdown"))
            return render({
                url: final,
                requested: raw,
                ...(title === "" ? {} : { title }),
                text: markdown,
                read: markdown.length,
                capped: false,
                hops: final === url.href ? 0 : 1,
            })
        } finally {
            done()
        }
    }
    return { spec: FETCH_SPEC, handler }
}

export const MAP_SPEC: Tool["spec"] = {
    slug: "web_map",
    provider: WEB_PROVIDER_ID,
    summary: "Lists the page addresses on one website, optionally filtered by a phrase.",
    whenToUse:
        "you need to find the right page on a site you already know — its documentation, pricing, a changelog — before reading it with web_fetch",
    whenNotToUse:
        "you do not know the site yet, which is web_search; you already have the page's address, which is web_fetch; or you need the pages' text, which is web_crawl",
    mutating: false,
    trust: "untrusted",
    policyArg: "url",
    tags: ["read", "web"],
    parameters: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "The site's address, including https://. Public internet only.",
            },
            search: {
                type: "string",
                description:
                    "A word or phrase the addresses should relate to. Leave it out to list them all.",
            },
            limit: {
                type: "integer",
                description: `How many addresses to return, 1 to ${MAX_MAP_LINKS}.`,
                default: DEFAULT_MAP_LINKS,
            },
        },
        required: ["url"],
    },
}

export function mapTool(options: FirecrawlOptions): Tool {
    const handler: ToolHandler = async (args, context) => {
        const url = await guarded(String(args.url ?? ""), options)
        const search = String(args.search ?? "").trim()
        const limit = clamp(args.limit, DEFAULT_MAP_LINKS, MAX_MAP_LINKS)
        const { signal, done } = bounded(context, SCRAPE_TIMEOUT_MS)
        try {
            const payload = await call(
                options,
                "map",
                "/map",
                {
                    method: "POST",
                    body: { url: url.href, limit, ...(search === "" ? {} : { search }) },
                },
                signal,
            )
            context.meter?.({
                provider: "firecrawl",
                operation: "map",
                unit: "credits",
                units: credits(payload, 1),
            })
            const links = (
                Array.isArray(field(payload, "links")) ? (field(payload, "links") as unknown[]) : []
            )
                .map((link) =>
                    typeof link === "string"
                        ? { url: link, title: "" }
                        : { url: text(field(link, "url")), title: text(field(link, "title")) },
                )
                .filter((link) => link.url !== "")
                .slice(0, limit)
            if (links.length === 0) {
                return `No addresses found on ${url.host}${search === "" ? "" : ` for ${JSON.stringify(search)}`}. The site may block crawlers or publish no sitemap; web_fetch on its home page is the other way in.`
            }
            const lines: string[] = []
            let used = 0
            for (const link of links) {
                const line = link.title === "" ? link.url : `${link.url} — ${link.title}`
                if (used + line.length > MAP_CHARS) break
                lines.push(line)
                used += line.length + 1
            }
            const head = `${links.length} address${links.length === 1 ? "" : "es"} on ${url.host}${search === "" ? "" : ` for ${JSON.stringify(search)}`}:`
            const cut =
                lines.length < links.length
                    ? [
                          `incomplete: only the first ${lines.length} are shown; narrow it with search`,
                      ]
                    : []
            return [head, ...cut, "", ...lines].join("\n")
        } finally {
            done()
        }
    }
    return { spec: MAP_SPEC, handler }
}

export const CRAWL_SPEC: Tool["spec"] = {
    slug: "web_crawl",
    provider: WEB_PROVIDER_ID,
    summary: "Reads several pages of one website, following its links, and returns their text.",
    whenToUse:
        "the answer is spread over a section of one site — a documentation chapter, a set of policy pages — and reading the pages one at a time would take many calls",
    whenNotToUse:
        "one page is enough, which is web_fetch; you only need the addresses, which is web_map; or you do not know the site, which is web_search. Each page costs, so keep the limit small",
    mutating: false,
    trust: "untrusted",
    policyArg: "url",
    tags: ["read", "web"],
    parameters: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description:
                    "Where to start, including https://. Only pages on this site are read.",
            },
            limit: {
                type: "integer",
                description: `How many pages to read, 1 to ${MAX_CRAWL_PAGES}.`,
                default: DEFAULT_CRAWL_PAGES,
            },
            includePaths: {
                type: "array",
                items: { type: "string" },
                description:
                    "Only follow addresses whose path matches one of these regular expressions, such as ^/docs/. Leave it out to follow any page on the site.",
            },
        },
        required: ["url"],
    },
}

export function crawlTool(options: FirecrawlOptions): Tool {
    const handler: ToolHandler = async (args, context) => {
        const url = await guarded(String(args.url ?? ""), options)
        const limit = clamp(args.limit, DEFAULT_CRAWL_PAGES, MAX_CRAWL_PAGES)
        const includePaths = Array.isArray(args.includePaths)
            ? args.includePaths.map((path) => String(path)).filter((path) => path !== "")
            : []
        const { signal, done } = bounded(context, Number.POSITIVE_INFINITY)
        let id = ""
        try {
            const started = await call(
                options,
                "crawl",
                "/crawl",
                {
                    method: "POST",
                    body: {
                        url: url.href,
                        limit,
                        ...(includePaths.length === 0 ? {} : { includePaths }),
                        scrapeOptions: {
                            formats: ["markdown"],
                            onlyMainContent: options.config.onlyMainContent,
                            ...(options.config.maxAgeMs === undefined
                                ? {}
                                : { maxAge: options.config.maxAgeMs }),
                        },
                    },
                },
                signal,
            )
            id = text(field(started, "id"))
            let status: unknown = {}
            // Polled until it ends or this call's deadline nears; the timer in `bounded` aborts the
            // wait, and what arrived by then is returned rather than thrown away.
            while (!signal.aborted) {
                await sleep(POLL_MS, signal)
                if (signal.aborted) break
                try {
                    status = await call(
                        options,
                        "crawl",
                        `/crawl/${encodeURIComponent(id)}`,
                        { method: "GET" },
                        signal,
                    )
                } catch (error) {
                    // The deadline cut a status check short: keep what the last one returned.
                    if (signal.aborted) break
                    throw error
                }
                const state = text(field(status, "status"))
                if (state === "completed" || state === "failed") break
            }
            const finished = text(field(status, "status"))
            const pages = (
                Array.isArray(field(status, "data")) ? (field(status, "data") as unknown[]) : []
            )
                .map((page) => ({
                    url:
                        text(field(field(page, "metadata"), "sourceURL")) ||
                        text(field(field(page, "metadata"), "url")),
                    markdown: text(field(page, "markdown")),
                }))
                .filter((page) => page.markdown !== "")
            context.meter?.({
                provider: "firecrawl",
                operation: "crawl",
                unit: "credits",
                units: credits(status, pages.length),
            })
            if (finished !== "completed" && id !== "") {
                // Stopped rather than left running: an abandoned crawl keeps spending credits on pages
                // nobody will read.
                await call(
                    options,
                    "crawl",
                    `/crawl/${encodeURIComponent(id)}`,
                    { method: "DELETE" },
                    AbortSignal.timeout(5_000),
                ).catch(() => undefined)
            }
            if (pages.length === 0) {
                return finished === "failed"
                    ? `The crawl of ${url.href} failed and read no pages. Try web_fetch on the page itself.`
                    : `The crawl of ${url.href} read no pages in time. Try a smaller limit, or web_fetch on the page itself.`
            }
            const share = Math.floor(CRAWL_CHARS / pages.length)
            const blocks = pages.map((page) => {
                const body =
                    page.markdown.length > share
                        ? `${page.markdown.slice(0, share).trimEnd()}\n…(cut)`
                        : page.markdown
                return `## ${page.url}\n\n${body}`
            })
            const notes: string[] = []
            if (finished !== "completed")
                notes.push("the crawl did not finish in time, so some pages are missing")
            if (pages.some((page) => page.markdown.length > share)) {
                notes.push(`each page is cut to ${share.toLocaleString("en-US")} characters`)
            }
            return [
                `${pages.length} page${pages.length === 1 ? "" : "s"} from ${url.host}:`,
                ...(notes.length === 0 ? [] : [`incomplete: ${notes.join("; ")}`]),
                "",
                blocks.join("\n\n"),
            ].join("\n")
        } finally {
            done()
        }
    }
    return { spec: CRAWL_SPEC, handler }
}

function clamp(value: unknown, fallback: number, max: number): number {
    const asked = typeof value === "number" ? value : Number(value)
    if (!Number.isFinite(asked)) return fallback
    return Math.min(max, Math.max(1, Math.trunc(asked)))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve()
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop)
            resolve()
        }, ms)
        const stop = () => {
            clearTimeout(timer)
            resolve()
        }
        signal.addEventListener("abort", stop, { once: true })
    })
}
