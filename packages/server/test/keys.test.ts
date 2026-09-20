/**
 * Operator keys on the wire, and the authentication path they join.
 *
 * The routes are the easy half. What is worth the assertions is `authorise`: three credentials in a
 * fixed order, a one-use claim scoped to one path, and a latch that closes an otherwise-open
 * server. A mistake anywhere in there is a bypass rather than a bug, and none of it is visible from
 * a passing request — an over-permissive auth check makes *every* test greener, which is why the
 * negative cases outnumber the positive ones below.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { Runtime } from "@dispach/core"
import { createClaimTicket } from "../src/keys.ts"
import { serve } from "../src/serve.ts"
import { cleanupWorkspaces, ENV, harness, replyFetch, TOKEN, workspace } from "./harness.ts"

afterAll(cleanupWorkspaces)

/** Mint a key through the route and hand back its secret. The only place one ever exists. */
async function issue(
    call: Awaited<ReturnType<typeof harness>>["call"],
    label = "my browser",
): Promise<{ secret: string; keyId: string }> {
    const response = await call("POST", "/v1/keys", { body: { label } })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { secret: string; keyId: string }
    return body
}

describe("issuing", () => {
    test("returns the secret exactly once, and never again", async () => {
        const { call } = await harness({ token: TOKEN })
        const { secret, keyId } = await issue(call)
        expect(secret.length).toBeGreaterThan(20)

        const listed = await (await call("GET", "/v1/keys")).json()
        const body = JSON.stringify(listed)
        // The property the scheme rests on. Asserted against the whole serialised listing rather
        // than field by field, because a `secret` arriving through a conditional spread would
        // type-check and be invisible to an assertion that names the fields it expects.
        expect(body).not.toContain(secret)
        expect(body).toContain(keyId)
    })

    test("refuses a body with no label", async () => {
        const { call } = await harness({ token: TOKEN })
        const response = await call("POST", "/v1/keys", { body: {} })
        expect(response.status).toBe(400)
        const { error } = (await response.json()) as { error: { code: string; hint: string } }
        expect(error.code).toBe("key_label_required")
        expect(error.hint.length).toBeGreaterThan(0)
    })

    test("refuses a label that would break a listing row", async () => {
        const { call } = await harness({ token: TOKEN })
        for (const label of ["", "   ", "two\nlines", "x".repeat(200)]) {
            const response = await call("POST", "/v1/keys", { body: { label } })
            expect(response.status).toBe(400)
            const { error } = (await response.json()) as { error: { code: string } }
            expect(error.code).toBe("key_label_invalid")
        }
    })

    test("trims the label it stores", async () => {
        const { call } = await harness({ token: TOKEN })
        await issue(call, "  padded  ")
        const { keys } = (await (await call("GET", "/v1/keys")).json()) as {
            keys: { label: string }[]
        }
        expect(keys[0]?.label).toBe("padded")
    })
})

describe("authenticating", () => {
    test("a key works in place of the configured token", async () => {
        const { call } = await harness({ token: TOKEN })
        const { secret } = await issue(call)
        expect((await call("GET", "/v1/agents", { token: secret })).status).toBe(200)
    })

    test("the configured token keeps working after a key exists", async () => {
        // Not a nicety: a platform calls server-to-server with the container's token, and it has to
        // keep working the moment a person mints a browser key. Demoting it to a bootstrap would
        // break every scheduled caller the first time somebody opened the UI.
        const { call } = await harness({ token: TOKEN })
        await issue(call)
        expect((await call("GET", "/v1/agents", { token: TOKEN })).status).toBe(200)
    })

    test("a revoked key stops working", async () => {
        const { call } = await harness({ token: TOKEN })
        const { secret, keyId } = await issue(call)
        expect((await call("GET", "/v1/agents", { token: secret })).status).toBe(200)
        expect((await call("DELETE", `/v1/keys/${keyId}`)).status).toBe(200)
        expect((await call("GET", "/v1/agents", { token: secret })).status).toBe(401)
    })

    test("a wrong key, a revoked key and no token all answer the same", async () => {
        const { call } = await harness({ token: TOKEN })
        const { secret, keyId } = await issue(call)
        await call("DELETE", `/v1/keys/${keyId}`)

        const codes: string[] = []
        for (const token of [null, "wrong", secret, "dispach_notarealkeyatallnotarealkey"]) {
            const response = await call("GET", "/v1/agents", { token })
            expect(response.status).toBe(401)
            const { error } = (await response.json()) as { error: { code: string } }
            codes.push(error.code)
        }
        // One answer for all four. Telling them apart confirms to an attacker that their request
        // *shape* is right, and "revoked" specifically would confirm a leaked credential was real.
        expect(new Set(codes).size).toBe(1)
        expect(codes[0]).toBe("unauthorized")
    })

    test("records that a key was used, coarsely", async () => {
        const { call } = await harness({ token: TOKEN })
        const { secret, keyId } = await issue(call)
        await call("GET", "/v1/agents", { token: secret })
        const { keys } = (await (await call("GET", "/v1/keys")).json()) as {
            keys: { keyId: string; lastUsedAt?: string }[]
        }
        // The column exists so an operator can tell a live credential from a forgotten one. A
        // column nothing writes would be the `includeHistory` shape recorded six times in
        // CLAUDE.md — declared vocabulary with no consumer.
        expect(keys.find((key) => key.keyId === keyId)?.lastUsedAt).toBeDefined()
    })

    test("open paths stay open to a key-holder and to nobody", async () => {
        const { call } = await harness({ token: TOKEN })
        expect((await call("GET", "/v1/health", { token: null })).status).toBe(200)
        expect((await call("GET", "/v1/ready", { token: null })).status).toBe(200)
    })
})

describe("the latch", () => {
    test("a token-less server is open until the first key exists", async () => {
        const { call } = await harness()
        // Open, as it has always been on loopback with no token configured.
        expect((await call("GET", "/v1/agents", { token: null })).status).toBe(200)

        const { secret } = await issue(call)

        /**
         * And now closed. This is the assertion the whole latch exists for: without it, minting a
         * key on a token-less server would do *nothing*, so a browser could show a key-management
         * page on a server every process on the machine can reach unauthenticated. "Looks
         * protected and is not" is worse than being plainly open.
         */
        expect((await call("GET", "/v1/agents", { token: null })).status).toBe(401)
        expect((await call("GET", "/v1/agents", { token: secret })).status).toBe(200)
    })

    test("revoking the last key does not reopen the server", async () => {
        const { call } = await harness()
        const { secret, keyId } = await issue(call)
        expect((await call("DELETE", `/v1/keys/${keyId}`, { token: secret })).status).toBe(200)
        // Deliberate, in the safe direction. The alternative is a `DELETE` whose real effect is to
        // remove authentication from every route, which is not what anybody revoking a credential
        // is asking for. A server meant to be open is one started with no keys.
        expect((await call("GET", "/v1/agents", { token: null })).status).toBe(401)
    })
})

describe("the claim", () => {
    test("exchanges once for a key, and then never again", async () => {
        const claim = createClaimTicket()
        const { call } = await harness({ token: TOKEN, claim })

        const first = await call("POST", "/v1/keys", {
            token: claim.token,
            body: { label: "my browser" },
        })
        expect(first.status).toBe(201)

        const second = await call("POST", "/v1/keys", {
            token: claim.token,
            body: { label: "again" },
        })
        expect(second.status).toBe(401)
        const { error } = (await second.json()) as { error: { code: string } }
        expect(error.code).toBe("claim_spent")
    })

    test("opens one path and no other", async () => {
        const claim = createClaimTicket()
        const { call } = await harness({ token: TOKEN, claim })
        // Scoped in `authorise` rather than trusted to the route, so a claim presented anywhere
        // else is an ordinary 401 instead of a partial credential whose blast radius depends on
        // which handler remembered to check.
        expect((await call("GET", "/v1/agents", { token: claim.token })).status).toBe(401)
        expect((await call("GET", "/v1/keys", { token: claim.token })).status).toBe(401)
        expect((await call("DELETE", "/v1/keys/k_x", { token: claim.token })).status).toBe(401)
        // Still unspent — a refused request must not burn the ticket.
        expect(claim.live()).toBe(true)
    })

    test("is not required when another credential is presented", async () => {
        const claim = createClaimTicket()
        const { call } = await harness({ token: TOKEN, claim })
        await call("POST", "/v1/keys", { token: TOKEN, body: { label: "by token" } })
        // The claim is checked *first* in the route, and this is what that ordering protects: a
        // ticket must not be consumed by a caller that authenticated some other way.
        expect(claim.live()).toBe(true)
    })

    test("a token-less server does not spend the claim on an ordinary request", async () => {
        const claim = createClaimTicket()
        const { call } = await harness({ claim })
        // The sharpest ordering case. With no token and no keys, `authRequired` is false, so the
        // gate never runs — and a claim presented to a route that did not need it would be burned
        // for nothing, leaving the operator with a spent ticket and no key.
        await call("GET", "/v1/agents", { token: claim.token })
        expect(claim.live()).toBe(true)
    })

    test("a refused body does not burn the ticket", async () => {
        const claim = createClaimTicket()
        const { call } = await harness({ token: TOKEN, claim })

        const bad = await call("POST", "/v1/keys", { token: claim.token, body: { label: "" } })
        expect(bad.status).toBe(400)
        /**
         * Which is why the spend happens *after* validation, and why this test exists rather than
         * the ordering being left to read correctly.
         *
         * Burning a one-use bootstrap credential on a malformed label leaves an operator with a
         * spent ticket, no key, and a restart as the only route back in — over a request they could
         * simply have retried. Moving the spend above the validation leaves every other assertion
         * in this file green.
         */
        expect(claim.live()).toBe(true)
        const good = await call("POST", "/v1/keys", {
            token: claim.token,
            body: { label: "second attempt" },
        })
        expect(good.status).toBe(201)
    })

    test("a claim from an earlier boot is not recognised at all", async () => {
        const { call } = await harness({ token: TOKEN })
        const response = await call("POST", "/v1/keys", {
            token: createClaimTicket().token,
            body: { label: "from an earlier boot" },
        })
        expect(response.status).toBe(401)
        const { error } = (await response.json()) as { error: { code: string } }
        // `unauthorized`, not `claim_spent`, and the distinction is honest rather than pedantic: a
        // claim lives in the process that printed it, so this one is a string the server has never
        // seen — indistinguishable from a wrong key, and answered the same way.
        expect(error.code).toBe("unauthorized")
    })
})

describe("through a real bind", () => {
    /**
     * The one claim `createHandler` cannot make, and the eighth instance of the shape.
     *
     * `serve` builds its `createHandler` argument by hand rather than spreading `options`, so a
     * field inherited through `ServeOptions` type-checks and reaches nothing — `approvals` was
     * wrong exactly that way on its first write. Every other test in this file constructs the
     * handler directly, so reverting the one forwarding line in `serve.ts` leaves this as the only
     * thing that goes red.
     *
     * The failure it prevents is a first run that cannot be recovered from: `serve` prints a claim,
     * the operator pastes it, and the server has never heard of it — indistinguishable from a
     * mistyped paste, with the real bootstrap credential sitting unused in a variable.
     */
    test("a claim printed by serve is exchangeable through serve", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [`${dir}/agent.yaml`],
            env: ENV,
            fetch: replyFetch(),
        })
        const claim = createClaimTicket()
        /**
         * **A token is required for this guard to be able to fail**, and its first version had
         * none.
         *
         * With no token and no keys the server is open, so the request succeeded whether or not the
         * claim reached the handler — the test passed with the forwarding line deleted, which is
         * the "passes with the fix reverted" shape this repo has been caught by five times. The
         * token is what makes the claim the *only* thing that can authorise this call.
         */
        const running = await serve({
            runtime,
            host: "127.0.0.1",
            port: 0,
            token: TOKEN,
            claim,
        })
        try {
            const response = await fetch(`${running.url}/v1/keys`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${claim.token}`,
                },
                body: JSON.stringify({ label: "my browser" }),
            })
            // 201, not 401. A 401 here is the forwarding bug and nothing else.
            expect(response.status).toBe(201)
            const { secret } = (await response.json()) as { secret: string }
            // And the key it minted really authenticates, which is what makes the claim worth
            // printing rather than merely accepted.
            const listed = await fetch(`${running.url}/v1/keys`, {
                headers: { authorization: `Bearer ${secret}` },
            })
            expect(listed.status).toBe(200)
        } finally {
            await running.stop()
            await runtime.stop("test over")
        }
    })
})

describe("revoking", () => {
    test("is idempotent and keeps the original stamp", async () => {
        const { call } = await harness({ token: TOKEN })
        const { keyId } = await issue(call)
        const first = (await (await call("DELETE", `/v1/keys/${keyId}`)).json()) as {
            revokedAt: string
        }
        const second = await call("DELETE", `/v1/keys/${keyId}`)
        // A retried DELETE is not a mistake, so it is a 200 — and it must not rewrite history.
        expect(second.status).toBe(200)
        expect(((await second.json()) as { revokedAt: string }).revokedAt).toBe(first.revokedAt)
    })

    test("an unknown id is a 404 with a hint", async () => {
        const { call } = await harness({ token: TOKEN })
        const response = await call("DELETE", "/v1/keys/k_nope")
        expect(response.status).toBe(404)
        const { error } = (await response.json()) as { error: { code: string; hint: string } }
        expect(error.code).toBe("key_not_found")
        // The hint has to be *about keys*. `notFound`'s default one talks about case-sensitivity
        // and channel segments — correct for the 404 this server returns most often, and advice to
        // look in the wrong place here. A non-empty assertion passed happily on the wrong sentence,
        // which is why this names what the sentence has to mention.
        expect(error.hint).toContain("keyId")
        expect(error.hint).not.toContain("channel segment")
    })
})

describe("the listing", () => {
    test("says on the wire what a key reaches, and what a scope is not", async () => {
        const { call } = await harness({ token: TOKEN })
        const body = (await (await call("GET", "/v1/keys")).json()) as { scope: string }
        /**
         * The plan's rule was "said in the UI, not discovered". A UI is one consumer of this route,
         * and a property nobody states is one every client re-derives differently.
         *
         * The sentence had to **change with the behaviour** in 18.2, which is the whole reason this
         * is asserted: it used to read "Every key authenticates every route for every agent", true
         * until a scope could narrow one — and a client that had cached that claim would now be
         * wrong about its own credential. So the assertion covers all three things it must say.
         */
        expect(body.scope).toContain("no scope")
        expect(body.scope).toContain("narrows")
        // And what it is not, in the same place — because the field names will be read as a role
        // system by the first person who sees them.
        expect(body.scope).toContain("not an identity")
    })

    test("shows revoked keys rather than hiding them", async () => {
        const { call } = await harness({ token: TOKEN })
        const { keyId } = await issue(call, "first")
        await issue(call, "second")
        await call("DELETE", `/v1/keys/${keyId}`)
        const { keys } = (await (await call("GET", "/v1/keys")).json()) as {
            keys: { label: string; revokedAt?: string }[]
        }
        expect(keys.length).toBe(2)
        expect(keys.filter((key) => key.revokedAt !== undefined).length).toBe(1)
    })
})
