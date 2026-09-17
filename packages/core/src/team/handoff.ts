/**
 * Running one delegation, and reporting honestly when it does not work.
 *
 * A handoff is a *turn on another agent*, in its own session, whose answer comes back as a
 * validated artifact and whose transcript does not come back at all. That last clause is the whole
 * feature (decision 10.2): the supervisor's context grows by the size of the artifact rather than
 * by the size of the work, which is why sub-agents cost fewer parent tokens than doing the same
 * thing in one conversation.
 *
 * ## Four outcomes, and there is deliberately no fifth for "the artifact was invalid"
 *
 * The plan asked for a schema violation to be "a typed failure the supervisor can handle, not an
 * exception", and the shape that delivers it is narrower than a separate outcome. Validation
 * happens at the `submit_artifact` *call*, inside the member's own turn, through `coerceArgs` — so a
 * bad shape is a `FieldError` observation the member reads and gets exactly one repair for, which
 * is the loop's existing rule rather than a retry policy invented here. If it still cannot submit,
 * the member's turn ends having said why in prose, and that is `no_artifact` carrying its reply.
 *
 * Which is strictly more useful than an `invalid` outcome would have been: `{kind: "invalid",
 * errors: [...]}` tells the supervisor which field was wrong, and the member's own sentence tells it
 * *why the field could not be filled* — usually that the task was underspecified, which is the
 * thing the supervisor can actually act on.
 *
 * ## Cost is reported, never estimated
 *
 * `promptTokens` and `outputTokens` come off the member's `TurnResult`, which carries the
 * endpoint's own figures where the endpoint reported them. The evals comparison this phase owes
 * (`evals/handoff/`) is about *parent* tokens, and those are measured on the supervisor's side —
 * but a supervisor that could not see what a delegation cost would make "is this cheaper" a
 * question nobody could answer per-call.
 */

import type { ErrorDetail } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { EventContext } from "../events/types.ts"
import { newHandoffId, newRunId } from "../loop/ids.ts"
import type { HandoffStore } from "../store/store.ts"
import type { ToolParameters } from "../tools/types.ts"
import { type ArtifactSink, submitArtifactTool, taskWithReturnChannel } from "./artifact.ts"

/** The minimum of `Agent` a handoff needs, so this module does not import the runtime. */
export interface HandoffTarget {
    readonly id: string
    send(
        input: string,
        options: {
            readonly sessionKey?: string
            readonly source?: string
            readonly signal?: AbortSignal
            readonly turnTools?: readonly import("../tools/types.ts").Tool[]
        },
    ): Promise<{
        readonly text: string
        readonly reason: string
        readonly steps: number
        /** `TurnResult.tokens` — nested, because that is the shape the loop already reports. */
        readonly tokens: { readonly prompt: number; readonly output: number }
        readonly error?: ErrorDetail | undefined
    }>
}

export type HandoffOutcome =
    | {
          readonly kind: "ok"
          readonly artifact: Readonly<Record<string, unknown>>
          readonly cost: HandoffCost
      }
    /**
     * The member finished without submitting. `text` is its own explanation.
     *
     * Covers a schema it could not satisfy, a task it judged impossible, and a member that simply
     * narrated instead of calling the tool. One outcome, because the member's sentence distinguishes
     * them better than a code would.
     */
    | { readonly kind: "no_artifact"; readonly text: string; readonly cost: HandoffCost }
    /** The member's own `limits` stopped it: steps, timeout, or no progress. */
    | {
          readonly kind: "budget"
          readonly reason: string
          readonly text: string
          readonly cost: HandoffCost
      }
    /** The member's turn failed. `error` is its own, unchanged. */
    | {
          readonly kind: "error"
          readonly error: ErrorDetail
          readonly cost: HandoffCost
      }

export interface HandoffCost {
    readonly steps: number
    readonly promptTokens: number
    readonly outputTokens: number
    /** Where the member's transcript is, so "what did it actually say" has an answer. */
    readonly sessionKey: string
}

/** Every way a member's turn can end that is not the work being done. */
const BUDGET_REASONS: ReadonlySet<string> = new Set([
    "max_steps",
    "timeout",
    "no_progress",
    "truncated",
    "stopped",
])

/**
 * Delegate one task and come back with an artifact or a reason.
 *
 * The member's session is **fresh per handoff** (`handoff:<runId>`), which is what makes isolation
 * structural rather than careful: there is no history to leak because there is no history. It is
 * also why the session key is reported — a supervisor that got a `no_artifact` and could not go
 * read the member's transcript would be debugging blind, and this repo has a recorded rule about
 * good information in a place nobody looks.
 */
export async function runHandoff(init: {
    readonly member: HandoffTarget
    readonly task: string
    readonly artifact: ToolParameters
    readonly bus: EventBus
    readonly eventContext: EventContext
    /**
     * The envelope's durable record. Optional so this function is unit-testable without a database,
     * and supplied on every real path — `handoffTool` closes over the supervisor's own store.
     */
    readonly store?: HandoffStore
    readonly now?: () => Date
    readonly signal?: AbortSignal
}): Promise<HandoffOutcome> {
    const now = init.now ?? (() => new Date())
    const handoffId = newHandoffId()
    const sessionKey = `handoff:${newRunId()}`
    const sink: ArtifactSink = { artifact: undefined }

    init.bus.emit(
        "handoff.start",
        { member: init.member.id, task: init.task, sessionKey },
        init.eventContext,
    )

    // Written `running` **before** the member starts, for the reason a turn row is: a crash
    // mid-delegation then leaves a durable record that one was in flight, which is the difference
    // between "the supervisor died during a handoff" and "the supervisor never delegated".
    await init.store?.start({
        handoffId,
        agentId: init.eventContext.agentId ?? "",
        sessionKey: init.eventContext.sessionKey ?? "",
        turnId: init.eventContext.turnId ?? "",
        memberId: init.member.id,
        memberSession: sessionKey,
        // The supervisor's own words, not the augmented prompt: the row records what was asked,
        // and the return-channel boilerplate is the runtime's framing rather than part of the task.
        task: init.task,
        startedAt: now().toISOString(),
    })

    const finish = async (outcome: HandoffOutcome): Promise<HandoffOutcome> => {
        init.bus.emit(
            "handoff.result",
            {
                member: init.member.id,
                sessionKey,
                outcome: outcome.kind,
                steps: outcome.cost.steps,
                tokens: {
                    prompt: outcome.cost.promptTokens,
                    output: outcome.cost.outputTokens,
                },
                ...(outcome.kind === "error" ? { errorCode: outcome.error.code } : {}),
            },
            init.eventContext,
        )
        await init.store?.finish(handoffId, {
            outcome: outcome.kind,
            // JSON on the row, so the artifact is queryable as text and a reader does not have to
            // reconstruct it from the supervisor's observation.
            ...(outcome.kind === "ok" ? { artifact: JSON.stringify(outcome.artifact) } : {}),
            ...(outcome.kind === "error"
                ? { errorCode: outcome.error.code, errorMessage: outcome.error.message }
                : {}),
            steps: outcome.cost.steps,
            promptTokens: outcome.cost.promptTokens,
            outputTokens: outcome.cost.outputTokens,
            endedAt: now().toISOString(),
        })
        return outcome
    }

    let result: Awaited<ReturnType<HandoffTarget["send"]>>
    try {
        // The task **plus** the return channel. A turn tool is not in slot 1 by design, so a member
        // handed only `init.task` has `submit_artifact` and no idea it exists — measured live,
        // three handoffs in a row, the member's own reasoning reading "No tool needed. Just reply."
        result = await init.member.send(taskWithReturnChannel(init.task, init.artifact), {
            sessionKey,
            // Its own source, not `"api"` or the supervisor's. A member's turns are a different kind
            // of thing from a person's and every surface reading `turns.source` should be able to
            // tell them apart without joining against the handoffs table.
            source: "handoff",
            ...(init.signal === undefined ? {} : { signal: init.signal }),
            turnTools: [
                submitArtifactTool({
                    parameters: init.artifact,
                    sink,
                    memberId: init.member.id,
                }),
            ],
        })
    } catch (error) {
        // A throw from `send` is the member failing to *start* — a bad manifest reaching the model
        // layer, a store error. Reported rather than propagated, because a supervisor whose
        // delegation threw would lose its own turn over a member's fault.
        return await finish({
            kind: "error",
            error: {
                code: "handoff_failed",
                message: `${init.member.id} could not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                hint: `Run the member on its own to see the fault: it is a normal agent, so \`validate\` and \`run\` work against its manifest. Its transcript for this attempt is session ${sessionKey}.`,
            },
            cost: { steps: 0, promptTokens: 0, outputTokens: 0, sessionKey },
        })
    }

    const cost: HandoffCost = {
        steps: result.steps,
        promptTokens: result.tokens.prompt,
        outputTokens: result.tokens.output,
        sessionKey,
    }

    if (result.error !== undefined)
        return await finish({ kind: "error", error: result.error, cost })

    // Budget checked **before** the artifact, and the order matters: a member stopped at its step
    // limit may have submitted something on the way, and reporting that as a clean `ok` would hide
    // that the work was cut short. An artifact from an incomplete run is not the artifact that was
    // asked for.
    if (BUDGET_REASONS.has(result.reason)) {
        return await finish({ kind: "budget", reason: result.reason, text: result.text, cost })
    }

    if (sink.artifact === undefined) {
        return await finish({ kind: "no_artifact", text: result.text, cost })
    }

    return await finish({ kind: "ok", artifact: sink.artifact, cost })
}
