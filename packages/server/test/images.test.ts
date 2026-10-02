/**
 * `POST /messages {images}` (pilot.5, #12): read and checked before the turn detaches, because a
 * refusal after that reaches nobody.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { cleanupWorkspaces, harness, MANIFEST, replyFetch } from "./harness.ts"

afterAll(cleanupWorkspaces)

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

function recording() {
    const bodies: string[] = []
    const inner = replyFetch("A cat.")
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""))
        return inner(url, init)
    }) as typeof globalThis.fetch
    return { bodies, fetch }
}

async function errorOf(response: Response) {
    return ((await response.json()) as { error: { code: string; hint: string } }).error
}

describe("images on POST /messages", () => {
    test("a path in the agent's directory reaches the model as an image", async () => {
        const { bodies, fetch } = recording()
        const { runtime, call } = await harness({ fetch, files: { "shot.png": PNG } })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "what is this?", sessionKey: "api:img", images: [{ path: "shot.png" }] },
        })
        expect(response.status).toBe(202)
        await settle()
        expect(bodies[0]).toContain(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`)
        await runtime.stop()
    })

    test("a missing file is a 400 with its code, and no turn starts", async () => {
        const { bodies, fetch } = recording()
        const { runtime, call } = await harness({ fetch })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "what is this?", images: [{ path: "nope.png" }] },
        })
        expect(response.status).toBe(400)
        expect((await errorOf(response)).code).toBe("image_not_found")
        await settle()
        expect(bodies.length).toBe(0)
        expect((await runtime.store.turns.listForAgent("assistant", {})).turns.length).toBe(0)
        await runtime.stop()
    })

    test("a model without vision is a 400 model_no_vision, not a silently dropped image", async () => {
        const { runtime, call } = await harness({
            manifest: MANIFEST.replace("gpt-4o-mini", "llama3.1:8b"),
            files: { "shot.png": PNG },
        })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "what is this?", images: [{ path: "shot.png" }] },
        })
        expect(response.status).toBe(400)
        const error = await errorOf(response)
        expect(error.code).toBe("model_no_vision")
        expect(error.hint).toContain("capabilities.vision")
        await runtime.stop()
    })
})
