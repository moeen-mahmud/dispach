/**
 * Refusing a request a browser made on somebody else's behalf.
 *
 * ## The attack this stops
 *
 * Nothing here read an `Origin` or `Host` header before this module existed, and a loopback bind is
 * permitted to carry no token at all — so any page an operator visited could **DNS-rebind** to
 * `127.0.0.1:7420` and drive an agent that has a shell. The mechanism: a hostname the attacker
 * controls is served with a short TTL, re-resolves to `127.0.0.1`, and the browser then treats
 * requests to it as same-origin with the attacker's page. No credential is stolen; none is needed,
 * because the server did not ask for one.
 *
 * Even with a token configured it still reached `POST /v1/channels/…`, which is open by prefix.
 *
 * This became urgent rather than theoretical with the always-on server: today it takes a
 * deliberately-started process, so the exposure is one developer. A server that is simply *up*
 * makes it every user, always. MCP made `Origin` validation mandatory after CVE-2026-11624 for the
 * same reason in the same shape.
 *
 * ## Two headers, two different questions
 *
 * `Origin` says which page's script is making the call. **Absent is allowed** — a curl, a channel
 * provider posting a webhook, a scheduled job and the healthcheck all send none, and refusing them
 * to guard against a browser would break every non-browser caller. A browser always sends it on a
 * cross-origin or state-changing request, which is exactly the case worth refusing.
 *
 * `Host` says which name the request was addressed to. That is what a rebinding attack cannot hide:
 * the browser sends the attacker's hostname, because that is the name it resolved. So on a loopback
 * bind — where the set of legitimate names is knowable — a `Host` that is not a loopback name is
 * refused outright, and that single check is what closes the rebinding hole.
 *
 * ## Why the rules differ by bind, and why the port is not checked
 *
 * A **loopback** bind may be token-less, so it is the dangerous one and gets the strict rules. A
 * **non-loopback** bind requires a token by design (`serve` refuses to start otherwise), so the
 * exposure is narrower and the server does not know its own public hostname — nobody can enumerate
 * it in advance. There the rule is same-origin: an `Origin` whose host matches the `Host` the
 * request arrived at is accepted, which is true of a browser on the real deployment and false of a
 * third-party page. `server.allowedOrigins` names anything else.
 *
 * **Port is deliberately not part of the comparison.** `docker run -p 8080:7420` means the browser
 * sends `Origin: http://localhost:8080` at a server bound to 7420, and `vite dev` proxies from
 * 5173 — both legitimate, and an exact-match rule breaks the web UI in the two most common
 * deployments. The discriminator that matters is the *hostname*: a rebinding attacker's origin is
 * `http://evil.example`, never `http://localhost:9999`. Being honest about what this leaves open:
 * another program listening on a different loopback port can still call this one, which is a
 * local-service-to-local-service concern and not the one Origin checking is for.
 */

import type { ErrorDetail } from "@dispach/core"

/** Loopback in every spelling that resolves to this machine, including IPv6 and the bracketed form. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"])

/**
 * Whether a bind address means "this machine only".
 *
 * Lives here rather than in `serve.ts`, which is where it started: `handler.ts` needs it to decide
 * these rules, `serve.ts` needs it to refuse a public bind with no token, and `serve.ts` imports
 * `handler.ts` — so keeping it there made the dependency a cycle. It is a fact about a host string,
 * which is this module's whole subject.
 */
export function isLoopback(host: string): boolean {
    return LOOPBACK.has(host.toLowerCase())
}

/** What the server knows about its own bind, which is what decides the rules. */
export interface OriginPolicy {
    /** The host `serve` was given — `127.0.0.1`, `0.0.0.0`, a name. */
    readonly host: string
    /** Extra origins to accept, exactly as written, scheme included. From `server.allowedOrigins`. */
    readonly allowedOrigins?: readonly string[]
    /**
     * Extra `Host` values to accept on a loopback bind.
     *
     * Needed by anything that reaches a loopback server through a name: a reverse proxy on the same
     * machine, or a `/etc/hosts` entry somebody added on purpose.
     */
    readonly allowedHosts?: readonly string[]
}

/**
 * The host part of a URL-ish string, lowercased, with any port and brackets removed.
 *
 * Returns `undefined` for anything unparseable, and the caller refuses on that — a value we cannot
 * read is not a value we can clear. `null` is the one exception the spec defines: a browser sends
 * `Origin: null` for a sandboxed iframe or a `file://` page, and that is a *stronger* reason to
 * refuse than an unrecognised name.
 */
export function hostOf(value: string): string | undefined {
    const trimmed = value.trim()
    if (trimmed === "" || trimmed.toLowerCase() === "null") return undefined
    try {
        // `Origin` is a full origin, `Host` is `name[:port]` — a scheme makes both parse.
        const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`)
        return url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    } catch {
        return undefined
    }
}

/** Whether a name resolves to this machine by definition rather than by DNS. */
function loopbackName(host: string): boolean {
    // `isLoopback` covers the spellings `serve` accepts as a bind. A browser can also address a
    // loopback server through any `127.x.x.x` address, which is the whole /8 by RFC 1122.
    return isLoopback(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Whether a request may proceed, and why not when it may not.
 *
 * Returns `undefined` for the ordinary case. Called **before** the open-path check rather than
 * after: `POST /v1/channels/…` needs no credential and changes state, so a guard behind
 * authentication would leave the one state-changing open route unprotected.
 */
export function originProblem(request: Request, policy: OriginPolicy): ErrorDetail | undefined {
    const strict = isLoopback(policy.host)
    const rawHost = request.headers.get("host")
    const rawOrigin = request.headers.get("origin")

    if (strict) {
        // The rebinding check. A `Host` we cannot parse is refused too — the alternative is deciding
        // a security question from a string we could not read.
        const host = rawHost === null ? undefined : hostOf(rawHost)
        const named = policy.allowedHosts ?? []
        const hostOk =
            host !== undefined &&
            (loopbackName(host) || named.some((entry) => hostOf(entry) === host))
        if (!hostOk) {
            return {
                code: "host_not_allowed",
                message: `This server does not answer to the host ${rawHost ?? "(absent)"}.`,
                hint: "It is bound to loopback, so only a loopback name or address can legitimately reach it — a request addressed to any other name arrived through DNS pointed at this machine, which is how a web page reaches a local server it was never given access to. Add the name to server.allowedHosts if a proxy on this machine needs it.",
                field: "server.allowedHosts",
            }
        }
    }

    if (rawOrigin === null) return undefined // Not a browser. See the module docstring.

    const origin = hostOf(rawOrigin)
    if (origin !== undefined) {
        if (loopbackName(origin)) return undefined
        if ((policy.allowedOrigins ?? []).some((entry) => hostOf(entry) === origin))
            return undefined
        // On a public bind, same-origin is the test — the server cannot know its own hostname, but
        // the request just told it which name it was addressed to.
        if (!strict && rawHost !== null && hostOf(rawHost) === origin) return undefined
    }

    return {
        code: "origin_not_allowed",
        message: `Refusing a request from the origin ${rawOrigin}.`,
        hint: strict
            ? "This server is bound to loopback, so a page served from anywhere else has no business calling it. Add the origin to server.allowedOrigins if you meant to allow it."
            : "Only a page served from this server's own host may call it. Add the origin to server.allowedOrigins if you meant to allow it — there is no wildcard, deliberately.",
        field: "server.allowedOrigins",
    }
}
