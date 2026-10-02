/**
 * Which IP addresses are off the public internet.
 *
 * Pure, exhaustively testable, and deliberately separate from anything that makes a request. The
 * whole SSRF story rests on this file being right, and a function that also opens sockets cannot be
 * tested against three hundred addresses in a millisecond.
 *
 * **Two users, one classifier.** It lives in core because both `web_fetch` (in `tools-web`) and
 * outbound webhooks (in core) need it, and core may import nothing from a sibling package. What each
 * user *does* with a verdict is its own decision, and the two decide differently on purpose: the
 * model chooses a `web_fetch` URL, so nothing private is ever reachable there, while an operator
 * chooses a webhook URL and may allow a private receiver (never a link-local one).
 *
 * **Refused rather than configured away.** There is no allowlist setting that lets `web_fetch` reach
 * `169.254.169.254`. A manifest field able to permit the cloud metadata endpoint is a manifest field
 * whose only real use is permitting the cloud metadata endpoint — the agent has no business there,
 * and an operator who genuinely wants an internal HTTP call has `exec` and `curl`, which is a
 * decision they make explicitly rather than one this tool makes quietly on their behalf.
 *
 * **IPv6 is not an afterthought.** `::ffff:127.0.0.1` and `64:ff9b::7f00:1` are loopback wearing a
 * different hat, and a checker that only understands dotted quads is a checker with a documented
 * bypass. Both forms decode to their embedded IPv4 and are classified as that address.
 */

/** Why an address is not reachable. The tool quotes this, so each one names a real category. */
export type AddressKind =
    | "public"
    | "loopback"
    | "link-local"
    | "private"
    | "cgnat"
    | "unspecified"
    | "multicast"
    | "reserved"

export interface AddressVerdict {
    readonly kind: AddressKind
    /** Set for everything but `public`: the range that matched, for the refusal message. */
    readonly range?: string
}

const PUBLIC: AddressVerdict = { kind: "public" }

/** Parse a dotted quad into four octets. Strict: no octal, no shorthand, no trailing text. */
export function parseIPv4(value: string): readonly number[] | undefined {
    const parts = value.split(".")
    if (parts.length !== 4) return undefined
    const octets: number[] = []
    for (const part of parts) {
        // `0x7f` and `017` are both legal to inet_aton and neither is legal here. A parser that
        // accepts more forms than the checker understands is the bypass, so this accepts the one
        // form and everything else falls through to "not an IPv4 literal" — which then goes to DNS
        // and gets classified on whatever it resolves to.
        if (part.length === 0 || part.length > 3 || !/^[0-9]+$/.test(part)) return undefined
        if (part.length > 1 && part.startsWith("0")) return undefined
        const octet = Number(part)
        if (octet > 255) return undefined
        octets.push(octet)
    }
    return octets
}

/**
 * Parse an IPv6 literal into sixteen bytes.
 *
 * Handles `::` compression and a trailing embedded IPv4 (`::ffff:127.0.0.1`). A zone id (`%eth0`)
 * is stripped first: it selects an interface, which by definition means the address is not a public
 * destination, and the address in front of it classifies on its own merits anyway.
 */
export function parseIPv6(value: string): readonly number[] | undefined {
    const address = value.split("%")[0] ?? ""
    if (address === "") return undefined
    if (!/^[0-9a-fA-F:.]+$/.test(address)) return undefined

    const halves = address.split("::")
    if (halves.length > 2) return undefined

    const expand = (part: string): number[] | undefined => {
        if (part === "") return []
        const groups = part.split(":")
        const bytes: number[] = []
        for (let index = 0; index < groups.length; index += 1) {
            const group = groups[index] ?? ""
            if (group.includes(".")) {
                // Only legal as the final group, and only as a full dotted quad.
                if (index !== groups.length - 1) return undefined
                const quad = parseIPv4(group)
                if (quad === undefined) return undefined
                bytes.push(...quad)
                continue
            }
            if (group.length === 0 || group.length > 4) return undefined
            const word = Number.parseInt(group, 16)
            if (Number.isNaN(word)) return undefined
            bytes.push((word >> 8) & 0xff, word & 0xff)
        }
        return bytes
    }

    if (halves.length === 1) {
        const bytes = expand(address)
        return bytes !== undefined && bytes.length === 16 ? bytes : undefined
    }

    const head = expand(halves[0] ?? "")
    const tail = expand(halves[1] ?? "")
    if (head === undefined || tail === undefined) return undefined
    const gap = 16 - head.length - tail.length
    if (gap < 0) return undefined
    return [...head, ...new Array<number>(gap).fill(0), ...tail]
}

/** Classify a dotted quad. */
export function classifyIPv4(octets: readonly number[]): AddressVerdict {
    const [a = 0, b = 0, c = 0, d = 0] = octets
    if (a === 0) return { kind: "unspecified", range: "0.0.0.0/8" }
    if (a === 127) return { kind: "loopback", range: "127.0.0.0/8" }
    if (a === 10) return { kind: "private", range: "10.0.0.0/8" }
    if (a === 172 && b >= 16 && b <= 31) return { kind: "private", range: "172.16.0.0/12" }
    if (a === 192 && b === 168) return { kind: "private", range: "192.168.0.0/16" }
    if (a === 100 && b >= 64 && b <= 127) return { kind: "cgnat", range: "100.64.0.0/10" }
    // The cloud metadata endpoint lives here — 169.254.169.254 on AWS, GCP and Azure alike. It is
    // the single highest-value SSRF target in existence and it is inside link-local, so the range
    // check covers it without needing a special case that could be edited away on its own.
    if (a === 169 && b === 254) return { kind: "link-local", range: "169.254.0.0/16" }
    if (a === 192 && b === 0 && c === 0) return { kind: "reserved", range: "192.0.0.0/24" }
    if (a === 192 && b === 0 && c === 2)
        return { kind: "reserved", range: "192.0.2.0/24 (TEST-NET-1)" }
    if (a === 198 && (b === 18 || b === 19)) return { kind: "reserved", range: "198.18.0.0/15" }
    if (a === 198 && b === 51 && c === 100) {
        return { kind: "reserved", range: "198.51.100.0/24 (TEST-NET-2)" }
    }
    if (a === 203 && b === 0 && c === 113) {
        return { kind: "reserved", range: "203.0.113.0/24 (TEST-NET-3)" }
    }
    if (a >= 224 && a <= 239) return { kind: "multicast", range: "224.0.0.0/4" }
    if (a === 255 && b === 255 && c === 255 && d === 255) {
        return { kind: "reserved", range: "255.255.255.255" }
    }
    if (a >= 240) return { kind: "reserved", range: "240.0.0.0/4" }
    return PUBLIC
}

/** Classify sixteen bytes, decoding the two v4-in-v6 encodings first. */
export function classifyIPv6(bytes: readonly number[]): AddressVerdict {
    if (bytes.length !== 16) return { kind: "reserved", range: "unparseable" }

    // ::ffff:a.b.c.d — the form every dual-stack resolver hands back for an IPv4 host.
    const mapped =
        bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    if (mapped) return classifyIPv4(bytes.slice(12))

    // 64:ff9b::/96 — NAT64. A synthesised address whose bottom four bytes are the real destination,
    // so `64:ff9b::7f00:1` is a request to 127.0.0.1 through a translator.
    const nat64 =
        bytes[0] === 0x00 &&
        bytes[1] === 0x64 &&
        bytes[2] === 0xff &&
        bytes[3] === 0x9b &&
        bytes.slice(4, 12).every((byte) => byte === 0)
    if (nat64) return classifyIPv4(bytes.slice(12))

    if (bytes.every((byte) => byte === 0)) return { kind: "unspecified", range: "::" }
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
        return { kind: "loopback", range: "::1" }
    }

    const first = bytes[0] ?? 0
    const second = bytes[1] ?? 0
    if ((first & 0xfe) === 0xfc) return { kind: "private", range: "fc00::/7" }
    if (first === 0xfe && (second & 0xc0) === 0x80)
        return { kind: "link-local", range: "fe80::/10" }
    if (first === 0xff) return { kind: "multicast", range: "ff00::/8" }
    if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
        return { kind: "reserved", range: "2001:db8::/32" }
    }
    return PUBLIC
}

/**
 * Classify any address literal. Returns `undefined` when the string is not an IP at all — that is a
 * hostname, and the caller resolves it before asking again.
 */
export function classifyAddress(value: string): AddressVerdict | undefined {
    const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
    const quad = parseIPv4(bare)
    if (quad !== undefined) return classifyIPv4(quad)
    const bytes = parseIPv6(bare)
    if (bytes !== undefined) return classifyIPv6(bytes)
    return undefined
}
