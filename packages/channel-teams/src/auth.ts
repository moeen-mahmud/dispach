/**
 * Bot Framework authentication, both directions, on `node:crypto` and `fetch`.
 *
 * **Inbound.** Every activity Teams POSTs carries `Authorization: Bearer <JWT>`, signed RS256 by the
 * Bot Connector. It is verified against the keys the connector publishes (OpenID metadata → JWKS),
 * and four things must hold beyond the signature: the issuer is the connector, the audience is this
 * bot's app id, the token is inside its lifetime, and — the one a copy-paste verifier skips — the
 * `serviceUrl` claim matches the activity's, because that URL is where the reply is sent. A key's
 * `endorsements` must name the activity's channel. An activity that fails any of it is refused and
 * nothing inside it is read: the text of an unverified activity is exactly what an attacker chose.
 *
 * **Outbound.** A reply needs a bearer token from Entra ID, by client credentials against the bot's
 * tenant (`botframework.com` for a legacy multi-tenant registration). Cached until five minutes
 * before it expires.
 *
 * Keys are fetched on the first inbound activity and cached for a day, and an unknown `kid` refetches
 * once — the connector rotates keys, and a cache that never refreshes refuses every message the day
 * after a rotation. Nothing here runs before `runtime.ready`: the first network call is a delivery.
 */

import { createPublicKey, verify } from "node:crypto"

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const OPENID_METADATA = "https://login.botframework.com/v1/.well-known/openidconfiguration"
export const ISSUER = "https://api.botframework.com"
const SKEW_S = 300
const KEYS_TTL_MS = 24 * 60 * 60 * 1000

/** An RSA signing key from the connector's JWKS. Only the fields this module reads. */
interface Key {
    readonly kty?: string
    readonly n?: string
    readonly e?: string
    readonly kid?: string
    readonly endorsements?: readonly string[]
}

export interface AuthOptions {
    readonly appId: string
    readonly password: string
    /** The bot's Entra tenant. `botframework.com` for a legacy multi-tenant registration. */
    readonly tenantId?: string
    readonly fetch?: FetchLike
    readonly now?: () => number
}

/** Why an activity was refused. Never shown to the sender; logged as the channel's status. */
export class AuthRefused extends Error {}

function decode(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
}

export class BotFrameworkAuth {
    readonly #options: AuthOptions
    readonly #fetch: FetchLike
    readonly #now: () => number
    #keys: { readonly at: number; readonly keys: readonly Key[] } | undefined
    #token: { readonly value: string; readonly until: number } | undefined

    constructor(options: AuthOptions) {
        this.#options = options
        this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
        this.#now = options.now ?? Date.now
    }

    /** Throws `AuthRefused` for anything that is not a genuine activity for this bot. */
    async verify(
        authorization: string | undefined,
        activity: { readonly serviceUrl?: string; readonly channelId?: string },
    ): Promise<void> {
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
        if (token === undefined) throw new AuthRefused("no bearer token")
        const [head, body, signature] = token.split(".")
        if (head === undefined || body === undefined || signature === undefined) {
            throw new AuthRefused("malformed token")
        }
        let header: Record<string, unknown>
        let claims: Record<string, unknown>
        try {
            header = decode(head)
            claims = decode(body)
        } catch {
            throw new AuthRefused("unreadable token")
        }
        if (header.alg !== "RS256")
            throw new AuthRefused(`unexpected algorithm ${String(header.alg)}`)

        const key = await this.#key(String(header.kid ?? ""))
        if (key === undefined)
            throw new AuthRefused("signed by a key the connector does not publish")
        if (
            key.endorsements !== undefined &&
            activity.channelId !== undefined &&
            !key.endorsements.includes(activity.channelId)
        ) {
            throw new AuthRefused(`key not endorsed for channel ${activity.channelId}`)
        }
        const valid = verify(
            "RSA-SHA256",
            Buffer.from(`${head}.${body}`),
            createPublicKey({
                key: { kty: key.kty ?? "RSA", n: key.n ?? "", e: key.e ?? "" },
                format: "jwk",
            }),
            Buffer.from(signature, "base64url"),
        )
        if (!valid) throw new AuthRefused("bad signature")

        const nowS = this.#now() / 1000
        if (claims.iss !== ISSUER) throw new AuthRefused(`issuer ${String(claims.iss)}`)
        if (claims.aud !== this.#options.appId) throw new AuthRefused("token is for another bot")
        if (typeof claims.exp !== "number" || claims.exp < nowS - SKEW_S) {
            throw new AuthRefused("token expired")
        }
        if (typeof claims.nbf === "number" && claims.nbf > nowS + SKEW_S) {
            throw new AuthRefused("token not yet valid")
        }
        // Required, not merely compared when present: the reply to this activity carries the bot's own
        // Entra token to `serviceUrl`, so an activity whose URL the connector did not sign could send
        // that token anywhere.
        if (typeof claims.serviceUrl !== "string" || claims.serviceUrl !== activity.serviceUrl) {
            throw new AuthRefused("serviceUrl is not the one the token was issued for")
        }
    }

    /** A bearer token for the Bot Connector, cached until shortly before it expires. */
    async token(signal?: AbortSignal): Promise<string> {
        if (this.#token !== undefined && this.#token.until > this.#now()) return this.#token.value
        const tenant = this.#options.tenantId ?? "botframework.com"
        const response = await this.#fetch(
            `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
            {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "client_credentials",
                    client_id: this.#options.appId,
                    client_secret: this.#options.password,
                    scope: "https://api.botframework.com/.default",
                }).toString(),
                ...(signal === undefined ? {} : { signal }),
            },
        )
        const body = (await response.json().catch(() => ({}))) as {
            access_token?: string
            expires_in?: number
            error_description?: string
        }
        if (!response.ok || typeof body.access_token !== "string") {
            throw new TokenRefused(
                response.status,
                body.error_description ?? `status ${response.status}`,
            )
        }
        const lifetimeMs = (body.expires_in ?? 3600) * 1000
        this.#token = { value: body.access_token, until: this.#now() + lifetimeMs - 5 * 60 * 1000 }
        return body.access_token
    }

    async #key(kid: string): Promise<Key | undefined> {
        const fresh = this.#keys !== undefined && this.#now() - this.#keys.at < KEYS_TTL_MS
        const cached = fresh ? this.#keys?.keys.find((key) => key.kid === kid) : undefined
        if (cached !== undefined) return cached
        // Unknown kid or a stale cache: fetch once. A rotation lands here the first time a new key
        // signs, instead of refusing every message until a restart.
        const metadata = (await (await this.#fetch(OPENID_METADATA)).json()) as {
            jwks_uri?: string
        }
        if (typeof metadata.jwks_uri !== "string") return undefined
        const jwks = (await (await this.#fetch(metadata.jwks_uri)).json()) as { keys?: Key[] }
        this.#keys = { at: this.#now(), keys: jwks.keys ?? [] }
        return this.#keys.keys.find((key) => key.kid === kid)
    }
}

/** Entra ID refused the bot's credentials: a wrong password or tenant, never worth a retry. */
export class TokenRefused extends Error {
    readonly status: number

    constructor(status: number, detail: string) {
        super(detail)
        this.status = status
    }
}
