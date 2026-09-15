/**
 * A pure path router. No dependency, no framework, no regex compilation per request.
 *
 * Framework-free because the surface is fifteen routes with at most three parameters each, and a
 * router is the single easiest thing in a web stack to write correctly. What a framework would add
 * here is a dependency with its own release cadence and its own opinion about error responses —
 * which this project already has, in `ErrorDetail`.
 *
 * Matching is segment-by-segment against a pre-split pattern, so a request costs one array
 * comparison. Parameters are **percent-decoded**, which matters more than it sounds: a session key
 * is `{channel}:{peerId}` and a Telegram group's peer id is negative, so real keys arrive as
 * `tg%3A-100123` and a router that skipped decoding would look up a session that does not exist.
 */

export interface RouteMatch {
    readonly params: Readonly<Record<string, string>>
}

export interface Route<THandler> {
    readonly method: string
    /** `/v1/agents/:id/sessions/:key` — `:name` captures one segment. */
    readonly pattern: string
    readonly handler: THandler
    /**
     * This route answers with an open event stream rather than a finished body.
     *
     * Declared on the route so the one thing that needs to know — `HEAD`, which must not be
     * answered by running a handler that subscribes to something — reads it off the table. A set
     * of stream patterns kept beside the dispatcher would have exactly two entries today and be
     * wrong the first time a third stream is added, with the symptom being a leaked subscription
     * per probe rather than an error.
     */
    readonly streaming: boolean
}

interface Compiled<THandler> extends Route<THandler> {
    readonly segments: readonly string[]
}

export class Router<THandler> {
    readonly #routes: Compiled<THandler>[] = []

    add(
        method: string,
        pattern: string,
        handler: THandler,
        options: { readonly streaming?: boolean } = {},
    ): this {
        this.#routes.push({
            method: method.toUpperCase(),
            pattern,
            handler,
            streaming: options.streaming === true,
            segments: split(pattern),
        })
        return this
    }

    /**
     * Every registered route, in registration order.
     *
     * Exposed so `Allow` headers, `OPTIONS` and the spec guard are all derived from the one table
     * rather than from a second list beside it. A hand-kept list of routes is the shape that has
     * cost this repo a round more than once — `NO_MANIFEST`, `DOCUMENTED_CTRL_LETTERS`,
     * `THRESHOLD_ORDER` — and the failure is always the same: the copy is right when it is written
     * and wrong at the next addition, with nothing reporting the gap.
     *
     * Handlers are deliberately included. A caller that only wants the shape can map it away; one
     * that wants to answer a request from the table (as `HEAD` does) needs them.
     */
    routes(): readonly Route<THandler>[] {
        return this.#routes.map(({ method, pattern, handler, streaming }) => ({
            method,
            pattern,
            handler,
            streaming,
        }))
    }

    /**
     * Find a handler, or report why not.
     *
     * `405` rather than `404` when the path exists under another method: they are different
     * mistakes, and conflating them sends someone looking for a typo in a URL that is correct.
     */
    match(
        method: string,
        pathname: string,
    ):
        | {
              readonly kind: "found"
              readonly handler: THandler
              readonly params: Readonly<Record<string, string>>
              readonly streaming: boolean
          }
        | { readonly kind: "method"; readonly allowed: readonly string[] }
        | { readonly kind: "none" } {
        const parts = split(pathname)
        const pathMatches: Compiled<THandler>[] = []

        for (const route of this.#routes) {
            const params = matchSegments(route.segments, parts)
            if (params === undefined) continue
            pathMatches.push(route)
            if (route.method === method.toUpperCase()) {
                return {
                    kind: "found",
                    handler: route.handler,
                    params,
                    streaming: route.streaming,
                }
            }
        }

        if (pathMatches.length > 0) {
            return { kind: "method", allowed: [...new Set(pathMatches.map((r) => r.method))] }
        }
        return { kind: "none" }
    }
}

function split(path: string): string[] {
    return path.split("/").filter((segment) => segment !== "")
}

function matchSegments(
    pattern: readonly string[],
    parts: readonly string[],
): Record<string, string> | undefined {
    if (pattern.length !== parts.length) return undefined
    const params: Record<string, string> = {}

    for (const [index, expected] of pattern.entries()) {
        const actual = parts[index]
        if (actual === undefined) return undefined
        if (expected.startsWith(":")) {
            // A malformed escape (`%zz`) throws rather than silently producing mojibake, and a
            // path that cannot be decoded is a path that matches nothing.
            try {
                params[expected.slice(1)] = decodeURIComponent(actual)
            } catch {
                return undefined
            }
            continue
        }
        if (expected !== actual) return undefined
    }

    return params
}
