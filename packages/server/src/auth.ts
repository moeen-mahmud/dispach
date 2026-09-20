/**
 * Who is calling: one authenticator, for the HTTP dispatcher **and** the WebSocket handshake.
 *
 * It lived inside `handler.ts` and answered *whether*, never *who* — `Response | undefined` — so
 * every scoping question was unanswerable until that signature changed. Two things forced it out
 * into a module at the same time.
 *
 * `/v1/ws` had its **own** comparison, against the configured token only, so a browser holding an
 * operator key could not use WebSocket at all — undocumented, and not a decision. That is the
 * recorded *"a check only one surface performs is a check the two disagree about"* shape, on the one
 * surface where disagreeing means a credential works everywhere except the socket. And a scope has
 * to reach the socket too: a key narrowed to one agent must not receive another agent's events over
 * a transport that skipped the check.
 *
 * So there is one function, it returns a `Principal`, and both front doors call it.
 */

import { keyFingerprint, type OperatorKeyStore } from "@dispach/core"
import type { ClaimTicket } from "./keys.ts"
import type { Principal } from "./principal.ts"
import { claimSpent, timingSafeEqual, unauthorized } from "./respond.ts"

/**
 * The bearer token on a request, or `""`.
 *
 * A **header**, always. A browser WebSocket cannot set one, and the answer to that is the
 * subprotocol — never a query parameter, because a credential in a URL lands in an access log, a
 * `Referer`, and whatever proxies in between. See `bearerFromProtocols`.
 */
function presentedToken(request: Request): string {
    const header = request.headers.get("authorization") ?? ""
    return header.startsWith("Bearer ") ? header.slice(7) : ""
}

/**
 * Whether this request may proceed, checked against every credential this server accepts.
 *
 * ## Three credentials, in a fixed order, and the order is the design
 *
 * 1. **The configured token**, from `server.tokenEnv`. Still a first-class credential and not
 *    demoted to a bootstrap: a platform calls server-to-server with the container's token and has
 *    to keep working once a person has also minted a browser key. It cannot be revoked through this
 *    API — it is the environment's, and a route that could revoke it would be a route that locks an
 *    operator out of their own container.
 * 2. **An operator key**, matched by fingerprint. One indexed read; `auth/keys.ts` carries the
 *    argument for why that is a single SHA-256 rather than a KDF.
 * 3. **The boot claim**, which authenticates `POST /v1/keys` and nothing else. Scoped here rather
 *    than trusted to the route, so a claim presented to any other path is an ordinary `401` instead
 *    of a partial credential whose blast radius depends on which handler remembered to check.
 *
 * The token is tried first because it is a constant-time compare with no I/O, so the common
 * server-to-server case never touches the database. It is deliberately **not** dispatched on the
 * key prefix, which would read as tidier and would lock out an operator whose `server.tokenEnv`
 * value happens to begin with it.
 *
 * ## The failure never says which part was wrong
 *
 * One message for a missing token, a wrong token, a revoked key and an unknown key. Distinguishing
 * them tells an attacker their request *shape* is right, which is the more useful half of the
 * answer — and "revoked" specifically would confirm that a leaked credential had once been real.
 */
export async function authorise(input: {
    readonly request: Request
    readonly expected: string | undefined
    readonly keys: OperatorKeyStore
    readonly claim: ClaimTicket | undefined
    readonly pathname: string
    readonly at: number
}): Promise<Principal | Response> {
    const presented = presentedToken(input.request)

    if (input.expected !== undefined && timingSafeEqual(presented, input.expected)) {
        return { kind: "token" }
    }

    if (presented !== "") {
        const record = await input.keys.findLive(
            await keyFingerprint(presented),
            new Date(input.at).toISOString(),
        )
        if (record !== undefined) {
            // Coarse, and awaited rather than fired and forgotten: an unawaited write can outlive
            // the response and land after the store has closed, which throws from a context with
            // nothing to catch it.
            await input.keys.touch(record.keyId, new Date(input.at).toISOString())
            // The scope travels with the principal rather than being re-read per check: one row
            // read per request, and every later question is answered from the same snapshot, so a
            // key revoked mid-request cannot make two routes in one call disagree about it.
            return {
                kind: "key",
                keyId: record.keyId,
                ...(record.scope === undefined ? {} : { scope: record.scope }),
            }
        }
        if (input.claim !== undefined && timingSafeEqual(presented, input.claim.token)) {
            /**
             * A claim opens exactly one **route**, which is a method *and* a path.
             *
             * Scoping on the path alone is the obvious version and was wrong: `/v1/keys` is shared
             * by the listing, so a claim could read every credential on the server — labels,
             * ids, and which of them are live — before exchanging itself for anything. Caught by
             * the test that asserts it opens one route and no other, which is exactly the shape
             * that would have looked correct in review.
             *
             * Scoped here rather than trusted to the route, so a claim presented anywhere else is
             * an ordinary 401 rather than a partial credential whose blast radius depends on which
             * handler remembered to check.
             */
            if (input.request.method !== "POST" || input.pathname !== "/v1/keys")
                return unauthorized()
            // Recognised and used up. This is the one credential failure worth distinguishing:
            // unlike a wrong key it discloses nothing the caller does not already hold, and the
            // alternative is a bootstrap that fails with no way to tell a spent ticket from a
            // mistyped paste. A claim from an *earlier boot* is not recognisable at all and falls
            // through to the generic answer, which is honest — this process has never seen it.
            if (!input.claim.live()) return claimSpent()
            return { kind: "claim" }
        }
    }

    return unauthorized()
}

/**
 * The bearer a browser WebSocket sends, read out of `Sec-WebSocket-Protocol`.
 *
 * A browser cannot set headers on a WebSocket handshake, which is why `?token=` existed — and a
 * credential in a URL is exactly what this repo's standing rule forbids, because it lands in access
 * logs, in a `Referer`, and in anything that proxies. The subprotocol list is a *header* the
 * browser will send on the caller's behalf: `new WebSocket(url, ["dispach.bearer", key])`.
 *
 * The server must echo the chosen subprotocol back or the browser closes the socket immediately, so
 * `PROTOCOL` is exported for the handshake to return.
 */
export const PROTOCOL = "dispach.bearer"

export function bearerFromProtocols(request: Request): string | undefined {
    const raw = request.headers.get("sec-websocket-protocol")
    if (raw === null) return undefined
    const offered = raw.split(",").map((entry) => entry.trim())
    const at = offered.indexOf(PROTOCOL)
    // The value is the entry *after* the marker, which is the convention every implementation of
    // this trick uses. A marker with nothing after it is a caller that meant to send one and did
    // not, and returning `""` rather than `undefined` keeps that an ordinary failed credential.
    return at === -1 ? undefined : (offered[at + 1] ?? "")
}

/**
 * A request carrying the WebSocket bearer as if it were an ordinary `Authorization` header.
 *
 * So the socket and the HTTP surface authenticate through the **same** `authorise`, rather than the
 * socket growing a second comparison — which is precisely how it came to reject operator keys.
 */
export function withBearerHeader(request: Request, bearer: string): Request {
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${bearer}`)
    return new Request(request.url, { method: request.method, headers })
}
