/**
 * The key probe: press a chord, see what arrived.
 *
 * A *view* in this repo's sense — it owns its single `useInput` and reports through `onDone`, and never
 * mounts itself or calls `useApp().exit()`. The host command owns the screen.
 *
 * It deliberately claims every key including `^C`, because the whole point is to show what a chord does:
 * a probe that exited on the chord you wanted to inspect would be unable to inspect it. `q` leaves, and
 * the footer says so.
 */

import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { EMPTY_EDITOR } from "#editor"
import { keyContext, keyToIntent } from "#keymap"
import { type Keystroke, keystrokeRows, protocolVerdict } from "#lib/keys-view"
import { headingRule } from "#lib/rows"
import { THEME } from "#lib/theme"
import type { KeyState } from "#lib/types"

const KEEP = 6

/**
 * A monotonic id per press, because two presses of the same key are two rows.
 *
 * An array index would key row 0 to whatever is currently oldest, so evicting the top of the window
 * re-keys every row below it and React reconciles the wrong nodes. Held outside the component: it counts
 * *events*, and a remount starting over is fine because the list starts over with it.
 */
let pressed = 0

/** A keystroke plus the sequence number that keys its row. */
interface Recorded extends Keystroke {
    readonly at: number
}

export interface KeyProbeProps {
    readonly columns: number
    /** Whether this process asked the terminal for the protocol, which the verdict needs to be honest. */
    readonly asked: boolean
    readonly terminal: string
    /**
     * The next unread stdin chunk, or `undefined`.
     *
     * Injected rather than read here for the usual reason — a component that attached its own stdin
     * listener would have to care about registration order relative to Ink's, which is the host's
     * business. `undefined` is a real answer: it means nothing was queued, and the row says so.
     */
    readonly takeRaw?: () => string | undefined
    /**
     * The same modifier correction the chat applies.
     *
     * Without it the probe would report Ink's raw reading and the chat would act on a corrected one, so a
     * chord could show `meta` here and resolve as a cmd chord there — a diagnostic disagreeing with the
     * thing it is diagnosing, which is worse than no diagnostic.
     */
    readonly correctKeys?: (key: KeyState, input: string) => KeyState
    readonly onDone: () => void
}

export function KeyProbe({
    columns,
    asked,
    terminal,
    takeRaw,
    correctKeys,
    onDone,
}: KeyProbeProps) {
    const [seen, setSeen] = useState<readonly Recorded[]>([])

    useInput((input, reported) => {
        const raw = takeRaw?.()
        const inkState = reported as KeyState
        const state = correctKeys === undefined ? inkState : correctKeys(inkState, input)
        // `q` on its own leaves. Every other key — ^C included — is recorded rather than acted on, which
        // is the one place in this CLI where ^C must not cancel: a probe that exits on the chord being
        // probed cannot report it.
        if (input === "q" && !state.ctrl && !state.meta && !state.super) {
            onDone()
            return
        }
        const intent = keyToIntent(input, state, keyContext(EMPTY_EDITOR, false))
        pressed += 1
        const at = pressed
        // The tapped chunk when there is one, and `input` as the fallback — which is right for the test
        // harness, where there is no real stdin to tap and `input` *is* what arrived.
        const bytes = raw ?? input
        setSeen((current) => [...current, { at, bytes, input, key: state, intent }].slice(-KEEP))
    })

    return (
        <Box flexDirection="column">
            <Text color={THEME.accent} bold wrap="truncate">
                key probe · {terminal}
            </Text>
            <Text color={THEME.muted} wrap="truncate">
                protocol {protocolVerdict(seen, asked)}
            </Text>
            <Text> </Text>
            {seen.length === 0 ? (
                <Text color={THEME.muted} wrap="truncate">
                    press any chord — the bytes, Ink's reading of them, and the resolved intent
                </Text>
            ) : null}
            {seen.map((stroke) => (
                <Box key={`stroke-${stroke.at}`} flexDirection="column">
                    <Text color={THEME.border} wrap="truncate">
                        {headingRule("", columns)}
                    </Text>
                    {keystrokeRows(stroke).map((row) => (
                        <Text key={row} wrap="truncate">
                            {row}
                        </Text>
                    ))}
                </Box>
            ))}
            <Text> </Text>
            <Text dimColor wrap="truncate">
                {"  q leaves · every other key is recorded, ^C included"}
            </Text>
        </Box>
    )
}
