import { describe, expect, test } from "bun:test"
import { afterUserScroll, atBottom, FOLLOW_TOLERANCE_PX } from "../src/lib/follow.ts"

describe("following the newest row", () => {
    test("at the bottom within tolerance is pinned; further up is not", () => {
        expect(atBottom({ scrollTop: 960, scrollHeight: 1000, clientHeight: 40 })).toBe(true)
        expect(
            atBottom({
                scrollTop: 960 - FOLLOW_TOLERANCE_PX,
                scrollHeight: 1000,
                clientHeight: 40,
            }),
        ).toBe(true)
        expect(atBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 40 })).toBe(false)
    })

    test("a user scroll decides the flag; growth cannot", () => {
        // The reader is at the bottom, then 400px of reply arrives. Measured against the NEW
        // height the old offset is far from the bottom — which is exactly why growth must not be
        // what decides. Only a scroll event re-evaluates.
        const before = { scrollTop: 960, scrollHeight: 1000, clientHeight: 40 }
        expect(afterUserScroll(before)).toBe(true)
        const grown = { ...before, scrollHeight: 1400 }
        expect(atBottom(grown)).toBe(false) // what the old Tail measured, and got wrong
    })
})
