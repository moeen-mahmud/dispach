/**
 * What the keys panel says a credential reaches.
 *
 * Pure, because the interesting cases are all about **absence**: a scope with no `agents` means
 * every agent, and a blank cell under a column headed "Reaches" reads as *unknown*. The difference
 * between "unknown" and "everything" is the entire reason the column exists, so it is said in words.
 */

import { describe, expect, test } from "bun:test"
import { reachSummary } from "../src/keys.tsx"

const NOW = Date.parse("2026-09-20T12:00:00.000Z")
const base = { keyId: "k_1", label: "probe", createdAt: "2026-09-01T00:00:00.000Z" }

describe("reachSummary", () => {
    test("an unscoped key says so in words, never by being blank", () => {
        expect(reachSummary(base, NOW)).toBe("every agent · all capabilities")
    })

    test("a narrowed key names what it reaches", () => {
        expect(
            reachSummary(
                {
                    ...base,
                    scope: { agents: ["milo"], sessions: "team_42:*", can: ["chat", "read"] },
                },
                NOW,
            ),
        ).toBe("milo · sessions team_42:* · chat+read")
    })

    test("each field narrows independently, because a scope is not a level", () => {
        // A key may name agents and keep all four capabilities, or the reverse. Rendering them as
        // one "restricted" badge would lose exactly the information somebody is auditing for.
        expect(reachSummary({ ...base, scope: { agents: ["milo"] } }, NOW)).toBe(
            "milo · all capabilities",
        )
        expect(reachSummary({ ...base, scope: { can: ["read"] } }, NOW)).toBe("every agent · read")
    })

    test("an expiry in the past is marked, not hidden", () => {
        // Same reason a revoked key is listed rather than dropped: the row is the record, and a key
        // that silently vanished from the panel is one nobody can explain afterwards.
        expect(reachSummary({ ...base, expiresAt: "2026-09-19T00:00:00.000Z" }, NOW)).toContain(
            "expired",
        )
        expect(reachSummary({ ...base, expiresAt: "2026-09-21T00:00:00.000Z" }, NOW)).toContain(
            "until",
        )
    })

    test("`now` is a parameter, so the rendering does not depend on when the test runs", () => {
        // The lesson the channel panel already carries: a component reading the clock is one whose
        // test passes or fails depending on the time of day.
        const row = { ...base, expiresAt: "2026-09-20T13:00:00.000Z" }
        expect(reachSummary(row, NOW)).toContain("until")
        expect(reachSummary(row, NOW + 7_200_000)).toContain("expired")
    })
})
