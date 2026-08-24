/**
 * The one home for appearance: colour tokens, glyphs, and the maps components render from.
 *
 * `lib/const.ts` keeps *behavioural* numbers (row caps, history limits, control sequences); this
 * module holds everything a person would touch to change how the CLI looks. Splitting the two
 * extends the "no magic value inline" rule rather than weakening it — one home each, and a
 * component containing a literal colour name is a review failure.
 *
 * Tokens are plain Ink colour names (16-colour safe; Ink's chalk layer maps them per terminal),
 * which keeps this module PURE-listable. `brand` is the single deliberate exception and says why. `NO_COLOR` needs no handling here: the mode resolution
 * forces plain output before Ink ever loads, and chalk independently honours it anyway.
 *
 * This is deliberately a single built-in token set, not a theming system — decision 11.12
 * reverses Phase 2.5's "themes" non-goal in the narrowest possible sense. User-configurable
 * themes stay a non-goal.
 */

import type { TranscriptRole, TurnStatus } from "#lib/types"

export interface Theme {
    /** The one accent, used sparingly: caret, selection cursor, user lines, banner border. */
    readonly accent: string
    /** Hints, notes, reasoning, breadcrumbs. */
    readonly muted: string
    readonly success: string
    readonly warning: string
    readonly error: string
    /** Tool rows and tool-running status. */
    readonly info: string
    /** Cancelling — the one transitional state worth its own colour. */
    readonly emphasis: string
    /**
     * The background a selected run is painted on.
     *
     * A background rather than `inverse`, which is what the caret uses. Inverse swaps foreground and
     * background, so on a coloured run it produces a different colour per role and reads as three
     * highlights rather than one selection — and where a selection contains the caret the two inversions
     * cancel and the caret disappears inside it. A solid background composes instead of fighting.
     */
    readonly selection: string
    /** Non-focal boxes: cards, frames. */
    readonly border: string
    /** The focused box: the input line, the banner. */
    readonly borderActive: string
    /**
     * The wordmark, and only the wordmark.
     *
     * The one token that is a hex triplet rather than an Ink colour name, chosen by the owner. Every other
     * token is 16-colour safe on purpose — a name lets chalk pick whatever the terminal actually has — and
     * this is the deliberate exception, because a brand mark is the one element whose *exact* colour is the
     * point. Chalk downsamples it per terminal rather than failing: on a 256-colour terminal it lands on the
     * nearest cube entry, on a 16-colour one on bright green, which is the right neighbour. `NO_COLOR` is
     * handled before Ink loads at all, by the mode resolution.
     *
     * Not reused anywhere else. A second consumer would make it an accent, and the accent already exists.
     */
    readonly brand: string
}

export const THEME: Theme = {
    accent: "magenta",
    muted: "gray",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
    emphasis: "cyan",
    // 16-colour safe like every token but `brand`: chalk maps it to whatever the terminal has, and a
    // named colour survives a 16-colour terminal where a hex triplet would be approximated.
    selection: "blue",
    border: "gray",
    borderActive: "magenta",
    brand: "magenta",
}

/** Status-dot colours, previously inlined in StatusBar. */
export const STATUS_COLOR: Record<TurnStatus, string> = {
    idle: THEME.success,
    thinking: THEME.warning,
    streaming: THEME.accent,
    working: THEME.info,
    cancelling: THEME.emphasis,
}

/** Transcript role colours, previously inlined in Transcript. `undefined` = terminal default. */
export const ROLE_COLOR: Record<TranscriptRole, string | undefined> = {
    user: THEME.accent,
    assistant: undefined,
    reasoning: THEME.muted,
    note: THEME.muted,
    error: THEME.error,
    tool: THEME.info,
    banner: undefined,
}

/**
 * What each role puts before its text, and re-applies as a hanging indent on every row after the first.
 *
 * That second half is why `reasoning` is **two columns** rather than the `\u00b7 reasoning \u00b7 ` it used to be.
 * A prefix is an indent, so the longest block in the transcript was also the narrowest — 86 columns of a
 * 100-column terminal, on the one item that is routinely forty rows long. The label moved to a header row
 * of its own, where it costs one row once instead of fourteen columns per row.
 */
export const ROLE_PREFIX: Record<TranscriptRole, string> = {
    user: "› ",
    assistant: "",
    reasoning: "  ",
    note: "· ",
    error: "✖ ",
    tool: "  · ",
    banner: "",
}

/** The glyph vocabulary. Components compose these; none defines its own. */
export const GLYPH = {
    prompt: "› ",
    pointer: "❯ ",
    bullet: "· ",
    error: "✖ ",
    dot: "● ",
    check: "✓ ",
    ellipsis: "…",
    create: "+ ",
    /** Multi-select boxes. Two glyphs so a ticked row reads as ticked without colour. */
    checked: "◉ ",
    unchecked: "◯ ",
} as const

/** Braille spinner. Ten glyphs in a const, not a dependency — decision 11.10 holds. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const SPINNER_INTERVAL_MS = 80

/** cli-boxes ships inside Ink 7; rounded is the house border. Zero new dependencies. */
export const BORDER_STYLE = "round" as const
