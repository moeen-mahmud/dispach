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
import { BRAND, HarnessError, processAlive, readManifestHeader, SqliteStore } from "@dispach/core"
import { EXIT_FAILURE, EXIT_OK, LOG_POLL_MS } from "#lib/const"
import {
    type Attention,
    agentFindings,
    attentionFrom,
    type BinaryFacts,
    type Finding,
    isLoopbackHost,
    renderStatus,
    type ServiceFacts,
    serverFindings,
    summariseStatus,
} from "#lib/daemon-plan"
import { onExit } from "#lib/exit"
import {
    plistEnvAllowed,
    renderPlist,
    type ServicePlan,
    serverLabel,
    THROTTLE_SECONDS,
} from "#lib/launchd"
import { liveHosts } from "#lib/lifecycle"
import { type FollowIO, followLogs } from "#lib/log-follow"
import { bytes, indent, keyValue, tildify } from "#lib/render"
import { listAgents, logPaths, sandboxRoot, serverLogPaths, storePath } from "#lib/sandbox"
import { isCompiledBinary } from "#lib/self"
import { type Exec, resolveServiceManager, unsupported } from "#lib/service"
import { renderUnit } from "#lib/systemd"

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
    /** For the sandbox root and `XDG_CONFIG_HOME`. Injectable so a test needs no real HOME. */
    readonly env?: Readonly<Record<string, string | undefined>>
    /** The database to read leases from. Defaults to the sandbox's. */
    readonly store?: string
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

    /**
     * **Naming an agent is retired for every verb that installs or moves a unit.**
     *
     * One service hosts every agent now, so a per-agent unit is not a smaller version of this — it
     * is a second host claiming the same leases, which would leave the server reporting those
     * agents as served elsewhere indefinitely with nothing looking wrong. Refused rather than
     * silently reinterpreted, because a command that does something materially different from what
     * it says is worse than one that stops.
     *
     * `status` and `logs` still take one: those are questions about an agent rather than
     * instructions about a unit.
     */
    if (options.manifestPath !== undefined && action !== "status" && action !== "logs") {
        throw new HarnessError({
            code: "daemon_per_agent_retired",
            message: `daemon ${action} no longer takes an agent — one service hosts every agent.`,
            hint: `\`${BRAND.slug} daemon ${action}\` acts on that one service. Per-agent on/off is \`${BRAND.slug} stop <agent>\` and \`${BRAND.slug} start <agent>\`, which persist in the store rather than as a unit — so an agent you switch off stays off across a restart without the host going down with it.`,
        })
    }

    const platform = options.platform ?? process.platform
    const binary = binaryFacts()

    // The platform check runs *after* the paths are resolved, so the refusal can hand over the
    // ExecStart line rather than only naming the gap. `darwin` and `linux` both have a manager now;
    // anything else still refuses, and `status` answers from the lease alone everywhere.
    if (platform !== "darwin" && platform !== "linux" && action !== "status") {
        throw unsupported(platform, execStartLine(binary, options.manifestPath ?? "<manifest>"))
    }

    const manager =
        platform === "darwin" || platform === "linux"
            ? resolveServiceManager(platform, {
                  home: homedir(),
                  uid: process.getuid?.() ?? 0,
                  envPrefix: BRAND.envPrefix,
                  ...(options.exec === undefined ? {} : { exec: options.exec }),
                  ...(options.env === undefined ? {} : { env: options.env }),
              })
            : undefined

    switch (action) {
        case "status":
            return await statusAction(options, manager)
        case "install":
            return await serverInstallAction(options, binary, manager)
        case "uninstall":
            return uninstallAction(options, manager)
        case "start":
        case "stop":
        case "restart":
            return lifecycleAction(action, manager)
        case "logs":
            return await logsAction(options)
    }
}

/**
 * Install **the** server unit: one process, hosting whatever the sandbox holds and has not stopped.
 *
 * No manifest anywhere in the plan, which is the change. `serve` with no argument reads the sandbox
 * at every start, so an agent provisioned tomorrow is hosted without touching the unit — where a
 * per-agent unit had to be installed per agent and could never host one that did not exist yet.
 *
 * Retirement happens **before** the install and is reported: a per-agent unit left beside this one
 * claims the same leases. `bootout` + `enable` + `rm`, in that order, because `launchctl enable` is
 * the only thing that clears an orphaned `disable` row and no verb deletes it — a label left
 * disabled makes a future job with that name install cleanly and silently never start.
 */
async function serverInstallAction(
    options: DaemonOptions,
    binary: BinaryFacts,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): Promise<number> {
    const label = serverLabel(BRAND.slug)
    const logs = serverLogPaths(options.env)
    const retiring = (manager?.labels(`${BRAND.slug}.agent.`) ?? []).filter(
        (found) => found !== label,
    )
    const findings = [
        ...serverFindings({
            binary,
            retiring,
            servedElsewhere: (await liveHosts(options.store)).map((lease) => ({
                agentId: lease.agentId,
                pid: lease.pid,
                mode: lease.mode,
            })),
        }),
        /**
         * Plus each agent's own, which is how "per-agent findings stay per-agent" survives the
         * per-agent install being retired: they are still facts about one agent, reported by the
         * one install that exists. Read from the **header**, never a full load — a listing must not
         * depend on any agent's credentials being present, and this one runs over every agent in
         * the sandbox, so a single missing key would otherwise break the install of the host that
         * serves all the others.
         */
        ...listAgents(options.env).flatMap((agent) => {
            // Read once. `exactOptionalPropertyTypes` cannot narrow a second call, and a doubled
            // `statSync` per agent is a filesystem call for nothing.
            const mode = envMode(agent.dir)
            return agentFindings({
                agentId: agent.id ?? agent.ref,
                agentDir: agent.dir,
                ...(agent.problem === undefined ? {} : { problem: agent.problem }),
                ...(mode === undefined ? {} : { envFileMode: mode }),
            })
        }),
    ]

    const plan: ServicePlan = {
        label,
        // **No manifest.** The sandbox is the inventory, read at every start.
        // `scriptPath` is empty for a compiled binary, which is the whole command on its own —
        // filtered rather than conditionally spread so there is one expression to read.
        programArguments: [
            binary.execPath,
            binary.scriptPath,
            "serve",
            "--store",
            storePath(),
        ].filter((argument) => argument !== ""),
        // The sandbox root rather than an agent's directory: there is no single agent here, and a
        // cwd that *is* an agent directory makes that agent's `.env` a layer in every other
        // agent's environment (decision 11.210).
        workingDirectory: sandboxRoot(options.env),
        stdoutPath: logs.out,
        stderrPath: logs.err,
        environment: serviceEnvironment(label),
        provenance: [
            `Generated by \`${BRAND.slug} daemon install\`. One service hosts every agent.`,
            "Rewritten on every install — it names no agent, so there is nothing here to edit",
            "when you add one. Switch an agent off with `stop <agent>`, which persists.",
            "There are no secrets here and there never will be: a service manager echoes a",
            "unit's environment in plaintext to anything running as this user. Each agent",
            "reads its own credentials from the .env beside its manifest.",
        ],
    }

    if (options.dryRun === true) {
        process.stdout.write(
            manager?.id === "systemd"
                ? renderUnit(plan, BRAND.envPrefix)
                : renderPlist(plan, BRAND.envPrefix),
        )
        if (findings.length > 0) process.stderr.write(renderFindings(findings))
        return EXIT_OK
    }

    for (const old of retiring) manager?.uninstall(old)
    if (findings.length > 0) process.stdout.write(renderFindings(findings))

    mkdirSync(dirname(logs.out), { recursive: true })
    manager?.install(plan)

    const followUp = manager?.followUp(label) ?? []
    process.stdout.write(
        `${label} — ${followUp.length === 0 ? "service installed" : "unit written"}\n${keyValue([
            { label: "runs", value: `${short(binary.execPath)} … serve` },
            { label: "hosts", value: "every agent in the sandbox that is not stopped" },
            { label: "logs", value: short(logs.err) },
            { label: "restarts", value: `on crash only, at most one per ${THROTTLE_SECONDS}s` },
        ])}\n`,
    )
    if (followUp.length > 0) {
        // The honest half of a manager that writes a unit and does not start it. Numbered, because
        // the order matters and because an unnumbered list of two commands reads as alternatives.
        process.stdout.write(
            `\nNot started yet — run these:\n${followUp
                .map((command, index) => `  ${index + 1}. ${command}`)
                .join("\n")}\n`,
        )
    }
    const caution = manager?.caution()
    if (caution !== undefined) process.stdout.write(`\n${caution}\n`)

    process.stdout.write(
        `\nA configuration error stops it once rather than looping — \`${BRAND.slug} daemon status\` says why.\n`,
    )
    return EXIT_OK
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
    // A compiled binary has no script: `argv[1]` is a `/$bunfs/` path that no process can execute,
    // and `realpath` on it returns it unchanged rather than failing, so the plist would look fine.
    const scriptPath = isCompiledBinary() ? "" : realpathOr(process.argv[1] ?? "")
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
    const label = serverLabel(BRAND.slug)
    const logs = serverLogPaths(options.env)
    // Retired per-agent units go too. Somebody uninstalling the host is not leaving one of those
    // behind on purpose, and a `disable` row it leaves is permanent.
    for (const old of (manager?.labels(`${BRAND.slug}.agent.`) ?? []).filter((l) => l !== label)) {
        manager?.uninstall(old)
        process.stdout.write(`  also removed ${old}\n`)
    }
    manager?.uninstall(label)
    process.stdout.write(
        `${label} — service removed\n${keyValue([
            // Kept deliberately. Removing a service is not a reason to destroy the record of why it
            // was removed, which is very often the reason someone is removing it.
            { label: "logs kept", value: short(logs.err) },
            // Said out loud: the agents are *not* stopped. Their `agent_state` rows are untouched,
            // so reinstalling brings back exactly what was running — and an agent switched off with
            // `stop` is still off. Removing a unit must not quietly become removing configuration.
            { label: "agents", value: "unchanged — nothing was switched off" },
        ])}\n`,
    )
    return EXIT_OK
}

function lifecycleAction(
    action: "start" | "stop" | "restart",
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): number {
    const label = serverLabel(BRAND.slug)
    if (manager === undefined) return EXIT_FAILURE
    if (action === "start") manager.start(label)
    if (action === "stop") manager.stop(label)
    if (action === "restart") manager.restart(label)
    const note =
        action === "stop"
            ? " — the whole host. It stays stopped across a login until you start it again, and no" +
              " agent was switched off"
            : ""
    process.stdout.write(`${label} — ${action}${action === "stop" ? "ped" : "ed"}${note}\n`)
    return EXIT_OK
}

async function statusAction(
    options: DaemonOptions,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
): Promise<number> {
    /**
     * Bare reports **the unit**; naming an agent reports that agent.
     *
     * Two different questions since one service hosts everything, and the bare form used to answer
     * the wrong one: it listed per-agent labels, so after 16.4 it said "no agents are installed as
     * a service" on a machine with a healthy server unit running — and pointed at the retired
     * `daemon install <agent>` to fix it.
     */
    const label = serverLabel(BRAND.slug)
    const hosts = await liveHosts(options.store)

    if (options.manifestPath === undefined) {
        const unitInstalled = manager?.state(label).installed === true
        if (!unitInstalled && hosts.length === 0) {
            process.stdout.write(
                `no server is installed and nothing is running\n  hint: \`${BRAND.slug} daemon install\` keeps one running after you close the terminal. One service hosts every agent.\n`,
            )
            return EXIT_FAILURE
        }
    }

    const ids = options.manifestPath === undefined ? [label] : [agentIdOf(options.manifestPath)]

    const reports = await Promise.all(
        ids.map((id) =>
            gatherStatus(id, manager, {
                // The unit has a label and the server's own log; an agent has neither, and its
                // liveness is the lease's to report.
                ...(id === label ? { label } : {}),
                logs: id === label ? serverLogPaths(options.env) : logPaths(id),
                ...(options.store === undefined ? {} : { store: options.store }),
                // The unit holds one lease per agent it serves, so any of them is evidence that
                // *this* process is up — and the first is as good as any for an uptime.
                ...(id === label && hosts[0] !== undefined ? { leaseOf: hosts[0].agentId } : {}),
            }),
        ),
    )

    // What the unit is actually hosting, which no service manager can say. Printed before the
    // switched-off list below, so "3 agents, 1 disabled" reads as one thought.
    const hosted =
        options.manifestPath === undefined && hosts.length > 0
            ? hosts.map((lease) => lease.agentId).sort()
            : []
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
            `${JSON.stringify({ agents: reports, hosting: hosted, disabled: switchedOff }, null, 2)}\n`,
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

        if (hosted.length > 0) {
            process.stdout.write(
                `  hosting ${hosted.length} ${hosted.length === 1 ? "agent" : "agents"}: ${hosted.join(", ")}\n`,
            )
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

/**
 * One status report, for the server unit or for one agent.
 *
 * The label and the log paths are arguments rather than derived from `agentId`, which is what lets
 * the *unit* and an *agent* share this: there is one unit and many agents, so a function that
 * computed `labelFor(slug, agentId)` could only ever describe the retired per-agent shape.
 *
 * When `label` is absent there is no unit to ask about — that is an agent, whose liveness is the
 * lease's to report, and `installed: false` is then the honest answer rather than a gap.
 */
async function gatherStatus(
    agentId: string,
    manager: ReturnType<typeof resolveServiceManager> | undefined,
    options: {
        readonly label?: string
        readonly logs: { readonly out: string; readonly err: string }
        readonly store?: string
        /** The lease to read liveness from. The unit's own is whichever agent it happens to hold. */
        readonly leaseOf?: string
    },
): Promise<{
    agentId: string
    report: ReturnType<typeof summariseStatus>
    tail: string
    attention: readonly Attention[]
}> {
    const label = options.label
    const unit = label === undefined ? undefined : manager?.unitPath(label)
    const state = label === undefined ? undefined : manager?.state(label)
    const logs = options.logs

    let lease: Awaited<ReturnType<SqliteStore["leases"]["get"]>>
    try {
        const store = await SqliteStore.open({ path: options.store ?? storePath() })
        lease = await store.leases.get(options.leaseOf ?? agentId)
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

/**
 * The host's log, or one agent's — and naming an agent is now the *unusual* form.
 *
 * One service means one log, so bare is the normal case. An agent is still accepted because the
 * per-agent files exist on any machine that ran a per-agent unit before 16.4, and a command that
 * refused to show a log somebody is looking for would be worse than one that shows an old file.
 */
async function logsAction(options: DaemonOptions): Promise<number> {
    const named = options.manifestPath === undefined ? undefined : agentIdOf(options.manifestPath)
    const agentId = named ?? serverLabel(BRAND.slug)
    const logs = named === undefined ? serverLogPaths(options.env) : logPaths(named)
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
