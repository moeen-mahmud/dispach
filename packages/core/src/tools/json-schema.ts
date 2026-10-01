/**
 * A provider's JSON Schema → this runtime's `ToolParameters` subset.
 *
 * Moved here from `tools-composio` when MCP became a second provider handing over JSON Schema, so the
 * two cannot disagree about what a schema means. The rules were grounded on live Composio data and
 * hold for any provider:
 *
 * **Constraints are folded into the description, not modelled.** `minimum`, `format`, `pattern` and
 * the rest reach the model as text in the field's description, where both dialects render it, and
 * `coerce` does not enforce them. An out-of-range value is rejected by the provider at execution.
 *
 * **Structural keywords are refused, loudly.** `anyOf`, `oneOf`, `allOf`, `not` and `$ref` change
 * which documents are valid, so dropping one hands the model a schema that disagrees with the
 * endpoint's. The caller supplies the refusal, so it names the provider and the tool.
 *
 * **`default: null` is dropped**: it is a schema saying "no default", and `coerce` would otherwise
 * send an explicit `null` on every call that left the field blank.
 *
 * **A nullable field is its non-null type.** `type: ["string", "null"]` and `anyOf: [{…}, {type:
 * "null"}]` are what zod and most MCP servers emit for an optional field, and refusing them refused
 * real servers (QA pilot.3). Leaving the field out is how this runtime says null, so nothing is
 * lost. A union of two real types is still refused: it changes which documents are valid.
 */

import type { JsonSchemaNode, JsonType, ToolParameters } from "./types.ts"

/** Changes which documents validate. Dropping one is lying to the model about the schema. */
const STRUCTURAL = ["anyOf", "oneOf", "allOf", "not", "$ref"] as const

/**
 * Rendered into the description in this order. `additionalProperties` is deliberately absent: the
 * common value is `false`, which is already how `coerce` behaves — an unknown field is a field error.
 */
const CONSTRAINTS = [
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
] as const

const TYPES = new Set<string>(["string", "number", "integer", "boolean", "array", "object"])

export interface SchemaConversion {
    /** The error for a structural keyword at `path`, naming the provider and tool. */
    readonly unsupported: (path: string, keyword: string) => Error
    /** What a node with no `type` becomes. Composio's are strings; MCP's are any JSON, so objects. */
    readonly untyped?: JsonType
    /** How the top-level schema is named in a refusal. */
    readonly rootPath?: string
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined
}

/** `minimum: 1, maximum: 100` — appended so the model sees a bound the coercer will not enforce. */
function constraintText(raw: Readonly<Record<string, unknown>>): string {
    const parts: string[] = []
    for (const key of CONSTRAINTS) {
        const value = raw[key]
        if (value === undefined || value === null) continue
        if (typeof value === "object") continue
        parts.push(`${key} ${String(value)}`)
    }
    return parts.join(", ")
}

function describe(raw: Readonly<Record<string, unknown>>): string | undefined {
    const base = typeof raw.description === "string" ? raw.description.trim() : ""
    const constraints = constraintText(raw)
    if (base === "" && constraints === "") return undefined
    if (constraints === "") return base
    return base === "" ? constraints : `${base} (${constraints})`
}

function stringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
}

/** `{…, anyOf: [X, {type: "null"}]}` as X with the outer node's own keywords, or unchanged. */
function unwrapNullable(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const variants = raw.anyOf ?? raw.oneOf
    if (!Array.isArray(variants) || variants.length !== 2) return raw
    const isNull = (variant: unknown) => asRecord(variant)?.type === "null"
    const other = variants.find((variant) => !isNull(variant))
    if (!variants.some(isNull) || asRecord(other) === undefined) return raw
    const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw
    return { ...asRecord(other), ...rest }
}

/** `["string", "null"]` as `"string"`; anything else unchanged, so a real union is still refused. */
function nonNullType(declared: unknown): unknown {
    if (!Array.isArray(declared)) return declared
    const real = declared.filter((type) => type !== "null")
    return real.length === 1 ? real[0] : declared
}

function node(
    given: Readonly<Record<string, unknown>>,
    path: string,
    conversion: SchemaConversion,
): JsonSchemaNode {
    const raw = unwrapNullable(given)
    for (const keyword of STRUCTURAL) {
        if (raw[keyword] !== undefined) throw conversion.unsupported(path, keyword)
    }

    const declared = nonNullType(raw.type)
    if (Array.isArray(declared)) throw conversion.unsupported(path, "type: []")
    const type: JsonType =
        typeof declared === "string" && TYPES.has(declared)
            ? (declared as JsonType)
            : (conversion.untyped ?? "string")

    const description = describe(raw)
    const enumValues = Array.isArray(raw.enum)
        ? raw.enum.filter(
              (value): value is string | number | boolean =>
                  typeof value === "string" ||
                  typeof value === "number" ||
                  typeof value === "boolean",
          )
        : undefined

    const items = type === "array" ? asRecord(raw.items) : undefined
    const properties = type === "object" ? asRecord(raw.properties) : undefined

    return {
        type,
        ...(description === undefined ? {} : { description }),
        ...(enumValues === undefined || enumValues.length === 0 ? {} : { enum: enumValues }),
        ...(items === undefined ? {} : { items: node(items, `${path}[]`, conversion) }),
        ...(properties === undefined
            ? {}
            : {
                  properties: mapProperties(properties, path, conversion),
                  required: stringArray(raw.required),
              }),
        ...(raw.default === undefined || raw.default === null ? {} : { default: raw.default }),
    }
}

function mapProperties(
    properties: Readonly<Record<string, unknown>>,
    path: string,
    conversion: SchemaConversion,
): Readonly<Record<string, JsonSchemaNode>> {
    const out: Record<string, JsonSchemaNode> = {}
    for (const [name, value] of Object.entries(properties)) {
        const raw = asRecord(value)
        if (raw === undefined) continue
        out[name] = node(raw, path === "" ? name : `${path}.${name}`, conversion)
    }
    return out
}

export function parametersFromJsonSchema(
    raw: Readonly<Record<string, unknown>> | undefined,
    conversion: SchemaConversion,
): ToolParameters {
    if (raw === undefined) return { type: "object", properties: {} }

    for (const keyword of STRUCTURAL) {
        if (raw[keyword] !== undefined) {
            throw conversion.unsupported(conversion.rootPath ?? "parameters", keyword)
        }
    }

    const properties = asRecord(raw.properties) ?? {}
    const required = stringArray(raw.required)
    const mapped = mapProperties(properties, "", conversion)

    return {
        type: "object",
        properties: mapped,
        // Filtered against what actually resolved: `required` naming a property that is not in
        // `properties` would make every call fail coercion on a field the model cannot supply.
        ...(required.length === 0 ? {} : { required: required.filter((name) => name in mapped) }),
    }
}
