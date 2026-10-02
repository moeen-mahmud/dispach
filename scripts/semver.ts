/**
 * The subset of semver `release.ts` needs: `X.Y.Z`, optionally `-<pre-release>` (`0.2.0-pilot.1`).
 *
 * A pre-release sorts **below** its release, and its identifiers compare left to right, numbers
 * numerically and below words — the semver precedence rules, so `pilot.2` follows `pilot.1` and
 * `0.2.0` follows every `0.2.0-*`. Build metadata (`+…`) is refused rather than half-handled: npm
 * ignores it for ordering, so two versions differing only there would collide at publish.
 */

export interface Version {
    readonly core: readonly [number, number, number]
    readonly pre: readonly string[]
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseVersion(text: string): Version | undefined {
    const match = VERSION.exec(text)
    if (match === null) return undefined
    return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4] === undefined ? [] : match[4].split("."),
    }
}

export function isPrerelease(version: Version): boolean {
    return version.pre.length > 0
}

/** Negative, zero or positive, as `a` sorts before, with, or after `b`. */
export function compareVersions(a: Version, b: Version): number {
    for (let i = 0; i < 3; i += 1) {
        const d = (a.core[i] ?? 0) - (b.core[i] ?? 0)
        if (d !== 0) return d
    }
    // A release outranks any of its pre-releases.
    if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
        const x = a.pre[i]
        const y = b.pre[i]
        if (x === undefined) return -1
        if (y === undefined) return 1
        const xn = /^\d+$/.test(x)
        const yn = /^\d+$/.test(y)
        if (xn && yn) {
            const d = Number(x) - Number(y)
            if (d !== 0) return d
        } else if (xn !== yn) {
            return xn ? -1 : 1
        } else if (x !== y) {
            return x < y ? -1 : 1
        }
    }
    return 0
}
