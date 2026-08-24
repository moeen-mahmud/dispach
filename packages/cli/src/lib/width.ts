/**
 * How many terminal columns a string occupies.
 *
 * ## Why this exists
 *
 * `lib/wrap.ts` measured in **code points** and there was no width function anywhere in the CLI. An emoji
 * is one code point and two columns, so `"👍".repeat(10)` measured 10 and drew 20 — and every cap built on
 * that measurement was short. Short by a row on the alternate screen is a frame taller than the terminal,
 * which scrolls the buffer and leaves the status line halfway up the display: the exact corruption
 * `lib/wrap.ts` was written to prevent, still reachable through the one input it could not measure.
 *
 * It became urgent with mouse selection, where a column has to map back to a character. A drag that grabs
 * the wrong text on any line containing an emoji is the "looks right and isn't" failure this repo avoids.
 *
 * ## What it is, and what it is not
 *
 * A range table, not a dependency — the same call `SPINNER_FRAMES` makes, and for the same reason: this is
 * a handful of comparisons against data that changes once a year, and a package would be a supply chain.
 *
 * It is **not** full UAX #11, and the gap is stated rather than discovered. Width is defined per code
 * point, so a grapheme cluster built from several — a ZWJ family emoji, a flag pair, a letter with two
 * combining marks — is measured by summing its parts. Zero-width joiners and variation selectors count as
 * zero, which makes the common cases right; a flag (two regional indicators, four columns by this count,
 * two on screen) is over-measured, and over-measuring wraps early rather than overflowing. That is the
 * direction to be wrong in, and it is why this rounds up rather than down.
 */

/** Ranges whose code points occupy two columns: East Asian Wide and Fullwidth, plus emoji. */
const WIDE: readonly (readonly [number, number])[] = [
    [0x1100, 0x115f], // Hangul Jamo initial consonants
    [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
    [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, CJK compat
    [0x3400, 0x4dbf], // CJK Unified Extension A
    [0x4e00, 0x9fff], // CJK Unified
    [0xa000, 0xa4cf], // Yi
    [0xa960, 0xa97f], // Hangul Jamo Extended-A
    [0xac00, 0xd7a3], // Hangul syllables
    [0xf900, 0xfaff], // CJK compatibility ideographs
    [0xfe10, 0xfe19], // vertical forms
    [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
    [0xff00, 0xff60], // fullwidth forms
    [0xffe0, 0xffe6], // fullwidth signs
    [0x1f300, 0x1f64f], // pictographs and emoticons
    [0x1f680, 0x1f6ff], // transport and map symbols
    [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
    [0x1fa70, 0x1faff], // symbols extended-A
    [0x20000, 0x2fffd], // CJK Unified Extension B and beyond
    [0x30000, 0x3fffd],
]

/** Ranges that occupy no columns of their own: combining marks, joiners, variation selectors. */
const ZERO: readonly (readonly [number, number])[] = [
    [0x0300, 0x036f], // combining diacritical marks
    [0x0483, 0x0489],
    [0x0591, 0x05bd],
    [0x0610, 0x061a],
    [0x064b, 0x065f],
    [0x0670, 0x0670],
    [0x06d6, 0x06dc],
    [0x0900, 0x0903],
    [0x093a, 0x093a],
    [0x0e31, 0x0e31],
    [0x0e34, 0x0e3a],
    [0x1ab0, 0x1aff], // combining diacritical marks extended
    [0x1dc0, 0x1dff], // combining diacritical marks supplement
    [0x200b, 0x200f], // zero-width space, ZWNJ, ZWJ, LRM, RLM
    [0x20d0, 0x20ff], // combining marks for symbols
    [0xfe00, 0xfe0f], // variation selectors
    [0xfe20, 0xfe2f], // combining half marks
    [0xfeff, 0xfeff], // byte-order mark
]

function within(code: number, ranges: readonly (readonly [number, number])[]): boolean {
    // Linear, because the tables are short and this runs per code point on the wrapping path. A binary
    // search over twenty entries is not measurably faster and is one more thing to get wrong.
    for (const [low, high] of ranges) {
        if (code < low) return false
        if (code <= high) return true
    }
    return false
}

/**
 * Columns one code point occupies: 0, 1, or 2.
 *
 * A C0 control counts as zero. They should never reach a measured string — `wrap.ts` expands tabs and
 * `printableOnly` strips the rest — so this is a floor rather than a feature: counting an escape byte as a
 * column would make every row containing one wrap early, which is harder to spot than it sounds.
 */
export function charWidth(code: number): number {
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
    if (within(code, ZERO)) return 0
    if (within(code, WIDE)) return 2
    return 1
}

/** Columns a string occupies, summed per code point. */
export function textWidth(text: string): number {
    let total = 0
    for (const char of text) total += charWidth(char.codePointAt(0) ?? 0)
    return total
}

/** Per-code-point widths of `cells`, for a caller that walks a line and needs each one. */
export function cellWidths(cells: readonly string[]): readonly number[] {
    return cells.map((cell) => charWidth(cell.codePointAt(0) ?? 0))
}
