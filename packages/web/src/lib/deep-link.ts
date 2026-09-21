/**
 * What the address bar says about where you are, and how to put it back.
 *
 * `?agent=milo&panel=tools` rather than `/agents/milo/tools`, and the reason is recorded in
 * `04-SPEC-WIRE.md`: this page is served with **no catch-all**, deliberately, because a wildcard
 * would make `/v1/agentss` answer `200 text/html`. A path would therefore cost a route, a
 * `WEB_ASSETS` entry, a spec row, a `spec.test.ts` change, and either that wildcard or a 404 on
 * reload. A query parameter costs none of them and survives a refresh.
 *
 * Pure, and separate from the component for the reason every reducer in `packages/cli` is: the
 * interesting cases are a URL naming a panel that does not exist and a URL naming an agent that has
 * been stopped since the link was made, and neither is worth mounting a page to check.
 */

/**
 * The panels the shell can show. `chat` is the one you land on.
 *
 * `new` is the odd one: it is the only panel the page may land on *without being asked to* — a
 * server hosting no agents has nothing else to show, and `dispach web run` with no agent points
 * here. It was also the only one that wrote anything until `config` and the schedule form joined
 * it, which is what 0.1.1 was about.
 */
export const PANELS = ["chat", "new", "tools", "schedules", "channels", "config", "keys"] as const

export type PanelName = (typeof PANELS)[number]

export interface Place {
    /** Absent means "whichever agent is running" — the page decides, and does not rewrite the URL. */
    readonly agentId?: string
    readonly panel: PanelName
}

function isPanel(value: string | null): value is PanelName {
    return value !== null && (PANELS as readonly string[]).includes(value)
}

/**
 * Read a place out of a URL.
 *
 * An unknown panel name falls back to `chat` rather than erroring. The ordinary cause is a link
 * made against a later version of the page, and a blank screen reading "no such panel" would be a
 * worse answer than the conversation — which is what somebody following a link to this page wants
 * nine times in ten anyway.
 */
export function placeFrom(href: string): Place {
    const params = new URL(href).searchParams
    const agentId = params.get("agent")
    const panel = params.get("panel")
    return {
        ...(agentId === null || agentId === "" ? {} : { agentId }),
        panel: isPanel(panel) ? panel : "chat",
    }
}

/**
 * The URL for a place, preserving everything else in the address.
 *
 * Built from the current href rather than from scratch so a parameter this module knows nothing
 * about survives — including `claim`, which `lib/auth.ts` strips on purpose and which must not be
 * *re-added* by a navigation. Hence: only these two keys are written, and `chat` writes none, so
 * the landing URL stays clean and a bookmark of it is the shortest thing it can be.
 */
export function hrefFor(href: string, place: Place): string {
    const url = new URL(href)
    if (place.agentId === undefined || place.agentId === "") url.searchParams.delete("agent")
    else url.searchParams.set("agent", place.agentId)
    if (place.panel === "chat") url.searchParams.delete("panel")
    else url.searchParams.set("panel", place.panel)
    return `${url.pathname}${url.search}`
}
