/**
 * launchd, as string transformations. Pure: no `node:*`, no `process`, no subprocess.
 *
 * Everything here is text in, text out — a plist rendered from a plan, and `launchctl` output
 * parsed into facts. That is what lets every plist key and every status decode be unit-tested
 * without installing a service on the machine running the tests, and it is why `service.ts`, which
 * actually shells out, contains almost no logic.
 *
 * ## The counter-example this file was written against
 *
 * `~/Library/LaunchAgents/ai.openclaw.gateway.plist`, on the author's machine, from the gateway
 * this runtime replaces. Three things it gets wrong, each reproduced here as a rule:
 *
 * 1. **It stores a live token as a literal string** in a `-rw-r--r--` file, and `launchctl print`
 *    echoes `EnvironmentVariables` in plaintext to anything running as that user. Hard rule 10 says
 *    secrets are env var *names* in config, never values, and a plist is config. So `renderPlist`
 *    *throws* on a key outside `PLIST_ENV_ALLOWED` rather than trusting whoever builds the plan.
 * 2. **It runs a Homebrew interpreter against an nvm-installed script.** It works by accident and
 *    dies when either moves. Interpreter and script are both resolved absolutely, by the caller,
 *    and recorded.
 * 3. **`KeepAlive: true`.** At the time of writing that job reports `runs = 2463`,
 *    `last exit code = 1`, and a 57 MB stderr log containing one sentence repeated every ten
 *    seconds. The message is a good one — it names the cause and offers two remedies. It was
 *    simply written somewhere nobody looks, thousands of times. See `KEEP_ALIVE`.
 */

import { assertNoSecrets } from "#lib/service-env"

/**
 * Environment keys a generated service definition may carry — **moved to `service-env.ts`**.
 *
 * The systemd renderer needs the identical list: `systemctl show` exposes `Environment=` exactly as
 * `launchctl print` exposes `EnvironmentVariables`, so a second copy is how one manager comes to
 * permit a variable the other refuses, and the dangerous direction is the one that silently permits
 * more. Re-exported under the old name so every existing caller is unchanged.
 */
export { serviceEnvAllowed as plistEnvAllowed } from "#lib/service-env"

/**
 * Restart on a crash signal, and on nothing else.
 *
 * The whole crash-loop answer, and it is structural rather than advisory. A deliberate non-zero
 * exit means the configuration is wrong — a manifest that will not load, a missing credential, a
 * port already taken — and relaunching that thirty times an hour produces the 57 MB log described
 * above. Under `Crashed` the job stops once, with the reason on disk, and `daemon status` says so.
 *
 * This is only safe because of a property the runtime already has: `ChannelHub.start()` catches
 * each transport's failure and boots anyway, so a Telegram outage or a rejected token never ends
 * the process. A non-zero exit therefore really is a misconfiguration and never a transient.
 *
 * The trade, stated rather than discovered: an uncaught exception also stops the service instead of
 * looping. A loud stop is the better failure — this codebase's whole objection to the OpenClaw job
 * is that nobody was ever told.
 */
export const KEEP_ALIVE = { Crashed: true } as const

/** launchd's default is 10s. Higher, because a restart loop should cost less while it lasts. */
export const THROTTLE_SECONDS = 30
/**
 * SIGTERM to SIGKILL. Must exceed the runtime's own stop deadline, or the reaper that kills
 * backgrounded `exec` children never finishes and they outlive the service.
 */
export const EXIT_TIMEOUT_SECONDS = 30

export interface ServicePlan {
    readonly label: string
    readonly programArguments: readonly string[]
    readonly workingDirectory: string
    readonly stdoutPath: string
    readonly stderrPath: string
    readonly environment: Readonly<Record<string, string>>
    /** Rendered into an XML comment. launchd has no `Comment` key — OpenClaw's is inert. */
    readonly provenance: readonly string[]
}

/**
 * The old name, kept as an alias so nothing that caught it stops catching it.
 *
 * The class itself is `ServiceSecretError` in `service-env.ts` — one error for two renderers, for
 * the reason the allowlist is one list.
 */
export { ServiceSecretError as PlistSecretError } from "#lib/service-env"

/**
 * `<slug>.agent.<id>` — the **retired** per-agent label.
 *
 * Kept, and now only for retirement: one service hosts every agent, so this is what a bare
 * `daemon install` looks for in order to clean it up. Leaving a per-agent unit installed beside the
 * server unit is a broken state rather than a redundant one — both claim the same lease, so the
 * server reports that agent as served elsewhere indefinitely with nothing looking wrong.
 *
 * ⚠️ **`launchctl enable` is the only thing that clears an orphaned `disable` row**, and no verb
 * deletes it. Deleting the plist leaves `<slug>.agent.<id> => disabled` in
 * `/var/db/com.apple.xpc.launchd/` forever, so a future job reusing that label installs cleanly,
 * reports success and silently never starts. Retirement is therefore `bootout` + `enable` + `rm`,
 * in that order, and never just `rm`.
 */
export function labelFor(slug: string, agentId: string): string {
    return `${slug}.agent.${agentId}`
}

/**
 * `<slug>.server` — the one unit.
 *
 * One service for the host rather than one per agent, because per-agent on/off is durable *state*
 * (16.3's `agent_state`) and not a unit: `stop milo` leaves the host serving everything else, which
 * a unit-per-agent cannot express without N processes contending for one port.
 */
export function serverLabel(slug: string): string {
    return `${slug}.server`
}

export function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;")
}

export function renderPlist(plan: ServicePlan, envPrefix: string): string {
    // The check is shared with the systemd renderer, so the two cannot disagree about what counts
    // as a secret — and it runs before a byte is written, so a throw leaves nothing half-installed.
    assertNoSecrets(plan.environment, envPrefix, "launchd")

    const args = plan.programArguments
        .map((arg) => `      <string>${escapeXml(arg)}</string>`)
        .join("\n")
    const env = Object.entries(plan.environment)
        .map(
            ([key, value]) =>
                `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
        )
        .join("\n")
    const comment = plan.provenance.map((line) => `  ${escapeXml(line)}`).join("\n")

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
${comment}
-->
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(plan.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>Crashed</key>
      <${KEEP_ALIVE.Crashed}/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_SECONDS}</integer>
    <key>ExitTimeOut</key>
    <integer>${EXIT_TIMEOUT_SECONDS}</integer>
    <key>ProcessType</key>
    <string>Adaptive</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(plan.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(plan.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(plan.stderrPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
  </dict>
</plist>
`
}

// ─── reading launchctl back ──────────────────────────────────────────────────────────────

export interface ListEntry {
    readonly pid?: number
    /** Raw wait status, exactly as the column carries it. Decode with `decodeWaitStatus`. */
    readonly status: number
    readonly label: string
}

/** `launchctl list` — tab-separated `PID / Status / Label`, `-` for an absent pid. */
export function parseLaunchctlList(text: string): readonly ListEntry[] {
    const out: ListEntry[] = []
    for (const line of text.split("\n")) {
        const parts = line.split("\t")
        if (parts.length < 3) continue
        const [pid, status, label] = parts
        if (label === undefined || label === "Label" || label === "") continue
        const parsedStatus = Number.parseInt(status ?? "", 10)
        out.push({
            ...(pid === undefined || pid === "-" ? {} : { pid: Number.parseInt(pid, 10) }),
            status: Number.isFinite(parsedStatus) ? parsedStatus : 0,
            label,
        })
    }
    return out
}

export interface PrintFacts {
    readonly pid?: number
    readonly runs?: number
    /** **Already decoded** by launchctl. Never pass this through `decodeWaitStatus`. */
    readonly lastExitCode?: number
    readonly jobState?: string
    readonly stdoutPath?: string
    readonly stderrPath?: string
}

/**
 * `launchctl print gui/$UID/<label>` — the only form carrying `runs`, which is what makes a
 * restart loop visible rather than merely a stopped job.
 *
 * Deliberately does **not** surface the `EnvironmentVariables` block it walks past. That output
 * echoes every value in plaintext, and a parser that lifted them into a struct would be one
 * `--json` away from writing somebody's bot token into a log file.
 */
export function parseLaunchctlPrint(text: string): PrintFacts {
    const facts: {
        pid?: number
        runs?: number
        lastExitCode?: number
        jobState?: string
        stdoutPath?: string
        stderrPath?: string
    } = {}
    for (const raw of text.split("\n")) {
        const line = raw.trim()
        const pid = /^pid = (\d+)$/.exec(line)
        if (pid?.[1] !== undefined) facts.pid = Number.parseInt(pid[1], 10)
        const runs = /^runs = (\d+)$/.exec(line)
        if (runs?.[1] !== undefined) facts.runs = Number.parseInt(runs[1], 10)
        const exit = /^last exit code = (-?\d+)$/.exec(line)
        if (exit?.[1] !== undefined) facts.lastExitCode = Number.parseInt(exit[1], 10)
        const state = /^state = (.+)$/.exec(line)
        if (state?.[1] !== undefined) facts.jobState = state[1]
        const out = /^stdout path = (.+)$/.exec(line)
        if (out?.[1] !== undefined) facts.stdoutPath = out[1]
        const err = /^stderr path = (.+)$/.exec(line)
        if (err?.[1] !== undefined) facts.stderrPath = err[1]
    }
    return facts
}

export interface WaitStatus {
    readonly exitCode?: number
    readonly signal?: number
    readonly signalName?: string
}

const SIGNALS: Readonly<Record<number, string>> = {
    1: "SIGHUP",
    2: "SIGINT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    15: "SIGTERM",
}

/**
 * Decode `launchctl list`'s status column — and only that column.
 *
 * It is a raw `wait(2)` status: `256` means exit code 1, and a negative value names the signal that
 * killed the job. `launchctl print`'s `last exit code` is *already decoded*, and putting it through
 * here turns exit 1 into exit 0 — a broken service reported as a clean stop. Two sources, two
 * code paths, on purpose.
 */
export function decodeWaitStatus(raw: number): WaitStatus {
    if (!Number.isFinite(raw)) return {}
    if (raw < 0) {
        const signal = -raw
        return {
            signal,
            ...(SIGNALS[signal] === undefined ? {} : { signalName: SIGNALS[signal] }),
        }
    }
    return { exitCode: raw >= 256 ? raw >> 8 : raw }
}

/**
 * `launchctl print-disabled gui/$UID` → the labels explicitly disabled.
 *
 * Required, not optional. A disabled job is simply absent from `launchctl list`, so without this
 * "you stopped it" and "it failed and was removed" are the same observation — and `disable`
 * persists across boots, which is how a reinstall silently never starts.
 */
export function parseDisabled(text: string): readonly string[] {
    const out: string[] = []
    for (const raw of text.split("\n")) {
        const match = /^\s*"(.+)"\s*=>\s*(disabled|true)\s*$/.exec(raw)
        if (match?.[1] !== undefined) out.push(match[1])
    }
    return out
}
