/**
 * The daemon's decisions, as pure functions: what would stop an install, and what a service's
 * state actually means.
 *
 * Facts in, verdicts out. Gathering the facts needs the filesystem, `launchctl` and a manifest
 * loader; *judging* them needs none of that, and separating the two is what makes the interesting
 * cases — a restart loop, a stale heartbeat, a binary inside a git checkout — testable as a table
 * rather than by breaking a real machine in nine different ways.
 *
 * No `node:*`, no `process`. This module is on the boundaries test's `PURE` list.
 */

import { bytes, duration, keyValue, type Row } from "#lib/render"

export type Severity = "block" | "warn"

export interface Finding {
    readonly code: string
    readonly severity: Severity
    readonly message: string
    /** Never optional. Hard rule 7, and a test asserts it over every finding this can produce. */
    readonly hint: string
}

export interface BinaryFacts {
    /** `realpath(process.execPath)` — the interpreter, absolute. */
    readonly execPath: string
    /** `realpath(process.argv[1])` — the script, absolute. */
    readonly scriptPath: string
    /** Nearest ancestor of `scriptPath` holding a `.git`, if any. */
    readonly gitRoot?: string
}

export interface AgentFindingFacts {
    readonly agentId: string
    readonly agentDir: string
    /** `undefined` when there is no `.env` beside the manifest. */
    readonly envFileMode?: number
    /** Set when the manifest could not be loaded at all. Reported, never fatal. */
    readonly problem?: string
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"])

export function isLoopbackHost(host: string): boolean {
    return LOOPBACK.has(host.toLowerCase())
}

/**
 * What is worth saying about **one agent** when the host that will serve it is installed.
 *
 * ## Four blockers were deleted rather than moved, and each for a reason
 *
 * This was `preflightFindings`, gating `daemon install <agent>`. That install is retired — one
 * service hosts every agent — and with it three of its five blockers became *false* rather than
 * merely unreachable, which is worth recording so nobody restores them:
 *
 * - **`daemon_nothing_to_serve`** refused an agent with no enabled channel and `server.enabled`
 *   false, because "a background service would answer nothing". Since 16.3 the host serves every
 *   agent over `/v1` whatever that agent's own `server` block says, so an agent with no channel is
 *   reachable from a browser and from the API — and a server with *no* agents is the designed
 *   first-run state. Refusing here would make "install and the API is up" false.
 * - **`server_public_without_token`** duplicated `serve`'s own bind-time refusal one step earlier,
 *   for a host whose address came from that agent's manifest. The unit names no manifest, so its
 *   bind comes from the schema's loopback default and this cannot arise. `serve` still refuses it.
 * - **`daemon_label_taken`** was about two agents sharing one per-agent label. There is no
 *   per-agent label.
 * - **`daemon_already_serving`** survives as `daemon_agents_held_elsewhere` on the server's own
 *   list, as a **warning**: the host now starts and serves everything else rather than refusing,
 *   which is 16.2a's partial-lease behaviour applied to an install.
 *
 * What is left is the one thing that is still true per agent and that nothing else says: the mode
 * of the file its credentials live in.
 */
export function agentFindings(facts: AgentFindingFacts): readonly Finding[] {
    const out: Finding[] = []

    if (facts.problem !== undefined) {
        out.push({
            code: "daemon_agent_unreadable",
            severity: "warn",
            message: `Agent "${facts.agentId}" could not be read: ${facts.problem}`,
            hint: "The host skips an agent whose manifest will not load and serves the rest, so this is a warning rather than a refusal — `validate` on that agent says exactly what is wrong with it.",
        })
    }

    if (facts.envFileMode !== undefined && (facts.envFileMode & 0o077) !== 0) {
        out.push({
            code: "daemon_env_world_readable",
            severity: "warn",
            message: `${facts.agentId}'s .env is mode ${(facts.envFileMode & 0o777).toString(8)} and holds its only secrets.`,
            hint: `Under a service manager that file is the *only* path credentials arrive by — a unit carries none on purpose, because its manager echoes the environment in plaintext. \`chmod 600 ${facts.agentDir}/.env\`.`,
        })
    }

    return out
}

export function binaryWarnings(binary: BinaryFacts): readonly Finding[] {
    const out: Finding[] = []

    if (binary.gitRoot !== undefined) {
        out.push({
            code: "daemon_binary_in_checkout",
            severity: "warn",
            message: `The binary resolves to ${binary.scriptPath}, inside a git checkout at ${binary.gitRoot}.`,
            hint: "A rebuild, a branch switch or a `git clean` changes or breaks what the service runs, and the failure arrives with no obvious connection to the change. Fine for testing; install a released build for a service you intend to leave running.",
        })
    }

    if (/[/.](nvm|fnm|volta|asdf)\//.test(binary.execPath)) {
        out.push({
            code: "daemon_versioned_runtime",
            severity: "warn",
            message: `The interpreter is a version-managed install: ${binary.execPath}`,
            hint: "The absolute path is baked into the service definition, so removing that runtime version later kills the service with a message only the log file sees. A system or Homebrew install is more durable.",
        })
    }

    return out
}

export interface ServerPreflightFacts {
    readonly binary: BinaryFacts
    /** Retired per-agent labels found installed, which a bare install cleans up. */
    readonly retiring: readonly string[]
    /** Live leases held by other processes — agents the new unit would not be able to serve. */
    readonly servedElsewhere: readonly {
        readonly agentId: string
        readonly pid: number
        readonly mode: string
    }[]
}

/**
 * What to say before installing **the** server unit — a much shorter list, and deliberately so.
 *
 * Every blocker the per-agent list used to carry was a fact about one agent — its channel, its
 * token, its label — and a host that starts with no agents has none of those. `agentFindings` above
 * records which ones were deleted and why each one became false rather than merely unreachable.
 *
 * Nothing here blocks. The one thing that could — a conflicting label — is handled by *retiring* it
 * instead, because that is the only way to leave a working system behind: a per-agent unit left
 * beside the server unit contends for the same lease, so the server would report that agent as
 * served elsewhere indefinitely with nothing looking wrong.
 */
export function serverFindings(facts: ServerPreflightFacts): readonly Finding[] {
    const out: Finding[] = []

    for (const label of facts.retiring) {
        out.push({
            code: "daemon_per_agent_retired",
            severity: "warn",
            message: `Retiring ${label} — one service hosts every agent now.`,
            hint: "It is unloaded, re-enabled and its definition removed. The re-enable is not cosmetic: a `disable` row persists across boots and no verb deletes it, so a label left disabled makes any future job with that name install cleanly and silently never start. Per-agent on/off is `stop <agent>`, which persists in the store instead.",
        })
    }

    if (facts.servedElsewhere.length > 0) {
        const first = facts.servedElsewhere[0]
        out.push({
            code: "daemon_agents_held_elsewhere",
            severity: "warn",
            message: `${facts.servedElsewhere.length} agent(s) are held by other live processes — ${first?.agentId} by pid ${first?.pid} (${first?.mode}).`,
            hint: "The service will start and serve everything else, and report those as served elsewhere rather than fighting for them — one listener per bot token is the whole reason the lease exists. `stop` with no agent ends the other processes.",
        })
    }

    out.push(...binaryWarnings(facts.binary))

    return out
}

// ─── status ─────────────────────────────────────────────────────────────────────────────

/**
 * What a service is doing, in four states rather than two.
 *
 * `running` and `absent` are the easy ones. The pair that matters is `stopped` versus
 * `installed-idle`: a disabled job is simply *not listed* by `launchctl list`, so without the
 * disable registry those two are the same observation — and one of them means "you asked for
 * this" while the other means "it died and launchd gave up".
 */
export type Verdict =
    | "running"
    | "failed"
    | "restart-loop"
    | "stopped"
    | "installed-idle"
    | "absent"

export interface ServiceFacts {
    readonly installed: boolean
    readonly disabled: boolean
    readonly pid?: number
    readonly runs?: number
    readonly lastExitCode?: number
    readonly stderrPath?: string
    readonly stderrBytes?: number
    /** From the runtime lease — true even when launchd knows nothing, e.g. a terminal `serve`. */
    readonly leasePid?: number
    readonly leaseMode?: string
    readonly leaseStartedAt?: string
    readonly uptimeMs?: number
}

/**
 * Things a *running* service is saying that a person needs to see.
 *
 * `status` reporting "running" was true and useless: the bot was up, connected, and refusing every
 * message from the one person it had been set up for, because a handle in `allowFrom` was mistyped.
 * The refusal names the sender and the exact line to paste — and writes it to a log file, which is
 * the failure mode this whole phase is a reaction to, reached from a new direction.
 *
 * Health is not the only question. "Is it running" and "is it working" are different, and only the
 * second one is why anybody typed the command.
 */
export interface Attention {
    readonly code: string
    readonly summary: string
    readonly fix: string
}

/**
 * Only the current run.
 *
 * launchd *appends* to a service's log, so a denial from before you fixed the allowlist would
 * otherwise be reported forever — a warning that outlives its cause is one people learn to scroll
 * past, which is how you end up with a screen full of things that are all fine. Each start writes
 * the serving banner, so everything after the last one is this process and nothing else.
 */
export function currentRun(log: string, marker = "serving on"): string {
    const at = log.lastIndexOf(marker)
    return at === -1 ? log : log.slice(at)
}

/** Lines a running service wrote that mean it is up and not doing its job. */
export function attentionFrom(rawLog: string): readonly Attention[] {
    const log = currentRun(rawLog)
    const out: Attention[] = []

    // Every distinct sender it has turned away. Deduplicated, because a person who messages three
    // times produces three identical lines and a status screen should say it once.
    const denied = new Set<string>()
    for (const match of log.matchAll(/denied — Sender "([^"]+)" is not in channel "([^"]+)"/g)) {
        if (match[1] !== undefined) denied.add(`${match[1]}|${match[2] ?? ""}`)
    }
    for (const entry of denied) {
        const [sender, channel] = entry.split("|")
        out.push({
            code: "inbound_denied",
            summary: `messages from ${sender} are being refused — they are not on channel "${channel}"'s allowFrom list`,
            fix: `add ${sender} to allowFrom in agent.yaml, then restart. An allowlist that is empty, or that has a typo in it, refuses silently from the sender's side: they see nothing at all.`,
        })
    }

    if (/channel_telegram_unauthorized|telegram_token_missing/.test(log)) {
        out.push({
            code: "channel_unauthorized",
            summary: "the channel rejected its token",
            fix: "check the token in the .env beside the manifest, then restart.",
        })
    }

    return out
}

export interface StatusReport {
    readonly verdict: Verdict
    readonly healthy: boolean
    readonly headline: string
    readonly rows: readonly Row[]
    /** Print the tail of stderr. True whenever the thing is not simply running. */
    readonly wantsStderrTail: boolean
}

/** Three restarts is where "it recovered" stops being the likelier reading. */
const LOOP_RUNS = 3

export function summariseStatus(agentId: string, facts: ServiceFacts): StatusReport {
    const verdict = decide(facts)
    const rows: Row[] = []

    if (facts.pid !== undefined) {
        rows.push({
            label: "state",
            value: `running · pid ${facts.pid}`,
            ...(facts.uptimeMs === undefined ? {} : { note: `up ${duration(facts.uptimeMs)}` }),
        })
    } else if (facts.leasePid !== undefined) {
        // launchd knows nothing, but something holds the lease — a `serve` in a terminal. Worth
        // saying plainly: "not installed" alone would read as "nothing is running", which is the
        // opposite of the truth and is exactly the confusion slot 2 was fixed for.
        rows.push({
            label: "state",
            value: `running in a terminal · pid ${facts.leasePid}`,
            note: "not installed as a service",
        })
    }
    // No `else`. With nothing running the headline already carries the state, and repeating it as
    // a row two lines below is noise that makes the rows underneath — the ones with the actual
    // evidence — harder to find.

    if (facts.runs !== undefined && facts.runs > 1) {
        rows.push({
            label: "starts",
            value: String(facts.runs),
            ...(verdict === "restart-loop"
                ? { note: `launchd has restarted this ${facts.runs} times` }
                : { note: "since the service was installed" }),
        })
    }
    // Only when nothing is running. On a healthy service this is history — the failure you already
    // fixed — and printing a red-looking "last exit code 1" beside "running" invites a person to go
    // and debug something that is working.
    if (verdict !== "running" && facts.lastExitCode !== undefined && facts.lastExitCode !== 0) {
        rows.push({ label: "last exit", value: `code ${facts.lastExitCode}` })
    }
    if (facts.stderrPath !== undefined) {
        rows.push({
            label: "logs",
            value: facts.stderrPath,
            ...(facts.stderrBytes === undefined ? {} : { note: `(${bytes(facts.stderrBytes)})` }),
        })
    }

    return {
        verdict,
        healthy: verdict === "running",
        headline:
            verdict === "restart-loop"
                ? `${agentId} — RESTART LOOP`
                : `${agentId} — ${stateWord(verdict)}`,
        rows,
        wantsStderrTail:
            verdict === "restart-loop" || verdict === "failed" || verdict === "installed-idle",
    }
}

function decide(facts: ServiceFacts): Verdict {
    if (!facts.installed) return facts.leasePid === undefined ? "absent" : "running"
    // **A pid means running, with no qualification.** An earlier version also demanded the start
    // count be low and the uptime long, and that was wrong in a way only the real thing showed:
    // launchd's `runs` is cumulative for the life of the loaded job and never resets, so every
    // deliberate restart of a service that had *ever* failed came back seconds old with a high
    // count and was announced as a RESTART LOOP while working perfectly. A status command that
    // cries wolf on a healthy service is worse than one that says nothing.
    if (facts.pid !== undefined) return "running"
    if (facts.disabled) return "stopped"
    if ((facts.runs ?? 0) >= LOOP_RUNS && (facts.lastExitCode ?? 0) !== 0) return "restart-loop"
    // A single non-zero exit, which under `KeepAlive: {Crashed: true}` is the *designed* end state
    // for a misconfiguration: it stopped once instead of looping. Reporting that as "installed, not
    // running" would understate it into invisibility — the same understatement that let a job
    // restart 2,463 times with a perfectly good error message in a file nobody opened.
    if ((facts.lastExitCode ?? 0) !== 0) return "failed"
    return "installed-idle"
}

function stateWord(verdict: Verdict): string {
    switch (verdict) {
        case "running":
            return "running"
        case "failed":
            return "STOPPED AFTER A FAILURE"
        case "restart-loop":
            return "exited · nothing is running"
        case "stopped":
            return "stopped by you"
        case "installed-idle":
            return "installed · not running"
        case "absent":
            return "not installed"
    }
}

/** The body of a `status` block, minus the log tail the caller reads from disk. */
export function renderStatus(report: StatusReport): string {
    return `${report.headline}\n${keyValue(report.rows)}`
}
