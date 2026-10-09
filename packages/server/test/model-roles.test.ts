/**
 * Named model roles over the wire (pilot.7, VelaCrew): a person adds one with `PATCH /config path
 * model.<name>`, and a message runs one turn on it with `POST /messages {role}`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_SETTABLE_PATHS, personSetting } from "@dispach/core"
import { cleanupWorkspaces, harness, MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

/** Records which model each request named, and answers every one the same. */
function recording() {
    const models: string[] = []
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        models.push((JSON.parse(String(init?.body ?? "{}")) as { model: string }).model)
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }) as typeof globalThis.fetch
    return { models, fetch }
}

const errorCode = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error.code

describe("a named role", () => {
    test("is added by a person over PATCH /config, and listed there as model.<role>", async () => {
        const { call, dir, runtime } = await harness({ manifest: MANIFEST })
        const listed = (await (await call("GET", "/v1/agents/assistant/config")).json()) as {
            settings: { path: string }[]
        }
        expect(listed.settings.some((setting) => setting.path === "model.<role>")).toBe(true)

        const response = await call("PATCH", "/v1/agents/assistant/config", {
            body: {
                path: "model.fast",
                value: "{id: fast-model, baseUrl: https://api.example.com/v1, apiKeyEnv: MODEL_API_KEY}",
            },
        })
        expect(response.status).toBe(200)
        expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("fast-model")
        expect(runtime.agent("assistant")?.roles.byName("fast").config.id).toBe("fast-model")
        await runtime.stop()
    })

    test("main is replaced whole by a person, in one write and one reload (pilot.16)", async () => {
        // Revises 14.78 (VelaCrew's bring-your-own key): a provider switch changes the transport,
        // endpoint and key variable together, and each step in between would not load.
        const { models, fetch } = recording()
        const { call, dir, runtime } = await harness({ manifest: MANIFEST, fetch })
        const response = await call("PATCH", "/v1/agents/assistant/config", {
            body: {
                path: "model.main",
                value: "{id: byo-model, baseUrl: https://byo.example.com/v1, apiKeyEnv: MODEL_API_KEY, maxTokens: 900}",
            },
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ changed: true, reloaded: true })
        expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("byo.example.com")
        expect(runtime.agent("assistant")?.roles.byName("main").config.id).toBe("byo-model")

        // The read reports the endpoint and the key's variable name, never its value.
        const listed = (await (await call("GET", "/v1/agents/assistant/config")).json()) as {
            settings: { path: string; value?: unknown }[]
        }
        const main = listed.settings.find((setting) => setting.path === "model.main")?.value
        expect(main).toMatchObject({
            baseUrl: "https://byo.example.com/v1",
            apiKeyEnv: "MODEL_API_KEY",
        })

        await call("POST", "/v1/agents/assistant/messages", {
            body: { sessionKey: "api:byo", text: "hello" },
        })
        await settle()
        expect(models).toEqual(["byo-model"])
        // The agent itself cannot move onto another provider.
        expect(AGENT_SETTABLE_PATHS).not.toContain("model.main")
        await runtime.stop()
    })

    test("a whole main that does not validate is refused and the file is untouched", async () => {
        const { call, dir, runtime } = await harness({ manifest: MANIFEST })
        const before = readFileSync(join(dir, "agent.yaml"), "utf8")
        const response = await call("PATCH", "/v1/agents/assistant/config", {
            body: { path: "model.main", value: "{baseUrl: https://byo.example.com/v1}" },
        })
        expect(response.status).toBe(400)
        expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before)
        await runtime.stop()
    })

    test("runs one message's turn, and only that one", async () => {
        const { models, fetch } = recording()
        const { call, runtime } = await harness({
            manifest: `${MANIFEST}  fast:
    id: fast-model
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
            fetch,
        })
        const send = (body: Record<string, unknown>) =>
            call("POST", "/v1/agents/assistant/messages", {
                body: { sessionKey: "api:r", ...body },
            })
        expect((await send({ text: "quick one", role: "fast" })).status).toBe(202)
        await settle()
        expect((await send({ text: "and a normal one" })).status).toBe(202)
        await settle()
        expect(models).toEqual(["fast-model", "gpt-4o-mini"])
        await runtime.stop()
    })

    test("an undeclared role is refused before the turn starts", async () => {
        const { models, fetch } = recording()
        const { call, runtime } = await harness({ fetch })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", role: "nope" },
        })
        expect(response.status).toBe(400)
        expect(await errorCode(response)).toBe("model_role_unknown")
        await settle()
        expect(models).toEqual([])
        await runtime.stop()
    })
})

describe("delegation over PATCH /config", () => {
    test("a person sets an offer, and the agents that may ask it are reloaded so their roster shows it", async () => {
        const { call, dir, runtime } = await harness({ manifest: MANIFEST })
        const asker = join(dir, "asker.yaml")
        writeFileSync(
            asker,
            `${MANIFEST.replace("id: assistant", "id: asker").replace("name: Assistant", "name: Asker")}delegation:\n  to: [assistant]\n`,
        )
        await runtime.adopt(asker)
        const roster = () =>
            runtime
                .agent("asker")
                ?.tools.specs()
                .some((spec) => spec.slug === "handoff")
        expect(roster()).toBe(false)

        const response = await call("PATCH", "/v1/agents/assistant/config", {
            body: {
                path: "delegation.offer",
                value: "{task: Answers questions about the roadmap., artifact: {type: object, properties: {answer: {type: string}}}}",
            },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { peers: { id: string; applied: boolean }[] }
        expect(body.peers).toEqual([{ id: "asker", applied: true }])
        expect(roster()).toBe(true)
        await runtime.stop()
    })

    test("delegation.to is a person's setting, never the agent's", () => {
        expect(personSetting("delegation.to")?.path).toBe("delegation.to")
        expect(AGENT_SETTABLE_PATHS).not.toContain("delegation.to")
        expect(AGENT_SETTABLE_PATHS).not.toContain("delegation.offer")
    })
})

describe("removing a field over PATCH /config (pilot.8)", () => {
    test("a field set once returns to its default; a required one is refused; value and remove are exclusive", async () => {
        const { call, dir, runtime } = await harness({
            manifest: MANIFEST.replace(
                "apiKeyEnv: MODEL_API_KEY",
                "apiKeyEnv: MODEL_API_KEY\n    temperature: 0.3",
            ),
        })
        const patch = (body: Record<string, unknown>) =>
            call("PATCH", "/v1/agents/assistant/config", { body })
        expect(runtime.agent("assistant")?.manifest.model.main.temperature).toBe(0.3)

        const removed = await patch({ path: "model.main.temperature", remove: true })
        expect(removed.status).toBe(200)
        expect(await removed.json()).toMatchObject({ before: 0.3, applied: true })
        expect(readFileSync(join(dir, "agent.yaml"), "utf8")).not.toContain("temperature")
        expect(runtime.agent("assistant")?.manifest.model.main.temperature).toBeUndefined()

        const required = await patch({ path: "model.main.id", remove: true })
        expect(required.status).toBe(400)
        expect(await errorCode(required)).toBe("manifest_edit_invalid")

        const both = await patch({ path: "model.main.temperature", value: "0.2", remove: true })
        expect(await errorCode(both)).toBe("config_remove_invalid")
        const neither = await patch({ path: "model.main.temperature" })
        expect(await errorCode(neither)).toBe("config_value_unreadable")
        await runtime.stop()
    })
})
