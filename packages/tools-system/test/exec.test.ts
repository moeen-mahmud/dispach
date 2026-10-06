/**
 * `exec`, against a real shell.
 *
 * Nothing here is mocked. A shell tool tested against a fake shell tests the fake — the failures this
 * package is built around (a `cd` not carrying, an `export` carrying when it must not, a process
 * group surviving its parent, an exit code coming back green from a red build) are all failures of
 * the operating system boundary, and the boundary is the thing under test.
 *
 * The commands are chosen to be quick and portable: no network, no package manager, and nothing that
 * takes longer than a couple of seconds even on a loaded machine.
 */

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toolContext } from "@dispach/core"
import {
    DEFAULT_TIMEOUT_MS,
    EXEC_SPEC,
    effectiveTimeout,
    execHandler,
    MAX_TIMEOUT_MS,
} from "../src/exec.ts"
import { INLINE_CAP, readOutput, stripLeadingEcho } from "../src/output.ts"
import { SystemProvider } from "../src/provider.ts"
import { resolveRoots } from "../src/root.ts"
import {
    backgroundable,
    backgroundedCommands,
    buildWrapper,
    commandLine,
    MAX_BACKGROUNDED,
    reapBackgrounded,
} from "../src/run.ts"
import { ShellSessions } from "../src/session.ts"

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "system-test-"))
}

/**
 * One handler with its own session state, as a provider would build it.
 *
 * The root is the directory itself rather than `<dir>/workspace`, which is what `resolveRoots`
 * returns for a directory with no workspace — every temp dir here is one.
 */
function handler(dir: string): ReturnType<typeof execHandler> {
    return execHandler({
        sessions: new ShellSessions(),
        env: process.env,
        roots: resolveRoots(dir),
    })
}

const ESC = String.fromCharCode(27)

// ─── the spec ────────────────────────────────────────────────────────────────────────────

test("exec declares itself mutating, untrusted, and matched on its command", () => {
    expect(EXEC_SPEC.mutating).toBe(true)
    // Both are load-bearing. `untrusted` is what puts a later write behind the gate; `policyArg`
    // is what lets a rule narrow the tool instead of only allowing or denying it whole.
    expect(EXEC_SPEC.trust).toBe("untrusted")
    expect(EXEC_SPEC.policyArg).toBe("command")
})

test("exec has no env parameter, so nothing can reach the shell unseen by a policy rule", () => {
    // A per-call environment map would be invisible to `decidePolicy`, which matches the command
    // string. Written inline it is part of the command and the matcher sees it.
    expect(Object.keys(EXEC_SPEC.parameters.properties).includes("env")).toBe(false)
})

test("exec's negative guidance names the structured tools it must lose to", () => {
    const guidance = EXEC_SPEC.whenNotToUse ?? ""
    for (const slug of ["file_read", "file_write", "glob", "grep"]) {
        expect(guidance.includes(slug)).toBe(true)
    }
})

// ─── running ─────────────────────────────────────────────────────────────────────────────

test("a command's output comes back", async () => {
    const dir = tempDir()
    const output = await handler(dir)({ command: "echo hello" }, toolContext({ dir }))
    expect(output).toBe("hello")
})

test("a command that prints nothing says so rather than returning an empty observation", async () => {
    const dir = tempDir()
    const output = await handler(dir)({ command: "true" }, toolContext({ dir }))
    expect(output.includes("printed nothing")).toBe(true)
})

test("a failure reports its exit code and keeps the output", async () => {
    const dir = tempDir()
    const output = await handler(dir)({ command: "echo before; exit 3" }, toolContext({ dir }))
    expect(output.includes("exit code 3")).toBe(true)
    expect(output.includes("before")).toBe(true)
})

test("stderr and stdout arrive together, in order", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        { command: "echo one; echo two 1>&2; echo three" },
        toolContext({ dir }),
    )
    expect(output).toBe("one\ntwo\nthree")
})

test("the command runs in the agent's directory, not the process's", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "marker.txt"), "x")
    const output = await handler(dir)({ command: "ls" }, toolContext({ dir }))
    expect(output.includes("marker.txt")).toBe(true)
})

test("an empty command is a named failure rather than an empty shell", async () => {
    const dir = tempDir()
    await expect(handler(dir)({ command: "   " }, toolContext({ dir }))).rejects.toThrow(
        /exec was called with no command/,
    )
})

test("a workdir that does not exist is refused by name", async () => {
    const dir = tempDir()
    await expect(
        handler(dir)({ command: "pwd", workdir: join(dir, "nowhere") }, toolContext({ dir })),
    ).rejects.toThrow(/does not exist/)
})

// ─── the session boundary: cwd carries, environment does not ─────────────────────────────

test("a cd in one call is visible to the next", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "inner"))
    const run = handler(dir)
    const context = toolContext({ dir })

    await run({ command: "cd inner" }, context)
    const output = await run({ command: "pwd" }, context)

    // realpath, because macOS resolves /var through a symlink and the shell reports the real one.
    expect(output.endsWith("/inner")).toBe(true)
})

test("an export in one call is NOT visible to the next", async () => {
    const dir = tempDir()
    const run = handler(dir)
    const context = toolContext({ dir })

    await run({ command: "export LEAKED=yes" }, context)
    const output = await run({ command: "echo [$LEAKED]" }, context)

    // The whole point of a fresh shell per call: a function or a PATH prefix defined by one command
    // cannot redefine what an allowlisted command means in the next.
    expect(output).toBe("[]")
})

test("a shell function defined in one call cannot shadow a command in the next", async () => {
    const dir = tempDir()
    const run = handler(dir)
    const context = toolContext({ dir })

    await run({ command: "hijacked() { echo pwned; }" }, context)
    const output = await run({ command: "hijacked 2>&1 || echo 'not a command'" }, context)

    expect(output.includes("pwned")).toBe(false)
})

test("two sessions do not share a directory", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "inner"))
    const run = handler(dir)

    await run({ command: "cd inner" }, toolContext({ dir, sessionKey: "a" }))
    const output = await run({ command: "pwd" }, toolContext({ dir, sessionKey: "b" }))

    expect(output.endsWith("/inner")).toBe(false)
})

test("a remembered directory that has been deleted clears itself instead of failing forever", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "gone"))
    const sessions = new ShellSessions()
    const run = execHandler({ sessions, env: process.env, roots: resolveRoots(dir) })
    const context = toolContext({ dir })

    await run({ command: "cd gone" }, context)
    await run({ command: `rmdir "${join(dir, "gone")}"`, workdir: dir }, context)
    // Back to the deleted directory, because the successful rmdir remembered `dir`… so force it.
    sessions.remember(context.sessionKey, join(dir, "gone"))

    await expect(run({ command: "pwd" }, context)).rejects.toThrow(/does not exist/)
    expect(sessions.lastCwd(context.sessionKey)).toBeUndefined()
    // And the next call works, from the agent's own directory.
    expect(await run({ command: "echo recovered" }, context)).toBe("recovered")
})

// ─── escapes ─────────────────────────────────────────────────────────────────────────────

test("terminal escapes never reach the observation", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        { command: `printf '%s' 'git status${ESC}[2K${ESC}[1G && rm -rf ~'` },
        toolContext({ dir }),
    )
    // Displayed raw at a terminal this reads as `git status`: the escape erases the line and moves
    // the cursor home, and everything after it overwrites what was already read.
    expect(output).toBe("git status && rm -rf ~")
})

test("a colour sequence is removed without touching the text around it", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        { command: `printf '%s' '${ESC}[31mred${ESC}[0m and plain'` },
        toolContext({ dir }),
    )
    expect(output).toBe("red and plain")
})

// ─── timeouts, killing, and backgrounding ────────────────────────────────────────────────

test("a timeout leaves room under the harness deadline", () => {
    // The two defaults are both 120 s, so without the margin which one fires is a race — and the
    // harness winning is the bad outcome: it abandons the handler rather than killing the child.
    expect(effectiveTimeout(undefined, 120_000)).toBeLessThan(DEFAULT_TIMEOUT_MS)
    expect(effectiveTimeout(undefined, 600_000)).toBe(DEFAULT_TIMEOUT_MS)
})

test("a timeout longer than the ceiling is clamped", () => {
    expect(effectiveTimeout(3_600_000, 3_600_000)).toBe(MAX_TIMEOUT_MS)
})

test("the default timeout coercion fills in is not reported as a clamp; a real request is (pilot.9)", async () => {
    // Coercion writes the spec's default into a call that named no timeout, and the 120 s harness
    // deadline then clamps it — which used to print "longer than allowed" on every default call.
    const dir = tempDir()
    const quiet = await handler(dir)(
        { command: "echo hi", timeoutMs: DEFAULT_TIMEOUT_MS },
        toolContext({ dir, deadlineMs: 120_000 }),
    )
    expect(quiet).not.toContain("longer than allowed")
    const asked = await handler(dir)(
        { command: "echo hi", timeoutMs: 3_600_000 },
        toolContext({ dir, deadlineMs: 120_000 }),
    )
    expect(asked).toContain("longer than allowed")
})

test("a deadline too short for the margin still yields a positive timeout", () => {
    expect(effectiveTimeout(undefined, 3_000)).toBe(2_400)
    expect(effectiveTimeout(undefined, 1)).toBeGreaterThan(0)
})

test("sleep is killed at the deadline rather than backgrounded", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        { command: "sleep 30", timeoutMs: 400 },
        toolContext({ dir, deadlineMs: 30_000 }),
    )
    expect(output.includes("without finishing")).toBe(true)
    expect(output.includes("Still running")).toBe(false)
})

test("a long build is backgrounded rather than thrown away, and is then reaped", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        // Not on the never-background list, so it is left alone and its output keeps accumulating.
        { command: "echo starting; while true; do :; done", timeoutMs: 400 },
        toolContext({ dir, deadlineMs: 30_000 }),
    )
    expect(output.includes("Still running")).toBe(true)
    expect(output.includes("starting")).toBe(true)
    // The path is the point: the model is handed somewhere to look rather than a truncated guess.
    expect(output.includes(".log")).toBe(true)

    // The half this test used to be missing, and the omission was not academic: it backgrounded a
    // busy loop on every run, and a day of runs left 33 orphaned shells at ~23% CPU each — load
    // average 351, and a `runtime.ready` that took 132 seconds. A test that leaks a process is a
    // test that manufactures the bug it is describing.
    expect(backgroundedCommands().length).toBeGreaterThan(0)
    const reaped = reapBackgrounded()
    expect(reaped.length).toBeGreaterThan(0)
    expect(backgroundedCommands().length).toBe(0)
})

test("the number that may run in the background at once is capped", async () => {
    // A model in a retry loop can background one per step, and nothing bounded it. The refusal names
    // what is already running, because "too many" on its own is not actionable.
    const dir = tempDir()
    try {
        for (let i = 0; i < MAX_BACKGROUNDED + 1; i += 1) {
            await handler(dir)(
                { command: `echo ${i}; while true; do :; done`, timeoutMs: 200 },
                toolContext({ dir, deadlineMs: 30_000 }),
            )
        }
        throw new Error("expected the cap to refuse")
    } catch (error) {
        expect((error as { code?: string }).code).toBe("exec_too_many_background")
        expect((error as { hint: string }).hint).toContain("while true")
    } finally {
        reapBackgrounded()
    }
})

test("a compound is only backgroundable when every fragment is", () => {
    expect(backgroundable("npm ci")).toBe(true)
    expect(backgroundable("npm ci && npm test")).toBe(true)
    // Half a compound qualifying is not the compound qualifying — the same rule the policy engine
    // applies to an allow rule.
    expect(backgroundable("npm ci && git push")).toBe(false)
    expect(backgroundable("sleep 500")).toBe(false)
    expect(backgroundable("/usr/bin/git fetch")).toBe(false)
    // A `VAR=value` prefix is not the command word.
    expect(backgroundable("GIT_DIR=/x git status")).toBe(false)
})

test("background: true returns before the command finishes", async () => {
    const dir = tempDir()
    const marker = join(dir, "late.txt")
    const started = Date.now()
    const output = await handler(dir)(
        { command: `sleep 2; echo done > "${marker}"`, background: true },
        toolContext({ dir }),
    )
    expect(output.includes("Still running")).toBe(true)
    // Well under the two seconds the command itself takes.
    expect(Date.now() - started).toBeLessThan(1_500)
})

// ─── output discipline ───────────────────────────────────────────────────────────────────

test("large output spills to a file and the model is told where", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        // 20 000 characters, comfortably over the inline cap.
        { command: "awk 'BEGIN { while (i++ < 2000) print \"0123456789\" }'" },
        toolContext({ dir }),
    )
    expect(output.includes("too much to include")).toBe(true)
    const path = /(\/[^\s]+\.log)/.exec(output)?.[1] ?? ""
    expect(path).not.toBe("")
    // Not a claim — the whole output really is there, and reading it back is the recovery the model
    // is being pointed at.
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(INLINE_CAP)
})

test("a spill on success shows the start; a spill on failure shows both ends", async () => {
    const dir = tempDir()
    const long = "awk 'BEGIN { while (i++ < 2000) print \"0123456789\" }'"

    const ok = await handler(dir)({ command: long }, toolContext({ dir }))
    expect(ok.includes("End of the output")).toBe(false)

    const bad = await handler(dir)(
        { command: `${long}; echo THE-ACTUAL-ERROR; exit 1` },
        toolContext({ dir }),
    )
    // The error is at the bottom, under two thousand lines of ordinary progress. A head-only
    // preview of a failure shows everything except the reason for it.
    expect(bad.includes("THE-ACTUAL-ERROR")).toBe(true)
})

test("small output leaves nothing behind in the spill directory", async () => {
    const dir = tempDir()
    const output = await handler(dir)({ command: "echo tidy" }, toolContext({ dir }))
    expect(output).toBe("tidy")
    // No path is offered, so keeping the file would be litter nobody will ever open.
    expect(output.includes(tmpdir())).toBe(false)
})

test("readOutput reports the size before the preview was taken", async () => {
    const dir = tempDir()
    const path = join(dir, "big.log")
    writeFileSync(path, "x".repeat(INLINE_CAP + 500))
    const observation = await readOutput(path)
    expect(observation.spilled).toBe(true)
    expect(observation.bytes).toBe(INLINE_CAP + 500)
    expect(observation.head.length).toBeLessThan(observation.bytes)
})

// ─── the wrapper and the terminal ────────────────────────────────────────────────────────

test("the wrapper captures the exit code on the line after the command", () => {
    const wrapper = buildWrapper("echo hi", "/tmp/s")
    const lines = wrapper.split("\n")
    expect(lines[0]).toBe("echo hi")
    // On the very next line, before anything else can overwrite `$?` — and on its own line, because
    // a command may legitimately end in a comment, a `&`, or a here-document.
    expect(lines[1]).toBe("__code=$?")
})

test("a status path containing a quote is escaped rather than breaking the wrapper", () => {
    const wrapper = buildWrapper("true", "/tmp/it's here")
    expect(wrapper.includes(`'/tmp/it'\\''s here'`)).toBe(true)
})

test("the two script conventions are both argv, so nothing is quoted twice", () => {
    const linux = commandLine("echo hi", true, "linux")
    expect(linux.file).toBe("script")
    expect(linux.args.includes("-qec")).toBe(true)
    // util-linux hands its command string to $SHELL, and an interactive fish would parse it under
    // different rules than the one the wrapper was written for.
    expect(linux.env.SHELL).toBe("/bin/sh")

    const bsd = commandLine("echo hi", true, "darwin")
    expect(bsd.args[0]).toBe("-q")
    expect(bsd.args.includes("echo hi")).toBe(true)

    const plain = commandLine("echo hi", false, "darwin")
    expect(plain.file).toBe("/bin/sh")
    expect(plain.args).toEqual(["-c", "echo hi"])
})

test("a command under a terminal reports its own exit code, not the wrapper's", async () => {
    const dir = tempDir()
    const output = await handler(dir)({ command: "exit 7", pty: true }, toolContext({ dir }))
    // `script`'s own status is not the command's on every platform, which is why the sidecar exists.
    // Getting this wrong reports a failed build as green, with nothing anywhere saying otherwise.
    expect(output.includes("exit code 7")).toBe(true)
})

test("the terminal's echo of our own end-of-input is not reported as output", () => {
    // Caret and D, two ordinary characters — the tty repeating back the EOF that closing stdin
    // sent it. `stripControl` never sees it, because it is not a control byte.
    expect(stripLeadingEcho("^Dtty")).toBe("tty")
    expect(stripLeadingEcho("^D\n^Cbuilding")).toBe("building")
    // Only at the start, where it is unambiguously ours.
    expect(stripLeadingEcho("pressed ^D to finish")).toBe("pressed ^D to finish")
})

test("a command under a terminal sees one", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        { command: "test -t 1 && echo tty || echo pipe", pty: true },
        toolContext({ dir }),
    )
    expect(output.trim()).toBe("tty")
})

test("the same command without a terminal sees a pipe", async () => {
    const dir = tempDir()
    const output = await handler(dir)(
        { command: "test -t 1 && echo tty || echo pipe" },
        toolContext({ dir }),
    )
    expect(output.trim()).toBe("pipe")
})

// ─── the provider ────────────────────────────────────────────────────────────────────────

test("the provider resolves exec and omits what it does not know", async () => {
    const provider = new SystemProvider({ env: {}, dir: "/tmp" })
    const resolved = await provider.resolve(["exec", "not_a_tool"])
    expect(resolved.map((tool) => tool.spec.slug)).toEqual(["exec"])
})

test("the provider matches a slug tolerantly, like the registry does", async () => {
    const provider = new SystemProvider({ env: {}, dir: "/tmp" })
    expect((await provider.resolve(["EXEC"])).length).toBe(1)
})

test("two provider instances do not share a working directory", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "inner"))
    const first = new SystemProvider({ env: process.env, dir })
    const second = new SystemProvider({ env: process.env, dir })
    const context = toolContext({ dir })

    const runFirst = (await first.resolve(["exec"]))[0]
    const runSecond = (await second.resolve(["exec"]))[0]
    if (runFirst === undefined || runSecond === undefined) throw new Error("exec did not resolve")

    await runFirst.handler({ command: "cd inner" }, context)
    const output = await runSecond.handler({ command: "pwd" }, context)

    // Session state on the instance rather than the module: two agents in one runtime must not
    // inherit each other's directory, which module state would silently arrange.
    expect(String(output).endsWith("/inner")).toBe(false)
})
