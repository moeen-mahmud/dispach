/**
 * `ask_agent`: a free-form question to another agent the same person owns (decision 15.9,
 * `docs/24-SPEC-PEER-ASK.md`).
 *
 * `handoff` is typed — the target declares an artifact schema — and "what is milo working on" has
 * none. An ask returns the peer's reply as text. Everything else is the delegation envelope: a fresh
 * session per ask, the `handoffs` row (`kind = 'ask'`), and one hop, because the asked turn carries
 * `peerAsk`, which removes `handoff` and `ask_agent` from it (`Agent.#send`). That is why there is no
 * cycle walk over peer edges: A and B asking each other is two asks, never a loop.
 *
 * A remote peer (another silo, through the control plane's relay) is the same `HandoffTarget`
 * shape, so sending is identical; `peer.remote` is read only to refuse a non-owner turn and to say
 * where the transcript is.
 */

import { HarnessError } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import { newHandoffId, newRunId } from "../loop/ids.ts"
import type { HandoffStore } from "../store/store.ts"
import type { Tool } from "../tools/types.ts"
import type { HandoffTarget } from "./handoff.ts"

export const ASK_AGENT = "ask_agent"

/** Prefix of an asked turn's session. Left untouched by `resolveSessionKey`, like a handoff's. */
export const ASK_SESSION_PREFIX = "ask"

export interface AskPeer {
    /** A local agent id, or `<silo>/<agent>` for a remote one. */
    readonly id: string
    readonly name?: string
    readonly description?: string
    /** Assigned to nobody: answers from its projects, not from anybody's private memory. */
    readonly shared: boolean
    /** In another silo, reached through the control plane. */
    readonly remote: boolean
    readonly target: HandoffTarget
}

/** The member's own limits stopping it, mirrored from `handoff.ts`. */
const BUDGET_REASONS: ReadonlySet<string> = new Set([
    "max_steps",
    "timeout",
    "no_progress",
    "truncated",
    "stopped",
])

/**
 * How far under the harness's own timeout the asked turn is stopped. The harness *abandons* a
 * handler rather than killing it, so an ask racing it would leave the peer's turn running with
 * nothing waiting for the answer. Stopped first, a local peer's partial reply comes back as `budget`;
 * a remote ask is abandoned instead (an `error`), and the turn in the other silo runs to its end.
 */
const DEADLINE_MARGIN_MS = 5_000

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

function rosterLine(peer: AskPeer): string {
    const label = peer.name === undefined ? peer.id : `${peer.id} (${oneLine(peer.name)})`
    const notes = [
        peer.remote ? "in another silo" : undefined,
        peer.shared ? "shared, answers from its projects" : undefined,
    ].filter((note) => note !== undefined)
    const about = peer.description === undefined ? "" : `: ${oneLine(peer.description)}`
    return `- ${label}${about}${notes.length === 0 ? "" : ` [${notes.join("; ")}]`}`
}

export function askAgentTool(init: {
    readonly peers: readonly AskPeer[]
    readonly bus: EventBus
    readonly store?: HandoffStore
    /**
     * Whether this turn acts for the agent's owner. A remote ask is relayed as the owner in the other
     * silo, so a stranger's turn must not reach one (`24-SPEC-PEER-ASK.md`). The control plane checks
     * the participant again; this is the only check of who the turn acts for: control checks that the owner's participant is linked.
     */
    readonly actsForOwner?: (
        participant: import("../loop/sender.ts").ActingParticipant | null,
    ) => Promise<boolean>
}): Tool {
    const byId = new Map(init.peers.map((peer) => [peer.id, peer]))
    const roster = init.peers.map(rosterLine).join("\n")

    return {
        spec: {
            slug: ASK_AGENT,
            provider: "team",
            summary:
                "Asks another agent that works for the same person a question and returns its answer.",
            whenToUse:
                "the answer is something another of the person's agents knows or can find out — its own work, its notes, its tools — and you cannot check it yourself",
            whenNotToUse:
                "you can answer from your own context or tools, or the person is asking you to do the work yourself. The peer starts with no history of this conversation and cannot ask you anything back",
            // A tainted turn cannot call it under `onMutate: refuse`, which is what stops untrusted
            // text steering a sibling's whole catalogue.
            mutating: true,
            tags: ["write", "team"],
            policyArg: "peer",
            parameters: {
                type: "object",
                properties: {
                    peer: {
                        type: "string",
                        description: `Which agent to ask:\n${roster}`,
                        enum: init.peers.map((peer) => peer.id),
                    },
                    question: {
                        type: "string",
                        description:
                            "The whole question, as one block of text. It is ALL the other agent sees: none of this conversation, no earlier answers. Write out any detail it needs.",
                    },
                },
                required: ["peer", "question"],
            },
        },
        async handler(args, context) {
            const id = typeof args.peer === "string" ? args.peer.trim() : ""
            const peer = byId.get(id)
            if (peer === undefined) {
                throw new HarnessError({
                    code: "peer_unknown",
                    message: `No peer called "${id}".`,
                    hint: `This agent can ask: ${[...byId.keys()].join(", ")}.`,
                    field: "peer",
                })
            }
            if (
                peer.remote &&
                !(await (init.actsForOwner?.(context.actingParticipant ?? null) ?? false))
            ) {
                throw new HarnessError({
                    code: "peer_owner_only",
                    message: `${peer.id} is in another silo, and only the person this agent works for can ask there.`,
                    hint: "A remote ask is relayed as that person, so it is not available on a turn acting for anybody else. Answer from what you have here, or ask one of the agents in this silo.",
                    field: "peer",
                })
            }
            const question = typeof args.question === "string" ? args.question.trim() : ""
            if (question === "") {
                throw new HarnessError({
                    code: "peer_question_required",
                    message: "An ask needs a question.",
                    hint: "The other agent sees nothing of this conversation, so the question has to carry everything it needs.",
                    field: "question",
                })
            }

            const askId = newHandoffId()
            const sessionKey = `${ASK_SESSION_PREFIX}:${newRunId()}`
            const eventContext = {
                agentId: context.agentId,
                sessionKey: context.sessionKey,
                turnId: context.turnId,
            }
            const now = context.now
            init.bus.emit(
                "peer.ask",
                {
                    askId,
                    peer: peer.id,
                    remote: peer.remote,
                    sessionKey,
                    ...(context.callId === undefined ? {} : { callId: context.callId }),
                },
                eventContext,
            )
            await init.store?.start({
                handoffId: askId,
                agentId: context.agentId,
                sessionKey: context.sessionKey,
                turnId: context.turnId,
                memberId: peer.id,
                memberSession: sessionKey,
                task: question,
                startedAt: now().toISOString(),
                kind: "ask",
            })

            type Outcome = "ok" | "budget" | "error"
            const finish = async (
                outcome: Outcome,
                cost: { steps: number; prompt: number; output: number },
                error?: { code: string; message: string },
            ) => {
                init.bus.emit(
                    "peer.answer",
                    {
                        askId,
                        peer: peer.id,
                        sessionKey,
                        outcome,
                        steps: cost.steps,
                        tokens: { prompt: cost.prompt, output: cost.output },
                        ...(error === undefined ? {} : { errorCode: error.code }),
                    },
                    eventContext,
                )
                await init.store?.finish(askId, {
                    outcome,
                    ...(error === undefined
                        ? {}
                        : { errorCode: error.code, errorMessage: error.message }),
                    steps: cost.steps,
                    promptTokens: cost.prompt,
                    outputTokens: cost.output,
                    endedAt: now().toISOString(),
                })
            }
            const where = `Their transcript is in session ${sessionKey}${peer.remote ? " in their silo" : ""}.`

            const signal = AbortSignal.any([
                context.signal,
                AbortSignal.timeout(Math.max(1_000, context.deadlineMs - DEADLINE_MARGIN_MS)),
            ])
            let result: Awaited<ReturnType<HandoffTarget["send"]>>
            try {
                result = await peer.target.send(question, {
                    sessionKey,
                    source: "ask",
                    signal,
                    // The person this turn acts for. An ask from the owner's turn reads as the owner's
                    // own ask on the other side; a shared agent sees who asked.
                    ...(context.actingParticipant === undefined ||
                    context.actingParticipant === null
                        ? {}
                        : { participant: context.actingParticipant }),
                    peerAsk: { askedBy: context.agentId },
                })
            } catch (error) {
                const failure = {
                    code: error instanceof HarnessError ? error.code : "peer_ask_failed",
                    message: error instanceof Error ? error.message : String(error),
                }
                await finish("error", { steps: 0, prompt: 0, output: 0 }, failure)
                throw new HarnessError({
                    code: "peer_ask_failed",
                    message: `${peer.id} could not be asked: ${failure.message}`,
                    hint: `This is a fault reaching them, not an answer. Say what you were trying to find out and that ${peer.id} could not be reached. ${where}`,
                })
            }

            const cost = {
                steps: result.steps,
                prompt: result.tokens.prompt,
                output: result.tokens.output,
            }
            if (result.error !== undefined) {
                await finish("error", cost, result.error)
                // A refusal by the control plane's relay (a rate limit, an unlinked person) is not the
                // peer failing, and its own hint says what to do — "try again in 20 s" — where the
                // generic advice below would tell the model never to retry.
                const relayed = result.error.code.startsWith("relay_")
                throw new HarnessError({
                    code: "peer_ask_failed",
                    message: relayed
                        ? `${peer.id} could not be reached: ${result.error.message}`
                        : `${peer.id} failed: ${result.error.message}`,
                    hint: relayed
                        ? result.error.hint
                        : `This is a fault on their side. Do not ask again with the same question — report what you were trying to find out and that it failed. ${where}`,
                })
            }
            const said = result.text.trim() === "" ? "(they said nothing)" : result.text.trim()
            if (BUDGET_REASONS.has(result.reason)) {
                await finish("budget", cost)
                return [
                    `${peer.id} ran out of room (${result.reason}) and answered only in part:`,
                    said,
                    "",
                    `(${where})`,
                ].join("\n")
            }
            await finish("ok", cost)
            return [
                peer.shared
                    ? `Answer from ${peer.id}, a shared agent:`
                    : `Answer from ${peer.id}, an agent working for the same person:`,
                said,
                "",
                `(${cost.steps} step${cost.steps === 1 ? "" : "s"}, ${where})`,
            ].join("\n")
        },
    }
}
