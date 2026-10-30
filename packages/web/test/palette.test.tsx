import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { paletteEntries, rankEntries } from "../src/lib/palette.ts"
import { Palette } from "../src/palette.tsx"

const entries = paletteEntries({
    agentPanels: [
        { panel: "chat", label: "Chat" },
        { panel: "schedules", label: "Schedules" },
    ],
    serverPanels: [
        { panel: "people", label: "People" },
        { panel: "server-usage", label: "Usage" },
    ],
    agents: [
        { id: "milo", name: "Milo" },
        { id: "nova", name: "Nova" },
    ],
    current: { id: "milo", name: "Milo" },
})

describe("the palette's list", () => {
    test("the current agent's pages, the server's, every agent, and new agent", () => {
        expect(entries.map((entry) => entry.id)).toEqual([
            "agent:milo:chat",
            "agent:milo:schedules",
            "server:people",
            "server:server-usage",
            "open:milo",
            "open:nova",
            "new",
        ])
        expect(entries.find((entry) => entry.id === "open:nova")?.target).toEqual({
            panel: "chat",
            agentId: "nova",
        })
    })

    test("a label starting with the query ranks first, every word must match, empty is all", () => {
        expect(rankEntries(entries, "").length).toBe(entries.length)
        expect(rankEntries(entries, "sch")[0]?.id).toBe("agent:milo:schedules")
        // "agent" is in hints; with "nova" it narrows to the one agent row.
        expect(rankEntries(entries, "agent nova").map((entry) => entry.id)).toEqual(["open:nova"])
        // Starts-with beats contains: "New agent" before anything merely containing "n".
        expect(rankEntries(entries, "ne")[0]?.id).toBe("new")
        expect(rankEntries(entries, "zzz")).toEqual([])
    })
})

describe("the palette", () => {
    test("renders every entry with its hint, the first one current", () => {
        const html = renderToStaticMarkup(
            createElement(Palette, { entries, onPick: () => undefined, onClose: () => undefined }),
        )
        expect(html).toContain('role="dialog"')
        expect(html).toContain('aria-current="true"><span>Chat</span><span class="sub">Milo</span>')
        expect((html.match(/class="palette-item"/g) ?? []).length).toBe(entries.length)
    })
})
