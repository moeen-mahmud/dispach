/**
 * Whether this process asks the terminal for enhanced keys, and what it asks for.
 *
 * ## Why there is anything to ask for
 *
 * Ink 7.1 ships a complete kitty-keyboard-protocol parser — `parse-keypress.js` decodes `CSI u`, and
 * `Key` carries `super`, `hyper`, `home` and `end` — and **none of it runs unless a caller opts in**:
 *
 *     initKittyKeyboard() {
 *         // Protocol is opt-in: if kittyKeyboard is not specified, do nothing
 *         if (!this.options.kittyKeyboard) return
 *
 * That single `return` is why `⌥r` typed `®` into the message instead of unfolding the reasoning block,
 * and why `cmd+←` word-moved instead of jumping to the start of the line: without the protocol, `⌥`
 * depends on a terminal setting that is off by default in Warp, and `super` cannot be expressed by any
 * legacy escape sequence at all — Ink's legacy branch folds it into `meta` (`modifier & 10`, bit 8 being
 * super and bit 2 alt), so the two chords become the same keystroke.
 *
 * ## Why both flags
 *
 * `disambiguateEscapeCodes` alone fixes the letter chords: `⌥r` arrives as `CSI 114;3u`, which Ink reports
 * as `input "r"` with `meta` set — exactly the shape `keymap.ts` already matched, which is why turning
 * this on required no change to a single binding. It is **not** enough for `cmd+←`: an arrow with a
 * modifier comes back as `CSI 1;9D`, and Ink's kitty branch for special keys (`kittySpecialKeyRe`)
 * *requires* the `:eventType` field, so without `reportEventTypes` the sequence falls through to the
 * legacy path and the super bit is folded away again.
 *
 * The cost of that second flag is stated where it is paid: Ink passes `eventType` through untouched and
 * filters nothing, so `keymap.ts` drops `release` or every enhanced chord fires twice.
 *
 * ## Why `enabled` rather than `auto`, measured
 *
 * `auto` is the careful-looking option: Ink writes `CSI ? u`, waits **200 ms**, and enables only if the
 * terminal answers. It was the first choice here and it loses the race. In a real Warp session the reply
 * arrived *after* the window closed — visible in `keys` as `bytes 1b 5b 3f 30 75` resolving to an insert,
 * because Ink strips the answer only while it is still listening. So the protocol stayed **off** on a
 * terminal that plainly supports it, and every option-letter chord went on depending on Warp's
 * *Left/Right Option Key is Meta* setting, which is off by default. That is the reported bug, one layer
 * down from where it looked like it was.
 *
 * `enabled` pushes `CSI > flags u` without asking. The cost is bounded by how terminals treat private-mode
 * sequences they do not know — they discard them — and the pop on the way out is the same shape. It is
 * also no longer load-bearing: `lib/csi.ts` reads modifiers off the bytes, so a terminal that ignores the
 * push still gets working cmd chords. The protocol now buys the *letter* chords, and losing it silently
 * costs those rather than everything.
 *
 * The override stays for the case neither argument covers: a terminal that accepts the push and then
 * implements it badly. The reference CLI carries the same hatch (`CLAUDE_CODE_DISABLE_MOUSE`), and a
 * switch nobody can reach is not a hatch.
 */

import { readEnv } from "#lib/env"
/**
 * The render options fragment, shaped structurally rather than imported from Ink.
 *
 * Declared here for the same reason `KeyState` is declared in `lib/types.ts` rather than imported: this
 * module sits on a path every command touches, and Ink costs ~170-210 ms to load under Node — more than
 * the entire runtime of `validate --json`. TypeScript checks it structurally against `RenderOptions` at
 * each call site, so a drift in Ink's own type is still a compile error.
 */
import { markEnhancedKeys } from "#lib/exit"

export interface KeyboardOptions {
    readonly kittyKeyboard?: {
        readonly mode: "auto" | "enabled" | "disabled"
        /**
         * The property is readonly; the array is not, because Ink's own `flags` is a mutable
         * `KittyFlagName[]` and under `exactOptionalPropertyTypes` a `readonly` array does not satisfy
         * it. Nothing is shared as a result — `keyboardOptions` builds a fresh array on every call, which
         * is what makes the mutable type harmless rather than a hole.
         */
        readonly flags: ("disambiguateEscapeCodes" | "reportEventTypes")[]
    }
}

/**
 * One answer for every surface that mounts Ink, and the teardown registered with it.
 *
 * Every one of them reads keys, so a per-surface decision would mean the chat honoured `cmd+←` and the
 * settings editor did not — and the *next* surface would forget entirely. `inSession` on `CommandSpec` is
 * the same shape: derived once so a new caller cannot drift.
 *
 * It marks rather than merely returning, which is why it is not called `keyboardOptions`: asking for the
 * protocol and arranging to withdraw it are one decision, and six call sites each remembering to do the
 * second is six chances to leave a terminal reporting `CSI u` at somebody's shell. Ink withdraws it on
 * unmount by itself; the mark covers the signal path, which is the one Ink cannot see.
 */
export function negotiateKeyboard(disabled?: boolean): KeyboardOptions {
    // `??` rather than a default parameter: a default fires on an explicitly passed `undefined` too, and
    // this repo has already lost a debugging round to that (`load(dir, undefined)` used the runner it was
    // meant to omit). Written this way, "no opinion" and "not passed" are deliberately the same case.
    if (disabled ?? readEnv().noEnhancedKeys) return {}
    markEnhancedKeys()
    return {
        kittyKeyboard: {
            // Not "auto" — see above. Ink's 200 ms detection window loses the race in Warp, measured.
            mode: "enabled",
            flags: ["disambiguateEscapeCodes", "reportEventTypes"],
        },
    }
}
