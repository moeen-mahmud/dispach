/**
 * `exec` — the agent doing something on the machine it runs on.
 *
 * ## Why there is no `env` argument
 *
 * The obvious signature has one, and it is a hole. A per-call environment map is invisible to the
 * policy engine: `exec(git status:*)` matches the command string, so an `env` of
 * `{ PATH: "/tmp/evil" }` beside a command of `git status` is allowed by a rule that never saw the
 * part that mattered. Written inline — `PATH=/tmp/evil git status` — the same attempt is *part of the
 * command*, `subcommands()` hands it to the matcher as one fragment, and the pattern `git status`
 * does not match it. The call asks or is refused.
 *
 * So environment variables are set the way they are set at any shell, in the command itself, and the
 * layer that decides whether a call runs gets to see all of it. Removing the field is not a
 * limitation here; it is what closes the gap between what a rule matches and what actually runs.
 *
 * The ambient environment — including whatever the agent's `.env` supplied — *is* passed through,
 * because a shell that cannot see `GITHUB_TOKEN` cannot run `gh`. That is a deliberate widening and
 * it is worth saying out loud: a pinned `exec` can read every secret the agent itself can.
 *
 * ## Why the description argues against itself
 *
 * `whenNotToUse` routes the model to `file_read`, `glob` and `grep` for anything those cover, and
 * that is a security control rather than a style note. A `file_read` call carries a `path` field a
 * rule can match exactly; `cat "$F"` carries a string in which the target is not addressable. The
 * structured tools are the layer where policy actually works, so the shell has to be the last resort
 * rather than the first — and a small model reaches for whatever the catalogue makes easiest.
 */

import { mkdir, realpath, rm, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool, ToolContext, ToolHandler, ToolProviderContext } from "@dispach/core"
import { execCommandEmpty, execWorkdirMissing } from "./errors.ts"
import { humanBytes, readOutput, stripLeadingEcho } from "./output.ts"
import { SYSTEM_PROVIDER_ID, spillDir } from "./paths.ts"
import { locate, type Roots } from "./root.ts"
import { runCommand } from "./run.ts"
import type { ShellSessions } from "./session.ts"

/** What a command gets if it asks for nothing. Two minutes covers a test run; a build often does not. */
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * The most any single call may ask for.
 *
 * Ten minutes, past which the answer is `background: true` rather than a longer wait — a turn that
 * spends a quarter of an hour inside one tool is not doing anything a person can follow.
 */
export const MAX_TIMEOUT_MS = 600_000

/**
 * Room left between this tool's deadline and the harness's.
 *
 * Without it the two are the same number by default (`limits.toolTimeoutMs` is also 120 s) and which
 * fires first is a race. The harness winning is the bad outcome: it abandons the handler rather than
 * killing it, so the child process survives with nothing holding a reference to it, and the
 * backgrounding path — the reason the deadline is interesting at all — never runs.
 */
const DEADLINE_MARGIN_MS = 5_000

export interface ExecOptions {
    readonly sessions: ShellSessions
    /** The manifest's environment layered over the ambient one, as the provider received it. */
    readonly env: Readonly<Record<string, string | undefined>>
    /**
     * Where a shell starts when nothing has moved it — the workspace, not the agent directory.
     *
     * Only the starting point. A shell cannot be confined to it: `sh -c "echo x > ~/notes"` carries
     * its target inside a string no path check can see, so `exec` is granted the machine and the
     * roots bind only the file tools. Said here because a reader of this field would otherwise
     * reasonably assume otherwise.
     */
    readonly roots: Roots
}

export const EXEC_SPEC: Tool["spec"] = {
    slug: "exec",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Runs a shell command on this computer and returns what it printed.",
    whenToUse:
        "you need to do something on this machine that no other tool covers — run a build or a test suite, use a command-line program, inspect what is running, or move and archive files in bulk",
    whenNotToUse:
        "reading one file, writing one file, or finding files by name or content — use file_read, file_write, glob and grep instead. They are more reliable and their targets can be checked against the permission rules; a path buried in a shell string cannot be",
    mutating: true,
    trust: "untrusted",
    policyArg: "command",
    tags: ["write", "system", "shell"],
    parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description:
                    "The command, exactly as it would be typed at a shell prompt. Set environment variables inline (VAR=value command) rather than expecting them to survive from an earlier call.",
            },
            workdir: {
                type: "string",
                description:
                    "Directory to run in. Relative paths are resolved against wherever the previous command ended up. Defaults to that directory, so a cd carries over.",
            },
            timeoutMs: {
                type: "integer",
                description: `How long to wait, in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
                default: DEFAULT_TIMEOUT_MS,
            },
            pty: {
                type: "boolean",
                description:
                    "Give the command a terminal. Needed only by programs that behave differently without one, such as those that ask for a password or draw a progress display.",
                default: false,
            },
            background: {
                type: "boolean",
                description:
                    "Start it and return immediately instead of waiting. Use for something long-running like a dev server; the output keeps accumulating in a file whose path is reported.",
                default: false,
            },
        },
        required: ["command"],
    },
}

/**
 * Clamp what was asked for to what can actually be waited on.
 *
 * Exported because the arithmetic decides whether the backgrounding path is reachable at all, and
 * that is worth a test rather than a reading of the code.
 */
export function effectiveTimeout(requested: number | undefined, deadlineMs: number): number {
    const asked = requested === undefined || requested <= 0 ? DEFAULT_TIMEOUT_MS : requested
    const capped = Math.min(asked, MAX_TIMEOUT_MS)
    const room = deadlineMs - DEADLINE_MARGIN_MS
    // A harness deadline too short to leave a margin still gets most of itself rather than a
    // negative number; finishing the kill is what matters, and 80% leaves time for it.
    return Math.max(1, Math.min(capped, room > 0 ? room : Math.floor(deadlineMs * 0.8)))
}

function numberArg(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Where this call's output and status files live. Unique per call, so nothing collides. */
function paths(context: ToolContext, callSalt: string): { out: string; status: string } {
    const dir = spillDir()
    return {
        out: resolve(dir, `${context.turnId}-${callSalt}.log`),
        status: resolve(dir, `${context.turnId}-${callSalt}.status`),
    }
}

export function execHandler(options: ExecOptions): ToolHandler {
    return async (args, context) => {
        const command = typeof args.command === "string" ? args.command.trim() : ""
        if (command === "") throw execCommandEmpty()

        const remembered = options.sessions.lastCwd(context.sessionKey)
        const base = remembered ?? options.roots.primary
        const asked = typeof args.workdir === "string" ? args.workdir.trim() : ""
        const wanted = asked === "" ? base : isAbsolute(asked) ? asked : resolve(base, asked)

        let cwd: string
        try {
            // `realpath`, not just `stat`. The shell reports `$PWD` with every symlink already
            // resolved, so comparing it against an unresolved path makes every call on macOS look
            // like it changed directory — `/var/…` going in, `/private/var/…` coming back. The
            // comparison decides whether the model is told the directory moved, and a runtime that
            // announces a move on every single command has taught it to ignore the one that matters.
            cwd = await realpath(wanted)
            if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory")
        } catch {
            // A remembered directory that has since been deleted must not fail every later call, so
            // the memory is cleared as part of reporting it. Asking again from a clean state is the
            // recovery, and the model is told that is what happened.
            const fromMemory = asked === "" && remembered !== undefined
            if (fromMemory) options.sessions.forget(context.sessionKey)
            throw execWorkdirMissing(wanted, fromMemory)
        }

        const timeoutMs = effectiveTimeout(numberArg(args.timeoutMs), context.deadlineMs)
        // Not when the request is the spec's own default: coercion fills that in for a model that
        // asked for nothing, and reporting it as a clamp put a misleading line on every such call.
        const requested = numberArg(args.timeoutMs)
        const clamped =
            requested !== undefined && requested !== DEFAULT_TIMEOUT_MS && timeoutMs < requested
        const background = args.background === true
        const dir = spillDir()
        await mkdir(dir, { recursive: true })
        const files = paths(context, hashCall(command, context.turnId))

        const run = await runCommand({
            command,
            cwd,
            env: options.env,
            timeoutMs,
            pty: args.pty === true,
            background,
            signal: context.signal,
            outPath: files.out,
            statusPath: files.status,
        })

        // Remembered whether or not it moved: an explicit `workdir` on this call becomes the starting
        // point for the next one, which is what a person means when they say "work in there".
        if (run.cwdAfter !== undefined) {
            options.sessions.remember(context.sessionKey, run.cwdAfter)
        }

        const read = await readOutput(files.out)
        const observation =
            args.pty === true ? { ...read, head: stripLeadingEcho(read.head) } : read

        // The status file has served its purpose either way. The output file is kept only when the
        // model was told where to find it — otherwise it is a temp file nobody will ever open.
        await rm(files.status, { force: true })
        if (!observation.spilled && run.ending !== "backgrounded") {
            await rm(files.out, { force: true })
        }

        return render({ command, cwd, run, observation, clamped, timeoutMs, path: files.out })
    }
}

/** Distinguishes two calls in one turn without a clock or a counter, both of which tests hate. */
function hashCall(command: string, turnId: string): string {
    let hash = 0x811c9dc5
    for (const text of [command, turnId]) {
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i)
            hash = Math.imul(hash, 0x01000193)
        }
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}

interface RenderInput {
    readonly command: string
    readonly cwd: string
    readonly run: Awaited<ReturnType<typeof runCommand>>
    readonly observation: Awaited<ReturnType<typeof readOutput>>
    readonly clamped: boolean
    readonly timeoutMs: number
    readonly path: string
}

/**
 * What the model reads.
 *
 * A successful, small, quiet command returns its output and nothing else — no header, no status
 * line, no framing. Everything below is a *departure* from that: a non-zero exit, a cut, a
 * background, a clamp. Anything that always appears is a per-call tax on every context window the
 * agent will ever assemble, and the exit code of a command that succeeded is not news.
 */
export function render(input: RenderInput): string {
    const notes: string[] = []

    if (input.clamped) {
        notes.push(
            `The requested timeout was longer than allowed, so this ran with ${input.timeoutMs} ms.`,
        )
    }

    if (input.run.ending === "backgrounded") {
        notes.push(
            `Still running${input.run.pid === undefined ? "" : ` as process ${input.run.pid}`}. It was left alone rather than stopped, and keeps writing to ${input.path}; read that file to see how far it has got. Nothing here is its final result.`,
        )
        return [...notes, section("Output so far", input.observation.head)].join("\n\n")
    }

    if (input.run.ending === "killed") {
        notes.push(
            `Stopped after ${input.timeoutMs} ms without finishing, and everything it started was stopped with it. Whatever it had already done still happened.`,
        )
    } else if (input.run.code !== undefined && input.run.code !== 0) {
        notes.push(`Failed with exit code ${input.run.code}.`)
    } else if (input.run.killedBy !== undefined) {
        notes.push(`Ended on signal ${input.run.killedBy}.`)
    }

    if (input.run.cwdAfter !== undefined && input.run.cwdAfter !== input.cwd) {
        notes.push(
            `The working directory is now ${input.run.cwdAfter}, and the next exec call starts there.`,
        )
    }

    const failed = input.run.ending === "killed" || (input.run.code ?? 0) !== 0
    const body: string[] = []

    if (input.observation.spilled) {
        notes.push(
            `Output was ${humanBytes(input.observation.bytes)}, too much to include. All of it is in ${input.path}; what follows is the ${failed ? "start and end" : "start"}.`,
        )
        body.push(section("First part of the output", input.observation.head))
        // The end is what a failure is actually about — the error is at the bottom, under however
        // many lines of ordinary progress came before it.
        if (failed) body.push(section("End of the output", input.observation.tail))
    } else if (input.observation.head.trim() !== "") {
        body.push(input.observation.head.trimEnd())
    } else if (notes.length === 0) {
        return "The command finished successfully and printed nothing."
    }

    return [...notes, ...body].join("\n\n")
}

function section(title: string, text: string): string {
    return `${title}:\n${text.trimEnd()}`
}

export function execTool(options: ExecOptions): Tool {
    // `workdir` and the command itself both decide where a command acts, and the command decides it in
    // a way nothing can check — so it is the one that most needs saying.
    return {
        spec: locate(EXEC_SPEC, options.roots, ["command", "workdir"], "shell"),
        handler: execHandler(options),
    }
}

/** The provider hands its own resolved environment through; nothing here reads `process.env`. */
export function execFromContext(
    context: ToolProviderContext,
    sessions: ShellSessions,
    roots: Roots,
): Tool {
    return execTool({ sessions, env: context.env, roots })
}
