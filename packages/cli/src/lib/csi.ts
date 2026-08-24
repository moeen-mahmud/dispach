/**
 * Reading a modifier off the bytes, because Ink's reading of it is lossy.
 *
 * ## The defect this exists for
 *
 * Warp sends `cmd+left` as `CSI 1;9D` — modifier 9, which decodes to the super bit — and **omits the
 * event-type field**. Ink's kitty branch for special keys requires that field (its regex demands a
 * `:<event>` group), so the sequence falls through to its legacy branch, which does:
 *
 *     key.meta = key.meta || !!(modifier & 10)
 *
 * `10` is `alt | super`. With modifier 8 that is `8 & 10 === 8`, truthy — so **super arrives as meta**,
 * and `cmd+left` becomes indistinguishable from `option+left` before our keymap is called at all.
 * Reported from a real session: both chords navigated by word, which is the only symptom this can have.
 *
 * Negotiating `reportEventTypes` was supposed to avoid this by making Warp include the field. It does not
 * — measured by the symptom, not assumed — and a fix that depends on a terminal populating an optional
 * field is a fix that works on some terminals. So the modifier is decoded here, from the bytes, where it
 * is unambiguous: bit 8 is super whether or not an event type follows it.
 *
 * ## Why this is not a second parser
 *
 * It reads *one* field. Key identity still comes from Ink — `leftArrow`, `home`, `input` — and this only
 * overrides the four modifier flags, and only when a sequence was actually found and matched to the key
 * Ink reported. Anything unrecognised leaves the key exactly as it arrived, so the worst case is today's
 * behaviour rather than a new class of wrong.
 */

import type { KeyState } from "#lib/types"

/** Modifier bits, per the xterm and kitty encodings: the wire value is `1 + these`. */
const SHIFT = 1
const ALT = 2
const CTRL = 4
const SUPER = 8

/** One modified key found in a chunk. `final` identifies the key for CSI forms, `param` for `u`. */
export interface CsiKey {
    readonly modifier: number
    readonly final: string
    /** The first parameter: a key number for `~` forms, a codepoint for `u`, else 1. */
    readonly param: number
    readonly eventType: "press" | "repeat" | "release" | undefined
}

/**
 * Every modified key in a chunk, oldest first.
 *
 * Matches `CSI <param> ; <modifier> [: <event>] <final>`, which covers the arrows (`A`-`D`), Home and End
 * (`H`/`F`), the tilde forms (`1~` `3~` `4~` `5~` `6~` `7~` `8~`) and kitty's letter form (`u`) in one
 * expression, because they differ only in the final byte. A sequence with no modifier parameter is skipped
 * — there is nothing to correct on an unmodified key. The leading escape is not required: Ink strips one
 * from the front of a chunk before a handler sees it, the same reason `lib/mouse.ts` anchors instead.
 */
export function csiKeys(chunk: string): readonly CsiKey[] {
    const found: CsiKey[] = []
    const pattern = /\[(\d+);(\d+)(?::(\d+))?([A-Za-z~])/g
    for (const match of chunk.matchAll(pattern)) {
        const param = Number(match[1])
        const modifier = Number(match[2])
        const event = match[3]
        const final = match[4] ?? ""
        if (!Number.isFinite(param) || !Number.isFinite(modifier) || modifier < 1) continue
        found.push({
            modifier,
            final,
            param,
            eventType:
                event === undefined
                    ? undefined
                    : event === "3"
                      ? "release"
                      : event === "2"
                        ? "repeat"
                        : "press",
        })
    }
    return found
}

/**
 * A terminal *reply*, not a keystroke: `CSI ? <flags> u`.
 *
 * Ink asks the terminal for its kitty-keyboard flags at mount, waits 200 ms, and strips the answer out of
 * stdin if one arrives in time. Measured in a real Warp session: it arrived **late**, the window had
 * closed, and the bytes fell through to `useInput` as ordinary text — `input "[?0u"`, resolving to an
 * insert. Left unclaimed that types `[?0u` into somebody's first message, which is the same class of
 * defect as a mouse report reaching the buffer and is claimed here for the same reason.
 *
 * Deliberately narrow. Only this one reply is recognised, because it is the only one this runtime *asks*
 * for — and the finals it would be tempting to generalise to are dangerous: `CSI 1;2R` is a real modified
 * F3 key, so claiming `R` would swallow a keystroke to catch a reply nobody requested.
 */
export function isTerminalReply(input: string): boolean {
    // The optional escape is stripped by code point rather than matched in the pattern: a control
    // character written into a regex is invisible in the source, which is a lint error for good reason —
    // `lib/keys-view.ts` draws the same line for the same reason.
    const body = input.codePointAt(0) === 0x1b ? input.slice(1) : input
    return /^\[\?\d*u$/.test(body)
}

/** Which Ink flag a CSI final byte identifies, so a record can be matched to the key Ink reported. */
function identifies(record: CsiKey, key: KeyState, input: string): boolean {
    switch (record.final) {
        case "A":
            return key.upArrow
        case "B":
            return key.downArrow
        case "C":
            return key.rightArrow
        case "D":
            return key.leftArrow
        case "H":
            return key.home
        case "F":
            return key.end
        case "~":
            switch (record.param) {
                case 1:
                case 7:
                    return key.home
                case 3:
                    return key.delete
                case 4:
                case 8:
                    return key.end
                case 5:
                    return key.pageUp
                case 6:
                    return key.pageDown
                default:
                    return false
            }
        case "u":
            // Kitty's letter form. Ink already decodes these correctly, so matching them is only about
            // not consuming a record that belongs to a later keystroke.
            if (record.param === 13) return key.return
            if (record.param === 127) return key.backspace
            if (record.param === 27) return key.escape
            return input !== "" && input === String.fromCodePoint(record.param).toLowerCase()
        default:
            return false
    }
}

/**
 * The key Ink reported, with its modifiers taken from the bytes when they can be.
 *
 * `records` is consumed: the matched entry is removed, so two keys in one chunk stay in step. Matching by
 * identity rather than by position is what makes that safe — a record that does not correspond to the key
 * Ink is reporting is left in the queue for whichever keystroke it belongs to, instead of being applied to
 * this one.
 */
export function withRealModifiers(key: KeyState, input: string, records: CsiKey[]): KeyState {
    const at = records.findIndex((record) => identifies(record, key, input))
    if (at === -1) return key
    const [record] = records.splice(at, 1)
    if (record === undefined) return key
    const bits = record.modifier - 1
    return {
        ...key,
        shift: (bits & SHIFT) !== 0,
        // `meta` is Alt/Option only. This is the whole correction: Ink merges super into it and we do not.
        meta: (bits & ALT) !== 0,
        ctrl: (bits & CTRL) !== 0,
        super: (bits & SUPER) !== 0,
        ...(record.eventType === undefined ? {} : { eventType: record.eventType }),
    }
}
