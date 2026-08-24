/**
 * The one place in this package that starts a process.
 *
 * There were two callers before this file existed and the second one is what created it: `lib/service.ts`
 * ran `launchctl`, and fetching a skill source needs `git`. The rule the boundaries test enforces is
 * "exactly one module imports `node:child_process`", and its stated reason is that a second call site is a
 * second place a test has to intercept — the first one that forgets reaches somebody's real machine. Two
 * callers of one seam keeps that property; an allowlist with two entries in it loses it, and would go on
 * losing it once per phase.
 *
 * Deliberately thin, and deliberately not clever. Everything specific to a tool — git's four ways of
 * being told not to prompt, launchd's exit-status decoding — belongs to the caller that knows about it.
 * What lives here is "run this, capture what it said, and tell me honestly how it ended".
 *
 * `notFound` is a field rather than an exception because the two callers want different sentences for it:
 * a missing `git` has a remedy the person can act on, and a missing `launchctl` means this is not the
 * operating system the caller thought it was. A shared error message would be wrong for both.
 */

import { spawn, spawnSync } from "node:child_process"

export interface SpawnRequest {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd?: string
    /** Replaces the environment entirely when given. Callers spread `process.env` themselves. */
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly timeoutMs?: number
    readonly maxBuffer?: number
    /**
     * Text to write to the child's stdin, which is then closed.
     *
     * Added for the clipboard: `pbcopy` reads what it copies from stdin and there is no argument form. The
     * alternative was a temporary file, which puts whatever was selected on disk — and a selection is
     * routinely the most sensitive thing on the screen. The seam grows rather than the caller working
     * around it, per the rule about first-party code not getting private escape hatches.
     */
    readonly input?: string
}

export interface SpawnResult {
    readonly code: number
    readonly stdout: string
    readonly stderr: string
    /** True when a timeout or a signal ended it, rather than the process choosing to exit. */
    readonly signalled: boolean
    /** True when the command is not on PATH at all. */
    readonly notFound: boolean
}

export function spawnCapture(request: SpawnRequest): SpawnResult {
    const result = spawnSync(request.command, [...request.args], {
        encoding: "utf8",
        ...(request.input === undefined ? {} : { input: request.input }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env as NodeJS.ProcessEnv }),
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
        ...(request.maxBuffer === undefined ? {} : { maxBuffer: request.maxBuffer }),
    })
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        signalled: result.signal !== null,
        notFound: code === "ENOENT",
    }
}

/**
 * The same thing, without blocking the event loop.
 *
 * Exists because `spawnSync` inside an Ink app freezes the whole terminal: no spinner frame advances, and
 * the keypresses that arrive during a twenty-second `git clone` are echoed by the tty instead of being
 * consumed by the app — which is how `^[[B^[[A` ended up printed in the middle of a fetch progress line.
 * Anything a rendered screen waits on has to be awaited, not blocked on.
 */
export function spawnCaptureAsync(request: SpawnRequest): Promise<SpawnResult> {
    return new Promise((resolve) => {
        const child = spawn(request.command, [...request.args], {
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            ...(request.env === undefined ? {} : { env: request.env as NodeJS.ProcessEnv }),
            // Never inherit: a child that writes to the terminal would paint over the rendered frame, and
            // one that reads from it would steal the keys the app is listening for.
            // A pipe only when there is something to write. `ignore` otherwise, for the reason below.
            stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        })
        if (request.input !== undefined) {
            // Ended immediately: a child reading stdin waits for EOF, so a pipe left open is a process
            // that never exits and a promise that never settles.
            child.stdin?.end(request.input)
        }
        let stdout = ""
        let stderr = ""
        let signalled = false
        const cap = request.maxBuffer ?? 32 * 1024 * 1024
        child.stdout?.on("data", (chunk: Buffer) => {
            if (stdout.length < cap) stdout += chunk.toString("utf8")
        })
        child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length < cap) stderr += chunk.toString("utf8")
        })
        const timer =
            request.timeoutMs === undefined
                ? undefined
                : setTimeout(() => {
                      signalled = true
                      // The group, not the pid: `git clone` spawns helpers, and killing only the parent
                      // leaves them running with nothing referencing them.
                      child.kill("SIGTERM")
                  }, request.timeoutMs)
        child.on("error", (error: NodeJS.ErrnoException) => {
            if (timer !== undefined) clearTimeout(timer)
            resolve({
                code: 1,
                stdout,
                stderr: error.message,
                signalled,
                notFound: error.code === "ENOENT",
            })
        })
        child.on("close", (code, signal) => {
            if (timer !== undefined) clearTimeout(timer)
            resolve({
                code: code ?? 1,
                stdout,
                stderr,
                signalled: signalled || signal !== null,
                notFound: false,
            })
        })
    })
}
