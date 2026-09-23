/**
 * Running one of this binary's own commands, for a pane inside a session.
 *
 * ## Why a child process rather than calling the function
 *
 * The obvious implementation is to call `validateCommand()` and swap `process.stdout.write` for a
 * collector. It is also wrong here: Ink *owns* stdout while a session is mounted, and it writes a frame
 * whenever anything re-renders. A frame drawn during the capture window lands in the collector instead of
 * on the terminal — so the screen silently misses a repaint and the pane shows a frame of itself. Nothing
 * errors; the display is just wrong, intermittently, depending on timing.
 *
 * A child writes to its own pipe. Nothing is hijacked, the frame keeps rendering, and the pane shows
 * exactly what the command prints — which is also the honest thing to show, since "run this command" is
 * what the palette offered. The cost is process startup, which is the same ~100 ms every command in this
 * CLI already pays and is invisible next to reading the result.
 *
 * `--plain` is forced, for the reason it exists: a child that thought it had a terminal would return
 * escape sequences, and the pane would render them as text.
 */

import { findCommand } from "#lib/commands"
import { selfInvocation } from "#lib/self"
import { spawnCaptureAsync } from "#lib/spawn"

export interface SubcommandResult {
    readonly lines: readonly string[]
    readonly code: number
}

export interface SubcommandRequest {
    readonly name: string
    /** Arguments as typed after the command word, split on whitespace. */
    readonly rest: string
    /** The agent this session is running, passed to any command that takes a manifest. */
    readonly manifestPath: string
    /** Injected by tests. `process.execPath` and `process.argv[1]` otherwise. */
    readonly interpreter?: string
    readonly script?: string
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly timeoutMs?: number
}

/**
 * Where this command wants the manifest among its positionals, or `-1` for one that takes none.
 *
 * Read off the command's own spec rather than a hand-kept list, which was wrong in both directions at
 * once. `NO_MANIFEST` held four names: `soul` takes an *action* first and was not listed, so
 * `/soul distill` ran as `soul <manifestPath> distill` and the action became a path — broken in-session
 * for as long as it has been offered there; and `agents` takes a variadic manifest first and *was*
 * listed, so it ran with none at all.
 *
 * It also could not express the real shape. `config` and `memory` take an action and *then* a manifest,
 * so "prepend or not" has no right answer for them — the path belongs at index 1. `soul`'s second
 * positional is a `file` (a long-form identity document, not a manifest), which is why matching on the
 * name matters rather than on the position.
 *
 * The same drift `session-commands.ts` exists to end: a second list describing `COMMANDS` disagrees with
 * it on the first command either one grows. Derived, a new command is covered with nothing to remember.
 */
function manifestIndex(name: string): number {
    return findCommand(name)?.args.findIndex((arg) => arg.name === "manifest") ?? -1
}

/**
 * The argv for a request.
 *
 * Pure and exported so the assembly is testable without starting anything — which matters because
 * getting it wrong means a command runs against the wrong agent, and that is not visible in the output.
 */
export function subcommandArgv(request: SubcommandRequest): readonly string[] {
    const rest = request.rest.trim() === "" ? [] : request.rest.trim().split(/\s+/)
    const at = manifestIndex(request.name)
    // Inserted only when everything before it was typed. `/skills` bare would otherwise become
    // `skills <manifestPath>`, putting a path where the action goes — and a command that resolves the
    // agent from the cwd instead is the lesser wrong: it may pick a different agent, where this one
    // cannot run at all. `--plain` stays last, so it cannot be swallowed as a flag's value.
    const positionals =
        at === -1 || rest.length < at
            ? rest
            : [...rest.slice(0, at), request.manifestPath, ...rest.slice(at)]
    return [request.name, ...positionals, "--plain"]
}

/**
 * Why a pane must not run this request, if it must not.
 *
 * A pane captures a child to completion, so a command that never finishes is a pane that shows a spinner
 * until the timeout fires and then reports being killed — thirty seconds of a frozen surface for a flag
 * that worked perfectly at a shell. `daemon logs --follow` is the case: it exists precisely to keep
 * printing until interrupted, and there is nothing for it to be interrupted *by* in here.
 *
 * Refused rather than quietly dropped. Dropping the flag would hand back the tail, which looks like a
 * following command that stopped immediately — a wrong answer that reads as a right one. Keyed off the
 * command's own spec, so a second command that grows a `follow` flag is covered with nothing to remember.
 */
export function paneRefusal(request: SubcommandRequest): string | undefined {
    const spec = findCommand(request.name)
    if (spec === undefined) return undefined
    const follow = spec.flags.find((flag) => flag.name === "follow")
    if (follow === undefined) return undefined
    const tokens = request.rest.trim().split(/\s+/)
    const asked = tokens.some(
        (token) =>
            token === "--follow" || (follow.short !== undefined && token === `-${follow.short}`),
    )
    if (!asked) return undefined
    return `--follow keeps printing until it is interrupted, and a pane has nothing to interrupt it with. Run it in its own terminal: ${request.name} ${request.rest.trim()}`
}

export async function runSubcommand(request: SubcommandRequest): Promise<SubcommandResult> {
    const refusal = paneRefusal(request)
    // Non-zero, because it did not do what was asked. A refusal reported as success is the shape hard
    // rule 8 forbids, whatever the message says.
    if (refusal !== undefined) return { lines: [refusal], code: 1 }

    /**
     * **The compiled binary is its own command and takes no script argument.**
     *
     * This read `[execPath, argv[1], ...]` unconditionally, which is right under node and wrong in
     * the artefact this ships as: `argv[1]` there is `/$bunfs/root/<binary>`, a path inside bun's
     * embedded filesystem, and passing it made every pane command answer `Unknown command
     * "/$bunfs/root/<bin>-linux-arm64"`. Reported on `/channels` in the container; it was never
     * about `/channels`.
     *
     * `request.interpreter`/`request.script` still override, because the tests inject both.
     */
    const self = selfInvocation()
    const interpreter = request.interpreter ?? self.command
    const lead =
        request.script !== undefined
            ? [request.script]
            : request.interpreter !== undefined
              ? [""]
              : self.args
    const result = await spawnCaptureAsync({
        command: interpreter,
        args: [...lead, ...subcommandArgv(request)],
        ...(request.env === undefined ? {} : { env: request.env }),
        timeoutMs: request.timeoutMs ?? 30_000,
    })

    // stderr is shown, not dropped. A command that failed says why on stderr, and a pane that showed only
    // stdout would render an empty box for the case a person most needs to read.
    const body = [result.stdout, result.stderr].filter((part) => part.trim() !== "").join("\n")
    const lines = body === "" ? [] : body.replace(/\n+$/, "").split("\n")
    if (result.notFound) {
        return { lines: [`could not run ${interpreter}`], code: 1 }
    }
    if (result.signalled) {
        return { lines: [...lines, `${request.name} was stopped before it finished`], code: 1 }
    }
    return { lines, code: result.code }
}
