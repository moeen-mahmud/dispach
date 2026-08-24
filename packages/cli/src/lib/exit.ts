/**
 * One way out of the process.
 *
 * Two failure modes this exists to prevent, both of which the previous CLI had:
 *
 * **A hidden cursor and a terminal left in raw mode.** Ink hides the cursor and puts stdin in raw
 * mode. `process.exit()` from anywhere else — an error path, a signal, an uncaught rejection —
 * skips React's cleanup, and the shell you get back does not echo what you type. Recovering needs
 * `stty sane`, and nothing tells you that. So the restore is registered on `process.on("exit")`
 * as well as run explicitly: whatever route the process takes out, the terminal is handed back.
 *
 * **Truncated output.** `process.stdout.write` to a *pipe* is asynchronous, and `process.exit()`
 * discards whatever has not flushed — so a `sessions … | head` invocation could lose its last lines,
 * intermittently and only when piped. Measured: 10 MB written and then exited immediately arrives as
 * **65,536 bytes**, one pipe buffer.
 *
 * The rule used to be "set `process.exitCode` and let the event loop drain", and that rule assumed the
 * loop *can* drain. It cannot. A command that boots a runtime leaves a keep-alive TLS socket to the
 * tool provider in Node's global `fetch` pool — `backend.composio.dev:443`, opened by the
 * post-readiness refresh — and that socket is ref'd, with no public API to close it. Measured: the
 * process was still alive **180 seconds** after `/exit`, and the `tools` command had to be killed at 30 s.
 * `^C` appeared to work only because SIGINT is deliberately unhandled here, so the default action kills
 * the process. a `tools --json | jq` invocation would have waited forever.
 *
 * So the rule is now: run the teardowns, drain the output *properly*, then leave. Both halves are
 * load-bearing — draining without leaving is the hang above, and leaving without draining is the
 * truncation above.
 */

import {
    DISABLE_ENHANCED_KEYS,
    EXIT_FAILURE,
    EXIT_SIGTERM,
    LEAVE_ALT_SCREEN,
    RESET_STYLE,
    SHOW_CURSOR,
} from "#lib/const"
import { DISABLE_MOUSE } from "#lib/mouse"
import type { TerminalHandles } from "#lib/schema"

/**
 * The real streams. Spelled out rather than passing `process` itself, which has no `in`/`out` —
 * that mistake typechecked against the structural type and threw only at runtime, inside the one
 * function whose entire job is to run when things have already gone wrong.
 */
function processHandles(): TerminalHandles {
    return { out: process.stdout, in: process.stdin }
}

type Teardown = () => void | Promise<void>

const teardowns: Teardown[] = []
let guardsInstalled = false
let restored = false
let dirty = false
let altScreen = false
let mouse = false
let enhancedKeys = false
let signalsClaimed = false

/**
 * Declare that the terminal has been put into a state that needs undoing — raw mode, a hidden
 * cursor, alternate styling. Only the rich path does this.
 *
 * Without the flag, the restore would fire on *every* exit, including the plain path, which puts a
 * cursor-and-style reset at the end of output that is otherwise pure text. That breaks the property
 * plain mode exists for: `--plain` at a terminal has to produce exactly what a pipe produces.
 */
export function markTerminalDirty(): void {
    dirty = true
}

/**
 * Declare that the alternate screen buffer has been entered, so the restore swaps back out of it.
 *
 * Separate from `markTerminalDirty` rather than folded into it, because the two are not the same
 * claim: every rich surface dirties the terminal, and only the ones that *take* it need swapping
 * back. Folding them together would write the leave sequence after every wizard and every chat
 * session, and a `1049l` sent to a terminal that never entered the buffer clears the screen the
 * output was just written to — the plain path's parity rule, broken in the least debuggable way.
 *
 * Setting this and never entering is therefore worse than the reverse. The host that writes
 * `ENTER_ALT_SCREEN` calls this in the same statement.
 */
export function markAltScreen(): void {
    dirty = true
    altScreen = true
}

/**
 * The session asked the terminal to report the mouse, so the terminal has to be told to stop.
 *
 * Separate from `markAltScreen` because only the chat reads mouse reports. A surface that enabled
 * tracking without claiming every report would have them typed into it as text, which is what Ink does
 * with one — so the flag follows whoever handles them rather than whoever took the screen.
 *
 * Left on, the shell that gets the terminal back emits a report on every click and scroll, into a prompt
 * that has no idea what they are. That is the failure worth being loud about: it outlives the process.
 */
export function markMouse(): void {
    dirty = true
    mouse = true
}

/**
 * Ink negotiated the kitty keyboard protocol, so the terminal has to be told to stop reporting that way.
 *
 * Ink pops it itself on unmount and around a suspend — this exists for the path it cannot cover, which is
 * the same one `markMouse` exists for: a signal. `SIGTERM` is the only route a service manager uses, and
 * a terminal left in the protocol hands the next shell `CSI u` for every Ctrl chord, which reads as a
 * broken keyboard and outlives the process.
 *
 * Set by the render sites rather than derived, because whether the protocol was actually *pushed* depends
 * on the terminal answering a query 200 ms after mount — so the honest flag is "we asked", and popping a
 * protocol that was never pushed is a no-op on every terminal.
 */
export function markEnhancedKeys(): void {
    dirty = true
    enhancedKeys = true
}

/**
 * Run before the process ends. Registration order is preserved and reversed on the way out, so a
 * later-registered resource is released before the thing it depends on.
 */
export function onExit(teardown: Teardown): void {
    teardowns.push(teardown)
}

/**
 * Take ownership of SIGTERM, for a command whose shutdown *is* the point.
 *
 * The default guard answers SIGTERM with `finishNow(EXIT_SIGTERM)`, which is right for a command
 * that was interrupted: 143 is the shell convention and the work was not finished. It is wrong for
 * `serve`, where a signal is the ordinary and expected way to stop — the work was to stay up, and
 * being asked to stop is the successful end of it, not a failure.
 *
 * That distinction is not cosmetic once a service manager is involved. The generated service
 * definition restarts only on a crash, precisely so a misconfiguration stops once instead of
 * looping forever; a graceful stop reported as 143 is indistinguishable from that misconfiguration,
 * so the supervisor would refuse to bring the agent back.
 *
 * The caller must resolve its own wait on the signal and return an exit code normally. Everything
 * registered with `onExit` still runs, because `finish` awaits the teardowns either way.
 */
export function claimSignals(): void {
    signalsClaimed = true
}

/**
 * Synchronous by necessity — `process.on("exit")` cannot await. Idempotent, because it runs both
 * explicitly and from the exit hook.
 */
export function restoreTerminal(handles: TerminalHandles = processHandles()): void {
    if (restored || !dirty) return
    restored = true
    if (handles.in.isTTY === true && handles.in.setRawMode !== undefined) {
        handles.in.setRawMode(false)
    }
    if (handles.out.isTTY !== true) return
    // Style and cursor first, buffer swap second. A reset applies to the buffer that is current when
    // it arrives, so resetting after the swap leaves the app's last colour on the shell's screen and
    // dutifully resets the one being thrown away.
    handles.out.write(`${RESET_STYLE}${SHOW_CURSOR}`)
    // Before the buffer swap, for the same reason the style reset is: the request was made against this
    // buffer and the shell must not be left with a terminal that reports clicks at it.
    if (mouse) handles.out.write(DISABLE_MOUSE)
    // Before the buffer swap for the same reason, and after the mouse for no reason but stable ordering
    // — a test asserts the sequence, and an order nothing pins is an order that drifts.
    //
    // This is usually the *second* pop: Ink pops on unmount, and on both the normal and the signal path
    // the unmount teardown has already run by the time this fires. Kept anyway, because the path it exists
    // for is the one where teardowns do not run at all — a hard crash — and a terminal left reporting
    // `CSI u` for every Ctrl chord outlives the process. Seen in a capture as `[<u[<u`.
    //
    // The cost is stated rather than hidden. A pop on an empty stack is ignored, so standalone this is
    // harmless; nested inside *another* application that pushed its own flags, the extra pop takes that
    // application's entry instead. That trade is accepted for a top-level CLI and would be the wrong one
    // for a library.
    if (enhancedKeys) handles.out.write(DISABLE_ENHANCED_KEYS)
    if (altScreen) handles.out.write(LEAVE_ALT_SCREEN)
}

/** Test seam. Nothing in `src/` outside this module calls it. */
export function resetForTests(
    options: {
        readonly dirty?: boolean
        readonly altScreen?: boolean
        readonly mouse?: boolean
        readonly enhancedKeys?: boolean
    } = {},
): void {
    teardowns.length = 0
    restored = false
    dirty = options.dirty ?? true
    altScreen = options.altScreen ?? false
    mouse = options.mouse ?? false
    enhancedKeys = options.enhancedKeys ?? false
    signalsClaimed = false
}

/** Enough of a stream to wait on. Spelled out so a test can supply one without a pipe. */
interface Drainable {
    write(chunk: string, callback: () => void): unknown
    readonly writableEnded?: boolean
    readonly destroyed?: boolean
}

/**
 * Wait until everything written to stdout has actually reached the operating system.
 *
 * This used to test `writableNeedDrain` and await a `drain` event, which is a weaker claim than it
 * reads as: the flag is only true once the buffer is *over* the high-water mark, so a modest pending
 * write to a pipe reported nothing to wait for and the function named "flush" returned immediately.
 * That was survivable while the process went on to idle until the loop emptied, and is not survivable
 * now that it exits on purpose.
 *
 * A zero-length write is the receipt. `Writable` invokes callbacks in write order once the underlying
 * write completes, so a chunk queued behind everything else calls back only after everything else has
 * gone out. Measured against a pipe with a sleeping reader: 10 MB exits complete, where an immediate
 * `process.exit` delivered 65,536 bytes.
 *
 * **The wait is deliberately unbounded.** A timeout would trade a silent truncation for a bounded exit,
 * and with a slow reader — `| less`, a terminal being scrolled — truncation is the worse of the two. A
 * closed reader is not the hazard it looks like: the callback still fires, carrying `EPIPE`.
 *
 * Also awaited between turns, where the point is different: a long session feeding a slow reader
 * accumulates unwritten output in memory, and this bounds that to one turn's worth.
 */
export async function flushOutput(stream: Drainable = process.stdout): Promise<void> {
    // Nothing to wait for, and writing would throw. Checked rather than caught, because a throw here
    // lands inside the function whose whole job is to run when things are already ending.
    if (stream.writableEnded === true || stream.destroyed === true) return
    await new Promise<void>((resolve) => {
        stream.write("", () => resolve())
    })
}

async function runTeardowns(): Promise<void> {
    for (const teardown of [...teardowns].reverse()) {
        try {
            await teardown()
        } catch (error) {
            // A failing teardown must not mask the exit code that brought us here, and must not
            // stop the remaining teardowns — the terminal restore is one of them.
            process.stderr.write(
                `warning: cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
            )
        }
    }
    teardowns.length = 0
}

/**
 * Everything that has to happen before the process ends: teardowns, the terminal, the exit code, and
 * the output.
 *
 * Sets `process.exitCode` rather than exiting, so a caller that has its own reason to stay alive can.
 * Nothing in `src/` is such a caller any more — the entry point uses `finishNow` — but the split is
 * what makes this testable: a `finish` that exited would take the test runner with it.
 */
export async function finish(code: number): Promise<void> {
    await runTeardowns()
    restoreTerminal()
    process.exitCode = code
    await flushOutput()
}

/**
 * Finish, and then actually leave.
 *
 * The ordinary way out, not the exceptional one. It was written for a signal or a crash — "where
 * waiting for the loop to drain would mean hanging" — on the assumption that the ordinary path could
 * wait. It cannot: the module docstring records the measurement, a keep-alive socket in the global
 * `fetch` pool that outlived the process by three minutes.
 *
 * Safe to call here and nowhere earlier, because `finish` has already awaited the teardowns and the
 * output. Anything still holding the loop open at this point is a resource with no owner, and waiting
 * on one is what the hang was.
 */
export async function finishNow(code: number): Promise<never> {
    await finish(code)
    process.exit(code)
}

/**
 * Guards for the ways a process dies without being asked to.
 *
 * `SIGINT` is deliberately **not** handled here. During a turn it means "cancel this turn", not
 * "exit" — the chat path owns it, and a guard that exited would break the contract Phase 1
 * established and measured.
 */
export function installGuards(): void {
    if (guardsInstalled) return
    guardsInstalled = true

    // Last line of defence. Runs even when something calls process.exit directly.
    process.on("exit", () => restoreTerminal())

    process.on("SIGTERM", () => {
        // Yield to a command that owns its own shutdown. Without this the two handlers raced and
        // the hard exit won: `serve`'s graceful path started, `process.exit(143)` landed first, and
        // `runtime.stop()` never completed — so the outbox was not flushed, the database was not
        // closed, and the child processes `exec` backgrounds were never reaped. Invisible at a
        // terminal, because ctrl-C sends SIGINT and this guard deliberately ignores that one.
        if (signalsClaimed) return
        void finishNow(EXIT_SIGTERM)
    })

    const crash = (label: string) => (error: unknown) => {
        restoreTerminal()
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
        // Loud and non-zero. An unexpected failure that exits 0 is the thing hard rule 8 forbids.
        process.stderr.write(`\n${label}: ${message}\n`)
        void finishNow(EXIT_FAILURE)
    }
    process.on("uncaughtException", crash("uncaught exception"))
    process.on("unhandledRejection", crash("unhandled rejection"))
}
