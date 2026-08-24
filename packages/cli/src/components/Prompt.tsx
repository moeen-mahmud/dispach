/**
 * The composer — a rounded box that grows with the message, accent-bordered when ready and muted while
 * a turn runs.
 *
 * Ink has no text field: it delivers keystrokes and nothing else, so the cursor is drawn rather than
 * positioned. `LineCursor` owns that rendering for this component and the wizard's fields alike, which
 * is why the prompt glyph is handed to it as a `gutter` rather than rendered here beside it — a glyph
 * drawn here would sit next to the *block* of lines, leaving the second line of a message starting one
 * column to its left and reading as a separate message.
 *
 * The box caps at `MAX_INPUT_ROWS` and scrolls to follow the cursor. Same reasoning as the live pane:
 * this is Ink's dynamic region, erased and redrawn every frame, so an unbounded box redraws a pasted
 * document on every keystroke — and a long paste would push the conversation off the screen.
 *
 * The border exists only where Ink renders: the plain path never mounts this, so plain parity is
 * untouched by definition.
 */

import { Box, Text } from "ink"
import { LineCursor } from "#components/LineCursor"
import { MAX_INPUT_ROWS, PROMPT } from "#lib/const"
import type { PromptProps } from "#lib/schema"
import { NEWLINE_HINT } from "#lib/session-commands"
import { BORDER_STYLE, THEME } from "#lib/theme"

export function Prompt({ editor, busy, placeholder, columns }: PromptProps) {
    const lines = editor.value.split("\n").length
    // Two border columns and `paddingX={1}` on each side. Subtracted here rather than inside the cursor,
    // because the box that spends them is this one.
    const inner = Math.max(1, columns - 4)
    return (
        <Box flexDirection="column">
            <Box
                borderStyle={BORDER_STYLE}
                borderColor={busy ? THEME.border : THEME.borderActive}
                // Explicit, because a `<Box>` with no width takes its *content* width — which is how a long
                // message made the box wider than the terminal and left the wrapping to whichever terminal
                // was running it.
                width={columns}
                paddingX={1}
            >
                <LineCursor
                    editor={editor}
                    gutter={PROMPT}
                    maxRows={MAX_INPUT_ROWS}
                    columns={inner}
                    {...(placeholder === undefined ? {} : { placeholder })}
                />
            </Box>
            {/*
             * Named only once the message has more than one line. Advertising it on every empty prompt
             * spends a row on something most messages never need.
             *
             * It names ⌥⏎ and the backslash and *not* shift+⏎, even after `terminal-setup` has run.
             * Whether shift+⏎ reaches this process cannot be detected from inside it — the terminal
             * either sends a distinguishable sequence or does not — and a hint that names a chord which
             * silently sends the message instead is worse than one that names only what always works.
             * `/help` and `terminal-setup` are where shift+⏎ is explained.
             */}
            {lines > 1 ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {NEWLINE_HINT}
                </Text>
            ) : null}
        </Box>
    )
}
