/**
 * The SSRF address classifier, tested where it lives.
 *
 * These cases moved verbatim from `packages/tools-web/test/web.test.ts`
 * ("address classification"), which kept them after the classifier itself moved
 * into core. The tools-web suite still covers the guard: DNS answers, refusals,
 * and bytes read. What stays here is pure classification, so it also runs under
 * `bun run test:node`, the Node runner the shipped binary uses.
 *
 * The one addition beyond the move is the final test, which calls `classifyIPv4`
 * and `classifyIPv6` directly: the moved cases reach them only through
 * `classifyAddress`, and both are named in the issue as untested in core.
 */

import {
    classifyAddress,
    classifyIPv4,
    classifyIPv6,
    parseIPv4,
    parseIPv6,
} from "../src/net/address.ts"
import { describe, expect, test } from "./_harness.ts"

describe("address classification", () => {
    test("the ranges that must never be fetched", () => {
        const cases: readonly [string, string][] = [
            ["127.0.0.1", "loopback"],
            ["127.1.2.3", "loopback"],
            ["0.0.0.0", "unspecified"],
            ["10.0.4.7", "private"],
            ["172.16.0.1", "private"],
            ["172.31.255.255", "private"],
            ["192.168.1.1", "private"],
            ["100.64.0.1", "cgnat"],
            ["169.254.169.254", "link-local"],
            ["224.0.0.1", "multicast"],
            ["255.255.255.255", "reserved"],
            ["::1", "loopback"],
            ["fd00::1", "private"],
            ["fe80::1", "link-local"],
            ["::", "unspecified"],
        ]
        for (const [address, kind] of cases) {
            expect(`${address} → ${classifyAddress(address)?.kind}`).toBe(`${address} → ${kind}`)
        }
    })

    test("public addresses stay public", () => {
        for (const address of [
            "1.1.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "192.169.0.1",
            "2606:4700::1111",
        ]) {
            expect(`${address} → ${classifyAddress(address)?.kind}`).toBe(`${address} → public`)
        }
    })

    test("loopback wearing an IPv6 hat is still loopback", () => {
        // The two encodings a dual-stack resolver and a NAT64 translator produce. A checker that only
        // understands dotted quads has a documented bypass, and these are it.
        expect(classifyAddress("::ffff:127.0.0.1")?.kind).toBe("loopback")
        expect(classifyAddress("::ffff:169.254.169.254")?.kind).toBe("link-local")
        expect(classifyAddress("64:ff9b::7f00:1")?.kind).toBe("loopback")
        expect(classifyAddress("[::ffff:10.0.0.1]")?.kind).toBe("private")
    })

    test("a zone id does not hide a link-local address", () => {
        expect(classifyAddress("fe80::1%eth0")?.kind).toBe("link-local")
    })

    test("only one spelling of an IPv4 literal is accepted", () => {
        // `0x7f.1` and `017.0.0.1` are legal to inet_aton and are exactly how a checker gets walked
        // past. Rejected as literals, they fall through to DNS and are classified on the answer.
        expect(parseIPv4("127.0.0.1")).toEqual([127, 0, 0, 1])
        expect(parseIPv4("017.0.0.1")).toBeUndefined()
        expect(parseIPv4("0x7f.0.0.1")).toBeUndefined()
        expect(parseIPv4("127.1")).toBeUndefined()
        expect(parseIPv4("256.0.0.1")).toBeUndefined()
    })

    test("IPv6 compression expands to sixteen bytes", () => {
        expect(parseIPv6("::1")?.length).toBe(16)
        expect(parseIPv6("2001:db8::")?.length).toBe(16)
        expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeUndefined()
        expect(parseIPv6("::1::2")).toBeUndefined()
    })

    test("a hostname is not an address", () => {
        expect(classifyAddress("example.com")).toBeUndefined()
    })

    test("the octet and byte classifiers agree with the string classifier", () => {
        expect(classifyIPv4([169, 254, 169, 254]).kind).toBe("link-local")
        expect(classifyIPv4([8, 8, 8, 8]).kind).toBe("public")
        expect(classifyIPv6([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]).kind).toBe(
            "loopback",
        )
        expect(classifyIPv6([1, 2, 3]).kind).toBe("reserved")
    })
})
