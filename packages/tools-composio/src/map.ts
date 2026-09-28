/**
 * Composio's tool JSON → this runtime's `ToolSpec`.
 *
 * Everything here is grounded on the live `GET /api/v3/tools` response rather than on the API
 * reference, because two of the decisions below only became obvious from real data.
 *
 * **Constraints are folded into the description, not modelled.** Measured over 100 tools: 46 carry at
 * least one keyword `JsonSchemaNode` does not express — `minimum` (62 occurrences), `maximum` (23),
 * `format` (22), `pattern`, `minLength`, `maxLength`, `minItems`. Refusing those tools would refuse
 * nearly half of Composio, and `types.ts` keeps the schema subset deliberately small on purpose. So
 * the constraint text reaches the model in the field's description, where both dialects render it,
 * and `coerce` does not enforce it. The honest consequence: an out-of-range value is rejected by
 * Composio at execution rather than caught locally as a repairable field error.
 *
 * **Structural keywords are refused, loudly.** `anyOf`, `oneOf`, `allOf`, `not` and `$ref` change
 * which documents are valid, so dropping them would hand the model a schema that disagrees with the
 * endpoint's. None appears anywhere in the sample — every tool is a flat-ish `type: "object"` nested
 * at most four deep — so the refusal costs nothing today and is the difference between a named load
 * failure and a mystery 400 if Composio's shape changes.
 *
 * **`default: null` is dropped.** `GMAIL_SEND_EMAIL.subject` ships `{"default": null, "nullable":
 * true}`, and `coerce` applies any default that is not `undefined` — so keeping it would send an
 * explicit `subject: null` on every call the model left blank. A null default is the schema saying
 * "no default", not "default to null".
 */

import { parametersFromJsonSchema, type ToolParameters, type ToolSpec } from "@dispach/core"
import { composioSchemaUnsupported } from "./errors.ts"

/** The fields of Composio's tool object this runtime reads. Everything else is ignored. */
export interface ComposioTool {
    readonly slug: string
    readonly name?: string
    readonly description?: string
    readonly human_description?: string
    readonly input_parameters?: Readonly<Record<string, unknown>>
    readonly tags?: readonly string[]
    readonly toolkit?: { readonly slug?: string; readonly name?: string }
    readonly no_auth?: boolean
    readonly is_deprecated?: boolean
}

/**
 * The schema conversion is core's `parametersFromJsonSchema`, shared with the MCP provider so the two
 * cannot disagree about what a schema means. Only the refusal is Composio's: it names the tool.
 */
export function mapParameters(tool: ComposioTool): ToolParameters {
    return parametersFromJsonSchema(tool.input_parameters, {
        unsupported: (path, keyword) => composioSchemaUnsupported(tool.slug, path, keyword),
        rootPath: "input_parameters",
    })
}

/**
 * Read or write, from the provider's own annotations rather than from its slug.
 *
 * Composio publishes MCP-style hints in `tags`. Measured over 100 tools: `readOnlyHint` on 51,
 * `destructiveHint` on 10, and **no hint at all on 37** — including `ABLY_PUBLISH_MESSAGE_TO_CHANNEL`
 * and `_2CHAT_CREATE_CONTACT`, which are plainly writes. So the annotation is trustworthy when
 * present (zero tools carry `readOnlyHint` while having a write verb in the slug) and carries no
 * information when absent.
 *
 * An unannotated tool is therefore treated as **mutating**, which is the safe direction and not the
 * cautious one: `mutating` is what makes the executor serialise a call and never retry it. A write
 * mislabelled as a read runs in parallel with its neighbours and is retried on failure, so the
 * failure mode is a side effect happening twice.
 */
export function isMutating(tool: ComposioTool): boolean {
    const tags = new Set(tool.tags ?? [])
    if (tags.has("destructiveHint")) return true
    return !tags.has("readOnlyHint")
}

/** True when the provider told us nothing either way, so the caller can report the assumption. */
export function isUnannotated(tool: ComposioTool): boolean {
    const tags = new Set(tool.tags ?? [])
    return !tags.has("readOnlyHint") && !tags.has("destructiveHint")
}

function firstSentence(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim()
    const stop = trimmed.search(/\.\s|\.$/)
    return stop === -1 ? trimmed : trimmed.slice(0, stop + 1)
}

/**
 * `whenNotToUse` is deliberately left unset.
 *
 * Composio supplies no negative guidance, and the registry already renders a visible placeholder and
 * warns naming the slug (decision 4.11). Fabricating a line here would put words the tool's author
 * never wrote in front of the model, under the tool's own name.
 */
export function mapTool(tool: ComposioTool): ToolSpec {
    const description = (tool.description ?? tool.human_description ?? "").trim()
    const summary = description === "" ? `The ${tool.slug} tool.` : firstSentence(description)
    const toolkit = tool.toolkit?.slug

    return {
        slug: tool.slug,
        provider: "composio",
        summary,
        // The full description, where Composio puts the "call this when…" material. `summary` is its
        // first sentence, so this is the same text at two lengths rather than two descriptions that
        // can disagree.
        whenToUse: description === "" ? `the task needs ${tool.slug}` : description,
        mutating: isMutating(tool),
        tags: [
            ...(toolkit === undefined ? [] : [toolkit]),
            ...(isMutating(tool) ? ["write"] : ["read"]),
        ],
        parameters: mapParameters(tool),
    }
}
