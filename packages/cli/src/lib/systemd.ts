/**
 * The systemd user unit: rendered and written here, enabled by two commands the person runs.
 *
 * ## Why this stops short of running `systemctl`
 *
 * `service.ts` refused Linux entirely on the argument that *"a systemd renderer nobody here can
 * execute would be a liability: wrong in ways no test catches, shipped with an acceptance criterion
 * that could not honestly be ticked."* Half of that argument has expired — Linux is the platform a
 * server runs on — and half has not: a container has no systemd (PID 1 is the entrypoint) and
 * `systemctl --user` on a CI runner has no D-Bus user session, so nothing in this project's test
 * environment can drive the lifecycle verbs end to end.
 *
 * So the split is by what can be *proven*. The unit text is pure and fully tested; writing a file
 * is ordinary I/O; and `enable --now` is printed rather than executed, because an install that
 * reports success while nothing runs is the failure mode this whole phase exists to remove. Two
 * commands is a worse experience than one and an honest one.
 *
 * ## `enable-linger` is not a footnote
 *
 * A systemd *user* unit is stopped when the user's last session ends, unless lingering is enabled
 * for that account. Without it, an always-on agent server installed over SSH is gone the moment the
 * connection closes — which is precisely launchd's `disable` trap in a different costume: installs
 * cleanly, reports success, and is not there later. So the line is printed with the reason attached,
 * and `daemon status` warns when lingering is off.
 *
 * ## What is deliberately the same as launchd
 *
 * `Restart=on-failure` mirrors `KeepAlive: {Crashed: true}` and `RestartSec` mirrors
 * `ThrottleInterval`: a configuration fault must stop once rather than retry into a log nobody
 * opens, which is the 57 MB lesson. `TimeoutStopSec` mirrors `ExitTimeOut`, and must exceed the
 * runtime's own stop deadline or the reaper that kills backgrounded `exec` children never finishes.
 * And the environment goes through the same `assertNoSecrets` — `systemctl show` echoes
 * `Environment=` exactly as `launchctl print` echoes `EnvironmentVariables`.
 */

import { join } from "node:path"
import { EXIT_TIMEOUT_SECONDS, type ServicePlan, THROTTLE_SECONDS } from "#lib/launchd"
import { assertNoSecrets } from "#lib/service-env"

/** `~/.config/systemd/user/<label>.service`, honouring `XDG_CONFIG_HOME` when it is set. */
export function unitPath(
    label: string,
    home: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
): string {
    const configHome = env.XDG_CONFIG_HOME
    const base = configHome === undefined || configHome === "" ? join(home, ".config") : configHome
    return join(base, "systemd", "user", `${label}.service`)
}

/**
 * Escape a value for a systemd unit.
 *
 * Nothing like XML escaping: systemd's parser treats a value as literal to end of line, so the only
 * thing that can break a line is a **newline**. A path containing one is refused rather than
 * silently truncated — a unit whose `ExecStart` stops halfway is a service that runs the wrong
 * command, which is worse than a command that fails here.
 */
export function assertUnitSafe(value: string, field: string): void {
    if (/[\r\n]/.test(value)) {
        throw new Error(
            `${field} contains a newline, which systemd cannot express. hint: a unit value runs to end of line, so this would silently truncate rather than fail — rename the path.`,
        )
    }
}

/**
 * Quote one `ExecStart` argument.
 *
 * systemd splits `ExecStart` on whitespace, so a path with a space in it becomes two arguments —
 * and a sandbox under `/Users/Some Name/` is an ordinary thing to have. Double quotes are systemd's
 * own quoting, with backslash escaping inside them.
 */
export function quoteArg(arg: string): string {
    if (!/[\s"\\]/.test(arg)) return arg
    return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function renderUnit(plan: ServicePlan, envPrefix: string): string {
    assertNoSecrets(plan.environment, envPrefix, "systemd")
    for (const arg of plan.programArguments) assertUnitSafe(arg, "ExecStart")
    assertUnitSafe(plan.workingDirectory, "WorkingDirectory")
    for (const [key, value] of Object.entries(plan.environment)) {
        assertUnitSafe(value, `Environment=${key}`)
    }

    const exec = plan.programArguments.map(quoteArg).join(" ")
    const environment = Object.entries(plan.environment)
        .map(([key, value]) => `Environment=${key}=${value}`)
        .join("\n")
    const comment = plan.provenance.map((line) => `# ${line}`).join("\n")

    // No StandardOutput/StandardError: systemd's default is the journal, which rotates, is
    // searchable and survives a disk filling up — none of which a plain append-only file does.
    // `daemon logs` reads `journalctl` on this platform for the same reason.
    return `${comment}

[Unit]
Description=${plan.label}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${plan.workingDirectory}
${environment}
# A configuration fault stops the service once rather than retrying into a log nobody opens.
# Mirrors launchd's KeepAlive: {Crashed: true} — see launchd.ts for why that is structural.
Restart=on-failure
RestartSec=${THROTTLE_SECONDS}
# Must exceed the runtime's own stop deadline, or the reaper that kills backgrounded exec
# children never finishes and they outlive the service.
TimeoutStopSec=${EXIT_TIMEOUT_SECONDS}
KillMode=mixed

[Install]
WantedBy=default.target
`
}

/** The commands a person runs after the unit is written, in the order they run them. */
export function followUp(label: string, user: string): readonly string[] {
    return [
        `systemctl --user daemon-reload`,
        `systemctl --user enable --now ${label}`,
        `loginctl enable-linger ${user}`,
    ]
}

/** How to read the log on this platform. The journal, not a file — see `renderUnit`. */
export function logCommand(label: string): string {
    return `journalctl --user -u ${label} -f`
}
