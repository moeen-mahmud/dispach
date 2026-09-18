/**
 * The shared test harness for the server package.
 *
 * Extracted when `spec.test.ts` needed the same `Runtime` + handler pair that `server.test.ts`
 * already had. Copying it would have been three lines cheaper and is the drift shape this repo
 * keeps paying for — a fixture that diverges makes two test files disagree about what the runtime
 * does, and the one you are not reading is the one that is wrong.
 *
 * `afterAll` is deliberately **not** registered here. A hook registered in an imported module
 * attaches to whichever file imported it, which is exactly the kind of implicit ordering that is
 * fine until it is not; each test file calls `cleanupWorkspaces()` in its own `afterAll` instead.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "@dispach/core"
import { createHandler } from "../src/handler.ts"
import type { ClaimTicket } from "../src/keys.ts"

export const TOKEN = "test-token-abcdef"
export const ENV = { MODEL_API_KEY: "sk-test" }

export const MANIFEST = `apiVersion: dispach/v1
id: assistant
name: Assistant
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`

/**
 * A manifest with tools pinned and two phases declared.
 *
 * The bare manifest above resolves **no tools at all** — no `tools:` block means an empty
 * catalogue — so every assertion about tags or phase visibility needs this one. `now` and
 * `memory_write` are local tools with real tags (`read`/`time` and `write`/`memory`), which is
 * what makes `tag:read` a meaningful `allow` entry rather than a string that matches by accident.
 */
export const PHASED_MANIFEST = `apiVersion: dispach/v1
id: assistant
name: Assistant
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  pinned: [now, memory_write]
phases:
  triage:
    entry: true
    allow: [tag:read]
  act:
    allow: ["*"]
`

/** The same manifest with the `phases:` block removed, for the unphased half of each pair. */
export const PINNED_MANIFEST = PHASED_MANIFEST.slice(0, PHASED_MANIFEST.indexOf("phases:"))

const dirs: string[] = []

/** Remove every temporary workspace this module created. Call from each file's `afterAll`. */
export function cleanupWorkspaces(): void {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
}

export function workspace(manifest = MANIFEST): string {
    const dir = mkdtempSync(join(tmpdir(), "server-test-"))
    dirs.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "agent.yaml"), manifest)
    return dir
}

/**
 * A model endpoint that answers one fixed reply, streamed as the loop expects.
 *
 * The reply arrives as **two** deltas rather than one, which is what makes the token-streaming test
 * below mean anything: with a single delta, "the frames concatenate to the reply" is satisfied by a
 * stream carrying one frame, and a client that ignored ordering would pass.
 */
export function replyFetch(text = "hello from the model"): typeof fetch {
    const half = Math.ceil(text.length / 2)
    return (async () => {
        const body = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, half) } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(half) } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`,
            "data: [DONE]\n\n",
        ].join("")
        return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        })
    }) as unknown as typeof fetch
}

/**
 * A model endpoint that records every request body and answers a scripted sequence of replies.
 *
 * The recording half is what makes a prompt assertion possible at all. This repo's standing rule
 * after six instances of the same bug is that a field threaded through a pipeline gets one test at
 * the **far end** that reads the value out of the request body — not one at the layer that sets it,
 * because a conditional spread is not excess-property-checked and every layer can be individually
 * right with one of them not connected.
 *
 * `replies` are consumed in order and the last one repeats, so a two-step turn is scripted by
 * handing it a tool call and then a final answer.
 */
export function recordingFetch(replies: readonly string[]): {
    fetch: typeof fetch
    bodies: Record<string, unknown>[]
    prompts: () => string[]
} {
    const bodies: Record<string, unknown>[] = []
    let call = 0
    const doFetch = (async (_url: unknown, init: { body?: string }) => {
        bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>)
        const text = replies[Math.min(call, replies.length - 1)] ?? ""
        call += 1
        const body = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`,
            "data: [DONE]\n\n",
        ].join("")
        return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        })
    }) as unknown as typeof fetch

    /** Every message of every request, flattened — what the model was actually shown. */
    const prompts = () =>
        bodies.flatMap((body) =>
            ((body.messages ?? []) as { content?: unknown }[]).map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            ),
        )

    return { fetch: doFetch, bodies, prompts }
}

export async function harness(
    options: {
        token?: string
        fetch?: typeof fetch
        /** Tune the per-turn buffer cap, so a test can reach the truncation path deliberately. */
        streams?: { maxEventsPerTurn?: number; retainEndedMs?: number }
        /** The shared cancel registry, so a test can hand the same one to the WS bridge. */
        running?: Map<string, AbortController>
        /** A different manifest — `PHASED_MANIFEST` for anything about tools or phases. */
        manifest?: string
        /** The one-time bootstrap ticket, for the claim path. */
        claim?: ClaimTicket
        /**
         * The bind, for the origin guard.
         *
         * Omitted by every other test on purpose: a handler built without it does no origin
         * checking, which is what lets a constructed `Request` with no `Host` header reach a route
         * at all. A real server always has one; `new Request(url)` does not.
         */
        origin?: {
            host: string
            allowedOrigins?: readonly string[]
            allowedHosts?: readonly string[]
        }
    } = {},
) {
    const dir = workspace(options.manifest)
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: ENV,
        fetch: options.fetch ?? replyFetch(),
        ...(options.streams === undefined ? {} : { streams: options.streams }),
    })
    const handler = createHandler({
        runtime,
        ...(options.token === undefined
            ? { allowUnauthenticated: true }
            : { token: options.token }),
        ...(options.running === undefined ? {} : { running: options.running }),
        ...(options.claim === undefined ? {} : { claim: options.claim }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
    })

    const call = (
        method: string,
        path: string,
        init: {
            body?: unknown
            token?: string | null
            /** Extra request headers. `Idempotency-Key` is the reason this exists. */
            headers?: Record<string, string>
        } = {},
    ) => {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            ...init.headers,
        }
        const auth = init.token === undefined ? options.token : (init.token ?? undefined)
        if (auth !== undefined && auth !== null) headers.authorization = `Bearer ${auth}`
        return handler(
            new Request(`http://127.0.0.1:7420${path}`, {
                method,
                headers,
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            }),
        )
    }

    return { runtime, handler, call, dir }
}

/** Read an SSE body to completion, returning the frames as `[event, data]`. */
export async function readSse(response: Response, max = 200): Promise<[string, unknown][]> {
    const reader = response.body?.getReader()
    if (reader === undefined) return []
    const decoder = new TextDecoder()
    const frames: [string, unknown][] = []
    let buffer = ""

    while (frames.length < max) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
            if (block.startsWith(":")) continue
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message"
            const data = block
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n")
            frames.push([event, data === "" ? undefined : JSON.parse(data)])
        }
    }
    return frames
}

/**
 * Read an SSE body until `done` is satisfied, then cancel.
 *
 * `readSse` reads to completion, which is right for a turn stream and wrong for the firehose: that
 * one never ends, so a frame budget either blocks forever waiting for the last frame or stops
 * early. This stops on a condition instead.
 */
export async function readUntil(
    response: Response,
    done: (frames: [string, unknown][]) => boolean,
    limit = 400,
): Promise<[string, unknown][]> {
    const reader = response.body?.getReader()
    if (reader === undefined) return []
    const decoder = new TextDecoder()
    const frames: [string, unknown][] = []
    let buffer = ""
    while (frames.length < limit && !done(frames)) {
        const read = await reader.read()
        if (read.done) break
        buffer += decoder.decode(read.value, { stream: true })
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
            if (block.startsWith(":") || block === "") continue
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message"
            const data = block
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n")
            frames.push([event, data === "" ? undefined : JSON.parse(data)])
        }
    }
    await reader.cancel()
    return frames
}

/**
 * A socket the bridge can drive without a platform WebSocket, so these run under Node too.
 *
 * Module-scoped because two describe blocks need it: the bridge's own frames, and the shared
 * cancel registry, which is about two surfaces agreeing and therefore cannot live inside either.
 */
export function fakeSocket(agentId?: string, chunks = false) {
    const sent: string[] = []
    return {
        sent,
        frames: () => sent.map((raw) => JSON.parse(raw) as { type: string; [k: string]: unknown }),
        ws: {
            data: { agentId, chunks },
            send: (message: string) => sent.push(message),
            close: () => {},
        },
    }
}
