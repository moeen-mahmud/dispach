/**
 * The command palette's list (⌘K / Ctrl+K): every page, every agent, and "new agent", narrowed by
 * what was typed. Pure, so ranking is tested without a DOM.
 *
 * Ranking is deliberately plain: a label that starts with the query beats one that contains it, and
 * one that contains every word beats one that does not. Anything subtler (fuzzy scoring) makes the
 * top row depend on letters a person did not mean, and the top row is what enter opens.
 */

import type { PanelName } from "./deep-link.ts"

export interface PaletteEntry {
    /** Stable and unique: what a row is keyed by and what a pick reports. */
    readonly id: string
    readonly label: string
    /** A second line, shown dim: the group, or which agent a page belongs to. */
    readonly hint: string
    readonly target: { readonly panel: PanelName; readonly agentId?: string }
}

export function paletteEntries(input: {
    readonly agentPanels: readonly { readonly panel: PanelName; readonly label: string }[]
    readonly serverPanels: readonly { readonly panel: PanelName; readonly label: string }[]
    readonly agents: readonly { readonly id: string; readonly name: string }[]
    /** The agent the page is on; its pages are listed under its name. Absent: none listed. */
    readonly current?: { readonly id: string; readonly name: string }
}): readonly PaletteEntry[] {
    const current = input.current
    return [
        ...(current === undefined
            ? []
            : input.agentPanels.map((entry) => ({
                  id: `agent:${current.id}:${entry.panel}`,
                  label: entry.label,
                  hint: current.name,
                  target: { panel: entry.panel, agentId: current.id },
              }))),
        ...input.serverPanels.map((entry) => ({
            id: `server:${entry.panel}`,
            label: entry.label,
            hint: "server",
            target: { panel: entry.panel },
        })),
        ...input.agents.map((agent) => ({
            id: `open:${agent.id}`,
            label: agent.name,
            hint: `agent · ${agent.id}`,
            target: { panel: "chat" as const, agentId: agent.id },
        })),
        { id: "new", label: "New agent", hint: "server", target: { panel: "new" as const } },
    ]
}

/** The entries matching `query`, best first; every entry, in order, for an empty query. */
export function rankEntries(
    entries: readonly PaletteEntry[],
    query: string,
): readonly PaletteEntry[] {
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== "")
    if (words.length === 0) return entries
    const scored = entries.flatMap((entry, index) => {
        const label = entry.label.toLowerCase()
        const haystack = `${label} ${entry.hint.toLowerCase()}`
        if (!words.every((word) => haystack.includes(word))) return []
        const first = words[0] ?? ""
        const score = label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2
        return [{ entry, score, index }]
    })
    // Stable within a score, so the order the list was built in breaks ties.
    return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((row) => row.entry)
}
