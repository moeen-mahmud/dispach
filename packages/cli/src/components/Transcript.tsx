/**
 * The finished conversation, as a window over rows we own.
 *
 * ## What replaced `<Static>`, and why it had to
 *
 * Through Phase 5 this rendered inside Ink's `<Static>`, which writes a node to the terminal once and
 * never touches it again — so history cost nothing to keep and scrolling was the terminal's own
 * scrollback. Phase 5.5 puts the session on the alternate screen buffer, and the two are incompatible
 * rather than merely awkward: `<Static>` appends to the scrollback, and the alternate buffer is
 * discarded on the way out with a scrollbar that reaches nothing. Everything Static wrote would be
 * invisible from the moment it was written.
 *
 * So the conversation is a buffer this code owns and this component shows a slice of. That moves the
 * transcript into the tree Ink redraws every frame, which is exactly the cost `<Static>` existed to
 * avoid — and is why the window is bounded in rows. A frame redraws its window regardless of how long
 * the conversation is, so the per-token cost stops growing with the answer.
 *
 * Controlled, like every component in this kit: the offset lives in the screen root, the rows come from
 * `transcriptRows`, and this owns no keyboard and no state.
 */

import { Box, Text } from "ink"
import type { TranscriptProps } from "#lib/schema"
import { scrollHint } from "#lib/scroll"
import { rowSelection } from "#lib/text-selection"
import { ROLE_COLOR, THEME } from "#lib/theme"

export function Transcript({ rows, slice, selection }: TranscriptProps) {
    const visible = rows.slice(slice.from, slice.to)
    const hint = scrollHint(slice)

    return (
        <Box flexDirection="column">
            {/*
             * Always drawn, blank included — the caller's window already excludes this row, so making it
             * conditional would hand the conversation one extra row on exactly the frames where it has
             * least to spare. Blank is one line nobody reads; a moving layout is one everybody notices.
             */}
            <Text color={THEME.muted} wrap="truncate">
                {hint === "" ? " " : hint}
            </Text>
            {visible.map((row, offset) => {
                // Spread rather than `color={...}`: Ink declares `color?: string`, so under
                // `exactOptionalPropertyTypes` an explicit `undefined` is a type error — and omitting it
                // is also what we want, because an assistant reply should use the terminal's own
                // foreground rather than a colour we picked for it.
                const colour = row.dim === true ? THEME.muted : ROLE_COLOR[row.role]
                const cells = [...row.text]
                // `slice.from + offset` is the row's index in the *buffer*, which is the coordinate the
                // selection is stored in. Using the visible index would move the highlight every time the
                // window scrolled, which is the whole reason the selection is not kept in screen space.
                const range = rowSelection(selection, slice.from + offset, cells.length)
                if (range === undefined) {
                    return (
                        <Text
                            key={row.key}
                            // Truncate rather than wrap, and that is load-bearing. `transcriptRows` has
                            // already broken the text to the width; letting Ink wrap it again would paint
                            // more rows than the window counted, which puts the tail of a reply underneath
                            // the composer.
                            wrap="truncate"
                            bold={row.bold === true}
                            {...(colour === undefined ? {} : { color: colour })}
                        >
                            {row.text === "" ? " " : row.text}
                        </Text>
                    )
                }
                // A background rather than `inverse`: inverse swaps foreground and background, so across
                // the transcript's coloured roles it would produce a different highlight per role and read
                // as several selections. Starting at `lead` excludes the role prefix — `› ` and `  · ` are
                // chrome this renderer added, and highlighting them would claim text is selected that
                // nobody wrote and no copy will contain.
                const from = Math.max(range.from, row.lead)
                return (
                    <Text
                        key={row.key}
                        wrap="truncate"
                        bold={row.bold === true}
                        {...(colour === undefined ? {} : { color: colour })}
                    >
                        {cells.slice(0, from).join("")}
                        <Text backgroundColor={THEME.selection}>
                            {cells.slice(from, range.to).join("")}
                        </Text>
                        {cells.slice(range.to).join("")}
                    </Text>
                )
            })}
        </Box>
    )
}
