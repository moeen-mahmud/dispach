/**
 * How a member returns its answer: as a tool call, not as prose.
 *
 * The obvious design is to ask the member for JSON in its reply and parse it. That design is
 * refuted by this repo's own measurements twice over. A model invents formats — three fresh
 * sessions produced `<action>`, `<TOOL_CALL>` and `<ACTION: glob>` inside an `<ebml>` element — and
 * a placeholder in a prompt example is read as an instruction, which is how a `field: value`
 * illustration became `value: <the value>` and scored NLT at 27% against native's 92%. Asking a
 * small model to emit a conforming JSON document as its reply is the same bet, with a second
 * extraction problem on top (fences, preamble, trailing prose).
 *
 * So the declared artifact schema **becomes a tool's parameter schema**. `submit_artifact` is
 * layered onto the member for the duration of one handoff, and from there:
 *
 * - the member's own dialect renders the fields, with types and descriptions, the way it renders
 *   every other tool — one mechanism, not two;
 * - `coerceArgs` validates and coerces, so `"3"` where a number is wanted is fixed rather than
 *   refused, and a missing required field is a `FieldError`;
 * - a malformed call earns exactly **one** repair, which is the loop's existing rule rather than a
 *   new retry policy invented here;
 * - the member's *reply* stays free prose, so nothing has to be stripped out of it.
 *
 * Zero new validation code, and "did it work?" is the boolean decision 10.3 asks for.
 *
 * ## Why the tool is per-handoff rather than per-member
 *
 * The schema is declared by the **supervisor**, in its `team` block, and the member's own manifest
 * knows nothing about it. Layering the tool per handoff (through `withTools`, the seam a
 * skill's script tools already use) keeps the member usable on its own, lets two supervisors ask
 * the same member for different shapes, and means the schema travels with the delegation instead of
 * being baked into an agent that has no opinion about it.
 */

import type { JsonSchemaNode, Tool, ToolParameters } from "../tools/types.ts"

export const SUBMIT_ARTIFACT = "submit_artifact"

/** Where a submitted artifact is left for the handoff runner to pick up. */
export interface ArtifactSink {
    /** Set by the tool's handler. `undefined` means the member never submitted one. */
    artifact: Readonly<Record<string, unknown>> | undefined
}

/**
 * The member's return channel, for one handoff.
 *
 * `mutating: false` — it records an answer and changes nothing in the world. Marking it true would
 * serialise it behind a write slot and suppress its retry for no gain, which is the same reasoning
 * `phase_set` carries.
 *
 * `trust: "trusted"` is left to the default: the *arguments* come from the member's own model, and
 * an argument is not an observation. Whatever untrusted content the member read on the way to
 * composing them has already gated its own writes inside the member's turn; re-fencing the result
 * here would put a warning about external content around the answer the supervisor asked for.
 */
export function submitArtifactTool(init: {
    readonly parameters: ToolParameters
    readonly sink: ArtifactSink
    /** The member's own id, so the guidance names the thing the model is being asked to finish. */
    readonly memberId: string
}): Tool {
    return {
        spec: {
            slug: SUBMIT_ARTIFACT,
            provider: "team",
            summary:
                "Returns your finished answer to the agent that delegated this task. Call it once, when the work is done.",
            // Both halves matter and the second is the measured one: a member that narrates instead
            // of submitting produces a `no_artifact` failure, which is indistinguishable to the
            // supervisor from a member that could not do the work.
            whenToUse:
                "you have finished the task you were given and can fill in every required field",
            whenNotToUse:
                "you are still working, or you cannot fill in a required field — say what is missing in your reply instead, and do not call this with a guess",
            mutating: false,
            tags: ["write", "team"],
            parameters: init.parameters,
        },
        async handler(args) {
            // Stored rather than returned: the runner reads the sink after the turn, because a
            // turn's `text` is the member's prose and the artifact is a different thing. Returning
            // it as the observation as well would put the whole artifact back into the member's own
            // context for any step that followed, which is the token cost delegation exists to avoid.
            init.sink.artifact = { ...args }
            return `Submitted. Your answer has been returned to the agent that delegated this task, and ${init.memberId} is done.`
        },
    }
}

/**
 * The task as the member receives it: the supervisor's instruction plus the return channel.
 *
 * **Found live, and the bug it fixes had no symptom in any unit test.** A turn tool is layered onto
 * the registry through `withTools`, and `ToolRuntime.blocks` — slot 1, the catalogue the model
 * reads — is rendered **once at load**. So `submit_artifact` was executable and *undocumented*: the
 * member had the tool and was never told it existed. Three real handoffs in a row came back
 * `no_artifact` with the member's own reasoning saying "No tool needed. Just reply." It was right
 * about what it could see.
 *
 * Every test passed because a scripted fixture model emits its `ACTION` block regardless of the
 * catalogue — the prompt was never the thing under test. `team.test.ts` now asserts the member's
 * prompt *mentions* the tool, which is the guard that would have caught it.
 *
 * **The first fix for this was wrong, and a real model said why in one run.** Putting the
 * description in the input alone — slot 11, past every cache breakpoint, which is where a per-turn
 * instruction belongs — left the tool absent from the catalogue, and the member reasoned:
 *
 *   "The tool is not listed? Wait tools listed: now only … We cannot call a tool not in available
 *    tools. 'Use only the tools listed below.'"
 *
 * It obeyed the catalogue, correctly, after several hundred reasoning tokens of deliberation. The
 * catalogue is authoritative because the NLT preamble says so, so a tool described anywhere else is
 * a contradiction rather than an instruction. `turnTools` therefore **re-renders** the catalogue
 * (see `withRenderedTools`), which is safe here for a specific reason and not a general one: a
 * handoff's session is fresh per delegation, so there is no cached prefix to protect — the cost
 * `skills/tools.ts` avoids for a *persisting* session does not exist here.
 *
 * This text stays, shortened, and now says "it is in your tool list" rather than introducing the
 * tool: the catalogue carries the schema, and this carries the obligation. A fact with no frame is
 * a fact a small model will not connect to a question.
 */
export function taskWithReturnChannel(task: string, parameters: ToolParameters): string {
    const required = new Set(parameters.required ?? [])
    const fields = Object.entries(parameters.properties).map(([name, node]) => {
        const node_ = node as JsonSchemaNode
        const type = node_.type === "array" ? `list of ${node_.items?.type ?? "value"}` : node_.type
        const note = node_.description === undefined ? "" : ` — ${node_.description}`
        return `- ${name} (${type})${required.has(name) ? ", required" : ", optional"}${note}`
    })
    return [
        task,
        "",
        "## How to return your answer",
        "",
        `When the work is done, call \`${SUBMIT_ARTIFACT}\` — it is in your tool list. Your reply on`,
        "its own does not reach the agent that asked; only this call does. Its fields:",
        "",
        ...fields,
        "",
        "If you genuinely cannot fill in a required field, do not guess: say in your reply what is",
        "missing, and stop.",
    ].join("\n")
}

/**
 * A description of the artifact's shape, for the supervisor's `handoff` guidance.
 *
 * One line per top-level field, so the supervisor knows what it is going to get back without the
 * whole schema being rendered into slot 1 twice — the member's catalogue already carries the full
 * version, and the supervisor only needs to know whether the shape fits what it is about to do.
 */
export function describeArtifact(parameters: ToolParameters): string {
    const required = new Set(parameters.required ?? [])
    const fields = Object.entries(parameters.properties).map(([name, node]) => {
        const node_ = node as JsonSchemaNode
        const type = node_.type === "array" ? `list of ${node_.items?.type ?? "value"}` : node_.type
        return `${name} (${type})${required.has(name) ? "" : ", optional"}`
    })
    return fields.length === 0 ? "an empty object" : fields.join("; ")
}
