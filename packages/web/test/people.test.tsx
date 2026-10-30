import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ActionsPanel, MemoryPanel, PeoplePanel, RoomsPanel, shortId } from "../src/people.tsx"

const noop = () => undefined
const ada = {
    id: "user:ada",
    name: "Ada",
    role: "admin" as const,
    createdAt: "2026-10-29T00:00:00Z",
}
const bob = {
    id: "user:bob",
    role: "member" as const,
    presence: "offline" as const,
    createdAt: "2026-10-29T00:00:00Z",
}
const agents = [
    { id: "milo", name: "Milo" },
    { id: "crew", name: "Crew" },
]

describe("people", () => {
    test("short ids", () => {
        expect(shortId("user:018f")).toBe("018f")
        expect(shortId("agent:crew")).toBe("crew")
        expect(shortId("me")).toBe("me")
    })

    test("a person shows role, presence and the agents assigned; unassigned agents can be assigned", () => {
        const html = renderToStaticMarkup(
            createElement(PeoplePanel, {
                people: [ada, bob],
                assignments: { milo: "user:ada" },
                agents,
                onAssign: noop,
                onPresence: noop,
            }),
        )
        expect(html).toContain(">Ada<")
        expect(html).toContain(">admin<")
        expect(html).toContain("online (assumed)")
        expect(html).toContain(">offline<")
        expect(html).toContain(">Milo<")
        expect(html).toContain("none assigned")
        // Ada's select offers Crew (unassigned) and not Milo (hers).
        const adaCard = html.slice(html.indexOf("user:ada"), html.indexOf("user:bob"))
        expect(adaCard).toContain("Crew (crew)")
        expect(adaCard).not.toContain("Milo (milo)")
    })
})

describe("a person's title and zone", () => {
    test("are shown on the card and asked for when registering", () => {
        const html = renderToStaticMarkup(
            createElement(PeoplePanel, {
                people: [{ ...ada, title: "Head of support", timezone: "Asia/Dhaka" }],
                assignments: {},
                agents,
                onRegister: noop,
            }),
        )
        expect(html).toContain("Head of support · Asia/Dhaka")
        expect(html).toContain('placeholder="Europe/London"')
    })
})

describe("rooms", () => {
    test("a selected room shows members, the log with stand-in and hop labels, and a post form", () => {
        const html = renderToStaticMarkup(
            createElement(RoomsPanel, {
                rooms: [
                    {
                        id: "r1",
                        kind: "room",
                        title: "Ops",
                        members: ["user:ada", "agent:milo"],
                        createdAt: "",
                    },
                ],
                people: [ada],
                agents,
                selected: "r1",
                messages: [
                    {
                        id: "m1",
                        authorId: "user:ada",
                        origin: "human",
                        text: "status?",
                        mentions: ["agent:milo"],
                        hop: 0,
                        createdAt: "2026-10-29T10:00:00Z",
                    },
                    {
                        id: "m2",
                        authorId: "agent:milo",
                        origin: "agent",
                        text: "**all green**",
                        mentions: [],
                        hop: 1,
                        onBehalfOf: "user:bob",
                        createdAt: "2026-10-29T10:00:05Z",
                    },
                ],
                skips: [
                    { messageId: "m2", reason: "hop_limit", detail: "", hop: 3, ceiling: 3 },
                    { messageId: "nope", reason: "failed", detail: "boom", hop: 1, ceiling: 3 },
                ],
                onSelect: noop,
                onPost: noop,
            }),
        )
        // A skip sits under the message it did not answer; one for another message is not shown.
        expect(html).toContain("not answered: hop limit reached (hop 3 of 3)")
        expect(html).not.toContain("boom")
        expect(html).toContain(">Ops<")
        expect(html).toContain("standing in for bob")
        expect(html).toContain("hop 1")
        expect(html).toContain("<strong>all green</strong>")
        expect(html).toContain("as Ada")
        expect(html).toContain("@Milo")
    })
})

describe("actions", () => {
    test("pending actions offer approve and decline; decided ones are a table", () => {
        const html = renderToStaticMarkup(
            createElement(ActionsPanel, {
                onDecide: noop,
                actions: [
                    {
                        id: "a1",
                        agentId: "milo",
                        conversationId: "r1",
                        ownerId: "user:bob",
                        requestedBy: "user:ada",
                        slug: "file_write",
                        args: { path: "x" },
                        status: "pending",
                        createdAt: "2026-10-29T10:00:00Z",
                    },
                    {
                        id: "a2",
                        agentId: "milo",
                        conversationId: "r1",
                        ownerId: "user:bob",
                        requestedBy: "user:ada",
                        slug: "exec",
                        args: {},
                        status: "denied",
                        createdAt: "2026-10-29T09:00:00Z",
                        decidedAt: "2026-10-29T09:01:00Z",
                    },
                ],
            }),
        )
        expect(html).toContain(">approve and run<")
        expect(html).toContain(">file_write<")
        expect(html).toContain("for bob, asked by ada")
        expect(html).toContain(">denied")
    })

    test("pending actions are grouped by the person whose call it is", () => {
        const pending = (id: string, ownerId: string) => ({
            id,
            agentId: "milo",
            conversationId: "r1",
            ownerId,
            requestedBy: "user:ada",
            slug: "file_write",
            args: {},
            status: "pending" as const,
            createdAt: "2026-10-29T10:00:00Z",
        })
        const html = renderToStaticMarkup(
            createElement(ActionsPanel, {
                actions: [
                    pending("a1", "user:bob"),
                    pending("a2", "user:eve"),
                    pending("a3", "user:bob"),
                ],
            }),
        )
        expect(html).toContain("for bob · 2 waiting")
        expect(html).toContain("for eve · 1 waiting")
        expect(html.indexOf("for bob ·")).toBeLessThan(html.indexOf("for eve ·"))
    })
})

describe("memory", () => {
    test("notes in a scope, projects with agent membership, and the read audit", () => {
        const html = renderToStaticMarkup(
            createElement(MemoryPanel, {
                scope: "space",
                scopes: ["space", "owner:user:ada"],
                notes: [
                    {
                        id: "n1",
                        scope: "space",
                        text: "deploys on Fridays are frozen",
                        writtenBy: "user:ada",
                        createdAt: "2026-10-29T10:00:00Z",
                    },
                ],
                projects: [{ id: "launch", name: "Launch", agents: ["milo"], createdAt: "" }],
                agents,
                reads: [
                    {
                        scope: "owner:user:ada",
                        reader: "agent:milo",
                        requestedBy: "user:bob",
                        at: "2026-10-29T11:00:00Z",
                    },
                ],
                onScope: noop,
                onAdd: noop,
                onProject: noop,
            }),
        )
        expect(html).toContain("deploys on Fridays are frozen")
        expect(html).toContain("project:launch")
        expect(html).toContain('checked=""')
        expect(html).toContain(">milo<")
        expect(html).toContain(">bob<")
    })
})
