/**
 * Selecting in the composer: what shift does, and what happens to a selection when you type over it.
 *
 * Kept separate from `editor.test.ts` because the interesting cases are all about a *second* piece of
 * state. The reducer had one position for its whole life, and every deletion computed its own range from
 * the cursor; adding an anchor means every one of those paths now has a case where a range already exists.
 */

import { describe, expect, test } from "bun:test"
import { applyIntent, EMPTY_EDITOR, selectionRange } from "#editor"
import { keyContext, keyToIntent } from "#keymap"
import type { EditorState, Intent, KeyState, MotionKind } from "#lib/types"

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

function at(value: string, cursor: number): EditorState {
    return { ...EMPTY_EDITOR, value, cursor }
}

function apply(state: EditorState, ...intents: readonly Intent[]): EditorState {
    return intents.reduce(applyIntent, state)
}

function extend(to: MotionKind): Intent {
    return { kind: "extend", to }
}

/** What is actually highlighted, as text — the thing a person is looking at. */
function selected(state: EditorState): string {
    const range = selectionRange(state)
    if (range === undefined) return ""
    return [...state.value].slice(range.start, range.end).join("")
}

describe("shift plus a motion selects", () => {
    test("a character at a time, in both directions", () => {
        const right = apply(at("hello world", 0), extend("cursorRight"), extend("cursorRight"))
        expect(selected(right)).toBe("he")
        const left = apply(at("hello world", 5), extend("cursorLeft"), extend("cursorLeft"))
        expect(selected(left)).toBe("lo")
    })

    test("a word, and then the next word, growing one selection rather than starting a second", () => {
        // The anchor is kept across chords, which is what makes shift-extending feel like dragging.
        const state = apply(at("hello world again", 0), extend("wordRight"), extend("wordRight"))
        expect(selected(state)).toBe("hello world")
        expect(state.anchor).toBe(0)
    })

    test("to the start and end of the line", () => {
        expect(selected(apply(at("hello world", 6), extend("cursorHome")))).toBe("hello ")
        expect(selected(apply(at("hello world", 6), extend("cursorEnd")))).toBe("world")
    })

    test("to the ends of a multi-line buffer, which is not the same as the line", () => {
        const buffer = at("first line\nsecond line", 14)
        // cmd+shift+← is the line; cmd+shift+↑ is everything above.
        expect(selected(apply(buffer, extend("cursorHome")))).toBe("sec")
        expect(selected(apply(buffer, extend("bufferStart")))).toBe("first line\nsec")
        expect(selected(apply(buffer, extend("bufferEnd")))).toBe("ond line")
    })

    test("across a line boundary, a line at a time", () => {
        // "first\nsecond\nthird" — offset 8 is the `c` of second, column 2. `lineUp` keeps the column,
        // so it lands on offset 2 and the range spans the newline.
        const state = apply(at("first\nsecond\nthird", 8), extend("lineUp"))
        expect(selected(state)).toBe("rst\nse")
    })

    test("extending back over the anchor flips the selection rather than collapsing it", () => {
        // This is why the state is anchor-plus-cursor and not a start/end pair: a pair cannot say which
        // end is moving, so coming back past the anchor would collapse to the wrong side.
        let state = apply(at("hello world", 5), extend("cursorRight"), extend("cursorRight"))
        expect(selected(state)).toBe(" w")
        state = apply(state, extend("cursorLeft"), extend("cursorLeft"), extend("cursorLeft"))
        expect(selected(state)).toBe("o")
        expect(state.cursor).toBe(4)
        expect(state.anchor).toBe(5)
    })

    test("a selection of nothing is no selection", () => {
        // Anchor equal to cursor is the state after extending one step and coming straight back. Reporting
        // an empty range would put a zero-width highlight on screen and make ⌫ take the region path for a
        // region with nothing in it.
        const state = apply(at("hello", 2), extend("cursorRight"), extend("cursorLeft"))
        expect(state.anchor).toBe(2)
        expect(selectionRange(state)).toBeUndefined()
    })

    test("cmd+a takes the whole buffer, newlines included", () => {
        const state = applyIntent(at("first\nsecond", 3), { kind: "selectAll" })
        expect(selected(state)).toBe("first\nsecond")
    })
})

describe("an unshifted key collapses the selection", () => {
    test("a plain motion moves and clears, leaving the text alone", () => {
        const state = apply(at("hello world", 0), extend("wordRight"), { kind: "cursorRight" })
        expect(state.anchor).toBeUndefined()
        expect(state.value).toBe("hello world")
        expect(state.cursor).toBe(6)
    })

    test("so does anything else — an undo, a history step, a no-op", () => {
        for (const intent of [
            { kind: "historyPrev" },
            { kind: "undo" },
            { kind: "none" },
        ] as const) {
            const state = apply(at("hello", 0), extend("cursorRight"), intent)
            expect(state.anchor, intent.kind).toBeUndefined()
        }
    })
})

describe("typing over a selection replaces it", () => {
    test("an insert replaces the range and leaves the caret after what was typed", () => {
        const state = apply(at("hello world", 0), extend("wordRight"), {
            kind: "insert",
            text: "goodbye",
        })
        expect(state.value).toBe("goodbye world")
        expect(state.cursor).toBe(7)
        expect(state.anchor).toBeUndefined()
    })

    test("backspace removes the selection and nothing more", () => {
        // The case worth pinning: ⌫ with three words selected removes the three words. It must not remove
        // them and then eat a fourth character, which is what a naive "delete range, then apply" does.
        const state = apply(at("hello world", 0), extend("wordRight"), { kind: "backspace" })
        expect(state.value).toBe(" world")
        expect(state.cursor).toBe(0)
    })

    test("forward delete behaves the same, from the same range", () => {
        const state = apply(at("hello world", 11), extend("wordLeft"), { kind: "delete" })
        expect(state.value).toBe("hello ")
        expect(state.cursor).toBe(6)
    })

    test("a newline replaces it too", () => {
        const state = apply(at("hello world", 0), extend("wordRight"), { kind: "newline" })
        expect(state.value).toBe("\n world")
    })

    test("and the replacement is one undo step back to the whole selection", () => {
        const typed = apply(at("hello world", 0), extend("wordRight"), {
            kind: "insert",
            text: "x",
        })
        expect(typed.value).toBe("x world")
        expect(applyIntent(typed, { kind: "undo" }).value).toBe("hello world")
    })
})

describe("the chords a terminal actually sends for a shifted motion", () => {
    // Modifier arithmetic, since every one of these is `1 + shift(1) + …`:
    //   shift        2      shift+alt    4      shift+ctrl   6      shift+super  10
    function press(key: Partial<KeyState>, input = ""): Intent {
        return keyToIntent(input, { ...NO_KEYS, ...key }, keyContext(EMPTY_EDITOR, false))
    }

    test("shift with a bare arrow extends by a character", () => {
        expect(press({ shift: true, leftArrow: true })).toEqual(extend("cursorLeft"))
        expect(press({ shift: true, rightArrow: true })).toEqual(extend("cursorRight"))
    })

    test("shift with option or ctrl extends by a word", () => {
        expect(press({ shift: true, meta: true, leftArrow: true })).toEqual(extend("wordLeft"))
        expect(press({ shift: true, ctrl: true, rightArrow: true })).toEqual(extend("wordRight"))
    })

    test("shift with cmd extends to the line and buffer ends", () => {
        // The ordering this depends on: the cmd block matches `key.super` without consulting shift, so a
        // shift branch placed after it would have silently become a plain cmd chord.
        expect(press({ shift: true, super: true, leftArrow: true })).toEqual(extend("cursorHome"))
        expect(press({ shift: true, super: true, upArrow: true })).toEqual(extend("bufferStart"))
    })

    test("shift with Home or End extends to the line ends", () => {
        expect(press({ shift: true, home: true })).toEqual(extend("cursorHome"))
        expect(press({ shift: true, end: true })).toEqual(extend("cursorEnd"))
    })

    test("shift+up extends a line even on the first line, where the plain arrow means history", () => {
        expect(press({ shift: true, upArrow: true })).toEqual(extend("lineUp"))
        expect(press({ upArrow: true })).toEqual({ kind: "historyPrev" })
    })

    test("a capital letter is still a capital letter", () => {
        // `key.shift` is true for every one of them, so a shift branch that matched on anything other
        // than a motion key would make typing impossible.
        expect(press({ shift: true }, "A")).toEqual({ kind: "insert", text: "A" })
    })

    test("shift+enter is still a newline, not a selection", () => {
        expect(press({ shift: true, return: true })).toEqual({ kind: "newline" })
    })

    test("cmd+a selects all, and ^A is still the start of the line", () => {
        expect(press({ super: true }, "a")).toEqual({ kind: "selectAll" })
        expect(press({ ctrl: true }, "a")).toEqual({ kind: "cursorHome" })
    })
})
