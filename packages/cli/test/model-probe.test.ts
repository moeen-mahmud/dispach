/**
 * `model probe`, end to end, against a recorded endpoint.
 *
 * The far-end test the recurring defect asks for: `lib/probe.ts` is covered separately and every
 * function in it passed while the command still had to *reach* them in the right order, with the
 * right URL, and carry the findings into the report. A pure-module suite that is green tells you
 * nothing about that.
 *
 * The fetch is injected, so this spends nothing and can assert on the *requests* — which is where the
 * two free techniques live: `GET /models` must be a GET at the sibling URL, and the over-range probe
 * must send a `max_tokens` no endpoint will honour, because a value that gets clamped measures
 * nothing.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@dispach/core"
import { modelCommand } from "#model"

interface Recorded {
    readonly url: string
    readonly method: string
    readonly body: Record<string, unknown> | undefined
}

/**
 * A fixture agent whose declared window is its **own**, not the shipped registry's.
 *
 * The first version left `capabilities` off and leaned on `deepseek-v4-flash*` resolving to 393,216,
 * so two tests here asserted a disagreement between the probe and the registry — and both broke the
 * day that row was corrected to 1,048,576, for no reason connected to what they were testing. A test
 * about "does the report notice a disagreement" must *construct* the disagreement; borrowing one from
 * a shipped default makes the suite a hostage to every future measurement.
 */
function agentDir(extra = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "probe-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: probe
model:
  main:
    id: deepseek-v4-flash
    baseUrl: https://api.example.com/v1
    apiKeyEnv: PROBE_KEY
    capabilities:
      contextWindow: 8192
${extra}`,
    )
    writeFileSync(join(dir, ".env"), "PROBE_KEY=secret\n")
    return dir
}

/** An endpoint that publishes nothing, refuses an over-range request, and caches on the repeat. */
function endpoint(options: { refusal?: string; cacheHit?: number; models?: unknown } = {}) {
    const calls: Recorded[] = []
    let chatCalls = 0
    const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url)
        const body =
            typeof init?.body === "string"
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined
        calls.push({ url: href, method: init?.method ?? "GET", body })

        if (href.endsWith("/models")) {
            return new Response(JSON.stringify(options.models ?? { data: [] }), { status: 200 })
        }
        chatCalls += 1
        if (body?.max_tokens === 2_000_000_000) {
            return new Response(
                JSON.stringify({
                    error: {
                        message: options.refusal ?? "max_tokens must be <= 8192",
                    },
                }),
                { status: 400 },
            )
        }
        // The two caching calls. The first reports no hit, the second reports one — which is what a
        // caching endpoint does and what the verdict is allowed to conclude from.
        const cached = chatCalls >= 3 ? (options.cacheHit ?? 1024) : 0
        return new Response(
            JSON.stringify({
                choices: [{ message: { content: "x" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1024, prompt_cache_hit_tokens: cached },
            }),
            { status: 200 },
        )
    }) as typeof globalThis.fetch
    return { doFetch, calls }
}

function capture(): { write: () => string; restore: () => void } {
    const original = process.stdout.write.bind(process.stdout)
    let text = ""
    process.stdout.write = ((chunk: string) => {
        text += chunk
        return true
    }) as typeof process.stdout.write
    return {
        write: () => text,
        restore: () => {
            process.stdout.write = original
        },
    }
}

async function run(
    dir: string,
    doFetch: typeof globalThis.fetch,
    options: { window?: boolean; write?: boolean; yes?: boolean } = {},
): Promise<string> {
    const out = capture()
    try {
        await modelCommand({
            manifestPath: join(dir, "agent.yaml"),
            window: options.window ?? false,
            write: options.write ?? false,
            // The tests drive the search directly; the spend prompt is exercised by its own case
            // below, where a non-TTY stdin is what makes the refusal observable.
            yes: options.yes ?? true,
            json: false,
            fetch: doFetch,
        })
        return out.write()
    } finally {
        out.restore()
    }
}

describe("the two free techniques", () => {
    test("the metadata read is a GET at the sibling URL, not the chat one", async () => {
        // `modelsUrl` is derived from `endpointUrl` in core precisely so the probe cannot drift from
        // the URL a turn uses. Asserted on the recorded request, because deriving it correctly and
        // then calling something else is the failure that would not show up in the report.
        const { doFetch, calls } = endpoint()
        const dir = agentDir()
        await run(dir, doFetch)
        const models = calls.find((call) => call.url.endsWith("/models"))
        expect(models?.url).toBe("https://api.example.com/v1/models")
        expect(models?.method).toBe("GET")
    })

    test("the over-range request asks for a max_tokens nothing will honour", async () => {
        // A value an endpoint silently clamps measures nothing at all. This one is chosen to be
        // refused, and the refusal is what carries the number.
        const { doFetch, calls } = endpoint()
        await run(agentDir(), doFetch)
        const overRange = calls.find((call) => call.body?.max_tokens === 2_000_000_000)
        expect(overRange).toBeDefined()
        expect(overRange?.url).toBe("https://api.example.com/v1/chat/completions")
    })

    test("an output cap is reported as an output cap, not as a window", async () => {
        // `max_tokens must be <= 8192` is about the reply, and writing 8192 in as a context window
        // would be the most damaging possible misreading — it is under every real window here.
        const out = await run(agentDir(), endpoint().doFetch)
        expect(out).toContain("output cap")
        expect(out).toContain("8192")
        expect(out.includes("measured     8192")).toBe(false)
    })

    test("a refusal naming the context length is reported as a ceiling", async () => {
        const { doFetch } = endpoint({
            refusal: "This model's maximum context length is 1048576 tokens.",
        })
        const out = await run(agentDir(), doFetch)
        expect(out).toContain("1048576 (ceiling)")
        // And it disagrees with the manifest, loudly enough to act on.
        expect(out).toContain("short")
    })
})

describe("the caching question", () => {
    test("a hit on the repeat is reported as yes, with the field that carried it", async () => {
        const out = await run(agentDir(), endpoint().doFetch)
        expect(out).toContain("prompt cache")
        expect(out).toContain("yes")
        expect(out).toContain("prompt_cache_hit_tokens")
    })

    test("a miss says evidence rather than proof", async () => {
        const out = await run(agentDir(), endpoint({ cacheHit: 0 }).doFetch)
        expect(out).toContain("no —")
        expect(out).toContain("not proof")
    })

    test("exactly two calls are spent on it", async () => {
        // It costs money, so the count is part of the contract rather than an implementation detail.
        const { doFetch, calls } = endpoint()
        await run(agentDir(), doFetch)
        const cacheCalls = calls.filter(
            (call) => call.body?.max_tokens === 1 && call.url.endsWith("/chat/completions"),
        )
        expect(cacheCalls).toHaveLength(2)
    })
})

describe("what it refuses to write", () => {
    test("a floor is never written into the manifest", async () => {
        // The rule the whole command rests on. A floor says "at least this much"; writing it as
        // `contextWindow` turns it into "exactly this much" for every future reader — which is
        // precisely how the registry came to declare 393,216 against a published 1,048,576.
        const { doFetch } = endpoint({ refusal: "server busy" })
        const dir = agentDir()
        const out = await run(dir, doFetch, { write: true })
        expect(out).toContain("not written")
    })

    test("a measured ceiling is written, and the file really changes", async () => {
        const { doFetch } = endpoint({
            refusal: "This model's maximum context length is 1048576 tokens.",
        })
        const dir = agentDir()
        const out = await run(dir, doFetch, { write: true })
        expect(out).toContain("written to the manifest")
        const after = await Bun.file(join(dir, "agent.yaml")).text()
        expect(after).toContain("contextWindow: 1048576")
        // Through `editManifest`, so what lands is schema-checked rather than re-serialised.
        expect(after).toContain("id: deepseek-v4-flash")
    })
})

describe("every configured role", () => {
    test("a role that falls back to main is not probed twice", async () => {
        // Same model, same endpoint — probing it again spends money to learn the same thing.
        const { doFetch, calls } = endpoint()
        await run(agentDir(), doFetch)
        expect(calls.filter((call) => call.url.endsWith("/models"))).toHaveLength(1)
    })

    test("a compactor on its own endpoint gets its own probe", async () => {
        const { doFetch, calls } = endpoint()
        const dir = agentDir(`  compactor:
    id: qwen3.5:9b
    baseUrl: https://local.example.com/v1
    apiKeyEnv: PROBE_KEY
`)
        const out = await run(dir, doFetch)
        expect(out).toContain("compactor · qwen3.5:9b")
        expect(calls.filter((call) => call.url.endsWith("/models"))).toHaveLength(2)
        expect(calls.some((call) => call.url.startsWith("https://local.example.com"))).toBe(true)
    })
})

describe("what did not answer", () => {
    test("a technique that found nothing is reported rather than swallowed", async () => {
        // "The endpoint publishes no context length" is information about the endpoint. A report
        // showing only successes would look like the probe had nothing to say.
        const out = await run(agentDir(), endpoint().doFetch)
        expect(out).toContain("what did not answer")
        expect(out).toContain("published no context length")
    })

    test("an endpoint that clamps instead of refusing is named as such", async () => {
        // CLAUDE.md's rule, from the other side: an endpoint that ignores a parameter says nothing
        // about it, so the probe reports that it cannot measure rather than reporting a number.
        const doFetch = (async (url: string | URL | Request) =>
            String(url).endsWith("/models")
                ? new Response(JSON.stringify({ data: [] }), { status: 200 })
                : new Response(
                      JSON.stringify({
                          choices: [{ message: { content: "x" } }],
                          usage: { prompt_tokens: 5 },
                      }),
                      { status: 200 },
                  )) as typeof globalThis.fetch
        const out = await run(agentDir(), doFetch)
        expect(out).toContain("clamps silently")
    })
})

describe("the --window search", () => {
    /** Accepts prompts up to `limit` chars, then refuses without naming anything. */
    function grower(limit: number, countedRatio: number) {
        return (async (url: string | URL | Request, init?: RequestInit) => {
            const href = String(url)
            if (href.endsWith("/models")) {
                return new Response(JSON.stringify({ data: [] }), { status: 200 })
            }
            const body =
                typeof init?.body === "string"
                    ? (JSON.parse(init.body) as Record<string, unknown>)
                    : undefined
            if (body?.max_tokens === 2_000_000_000) {
                return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 })
            }
            const messages = body?.messages as { content: string }[] | undefined
            const chars = messages?.[0]?.content.length ?? 0
            if (chars > limit) {
                return new Response(JSON.stringify({ error: { message: "too long" } }), {
                    status: 400,
                })
            }
            return new Response(
                JSON.stringify({
                    choices: [{ message: { content: "x" } }],
                    // Deliberately *not* the requested size: a repeated word is not one token, so the
                    // two numbers genuinely differ on every real endpoint.
                    usage: { prompt_tokens: Math.round(chars * countedRatio) },
                }),
                { status: 200 },
            )
        }) as typeof globalThis.fetch
    }

    test("the floor is the count the endpoint reported, not the size that was asked for", async () => {
        // `filler` repeats a word, and a word is not a token. Labelling a floor with the requested
        // size would make the one honest output of this technique a guess — so the endpoint's own
        // `prompt_tokens` wins. Found while reading the code before spending money on a live run.
        const dir = agentDir()
        const out = await run(dir, grower(200_000, 0.25), { window: true })
        expect(out).toContain("(floor)")
        // 8 chars per unit × 0.25 → a quarter of the characters, which is nothing like the request.
        expect(out).toContain("the endpoint counted at")
        expect(out.includes("accepted a 8192-token")).toBe(false)
    })

    test("a refusal that names a number turns the search into a ceiling", async () => {
        // The better-than-designed outcome: the search set out to raise a floor and came back with a
        // number the endpoint stated, which is a stronger claim than acceptance can ever produce.
        const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const href = String(url)
            if (href.endsWith("/models")) {
                return new Response(JSON.stringify({ data: [] }), { status: 200 })
            }
            const body =
                typeof init?.body === "string"
                    ? (JSON.parse(init.body) as Record<string, unknown>)
                    : undefined
            if (body?.max_tokens === 2_000_000_000) {
                return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 })
            }
            const messages = body?.messages as { content: string }[] | undefined
            if ((messages?.[0]?.content.length ?? 0) > 100_000) {
                return new Response(
                    JSON.stringify({
                        error: { message: "maximum context length is 65536 tokens" },
                    }),
                    { status: 400 },
                )
            }
            return new Response(
                JSON.stringify({
                    choices: [{ message: { content: "x" } }],
                    usage: { prompt_tokens: 1000 },
                }),
                { status: 200 },
            )
        }) as typeof globalThis.fetch
        const out = await run(agentDir(), doFetch, { window: true })
        expect(out).toContain("65536 (ceiling)")
    })
})

describe("the --window spend gate", () => {
    test("a non-terminal is told rather than charged", async () => {
        // `askYesNo` answers no when stdin is not a tty, which is what makes a piped or CI run safe
        // by construction rather than by remembering a flag. The free techniques still ran, so the
        // command is useful rather than merely refused.
        const { doFetch, calls } = endpoint()
        const out = await run(agentDir(), doFetch, { window: true, yes: false })
        expect(out).toContain("Skipping the search")
        expect(out).toContain("--window --yes")
        // And the free findings are still there. Declining the search is a reason to skip the search
        // and no reason to skip the two techniques that cost nothing — an earlier version returned
        // early and printed "the free techniques still ran above", which they had not.
        expect(out).toContain("prompt cache")
        expect(out).toContain("output cap")
        // Nothing large was ever sent: the search never started.
        const big = calls.filter((call) => {
            const messages = call.body?.messages as { content: string }[] | undefined
            return (messages?.[0]?.content.length ?? 0) > 10_000
        })
        expect(big).toHaveLength(0)
    })

    test("the estimate says it is an upper bound, because the search stops at the first refusal", async () => {
        // Measured live: the printed estimate was 4,186,112 tokens and the run stopped at the eighth
        // of nine requests, so roughly half — and the refused one generates nothing.
        const out = await run(agentDir(), endpoint().doFetch, { window: true, yes: false })
        expect(out).toContain("upper bound")
    })
})
