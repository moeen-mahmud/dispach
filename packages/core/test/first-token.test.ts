/**
 * `model.result.firstTokenMs`: the latency a person feels, read at the far end off the bus.
 *
 * The endpoint delays its first chunk, so the figure has a floor it must clear, and a ceiling (the
 * whole call) it must not pass. An endpoint that streams nothing leaves the field absent rather
 * than reporting a number nothing measured.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "first-token-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: timed
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    return join(dir, "agent.yaml")
}

/** Streams `frames`, waiting `delayMs` before the first one. */
function delayed(frames: string[], delayMs: number): FetchLike {
    return async () =>
        new Response(
            new ReadableStream<Uint8Array>({
                async start(controller) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs))
                    const encoder = new TextEncoder()
                    for (const frame of frames) controller.enqueue(encoder.encode(frame))
                    controller.close()
                },
            }),
            { headers: { "content-type": "text/event-stream" } },
        )
}

const delta = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

async function results(fetch: FetchLike) {
    const runtime = await Runtime.create({
        agents: [manifest()],
        env: { MODEL_API_KEY: "k" },
        fetch,
        store: ":memory:",
    })
    const seen: { latencyMs: number; firstTokenMs?: number }[] = []
    runtime.bus.on("*", (event) => {
        if (event.type === "model.result") seen.push(event.data)
    })
    await runtime.agent("timed").send("hi")
    await runtime.stop()
    return seen
}

describe("model.result.firstTokenMs", () => {
    test("measures the wait for the first streamed output, within the whole call", async () => {
        const [result] = await results(
            delayed([delta("hello"), delta(" there"), "data: [DONE]\n\n"], 60),
        )
        expect(result?.firstTokenMs).toBeDefined()
        expect(result?.firstTokenMs ?? 0).toBeGreaterThanOrEqual(55)
        expect(result?.firstTokenMs ?? 0).toBeLessThanOrEqual(result?.latencyMs ?? 0)
    })

    test("is absent when nothing streamed", async () => {
        const [result] = await results(delayed(["data: [DONE]\n\n"], 5))
        expect(result).toBeDefined()
        expect(result?.firstTokenMs).toBeUndefined()
    })
})
