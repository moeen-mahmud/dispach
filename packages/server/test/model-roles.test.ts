/**
 * Named model roles over the wire (pilot.7, VelaCrew): a person adds one with `PATCH /config path
 * model.<name>`, and a message runs one turn on it with `POST /messages {role}`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

    test("main is not replaced whole; its fields keep their own rows", async () => {
        const { call, runtime } = await harness({ manifest: MANIFEST })
        const response = await call("PATCH", "/v1/agents/assistant/config", {
            body: { path: "model.main", value: "{id: other}" },
        })
        expect(response.status).toBe(400)
        expect(await errorCode(response)).toBe("config_path_unknown")
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
