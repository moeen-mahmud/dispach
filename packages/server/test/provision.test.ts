/**
 * `POST /v1/agents` — creating an agent over the wire, and the three things that must not happen.
 *
 * The route is a thin shell on purpose: the server owns the wire shape and the gate, and the CLI
 * injects the implementation, because the wizard's questions and templates live in `packages/cli`
 * and `packages/server` may not import it. So what is testable here is exactly the shell — the
 * gate, the coercion, the adopt, and what each failure says.
 *
 * The provisioner is a fake throughout. `packages/cli`'s own tests cover the real one end to end;
 * duplicating that here would test the CLI through an HTTP handler, which is two things at once and
 * neither well.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { HarnessError } from "@dispach/core"
import type { Provisioner } from "../src/handler.ts"
import { cleanupWorkspaces, harness, TOKEN, workspace } from "./harness.ts"

afterAll(cleanupWorkspaces)

/**
 * Every call here carries a `Host`, because every one of these tests supplies an `origin` policy.
 *
 * A handler told what it bound checks `Host` first and refuses when it is absent — deliberately,
 * since a rebinding request has both headers agreeing on the attacker's name. A constructed
 * `Request` has no `Host` at all, which is why the rest of this suite omits `origin` entirely; the
 * provisioning gate reads the bind, so these cannot.
 */
function local(
    call: Awaited<ReturnType<typeof harness>>["call"],
): (
    method: string,
    path: string,
    init?: { body?: unknown; token?: string | null },
) => Promise<Response> {
    return (method, path, init = {}) =>
        call(method, path, { ...init, headers: { host: "127.0.0.1:7420" } })
}

/** Records what it was asked for, and creates an agent from a manifest already on disk. */
function fakeProvisioner(manifestPath: string): Provisioner & { seen: Record<string, string>[] } {
    const seen: Record<string, string>[] = []
    return {
        seen,
        steps: () => [
            {
                step: "name",
                prompt: "what is it called?",
                fallback: "",
                optional: false,
                secret: false,
            },
            {
                step: "apiKey",
                prompt: "paste the key",
                fallback: "",
                optional: true,
                secret: true,
            },
            {
                step: "preset",
                prompt: "which endpoint?",
                fallback: "openai",
                optional: false,
                secret: false,
                choices: [{ value: "openai", label: "OpenAI", hint: "needs a key" }],
            },
        ],
        create: (answers) => {
            seen.push({ ...answers })
            if (answers.name === "boom") {
                throw new HarnessError({
                    code: "provision_answer_invalid",
                    message: "name is boom, which is not a name",
                    hint: "pick another",
                    field: "name",
                })
            }
            return {
                agentId: "assistant",
                manifestPath,
                dir: manifestPath.replace("/agent.yaml", ""),
                files: ["agent.yaml", ".env"],
            }
        },
    }
}

/** A second manifest with a different id, so an adopt actually adds an agent. */
const OTHER = `apiVersion: dispach/v1
id: provisioned
name: Provisioned
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`

describe("the step list", () => {
    test("is served from the callback, secrets flagged", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "127.0.0.1" },
        })

        const body = (await (await local(call)("GET", "/v1/provision")).json()) as {
            available: boolean
            local: boolean
            steps: { step: string; secret: boolean; choices?: unknown[] }[]
        }
        expect(body.available).toBe(true)
        expect(body.local).toBe(true)
        // The whole reason this is served rather than hard-coded in the page: a browser renders the
        // walk the terminal performs, so the two cannot drift.
        expect(body.steps.map((entry) => entry.step)).toEqual(["name", "apiKey", "preset"])
        // What a client masks. Derived from `SECRET_STEPS` in the real implementation, never
        // restated — a second list of which answers are secrets is the one worth getting wrong.
        expect(body.steps.find((entry) => entry.step === "apiKey")?.secret).toBe(true)
        expect(body.steps.find((entry) => entry.step === "preset")?.choices).toHaveLength(1)

        await runtime.stop()
    })

    test("a server with no provisioner says so rather than 501-ing the listing", async () => {
        const { runtime, call } = await harness({ token: TOKEN, origin: { host: "127.0.0.1" } })
        // Annotated with every field asserted below, not just the two being read: `toEqual` checks
        // the literal against this type, so a narrower annotation makes the assertion itself a type
        // error — which passes `bun test` and fails `tsc`, since the runner does not typecheck.
        const body = (await (await local(call)("GET", "/v1/provision")).json()) as {
            available: boolean
            local: boolean
            steps: unknown[]
        }
        // More useful than a status code a client has to interpret. An embedder over its own
        // agent store is what lands here; the container has a provisioner and is refused by the
        // bind instead.
        expect(body).toEqual({ available: false, local: true, steps: [] })
        await runtime.stop()
    })
})

describe("creating an agent", () => {
    test("the agent is written and adopted before the response returns", async () => {
        const dir = workspace(OTHER)
        const provisioner = fakeProvisioner(`${dir}/agent.yaml`)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: provisioner,
            origin: { host: "127.0.0.1" },
        })
        expect(runtime.list().map((agent) => agent.id)).toEqual(["assistant"])

        const response = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "provisioned", preset: "openai" } },
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { id: string; adopted: string[]; files: string[] }

        // Adopted, not queued for a restart. That is the whole point: the agent is live before the
        // response returns, and nothing else the process hosts was disturbed.
        expect(body.adopted).toEqual(["provisioned"])
        expect(body.files).toContain(".env")
        expect(
            runtime
                .list()
                .map((agent) => agent.id)
                .sort(),
        ).toEqual(["assistant", "provisioned"])
        // The answers reached the implementation unchanged.
        expect(provisioner.seen[0]).toEqual({ name: "provisioned", preset: "openai" })

        await runtime.stop()
    })

    test("a manifest that cannot be adopted is still a 201, with the reason", async () => {
        const dir = workspace()
        // The same id this harness already hosts, so `adopt` refuses with `agent_already_hosted`.
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "127.0.0.1" },
        })

        const response = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "dup" } },
        })
        // The agent is on disk either way, so a failed adoption is not a failed creation —
        // reporting this as a failure would send somebody to create a second copy of an agent that
        // already exists.
        expect(response.status).toBe(201)
        const body = (await response.json()) as { adopted: string[]; error?: { code: string } }
        expect(body.adopted).toEqual([])
        expect(body.error?.code).toBe("agent_already_hosted")

        await runtime.stop()
    })

    test("the implementation's refusal passes through with its own hint", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "127.0.0.1" },
        })
        const response = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "boom" } },
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string; hint: string } }
        // Paraphrasing it here would lose the field and the fix. The implementation knows why.
        expect(body.error.code).toBe("provision_answer_invalid")
        expect(body.error.hint).toBe("pick another")
        await runtime.stop()
    })
})

describe("what the route refuses", () => {
    test("no provisioner is 501, not a silent success", async () => {
        const { runtime, call } = await harness({ token: TOKEN, origin: { host: "127.0.0.1" } })
        const response = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "x" } },
        })
        expect(response.status).toBe(501)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
            "provisioning_not_supported",
        )
        await runtime.stop()
    })

    test("a public bind is 403, whatever credential is presented", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            // A real public bind. The route writes files and starts an agent, so it is gated on the
            // *bind* rather than on a credential — a token-less loopback server is supported, and
            // the origin guard protects a browser caller rather than a curl.
            origin: { host: "0.0.0.0" },
        })
        const response = await call("POST", "/v1/agents", {
            body: { answers: { name: "x" } },
            headers: { host: "example.com:7420" },
        })
        expect(response.status).toBe(403)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
            "provisioning_not_local",
        )
        await runtime.stop()
    })

    test("a handler that was never told what it bound is not local", async () => {
        const dir = workspace(OTHER)
        // `origin` omitted. A handler mounted inside somebody else's router is the case that must
        // not get a filesystem write for free, so the absent case reads as *not* loopback.
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
        })
        expect(
            (await call("POST", "/v1/agents", { body: { answers: { name: "x" } } })).status,
        ).toBe(403)
        await runtime.stop()
    })

    test("a body with no answers, and an answer that is not text", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "127.0.0.1" },
        })
        expect((await local(call)("POST", "/v1/agents", { body: {} })).status).toBe(400)
        expect((await local(call)("POST", "/v1/agents", { body: { answers: [] } })).status).toBe(
            400,
        )

        // Coerced per key rather than trusted: a number would reach `validateAnswer` as something
        // it has no case for, and answers arrive as text from both front doors anyway.
        const response = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "x", server: true } },
        })
        expect(response.status).toBe(400)
        const detail = ((await response.json()) as { error: { field: string; code: string } }).error
        expect(detail.field).toBe("answers.server")
        // `invalid`, not `required`: the answer was present and the wrong type, and a code saying
        // "required" would send somebody looking for a field they already sent.
        expect(detail.code).toBe("provision_answer_invalid")
        await runtime.stop()
    })

    test("an unauthenticated caller is refused before any of this", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "127.0.0.1" },
        })
        // The loopback gate is not a substitute for the token when there is one: a server with a
        // credential configured demands it everywhere.
        const response = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "x" } },
            token: null,
        })
        expect(response.status).toBe(401)
        await runtime.stop()
    })
})
