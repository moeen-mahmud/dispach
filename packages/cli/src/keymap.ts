/**
 * Keystrokes in, intents out. Pure, and free of any Ink import.
 *
 * The one contract worth stating explicitly, because Phase 1 established and measured it:
 * **Ctrl-C cancels the turn, not the process.** Whether a keystroke means "cancel" or "exit"
 * depends on whether a turn is in flight, so that decision belongs here — in a function that can be
 * tested against both states — rather than in a component where it can only be tested by hand.
 */

import { lineInfo } from "#editor"
import { isTerminalReply } from "#lib/csi"
import { mouseInput } from "#lib/mouse"
import type { EditorState, Intent, KeyState, MotionKind } from "#lib/types"

export interface KeyContext {
    /** A turn is in flight. */
    readonly busy: boolean
    /** The input buffer is empty. */
    readonly empty: boolean
    /**
     * The cursor is on the first line, so ↑ means history rather than a line up.
     *
     * Position decides, because a multi-line buffer wants both and every editor resolves it this way:
     * at the top of what you are composing there is nothing above to move to, so the arrow is free to
     * mean the other thing. `^P`/`^N` stay unconditional history for anyone who would rather not think
     * about where the cursor is.
     */
    readonly firstLine: boolean
    readonly lastLine: boolean
    /** `^R` is open, so enter accepts a match and escape closes it. */
    readonly searching: boolean
    /**
     * A first ^C has already been pressed at an idle prompt, so the next one leaves.
     *
     * Held by the caller rather than derived, because it is the one piece of keyboard state with a
     * *clock* attached — it expires — and a pure function cannot own that. What it must not do is
     * decide what an armed ^C means, which is why the flag comes in here and the decision stays below.
     */
    readonly armed: boolean
    /**
     * The transcript window is parked above the newest row, so escape means "come back down".
     *
     * Escape had nothing to do at an idle prompt and was claimed as `none` to keep control characters
     * out of the buffer. A scrolled-away view is the one state where a reader plainly wants a way out
     * of where they are, and escape is the key they will press.
     */
    readonly scrolled: boolean
}

/**
 * The context for a given editor state.
 *
 * Exported and derived in one place so no renderer computes it by hand. `empty` was already this shape
 * — editor state passed to the keymap as context — and the two line flags are the same idea; a caller
 * that got `firstLine` wrong would make the arrows misbehave in a way no test of this module would see.
 */
export function keyContext(
    editor: EditorState,
    busy: boolean,
    session: { readonly armed?: boolean; readonly scrolled?: boolean } = {},
): KeyContext {
    const { line, lines } = lineInfo(editor)
    return {
        busy,
        empty: editor.value === "",
        firstLine: line === 0,
        lastLine: line === lines - 1,
        searching: editor.search !== undefined,
        armed: session.armed ?? false,
        scrolled: session.scrolled ?? false,
    }
}

/** Ctrl-key chords arrive as `key.ctrl` plus the letter in `input`. */
function ctrlIntent(letter: string, context: KeyContext): Intent {
    switch (letter) {
        case "c":
            // While a search is open, ^C dismisses it rather than the session: the search is the
            // foreground thing, and quitting the whole session from it would lose a message somebody
            // is part-way through composing.
            if (context.searching) return { kind: "searchCancel" }
            // The whole point. Busy means a turn is generating; interrupting it must leave the
            // prompt behind, not the shell.
            if (context.busy) return { kind: "cancel" }
            // At an idle prompt it takes two, and the first one says so.
            //
            // One press used to exit, which was defensible while the session left its conversation in
            // the scrollback: ^C landed you back in a shell with the transcript still above it. On the
            // alternate screen the buffer is discarded on the way out, so the same keystroke now throws
            // the visible conversation away — and it is one press away from the chord that means
            // "cancel this turn", pressed reflexively when a reply runs long. ^D still leaves in one,
            // for anyone who wants that, and the status line names whichever is live.
            return context.armed ? { kind: "exit" } : { kind: "arm" }
        case "d":
            // Ctrl-D is end-of-input, so it only ends the session when there is nothing to submit.
            // On a line with text it is a forward delete, as in a shell.
            return context.empty ? { kind: "exit" } : { kind: "delete" }
        case "a":
            return { kind: "cursorHome" }
        case "e":
            return { kind: "cursorEnd" }
        case "b":
            return { kind: "cursorLeft" }
        case "f":
            return { kind: "cursorRight" }
        case "u":
            return { kind: "killToStart" }
        case "k":
            return { kind: "killToEnd" }
        case "w":
            return { kind: "killWord" }
        case "p":
            return { kind: "historyPrev" }
        case "n":
            return { kind: "historyNext" }
        case "r":
            return { kind: "searchOpen" }
        case "o":
            // The same thing ⌥r does, on a chord that cannot fail to arrive.
            //
            // ⌥r needs either the kitty protocol or the terminal's option-as-meta setting; a ctrl letter
            // needs neither, because it is a single control byte every terminal has always sent. Reported
            // as "⌥r doesn't do anything", and while the immediate cause was a fold with nothing in it,
            // the standing cause is that a view toggle should not depend on a terminal handshake at all.
            // ^O is what the reference CLI binds its own transcript toggle to, so the habit transfers.
            return { kind: "reasoning" }
        case "z":
            // Undo, not SIGTSTP. Ink puts stdin in raw mode, so the terminal never generates the
            // signal and the byte arrives here — which makes this a choice rather than an accident.
            // Suspending a chat you can leave with ^D is worth little; undo is worth a lot, and the
            // footer says so, which is what keeps the trade visible.
            return { kind: "undo" }
        case "y":
            return { kind: "redo" }
        default:
            return { kind: "none" }
    }
}

export function keyToIntent(input: string, key: KeyState, context: KeyContext): Intent {
    // The mouse, before anything else, and unconditionally.
    //
    // Ink has no idea what a mouse report is and hands it over as text: with tracking on, one wheel notch
    // reached the insert branch and typed the report into the message. So every report is claimed here —
    // the wheel becomes a scroll and everything else becomes nothing at all, because a click that falls
    // through is the same bug with a different button.
    const mouse = mouseInput(input)
    if (mouse !== undefined) {
        if (mouse.rows !== 0) {
            return {
                kind: "scroll",
                move: mouse.rows < 0 ? "up" : "down",
                times: Math.abs(mouse.rows),
            }
        }
        // A press, drag or release. Reported rather than resolved: which row of the conversation a cell
        // sits on is a question about the frame, and this function has no frame. Still claimed either way —
        // a report that fell through would be typed into the message, which is the bug this branch exists
        // for and does not stop being one because the gesture is now useful.
        if (mouse.at !== undefined && mouse.kind !== undefined && mouse.kind !== "wheel") {
            return {
                kind: "pointer",
                gesture: mouse.kind,
                column: mouse.at.column,
                row: mouse.at.row,
                shift: mouse.shift === true,
            }
        }
        return { kind: "none" }
    }

    // A key *release* is not a keystroke. `reportEventTypes` is on so that `super` survives on an arrow
    // key (Ink's kitty branch requires the `:eventType` field), and the cost is that Ink hands the type
    // through without filtering — so every enhanced key arrives twice, down and up, and every chord would
    // fire twice. Repeats are kept: holding a key down is a real thing to do.
    if (key.eventType === "release") return { kind: "none" }

    // ─── shift extends a selection ───────────────────────────────────────────────────────
    //
    // Before the cmd, ctrl and option blocks, because every one of them would otherwise claim the chord
    // and drop the shift: `cmd+shift+←` arrives as `CSI 1;10D` — one plus shift plus super — and the
    // super block below matches on `key.super` without looking at shift at all.
    //
    // Only the motion keys are recognised, which is what keeps this from swallowing ordinary typing:
    // `key.shift` is true for every capital letter, and a letter matches none of the tests in
    // `shiftMotion`. Return is not a motion either, so `⇧⏎` still reaches the newline branch.
    if (key.shift) {
        const to = shiftMotion(key)
        if (to !== undefined) return { kind: "extend", to }
    }

    // ─── command chords ──────────────────────────────────────────────────────────────────
    //
    // `super` is Cmd, and it is only ever true once the kitty keyboard protocol has been negotiated —
    // no legacy sequence can express it, and Ink's legacy path folds it into `meta`, which is why
    // `cmd+←` used to word-move like `⌥←` instead of jumping to the start of the line.
    //
    // Horizontal is the line, vertical is the whole message: that is what macOS binds and what every
    // editor on the platform does. Before the ctrl and meta blocks because a chord can carry more than
    // one modifier, and cmd is the most specific claim.
    if (key.super) {
        if (key.leftArrow) return { kind: "cursorHome" }
        if (key.rightArrow) return { kind: "cursorEnd" }
        if (key.upArrow) return { kind: "bufferStart" }
        if (key.downArrow) return { kind: "bufferEnd" }
        if (key.backspace) return { kind: "killToStart" }
        if (key.delete) return { kind: "killToEnd" }
        if (input === "z") return key.shift ? { kind: "redo" } : { kind: "undo" }
        if (input === "a") return { kind: "selectAll" }
        // Unclaimed, and deliberately swallowed for the same reason an unclaimed option chord is: the
        // insert branch would type the bare letter, so cmd+s would put an "s" in the message.
        return { kind: "none" }
    }

    // Ctrl with an arrow or a backspace is the other spelling of a word operation — Linux and Windows
    // convention, and the reference honours `ctrl || meta || fn` for exactly one action because a
    // physical chord reaches a terminal in more than one encoding. Before `ctrlIntent`, which dispatches
    // on a *letter* and would see an empty string here.
    // A terminal's answer to a question this process asked is not a keystroke. Claimed next to the mouse
    // for the same reason: Ink hands it over as text, and text reaches the insert branch.
    if (isTerminalReply(input)) return { kind: "none" }

    if (key.ctrl && key.leftArrow) return { kind: "wordLeft" }
    if (key.ctrl && key.rightArrow) return { kind: "wordRight" }
    if (key.ctrl && key.backspace) return { kind: "killWord" }

    if (key.ctrl) return ctrlIntent(input.toLowerCase(), context)

    // ─── option chords ───────────────────────────────────────────────────────────────────
    //
    // Every one of these is measured against Ink's parser rather than assumed, because a terminal has
    // more than one way to send them and the parser reporting *a* key says nothing about which:
    //
    //   ⌥←  Apple Terminal `ESC b`      → input "b" + meta      iTerm2 `CSI 1;3D` → leftArrow + meta
    //   ⌥→  Apple Terminal `ESC f`      → input "f" + meta      iTerm2 `CSI 1;3C` → rightArrow + meta
    //   ⌥⌫  `ESC DEL`                   → backspace + meta
    //   ⌥d  `ESC d`                     → input "d" + meta
    //   ⌥r  `ESC r`                     → input "r" + meta
    //   ⌥⏎  `ESC CR`                    → return + meta
    //   ⇧⏎  kitty protocol `CSI 13;2u`  → return + shift        (only once the terminal is taught)
    //
    // Both spellings of each are honoured, so the same binding works in both families of terminal.
    //
    // Under the kitty protocol these arrive as `CSI <codepoint>;3u` instead — `⌥r` is `CSI 114;3u`, and
    // Ink reports it as `input "r"` with `meta` set, which is the same shape the table above describes.
    // That is why negotiating the protocol needed no change here: these bindings were always right and
    // simply never arrived, because Warp's Option-as-Meta setting is off by default and `⌥r` was
    // reaching us as the composed character `®`.
    if (key.meta) {
        if (key.return) return { kind: "newline" }
        // ⌥↑/⌥↓ walk the conversation a row at a time, and ⌥PgUp/⌥PgDn go to its ends. Bare ↑/↓ cannot
        // do this: they already mean line movement inside a message and history at its edges, and a
        // third meaning on one key is how a keyboard stops being predictable.
        if (key.pageUp) return { kind: "scroll", move: "top" }
        if (key.pageDown) return { kind: "scroll", move: "bottom" }
        if (key.upArrow) return { kind: "scroll", move: "up" }
        if (key.downArrow) return { kind: "scroll", move: "down" }
        if (key.leftArrow || input === "b") return { kind: "wordLeft" }
        if (key.rightArrow || input === "f") return { kind: "wordRight" }
        if (key.backspace) return { kind: "killWord" }
        if (input === "d") return { kind: "killWordForward" }
        // Reasoning is folded to a few rows by default, and this is how the rest of it is read. Same
        // shape as ⌥d — a letter with meta — so it works wherever the chords above already do.
        if (input === "r") return { kind: "reasoning" }
        // An unclaimed option chord does nothing. Falling through would reach the insert branch and
        // type the bare letter, so ⌥s would silently put an "s" in the message. Composed characters
        // (é, ∆) are unaffected: macOS sends those as the character itself, with no meta flag.
        return { kind: "none" }
    }

    // Shift+enter is a newline where the terminal can express it — `terminal-setup` is what teaches
    // iTerm2, VS Code, Ghostty and Kitty to send the sequence Ink already understands. Where it
    // cannot, this is never true and ⏎ submits, which is why ⌥⏎ is the documented chord.
    if (key.return && key.shift) return { kind: "newline" }

    // Paging the conversation, unmodified.
    //
    // Deliberately not ^U/^D, which the plan named: both are already taken by the editor — ^U deletes to
    // the start of the line and ^D leaves an empty one — and they are documented, shell-standard, and
    // reached by muscle memory. A scroll key that silently deleted half a message would be a worse bug
    // than no scroll key.
    if (key.pageUp) return { kind: "scroll", move: "pageUp" }
    if (key.pageDown) return { kind: "scroll", move: "pageDown" }

    // Home and End. Ink has always parsed them; `KeyState` never declared the fields, so both keys did
    // nothing whatsoever until now. The raw-sequence fallback further down catches the terminals that
    // send a spelling Ink does not flag.
    if (key.home) return { kind: "cursorHome" }
    if (key.end) return { kind: "cursorEnd" }

    if (key.return) return context.searching ? { kind: "searchAccept" } : { kind: "submit" }
    if (key.backspace) return { kind: "backspace" }
    if (key.delete) return { kind: "delete" }
    if (key.leftArrow) return { kind: "cursorLeft" }
    if (key.rightArrow) return { kind: "cursorRight" }
    // History at the edges of the buffer, line movement inside it. While searching both walk the match
    // list, which the reducer routes — the arrows mean "previous" and "next" either way.
    if (key.upArrow) {
        return context.searching || context.firstLine ? { kind: "historyPrev" } : { kind: "lineUp" }
    }
    if (key.downArrow) {
        return context.searching || context.lastLine
            ? { kind: "historyNext" }
            : { kind: "lineDown" }
    }

    // Escape closes a search; otherwise it is claimed deliberately and does nothing, rather than
    // falling through to the insert branch where it would put a control character into the buffer and
    // be sent to a model. Tab is claimed for the same reason.
    if (key.escape) {
        if (context.searching) return { kind: "searchCancel" }
        return context.scrolled ? { kind: "scroll", move: "bottom" } : { kind: "none" }
    }
    if (key.tab) return { kind: "none" }

    // A paste arrives as one large `input` with no key flags, so insert has to accept many
    // characters at once rather than assuming a single keypress.
    if (input === "") return { kind: "none" }

    // Home and End again, by raw sequence. There are four spellings in the wild and Ink flags only some
    // of them — the reference keeps the same fallback for the same reason (`useTextInput.ts:385-389`).
    // After the empty-input check and before the printable filter, which would otherwise strip the
    // escape and insert `[H` into the message.
    if (input === "\u001B[H" || input === "\u001B[1~") return { kind: "cursorHome" }
    if (input === "\u001B[F" || input === "\u001B[4~") return { kind: "cursorEnd" }

    // Newlines inside that chunk are line breaks, not control noise. Stripping them — which the
    // printable filter below would do — silently joins the last word of one line to the first word
    // of the next and submits nothing, so a pasted multi-line prompt arrives mangled with no error.
    if (/[\r\n]/.test(input)) {
        const lines = input.split(/\r\n|[\r\n]/).map(printableOnly)
        // A trailing newline means the final line is finished too; without one, the tail is still
        // being typed.
        const complete = lines.at(-1) === "" && lines.length > 1
        return { kind: "paste", lines: complete ? lines.slice(0, -1) : lines, complete }
    }

    const printable = printableOnly(input)
    return printable === "" ? { kind: "none" } : { kind: "insert", text: printable }
}

/**
 * Which motion a shift chord extends by, or `undefined` when the key is not a motion at all.
 *
 * Modifier first, then the bare keys, so `shift+cmd+←` is a line and `shift+⌥←` is a word rather than both
 * being a character. `shift+↑` extends a line up even on the first line, where the unshifted arrow means
 * history: selecting upward is unambiguous, and a history chord that also grew a selection would be one
 * key doing two unrelated things.
 *
 * `input` is deliberately not consulted. The `ESC b` spelling of `⌥←` would arrive shifted as `ESC B`, and
 * matching a capital letter here is how `shift+B` would start selecting words. Terminals send the CSI form
 * for a shifted arrow, which carries the flags this reads.
 */
function shiftMotion(key: KeyState): MotionKind | undefined {
    if (key.super) {
        if (key.leftArrow) return "cursorHome"
        if (key.rightArrow) return "cursorEnd"
        if (key.upArrow) return "bufferStart"
        if (key.downArrow) return "bufferEnd"
        return undefined
    }
    if (key.meta || key.ctrl) {
        if (key.leftArrow) return "wordLeft"
        if (key.rightArrow) return "wordRight"
        return undefined
    }
    if (key.home) return "cursorHome"
    if (key.end) return "cursorEnd"
    if (key.leftArrow) return "cursorLeft"
    if (key.rightArrow) return "cursorRight"
    if (key.upArrow) return "lineUp"
    if (key.downArrow) return "lineDown"
    return undefined
}

/**
 * Drop C0 controls and DEL. A bracketed-paste marker or a stray escape sequence reaching the buffer
 * would be invisible on screen and sent to the model as if it had been typed.
 */
function printableOnly(text: string): string {
    return [...text]
        .filter((char) => {
            const code = char.codePointAt(0) ?? 0
            return code >= 0x20 && code !== 0x7f
        })
        .join("")
}

// ─── screen keymaps ──────────────────────────────────────────────────────────────────────
//
// The wizard and picker differ from the chat input in what Esc means — a *context*, not a new
// module, which is why they live here beside `keyToIntent` rather than in per-screen files: one
// keyboard home, closed by the same drift tests.

import type { SelectMove } from "#lib/select"

export type ListIntent =
    | { readonly kind: "move"; readonly move: SelectMove }
    | { readonly kind: "choose" }
    | { readonly kind: "back" }
    | { readonly kind: "exit" }
    | { readonly kind: "none" }

/**
 * A checklist adds two verbs a single-select list does not have: tick a row, and finish.
 *
 * Space ticks and enter finishes, which is the convention every multi-select in a terminal uses — and
 * getting it the other way round is the mistake that makes a picker feel broken, because enter on a
 * highlighted row is such a strong habit that people submit with one thing ticked and never see the rest.
 * `a` and `n` are all/none, worth having when the list is fifty rows long.
 */
export type CheckIntent =
    | { readonly kind: "move"; readonly move: SelectMove }
    | { readonly kind: "toggle" }
    | { readonly kind: "all" }
    | { readonly kind: "none-selected" }
    | { readonly kind: "confirm" }
    | { readonly kind: "cancel" }
    | { readonly kind: "none" }

export function keyToCheckIntent(input: string, key: KeyState): CheckIntent {
    if (key.ctrl) {
        return input.toLowerCase() === "c" || input.toLowerCase() === "d"
            ? { kind: "cancel" }
            : { kind: "none" }
    }
    if (key.return) return { kind: "confirm" }
    if (key.escape) return { kind: "cancel" }
    // Ink reports the space bar as the input string " " with no flag of its own.
    if (input === " ") return { kind: "toggle" }
    if (input === "a") return { kind: "all" }
    if (input === "n") return { kind: "none-selected" }

    const list = keyToListIntent(input, key)
    // Movement is shared so the two lists cannot drift apart; `choose` cannot arrive, because `key.return`
    // is handled above, and the remaining kinds are not this screen's.
    return list.kind === "move" ? list : { kind: "none" }
}

/**
 * List navigation: arrows or j/k, g/G for ends, enter chooses, esc backs out, ^C/^D leave.
 *
 * A digit jumps the cursor — visibly and reversibly — and deliberately does not choose: a stray
 * number must never launch an agent.
 */
export function keyToListIntent(input: string, key: KeyState): ListIntent {
    if (key.ctrl) {
        return input.toLowerCase() === "c" || input.toLowerCase() === "d"
            ? { kind: "exit" }
            : { kind: "none" }
    }
    if (key.return) return { kind: "choose" }
    if (key.escape) return { kind: "back" }
    if (key.upArrow) return { kind: "move", move: { kind: "up" } }
    if (key.downArrow) return { kind: "move", move: { kind: "down" } }

    switch (input) {
        case "k":
            return { kind: "move", move: { kind: "up" } }
        case "j":
            return { kind: "move", move: { kind: "down" } }
        case "g":
            return { kind: "move", move: { kind: "first" } }
        case "G":
            return { kind: "move", move: { kind: "last" } }
        default:
            break
    }
    if (/^[1-9]$/.test(input)) {
        return { kind: "move", move: { kind: "jump", index: Number(input) - 1 } }
    }
    return { kind: "none" }
}

export type WizardKeyIntent =
    | { readonly kind: "back" }
    | { readonly kind: "abort" }
    | { readonly kind: "commit" }
    | { readonly kind: "list"; readonly intent: ListIntent }
    | { readonly kind: "edit"; readonly intent: Intent }

/**
 * The wizard's chrome keys are checked before delegation — Esc means "back a question" here,
 * which is exactly why chat's `keyToIntent` (which claims Esc as none) is not reused raw.
 *
 * Text steps then get the full chat editor treatment (^A/^E, ^W, code-point cursor); select steps
 * get the list navigation. A pasted blob collapses to its first line — a wizard answer is one
 * line — and history chords mean nothing inside a question.
 */
export function keyToWizardIntent(
    input: string,
    key: KeyState,
    context: { readonly select: boolean; readonly empty: boolean },
): WizardKeyIntent {
    if (key.ctrl && input.toLowerCase() === "c") return { kind: "abort" }
    if (key.escape) return { kind: "back" }
    if (key.return) return { kind: "commit" }

    if (context.select) {
        return { kind: "list", intent: keyToListIntent(input, key) }
    }

    // A wizard answer is one line — a pasted blob collapses to its first — so the cursor is always on
    // both the first and the last line, and ↑/↓ mean history rather than line movement. There is no
    // search here either.
    const intent = keyToIntent(input, key, {
        busy: false,
        empty: context.empty,
        firstLine: true,
        lastLine: true,
        searching: false,
        // A question is not a conversation: there is nothing to scroll and nothing to arm, and Esc is
        // claimed above as "back a question" before this is ever reached.
        armed: false,
        scrolled: false,
    })
    switch (intent.kind) {
        case "submit":
            return { kind: "commit" }
        case "exit":
            // ^D on an empty question line reads as "get me out", same as ^C.
            return { kind: "abort" }
        case "arm":
        case "scroll":
            // Unreachable in practice — ^C is claimed as `abort` above and there is nothing to scroll —
            // and listed rather than left to the default, so adding a session-only intent cannot
            // silently become an edit the wizard applies to a field.
            return { kind: "edit", intent: { kind: "none" } }
        case "historyPrev":
        case "historyNext":
            return { kind: "edit", intent: { kind: "none" } }
        case "paste":
            return {
                kind: "edit",
                intent: { kind: "insert", text: intent.lines[0] ?? "" },
            }
        default:
            return { kind: "edit", intent }
    }
}
