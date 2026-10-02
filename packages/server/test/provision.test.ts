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
import type { Provisioner, SecretAdmin } from "../src/handler.ts"
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
        templates: () => [
            {
                name: "support",
                description: "One store's support agent",
                vars: [
                    { name: "store", required: true, secret: false },
                    { name: "apiKey", required: false, secret: true },
                ],
            },
        ],
        createFromTemplate: (input) => {
            seen.push({ template: input.template, name: input.name, ...input.vars })
            if (input.template !== "support") {
                throw new HarnessError({
                    code: "template_not_found",
                    message: `No template called "${input.template}".`,
                    hint: "Templates here: support.",
                    field: "template",
                })
            }
            return {
                agentId: "provisioned",
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
            allowed: boolean
            steps: unknown[]
        }
        // More useful than a status code a client has to interpret. An embedder over its own agent
        // store is what lands here — `allowed` is still true, because nothing about *this caller*
        // is the problem: a loopback admin may provision, there is simply no provisioner to do it.
        // The two fields answer different questions and a page needs both to say which.
        expect(body).toEqual({ available: false, local: true, allowed: true, steps: [] })
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

    /**
     * **The gate is the credential, not only the bind — and the bind-only version refused the
     * safer case.**
     *
     * A token-less loopback server was allowed to provision while a token-authenticated `0.0.0.0`
     * one was refused, so the rule was strictest exactly where a credential had been presented.
     * The container is the second case, which made the browser onboarding panel the one panel
     * structurally impossible in the only deployment that ships it: claim exchanged, first screen a
     * refusal. This test asserted that as correct behaviour, `whatever credential is presented`.
     */
    test("a public bind with an authenticated admin provisions", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "0.0.0.0" },
        })
        const response = await call("POST", "/v1/agents", {
            body: { answers: { name: "x" } },
            headers: { host: "example.com:7420" },
        })
        expect(response.status).toBe(201)
        await runtime.stop()
    })

    test("**a public bind that required no credential is still refused**", async () => {
        const dir = workspace(OTHER)
        // `token` omitted, so the handler is `allowUnauthenticated` and every principal is `open`.
        // This is the case the gate exists for and the only one it should ever have been about: a
        // filesystem write reachable from the network by anybody at all. `can(open, "admin")` is
        // true by definition, which is why the route's declared capability cannot catch this and
        // `mayProvision` tests the principal's *kind*.
        const { runtime, call } = await harness({
            provision: fakeProvisioner(`${dir}/agent.yaml`),
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

    test("GET /v1/provision reports `allowed` about the caller, not the bind", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "0.0.0.0" },
        })
        const offer = (await (
            await call("GET", "/v1/provision", { headers: { host: "example.com:7420" } })
        ).json()) as { local: boolean; allowed: boolean }
        // The page branched on `local` and therefore told an authenticated admin they could not do
        // what they could. Both fields are reported; they disagree here, which is the whole point.
        expect({ local: offer.local, allowed: offer.allowed }).toEqual({
            local: false,
            allowed: true,
        })
        await runtime.stop()
    })

    test("a handler that was never told what it bound still needs a credential", async () => {
        const dir = workspace(OTHER)
        // `origin` omitted — a handler mounted inside somebody else's router, which must not get a
        // filesystem write for free. Unauthenticated, that is still a refusal.
        const { runtime, call } = await harness({
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

describe("creating an agent from a template", () => {
    test("GET /v1/templates lists them, and a template body creates and adopts", async () => {
        const dir = workspace(OTHER)
        const provisioner = fakeProvisioner(`${dir}/agent.yaml`)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: provisioner,
            origin: { host: "127.0.0.1" },
        })
        const listed = (await (await local(call)("GET", "/v1/templates")).json()) as {
            templates: { name: string; vars: { name: string; secret: boolean }[] }[]
        }
        expect(listed.templates.map((entry) => entry.name)).toEqual(["support"])
        expect(listed.templates[0]?.vars.find((entry) => entry.name === "apiKey")?.secret).toBe(
            true,
        )

        const response = await local(call)("POST", "/v1/agents", {
            body: { template: "support", name: "Acme Store", vars: { store: "Acme" } },
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { id: string; adopted: string[] }
        expect(body.adopted).toEqual(["provisioned"])
        // The template path reached the implementation, not the answers path.
        expect(provisioner.seen[0]).toEqual({
            template: "support",
            name: "Acme Store",
            store: "Acme",
        })
        await runtime.stop()
    })

    test("both bodies at once is refused, and so is neither", async () => {
        const dir = workspace(OTHER)
        const provisioner = fakeProvisioner(`${dir}/agent.yaml`)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: provisioner,
            origin: { host: "127.0.0.1" },
        })
        const both = await local(call)("POST", "/v1/agents", {
            body: { answers: { name: "x" }, template: "support", name: "x" },
        })
        expect(both.status).toBe(400)
        expect(((await both.json()) as { error: { code: string } }).error.code).toBe(
            "provision_body_ambiguous",
        )
        const neither = await local(call)("POST", "/v1/agents", { body: { name: "x" } })
        expect(((await neither.json()) as { error: { code: string } }).error.code).toBe(
            "provision_answers_required",
        )
        // Nothing reached the implementation for either.
        expect(provisioner.seen).toEqual([])
        await runtime.stop()
    })

    test("an unknown template passes the implementation's refusal through", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            provision: fakeProvisioner(`${dir}/agent.yaml`),
            origin: { host: "127.0.0.1" },
        })
        const response = await local(call)("POST", "/v1/agents", {
            body: { template: "nope", name: "x" },
        })
        expect(response.status).toBe(400)
        const detail = ((await response.json()) as { error: { code: string; hint: string } }).error
        expect(detail.code).toBe("template_not_found")
        expect(detail.hint).toContain("support")
        await runtime.stop()
    })
})

/** Writes into a map, and allows exactly the one variable these manifests read. */
function fakeSecrets(): SecretAdmin & { store: Map<string, Record<string, string>> } {
    const store = new Map<string, Record<string, string>>()
    return {
        store,
        status: (manifestPath) => [
            {
                name: "MODEL_API_KEY",
                set: store.get(manifestPath)?.MODEL_API_KEY !== undefined,
                usedBy: ["model.main.apiKeyEnv"],
            },
        ],
        write: (manifestPath, values) => {
            for (const name of Object.keys(values)) {
                if (name !== "MODEL_API_KEY") {
                    throw new HarnessError({
                        code: "secret_not_referenced",
                        message: `"${name}" is not a variable this agent's manifest reads.`,
                        hint: "It reads MODEL_API_KEY.",
                        field: `values.${name}`,
                    })
                }
            }
            store.set(manifestPath, { ...store.get(manifestPath), ...values })
            return { written: Object.keys(values), shadowed: [] }
        },
    }
}

describe("an agent's secrets", () => {
    test("a hosted agent is reloaded, and no value is ever returned", async () => {
        const secrets = fakeSecrets()
        const { runtime, call } = await harness({ token: TOKEN, secrets })
        const put = await call("PUT", "/v1/agents/assistant/secrets", {
            body: { values: { MODEL_API_KEY: "sk-new" } },
        })
        expect(put.status).toBe(200)
        const body = (await put.json()) as { applied: string; written: string[] }
        expect(body).toMatchObject({ applied: "reloaded", written: ["MODEL_API_KEY"] })

        const read = await call("GET", "/v1/agents/assistant/secrets")
        const text = await read.text()
        expect(JSON.parse(text)).toMatchObject({ secrets: [{ name: "MODEL_API_KEY", set: true }] })
        expect(text).not.toContain("sk-new")
        await runtime.stop()
    })

    test("an agent that was not running is adopted once its key arrives", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            secrets: fakeSecrets(),
            resolveAgent: (id) => (id === "provisioned" ? `${dir}/agent.yaml` : undefined),
        })
        const put = await call("PUT", "/v1/agents/provisioned/secrets", {
            body: { values: { MODEL_API_KEY: "sk-new" } },
        })
        expect(((await put.json()) as { applied: string }).applied).toBe("adopted")
        expect(runtime.list().some((agent) => agent.id === "provisioned")).toBe(true)
        await runtime.stop()
    })

    test("a stopped agent is written and left stopped", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            secrets: fakeSecrets(),
            resolveAgent: (id) => (id === "provisioned" ? `${dir}/agent.yaml` : undefined),
        })
        await runtime.store.agentState.disable("provisioned", new Date().toISOString(), "weekend")
        const put = await call("PUT", "/v1/agents/provisioned/secrets", {
            body: { values: { MODEL_API_KEY: "sk-new" } },
        })
        expect(await put.json()).toMatchObject({ applied: "none", stopped: true })
        expect(runtime.list().some((agent) => agent.id === "provisioned")).toBe(false)
        await runtime.stop()
    })

    test("a variable the manifest does not read is refused, and nothing is applied", async () => {
        const { runtime, call } = await harness({ token: TOKEN, secrets: fakeSecrets() })
        const put = await call("PUT", "/v1/agents/assistant/secrets", {
            body: { values: { SOMETHING_ELSE: "x" } },
        })
        expect(put.status).toBe(400)
        expect(((await put.json()) as { error: { code: string } }).error.code).toBe(
            "secret_not_referenced",
        )
        await runtime.stop()
    })

    test("out of scope answers the same 404 an imaginary agent does, on both verbs", async () => {
        const dir = workspace(OTHER)
        const { runtime, call } = await harness({
            token: TOKEN,
            secrets: fakeSecrets(),
            resolveAgent: (id) => (id === "provisioned" ? `${dir}/agent.yaml` : undefined),
        })
        const minted = (await (
            await call("POST", "/v1/keys", {
                body: { label: "narrow", scope: { agents: ["assistant"], can: ["admin"] } },
            })
        ).json()) as { secret: string }
        for (const method of ["GET", "PUT"]) {
            const response = await call(method, "/v1/agents/provisioned/secrets", {
                token: minted.secret,
                ...(method === "PUT" ? { body: { values: { MODEL_API_KEY: "x" } } } : {}),
            })
            expect(response.status).toBe(404)
            expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
                "agent_not_found",
            )
        }
        await runtime.stop()
    })

    test("no writer is a 501 that names the alternative", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/agents/assistant/secrets")
        expect(response.status).toBe(501)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
            "secrets_not_supported",
        )
        await runtime.stop()
    })
})
