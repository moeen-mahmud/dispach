/**
 * `web_fetch` — one page, as text.
 *
 * One GET. No JavaScript, no crawling, no link-following, no cookie jar, no second request of any
 * kind. Everything on that list is a capability an agent occasionally wants and a capability an
 * attacker reliably wants, and the boundary is much easier to reason about when the tool does exactly
 * one thing.
 *
 * ## Redirects are followed by hand
 *
 * `redirect: "follow"` would let the HTTP client walk to an address nothing checked — the standard way
 * to launder a public URL into an internal one. So the client is told `manual`, every hop is
 * re-checked by the same guard as the first, and the chain is short enough that a tracker gives up
 * before the limit does.
 *
 * ## The byte cap is enforced while reading, not after
 *
 * `await response.text()` on a 50 MB page has already spent the 50 MB by the time anything can
 * measure it. The body is pulled chunk by chunk and the reader is cancelled the moment the cap is
 * reached, so the cap is a statement about bytes off the socket rather than about the size of the
 * observation. Tested on bytes read for exactly that reason.
 */

import type { Tool, ToolContext, ToolHandler } from "@dispach/core"
import {
    webContentUnusable,
    webRequestFailed,
    webStatusFailed,
    webTooManyRedirects,
} from "./errors.ts"
import { extract, isTextual } from "./extract.ts"
import { assertFetchable, type LookupLike, parseUrl } from "./guard.ts"
import { WEB_PROVIDER_ID } from "./paths.ts"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Two megabytes off the socket. A page bigger than this is a download, not a document. */
export const DEFAULT_MAX_BYTES = 2_000_000

/**
 * How much extracted text reaches the model.
 *
 * Sized against `context.observationMaxTokens`' 2,000-token default with room to spare, because a
 * tool whose output does not fit the budget is middle-cut and read again — `config_read` cost 8,040
 * output tokens in one turn learning that. Roughly four characters to a token, so 6,000 characters
 * lands near 1,500.
 */
export const DEFAULT_MAX_CHARS = 6_000

/** Short by design: a legitimate page is one or two hops, a chain is a tracker or a loop. */
export const MAX_REDIRECTS = 5

/** Clamped this far under the harness deadline so this tool's own timeout wins the race. */
const DEADLINE_MARGIN_MS = 3_000
const DEFAULT_TIMEOUT_MS = 20_000

export interface FetchOptions {
    readonly lookup: LookupLike
    readonly fetch: FetchLike
    readonly maxBytes?: number
    readonly userAgent: string
}

export const FETCH_SPEC: Tool["spec"] = {
    slug: "web_fetch",
    provider: WEB_PROVIDER_ID,
    summary: "Reads one web page and returns its text.",
    whenToUse:
        "you have a specific URL — from the person, from a search result, from a document — and need what is actually on that page rather than what you remember about it",
    whenNotToUse:
        "you do not have a URL yet, which is web_search; the address is on this machine or this network, which is refused; or you want a file from disk, which is file_read",
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
                    "The complete address of one page, including https://. Public internet only — addresses on this machine or this network are refused.",
            },
        },
        required: ["url"],
    },
}

export function fetchTool(options: FetchOptions): Tool {
    return { spec: FETCH_SPEC, handler: fetchHandler(options) }
}

/**
 * How long this call may take, leaving the harness' own deadline room to be the outer bound.
 *
 * Same shape as `exec`'s clamp and for the same reason: `limits.toolTimeoutMs` *abandons* a handler
 * rather than killing it, so a tool holding a socket must finish first or leak one per call.
 */
export function effectiveTimeout(deadlineMs: number): number {
    const ceiling = Math.max(1_000, deadlineMs - DEADLINE_MARGIN_MS)
    return Math.min(DEFAULT_TIMEOUT_MS, ceiling)
}

function fetchHandler(options: FetchOptions): ToolHandler {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

    return async (args: Readonly<Record<string, unknown>>, context: ToolContext) => {
        const raw = String(args.url ?? "")
        let url = parseUrl(raw)

        const controller = new AbortController()
        const abort = () => {
            controller.abort()
        }
        context.signal.addEventListener("abort", abort, { once: true })
        const timer = setTimeout(abort, effectiveTimeout(context.deadlineMs))

        try {
            for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
                await assertFetchable(url, options.lookup, hop)

                let response: Response
                try {
                    response = await options.fetch(url.href, {
                        method: "GET",
                        redirect: "manual",
                        signal: controller.signal,
                        headers: {
                            "user-agent": options.userAgent,
                            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
                            "accept-language": "en",
                        },
                    })
                } catch (cause) {
                    throw webRequestFailed(
                        url.href,
                        cause instanceof Error ? cause.message : String(cause),
                    )
                }

                const location = response.headers.get("location")
                if (isRedirect(response.status) && location !== null) {
                    // The body of a redirect is never read, and cancelling it is what returns the
                    // socket to the pool instead of leaving one per hop held open until GC.
                    await response.body?.cancel().catch(() => undefined)
                    if (hop === MAX_REDIRECTS) throw webTooManyRedirects(raw, MAX_REDIRECTS)
                    try {
                        url = new URL(location, url)
                    } catch {
                        throw webRequestFailed(
                            url.href,
                            `it redirected to an unusable address: ${location}`,
                        )
                    }
                    continue
                }

                if (!response.ok) {
                    await response.body?.cancel().catch(() => undefined)
                    throw webStatusFailed(url.href, response.status, response.statusText)
                }

                const contentType = response.headers.get("content-type") ?? ""
                if (!isTextual(contentType)) {
                    await response.body?.cancel().catch(() => undefined)
                    throw webContentUnusable(
                        url.href,
                        contentType.split(";")[0]?.trim() ?? "binary",
                    )
                }

                const { text: body, read, capped } = await readCapped(response, maxBytes)
                const { title, text } = extract(body, contentType)
                return render({
                    url: url.href,
                    requested: raw,
                    ...(title === undefined ? {} : { title }),
                    text,
                    read,
                    capped,
                    hops: hop,
                })
            }
            throw webTooManyRedirects(raw, MAX_REDIRECTS)
        } finally {
            clearTimeout(timer)
            context.signal.removeEventListener("abort", abort)
        }
    }
}

function isRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export interface CappedRead {
    readonly text: string
    /** Bytes actually pulled off the socket. What the cap is a statement about. */
    readonly read: number
    readonly capped: boolean
}

/**
 * Read a response body up to `maxBytes`, then stop pulling.
 *
 * The decoder is streaming so a multi-byte character split across the cap boundary does not become a
 * replacement character in the middle of a word — and the final `decode()` with no argument flushes
 * whatever partial sequence the cut left behind.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<CappedRead> {
    const body = response.body
    if (body === null) return { text: "", read: 0, capped: false }

    const reader = body.getReader()
    const decoder = new TextDecoder("utf-8")
    const parts: string[] = []
    let read = 0
    let capped = false

    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value === undefined) continue
            read += value.byteLength
            if (read >= maxBytes) {
                const keep = value.byteLength - (read - maxBytes)
                parts.push(decoder.decode(value.subarray(0, Math.max(0, keep)), { stream: true }))
                capped = true
                break
            }
            parts.push(decoder.decode(value, { stream: true }))
        }
    } finally {
        // Cancel rather than release: cancelling tells the far end to stop sending, which is the
        // difference between reading 2 MB of a 50 MB page and reading all 50 MB into a socket buffer
        // nobody drains.
        await reader.cancel().catch(() => undefined)
    }

    parts.push(decoder.decode())
    return { text: parts.join(""), read: Math.min(read, maxBytes), capped }
}

export interface Rendered {
    readonly url: string
    readonly requested: string
    readonly title?: string
    readonly text: string
    readonly read: number
    readonly capped: boolean
    readonly hops: number
}

/**
 * The observation.
 *
 * The final URL is printed whenever it differs from what was asked for, because "the page I read is
 * not the page you named" is something the model has to be able to say — a redirect to a login wall
 * or a consent interstitial otherwise reads as the article being strange.
 *
 * Every cap says it was a cap. A page silently cut at 6,000 characters is one the model reasons about
 * as though it had read all of it, which is the same failure as a search returning the first fifty of
 * four hundred matches with nothing saying so.
 */
export function render(result: Rendered): string {
    const lines: string[] = []
    lines.push(result.url)
    if (result.hops > 0 && result.url !== result.requested) {
        lines.push(
            `redirected from ${result.requested} (${result.hops} hop${result.hops === 1 ? "" : "s"})`,
        )
    }
    if (result.title !== undefined) lines.push(`title: ${result.title}`)

    let text = result.text
    let trimmed = false
    if (text.length > DEFAULT_MAX_CHARS) {
        text = text.slice(0, DEFAULT_MAX_CHARS)
        trimmed = true
    }

    const notes: string[] = []
    if (result.capped) {
        notes.push(
            `the download stopped at ${result.read.toLocaleString("en-US")} bytes, so the end of the page is missing`,
        )
    }
    if (trimmed) {
        notes.push(
            `only the first ${DEFAULT_MAX_CHARS.toLocaleString("en-US")} characters are shown`,
        )
    }
    if (notes.length > 0) lines.push(`incomplete: ${notes.join("; ")}`)

    lines.push("")
    lines.push(text === "" ? "(the page has no readable text)" : text)
    return lines.join("\n")
}
