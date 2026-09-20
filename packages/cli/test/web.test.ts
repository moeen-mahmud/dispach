/**
 * Pointing a browser at a running host, and the case that matters most — not having one.
 *
 * The opener is a few lines around one command per platform, so what is worth pinning is the
 * *refusals*: a container has no `xdg-open`, a pipe must not sprout a window on somebody's screen,
 * and an opener that fails must still leave the operator with a link. Each of those is an ordinary
 * outcome rather than an error, and the difference shows up in the sentence printed.
 *
 * The URL builder is small and load-bearing for the same reason: `web run milo` puts `?agent=milo`
 * in the address, and the page reads it. A URL that named an agent the page ignored would be
 * declared vocabulary nothing consumes.
 */

import { describe, expect, test } from "bun:test"
import { openInBrowser, openMessage } from "#lib/browser"
import type { SpawnResult } from "#lib/spawn"
import { webUrl } from "#web"

const OK: SpawnResult = { code: 0, stdout: "", stderr: "", signalled: false, notFound: false }
const MISSING: SpawnResult = { ...OK, code: 1, notFound: true }
const REFUSED: SpawnResult = { ...OK, code: 3, stderr: "no application knows how to open this" }

function recorder(result: SpawnResult = OK) {
    const calls: { command: string; args: readonly string[] }[] = []
    return {
        calls,
        spawn: async (request: { command: string; args: readonly string[] }) => {
            calls.push({ command: request.command, args: request.args })
            return result
        },
    }
}

describe("which command opens a URL", () => {
    test("macOS and Linux use their own, and Windows needs the empty title", async () => {
        for (const [platform, command] of [
            ["darwin", "open"],
            ["linux", "xdg-open"],
            ["win32", "cmd"],
        ] as const) {
            const fake = recorder()
            const outcome = await openInBrowser("http://127.0.0.1:7420/", {
                platform,
                isTty: true,
                spawn: fake.spawn as never,
            })
            expect(outcome.opened).toBe(true)
            expect(fake.calls[0]?.command).toBe(command)
        }
        // `start` reads a first quoted argument as the window *title*, so without the empty one it
        // opens a console named after the address instead of a browser.
        const windows = recorder()
        await openInBrowser("http://h/", {
            platform: "win32",
            isTty: true,
            spawn: windows.spawn as never,
        })
        expect(windows.calls[0]?.args).toEqual(["/c", "start", "", "http://h/"])
    })

    test("an unknown platform opens nothing rather than guessing", async () => {
        const fake = recorder()
        const outcome = await openInBrowser("http://h/", {
            platform: "aix",
            isTty: true,
            spawn: fake.spawn as never,
        })
        expect(outcome).toEqual({ opened: false, refusal: "no-opener" })
        // Nothing was run. Guessing a command and watching it fail would be slower and would report
        // "could not open a browser" for an operating system that was never going to have one.
        expect(fake.calls).toEqual([])
    })
})

describe("the refusals, which are outcomes rather than failures", () => {
    test("a container has no opener, and the sentence says so without apologising", async () => {
        /**
         * The deployment target. `xdg-open` is a freedesktop desktop tool and a server image has
         * none, so this is the *ordinary* state rather than a fault — and an operator reading
         * "could not open a browser" would go looking for one.
         */
        const fake = recorder(MISSING)
        const outcome = await openInBrowser("http://127.0.0.1:7420/", {
            platform: "linux",
            isTty: true,
            spawn: fake.spawn as never,
        })
        expect(outcome.refusal).toBe("no-opener")
        const message = openMessage("http://127.0.0.1:7420/", outcome)
        expect(message).toContain("no browser here")
        expect(message).toContain("http://127.0.0.1:7420/")
        expect(message).not.toContain("could not")
    })

    test("no terminal means no window, and the URL is the whole output", async () => {
        // A piped or scripted run must not open a window on somebody's screen. The URL alone is
        // what a pipe can use, so it is the entire message — no sentence to strip.
        const fake = recorder()
        const outcome = await openInBrowser("http://h/", {
            platform: "darwin",
            isTty: false,
            spawn: fake.spawn as never,
        })
        expect(outcome.refusal).toBe("not-a-terminal")
        expect(fake.calls).toEqual([])
        expect(openMessage("http://h/", outcome)).toBe("http://h/")
        expect(openMessage("http://h/", { opened: false, refusal: "asked-not-to" })).toBe(
            "http://h/",
        )
    })

    test("an opener that says no still leaves a link, and repeats what it said", async () => {
        const fake = recorder(REFUSED)
        const outcome = await openInBrowser("http://h/", {
            platform: "darwin",
            isTty: true,
            spawn: fake.spawn as never,
        })
        expect(outcome.refusal).toBe("opener-failed")
        const message = openMessage("http://h/", outcome)
        expect(message).toContain("no application knows how to open this")
        expect(message).toContain("http://h/")
    })

    test("even a successful open prints the URL", () => {
        // A browser that opened behind another window looks like nothing happened, and a terminal
        // reached over SSH is one where the link is the only usable half.
        expect(openMessage("http://h/", { opened: true })).toContain("http://h/")
    })
})

describe("the address the page is opened at", () => {
    test("an agent becomes a query parameter, not a path", () => {
        // A path would need a route, a `WEB_ASSETS` entry, a spec row, a `spec.test.ts` change and
        // either a catch-all — which would make `/v1/agentss` answer `200 text/html` — or a 404 on
        // reload. The no-catch-all decision stands; this is how a deep link works without it.
        expect(webUrl("http://127.0.0.1:7420", "milo")).toBe("http://127.0.0.1:7420/?agent=milo")
        expect(webUrl("http://127.0.0.1:7420")).toBe("http://127.0.0.1:7420/")
        expect(webUrl("http://127.0.0.1:7420", "")).toBe("http://127.0.0.1:7420/")
    })

    test("a bind is turned into an address a browser can open", () => {
        /**
         * Found in the container, which is the only place it shows.
         *
         * The lease publishes what was *bound*, and the image binds `0.0.0.0` — every interface,
         * and a link nothing can click. On a laptop `serve` binds `127.0.0.1`, so the substitution
         * never fires and the defect is invisible exactly where it is not deployed.
         */
        expect(webUrl("http://0.0.0.0:7420", "minimal")).toBe(
            "http://127.0.0.1:7420/?agent=minimal",
        )
        expect(webUrl("http://[::]:7420")).toBe("http://127.0.0.1:7420/")
        // A real address is left alone — the substitution is for binds, not a blanket rewrite.
        expect(webUrl("http://192.168.1.9:7420")).toBe("http://192.168.1.9:7420/")
    })

    test("a lease's address is used as published, path and all", () => {
        // The base URL comes off the lease, published after the bind — never rebuilt from a
        // manifest, because `--port 0` means the port does not exist until the socket does. So the
        // host and port are carried verbatim and only the path is ours to set.
        expect(webUrl("http://192.168.1.9:9001/v1/anything", "vela")).toBe(
            "http://192.168.1.9:9001/?agent=vela",
        )
        // IPv6 keeps its brackets rather than being re-parsed into something unroutable.
        expect(webUrl("http://[::1]:7420", "a")).toBe("http://[::1]:7420/?agent=a")
    })
})
