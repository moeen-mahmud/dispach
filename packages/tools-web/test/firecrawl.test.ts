/**
 * Firecrawl, first-class (pilot.9), against a fake API that records what it was asked: web_fetch
 * through its scrape, web_map, web_crawl, the search backend, metering, and the guard running first.
 */

import { describe, expect, test } from "bun:test"
import { type ToolUsage, toolContext } from "@dispach/core"
import { webFromConfig } from "../src/provider.ts"

type Route = (body: Record<string, unknown>, method: string) => { status?: number; json: unknown }

function firecrawl(routes: Record<string, Route>) {
    const calls: {
        path: string
        method: string
        body: Record<string, unknown>
        auth: string | null
    }[] = []
    const fetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
        const path = input.replace("https://api.firecrawl.dev/v2", "")
        const body = (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<
            string,
            unknown
        >
        const method = init?.method ?? "GET"
        calls.push({ path, method, body, auth: new Headers(init?.headers).get("authorization") })
        const route = routes[`${method} ${path.replace(/\/crawl\/[^/]+$/, "/crawl/:id")}`]
        if (route === undefined) return new Response("{}", { status: 404 })
        const answer = route(body, method)
        return Response.json(answer.json, { status: answer.status ?? 200 })
    }
    return { calls, fetchLike }
}

async function tools(config: Record<string, unknown>, fake: ReturnType<typeof firecrawl>) {
    const provider = webFromConfig({
        dir: "/tmp",
        env: { FIRECRAWL_API_KEY: "fc-key", TAVILY_API_KEY: "tv-key" },
        config,
        agentId: "a",
    })
    // The real constructor takes no fetch from config, so the test builds through the class.
    const { WebProvider } = await import("../src/provider.ts")
    const built = new WebProvider({
        env: { FIRECRAWL_API_KEY: "fc-key", TAVILY_API_KEY: "tv-key" },
        ...(config.backend === undefined ? {} : { backend: config.backend as "firecrawl" }),
        ...(config.firecrawl === undefined && config.backend !== "firecrawl"
            ? {}
            : { firecrawl: { apiKeyEnv: "FIRECRAWL_API_KEY", onlyMainContent: true } }),
        fetch: fake.fetchLike,
        lookup: async (host) => [
            { address: host === "intranet.example" ? "10.0.0.5" : "93.184.216.34" },
        ],
    })
    const slugs = await provider.list()
    const run = async (slug: string, args: Record<string, unknown>) => {
        const usage: ToolUsage[] = []
        const [tool] = await built.resolve([slug])
        const output = await tool?.handler(
            args,
            toolContext({ meter: (u) => usage.push(u), deadlineMs: 30_000 }),
        )
        return { output: String(output), usage }
    }
    return { slugs, run }
}

describe("Firecrawl", () => {
    test("configured, web_fetch reads through its scrape, metered in credits; crawl and map exist", async () => {
        const fake = firecrawl({
            "POST /scrape": () => ({
                json: {
                    success: true,
                    data: {
                        markdown: "# Pricing\n\nPro is $20.",
                        metadata: {
                            title: "Pricing",
                            url: "https://example.com/pricing",
                            statusCode: 200,
                        },
                    },
                },
            }),
        })
        const { slugs, run } = await tools({ firecrawl: {} }, fake)
        expect(slugs).toEqual(["web_search", "web_fetch", "web_crawl", "web_map"])
        const { output, usage } = await run("web_fetch", { url: "https://example.com/pricing" })
        expect(output).toContain("title: Pricing")
        expect(output).toContain("Pro is $20.")
        expect(fake.calls[0]).toMatchObject({ path: "/scrape", auth: "Bearer fc-key" })
        expect(fake.calls[0]?.body).toMatchObject({
            url: "https://example.com/pricing",
            onlyMainContent: true,
        })
        expect(usage).toEqual([
            { provider: "firecrawl", operation: "scrape", unit: "credits", units: 1 },
        ])
    })

    test("not configured, nothing changes: plain web_fetch, no crawl or map", async () => {
        const { slugs } = await tools({}, firecrawl({}))
        expect(slugs).toEqual(["web_search", "web_fetch"])
    })

    test("a private address is refused before Firecrawl is asked anything", async () => {
        const fake = firecrawl({})
        const { run } = await tools({ firecrawl: {} }, fake)
        await expect(run("web_fetch", { url: "https://intranet.example/" })).rejects.toThrow()
        await expect(run("web_crawl", { url: "http://127.0.0.1/" })).rejects.toThrow()
        expect(fake.calls).toEqual([])
    })

    test("web_map lists addresses; web_crawl polls to completion and meters its credits", async () => {
        let polls = 0
        const fake = firecrawl({
            "POST /map": () => ({
                json: {
                    success: true,
                    links: [
                        { url: "https://example.com/docs", title: "Docs" },
                        { url: "https://example.com/blog" },
                    ],
                },
            }),
            "POST /crawl": () => ({ json: { success: true, id: "c1" } }),
            "GET /crawl/:id": () => {
                polls += 1
                return {
                    json:
                        polls < 2
                            ? { status: "scraping", data: [] }
                            : {
                                  status: "completed",
                                  creditsUsed: 2,
                                  data: [
                                      {
                                          markdown: "Install it.",
                                          metadata: { sourceURL: "https://example.com/docs" },
                                      },
                                      {
                                          markdown: "Configure it.",
                                          metadata: {
                                              sourceURL: "https://example.com/docs/config",
                                          },
                                      },
                                  ],
                              },
                }
            },
        })
        const { run } = await tools({ firecrawl: {} }, fake)
        const mapped = await run("web_map", { url: "https://example.com", search: "docs" })
        expect(mapped.output).toContain("https://example.com/docs — Docs")
        expect(fake.calls[0]?.body).toMatchObject({ search: "docs", limit: 100 })
        const crawled = await run("web_crawl", { url: "https://example.com/docs", limit: 2 })
        expect(crawled.output).toContain("2 pages from example.com")
        expect(crawled.output).toContain("## https://example.com/docs/config")
        expect(crawled.usage).toEqual([
            { provider: "firecrawl", operation: "crawl", unit: "credits", units: 2 },
        ])
    }, 15_000)

    test("an out-of-credit answer says so, as its own code", async () => {
        const fake = firecrawl({
            "POST /scrape": () => ({
                status: 402,
                json: { success: false, error: "Insufficient credits" },
            }),
        })
        const { run } = await tools({ firecrawl: {} }, fake)
        await expect(run("web_fetch", { url: "https://example.com/" })).rejects.toThrow(
            /Insufficient credits/,
        )
    })

    test("as a search backend, and every search is metered", async () => {
        const fake = firecrawl({
            "POST /search": () => ({
                json: {
                    success: true,
                    creditsUsed: 2,
                    data: {
                        web: [{ url: "https://a.example", title: "A", description: "about a" }],
                    },
                },
            }),
        })
        const { run } = await tools({ backend: "firecrawl" }, fake)
        const { output, usage } = await run("web_search", { query: "a" })
        expect(output).toContain("https://a.example")
        expect(usage).toEqual([
            { provider: "firecrawl", operation: "search", unit: "credits", units: 2 },
        ])
    })

    test("a firecrawl block it cannot read is refused at load", () => {
        expect(() =>
            webFromConfig({
                dir: "/tmp",
                env: {},
                config: { firecrawl: { scrape: true } },
                agentId: "a",
            }),
        ).toThrow(/firecrawl.scrape/)
    })
})

describe("a relay in front of the web APIs (pilot.10)", () => {
    test("baseUrl moves search and every Firecrawl call to the relay, same path and body, any host", async () => {
        const seen: string[] = []
        const fetchLike = async (input: string): Promise<Response> => {
            seen.push(input)
            return Response.json(
                input.endsWith("/scrape")
                    ? { data: { markdown: "ok", metadata: { statusCode: 200 } } }
                    : { results: [], data: { web: [] } },
            )
        }
        const { WebProvider } = await import("../src/provider.ts")
        const provider = webFromConfig({
            dir: "/tmp",
            env: {},
            config: {
                backend: "tavily",
                baseUrl: "http://velaops-engine:4000/internal/web-relay/tavily/",
                firecrawl: {
                    baseUrl: "http://velaops-engine:4000/internal/web-relay/firecrawl/v2",
                },
            },
            agentId: "a",
        })
        expect(await provider.list()).toContain("web_crawl")
        const built = new WebProvider({
            env: { TAVILY_API_KEY: "silo-token", FIRECRAWL_API_KEY: "silo-token" },
            backend: "tavily",
            baseUrl: "http://velaops-engine:4000/internal/web-relay/tavily",
            firecrawl: {
                apiKeyEnv: "FIRECRAWL_API_KEY",
                onlyMainContent: true,
                baseUrl: "http://velaops-engine:4000/internal/web-relay/firecrawl/v2",
            },
            fetch: fetchLike,
            lookup: async () => [{ address: "93.184.216.34" }],
        })
        const tools = await built.resolve(["web_search", "web_fetch"])
        for (const tool of tools) {
            await tool.handler(
                tool.spec.slug === "web_search" ? { query: "q" } : { url: "https://example.com/" },
                toolContext({}),
            )
        }
        expect(seen).toEqual([
            "http://velaops-engine:4000/internal/web-relay/tavily/search",
            "http://velaops-engine:4000/internal/web-relay/firecrawl/v2/scrape",
        ])
    })

    test("a baseUrl carrying credentials, or not http, is refused at load", () => {
        const load = (baseUrl: string) =>
            webFromConfig({ dir: "/tmp", env: {}, config: { baseUrl }, agentId: "a" })
        expect(() => load("http://user:pass@relay/x")).toThrow(/credentials/)
        expect(() => load("ftp://relay/x")).toThrow(/http or https/)
    })
})
