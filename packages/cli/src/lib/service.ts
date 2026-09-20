/**
 * The service-manager seam, and the only place in this package that spawns a subprocess.
 *
 * Deliberately thin. Every decision lives in `daemon-plan.ts` and every string transformation in
 * `launchd.ts` and `systemd.ts`, all pure; what is left here is "run the manager and hand back what
 * it said", which is the part no test should be exercising against a real machine. `Exec` is
 * injectable for that reason — the daemon tests drive a fake and never touch the user's
 * `~/Library/LaunchAgents`.
 *
 * ## Linux is supported as far as it can be proven, and says where that ends
 *
 * This file used to refuse Linux outright, on the argument that *"a systemd renderer nobody here
 * can execute would be a liability: wrong in ways no test catches, shipped with an acceptance
 * criterion that could not honestly be ticked."* Half of that expired when the product became a
 * server — Linux is where one runs — and half did not: a container has no systemd (PID 1 is the
 * entrypoint) and `systemctl --user` on a CI runner has no D-Bus user session, so nothing here can
 * drive the lifecycle verbs end to end.
 *
 * So the line is drawn by what is provable. `SystemdManager` **writes a real unit** — the text is
 * pure and fully tested — and its lifecycle verbs throw a refusal carrying the exact command
 * instead of pretending. `install` reports the two commands to run. An install that claimed success
 * while nothing was running is the failure this whole phase exists to remove, and that is the one
 * thing a half-built manager must not do.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { HarnessError } from "@dispach/core"
import {
    EXIT_TIMEOUT_SECONDS,
    type PrintFacts,
    parseDisabled,
    parseLaunchctlList,
    parseLaunchctlPrint,
    renderPlist,
    type ServicePlan,
} from "#lib/launchd"
import { spawnCapture } from "#lib/spawn"
import { renderUnit, followUp as systemdFollowUp, unitPath as systemdUnitPath } from "#lib/systemd"

export interface ExecResult {
    readonly code: number
    readonly stdout: string
    readonly stderr: string
}
export type Exec = (command: string, args: readonly string[]) => ExecResult

export interface ServiceState {
    readonly installed: boolean
    readonly disabled: boolean
    readonly print?: PrintFacts
    readonly pid?: number
    /**
     * `false` when this manager cannot say whether the unit is *running*.
     *
     * True for launchd, which is read through `launchctl print`. False for systemd, where the
     * lifecycle is not driven from here — so `installed` there means "the unit file exists" and
     * nothing more, and a caller must fall back to the lease table rather than reporting a written
     * file as a running server.
     */
    readonly liveness: boolean
}

export interface ServiceManager {
    readonly id: string
    unitPath(label: string): string
    install(plan: ServicePlan): void
    uninstall(label: string): void
    stop(label: string): void
    start(label: string): void
    restart(label: string): void
    state(label: string): ServiceState
    /** Every label this manager knows about that belongs to us, for a bare `status`. */
    labels(prefix: string): readonly string[]
    /**
     * Commands the person must run themselves after `install`, in order. Empty for launchd.
     *
     * The honest half of a manager that writes a unit and does not start it. Returned rather than
     * printed here so the caller decides where it goes — and returned rather than omitted so the
     * difference between the two platforms is in the type, where it cannot be forgotten.
     */
    followUp(label: string): readonly string[]
    /**
     * A platform-specific caution worth printing, or `undefined`.
     *
     * Exists for exactly one thing today: a systemd **user** unit stops when the user's last
     * session ends unless lingering is enabled for the account — so an always-on server installed
     * over SSH is gone when the connection closes. That is launchd's `disable` trap in a different
     * costume, and the cure is the same: say it where somebody is looking.
     */
    caution(): string | undefined
}

/**
 * How long to wait for a `bootout` to complete before bootstrapping over it.
 *
 * Generous relative to what it costs: a reinstall is a command somebody is watching, and the
 * failure being avoided is a unit that silently does not load. Well under `ExitTimeOut`, because a
 * job taking the full 30 s to die is a job with a problem of its own and the post-install check
 * will say so.
 */
const SETTLE_MS = 6_000
const SETTLE_POLL_MS = 200

const realExec: Exec = (command, args) => {
    const result = spawnCapture({ command, args })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

export interface ManagerOptions {
    readonly home: string
    readonly uid: number
    readonly envPrefix: string
    readonly exec?: Exec
    /** For `XDG_CONFIG_HOME` and `USER`. Injectable so a test needs no real environment. */
    readonly env?: Readonly<Record<string, string | undefined>>
}

export function resolveServiceManager(platform: string, options: ManagerOptions): ServiceManager {
    if (platform === "darwin") return new LaunchdManager(options)
    if (platform === "linux") return new SystemdManager(options)
    throw unsupported(platform)
}

/**
 * Whether this platform's manager can *start* what it installs.
 *
 * Read by the first-run bootstrap, which must not install something it cannot start and then
 * report a running server: on Linux it prints the command instead. A predicate rather than a
 * `platform === "darwin"` test at the call site, so adding a manager that can execute does not
 * mean finding every place that assumed one could not.
 */
export function managerCanStart(platform: string): boolean {
    return platform === "darwin"
}

/**
 * The refusal, with the workaround's hard part already solved.
 *
 * Filled in by the caller, which knows the resolved paths — a message naming `ExecStart=` with real
 * absolute values is worth more than a paragraph explaining that they matter.
 */
export function unsupported(platform: string, execStart?: string): HarnessError {
    const recipe =
        execStart === undefined
            ? ""
            : ` For a systemd user unit, the line to write is:\n\n      ${execStart}\n      Restart=on-failure\n      RestartSec=30\n\n    Put no secrets in the unit: the agent reads the .env beside its manifest, and \`systemctl show\` echoes Environment= to anyone.`
    return new HarnessError({
        code: "daemon_platform_unsupported",
        message: `daemon installs a macOS LaunchAgent or a systemd user unit, and this platform is ${platform}.`,
        hint: `No service manager is implemented for this platform.${recipe} In a container, run \`serve\` in the foreground and let the container runtime supervise it; that is the deployment this runtime is designed around.`,
    })
}

/**
 * Writes a real systemd user unit. Does not start it — see the file comment.
 *
 * Every lifecycle verb throws a refusal carrying the exact command, which is the honest shape: a
 * manager that swallowed `start` would make `daemon install` report a running server on a platform
 * where nothing had been started, and that is the one failure this phase exists to remove.
 */
class SystemdManager implements ServiceManager {
    readonly id = "systemd"
    readonly #home: string
    readonly #envPrefix: string
    readonly #exec: Exec
    readonly #env: Readonly<Record<string, string | undefined>>

    constructor(options: ManagerOptions) {
        this.#home = options.home
        this.#envPrefix = options.envPrefix
        this.#exec = options.exec ?? realExec
        this.#env = options.env ?? process.env
    }

    unitPath(label: string): string {
        return systemdUnitPath(label, this.#home, this.#env)
    }

    install(plan: ServicePlan): void {
        const path = this.unitPath(plan.label)
        // Rendered before anything is written, because that is where the no-secrets rule is
        // enforced — the same ordering `LaunchdManager.install` has, for the same reason.
        const body = renderUnit(plan, this.#envPrefix)
        mkdirSync(dirname(path), { recursive: true })
        // 0600 is not the protection — `systemctl show` echoes `Environment=` whatever the mode —
        // but there is no reason for it to be readable.
        writeFileSync(path, body, { encoding: "utf8", mode: 0o600 })
    }

    uninstall(label: string): void {
        // The file only. Disabling it is the person's command, and saying so is better than a
        // silent half-removal that leaves `systemctl --user` still listing a unit we deleted.
        rmSync(this.unitPath(label), { force: true })
    }

    stop(label: string): void {
        throw this.#manual(`systemctl --user stop ${label}`)
    }

    start(label: string): void {
        throw this.#manual(`systemctl --user start ${label}`)
    }

    restart(label: string): void {
        throw this.#manual(`systemctl --user restart ${label}`)
    }

    /**
     * Whether the unit file exists, and nothing more.
     *
     * `liveness: false` is the load-bearing field. Without it a caller would read `installed: true`
     * as "running" and report a written file as a live server — so every surface that needs to know
     * whether something is actually up falls back to the lease table, which is a fact about a
     * process rather than about a file.
     */
    state(label: string): ServiceState {
        return { installed: existsSync(this.unitPath(label)), disabled: false, liveness: false }
    }

    labels(prefix: string): readonly string[] {
        // Read from the directory rather than from `systemctl list-units`, which needs the session
        // bus this manager deliberately does not depend on.
        try {
            return readdirSync(dirname(this.unitPath(prefix)))
                .filter((name) => name.startsWith(prefix) && name.endsWith(".service"))
                .map((name) => name.slice(0, -".service".length))
                .sort()
        } catch {
            // No unit directory yet is the ordinary state before a first install.
            return []
        }
    }

    followUp(label: string): readonly string[] {
        return systemdFollowUp(label, this.#user())
    }

    /**
     * The lingering warning, and only when lingering is actually off.
     *
     * `loginctl show-user` is a **read**, which is why executing it here does not contradict this
     * manager not driving the lifecycle — and a missing or failing `loginctl` returns the warning
     * rather than suppressing it, because the direction that matters is not silently reassuring
     * somebody that their service will survive a logout.
     */
    caution(): string | undefined {
        const user = this.#user()
        const result = this.#exec("loginctl", ["show-user", user, "--property=Linger"])
        if (result.code === 0 && /Linger=yes/i.test(result.stdout)) return undefined
        return `A systemd user unit stops when your last session ends. \`loginctl enable-linger ${user}\` is what keeps it running after you log out or close an SSH connection.`
    }

    #user(): string {
        return this.#env.USER ?? this.#env.LOGNAME ?? basename(this.#home)
    }

    #manual(command: string): HarnessError {
        return new HarnessError({
            code: "daemon_manual_step",
            message: `This has to be run yourself: ${command}`,
            hint: `Unit files are written and read from here, and the lifecycle is not driven from here — nothing in this project's test environment can run \`systemctl --user\` (a container has no systemd, and a CI runner has no user session bus), and a command that reported success while nothing happened would be worse than this sentence. The unit is at ${this.unitPath(command.split(" ").pop() ?? "")}.`,
        })
    }
}

class LaunchdManager implements ServiceManager {
    readonly id = "launchd"
    readonly #home: string
    readonly #domain: string
    readonly #envPrefix: string
    readonly #exec: Exec

    constructor(options: ManagerOptions) {
        this.#home = options.home
        this.#domain = `gui/${options.uid}`
        this.#envPrefix = options.envPrefix
        this.#exec = options.exec ?? realExec
    }

    unitPath(label: string): string {
        return join(this.#home, "Library", "LaunchAgents", `${label}.plist`)
    }

    install(plan: ServicePlan): void {
        const path = this.unitPath(plan.label)
        // Rendered before anything is written, because `renderPlist` is where the no-secrets rule
        // is enforced — a throw must not leave a half-installed service behind.
        const body = renderPlist(plan, this.#envPrefix)

        mkdirSync(dirname(path), { recursive: true })
        mkdirSync(dirname(plan.stdoutPath), { recursive: true })

        // Unload an existing copy first; `bootstrap` over a loaded job is an error, not an update.
        this.#launchctl(["bootout", `${this.#domain}/${plan.label}`], { tolerate: true })
        /**
         * **Wait for the unload to finish.** `bootout` returns before the job is gone.
         *
         * Found by reinstalling over a *running* server: the bootout returned 0, the immediate
         * bootstrap also returned 0, and nothing was loaded afterwards — the command reported
         * "service installed" while `launchctl print` could not find the service at all. launchd's
         * own vocabulary for this is code 37, "operation now in progress", which it does not always
         * bother to produce.
         *
         * A first install has nothing to wait for and this returns immediately, which is why it
         * went unnoticed: the bug needs an existing *running* job, and the tests use a fake `Exec`.
         */
        this.#settle(plan.label)
        // 0600 is not the protection — `launchctl print` reads a loaded job's environment whatever
        // the file mode — but there is no reason for it to be readable and OpenClaw's is 0644.
        writeFileSync(path, body, { encoding: "utf8", mode: 0o600 })
        // Before bootstrap, and not optional: `disable` state persists across boots, so a service
        // that was once `daemon stop`ped would install cleanly here and then silently never start.
        this.#launchctl(["enable", `${this.#domain}/${plan.label}`], { tolerate: true })
        this.#launchctl(["bootstrap", this.#domain, path])

        /**
         * And check it is really there, because "installed" is a claim about a *running* job.
         *
         * The whole objection this project has to the service it replaces is that nobody was ever
         * told — so an install that cannot demonstrate a loaded job has to say so rather than print
         * four tidy rows about a unit launchd never took.
         */
        if (!this.state(plan.label).installed) {
            throw new HarnessError({
                code: "daemon_not_loaded",
                message: `${plan.label} was written to ${path} but launchd did not load it.`,
                hint: `\`launchctl bootstrap\` returned success and \`launchctl print ${this.#domain}/${plan.label}\` finds nothing, which usually means an earlier copy was still unloading. Try again in a moment. Over SSH with no desktop session the ${this.#domain} domain is unavailable and no LaunchAgent can load at all.`,
            })
        }
    }

    /**
     * Block until this label is no longer loaded, or until the budget runs out.
     *
     * A synchronous wait because `install` is synchronous, and making it async would ripple through
     * four callers for a path that runs once. `Atomics.wait` on a throwaway buffer is the standard
     * way to sleep a thread without a busy loop burning CPU while launchd works.
     *
     * Bounded, and silent when the budget runs out: the post-install check above is what reports a
     * failure, and it reports it with evidence rather than as a timeout nobody can act on.
     */
    #settle(label: string): void {
        const deadline = Date.now() + SETTLE_MS
        while (Date.now() < deadline) {
            if (this.#exec("launchctl", ["print", `${this.#domain}/${label}`]).code !== 0) return
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLE_POLL_MS)
        }
    }

    uninstall(label: string): void {
        this.#launchctl(["bootout", `${this.#domain}/${label}`], { tolerate: true })
        // Re-enabled on the way out so a future install is not gated on a disable nobody remembers.
        this.#launchctl(["enable", `${this.#domain}/${label}`], { tolerate: true })
        rmSync(this.unitPath(label), { force: true })
    }

    stop(label: string): void {
        // Disable *and* unload. `bootout` alone stops it now and launchd loads it again at the next
        // login — the "I stopped it and it was back after lunch" surprise.
        this.#launchctl(["disable", `${this.#domain}/${label}`], { tolerate: true })
        this.#launchctl(["bootout", `${this.#domain}/${label}`], { tolerate: true })
    }

    start(label: string): void {
        this.#launchctl(["enable", `${this.#domain}/${label}`], { tolerate: true })
        this.#launchctl(["bootstrap", this.#domain, this.unitPath(label)])
    }

    restart(label: string): void {
        this.#launchctl(["kickstart", "-k", `${this.#domain}/${label}`])
    }

    state(label: string): ServiceState {
        const print = this.#exec("launchctl", ["print", `${this.#domain}/${label}`])
        const disabled = parseDisabled(
            this.#exec("launchctl", ["print-disabled", this.#domain]).stdout,
        ).includes(label)

        if (print.code !== 0) {
            // Not loaded. The plist may still exist on disk — a stopped service is exactly that —
            // so "installed" is a question for the caller, which can see the file.
            return { installed: false, disabled, liveness: true }
        }
        const facts = parseLaunchctlPrint(print.stdout)
        return {
            installed: true,
            disabled,
            liveness: true,
            print: facts,
            ...(facts.pid === undefined ? {} : { pid: facts.pid }),
        }
    }

    /**
     * Every label of ours, from **both** the loaded jobs and the plist directory.
     *
     * `launchctl list` alone was wrong, and wrong in the worst direction: **a disabled job is simply
     * absent from it**, which is the recorded trap this file already documents for `status` — and a
     * disabled per-agent unit is precisely the one whose retirement matters, because its `disable`
     * row persists across boots and no verb deletes it. So a bare `daemon install` found nothing to
     * retire on the one machine that had two of them, reported success, and left the rows behind.
     * Found by running the real install against a real `~/Library/LaunchAgents`, not by a test.
     *
     * The directory is authoritative for "a definition exists" and the list is authoritative for
     * "it is loaded"; retirement needs the union, because a unit that is either is a unit to remove.
     */
    labels(prefix: string): readonly string[] {
        const loaded = parseLaunchctlList(this.#exec("launchctl", ["list"]).stdout)
            .map((entry) => entry.label)
            .filter((label) => label.startsWith(prefix))
        let onDisk: string[] = []
        try {
            onDisk = readdirSync(join(this.#home, "Library", "LaunchAgents"))
                .filter((name) => name.startsWith(prefix) && name.endsWith(".plist"))
                .map((name) => name.slice(0, -".plist".length))
        } catch {
            // No LaunchAgents directory yet is the ordinary state before a first install.
        }
        return [...new Set([...loaded, ...onDisk])].sort()
    }

    /** None: `install` bootstraps the job itself, so there is nothing left for anybody to run. */
    followUp(): readonly string[] {
        return []
    }

    /** None. A LaunchAgent's survival across a login is `RunAtLoad`, which the plist carries. */
    caution(): string | undefined {
        return undefined
    }

    #launchctl(args: readonly string[], options: { tolerate?: boolean } = {}): ExecResult {
        const result = this.#exec("launchctl", args)
        if (result.code === 0 || options.tolerate === true) return result
        // launchctl's own stderr, verbatim. Its messages are terse — "Bootstrap failed: 5:
        // Input/output error" — and paraphrasing loses the code, which is the only searchable part.
        throw new HarnessError({
            code: "daemon_launchctl_failed",
            message: `launchctl ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || "no output"}`,
            hint: `Code 5 usually means the service is already loaded — try \`daemon restart\`. Code 37 means an operation is still in progress; wait a moment. Code 125 or 112 means the ${this.#domain} domain is unavailable, which happens over SSH with no GUI session: a LaunchAgent needs a logged-in desktop session, and the exit timeout is ${EXIT_TIMEOUT_SECONDS}s.`,
        })
    }
}
