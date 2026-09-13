/**
 * An arrow-key select list: ❯ on the selected row, hints dim, optional numbering.
 *
 * Controlled and presentational — `index` comes from the parent's reducer (`lib/select.ts`), and values
 * stay with the parent, which maps the index back to its own data. This component never listens to input;
 * the screen root owns the single `useInput`.
 *
 * ## Windowing
 *
 * `maxRows` is not decoration. This rendered every item it was given, which was fine for a sandbox of
 * three agents and is not fine for a store with fifty conversations: on the alternate screen a list taller
 * than the terminal pushes the frame apart, and there is no scrollback to recover it from. It windows
 * through `viewport` — the same function the composer and the catalogue use, because "keep the selected
 * row visible" is one rule and not three.
 *
 * Numbering stays **absolute** while windowed. A digit jumps the cursor by absolute index, so numbering
 * the visible rows 1..n would make `3` mean a different row depending on where the window sat. The
 * consequence, stated: digits reach the first nine rows and the arrows reach the rest.
 */

import { Box, Text } from "ink"
import { viewport } from "#lib/rows"
import { GLYPH, THEME } from "#lib/theme"

export interface SelectItem {
    readonly label: string
    /** Dim, after the label — a model id, a relative time, a one-line description. */
    readonly hint?: string
}

export interface SelectListProps {
    readonly items: readonly SelectItem[]
    readonly index: number
    /** `1.`-style prefixes; digits then jump the cursor (they never choose). */
    readonly numbered?: boolean
    /** Visible rows before the list scrolls to follow the selection. Unbounded when omitted. */
    readonly maxRows?: number
}

export function SelectList({ items, index, numbered, maxRows }: SelectListProps) {
    const window = maxRows === undefined ? items.length : Math.max(1, maxRows)
    const { from, to } = viewport(items.length, index, window)
    // Absolute row numbers computed before the map, so a React key is a position rather than a callback
    // index — and so the printed number does not change when the window moves.
    const visible = items.slice(from, to).map((item, offset) => ({ at: from + offset, item }))

    return (
        <Box flexDirection="column">
            {from > 0 ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {GLYPH.ellipsis} {from} above
                </Text>
            ) : null}
            {visible.map(({ at, item }) => {
                const selected = at === index
                const number = numbered === true ? `${at + 1}. ` : ""
                return (
                    // `wrap="truncate"` is the backstop, not the layout: a row wider than the frame
                    // otherwise wraps onto a continuation line carrying no pointer and no number,
                    // which reads as an extra list item. Label before hint, so what clips is the
                    // reason rather than the thing being named.
                    <Text
                        key={`row-${at}`}
                        wrap="truncate"
                        {...(selected ? { color: THEME.accent } : {})}
                    >
                        {selected ? GLYPH.pointer : "  "}
                        <Text bold={selected}>
                            {number}
                            {item.label}
                        </Text>
                        {item.hint === undefined ? (
                            ""
                        ) : (
                            <Text dimColor {...(selected ? { color: THEME.muted } : {})}>
                                {"  "}
                                {item.hint}
                            </Text>
                        )}
                    </Text>
                )
            })}
            {to < items.length ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {GLYPH.ellipsis} {items.length - to} below
                </Text>
            ) : null}
        </Box>
    )
}
