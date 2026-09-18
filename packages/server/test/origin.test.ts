/**
 * The origin guard, which is the only thing standing between a loopback server and any web page
 * the operator happens to visit.
 *
 * Worth the density of negative cases: an over-permissive origin check makes every *other* test
 * greener, and the failure it admits is silent — a page that drives an agent with a shell and looks
 * to the server exactly like the operator's own browser. So the matrix is deliberate: `Origin`
 * absent / allowed / hostile, against a loopback bind and a public one, on an open route and an
 * authenticated one.
 *
 * `originProblem` is tested directly because it is pure and the interesting part is the decision
 * table. The wiring is tested through `createHandler` for one reason only, and it is the reason the
 * guard sits where it does: `POST /v1/channels/…` needs no credential and changes state, so a
 * check behind authentication would leave it open.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { hostOf, isLoopback, originProblem } from "../src/origin.ts"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

/** A request with only the headers a case is about. `Host` is settable in Bun; a browser's is not. */
function req(headers: { host?: string; origin?: string }, method = "GET"): Request {
    const init: Record<string, string> = {}
    if (headers.host !== undefined) init.host = headers.host
    if (headers.origin !== undefined) init.origin = headers.origin
    return new Request("http://127.0.0.1:7420/v1/ready", { method, headers: init })
}

const LOOPBACK = { host: "127.0.0.1" } as const
const PUBLIC = { host: "0.0.0.0" } as const

describe("a loopback bind is the strict case, because it may have no token", () => {
    test("a request with no Origin is allowed — curl, a webhook, a healthcheck", () => {
        expect(originProblem(req({ host: "127.0.0.1:7420" }), LOOPBACK)).toBeUndefined()
    })

    test("a loopback Origin on a different port is allowed, and that is not laxity", () => {
        // `-p 8080:7420` and `vite dev` on 5173 both change the port legitimately, and an
        // exact-match rule would break the web UI in the two most common deployments. The
        // discriminator a rebinding attack cannot fake is the hostname, not the port.
        expect(
            originProblem(
                req({ host: "localhost:8080", origin: "http://localhost:8080" }),
                LOOPBACK,
            ),
        ).toBeUndefined()
        expect(
            originProblem(
                req({ host: "localhost:7420", origin: "http://localhost:5173" }),
                LOOPBACK,
            ),
        ).toBeUndefined()
    })

    test("a page served from anywhere else is refused", () => {
        const problem = originProblem(
            req({ host: "127.0.0.1:7420", origin: "https://evil.example" }),
            LOOPBACK,
        )
        expect(problem?.code).toBe("origin_not_allowed")
        expect(problem?.field).toBe("server.allowedOrigins")
    })

    test("**the rebinding case**: a Host that is not a loopback name is refused outright", () => {
        // The one check that closes the hole. A rebinding page's DNS points at this machine, so the
        // request arrives — but the browser sends the name it resolved, which it cannot hide.
        // Refused with *no* Origin at all, because that is the shape a non-browser caller has and
        // an attacker could imitate.
        const problem = originProblem(req({ host: "evil.example" }), LOOPBACK)
        expect(problem?.code).toBe("host_not_allowed")
        expect(problem?.field).toBe("server.allowedHosts")
    })

    test("Host is checked before Origin, so a matching hostile pair still reads as rebinding", () => {
        // Both headers agreeing is what a rebinding request looks like from the inside. Reporting
        // `origin_not_allowed` would send somebody to the wrong setting.
        expect(
            originProblem(req({ host: "evil.example", origin: "http://evil.example" }), LOOPBACK)
                ?.code,
        ).toBe("host_not_allowed")
    })

    test("an absent Host is refused, because HTTP/1.1 requires one", () => {
        expect(originProblem(req({}), LOOPBACK)?.code).toBe("host_not_allowed")
    })

    test("the whole 127/8 is loopback, not just 127.0.0.1", () => {
        expect(originProblem(req({ host: "127.0.0.5:7420" }), LOOPBACK)).toBeUndefined()
        expect(originProblem(req({ host: "[::1]:7420" }), LOOPBACK)).toBeUndefined()
    })

    test("`Origin: null` is refused rather than treated as absent", () => {
        // A sandboxed iframe and a `file://` page both send it. That is a *stronger* reason to
        // refuse than an unrecognised name, so it must not fall through the absent-Origin branch.
        expect(originProblem(req({ host: "127.0.0.1:7420", origin: "null" }), LOOPBACK)?.code).toBe(
            "origin_not_allowed",
        )
    })

    test("allowedHosts is the escape for a proxy on this machine", () => {
        expect(
            originProblem(req({ host: "agent.local" }), {
                host: "127.0.0.1",
                allowedHosts: ["agent.local"],
            }),
        ).toBeUndefined()
    })

    test("allowedOrigins widens the origin check and nothing else", () => {
        const policy = { host: "127.0.0.1", allowedOrigins: ["https://app.example.com"] }
        expect(
            originProblem(
                req({ host: "127.0.0.1:7420", origin: "https://app.example.com" }),
                policy,
            ),
        ).toBeUndefined()
        // Still refuses a different one — an allowlist entry is not a wildcard.
        expect(
            originProblem(req({ host: "127.0.0.1:7420", origin: "https://other.example" }), policy)
                ?.code,
        ).toBe("origin_not_allowed")
    })
})

describe("a public bind requires a token, so the rule is same-origin", () => {
    test("Host is not checked, because the server cannot know its own public name", () => {
        expect(originProblem(req({ host: "agent.example.com" }), PUBLIC)).toBeUndefined()
    })

    test("a browser on the real deployment is allowed without any configuration", () => {
        expect(
            originProblem(
                req({ host: "agent.example.com", origin: "https://agent.example.com" }),
                PUBLIC,
            ),
        ).toBeUndefined()
    })

    test("a third-party page is refused, which is the cross-site case", () => {
        expect(
            originProblem(
                req({ host: "agent.example.com", origin: "https://evil.example" }),
                PUBLIC,
            )?.code,
        ).toBe("origin_not_allowed")
    })

    test("loopback stays allowed on a public bind, for a probe on the box itself", () => {
        expect(
            originProblem(
                req({ host: "agent.example.com", origin: "http://localhost:7420" }),
                PUBLIC,
            ),
        ).toBeUndefined()
    })
})

describe("hostOf", () => {
    test("reads a host out of either header shape, and refuses what it cannot read", () => {
        expect(hostOf("https://App.Example.com:8443")).toBe("app.example.com")
        expect(hostOf("localhost:7420")).toBe("localhost")
        expect(hostOf("[::1]:7420")).toBe("::1")
        expect(hostOf("null")).toBeUndefined()
        expect(hostOf("")).toBeUndefined()
        expect(hostOf("  ")).toBeUndefined()
    })

    test("isLoopback knows the spellings `serve` accepts as a bind", () => {
        for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"]) {
            expect(isLoopback(host)).toBe(true)
        }
        expect(isLoopback("0.0.0.0")).toBe(false)
        expect(isLoopback("agent.example.com")).toBe(false)
    })
})

describe("wired ahead of the open-path check, which is the point", () => {
    test("**the open webhook route is refused**, where authentication would not have helped", async () => {
        // `isOpenPath` matches `/v1/channels/` by *prefix*, and this route changes state. It is the
        // half of the rebinding hole a configured token leaves open, so it is the one case that
        // proves the guard's position rather than merely its logic.
        const { call } = await harness({ token: TOKEN, origin: LOOPBACK })
        const response = await call("POST", "/v1/channels/tg/webhook/assistant", {
            headers: { host: "127.0.0.1:7420", origin: "https://evil.example" },
            body: {},
        })
        expect(response.status).toBe(403)
        const { error } = (await response.json()) as { error: { code: string } }
        expect(error.code).toBe("origin_not_allowed")
    })

    test("an open probe is refused on a hostile Host and answered on a loopback one", async () => {
        const { call } = await harness({ token: TOKEN, origin: LOOPBACK })
        expect((await call("GET", "/v1/ready", { headers: { host: "evil.example" } })).status).toBe(
            403,
        )
        expect(
            (await call("GET", "/v1/ready", { headers: { host: "127.0.0.1:7420" } })).status,
        ).toBe(200)
    })

    test("an authenticated route is refused before the token is even considered", async () => {
        // 403 rather than 401, and with a *valid* token: a cross-origin caller holding the right
        // credential is still a cross-origin caller, and answering 401 would say the credential was
        // the problem.
        const { call } = await harness({ token: TOKEN, origin: LOOPBACK })
        const response = await call("GET", "/v1/agents", {
            headers: { host: "127.0.0.1:7420", origin: "https://evil.example" },
        })
        expect(response.status).toBe(403)
    })

    test("HEAD goes through the same guard", async () => {
        const { call } = await harness({ token: TOKEN, origin: LOOPBACK })
        expect(
            (await call("HEAD", "/v1/health", { headers: { host: "evil.example" } })).status,
        ).toBe(403)
    })

    test("a handler built with no bind does no checking at all", async () => {
        // The escape every other test in this package depends on, stated rather than incidental: a
        // constructed `Request` carries no `Host`, so a policy-bearing handler would refuse the
        // whole existing suite.
        const { call } = await harness({ token: TOKEN })
        expect(
            (await call("GET", "/v1/ready", { headers: { origin: "https://evil.example" } }))
                .status,
        ).toBe(200)
    })
})
