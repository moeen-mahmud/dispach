/**
 * The generated document, and the ways it could quietly stop describing the server.
 *
 * The both-directions summary guard lives in `spec.test.ts` rather than here, because that file
 * already extracts the **real** router table from the source — the first version of it lived here
 * and read the *document* back, which is circular: a route missing a summary is absent from the
 * document, so a check driven by the document can never see it.
 *
 * `09-API-GUIDE.md` argued against a generated reference on the grounds that it would be "a third
 * description of a surface that already has two… drifting from both and looking the most
 * authoritative". This file is what makes a *derived* one safe: paths come from the router table and
 * bodies from the Zod schemas, and the only hand-written half — one summary per route — is guarded
 * in **both** directions here. A route with no summary is red; a summary for a route that does not
 * exist is red too.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { VERSION } from "@dispach/core"
import { ApprovalBody, MessageBody, parseBody } from "../src/wire-schemas.ts"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

describe("the document cannot drift from the router", () => {
    test("the served document lists the real paths, with OpenAPI's parameter spelling", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const doc = (await (await call("GET", "/v1/openapi.json")).json()) as {
            openapi: string
            info: { version: string }
            paths: Record<string, Record<string, { summary?: string }>>
        }
        expect(doc.openapi).toBe("3.1.0")
        // The version is the package's, not a literal — a document claiming a version the server
        // is not is worse than one with no version at all.
        expect(doc.info.version).toBe(VERSION)

        // `:id` → `{id}`, the one translation this generator performs.
        expect(doc.paths["/v1/agents/{id}/messages"]?.post?.summary).toContain("Start a turn")
        expect(doc.paths["/v1/agents/:id/messages"]).toBeUndefined()
        // A real route with a real summary, rather than a count nobody reads.
        expect(doc.paths["/v1/health"]?.get?.summary).toBeDefined()

        await runtime.stop()
    })

    test("the browser surface is absent, and the reference is present", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const doc = (await (await call("GET", "/v1/openapi.json")).json()) as {
            paths: Record<string, unknown>
        }
        // `/` and the two assets are a served *page*, not an API — listing them would invite a
        // client to treat the UI's asset paths as a contract.
        expect(doc.paths["/"]).toBeUndefined()
        expect(doc.paths["/assets/app.js"]).toBeUndefined()
        expect(doc.paths["/docs"]).toBeDefined()
        await runtime.stop()
    })

    test("a body's schema, its refusal code and its hint all reach the document", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const doc = (await (await call("GET", "/v1/openapi.json")).json()) as {
            paths: Record<
                string,
                Record<
                    string,
                    {
                        requestBody?: {
                            content: Record<
                                string,
                                { schema: { properties?: Record<string, Record<string, unknown>> } }
                            >
                        }
                    }
                >
            >
        }
        const schema =
            doc.paths["/v1/agents/{id}/messages"]?.post?.requestBody?.content["application/json"]
                ?.schema
        expect(schema?.properties?.text?.type).toBe("string")
        // The part a hand-written document would not have: the reference names the error code a
        // bad value produces, and the sentence that says what to do about it.
        expect(schema?.properties?.text?.code).toBe("message_text_required")
        expect(String(schema?.properties?.text?.hint)).toContain("billed for a full prompt")
        await runtime.stop()
    })
})

describe("one validator, and it keeps every message", () => {
    test("a missing field reports the field's own code and hint", () => {
        const result = parseBody(MessageBody, {})
        expect(result.ok).toBe(false)
        if (!result.ok) {
            // Exactly what the route used to build by hand. The code moved into the schema; the
            // sentence did not change, which is the whole claim of the refactor.
            expect(result.error.code).toBe("message_text_required")
            expect(result.error.field).toBe("text")
            expect(result.error.hint).toContain("billed for a full prompt")
        }
    })

    test("an empty string is a missing answer, not a present one", () => {
        // `.trim().min(1)` rather than a presence check: `{"text":"   "}` would otherwise start a
        // turn that is billed for a full prompt and produces nothing.
        expect(parseBody(MessageBody, { text: "   " }).ok).toBe(false)
        expect(parseBody(MessageBody, { text: "hello" }).ok).toBe(true)
    })

    test("the sender's kind keeps its nearest-match suggestion", () => {
        const result = parseBody(MessageBody, {
            text: "hi",
            from: { id: "agent:ops", kind: "agnet" },
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            // The one thing a default Zod message would have lost. `from.kind` decides the trust
            // boundary, so the refusal names the options *and* guesses at the typo.
            expect(result.error.message).toContain('Did you mean "agent"?')
            expect(result.error.hint).toContain("trust boundary")
        }
    })

    test("a nested field is reported by its path", () => {
        const result = parseBody(MessageBody, { text: "hi", from: { kind: "user" } })
        expect(result.ok).toBe(false)
        // `from.id`, not `from` — a caller fixing this needs to know which half.
        if (!result.ok) expect(result.error.field).toBe("from.id")
    })

    test("a boolean with no default is refused rather than guessed", () => {
        const result = parseBody(ApprovalBody, {})
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error.code).toBe("approval_decision_required")
            // One direction would deny a call over a typo and the other would grant one.
            expect(result.error.hint).toContain("neither is a decision anybody made")
        }
    })

    test("a valid body comes back parsed, not merely approved", () => {
        const result = parseBody(MessageBody, {
            text: "  hello  ",
            deliver: { channel: "tg", to: "42" },
        })
        expect(result.ok).toBe(true)
        // Trimmed on the way through, so the route works with the value the schema promises rather
        // than re-deriving it.
        if (result.ok) expect(result.value.text).toBe("hello")
    })
})

describe("the reference page", () => {
    test("it needs no credential, and says what to do without a network", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const response = await call("GET", "/docs", { token: null })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        const html = await response.text()
        // A blank page with no explanation is indistinguishable from a broken server, and offline
        // this page *is* blank — so the `noscript` names the document that still works.
        expect(html).toContain("<noscript")
        expect(html).toContain("/v1/openapi.json")
        // The document it renders is served locally; only the viewer is remote.
        expect(html).toContain("cdn.jsdelivr.net")
        await runtime.stop()
    })

    test("the document needs no credential either", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        // A description of which routes exist is not a secret, and gating it means a developer
        // cannot read the API of a server they have no key for yet — the moment it is most useful.
        expect((await call("GET", "/v1/openapi.json", { token: null })).status).toBe(200)
        await runtime.stop()
    })

    test("it discloses nothing about what this process is hosting", async () => {
        const { runtime, call } = await harness({ token: TOKEN })
        const text = await (await call("GET", "/v1/openapi.json")).text()
        // Generated from the route *table*, so no agent id, no session key, no configuration. The
        // harness hosts an agent called `assistant`; the document must not know that.
        expect(text).not.toContain("assistant")
        await runtime.stop()
    })
})
