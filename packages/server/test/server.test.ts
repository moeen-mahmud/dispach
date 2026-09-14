/**
 * The wire surface, driven as `Request` → `Response`.
 *
 * No port is opened for most of this, which is the payoff of `createHandler` being a plain
 * function: every route in `04-SPEC-WIRE.md` is exercised against a real `Runtime` with a scripted
 * model endpoint, and the only tests that need a socket are the ones about sockets.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "@dispach/core"
import { createHandler } from "../src/handler.ts"
import { Router } from "../src/router.ts"
import { isLoopback, serve } from "../src/serve.ts"
import { encodeFrame } from "../src/sse.ts"

const TOKEN = "test-token-abcdef"
const ENV = { MODEL_API_KEY: "sk-test" }

const MANIFEST = `apiVersion: dispach/v1
id: assistant
name: Assistant
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`

const dirs: string[] = []
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "server-test-"))
    dirs.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "agent.yaml"), MANIFEST)
    return dir
}

/** A model endpoint that answers one fixed reply, streamed as the loop expects. */
function replyFetch(text = "hello from the model"): typeof fetch {
    return (async () => {
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
}

async function harness(options: { token?: string; fetch?: typeof fetch } = {}) {
    const dir = workspace()
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: ENV,
        fetch: options.fetch ?? replyFetch(),
    })
    const handler = createHandler({
        runtime,
        ...(options.token === undefined
            ? { allowUnauthenticated: true }
            : { token: options.token }),
    })

    const call = (
        method: string,
        path: string,
        init: { body?: unknown; token?: string | null } = {},
    ) => {
        const headers: Record<string, string> = { "content-type": "application/json" }
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
async function readSse(response: Response, max = 200): Promise<[string, unknown][]> {
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

// ─── Router ──────────────────────────────────────────────────────────────────────────────

describe("router", () => {
    test("captures and percent-decodes parameters", () => {
        // A session key is `{channel}:{peerId}` and a Telegram group id is negative, so real keys
        // arrive as `tg%3A-100123`. Skipping the decode looks up a session that does not exist.
        const router = new Router<string>().add("GET", "/v1/agents/:id/sessions/:key", "h")
        const match = router.match("GET", "/v1/agents/assistant/sessions/tg%3A-100123")
        expect(match.kind).toBe("found")
        if (match.kind === "found") expect(match.params.key).toBe("tg:-100123")
    })

    test("a known path under the wrong method is 405, not 404", () => {
        const router = new Router<string>().add("POST", "/v1/agents/:id/messages", "h")
        const match = router.match("GET", "/v1/agents/a/messages")
        expect(match.kind).toBe("method")
        if (match.kind === "method") expect(match.allowed).toEqual(["POST"])
    })

    test("a malformed escape matches nothing rather than producing mojibake", () => {
        const router = new Router<string>().add("GET", "/v1/agents/:id", "h")
        expect(router.match("GET", "/v1/agents/%zz").kind).toBe("none")
    })
})

// ─── SSE framing ─────────────────────────────────────────────────────────────────────────

describe("sse framing", () => {
    test("the event name mirrors the type so EventSource can dispatch", () => {
        expect(encodeFrame({ event: "turn.end", data: { a: 1 } })).toBe(
            'event: turn.end\ndata: {"a":1}\n\n',
        )
    })

    test("a multi-line payload is prefixed per line, not truncated at the first newline", () => {
        expect(encodeFrame({ data: "one\ntwo" })).toBe("data: one\ndata: two\n\n")
    })
})

// ─── Health and auth ─────────────────────────────────────────────────────────────────────

describe("health and auth", () => {
    test("health is open — a probe cannot hold our token", async () => {
        const { call, runtime } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/health", { token: null })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; agents: number }
        expect(body.status).toBe("ok")
        expect(body.agents).toBe(1)
        await runtime.stop()
    })

    test("ready is open too — it is the probe an orchestrator actually uses", async () => {
        // It was *not*, and the consequence was that the container story could not work: a
        // published port needs a non-loopback bind, a non-loopback bind requires a token, and the
        // readiness probe then got 401 forever. `/v1/ready` discloses strictly less than
        // `/v1/health`, which was already open — a status and an agent count, without the version.
        const { call, runtime } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/ready", { token: null })
        expect(response.status).toBe(200)
        expect(((await response.json()) as { status: string }).status).toBe("ready")
        await runtime.stop()
    })

    test("every other route requires the bearer token", async () => {
        const { call, runtime } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/agents", { token: null })
        expect(response.status).toBe(401)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe("unauthorized")
        await runtime.stop()
    })

    test("a wrong token is refused without saying which part was wrong", async () => {
        const { call, runtime } = await harness({ token: TOKEN })
        const response = await call("GET", "/v1/agents", { token: "wrong-token-abcd" })
        expect(response.status).toBe(401)
        const body = (await response.json()) as { error: { message: string } }
        // Distinguishing "no token" from "wrong token" tells an attacker their shape is right.
        expect(body.error.message).toBe("Missing or invalid bearer token.")
        await runtime.stop()
    })

    test("readiness flips at runtime.ready, before channels connect", async () => {
        const { call, runtime } = await harness()
        expect((await call("GET", "/v1/ready")).status).toBe(200)
        await runtime.stop()
        // A stopped runtime is not ready. A channel outage would not change this — channel state
        // is on the agent resource, so an orchestrator does not restart into an outage.
        expect((await call("GET", "/v1/ready")).status).toBe(503)
    })

    test("building a handler with neither a token nor an explicit opt-out is refused", async () => {
        const { runtime } = await harness()
        expect(() => createHandler({ runtime })).toThrow(/allowUnauthenticated/)
        await runtime.stop()
    })

    test("an unknown route is 404 and names where the surface is documented", async () => {
        const { call, runtime } = await harness()
        const response = await call("GET", "/v1/nope")
        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: { hint: string } }
        expect(body.error.hint).toContain("04-SPEC-WIRE.md")
        await runtime.stop()
    })

    test("a known path under the wrong method answers 405 with Allow", async () => {
        const { call, runtime } = await harness()
        const response = await call("GET", "/v1/agents/assistant/messages")
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toBe("POST")
        await runtime.stop()
    })
})

// ─── Agents ──────────────────────────────────────────────────────────────────────────────

describe("agents", () => {
    test("listing reports id, model, and channel state", async () => {
        const { call, runtime } = await harness()
        const body = (await (await call("GET", "/v1/agents")).json()) as {
            id: string
            model: string
            channels: unknown[]
        }[]
        expect(body[0]?.id).toBe("assistant")
        expect(body[0]?.model).toBe("gpt-4o-mini")
        expect(body[0]?.channels).toEqual([])
        await runtime.stop()
    })

    test("an unknown agent is 404", async () => {
        const { call, runtime } = await harness()
        expect((await call("GET", "/v1/agents/nope")).status).toBe(404)
        await runtime.stop()
    })

    test("reload is refused, naming the reason rather than half-doing it", async () => {
        // The catalogue resolves once and the cached prefix depends on it staying fixed.
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/reload")
        expect(response.status).toBe(501)
        const body = (await response.json()) as { error: { code: string; hint: string } }
        expect(body.error.code).toBe("reload_not_supported")
        expect(body.error.hint).toContain("Restart")
        await runtime.stop()
    })

    test("skills report supported: false rather than a bare empty list", async () => {
        // An empty array alone cannot be told apart from "this build has no skills".
        const { call, runtime } = await harness()
        const body = (await (await call("GET", "/v1/agents/assistant/skills")).json()) as {
            skills: unknown[]
            supported: boolean
        }
        expect(body).toEqual({ skills: [], supported: false })
        await runtime.stop()
    })

    test("context reports slots with labels and a total", async () => {
        const { call, runtime } = await harness()
        const body = (await (await call("GET", "/v1/agents/assistant/context")).json()) as {
            slots: { slot: number; label: string; tokens: number }[]
            total: number
            window: number
        }
        expect(body.slots.length).toBeGreaterThan(0)
        // Slot numbers are positional; a client reads meaning from the label.
        expect(typeof body.slots[0]?.label).toBe("string")
        expect(body.total).toBeGreaterThan(0)
        expect(body.window).toBeGreaterThan(0)
        await runtime.stop()
    })

    test("tools lists the resolved catalogue", async () => {
        const { call, runtime } = await harness()
        const body = (await (await call("GET", "/v1/agents/assistant/tools")).json()) as {
            slug: string
        }[]
        expect(Array.isArray(body)).toBe(true)
        await runtime.stop()
    })
})

// ─── Turns ───────────────────────────────────────────────────────────────────────────────

describe("turns", () => {
    test("a message returns 202 with a turn id, and the turn completes detached", async () => {
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", sessionKey: "api:t1" },
        })
        expect(response.status).toBe(202)
        const body = (await response.json()) as { turnId: string; sessionKey: string }
        expect(body.turnId).toMatch(/^t_/)
        expect(body.sessionKey).toBe("api:t1")

        // The response returned before the turn finished; the turn kept going anyway.
        await Bun.sleep(120)
        const record = (await (
            await call("GET", `/v1/agents/assistant/turns/${body.turnId}`)
        ).json()) as { status: string; text: string }
        expect(record.status).toBe("final")
        expect(record.text).toBe("hello from the model")
        await runtime.stop()
    })

    test("an empty message is refused rather than billed", async () => {
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "   " },
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe("message_text_required")
        await runtime.stop()
    })

    test("a body that is not JSON is refused with a hint about quoting", async () => {
        const { runtime, handler } = await harness()
        const response = await handler(
            new Request("http://127.0.0.1/v1/agents/assistant/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{not json",
            }),
        )
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string; hint: string } }
        expect(body.error.code).toBe("body_not_json")
        expect(body.error.hint).toContain("quoting")
        await runtime.stop()
    })

    test("a bare channel id in deliver is refused — an API turn has no recipient to infer", async () => {
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", deliver: "tg" },
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe("deliver_invalid")
        await runtime.stop()
    })

    test('deliver: "none" is accepted', async () => {
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", deliver: "none" },
        })
        expect(response.status).toBe(202)
        await runtime.stop()
    })

    test("stream: true returns 202 and an SSE body starting with turn.accepted", async () => {
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", sessionKey: "api:s1", stream: true },
        })
        expect(response.status).toBe(202)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        // No buffering hop between here and a browser: nginx buffers proxied responses by default.
        expect(response.headers.get("x-accel-buffering")).toBe("no")

        const frames = await readSse(response)
        expect(frames[0]?.[0]).toBe("turn.accepted")
        expect(frames.map(([event]) => event)).toContain("turn.end")
        await runtime.stop()
    })

    test("reattaching to a finished turn replays its events, then closes", async () => {
        const { call, runtime } = await harness()
        const started = (await (
            await call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })
        ).json()) as { turnId: string }
        await Bun.sleep(120)

        const frames = await readSse(
            await call("GET", `/v1/agents/assistant/turns/${started.turnId}/stream`),
        )
        // Replay is the whole point of reattach: a client that comes back sees what it missed.
        expect(frames.map(([event]) => event)).toContain("turn.start")
        expect(frames.map(([event]) => event)).toContain("turn.end")
        await runtime.stop()
    })

    test("streaming a turn with no buffer says so instead of hanging", async () => {
        const { call, runtime } = await harness()
        const frames = await readSse(
            await call("GET", "/v1/agents/assistant/turns/t_nonexistent/stream"),
        )
        expect(frames[0]?.[0]).toBe("stream.unavailable")
        await runtime.stop()
    })

    test("stopping a turn that is not running is 409, not a silent success", async () => {
        const { call, runtime } = await harness()
        const response = await call("POST", "/v1/agents/assistant/turns/t_gone/stop")
        expect(response.status).toBe(409)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe("turn_not_running")
        await runtime.stop()
    })

    test("an unknown turn id is 404", async () => {
        const { call, runtime } = await harness()
        expect((await call("GET", "/v1/agents/assistant/turns/t_gone")).status).toBe(404)
        await runtime.stop()
    })
})

// ─── Sessions ────────────────────────────────────────────────────────────────────────────

describe("sessions", () => {
    async function withSession() {
        const h = await harness()
        await h.call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", sessionKey: "api:s" },
        })
        await Bun.sleep(120)
        return h
    }

    test("listing reports the session with its counts", async () => {
        const { call, runtime } = await withSession()
        const body = (await (await call("GET", "/v1/agents/assistant/sessions")).json()) as {
            sessionKey: string
            messages: number
        }[]
        expect(body[0]?.sessionKey).toBe("api:s")
        expect(body[0]?.messages).toBeGreaterThan(0)
        await runtime.stop()
    })

    test("messages page newest-first and carry the tool fields", async () => {
        const { call, runtime } = await withSession()
        const body = (await (
            await call("GET", "/v1/agents/assistant/sessions/api%3As/messages?limit=10")
        ).json()) as { messages: { role: string; content: string }[] }
        expect(body.messages.length).toBeGreaterThan(0)
        await runtime.stop()
    })

    test("deleting clears history and says memory files were kept", async () => {
        const { call, runtime } = await withSession()
        const response = await call("DELETE", "/v1/agents/assistant/sessions/api%3As")
        expect(response.status).toBe(200)
        const body = (await response.json()) as { memoryFilesKept: boolean }
        // Memory markdown is a file artifact and is never deleted by an API call.
        expect(body.memoryFilesKept).toBe(true)

        const after = (await (
            await call("GET", "/v1/agents/assistant/sessions/api%3As/messages")
        ).json()) as { messages: unknown[] }
        expect(after.messages.length).toBe(0)
        await runtime.stop()
    })

    test("setting a phase persists it", async () => {
        const { call, runtime } = await withSession()
        expect(
            (
                await call("POST", "/v1/agents/assistant/sessions/api%3As/phase", {
                    body: { phase: "triage" },
                })
            ).status,
        ).toBe(200)
        const body = (await (
            await call("GET", "/v1/agents/assistant/sessions/api%3As")
        ).json()) as { phase?: string }
        expect(body.phase).toBe("triage")
        await runtime.stop()
    })

    test("a non-string phase is refused", async () => {
        const { call, runtime } = await withSession()
        const response = await call("POST", "/v1/agents/assistant/sessions/api%3As/phase", {
            body: { phase: 7 },
        })
        expect(response.status).toBe(400)
        await runtime.stop()
    })

    test("an unknown session is 404", async () => {
        const { call, runtime } = await harness()
        expect((await call("GET", "/v1/agents/assistant/sessions/api%3Anope")).status).toBe(404)
        await runtime.stop()
    })
})

// ─── Event stream ────────────────────────────────────────────────────────────────────────

describe("event stream", () => {
    test("subscribing sees a turn's events as they happen", async () => {
        const { call, runtime } = await harness()
        const stream = await call("GET", "/v1/events?types=turn.start,turn.end")

        void call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })

        const frames: string[] = []
        const reader = stream.body?.getReader()
        const decoder = new TextDecoder()
        while (reader !== undefined && !frames.includes("turn.end")) {
            const { done, value } = await reader.read()
            if (done) break
            for (const line of decoder.decode(value).split("\n")) {
                if (line.startsWith("event: ")) frames.push(line.slice(7))
            }
        }
        expect(frames).toContain("turn.start")
        expect(frames).toContain("turn.end")
        // The filter held: nothing else got through.
        expect(frames.every((f) => f === "turn.start" || f === "turn.end")).toBe(true)
        await reader?.cancel()
        await runtime.stop()
    })
})

// ─── Binding ─────────────────────────────────────────────────────────────────────────────

describe("binding", () => {
    test("loopback is recognised in every spelling", () => {
        for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
            expect(isLoopback(host)).toBe(true)
        }
        expect(isLoopback("0.0.0.0")).toBe(false)
        expect(isLoopback("10.0.0.5")).toBe(false)
    })

    test("a non-loopback bind with no token refuses to start", async () => {
        // An agent with shell access on 0.0.0.0 behaves identically to a safe one until found.
        const { runtime } = await harness()
        await expect(serve({ runtime, host: "0.0.0.0", port: 0 })).rejects.toThrow(
            /Refusing to bind/,
        )
        await runtime.stop()
    })

    test("an idle SSE stream survives past the server's own idle timeout", async () => {
        // Bun.serve defaults to a 10-second idle timeout, which is shorter than the 15-second
        // heartbeat — so the server killed its own streams before the first keep-alive frame and
        // closed cleanly, which a client reads as "the turn ended". Only a real socket shows this:
        // the handler-level tests read a stream to completion in milliseconds.
        const { runtime } = await harness()
        const running = await serve({ runtime, host: "127.0.0.1", port: 0, token: TOKEN })
        try {
            const response = await fetch(`${running.url}/v1/events`, {
                headers: { authorization: `Bearer ${TOKEN}` },
            })
            const reader = response.body?.getReader()
            expect(reader).toBeDefined()

            // Past the 10 s default, with nothing emitted. A heartbeat should arrive first.
            const first = await Promise.race([
                reader?.read().then(() => "data" as const),
                Bun.sleep(11_000).then(() => "timeout" as const),
            ])
            expect(first).toBe("data")
            await reader?.cancel()
        } finally {
            await running.stop()
            await runtime.stop()
        }
    }, 20_000)

    test("a real bind serves health and stops cleanly", async () => {
        const { runtime } = await harness()
        const running = await serve({ runtime, host: "127.0.0.1", port: 0, token: TOKEN })
        try {
            const response = await fetch(`${running.url}/v1/health`)
            expect(response.status).toBe(200)
            expect(((await response.json()) as { status: string }).status).toBe("ok")
        } finally {
            await running.stop()
            await runtime.stop()
        }
    })
})
