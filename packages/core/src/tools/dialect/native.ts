/**
 * The `native` dialect: the provider's `tools` parameter and `tool_calls` response.
 *
 * Opt-in, and it exists for two reasons. Frontier models show smaller or reversed gains from NLT
 * (decision 4.1), so an escape hatch that is not "fork the runtime" has to exist. And decision O.4
 * says whether native ever becomes the default is settled with eval data — which requires the two
 * dialects to be *runnable on the same fixtures*. A comparison against a dialect nobody implemented
 * would have been a comparison against an assumption.
 *
 * ## The description carries the same guidance as the NLT catalogue
 *
 * This is the load-bearing decision in this file. It would have been easy to set
 * `description: spec.summary` and be done: that is what most native integrations do, and the schema
 * is right there. It would also have quietly rigged every eval in this repo. NLT's catalogue entry
 * spends tokens on `Use when`, a mandatory `Do NOT use when`, and a state-change warning, and those
 * lines are most of why routing improves. Comparing prose-with-guidance against a bare one-line
 * summary would measure *the guidance*, then report the number as a property of the dialect.
 *
 * So the same four things reach the model either way, and only the channel differs — prose in the
 * context under NLT, `function.description` here. What remains measurable is what the comparison is
 * actually about: whether a model routes and fills arguments better when the protocol is text it
 * writes or a schema the API enforces.
 *
 * ## What genuinely differs, and why each difference is forced
 *
 * - **No context block.** The catalogue travels in the request, so slot 1 is empty and its cost is
 *   invisible to the context budget. `wireTokens` on the tool runtime is how the loop pays for it.
 * - **Nothing to filter from the stream.** A call is not text here, so the stream filter passes
 *   everything through and the CLI shows the prose exactly as it arrives.
 * - **Observations are `tool` messages, one per call.** Required, not stylistic: an endpoint rejects
 *   an assistant turn whose `tool_calls` were not each answered.
 * - **Arguments can be unreadable.** NLT's parser is tolerant by construction; a truncated JSON
 *   document is not, and it is reported as malformed rather than as an empty argument set.
 */

import { estimateTokens } from "../../context/tokens.ts"
import { nativeToolNameCollision, nativeToolNameInvalid } from "../../errors.ts"
import type { ChatMessage, ToolDefinition } from "../../model/provider.ts"
import { renderTrusted } from "../trust.ts"
import type { FieldError, ToolIntent, ToolSpec } from "../types.ts"
import {
    type ParsedOutput,
    passThroughFilter,
    type StepOutput,
    type ToolDialect,
} from "./dialect.ts"
import { renderNotEnabledBlock } from "./not-enabled.ts"

/**
 * The function-name grammar every OpenAI-compatible endpoint enforces.
 *
 * One rewrite is made, and only one: a dot becomes `__`, because skill scripts are named
 * `skill.<skill>.<script>` and they join the catalogue when their skill activates, so a native agent
 * loaded fine and failed on the first turn that picked a scripted skill (VelaCrew, pilot.4). The slug
 * is unchanged everywhere else (policy, events, the store); only the name on the wire differs.
 *
 * The way back needs no map. The model's reply names the wire form, and `ToolRegistry.resolve` finds
 * the slug through its normalised lookup, which ignores `.`, `_` and `-`. That lookup is exactly where
 * a rewrite would turn ambiguous (`a.b` and `a_b` are one normalised name), so `requestTools` refuses
 * a catalogue in which two slugs share one: the reason the rewrite was refused before, kept, but
 * checked rather than assumed. Anything else outside the grammar (a space, a slash) is still refused.
 */
const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** The name a slug is sent under. Exported for the transports' tests; nothing else should need it. */
export function wireName(slug: string): string {
    return slug.replaceAll(".", "__")
}

/** As `ToolRegistry`'s normalised lookup sees a name. Kept identical to it, or the check is a guess. */
function lookupKey(name: string): string {
    return name.toLowerCase().replace(/[\s_.-]+/g, "")
}

/** The guidance a catalogue entry carries, in the one field the wire format has for it. */
export function renderNativeDescription(spec: ToolSpec): string {
    const parts = [spec.summary.trim()]
    if (spec.whenToUse.trim() !== "") parts.push(`Use when: ${spec.whenToUse.trim()}`)
    // Same rule as the NLT catalogue: the negative case is the cheapest routing-accuracy improvement
    // available, so a missing one is admitted rather than fabricated or dropped.
    parts.push(
        `Do NOT use when: ${
            spec.whenNotToUse === undefined || spec.whenNotToUse.trim() === ""
                ? "no guidance was supplied for this tool — if it does not clearly match what was asked, prefer another tool or reply without one"
                : spec.whenNotToUse.trim()
        }`,
    )
    if (spec.mutating) {
        parts.push("Changes state: yes — only use it when the person asked for it.")
    }
    return parts.join("\n")
}

function toDefinition(spec: ToolSpec): ToolDefinition {
    const name = wireName(spec.slug)
    if (!WIRE_NAME.test(name)) throw nativeToolNameInvalid(spec.slug, spec.provider)
    return {
        name,
        description: renderNativeDescription(spec),
        // Passed through unchanged. The tool declares one schema; this dialect is the rendering that
        // hands it over verbatim, which is what keeps an eval comparing the same tools.
        parameters: spec.parameters as unknown as Readonly<Record<string, unknown>>,
    }
}

/**
 * What the wire-level catalogue costs in prompt tokens.
 *
 * Exported because the loop has to subtract it from the window. Under NLT the catalogue is a context
 * block and the budget sees it; under native it is in the request body, invisible to `assembleContext`
 * — so without this the turn would believe it had more room than it does, and the failure would
 * arrive as a context-length error from the endpoint with nothing local to explain it.
 */
export function nativeWireTokens(definitions: readonly ToolDefinition[]): number {
    if (definitions.length === 0) return 0
    // The serialised body is what is actually billed, and the per-tool envelope (`type`, `function`,
    // the braces) is a real part of it.
    return estimateTokens(JSON.stringify(definitions))
}

function malformed(name: string, message: string, hint: string): FieldError {
    return { field: `${name}.arguments`, message, hint }
}

/**
 * Read one call's argument document.
 *
 * Tolerant in exactly one respect: a document that parses to a *string* is parsed once more. Several
 * compat proxies double-encode `arguments`, and the second layer is theirs rather than the model's.
 * Beyond that there is no recovery — invalid JSON is invalid, and guessing at it would mean running
 * a tool with arguments nobody asked for.
 */
function readArguments(
    name: string,
    raw: string,
):
    | { readonly ok: true; readonly args: Record<string, unknown> }
    | { readonly ok: false; readonly error: FieldError } {
    const trimmed = raw.trim()
    // A tool taking no arguments legitimately streams an empty document.
    if (trimmed === "") return { ok: true, args: {} }

    let value: unknown
    try {
        value = JSON.parse(trimmed)
        if (typeof value === "string") value = JSON.parse(value)
    } catch {
        return {
            ok: false,
            error: malformed(
                name,
                "was not valid JSON, so the call could not be read.",
                "Send the arguments again as a single well-formed JSON object. If the last attempt was cut off, the reply may have hit the output limit — keep the arguments short.",
            ),
        }
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {
            ok: false,
            error: malformed(
                name,
                `parsed to ${Array.isArray(value) ? "an array" : typeof value}, not an object.`,
                "Arguments are always a JSON object keyed by field name, even when there is only one field.",
            ),
        }
    }

    return { ok: true, args: value as Record<string, unknown> }
}

/** Errors belonging to one call: `slug` itself, or any `slug.field` beneath it. */
function errorsFor(slug: string, errors: readonly FieldError[]): readonly FieldError[] {
    return errors.filter((error) => error.field === slug || error.field.startsWith(`${slug}.`))
}

export function parseNative(output: StepOutput): ParsedOutput {
    const intents: ToolIntent[] = []
    const problems: FieldError[] = []

    for (const call of output.calls) {
        const name = call.name.trim()
        if (name === "") {
            problems.push(
                malformed(
                    "(unnamed)",
                    "arrived without a function name.",
                    "Name the tool being called. If none applies, reply without calling a tool.",
                ),
            )
            continue
        }

        const read = readArguments(name, call.arguments)
        if (!read.ok) {
            problems.push(read.error)
            continue
        }
        intents.push({ callId: call.id, slug: name, args: read.args })
    }

    return {
        intents,
        text: output.text.trim(),
        ...(problems.length === 0 ? {} : { malformed: problems }),
    }
}

export const nativeDialect: ToolDialect = {
    id: "native",

    // Slot 1 carries *only* what the request cannot: the catalogue itself goes in the `tools`
    // parameter, and a list of tools that were NOT enabled has no field there to go in. So this stays
    // empty in the ordinary case — which keeps the cache-stable prefix shorter under native rather
    // than unstable — and holds one block when there is something to say.
    //
    // Both dialects must put the same guidance in front of the model, or an eval comparing them
    // measures the guidance and reports it as a property of the dialect.
    renderCatalogue: (_specs, notEnabled) => renderNotEnabledBlock(notEnabled),

    requestTools(specs) {
        if (specs.length === 0) return undefined
        const seen = new Map<string, ToolSpec>()
        for (const spec of specs) {
            const key = lookupKey(spec.slug)
            const other = seen.get(key)
            if (other !== undefined && spec.slug !== wireName(spec.slug)) {
                throw nativeToolNameCollision(spec.slug, other.slug)
            }
            if (other !== undefined && other.slug !== wireName(other.slug)) {
                throw nativeToolNameCollision(other.slug, spec.slug)
            }
            seen.set(key, spec)
        }
        return specs.map(toDefinition)
    },

    parse: parseNative,

    // A call is structured here, so nothing in the text stream needs holding back.
    createStreamFilter: passThroughFilter,

    renderCall(output) {
        return {
            role: "assistant",
            content: output.text,
            // Replayed because the `tool` messages below answer these ids. An assistant message
            // without them leaves those answers dangling, which endpoints reject outright — the one
            // failure mode here that is loud rather than quiet.
            ...(output.calls.length === 0 ? {} : { toolCalls: output.calls }),
        }
    },

    renderObservation(results) {
        // One per call, and deliberately bare — no "continue or reply" line. NLT needs that nudge
        // because prose is its only channel; here the protocol itself says an assistant turn follows
        // the tool messages, and repeating an instruction after every observation would spend tokens
        // telling the model something the API already told it.
        //
        // `renderTrusted` is shared with NLT so the two cannot delimit the same bytes differently.
        // There is no per-message header here to carry a "blocked" state, and none is needed: the
        // refusal text opens by saying the call was not run, identically under both dialects.
        return results.map((result) => ({
            role: "tool",
            content: renderTrusted(result),
            toolCallId: result.callId,
        }))
    },

    renderRepair(errors, output) {
        // Driven by `output.calls` rather than by the parsed intents: every call the assistant message
        // announced must be answered, and a call whose arguments would not parse never became an
        // intent. Leaving that one unanswered is the protocol error this shape exists to avoid.
        const messages: ChatMessage[] = output.calls.map((call) => {
            const mine = errorsFor(call.name.trim(), errors)
            const body =
                mine.length > 0
                    ? [
                          "This call could not be used:",
                          ...mine.map(
                              (error) => `- ${error.field}: ${error.message} ${error.hint}`,
                          ),
                      ].join("\n")
                    : // A step runs all-or-nothing, so a call that was fine still did not run. Saying
                      // so is the difference between "retry everything" and "your call vanished".
                      "This call was not run: another call in the same step could not be used, and a step runs all of its calls or none of them."
            return { role: "tool", content: body, toolCallId: call.id }
        })

        messages.push({
            role: "user",
            content:
                "Try those calls again, corrected. This is the only retry — if you cannot fill a required field, say so in a plain reply instead of guessing.",
        })
        return messages
    },
}
