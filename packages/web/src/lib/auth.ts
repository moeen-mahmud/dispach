/**
 * Resolving a credential, which is the page's first job and the one with a wrong answer.
 *
 * The server accepts three (decision 11.194): the configured `server.tokenEnv` value, an operator
 * key, and the boot claim — which opens `POST /v1/keys` and nothing else. A browser can hold a key;
 * it must never be handed the container token, which is the one secret every scheduled caller also
 * uses and the one that cannot be rotated. So the page's job is to *end up holding a key*.
 *
 * ## Four states, and the fourth is the one that is easy to get wrong
 *
 * 1. **A claim in the URL.** `serve` printed it; the operator opened the link. Exchange it for a
 *    key, store the key, and **strip the query immediately** — a one-time token left in the address
 *    bar is in the history, in a bookmark and in whatever syncs them. Decision 11.195 predicted
 *    this cost when it chose the URL form; this is where it gets paid.
 * 2. **A key in storage.** The ordinary case after the first visit.
 * 3. **No credential needed.** A loopback server with no `server.tokenEnv` and no key is genuinely
 *    open, and asking such an operator to paste a token they do not have would be a dead end.
 * 4. **A credential is needed and we have none.** Ask for one. This is *not* the same as state 3
 *    and the difference has to be probed rather than assumed: a live key makes an otherwise-open
 *    server demand one (11.193), so "no token configured" does not imply "open".
 *
 * ## `localStorage`, and what that does and does not risk
 *
 * The key is readable by script on this origin. That is the same exposure the page already has —
 * it is holding a live session, so script on this origin can act as the operator whether or not a
 * string is in storage. The page loads no third-party script and has no external stylesheet, which
 * is the property that actually matters and is enforced by the bundle having no network origins in
 * it. What storage buys is not having to re-exchange a claim on every reload, which is impossible
 * anyway: a claim is good once.
 */

import { createClient, type DispachClient, DispachError } from "@dispach/client"

const STORAGE_KEY = "dispach.key"

export type Credential =
    /** A key we hold, from storage or from a claim we just exchanged. */
    | { readonly kind: "key"; readonly secret: string }
    /** The server asked for nothing. No credential is the correct credential. */
    | { readonly kind: "open" }
    /** A credential is required and we have none, or the one we had stopped working. */
    | { readonly kind: "needed"; readonly because: string }

/** Read the claim out of the URL and remove it from the address bar in the same breath. */
function takeClaimFromUrl(): string | undefined {
    const url = new URL(window.location.href)
    const claim = url.searchParams.get("claim")
    if (claim === null || claim === "") return undefined
    url.searchParams.delete("claim")
    // `replaceState` rather than `pushState`: a back button that restores a spent one-time token to
    // the address bar is the same disclosure with an extra step.
    window.history.replaceState({}, "", url.pathname + url.search + url.hash)
    return claim
}

export function storedKey(): string | undefined {
    try {
        return window.localStorage.getItem(STORAGE_KEY) ?? undefined
    } catch {
        // Private windows and blocked site data throw on access rather than returning null. A page
        // that cannot remember a key still works; it just asks again.
        return undefined
    }
}

export function rememberKey(secret: string): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, secret)
    } catch {
        // Nothing to do and nothing to report: the session in hand is unaffected.
    }
}

export function forgetKey(): void {
    try {
        window.localStorage.removeItem(STORAGE_KEY)
    } catch {
        /* as above */
    }
}

/** Exchange a claim for a key. The secret is in this response and in no other, ever. */
export async function exchangeClaim(baseUrl: string, claim: string): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${claim}` },
        body: JSON.stringify({ label: browserLabel() }),
    })
    const body = (await response.json()) as { secret?: string; error?: { message?: string } }
    if (!response.ok || typeof body.secret !== "string") {
        throw new Error(body.error?.message ?? `The claim was refused (${response.status}).`)
    }
    return body.secret
}

/**
 * A label the operator will recognise in `GET /v1/keys` a month from now.
 *
 * Derived rather than asked for, because a required field on a bootstrap screen is a field people
 * type "x" into. It names the browser and the day, which is enough to answer "which of these three
 * is the laptop I am on" — the only question a listing has to support.
 */
function browserLabel(): string {
    const ua = navigator.userAgent
    const browser = /Firefox\//.test(ua)
        ? "Firefox"
        : /Edg\//.test(ua)
          ? "Edge"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "browser"
    return `${browser} · ${new Date().toISOString().slice(0, 10)}`
}

/**
 * Work out what we can authenticate with, asking the server rather than guessing.
 *
 * The probe is `GET /v1/agents` with whatever we have, because that is a route the UI needs anyway
 * — a credential that authenticates only the health check is not a credential this page can use.
 */
export async function resolveCredential(baseUrl: string): Promise<Credential> {
    const claim = takeClaimFromUrl()
    if (claim !== undefined) {
        try {
            const secret = await exchangeClaim(baseUrl, claim)
            rememberKey(secret)
            return { kind: "key", secret }
        } catch (error) {
            // Fall through to the stored key rather than stopping: an operator who opens a spent
            // claim link twice should land in a working session, not on an error page.
            const because = error instanceof Error ? error.message : String(error)
            const stored = storedKey()
            if (stored === undefined) return { kind: "needed", because }
        }
    }

    const stored = storedKey()
    if (stored !== undefined && (await works(baseUrl, stored)))
        return { kind: "key", secret: stored }
    if (stored !== undefined) {
        // It was revoked, or it belongs to another server on the same port. Either way it is dead,
        // and keeping it would make every later failure look like a network problem.
        forgetKey()
    }

    if (await works(baseUrl, undefined)) return { kind: "open" }
    return {
        kind: "needed",
        because:
            stored === undefined
                ? "This server needs a credential."
                : "The key this browser held no longer works — it was revoked, or this is a different server.",
    }
}

async function works(baseUrl: string, token: string | undefined): Promise<boolean> {
    try {
        await client(baseUrl, token).agents()
        return true
    } catch (error) {
        if (error instanceof DispachError && error.code === "unauthorized") return false
        // A transport failure is not an authentication answer, and treating it as one would show a
        // paste-a-token screen to somebody whose server is simply down.
        throw error
    }
}

export function client(baseUrl: string, token: string | undefined): DispachClient {
    return createClient({ baseUrl, ...(token === undefined ? {} : { token }) })
}
