/**
 * Middleware composition, and the two worked examples.
 *
 * The ordering tests matter more than they look. Composition order is the one thing about middleware
 * a person can reason about — "the first plugin listed sees the call first" — and it is invisible
 * when wrong: two middleware in the wrong order still both run, still both return, and produce a
 * result that is subtly not what the manifest asked for.
 */

import { ModelError } from "../src/errors.ts"
import type { AnyEvent } from "../src/events/types.ts"
import { approvalMiddleware, retryMiddleware } from "../src/plugins/builtin.ts"
import { compose, type Middleware, notify } from "../src/plugins/middleware.ts"
import { describe, expect, test } from "./_harness.ts"

/** A turn-shaped middleware that records when it entered and left. */
function tracer(name: string, log: string[]): Middleware {
    return {
        name,
        async wrapTurn(_context, next) {
            log.push(`${name}:in`)
            const result = await next()
            log.push(`${name}:out`)
            return { ...result, text: `${name}(${result.text})` }
        },
    }
}

const TURN_CONTEXT = {
    agentId: "a",
    sessionKey: "local:test",
    turnId: "t1",
    input: "hello",
    source: "test",
    signal: new AbortController().signal,
}

describe("composition", () => {
    test("manifest order is outermost first", async () => {
        const log: string[] = []
        const run = compose([tracer("a", log), tracer("b", log)], "wrapTurn", async () => ({
            text: "core",
            reason: "final",
            steps: 1,
        }))
        const result = await run(TURN_CONTEXT)

        // `a` entered first and left last: it is outside `b`, which is outside the core.
        expect(log).toEqual(["a:in", "b:in", "b:out", "a:out"])
        // And the nesting shows in the result: the core's text was wrapped by b, then by a.
        expect(result.text).toBe("a(b(core))")
    })

    test("nothing implementing a hook returns the core function itself", () => {
        // Not an optimisation to be nice about — these compose per step and per tool call, and a
        // chain of no-op closures on that path is a cost no single measurement would attribute.
        const core = async () => ({ text: "", reason: "final", steps: 0 })
        const run = compose([{ name: "watcher", onEvent: () => {} }], "wrapTurn", core)
        expect(run).toBe(core)
    })

    test("a short-circuit skips the core and everything inside it", async () => {
        const log: string[] = []
        let coreRan = false
        const stop: Middleware = {
            name: "stop",
            async wrapTurn() {
                return { text: "refused", reason: "error", steps: 0 }
            },
        }
        const run = compose([stop, tracer("inner", log)], "wrapTurn", async () => {
            coreRan = true
            return { text: "core", reason: "final", steps: 1 }
        })
        const result = await run(TURN_CONTEXT)

        expect(result.text).toBe("refused")
        expect(coreRan).toBe(false)
        // Not merely the core: everything the short-circuiting middleware wraps is skipped too.
        expect(log).toEqual([])
    })

    test("returning nothing is a named failure, not an empty result", async () => {
        // The one shape that is never intentional. Without this it surfaces as an empty reply or a
        // prompt with no blocks — confusing symptoms that name nothing.
        const forgetful = {
            name: "forgetful",
            wrapTurn: async () => undefined,
        } as unknown as Middleware
        const run = compose([forgetful], "wrapTurn", async () => ({
            text: "core",
            reason: "final",
            steps: 1,
        }))
        await expect(run(TURN_CONTEXT)).rejects.toThrow(/forgetful.*returned nothing/s)
    })

    test("an error propagates rather than being swallowed", async () => {
        const boom: Middleware = {
            name: "boom",
            async wrapTurn() {
                throw new Error("middleware failed")
            },
        }
        const run = compose([boom], "wrapTurn", async () => ({
            text: "core",
            reason: "final",
            steps: 1,
        }))
        await expect(run(TURN_CONTEXT)).rejects.toThrow("middleware failed")
    })
})

describe("onEvent", () => {
    test("a throw is reported and the other watchers still get the event", async () => {
        const seen: string[] = []
        const failures: string[] = []
        const bad: Middleware = {
            name: "bad",
            onEvent: () => {
                throw new Error("observer blew up")
            },
        }
        const good: Middleware = { name: "good", onEvent: (event) => seen.push(event.type) }

        notify([bad, good], { type: "turn.start" } as unknown as AnyEvent, (_error, name) =>
            failures.push(name),
        )
        expect(failures).toEqual(["bad"])
        // The point: one plugin's broken observer must not stop the runtime reporting to everybody.
        expect(seen).toEqual(["turn.start"])
    })
})

/** A step result with only the fields these tests read. */
function step(text: string) {
    return {
        text,
        reasoning: "",
        finishReason: "stop",
        promptTokens: 0,
        promptTokensReported: false,
        outputTokens: 0,
        calls: [],
    } as unknown as Awaited<ReturnType<NonNullable<Middleware["wrapModelCall"]>>>
}

const MODEL_CONTEXT = {
    agentId: "a",
    sessionKey: "local:test",
    turnId: "t1",
    step: 1,
    role: "main",
    model: "test",
    request: { model: "test", messages: [] },
    signal: new AbortController().signal,
}

describe("retry middleware", () => {
    test("retries a 429 and succeeds", async () => {
        const slept: number[] = []
        let attempts = 0
        const middleware = retryMiddleware({
            attempts: 3,
            baseDelayMs: 10,
            sleep: async (ms) => {
                slept.push(ms)
            },
        })
        const run = compose([middleware], "wrapModelCall", async () => {
            attempts += 1
            if (attempts === 1) {
                // The real error this runtime throws, not a hand-made object. `modelHttpError`
                // carried the status only inside its message until this middleware was written,
                // which would have made every retry silently never fire.
                throw new ModelError({
                    status: 429,
                    code: "model_http_error",
                    message: "Model endpoint returned 429",
                    hint: "slow down",
                })
            }
            return step("ok")
        })

        const result = await run(MODEL_CONTEXT)
        expect({ text: result.text, attempts, slept }).toEqual({
            text: "ok",
            attempts: 2,
            slept: [10],
        })
    })

    test("honours Retry-After over its own backoff", async () => {
        const slept: number[] = []
        let attempts = 0
        const run = compose(
            [
                retryMiddleware({
                    attempts: 2,
                    baseDelayMs: 5000,
                    sleep: async (ms) => {
                        slept.push(ms)
                    },
                }),
            ],
            "wrapModelCall",
            async () => {
                attempts += 1
                if (attempts === 1) {
                    throw new ModelError({
                        status: 429,
                        retryAfterSeconds: 2,
                        code: "model_http_error",
                        message: "429",
                        hint: "wait",
                    })
                }
                return step("ok")
            },
        )
        await run(MODEL_CONTEXT)
        // The endpoint said two seconds. Ignoring that is how a client already being rate-limited
        // makes it worse.
        expect(slept).toEqual([2000])
    })

    test("does not retry a 400", async () => {
        let attempts = 0
        const run = compose(
            [retryMiddleware({ attempts: 3, sleep: async () => {} })],
            "wrapModelCall",
            async () => {
                attempts += 1
                throw new ModelError({
                    status: 400,
                    code: "model_http_error",
                    message: "bad request",
                    hint: "fix the prompt",
                })
            },
        )
        await expect(run(MODEL_CONTEXT)).rejects.toThrow("bad request")
        // Retrying spends money on a request that fails identically, and buries the real error.
        expect(attempts).toBe(1)
    })

    test("stops retrying when the turn is cancelled", async () => {
        const controller = new AbortController()
        let attempts = 0
        const run = compose(
            [retryMiddleware({ attempts: 5, sleep: async () => {} })],
            "wrapModelCall",
            async () => {
                attempts += 1
                controller.abort()
                throw new ModelError({
                    status: 503,
                    code: "model_http_error",
                    message: "unavailable",
                    hint: "retry",
                })
            },
        )
        await expect(run({ ...MODEL_CONTEXT, signal: controller.signal })).rejects.toThrow()
        // Cancellation outranks the retry policy, or stop stops being reliable.
        expect(attempts).toBe(1)
    })
})

const TOOL_CONTEXT = {
    agentId: "a",
    sessionKey: "local:test",
    turnId: "t1",
    tool: {
        slug: "file_write",
        provider: "system",
        summary: "",
        whenToUse: "",
        whenNotToUse: "",
        mutating: true,
        tags: [],
        parameters: { type: "object" as const, properties: {}, required: [] },
    },
    intent: { callId: "c1", slug: "file_write", args: {} },
    args: {},
    tainted: false,
    signal: new AbortController().signal,
}

describe("approval middleware", () => {
    test("a denial returns a well-formed failed result and the tool does not run", async () => {
        let ran = false
        const run = compose(
            [approvalMiddleware({ ask: async () => false })],
            "wrapToolCall",
            async () => {
                ran = true
                return {
                    callId: "c1",
                    slug: "file_write",
                    ok: true,
                    output: "written",
                    latencyMs: 1,
                    bytes: 7,
                    truncated: false,
                    trust: "trusted" as const,
                }
            },
        )
        const result = await run(TOOL_CONTEXT)

        expect(ran).toBe(false)
        // Well-formed, not an exception: a refused tool is information the agent can adapt to, and
        // throwing would kill the turn instead.
        expect({ ok: result.ok, code: result.error?.code, callId: result.callId }).toEqual({
            ok: false,
            code: "denied_by_approval",
            callId: "c1",
        })
    })

    test("a throwing approver denies", async () => {
        // A prompt that crashed is not consent. This is the one failure mode the layer exists for.
        const run = compose(
            [
                approvalMiddleware({
                    ask: async () => {
                        throw new Error("the prompt crashed")
                    },
                }),
            ],
            "wrapToolCall",
            async () => {
                throw new Error("must not run")
            },
        )
        const result = await run(TOOL_CONTEXT)
        expect(result.ok).toBe(false)
    })

    test("approval lets the call through to the policy engine", async () => {
        let ran = false
        const run = compose(
            [approvalMiddleware({ ask: async () => true })],
            "wrapToolCall",
            async () => {
                ran = true
                return {
                    callId: "c1",
                    slug: "file_write",
                    ok: true,
                    output: "written",
                    latencyMs: 1,
                    bytes: 7,
                    truncated: false,
                    trust: "trusted" as const,
                }
            },
        )
        const result = await run(TOOL_CONTEXT)
        // `next()` *is* the policy engine in the real wiring, which is why approving can only ever
        // let a call reach the gate — never past it.
        expect({ ran, ok: result.ok }).toEqual({ ran: true, ok: true })
    })

    test("a read-only tool is not asked about", async () => {
        let asked = false
        const run = compose(
            [
                approvalMiddleware({
                    ask: async () => {
                        asked = true
                        return true
                    },
                }),
            ],
            "wrapToolCall",
            async () => ({
                callId: "c1",
                slug: "file_read",
                ok: true,
                output: "contents",
                latencyMs: 1,
                bytes: 8,
                truncated: false,
                trust: "trusted" as const,
            }),
        )
        await run({
            ...TOOL_CONTEXT,
            tool: { ...TOOL_CONTEXT.tool, slug: "file_read", mutating: false },
        })
        expect(asked).toBe(false)
    })
})

describe("confirm without an approver", () => {
    test("warns at load, because a settable value nothing can satisfy is worse than none", async () => {
        // `onMutate: "confirm"` has been settable since the field existed and reachable never: the
        // policy asks `approver: input.approve !== undefined`, and nothing ever set it. The runtime
        // then refuses instead of asking — fail-closed, and not what the manifest says. Worse, the
        // `tool_gated_after_first_use` hint recommends `confirm` as the fix, so a person following
        // the runtime's own advice landed on a setting that could not work for them.
        const { mkdtempSync, writeFileSync } = await import("node:fs")
        const { tmpdir } = await import("node:os")
        const { join } = await import("node:path")
        const { BRAND } = await import("../src/brand.ts")
        const { Runtime } = await import("../src/runtime/runtime.ts")

        const dir = mkdtempSync(join(tmpdir(), "confirm-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: confirmtest
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
tools:
  untrusted:
    onMutate: confirm
`,
        )
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { MODEL_API_KEY: "k" },
            fetch: async () => new Response("{}"),
            lease: false,
        })
        const codes = runtime.agent("confirmtest").warnings.map((warning) => warning.code)
        expect(codes).toContain("confirm_without_approver")
        await runtime.stop()
    })
})
