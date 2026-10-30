import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ApiPanel, HomePanel, TeamPanel } from "../src/overview.tsx"

const noop = () => undefined

describe("the overview", () => {
    const render = (agents: Parameters<typeof HomePanel>[0]["agents"]) =>
        renderToStaticMarkup(
            createElement(HomePanel, { agents, onOpen: noop, onStart: noop, onNew: noop }),
        )

    test("every agent is a card, and a stopped one offers start and nothing to open", () => {
        const html = render([
            {
                id: "milo",
                name: "Milo",
                status: "loaded",
                model: "deepseek-v4-pro",
                dialect: "native",
                channels: [{ id: "tg", type: "telegram", status: "connected" }],
            },
            { id: "ops", name: "Ops", status: "disabled", reason: "paused for the demo" },
        ])
        expect(html).toContain("2 on this server · 1 running")
        expect(html).toContain("deepseek-v4-pro")
        expect(html).toContain("telegram")
        expect(html).toContain("paused for the demo")
        expect(html).toContain(">start<")
        // Exactly one card is a button: the running one. A stopped agent answers 404.
        expect(html.match(/<button type="button" class="agent-card"/g)?.length).toBe(1)
    })

    test("an empty server says how to make one", () => {
        expect(render([])).toContain("No agents yet")
    })
})

describe("the team panel", () => {
    test("members with their task and the fields they hand back", () => {
        const html = renderToStaticMarkup(
            createElement(TeamPanel, {
                lead: { id: "crew", name: "Crew" },
                team: [{ id: "researcher", task: "Find sources", artifact: ["summary", "links"] }],
            }),
        )
        expect(html).toContain("1 member")
        expect(html).toContain("researcher")
        expect(html).toContain("Find sources")
        expect(html).toContain("links")
    })

    test("no team explains the block that adds one", () => {
        const html = renderToStaticMarkup(
            createElement(TeamPanel, { lead: { id: "milo", name: "Milo" }, team: undefined }),
        )
        expect(html).toContain("No team")
        expect(html).toContain("team:")
    })

    test("peers: the switch, each peer's description, and which are shared or remote", () => {
        const html = renderToStaticMarkup(
            createElement(TeamPanel, {
                lead: { id: "milo", name: "Milo" },
                team: undefined,
                ask: true,
                onAsk: () => {},
                peers: [
                    { id: "nova", description: "Keeps the calendar", shared: false, remote: false },
                    { id: "team/crm", name: "CRM", shared: true, remote: true },
                ],
            }),
        )
        expect(html).toContain("delegation.ask")
        expect(html).toContain("checked")
        expect(html).toContain("Keeps the calendar")
        expect(html).toContain("another silo")
        expect(html).toContain("shared")
        expect(html).toContain("team/crm")
    })

    test("with peer ask off, it says how to switch it on rather than listing nobody", () => {
        const html = renderToStaticMarkup(
            createElement(TeamPanel, { lead: { id: "milo", name: "Milo" }, team: undefined }),
        )
        expect(html).toContain("Nobody to ask")
        expect(html).toContain("Switch it on")
    })
})

describe("the API panel", () => {
    test("names the server's token, not an agent's, and links the reference", () => {
        const html = renderToStaticMarkup(
            createElement(ApiPanel, { baseUrl: "http://127.0.0.1:7420/", agentId: "milo" }),
        )
        expect(html).toContain("http://127.0.0.1:7420/v1/agents/milo/messages")
        expect(html).toContain('href="http://127.0.0.1:7420/docs"')
        expect(html).toContain("API_TOKEN")
        expect(html).toContain("not an agent")
    })
})

describe("the overview's week", () => {
    test("each agent carries its last seven days, an idle one says so, and the header sums them", () => {
        const html = renderToStaticMarkup(
            createElement(HomePanel, {
                agents: [
                    { id: "milo", name: "Milo", status: "loaded" },
                    { id: "nova", name: "Nova", status: "loaded" },
                ],
                week: [{ agentId: "milo", calls: 12, promptTokens: 4_000, outputTokens: 1_500 }],
                onOpen: () => undefined,
                onStart: () => undefined,
                onNew: () => undefined,
                onUsage: () => undefined,
            }),
        )
        expect(html).toContain("12 calls · 5.5k tokens in 7 days")
        expect(html).toContain("no model calls in 7 days")
        expect(html).toContain("12 model calls, 5.5k tokens in 7 days")
    })
})

describe("whom an agent works for", () => {
    test("the Team page names the owner, offers everyone, and nobody means shared", () => {
        const render = (owner: string | null | undefined) =>
            renderToStaticMarkup(
                createElement(TeamPanel, {
                    lead: { id: "milo", name: "Milo" },
                    team: [],
                    ...(owner === undefined ? {} : { owner }),
                    people: [{ id: "user:ada", name: "Ada" }, { id: "user:bob" }],
                    onAssign: () => undefined,
                }),
            )
        expect(render("user:ada")).toContain(
            '<option value="user:ada" selected="">Ada (user:ada)</option>',
        )
        expect(render(null)).toContain(
            '<option value="" selected="">nobody: a shared agent</option>',
        )
        // Not yet read: no picker rather than a wrong "nobody".
        expect(render(undefined)).not.toContain("Works for")
    })
})
