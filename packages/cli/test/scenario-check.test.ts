/**
 * The scenario runner's call-log check (`scripts/scenario-check.ts`). It is the hard half of every
 * step, so a check that passed a wrong call log would make every "4 of 5" a lie.
 */

import { describe, expect, test } from "bun:test"
import { checkCalls } from "../../../scripts/scenario-check.ts"

const call = (slug: string, args: Record<string, unknown> = {}) => ({ slug, args })

describe("scenario call checks", () => {
    test("in_order allows calls in between and refuses the wrong order", () => {
        const want = [{ slug: "search" }, { slug: "send", args: { to: "ada" } }]
        expect(
            checkCalls(
                want,
                [call("search"), call("now"), call("send", { to: "ada", body: "x" })],
                "in_order",
            ),
        ).toBeUndefined()
        expect(
            checkCalls(want, [call("send", { to: "ada" }), call("search")], "in_order"),
        ).toContain("expected in order")
        expect(
            checkCalls(want, [call("search"), call("send", { to: "bob" })], "in_order"),
        ).toContain("expected in order")
    })

    test("exact means these and nothing else; an empty exact list means no tool at all", () => {
        expect(checkCalls([{ slug: "a" }], [call("a")], "exact")).toBeUndefined()
        expect(checkCalls([{ slug: "a" }], [call("a"), call("b")], "exact")).toContain("exactly")
        expect(checkCalls([], [], "exact")).toBeUndefined()
        expect(checkCalls([], [call("send")], "exact")).toContain("got [send]")
    })

    test("any_order names what is missing", () => {
        expect(
            checkCalls([{ slug: "a" }, { slug: "b" }], [call("b"), call("a")], "any_order"),
        ).toBeUndefined()
        expect(checkCalls([{ slug: "a" }, { slug: "c" }], [call("a")], "any_order")).toContain(
            "missing c",
        )
    })
})
