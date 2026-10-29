import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ToolsPanel } from "../src/tools.tsx"

const tools = [
    {
        slug: "exec",
        summary: "run a shell command",
        mutating: true,
        trust: "trusted",
        trustReason: "the runtime composed the output",
        provider: "system",
        tags: ["shell"],
    },
    {
        slug: "web_search",
        summary: "search the web",
        mutating: false,
        trust: "untrusted",
        provider: "web",
    },
    { slug: "now", summary: "the time", mutating: false, trust: "trusted", provider: "local" },
]

describe("the tools panel", () => {
    test("groups by provider, counts the cost, and marks untrusted", () => {
        const html = renderToStaticMarkup(
            createElement(ToolsPanel, {
                tools,
                catalogueTokens: 1234,
                providers: [
                    { id: "web", keyEnv: "TAVILY_API_KEY", keySet: false },
                    { id: "system" },
                ],
            }),
        )
        expect(html).toContain("1234 tokens / turn")
        expect(html).toContain("1 untrusted")
        expect(html).toContain("TAVILY_API_KEY missing")
        // Providers appear as group headings, sorted.
        expect(html.indexOf(">local <")).toBeLessThan(html.indexOf(">system <"))
        expect(html.indexOf(">system <")).toBeLessThan(html.indexOf(">web <"))
        expect(html).toContain("the runtime composed the output")
    })

    test("only a pinned tool offers unpin; rules render with remove", () => {
        const html = renderToStaticMarkup(
            createElement(ToolsPanel, {
                tools,
                pinned: ["exec", "web_search"],
                allow: ["memory_write", "exec(git status:*)"],
                deny: [],
                onPin: () => undefined,
                onRules: () => undefined,
            }),
        )
        expect(html.match(/>unpin</g)?.length).toBe(2)
        expect(html).toContain("exec(git status:*)")
        expect(html).toContain("no deny rules")
        expect(html.match(/>remove</g)?.length).toBe(2)
    })

    test("an empty catalogue explains itself", () => {
        expect(renderToStaticMarkup(createElement(ToolsPanel, { tools: [] }))).toContain(
            "tools.pinned",
        )
    })
})
