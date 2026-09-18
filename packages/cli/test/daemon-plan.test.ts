/**
 * What would stop an install, and what a service's state actually means.
 *
 * Both are pure functions over facts, which is the point: the interesting cases here are a restart
 * loop, a binary inside a git checkout, and a job that is stopped-by-you rather than
 * stopped-because-it-died. Reaching those against a real machine would mean breaking one nine
 * different ways; as a table they are nine assertions.
 */

import { describe, expect, test } from "bun:test"
import {
    type AgentFindingFacts,
    type Attention,
    agentFindings,
    attentionFrom,
    type BinaryFacts,
    currentRun,
    type Finding,
    isLoopbackHost,
    type ServerPreflightFacts,
    type ServiceFacts,
    serverFindings,
    summariseStatus,
} from "#lib/daemon-plan"

const AGENT: AgentFindingFacts = { agentId: "milo", agentDir: "/agents/milo" }
const BINARY: BinaryFacts = { execPath: "/opt/homebrew/bin/node", scriptPath: "/opt/cli/index.js" }

function agentCodes(facts: Partial<AgentFindingFacts>): readonly string[] {
    return agentFindings({ ...AGENT, ...facts }).map((finding) => finding.code)
}

function serverCodes(facts: Partial<ServerPreflightFacts>): readonly string[] {
    return serverFindings({ binary: BINARY, retiring: [], servedElsewhere: [], ...facts }).map(
        (finding) => finding.code,
    )
}

describe("preflight", () => {
    test("a healthy agent and a healthy host both produce nothing", () => {
        expect(agentCodes({})).toEqual([])
        expect(serverCodes({})).toEqual([])
    })

    /**
     * Hard rule 7, asserted over the whole table rather than remembered per finding. Every path
     * through both functions is walked and every finding they can produce is checked, so a new one
     * without a hint fails here rather than at review.
     */
    test("every finding carries a non-empty hint", () => {
        const everything: Finding[] = [
            ...agentFindings({ ...AGENT, envFileMode: 0o644 }),
            ...agentFindings({ ...AGENT, problem: "unreadable" }),
            ...serverFindings({
                binary: { ...BINARY, gitRoot: "/checkout" },
                retiring: ["dispach.agent.milo"],
                servedElsewhere: [{ agentId: "milo", pid: 1, mode: "terminal" }],
            }),
            ...serverFindings({
                binary: { ...BINARY, execPath: "/Users/x/.nvm/versions/node/v24/bin/node" },
                retiring: [],
                servedElsewhere: [],
            }),
        ]
        expect(everything.length).toBeGreaterThan(4)
        for (const finding of everything) {
            expect(finding.hint.length).toBeGreaterThan(20)
            expect(finding.message.length).toBeGreaterThan(10)
        }
    })

    /**
     * The three blockers 16.4 **deleted**, asserted as gone rather than left to be noticed.
     *
     * Each became false rather than merely unreachable when one service started hosting every
     * agent — an agent with no channel is reachable over the host's `/v1`, a host that names no
     * manifest cannot bind a public host, and there is no per-agent label to take. `agentFindings`
     * carries the reasoning; this is the guard that stops one being restored by reflex.
     */
    test("nothing blocks any more — the per-agent install that could is retired", () => {
        const all = [
            ...agentFindings({ ...AGENT, envFileMode: 0o644, problem: "x" }),
            ...serverFindings({
                binary: { ...BINARY, gitRoot: "/c" },
                retiring: ["dispach.agent.milo"],
                servedElsewhere: [{ agentId: "milo", pid: 1, mode: "daemon" }],
            }),
        ]
        expect(all.every((finding) => finding.severity === "warn")).toBe(true)
    })

    test("a retired per-agent unit is reported, with the re-enable named", () => {
        const findings = serverFindings({
            binary: BINARY,
            retiring: ["dispach.agent.milo"],
            servedElsewhere: [],
        })
        expect(findings[0]?.code).toBe("daemon_per_agent_retired")
        expect(findings[0]?.message).toContain("dispach.agent.milo")
        // The `disable` row is the whole trap: no verb deletes it, so a label left disabled makes a
        // future job with that name install cleanly and silently never start.
        expect(findings[0]?.hint).toContain("re-enabled")
    })

    test("agents held by another process are a warning, not a refusal", () => {
        // 16.2a's partial-lease behaviour applied to an install: the host starts and serves
        // everything else rather than refusing over one contended agent.
        const findings = serverFindings({
            binary: BINARY,
            retiring: [],
            servedElsewhere: [{ agentId: "milo", pid: 4711, mode: "terminal" }],
        })
        expect(findings[0]?.code).toBe("daemon_agents_held_elsewhere")
        expect(findings[0]?.message).toContain("4711")
        expect(findings[0]?.severity).toBe("warn")
    })

    test("an unreadable agent is reported and the host still serves the rest", () => {
        expect(agentCodes({ problem: "no id" })).toEqual(["daemon_agent_unreadable"])
    })

    test("loopback is recognised in all its spellings", () => {
        for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
            expect(isLoopbackHost(host)).toBe(true)
        }
        expect(isLoopbackHost("0.0.0.0")).toBe(false)
        expect(isLoopbackHost("192.168.1.4")).toBe(false)
    })

    test("the binary warnings are shared by both lists and reported once", () => {
        // Extracted rather than copied when the server unit arrived: they are facts about this
        // binary and nothing to do with which agent, and a second copy is how one install path
        // comes to warn about a checkout while the other installs silently from one.
        expect(
            serverCodes({
                binary: {
                    execPath: "/Users/x/.nvm/versions/node/v24.11.0/bin/node",
                    scriptPath: "/checkout/packages/cli/dist/index.js",
                    gitRoot: "/checkout",
                },
            }),
        ).toEqual(["daemon_binary_in_checkout", "daemon_versioned_runtime"])
    })

    test("a 0600 env file is not warned about", () => {
        expect(agentCodes({ envFileMode: 0o600 })).toEqual([])
        expect(agentCodes({ envFileMode: 0o644 })).toEqual(["daemon_env_world_readable"])
    })
})

const STOPPED: ServiceFacts = { installed: true, disabled: true }

describe("status verdicts", () => {
    test("running", () => {
        const report = summariseStatus("milo", {
            installed: true,
            disabled: false,
            pid: 4711,
            runs: 1,
            uptimeMs: 3 * 3600_000,
        })
        expect(report.verdict).toBe("running")
        expect(report.healthy).toBe(true)
        expect(report.wantsStderrTail).toBe(false)
        expect(report.rows[0]?.value).toContain("pid 4711")
        expect(report.rows[0]?.note).toContain("3h")
    })

    /**
     * The pair no single source can tell apart. A disabled job is simply absent from
     * `launchctl list`, so without the disable registry "you stopped it" and "it died and launchd
     * gave up" are the same observation — and only one of them is a problem.
     */
    test("stopped by you is not the same as installed and idle", () => {
        expect(summariseStatus("milo", STOPPED).verdict).toBe("stopped")
        expect(summariseStatus("milo", { installed: true, disabled: false }).verdict).toBe(
            "installed-idle",
        )
    })

    test("a restart loop is named as one and is never healthy", () => {
        const report = summariseStatus("milo", {
            installed: true,
            disabled: false,
            runs: 2463,
            lastExitCode: 1,
            stderrPath: "/logs/milo.err.log",
            stderrBytes: 57_192_866,
        })
        expect(report.verdict).toBe("restart-loop")
        expect(report.healthy).toBe(false)
        // The log tail is the whole point: the reason was on disk the entire time.
        expect(report.wantsStderrTail).toBe(true)
        expect(report.headline).toContain("RESTART LOOP")
        expect(report.rows.some((row) => row.note?.includes("2463") === true)).toBe(true)
        expect(report.rows.some((row) => row.note?.includes("55 MB") === true)).toBe(true)
    })

    test("a few restarts with real uptime is a recovery, not a loop", () => {
        const report = summariseStatus("milo", {
            installed: true,
            disabled: false,
            pid: 900,
            runs: 4,
            uptimeMs: 6 * 3600_000,
        })
        expect(report.verdict).toBe("running")
        expect(report.healthy).toBe(true)
    })

    test("a terminal serve is reported as running even though nothing is installed", () => {
        // "not installed" alone would read as "nothing is running", which is the opposite of the
        // truth — the same lie slot 2 was fixed for.
        const report = summariseStatus("milo", {
            installed: false,
            disabled: false,
            leasePid: 321,
            leaseMode: "terminal",
        })
        expect(report.verdict).toBe("running")
        expect(report.rows[0]?.value).toContain("running in a terminal")
        expect(report.rows[0]?.note).toContain("not installed")
    })

    test("nothing anywhere is absent, and absent is not healthy", () => {
        const report = summariseStatus("milo", { installed: false, disabled: false })
        expect(report.verdict).toBe("absent")
        expect(report.healthy).toBe(false)
    })
})

/**
 * "Running" was true and useless.
 *
 * The service was up, connected, and refusing every message from the one person it had been set up
 * for, because a handle in `allowFrom` had a hyphen where an underscore belonged. The refusal names
 * the sender and says exactly what to do — into a log file, which under a background service nobody
 * opens. `status` said `running`, and it was right, and that was the whole problem: is it up and is
 * it working are different questions, and only the second is why anyone typed the command.
 */
describe("things a healthy service is saying that you need to hear", () => {
    const DENIED = `dispach serving on http://127.0.0.1:7420
  tg: connected — @milothecat_bot, long-poll
  tg: denied — Sender "@moeen_mahmud" is not in channel "tg"'s allowFrom list.`

    test("a refused sender is surfaced, with the sender and the fix", () => {
        const found = attentionFrom(DENIED)
        expect(found.length).toBe(1)
        expect(found[0]?.code).toBe("inbound_denied")
        expect(found[0]?.summary).toContain("@moeen_mahmud")
        expect(found[0]?.summary).toContain("tg")
        expect(found[0]?.fix).toContain("allowFrom")
    })

    test("the same sender knocking five times is said once", () => {
        const repeated = `${DENIED}\n${'  tg: denied — Sender "@moeen_mahmud" is not in channel "tg"\'s allowFrom list.\n'.repeat(4)}`
        expect(attentionFrom(repeated).length).toBe(1)
    })

    test("two different senders are two findings", () => {
        const two = `${DENIED}\n  tg: denied — Sender "@someone_else" is not in channel "tg"'s allowFrom list.`
        expect(attentionFrom(two).length).toBe(2)
    })

    /**
     * launchd appends, so without this a denial from before you fixed the allowlist would be
     * reported forever — and a warning that outlives its cause is one people learn to scroll past.
     */
    test("a denial from a previous run is not reported after a restart", () => {
        const restarted = `${DENIED}
stopping
dispach serving on http://127.0.0.1:7420
  tg: connected — @milothecat_bot, long-poll`
        expect(attentionFrom(restarted)).toEqual([])
        expect(currentRun(restarted)).not.toContain("denied")
    })

    test("a healthy log says nothing", () => {
        expect(attentionFrom("dispach serving on http://127.0.0.1:7420\n  tg: connected")).toEqual(
            [],
        )
    })

    test("every finding carries a fix", () => {
        const all: Attention[] = [
            ...attentionFrom(DENIED),
            ...attentionFrom("serving on x\ntelegram_token_missing: nope"),
        ]
        expect(all.length).toBeGreaterThan(1)
        for (const item of all) expect(item.fix.length).toBeGreaterThan(20)
    })
})
