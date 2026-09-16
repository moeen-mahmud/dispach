/**
 * Approvals over the wire.
 *
 * `ToolContext.approve` has existed since Phase 3 and nothing ever filled it, so
 * `tools.untrusted.onMutate: "confirm"` was unreachable and a `tools.policy` rule with `ask` fell
 * through to `onNoApprover`. This is the filling: a registry that turns "ask a person" into an
 * event plus one POST, so the person can be anywhere the API is.
 *
 * ## Why not WebSocket
 *
 * The obvious shape for a two-way question is a socket, and `/v1/ws` answers `501` under Node,
 * which has no upgrade path without a dependency. A capability half the supported runtimes cannot
 * reach is not a capability. So the request goes out on the stream every reader already has —
 * emitted by **core**, so the CLI and an audit log see it too — and the answer comes back as an
 * ordinary POST. Nothing here needs a socket in either direction.
 *
 * ## Why pending approvals are listable
 *
 * `GET /v1/agents/:id/approvals` exists for the same reason turn reattach does: a browser refresh
 * must not lose the question. Without it, a client that missed the event — opened after the turn
 * blocked, reconnected, was a second operator — has a turn that has visibly stopped and no way to
 * discover why. The listing is the recovery path, and it is the difference between approvals being
 * usable from a UI and being usable from one long-lived curl.
 *
 * ## What it deliberately does not do
 *
 * No persistence. A pending approval lives in this process's memory and dies with it, and that is
 * correct rather than lazy: the promise it resolves is a suspended turn in *this* process, so a row
 * surviving a restart would describe a question nobody is still waiting on — answerable, with
 * nothing to resume. A restart abandons the turn, which the `abandoned` outcome already says.
 *
 * No timeout of its own. The turn's `limits.turnTimeoutMs` bounds the wait, and core races the
 * approver against the turn's signal — so an unanswered question ends with the turn rather than on
 * a second clock. Two deadlines racing each other is a recorded bug in this repo (a tool that
 * outlives the harness leaves a process with nothing referencing it), and this is the same shape.
 */

import type { ApprovalRequest } from "@dispach/core"

/** A question waiting on somebody, as a reader of the listing sees it. */
export interface PendingApproval {
    readonly approvalId: string
    readonly slug: string
    readonly callId: string
    readonly match: string | undefined
    readonly mutating: boolean
    readonly reason: string
    /** RFC 3339. How long it has been waiting is the thing a person triaging a queue wants. */
    readonly requestedAt: string
}

export interface ApprovalRegistry {
    /**
     * Pass this to `Runtime.create({ approve })`.
     *
     * Bound rather than a method so the caller cannot detach it from the registry by accident —
     * `approve: registry.approver` would otherwise lose `this` and fail at the first question,
     * which is a runtime error in the one code path nobody exercises until somebody needs it.
     */
    readonly approver: (request: ApprovalRequest) => Promise<boolean>
    /** Oldest first, which is the order a queue should be worked. */
    pending(): readonly PendingApproval[]
    /**
     * Answer one. `false` when no such approval is waiting — already answered, abandoned with its
     * turn, or never existed. The caller turns that into the wire's `404`.
     */
    resolve(approvalId: string, granted: boolean): boolean
    /** How many are waiting. For the readiness/introspection surfaces. */
    readonly size: number
}

export function createApprovalRegistry(
    options: { readonly now?: () => Date } = {},
): ApprovalRegistry {
    const now = options.now ?? (() => new Date())

    interface Entry {
        readonly pending: PendingApproval
        readonly settle: (granted: boolean) => void
    }

    const waiting = new Map<string, Entry>()

    const approver = (request: ApprovalRequest): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
            const entry: Entry = {
                pending: {
                    approvalId: request.approvalId,
                    slug: request.slug,
                    callId: request.callId,
                    match: request.match,
                    mutating: request.mutating,
                    reason: request.reason,
                    requestedAt: now().toISOString(),
                },
                settle: (granted) => {
                    // Deleted before resolving, so an approver that is somehow re-entered cannot
                    // see an entry it has already answered.
                    waiting.delete(request.approvalId)
                    resolve(granted)
                },
            }
            waiting.set(request.approvalId, entry)

            // The courtesy half of `ApprovalRequest.signal`. Core already races this signal and
            // denies when it wins, so the turn ends correctly whether or not this listener exists —
            // what it buys is that the entry leaves the map instead of sitting in a listing forever
            // as a question nobody is waiting on. A UI polling `pending()` would otherwise show an
            // abandoned prompt indefinitely and get a `404` for answering it.
            //
            // `once`, and it resolves rather than rejects: a rejection here would surface as the
            // `error` outcome, which means "the approver is broken" and would be a lie about a turn
            // that was simply stopped.
            request.signal.addEventListener("abort", () => entry.settle(false), { once: true })
        })

    return {
        approver,
        pending: () =>
            [...waiting.values()]
                .map((entry) => entry.pending)
                .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
        resolve: (approvalId, granted) => {
            const entry = waiting.get(approvalId)
            if (entry === undefined) return false
            entry.settle(granted)
            return true
        },
        get size() {
            return waiting.size
        },
    }
}
