/**
 * `daemon <action> <agent>` — keep an agent serving without a terminal open.
 *
 * ## Why this is a command and not a paragraph in the README
 *
 * Path resolution, and it is provable rather than arguable. The obvious hand-written plist —
 * `ProgramArguments: ["~/.bun/bin/<binary>", "serve", "milo"]` — **exits 127 forever**: the built
 * binary's first line is `#!/usr/bin/env node`, launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`,
 * and on a machine using a version manager there is no `node` in any of those. The failure lands in
 * a log file nobody has been told about. The gateway this runtime replaces ships an installer and
 * still got a version of this half-wrong — a Homebrew interpreter running an nvm-installed script.
 *
 * So the job is: resolve the interpreter and the script absolutely, resolve the manifest absolutely
 * (a bare agent name means something different from launchd's cwd of `/` than it does from the
 * directory you typed it in), carry no secrets, and refuse to install something that will not boot.
 *
 * No Ink and no React — a service command's output is read from a log at least as often as from a
 * terminal.
 */

import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
    BRAND,
    buildChannels,
    HarnessError,
    loadManifest,
    processAlive,
    readManifestHeader,
    SqliteStore,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK, LOG_POLL_MS } from "#lib/const"
import {
    type Attention,
    attentionFrom,
    type BinaryFacts,
    type Finding,
    isLoopbackHost,
    type PreflightFacts,
    preflightFindings,
    renderStatus,
    type ServiceFacts,
    summariseStatus,
} from "#lib/daemon-plan"
import { onExit } from "#lib/exit"
import {
    labelFor,
    plistEnvAllowed,
    renderPlist,
    type ServicePlan,
    THROTTLE_SECONDS,
} from "#lib/launchd"
import { type FollowIO, followLogs } from "#lib/log-follow"
import { CHANNEL_IDS, CHANNELS, PROVIDER_IDS } from "#lib/providers"
import { bytes, indent, keyValue, tildify } from "#lib/render"
import { logPaths, storePath } from "#lib/sandbox"
import { type Exec, resolveServiceManager, unsupported } from "#lib/service"

export const DAEMON_ACTIONS = [
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "logs",
] as const
export type DaemonAction = (typeof DAEMON_ACTIONS)[number]

export interface DaemonOptions {
    readonly action: string
    /** Absolute manifest path. Optional only for `status`, which can report on everything. */
    readonly manifestPath?: string
    readonly lines?: number
    readonly follow?: boolean
    readonly truncate?: boolean
    readonly dryRun?: boolean
    readonly json?: boolean
    /** Test seams. Nothing in `src/` outside this file passes them. */
    readonly exec?: Exec
    readonly platform?: string
}

export async function daemonCommand(options: DaemonOptions): Promise<number> {
    if (!(DAEMON_ACTIONS as readonly string[]).includes(options.action)) {
        throw new HarnessError({
            code: "cli_daemon_unknown_action",
            message: `daemon takes one of ${DAEMON_ACTIONS.join(", ")}, not "${options.action}".`,
            hint: `Usage: ${BRAND.slug} daemon <action> <agent>. Run \`${BRAND.slug} daemon --help\` for what each one does.`,
        })
    }
    const action = options.action as DaemonAction

    if (action !== "status" && options.manifestPath === undefined) {
        throw new HarnessError({
            code: "cli_daemon_agent_required",
            message: `daemon ${action} needs an agent.`,
            hint: `Usage: ${BRAND.slug} daemon ${action} <agent>. Only \`status\` may be run bare, where it reports on every installed agent.`,
        })
    }

    const platform = options.platform ?? process.platform
    const binary = binaryFacts()

    // The platform check runs *after* the paths are resolved, so the refusal can hand over the
    // ExecStart line rather than only naming the gap. Not for `status`, which answers from the
    // runtime lease alone and is useful everywhere.
    if (platform !== "darwin" && action !== "status") {
        throw unsupported(platform, execStartLine(binary, options.manifestPath ?? "<manifest>"))
    }

    const manager =
        platform === "darwin"
            ? resolveServiceManager(platform, {
                  home: homedir(),
                  uid: process.getuid?.() ?? 0,
                  envPrefix: BRAND.envPrefix,
                  ...(options.exec === undefined ? {} : { exec: options.exec }),
              })
            : undefined

    switch (action) {
        case "status":
            return await statusAction(options, manager)
        case "install":
            return await installAction(options, binary, manager)
        case "uninstall":
            return uninstallAction(options, manager)
        case "start":
        case "stop":
        case "restart":
            return lifecycleAction(action, options, manager)
        case "logs":
            return await logsAction(options)
    }
}

// ─── facts ──────────────────────────────────────────────────────────────────────────────

/**
 * The interpreter and the script, resolved through every symlink.
 *
 * `realpathSync` on both rather than trusting `argv[1]`: Node resolves the main module's realpath
 * today, but that is a flag away from changing (`--preserve-symlinks-main`), and a service
 * definition is not the place to depend on a default. On this machine the chain runs
 * `~/.bun/bin/<binary>` → the bun global directory → a `dist/index.js` inside a git checkout, which
 * is a fact the person installing deserves to be told (see `daemon_binary_in_checkout`).
 */
function binaryFacts(): BinaryFacts {
    const execPath = realpathOr(process.execPath)
    const scriptPath = realpathOr(process.argv[1] ?? "")
    const gitRoot = findGitRoot(dirname(scriptPath))
    return { execPath, scriptPath, ...(gitRoot === undefined ? {} : { gitRoot }) }
}

function realpathOr(path: string): string {
    try {
        // Imported lazily so the pure-module boundary stays obvious: this file is the impure one.
        return require("node:fs").realpathSync(path) as string
    } catch {
        return path
    }
}

function findGitRoot(from: string): string | undefined {
    let dir = from
    for (let depth = 0; depth < 40; depth += 1) {
        if (existsSync(join(dir, ".git"))) return dir
        const parent = dirname(dir)
        if (parent === dir) return undefined
        dir = parent
    }
    return undefined
}

function execStartLine(binary: BinaryFacts, manifestPath: string): string {
    return `ExecStart=${binary.execPath} ${binary.scriptPath} serve ${manifestPath} --store ${storePath()}`
}

// ─── install ────────────────────────────────────────────────────────────────────────────

async function installAction(
    options: DaemonOptions,
    binary: BinaryFacts,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): Promise<number> {
    const manifestPath = options.manifestPath as string
    const env = ambientEnv([manifestPath])

    // Exactly the pair `validate` uses, so a manifest the daemon accepts is one `serve` runs.
    // `buildChannels` is where a missing bot token surfaces — the single check that would have
    // prevented the crash loop this whole design is a reaction to. It opens no socket.
    const loaded = loadManifest(manifestPath, {
        knownProviders: PROVIDER_IDS,
        knownChannels: CHANNEL_IDS,
        env,
    })
    buildChannels(loaded, { channels: CHANNELS })

    const agentId = loaded.manifest.id
    const label = labelFor(BRAND.slug, agentId)
    const logs = logPaths(agentId)
    const mode = envMode(loaded.dir)
    const facts: PreflightFacts = {
        platform: options.platform ?? process.platform,
        agentId,
        manifestPath,
        agentDir: loaded.dir,
        binary,
        ...(mode === undefined ? {} : { envFileMode: mode }),
        enabledChannels: loaded.manifest.channels
            .filter((channel) => channel.enabled)
            .map((channel) => channel.id),
        serverEnabled: loaded.manifest.server.enabled,
        serverHost: loaded.manifest.server.host,
        serverTokenPresent: (loaded.env[loaded.manifest.server.tokenEnv] ?? "") !== "",
        ...(await servedBy(agentId)),
        ...installedManifest(manager?.unitPath(label)),
    }

    const findings = preflightFindings(facts)
    const blocking = findings.filter((finding) => finding.severity === "block")
    if (blocking.length > 0) {
        process.stderr.write(renderFindings(findings))
        return EXIT_FAILURE
    }

    const plan: ServicePlan = {
        label,
        programArguments: [
            binary.execPath,
            binary.scriptPath,
            "serve",
            manifestPath,
            "--store",
            storePath(),
        ],
        workingDirectory: loaded.dir,
        stdoutPath: logs.out,
        stderrPath: logs.err,
        environment: serviceEnvironment(label),
        provenance: [
            `Generated by \`${BRAND.slug} daemon install\` for agent "${agentId}".`,
            "Rewritten on every install — change agent.yaml, not this file.",
            "There are no secrets here and there never will be: `launchctl print` echoes",
            "EnvironmentVariables in plaintext to anything running as this user. The agent",
            "reads its own credentials from the .env beside its manifest.",
        ],
    }

    if (options.dryRun === true) {
        process.stdout.write(renderPlist(plan, BRAND.envPrefix))
        if (findings.length > 0) process.stderr.write(renderFindings(findings))
        return EXIT_OK
    }

    if (findings.length > 0) process.stdout.write(renderFindings(findings))
    mkdirSync(dirname(logs.out), { recursive: true })
    manager?.install(plan)

    process.stdout.write(
        `${agentId} — service installed\n${keyValue([
            { label: "label", value: label },
            { label: "runs", value: `${short(binary.execPath)} … serve ${short(manifestPath)}` },
            { label: "logs", value: short(logs.err) },
            { label: "restarts", value: `on crash only, at most one per ${THROTTLE_SECONDS}s` },
        ])}\n`,
    )
    process.stdout.write(
        `\nA configuration error stops it once rather than looping — \`${BRAND.slug} daemon status ${agentId}\` says why.\nAfter changing agent.yaml or .env: \`${BRAND.slug} daemon restart ${agentId}\`.\n`,
    )
    return EXIT_OK
}

/**
 * Four keys at most, and a throw in `renderPlist` if anything else appears.
 *
 * `PATH` is curated rather than copied from the installing shell — a developer's `$PATH` is full of
 * direnv and version-manager shims that are true for one directory and meaningless to a service.
 * But it must contain *something* useful: launchd's default has no node, bun, git or ripgrep, so an
 * agent whose `exec` works perfectly in the REPL answers "command not found" as a daemon, and the
 * model then invents a workaround rather than reporting a broken environment.
 */
function serviceEnvironment(label: string): Record<string, string> {
    const home = homedir()
    const interpreterDir = dirname(realpathOr(process.execPath))
    const path = [
        interpreterDir,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
        .filter((entry, index, all) => all.indexOf(entry) === index)
        .join(":")

    const env: Record<string, string> = {
        HOME: home,
        PATH: path,
        // Set by the service definition and by nothing else, so `serve` can record "daemon" on its
        // runtime lease as a fact rather than inferring it from `ppid === 1`, which is also true of
        // any orphan.
        [`${BRAND.envPrefix}SERVICE`]: label,
    }
    const sandboxOverride = process.env[`${BRAND.envPrefix}HOME`]
    if (sandboxOverride !== undefined && sandboxOverride !== "") {
        // Without this the service would resolve a different sandbox — and therefore a different
        // store — from the shell that installed it.
        env[`${BRAND.envPrefix}HOME`] = sandboxOverride
    }
    return env
}

function envMode(agentDir: string): number | undefined {
    try {
        return statSync(join(agentDir, ".env")).mode
    } catch {
        return undefined
    }
}

async function servedBy(agentId: string): Promise<Partial<PreflightFacts>> {
    try {
        const store = await SqliteStore.open({ path: storePath() })
        const lease = await store.leases.get(agentId)
        await store.close()
        if (lease === undefined) return {}
        return {
            servedBy: { pid: lease.pid, mode: lease.mode, startedAt: lease.startedAt },
        }
    } catch {
        // No store yet is the normal case for a fresh agent, not an error.
        return {}
    }
}

function installedManifest(unitPath: string | undefined): Partial<PreflightFacts> {
    if (unitPath === undefined || !existsSync(unitPath)) return {}
    const body = readFileSync(unitPath, "utf8")
    const match = /<string>([^<]*agent\.ya?ml)<\/string>/.exec(body)
    return match?.[1] === undefined ? {} : { installedManifest: match[1] }
}

function renderFindings(findings: readonly Finding[]): string {
    return `${findings
        .map(
            (finding) =>
                `${finding.severity === "block" ? "refused" : "warning"}: ${finding.message}\n  hint: ${finding.hint}`,
        )
        .join("\n\n")}\n`
}

// ─── the rest ───────────────────────────────────────────────────────────────────────────

function uninstallAction(
    options: DaemonOptions,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): number {
    const agentId = agentIdOf(options.manifestPath as string)
    const label = labelFor(BRAND.slug, agentId)
    manager?.uninstall(label)
    const logs = logPaths(agentId)
    process.stdout.write(
        `${agentId} — service removed\n${keyValue([
            { label: "label", value: label },
            // Kept deliberately. Removing a service is not a reason to destroy the record of why it
            // was removed, which is very often the reason someone is removing it.
            { label: "logs kept", value: short(logs.err) },
        ])}\n`,
    )
    return EXIT_OK
}

function lifecycleAction(
    action: "start" | "stop" | "restart",
    options: DaemonOptions,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): number {
    const agentId = agentIdOf(options.manifestPath as string)
    const label = labelFor(BRAND.slug, agentId)
    if (manager === undefined) return EXIT_FAILURE
    if (action === "start") manager.start(label)
    if (action === "stop") manager.stop(label)
    if (action === "restart") manager.restart(label)
    const note =
        action === "stop"
            ? " — it stays stopped across a restart or a login until you start it again"
            : ""
    process.stdout.write(`${agentId} — ${action}${action === "stop" ? "ped" : "ed"}${note}\n`)
    return EXIT_OK
}

async function statusAction(
    options: DaemonOptions,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): Promise<number> {
    const ids =
        options.manifestPath === undefined
            ? await installedAgentIds(manager)
            : [agentIdOf(options.manifestPath)]

    if (ids.length === 0) {
        process.stdout.write(
            `no agents are installed as a service\n  hint: \`${BRAND.slug} daemon install <agent>\` keeps one running after you close the terminal.\n`,
        )
        return EXIT_FAILURE
    }

    const reports = await Promise.all(ids.map((id) => gatherStatus(id, manager)))
    /**
     * Agents that are switched off, which no other source here can see.
     *
     * `installedAgentIds` reads service labels and lease rows, and a stopped agent has neither — so
     * without this it is simply **absent** from the status of the thing it belongs to, which is the
     * "I set this up and it is gone" failure the durable switch exists to make explicable. The same
     * reason `listAgents` shows a broken directory rather than skipping it.
     */
    const switchedOff = (await disabledAgents()).filter(
        (entry) => options.manifestPath === undefined || ids.includes(entry.agentId),
    )

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ agents: reports, disabled: switchedOff }, null, 2)}\n`,
        )
    } else {
        for (const report of reports) {
            process.stdout.write(`${renderStatus(report.report)}\n`)
            // Before the log tail and before the fix line, because "running" plus this is the
            // combination someone is actually here to resolve: the service is up and the agent is
            // still not answering them.
            for (const item of report.attention) {
                process.stdout.write(`\n  needs you  ${item.summary}\n             ${item.fix}\n`)
            }
            if (report.report.wantsStderrTail && report.tail !== "") {
                process.stdout.write(`\n  last lines of stderr:\n${indent(report.tail, 4)}\n`)
            }
            // The next command, spelled out. Someone reading this is mid-problem, and the point of
            // stopping once rather than looping is wasted if the way back is a guess.
            if (report.report.verdict === "restart-loop" || report.report.verdict === "failed") {
                process.stdout.write(
                    `\n  fix        correct the error above, then \`${BRAND.slug} daemon restart ${report.agentId}\`\n`,
                )
            }
            process.stdout.write("\n")
        }

        if (switchedOff.length > 0) {
            const count = `${switchedOff.length} ${switchedOff.length === 1 ? "agent" : "agents"}`
            process.stdout.write(`  ${count} switched off, so nothing is hosting them:\n`)
            for (const entry of switchedOff) {
                process.stdout.write(
                    `    ${entry.agentId}${entry.reason === undefined ? "" : ` — ${entry.reason}`}` +
                        `${entry.disabledAt === undefined ? "" : ` (since ${entry.disabledAt})`}\n`,
                )
            }
            process.stdout.write(
                `  \`${BRAND.slug} start <agent>\` switches one back on — a restart alone will not.\n\n`,
            )
        }
    }
    // A switched-off agent is **not** unhealthy: it is in the state somebody asked for, and exiting
    // non-zero over it would make a deliberate stop look like a fault to a monitor.
    //
    // Non-zero when anything is unhealthy. Reporting a restart loop and exiting 0 is the shape hard
    // rule 8 forbids, and it is what makes this usable from a monitor without parsing text.
    return reports.every((report) => report.report.healthy) ? EXIT_OK : EXIT_FAILURE
}

/** Every agent with a `disabled` row, for the status block above. */
async function disabledAgents(): Promise<
    readonly { agentId: string; reason?: string; disabledAt?: string }[]
> {
    try {
        const store = await SqliteStore.open({ path: storePath() })
        try {
            return (await store.agentState.list())
                .filter((state) => !state.enabled)
                .map((state) => ({
                    agentId: state.agentId,
                    ...(state.reason === undefined ? {} : { reason: state.reason }),
                    ...(state.disabledAt === undefined ? {} : { disabledAt: state.disabledAt }),
                }))
        } finally {
            await store.close()
        }
    } catch {
        // No store is the ordinary first-run state, not an error for a status command.
        return []
    }
}

async function installedAgentIds(
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): Promise<readonly string[]> {
    const prefix = `${BRAND.slug}.agent.`
    const fromLaunchd = (manager?.labels(prefix) ?? []).map((label) => label.slice(prefix.length))
    // Plus anything holding a lease, so a `serve` running in a terminal is reported rather than
    // reading as "nothing is running" — the same lie slot 2 was fixed for.
    const leased: string[] = []
    try {
        const store = await SqliteStore.open({ path: storePath() })
        for (const lease of await store.leases.all()) leased.push(lease.agentId)
        await store.close()
    } catch {
        // No store is not an error here.
    }
    return [...new Set([...fromLaunchd, ...leased])].sort()
}

async function gatherStatus(
    agentId: string,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): Promise<{
    agentId: string
    report: ReturnType<typeof summariseStatus>
    tail: string
    attention: readonly Attention[]
}> {
    const label = labelFor(BRAND.slug, agentId)
    const unit = manager?.unitPath(label)
    const state = manager?.state(label)
    const logs = logPaths(agentId)

    let lease: Awaited<ReturnType<SqliteStore["leases"]["get"]>>
    try {
        const store = await SqliteStore.open({ path: storePath() })
        lease = await store.leases.get(agentId)
        await store.close()
    } catch {
        lease = undefined
    }
    // A lease row is a claim, not a fact. A boot that fails *after* claiming — a missing channel
    // token, say — leaves one behind with no process under it, and reporting that as "running in a
    // terminal" is the exact class of lie slot 2 was fixed for: true of a record, false of the
    // moment. The runtime's own liveness probe, so the two cannot disagree about what alive means.
    if (lease !== undefined && !processAlive(lease.pid)) lease = undefined

    const stderrPath = state?.print?.stderrPath ?? logs.err
    const stderrBytes = sizeOf(stderrPath)
    const facts: ServiceFacts = {
        installed: (unit !== undefined && existsSync(unit)) || state?.installed === true,
        disabled: state?.disabled ?? false,
        ...(state?.pid === undefined ? {} : { pid: state.pid }),
        ...(state?.print?.runs === undefined ? {} : { runs: state.print.runs }),
        ...(state?.print?.lastExitCode === undefined
            ? {}
            : { lastExitCode: state.print.lastExitCode }),
        stderrPath: short(stderrPath),
        ...(stderrBytes === undefined ? {} : { stderrBytes }),
        ...(lease === undefined
            ? {}
            : {
                  leasePid: lease.pid,
                  leaseMode: lease.mode,
                  leaseStartedAt: lease.startedAt,
                  uptimeMs: Date.now() - Date.parse(lease.startedAt),
              }),
    }

    const report = summariseStatus(agentId, facts)
    // Read from *stdout*, not stderr: a refused sender is not an error, it is the runtime working
    // exactly as configured — which is why it never reaches the failure path and why a service can
    // be perfectly healthy and completely useless at the same time.
    const attention = attentionFrom(tail(logs.out, 200))

    return {
        agentId,
        report,
        tail: report.wantsStderrTail ? tail(stderrPath, 20) : "",
        attention,
    }
}

async function logsAction(options: DaemonOptions): Promise<number> {
    const agentId = agentIdOf(options.manifestPath as string)
    const logs = logPaths(agentId)
    if (options.truncate === true) {
        // Truncate rather than delete: launchd holds the file descriptor, so removing the file
        // leaves output flowing into a deleted inode — disk consumed, `ls` showing nothing.
        for (const path of [logs.out, logs.err]) {
            try {
                require("node:fs").writeFileSync(path, "")
            } catch {
                // Nothing there yet is fine.
            }
        }
        process.stdout.write(`${agentId} — logs truncated\n`)
        return EXIT_OK
    }
    const body = tail(logs.err, options.lines ?? 40)
    process.stdout.write(body === "" ? `${short(logs.err)} is empty\n` : `${body}\n`)
    if (options.follow !== true) return EXIT_OK

    // Both files, and that is the point of following rather than tailing one.
    //
    // A service can be perfectly healthy and completely useless at the same time: a sender refused by
    // `allowFrom` is the runtime working as configured, so it goes to *stdout* and never reaches the
    // failure path. `status` already reads both for exactly that reason. Somebody watching a log live is
    // watching because they do not trust what they are being told, and giving them half of it is how the
    // 57 MB lesson repeats — a good message in a file nobody opens.
    await followLogs(
        [
            { path: logs.err, label: "stderr" },
            { path: logs.out, label: "stdout" },
        ],
        followIO(),
        {
            // From the end of what was just printed, so nothing is reprinted and nothing that arrived
            // between the tail and the first poll is skipped.
            offsets: { [logs.err]: sizeOf(logs.err) ?? 0, [logs.out]: sizeOf(logs.out) ?? 0 },
            intervalMs: LOG_POLL_MS,
        },
    )
    return EXIT_OK
}

/**
 * The follower's streams, its clock, and its stop condition.
 *
 * `SIGINT` is claimed here and nowhere else in this file, which is safe precisely because
 * `installGuards` deliberately leaves it alone — the chat path owns it, and a guard that exited would
 * break the cancel-the-turn contract. A foreground `--follow` is the one command where ctrl-C means
 * "stop watching", so it handles it itself and removes the listener on the way out.
 */
function followIO(): FollowIO {
    let stop = false
    let wake: (() => void) | undefined
    const onInterrupt = () => {
        stop = true
        // Wakes the pending sleep rather than waiting out the poll interval: a follower that took a
        // third of a second to notice ctrl-C would read as one that ignored it.
        wake?.()
    }
    process.on("SIGINT", onInterrupt)
    onExit(() => {
        process.off("SIGINT", onInterrupt)
    })

    return {
        sizeOf: (path) => sizeOf(path),
        read: (path, from, to) => {
            try {
                const handle = openSync(path, "r")
                try {
                    const buffer = Buffer.alloc(to - from)
                    const read = readSync(handle, buffer, 0, buffer.length, from)
                    return buffer.subarray(0, read).toString("utf8")
                } finally {
                    closeSync(handle)
                }
            } catch {
                // Gone or unreadable between the stat and the read. Nothing to print, and the next poll
                // decides what that means.
                return ""
            }
        },
        write: (text) => void process.stdout.write(text),
        wait: (ms) =>
            new Promise<void>((resolve) => {
                if (stop) {
                    resolve()
                    return
                }
                const timer = setTimeout(resolve, ms)
                wake = () => {
                    clearTimeout(timer)
                    resolve()
                }
            }),
        stopped: () => stop,
    }
}

// ─── small helpers ──────────────────────────────────────────────────────────────────────

/**
 * The manifest's own id, read without expanding env.
 *
 * `readManifestHeader`, never `loadManifest`: `status` and `uninstall` have to work on an agent
 * whose key is not exported, and a service command built on the loader would fail exactly when it
 * is most needed — on the machine where something is already wrong.
 */
function agentIdOf(manifestPath: string): string {
    const header = readManifestHeader(manifestPath)
    if (header.id === undefined || header.id === "") {
        throw new HarnessError({
            code: "cli_daemon_agent_id_missing",
            message: `${manifestPath} declares no id, so there is no stable name to install a service under.`,
            hint: "A service label is derived from the manifest id and has to survive a rename of the directory. Add `id: <name>` to the manifest.",
        })
    }
    return header.id
}

function short(path: string): string {
    return tildify(resolve(path), homedir())
}

function sizeOf(path: string): number | undefined {
    try {
        return statSync(path).size
    } catch {
        return undefined
    }
}

function tail(path: string, lines: number): string {
    try {
        const body = readFileSync(path, "utf8").trimEnd()
        if (body === "") return ""
        return body.split("\n").slice(-lines).join("\n")
    } catch {
        return ""
    }
}

/** Re-exported so the boundaries test can assert this module carries no renderer import. */
export const DAEMON_ENV_ALLOWED = plistEnvAllowed(BRAND.envPrefix)
export const DAEMON_LOOPBACK = isLoopbackHost
export const DAEMON_BYTES = bytes
