/**
 * Images sent with a message (pilot.5, #12).
 *
 * The far-end half reads request bodies, because the field crosses four layers (`Agent.send`,
 * `TurnInput`, the input block, the wire mapper) and a spread drops a field silently: the shape that
 * has cost this repo six rounds.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { MAX_IMAGE_BYTES, readImages, sniffImage } from "../src/media/image-input.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
    try {
        await work
        return undefined
    } catch (error) {
        return (error as { code?: string }).code
    }
}

function agentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "images-"))
    mkdirSync(join(dir, "files", "c1"), { recursive: true })
    writeFileSync(join(dir, "files", "c1", "shot.png"), PNG)
    writeFileSync(join(dir, ".env"), "SECRET=1")
    return dir
}

describe("reading an image", () => {
    test("the bytes decide the type, whatever the name says", () => {
        expect(sniffImage(PNG)).toBe("image/png")
        expect(sniffImage(JPEG)).toBe("image/jpeg")
        expect(sniffImage(new TextEncoder().encode("SECRET=1"))).toBeUndefined()
    })

    test("a path inside the agent's directory is read, with its path as the reference", async () => {
        const [image] = await readImages(agentDir(), [{ path: "files/c1/shot.png" }])
        expect(image?.mediaType).toBe("image/png")
        expect(image?.ref).toBe("files/c1/shot.png")
        expect(Buffer.from(image?.data ?? "", "base64")).toEqual(Buffer.from(PNG))
    })

    test("a path that leaves the directory is refused, through a symlink too", async () => {
        const dir = agentDir()
        const outside = mkdtempSync(join(tmpdir(), "outside-"))
        writeFileSync(join(outside, "x.png"), PNG)
        symlinkSync(join(outside, "x.png"), join(dir, "files", "link.png"))
        // Outside is outside whether or not the file exists, so the answer cannot probe the host.
        expect(await codeOf(readImages(dir, [{ path: "../x.png" }]))).toBe("image_path_invalid")
        expect(await codeOf(readImages(dir, [{ path: "../no-such-file.png" }]))).toBe(
            "image_path_invalid",
        )
        expect(await codeOf(readImages(dir, [{ path: "files/link.png" }]))).toBe(
            "image_path_invalid",
        )
        expect(await codeOf(readImages(dir, [{ path: "/etc/hosts" }]))).toBe("image_path_invalid")
    })

    test("a file that is not an image is refused without its content", async () => {
        try {
            await readImages(agentDir(), [{ path: ".env" }])
            throw new Error("not refused")
        } catch (error) {
            expect((error as { code?: string }).code).toBe("image_unsupported")
            expect(String((error as Error).message)).not.toContain("SECRET")
        }
    })

    test("inline data is checked like a file, and a wrong declared type is refused", async () => {
        const data = Buffer.from(JPEG).toString("base64")
        const [image] = await readImages(agentDir(), [{ data }])
        expect(image?.mediaType).toBe("image/jpeg")
        expect(image?.ref).toBe("upload")
        expect(await codeOf(readImages(agentDir(), [{ data, mediaType: "image/png" }]))).toBe(
            "image_media_type_mismatch",
        )
        expect(await codeOf(readImages(agentDir(), [{ data: "not base64!" }]))).toBe(
            "image_data_invalid",
        )
    })

    test("the size and count caps refuse rather than truncate", async () => {
        const dir = agentDir()
        const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
        big.set(PNG)
        writeFileSync(join(dir, "big.png"), big)
        expect(await codeOf(readImages(dir, [{ path: "big.png" }]))).toBe("image_too_large")
        const six = Array.from({ length: 6 }, () => ({ path: "files/c1/shot.png" }))
        expect(await codeOf(readImages(dir, six))).toBe("image_count_exceeded")
    })
})

function manifest(model: string): string {
    const dir = agentDir()
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: ${model}
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
    )
    return join(dir, "agent.yaml")
}

function recorder() {
    const bodies: string[] = []
    const fetch: FetchLike = async (_url, init) => {
        bodies.push(String(init?.body ?? ""))
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "A dog." } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    return { bodies, fetch }
}

describe("an image inside a real turn", () => {
    test("reaches the request once, and history keeps only the reference", async () => {
        const path = manifest("gpt-4o-mini")
        const { bodies, fetch } = recorder()
        const runtime = await Runtime.create({
            agents: [path],
            env: { MODEL_API_KEY: "k" },
            fetch,
        })
        const agent = runtime.agent("test")
        const images = await readImages(agent?.dir ?? "", [{ path: "files/c1/shot.png" }])
        await agent?.send("what is this?", { sessionKey: "api:img", images })
        await agent?.send("and now?", { sessionKey: "api:img" })

        const first = JSON.parse(bodies[0] ?? "{}") as {
            messages: { role: string; content: unknown }[]
        }
        const last = first.messages.at(-1)
        expect(Array.isArray(last?.content)).toBe(true)
        expect(JSON.stringify(last?.content)).toContain(
            `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
        )
        expect(JSON.stringify(last?.content)).toContain("[image: files/c1/shot.png]")

        // The next turn pays for no image, and still knows one was sent.
        expect(bodies[1]).not.toContain("image_url")
        expect(bodies[1]).toContain("[image: files/c1/shot.png]")
        const history = await agent?.store.messages.history("test", "api:img")
        expect(JSON.stringify(history)).not.toContain(Buffer.from(PNG).toString("base64"))
        await runtime.stop()
    })

    test("a model without vision refuses before anything is recorded", async () => {
        const path = manifest("llama3.1:8b")
        const { bodies, fetch } = recorder()
        const runtime = await Runtime.create({
            agents: [path],
            env: { MODEL_API_KEY: "k" },
            fetch,
        })
        const agent = runtime.agent("test")
        const images = await readImages(agent?.dir ?? "", [{ path: "files/c1/shot.png" }])
        expect(agent?.refusesImages()?.code).toBe("model_no_vision")
        expect(
            await codeOf(
                agent?.send("what is this?", { sessionKey: "api:x", images }) ?? Promise.resolve(),
            ),
        ).toBe("model_no_vision")
        expect(bodies.length).toBe(0)
        expect((await agent?.store.messages.history("test", "api:x"))?.length ?? 0).toBe(0)
        await runtime.stop()
    })
})
