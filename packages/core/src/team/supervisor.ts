/**
 * The supervisor's side: one tool, and what the model reads when a delegation does not work.
 *
 * ## Why `handoff` is one tool with a `member` argument, not one tool per member
 *
 * `handoff_researcher`, `handoff_writer` reads like the more explicit design and is the two-hop
 * shape decision 4.7 refuses from the other direction: it puts the choice in the *slug*, so the
 * catalogue grows with the team and a phase can only allow or deny whole members by name. One tool
 * with an enum'd argument means the model makes one decision, the guidance for every member is in
 * one place where they can be compared, and `policyArg: "member"` makes
 * `deny handoff(researcher)` expressible — which is the granularity a person actually wants.
 *
 * ## Why it is `mutating: true`, and what that costs
 *
 * A member can write files and run `exec`; `mutating` is the field that says a call has
 * consequences, and this one has whatever consequences its member has. Two things follow, one
 * wanted and one paid for. Wanted: **a handoff is never retried.** Re-running a delegation that
 * half-completed would repeat the member's side effects, and `mutating` is what suppresses the
 * retry. Paid for: `batch()` puts every mutating call alone in its group, so two handoffs in one
 * step run **sequentially** — a supervisor fanning out to three members takes three times one
 * member's latency.
 *
 * That cost was weighed rather than discovered. Declaring `handoff` parallel-safe would buy the
 * fan-out and assert something false: two members are separate agents but share a filesystem,
 * `tools.providerConfig.writeRoots` can overlap, and `exec` is bound by no root at all — so
 * concurrent handoffs can interleave writes to one file, which surfaces as corrupted output rather
 * than as a concurrency bug. Stated here, in the README, and in the spec, because a latency
 * property nobody wrote down is one somebody reports as a hang.
 */

import { HarnessError } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { TeamMemberConfig } from "../manifest/schema.ts"
import type { HandoffStore } from "../store/store.ts"
import type { Tool, ToolParameters } from "../tools/types.ts"
import { describeArtifact } from "./artifact.ts"
import { type HandoffTarget, runHandoff } from "./handoff.ts"

export const HANDOFF = "handoff"

/**
 * How deep a delegation chain may go, and it is not configurable.
 *
 * Two hops: a supervisor delegates to a member, and that member may delegate once more. A third
 * level is refused **at load**, walking the manifest graph, for the same reason a cron expression is
 * parsed by `validate` rather than only by the scheduler — a limit enforced at runtime is a limit
 * somebody discovers when their agent stops halfway through a task it reported starting.
 *
 * No manifest field, because there is no evidence anybody needs three and every level multiplies
 * the worst-case spend of one turn. When somebody does, it gets a field and a number in `evals/`.
 */
export const MAX_TEAM_DEPTH = 2

/** A member, resolved: its declaration plus the agent that runs it. */
export interface ResolvedMember {
    readonly config: TeamMemberConfig
    readonly agent: HandoffTarget
}

/**
 * Walk the team graph and refuse a cycle or an over-deep chain, by name.
 *
 * Load-time rather than runtime, and that is the whole reason it is cheap: the graph is entirely
 * static — every edge is a `team.members[].manifest` path — so `A → B → A` is visible in the
 * manifests without anybody running a turn. Threading a chain through `AgentSendOptions` and
 * `ToolContext` to catch it at the third hop would be more machinery answering the same question
 * later and worse.
 *
 * `chain` is the path taken to reach `id`, oldest first, so the refusal can print it.
 */
export function checkTeamGraph(
    id: string,
    membersOf: (agentId: string) => readonly string[],
    chain: readonly string[] = [],
): void {
    if (chain.includes(id)) {
        throw new HarnessError({
            code: "team_cycle",
            message: `Delegation cycle: ${[...chain, id].join(" → ")}.`,
            hint: "An agent cannot appear twice in one chain, directly or through another member — the chain would spend a turn's budget per lap. Point the repeated member at a different agent, or drop its own team block.",
            field: "team.members",
        })
    }
    const next = [...chain, id]
    if (next.length > MAX_TEAM_DEPTH + 1) {
        throw new HarnessError({
            code: "team_too_deep",
            message: `Delegation chain is ${next.length - 1} levels deep: ${next.join(" → ")}.`,
            hint: `At most ${MAX_TEAM_DEPTH} levels. Each one multiplies the worst-case cost of a single turn, and there is no manifest field to raise it. Flatten the team: give the top supervisor the deepest member directly.`,
            field: "team.members",
        })
    }
    for (const member of membersOf(id)) checkTeamGraph(member, membersOf, next)
}

/**
 * The supervisor's delegation tool.
 *
 * Registered at **load**, not per turn: a team is fixed for an agent's lifetime, so slot 1 renders
 * it once and stays byte-stable. (`phase_set` is per-turn because the *current phase* it names
 * changes mid-turn; nothing here does.)
 */
export function handoffTool(init: {
    readonly members: readonly ResolvedMember[]
    readonly bus: EventBus
    /** The supervisor's own store, for the envelope. Closed over because `ToolContext` has none. */
    readonly store?: HandoffStore
}): Tool {
    const byId = new Map(init.members.map((member) => [member.config.id, member]))
    // Collapsed, because a manifest's `task:` is usually a folded YAML scalar (`>`) and folding
    // leaves newlines and a trailing space inside the value. Unhandled, that put a line break in
    // the middle of a tool summary and broke the `tools` listing's columns — visible only by
    // running the command, not by reading the manifest.
    const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
    const roster = init.members
        .map(
            (member) =>
                `- ${member.config.id}: ${oneLine(member.config.task)} Returns ${describeArtifact(
                    member.config.artifact as ToolParameters,
                )}.`,
        )
        .join("\n")

    return {
        spec: {
            slug: HANDOFF,
            provider: "team",
            // One line, and the roster is **not** here. A summary is rendered into a table by the
            // `tools` command, so a newline in it breaks that listing's columns — and the roster
            // belongs beside the field it fills in anyway, which is the rule this repo records for
            // every path-taking argument: next to the field, not in a preamble, because that is
            // where a small model looks.
            summary:
                "Delegates one self-contained task to a member of your team and returns their finished answer.",
            whenToUse:
                "a task matches one member's description and can be handed over in a single instruction — they cannot ask you follow-up questions, so include everything they need",
            // Aimed at two measured failures. A narrow-phase agent reads "more tools elsewhere" as
            // an instruction to move (the `eval:phases` restraint regression), and the same shape
            // applies here: a roster of capable members reads as a reason to delegate. And one
            // member at a time is a latency property a model should know about before it writes
            // three calls into one step.
            whenNotToUse:
                "you can answer yourself, the task needs a back-and-forth, or you only need part of what a member does. Members run one at a time, so three handoffs in one step take three times as long as one",
            mutating: true,
            tags: ["write", "team"],
            // So `deny handoff(researcher)` is expressible. A batch argument would be invisible to
            // the policy engine — the same hole `COMPOSIO_MULTI_EXECUTE_TOOL` is not shipped for.
            policyArg: "member",
            parameters: {
                type: "object",
                properties: {
                    member: {
                        type: "string",
                        description: `Which member to delegate to:\n${roster}`,
                        enum: init.members.map((member) => member.config.id),
                    },
                    task: {
                        type: "string",
                        // Blunt about being the *only* channel, because the first live run failed
                        // here: having read that the writer returns a paragraph, the supervisor
                        // tried `handoff` with a `Claims` field carrying the researcher's artifact
                        // — reasonable, and not a field this tool has, so the call failed its one
                        // repair and took the turn with it. There are two arguments and nothing
                        // said that. Describing the field rather than showing a literal, per the
                        // measured rule that a placeholder in an example is read as an instruction.
                        description:
                            "Everything the member gets, as one block of text. This is the ONLY channel: there is no other argument, they start with no history, and they cannot ask you anything. If a previous member's answer is needed, write its values out here in full — do not refer to it.",
                    },
                },
                required: ["member", "task"],
            },
        },
        async handler(args, context) {
            const id = typeof args.member === "string" ? args.member.trim() : ""
            const member = byId.get(id)
            if (member === undefined) {
                // Thrown rather than returned: an unknown member is the model naming something that
                // does not exist, which `coerceArgs`' enum should already have caught — so reaching
                // here means the catalogue and this map disagree, and that is a fault rather than an
                // outcome the supervisor should reason about.
                throw new HarnessError({
                    code: "team_member_unknown",
                    message: `No team member called "${id}".`,
                    hint: `This team has: ${[...byId.keys()].join(", ")}.`,
                    field: "member",
                })
            }
            const task = typeof args.task === "string" ? args.task.trim() : ""
            if (task === "") {
                throw new HarnessError({
                    code: "team_task_required",
                    message: "A handoff needs a task.",
                    hint: "The member starts with no history and cannot ask follow-up questions, so the task has to carry everything it needs.",
                    field: "task",
                })
            }

            const outcome = await runHandoff({
                member: member.agent,
                task,
                artifact: member.config.artifact as ToolParameters,
                bus: init.bus,
                ...(init.store === undefined ? {} : { store: init.store }),
                eventContext: {
                    agentId: context.agentId,
                    sessionKey: context.sessionKey,
                    turnId: context.turnId,
                },
                signal: context.signal,
            })

            if (outcome.kind === "ok") {
                // The artifact, and **not** the member's prose or transcript. This string is the
                // supervisor's whole view of the work, which is the token property the phase exists
                // for — and the session key is here so "what did it actually say" has an answer
                // without the transcript being in the prompt.
                return [
                    `${id} returned:`,
                    JSON.stringify(outcome.artifact, null, 2),
                    "",
                    `(${outcome.cost.steps} step${outcome.cost.steps === 1 ? "" : "s"}, ${outcome.cost.promptTokens} prompt + ${outcome.cost.outputTokens} output tokens, transcript in session ${outcome.cost.sessionKey})`,
                ].join("\n")
            }

            throw handoffFailure(id, outcome)
        },
    }
}

/**
 * What the supervisor reads when a delegation did not produce an artifact.
 *
 * Thrown so the loop renders it as a failed `ToolResult` the model can work with, which is decision
 * 4.26's rule — a refused tool is information, and throwing past the loop would kill the
 * supervisor's turn over a member's difficulty.
 *
 * Every message names a **terminal action**, because the observed failure mode of a truthful
 * refusal with no alternative is a retry storm: `memory_write` once returned an honest "NOT SAVED"
 * and a real model retried until the step budget ran out. So none of these reads as transient.
 */
function handoffFailure(
    id: string,
    outcome: Extract<
        Awaited<ReturnType<typeof runHandoff>>,
        { kind: "no_artifact" | "budget" | "error" }
    >,
): HarnessError {
    const where = `Their transcript is in session ${outcome.cost.sessionKey}.`

    if (outcome.kind === "no_artifact") {
        const said = outcome.text.trim() === "" ? "(they said nothing)" : outcome.text.trim()
        return new HarnessError({
            code: "handoff_no_artifact",
            message: `${id} finished without returning an answer. They said: ${said}`,
            hint: `Usually the task was missing something they needed. Re-read what they said, then either hand it over again with the missing detail filled in, or do the work yourself. Handing over the same task unchanged will end the same way. ${where}`,
        })
    }
    if (outcome.kind === "budget") {
        return new HarnessError({
            code: "handoff_budget",
            message: `${id} ran out of room before finishing (${outcome.reason}) after ${outcome.cost.steps} steps.`,
            hint: `The task was too large for one delegation. Split it into smaller pieces and hand those over one at a time, or do it yourself — the same task again will stop at the same place. ${where}`,
        })
    }
    return new HarnessError({
        code: "handoff_error",
        message: `${id} failed: ${outcome.error.message}`,
        hint: `This is a fault on their side, not a task they declined. Do not hand it over again — say what you were trying to do and report the failure. ${where}`,
    })
}
