import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { HarnessError } from "../src/errors.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { ToolProviderFactory } from "../src/tools/types.ts"
import { describe, expect, sleep, test } from "./_harness.ts"

/**
 * Boot and turn behaviour end to end, with `fetch` injected.
 *
 * The two properties worth guarding here are the ones with no visible symptom when they break:
 * that booting touches no network at all, and that a cancelled turn resolves rather than
 * rejects.
 */

const ENV = { MODEL_API_KEY: "test-key" }

function workspace(extra: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "runtime-test-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
name: Test Agent
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
  files:
    - IDENTITY.md
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
    for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content)
    return dir
}

function sse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
        },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function delta(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

const replyFetch: FetchLike = async () => sse([delta("Hello"), delta(" there"), "data: [DONE]\n\n"])

describe("boot", () => {
    test("runtime.ready carries bootMs, processMs and a phase breakdown", async () => {
        const dir = workspace()
        const events: AnyEvent[] = []

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
        })
        // Boot events fired during create; read the report the runtime kept.
        expect(runtime.boot.bootMs).toBeGreaterThanOrEqual(0)
        expect(runtime.boot.processMs).toBeGreaterThan(0)
        // Order is the boot sequence, and the list is exhaustive on purpose: a phase appearing
        // without anyone noticing is a phase whose cost nobody is watching.
        expect(Object.keys(runtime.boot.phases)).toEqual([
            "manifest",
            "store",
            "tools",
            "agents",
            "channels",
        ])

        runtime.bus.on("*", (event) => events.push(event))
        await runtime.stop()
        expect(events.map((e) => e.type)).toContain("runtime.stopping")
    })

    test("a subscriber attached before create sees runtime.ready", async () => {
        const dir = workspace()
        const { EventBus } = await import("../src/events/bus.ts")
        const bus = new EventBus({ runtimeId: "rt_test" })
        const seen: AnyEvent[] = []
        bus.on("*", (event) => seen.push(event))

        await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
            bus,
        })

        const ready = seen.find((event) => event.type === "runtime.ready")
        expect(ready).toBeDefined()
        const data = ready?.data as { bootMs: number; agents: number }
        expect(data.agents).toBe(1)
        expect(data.bootMs).toBeGreaterThanOrEqual(0)
        expect(seen.map((e) => e.type)).toContain("agent.loaded")
    })

    test("booting performs no network I/O at all", async () => {
        // The rule the whole project exists for. A `setup()` that dials out during boot is how the
        // runtime being replaced ends up four minutes from launch to ready.
        const dir = workspace()
        let calls = 0
        const countingFetch: FetchLike = async () => {
            calls += 1
            return sse(["data: [DONE]\n\n"])
        }

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: countingFetch,
        })
        expect(calls).toBe(0)
        await runtime.stop()
    })

    test("one process hosts several agents", async () => {
        const dir = workspace()
        const second = workspace()
        writeFileSync(
            join(second, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: second
model:
  main:
    id: qwen3.5:9b
    baseUrl: http://localhost:11434/v1
`,
        )

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml"), join(second, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
        })
        expect(
            runtime
                .list()
                .map((a) => a.id)
                .sort(),
        ).toEqual(["second", "test"])
        expect(runtime.agent("second").describe().model).toBe("qwen3.5:9b")
        await runtime.stop()
    })

    test("duplicate agent ids fail loudly", async () => {
        const dir = workspace()
        await expect(
            Runtime.create({
                agents: [join(dir, "agent.yaml"), join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
            }),
        ).rejects.toThrow(/share the id/)
    })

    test("asking for an unknown agent lists the known ones", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
        })
        expect(() => runtime.agent("nope")).toThrow(/test/)
        await runtime.stop()
    })
})

describe("a turn", () => {
    test("streams a reply and records it in the session", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
            emitChunks: true,
        })
        const agent = runtime.agent("test")

        const deltas: string[] = []
        runtime.bus.on("model.chunk", (event) => {
            deltas.push((event.data as { delta: string }).delta)
        })

        const result = await agent.send("hi")

        expect(result.text).toBe("Hello there")
        expect(result.reason).toBe("final")
        expect(deltas).toEqual(["Hello", " there"])
        expect((await agent.history()).map((m) => m.role)).toEqual(["user", "assistant"])
        await runtime.stop()
    })

    test("identity from context.files reaches the model as the first system message", async () => {
        const dir = workspace()
        let messages: { role: string; content: string }[] = []
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async (_url, init) => {
                messages = (JSON.parse(String(init?.body)) as { messages: typeof messages })
                    .messages
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })

        await runtime.agent("test").send("hello")

        expect(messages[0]?.role).toBe("system")
        expect(messages[0]?.content).toContain("test fixture")
        expect(messages.at(-1)).toEqual({ role: "user", content: "hello" })
        await runtime.stop()
    })

    test("the identity prefix is byte-identical across turns", async () => {
        // Slot 0 is half of the cache-stable prefix. If it varies per turn, prompt caching stops
        // working and the only symptom is the bill.
        const dir = workspace()
        const prefixes: string[] = []
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async (_url, init) => {
                const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
                prefixes.push(body.messages[0]?.content ?? "")
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })

        const agent = runtime.agent("test")
        await agent.send("one")
        await agent.send("two")

        expect(prefixes[0]).toBe(prefixes[1])
        await runtime.stop()
    })

    test("history accumulates and is replayed on the next turn", async () => {
        const dir = workspace()
        const sent: { role: string; content: string }[][] = []
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async (_url, init) => {
                sent.push(
                    (
                        JSON.parse(String(init?.body)) as {
                            messages: { role: string; content: string }[]
                        }
                    ).messages,
                )
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })

        const agent = runtime.agent("test")
        await agent.send("first")
        await agent.send("second")

        expect(sent[1]?.map((m) => m.content)).toContain("first")
        expect(sent[1]?.map((m) => m.content)).toContain("ok")
        await runtime.stop()
    })

    test("turn events fire in order with a shared turn id", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
        })
        const seen: AnyEvent[] = []
        runtime.bus.on("*", (event) => seen.push(event))

        const result = await runtime.agent("test").send("hi")

        const types = seen.map((e) => e.type)
        expect(types).toEqual([
            "turn.start",
            // Between the ladder and the assembly, and both now describe the *same* prompt — the one
            // about to be sent. Reporting the pre-compaction figure here put `ctx 128%` on a status
            // line for a session compaction had handled; `peak` carries that figure instead.
            "context.pressure",
            "context.assembled",
            "model.call",
            "model.result",
            "turn.end",
        ])
        expect(new Set(seen.map((e) => e.turnId))).toEqual(new Set([result.turnId]))
        await runtime.stop()
    })

    test("sessions are isolated from each other", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
        })
        const agent = runtime.agent("test")

        await agent.send("a", { sessionKey: "local:one" })
        await agent.send("b", { sessionKey: "local:two" })

        expect((await agent.history("local:one")).map((m) => m.content)).toEqual([
            "a",
            "Hello there",
        ])
        expect((await agent.history("local:two")).map((m) => m.content)).toEqual([
            "b",
            "Hello there",
        ])
        await runtime.stop()
    })
})

describe("cancellation", () => {
    test("a stopped turn resolves with reason stopped, and does so promptly", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            emitChunks: true,
            fetch: async () => {
                const stream = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        await sleep(10)
                        controller.enqueue(new TextEncoder().encode(delta("tick ")))
                    },
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream" } })
            },
        })

        const controller = new AbortController()
        let abortedAt = 0
        runtime.bus.on("model.chunk", () => {
            if (abortedAt === 0) {
                abortedAt = performance.now()
                controller.abort()
            }
        })

        const result = await runtime.agent("test").send("go", { signal: controller.signal })
        const elapsed = performance.now() - abortedAt

        expect(result.reason).toBe("stopped")
        // The acceptance criterion is 100 ms. Measured generously here because CI machines are
        // noisy, but the mechanism is a linked AbortSignal reaching fetch, not a poll.
        expect(elapsed).toBeLessThan(100)
        await runtime.stop()
    })

    test("cancelling keeps the partial reply rather than discarding it", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            emitChunks: true,
            fetch: async () => {
                const stream = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        await sleep(10)
                        controller.enqueue(new TextEncoder().encode(delta("word ")))
                    },
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream" } })
            },
        })

        const controller = new AbortController()
        let chunks = 0
        runtime.bus.on("model.chunk", () => {
            chunks += 1
            if (chunks === 2) controller.abort()
        })

        const result = await runtime.agent("test").send("go", { signal: controller.signal })
        expect(result.text.length).toBeGreaterThan(0)
        expect(result.reason).toBe("stopped")
        await runtime.stop()
    })

    test("cancellation produces no unhandled rejection", async () => {
        const rejections: unknown[] = []
        const onRejection = (reason: unknown) => rejections.push(reason)
        process.on("unhandledRejection", onRejection)

        try {
            const dir = workspace()
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: async () => {
                    const stream = new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            await sleep(5)
                            controller.enqueue(new TextEncoder().encode(delta("x")))
                        },
                    })
                    return new Response(stream, {
                        headers: { "content-type": "text/event-stream" },
                    })
                },
            })

            const controller = new AbortController()
            const pending = runtime.agent("test").send("go", { signal: controller.signal })
            await sleep(15)
            controller.abort()
            await pending
            await sleep(20)
            await runtime.stop()
        } finally {
            process.off("unhandledRejection", onRejection)
        }

        expect(rejections).toEqual([])
    })

    test("a turn that outruns turnTimeoutMs is reported as a timeout, not as a stop", async () => {
        const dir = workspace({})
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
limits:
  turnTimeoutMs: 30
`,
        )

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async () => {
                const stream = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        await sleep(10)
                        controller.enqueue(new TextEncoder().encode(delta("slow ")))
                    },
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream" } })
            },
        })

        const result = await runtime.agent("test").send("go")
        expect(result.reason).toBe("timeout")
        await runtime.stop()
    })
})

describe("a .env beside the manifest", () => {
    // Regression guard for a real defect: the loader merged `.env` for validation while the
    // provider read `process.env` at request time, so `validate` approved a manifest that `run`
    // then refused with "MODEL_API_KEY is not set". A validator that disagrees with the runtime is
    // worse than no validator.
    function envWorkspace(): string {
        const dir = mkdtempSync(join(tmpdir(), "runtime-dotenv-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: FROM_DOTENV
`,
        )
        writeFileSync(join(dir, ".env"), "FROM_DOTENV=key-from-file\n")
        return dir
    }

    test("supplies the API key to the provider, not just to validation", async () => {
        const dir = envWorkspace()
        const seen: (string | null)[] = []

        const runtime = await Runtime.create({
            // Deliberately empty: the key exists only in the .env beside the manifest.
            env: {},
            agents: [join(dir, "agent.yaml")],
            fetch: async (_url, init) => {
                seen.push(new Headers(init?.headers).get("authorization"))
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })

        const result = await runtime.agent("test").send("hi")

        expect(result.reason).toBe("final")
        expect(seen).toEqual(["Bearer key-from-file"])
        await runtime.stop()
    })

    test("the real environment still wins over the file", async () => {
        const dir = envWorkspace()
        const seen: (string | null)[] = []

        const runtime = await Runtime.create({
            env: { FROM_DOTENV: "exported-wins" },
            agents: [join(dir, "agent.yaml")],
            fetch: async (_url, init) => {
                seen.push(new Headers(init?.headers).get("authorization"))
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })

        await runtime.agent("test").send("hi")
        expect(seen).toEqual(["Bearer exported-wins"])
        await runtime.stop()
    })

    test("a key rotated after boot is picked up without a restart", async () => {
        // The reason the env is a live view rather than a snapshot.
        const dir = envWorkspace()
        const mutable: Record<string, string | undefined> = { FROM_DOTENV: "first" }
        const seen: (string | null)[] = []

        const runtime = await Runtime.create({
            env: mutable,
            agents: [join(dir, "agent.yaml")],
            fetch: async (_url, init) => {
                seen.push(new Headers(init?.headers).get("authorization"))
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })

        await runtime.agent("test").send("one")
        mutable.FROM_DOTENV = "rotated"
        await runtime.agent("test").send("two")

        expect(seen).toEqual(["Bearer first", "Bearer rotated"])
        await runtime.stop()
    })
})

describe("a reasoning model that exhausts its output budget", () => {
    // Reproduces, in a test, what deepseek-v4-pro did on a live call with max_tokens=16: all of
    // the allowance went to reasoning and `content` came back empty with finish_reason=length.
    const exhaustedFetch: FetchLike = async () =>
        sse([
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking hard" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
            "data: [DONE]\n\n",
        ])

    test("is a failed turn, not an empty success", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: exhaustedFetch,
        })

        const result = await runtime.agent("test").send("hi")

        expect(result.reason).toBe("error")
        expect(result.error?.code).toBe("empty_reply_output_exhausted")
        // The field is the cap, not the budget. `context.reserveOutput` no longer feeds max_tokens
        // — a budgeting number became a hard truncation, and the message blamed a limit this
        // runtime had not sent.
        expect(result.error?.field).toBe("model.main.maxTokens")
        // No max_tokens was configured, so it was the endpoint that stopped it and the message says
        // so rather than quoting a number nobody chose.
        expect(result.error?.message).toContain("the endpoint's own output limit")
        await runtime.stop()
    })

    test("names reasoning as the cause when the model is a reasoning model", async () => {
        const dir = workspace()
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: deepseek-v4-pro
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
`,
        )
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: exhaustedFetch,
        })

        const result = await runtime.agent("test").send("hi")
        expect(result.error?.hint).toContain("bills its thinking")
        expect(result.error?.hint).toContain("reasoningEffort")
        await runtime.stop()
    })

    test("leaves no half-written exchange in the session", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: exhaustedFetch,
        })
        await runtime.agent("test").send("hi")
        expect(await runtime.agent("test").history()).toEqual([])
        await runtime.stop()
    })

    test("a truncated but non-empty reply is reported as truncated, and keeps its text", async () => {
        // The previous behaviour was `final`, on the reasoning that truncation is visible to the user
        // so it needs no flag. That holds for a person watching a terminal and nowhere else: on a
        // channel a cut-off reply reads as a short complete one, and to anything reading the result
        // programmatically `final` plus exit 0 means success. The text is still delivered — this is a
        // reason of its own, not an error — so nothing is hidden that used to be shown.
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async () =>
                sse([
                    delta("partial answer"),
                    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
                    "data: [DONE]\n\n",
                ]),
        })

        const result = await runtime.agent("test").send("hi")
        expect(result.reason).toBe("truncated")
        expect(result.text).toBe("partial answer")
        // Named the field to change and said whose limit it was — `max_tokens` is only sent when
        // configured, so "the endpoint's own" and "the one you set" are different remedies.
        expect(result.error?.code).toBe("reply_truncated")
        expect(result.error?.field).toBe("model.main.maxTokens")
        await runtime.stop()
    })
})

describe("failures inside a turn", () => {
    test("an HTTP failure ends the turn as an error with a hint, not a throw", async () => {
        const dir = workspace()
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async () => new Response("unauthorised", { status: 401 }),
        })

        const errors: AnyEvent[] = []
        runtime.bus.on("error", (event) => errors.push(event))

        const result = await runtime.agent("test").send("hi")

        expect(result.reason).toBe("error")
        expect(result.error?.code).toBe("model_http_error")
        expect(result.error?.hint.length).toBeGreaterThan(0)
        expect(errors.length).toBe(1)
        // A failed turn must not leave a half-written exchange in the session.
        expect(await runtime.agent("test").history()).toEqual([])
        await runtime.stop()
    })
})

describe("knowledge", () => {
    test("an entry enters the context only on turns that mention its keyword", async () => {
        const dir = mkdtempSync(join(tmpdir(), "runtime-knowledge-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  files:
    - IDENTITY.md
knowledge:
  dir: ./knowledge
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
        )
        writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
        const { mkdirSync } = await import("node:fs")
        mkdirSync(join(dir, "knowledge"))
        writeFileSync(
            join(dir, "knowledge", "deploys.md"),
            "---\nkeywords: [deploy]\n---\nStaging first, always.\n",
        )

        let bodies: { role: string; content: string }[][] = []
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async (_url, init) => {
                bodies.push(
                    (JSON.parse(String(init?.body)) as { messages: (typeof bodies)[number] })
                        .messages,
                )
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        const agent = runtime.agent("test")

        await agent.send("how do I deploy this?")
        const withKnowledge = bodies[0] ?? []
        expect(withKnowledge.some((m) => m.content.includes("Staging first"))).toBe(true)

        bodies = []
        await agent.send("what is the capital of France?")
        const without = bodies[0] ?? []
        expect(without.some((m) => m.content.includes("Staging first"))).toBe(false)

        expect(agent.describe().knowledge.map((entry) => entry.name)).toEqual(["deploys.md"])
        await runtime.stop()
    })
})

describe("tools.providers", () => {
    /** A provider whose tools are named after it, so a catalogue can be attributed by eye. */
    function stub(id: string, slugs: readonly string[]): ToolProviderFactory {
        return () => ({
            id,
            resolve(wanted) {
                return Promise.resolve(
                    slugs
                        .filter((slug) => wanted.includes(slug))
                        .map((slug) => ({
                            spec: {
                                slug,
                                provider: id,
                                summary: `${slug} from ${id}`,
                                whenToUse: "testing",
                                whenNotToUse: "not testing",
                                mutating: false,
                                tags: [],
                                parameters: { type: "object" as const, properties: {} },
                            },
                            handler: () => "ok",
                        })),
                )
            },
        })
    }

    function withTools(tools: string): string {
        const dir = mkdtempSync(join(tmpdir(), "runtime-providers-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
${tools}
`,
        )
        return dir
    }

    test("several providers resolve into one catalogue, in manifest order", async () => {
        const dir = withTools(`tools:
  providers:
    alpha: {}
    beta: {}
  pinned: [a_one, b_one, a_two]`)

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
            toolProviders: {
                alpha: stub("alpha", ["a_one", "a_two"]),
                beta: stub("beta", ["b_one"]),
            },
        })

        // Catalogue order is manifest order — what the author pinned first survives a trim — and the
        // providers were consulted in the order the map lists them.
        expect(
            runtime
                .agent("test")
                .tools.specs()
                .map((entry) => entry.slug),
        ).toEqual(["a_one", "b_one", "a_two"])
        expect(
            runtime
                .agent("test")
                .tools.specs()
                .map((entry) => entry.provider),
        ).toEqual(["alpha", "beta", "alpha"])
        await runtime.stop()
    })

    test("a slug two providers both answer is a load failure naming both", async () => {
        const dir = withTools(`tools:
  providers:
    alpha: {}
    beta: {}
  pinned: [shared]`)

        // Silently taking the first would make which provider ran a fact about map order rather
        // than about the manifest — and the two tools with one name do different things.
        let error: HarnessError | undefined
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
                toolProviders: {
                    alpha: stub("alpha", ["shared"]),
                    beta: stub("beta", ["shared"]),
                },
            })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("tool_slug_collision")
        expect(error?.message).toContain("alpha")
        expect(error?.message).toContain("beta")
    })

    test("the old singular provider still loads, with a warning that names the rewrite", async () => {
        const dir = withTools(`tools:
  provider: alpha
  providerConfig: { flavour: vanilla }
  pinned: [a_one]`)

        const seen: Record<string, unknown>[] = []
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: replyFetch,
            toolProviders: {
                alpha: (context) => {
                    seen.push({ ...context.config })
                    return stub("alpha", ["a_one"])(context)
                },
            },
        })

        const agent = runtime.agent("test")
        expect(agent.tools.specs().map((entry) => entry.slug)).toEqual(["a_one"])
        // The config still reaches the provider — the alias is a spelling, not a downgrade.
        expect(seen).toEqual([{ flavour: "vanilla" }])

        // Read off the agent rather than caught on the bus: boot finishes before anything subscribes.
        const warning = agent.warnings.find((entry) => entry.code === "tools_provider_deprecated")
        expect(warning).toBeDefined()
        expect(warning?.hint).toContain("providers:")
        await runtime.stop()
    })

    test("both spellings at once is refused rather than merged", async () => {
        const dir = withTools(`tools:
  providers:
    alpha: {}
  provider: beta
  pinned: [a_one]`)

        let error: HarnessError | undefined
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
                toolProviders: { alpha: stub("alpha", ["a_one"]), beta: stub("beta", []) },
            })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("tools_provider_alias_conflict")
    })

    test("an unregistered id fails at load, naming the field it was written in", async () => {
        const dir = withTools(`tools:
  providers:
    nowhere: {}
  pinned: [a_one]`)

        let error: HarnessError | undefined
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: replyFetch,
                toolProviders: { alpha: stub("alpha", ["a_one"]) },
            })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        // Refused by the loader's knownProviders check before construction is even attempted.
        expect(error?.details?.some((detail) => detail.field === "tools.providers.nowhere")).toBe(
            true,
        )
    })
})

describe("a .env the environment overrides", () => {
    test("a variable the ambient environment wins is named on the agent, with both values", async () => {
        // The layering itself is deliberate and stays. What is not acceptable is silence: an agent
        // whose own .env named deepseek-v4-flash ran a whole session on deepseek-v4-pro because a
        // .env in the directory the binary was launched from said so, and the banner reported the
        // model actually in use — correctly, and uselessly.
        const dir = mkdtempSync(join(tmpdir(), "runtime-override-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: \${MODEL_ID}
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
        )
        writeFileSync(join(dir, ".env"), "MODEL_ID=mine\nMODEL_API_KEY=from-file\n")

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_ID: "theirs", MODEL_API_KEY: "from-env" },
            fetch: replyFetch,
        })

        const agent = runtime.agent("test")
        expect(agent.manifest.model.main.id).toBe("theirs")

        const warning = agent.warnings.find((entry) => entry.code === "env_overridden")
        expect(warning?.message).toContain("MODEL_ID (mine → theirs)")
        // The name is useful and the value is not worth printing to explain a model id.
        expect(warning?.message).toContain("MODEL_API_KEY")
        expect((warning?.message ?? "").includes("from-file")).toBe(false)
        await runtime.stop()
    })

    test("a model that matches no registry row warns, naming the role and the floor", async () => {
        // `CONSERVATIVE`'s 8,192 for an unmatched id is indistinguishable from a measured 8,192, and
        // the budget divides by it — on a model with a real 200k window almost all of it goes unused,
        // silently and in the expensive direction.
        const dir = mkdtempSync(join(tmpdir(), "runtime-window-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: some-model-nobody-listed-v9
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
        )
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_API_KEY: "k" },
            fetch: replyFetch,
        })
        const agent = runtime.agent("test")
        const warning = agent.warnings.find((entry) => entry.code === "model_window_unknown")
        expect(warning?.message).toContain("some-model-nobody-listed-v9")
        expect(warning?.message).toContain("main")
        expect(warning?.message).toContain("8192")
        // Read off `agent.warnings` rather than the bus on purpose: boot finishes before anything
        // subscribes, so a warning emitted there lands in an empty room.
        await runtime.stop()
    })

    test("a recognised model warns about nothing, and an unconfigured role is not a second mistake", async () => {
        // The half that keeps the warning readable. `selector` and `compactor` fall back to main's
        // instance, so without the `configuredAs` filter one unknown model would be reported three
        // times — and three lines about one mistake is how a banner teaches people to skip it.
        const dir = mkdtempSync(join(tmpdir(), "runtime-window-known-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: unlisted-model-a
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
        )
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_API_KEY: "k" },
            fetch: replyFetch,
        })
        const warning = runtime
            .agent("test")
            .warnings.find((entry) => entry.code === "model_window_unknown")
        // One warning, naming main only: the selector fell back to main and the compactor matched.
        expect(warning?.message).toContain("unlisted-model-a")
        expect((warning?.message ?? "").includes("selector")).toBe(false)
        expect((warning?.message ?? "").includes("gpt-4o-mini")).toBe(false)
        await runtime.stop()
    })

    test("agreement and env-only variables say nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "runtime-agree-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
        )
        writeFileSync(join(dir, ".env"), "MODEL_API_KEY=same\n")

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            // Identical is not an override, and a variable only the environment supplies is the
            // normal case — warning about either is how a real warning gets ignored.
            env: { MODEL_API_KEY: "same", PATH: "/usr/bin" },
            fetch: replyFetch,
        })
        expect(
            runtime.agent("test").warnings.some((entry) => entry.code === "env_overridden"),
        ).toBe(false)
        await runtime.stop()
    })
})

describe("max_tokens", () => {
    function withModel(extra: string): string {
        const dir = mkdtempSync(join(tmpdir(), "runtime-maxtokens-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
${extra}context:
  window: 8192
  reserveOutput: 512
`,
        )
        return dir
    }

    async function sentBody(dir: string): Promise<Record<string, unknown>> {
        let body: Record<string, unknown> = {}
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return sse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        await runtime.agent("test").send("hi")
        await runtime.stop()
        return body
    }

    test("is not sent when nobody configured one", async () => {
        // `context.reserveOutput` used to become max_tokens, which turned a context-budgeting
        // number into a hard truncation — and on a reasoning model the truncation lands on the
        // thinking, so the reply came back empty against a limit nobody chose.
        expect("max_tokens" in (await sentBody(withModel("")))).toBe(false)
    })

    test("is sent, and bounded, when model.main.maxTokens says so", async () => {
        expect((await sentBody(withModel("    maxTokens: 4096\n"))).max_tokens).toBe(4096)
        // Never larger than the window: a cap that cannot be served is not a cap.
        expect((await sentBody(withModel("    maxTokens: 999999\n"))).max_tokens).toBe(8191)
    })

    test("reserveOutput still does its own job — reserving prompt budget", async () => {
        // Unchanged and deliberately so: it decides how much of the window the prompt may use.
        const body = await sentBody(withModel(""))
        expect("max_tokens" in body).toBe(false)
        expect(Array.isArray(body.messages)).toBe(true)
    })
})
