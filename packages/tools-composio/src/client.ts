/**
 * Composio over plain HTTP.
 *
 * Direct `fetch` against `backend.composio.dev/api/v3`, authenticated with an `x-api-key` header.
 * No MCP transport, no SDK, no sidecar — decision 4.6, and the reason is transport rather than taste:
 * Composio's MCP surface 405s the GET stream leg and stalls past 120 s, so the proxy that existed to
 * work around it disappears along with the held-open SSE connection and the rebind bug.
 *
 * `fetch` is injected so every path here is testable without a network, including the failure paths
 * that a live key would make awkward to reach on purpose.
 */

import { trimTrailingSlashes } from "@dispach/core"
import { composioRequestFailed } from "./errors.ts"
import type { ComposioTool } from "./map.ts"

export type FetchLike = (
    input: string,
    init?: {
        method?: string
        headers?: Record<string, string>
        body?: string
        signal?: AbortSignal
    },
) => Promise<Response>

export interface ClientOptions {
    readonly apiKey: string
    /** Ends at the version segment, matching how `model.baseUrl` is specified. */
    readonly baseUrl?: string
    readonly fetch?: FetchLike
}

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3"

/**
 * The router lives on `v3.1`; tool schemas deliberately stay on `v3`.
 *
 * Not an oversight and not laziness. On `v3.1` an omitted version parameter selects the *latest*
 * toolkit version, where `v3` pins `00000000_00` — and this provider caches schemas to disk and
 * boots off that cache. Auto-latest means a cached copy can silently stop matching what the endpoint
 * will accept, which is precisely the drift `refresh()` exists to report rather than absorb. Session
 * endpoints have no cached counterpart, so the newer version costs nothing there.
 */
function routerBase(baseUrl: string): string {
    return /\/v3$/.test(baseUrl) ? baseUrl.replace(/\/v3$/, "/v3.1") : baseUrl
}

/** Composio pages tool listings; 100 is its documented maximum per page. */
const PAGE_SIZE = 100

/** What `POST /tool_router/session` answers with. Only the fields this runtime reads. */
export interface SessionCreated {
    readonly session_id: string
    /** The meta tools this session exposes, by slug. Reported, never used for dispatch. */
    readonly tool_router_tools?: readonly string[]
    readonly warnings?: readonly unknown[]
}

/** The envelope every meta-tool execution comes back in. */
export interface MetaResult {
    readonly ok: boolean
    readonly data: unknown
    readonly error?: string
}

interface Page {
    readonly items?: readonly ComposioTool[]
    readonly next_cursor?: string | null
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined
}

/**
 * Composio's error body is `{error: {message, suggested_fix, ...}}`. Its `suggested_fix` is carried
 * into the message when present — it is the provider's own hint and better than anything guessable
 * from a status code.
 */
async function detailOf(response: Response): Promise<string> {
    let body: unknown
    try {
        body = await response.json()
    } catch {
        return response.statusText === "" ? "no detail in the response body" : response.statusText
    }
    const error = asRecord(asRecord(body)?.error)
    const message = typeof error?.message === "string" ? error.message : undefined
    const fix = typeof error?.suggested_fix === "string" ? error.suggested_fix : undefined
    if (message === undefined) return response.statusText === "" ? "no detail" : response.statusText
    return fix === undefined || fix === "" ? message : `${message} — ${fix}`
}

export class ComposioClient {
    readonly #apiKey: string
    readonly #baseUrl: string
    readonly #fetch: FetchLike

    constructor(options: ClientOptions) {
        this.#apiKey = options.apiKey
        this.#baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL)
        this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    }

    #request(path: string, signal?: AbortSignal): Promise<Response> {
        return this.#fetch(`${this.#baseUrl}${path}`, {
            method: "GET",
            headers: { "x-api-key": this.#apiKey, accept: "application/json" },
            ...(signal === undefined ? {} : { signal }),
        })
    }

    async #get(path: string, signal?: AbortSignal): Promise<unknown> {
        const response = await this.#request(path, signal)
        if (!response.ok) throw composioRequestFailed(response.status, await detailOf(response))
        return response.json()
    }

    /**
     * Fetch one tool's schema.
     *
     * A 404 is returned as `undefined` rather than thrown: the registry's job is to diff what came
     * back against what was asked for and fail naming every missing slug at once, so throwing on the
     * first unknown one would report a single typo and hide the other three. The status is checked
     * directly rather than by matching a thrown error's message — a message is prose and changes.
     */
    async tool(slug: string, signal?: AbortSignal): Promise<ComposioTool | undefined> {
        const response = await this.#request(`/tools/${encodeURIComponent(slug)}`, signal)
        if (response.status === 404) return undefined
        if (!response.ok) throw composioRequestFailed(response.status, await detailOf(response))
        const record = asRecord(await response.json())
        return typeof record?.slug === "string" ? (record as unknown as ComposioTool) : undefined
    }

    /** Every tool slug, paged. Used only to suggest a nearest match when resolution fails. */
    async slugs(signal?: AbortSignal): Promise<readonly string[]> {
        const out: string[] = []
        let cursor: string | undefined
        // Bounded: ~25,000 tools at 100 a page is 255 requests, and a runaway cursor that never
        // advances would otherwise loop forever against a live endpoint.
        for (let page = 0; page < 400; page += 1) {
            const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
            if (cursor !== undefined) query.set("cursor", cursor)
            const body = (await this.#get(`/tools?${query.toString()}`, signal)) as Page
            for (const item of body.items ?? []) {
                if (typeof item.slug === "string") out.push(item.slug)
            }
            const next = body.next_cursor
            if (next === null || next === undefined || next === "" || next === cursor) break
            cursor = next
        }
        return out
    }

    /**
     * Run a tool.
     *
     * `POST /tools/execute/{slug}`, with `user_id` naming which connected account to act as. The
     * response carries `successful` alongside `data`, and a `successful: false` with a 200 status is
     * a tool failure — reporting it as success is how an agent tells someone their email was sent
     * when it was not.
     */
    async execute(
        slug: string,
        args: Readonly<Record<string, unknown>>,
        userId: string,
        signal?: AbortSignal,
    ): Promise<{ readonly ok: boolean; readonly data: unknown; readonly error?: string }> {
        const response = await this.#post(
            `${this.#baseUrl}/tools/execute/${encodeURIComponent(slug)}`,
            { user_id: userId, arguments: args },
            signal,
        )
        if (!response.ok) {
            throw composioRequestFailed(response.status, await detailOf(response))
        }
        const body = asRecord(await response.json()) ?? {}
        const ok = body.successful !== false
        const error = typeof body.error === "string" && body.error !== "" ? body.error : undefined
        return { ok, data: body.data ?? body, ...(error === undefined ? {} : { error }) }
    }

    #post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
        return this.#fetch(path, {
            method: "POST",
            headers: {
                "x-api-key": this.#apiKey,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal }),
        })
    }

    /**
     * Open a router session for one person.
     *
     * **After readiness only.** The session is what makes `COMPOSIO_SEARCH_TOOLS` and
     * `COMPOSIO_MANAGE_CONNECTIONS` reachable, and it is created lazily on the first call rather than
     * at boot — hard rule 4 forbids the request, and an agent that never searches should never pay
     * for one. Its id is persisted, so this runs about once per agent rather than once per turn.
     */
    async createSession(userId: string, signal?: AbortSignal): Promise<SessionCreated> {
        const response = await this.#post(
            `${routerBase(this.#baseUrl)}/tool_router/session`,
            { user_id: userId },
            signal,
        )
        if (!response.ok) throw composioRequestFailed(response.status, await detailOf(response))
        const body = asRecord(await response.json()) ?? {}
        const id = body.session_id
        if (typeof id !== "string" || id === "") {
            throw composioRequestFailed(response.status, "no session_id in the response body")
        }
        return body as unknown as SessionCreated
    }

    /**
     * Run one meta tool inside a session.
     *
     * Returns `notFound` rather than throwing on a 404 so the caller can recreate an expired session
     * and retry once. A session id outlives the process, so the interesting failure is not "this call
     * broke" but "the id on disk refers to something the backend has since dropped" — indistinguishable
     * from a transport error unless the status is read here.
     */
    async executeMeta(
        sessionId: string,
        slug: string,
        args: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
    ): Promise<MetaResult | { readonly notFound: true }> {
        const response = await this.#post(
            `${routerBase(this.#baseUrl)}/tool_router/session/${encodeURIComponent(sessionId)}/execute_meta`,
            { slug, arguments: args },
            signal,
        )
        if (response.status === 404) return { notFound: true }
        if (!response.ok) throw composioRequestFailed(response.status, await detailOf(response))
        const body = asRecord(await response.json()) ?? {}
        // Two shapes in the wild: `execute_meta` documents `{data, error, log_id}` with no boolean,
        // while the meta tools' own schemas carry `successful`. Absent `successful` with a null error
        // is a success; treating the missing field as false would report every good call as failed.
        const error = typeof body.error === "string" && body.error !== "" ? body.error : undefined
        const ok = body.successful === undefined ? error === undefined : body.successful !== false
        return { ok, data: body.data ?? body, ...(error === undefined ? {} : { error }) }
    }
}
