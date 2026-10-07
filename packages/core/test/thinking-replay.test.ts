/**
 * Signed thinking is replayed with the tool call that followed it, and the cache breakpoints reach
 * the transport. Both read at the far end — the request the transport received on the *second* step —
 * because each layer can be right on its own and the value still dropped between them: the shape
 * that cost `TurnInput.skills`, `ChatMessage.toolCalls` and five others a round each.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { createChatCompletionsProvider } from "../src/model/chat-completions.ts"
import type { ChatChunk, ChatMessage, ChatRequest, FetchLike } from "../src/model/provider.ts"
import type { ModelTransport } from "../src/model/transport.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const SIGNED = { text: "The user wants the time; call now.", signature: "sig-abc123" }

function manifest(thinking: "anthropic" | "none", promptCache?: "bedrock"): string {
    const dir = mkdtempSync(join(tmpdir(), "thinking-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: thinker
model:
  main:
    id: some.claude-model
    api: scripted
    capabilities:
      thinking: ${thinking}${promptCache === undefined ? "" : `\n      promptCache: ${promptCache}`}
tools:
  local:
    - now
limits:
  maxSteps: 4
  turnTimeoutMs: 5000
`,
    )
    return join(dir, "agent.yaml")
}

/** Step one thinks and calls `now`; step two answers. Every request is kept. */
function scripted() {
    const requests: ChatRequest[] = []
    const transport: ModelTransport = {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                requests.push(request)
                if (requests.length === 1) {
                    yield { type: "reasoning", delta: SIGNED.text }
                    yield { type: "thinking_block", block: SIGNED }
                    yield { type: "text", delta: "ACTION: now\n" }
                } else {
                    yield { type: "text", delta: "It is now." }
                }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
    return { transport, requests }
}

async function turn(thinking: "anthropic" | "none", promptCache?: "bedrock") {
    const model = scripted()
    const runtime = await Runtime.create({
        agents: [manifest(thinking, promptCache)],
        store: ":memory:",
        env: {},
        modelTransports: { scripted: model.transport },
    })
    const reply = await runtime.agent("thinker").send("what time is it?")
    await runtime.stop()
    return { reply, requests: model.requests }
}

const callOf = (messages: readonly ChatMessage[]) =>
    messages.find((m) => m.role === "assistant" && m.origin === "call")

describe("thinking replay", () => {
    test("the signed block rides on the tool call into the next step", async () => {
        const { reply, requests } = await turn("anthropic")
        expect(reply.text).toBe("It is now.")
        expect(requests.length).toBe(2)
        expect(callOf(requests[1]?.messages ?? [])?.thinking).toEqual([SIGNED])
    })

    test("each step only appends: step two opens with step one's request, byte for byte (pilot.13)", async () => {
        // Claude 5.x binds a signed block to everything before it. With the input after the trace,
        // step two moved the question behind the step-one call and Bedrock refused the replay as
        // "bound to a different conversation" (VelaCrew).
        const { requests } = await turn("anthropic")
        const first = requests[0]?.messages ?? []
        const second = requests[1]?.messages ?? []
        expect(second.slice(0, first.length)).toEqual([...first])
        expect(second[first.length]?.origin).toBe("call")
    })

    test("a model whose transport caches the prompt gets append-only steps too (pilot.13)", async () => {
        // The rolling cache point at the end of each Bedrock request is only read back if the next
        // step starts with the same bytes.
        const { requests } = await turn("none", "bedrock")
        const first = requests[0]?.messages ?? []
        const second = requests[1]?.messages ?? []
        expect(second.slice(0, first.length)).toEqual([...first])
    })

    test("a model without replayed thinking keeps the question last, as before", async () => {
        const { requests } = await turn("none")
        const second = requests[1]?.messages ?? []
        expect(second.at(-1)?.turnInput).toBe(true)
    })

    test("a model whose family does not take it back gets none", async () => {
        const { requests } = await turn("none")
        const call = callOf(requests[1]?.messages ?? [])
        expect(call).toBeDefined()
        expect(call?.thinking).toBeUndefined()
    })
})

describe("cache breakpoints", () => {
    test("breakpoint A marks the last static message, and only it", async () => {
        const { requests } = await turn("none")
        const messages = requests[0]?.messages ?? []
        const marked = messages.flatMap((m, i) => (m.cacheBreakpoint === true ? [i] : []))
        expect(marked.length).toBe(1)
        const at = marked[0] ?? -1
        expect(messages[at]?.role).toBe("system")
        // Everything after it is the uncached region: the history and the input.
        expect(messages.slice(at + 1).some((m) => m.role === "user")).toBe(true)
    })

    test("chat-completions sends neither marker nor thinking on the wire", async () => {
        const bodies: string[] = []
        const fetch: FetchLike = async (_url, init) => {
            bodies.push(String(init?.body))
            return new Response("data: [DONE]\n\n", {
                headers: { "content-type": "text/event-stream" },
            })
        }
        const provider = createChatCompletionsProvider({
            id: "chat-completions:main",
            baseUrl: "https://api.example.com/v1",
            field: "model.main",
            fetch,
            env: {},
        })
        const messages: ChatMessage[] = [
            { role: "system", content: "identity", cacheBreakpoint: true },
            { role: "assistant", content: "ACTION: now", thinking: [SIGNED] },
            { role: "user", content: "hi" },
        ]
        for await (const _ of provider.chat(
            { model: "m", messages },
            new AbortController().signal,
        )) {
            // drain
        }
        expect(bodies.length).toBe(1)
        expect(bodies[0]).not.toContain("cacheBreakpoint")
        expect(bodies[0]).not.toContain("sig-abc123")
        expect(JSON.parse(bodies[0] ?? "{}").messages).toEqual([
            { role: "system", content: "identity" },
            { role: "assistant", content: "ACTION: now" },
            { role: "user", content: "hi" },
        ])
    })
})
