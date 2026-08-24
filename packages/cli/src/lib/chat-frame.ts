/**
 * How tall each piece of the chat frame is, so the conversation gets exactly the rows that are left.
 *
 * ## Why this has to be arithmetic and not flexbox
 *
 * On the alternate screen the layout has a hard ceiling: the terminal's height, with no scrollback to
 * absorb an overshoot. One row too many and Ink's own output scrolls the buffer, which leaves the status
 * line halfway up the display and the composer where the status line was — a corrupt frame rather than a
 * cramped one. Yoga will not save us here, because the thing that overflows is *our* choice of how many
 * transcript rows to hand it.
 *
 * So every piece of chrome reports its height, the sum is subtracted from the terminal, and the
 * conversation gets the remainder. `bodyRows` spends one further row as a margin, in the direction that
 * cannot be seen.
 *
 * ## The drift this invites, and how it is caught
 *
 * These functions restate each component's geometry, which means a component that grows a row without
 * changing its function here would make the frame one row too tall. That is a real hazard and it is
 * pinned by frame tests: each function is asserted against the line count of the actual render, so the
 * two cannot disagree for longer than one test run. Deriving the number *from* a render is not available
 * — the layout has to be decided before anything is drawn.
 *
 * Pure: editor state, palette matches and live text in, row counts out.
 */

import { searchMatches } from "#editor"
import { composerLayout } from "#lib/composer"
import {
    BRAND_GAP_ROWS,
    LIVE_PANE_MAX_ROWS,
    MAX_INPUT_ROWS,
    MIN_LANDING_TRANSCRIPT,
} from "#lib/const"
import type { Palette } from "#lib/palette"
import { viewport } from "#lib/rows"
import { bodyRows } from "#lib/scroll"
import type { EditorState, LiveTurn } from "#lib/types"
import { livePane } from "#lib/wrap"

/** The one-line header, the status line, and the row the transcript reserves for its scroll counter. */
const HEADER_ROWS = 1
const STATUS_ROWS = 1
const SCROLL_HINT_ROWS = 1
/** `Prompt` wraps `LineCursor` in a bordered box: one row of border above and one below. */
const PROMPT_BORDER_ROWS = 2
/** The same box's two border columns and its `paddingX={1}` on each side. */
const PROMPT_PADDING = 4
/** `PROMPT` — the `\u203a ` the composer draws before the first row and matches with a blank after it. */
const PROMPT_GUTTER = 2
/** `\u00b7 reasoning \u00b7 ` — the prefix `Live` puts on its first row, which narrows the wrap. */
const LIVE_LABEL = 14

/**
 * The composer, including its border and the newline hint it shows once a message has two lines.
 *
 * One form, both states. There used to be a `roomy` landing variant three rows taller, which existed
 * because the composer sat directly under the banner with the slack below it — the padding was what kept
 * its border off the text above. With the slack above it (decision 11.98, reversed) there is nothing to
 * separate it from, and 11.90's own argument now applies to both states rather than one: every row the
 * composer takes is a row of conversation, and this is the function that charges for them.
 */
export function promptRows(editor: EditorState, columns: number): number {
    // Visual rows, not logical lines. Counting lines was correct only while nothing wrapped, and it went
    // wrong in the direction that cannot be seen: a wrapped message drew more rows than the frame had
    // subtracted, so the bottom of the composer went under the status line.
    const { rows, caretRow } = composerLayout(
        editor,
        Math.max(1, columns - PROMPT_PADDING - PROMPT_GUTTER),
    )
    const total = rows.length
    // Through `viewport`, the function `LineCursor` itself calls, rather than a second guess at where the
    // window lands. Each side of it spends a row on a "… n lines above/below" notice when it hides
    // something, so the count has to come from the same arithmetic that decides whether it does.
    const { from, to } = viewport(total, caretRow, Math.max(1, Math.min(total, MAX_INPUT_ROWS)))
    return (
        PROMPT_BORDER_ROWS +
        (to - from) +
        (from > 0 ? 1 : 0) +
        (total - to > 0 ? 1 : 0) +
        // Logical lines, not rows: the newline hint answers "how do I add another line", and a message
        // that merely wrapped has not added one. Counting rows here made the frame one row taller than
        // the render for every message wide enough to wrap — the same disagreement, in the other
        // direction, as counting lines for the viewport.
        (editor.value.includes("\n") ? 1 : 0)
    )
}

/** The slash-command list: its matches, its overflow notices, and the line naming its keys. */
export function paletteRows(palette: Palette | undefined, maxRows: number): number {
    if (palette === undefined) return 0
    // The empty case renders one line saying nothing matched, and no key hint — there is nothing to do.
    if (palette.matches.length === 0) return 1
    const shown = Math.min(palette.matches.length, maxRows)
    const overflow = palette.matches.length > shown ? 1 : 0
    return shown + overflow + 1
}

/** `^R`'s match list plus its query line. Zero when the search is closed. */
export function searchRows(editor: EditorState, maxRows: number): number {
    if (editor.search === undefined) return 0
    const matches = searchMatches(editor)
    return (matches.length === 0 ? 1 : Math.min(matches.length, maxRows)) + 1
}

export interface ChatFrame {
    /**
     * Rows the brand mark **may** use above the one-line header, or 0 once it has collapsed.
     *
     * An allowance, not a height, and the caller must charge the conversation for what the mark *actually*
     * draws — `wordmark` degrades through its tiers and usually takes far less. Charging the allowance was
     * the first version and it wasted eleven rows on a thirty-row terminal: the mark drew five, the
     * transcript was billed sixteen, and the banner ended up scrolled to a mid-wrap fragment of a store path
     * with a third of the screen blank.
     *
     * Floored so a landing screen always keeps enough transcript for the banner. That is where the boot notes
     * and every load warning are written, and a picture hiding them is the trimmed-catalogue failure with
     * better typography: true of what is on screen, false of what is the case.
     */
    readonly brand: number
    /**
     * Rows for the brand mark and the conversation together, before either is measured.
     *
     * Returned so the split happens once, in the caller that knows the mark's rendered height.
     */
    readonly body: number
    /** Rows the conversation may draw if the mark takes none — its scroll counter already deducted. */
    readonly transcript: number
    /** Rows a pane over the conversation may draw. It replaces the transcript rather than sharing. */
    readonly pane: number
}

/**
 * The row budget for one frame.
 *
 * A pane and the transcript are alternatives, not neighbours. Rendered together the pane took a fixed
 * sixteen rows and pushed the conversation off the top of a full screen — and on a surface with no
 * scrollback, "off the top" means gone. Whichever is in front gets the body.
 */
export function chatFrame(inputs: {
    readonly rows: number
    readonly columns: number
    readonly editor: EditorState
    readonly live: LiveTurn | undefined
    readonly showReasoning: boolean
    readonly palette: Palette | undefined
    readonly searchMaxRows: number
    readonly paletteMaxRows: number
    /** A confirmation question, which is one line above the composer. */
    readonly confirming: boolean
    /**
     * Nothing has been sent yet, so the brand mark is up.
     *
     * It used to mean a roomier composer as well, and no longer does: the composer is one form in both
     * states now that the slack sits above it. What is left is the wordmark's allowance, which is the only
     * thing on the frame that a landing screen still spends rows on.
     */
    readonly landing: boolean
    /** The one-line hint under the composer, shown only while landing. */
    readonly hint: boolean
}): ChatFrame {
    const live = inputs.live
    // The live pane shows reasoning only until the reply itself starts, which is the component's rule and
    // therefore has to be this one too.
    const liveText =
        live === undefined
            ? ""
            : inputs.showReasoning && live.reasoning !== "" && live.text === ""
              ? live.reasoning
              : live.text

    const chrome =
        HEADER_ROWS +
        STATUS_ROWS +
        livePane(liveText, inputs.columns - LIVE_LABEL, LIVE_PANE_MAX_ROWS).rows +
        paletteRows(inputs.palette, inputs.paletteMaxRows) +
        searchRows(inputs.editor, inputs.searchMaxRows) +
        promptRows(inputs.editor, inputs.columns) +
        (inputs.confirming ? 1 : 0) +
        (inputs.hint ? 1 : 0)

    const body = bodyRows(inputs.rows, chrome)

    // What is left for the brand mark after the conversation keeps its floor and the blank row under the mark
    // is paid for. Zero once it has collapsed, and zero on a terminal too short to afford it — `wordmark`
    // degrades through its tiers on the way down and then to nothing, so a short screen loses the picture
    // rather than the banner.
    const brand = inputs.landing ? Math.max(0, body - MIN_LANDING_TRANSCRIPT - BRAND_GAP_ROWS) : 0

    // The pane draws its own two "… n lines above/below" notices and a key-hint line, which is why it
    // reports fewer rows than it is given rather than being handed the whole body.
    return {
        brand,
        body,
        transcript: Math.max(1, body - SCROLL_HINT_ROWS),
        pane: Math.max(1, body - 3),
    }
}

/**
 * The conversation's rows once the brand mark has taken what it actually needs.
 *
 * Separate from `chatFrame` because it needs the mark's *rendered* height, which only the caller has — and
 * one function rather than an inline subtraction at the call site, so there is no second idea of whether the
 * gap row is included.
 */
/**
 * Which buffer row a screen cell is on, or `undefined` if the cell is not in the transcript.
 *
 * The one place the frame's vertical arithmetic is read backwards, and it belongs here because this module
 * is where that arithmetic already lives. A caller deriving it would restate the brand's height, the gap,
 * the header and the scroll-hint row — four numbers that are only correct together.
 *
 * Above the transcript, in order: the wordmark and its gap (landing only), the one-line header, and the
 * scroll-hint row `Transcript` always draws even when it is blank. Below it, everything is chrome. A cell
 * outside the window returns `undefined` rather than clamping, because clamping would make a click on the
 * status line select the last row of the conversation.
 */
export function transcriptHit(
    point: { readonly column: number; readonly row: number },
    layout: {
        readonly brandLines: number
        /** The window `Transcript` was handed: `from` inclusive, `to` exclusive. */
        readonly from: number
        readonly to: number
    },
): { readonly row: number; readonly column: number } | undefined {
    const top =
        (layout.brandLines === 0 ? 0 : layout.brandLines + BRAND_GAP_ROWS) +
        HEADER_ROWS +
        SCROLL_HINT_ROWS
    const offset = point.row - top
    if (offset < 0) return undefined
    const row = layout.from + offset
    if (row >= layout.to) return undefined
    return { row, column: point.column }
}

export function transcriptRowsAfterBrand(frame: ChatFrame, brandLines: number): number {
    const used = brandLines === 0 ? 0 : brandLines + BRAND_GAP_ROWS
    return Math.max(1, frame.body - used - SCROLL_HINT_ROWS)
}
