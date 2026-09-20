/**
 * The one JSON failure shape, and the refusals shared by more than one module.
 *
 * Extracted when `authorise` moved into `auth.ts`: the alternative was `auth.ts` building its own
 * `{ error: … }` body, which is two copies of the wire contract `04-SPEC-WIRE.md` guarantees and
 * `spec.test.ts` checks — and the copies would be right on the day they were written.
 */

import type { ErrorDetail } from "@dispach/core"

export function fail(
    error: ErrorDetail,
    status: number,
    extraHeaders: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    })
}

/**
 * The one refusal every failed credential shares, built in one place so they cannot drift.
 *
 * A missing token, a wrong token, a revoked key, an **expired** key, an unknown key and a claim
 * presented to the wrong path all answer with this. Several of those are tempting to distinguish
 * and every one of them would tell an attacker their request *shape* is right, which is the more
 * useful half of the answer — "revoked" would additionally confirm that a leaked credential had
 * once been real, and "expired" would date it.
 */
export function unauthorized(): Response {
    return fail(
        {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
            hint: "Send Authorization: Bearer <token>, where the token is either the value of the variable named by server.tokenEnv or an operator key from POST /v1/keys. A revoked key, an expired one and a wrong one answer the same way on purpose.",
        },
        401,
    )
}

/** Two callers — the gate and the route's race loser — so the answer cannot differ between them. */
export function claimSpent(): Response {
    return fail(
        {
            code: "claim_spent",
            message: "That claim has already been exchanged.",
            hint: "A claim is good for one key. Use the key it minted; if it is lost, restart with --claim to print a new one — a claim lives in the process rather than the database, so it never outlives the boot that printed it.",
        },
        401,
    )
}

/**
 * This credential is real and may not do this.
 *
 * **`403`, where being out of *scope* is `404`** — and the asymmetry is the point. A scope refusal
 * must not confirm that an agent or a session exists, because that turns a narrow credential into a
 * directory of other tenants'. A capability refusal discloses nothing about what exists: the caller
 * can already see the agent, and answering `404` would tell somebody holding a read-only key that
 * the thing they are plainly reading has vanished.
 */
export function forbidden(capability: string, what: string): Response {
    return fail(
        {
            code: "capability_required",
            message: `This credential cannot ${what}.`,
            hint: `The key is scoped, and "${capability}" is not among its capabilities. GET /v1/keys shows what each key may do; mint another with POST /v1/keys, or use the server token. An unscoped key has all four.`,
            field: "scope.can",
        },
        403,
    )
}

function timingSafe(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

export { timingSafe as timingSafeEqual }
