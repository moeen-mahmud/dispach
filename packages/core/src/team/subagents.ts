/**
 * Subagents: a routed tool call runs in a throwaway child of the same agent (pilot.6).
 *
 * The child is started by configuration, never by the model's judgement. The parent's call keeps its
 * spec, so the policy, the write gate and a stand-in's deferral have all decided by the time the
 * handler swapped in here runs: a refused call never starts a child.
 *
 * What the child inherits is decided by the caller (`Agent`), which owns the turn options; this module
 * only builds the task, runs it through `runHandoff`, and renders what the parent reads. That split
 * keeps the authority rules in one place, next to the turn they narrow.
 */

import { HarnessError } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { SubagentConfig } from "../manifest/schema.ts"
import type { HandoffStore } from "../store/store.ts"
import type { Tool, ToolContext, ToolParameters } from "../tools/types.ts"
import { type HandoffOutcome, type HandoffTarget, runHandoff } from "./handoff.ts"

/** What a child returns when its subagent declares no schema of its own. */
export const DEFAULT_SUBAGENT_ARTIFACT: ToolParameters = {
    type: "object",
    properties: {
        summary: {
            type: "string",
            description:
                "What the call returned, in a few sentences, with every figure that matters.",
        },
        findings: {
            type: "array",
            items: { type: "string" },
            description:
                "One entry per item worth acting on: ids, names, dates and links kept exact.",
        },
    },
    required: ["summary"],
}

/** The child's task: what it is for, then the one call it was handed, as the parent made it. */
export function subagentTask(
    child: SubagentConfig,
    slug: string,
    args: Readonly<Record<string, unknown>>,
    asked?: string,
): string {
    return [
        child.task,
        "",
        // What the call is for. Without it the child summarises blind, and a summary that drops the
        // one fact the person wanted is a smaller observation that answers nothing.
        ...(asked === undefined || asked === "" ? [] : ["## What the person asked", "", asked, ""]),
        "## The call to make",
        "",
        `Call \`${slug}\` with these arguments, then work from what it returns:`,
        "",
        JSON.stringify(args, null, 2),
    ].join("\n")
}

/** A child run, as the agent provides one: itself, with the child's options closed over. */
export type SubagentRunner = (
    child: SubagentConfig,
    context: ToolContext,
) => HandoffTarget & {
    readonly tainted: () => boolean
    /** The parent turn's input, so the child knows what the call is for. */
    readonly asked?: string
}

/**
 * The routed version of `tool`: same spec, a handler that runs `child` instead.
 *
 * `trustOf` reports the child's taint rather than the spec's, because the parent reads the child's
 * artifact, not the tool's output: a child that only ever saw trusted text returns trusted text. It
 * can only lower trust (`execute.ts`), so a spec declared `untrusted` stays untrusted regardless.
 */
export function routedTool(init: {
    readonly tool: Tool
    readonly child: SubagentConfig
    readonly runner: SubagentRunner
    readonly bus: EventBus
    readonly store?: HandoffStore
}): Tool {
    const { tool, child } = init
    // Keyed by the args object, which the executor hands to the handler and then to `trustOf`.
    const taint = new WeakMap<object, boolean>()
    return {
        spec: tool.spec,
        trustOf: (args) => (taint.get(args) === true ? "untrusted" : "trusted"),
        async handler(args, context) {
            const target = init.runner(child, context)
            const outcome = await runHandoff({
                member: target,
                task: subagentTask(child, tool.spec.slug, args, target.asked),
                artifact:
                    (child.artifact as ToolParameters | undefined) ?? DEFAULT_SUBAGENT_ARTIFACT,
                bus: init.bus,
                ...(init.store === undefined ? {} : { store: init.store }),
                eventContext: {
                    agentId: context.agentId,
                    sessionKey: context.sessionKey,
                    turnId: context.turnId,
                },
                signal: context.signal,
                sessionPrefix: "subagent",
                source: "subagent",
                kind: "self",
                name: child.name,
                ...(context.callId === undefined ? {} : { callId: context.callId }),
                ...(context.actingParticipant ? { participant: context.actingParticipant } : {}),
            })
            // Recorded whatever the outcome: a failed child's prose can carry what it read too.
            taint.set(args, target.tainted())
            if (outcome.kind === "ok") {
                return [
                    `${tool.spec.slug} ran in subagent ${child.name}, which returned:`,
                    JSON.stringify(outcome.artifact, null, 2),
                ].join("\n")
            }
            throw subagentFailure(child.name, tool.spec.slug, outcome)
        },
    }
}

/**
 * What the parent reads when its child came back without an artifact. Thrown, so it is a failed call
 * the model can work with, and every message names a terminal action rather than reading as transient.
 */
function subagentFailure(
    name: string,
    slug: string,
    outcome: Exclude<HandoffOutcome, { kind: "ok" }>,
): HarnessError {
    const where = `The subagent's transcript is in session ${outcome.cost.sessionKey}.`
    if (outcome.kind === "no_artifact") {
        const said = outcome.text.trim() === "" ? "(it said nothing)" : outcome.text.trim()
        return new HarnessError({
            code: "subagent_no_artifact",
            message: `${slug} ran in subagent ${name}, which finished without an answer. It said: ${said}`,
            hint: `Calling ${slug} again with the same arguments will end the same way. Change the arguments if what it said shows they were wrong; otherwise tell the person what it said. ${where}`,
        })
    }
    if (outcome.kind === "budget") {
        return new HarnessError({
            code: "subagent_budget",
            message: `${slug} ran in subagent ${name}, which stopped before finishing (${outcome.reason}) after ${outcome.cost.steps} steps.`,
            hint: `Ask for less in one call (a narrower query, fewer items), or tell the person the result was too large. ${where}`,
        })
    }
    return new HarnessError({
        code: "subagent_error",
        message: `${slug} ran in subagent ${name}, which failed: ${outcome.error.message}`,
        hint: `This is a fault, not a refusal: do not call ${slug} again for this. Report what you were trying to do. ${where}`,
    })
}
