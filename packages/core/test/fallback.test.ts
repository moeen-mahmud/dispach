/**
 * `model.<role>.fallbacks`: when the chain moves on, when it must not, and that the model which
 * answered is the one billed — read off the usage table, the far end, rather than off the wrapper.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { HarnessError, ModelError } from "../src/errors.ts"
import { type FallbackInfo, fallbackReason, withFallbacks } from "../src/model/fallback.ts"
import type { ChatChunk, FetchLike, ModelProvider } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const failing = (error: unknown, afterChunk = false): ModelProvider => ({
    id: "failing",
    async *chat(): AsyncIterable<ChatChunk> {
        if (afterChunk) yield { type: "text", delta: "half" }
        throw error
    },
})
const answering = (text: string): ModelProvider => ({
    id: "answering",
    async *chat(request): AsyncIterable<ChatChunk> {
        yield { type: "text", delta: `${text} as ${request.model}` }
        yield { type: "finish", reason: "stop" }
    },
})
const http = (status: number) =>
    new ModelError({ code: "model_http_error", message: `HTTP ${status}`, hint: "h", status })

async function drain(provider: ModelProvider): Promise<ChatChunk[]> {
    const out: ChatChunk[] = []
    for await (const chunk of provider.chat(
        { model: "primary", messages: [] },
        new AbortController().signal,
    ))
        out.push(chunk)
    return out
}

describe("the fallback chain", () => {
    test("an endpoint failure moves to the next model, which is named before its output", async () => {
        const moved: FallbackInfo[] = []
        const chunks = await drain(
            withFallbacks(
                "p",
                [
                    { model: "primary", provider: failing(http(503)) },
                    { model: "backup", provider: answering("ok") },
                ],
                (info) => moved.push(info),
            ),
        )
        expect(chunks[0]).toEqual({ type: "model", id: "backup" })
        expect(chunks[1]).toEqual({ type: "text", delta: "ok as backup" })
        expect(moved).toEqual([{ from: "primary", to: "backup", reason: "HTTP 503" }])
    })

    test("a 400, a 403 and an error after output never fall back", async () => {
        for (const provider of [failing(http(400)), failing(http(403)), failing(http(503), true)]) {
            const chain = withFallbacks("p", [
                { model: "primary", provider },
                { model: "backup", provider: answering("wrong") },
            ])
            let threw = false
            try {
                await drain(chain)
            } catch {
                threw = true
            }
            expect(threw).toBe(true)
        }
    })

    test("which failures count is decided structurally, so a foreign copy of the error class works", () => {
        expect(fallbackReason(http(429))).toBe("HTTP 429")
        expect(fallbackReason(http(403))).toBeUndefined()
        expect(
            fallbackReason(
                new HarnessError({ code: "model_unreachable", message: "m", hint: "h" }),
            ),
        ).toBe("model_unreachable")
        expect(fallbackReason(new Error("plain"))).toBeUndefined()
    })
})

describe("through a real turn", () => {
    test("a primary failing past its retries hands the turn to the fallback, which is billed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fallback-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: resilient
model:
  main:
    id: primary-model
    baseUrl: https://primary.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    fallbacks:
      - id: backup-model
        baseUrl: https://backup.example.com/v1
        apiKeyEnv: MODEL_API_KEY
limits:
  maxSteps: 2
  turnTimeoutMs: 20000
`,
        )
        const hits: string[] = []
        const fetch: FetchLike = async (url) => {
            const host = new URL(String(url)).host
            hits.push(host)
            if (host === "primary.example.com") return new Response("down", { status: 503 })
            const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "from the backup" } }] })}\n\n`
            return new Response(`${frame}data: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            })
        }
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_API_KEY: "k" },
            fetch,
        })
        const moved: unknown[] = []
        runtime.bus.on("model.fallback", (event) => moved.push(event.data))
        const reply = await runtime.agent("resilient").send("hi")
        await new Promise((resolve) => setTimeout(resolve, 20))
        const buckets = (await runtime.store.usage.report({ by: ["model"] })).buckets
        await runtime.stop()

        expect(reply.text).toBe("from the backup")
        // Every retry first, then the fallback — never the fallback in place of the retries.
        expect(hits.filter((h) => h === "primary.example.com").length).toBe(3)
        expect(hits.at(-1)).toBe("backup.example.com")
        expect(moved).toEqual([{ from: "primary-model", to: "backup-model", reason: "HTTP 503" }])
        expect(buckets.map((b) => [b.model, b.calls])).toEqual([["backup-model", 1]])
    })
})

describe("a fallback smaller than its primary", () => {
    test("is a warning on the agent, and validate reads the same function", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fallback-warn-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: warned
model:
  main:
    id: gpt-4o
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    fallbacks:
      - id: tiny-local
        baseUrl: http://localhost:11434/v1
        capabilities:
          contextWindow: 4096
`,
        )
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_API_KEY: "k" },
            store: ":memory:",
        })
        const codes = runtime.agent("warned").warnings.map((w) => w.code)
        await runtime.stop()
        expect(codes).toContain("model_fallback_smaller")
    })
})
