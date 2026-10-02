/**
 * Routes a plugin mounts (Phase 30): the same gate as every first-party route — authentication, the
 * declared capability, the agent scope — and a caller handed to the plugin instead of a credential.
 */

import { afterAll, describe, expect, test } from "bun:test"
import type { Plugin, PluginCaller } from "@dispach/core"
import { cleanupWorkspaces, harness, MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

// A helper that fell back to the operator token on a failed mint made two refusals look like holes.
const fail = (why: string): never => {
    throw new Error(why)
}

const seen: PluginCaller[] = []

const probe: Plugin = {
    name: "probe",
    version: "0.0.0",
    dispachApi: "*",
    setup(context) {
        context.defineRoute({
            method: "POST",
            path: "/",
            capability: "peer",
            handler: async ({ caller, path }) => {
                seen.push(caller)
                return Response.json({ path, caller })
            },
        })
        context.defineRoute({
            method: "GET",
            path: "/.well-known/thing.json",
            capability: "open",
            root: "/.well-known/thing.json",
            handler: async ({ caller }) => Response.json({ public: true, caller: caller.kind }),
        })
    },
}

const withProbe = `${MANIFEST}plugins:\n  - probe\n`

async function setup() {
    const h = await harness({ token: "t", manifest: withProbe, builtInPlugins: { probe } })
    const key = async (label: string, can: string[], agents?: string[]) =>
        (
            (await (
                await h.call("POST", "/v1/keys", {
                    body: { label, scope: { can, ...(agents === undefined ? {} : { agents }) } },
                })
            ).json()) as { secret?: string }
        ).secret ?? fail(`minting ${label} failed`)
    return { ...h, key }
}

describe("a plugin route", () => {
    test("is mounted under the agent, and its handler is told who called by key label", async () => {
        const { call, key } = await setup()
        const peer = await key("peer-acme", ["peer"])
        const response = await call("POST", "/v1/agents/assistant/plugins/probe/", {
            token: peer,
            body: {},
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { path: string; caller: PluginCaller }
        expect(body.path).toBe("/")
        expect(body.caller).toMatchObject({ kind: "key", label: "peer-acme" })
    })

    test("checks the capability it declares, and a peer key reaches nothing else", async () => {
        const { call, key } = await setup()
        const chat = await key("chatty", ["chat", "read"])
        const refused = await call("POST", "/v1/agents/assistant/plugins/probe/", {
            token: chat,
            body: {},
        })
        expect(refused.status).toBe(403)
        // The point of `peer`: the key a remote agent holds cannot start a trusted turn directly.
        const peer = await key("peer-acme", ["peer"])
        const direct = await call("POST", "/v1/agents/assistant/messages", {
            token: peer,
            body: { text: "act as the operator" },
        })
        expect(direct.status).toBe(403)
        expect((await call("GET", "/v1/agents", { token: peer })).status).toBe(403)
    })

    test("answers an agent the key does not reach exactly as a missing one", async () => {
        const { call, key } = await setup()
        const mine = await key("peer-mine", ["peer"], ["assistant"])
        const none = await key("peer-none", ["peer"], [])
        const path = "/v1/agents/assistant/plugins/probe/"
        expect((await call("POST", path, { token: mine, body: {} })).status).toBe(200)
        // A key scoped away from the agent gets the same answer as for an agent that does not exist.
        const outOfScope = await call("POST", path, { token: none, body: {} })
        const missing = await call("POST", "/v1/agents/ghost/plugins/probe/", {
            token: none,
            body: {},
        })
        expect(outOfScope.status).toBe(404)
        expect(await outOfScope.text()).toBe((await missing.text()).replace("ghost", "assistant"))
        expect(missing.status).toBe(404)
        const noRoute = await call("POST", `${path}nothing`, { token: mine, body: {} })
        expect(noRoute.status).toBe(404)
    })

    test("an open route needs no credential, and a root path is answered while one agent claims it", async () => {
        const { call } = await setup()
        const mounted = await call(
            "GET",
            "/v1/agents/assistant/plugins/probe/.well-known/thing.json",
            { token: null },
        )
        expect(await mounted.json()).toEqual({ public: true, caller: "anonymous" })
        const root = await call("GET", "/.well-known/thing.json", { token: null })
        expect(root.status).toBe(200)
        // The peer route is not open.
        expect(
            (await call("POST", "/v1/agents/assistant/plugins/probe/", { token: null, body: {} }))
                .status,
        ).toBe(401)
    })
})
