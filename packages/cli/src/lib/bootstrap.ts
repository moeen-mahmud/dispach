/**
 * First run: if no server is up, put one up — and say so in one line.
 *
 * This is the most invasive thing the product does, and it is defensible only because of four
 * properties, each of which is a line of code below rather than an intention:
 *
 * 1. **It is announced**, in one line, naming the command that undoes it.
 * 2. **It is skipped for every command that does not want a host** — `CommandSpec.needsServer` is a
 *    required field so that decision is taken per command rather than inherited from a list in
 *    `index.ts` that a new command is silently absent from, or silently included in.
 * 3. **It never runs inside a container**, which *is* the daemon, or under CI, or when the escape
 *    hatch is set. A service manager inside a container is a second supervisor arguing with the
 *    first.
 * 4. **It never fails the command it was asked for.** A LaunchAgent needs a GUI session, so over
 *    SSH `launchctl bootstrap` returns 125 or 112 — and a listing command that died because a
 *    background service could not be installed would be a far worse product than one without any
 *    of this. Every failure degrades to a printed line.
 *
 * ## Why it does not start a service it cannot start
 *
 * On Linux the unit is written and not enabled — `systemctl --user` is not driven from here (see
 * `service.ts`). Bootstrapping there would mean writing a file and reporting a running server,
 * which is the exact failure this phase exists to remove, so on a platform whose manager cannot
 * start what it installs the bootstrap **prints the command and writes nothing**.
 */

import { existsSync } from "node:fs"
import { BRAND } from "@dispach/core"
import { liveHosts } from "#lib/lifecycle"
import { managerCanStart } from "#lib/service"

export interface BootstrapOptions {
    /** From `CommandSpec.needsServer`. False short-circuits everything. */
    readonly needsServer: boolean
    readonly platform?: string
    readonly env?: Readonly<Record<string, string | undefined>>
    /** `--no-bootstrap`. */
    readonly disabled?: boolean
    /** Injected by tests; the real one installs and starts the unit. */
    readonly install?: () => Promise<BootstrapResult>
    /** The store to look for a live host in. `serve --store` has one, so this does too. */
    readonly store?: string
}

export type BootstrapResult =
    | { readonly kind: "started"; readonly label: string }
    | { readonly kind: "manual"; readonly lines: readonly string[] }
    | { readonly kind: "failed"; readonly message: string; readonly hint: string }

/** Why nothing was done, when nothing was done. Returned rather than logged, so a test can read it. */
export type BootstrapOutcome =
    | { readonly kind: "skipped"; readonly reason: SkipReason }
    | { readonly kind: "already" }
    | BootstrapResult

export type SkipReason =
    | "command-needs-no-server"
    | "disabled-by-flag"
    | "disabled-by-env"
    | "in-container"
    | "in-ci"
    | "is-the-service"

/**
 * Are we inside a container?
 *
 * A container is already supervised by whatever started it, and its entrypoint is `serve` — so it
 * neither wants a bootstrap nor has a terminal to lose. `/.dockerenv` is Docker's own marker; the
 * `container` variable covers podman and a hand-rolled image.
 *
 * Exported because the *banner* needs it too, and for the reason `browsableHost` gives about having
 * had two copies before a third caller arrived: the sign-off line told a container operator to
 * press ctrl-c in a terminal that does not exist and to run `daemon install` against a supervisor
 * that is already doing the job.
 */
export function inContainer(
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    return existsSync("/.dockerenv") || env.container !== undefined
}

/**
 * Why we are not doing this, checked before anything is read.
 *
 * Ordered cheapest-first and by *specificity*: `is-the-service` is checked before `in-container`
 * because a service process is the one case where being wrong would be recursive, and the reason is
 * worth reporting accurately when a test asks.
 */
export function skipReason(options: BootstrapOptions): SkipReason | undefined {
    const env = options.env ?? process.env
    if (!options.needsServer) return "command-needs-no-server"
    if (options.disabled === true) return "disabled-by-flag"
    if (env[`${BRAND.envPrefix}SERVICE`] !== undefined) return "is-the-service"
    if (env[`${BRAND.envPrefix}NO_BOOTSTRAP`] !== undefined) return "disabled-by-env"
    if (inContainer(env)) return "in-container"
    // Not politeness: a CI job that installed a LaunchAgent would leave it behind on a shared
    // runner, and the job after it would inherit a server nobody asked for.
    if (env.CI !== undefined) return "in-ci"
    return undefined
}

/**
 * Put a server up if one is not already up.
 *
 * "Already up" is decided from the **lease table plus pid liveness**, which is the same witness
 * every other surface uses — `liveHosts` filters on `process.kill(pid, 0)`, so a row left behind by
 * a boot that died after claiming does not read as a running server. No HTTP probe: a lease with a
 * live pid is a process hosting agents whether or not it serves HTTP, and a `run` REPL holding one
 * is a reason not to install a second host underneath somebody.
 */
export async function ensureServer(options: BootstrapOptions): Promise<BootstrapOutcome> {
    const skip = skipReason(options)
    if (skip !== undefined) return { kind: "skipped", reason: skip }

    const hosts = await liveHosts(options.store)
    if (hosts.length > 0) return { kind: "already" }

    const platform = options.platform ?? process.platform
    if (!managerCanStart(platform)) {
        // Write nothing and claim nothing. See the file comment.
        return {
            kind: "manual",
            lines: [`${BRAND.slug} daemon install`],
        }
    }

    const install = options.install
    if (install === undefined) {
        return {
            kind: "failed",
            message: "no installer was supplied",
            hint: "This is a wiring mistake rather than a configuration one: `ensureServer` is called with an `install` callback by `index.ts`.",
        }
    }

    try {
        return await install()
    } catch (error) {
        // Never rethrown. A command that failed because a *background service* could not be
        // installed would be a worse product than one with no bootstrap at all — and over SSH on
        // macOS this is the ordinary outcome, because a LaunchAgent needs a GUI session.
        const detail = error instanceof Error ? error.message : String(error)
        return {
            kind: "failed",
            message: detail,
            hint: `The command ran anyway. \`${BRAND.slug} daemon install\` reports the same failure with more detail — on macOS over SSH it is usually that a LaunchAgent needs a logged-in desktop session.`,
        }
    }
}

/**
 * The one line, and it is the whole justification for doing this at all.
 *
 * Written to **stderr**, so it never lands in the middle of `--json` output somebody is piping into
 * `jq` — the announcement matters to a person and is noise to a script. Every branch names what to
 * type next: the undo for a success, the do-it-yourself for a platform we do not drive, and the
 * diagnostic command for a failure.
 */
export function announce(outcome: BootstrapOutcome): string | undefined {
    switch (outcome.kind) {
        case "started":
            return `started the background server · \`${BRAND.slug} daemon uninstall\` to undo\n`
        case "manual":
            return `no server is running · ${outcome.lines.join(", then ")}\n`
        case "failed":
            return `could not start a background server: ${outcome.message}\n  hint: ${outcome.hint}\n`
        default:
            // `skipped` and `already` are the ordinary states and say nothing. A line on every
            // invocation is a line nobody reads, which is how the one that matters gets missed.
            return undefined
    }
}
