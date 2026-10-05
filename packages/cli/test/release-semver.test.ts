/**
 * The release script's version ordering. A pre-release that sorted above its release would let
 * `bun run release 0.2.0` be refused as "not newer" after a pilot tag — or, the other way round,
 * let a pilot tag republish over a release.
 */

import { describe, expect, test } from "bun:test"
import { compareVersions, isPrerelease, parseVersion } from "../../../scripts/semver.ts"

const v = (text: string) => {
    const parsed = parseVersion(text)
    if (parsed === undefined) throw new Error(`unparsed ${text}`)
    return parsed
}

describe("release versions", () => {
    test("pre-releases sort below their release and in identifier order", () => {
        const ordered = [
            "0.1.3",
            "0.2.0-pilot.1",
            "0.2.0-pilot.2",
            "0.2.0-pilot.10",
            "0.2.0-rc.1",
            "0.2.0",
            "0.2.1",
        ]
        const shuffled = [...ordered].reverse()
        expect(shuffled.sort((a, b) => compareVersions(v(a), v(b)))).toEqual(ordered)
    })

    test("only X.Y.Z with an optional pre-release parses", () => {
        expect(isPrerelease(v("0.2.0-pilot.1"))).toBe(true)
        expect(isPrerelease(v("0.2.0"))).toBe(false)
        for (const bad of ["0.2", "v0.2.0", "0.2.0+build.1", "0.2.0-", "0.2.0-pilot..1"]) {
            expect(parseVersion(bad)).toBeUndefined()
        }
    })
})
