/**
 * Editable text with an inverse-video cursor — the rendering half of `editor.ts`.
 *
 * Shared by the chat composer and the wizard's text fields, so there is one cursor implementation:
 * code-point split (never UTF-16 units), the character under the cursor drawn inverse, and a trailing
 * space inverted when the cursor sits at the end. When the buffer is empty and a placeholder is given,
 * the placeholder renders dim with the cursor on its first character — the affordance every modern CLI
 * uses for "press enter to accept this".
 *
 * ## Why it renders rows rather than lines
 *
 * The chat buffer became multi-line in Phase 5.5, and the alternative to generalising this was a second
 * component for the composer — which would be a second cursor implementation, the exact thing this file
 * was extracted to prevent. So it renders a column of rows with a caller-supplied `gutter`, and a
 * single-line field is the one-row case of that.
 *
 * A **row is not a line**, and conflating them was the defect. Nothing here wrapped: each logical line was
 * handed to Ink with `wrap="truncate"`, so a message wider than the box was cut and the caret went with it
 * — you could not see what you were typing. `composerLayout` now decides the rows and where the caret sits
 * on them, `wrap="truncate"` is a backstop rather than the layout, and `chat-frame.promptRows` counts the
 * same rows this draws.
 *
 * Two consequences worth stating. The cursor is never drawn *on* a newline: the line break is structure
 * rather than a character, so the caret sits at the end of one row or the start of the next, which is
 * where a person expects it. And the view scrolls to follow the caret through `viewport()` — the same
 * function the catalogue list uses, because "keep the interesting row visible" is one rule.
 */

import { Box, Text } from "ink"
import { selectionRange } from "#editor"
import { composerLayout, rowSegments } from "#lib/composer"
import { viewport } from "#lib/rows"
import { THEME } from "#lib/theme"
import type { EditorState } from "#lib/types"

export interface LineCursorProps {
    readonly editor: EditorState
    readonly placeholder?: string
    /**
     * Render every character as a dot. For a value that must not appear on screen, in scrollback, or
     * over a shoulder — the cursor still moves normally, because the editing model is unchanged and
     * only the rendering differs.
     */
    readonly secret?: boolean
    /**
     * Drawn before the first line. Continuation lines get an equal-width blank, so the text stays in
     * one column and a two-line message does not look like two messages.
     */
    readonly gutter?: string
    /** Visible rows before the view starts scrolling to follow the cursor. */
    readonly maxRows?: number
    /**
     * Columns available for the text, the gutter included.
     *
     * Required for anything that can hold a long message. Omitted, nothing wraps and a line wider than
     * whatever draws this is truncated by Ink at a width nobody chose — which is what this component did
     * everywhere until Phase 5.6.
     */
    readonly columns?: number
}

export function LineCursor({
    editor,
    placeholder,
    secret,
    gutter = "",
    maxRows,
    columns,
}: LineCursorProps) {
    const lead = [...gutter].length
    const pad = " ".repeat(lead)

    if (editor.value === "" && placeholder !== undefined && placeholder !== "") {
        const chars = [...placeholder]
        return (
            <Text dimColor wrap="truncate">
                <Text color={THEME.accent}>{gutter}</Text>
                <Text inverse>{chars[0] ?? " "}</Text>
                {chars.slice(1).join("")}
            </Text>
        )
    }

    // The gutter is drawn on the first row and matched by a blank on every row after it, so the text
    // stays in one column — which means the text itself only ever gets what is left.
    // Derived here rather than passed in: it is a function of the editor state this component already
    // has, and a prop would let a caller draw a highlight the reducer does not believe in.
    const selection = selectionRange(editor)
    const { rows: all, caretRow } = composerLayout(
        editor,
        Math.max(1, (columns ?? Number.MAX_SAFE_INTEGER) - lead),
    )
    const window = maxRows ?? all.length
    const { from, to } = viewport(all.length, caretRow, Math.max(1, window))
    const hiddenAbove = from
    const hiddenBelow = all.length - to

    return (
        <Box flexDirection="column">
            {hiddenAbove > 0 ? (
                <Text dimColor wrap="truncate">
                    {pad}… {hiddenAbove} line{hiddenAbove === 1 ? "" : "s"} above
                </Text>
            ) : null}
            {all.slice(from, to).map((row, offset) => {
                const at = from + offset
                // Masked per code point, so the dot count matches what was typed rather than its byte
                // length.
                const chars = secret === true ? [...row.text].map(() => "•") : [...row.text]
                const glyph = at === from && hiddenAbove === 0 ? gutter : pad
                if (row.caret === undefined && selection === undefined) {
                    return (
                        // Keyed by index: two identical rows in a message are not the same row, and a
                        // content key would collapse them.
                        <Text key={`row-${at}`} wrap="truncate">
                            <Text color={THEME.accent}>{glyph}</Text>
                            {chars.join("")}
                        </Text>
                    )
                }
                // Runs rather than slices. The caret can sit inside the selection, and slicing for both
                // produces overlapping ranges that have to be reconciled; `rowSegments` walks the row once
                // and the caret stays one cell wide by construction. Masking is applied after the split so
                // a secret field's dots line up with the runs rather than with the source.
                const runs = rowSegments(row, selection)
                let column = 0
                return (
                    <Text key={`row-${at}`} wrap="truncate">
                        <Text color={THEME.accent}>{glyph}</Text>
                        {runs.map((run) => {
                            const key = `run-${at}-${column}`
                            column += [...run.text].length
                            const text =
                                secret === true ? [...run.text].map(() => "•").join("") : run.text
                            // Inverting a trailing space is how the caret stays visible at end of line;
                            // `rowSegments` supplies that space when the caret is past the last character.
                            if (run.caret) {
                                return (
                                    <Text key={key} inverse>
                                        {text}
                                    </Text>
                                )
                            }
                            if (run.selected) {
                                return (
                                    <Text key={key} backgroundColor={THEME.selection}>
                                        {text}
                                    </Text>
                                )
                            }
                            return <Text key={key}>{text}</Text>
                        })}
                    </Text>
                )
            })}
            {hiddenBelow > 0 ? (
                <Text dimColor wrap="truncate">
                    {pad}… {hiddenBelow} line{hiddenBelow === 1 ? "" : "s"} below
                </Text>
            ) : null}
        </Box>
    )
}
