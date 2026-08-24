/**
 * The input buffer, as data. Pure — no Ink, no React, no terminal.
 *
 * Ink gives you keystrokes and nothing else: there is no text field, so cursor movement, word motion,
 * history, undo and line breaks are this file's job. Keeping them here rather than inside a component
 * is what makes them testable, and they are exactly the behaviours that are tedious to check by hand
 * and embarrassing when wrong.
 *
 * **Positions are code points, not UTF-16 units.** `"👍".length` is 2, so a cursor counted in string
 * indices lands *inside* the surrogate pair, and one backspace leaves half a character behind that
 * renders as a replacement glyph and gets sent to the model. Every operation here goes through an
 * array of code points for that reason.
 *
 * **The buffer is multi-line.** A message is composed rather than typed on one line, so `value` may
 * contain `\n` and the line helpers derive bounds on demand. That choice is argued in
 * `EditorState.value`; the consequence here is that "start of line" and "start of buffer" are now
 * different places, and `cursorHome` means the first.
 *
 * **Undo coalesces.** One snapshot per keystroke makes undo useless — nobody wants to press it forty
 * times to take back a sentence — so a run of plain typing is one step, and anything structural
 * (deletion, a line break, a paste, recalling history) opens a new one. That is the granularity every
 * editor converged on, and it is decided by `remember`'s single argument rather than scattered.
 */

import { HISTORY_LIMIT, UNDO_LIMIT } from "#lib/const"
import type { EditorSnapshot, EditorState, Intent } from "#lib/types"

export const EMPTY_EDITOR: EditorState = {
    value: "",
    cursor: 0,
    history: [],
    historyOffset: 0,
    draft: "",
    past: [],
    future: [],
    search: undefined,
    anchor: undefined,
}

function chars(value: string): string[] {
    return [...value]
}

function clamp(cursor: number, length: number): number {
    return Math.max(0, Math.min(cursor, length))
}

function snapshot(state: EditorState): EditorSnapshot {
    return { value: state.value, cursor: state.cursor }
}

/**
 * Record the current text as an undo point, unless this edit continues the last one.
 *
 * `coalesce` is true for plain typing: the top of the stack already holds a point before the run
 * started, so extending it needs no new entry. Everything else pushes.
 *
 * Any edit clears `future`, because a redo stack that survives a new edit would replay text that
 * never followed from what is now on screen.
 */
function remember(state: EditorState, options: { readonly coalesce: boolean }): EditorState {
    const top = state.past.at(-1)
    // Nothing to remember when the text has not changed since the last point — repeated arrow keys
    // would otherwise fill the stack with identical entries and make undo appear to do nothing.
    if (options.coalesce && top !== undefined && state.future.length === 0) {
        return { ...state, future: [] }
    }
    if (top !== undefined && top.value === state.value) return { ...state, future: [] }
    return { ...state, past: [...state.past, snapshot(state)].slice(-UNDO_LIMIT), future: [] }
}

/** Cursor to the end, which is where every whole-buffer replacement leaves it. */
function replaceAll(state: EditorState, value: string): EditorState {
    return { ...state, value, cursor: chars(value).length }
}

function insert(state: EditorState, text: string): EditorState {
    const remembered = remember(state, { coalesce: !text.includes("\n") })
    const current = chars(remembered.value)
    const at = clamp(remembered.cursor, current.length)
    const next = [...current.slice(0, at), ...chars(text), ...current.slice(at)]
    return { ...remembered, value: next.join(""), cursor: at + chars(text).length }
}

function deleteBack(state: EditorState): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    if (at === 0) return state
    const remembered = remember(state, { coalesce: false })
    const next = [...current.slice(0, at - 1), ...current.slice(at)]
    return { ...remembered, value: next.join(""), cursor: at - 1 }
}

function deleteForward(state: EditorState): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    if (at >= current.length) return state
    const remembered = remember(state, { coalesce: false })
    return {
        ...remembered,
        value: [...current.slice(0, at), ...current.slice(at + 1)].join(""),
    }
}

// ─── words ───────────────────────────────────────────────────────────────────────────────
//
// A newline counts as a separator, so word motion crosses lines the way it does in a text field.
// Treating it as a boundary that stops the cursor was the other option and is worse: it makes ⌥←
// silently do nothing at the start of a line, which reads as a dead key.

function isSeparator(char: string | undefined): boolean {
    return char === undefined || /\s/.test(char)
}

/** The start of the word at or before `at` — separators skipped first, as every shell does. */
function wordStart(current: readonly string[], at: number): number {
    let index = at
    while (index > 0 && isSeparator(current[index - 1])) index -= 1
    while (index > 0 && !isSeparator(current[index - 1])) index -= 1
    return index
}

/** The end of the word at or after `at`. */
function wordEnd(current: readonly string[], at: number): number {
    let index = at
    while (index < current.length && isSeparator(current[index])) index += 1
    while (index < current.length && !isSeparator(current[index])) index += 1
    return index
}

/**
 * Delete the word before the cursor, trailing whitespace included — so `^W` after "hello world "
 * removes "world " rather than only the space, which is what every shell does.
 */
function killWord(state: EditorState): EditorState {
    const current = chars(state.value)
    const at = wordStart(current, clamp(state.cursor, current.length))
    if (at === state.cursor) return state
    const remembered = remember(state, { coalesce: false })
    return {
        ...remembered,
        value: [...current.slice(0, at), ...current.slice(state.cursor)].join(""),
        cursor: at,
    }
}

function killWordForward(state: EditorState): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    const to = wordEnd(current, at)
    if (to === at) return state
    const remembered = remember(state, { coalesce: false })
    return {
        ...remembered,
        value: [...current.slice(0, at), ...current.slice(to)].join(""),
    }
}

// ─── lines ───────────────────────────────────────────────────────────────────────────────

interface LineBounds {
    readonly start: number
    readonly end: number
}

/** The bounds of the line the cursor sits on, in code points. `end` is the newline or the buffer end. */
export function lineAt(value: string, cursor: number): LineBounds {
    const current = chars(value)
    const at = clamp(cursor, current.length)
    let start = at
    while (start > 0 && current[start - 1] !== "\n") start -= 1
    let end = at
    while (end < current.length && current[end] !== "\n") end += 1
    return { start, end }
}

/** Which line the cursor is on, and how many there are. Used to decide what an arrow means. */
export function lineInfo(state: EditorState): {
    readonly line: number
    readonly lines: number
    readonly column: number
} {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    const before = current.slice(0, at)
    const { start } = lineAt(state.value, at)
    return {
        line: before.filter((char) => char === "\n").length,
        lines: current.filter((char) => char === "\n").length + 1,
        column: at - start,
    }
}

/**
 * Move a line, keeping the column where possible.
 *
 * A shorter target line clamps to its end rather than wrapping onto the next one — the behaviour every
 * editor has, and the reason the column is recomputed from the line start each time instead of being
 * remembered across moves. Remembering it is what produces a "sticky" column, which is nicer in vim and
 * surprising in a message box.
 */
function moveLine(state: EditorState, delta: number): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    const here = lineAt(state.value, at)
    const column = at - here.start
    if (delta < 0) {
        if (here.start === 0) return state
        const previous = lineAt(state.value, here.start - 1)
        return { ...state, cursor: Math.min(previous.start + column, previous.end) }
    }
    if (here.end >= current.length) return state
    const next = lineAt(state.value, here.end + 1)
    return { ...state, cursor: Math.min(next.start + column, next.end) }
}

// ─── history ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk back through history. The text being edited is saved on the first step and restored on the
 * way back down, so browsing history never destroys what you were typing.
 */
function historyPrev(state: EditorState): EditorState {
    if (state.history.length === 0) return state
    const offset = Math.min(state.historyOffset + 1, state.history.length)
    const entry = state.history[state.history.length - offset]
    if (entry === undefined) return state
    return replaceAll(
        {
            ...remember(state, { coalesce: false }),
            historyOffset: offset,
            draft: state.historyOffset === 0 ? state.value : state.draft,
        },
        entry,
    )
}

function historyNext(state: EditorState): EditorState {
    if (state.historyOffset === 0) return state
    const offset = state.historyOffset - 1
    const remembered = remember(state, { coalesce: false })
    if (offset === 0) return replaceAll({ ...remembered, historyOffset: 0 }, state.draft)
    const entry = state.history[state.history.length - offset]
    return entry === undefined ? state : replaceAll({ ...remembered, historyOffset: offset }, entry)
}

// ─── reverse search ──────────────────────────────────────────────────────────────────────

/**
 * History entries containing the query, newest first.
 *
 * Substring rather than prefix, and case-insensitive: a message is prose, and remembering how one
 * started is much harder than remembering a word in the middle of it. Deduplicated, because the same
 * question asked twice should not take two presses of ↓ to walk past.
 */
export function searchMatches(state: EditorState): readonly string[] {
    const query = (state.search?.query ?? "").toLowerCase()
    const seen = new Set<string>()
    const matches: string[] = []
    for (let at = state.history.length - 1; at >= 0; at -= 1) {
        const entry = state.history[at]
        if (entry === undefined || seen.has(entry)) continue
        if (query === "" || entry.toLowerCase().includes(query)) {
            seen.add(entry)
            matches.push(entry)
        }
    }
    return matches
}

/** The entry the search has landed on, or `undefined` when nothing matches. */
export function searchSelection(state: EditorState): string | undefined {
    const matches = searchMatches(state)
    return matches[clamp(state.search?.index ?? 0, Math.max(0, matches.length - 1))]
}

function searchStep(state: EditorState, delta: number): EditorState {
    const search = state.search
    if (search === undefined) return state
    const matches = searchMatches(state)
    if (matches.length === 0) return state
    return {
        ...state,
        search: { ...search, index: clamp(search.index + delta, matches.length - 1) },
    }
}

function searchType(state: EditorState, text: string): EditorState {
    const search = state.search
    if (search === undefined) return state
    // The index resets on every keystroke: the match list has changed underneath it, so keeping the
    // old position would silently point at a different entry than the one that was highlighted.
    return { ...state, search: { query: search.query + text, index: 0 } }
}

function searchBackspace(state: EditorState): EditorState {
    const search = state.search
    if (search === undefined) return state
    const query = chars(search.query).slice(0, -1).join("")
    return { ...state, search: { query, index: 0 } }
}

function searchAccept(state: EditorState): EditorState {
    const chosen = searchSelection(state)
    if (chosen === undefined) return { ...state, search: undefined }
    return replaceAll({ ...remember(state, { coalesce: false }), search: undefined }, chosen)
}

// ─── undo ────────────────────────────────────────────────────────────────────────────────

function undo(state: EditorState): EditorState {
    const previous = state.past.at(-1)
    if (previous === undefined) return state
    return {
        ...state,
        value: previous.value,
        cursor: clamp(previous.cursor, chars(previous.value).length),
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
        historyOffset: 0,
    }
}

function redo(state: EditorState): EditorState {
    const next = state.future[0]
    if (next === undefined) return state
    return {
        ...state,
        value: next.value,
        cursor: clamp(next.cursor, chars(next.value).length),
        past: [...state.past, snapshot(state)].slice(-UNDO_LIMIT),
        future: state.future.slice(1),
    }
}

/** The selected range, normalised so `start <= end`. `undefined` when nothing is selected. */
export function selectionRange(
    state: EditorState,
): { readonly start: number; readonly end: number } | undefined {
    if (state.anchor === undefined || state.anchor === state.cursor) return undefined
    return state.anchor < state.cursor
        ? { start: state.anchor, end: state.cursor }
        : { start: state.cursor, end: state.anchor }
}

/** Cut the selected range out, leaving the caret where it was and no selection behind. */
function deleteRange(state: EditorState): EditorState {
    const range = selectionRange(state)
    if (range === undefined) return { ...state, anchor: undefined }
    const current = chars(state.value)
    return {
        ...remember(state, { coalesce: false }),
        value: [...current.slice(0, range.start), ...current.slice(range.end)].join(""),
        cursor: range.start,
        anchor: undefined,
    }
}

/**
 * Which intents replace a selection rather than acting beside it.
 *
 * Typing over a selection replaces it and backspace removes it — that is what every editor does and what
 * makes a selection worth having. A *motion* does not: it collapses the selection and moves, which is the
 * `anchor: undefined` at the end of `applyIntent` rather than a deletion here.
 */
function replacesSelection(intent: Intent): boolean {
    return (
        intent.kind === "insert" ||
        intent.kind === "newline" ||
        intent.kind === "backspace" ||
        intent.kind === "delete"
    )
}

export function applyIntent(state: EditorState, intent: Intent): EditorState {
    // A selection is replaced before the intent is applied, and for backspace and delete that *is* the
    // whole edit — pressing ⌫ with three words selected removes the three words, it does not remove them
    // and then eat a fourth character. Ordered before the search branch below because a search has no
    // selection to replace: `searchType` writes to the query, never to the line.
    if (
        state.search === undefined &&
        replacesSelection(intent) &&
        selectionRange(state) !== undefined
    ) {
        const cut = deleteRange(state)
        if (intent.kind === "backspace" || intent.kind === "delete") return cut
        return applyIntent(cut, intent)
    }

    if (intent.kind === "extend") {
        // The motion is applied by the same code the unshifted chord uses, on a copy with no anchor, so a
        // selection cannot disagree with the plain move about where the cursor lands. The anchor is
        // whichever one already existed — extending twice grows one selection rather than starting a
        // second — and falls back to where the caret was when the first shift chord arrived.
        const anchor = state.anchor ?? state.cursor
        const moved = applyIntent({ ...state, anchor: undefined }, { kind: intent.to })
        return { ...moved, anchor }
    }

    // Cut is a deletion; copy touches nothing. Both leave the clipboard to the caller — a pure reducer
    // cannot spawn `pbcopy`, and a reducer that could would be untestable for the sake of one line.
    if (intent.kind === "cutSelection") return deleteRange(state)
    if (intent.kind === "copySelection") return state

    if (intent.kind === "selectAll") {
        return { ...state, anchor: 0, cursor: chars(state.value).length }
    }

    const next = applyToLine(state, intent)
    // Every other intent collapses the selection. Written once here rather than in each motion case: ten
    // cases each remembering to clear a field is ten chances for one of them not to, and the one that
    // forgot would leave a highlight on screen with nothing selecting it.
    return next.anchor === undefined ? next : { ...next, anchor: undefined }
}

function applyToLine(state: EditorState, intent: Intent): EditorState {
    // While the search is open, the keys that would edit the line extend the query instead. Routed
    // here rather than by emitting a parallel set of search intents from the keymap: the keys mean the
    // same thing to a reader — type, rub out, move, choose — and only the target changes.
    if (state.search !== undefined) {
        switch (intent.kind) {
            case "insert":
                return searchType(state, intent.text)
            case "backspace":
                return searchBackspace(state)
            case "historyPrev":
            case "lineUp":
                return searchStep(state, 1)
            case "historyNext":
            case "lineDown":
                return searchStep(state, -1)
            case "searchAccept":
                return searchAccept(state)
            case "searchCancel":
                return { ...state, search: undefined }
            case "searchOpen":
                return state
            default:
                // Anything else closes the search and is *not* applied to the line. Applying it would
                // mean a ^K pressed to dismiss the search also truncated the message behind it.
                return { ...state, search: undefined }
        }
    }

    switch (intent.kind) {
        case "insert":
            return insert(state, intent.text)
        case "newline":
            return insert(state, "\n")
        case "backspace":
            return deleteBack(state)
        case "delete":
            return deleteForward(state)
        case "cursorLeft":
            return { ...state, cursor: clamp(state.cursor - 1, chars(state.value).length) }
        case "cursorRight":
            return { ...state, cursor: clamp(state.cursor + 1, chars(state.value).length) }
        case "cursorHome":
            // The start of the *line*, not of the buffer: `^A` on the third line of a message means
            // that line's start, which is what it means in every shell and every editor.
            return { ...state, cursor: lineAt(state.value, state.cursor).start }
        case "cursorEnd":
            return { ...state, cursor: lineAt(state.value, state.cursor).end }
        case "bufferStart":
            return { ...state, cursor: 0 }
        case "bufferEnd":
            return { ...state, cursor: chars(state.value).length }
        case "wordLeft":
            return { ...state, cursor: wordStart(chars(state.value), state.cursor) }
        case "wordRight":
            return { ...state, cursor: wordEnd(chars(state.value), state.cursor) }
        case "lineUp":
            return moveLine(state, -1)
        case "lineDown":
            return moveLine(state, 1)
        case "killToStart": {
            const { start } = lineAt(state.value, state.cursor)
            if (start === state.cursor) return state
            const current = chars(state.value)
            return {
                ...remember(state, { coalesce: false }),
                value: [...current.slice(0, start), ...current.slice(state.cursor)].join(""),
                cursor: start,
            }
        }
        case "killToEnd": {
            const { end } = lineAt(state.value, state.cursor)
            if (end === state.cursor) return state
            const current = chars(state.value)
            return {
                ...remember(state, { coalesce: false }),
                value: [...current.slice(0, state.cursor), ...current.slice(end)].join(""),
            }
        }
        case "killWord":
            return killWord(state)
        case "killWordForward":
            return killWordForward(state)
        case "historyPrev":
            return historyPrev(state)
        case "historyNext":
            return historyNext(state)
        case "undo":
            return undo(state)
        case "redo":
            return redo(state)
        case "searchOpen":
            return { ...state, search: { query: "", index: 0 } }
        // Submit, cancel, exit and none are the caller's business — they change the session, not the
        // buffer. A paste is the caller's too: it can carry several finished lines, and only the caller
        // can send them. Search accept and cancel are unreachable with no search open, and are listed
        // rather than defaulted so a new intent has to be considered.
        case "searchAccept":
        case "searchCancel":
        case "submit":
        case "cancel":
        case "exit":
        // The session's, not the line's: arming ^C and moving the transcript window change what is on
        // screen and nothing about what is being typed. The exhaustive switch is what surfaced them —
        // added to `Intent` for the keymap's benefit, they made this function stop returning, which is a
        // compile error rather than a silent edit applied to somebody's message.
        case "arm":
        case "scroll":
        case "pointer":
        case "reasoning":
        case "paste":
        case "none":
            return state
        // Handled by `applyIntent` before it delegates here, and listed rather than defaulted so the
        // exhaustive switch keeps doing its job: a new intent has to be considered, not absorbed.
        case "extend":
        case "selectAll":
        case "copySelection":
        case "cutSelection":
            return state
    }
}

/**
 * Does enter send the message, or continue it on a new line?
 *
 * A trailing backslash means continue — the shell's convention, and the fallback for terminals where
 * shift+enter is indistinguishable from enter. Counted rather than tested for one character, so an
 * escaped backslash (`a\\`) sends and does not silently swallow the pair.
 *
 * Only at the very end of the buffer. Mid-message a backslash is ordinary text, and a message about
 * Windows paths should not become unsendable.
 */
export function submitIntent(state: EditorState): "send" | "newline" {
    const current = chars(state.value)
    if (clamp(state.cursor, current.length) !== current.length) return "send"
    let backslashes = 0
    for (let at = current.length - 1; at >= 0 && current[at] === "\\"; at -= 1) backslashes += 1
    return backslashes % 2 === 1 ? "newline" : "send"
}

/** Drop the trailing continuation backslash and break the line. Paired with `submitIntent`. */
export function continueLine(state: EditorState): EditorState {
    const current = chars(state.value)
    const trimmed = current.slice(0, -1).join("")
    return applyIntent(
        { ...state, value: trimmed, cursor: chars(trimmed).length },
        { kind: "newline" },
    )
}

/**
 * Commit the message. Returns the text to send and the state to keep.
 *
 * Empty submits nothing, and a repeat of the previous entry is not added to history — otherwise
 * pressing Enter twice fills history with duplicates that the arrows then have to walk.
 *
 * The undo stack does not survive: it describes a message that has been sent, and offering to undo
 * into text that is already in the transcript would be a lie about what the buffer is.
 */
export function submit(state: EditorState): { readonly text: string; readonly state: EditorState } {
    const text = state.value.trim()
    if (text === "") {
        return { text: "", state: { ...EMPTY_EDITOR, history: state.history } }
    }
    const last = state.history.at(-1)
    const history = last === text ? state.history : [...state.history, text].slice(-HISTORY_LIMIT)
    return { text, state: { ...EMPTY_EDITOR, history } }
}
