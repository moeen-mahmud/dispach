/**
 * The wire surface, driven as `Request` → `Response`.
 *
 * No port is opened for most of this, which is the payoff of `createHandler` being a plain
 * function: every route in `04-SPEC-WIRE.md` is exercised against a real `Runtime` with a scripted
 * model endpoint, and the only tests that need a socket are the ones about sockets.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Runtime } from "@dispach/core"
import { createHandler } from "../src/handler.ts"
import { Router } from "../src/router.ts"
import { isLoopback, serve } from "../src/serve.ts"
import { encodeFrame } from "../src/sse.ts"
import { attachWebSocket } from "../src/ws.ts"

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

/**
 * A model endpoint that answers one fixed reply, streamed as the loop expects.
 *
 * The reply arrives as **two** deltas rather than one, which is what makes the token-streaming test
 * below mean anything: with a single delta, "the frames concatenate to the reply" is satisfied by a
 * stream carrying one frame, and a client that ignored ordering would pass.
 */
function replyFetch(text = "hello from the model"): typeof fetch {
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

async function harness(
    options: {
        token?: string
        fetch?: typeof fetch
        /** Tune the per-turn buffer cap, so a test can reach the truncation path deliberately. */
        streams?: { maxEventsPerTurn?: number; retainEndedMs?: number }
        /** The shared cancel registry, so a test can hand the same one to the WS bridge. */
        running?: Map<string, AbortController>
    } = {},
) {
    const dir = workspace()
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

/**
 * Read an SSE body until `done` is satisfied, then cancel.
 *
 * `readSse` reads to completion, which is right for a turn stream and wrong for the firehose: that
 * one never ends, so a frame budget either blocks forever waiting for the last frame or stops
 * early. This stops on a condition instead.
 */
async function readUntil(
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
function fakeSocket(agentId?: string, chunks = false) {
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

    test("chunks: true streams the reply token by token", async () => {
        /**
         * The regression test for the defect this whole phase exists for.
         *
         * `model.chunk` was gated by a process-wide `emitChunks` that defaulted false and whose
         * setter had no caller, and `serve` built its bus without it — so in a served process the
         * per-token stream was dark. **Nothing could have caught it**: the harness below built its
         * runtime without chunks too, so every streaming test passed against a chunk-less stream
         * and asserted only what is true of one.
         *
         * Asserted by reconstruction rather than by counting frames: the deltas must concatenate
         * to exactly the reply, which is the property a client actually depends on.
         */
        const { call, runtime } = await harness({ fetch: replyFetch("hello from the model") })
        const response = await call("POST", "/v1/agents/assistant/messages", {
            body: { text: "hi", stream: true, chunks: true },
        })
        const frames = await readSse(response)

        const names = frames.map(([event]) => event)
        expect(names).toContain("model.chunk")
        expect(names).toContain("turn.end")

        const streamed = frames
            .filter(([event]) => event === "model.chunk")
            .map(([, frame]) => (frame as { data: { delta: string; kind?: string } }).data)
            .filter((chunk) => chunk.kind !== "reasoning")
            .map((chunk) => chunk.delta)
            .join("")
        expect(streamed).toBe("hello from the model")
        await runtime.stop()
    })

    test("without chunks, the same turn streams lifecycle and no tokens", async () => {
        // The other half of an opt-in: a reader who did not ask must not be put on the per-token
        // path. `/v1/events` subscribers and plugin watchers are all wildcard, and this is the
        // property that keeps them off it.
        const { call, runtime } = await harness({ fetch: replyFetch("hello from the model") })
        const frames = await readSse(
            await call("POST", "/v1/agents/assistant/messages", {
                body: { text: "hi", stream: true },
            }),
        )
        const names = frames.map(([event]) => event)
        expect(names).not.toContain("model.chunk")
        // Still a usable stream: the lifecycle is what a client watching progress needs.
        expect(names).toContain("turn.end")
        await runtime.stop()
    })

    test("a non-streaming POST is attachable by the id it returned", async () => {
        // The race. `open()` used to be called only on the `stream: true` path, and `Agent.send`
        // awaits the session write before emitting anything — so a caller who POSTed without
        // `stream` and then immediately attached with the id it had just been handed was told
        // there was no buffer, for a turn that was about to run.
        //
        // **This one is green either way on a fast machine**, and is kept for what it does prove:
        // that the end-to-end path works. `TurnStreams.record` creates a buffer for any event
        // carrying a turn id (`buffer.ts:142-152`), so once `turn.start` fires the buffer exists
        // regardless — and on an unloaded machine that happens before a second HTTP request can be
        // issued. The window is real on a loaded one, which is where CI lives.
        //
        // The guard that actually fails when the fix is reverted is the structural one below.
        const { call, runtime } = await harness()
        const accepted = (await (
            await call("POST", "/v1/agents/assistant/messages", { body: { text: "hello" } })
        ).json()) as { turnId: string }

        const frames = await readSse(
            await call("GET", `/v1/agents/assistant/turns/${accepted.turnId}/stream`),
        )
        expect(frames.map(([event]) => event)).not.toContain("stream.unavailable")
        expect(frames.map(([event]) => event)).toContain("turn.end")
        await runtime.stop()
    })

    test("a manually fired schedule's turn is attachable by the id it returned", async () => {
        // The same invariant on the third route that mints an id and hands it out. This one never
        // opened a buffer at all, so every manual schedule run was unstreamable.
        const { call, runtime } = await harness()
        await call("POST", "/v1/agents/assistant/schedules", {
            body: {
                id: "brief",
                kind: "every",
                expr: "15m",
                task: "say hello",
                deliver: "none",
            },
        })
        const fired = (await (
            await call("POST", "/v1/agents/assistant/schedules/brief/run")
        ).json()) as { turnId: string }

        const frames = await readSse(
            await call("GET", `/v1/agents/assistant/turns/${fired.turnId}/stream`),
        )
        expect(frames.map(([event]) => event)).not.toContain("stream.unavailable")
        await runtime.stop()
    })

    test("a truncated replay announces the hole before the replay frames", async () => {
        /**
         * Hard rule 8, on the one path where the runtime was silently lying.
         *
         * The buffer caps at 10,000 events and discards the **oldest** to stay under it, setting a
         * `truncated` flag that `TurnAttachment` had no field for and that nothing ever read. So a
         * client got a replay missing its front, concatenated what arrived, and believed it. With
         * tokens streaming that stops being theoretical — each token is one buffered event.
         *
         * Order is the assertion, not merely presence: a warning after the frames it warns about
         * is a warning that arrives too late to act on.
         */
        const { call, runtime } = await harness({
            fetch: replyFetch("hello from the model"),
            streams: { maxEventsPerTurn: 3 },
        })
        // A **reattaching** client, which is the only one for which this can be true: the preamble
        // reports what is true of the replay it precedes, and on the inline path nothing has been
        // dropped yet because the turn has barely started. Truncation is a property a late arrival
        // discovers, which is exactly why it has to be told rather than left to infer.
        const accepted = (await (
            await call("POST", "/v1/agents/assistant/messages", {
                body: { text: "hi", chunks: true },
            })
        ).json()) as { turnId: string }
        await new Promise((resolve) => setTimeout(resolve, 150))

        const frames = await readSse(
            await call("GET", `/v1/agents/assistant/turns/${accepted.turnId}/stream?chunks=true`),
        )

        const names = frames.map(([event]) => event)
        const replayAt = names.indexOf("stream.replay")
        expect(replayAt).toBeGreaterThanOrEqual(0)
        const preamble = frames[replayAt]?.[1] as { truncated: boolean; dropped: number }
        expect({ truncated: preamble.truncated, dropped: preamble.dropped > 0 }).toEqual({
            truncated: true,
            dropped: true,
        })
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
        // The filter held: nothing else got through. `stream.subscribed` is exempt and has to be —
        // it is a frame about the subscription rather than a runtime event, so filtering it by
        // `types` would hide the report of the filter from every client that set one.
        expect(frames.filter((f) => f !== "stream.subscribed")).toEqual(
            frames.filter((f) => f === "turn.start" || f === "turn.end"),
        )
        expect(frames[0]).toBe("stream.subscribed")
        await reader?.cancel()
        await runtime.stop()
    })

    /**
     * The firehose is a **wildcard** subscriber, so after the per-subscriber opt-in it gets no
     * tokens unless it asks — which turned `?types=model.chunk` into a request that streamed
     * nothing, forever, with nothing reporting why. These two are the whole of that fix.
     */
    test("types naming model.chunk is itself the opt-in, and the preamble says so", async () => {
        const { call, runtime } = await harness()
        const stream = await call("GET", "/v1/events?types=model.chunk")

        void call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })
        const frames = await readUntil(
            stream,
            (seen) => seen.filter(([event]) => event === "model.chunk").length >= 2,
        )

        expect(frames[0]?.[0]).toBe("stream.subscribed")
        expect(frames[0]?.[1]).toEqual({
            agentId: null,
            types: ["model.chunk"],
            chunks: true,
            // Reported rather than assumed. An implication a reader cannot see is a surprise.
            implied: "types names model.chunk",
        })
        const text = frames
            .filter(([event]) => event === "model.chunk")
            .map(([, data]) => (data as { data: { delta: string } }).data.delta)
            .join("")
        expect(text).toBe("hello from the model")
        await runtime.stop()
    })

    test("a firehose that asked for nothing reports chunks: false and receives none", async () => {
        const { call, runtime } = await harness()
        const stream = await call("GET", "/v1/events")

        void call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })
        const frames = await readUntil(stream, (seen) =>
            seen.some(([event]) => event === "turn.end"),
        )

        expect(frames[0]?.[1]).toEqual({ agentId: null, types: null, chunks: false })
        expect(frames.filter(([event]) => event === "model.chunk")).toEqual([])
        // And it saw the turn, so this is a filtered stream rather than a broken one.
        expect(frames.map(([event]) => event)).toContain("turn.end")
        await runtime.stop()
    })
})

// ─── The stream route's four states ──────────────────────────────────────────────────────

/**
 * One answer per state, and the point of each test is the state it *excludes*.
 *
 * Before this, every unattachable turn got `200` with a `stream.unavailable` frame — so "you typed
 * the id wrong", "it finished an hour ago" and "it is running in another process" were one
 * response, and telling them apart took a second request.
 */
describe("attaching to a turn answers what is true of it", () => {
    test("an unknown turn id is 404, not a 200 carrying a frame", async () => {
        const { call, runtime } = await harness()

        const response = await call("GET", "/v1/agents/assistant/turns/t_nonexistent/stream")

        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: { code: string; hint?: string } }
        expect(body.error.code).toBe("turn_not_found")
        expect(body.error.hint ?? "").not.toBe("")
        await runtime.stop()
    })

    test("a finished, evicted turn is 200 + stream.ended carrying its stored status", async () => {
        // Retention is what makes this state reachable at all: the buffer is dropped a while after
        // `turn.end`, and the turn row outlives it by design — the store is the audit trail.
        const { call, runtime } = await harness()
        const accepted = (await (
            await call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })
        ).json()) as { turnId: string }
        // Wait on the *row*, not on `turn.end`. The event fires before `turns.finish` has
        // resolved, so attaching right after it read a row still marked `running` and this test
        // asserted `stream.ended` against `stream.unavailable` — the four states catching a race
        // in the test written to check them.
        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("no agent")
        for (let i = 0; i < 200; i += 1) {
            const row = await agent.store.turns.get(accepted.turnId)
            if (row !== undefined && row.status !== "running") break
            await new Promise((resolve) => setTimeout(resolve, 5))
        }
        // Drop the buffer the way the retention timer eventually does, without waiting 60 seconds.
        runtime.streams.close()

        const response = await call("GET", `/v1/agents/assistant/turns/${accepted.turnId}/stream`)
        expect(response.status).toBe(200)
        const frames = await readSse(response)

        expect(frames.map(([event]) => event)).toEqual(["stream.ended"])
        const data = frames[0]?.[1] as { turnId: string; status: string; hint: string }
        expect(data.turnId).toBe(accepted.turnId)
        expect(data.status).toBe("final")
        expect(data.hint).toContain("/v1/agents/:id/turns/:turnId")
        await runtime.stop()
    })

    test("a turn still recorded as running is stream.unavailable, never stream.ended", async () => {
        // The state the plan's trichotomy did not have a row for, and the one that would have been
        // a lie: the row is written at turn *start* and one store is shared by every process under
        // a sandbox root, so a served process can hold a `running` row for a turn it is not
        // executing. Saying "ended" would send a client to read a final text that does not exist.
        const { call, runtime } = await harness()
        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("no agent")

        // A row with no buffer and no process behind it — exactly what a turn running elsewhere
        // looks like from here.
        await agent.store.turns.start({
            turnId: "t_elsewhere",
            agentId: agent.id,
            sessionKey: "api:default",
            source: "api",
            input: "hi",
        })

        const response = await call("GET", "/v1/agents/assistant/turns/t_elsewhere/stream")
        expect(response.status).toBe(200)
        const frames = await readSse(response)

        expect(frames.map(([event]) => event)).toEqual(["stream.unavailable"])
        const data = frames[0]?.[1] as { status: string; hint: string }
        expect(data.status).toBe("running")
        expect(data.hint).toContain("running")
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

describe("whoever hands out a turn id opens its buffer first", () => {
    /**
     * The invariant behind the two attach-race tests above, asserted where it is decided.
     *
     * A behavioural version of this cannot fail reliably: `TurnStreams.record` creates a buffer for
     * any event carrying a turn id, so once `turn.start` fires the buffer exists whether or not
     * `open()` was called — and on an unloaded machine that beats a second HTTP request every time.
     * The window is real on a loaded machine, which is exactly where CI runs and exactly where this
     * class of bug has bitten this repo before (the `serve` signal race, red on CI for twelve days
     * while passing locally six runs in a row).
     *
     * So the ordering is asserted in the source. There are exactly three routes that mint a turn id
     * and hand it to a caller; each must open the buffer before starting the turn.
     */
    const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "handler.ts"), "utf8")

    test("every newTurnId() in a route is followed by streams.open before agent.send", () => {
        const offenders: string[] = []
        for (const match of SOURCE.matchAll(/newTurnId\(\)/g)) {
            // The window from the mint to the first `send` in the same route body. Generous on
            // purpose — the assertion is about *order*, not proximity — and it has to be, because
            // the comments explaining these two fixes are themselves ~1,400 characters. At 1,200
            // this guard went red for code that was correct, which is its own kind of useless.
            const after = SOURCE.slice(match.index ?? 0, (match.index ?? 0) + 3000)
            // Matches the call, not its arity — the signature grew a `{ chunks }` argument and an
            // exact-string match would have gone red for a fix that was still in place.
            const opened = after.indexOf("streams.open(turnId")
            const sent = after.indexOf(".send(")
            if (opened === -1 || (sent !== -1 && opened > sent)) {
                offenders.push(
                    SOURCE.slice(0, match.index ?? 0)
                        .split("\n")
                        .length.toString(),
                )
            }
        }
        expect({ routesMintingATurnIdWithoutOpening: offenders }).toEqual({
            routesMintingATurnIdWithoutOpening: [],
        })
    })

    test("and there really are mint sites, or the test above proves nothing", () => {
        // The count is the guard on the guard: a refactor that renames `newTurnId` would otherwise
        // leave the assertion above passing over an empty set.
        expect([...SOURCE.matchAll(/newTurnId\(\)/g)].length).toBeGreaterThanOrEqual(2)
    })
})

describe("the websocket subscribe frame", () => {
    /**
     * A socket that reported success and then received nothing, forever.
     *
     * `subscribe` set the agent filter from `frame.sessionKey` — and the frame type had no
     * `agentId` field at all, so that was the only way to reach it. A session key can never equal
     * an `event.agentId`, so the filter in `broadcast` matched nothing: the socket went silent and
     * answered `ws.subscribed` to say the change had worked. Rule 8, over a socket.
     *
     * Driven through `bridge.handlers.message` with a fake socket rather than a real connection —
     * `Socket` is a three-method interface, and `/v1/ws` is Bun-only, so a portless test is the one
     * that runs everywhere.
     */

    test("sets the filter from agentId", async () => {
        const { runtime } = await harness()
        const bridge = attachWebSocket(runtime, undefined)
        const socket = fakeSocket(undefined)

        bridge.handlers.message(
            socket.ws,
            JSON.stringify({ type: "subscribe", agentId: "assistant" }),
        )

        expect(socket.ws.data.agentId).toBe("assistant")
        expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
            type: "ws.subscribed",
            agentId: "assistant",
            // Omitting `chunks` leaves it as it was, so re-pointing the agent cannot silently
            // switch streaming off on a socket that had asked for tokens.
            chunks: false,
        })
        await runtime.stop()
    })

    test("refuses a frame naming only sessionKey rather than silently muting the socket", async () => {
        // The shape a client written against the old behaviour sends. Accepting it would leave the
        // same dead socket with a different cause, so it is an error with a hint.
        const { runtime } = await harness()
        const bridge = attachWebSocket(runtime, undefined)
        const socket = fakeSocket("assistant")

        bridge.handlers.message(
            socket.ws,
            JSON.stringify({ type: "subscribe", sessionKey: "api:default" }),
        )

        const reply = JSON.parse(socket.sent[0] ?? "{}") as { type: string; code?: string }
        expect({ type: reply.type, code: reply.code }).toEqual({
            type: "ws.error",
            code: "subscribe_needs_agent_id",
        })
        // And the filter is untouched, so the socket keeps working rather than going dark.
        expect(socket.ws.data.agentId).toBe("assistant")
        await runtime.stop()
    })

    test("tokens reach the socket that asked and not the one beside it", async () => {
        // Per socket, not per bridge. One client asking for tokens is what puts them on the bus;
        // it must not also put them on every other connected client's wire.
        const { runtime } = await harness()
        const bridge = attachWebSocket(runtime, undefined)
        const reader = fakeSocket("assistant", true)
        const watcher = fakeSocket("assistant", false)
        bridge.handlers.open(reader.ws)
        bridge.handlers.open(watcher.ws)

        runtime.bus.emit("model.chunk", { delta: "tok", kind: "text" }, { agentId: "assistant" })
        runtime.bus.emit(
            "turn.end",
            {
                reason: "final",
                steps: 1,
                tokens: { prompt: 10, output: 4 },
                durationMs: 1,
            },
            { agentId: "assistant" },
        )

        const kinds = (socket: typeof reader) =>
            socket.frames().map((frame) => frame.type ?? (frame as { type?: string }).type)
        // `ws.open` first for both, then what each subscribed to.
        expect(kinds(reader)).toEqual(["ws.open", "model.chunk", "turn.end"])
        expect(kinds(watcher)).toEqual(["ws.open", "turn.end"])
        bridge.closeAll()
        await runtime.stop()
    })

    test("chunk interest is refcounted, so the last reader leaving turns them off", async () => {
        // The wildcard stays chunk-free and an exact `model.chunk` subscription is added only
        // while somebody wants tokens — so the bus builds no per-token envelope for a bridge full
        // of progress watchers. Asserted against the bus's own counter rather than a symptom.
        const { runtime } = await harness()
        const bridge = attachWebSocket(runtime, undefined)
        const before = runtime.bus.chunkSubscribers

        // First, the assertion the counter alone cannot make. `chunkSubscribers` is incremented by
        // a wildcard that passed `{ chunks: true }` just as much as by an exact subscription, so
        // watching it go up and down is satisfied by the design this one rejects — subscribe the
        // wildcard for tokens always, filter per socket. That variant is only distinguishable
        // *here*: a bridge holding nothing but progress watchers must cost the bus nothing, and
        // under the folded design this line reads `before + 1`. Found by reverting to it.
        const watcher = fakeSocket("assistant", false)
        bridge.handlers.open(watcher.ws)
        expect(runtime.bus.chunkSubscribers).toBe(before)
        bridge.handlers.close(watcher.ws)

        const a = fakeSocket("assistant", true)
        const b = fakeSocket("assistant", true)
        bridge.handlers.open(a.ws)
        bridge.handlers.open(b.ws)
        expect(runtime.bus.chunkSubscribers).toBe(before + 1)

        bridge.handlers.close(a.ws)
        // Still one reader left, so the subscription stays.
        expect(runtime.bus.chunkSubscribers).toBe(before + 1)
        bridge.handlers.close(b.ws)
        expect(runtime.bus.chunkSubscribers).toBe(before)

        // A duplicate close must not decrement for a socket already gone, or it would drop the
        // subscription out from under a client that is still reading.
        bridge.handlers.close(b.ws)
        expect(runtime.bus.chunkSubscribers).toBe(before)
        bridge.closeAll()
        await runtime.stop()
    })

    test("a subscribe frame can turn tokens on without reconnecting", async () => {
        const { runtime } = await harness()
        const bridge = attachWebSocket(runtime, undefined)
        const socket = fakeSocket("assistant", false)
        bridge.handlers.open(socket.ws)
        const before = runtime.bus.chunkSubscribers

        bridge.handlers.message(
            socket.ws,
            JSON.stringify({ type: "subscribe", agentId: "assistant", chunks: true }),
        )
        expect(runtime.bus.chunkSubscribers).toBe(before + 1)
        expect(socket.frames().at(-1)).toEqual({
            type: "ws.subscribed",
            agentId: "assistant",
            chunks: true,
        })

        bridge.handlers.message(
            socket.ws,
            JSON.stringify({ type: "subscribe", agentId: "assistant", chunks: false }),
        )
        expect(runtime.bus.chunkSubscribers).toBe(before)
        bridge.closeAll()
        await runtime.stop()
    })
})

// ─── A stream that closes inside start ───────────────────────────────────────────────────

describe("a synchronously-closing stream still runs its teardown", () => {
    test("attaching to an ended turn leaves no listener pinning the buffer", async () => {
        // The far end, not the assignment. `sse.ts` set `teardown` *after* calling `start`, and
        // `streamTurn` closes inside `start` when the turn has already ended — so the real
        // teardown landed in a variable only `cancel()` reads, and `cancel()` bails on `closed`.
        //
        // The assertion is the consequence rather than the mechanism: a leaked buffer listener
        // pins the buffer against eviction, and `#evict` skips anything with listeners *before*
        // the count cap can consider it, so the buffer escaped both bounds. Asserted through the
        // one surface that reports it — a buffer with a listener is never dropped by age, so if
        // the listener leaked, `state()` still answers after the window has passed.
        const { call, runtime } = await harness({ streams: { retainEndedMs: 50 } })

        const accepted = (await (
            await call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })
        ).json()) as { turnId: string }
        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("no agent")
        for (let i = 0; i < 200; i += 1) {
            const row = await agent.store.turns.get(accepted.turnId)
            if (row !== undefined && row.status !== "running") break
            await new Promise((resolve) => setTimeout(resolve, 5))
        }

        // Attach to the finished turn. This is the stream that closes inside `start`.
        const response = await call("GET", `/v1/agents/assistant/turns/${accepted.turnId}/stream`)
        await readSse(response)
        expect(runtime.streams.state(accepted.turnId)).toBe("ended")

        // Past the retention window, and then any recorded event runs the sweep — retention is
        // enforced lazily on `record`, never on a timer, so an idle process holds an ended buffer
        // indefinitely. That is why this drives a second turn rather than waiting.
        await new Promise((resolve) => setTimeout(resolve, 80))
        await call("POST", "/v1/agents/assistant/messages", { body: { text: "again" } })
        await runtime.bus.next("turn.end")

        // With the leak, the listener is still attached and the buffer survives both bounds.
        expect(runtime.streams.state(accepted.turnId)).toBeUndefined()
        await runtime.stop()
    })
})

// ─── One cancel registry ─────────────────────────────────────────────────────────────────

/**
 * Whether a turn can be stopped is a fact about the turn, not about which door the question
 * arrived through. Each surface used to own a private map, so both answered honestly about the
 * wrong registry — the least debuggable shape a wrong answer has.
 */
describe("a turn is stoppable from either surface", () => {
    test("a turn started over HTTP is found by a WebSocket stop frame", async () => {
        const running = new Map<string, AbortController>()
        const { call, runtime } = await harness({ running })
        const bridge = attachWebSocket(runtime, undefined, running)
        const socket = fakeSocket("assistant")
        bridge.handlers.open(socket.ws)

        const accepted = (await (
            await call("POST", "/v1/agents/assistant/messages", { body: { text: "hi" } })
        ).json()) as { turnId: string }

        bridge.handlers.message(
            socket.ws,
            JSON.stringify({ type: "stop", turnId: accepted.turnId }),
        )

        expect(socket.frames().at(-1)).toEqual({
            type: "ws.stopping",
            turnId: accepted.turnId,
            found: true,
        })
        bridge.closeAll()
        await runtime.stop()
    })

    test("a turn started over a WebSocket is stoppable with POST /stop", async () => {
        const running = new Map<string, AbortController>()
        const { call, runtime } = await harness({ running })
        const bridge = attachWebSocket(runtime, undefined, running)
        const socket = fakeSocket("assistant")
        bridge.handlers.open(socket.ws)

        bridge.handlers.message(socket.ws, JSON.stringify({ type: "message", text: "hi" }))
        const accepted = socket.frames().find((frame) => frame.type === "ws.accepted") as
            | { turnId: string }
            | undefined
        expect(accepted?.turnId).toBeDefined()

        const response = await call("POST", `/v1/agents/assistant/turns/${accepted?.turnId}/stop`)
        expect(response.status).toBe(202)
        bridge.closeAll()
        await runtime.stop()
    })
})
