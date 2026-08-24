/**
 * Every constant the CLI uses, in one place.
 *
 * The rule is the one termheat follows: no magic number inline. A width, a limit, or a control
 * sequence buried in a component is invisible to anyone tuning behaviour later, and two copies of
 * the same number drift.
 */

// ─── terminal ────────────────────────────────────────────────────────────────────────────

export const SHOW_CURSOR = "\u001B[?25h"
export const RESET_STYLE = "\u001B[0m"
/**
 * Faint text, for the one thing written outside Ink that is not the point of the output.
 *
 * SGR 2 rather than a grey foreground: a fixed colour is wrong on half the terminals in existence,
 * and dim is the terminal's own opinion about what recedes on the theme in use. It persists across a
 * newline, so a multi-line note opens it once and resets once — and the reset lands before the final
 * newline, or the shell prompt that follows inherits it.
 */
export const DIM_STYLE = "\u001B[2m"

/**
 * The alternate screen buffer — a second, empty screen the terminal swaps in, discards on the way
 * out, and never adds to the scrollback.
 *
 * `1049` rather than the older `47`: it saves the cursor position and clears the new buffer in one
 * sequence, which is what lands the shell prompt back where it was rather than wherever the app left
 * the cursor.
 *
 * The order on the way out is easy to get backwards. A style reset applies to whichever buffer is
 * *current*, so it has to be written before the swap away — reset afterwards and any colour the app
 * left on lands on the shell's screen instead of the one being discarded. `restoreTerminal` does them
 * in that order and says so there too.
 */
export const ENTER_ALT_SCREEN = "\u001B[?1049h"
export const LEAVE_ALT_SCREEN = "\u001B[?1049l"

/**
 * Pop the kitty keyboard protocol: `CSI < u`, the counterpart to the `CSI > flags u` Ink pushes.
 *
 * Here rather than in `lib/keyboard.ts` so the dependency runs one way — `lib/exit.ts` needs the
 * sequence and `lib/keyboard.ts` needs `markEnhancedKeys`, and only one of those two can import the
 * other. Terminal-mode sequences already live in this module, which makes this the side that moves.
 */
export const DISABLE_ENHANCED_KEYS = "\u001B[<u"

/**
 * Fallback width. A pty can genuinely report `columns === 0` — measured, under `script -q`, which
 * is how this repo drives a real TTY in a test harness. Any layout maths that divides by the
 * terminal width has to survive that.
 */
export const FALLBACK_COLUMNS = 80
export const FALLBACK_ROWS = 24

/**
 * Rows the live pane may occupy before it starts showing only its tail.
 *
 * Ink erases and redraws its whole dynamic tree every frame, so an unbounded live region means
 * redrawing hundreds of lines per token. Finished messages move into `<Static>`, which is written
 * once and never touched again; this cap is what keeps the *unfinished* one cheap.
 */
export const LIVE_PANE_MAX_ROWS = 12

export const PROMPT = "› "

/**
 * The width a screen is laid out for, clamped at both ends.
 *
 * The floor is where the row layout drops its description column rather than wrapping — below it
 * nothing sensible is possible, and a wrapped row is what made the first skills list unreadable. The
 * ceiling stops a 300-column window putting a description a screen away from the name it belongs to.
 *
 * Here rather than in the one command that first needed them, because every screen now shares a frame
 * and two screens clamping differently is the drift `render.ts` was written to end.
 */
export const MIN_SCREEN_COLUMNS = 40
export const MAX_SCREEN_COLUMNS = 140

/** Rows a scrolling list may occupy, before and after the frame takes its share. */
export const MIN_SCREEN_ROWS = 8
export const MAX_SCREEN_ROWS = 40
/** Header, footer, margins and the counter — what the frame costs a list. */
export const SCREEN_CHROME_ROWS = 8

// ─── commands and input ──────────────────────────────────────────────────────────────────

// The command words themselves live in `session-commands.ts`, beside the summary that documents
// each one and the dispatch that honours it. Three bare string constants here is how the help text
// and the parser came to disagree in the first place.

/** Lines of input history kept for the up/down arrows. */
export const HISTORY_LIMIT = 200

/**
 * Undo points kept for the input buffer.
 *
 * Bounded because a snapshot holds a whole copy of the text, and a long composing session with a
 * pasted document in it would otherwise keep every intermediate version alive for the life of the
 * process. A run of typing is one point, not one per keystroke, so this is deeper than it looks.
 */
export const UNDO_LIMIT = 100

/**
 * Rows the input box may grow to before it scrolls internally.
 *
 * The same reasoning as `LIVE_PANE_MAX_ROWS`: the input is in Ink's dynamic region, which is erased and
 * redrawn every frame, so an unbounded box means redrawing a pasted document on every keystroke. It
 * also stops a long paste pushing the conversation off the screen.
 */
export const MAX_INPUT_ROWS = 10

/**
 * Rows of a reasoning block shown before it folds to a count.
 *
 * Reasoning is secondary and routinely the longest item in a conversation — a real turn produced a
 * twenty-three-row block for a one-sentence answer, which filled a thirty-row terminal on its own and made
 * the reply itself something you had to scroll to find. Four rows is enough to see what it was thinking
 * about; `⌥r` shows the rest.
 *
 * Folding is a *view* decision, applied when items become rows. The whole text is always in the item, so
 * expanding needs no re-derivation and nothing is lost.
 */
export const REASONING_FOLD_ROWS = 4

/** Matches `^R` shows at once. Enough to recognise one, few enough to leave the prompt on screen. */
export const SEARCH_ROWS = 6

/**
 * Rows a single-value field may wrap to before it scrolls to follow the caret.
 *
 * Smaller than `MAX_INPUT_ROWS`, because a *value* is not a message: a wizard answer and a manifest
 * setting are one line of intent that happens to be long. Three is enough for the longest thing a
 * generated manifest holds — `tools.pinned` at 92 characters is two rows on an 80-column terminal — and
 * few enough that the field never pushes the rest of the screen around.
 *
 * There was no bound at all before, because the field passed no width: in the settings editor a long
 * value was clipped at the terminal's edge with the caret past the clip, and you could not see what you
 * were typing. The wizard escaped it — a bordered box bounds its text whatever the field passes.
 */
export const FIELD_ROWS = 3

/**
 * Transcript items kept before the oldest are dropped.
 *
 * Load-bearing rather than prudent, and it was missing for three phases. While the conversation lived
 * in `<Static>` a finished item was written once and cost nothing afterwards; the alternate screen took
 * that away, so every item is now re-derived and re-wrapped on every frame — an unbounded buffer means
 * unbounded work per keystroke, and the case that reaches it is an agent looping tool calls overnight
 * rather than anybody typing.
 *
 * Counted in **items**, not rows, because the row count depends on the terminal width and the reducer
 * that owns the buffer is pure and has none. That does not contradict the scroll layer's rule that the
 * unit is a row: that rule is about addressing an *offset*, where paging by item steps over a forty-row
 * reply in one keystroke.
 *
 * Deliberately far past any session a person reads end to end — roughly four hundred turns — so the cap
 * is a backstop nobody meets rather than a limit that shapes ordinary use. Eviction is also gated on the
 * reader following the tail; see `TRIM` in `transcript.ts` for why that gate is not optional.
 */
export const MAX_TRANSCRIPT_ITEMS = 2000

// ─── defaults ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ROW_LIMIT = 50
export const MIN_ROW_LIMIT = 1

// ─── exit codes ──────────────────────────────────────────────────────────────────────────

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
/** 128 + SIGTERM, the shell convention. */
export const EXIT_SIGTERM = 143

/** Rows a pane over the conversation may use — a command's output, or a hosted view. */
export const PANE_ROWS = 16

/**
 * The fewest rows a scrolling body is ever given.
 *
 * A floor rather than a target. At eight terminal rows the chrome alone — header, composer, status —
 * accounts for most of the screen, and the alternative to a floor is a body of zero rows: a session
 * that shows the prompt and no conversation at all, which reads as a broken renderer rather than as a
 * window somebody should make taller.
 */
export const MIN_BODY_ROWS = 3

/**
 * Rows a list may take while landing — before anything has been sent.
 *
 * Deliberately larger than `SEARCH_ROWS`, which is tuned for a live conversation where every row of list is a
 * row of conversation hidden. There is no conversation yet on the landing screen and its whole job is
 * discovery: showing six of fifteen commands behind a `… 9 below` is the wrong trade on the screen somebody
 * opens before they know what the commands are. The brand mark gives up a tier to pay for it, which the tier
 * ladder already knows how to do.
 *
 * **This tracks the size of the in-session command table**, so a phase that adds a command has to raise it —
 * which is why `commands.test.ts` asserts the relationship rather than leaving it to whoever notices the
 * `… 1 below`. It is not derived from `COMMANDS` directly because `commands.ts` reads this module, and the
 * cycle would cost more than the assertion does.
 */
export const LANDING_LIST_ROWS = 18

/**
 * Rows of conversation the landing screen keeps, whatever the brand mark would like.
 *
 * The banner is written into the transcript, so a wordmark that squeezed it to nothing would hide the boot
 * notes and every load warning behind a picture — which is the trimmed-catalogue failure with better
 * typography: true of what is on screen, false of what is the case.
 *
 * Eight rather than four, measured against a real banner: four left the window showing the *tail* of it, so
 * the first thing on screen was the second half of a wrapped store path. The banner runs six to eight rows
 * depending on how many load warnings there are.
 */
export const MIN_LANDING_TRANSCRIPT = 8

/**
 * How long after a press a second one still counts as a double-click.
 *
 * A terminal reports three presses and never a "double click", so the grouping is ours to infer — from time
 * *and* position, because two clicks 300 ms apart on different words are two clicks. 400 ms is the common
 * platform default; longer makes a deliberate second selection turn into a word-select, shorter makes a
 * real double-click fail on a slow hand.
 */
export const MULTI_CLICK_MS = 400

/** The blank row between the brand mark and the one-line header under it. */
export const BRAND_GAP_ROWS = 1

/** Conversations the session picker shows at once. The list scrolls inside this. */
export const SESSION_PICKER_ROWS = 12

/**
 * How often `daemon logs --follow` checks a service log for new bytes.
 *
 * Polled rather than watched: `fs.watch` on macOS reports another process's appends unreliably, and a
 * follower that misses the line somebody is waiting for is worse than one that arrives a third of a
 * second late — the reason to watch a log live is not trusting what you have been told. Ctrl-C wakes the
 * pending sleep rather than waiting it out, so this interval never delays a stop.
 */
export const LOG_POLL_MS = 300

/**
 * How long a ^C at an idle prompt stays armed.
 *
 * The chord is doubled rather than immediate because a single ^C means "cancel the turn" everywhere
 * else in this session, and the two are one keystroke apart. Long enough to be a deliberate second
 * press, short enough that an armed prompt left alone goes back to being safe.
 */
export const EXIT_ARM_MS = 2000
