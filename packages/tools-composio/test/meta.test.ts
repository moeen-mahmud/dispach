/**
 * The three meta tools: search, connect, workbench.
 *
 * The handlers are tested against a stub `MetaContext` rather than a stub `fetch`, because what
 * matters here is not the transport — that is `client`'s problem — but the two things this layer
 * decides:
 *
 * 1. **What the model is told.** A search hit carries a full JSON schema per tool, and the whole set
 *    would blow `observationMaxTokens` and be middle-cut on every call. `config_read` already did
 *    exactly that: 2,766 tokens against a 2,000 budget, re-read three times in one turn for 8,040
 *    output tokens to change one line. So the observation is a summary and the schemas go to the
 *    cache, and the assertions below are about size and about the next step being *stated*.
 * 2. **What is remembered.** A slug the model was shown must resolve after a restart with no warm
 *    step, or the pin it writes fails the next load — which is the dead end this feature replaces,
 *    reintroduced one layer down.
 */

import { expect, test } from "bun:test"
import type { ToolContext } from "@dispach/core"
import type { ComposioTool } from "../src/map.ts"
import {
    CONNECT_SPEC,
    connectTool,
    findUrl,
    META_SLUGS,
    type MetaContext,
    metaTools,
    SEARCH_SPEC,
    searchTool,
    WORKBENCH_SPEC,
} from "../src/meta.ts"

const CONTEXT = { signal: undefined } as unknown as ToolContext

function schema(slug: string, description: string, tags: readonly string[]): ComposioTool {
    return {
        slug,
        name: slug,
        description,
        tags: [...tags],
        toolkit: { slug: slug.split("_")[0]?.toLowerCase() ?? "" },
        input_parameters: { type: "object", properties: {} },
    } as unknown as ComposioTool
}

interface Recorded {
    readonly calls: { slug: string; args: Readonly<Record<string, unknown>> }[]
    /** Which slugs had their real schema fetched — the set that reaches the cache. */
    readonly fetched: string[]
}

/**
 * `schemas` stands in for `GET /tools/{slug}`, which is where a usable schema comes from. The
 * router's own `tool_schemas` are deliberately not modelled: they lack `input_parameters` and
 * `tags` entirely, so nothing here may read them.
 */
function stub(
    data: unknown,
    options: { ok?: boolean; schemas?: Readonly<Record<string, ComposioTool>> } = {},
): { context: MetaContext; recorded: Recorded } {
    const ok = options.ok ?? true
    const schemas = options.schemas ?? {}
    const recorded: Recorded = { calls: [], fetched: [] }
    return {
        recorded,
        context: {
            call: async (slug, args) => {
                recorded.calls.push({ slug, args })
                return ok ? { ok, data } : { ok, data, error: "nope" }
            },
            fetchSchemas: async (slugs) => {
                recorded.fetched.push(...slugs)
                const out: Record<string, ComposioTool> = {}
                for (const slug of slugs) {
                    const tool = schemas[slug]
                    if (tool !== undefined) out[slug] = tool
                }
                return out
            },
        },
    }
}

/** Real-shaped schemas, as `GET /tools/{slug}` returns them. */
const SCHEMAS: Readonly<Record<string, ComposioTool>> = {
    GMAIL_SEND_EMAIL: schema("GMAIL_SEND_EMAIL", "Sends an email via Gmail.", []),
    GMAIL_CREATE_EMAIL_DRAFT: schema("GMAIL_CREATE_EMAIL_DRAFT", "Creates a draft.", []),
    GMAIL_FETCH_EMAILS: schema("GMAIL_FETCH_EMAILS", "Reads mail.", ["readOnlyHint"]),
}

const SEARCH_DATA = {
    results: [
        {
            index: 1,
            use_case: "send an email",
            primary_tool_slugs: ["GMAIL_SEND_EMAIL"],
            related_tool_slugs: ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_FETCH_EMAILS"],
        },
    ],
    toolkit_connection_statuses: [
        { toolkit: "gmail", has_active_connection: false, status_message: "not connected" },
    ],
}

test("the meta tools resolve from nothing — no cache, no key, no request", () => {
    // The property the whole feature rests on. If these ever came from the cache, a fresh agent
    // would boot with no route to Composio and no way to obtain one.
    const tools = metaTools(stub({}).context)
    expect(Object.keys(tools).sort()).toEqual([...META_SLUGS].sort())
    for (const slug of META_SLUGS) expect(tools[slug]?.spec.slug).toBe(slug)
})

test("search reports the slugs and caches their definitions", async () => {
    const { context, recorded } = stub(SEARCH_DATA, { schemas: SCHEMAS })
    const observation = await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)

    expect(recorded.calls[0]?.slug).toBe("COMPOSIO_SEARCH_TOOLS")
    // One query, not the array Composio accepts: a list-of-objects argument is a worse shape to put
    // in front of a small model than a single string, and parallel search buys nothing here.
    expect(recorded.calls[0]?.args.queries).toEqual([{ use_case: "send an email" }])

    expect(observation).toContain("GMAIL_SEND_EMAIL")
    // Its real schema was fetched, which is what puts it in the cache — so the pin the model writes
    // resolves after a restart with no warm step. This is the loop closing.
    expect(recorded.fetched).toContain("GMAIL_SEND_EMAIL")
})

test("only the slugs about to be shown have their schemas fetched", async () => {
    // One request per slug, so fetching the rest would spend requests on schemas nobody reads and
    // cache tools the model was never offered — which is how a slug nobody saw becomes pinnable.
    const wide = {
        results: [
            {
                primary_tool_slugs: Array.from({ length: 30 }, (_, i) => `GMAIL_ACTION_${i}`),
            },
        ],
    }
    const { context, recorded } = stub(wide)
    // No schemas stubbed, so every hit is dropped and the handler reports no match — irrelevant
    // here. What is under test is how many were asked for before that.
    try {
        await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)
    } catch {
        // expected: nothing resolvable came back
    }
    expect(recorded.fetched.length).toBeLessThanOrEqual(8)
    expect(recorded.fetched.length).toBeGreaterThan(0)
})

test("a slug whose schema could not be fetched is not offered", async () => {
    // Offering it would hand the model a suggestion that breaks its own agent: the pin would fail
    // the next load. The router recommends slugs it has no full schema for, so this happens.
    const orphan = {
        ...SEARCH_DATA,
        results: [{ primary_tool_slugs: ["GMAIL_SEND_EMAIL", "GHOST_TOOL"] }],
    }
    const { context } = stub(orphan, { schemas: SCHEMAS })
    const observation = await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)
    expect(observation.includes("GHOST_TOOL")).toBe(false)
})

test("the observation stays small enough to survive the budget", async () => {
    // Twenty hits with full schemas is what a broad search returns. `estimateTokens` runs about four
    // characters per token, and observationMaxTokens defaults to 2000 — so the cap that matters is
    // the character count, and a summary per tool is what keeps it under.
    const many = {
        results: [
            {
                primary_tool_slugs: Array.from({ length: 20 }, (_, i) => `GMAIL_ACTION_${i}`),
            },
        ],
        toolkit_connection_statuses: [{ toolkit: "gmail", has_active_connection: true }],
    }
    const { context } = stub(many, {
        schemas: Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [
                `GMAIL_ACTION_${i}`,
                schema(`GMAIL_ACTION_${i}`, "x".repeat(4000), []),
            ]),
        ),
    })
    const observation = await searchTool(context).handler({ use_case: "anything" }, CONTEXT)
    expect(observation.length).toBeLessThan(2000)
})

test("a tool this runtime could not load is marked unavailable, not offered to pin (pilot.16)", async () => {
    const broken: ComposioTool = {
        ...schema("GMAIL_CREATE_EMAIL_DRAFT", "Creates a draft.", []),
        input_parameters: {
            type: "object",
            properties: { x: { anyOf: [{ type: "object", properties: {} }, { type: "string" }] } },
        },
    }
    const { context } = stub(SEARCH_DATA, {
        schemas: { ...SCHEMAS, GMAIL_CREATE_EMAIL_DRAFT: broken },
    })
    const observation = await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)
    expect(observation).toContain("n/a    GMAIL_CREATE_EMAIL_DRAFT")
    expect(observation).toContain("unavailable — do not pin it")
    expect(observation).toContain("anyOf")
    // The loadable ones are offered as before.
    expect(observation).toContain("write  GMAIL_SEND_EMAIL")
})

test("the observation states the next step, which no model can infer", async () => {
    // Pin, then restart, and connect first if the account is not linked. Leaving this out is what
    // the transcript that motivated the feature looked like: a model that had the facts and could
    // not work out the sequence.
    const { context } = stub(SEARCH_DATA, { schemas: SCHEMAS })
    const observation = await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)
    expect(observation).toContain("config_set")
    expect(observation).toContain("restart")
    expect(observation).toContain("composio_connect")
})

test("an already-connected toolkit is not reported as needing a sign-in", async () => {
    const connected = {
        ...SEARCH_DATA,
        toolkit_connection_statuses: [{ toolkit: "gmail", has_active_connection: true }],
    }
    const { context } = stub(connected, { schemas: SCHEMAS })
    const observation = await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)
    expect(observation).toContain("Already connected: gmail")
    expect(observation.includes("Not connected yet")).toBe(false)
})

test("no match is a failure, not an empty observation", async () => {
    // "No results" phrased as data reads to a model as a tool that worked, and it then tells the
    // person the app does not exist. Composio covers ~1,000 toolkits, so bad phrasing is likelier.
    const { context } = stub({ results: [] })
    let code = ""
    try {
        await searchTool(context).handler({ use_case: "ride a horse" }, CONTEXT)
    } catch (error) {
        code = (error as { code?: string }).code ?? ""
    }
    expect(code).toBe("composio_no_match")
})

test("connect returns the sign-in link, in the shape the endpoint really sends", async () => {
    // Copied from a live response. The reference describes a `summary` object with
    // `active_connections`; there is no `summary`, and the link is at results.<toolkit>.redirect_url.
    const { context } = stub({
        message: "Connection initiated",
        results: {
            gmail: {
                toolkit: "gmail",
                status: "initiated",
                redirect_url: "https://connect.composio.dev/link/lk_6d24tdiaDqUL",
                instruction: "Action required: Share the following authentication link…",
            },
        },
    })
    const observation = await connectTool(context).handler({ toolkit: "gmail" }, CONTEXT)
    expect(observation).toContain("https://connect.composio.dev/link/lk_6d24tdiaDqUL")
    // It must say the agent cannot finish the job itself, or it will report that it did.
    expect(observation).toContain("cannot complete a sign-in")
    // Composio's own `instruction` prose is never passed through: it is a third party telling a
    // model what to do next, arriving through a tool this runtime marks untrusted.
    expect(observation.includes("Action required")).toBe(false)
})

test("the link is still found if Composio moves it", async () => {
    // The documented path and the real one have already disagreed once. Reading the known field
    // first and walking as a fallback costs nothing and fails loudly rather than silently.
    const { context } = stub({
        results: { gmail: { connection: { url: "https://auth.example/abc" } } },
    })
    const observation = await connectTool(context).handler({ toolkit: "gmail" }, CONTEXT)
    expect(observation).toContain("https://auth.example/abc")
})

test("connect on an already-linked account says so instead of inventing a link", async () => {
    const { context } = stub({ results: { gmail: { toolkit: "gmail", status: "ACTIVE" } } })
    const observation = await connectTool(context).handler({ toolkit: "gmail" }, CONTEXT)
    expect(observation).toContain("already connected")
})

test("no link and no active status is reported as a failure, not as success", async () => {
    const { context } = stub({ message: "toolkit unknown", results: {} })
    const observation = await connectTool(context).handler({ toolkit: "nosuchapp" }, CONTEXT)
    expect(observation).toContain("no sign-in link")
    expect(observation).toContain("toolkit unknown")
})

test("the toolkit is lowercased and passed as a list", async () => {
    const { context, recorded } = stub({ results: { gmail: { status: "ACTIVE" } } })
    await connectTool(context).handler({ toolkit: "  GMail " }, CONTEXT)
    expect(recorded.calls[0]?.slug).toBe("COMPOSIO_MANAGE_CONNECTIONS")
    expect(recorded.calls[0]?.args.toolkits).toEqual(["gmail"])
})

test("findUrl ignores non-URL strings and stops descending", () => {
    expect(findUrl({ a: { b: "not a url" } })).toBe(undefined)
    expect(findUrl({ a: [{ b: "https://x.example/y" }] })).toBe("https://x.example/y")
    // A cycle-free deep object still terminates rather than walking forever.
    let deep: unknown = "https://x.example/y"
    for (let i = 0; i < 20; i += 1) deep = { next: deep }
    expect(findUrl(deep)).toBe(undefined)
})

test("search is read-only and connect is not, and the difference is load-bearing", () => {
    // search parallelises and is retried; connect serialises, holds a write slot, and is never
    // retried — it opens an authorisation against a real account. The cache write search performs
    // is idempotent, which is why it stays a read.
    expect(SEARCH_SPEC.mutating).toBe(false)
    expect(CONNECT_SPEC.mutating).toBe(true)
    expect(WORKBENCH_SPEC.mutating).toBe(true)
    // Both are untrusted: the text comes from whoever published the toolkit.
    expect(SEARCH_SPEC.trust).toBe("untrusted")
    expect(CONNECT_SPEC.trust).toBe("untrusted")
    // The target has to be visible to a rule, or `deny composio_connect(slack)` cannot exist.
    expect(CONNECT_SPEC.policyArg).toBe("toolkit")
})

test("a failed meta call is reported, never rendered as an empty result", async () => {
    const { context } = stub(SEARCH_DATA, { ok: false })
    const observation = await searchTool(context).handler({ use_case: "send an email" }, CONTEXT)
    expect(observation).toContain("failed")
})

// ─── the session, and the wire under it ──────────────────────────────────────────────────

test("a session id survives the process and is not re-created", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { readSession, writeSession } = await import("../src/session.ts")

    const dir = mkdtempSync(join(tmpdir(), "composio-session-"))
    expect(readSession(dir, "default")).toBe(undefined)
    writeSession(dir, "default", "sess_abc")
    expect(readSession(dir, "default")).toBe("sess_abc")

    // Two people on one agent must not share a session: a session is precisely the thing that
    // decides whose Gmail a call reaches.
    writeSession(dir, "moeen", "sess_xyz")
    expect(readSession(dir, "default")).toBe("sess_abc")
    expect(readSession(dir, "moeen")).toBe("sess_xyz")
})

test("an unreadable session file opens a new session rather than failing", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { dirname, join } = await import("node:path")
    const { readSession, sessionPath } = await import("../src/session.ts")

    const dir = mkdtempSync(join(tmpdir(), "composio-session-"))
    mkdirSync(dirname(sessionPath(dir)), { recursive: true })
    writeFileSync(sessionPath(dir), "{ not json", "utf8")
    // A parse error naming a file nobody wrote is the worst available outcome here.
    expect(readSession(dir, "default")).toBe(undefined)
})

test("the router uses v3.1 while tool schemas stay on frozen v3", async () => {
    const { ComposioClient } = await import("../src/client.ts")
    const seen: string[] = []
    const client = new ComposioClient({
        apiKey: "k",
        fetch: async (url) => {
            seen.push(url)
            return new Response(JSON.stringify({ session_id: "s1" }), { status: 201 })
        },
    })
    await client.createSession("default")
    // On v3.1 an omitted version selects the LATEST toolkit version, where v3 pins one. This
    // provider caches schemas to disk and boots off them, so auto-latest would let a cached copy
    // silently stop matching the endpoint — the drift refresh() exists to report, not absorb.
    expect(seen[0]).toBe("https://backend.composio.dev/api/v3.1/tool_router/session")
})

test("an expired session id is recovered once, not looped on", async () => {
    const { ComposioProvider } = await import("../src/provider.ts")
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { writeSession } = await import("../src/session.ts")

    const dir = mkdtempSync(join(tmpdir(), "composio-expired-"))
    // An id that outlived the session it names — the case that matters, because the file survives
    // restarts and the backend's session does not.
    writeSession(dir, "default", "sess_stale")

    const calls: string[] = []
    const provider = new ComposioProvider({
        dir,
        env: { COMPOSIO_API_KEY: "k" },
        fetch: async (url) => {
            calls.push(url)
            if (url.endsWith("/tool_router/session")) {
                return new Response(JSON.stringify({ session_id: "sess_fresh" }), { status: 201 })
            }
            if (url.includes("sess_stale")) return new Response("{}", { status: 404 })
            return new Response(JSON.stringify({ data: { results: [] }, error: null }), {
                status: 200,
            })
        },
    })

    const [connect] = await provider.resolve(["composio_connect"])
    await connect?.handler({ toolkit: "gmail" }, CONTEXT)

    // Stale id tried, session re-opened, retried once against the new id — and no further attempts.
    expect(calls.filter((url) => url.includes("sess_stale")).length).toBe(1)
    expect(calls.filter((url) => url.endsWith("/tool_router/session")).length).toBe(1)
    expect(calls.filter((url) => url.includes("sess_fresh")).length).toBe(1)
})

test("the workbench observes what the code printed, not the envelope it came in", async () => {
    const { renderWorkbench } = await import("../src/meta.ts")
    // The live shape. Returning it as JSON spends the observation budget on field names and a
    // sandbox id nothing reads.
    expect(
        renderWorkbench({
            results: "",
            stdout: "42\n",
            stderr: "",
            error: "",
            sandbox_id_suffix: "qxmd",
        }),
    ).toBe("42")
    // Silence stated, not rendered blank — an empty observation reads as a tool that failed.
    expect(renderWorkbench({ stdout: "", stderr: "" })).toContain("printed nothing")
    expect(renderWorkbench({ stdout: "", stderr: "boom" })).toContain("stderr:\nboom")
})

test("every Composio tool is the owner's, meta tools included (pilot.15)", async () => {
    const { ComposioProvider } = await import("../src/provider.ts")
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const provider = new ComposioProvider({
        dir: mkdtempSync(join(tmpdir(), "composio-personal-")),
        env: { COMPOSIO_API_KEY: "k" },
        fetch: async () => new Response("{}", { status: 200 }),
    })
    const tools = await provider.resolve(["composio_search", "composio_connect"])
    expect(tools.map((tool) => tool.spec.personal)).toEqual([true, true])
})
