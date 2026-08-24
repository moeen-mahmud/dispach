/**
 * A read-only tap on stdin, opened before Ink attaches.
 *
 * ## Why a tap at all
 *
 * `useInput` cannot tell you what the terminal sent. Two independent things need that fact:
 *
 * 1. **Modifier correction.** Ink folds the super bit into `meta` on its legacy path, so `cmd+left` and
 *    `option+left` arrive as the same keystroke. `lib/csi.ts` decodes the modifier from the bytes; this is
 *    what gets the bytes to it.
 * 2. **The `keys` probe.** For a special key Ink reports `input: ""`, so a probe built on `input` printed
 *    an empty byte row for every arrow, Home and cmd chord — the exact keys worth probing.
 *
 * ## Why it is safe
 *
 * Two listeners on one `data` event both receive the chunk; this consumes nothing from Ink. Ordering is
 * registration order, which is why `openTap` has to be called **before** `render` — that is what
 * guarantees a chunk is parsed and queued by the time `useInput` fires for it. Opened by the host rather
 * than by a component for exactly that reason: a component cannot register before the renderer that mounts
 * it.
 *
 * The queue is drained by *identity*, not by position (`withRealModifiers`), so an unmatched record waits
 * for the keystroke it belongs to instead of being applied to the wrong one. A record nothing ever claims
 * is dropped once the queue passes `MAX_QUEUED`, which keeps a terminal that emits sequences we do not
 * recognise from growing an array for the life of the session.
 */

import { type CsiKey, csiKeys, withRealModifiers } from "#lib/csi"
import type { KeyState } from "#lib/types"

/**
 * How many unclaimed records to keep.
 *
 * Small on purpose: a keystroke is claimed by the very next `useInput`, so anything still queued after a
 * handful of presses was never going to be claimed. Bounded rather than cleared, because a burst of key
 * repeat legitimately queues several at once.
 */
const MAX_QUEUED = 16

export interface StdinTap {
    /** The key Ink reported, with its modifiers read off the wire where they could be. */
    correct(key: KeyState, input: string): KeyState
    /** The oldest unread chunk, for a probe that wants to print bytes. */
    takeRaw(): string | undefined
    close(): void
}

interface DataStream {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown
    off(event: "data", listener: (chunk: Buffer | string) => void): unknown
}

export function openTap(stdin: DataStream = process.stdin): StdinTap {
    const records: CsiKey[] = []
    const raw: string[] = []

    const listener = (chunk: Buffer | string): void => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
        raw.push(text)
        if (raw.length > MAX_QUEUED) raw.splice(0, raw.length - MAX_QUEUED)
        records.push(...csiKeys(text))
        if (records.length > MAX_QUEUED) records.splice(0, records.length - MAX_QUEUED)
    }

    stdin.on("data", listener)

    return {
        correct: (key: KeyState, input: string) => withRealModifiers(key, input, records),
        takeRaw: () => raw.shift(),
        close: () => {
            stdin.off("data", listener)
        },
    }
}
