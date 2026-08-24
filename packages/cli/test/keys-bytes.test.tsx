/**
 * Chords, verified against the bytes a terminal actually sends.
 *
 * CLAUDE.md's rule is that a key chord is verified against a real terminal and never against the parser —
 * and until this file existed nothing in the repo did that. `test/helpers/frame.tsx` defined `metaLeft`,
 * `metaRight`, `csiMetaLeft`, `csiMetaRight` and `metaBackspace`, and **no test used any of them**: every
 * chord assertion built a `KeyState` by hand and handed it straight to `keyToIntent`, which proves the
 * switch and nothing about whether Ink reports what the switch is matching on.
 *
 * So this mounts a real `useInput` behind the harness's fake stdin, writes the escape sequence, and asserts
 * the `Intent` that came out the far end — Ink's parser included. It is the far-end test the "a field
 * threaded through a pipeline needs one test at the *end* of it" rule asks for, applied to the keyboard.
 *
 * Ink parses `CSI u` unconditionally; only *negotiation* is opt-in. So these bytes are read correctly here
 * with no `kittyKeyboard` option in the harness, which is what makes the test hermetic — it measures the
 * parser and the keymap, not a terminal handshake.
 */

import { describe, expect, test } from "bun:test"
import { Text, useInput } from "ink"
import { createElement as h } from "react"
import { applyIntent, EMPTY_EDITOR } from "#editor"
import { keyContext, keyToIntent } from "#keymap"
import { csiKeys, withRealModifiers } from "#lib/csi"
import type { EditorState, Intent, KeyState } from "#lib/types"
import { KEY, mount } from "./helpers/frame.tsx"

function Probe({
    onIntent,
    editor,
    correct,
}: {
    onIntent: (i: Intent) => void
    editor: EditorState
    correct?: (key: KeyState, input: string) => KeyState
}) {
    useInput((input, reported) => {
        const key =
            correct === undefined ? (reported as KeyState) : correct(reported as KeyState, input)
        onIntent(keyToIntent(input, key, keyContext(editor, false)))
    })
    return h(Text, null, "probe")
}

/** Press one byte sequence and return every intent it produced. One press, so usually exactly one. */
async function press(sequence: string, editor: EditorState = EMPTY_EDITOR): Promise<Intent[]> {
    const seen: Intent[] = []
    const harness = mount(h(Probe, { onIntent: (intent: Intent) => seen.push(intent), editor }), {
        columns: 80,
        rows: 24,
    })
    await harness.press(sequence)
    harness.unmount()
    return seen
}

/**
 * The same press, with the modifier correction the real session applies.
 *
 * The records are seeded from the sequence about to be written rather than tapped off the harness's
 * stdin, because a test cannot register a listener before `render` — `mount` creates the stream. That
 * ordering is guaranteed by the call site (`openTap` before `render` in `run.ts` and `keys.ts`) and proven
 * by driving the built binary under a pty; what is asserted here is the part with real logic in it, which
 * is bytes to records to modifiers to intent.
 */
async function pressCorrected(
    sequence: string,
    editor: EditorState = EMPTY_EDITOR,
): Promise<Intent[]> {
    const seen: Intent[] = []
    const records = [...csiKeys(sequence)]
    const harness = mount(
        h(Probe, {
            onIntent: (intent: Intent) => seen.push(intent),
            editor,
            correct: (key: KeyState, input: string) => withRealModifiers(key, input, records),
        }),
        { columns: 80, rows: 24 },
    )
    await harness.press(sequence)
    harness.unmount()
    return seen
}

const LINE = { ...EMPTY_EDITOR, value: "hello world", cursor: 6 }

describe("the bytes a terminal sends, through Ink, to an intent", () => {
    test("option chords in both legacy spellings", async () => {
        // The claim `keymap.ts` makes in its comment table, asserted against bytes for the first time.
        expect(await press(KEY.metaLeft, LINE)).toEqual([{ kind: "wordLeft" }])
        expect(await press(KEY.csiMetaLeft, LINE)).toEqual([{ kind: "wordLeft" }])
        expect(await press(KEY.metaRight, LINE)).toEqual([{ kind: "wordRight" }])
        expect(await press(KEY.csiMetaRight, LINE)).toEqual([{ kind: "wordRight" }])
        expect(await press(KEY.metaBackspace, LINE)).toEqual([{ kind: "killWord" }])
        expect(await press(KEY.metaEnter, LINE)).toEqual([{ kind: "newline" }])
    })

    test("option-r under the kitty protocol, which is the spelling that actually arrives", async () => {
        // The reported bug. Without the protocol Warp sends the composed character `®` for ⌥r, which is
        // printable and was therefore typed into the message; negotiated, it is `CSI 114;3u`.
        expect(await press(KEY.kittyMetaR, LINE)).toEqual([{ kind: "reasoning" }])
        // And the composed character really is an insert, which is what made this look like a dead key
        // rather than a misconfigured one.
        expect(await press("\u00ae", LINE)).toEqual([{ kind: "insert", text: "\u00ae" }])
    })

    test("command chords, which no legacy sequence can express", async () => {
        // `super` is bit 8, so the modifier is 9. Before the protocol these arrived as `meta` — Ink's
        // legacy branch folds super into it (`modifier & 10`) — and cmd+← word-moved like ⌥←.
        expect(await press(KEY.kittySuperLeft, LINE)).toEqual([{ kind: "cursorHome" }])
        expect(await press(KEY.kittySuperRight, LINE)).toEqual([{ kind: "cursorEnd" }])
        expect(await press(KEY.kittySuperUp, LINE)).toEqual([{ kind: "bufferStart" }])
        expect(await press(KEY.kittySuperDown, LINE)).toEqual([{ kind: "bufferEnd" }])
        expect(await press(KEY.kittySuperZ, LINE)).toEqual([{ kind: "undo" }])
    })

    test("ctrl with an arrow is the other spelling of a word move", async () => {
        expect(await press(KEY.kittyCtrlLeft, LINE)).toEqual([{ kind: "wordLeft" }])
        expect(await press(KEY.kittyCtrlRight, LINE)).toEqual([{ kind: "wordRight" }])
    })

    test("all four spellings of home and end", async () => {
        // Ink flags the CSI H/F pair as `key.home`/`key.end`; the tilde forms fall through to the raw
        // check. Both routes have to work, which is why there are two.
        for (const sequence of [KEY.home, KEY.homeTilde]) {
            expect(await press(sequence, LINE), sequence).toEqual([{ kind: "cursorHome" }])
        }
        for (const sequence of [KEY.end, KEY.endTilde]) {
            expect(await press(sequence, LINE), sequence).toEqual([{ kind: "cursorEnd" }])
        }
    })

    test("a key release does nothing at all", async () => {
        // `reportEventTypes` is on so `super` survives on an arrow key, and Ink passes the event type
        // through without filtering — so without the guard every enhanced chord fires twice, once down
        // and once up. A release must not reach the reducer even as a no-op intent that a caller acts on.
        expect(await press(KEY.kittyMetaRRelease, LINE)).toEqual([{ kind: "none" }])
    })
})

describe("the navigation table, from bytes all the way to a moved cursor", () => {
    // The intent is only half the claim: a chord that resolves correctly and then moves the wrong
    // distance still fails somebody's muscle memory. So each row is applied to a real buffer.
    //
    //                     "hello world\nsecond line"
    //  cursor 6 is the `w` of world, on the first line.
    const buffer: EditorState = { ...EMPTY_EDITOR, value: "hello world\nsecond line", cursor: 6 }

    const rows: readonly (readonly [string, Intent["kind"], number])[] = [
        [KEY.metaLeft, "wordLeft", 0],
        [KEY.csiMetaLeft, "wordLeft", 0],
        [KEY.metaRight, "wordRight", 11],
        [KEY.kittyCtrlLeft, "wordLeft", 0],
        [KEY.kittyCtrlRight, "wordRight", 11],
        [KEY.kittySuperLeft, "cursorHome", 0],
        [KEY.kittySuperRight, "cursorEnd", 11],
        [KEY.kittySuperUp, "bufferStart", 0],
        [KEY.kittySuperDown, "bufferEnd", 23],
        [KEY.home, "cursorHome", 0],
        [KEY.endTilde, "cursorEnd", 11],
        [KEY.left, "cursorLeft", 5],
        [KEY.right, "cursorRight", 7],
    ]

    for (const [sequence, kind, cursor] of rows) {
        test(`${kind} via ${JSON.stringify(sequence)} lands the cursor at ${cursor}`, async () => {
            const [intent, ...rest] = await press(sequence, buffer)
            expect(rest).toEqual([])
            expect(intent?.kind).toBe(kind)
            expect(applyIntent(buffer, intent ?? { kind: "none" }).cursor).toBe(cursor)
        })
    }

    test("cmd+backspace kills to the start of the line, not of the buffer", async () => {
        // The distinction the two pairs exist for: cmd with a horizontal arrow is the line, cmd with a
        // vertical one is the whole message — and `killToStart` follows the horizontal pair.
        // "hello world\nsecond line" — the newline is 11, "second" is 12-17, so 18 is the space after it.
        // Killing to the *line* start removes "second" and leaves the space; killing to the buffer start
        // would have taken the first line with it, which is the mistake the two pairs exist to prevent.
        const onSecondLine: EditorState = { ...buffer, cursor: 18 }
        const [intent] = await press(KEY.kittySuperBackspace, onSecondLine)
        expect(intent).toEqual({ kind: "killToStart" })
        expect(applyIntent(onSecondLine, intent ?? { kind: "none" }).value).toBe(
            "hello world\n line",
        )
    })
})

describe("the form Warp actually sends, which has no event type", () => {
    // The reported symptom: `cmd+←` and `⌥←` both navigated by word. Both are word-moves only if both
    // arrive as `meta`, and that is precisely what Ink's legacy branch does with `CSI 1;9D` — super is
    // bit 8 and the mask is `modifier & 10`. Negotiating `reportEventTypes` was supposed to make Warp
    // include the `:1` field and it does not, so the modifier is decoded from the bytes instead.
    test("uncorrected, cmd+left really is indistinguishable from option+left", async () => {
        // Asserted rather than assumed, because it is the premise of the fix: if Ink ever stops folding
        // super into meta this test fails, and the correction becomes redundant rather than wrong.
        expect(await press("\u001B[1;9D", LINE)).toEqual([{ kind: "wordLeft" }])
        expect(await press("\u001B[1;3D", LINE)).toEqual([{ kind: "wordLeft" }])
    })

    test("corrected, they are two different chords", async () => {
        expect(await pressCorrected("\u001B[1;9D", LINE)).toEqual([{ kind: "cursorHome" }])
        expect(await pressCorrected("\u001B[1;3D", LINE)).toEqual([{ kind: "wordLeft" }])
    })

    test("and the rest of the cmd set arrives too", async () => {
        expect(await pressCorrected("\u001B[1;9C", LINE)).toEqual([{ kind: "cursorEnd" }])
        expect(await pressCorrected("\u001B[1;9A", LINE)).toEqual([{ kind: "bufferStart" }])
        expect(await pressCorrected("\u001B[1;9B", LINE)).toEqual([{ kind: "bufferEnd" }])
    })

    test("ctrl+left stays a word move rather than becoming a cmd chord", async () => {
        expect(await pressCorrected("\u001B[1;5D", LINE)).toEqual([{ kind: "wordLeft" }])
    })
})

describe("what the terminal says back", () => {
    test("the protocol reply is swallowed rather than typed", async () => {
        // The bug this closes, from a real Warp session: `bytes 1b 5b 3f 30 75` / `intent insert`, which
        // would have put `[?0u` into somebody's first message. Ink strips the answer only while its
        // detection window is open, and Warp answered after it closed.
        expect(await press("\u001B[?0u", LINE)).toEqual([{ kind: "none" }])
        expect(await press("\u001B[?3u", LINE)).toEqual([{ kind: "none" }])
    })

    test("ctrl+o expands reasoning, needing neither the protocol nor a terminal setting", async () => {
        // ⌥r needs one or the other; a control byte needs neither, which is the point of having both.
        expect(await press(KEY.ctrl("o"), LINE)).toEqual([{ kind: "reasoning" }])
    })
})
