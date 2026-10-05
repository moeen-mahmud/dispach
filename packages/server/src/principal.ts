/**
 * Who is calling, and how far they reach.
 *
 * `authorise` used to return *whether*, never *who* — `Response | undefined` — so every scoping
 * question was unanswerable until that signature changed. This is the answer, threaded onto
 * `RequestContext` so a route asks about the caller rather than re-deriving them.
 *
 * ## What a scope is, and what it is not
 *
 * A scope narrows an **already-authenticated** caller. It is not an identity system: there are no
 * users, teams, orgs or roles here and there will not be — `docs/06-VELAOPS-INTEGRATION.md` refuses
 * them in four places and Better Auth stays authoritative for the consumer that needs them. What
 * this supplies is *isolation*; `from` on `POST /messages` supplies *attribution*. Those two
 * together are enough to build a collaborative app on, and neither is a user model.
 *
 * ## Out of scope answers 404, never 403
 *
 * Stated here because it is a property of the whole surface rather than of any one route: a refusal
 * that confirms existence turns a narrow credential into a directory of other tenants' agents and
 * sessions. A caller outside its scope sees exactly what a caller asking for something that does
 * not exist sees. The one deliberate exception is a **capability** refusal, which is `403` — that
 * discloses nothing about *what* exists, only about what this credential may do, and answering 404
 * there would tell somebody holding a read-only key that the agent they can plainly read is gone.
 */

import { CAPABILITIES, type Capability, type KeyScope } from "@dispach/core"

/**
 * The caller.
 *
 * `open` is a real member rather than a stand-in for "no principal": a token-less loopback server
 * is a supported configuration, and so is an open path like `/v1/health` on a server that does
 * require credentials elsewhere. Both reach everything, which is exactly today's behaviour — making
 * the field **required** on `RequestContext` is what stops a route forgetting to ask.
 */
export type Principal =
    /** No credential was required for this request. Reaches everything. */
    | { readonly kind: "open" }
    /** The token from `server.tokenEnv`. The operator's own credential; unscoped by definition. */
    | { readonly kind: "token" }
    /** An operator key, with whatever scope it was minted under. */
    | { readonly kind: "key"; readonly keyId: string; readonly scope?: KeyScope }
    /** A one-time claim. Opens `POST /v1/keys` and nothing else; `authorise` enforces that. */
    | { readonly kind: "claim" }

/** Everything an unscoped caller reaches. Absence of a scope is this, not an empty set. */
export const UNSCOPED: Principal = { kind: "open" }

/**
 * May this caller do this kind of thing?
 *
 * A capability set that is absent means **all four**, which is what makes a scope opt-in narrowing
 * and keeps an unscoped key byte-identical to one minted before 18.2. An empty array is a different
 * statement and is honoured as written: a key that may do nothing is a coherent thing to mint,
 * however useless, and quietly promoting it to "everything" would be the worst possible reading.
 */
export function can(principal: Principal, capability: Capability): boolean {
    if (principal.kind !== "key") return principal.kind !== "claim"
    const allowed = principal.scope?.can
    return allowed === undefined || allowed.includes(capability)
}

/**
 * May this caller reach this agent?
 *
 * Applied at `withAgent`, at the listing, and at the event stream — the three places an agent id
 * enters. One predicate rather than three comparisons, because a scope check written out at each
 * site is one that a fourth site added later will not have.
 */
export function reachesAgent(principal: Principal, agentId: string): boolean {
    if (principal.kind !== "key") return principal.kind !== "claim"
    const agents = principal.scope?.agents
    return agents === undefined || agents.includes(agentId)
}

/**
 * May this caller reach this session key?
 *
 * A **prefix**, with a trailing `*` accepted and ignored — a platform mints one key per end-user
 * and their conversations are created afterwards, so an enumerated list would have to be rewritten
 * on every new one. `team_42:` and `team_42:*` mean the same thing, because both spellings will be
 * written by somebody and refusing one would be a refusal nobody can debug from the outside.
 *
 * ⚠️ A prefix is not a namespace: `team_4` also matches `team_42:x`. That is the caller's to get
 * right, and the reason `keys create` prints back what a scope matches rather than only storing it.
 */
export function reachesSession(principal: Principal, sessionKey: string): boolean {
    if (principal.kind !== "key") return principal.kind !== "claim"
    const prefix = principal.scope?.sessions
    if (prefix === undefined) return true
    return sessionKey.startsWith(prefix.endsWith("*") ? prefix.slice(0, -1) : prefix)
}

/**
 * The same scope, as a filter for a query that aggregates across agents and sessions.
 *
 * Derived here, beside `reachesAgent` and `reachesSession`, so the prefix rule (a trailing `*`
 * ignored) is written once. An aggregate is where an omitted filter leaks quietly: a per-sender
 * usage row is identity, and a session-scoped key must not read another tenant's senders from a
 * total it could never have reached turn by turn.
 */
export function scopeFilter(principal: Principal): {
    readonly agentIds?: readonly string[]
    readonly sessionPrefix?: string
} {
    if (principal.kind === "claim") return { agentIds: [] }
    if (principal.kind !== "key") return {}
    const agents = principal.scope?.agents
    const prefix = principal.scope?.sessions
    return {
        ...(agents === undefined ? {} : { agentIds: agents }),
        ...(prefix === undefined
            ? {}
            : { sessionPrefix: prefix.endsWith("*") ? prefix.slice(0, -1) : prefix }),
    }
}

/** Does this principal narrow anything at all? Used to skip filtering on the common path. */
export function isScoped(principal: Principal): boolean {
    if (principal.kind !== "key") return false
    const scope = principal.scope
    return (
        scope !== undefined &&
        (scope.agents !== undefined || scope.sessions !== undefined || scope.can !== undefined)
    )
}

/** A capability name, or `undefined` for anything that is not one. For validating a request. */
export function capabilityOf(value: string): Capability | undefined {
    return CAPABILITIES.find((entry) => entry === value)
}
