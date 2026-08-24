import { describe, expect, test } from "bun:test"
import { type KeyContext, keyToIntent } from "#keymap"
import type { Intent, KeyState } from "#lib/types"

const NO_KEYS: KeyState = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    home: false,
    end: false,
    super: false,
}

/** A single-line buffer sits on both the first and the last line, which is the common case. */
const ONE_LINE = {
    firstLine: true,
    lastLine: true,
    searching: false,
    armed: false,
    scrolled: false,
} as const

const IDLE: KeyContext = { busy: false, empty: true, ...ONE_LINE }
const BUSY: KeyContext = { busy: true, empty: false, ...ONE_LINE }
const TYPING: KeyContext = { busy: false, empty: false, ...ONE_LINE }
/** Mid-buffer: neither the first line nor the last, so the arrows move the cursor. */
const MID_BUFFER: KeyContext = {
    busy: false,
    empty: false,
    firstLine: false,
    lastLine: false,
    searching: false,
    armed: false,
    scrolled: false,
}
const SEARCHING: KeyContext = { busy: false, empty: false, ...ONE_LINE, searching: true }

function press(input: string, keys: Partial<KeyState> = {}, context: KeyContext = IDLE): Intent {
    return keyToIntent(input, { ...NO_KEYS, ...keys }, context)
}

describe("Ctrl-C — the contract Phase 1 measured", () => {
    test("cancels the turn while one is running", () => {
        expect(press("c", { ctrl: true }, BUSY)).toEqual({ kind: "cancel" })
    })

    test("arms at an idle prompt, and the second press leaves", () => {
        // Two presses rather than one, because the alternate screen discards the buffer on the way out:
        // a reflexive ^C during a long reply used to end the session *and* take the visible conversation
        // with it. `^D` still leaves in one.
        expect(press("c", { ctrl: true }, IDLE)).toEqual({ kind: "arm" })
        expect(press("c", { ctrl: true }, { ...IDLE, armed: true })).toEqual({ kind: "exit" })
    })

    test("cancels while busy even with text on the line", () => {
        expect(press("c", { ctrl: true }, { busy: true, empty: true, ...ONE_LINE })).toEqual({
            kind: "cancel",
        })
    })

    test("a busy turn is cancelled even when the prompt was already armed", () => {
        // Arming is an idle-prompt state and a turn starting does not clear it, so the flag can still be
        // set when a reply arrives. Cancel has to win: the alternative is a ^C aimed at a running turn
        // ending the session, which is precisely the accident the arming exists to prevent.
        expect(press("c", { ctrl: true }, { ...BUSY, armed: true })).toEqual({ kind: "cancel" })
    })

    test("is recognised whatever case the terminal reports", () => {
        expect(press("C", { ctrl: true }, BUSY)).toEqual({ kind: "cancel" })
    })
})

describe("Ctrl-D", () => {
    test("ends the session only when there is nothing to submit", () => {
        expect(press("d", { ctrl: true }, IDLE)).toEqual({ kind: "exit" })
    })

    test("deletes forward on a line with text, as in a shell", () => {
        expect(press("d", { ctrl: true }, TYPING)).toEqual({ kind: "delete" })
    })
})

describe("readline chords", () => {
    const cases: readonly [string, Intent["kind"]][] = [
        ["a", "cursorHome"],
        ["e", "cursorEnd"],
        ["b", "cursorLeft"],
        ["f", "cursorRight"],
        ["u", "killToStart"],
        ["k", "killToEnd"],
        ["w", "killWord"],
        ["p", "historyPrev"],
        ["n", "historyNext"],
    ]

    for (const [letter, kind] of cases) {
        test(`Ctrl-${letter.toUpperCase()} is ${kind}`, () => {
            expect(press(letter, { ctrl: true }, TYPING).kind).toBe(kind)
        })
    }

    test("an unmapped chord does nothing rather than inserting its letter", () => {
        // Ctrl-G inserting a literal "g" would be worse than ignoring it.
        expect(press("g", { ctrl: true }, TYPING)).toEqual({ kind: "none" })
    })
})

describe("editing keys", () => {
    test("return submits", () => {
        expect(press("", { return: true }, TYPING)).toEqual({ kind: "submit" })
    })

    test("backspace and delete are distinct", () => {
        expect(press("", { backspace: true }, TYPING)).toEqual({ kind: "backspace" })
        expect(press("", { delete: true }, TYPING)).toEqual({ kind: "delete" })
    })

    test("arrows move the cursor and walk history", () => {
        expect(press("", { leftArrow: true }, TYPING)).toEqual({ kind: "cursorLeft" })
        expect(press("", { rightArrow: true }, TYPING)).toEqual({ kind: "cursorRight" })
        expect(press("", { upArrow: true }, TYPING)).toEqual({ kind: "historyPrev" })
        expect(press("", { downArrow: true }, TYPING)).toEqual({ kind: "historyNext" })
    })

    test("escape and tab are claimed and do nothing", () => {
        // Falling through to insert would put a control character in the buffer and send it to a
        // model, invisibly.
        expect(press("", { escape: true }, TYPING)).toEqual({ kind: "none" })
        expect(press("\t", { tab: true }, TYPING)).toEqual({ kind: "none" })
    })
})

describe("text", () => {
    test("a printable character inserts", () => {
        expect(press("x", {}, TYPING)).toEqual({ kind: "insert", text: "x" })
    })

    test("shift does not change insertion", () => {
        expect(press("X", { shift: true }, TYPING)).toEqual({ kind: "insert", text: "X" })
    })

    test("a paste arrives as one chunk and inserts whole", () => {
        // Ink delivers a paste as a single large `input` with no key flags. Treating it as one
        // keypress would drop all but the first character.
        const pasted = "the quick brown fox jumps over the lazy dog"
        expect(press(pasted, {}, TYPING)).toEqual({ kind: "insert", text: pasted })
    })

    test("multi-byte characters survive", () => {
        expect(press("👍", {}, TYPING)).toEqual({ kind: "insert", text: "👍" })
        expect(press("héllo", {}, TYPING)).toEqual({ kind: "insert", text: "héllo" })
    })

    test("control characters are stripped from a paste rather than inserted", () => {
        // A paste carrying an escape sequence would be invisible on screen and sent to the model.
        expect(press("ab\u0000c\u001Bd", {}, TYPING)).toEqual({ kind: "insert", text: "abcd" })
    })

    test("input that is only control characters does nothing", () => {
        expect(press("\u001B\u0007", {}, TYPING)).toEqual({ kind: "none" })
    })

    test("empty input does nothing", () => {
        expect(press("", {}, TYPING)).toEqual({ kind: "none" })
    })
})

describe("a chunk with newlines in it", () => {
    // Found by driving the real app through a pty: the injected text arrived as one chunk, the
    // carriage returns were stripped as control characters, and "…one word." was joined to "/exit"
    // on a single line that never submitted — silent corruption of anything pasted.
    test("a newline is a line break, not control noise", () => {
        expect(press("first\rsecond", {}, TYPING)).toEqual({
            kind: "paste",
            lines: ["first", "second"],
            complete: false,
        })
    })

    test("a trailing newline means the last line is finished", () => {
        expect(press("only\r", {}, TYPING)).toEqual({
            kind: "paste",
            lines: ["only"],
            complete: true,
        })
    })

    test("CRLF is one break, not two", () => {
        expect(press("a\r\nb\r\n", {}, TYPING)).toEqual({
            kind: "paste",
            lines: ["a", "b"],
            complete: true,
        })
    })

    test("a multi-line paste keeps every line and its order", () => {
        expect(press("one\ntwo\nthree\n", {}, TYPING)).toEqual({
            kind: "paste",
            lines: ["one", "two", "three"],
            complete: true,
        })
    })

    test("blank lines inside a paste survive as blank lines", () => {
        // They submit nothing, but dropping them here would silently reflow pasted text.
        expect(press("a\n\nb\n", {}, TYPING)).toEqual({
            kind: "paste",
            lines: ["a", "", "b"],
            complete: true,
        })
    })

    test("control characters are still stripped within each line", () => {
        expect(press("a\u0001b\rcd", {}, TYPING)).toEqual({
            kind: "paste",
            lines: ["ab", "cd"],
            complete: false,
        })
    })

    test("a real Enter keypress is still a submit, not a paste", () => {
        // Ink reports Enter as `key.return`; the chunk path must not shadow it.
        expect(press("\r", { return: true }, TYPING)).toEqual({ kind: "submit" })
    })
})

describe("option chords — measured against Ink's parser, not assumed", () => {
    // A terminal has more than one way to send each of these, and the parser reporting *a* key says
    // nothing about which. Both spellings are honoured, so one binding works in both families.
    test("⌥← is a word left, as either terminal sends it", () => {
        expect(press("b", { meta: true }, TYPING)).toEqual({ kind: "wordLeft" })
        expect(press("", { meta: true, leftArrow: true }, TYPING)).toEqual({ kind: "wordLeft" })
    })

    test("⌥→ is a word right, as either terminal sends it", () => {
        expect(press("f", { meta: true }, TYPING)).toEqual({ kind: "wordRight" })
        expect(press("", { meta: true, rightArrow: true }, TYPING)).toEqual({ kind: "wordRight" })
    })

    test("⌥⌫ deletes the word behind and ⌥d the word ahead", () => {
        expect(press("", { meta: true, backspace: true }, TYPING)).toEqual({ kind: "killWord" })
        expect(press("d", { meta: true }, TYPING)).toEqual({ kind: "killWordForward" })
    })

    test("⌥⏎ is a newline, not a send", () => {
        expect(press("\r", { meta: true, return: true }, TYPING)).toEqual({ kind: "newline" })
    })

    test("shift+⏎ is a newline where the terminal can say so", () => {
        // Ink already parses kitty's `CSI 13;2u` into return+shift, so this works the moment the
        // terminal is taught to send it. Where it cannot, the flag is never set and ⏎ submits.
        expect(press("\r", { return: true, shift: true }, TYPING)).toEqual({ kind: "newline" })
    })

    test("an unclaimed option chord types nothing", () => {
        // Falling through would reach the insert branch, so ⌥s would silently put an "s" in the
        // message somebody is composing.
        expect(press("s", { meta: true }, TYPING)).toEqual({ kind: "none" })
        expect(press("x", { meta: true }, TYPING)).toEqual({ kind: "none" })
    })
})

describe("the arrows, in a buffer that has more than one line", () => {
    test("↑ recalls history on the first line", () => {
        expect(press("", { upArrow: true }, TYPING)).toEqual({ kind: "historyPrev" })
    })

    test("↑ moves a line when there is a line above", () => {
        expect(press("", { upArrow: true }, MID_BUFFER)).toEqual({ kind: "lineUp" })
    })

    test("↓ moves a line unless the cursor is on the last one", () => {
        expect(press("", { downArrow: true }, MID_BUFFER)).toEqual({ kind: "lineDown" })
        expect(press("", { downArrow: true }, TYPING)).toEqual({ kind: "historyNext" })
    })

    test("^P and ^N stay unconditional history, wherever the cursor is", () => {
        // For anyone who would rather not think about which line they are on.
        expect(press("p", { ctrl: true }, MID_BUFFER)).toEqual({ kind: "historyPrev" })
        expect(press("n", { ctrl: true }, MID_BUFFER)).toEqual({ kind: "historyNext" })
    })
})

describe("undo takes ^Z, and suspend goes with it", () => {
    test("^Z undoes and ^Y redoes", () => {
        expect(press("z", { ctrl: true }, TYPING)).toEqual({ kind: "undo" })
        expect(press("y", { ctrl: true }, TYPING)).toEqual({ kind: "redo" })
    })
})

describe("reverse search changes what the keys mean", () => {
    test("^R opens it", () => {
        expect(press("r", { ctrl: true }, TYPING)).toEqual({ kind: "searchOpen" })
    })

    test("enter accepts a match instead of sending the message", () => {
        expect(press("\r", { return: true }, SEARCHING)).toEqual({ kind: "searchAccept" })
        expect(press("\r", { return: true }, TYPING)).toEqual({ kind: "submit" })
    })

    test("escape closes it, and otherwise still does nothing", () => {
        expect(press("", { escape: true }, SEARCHING)).toEqual({ kind: "searchCancel" })
        expect(press("", { escape: true }, TYPING)).toEqual({ kind: "none" })
    })

    test("^C dismisses the search rather than the session", () => {
        // Quitting from a search would lose a message somebody is part-way through composing.
        expect(press("c", { ctrl: true }, SEARCHING)).toEqual({ kind: "searchCancel" })
    })

    test("the arrows walk matches from either end of the buffer", () => {
        expect(press("", { upArrow: true }, SEARCHING)).toEqual({ kind: "historyPrev" })
        expect(press("", { downArrow: true }, SEARCHING)).toEqual({ kind: "historyNext" })
    })
})
