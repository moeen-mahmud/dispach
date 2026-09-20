/**
 * The plist renderer and the `launchctl` parsers.
 *
 * Pure, so all of it runs without installing anything. The `launchctl print` fixture is real output
 * captured from the OpenClaw gateway job on the author's machine — `runs = 2463`,
 * `last exit code = 1` — with its environment block removed, because that block contained a live
 * gateway token and committing it would make the secret permanent. Which is, at one remove,
 * exactly the property the first test in this file asserts.
 */

import { describe, expect, test } from "bun:test"
import { BRAND } from "@dispach/core"
import {
    decodeWaitStatus,
    escapeXml,
    KEEP_ALIVE,
    labelFor,
    PlistSecretError,
    parseDisabled,
    parseLaunchctlList,
    parseLaunchctlPrint,
    plistEnvAllowed,
    renderPlist,
    type ServicePlan,
} from "#lib/launchd"

const PLAN: ServicePlan = {
    label: labelFor(BRAND.slug, "milo"),
    programArguments: ["/opt/node/bin/node", "/opt/cli/index.js", "serve", "/agents/milo.yaml"],
    workingDirectory: "/agents",
    stdoutPath: "/logs/milo.out.log",
    stderrPath: "/logs/milo.err.log",
    environment: { HOME: "/Users/x", PATH: "/usr/bin", [`${BRAND.envPrefix}SERVICE`]: "svc" },
    provenance: ["generated"],
}

describe("the plist carries no secrets", () => {
    /**
     * Hard rule 10 as a code path rather than a review habit.
     *
     * `launchctl print` echoes `EnvironmentVariables` in plaintext to anything running as this
     * user, so a credential here is a credential published — and nothing about the running agent
     * would look wrong. The gateway this runtime replaces does exactly that, in a 0644 file.
     */
    test("an environment key outside the allowlist throws", () => {
        expect(() =>
            renderPlist(
                { ...PLAN, environment: { ...PLAN.environment, TELEGRAM_BOT_TOKEN: "123:abc" } },
                BRAND.envPrefix,
            ),
        ).toThrow(PlistSecretError)
    })

    test("the thrown error names the key and the allowed set", () => {
        try {
            renderPlist({ ...PLAN, environment: { MODEL_API_KEY: "sk-live" } }, BRAND.envPrefix)
            throw new Error("should have thrown")
        } catch (error) {
            expect(error).toBeInstanceOf(PlistSecretError)
            const secret = error as PlistSecretError
            // `_service`, not `_plist`: one error for two renderers, because `systemctl show`
            // echoes `Environment=` exactly as `launchctl print` echoes `EnvironmentVariables`.
            expect(secret.code).toBe("daemon_secret_in_service")
            expect(secret.message).toContain("MODEL_API_KEY")
            expect(secret.hint).toContain("HOME")
        }
    })

    test("no secret-looking value survives into the rendered text", () => {
        // The property stated from the other side: whatever an agent's .env holds, none of it can
        // reach the file, because none of those names is renderable.
        const secrets = ["TELEGRAM_BOT_TOKEN", "MODEL_API_KEY", "COMPOSIO_API_KEY"]
        const body = renderPlist(PLAN, BRAND.envPrefix)
        for (const name of secrets) {
            expect(body.includes(name)).toBe(false)
        }
    })

    test("the allowlist is derived from the brand, so a rename moves it", () => {
        expect(plistEnvAllowed("ACME_")).toContain("ACME_SERVICE")
        expect(plistEnvAllowed("ACME_")).toContain("ACME_HOME")
    })
})

describe("rendering", () => {
    const body = renderPlist(PLAN, BRAND.envPrefix)

    test("restarts on a crash and on nothing else", () => {
        // The structural answer to the restart loop: a deliberate non-zero exit — every
        // configuration fault — does not relaunch, so a broken service stops once with the reason
        // on disk instead of writing the same line into a log every ten seconds forever.
        expect(KEEP_ALIVE).toEqual({ Crashed: true })
        expect(body).toContain("<key>KeepAlive</key>")
        expect(body).toContain("<key>Crashed</key>")
        expect(body.includes("<key>SuccessfulExit</key>")).toBe(false)
    })

    test("every argument is absolute and present in order", () => {
        for (const arg of PLAN.programArguments) {
            expect(body).toContain(`<string>${arg}</string>`)
        }
        expect(body.indexOf("/opt/node/bin/node")).toBeLessThan(body.indexOf("/opt/cli/index.js"))
    })

    test("the keys a service manager actually reads are all there", () => {
        for (const key of [
            "Label",
            "ProgramArguments",
            "RunAtLoad",
            "ThrottleInterval",
            "ExitTimeOut",
            "ProcessType",
            "WorkingDirectory",
            "StandardOutPath",
            "StandardErrorPath",
        ]) {
            expect(body).toContain(`<key>${key}</key>`)
        }
    })

    test("XML-hostile characters in a path are escaped", () => {
        const odd = renderPlist({ ...PLAN, workingDirectory: "/a & b/<c>/'d'" }, BRAND.envPrefix)
        expect(odd).toContain("/a &amp; b/&lt;c&gt;/&apos;d&apos;")
        expect(escapeXml(`"x"`)).toBe("&quot;x&quot;")
    })

    test("the label is brand-derived", () => {
        expect(labelFor("acme", "milo")).toBe("acme.agent.milo")
    })
})

describe("reading launchctl back", () => {
    test("list is tab-separated, with `-` for an absent pid", () => {
        const parsed = parseLaunchctlList(
            [
                "PID\tStatus\tLabel",
                "-\t0\tcom.apple.quiet",
                "4711\t0\tacme.agent.milo",
                "-\t-9\tx",
            ].join("\n"),
        )
        expect(parsed).toEqual([
            { status: 0, label: "com.apple.quiet" },
            { pid: 4711, status: 0, label: "acme.agent.milo" },
            { status: -9, label: "x" },
        ])
    })

    /** Real output, environment block removed. The restart loop this whole design answers. */
    const OPENCLAW = `gui/501/ai.openclaw.gateway = {
	active count = 0
	path = /Users/x/Library/LaunchAgents/ai.openclaw.gateway.plist
	type = LaunchAgent
	state = spawn scheduled

	program = /opt/homebrew/bin/node

	stdout path = /Users/x/.openclaw/logs/gateway.log
	stderr path = /Users/x/.openclaw/logs/gateway.err.log

	runs = 2463
	last exit code = 1

	job state = exited
}`

    test("print yields the run count and the already-decoded exit code", () => {
        const facts = parseLaunchctlPrint(OPENCLAW)
        expect(facts.runs).toBe(2463)
        // Already decoded by launchctl. Putting this through `decodeWaitStatus` would turn exit 1
        // into exit 0 — a broken service reported as a clean stop. Two sources, two code paths.
        expect(facts.lastExitCode).toBe(1)
        expect(facts.pid).toBeUndefined()
        expect(facts.stderrPath).toBe("/Users/x/.openclaw/logs/gateway.err.log")
        expect(facts.jobState).toBe("spawn scheduled")
    })

    test("print never surfaces an environment value", () => {
        const withSecret = `${OPENCLAW}\n\tenvironment = {\n\t\tTOKEN => hunter2\n\t}`
        expect(JSON.stringify(parseLaunchctlPrint(withSecret)).includes("hunter2")).toBe(false)
    })

    test("a raw wait status decodes to an exit code or a signal", () => {
        expect(decodeWaitStatus(0)).toEqual({ exitCode: 0 })
        expect(decodeWaitStatus(256)).toEqual({ exitCode: 1 })
        expect(decodeWaitStatus(65280)).toEqual({ exitCode: 255 })
        expect(decodeWaitStatus(-9)).toEqual({ signal: 9, signalName: "SIGKILL" })
        expect(decodeWaitStatus(-15)).toEqual({ signal: 15, signalName: "SIGTERM" })
    })

    test("the disable registry is read, because a disabled job is simply not listed", () => {
        const disabled = parseDisabled(
            [
                "	disabled services = {",
                '		"com.docker.helper" => enabled',
                '		"acme.agent.milo" => disabled',
                "	}",
            ].join("\n"),
        )
        expect(disabled).toEqual(["acme.agent.milo"])
    })
})
