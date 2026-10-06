/**
 * The container-credentials endpoint read by Dispach (pilot.9): a refusal keeps its own code all the
 * way to the turn's error, where the SDK's own provider reduced it to "credentials missing".
 */

import { describe, expect, test } from "bun:test"
import { containerCredentials } from "../src/credentials.ts"
import { classify } from "../src/errors.ts"

const URI = "http://169.254.170.23/v1/credentials"

function endpoint(status: number, body: unknown) {
    const calls: { auth: string | null }[] = []
    const fetchLike = (async (_url: unknown, init?: RequestInit) => {
        calls.push({ auth: new Headers(init?.headers).get("authorization") })
        return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { calls, fetchLike }
}

describe("container credentials", () => {
    test("a refusal's own code is the turn's error code, and stays terminal", async () => {
        const { fetchLike, calls } = endpoint(403, {
            code: "credit_exhausted",
            message: "No credit left.",
        })
        const read = containerCredentials(
            { AWS_CONTAINER_CREDENTIALS_FULL_URI: URI, AWS_CONTAINER_AUTHORIZATION_TOKEN: "tok" },
            fetchLike,
        )
        let thrown: unknown
        try {
            await read?.()
        } catch (error) {
            thrown = error
        }
        expect(calls[0]?.auth).toBe("tok")
        const classified = classify(thrown, "amazon.nova-micro-v1:0", "eu-west-2", "model.main")
        expect(classified.retryable).toBe(false)
        expect(classified.status).toBe(403)
        expect(classified.error.code).toBe("credit_exhausted")
        expect(classified.error.message).toContain("No credit left.")
    })

    test("credentials are read once and reused until near their expiry", async () => {
        const later = new Date(Date.now() + 60 * 60_000).toISOString()
        const { fetchLike, calls } = endpoint(200, {
            AccessKeyId: "AK",
            SecretAccessKey: "SK",
            Token: "ST",
            Expiration: later,
        })
        const read = containerCredentials({ AWS_CONTAINER_CREDENTIALS_FULL_URI: URI }, fetchLike)
        const first = await read?.()
        await read?.()
        expect(first).toMatchObject({
            accessKeyId: "AK",
            secretAccessKey: "SK",
            sessionToken: "ST",
        })
        expect(calls.length).toBe(1)
    })

    test("a URI the SDK would not accept stays with the SDK's own chain", () => {
        expect(
            containerCredentials({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://example.com/c" }),
        ).toBeUndefined()
        expect(containerCredentials({})).toBeUndefined()
    })
})
