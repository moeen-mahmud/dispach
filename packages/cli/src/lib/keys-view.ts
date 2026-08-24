/**
 * What a keystroke actually was, rendered for a person to paste into a bug report.
 *
 * ## Why this exists
 *
 * CLAUDE.md's rule is that a key chord is verified against a real terminal and never against the parser,
 * and for ten rounds of TUI work there was no way to do that: the only instrument was Ink reporting *a*
 * key, which says nothing about the bytes a terminal sent. So `⌥r` was documented, bound, handled, and
 * silently arriving as the composed character `®`, and every round diagnosed it by guessing.
 *
 * A probe ends that. It prints the bytes, Ink's reading of them, and the intent this repo's own keymap
 * resolved — three layers, so a failure names which one is wrong instead of leaving three suspects.
 *
 * Pure, so every line of it is asserted without a terminal. The component around it does nothing but
 * mount a `useInput` and hand what arrives to these functions.
 */

import type { Intent, KeyState } from "#lib/types"

/** One keystroke, as all three layers saw it. */
export interface Keystroke {
    /**
     * What the terminal actually wrote, tapped off stdin.
     *
     * Distinct from `input` because for a special key they differ completely: `CSI 1;9:1D` reaches a
     * handler as `input: ""` with flags set, so a probe reporting only `input` prints an empty byte row
     * for every arrow, Home, and cmd chord — the exact keys worth probing. Measured under a pty, not
     * reasoned about.
     */
    readonly bytes: string
    /** What Ink handed the handler. Empty for a special key, which is itself the point. */
    readonly input: string
    readonly key: KeyState
    readonly intent: Intent
}

/**
 * The bytes, in hex, as UTF-8 — which is what the terminal actually wrote.
 *
 * Not `charCodeAt`: that reports UTF-16 code units, so a composed `®` or an emoji would print a number
 * no terminal ever sent. The point of a byte probe is the bytes.
 */
export function hexOf(text: string): string {
    return [...new TextEncoder().encode(text)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ")
}

/** The modifier and key flags Ink set, named. Empty when it set none, which is itself information. */
export function flagsOf(key: KeyState): string {
    const named: string[] = []
    if (key.ctrl) named.push("ctrl")
    if (key.meta) named.push("meta")
    if (key.super) named.push("super")
    if (key.shift) named.push("shift")
    for (const [name, held] of [
        ["up", key.upArrow],
        ["down", key.downArrow],
        ["left", key.leftArrow],
        ["right", key.rightArrow],
        ["pageUp", key.pageUp],
        ["pageDown", key.pageDown],
        ["home", key.home],
        ["end", key.end],
        ["return", key.return],
        ["escape", key.escape],
        ["tab", key.tab],
        ["backspace", key.backspace],
        ["delete", key.delete],
    ] as const) {
        if (held) named.push(name)
    }
    if (key.eventType !== undefined && key.eventType !== "press") named.push(key.eventType)
    return named.length === 0 ? "—" : named.join(" ")
}

/**
 * Whether the keystroke is evidence that the kitty protocol negotiated.
 *
 * Ink does not expose whether its handshake succeeded, and asking the terminal a second time from here
 * would be a different question than the one Ink asked. So this reports *evidence* rather than a claim:
 * `super` cannot be expressed without the protocol, and an `eventType` only arrives under
 * `reportEventTypes`. Either one proves it is on. Neither one appearing proves nothing either way, which
 * the verdict below says in as many words rather than defaulting to "off".
 */
export function provesProtocol(key: KeyState): boolean {
    return key.super || key.eventType !== undefined
}

/** What can honestly be said about the protocol, given what has been pressed so far. */
export function protocolVerdict(seen: readonly Keystroke[], asked: boolean): string {
    if (!asked) return "not requested — the override is set, so cmd chords cannot arrive"
    if (seen.some((stroke) => provesProtocol(stroke.key))) {
        return "active — a keystroke carried a modifier only the protocol can express"
    }
    return "requested; nothing pressed yet has proved it — try cmd+left, or option+r"
}

/** One keystroke as three labelled lines, deepest layer last. */
export function keystrokeRows(stroke: Keystroke): readonly string[] {
    // Code points rather than a character-class regex: a control character written into a regex is a
    // lint error for a good reason (it is invisible in the source), and `printableOnly` in `keymap.ts`
    // already draws this line the same way.
    const printable = [...stroke.bytes]
        .map((char) => {
            const code = char.codePointAt(0) ?? 0
            return code < 0x20 || code === 0x7f ? "." : char
        })
        .join("")
    return [
        `bytes   ${hexOf(stroke.bytes)}${printable === "" ? "" : `   ${printable}`}`,
        `ink     ${flagsOf(stroke.key)}${stroke.input === "" ? "" : `   input ${JSON.stringify(stroke.input)}`}`,
        `intent  ${stroke.intent.kind}`,
    ]
}
