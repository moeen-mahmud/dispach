/**
 * One stream per turn, and the abort that closes it.
 *
 * ## Why this is a module and not two refs in the component
 *
 * It was two refs in the component, and before that it was nothing at all — which is how the
 * browser came to run **six concurrent event streams for one turn**. `client.agent(id)` returns a
 * fresh object every call, the shell called it in its render body, and everything keyed on that
 * identity went with it: the reattach effect re-fired on every render with no cleanup, each stream's
 * `setState` committed a render, and each render opened another stream. Every one of them folded
 * into one transcript and one *mutable* token filter, so a real session rendered
 * `DoingDoingDoingDoing good good good…` and then the finished reply eight more times.
 *
 * Memoising the facade stops today's loop. It does not stop the *shape*: the next effect that gains
 * a dependency, a second `send`, or React's `StrictMode` double-invoke would each open a second
 * subscription into the same accumulator, and nothing would say so. The CLI has never had this
 * because `lib/source.ts` guards with `if (pump !== undefined) return` — a refusal that lives in one
 * place and is therefore checkable.
 *
 * So the bookkeeping lives here, out of the component, for the reason every reducer in this package
 * does: **the shell is where the untested code was.** `packages/web/test` renders props to markup
 * and never mounts an effect, so a guard written against the component could not have failed. This
 * one can, with no DOM.
 *
 * ## The contract
 *
 * `begin` is the gate: it answers with a signal for the caller to pass to `stream()`, or `undefined`
 * when that turn is already being followed. `finish` releases only if the caller still owns the
 * slot, so a late `finally` from an aborted stream cannot clear a newer one. `abort` closes whatever
 * is live — a session switch, an agent switch, an unmount — and is safe to call when nothing is.
 *
 * The abort matters separately from the guard. `AgentClient.stream` has accepted a `signal` since
 * the client was written and the shell passed none, so a stream outlived the conversation it
 * belonged to: switching sessions reset the transcript and left the old stream appending rows into
 * the new one. `handle.stop()` was never this — that cancels the *turn on the server*, which is a
 * different thing from hanging up.
 */

export interface LiveStream {
    /**
     * Claim the slot for `turnId`.
     *
     * Returns the signal to hand to `stream()`, or `undefined` if this turn is already being
     * followed — in which case the caller must not open a stream.
     */
    begin(turnId: string): AbortSignal | undefined
    /** Release the slot, if `turnId` still holds it. Idempotent. */
    finish(turnId: string): void
    /** Close the live stream. Idempotent, and safe when nothing is live. */
    abort(): void
    /** The turn currently being followed, for a caller that needs to ask. */
    following(): string | undefined
    /** Whether the live stream was aborted by us, so a caller can tell a cancel from a fault. */
    aborted(): boolean
}

export function liveStream(): LiveStream {
    let turn: string | undefined
    let controller: AbortController | undefined

    return {
        begin(turnId) {
            if (turn === turnId) return undefined
            // A different turn starting while one is live is a real case — `send` during a
            // reattached turn. The old one is closed rather than left running, because two streams
            // is the state this module exists to make impossible.
            controller?.abort()
            turn = turnId
            controller = new AbortController()
            return controller.signal
        },
        finish(turnId) {
            // Only the owner clears. An aborted stream's `finally` arrives *after* its replacement
            // has claimed the slot, and letting it clear would leave the new stream unguarded.
            if (turn !== turnId) return
            turn = undefined
            controller = undefined
        },
        abort() {
            controller?.abort()
        },
        following: () => turn,
        aborted: () => controller?.signal.aborted ?? false,
    }
}
