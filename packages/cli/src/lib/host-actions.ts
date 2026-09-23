/**
 * Getting an agent hosted, adopted and reloaded — the sequence three commands share.
 *
 * `init`, `channels pair` and `restart` each need the same three moves: make sure a host is up
 * (the bootstrap), have it adopt the agent (`POST /start`), and have it pick up a change
 * (`POST /reload`). Written once, because three copies is how one of them comes to do the middle
 * step and skip the last — and a pairing whose session sits on disk unread by the process that is
 * supposed to answer is exactly the "paired, now run `serve` by hand" dead end this exists to close.
 *
 * Everything here talks to a host through the lease table and HTTP, never through the service
 * manager: a host started by hand, by launchd, by systemd or by a container is the same host once
 * it holds a lease, and the lease is the one witness every surface already trusts.
 */

import type { LeaseRecord } from "@dispach/core"
import { BRAND } from "@dispach/core"
import { daemonCommand } from "#daemon"
import { type BootstrapOutcome, type BootstrapResult, ensureServer } from "#lib/bootstrap"
import { EXIT_OK } from "#lib/const"
import {
    agentIdFor,
    anyLiveHost,
    callHost,
    type HostReply,
    liveHostOf,
    postToHost,
} from "#lib/lifecycle"

/**
 * Install and start the server unit, as the bootstrap does it.
 *
 * Reuses `daemonCommand` rather than reaching into the service layer, so a bootstrapped unit and
 * one installed by hand are byte-identical — a second plan builder is how the two come to differ in
 * a way nobody notices until one of them will not start. Its output is swallowed: the bootstrap's
 * whole contract is *one line*, and `daemon install`'s four-row report in front of `agents` would
 * be the opposite.
 */
export async function installServerUnit(): Promise<BootstrapResult> {
    const write = process.stdout.write.bind(process.stdout)
    // Replaced rather than piped, because `daemon install` writes with `process.stdout.write`
    // directly and there is nothing to intercept further down. Restored in a `finally`, or every
    // subsequent line of this process would vanish.
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
        const code = await daemonCommand({ action: "install" })
        if (code !== EXIT_OK) {
            return {
                kind: "failed",
                message: `daemon install exited ${code}`,
                hint: `Run \`${BRAND.slug} daemon install\` to see what it said.`,
            }
        }
        return { kind: "started", label: `${BRAND.slug}.server` }
    } finally {
        process.stdout.write = write
    }
}

export type Installer = () => Promise<BootstrapResult>

export interface EnsureHostOptions {
    /** How to start one when none is up. Absent means "do not try" — a test, or a caller that must not install. */
    readonly install?: Installer
    readonly store?: string
    readonly env?: Readonly<Record<string, string | undefined>>
    /** How long to wait for a freshly started server to claim its lease. */
    readonly waitMs?: number
}

/** How long a just-installed unit gets to boot and publish an address before we stop waiting. */
const HOST_WAIT_MS = 15_000
const HOST_POLL_MS = 250

/**
 * A host with an HTTP address, starting one if allowed and none is up.
 *
 * `host` is `undefined` when nothing could be reached — a platform we do not drive, a container,
 * CI, no installer, or a unit that installed and did not come up in time. The outcome says which,
 * and the caller prints `announce(outcome)` so the person sees the same one line the bootstrap
 * prints everywhere else.
 */
export async function ensureHost(
    options: EnsureHostOptions = {},
): Promise<{ readonly outcome: BootstrapOutcome; readonly host: LeaseRecord | undefined }> {
    const outcome = await ensureServer({
        needsServer: true,
        disabled: options.install === undefined,
        ...(options.install === undefined ? {} : { install: options.install }),
        ...(options.store === undefined ? {} : { store: options.store }),
        ...(options.env === undefined ? {} : { env: options.env }),
    })
    // Only a start is worth waiting on: `already` answers now, and every other kind means no host
    // is coming.
    const deadline =
        Date.now() + (outcome.kind === "started" ? (options.waitMs ?? HOST_WAIT_MS) : 0)
    for (;;) {
        const host = await anyLiveHost(options.store)
        if (host !== undefined || Date.now() >= deadline) return { outcome, host }
        await new Promise((resolve) => setTimeout(resolve, HOST_POLL_MS))
    }
}

/**
 * Have `host` serve this agent, unless something already does.
 *
 * `POST /v1/agents/:id/start` is also what `start` posts; a running host that already holds the
 * lease is left alone rather than asked to start what it is serving.
 */
export async function adoptOnHost(
    host: LeaseRecord,
    manifestPath: string,
    store?: string,
): Promise<HostReply & { readonly already?: true }> {
    const agentId = agentIdFor(manifestPath)
    const holder = await liveHostOf(agentId, store)
    if (holder !== undefined && holder.baseUrl !== undefined) {
        return { ok: true, status: 200, already: true }
    }
    return await postToHost(
        host,
        `/v1/agents/${encodeURIComponent(agentId)}/start`,
        {},
        manifestPath,
    )
}

export type ReloadResult =
    | { readonly kind: "reloaded"; readonly pid: number; readonly adopted: readonly string[] }
    | { readonly kind: "busy"; readonly pid: number }
    | {
          readonly kind: "failed"
          readonly pid: number
          readonly status: number
          readonly detail?: string
          readonly hint?: string
      }
    | { readonly kind: "no-host" }

/**
 * Ask the host holding this agent to rebuild it from disk.
 *
 * `POST /v1/agents/:id/reload` disposes and re-creates the agent from its manifest, so a pairing
 * written beside it, a token added to `.env` or an edited `agent.yaml` take effect without a
 * restart of the process that hosts every other agent too. `409` is a turn in flight and is
 * reported as such rather than retried: the person asked for a reload, not for a turn to be cut.
 */
export async function reloadOnHost(manifestPath: string, store?: string): Promise<ReloadResult> {
    const agentId = agentIdFor(manifestPath)
    const holder = await liveHostOf(agentId, store)
    if (holder === undefined || holder.baseUrl === undefined) return { kind: "no-host" }
    const reply = await postToHost(
        holder,
        `/v1/agents/${encodeURIComponent(agentId)}/reload`,
        {},
        manifestPath,
    )
    if (reply.ok) {
        const body = reply.body as { adopted?: readonly string[] } | undefined
        return { kind: "reloaded", pid: holder.pid, adopted: body?.adopted ?? [] }
    }
    if (reply.status === 409) return { kind: "busy", pid: holder.pid }
    return {
        kind: "failed",
        pid: holder.pid,
        status: reply.status,
        ...(reply.detail === undefined ? {} : { detail: reply.detail }),
        ...(reply.hint === undefined ? {} : { hint: reply.hint }),
    }
}

export interface LiveChannel {
    readonly id: string
    readonly status: string
    readonly detail?: string
    readonly input?: {
        readonly kind: string
        readonly payload: string
        readonly expiresAt?: string
    }
}

/**
 * The channel states the host holding this agent reports, or `undefined` when nothing does.
 *
 * Best effort throughout: a host that refuses, has no HTTP, or answers something unexpected leaves
 * the caller with the manifest view rather than a failed command. Reading a file must not start
 * depending on a socket.
 */
export async function liveChannels(
    manifestPath: string,
    store?: string,
): Promise<Map<string, LiveChannel> | undefined> {
    const agentId = agentIdFor(manifestPath)
    if (agentId === "") return undefined
    const holder = await liveHostOf(agentId, store)
    if (holder === undefined || holder.baseUrl === undefined) return undefined
    const reply = await callHost(
        holder,
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}`,
        manifestPath,
    )
    if (!reply.ok) return undefined
    const body = reply.body as { channels?: readonly LiveChannel[] } | undefined
    if (body?.channels === undefined) return undefined
    return new Map(body.channels.map((channel) => [channel.id, channel]))
}

export type HostPairOutcome = "paired" | "no-code" | "timeout"

export interface WaitForPairingOptions {
    readonly manifestPath: string
    readonly channelId: string
    readonly store?: string
    readonly out?: (text: string) => void
    /** How long to wait for the host to offer a code. */
    readonly codeWaitMs?: number
    /** How long to wait for the phone once the code is on screen. */
    readonly pairWaitMs?: number
    readonly pollMs?: number
}

const CODE_WAIT_MS = 25_000
const PAIR_WAIT_MS = 120_000
const POLL_MS = 2_000

/**
 * Show the code the host is offering and wait for the phone.
 *
 * The host does the pairing — it holds the socket to WhatsApp, and when the phone accepts, the
 * session is already in the process that will answer. Nothing to reload afterwards, which is the
 * whole reason this path is preferred over pairing in this process and asking the host to pick it
 * up. Bounded twice: for the code to appear and for the phone to act, each named on the way out.
 */
export async function waitForPairing(options: WaitForPairingOptions): Promise<HostPairOutcome> {
    const out = options.out ?? ((text: string) => process.stdout.write(text))
    const poll = options.pollMs ?? POLL_MS
    let shown: string | undefined
    let deadline = Date.now() + (options.codeWaitMs ?? CODE_WAIT_MS)
    while (Date.now() < deadline) {
        const now = (await liveChannels(options.manifestPath, options.store))?.get(
            options.channelId,
        )
        if (now?.status === "connected") {
            out(`Paired. ${options.channelId} is linked.\n`)
            return "paired"
        }
        if (now?.input !== undefined && now.input.payload !== shown) {
            if (shown === undefined) deadline = Date.now() + (options.pairWaitMs ?? PAIR_WAIT_MS)
            shown = now.input.payload
            const code = shown.replace(/(.{4})(?=.)/g, "$1 ")
            out(
                `\n${now.detail ?? "On the phone: WhatsApp › Settings › Linked devices › Link with phone number. Enter this code"}:\n\n    ${code}\n\nWaiting — this finishes on its own, or press ctrl-c and pair later.\n`,
            )
        }
        await new Promise((resolve) => setTimeout(resolve, poll))
    }
    return shown === undefined ? "no-code" : "timeout"
}
