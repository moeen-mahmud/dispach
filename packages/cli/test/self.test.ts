/**
 * How this CLI re-invokes itself, which was wrong in the artefact it ships as.
 *
 * Two places spawn the binary again — a session pane running a command as a child, and the
 * generated service definition — and both assembled `[execPath, argv[1], ...args]`. Right under
 * node, where the entry is a script and `execPath` is the runtime. Wrong for the compiled binary,
 * where `execPath` is the whole command and `argv[1]` is a path inside bun's embedded filesystem.
 *
 * Reported from the TUI in the container: `/channels` answered
 * `Unknown command "/$bunfs/root/…-linux-arm64"`. It was never about `/channels` — every pane
 * command was broken there, and the service definition had the same bug waiting for somebody to
 * install one from a compiled binary, where it would exit 1 at every boot.
 *
 * **The suite runs under bun-the-runtime and never as a compiled artefact**, so the state cannot be
 * reached by running something. `argv` is a parameter for exactly that reason; the shape it takes
 * was measured from a real compiled probe rather than assumed:
 *
 *     {"execPath":"/private/tmp/argvprobe","argv1":"/$bunfs/root/argvprobe"}
 */

import { describe, expect, test } from "bun:test"
import { isCompiledBinary, selfInvocation } from "../src/lib/self.ts"

const COMPILED = ["/usr/local/bin/agentbin", "/$bunfs/root/agentbin-linux-arm64"]
const SCRIPT = ["/usr/local/bin/node", "/opt/pkg/dist/index.js"]

describe("a compiled binary is recognised by its embedded script path", () => {
    test("a `/$bunfs/` path means compiled", () => {
        expect(isCompiledBinary(COMPILED)).toBe(true)
    })

    test("an ordinary script path does not", () => {
        expect(isCompiledBinary(SCRIPT)).toBe(false)
    })

    /**
     * Running *under* bun and being *compiled into* a binary are different states, and the suite
     * itself is the first. Keying on `process.isBun` would have reported every test run as
     * compiled and broken the pane in development instead of in production.
     */
    test("running under bun from source is not compiled", () => {
        expect(isCompiledBinary(["/usr/local/bin/bun", "/repo/packages/cli/src/index.ts"])).toBe(
            false,
        )
    })

    test("no argv[1] at all is a self-contained command", () => {
        expect(isCompiledBinary(["/usr/local/bin/agentbin"])).toBe(true)
    })
})

describe("the invocation carries a script only when there is one", () => {
    test("compiled: the binary is the whole command", () => {
        const self = selfInvocation(COMPILED, "/usr/local/bin/agentbin")
        expect(self).toEqual({ command: "/usr/local/bin/agentbin", args: [] })
    })

    test("script: the runtime is the command and the script leads", () => {
        const self = selfInvocation(SCRIPT, "/usr/local/bin/node")
        expect(self).toEqual({ command: "/usr/local/bin/node", args: ["/opt/pkg/dist/index.js"] })
    })

    /**
     * The defect in one assertion: the embedded path must never reach the argument list, because
     * the binary reads its first positional as the command name.
     */
    test("the embedded path is never passed as an argument", () => {
        expect(selfInvocation(COMPILED, "/usr/local/bin/agentbin").args.join(" ")).not.toContain(
            "$bunfs",
        )
    })
})
