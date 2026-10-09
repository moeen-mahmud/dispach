/**
 * The Composio provider.
 *
 * Two properties carry most of the weight here, and both are the kind that fail silently:
 *
 * 1. **`resolve()` makes no request.** It runs before `runtime.ready`, and the whole project exists
 *    because the runtime it replaces blocks minutes on network calls during initialisation. The fetch
 *    injected into these tests throws on any call, so a regression that reaches for the network fails
 *    the test rather than merely being slower.
 * 2. **An unannotated tool is mutating.** 37 of 100 sampled tools carry no read/write hint, so the
 *    default decides how a third of the catalogue executes — parallel and retried, or serial and not.
 *
 * The fixtures are trimmed copies of real `GET /api/v3/tools` responses, including the shapes that
 * drove the mapper's decisions: `default: null`, `minimum`/`maximum`, `format`, and an `array` whose
 * `items` carries an empty `properties` object.
 */

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, renderNotEnabledText, ToolRegistry } from "@dispach/core"
import { cachePath, readCache, writeCache } from "../src/cache.ts"
import { type ComposioTool, isMutating, isUnannotated, mapTool } from "../src/map.ts"
import { ComposioProvider } from "../src/provider.ts"

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "composio-test-"))
}

/** Any call is a failure: nothing in the boot path may touch the network. */
const forbiddenFetch = () => {
    throw new Error("network call attempted")
}

const GMAIL_SEND: ComposioTool = {
    slug: "GMAIL_SEND_EMAIL",
    name: "Send email",
    description: "Sends an email via Gmail. Use for transactional and personal mail.",
    tags: ["gmail", "important"],
    toolkit: { slug: "gmail", name: "Gmail" },
    input_parameters: {
        type: "object",
        title: "SendEmailRequest",
        required: ["recipient_email", "body"],
        properties: {
            recipient_email: { type: "string", title: "Recipient Email", format: "email" },
            body: { type: "string", title: "Body", description: "Email content." },
            // The real shape: a null default, which must not become an argument.
            subject: { type: "string", title: "Subject", default: null, nullable: true },
            is_html: { type: "boolean", title: "Is Html", default: false },
            cc: {
                type: "array",
                title: "Cc",
                default: [],
                items: { type: "string", properties: {} },
                description: "CC recipients.",
            },
        },
    },
}

const GMAIL_FETCH: ComposioTool = {
    slug: "GMAIL_FETCH_EMAILS",
    description: "Fetches emails matching a query.",
    tags: ["gmail", "readOnlyHint"],
    toolkit: { slug: "gmail" },
    input_parameters: {
        type: "object",
        required: [],
        properties: {
            max_results: {
                type: "integer",
                description: "How many to return.",
                minimum: 1,
                maximum: 500,
                default: 10,
            },
        },
    },
}

function seed(dir: string, tools: readonly ComposioTool[]): void {
    const byslug: Record<string, ComposioTool> = {}
    for (const tool of tools) byslug[tool.slug] = tool
    writeCache(dir, byslug, "https://backend.composio.dev/api/v3", () => new Date(0))
}

function provider(dir: string, extra: Record<string, unknown> = {}) {
    return new ComposioProvider({
        dir,
        env: { COMPOSIO_API_KEY: "test-key" },
        fetch: forbiddenFetch,
        now: () => new Date(0),
        ...extra,
    })
}

// ─── mutating derivation ──────────────────────────────────────────────────────────────────

test("readOnlyHint makes a tool non-mutating", () => {
    expect(isMutating(GMAIL_FETCH)).toBe(false)
})

test("destructiveHint makes a tool mutating even alongside readOnlyHint", () => {
    // Contradictory annotations are possible in principle; the dangerous reading wins.
    const both: ComposioTool = { slug: "X", tags: ["readOnlyHint", "destructiveHint"] }
    expect(isMutating(both)).toBe(true)
})

test("a tool with no hint at all is treated as mutating", () => {
    // 37 of 100 sampled tools are in this state, including ABLY_PUBLISH_MESSAGE_TO_CHANNEL. Treating
    // an unannotated write as a read would run it in parallel and retry it — the side effect happens
    // twice, and nothing reports it.
    expect(isMutating(GMAIL_SEND)).toBe(true)
    expect(isUnannotated(GMAIL_SEND)).toBe(true)
})

test("an annotated tool is not reported as an assumption", () => {
    expect(isUnannotated(GMAIL_FETCH)).toBe(false)
})

// ─── schema mapping ───────────────────────────────────────────────────────────────────────

test("a null default is dropped, so no argument is invented", () => {
    // GMAIL_SEND_EMAIL.subject really ships `default: null`. `coerce` applies any default that is not
    // undefined, so keeping this would send subject: null on every call the model left blank.
    const spec = mapTool(GMAIL_SEND)
    expect("default" in (spec.parameters.properties.subject ?? {})).toBe(false)
})

test("a real default survives", () => {
    const spec = mapTool(GMAIL_SEND)
    expect(spec.parameters.properties.is_html?.default).toBe(false)
})

test("constraints the coercer cannot enforce are folded into the description", () => {
    const spec = mapTool(GMAIL_FETCH)
    const description = spec.parameters.properties.max_results?.description ?? ""
    expect(description.includes("minimum 1")).toBe(true)
    expect(description.includes("maximum 500")).toBe(true)
    // The provider's own prose is kept, not replaced by the constraint list.
    expect(description.includes("How many to return.")).toBe(true)
})

test("a constraint on a field with no description still reaches the model", () => {
    const spec = mapTool(GMAIL_SEND)
    expect(spec.parameters.properties.recipient_email?.description).toBe("format email")
})

test("required is preserved, and filtered against what resolved", () => {
    const spec = mapTool(GMAIL_SEND)
    expect(spec.parameters.required).toEqual(["recipient_email", "body"])
})

test("required naming a property that does not exist is dropped, not carried", () => {
    // Carrying it would fail coercion on every call, for a field the model cannot supply.
    const spec = mapTool({
        slug: "X",
        input_parameters: {
            type: "object",
            required: ["real", "ghost"],
            properties: { real: { type: "string" } },
        },
    })
    expect(spec.parameters.required).toEqual(["real"])
})

test("an array's items map, including the empty properties object Composio emits", () => {
    const spec = mapTool(GMAIL_SEND)
    expect(spec.parameters.properties.cc?.type).toBe("array")
    expect(spec.parameters.properties.cc?.items?.type).toBe("string")
})

test("a structural keyword is refused, naming the tool, the field and the keyword", () => {
    // Dropping anyOf would hand the model a schema the endpoint disagrees with. An object in a union
    // is still that case after pilot.16 accepted unions of plain values.
    let message = ""
    try {
        mapTool({
            slug: "WEIRD_TOOL",
            input_parameters: {
                type: "object",
                properties: {
                    target: { anyOf: [{ type: "string" }, { type: "object", properties: {} }] },
                },
            },
        })
    } catch (error) {
        message = error instanceof Error ? error.message : String(error)
    }
    expect(message.includes("WEIRD_TOOL")).toBe(true)
    expect(message.includes("anyOf")).toBe(true)
    expect(message.includes("target")).toBe(true)
})

test("a union of plain values maps as one (pilot.16), the way Composio types a Sheets cell", () => {
    const spec = mapTool({
        slug: "GOOGLESHEETS_BATCH_UPDATE",
        input_parameters: {
            type: "object",
            properties: {
                values: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
                        },
                    },
                },
                x: { type: ["string", "integer", "null"] },
            },
        },
    })
    expect(spec.parameters.properties.values?.items?.items?.type).toEqual([
        "string",
        "number",
        "boolean",
    ])
    expect(spec.parameters.properties.x?.type).toEqual(["string", "integer"])
})

test("a union is still refused when a variant carries a constraint the union form would drop", () => {
    for (const property of [
        { anyOf: [{ type: "string", format: "date" }, { type: "number" }] },
        { allOf: [{ type: "string" }] },
    ]) {
        let code = ""
        try {
            mapTool({
                slug: "UNION_TOOL",
                input_parameters: { type: "object", properties: { x: property } },
            })
        } catch (error) {
            code = (error as { code?: string }).code ?? ""
        }
        expect(code).toBe("composio_schema_unsupported")
    }
})

test("a pinned tool Composio broke costs that tool, not the agent (pilot.16)", async () => {
    // Nine refused reloads in three hours on VelaCrew's pilot, from one schema change upstream.
    const dir = tempDir()
    seed(dir, [
        GMAIL_SEND,
        {
            slug: "SHEETS_BROKEN",
            input_parameters: {
                type: "object",
                properties: {
                    x: { anyOf: [{ type: "object", properties: {} }, { type: "string" }] },
                },
            },
        },
    ])
    const registry = await ToolRegistry.create({
        pinned: ["GMAIL_SEND_EMAIL", "SHEETS_BROKEN"],
        providers: [provider(dir)],
    })
    const slugs = registry.specs().map((spec) => spec.slug)
    expect(slugs).toContain("GMAIL_SEND_EMAIL")
    expect(slugs).not.toContain("SHEETS_BROKEN")
    const warning = registry.warnings.find((entry) => entry.code === "tool_schema_unsupported")
    expect(warning?.message).toContain("SHEETS_BROKEN")
    expect(warning?.message).toContain("anyOf")
    expect(warning?.field).toBe("tools.pinned[1]")
    // Not reported as missing as well, which would blame a slug that exists.
    expect(registry.warnings.some((entry) => entry.code === "unknown_tool")).toBe(false)
    // The model is told it is unavailable, not asked to pin what is pinned.
    expect(renderNotEnabledText(registry.notEnabled)).toContain("Unavailable right now")
    expect(renderNotEnabledText(registry.notEnabled)).toContain("SHEETS_BROKEN")
})

test("a nullable field is its type, which is not a union (pilot.3)", () => {
    const spec = mapTool({
        slug: "NULLABLE_TOOL",
        input_parameters: { type: "object", properties: { x: { type: ["string", "null"] } } },
    })
    expect(spec.parameters.properties.x?.type).toBe("string")
})

test("whenNotToUse is left unset for the registry to flag", () => {
    // Fabricating negative guidance would put words the tool's author never wrote in front of the
    // model, under the tool's own name. Decision 4.11.
    expect(mapTool(GMAIL_SEND).whenNotToUse).toBe(undefined)
})

test("the summary is the first sentence and whenToUse is the whole description", () => {
    const spec = mapTool(GMAIL_SEND)
    expect(spec.summary).toBe("Sends an email via Gmail.")
    expect(spec.whenToUse.includes("transactional and personal mail")).toBe(true)
})

test("tags carry the toolkit and the read/write class", () => {
    expect(mapTool(GMAIL_FETCH).tags).toEqual(["gmail", "read"])
    expect(mapTool(GMAIL_SEND).tags).toEqual(["gmail", "write"])
})

// ─── the cache, and hard rule 4 ───────────────────────────────────────────────────────────

test("resolve serves the cache and makes no network call", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_SEND, GMAIL_FETCH])
    const resolved = await provider(dir).resolve(["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"])
    expect(resolved.map((tool) => tool.spec.slug)).toEqual([
        "GMAIL_SEND_EMAIL",
        "GMAIL_FETCH_EMAILS",
    ])
})

test("an uncached slug is omitted, not thrown — the registry diffs and names them all at once", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_FETCH])
    const p = provider(dir)
    const resolved = await p.resolve(["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL", "SLACK_POST"])
    expect(resolved.map((tool) => tool.spec.slug)).toEqual(["GMAIL_FETCH_EMAILS"])
    expect(p.uncached(["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL", "SLACK_POST"])).toEqual([
        "GMAIL_SEND_EMAIL",
        "SLACK_POST",
    ])
})

test("an unwarmed cache explains itself, naming the warm command rather than the slugs", async () => {
    // Left to the registry this surfaces as "no provider resolved GMAIL_SEND_EMAIL … Available: now,
    // memory_write" — three correct slugs blamed, and local tools offered as the alternative. Only this
    // provider knows the cache is the actual reason, so only it can say so.
    const dir = tempDir()
    const detail = provider(dir).explainUnresolved(["GMAIL_SEND_EMAIL"])
    expect(detail?.code).toBe("composio_cache_miss")
    expect(detail?.hint?.includes("--warm")).toBe(true)
})

test("a cold cache resolves to nothing instead of throwing", async () => {
    // The behaviour this replaces refused the whole boot from inside resolve(). The registry hands
    // EVERY provider the whole pinned list, so a cold Composio was asked about `config_read` — the
    // system provider's, and about to resolve fine — and killed a correct manifest. Omitting is what
    // every other provider does with a slug it does not own.
    const dir = tempDir()
    expect((await provider(dir).resolve(["config_read", "GMAIL_SEND_EMAIL"])).length).toBe(0)
})

test("a warm cache explains nothing — an unknown slug there really is a typo", async () => {
    // The nearest-match message is the better one once there is a catalogue to match against, so the
    // explanation has to fall silent rather than blaming the cache for every future mistake.
    const dir = tempDir()
    seed(dir, [GMAIL_SEND])
    expect(provider(dir).explainUnresolved(["GMAIL_SEND_EMAILZ"])).toBe(undefined)
})

test("an empty request against an empty cache is not a failure", async () => {
    // An agent that pins nothing from the provider has nothing to warm.
    const dir = tempDir()
    expect((await provider(dir).resolve([])).length).toBe(0)
    expect(provider(dir).explainUnresolved([])).toBe(undefined)
})

test("a corrupt cache is treated as empty, not as a parse error", async () => {
    // A boot that dies on JSON.parse names a file the user never edited. The cache-miss failure names
    // the slugs and the warm command instead.
    const dir = tempDir()
    mkdirSync(join(dir, BRAND.stateDir), { recursive: true })
    writeFileSync(cachePath(dir), "{ this is not json", "utf8")
    // Reported as an unwarmed cache, which is the actionable reading, rather than as a parse error
    // naming a file the user never edited.
    expect(
        await provider(dir)
            .resolve([])
            .then(() => "no throw"),
    ).toBe("no throw")
    expect(provider(dir).explainUnresolved(["GMAIL_SEND_EMAIL"])?.code).toBe("composio_cache_miss")
})

test("a cache written by an older version is ignored", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, BRAND.stateDir), { recursive: true })
    writeFileSync(
        cachePath(dir),
        JSON.stringify({
            version: 0,
            provider: "composio",
            tools: { GMAIL_SEND_EMAIL: GMAIL_SEND },
        }),
        "utf8",
    )
    // Ignored, then reported as unwarmed — which is the actionable reading. Misreading an older shape
    // would be worse than refusing it: the fields it was written with are not the fields read now.
    expect(provider(dir).explainUnresolved(["GMAIL_SEND_EMAIL"])?.code).toBe("composio_cache_miss")
})

test("describe reports what was assumed rather than leaving it silent", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_SEND, GMAIL_FETCH])
    const p = provider(dir)
    await p.resolve(["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"])
    const report = p.describe()
    expect(report.cached).toBe(2)
    expect(report.assumedMutating).toEqual(["GMAIL_SEND_EMAIL"])
})

test("the cache round-trips through disk", () => {
    const dir = tempDir()
    seed(dir, [GMAIL_SEND])
    const read = readCache(dir)
    expect(Object.keys(read.tools)).toEqual(["GMAIL_SEND_EMAIL"])
    expect(read.fetchedAt).toBe(new Date(0).toISOString())
})

// ─── refresh, after readiness ─────────────────────────────────────────────────────────────

function jsonFetch(byPath: Record<string, { status?: number; body: unknown }>) {
    const calls: string[] = []
    const fetchLike = async (input: string) => {
        calls.push(input)
        const key = Object.keys(byPath).find((path) => input.includes(path))
        const entry =
            key === undefined
                ? { status: 404, body: { error: { message: "not found" } } }
                : byPath[key]
        return new Response(JSON.stringify(entry?.body ?? {}), {
            status: entry?.status ?? 200,
            headers: { "content-type": "application/json" },
        })
    }
    return { fetchLike, calls }
}

test("refresh fetches, writes the cache, and reports what changed", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_FETCH])
    const { fetchLike, calls } = jsonFetch({ "/tools/GMAIL_SEND_EMAIL": { body: GMAIL_SEND } })
    const p = provider(dir, { fetch: fetchLike })

    const report = await p.refresh(["GMAIL_SEND_EMAIL"])
    expect(report.fetched).toBe(1)
    expect(report.changed).toEqual(["GMAIL_SEND_EMAIL"])
    expect(report.missing).toEqual([])
    expect(calls.length).toBe(1)

    // Merged, not replaced: the previously cached tool survives a refresh of a different slug.
    expect(Object.keys(readCache(dir).tools).sort()).toEqual([
        "GMAIL_FETCH_EMAILS",
        "GMAIL_SEND_EMAIL",
    ])
})

test("refresh reports an unchanged tool as unchanged", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_SEND])
    const { fetchLike } = jsonFetch({ "/tools/GMAIL_SEND_EMAIL": { body: GMAIL_SEND } })
    const report = await provider(dir, { fetch: fetchLike }).refresh(["GMAIL_SEND_EMAIL"])
    expect(report.changed).toEqual([])
})

test("a slug Composio does not have is reported, not thrown — one bad slug keeps the rest", async () => {
    const dir = tempDir()
    const { fetchLike } = jsonFetch({ "/tools/GMAIL_SEND_EMAIL": { body: GMAIL_SEND } })
    const report = await provider(dir, { fetch: fetchLike }).refresh(["GMAIL_SEND_EMAIL", "NOPE"])
    expect(report.fetched).toBe(1)
    expect(report.missing).toEqual(["NOPE"])
})

test("refresh without a key fails naming the variable, not the key", async () => {
    const dir = tempDir()
    const p = new ComposioProvider({ dir, env: {}, fetch: forbiddenFetch })
    let detail: { code?: string; hint?: string } = {}
    try {
        await p.refresh(["GMAIL_SEND_EMAIL"])
    } catch (error) {
        detail = error as { code?: string; hint?: string }
    }
    expect(detail.code).toBe("composio_key_missing")
    expect(detail.hint?.includes("COMPOSIO_API_KEY")).toBe(true)
})

test("a fully cached agent resolves with no key at all — it can boot offline", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_FETCH])
    const p = new ComposioProvider({ dir, env: {}, fetch: forbiddenFetch })
    expect((await p.resolve(["GMAIL_FETCH_EMAILS"])).length).toBe(1)
})

test("an auth failure carries a hint about the variable rather than the status", async () => {
    const dir = tempDir()
    const { fetchLike } = jsonFetch({
        "/tools/": { status: 401, body: { error: { message: "invalid api key" } } },
    })
    let hint = ""
    try {
        await provider(dir, { fetch: fetchLike }).refresh(["GMAIL_SEND_EMAIL"])
    } catch (error) {
        hint = (error as { hint?: string }).hint ?? ""
    }
    expect(hint.includes("apiKeyEnv")).toBe(true)
})

// ─── execution ────────────────────────────────────────────────────────────────────────────

const CONTEXT = {
    agentId: "a",
    sessionKey: "local:default",
    turnId: "t1",
    dir: "/tmp",
    signal: new AbortController().signal,
    deadlineMs: 120_000,
    now: () => new Date(0),
}

test("a successful execution returns the data as the observation", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_FETCH])
    const { fetchLike } = jsonFetch({
        "/tools/execute/": { body: { successful: true, data: { messages: ["one"] } } },
    })
    const [tool] = await provider(dir, { fetch: fetchLike }).resolve(["GMAIL_FETCH_EMAILS"])
    const observation = await tool?.handler({}, CONTEXT)
    expect((observation ?? "").includes("messages")).toBe(true)
})

test("successful: false on a 200 is a failure, not a silent success", async () => {
    // The failure worth guarding: reporting this as success is how an agent tells someone their email
    // was sent when it was not.
    const dir = tempDir()
    seed(dir, [GMAIL_SEND])
    const { fetchLike } = jsonFetch({
        "/tools/execute/": { body: { successful: false, error: "quota exceeded" } },
    })
    const [tool] = await provider(dir, { fetch: fetchLike }).resolve(["GMAIL_SEND_EMAIL"])
    let code = ""
    try {
        await tool?.handler({ recipient_email: "a@b.com", body: "hi" }, CONTEXT)
    } catch (error) {
        code = (error as { code?: string }).code ?? ""
    }
    expect(code).toBe("composio_execute_failed")
})

test("a missing connected account gets its own error naming the toolkit", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_SEND])
    const { fetchLike } = jsonFetch({
        "/tools/execute/": {
            body: { successful: false, error: "No connected account found for gmail" },
        },
    })
    const [tool] = await provider(dir, { fetch: fetchLike }).resolve(["GMAIL_SEND_EMAIL"])
    let detail: { code?: string; hint?: string } = {}
    try {
        await tool?.handler({ recipient_email: "a@b.com", body: "hi" }, CONTEXT)
    } catch (error) {
        detail = error as { code?: string; hint?: string }
    }
    expect(detail.code).toBe("composio_not_connected")
    expect(detail.hint?.includes("userId")).toBe(true)
})

test("the userId reaches the request body", async () => {
    const dir = tempDir()
    seed(dir, [GMAIL_FETCH])
    let sentBody = ""
    const fetchLike = async (_input: string, init?: { body?: string }) => {
        sentBody = init?.body ?? ""
        return new Response(JSON.stringify({ successful: true, data: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        })
    }
    const [tool] = await provider(dir, { fetch: fetchLike, userId: "moeen" }).resolve([
        "GMAIL_FETCH_EMAILS",
    ])
    await tool?.handler({ max_results: 5 }, CONTEXT)
    expect(JSON.parse(sentBody).user_id).toBe("moeen")
})

// ─── the standing constraint ──────────────────────────────────────────────────────────────

test("no MCP transport anywhere in this package", () => {
    // Decision 4.6, asserted rather than trusted. Composio's MCP surface 405s the GET stream leg and
    // stalls past 120 s; both are transport properties, and going direct is what deletes the sidecar.
    const sources = ["client.ts", "provider.ts", "cache.ts", "map.ts", "errors.ts", "index.ts"]
    for (const file of sources) {
        const text = readFileSync(join(import.meta.dir, "..", "src", file), "utf8")
        // Comments legitimately discuss MCP, so the check targets what a transport would actually need.
        expect(/require\(['"]@modelcontextprotocol|from ['"]@modelcontextprotocol/.test(text)).toBe(
            false,
        )
        expect(/new EventSource|text\/event-stream/.test(text)).toBe(false)
    }
})
