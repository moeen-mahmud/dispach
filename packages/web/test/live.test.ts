/**
 * One stream per turn — the guard for the defect that made the browser unusable.
 *
 * A real session rendered its reply as `DoingDoingDoingDoing good good good…` and then repeated the
 * finished reply eight more times. The arithmetic named the cause before the source did: the first
 * block's reasoning was `1068` characters and every repeat was `178`, and **1068 = 178 × 6** — six
 * concurrent subscriptions appending the same stream into one accumulator, then eight later attaches
 * each replaying the turn and committing a clean copy of its own.
 *
 * The cause was a render-identity cascade in `app.tsx` (see `lib/live.ts`), and the fix has two
 * halves: memoise the facade so the effect stops re-firing, and refuse a second subscription so the
 * shape cannot come back. Only the second half is assertable without a DOM, which is the whole
 * reason it is a module — `packages/web/test` renders props to markup and mounts no effects, so a
 * guard written against the component could not have failed.
 */

import { expect, test } from "bun:test"
import { liveStream } from "../src/lib/live.ts"

test("a second begin for the same turn is refused", () => {
    const live = liveStream()
    const first = live.begin("t_1")
    expect(first).toBeDefined()
    // The assertion that matters. A caller handed `undefined` must not open a stream, which is what
    // makes six concurrent streams unreachable rather than merely unlikely.
    expect(live.begin("t_1")).toBeUndefined()
    expect(live.begin("t_1")).toBeUndefined()
    expect(live.following()).toBe("t_1")
    // And the first signal is still usable — refusing the duplicate must not have closed the one
    // that is legitimately running.
    expect(first?.aborted).toBe(false)
})

test("a different turn takes over, and closes the one it replaced", () => {
    const live = liveStream()
    const first = live.begin("t_1")
    const second = live.begin("t_2")
    expect(second).toBeDefined()
    // `send` during a reattached turn is the real case. Leaving the old stream running would be
    // two streams into one transcript, which is the state this module exists to make impossible.
    expect(first?.aborted).toBe(true)
    expect(second?.aborted).toBe(false)
    expect(live.following()).toBe("t_2")
})

test("a late finish from a replaced stream does not release the new one", () => {
    /**
     * The ordering that makes `finish` take an argument. An aborted stream's `finally` runs *after*
     * its replacement has claimed the slot — so a `finish` that cleared unconditionally would leave
     * the live stream unguarded and the next render free to open a second one.
     */
    const live = liveStream()
    live.begin("t_1")
    live.begin("t_2")
    live.finish("t_1")
    expect(live.following()).toBe("t_2")
    expect(live.begin("t_2")).toBeUndefined()
})

test("finish releases the slot for its owner, and is idempotent", () => {
    const live = liveStream()
    live.begin("t_1")
    live.finish("t_1")
    expect(live.following()).toBeUndefined()
    live.finish("t_1")
    expect(live.following()).toBeUndefined()
    // And the same turn may be followed again afterwards — a reattach after a completed turn is a
    // legitimate thing to do, so the refusal must be about concurrency and not about history.
    expect(live.begin("t_1")).toBeDefined()
})

test("abort closes the live stream, and does nothing when none is live", () => {
    const live = liveStream()
    // Safe on an empty slot: `openSession` calls this before it knows whether anything is running.
    expect(() => live.abort()).not.toThrow()
    const signal = live.begin("t_1")
    live.abort()
    expect(signal?.aborted).toBe(true)
    expect(live.aborted()).toBe(true)
})

test("an aborted stream is distinguishable from a failed one", () => {
    // The shell branches on this: an abort is the page hanging up on purpose — a session switch, an
    // agent switch, an unmount — and reporting it would put a transport error on screen for an
    // action the reader had just taken.
    const live = liveStream()
    const signal = live.begin("t_1")
    expect(signal?.aborted).toBe(false)
    expect(live.aborted()).toBe(false)
    live.abort()
    expect(live.aborted()).toBe(true)
})
