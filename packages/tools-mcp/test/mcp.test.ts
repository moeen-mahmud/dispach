/**
 * The MCP provider against a fake Streamable-HTTP server shaped like the live `@firfi/huly-mcp`
 * 0.52.6: its six proxy-mode tools and annotations verbatim, a session id, `202` for a notification,
 * `404` for a stale session, and a tool error as `isError: true` rather than a JSON-RPC error.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, type ChatChunk, decidePolicy, type ModelTransport, Runtime } from "@dispach/core"
import {
    type FetchLike,
    McpProvider,
    type McpTool,
    mcpFromConfig,
    parseServers,
    renderResult,
    slugOf,
    toSpec,
} from "../src/index.ts"

const READ = { readOnlyHint: true, destructiveHint: false }
/** Huly's proxy surface, as `tools/list` returned it live on 2026-09-28. */
const HULY: McpTool[] = [
    { name: "get_version", description: "Huly MCP server version.", annotations: READ },
    {
        name: "search_tools",
        description: "Search Huly tools by name or purpose.",
        annotations: READ,
        inputSchema: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer" } },
            required: ["query"],
            $schema: "http://json-schema.org/draft-07/schema#",
            additionalProperties: false,
        },
    },
    {
        name: "invoke_tool",
        description: "Invoke a Huly tool through the proxy.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
            type: "object",
            properties: {
                toolName: { type: "string", minLength: 1 },
                arguments: { description: "Arguments object for the target Huly tool." },
            },
            required: ["toolName"],
        },
    },
]

interface Seen {
    readonly method: string
    readonly headers: Headers
    readonly body: { id?: number; method: string; params?: { name?: string; arguments?: unknown } }
}

/** A fake server. `sse` answers requests as an event stream; `expire()` drops every session. */
function server(options: { sse?: boolean; down?: boolean; tools?: McpTool[] } = {}) {
    const seen: Seen[] = []
    const sessions = new Set<string>()
    let n = 0
    const fetch: FetchLike = async (_url, init) => {
        if (options.down === true) throw new Error("connect ECONNREFUSED 127.0.0.1:3000")
        const headers = new Headers(init.headers)
        const body = JSON.parse(String(init.body)) as Seen["body"]
        seen.push({ method: body.method, headers, body })
        const session = headers.get("mcp-session-id")
        if (body.method === "initialize") {
            n += 1
            sessions.add(`s${n}`)
            return Response.json(
                { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } },
                { headers: { "mcp-session-id": `s${n}` } },
            )
        }
        if (session === null || !sessions.has(session)) {
            return new Response("session not found", { status: 404 })
        }
        if (body.id === undefined) return new Response(null, { status: 202 })
        const result =
            body.method === "tools/list"
                ? { tools: options.tools ?? HULY }
                : body.params?.name === "invoke_tool"
                  ? {
                        content: [{ type: "text", text: "tool delete_issue is not in TOOLS" }],
                        isError: true,
                    }
                  : { content: [{ type: "text", text: `ran ${body.params?.name}` }] }
        const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result })
        return options.sse === true
            ? new Response(`event: message\ndata: ${message}\n\n`, {
                  headers: { "content-type": "text/event-stream" },
              })
            : new Response(message, { headers: { "content-type": "application/json" } })
    }
    return { fetch, seen, expire: () => sessions.clear() }
}

const CONFIG = {
    servers: {
        huly: {
            url: "http://127.0.0.1:3000/mcp",
            headersEnv: { Authorization: "HULY_MCP_AUTH" },
            participantHeader: "X-Acting-Participant",
            policyArgs: { invoke_tool: "toolName" },
        },
    },
}

function provider(fake: FetchLike, dir = mkdtempSync(join(tmpdir(), "mcp-"))) {
    return {
        dir,
        mcp: new McpProvider({
            dir,
            env: { HULY_MCP_AUTH: "Bearer secret-value" },
            servers: parseServers(CONFIG),
            fetch: fake,
        }),
    }
}

describe("configuration", () => {
    test("refuses what it would otherwise ignore, and never takes a secret", () => {
        const refused = (config: Record<string, unknown>) => {
            try {
                parseServers(config)
                return "accepted"
            } catch (error) {
                return (error as { code: string }).code
            }
        }
        expect(refused({ servers: {} })).toBe("mcp_config_invalid")
        expect(refused({ server: {} })).toBe("mcp_config_invalid")
        expect(refused({ servers: { Huly_X: { url: "http://x/mcp" } } })).toBe("mcp_config_invalid")
        expect(refused({ servers: { huly: { url: "http://u:p@x/mcp" } } })).toBe(
            "mcp_config_invalid",
        )
        expect(refused({ servers: { huly: { url: "stdio://x" } } })).toBe("mcp_config_invalid")
        expect(
            refused({ servers: { huly: { url: "http://x/mcp", headersEnv: { A: "Bearer x" } } } }),
        ).toBe("mcp_config_invalid")
        expect(refused({ servers: { huly: { url: "http://x/mcp", extra: 1 } } })).toBe(
            "mcp_config_invalid",
        )
        expect(refused(CONFIG)).toBe("accepted")
    })
})

describe("mapping", () => {
    test("namespaced slugs, fail-closed mutating, the proxy's inner tool as its policy arg", () => {
        const [version, search, invoke] = HULY.map((tool) =>
            toSpec("huly", tool, tool.name === "invoke_tool" ? "toolName" : undefined),
        )
        expect(version?.slug).toBe("huly__get_version")
        expect(version?.mutating).toBe(false)
        expect(search?.parameters.properties.query?.description).toBe("minLength 1")
        expect(invoke?.mutating).toBe(true)
        expect(invoke?.policyArg).toBe("toolName")
        // Untyped in the schema; a string would make the model stringify the inner arguments.
        expect(invoke?.parameters.properties.arguments?.type).toBe("object")
        // No annotations at all is a write.
        expect(toSpec("huly", { name: "x" }, undefined).mutating).toBe(true)
        expect(slugOf("huly", "a.b/c")).toBe("huly__a_b_c")
        expect(invoke?.trust).toBeUndefined()
    })

    test("a nullable field is its type; a real union is still refused (QA pilot.3)", () => {
        const spec = toSpec(
            "work",
            {
                name: "update_task",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: { type: ["string", "null"], description: "New title." },
                        due: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
                    },
                },
            },
            undefined,
        )
        expect(spec.parameters.properties.title?.type).toBe("string")
        expect(spec.parameters.properties.title?.description).toBe("New title.")
        expect(spec.parameters.properties.due?.type).toBe("string")
        expect(spec.parameters.properties.due?.description).toBe("format date")
        expect(() =>
            toSpec(
                "work",
                { name: "u", inputSchema: { properties: { x: { type: ["string", "number"] } } } },
                undefined,
            ),
        ).toThrow(/type: \[\]/)
    })

    test("a tool nobody pinned cannot refuse the agent by having a schema it cannot express", async () => {
        // `available()` converted every cached tool's schema to read a summary, so one unpinned tool
        // with a union refused the whole agent at boot.
        const union: McpTool = {
            name: "search",
            description: "Search anything.",
            inputSchema: { properties: { q: { type: ["string", "number"] } } },
        }
        const { mcp } = provider(server({ tools: [...HULY, union] }).fetch)
        await mcp.refresh([])
        expect((await mcp.available()).map((entry) => entry.slug)).toContain("huly__search")
    })

    test("a policy rule reaches the tool the proxy would call", () => {
        const policy = {
            mode: "allow" as const,
            allow: [] as string[],
            deny: ["huly__invoke_tool(delete_*)"],
            onNoApprover: "deny" as const,
        }
        expect(
            decidePolicy(policy, { slug: "huly__invoke_tool", match: "delete_issue" }).effect,
        ).toBe("deny")
        expect(
            decidePolicy(policy, { slug: "huly__invoke_tool", match: "list_issues" }).effect,
        ).toBe("allow")
    })

    test("non-text content is named rather than dropped", () => {
        expect(renderResult({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe(
            "a\n[image content omitted]",
        )
        expect(renderResult({ structuredContent: { ok: 1 } })).toContain('"ok": 1')
    })
})

describe("boot and refresh", () => {
    test("boot resolves from the cache and contacts nothing; a cold cache names --warm", async () => {
        const fake = server()
        const { mcp } = provider(fake.fetch)
        expect(await mcp.resolve(["huly__get_version"])).toEqual([])
        expect(fake.seen).toEqual([])
        const cold = mcp.explainUnresolved(["huly__get_version", "now", "other__x"])
        expect(cold?.code).toBe("mcp_cache_miss")
        expect(cold?.hint).toContain("--warm")
        // Not ours: a slug for an unconfigured server, or another provider's, is not explained here.
        expect(cold?.message).not.toContain("other__x")
        expect(mcp.explainUnresolved(["now"])).toBeUndefined()
    })

    test("refresh lists over SSE, writes the cache, and the next boot resolves from it", async () => {
        const fake = server({ sse: true })
        const { mcp, dir } = provider(fake.fetch)
        const report = await mcp.refresh(["huly__get_version", "huly__gone"])
        expect(report.fetched).toBe(1)
        expect(report.missing).toEqual(["huly__gone"])
        expect(report.changed).toEqual(["huly__get_version"])
        // Initialize, the initialized notification with its session, then the listing.
        expect(fake.seen.map((call) => call.method)).toEqual([
            "initialize",
            "notifications/initialized",
            "tools/list",
        ])
        expect(fake.seen[2]?.headers.get("mcp-session-id")).toBe("s1")
        expect(fake.seen[2]?.headers.get("authorization")).toBe("Bearer secret-value")

        const again = provider(server().fetch, dir).mcp
        const tools = await again.resolve(["huly__get_version", "huly__invoke_tool"])
        expect(tools.map((tool) => tool.spec.slug).sort()).toEqual([
            "huly__get_version",
            "huly__invoke_tool",
        ])
    })

    test("a server that is down fails the refresh by name and keeps the cache", async () => {
        const { mcp, dir } = provider(server().fetch)
        await mcp.refresh([])
        const down = provider(server({ down: true }).fetch, dir).mcp
        await expect(down.refresh([])).rejects.toThrow(/huly.*ECONNREFUSED/)
        expect((await down.resolve(["huly__get_version"])).length).toBe(1)
    })
})

describe("calls", () => {
    async function warmed(fake: ReturnType<typeof server>) {
        const { mcp } = provider(fake.fetch)
        await mcp.refresh([])
        const tools = await mcp.resolve(["huly__get_version", "huly__invoke_tool"])
        const tool = (slug: string) => tools.find((entry) => entry.spec.slug === slug)
        return { tool }
    }
    const context = (actingParticipant: { id: string; via: "api" } | null) => ({
        agentId: "a",
        sessionKey: "s",
        turnId: "t",
        dir: "/",
        signal: new AbortController().signal,
        deadlineMs: 1000,
        now: () => new Date(),
        actingParticipant,
    })

    test("a person is forwarded as the participant header; nobody sends none", async () => {
        const fake = server()
        const { tool } = await warmed(fake)
        expect(
            await tool("huly__get_version")?.handler({}, context({ id: "user:bob", via: "api" })),
        ).toBe("ran get_version")
        await tool("huly__get_version")?.handler({}, context(null))
        const calls = fake.seen.filter((call) => call.method === "tools/call")
        expect(calls[0]?.headers.get("x-acting-participant")).toBe("user:bob")
        expect(calls[1]?.headers.has("x-acting-participant")).toBe(false)
    })

    test("the server's refusal is a failed call carrying its words", async () => {
        const { tool } = await warmed(server())
        await expect(
            tool("huly__invoke_tool")?.handler(
                { toolName: "delete_issue", arguments: {} },
                context(null),
            ) ?? Promise.resolve(),
        ).rejects.toMatchObject({ code: "mcp_tool_failed" })
    })

    test("a server restart (stale session) costs one re-initialize, not a failure", async () => {
        const fake = server()
        const { tool } = await warmed(fake)
        fake.expire()
        expect(await tool("huly__get_version")?.handler({}, context(null))).toBe("ran get_version")
        expect(fake.seen.filter((call) => call.method === "initialize").length).toBe(2)
    })
})

describe("through a real turn", () => {
    test("a pinned MCP tool is called from a turn, and its output is fenced as untrusted", async () => {
        const fake = server()
        const dir = mkdtempSync(join(tmpdir(), "mcp-turn-"))
        await provider(fake.fetch, dir).mcp.refresh([])
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: mcp-agent
model:
  main:
    id: scripted
    api: scripted
    capabilities:
      nativeTools: true
tools:
  dialect: native
  providers:
    mcp:
      servers:
        huly:
          url: http://127.0.0.1:3000/mcp
          headersEnv: { Authorization: HULY_MCP_AUTH }
          participantHeader: X-Acting-Participant
  pinned: [huly__get_version]
`,
        )
        const prompts: string[] = []
        const scripted: ModelTransport = {
            create: (context) => ({
                id: context.id,
                async *chat(request): AsyncIterable<ChatChunk> {
                    prompts.push(JSON.stringify(request.messages))
                    if (prompts.length === 1) {
                        yield {
                            type: "tool_call",
                            call: { id: "c1", name: "huly__get_version", arguments: "{}" },
                        }
                        yield { type: "finish", reason: "tool_calls" }
                        return
                    }
                    yield { type: "text", delta: "done" }
                    yield { type: "finish", reason: "stop" }
                },
            }),
        }
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: { HULY_MCP_AUTH: "Bearer secret-value" },
            store: ":memory:",
            modelTransports: { scripted },
            toolProviders: { mcp: (context) => mcpFromConfig(context, fake.fetch) },
        })
        const reply = await runtime
            .agent("mcp-agent")
            .send("version?", { from: { id: "user:bob", kind: "user" } })
        await runtime.stop()

        expect(reply.text).toBe("done")
        const call = fake.seen.find((entry) => entry.method === "tools/call")
        expect(call?.body.params?.name).toBe("get_version")
        expect(call?.headers.get("x-acting-participant")).toBe("user:bob")
        // A remote server is a stranger: its output reaches the model inside the untrusted fence.
        expect(prompts[1]).toContain("ran get_version")
        expect(prompts[1]).toMatch(/untrusted/i)
    })
})
