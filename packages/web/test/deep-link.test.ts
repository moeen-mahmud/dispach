/**
 * The address bar as state, and the three cases that are not round-trips.
 *
 * Pure, so the interesting inputs are reachable without a browser: a link made against a later
 * version of the page, a link to an agent that has since been stopped, and — the one that would be
 * a security defect rather than an annoyance — a navigation that re-adds a spent one-time claim.
 */

import { describe, expect, test } from "bun:test"
import { hrefFor, PANELS, placeFrom } from "../src/lib/deep-link.ts"

const BASE = "http://127.0.0.1:7420/"

describe("reading a place out of a URL", () => {
    test("both parameters, either, or neither", () => {
        expect(placeFrom(`${BASE}?agent=milo&panel=tools`)).toEqual({
            agentId: "milo",
            panel: "tools",
        })
        expect(placeFrom(`${BASE}?agent=milo`)).toEqual({ agentId: "milo", panel: "chat" })
        expect(placeFrom(`${BASE}?panel=keys`)).toEqual({ panel: "keys" })
        // No agent named is not an error: the page picks whichever is running, which is the right
        // behaviour on the one-agent-per-container shape this runtime is usually deployed in.
        expect(placeFrom(BASE)).toEqual({ panel: "chat" })
    })

    test("a panel this build has never heard of lands on the chat", () => {
        // The ordinary cause is a link made against a later version of the page. A blank screen
        // reading "no such panel" would be a worse answer than the conversation, which is what
        // somebody following a link here wants nine times in ten anyway.
        expect(placeFrom(`${BASE}?panel=onboarding`).panel).toBe("chat")
        expect(placeFrom(`${BASE}?panel=`).panel).toBe("chat")
        expect(placeFrom(`${BASE}?panel=CHAT`).panel).toBe("chat")
    })

    test("every declared panel is readable", () => {
        // Walked from `PANELS` rather than listed again — a hand-kept copy here would be right when
        // written and silently wrong at the next panel, which is the shape this repo keeps finding.
        for (const panel of PANELS) {
            expect(placeFrom(`${BASE}?panel=${panel}`).panel).toBe(panel)
        }
    })
})

describe("writing a place back", () => {
    test("the landing URL stays clean", () => {
        // `chat` writes no parameter, so a bookmark of the page you land on is the shortest thing it
        // can be — and `?panel=chat` is not a state anybody needs to see in an address bar.
        expect(hrefFor(`${BASE}?panel=tools`, { panel: "chat" })).toBe("/")
        expect(hrefFor(BASE, { agentId: "milo", panel: "chat" })).toBe("/?agent=milo")
    })

    test("a navigation never re-adds a spent claim", () => {
        /**
         * The one case here that is a security defect rather than an annoyance.
         *
         * `lib/auth.ts` strips `?claim=` from the address the moment it is exchanged, because a
         * one-time token left there is in the history, in a bookmark and in whatever syncs them.
         * This builds from the *current* href to preserve unknown parameters — so if it were handed
         * a URL that still carried one it must not resurrect it into a later navigation.
         */
        const afterStrip = hrefFor(`${BASE}?panel=keys`, { panel: "tools" })
        expect(afterStrip).not.toContain("claim")
        // And an unknown parameter that is *not* a secret does survive, which is the reason this
        // reads the existing URL rather than building one from scratch.
        expect(hrefFor(`${BASE}?theme=dark`, { agentId: "a", panel: "tools" })).toBe(
            "/?theme=dark&agent=a&panel=tools",
        )
    })

    test("a place round-trips", () => {
        for (const panel of PANELS) {
            const href = hrefFor(BASE, { agentId: "vela", panel })
            expect(placeFrom(`http://127.0.0.1:7420${href}`)).toEqual({
                agentId: "vela",
                panel,
            })
        }
    })
})
