/**
 * Just enough semver to answer one question: does this host satisfy a plugin's declared range?
 *
 * Hand-written because core depends on the standard library, a YAML parser and a schema validator,
 * and nothing else (hard rule 2's sibling). A range check is the smallest possible reason to break
 * that, and the subset a `dispachApi` field actually contains is small.
 *
 * **An unparseable range is refused, never assumed satisfied.** That is the entire safety property
 * here. A range this file does not understand means the check could not be performed, and a version
 * gate that silently passes when it cannot decide is worse than no gate at all: decision 7.6 exists
 * because a config rolling back quietly on version skew surfaces as a missing capability somewhere
 * else entirely, with nothing pointing back at the cause. Refusing is loud, names the range, and is
 * fixable in one edit.
 *
 * Supported, which is every form a real `dispachApi` uses:
 *
 *     *  x  X          any version
 *     1.2.3            exact
 *     ^1.2.3  ^0.1     caret — the compatible range, 0.x pinned to its minor
 *     ~1.2.3  ~1.2     tilde — patch-level within a minor
 *     >=1.2  <2.0      comparators, space-separated, all must hold
 *     ^1 || ^2         alternatives, any may hold
 *
 * Not supported, and therefore refused rather than approximated: pre-release identifiers, build
 * metadata, hyphen ranges, and `x` inside a partial version (`1.x`). Each is a small amount of code
 * and an opportunity to be subtly wrong about which versions match, which is the one thing this file
 * must not be.
 */

interface Version {
    readonly major: number
    readonly minor: number
    readonly patch: number
}

const EXACT = /^(\d+)\.(\d+)\.(\d+)$/
/** A version that may omit minor and patch, as every range operator permits. */
const PARTIAL = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

export function parseVersion(raw: string): Version | undefined {
    const match = EXACT.exec(raw.trim())
    if (match === null) return undefined
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function parsePartial(raw: string): { version: Version; specified: 1 | 2 | 3 } | undefined {
    const match = PARTIAL.exec(raw.trim())
    if (match === null) return undefined
    const [, major, minor, patch] = match
    return {
        version: { major: Number(major), minor: Number(minor ?? 0), patch: Number(patch ?? 0) },
        specified: patch !== undefined ? 3 : minor !== undefined ? 2 : 1,
    }
}

function compare(a: Version, b: Version): number {
    if (a.major !== b.major) return a.major - b.major
    if (a.minor !== b.minor) return a.minor - b.minor
    return a.patch - b.patch
}

/** `^1.2.3` → `>=1.2.3 <2.0.0`; `^0.1.2` → `>=0.1.2 <0.2.0`; `^0.0.3` → `>=0.0.3 <0.0.4`. */
function caretUpper(version: Version): Version {
    if (version.major !== 0) return { major: version.major + 1, minor: 0, patch: 0 }
    if (version.minor !== 0) return { major: 0, minor: version.minor + 1, patch: 0 }
    return { major: 0, minor: 0, patch: version.patch + 1 }
}

/** `~1.2.3` → `>=1.2.3 <1.3.0`. `~1` → `>=1.0.0 <2.0.0`, since there is no minor to hold fixed. */
function tildeUpper(version: Version, specified: 1 | 2 | 3): Version {
    if (specified === 1) return { major: version.major + 1, minor: 0, patch: 0 }
    return { major: version.major, minor: version.minor + 1, patch: 0 }
}

/** One space-separated term. `undefined` means "this file cannot decide", never "no match". */
function satisfiesTerm(version: Version, term: string): boolean | undefined {
    if (term === "*" || term === "x" || term === "X") return true

    const operator = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(term)
    if (operator === null) return undefined
    const parsed = parsePartial(operator[2] ?? "")
    if (parsed === undefined) return undefined
    const { version: bound, specified } = parsed

    switch (operator[1]) {
        case "^":
            return compare(version, bound) >= 0 && compare(version, caretUpper(bound)) < 0
        case "~":
            return (
                compare(version, bound) >= 0 && compare(version, tildeUpper(bound, specified)) < 0
            )
        case ">=":
            return compare(version, bound) >= 0
        case "<=":
            return compare(version, bound) <= 0
        case ">":
            return compare(version, bound) > 0
        case "<":
            return compare(version, bound) < 0
        default:
            // Bare or `=`. A partial is a prefix match — `=1.2` accepts every 1.2.x — which is what
            // somebody writing a two-part version means, and treating it as `1.2.0` exactly would
            // refuse the patch releases they were asking for.
            if (specified === 3) return compare(version, bound) === 0
            if (specified === 2)
                return version.major === bound.major && version.minor === bound.minor
            return version.major === bound.major
    }
}

/**
 * Does `version` satisfy `range`?
 *
 * `undefined` is the third answer and the important one: the range could not be parsed, so no claim
 * is made either way and the caller refuses. Returning `false` there would be a lie — it would report
 * a version mismatch for what is really a malformed declaration, and send whoever reads it looking at
 * the wrong number.
 */
export function satisfies(version: string, range: string): boolean | undefined {
    const parsed = parseVersion(version)
    if (parsed === undefined) return undefined

    const alternatives = range.split("||")
    let decided = false
    for (const alternative of alternatives) {
        const terms = alternative
            .trim()
            .split(/\s+/)
            .filter((term) => term !== "")
        if (terms.length === 0) return undefined

        let all = true
        for (const term of terms) {
            const result = satisfiesTerm(parsed, term)
            if (result === undefined) return undefined
            if (!result) all = false
        }
        decided = true
        if (all) return true
    }
    return decided ? false : undefined
}
