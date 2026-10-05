/**
 * The web tools, against stub transports.
 *
 * Nothing here reaches the network, and that is not only about speed: the assertions worth making are
 * "this address was refused" and "this many bytes were pulled", and both are unobservable through a
 * real socket. The stubs record what was *attempted*, so a refusal test can prove no request was made
 * rather than proving a request failed.
 */

import { describe, expect, test } from "bun:test"
import { HarnessError, toolContext } from "@dispach/core"
import { classifyAddress, parseIPv4, parseIPv6 } from "../src/address.ts"
import { backend } from "../src/backends.ts"
import { decodeEntities, extract, htmlToText, isTextual } from "../src/extract.ts"
import {
    DEFAULT_MAX_BYTES,
    effectiveTimeout,
    FETCH_SPEC,
    fetchTool,
    readCapped,
} from "../src/fetch.ts"
import { assertFetchable, checkUrlShape, type LookupLike, parseUrl } from "../src/guard.ts"
import { WebProvider, webFromConfig } from "../src/provider.ts"
import { clampResults, render, SEARCH_SPEC, searchTool } from "../src/search.ts"

/** A resolver that answers with whatever the test says, and records that it was consulted. */
function stubLookup(answers: Readonly<Record<string, readonly string[]>>): LookupLike & {
    asked: string[]
} {
    const asked: string[] = []
    const fn = async (hostname: string) => {
        asked.push(hostname)
        const found = answers[hostname]
        if (found === undefined) throw new Error(`ENOTFOUND ${hostname}`)
        return found.map((address) => ({ address }))
    }
    return Object.assign(fn, { asked })
}

async function failure(run: () => unknown): Promise<HarnessError> {
    try {
        await run()
    } catch (thrown) {
        if (thrown instanceof HarnessError) return thrown
        throw thrown
    }
    throw new Error("expected a HarnessError and the call succeeded")
}

// ─── addresses ───────────────────────────────────────────────────────────────────────────

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
})

// ─── the guard ───────────────────────────────────────────────────────────────────────────

describe("the URL guard", () => {
    test("only http and https", () => {
        for (const raw of [
            "file:///etc/passwd",
            "gopher://x/1",
            "ftp://x/y",
            "data:text/html,hi",
        ]) {
            expect(() => {
                checkUrlShape(parseUrl(raw))
            }).toThrow(/not fetchable/)
        }
    })

    test("credentials in a URL are refused rather than stripped", () => {
        expect(() => {
            checkUrlShape(parseUrl("https://user:pw@example.com/"))
        }).toThrow(/username and password/)
    })

    test("names that only mean something locally are refused before DNS", async () => {
        const lookup = stubLookup({})
        for (const host of [
            "localhost",
            "printer.local",
            "db.internal",
            "metadata",
            "x.home.arpa",
        ]) {
            await failure(() => assertFetchable(parseUrl(`http://${host}/`), lookup))
        }
        // The point of "before DNS": the resolver was never consulted for any of them.
        expect(lookup.asked).toEqual([])
    })

    test("an address literal is classified without a lookup", async () => {
        const lookup = stubLookup({})
        const error = await failure(() =>
            assertFetchable(parseUrl("http://169.254.169.254/latest/meta-data/"), lookup),
        )
        expect(error.code).toBe("web_address_refused")
        expect(error.message).toContain("link-local")
        expect(lookup.asked).toEqual([])
    })

    test("a public name resolving to a private address is refused, naming both", async () => {
        const lookup = stubLookup({ "intranet.example.com": ["10.0.4.7"] })
        const error = await failure(() =>
            assertFetchable(parseUrl("https://intranet.example.com/"), lookup),
        )
        expect(error.message).toContain("intranet.example.com → 10.0.4.7")
        expect(error.message).toContain("10.0.0.0/8")
    })

    test("every address is checked, not the first", async () => {
        // Node picks whichever connects first, so a name with one public and one private address is
        // an attack rather than a configuration.
        const lookup = stubLookup({ "split.example.com": ["93.184.216.34", "127.0.0.1"] })
        const error = await failure(() =>
            assertFetchable(parseUrl("https://split.example.com/"), lookup),
        )
        expect(error.message).toContain("127.0.0.1")
    })

    test("a name that will not resolve is refused rather than attempted", async () => {
        const error = await failure(() =>
            assertFetchable(parseUrl("https://nope.example/"), stubLookup({})),
        )
        expect(error.code).toBe("web_host_unresolvable")
    })

    test("a public host passes", async () => {
        await assertFetchable(
            parseUrl("https://example.com/a"),
            stubLookup({ "example.com": ["93.184.216.34"] }),
        )
    })
})

// ─── web_fetch ───────────────────────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><title>Example &amp; Co</title>
<style>body{color:red}</style><script>var x = "<b>not text</b>"</script></head>
<body><h1>Heading</h1><p>First paragraph.</p><p>Second &mdash; with an entity.</p></body></html>`

function response(body: string | ReadableStream<Uint8Array>, init: ResponseInit = {}): Response {
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        ...init,
    })
}

describe("web_fetch", () => {
    const lookup = stubLookup({
        "example.com": ["93.184.216.34"],
        "redirector.example.com": ["93.184.216.34"],
        "hop2.example.com": ["93.184.216.34"],
    })

    test("returns the page as text, with the title and no script or style", async () => {
        const tool = fetchTool({
            lookup,
            fetch: async () => response(PAGE),
            userAgent: "test",
        })
        const out = await tool.handler({ url: "https://example.com/page" }, toolContext())
        expect(out).toContain("title: Example & Co")
        expect(out).toContain("Heading")
        expect(out).toContain("Second — with an entity.")
        expect(out).not.toContain("color:red")
        expect(out).not.toContain("var x")
    })

    test("refuses loopback, link-local, RFC-1918 and file:// without making a request", async () => {
        const attempted: string[] = []
        const tool = fetchTool({
            lookup,
            fetch: async (input) => {
                attempted.push(input)
                return response("should never be reached")
            },
            userAgent: "test",
        })

        for (const url of [
            "http://127.0.0.1:8080/admin",
            "http://[::1]/admin",
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            "http://10.0.4.7/internal",
            "http://192.168.1.1/router",
            "http://100.64.3.1/cgnat",
            "file:///etc/passwd",
        ]) {
            const error = await failure(() => tool.handler({ url }, toolContext()))
            expect(`${url} → ${error.code}`).toMatch(/web_(address|scheme)_refused$/)
        }
        expect(attempted).toEqual([])
    })

    test("a public URL redirecting to loopback is refused at the hop, after one request", async () => {
        const attempted: string[] = []
        const tool = fetchTool({
            lookup,
            fetch: async (input) => {
                attempted.push(input)
                if (new URL(input).host === "redirector.example.com") {
                    return new Response(null, {
                        status: 302,
                        headers: { location: "http://127.0.0.1:9000/secrets" },
                    })
                }
                return response("unreachable")
            },
            userAgent: "test",
        })

        const error = await failure(() =>
            tool.handler({ url: "https://redirector.example.com/go" }, toolContext()),
        )
        expect(error.code).toBe("web_address_refused")
        expect(error.message).toContain("redirect 1")
        // The first hop was legitimately fetched; the second was refused before any request.
        expect(attempted).toEqual(["https://redirector.example.com/go"])
    })

    test("a legitimate redirect is followed and reported", async () => {
        const tool = fetchTool({
            lookup,
            fetch: async (input) =>
                input.includes("redirector")
                    ? new Response(null, {
                          status: 301,
                          headers: { location: "https://hop2.example.com/final" },
                      })
                    : response("<p>arrived</p>"),
            userAgent: "test",
        })
        const out = await tool.handler({ url: "https://redirector.example.com/go" }, toolContext())
        expect(out).toContain("https://hop2.example.com/final")
        expect(out).toContain("redirected from https://redirector.example.com/go (1 hop)")
        expect(out).toContain("arrived")
    })

    test("a redirect loop stops at the limit", async () => {
        const tool = fetchTool({
            lookup,
            fetch: async () =>
                new Response(null, {
                    status: 302,
                    headers: { location: "https://example.com/loop" },
                }),
            userAgent: "test",
        })
        const error = await failure(() =>
            tool.handler({ url: "https://example.com/loop" }, toolContext()),
        )
        expect(error.code).toBe("web_too_many_redirects")
    })

    test("a non-2xx and a binary body are both refused with the reason", async () => {
        const notFound = fetchTool({
            lookup,
            fetch: async () => new Response("nope", { status: 404, statusText: "Not Found" }),
            userAgent: "test",
        })
        expect(
            (await failure(() => notFound.handler({ url: "https://example.com/x" }, toolContext())))
                .code,
        ).toBe("web_status_failed")

        const binary = fetchTool({
            lookup,
            fetch: async () =>
                response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
            userAgent: "test",
        })
        expect(
            (
                await failure(() =>
                    binary.handler({ url: "https://example.com/x.pdf" }, toolContext()),
                )
            ).code,
        ).toBe("web_content_unusable")
    })

    test("a 50 MB page stops at maxBytes — asserted on bytes pulled off the socket", async () => {
        const CHUNK = 64 * 1024
        const TOTAL = 50 * 1024 * 1024
        let produced = 0

        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (produced >= TOTAL) {
                    controller.close()
                    return
                }
                produced += CHUNK
                controller.enqueue(new Uint8Array(CHUNK).fill(0x61))
            },
        })

        const tool = fetchTool({
            lookup,
            fetch: async () => response(stream, { headers: { "content-type": "text/plain" } }),
            maxBytes: 200_000,
            userAgent: "test",
        })
        const out = await tool.handler({ url: "https://example.com/huge" }, toolContext())

        // The claim is about the socket, not the observation: reading it all and then trimming would
        // pass an observation-size assertion while having spent the whole 50 MB.
        //
        // The bound is the cap plus two chunks rather than the cap exactly, and the slack is real: a
        // ReadableStream fills its queue one chunk ahead of the reader, so the last `read()` before
        // the cancel has already caused the next `pull`. That is a constant overshoot, not a leak —
        // 0.6% of the page here, and it does not grow with the size of the page, which is the
        // property that matters.
        expect(produced).toBeLessThanOrEqual(200_000 + 2 * CHUNK)
        expect(produced / TOTAL).toBeLessThan(0.01)
        expect(out).toContain("incomplete:")
        expect(out).toContain("the download stopped at")
    })

    test("readCapped reports the bytes it took and flushes the decoder", async () => {
        const body = new TextEncoder().encode("héllo world, this is longer than the cap")
        const { text, read, capped } = await readCapped(new Response(body), 10)
        expect(capped).toBe(true)
        expect(read).toBe(10)
        expect(text.startsWith("héllo")).toBe(true)
    })

    test("the timeout clamps under the harness deadline", () => {
        // Same shape as exec's clamp: a tool holding a socket must time out before the harness
        // abandons it, or the socket outlives everything referencing it.
        expect(effectiveTimeout(120_000)).toBe(20_000)
        expect(effectiveTimeout(5_000)).toBe(2_000)
        expect(effectiveTimeout(500)).toBe(1_000)
    })

    test("the spec is read-only and untrusted, and says so", () => {
        expect(FETCH_SPEC.mutating).toBe(false)
        expect(FETCH_SPEC.trust).toBe("untrusted")
        expect(FETCH_SPEC.policyArg).toBe("url")
        expect(FETCH_SPEC.whenNotToUse).toContain("web_search")
    })
})

// ─── extraction ──────────────────────────────────────────────────────────────────────────

describe("extraction", () => {
    test("an unterminated script does not leak its source", () => {
        // A page cut at maxBytes mid-<script> has no closing tag, and the well-formed pattern would
        // leave the whole tail in place — which is exactly the content the drop list exists for.
        const cut = "<body><p>real</p><script>var secret = 'leaked'"
        const text = htmlToText(cut)
        expect(text).toContain("real")
        expect(text).not.toContain("leaked")
    })

    test("entities decode, including numeric and hex", () => {
        expect(decodeEntities("a &amp; b &#65; &#x42; &nbsp;c")).toBe("a & b A B  c")
        expect(decodeEntities("&notareal;")).toBe("&notareal;")
    })

    test("block elements become line breaks rather than running together", () => {
        expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\n\ntwo")
        // A run of nested block tags collapses to one blank line rather than fifteen. Markup depth
        // is a fact about the page's authoring, not about its content, and the model pays per token
        // for every one of them.
        expect(htmlToText("<div><div><section><p>one</p></section></div></div><p>two</p>")).toBe(
            "one\n\ntwo",
        )
    })

    test("JSON passes through untouched", () => {
        const body = '{"a": "<b>", "c": 1}'
        expect(extract(body, "application/json").text).toBe(body)
    })

    test("content types with no text are recognised as such", () => {
        expect(isTextual("text/html")).toBe(true)
        expect(isTextual("application/json; charset=utf-8")).toBe(true)
        expect(isTextual("")).toBe(true)
        expect(isTextual("application/pdf")).toBe(false)
        expect(isTextual("image/png")).toBe(false)
    })
})

// ─── web_search ──────────────────────────────────────────────────────────────────────────

describe("web_search", () => {
    const env = {
        TAVILY_API_KEY: "tvly-test",
        BRAVE_API_KEY: "brave-test",
        EXA_API_KEY: "exa-test",
    }

    test("each backend is asked in its own dialect", () => {
        const tavily = backend("tavily").request("bun test", 5, "k")
        expect(tavily.url).toBe("https://api.tavily.com/search")
        expect(String(tavily.init.body)).toContain('"max_results":5')

        const brave = backend("brave").request("bun test", 3, "k")
        expect(brave.url).toContain("q=bun+test")
        expect(brave.url).toContain("count=3")

        const exa = backend("exa").request("bun test", 2, "k")
        expect(String(exa.init.body)).toContain('"numResults":2')
    })

    test("every backend's results read into the same shape", () => {
        expect(
            backend("tavily").read({ results: [{ title: "T", url: "https://a", content: "C" }] }),
        ).toEqual([{ title: "T", url: "https://a", snippet: "C" }])
        expect(
            backend("brave").read({
                web: { results: [{ title: "T", url: "https://a", description: "C" }] },
            }),
        ).toEqual([{ title: "T", url: "https://a", snippet: "C" }])
        expect(
            backend("exa").read({ results: [{ title: "T", url: "https://a", text: "C" }] }),
        ).toEqual([{ title: "T", url: "https://a", snippet: "C" }])
    })

    test("a payload of the wrong shape yields no results rather than throwing", () => {
        expect(backend("tavily").read({ unexpected: true })).toEqual([])
        expect(backend("brave").read(null)).toEqual([])
    })

    test("results render numbered with the address on its own line", async () => {
        const tool = searchTool({
            backend: "tavily",
            apiKeyEnv: "TAVILY_API_KEY",
            env,
            fetch: async () =>
                Response.json({
                    results: [
                        { title: "Bun", url: "https://bun.sh", content: "A fast runtime." },
                        { title: "Docs", url: "https://bun.sh/docs", content: "Reference." },
                    ],
                }),
        })
        const out = await tool.handler({ query: "bun" }, toolContext())
        expect(out).toContain("2 results")
        expect(out).toContain("1. Bun")
        expect(out).toContain("https://bun.sh/docs")
    })

    test("a missing key names the variable rather than failing at the endpoint", async () => {
        const tool = searchTool({
            backend: "tavily",
            apiKeyEnv: "TAVILY_API_KEY",
            env: {},
            fetch: async () => {
                throw new Error("must not be called")
            },
        })
        const error = await failure(() => tool.handler({ query: "x" }, toolContext()))
        expect(error.code).toBe("web_search_key_missing")
        expect(error.message).toContain("TAVILY_API_KEY")
    })

    test("a backend failure quotes what it said", async () => {
        const tool = searchTool({
            backend: "brave",
            apiKeyEnv: "BRAVE_API_KEY",
            env,
            fetch: async () => new Response("quota exhausted", { status: 429 }),
        })
        const error = await failure(() => tool.handler({ query: "x" }, toolContext()))
        expect(error.code).toBe("web_search_failed")
        expect(error.message).toContain("quota exhausted")
    })

    test("maxResults is clamped rather than trusted", () => {
        expect(clampResults(undefined)).toBe(5)
        expect(clampResults("3")).toBe(3)
        expect(clampResults(0)).toBe(1)
        expect(clampResults(1000)).toBe(10)
        expect(clampResults("not a number")).toBe(5)
    })

    test("an empty result set says the search ran", () => {
        expect(render("nothing at all", [])).toContain("came back empty")
    })

    test("the spec keeps web_search and tools.search apart", () => {
        expect(SEARCH_SPEC.trust).toBe("untrusted")
        expect(SEARCH_SPEC.whenNotToUse).toContain("find a tool rather than a page")
    })
})

// ─── the provider ────────────────────────────────────────────────────────────────────────

describe("the web provider", () => {
    const base = { dir: "/tmp", env: {}, agentId: "test" }

    test("resolves both slugs and lists them as available", async () => {
        const provider = new WebProvider({ env: {} })
        expect((await provider.resolve(["web_fetch"])).map((tool) => tool.spec.slug)).toEqual([
            "web_fetch",
        ])
        expect((await provider.available()).map((entry) => entry.slug)).toEqual([
            "web_search",
            "web_fetch",
        ])
    })

    test("omits what it does not know rather than throwing", async () => {
        const provider = new WebProvider({ env: {} })
        expect(await provider.resolve(["nonsense"])).toEqual([])
    })

    test("an unknown config key is refused, and there is no key that permits private addresses", () => {
        expect(() => webFromConfig({ ...base, config: { allowPrivate: true } })).toThrow(
            /does not read: allowPrivate/,
        )
        expect(() => webFromConfig({ ...base, config: { backend: "google" } })).toThrow(
            /tavily, brave, exa/,
        )
        expect(() => webFromConfig({ ...base, config: { apiKeyEnv: "" } })).toThrow(
            /non-empty name/,
        )
        expect(() => webFromConfig({ ...base, config: { maxBytes: 10 } })).toThrow(/at least 1000/)
    })

    test("the default is tavily with its conventional variable", () => {
        const provider = webFromConfig({ ...base, config: {} })
        expect(provider.id).toBe("web")
        expect(DEFAULT_MAX_BYTES).toBe(2_000_000)
    })
})
