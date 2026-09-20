/**
 * Opening a URL in whatever the operating system thinks a browser is.
 *
 * Nothing in this repo opened a browser before, and the temptation is a dependency — there are
 * several, and every one of them is this file plus a matrix of platforms nobody here runs. What it
 * actually takes is one command per platform and an honest answer when there is no browser at all,
 * which is the case that matters most: **a container has none**, and the container is where this
 * runtime is deployed. So "could not open" is a first-class outcome with the URL printed beside it,
 * not an error.
 *
 * Three properties, each of which was a decision:
 *
 * **It never blocks.** `open`/`xdg-open` hand off to a browser and exit, but `xdg-open` on a box
 * with no desktop can sit there — and a command that hangs while claiming to have opened a page is
 * worse than one that prints a link. Every call is bounded.
 *
 * **It never fails the command.** The URL is the deliverable; the browser is a convenience. A
 * non-zero exit from `open` means the operator gets a link to click instead, which is exactly what
 * they would have got from `web url`.
 *
 * **It refuses without a TTY.** A piped or scripted run must not sprout a browser window on
 * somebody's screen — and in CI it would open nothing and waste a timeout finding out.
 */

import { spawnCaptureAsync } from "#lib/spawn"

/** Why a URL was not opened. Absent means it was. */
export type OpenRefusal =
    /** No terminal, so nothing asked for a window. */
    | "not-a-terminal"
    /** `--no-open`. */
    | "asked-not-to"
    /** No opener on this platform — a container, a bare server, an unrecognised OS. */
    | "no-opener"
    /** There is an opener and it said no. */
    | "opener-failed"

export interface OpenOutcome {
    readonly opened: boolean
    readonly refusal?: OpenRefusal
    /** What the opener said, when it said something worth repeating. */
    readonly detail?: string
}

/**
 * The command that opens a URL, per platform.
 *
 * `xdg-open` is the freedesktop standard and is what Linux desktops implement; a *server* has none,
 * which is the honest reason this can return nothing. Windows needs the `""` title argument before
 * the URL, because `start` reads a first quoted argument as the window title and would otherwise
 * open a console named after the address.
 */
function openerFor(platform: string): { command: string; args: readonly string[] } | undefined {
    if (platform === "darwin") return { command: "open", args: [] }
    if (platform === "linux") return { command: "xdg-open", args: [] }
    if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] }
    return undefined
}

/** Bounded: `xdg-open` on a box with no desktop session can sit indefinitely. */
const OPEN_TIMEOUT_MS = 5_000

export async function openInBrowser(
    url: string,
    options: {
        readonly platform?: string
        readonly isTty?: boolean
        readonly noOpen?: boolean
        readonly spawn?: typeof spawnCaptureAsync
    } = {},
): Promise<OpenOutcome> {
    if (options.noOpen === true) return { opened: false, refusal: "asked-not-to" }
    if (options.isTty !== true) return { opened: false, refusal: "not-a-terminal" }

    const opener = openerFor(options.platform ?? process.platform)
    if (opener === undefined) return { opened: false, refusal: "no-opener" }

    const run = options.spawn ?? spawnCaptureAsync
    const result = await run({
        command: opener.command,
        args: [...opener.args, url],
        timeoutMs: OPEN_TIMEOUT_MS,
    })

    // `notFound` is its own answer: `xdg-open` missing means this is a server or a container, which
    // is a fact about the deployment rather than a failure to report as one.
    if (result.notFound) return { opened: false, refusal: "no-opener" }
    if (result.code !== 0 || result.signalled) {
        return {
            opened: false,
            refusal: "opener-failed",
            ...(result.stderr.trim() === "" ? {} : { detail: result.stderr.trim() }),
        }
    }
    return { opened: true }
}

/**
 * What to print. One sentence, and it always ends with the URL.
 *
 * The URL is the deliverable in every branch — including success, because a browser that opened
 * behind another window looks like nothing happened, and because a terminal that prints the link is
 * one somebody can copy out of over SSH.
 */
export function openMessage(url: string, outcome: OpenOutcome): string {
    if (outcome.opened) return `opening ${url}`
    switch (outcome.refusal) {
        case "asked-not-to":
            return url
        case "not-a-terminal":
            return url
        case "no-opener":
            // Named rather than apologised for: this is the ordinary state inside a container, and
            // an operator reading "failed to open a browser" would go looking for a fault.
            return `no browser here — open this from a machine that has one:\n  ${url}`
        default:
            return `could not open a browser${outcome.detail === undefined ? "" : ` (${outcome.detail})`} — open this:\n  ${url}`
    }
}
