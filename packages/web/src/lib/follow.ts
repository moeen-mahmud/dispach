/**
 * Whether the transcript follows its newest row, as a pure decision.
 *
 * The old `Tail` measured "am I at the bottom" *after* React had painted the new content, so the
 * moment a long reply pushed the anchor below the fold the measurement read false and the view
 * stopped following for the rest of the turn — the recorded `pinned` bug, in a browser. The flag is
 * owned by the reader's own scrolling: a scroll that ends within the tolerance re-pins, a scroll
 * away unpins, and content growth never changes it. `pinned` is a flag, not a comparison against the
 * bottom (CLAUDE.md), because the instant a row is appended the old offset *is* short of the bottom.
 */

export const FOLLOW_TOLERANCE_PX = 40

export interface Viewport {
    readonly scrollTop: number
    readonly scrollHeight: number
    readonly clientHeight: number
}

/** True when the viewport shows the bottom, within tolerance. */
export function atBottom(view: Viewport): boolean {
    return view.scrollHeight - view.scrollTop - view.clientHeight <= FOLLOW_TOLERANCE_PX
}

/**
 * The flag after a *user* scroll. Content growth does not call this; only a scroll event does, and
 * a scroll event the page itself caused (scrollIntoView) lands at the bottom and therefore re-pins,
 * which is the right answer for it too.
 */
export function afterUserScroll(view: Viewport): boolean {
    return atBottom(view)
}
