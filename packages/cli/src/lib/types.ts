/**
 * Domain shapes.
 *
 * The split follows termheat's rule: `types.ts` owns the shapes the CLI reasons *about*, and the
 * modules beside it own the logic. `schema.ts` owns the contracts between modules — parser output,
 * command options, component props.
 */

/**
 * How output is rendered.
 *
 * - `json`  — one machine-readable document on stdout and nothing else.
 * - `plain` — line-oriented text, no ANSI, no cursor movement. Safe to pipe, log, or diff.
 * - `rich`  — the Ink app: live transcript, status bar, input line.
 */
export type RenderMode = "json" | "plain" | "rich"

/** What the environment says about how much rendering is welcome. */
export interface EnvFacts {
    readonly noColor: boolean
    readonly dumbTerminal: boolean
    readonly ci: boolean
    readonly debug: boolean
    /** Sandbox root override (`<ENVPREFIX>HOME`). Tests point it at a tmpdir, never real HOME. */
    readonly sandboxHome: string | undefined
    /**
     * `<ENVPREFIX>NO_CSI_U` — do not negotiate the kitty keyboard protocol.
     *
     * The hatch for a terminal that answers the protocol query and then implements it badly. `mode:
     * "auto"` already covers a terminal that stays silent, so this is not for "might not work" — it is
     * for "answers and is worse", which no amount of detection can tell apart from "answers and works".
     */
    readonly noEnhancedKeys: boolean
}

// ─── transcript ──────────────────────────────────────────────────────────────────────────

export type TranscriptRole =
    | "user"
    | "assistant"
    | "reasoning"
    | "note"
    | "error"
    | "tool"
    /**
     * The opening banner, exactly one and always first. Its own role because the rich renderer gives
     * it the screen's first rows and its own emphasis.
     */
    | "banner"

/**
 * A finished line of conversation.
 *
 * Immutable once created, which is not a style preference: finished items render inside Ink's
 * `<Static>`, which writes a node to the terminal once and never touches it again. Mutating one
 * would change a value the renderer will never look at, so the change would silently not appear.
 */
export interface TranscriptItem {
    /** Stable and unique. React keys off it, and a reused key drops a line. */
    readonly id: string
    readonly role: TranscriptRole
    readonly text: string
    /** Present on a completed assistant reply. */
    readonly stats?: TurnStats
    /**
     * The call this row is about, for a `tool` row only.
     *
     * A tool used to occupy two items: one appended when the call started and a second when it
     * returned, because `<Static>` had already written the first and editing a written node silently
     * does nothing. `<Static>` went in Phase 5.5 and the transcript became a buffer this code owns, so
     * the row is now *completed* — four rows per call became one. The id is what pairs them: calls can
     * overlap, so "the last tool row" is not the row a result belongs to.
     */
    readonly callId?: string
    /** A tool row still waiting for its result. Drawn as running rather than as finished. */
    readonly pending?: boolean
}

/**
 * One drawn line of the finished conversation.
 *
 * The transcript is windowed rather than written once, so its unit is a row on screen instead of a
 * message: an offset counting items would page over a forty-row reply in a single keystroke. Wrapping
 * has already happened — `text` is exactly what is painted, prefix and indent included — which is what
 * makes the row count the scroll layer works in the row count the terminal shows.
 */
export interface TranscriptRow {
    /** Stable per item and per row within it. React keys off it; two identical replies are two rows. */
    readonly key: string
    readonly role: TranscriptRole
    readonly text: string
    readonly dim?: boolean
    readonly bold?: boolean
}

export interface TurnStats {
    readonly promptTokens: number
    readonly outputTokens: number
    readonly durationMs: number
    readonly steps: number
    /** `final` is the only clean ending. The rest are reported as themselves, never as success. */
    readonly reason: string
}

/** The turn in flight. Everything here is still moving, so none of it belongs in `<Static>`. */
export interface LiveTurn {
    readonly text: string
    readonly reasoning: string
    /** Which stream produced the most recent delta, so a view can label a switch. */
    readonly last: "text" | "reasoning" | undefined
}

/** `working` is a tool running: the model is not producing tokens, so `streaming` would mislead. */
export type TurnStatus = "idle" | "thinking" | "streaming" | "working" | "cancelling"

export interface TranscriptState {
    /**
     * The finished conversation, in the order it happened.
     *
     * Append-mostly rather than append-only, and the two exceptions are deliberate: a `tool` row is
     * completed by its own result, and a turn's statistics are attached to the reply they belong to. Both
     * were impossible while this lived in `<Static>`, which is why each used to cost an extra row.
     */
    readonly items: readonly TranscriptItem[]
    readonly live: LiveTurn | undefined
    readonly status: TurnStatus
    /** Monotonic id source. Kept in state so the reducer needs no clock and no randomness. */
    readonly nextId: number
    /**
     * Index into `items` where the current turn began, so `turn.end` can find the reply it is about.
     *
     * Needed because a reply is committed at each step boundary rather than once at the end, and the
     * statistics arrive after all of them. Searching backwards without a floor would attach a turn's cost
     * to the previous turn's reply on any turn that produced no text of its own.
     *
     * Required and explicitly `undefined` between turns, the way `live` is: an optional property under
     * `exactOptionalPropertyTypes` cannot be *cleared*, only omitted, and a field a reducer has to clear
     * on every turn boundary is the wrong shape for that.
     */
    readonly turnFrom: number | undefined
    /**
     * How full the prompt was on the most recent step, as a fraction of the budget.
     *
     * On the status line rather than in the transcript because it is a gauge, not an event: it changes
     * every step and a reader wants the current value, never the history of it. The stages that
     * *destroy* detail — collapse and reset — do get transcript notes, because those are events and a
     * person who was not watching the gauge still needs to know their conversation was summarised.
     */
    readonly pressure?: number
    /**
     * The phase the session is in, once something has moved it.
     *
     * Absent until the first `phase.changed`, deliberately: the entry phase is not an event and putting
     * it here would mean the reducer inventing a fact it was never told. What a reader needs is *that it
     * changed* and what to now — which is exactly what the event carries.
     */
    readonly phase?: string
}

// ─── input ───────────────────────────────────────────────────────────────────────────────

/**
 * The subset of Ink's `Key` this CLI acts on.
 *
 * Declared here rather than imported from Ink so that `keymap.ts` and `editor.ts` stay free of the
 * rich-path dependency — they are the two modules most worth unit-testing, and importing Ink would
 * cost every plain-path invocation ~170 ms under Node. Ink's own `Key` satisfies this structurally.
 */
export interface KeyState {
    readonly upArrow: boolean
    readonly downArrow: boolean
    readonly leftArrow: boolean
    readonly rightArrow: boolean
    /**
     * Page keys. Ink has always reported these; nothing asked for them until the transcript stopped
     * being the terminal's scrollback and became a buffer with a window over it.
     */
    readonly pageUp: boolean
    readonly pageDown: boolean
    readonly return: boolean
    readonly escape: boolean
    readonly ctrl: boolean
    readonly shift: boolean
    readonly tab: boolean
    readonly backspace: boolean
    readonly delete: boolean
    readonly meta: boolean
    /**
     * Home and End. Ink has reported these since 7.0 and this type never declared them, so they were
     * parsed on the way in and dropped on the floor: both keys did nothing at all, in every surface,
     * for as long as the CLI has existed. Nothing to negotiate and nothing to configure — a missing
     * field, and the cheapest fix on the whole keyboard.
     */
    readonly home: boolean
    readonly end: boolean
    /**
     * Cmd on macOS, Win elsewhere — and **only ever true under the kitty keyboard protocol**.
     *
     * No legacy escape sequence can express it. Worse, Ink's legacy path folds it into `meta`
     * (`key.meta = key.meta || !!(modifier & 10)`, where bit 8 is super and bit 2 is alt), so without
     * the protocol `cmd+←` is indistinguishable from `⌥←` and silently word-moves. Negotiating the
     * protocol is what separates them; `mode: "auto"` means this is simply `false` where it cannot be
     * known, which is the honest value rather than a guess.
     */
    readonly super: boolean
    /**
     * Press, repeat, or release — and `release` must be dropped before anything acts on the key.
     *
     * `reportEventTypes` is what makes an arrow-with-modifier parse through Ink's kitty branch rather
     * than its legacy one, which is the only way `super` survives on an arrow key. The cost is that
     * Ink passes the event type straight through (`use-input.js:63`) and filters nothing, so every
     * enhanced key would otherwise fire twice: once down, once up. Optional because a terminal that
     * never negotiated the protocol reports no event type at all.
     */
    readonly eventType?: "press" | "repeat" | "release"
}

/**
 * A move of a scrolling window: a row, a page, or an end.
 *
 * Here rather than in `lib/scroll.ts` because it is a shape the keymap produces and the reducer
 * consumes, and neither should have to import the other — the same reason `KeyState` is declared here
 * rather than imported from Ink.
 */
export type ScrollMove = "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom"

/**
 * The intents that only move the cursor.
 *
 * A subset of `Intent["kind"]` written out rather than derived, because it is the set `extend` may carry
 * and that is a smaller claim than "every intent with no payload". Deriving it would silently admit the
 * next payload-free intent — `undo`, say — into a shift chord.
 */
export type MotionKind =
    | "cursorLeft"
    | "cursorRight"
    | "cursorHome"
    | "cursorEnd"
    | "wordLeft"
    | "wordRight"
    | "lineUp"
    | "lineDown"
    | "bufferStart"
    | "bufferEnd"

export type Intent =
    | { readonly kind: "submit" }
    /** Ctrl-C while a turn is running: cancel the turn, keep the process. */
    | { readonly kind: "cancel" }
    /** Ctrl-C at an idle prompt, or Ctrl-D. */
    | { readonly kind: "exit" }
    /**
     * A first Ctrl-C at an idle prompt: say what a second one will do, and do nothing else.
     *
     * An intent rather than a component detail, because it is the same decision `cancel` and `exit` are —
     * what one keystroke means given what the session is doing — and the three have to be decided
     * together or the chord that cancels a turn becomes the chord that ends the session a moment later.
     */
    | { readonly kind: "arm" }
    /**
     * Move the transcript window. The buffer is ours now, so its scrolling is a keystroke away.
     *
     * `times` is for the wheel, which arrives as a count rather than as one event: a chunk can hold
     * several notches, and honouring one of them makes a flick of the wheel move a single row.
     */
    | { readonly kind: "scroll"; readonly move: ScrollMove; readonly times?: number }
    /**
     * Show reasoning blocks whole rather than folded to a count.
     *
     * A view state, not an edit, and deliberately session-wide rather than per block: a cursor that walked
     * the transcript to pick one would be a second focus to reason about on a surface where the composer
     * already owns the keyboard. Folding is what makes the reply findable; this is the way to read past it.
     */
    | { readonly kind: "reasoning" }
    | { readonly kind: "insert"; readonly text: string }
    /**
     * Text arriving as one chunk with newlines in it — a paste, or a here-doc fed to the process.
     *
     * It cannot be an `insert`: the newlines are control characters, and stripping them silently
     * runs the words together. It cannot be a `submit` either, because one chunk can carry several
     * finished lines. So the segments travel intact and the caller decides: every finished line is
     * submitted in order, and an unterminated tail stays on the input line.
     */
    | { readonly kind: "paste"; readonly lines: readonly string[]; readonly complete: boolean }
    | { readonly kind: "backspace" }
    | { readonly kind: "delete" }
    | { readonly kind: "cursorLeft" }
    | { readonly kind: "cursorRight" }
    | { readonly kind: "cursorHome" }
    | { readonly kind: "cursorEnd" }
    /**
     * The ends of the whole buffer, not of a line — `cmd+↑`/`cmd+↓`.
     *
     * Distinct from `cursorHome`/`cursorEnd` because a message can have many lines and macOS binds both
     * pairs: cmd with a horizontal arrow is the line, cmd with a vertical one is the document. Collapsing
     * them would make one of the two chords silently mean the other.
     */
    | { readonly kind: "bufferStart" }
    | { readonly kind: "bufferEnd" }
    /**
     * A motion that moves the cursor and leaves the anchor, which is what selecting *is*.
     *
     * One intent carrying a motion rather than a shifted twin of every motion: ten motions would have
     * become twenty intents and twenty reducer cases, and the second ten would have been the first ten
     * plus one line each. The keymap decides that shift means extend; the reducer reuses the motion it
     * already implements, so a selection can never disagree with the plain move about where it lands.
     */
    | { readonly kind: "extend"; readonly to: MotionKind }
    | { readonly kind: "selectAll" }
    | { readonly kind: "historyPrev" }
    | { readonly kind: "historyNext" }
    | { readonly kind: "killToStart" }
    | { readonly kind: "killToEnd" }
    | { readonly kind: "killWord" }
    /** A line break inside the message — ⌥⏎, shift+⏎ where the terminal can send it, or `\` then ⏎. */
    | { readonly kind: "newline" }
    /**
     * Word-wise motion and deletion — ⌥← ⌥→ ⌥⌫ ⌥d.
     *
     * `killWord` is the backward one and predates these; it keeps its name because `^W` is documented
     * under it and renaming a chord's intent to make a set look tidy is churn a reader pays for.
     */
    | { readonly kind: "wordLeft" }
    | { readonly kind: "wordRight" }
    | { readonly kind: "killWordForward" }
    /**
     * Cursor up or down a line, column preserved.
     *
     * Distinct from `historyPrev`/`historyNext`: which one an arrow means depends on whether the cursor
     * is on the first or last line, and that decision lives in `keyToIntent` with the rest of the
     * keyboard rather than being re-derived per renderer.
     */
    | { readonly kind: "lineUp" }
    | { readonly kind: "lineDown" }
    | { readonly kind: "undo" }
    | { readonly kind: "redo" }
    /** `^R`. While it is open, `insert`, `backspace` and the history intents act on the query. */
    | { readonly kind: "searchOpen" }
    /** Put the highlighted match on the line and close. */
    | { readonly kind: "searchAccept" }
    /** Close and leave the line exactly as it was. */
    | { readonly kind: "searchCancel" }
    | { readonly kind: "none" }

/** A point the editor can be returned to. Value and cursor together, or undo puts the caret nowhere. */
export interface EditorSnapshot {
    readonly value: string
    readonly cursor: number
}

/**
 * Reverse history search, while it is open.
 *
 * A *mode*: with this set, a printable key extends the query rather than the line, and the arrows walk
 * matches rather than the buffer. Modes are worth avoiding in general and this one earns itself — the
 * alternative is a second editor for the query, and that second editor then needs its own cursor,
 * history and undo, none of which a search box wants.
 *
 * `index` counts from the newest match. The line itself is untouched until the search is accepted, so
 * cancelling costs nothing.
 */
export interface EditorSearch {
    readonly query: string
    readonly index: number
}

export interface EditorState {
    /**
     * The buffer. May contain newlines: a message is composed, not typed on one line.
     *
     * A flat string rather than an array of lines. Every operation here already walks code points —
     * `"👍".length` is 2, so a cursor counted in string indices lands inside a surrogate pair — and a
     * line array would need that walk *plus* a two-part cursor, doubling the arithmetic that already
     * had to be right. `\n` is one code point; the line helpers derive bounds when they need them.
     */
    readonly value: string
    /** Index into `value` in code points, 0..length. */
    readonly cursor: number
    /** Newest last. Submitting appends; the arrows walk it. */
    readonly history: readonly string[]
    /** How far back the arrows have walked. 0 = editing a fresh line. */
    readonly historyOffset: number
    /** The line being edited when history browsing started, restored on the way back down. */
    readonly draft: string
    /** Undo stack, oldest first. Bounded — see `UNDO_LIMIT`. */
    readonly past: readonly EditorSnapshot[]
    /** What undo took away, newest first, so redo can put it back. Cleared by any fresh edit. */
    readonly future: readonly EditorSnapshot[]
    /** Set while `^R` is open. */
    readonly search: EditorSearch | undefined
    /**
     * Where a selection started, or `undefined` when there is none.
     *
     * Required-but-possibly-undefined rather than optional, exactly as `search` above is, and for the same
     * reason: `exactOptionalPropertyTypes` makes an optional field impossible to *clear* by assignment, and
     * clearing this one happens on every unshifted keystroke. Declaring it required also turns every
     * existing construction site into a compile error, which is how they get found rather than missed.
     *
     * A code-point offset like `cursor`, and deliberately not a `{start, end}` pair: the pair cannot say
     * which end is moving, so shift-extending leftward past the anchor and back would collapse to the
     * wrong side. Anchor plus cursor keeps the direction, and the *rendered* range normalises.
     */
    readonly anchor: number | undefined
}
