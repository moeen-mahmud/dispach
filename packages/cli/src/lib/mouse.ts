/**
 * Wheel scrolling on the alternate screen. Pure, so a mouse report is arithmetic rather than a guess.
 *
 * ## Why this needs a guard rather than only a parser
 *
 * Ink does not know about mouse reports. Measured against a real pty with tracking on: a wheel notch
 * arrived as the literal text `ESC[<64;10;5M`, fell through the keymap to the insert branch, and was typed
 * into the message — twice, because two notches are two reports. So recognising a report is not an
 * optimisation here; every report a terminal can send has to be claimed, wheel and click alike, or the
 * feature's cost is garbage in somebody's message.
 *
 * A chunk can carry several reports. A fast scroll sends one per notch and the runtime coalesces them, so
 * the count matters: honouring one report per chunk makes a flick of the wheel move a single row and reads
 * as the wheel not working.
 *
 * ## The trade this makes, stated
 *
 * Tracking is what stops the terminal handling the mouse itself, so **drag-selecting text with the mouse
 * stops working while a session is mounted**. Every terminal worth naming lets you hold shift to bypass
 * tracking and select natively, which is why the key list says so rather than leaving it to be discovered.
 *
 * Two encodings are recognised. SGR (`ESC [ < b ; x ; y M`) is what we ask for and what any terminal from
 * the last decade replies with; X10 (`ESC [ M` and three raw bytes) is the fallback a terminal that ignored
 * the SGR request will use, and its bytes are frequently above 127 — so leaving it unclaimed would put
 * unprintable characters into a message on exactly the terminals least able to say why.
 */

/**
 * Button tracking, drag tracking, and SGR encoding.
 *
 * 1000 reports press and release and is the least that reports the wheel at all. **1002 adds motion while a
 * button is held**, and without it a drag is not reported — which is why selecting text was not merely
 * disabled but unreachable: the events never arrived. 1003 (motion with no button) is deliberately absent,
 * because it makes the terminal send a report for every pixel of idle pointer movement and nothing here
 * wants hover.
 *
 * Set low-to-high and reset high-to-low, so a terminal that only understands some of them is left in a
 * state we asked for rather than a partial one.
 */
export const ENABLE_MOUSE = "\u001B[?1000h\u001B[?1002h\u001B[?1006h"
/** Reversed on the way out, so a terminal is left handling its own mouse again. */
export const DISABLE_MOUSE = "\u001B[?1006l\u001B[?1002l\u001B[?1000l"

/**
 * Rows one notch of the wheel moves.
 *
 * Three, which is the line-scroll every desktop uses. One row per notch is technically a scroll and feels
 * like the wheel is broken; a whole page per notch overshoots what somebody is looking for.
 */
export const WHEEL_ROWS = 3

/** Wheel-up and wheel-down in SGR's button numbering. 64 is the wheel bit plus button 0. */
const WHEEL_UP = 64
const WHEEL_DOWN = 65

/** Motion bit — set on every report mode 1002 sends while a button is held. */
const MOTION = 32
/** Shift bit, so shift-clicking can extend a selection rather than starting a new one. */
const SHIFT = 4

/**
 * The escape prefix is **optional**, and that is not laxness.
 *
 * Ink strips one leading `ESC` from the chunk before a handler sees it (`use-input.js:97`), so the first
 * report in a chunk arrives bare and every one after it keeps its escape. Requiring the prefix therefore
 * matched none of them, which is exactly how the first version of this let a wheel notch through: measured
 * against a real pty, the composer read `abc[<64;10;5M[<64;10;5M`.
 *
 * Anchored rather than left floating: a bare report is only recognised at the very start of the chunk,
 * which is the one position Ink's stripping can produce. A message that happens to contain the same text
 * in the middle of a sentence is still a message.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the thing being matched
const SGR = /(?:^|\u001B)\[<(\d+);(\d+);(\d+)([Mm])/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the thing being matched
const X10 = /(?:^|\u001B)\[M[\s\S]{3}/g

/** Which gesture a report describes. */
export type MouseKind = "wheel" | "press" | "drag" | "release"

/** Where a report happened, in **zero-based** screen cells. */
export interface MousePoint {
    readonly column: number
    readonly row: number
}

export interface MouseInput {
    /**
     * Rows to move: negative up, positive down, zero for a report that is not the wheel.
     *
     * Zero is *not* "no report" — a click is a report with no scroll in it, and it still has to be
     * swallowed. The `undefined` return is what means "no report".
     */
    readonly rows: number
    /**
     * The last gesture in the chunk, and where it happened. `undefined` when nothing positional was in it.
     *
     * The *last* rather than every one, because a drag arrives as a stream of motion reports and only the
     * newest position matters — a selection follows the pointer, it does not retrace it. The wheel is the
     * exception and is summed instead, which is why `rows` is separate: a flick coalesces several notches
     * into one chunk and honouring only the last would move a single row.
     */
    readonly at?: MousePoint
    readonly kind?: MouseKind
    /** Held modifiers, from SGR's button bits. Shift is what extends a selection from a click. */
    readonly shift?: boolean
}

/**
 * What a chunk of input means to the mouse, or `undefined` if it holds no mouse report at all.
 *
 * Returning `undefined` rather than a zero is what keeps a keystroke a keystroke: every other branch of
 * the keymap runs only when this says nothing.
 */
export function mouseInput(input: string): MouseInput | undefined {
    // Cheap prefilter. Every report contains one of these two, and almost no keystroke does.
    if (!input.includes("[<") && !input.includes("[M")) return undefined
    let rows = 0
    let seen = false
    let at: MousePoint | undefined
    let kind: MouseKind | undefined
    let shift = false
    for (const match of input.matchAll(SGR)) {
        seen = true
        const button = Number(match[1])
        if (button === WHEEL_UP) {
            rows -= WHEEL_ROWS
            continue
        }
        if (button === WHEEL_DOWN) {
            rows += WHEEL_ROWS
            continue
        }
        // SGR reports 1-based cells; everything downstream indexes from zero, so the conversion happens
        // once, here, rather than at each of the callers that would each have to remember it.
        at = { column: Math.max(0, Number(match[2]) - 1), row: Math.max(0, Number(match[3]) - 1) }
        // `m` is a release whatever the button bits say. Motion is bit 5 (32); the low two bits are the
        // button, and only the left one starts a selection.
        kind = match[4] === "m" ? "release" : (button & MOTION) !== 0 ? "drag" : "press"
        shift = (button & SHIFT) !== 0
    }
    for (const match of input.matchAll(X10)) {
        seen = true
        // X10 offsets every field by 32, so the wheel's 64 and 65 arrive as 96 and 97.
        // Three fields follow `[M`, and the escape before it is optional — so the button is found
        // from the end of the match rather than at a fixed offset.
        const button = (match[0].codePointAt(match[0].length - 3) ?? 32) - 32
        if (button === WHEEL_UP) rows -= WHEEL_ROWS
        else if (button === WHEEL_DOWN) rows += WHEEL_ROWS
    }
    if (!seen) return undefined
    return {
        rows,
        ...(at === undefined ? {} : { at }),
        ...(kind === undefined ? {} : { kind }),
        ...(shift ? { shift } : {}),
    }
}
