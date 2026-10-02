/**
 * The version gate's arithmetic.
 *
 * Worth its own file because a subtly wrong range check is the one failure this subsystem must not
 * have: it either loads a plugin written against a host that no longer exists, or refuses one that
 * would have worked — and both surface far from here. The third answer, `undefined`, is asserted as
 * hard as the other two, because "cannot decide" collapsing into `false` would report a version
 * mismatch for a malformed declaration and point the reader at the wrong number.
 */

import { parseVersion, satisfies } from "../src/plugins/semver.ts"
import { describe, expect, test } from "./_harness.ts"

describe("caret, which is what a plugin actually declares", () => {
    test("0.x is pinned to its minor", () => {
        // The minor is the compatibility line under 0.x: a 0.2 host refuses a plugin still on ^0.1.
        expect(satisfies("0.1.0", "^0.1")).toBe(true)
        expect(satisfies("0.1.7", "^0.1")).toBe(true)
        expect(satisfies("0.2.0", "^0.1")).toBe(false)
        expect(satisfies("0.0.9", "^0.1")).toBe(false)
        // A pre-release host is judged as its release: a pilot of 0.2.0 carries 0.2's plugin API.
        expect(satisfies("0.2.0-pilot.1", "^0.2")).toBe(true)
        expect(satisfies("0.2.0-pilot.1", "^0.1")).toBe(false)
        expect(satisfies("0.2.0-", "^0.2")).toBe(undefined)
        // A pre-release in the *range* is still refused rather than approximated.
        expect(satisfies("0.2.0", "^0.2.0-pilot.1")).toBe(undefined)
    })

    test("1.x allows the whole major", () => {
        expect(satisfies("1.9.9", "^1.2.3")).toBe(true)
        expect(satisfies("1.2.2", "^1.2.3")).toBe(false)
        expect(satisfies("2.0.0", "^1.2.3")).toBe(false)
    })

    test("^0.0.x is pinned to the patch", () => {
        expect(satisfies("0.0.3", "^0.0.3")).toBe(true)
        expect(satisfies("0.0.4", "^0.0.3")).toBe(false)
    })
})

describe("the other forms", () => {
    test("any", () => {
        expect(satisfies("1.2.3", "*")).toBe(true)
        expect(satisfies("0.0.1", "x")).toBe(true)
    })

    test("tilde holds the minor, unless there is no minor to hold", () => {
        expect(satisfies("1.2.9", "~1.2.3")).toBe(true)
        expect(satisfies("1.3.0", "~1.2.3")).toBe(false)
        expect(satisfies("1.9.0", "~1")).toBe(true)
        expect(satisfies("2.0.0", "~1")).toBe(false)
    })

    test("comparators are ANDed, alternatives are ORed", () => {
        expect(satisfies("1.5.0", ">=1.2 <2.0")).toBe(true)
        expect(satisfies("2.0.0", ">=1.2 <2.0")).toBe(false)
        expect(satisfies("2.1.0", "^1 || ^2")).toBe(true)
        expect(satisfies("3.0.0", "^1 || ^2")).toBe(false)
    })

    test("a partial exact is a prefix match", () => {
        // `=1.2` means every 1.2.x. Reading it as exactly 1.2.0 would refuse the patch releases the
        // author was asking for.
        expect(satisfies("1.2.9", "1.2")).toBe(true)
        expect(satisfies("1.3.0", "1.2")).toBe(false)
        expect(satisfies("1.2.3", "1.2.3")).toBe(true)
        expect(satisfies("1.2.4", "1.2.3")).toBe(false)
    })
})

describe("what it refuses to decide", () => {
    // Each of these is a range this file does not implement. `undefined` makes the loader refuse and
    // name the range; `false` would blame the host version instead, which is the wrong fix to go and
    // look for.
    test("unsupported syntax is undecided, not unsatisfied", () => {
        expect(satisfies("1.2.3", "1.x")).toBeUndefined()
        expect(satisfies("1.2.3", "1.2.3 - 2.0.0")).toBeUndefined()
        expect(satisfies("1.2.3", "^1.0.0-beta.1")).toBeUndefined()
        expect(satisfies("1.2.3", "")).toBeUndefined()
        expect(satisfies("1.2.3", "not a range")).toBeUndefined()
    })

    test("a host version that is not a triple, or a triple with a pre-release, is undecided otherwise", () => {
        expect(satisfies("1.2", "^1")).toBeUndefined()
        expect(satisfies("1.2.3+build", "^1")).toBeUndefined()
        // Since the first pilot tag a pre-release host is judged as its release (see above).
        expect(satisfies("1.2.3-rc.1", "^1")).toBe(true)
    })
})

test("parseVersion accepts exactly a plain triple", () => {
    expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 })
    expect(parseVersion("1.2")).toBeUndefined()
    expect(parseVersion("v1.2.3")).toBeUndefined()
})
