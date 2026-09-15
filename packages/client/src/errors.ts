/**
 * One error type, carrying what the wire carries.
 *
 * `04-SPEC-WIRE.md` guarantees every failure arrives as `{ error: { code, message, hint, field? } }`
 * and that `code` is stable and machine-readable — so a client that threw `Error("HTTP 409")` would
 * be discarding the only part a caller can branch on, and the hint, which is the part a person
 * reads. `spec.test.ts` now asserts both ends of that promise: every code the server can return is
 * documented, and every reachable failure carries a non-empty hint.
 *
 * A single class rather than one per code. The codes are data — a new one ships whenever the server
 * grows a refusal — and a subclass per code would mean this package needing a release to let a
 * caller catch something the server already sends. Branch on `code`.
 */

/** The shape the server sends. Mirrors `ErrorDetail` in core without importing it. */
export interface WireError {
    readonly code: string
    readonly message: string
    readonly hint?: string
    /** The manifest path or request field at fault, when the server can name one. */
    readonly field?: string
}

export class DispachError extends Error {
    /** Stable and machine-readable. Branch on this, never on `message`. */
    readonly code: string
    /** What to do about it. Empty only if the server sent none, which `spec.test.ts` forbids. */
    readonly hint: string
    readonly field: string | undefined
    /** HTTP status, or `undefined` for a failure that never reached a response. */
    readonly status: number | undefined
    /** The request that produced it, so a caught error is traceable without a log. */
    readonly request: { readonly method: string; readonly path: string } | undefined

    constructor(
        detail: WireError,
        context: {
            readonly status?: number
            readonly method?: string
            readonly path?: string
            readonly cause?: unknown
        } = {},
    ) {
        // The hint is in the message because an uncaught throw prints only that, and the whole
        // argument for hints is that the expensive part of a failure is not knowing what was wrong.
        super(
            detail.hint === undefined
                ? detail.message
                : `${detail.message}\n  hint: ${detail.hint}`,
        )
        this.name = "DispachError"
        this.code = detail.code
        this.hint = detail.hint ?? ""
        this.field = detail.field
        this.status = context.status
        this.request =
            context.method === undefined || context.path === undefined
                ? undefined
                : { method: context.method, path: context.path }
        if (context.cause !== undefined) this.cause = context.cause
    }
}

/**
 * A failure that never reached an HTTP response: DNS, a refused connection, an aborted fetch.
 *
 * Given a code of its own rather than being re-thrown raw, so `catch (e) { if (e instanceof
 * DispachError) }` is a complete answer for a caller. A bare `TypeError: fetch failed` escaping
 * this package would make every call site need two error shapes.
 */
export function transportError(
    error: unknown,
    context: { readonly method: string; readonly path: string; readonly baseUrl: string },
): DispachError {
    const because = error instanceof Error ? error.message : String(error)
    return new DispachError(
        {
            code: "transport_failed",
            message: `${context.method} ${context.path} did not reach ${context.baseUrl}: ${because}`,
            hint: "Check the base URL, that the server is running, and that nothing between you and it is refusing the connection. `GET /v1/health` needs no token and is the cheapest probe.",
        },
        { ...context, cause: error },
    )
}

/**
 * Read an error response body, falling back when it is not the documented shape.
 *
 * A proxy returning an HTML 502 is the case that matters: the status is real information and the
 * body is not JSON, so parsing has to fail into something that still names the status rather than
 * throwing a second error on top of the first.
 */
export async function errorFromResponse(
    response: Response,
    context: { readonly method: string; readonly path: string },
): Promise<DispachError> {
    let detail: WireError | undefined
    try {
        const body = (await response.json()) as { error?: Partial<WireError> }
        if (typeof body.error?.code === "string" && typeof body.error.message === "string") {
            detail = {
                code: body.error.code,
                message: body.error.message,
                ...(body.error.hint === undefined ? {} : { hint: body.error.hint }),
                ...(body.error.field === undefined ? {} : { field: body.error.field }),
            }
        }
    } catch {
        // Not JSON, or an empty body. Handled below rather than propagated: a parse failure here
        // would replace a useful status with a misleading syntax error.
    }

    return new DispachError(
        detail ?? {
            code: `http_${response.status}`,
            message: `${context.method} ${context.path} returned ${response.status} with no error body.`,
            hint: "This is not a response this server produces, so something between you and it answered — a proxy, a gateway, or a load balancer. Check the URL and what is in front of it.",
        },
        { status: response.status, ...context },
    )
}
