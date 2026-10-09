/**
 * Text in, typed arguments out — or an honest list of what is wrong.
 *
 * A line-oriented dialect yields strings, and `native` yields JSON that Anthropic's compat endpoint
 * will happily deliver off-schema because it ignores `strict`. So coercion runs for **both**
 * dialects, and this is the only place that decides what a model's words mean for a given tool.
 *
 * The tolerances are all cases that arrive in practice and cost a repair step otherwise: keys
 * differing only in case or separator, `yes` for a boolean, a comma list for an array, a repeated
 * key for a list. What it will *not* do is guess: an unfillable required field is a field error, not
 * an empty string, because a tool call with a plausible wrong argument is worse than a refused one.
 */

import { nearest } from "../nearest.ts"
import { typeWords } from "./json-schema.ts"
import type { FieldError, JsonSchemaNode, ScalarType, ToolSpec } from "./types.ts"

export interface CoercionSuccess {
    readonly ok: true
    readonly args: Readonly<Record<string, unknown>>
}

export interface CoercionFailure {
    readonly ok: false
    readonly errors: readonly FieldError[]
}

export type Coercion = CoercionSuccess | CoercionFailure

/** `Send_Email`, `send email` and `send-email` are the same key. Nothing else is. */
function normaliseKey(key: string): string {
    return key.toLowerCase().replace(/[\s_.-]+/g, "")
}

const TRUTHY = new Set(["true", "yes", "y", "1", "on", "enabled"])
const FALSY = new Set(["false", "no", "n", "0", "off", "disabled"])
const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/

function typeName(node: JsonSchemaNode): string {
    if (node.type !== "array") return typeWords(node.type)
    return node.items === undefined ? "list" : `list of ${typeWords(node.items.type)}`
}

/**
 * A value for a union of plain types (pilot.16): kept as written when it already is one of them, so a
 * Sheets cell sent as 5 stays a number and "5" stays text. Otherwise each non-text type is tried in
 * order, which is what lets NLT, where every value arrives as text, still send a number or a yes/no.
 */
function convertUnion(
    node: JsonSchemaNode,
    types: readonly ScalarType[],
    value: unknown,
): Converted {
    const own =
        typeof value === "string"
            ? "string"
            : typeof value === "boolean"
              ? "boolean"
              : typeof value === "number"
                ? Number.isInteger(value) && types.includes("integer")
                    ? "integer"
                    : "number"
                : undefined
    if (own !== undefined && types.includes(own)) return { ok: true, value }
    for (const type of types) {
        if (type === "string") continue
        const converted = convertScalar({ ...node, type }, value)
        if (converted.ok) return converted
    }
    if (types.includes("string")) return convertScalar({ ...node, type: "string" }, value)
    return fail(
        `expected ${typeWords(types)}, got ${JSON.stringify(shorten(String(value)))}.`,
        `Write one of: ${typeWords(types)}.`,
    )
}

interface Converted {
    readonly ok: boolean
    readonly value?: unknown
    readonly message?: string
    readonly hint?: string
}

function fail(message: string, hint: string): Converted {
    return { ok: false, message, hint }
}

function shorten(value: string): string {
    const single = value.replace(/\s+/g, " ").trim()
    return single.length > 60 ? `${single.slice(0, 57)}…` : single
}

function convertScalar(node: JsonSchemaNode, value: unknown): Converted {
    if (Array.isArray(node.type))
        return convertUnion(node, node.type as readonly ScalarType[], value)
    switch (node.type) {
        case "string": {
            if (typeof value === "string") return { ok: true, value }
            if (typeof value === "number" || typeof value === "boolean") {
                return { ok: true, value: String(value) }
            }
            return fail(
                `expected text, got ${typeof value}.`,
                "Write the value on one line, or open it with <<< and close it with >>> for several lines.",
            )
        }
        case "number":
        case "integer": {
            const raw =
                typeof value === "number"
                    ? value
                    : typeof value === "string"
                      ? // A model writing 1,000 or 1_000 means one thousand. Anything else with a
                        // stray character in it is refused rather than silently reinterpreted.
                        NUMERIC.test(value.trim().replace(/(?<=\d)[,_](?=\d)/g, ""))
                          ? Number(value.trim().replace(/(?<=\d)[,_](?=\d)/g, ""))
                          : Number.NaN
                      : Number.NaN

            if (!Number.isFinite(raw)) {
                return fail(
                    `expected a number, got ${JSON.stringify(shorten(String(value)))}.`,
                    "Write digits only, with no units or words — for example 5.",
                )
            }
            if (node.type === "integer" && !Number.isInteger(raw)) {
                return fail(
                    `expected a whole number, got ${raw}.`,
                    "Round it to a whole number and write that.",
                )
            }
            return { ok: true, value: raw }
        }
        case "boolean": {
            if (typeof value === "boolean") return { ok: true, value }
            if (typeof value === "number" && (value === 0 || value === 1)) {
                return { ok: true, value: value === 1 }
            }
            if (typeof value === "string") {
                const word = value.trim().toLowerCase()
                if (TRUTHY.has(word)) return { ok: true, value: true }
                if (FALSY.has(word)) return { ok: true, value: false }
            }
            return fail(
                `expected yes or no, got ${JSON.stringify(shorten(String(value)))}.`,
                "Write exactly `true` or `false`.",
            )
        }
        case "object": {
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                return { ok: true, value }
            }
            if (typeof value === "string" && value.trim().startsWith("{")) {
                try {
                    const parsed: unknown = JSON.parse(value)
                    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                        return { ok: true, value: parsed }
                    }
                } catch {
                    // Falls through to the honest failure below rather than to a partial object.
                }
            }
            return fail(
                "expected a JSON object.",
                'Write it as JSON on one line, e.g. {"key": "value"}.',
            )
        }
        default:
            return fail(`expected ${typeName(node)}.`, "Check the field list for this tool.")
    }
}

function splitList(value: string, itemType: JsonSchemaNode["type"]): unknown[] {
    const text = value.trim()
    if (text === "") return []
    // A list of objects is JSON or nothing: splitting `{"a": 1, "b": 2}` on its commas, or a
    // pretty-printed object on its newlines, yields fragments no item can be coerced from. So the
    // bare form — `{…}, {…}` or one object over several lines — is read as the list it means.
    if (itemType === "object" && !text.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(`[${text}]`)
            if (Array.isArray(parsed)) return parsed
        } catch {
            // Not JSON; the item conversion below reports it with the hint to write JSON.
        }
    }
    if (text.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(text)
            // Items as parsed: stringifying them turned every object in a JSON list into
            // "[object Object]", the same defect pilot.3 fixed for native calls.
            if (Array.isArray(parsed)) return parsed
        } catch {
            // Not JSON after all — fall through to the separator rules, which is what a model
            // writing `[a, b` meant anyway.
        }
    }
    // Newlines win over commas: a heredoc list is one item per line, and its items often contain
    // commas of their own.
    const parts = text.includes("\n") ? text.split("\n") : text.split(",")
    return parts.map((part) => part.trim().replace(/^[-*+]\s+/, "")).filter((part) => part !== "")
}

function convert(node: JsonSchemaNode, value: unknown, field: string): Converted {
    if (node.type === "array") {
        // Items keep their own type and are converted against the item schema below. Stringifying
        // them first turned every object in a list into "[object Object]", so a native call passing
        // a list of objects failed coercion and then its repair (pilot.3).
        const items: readonly unknown[] | undefined = Array.isArray(value)
            ? value
            : typeof value === "string"
              ? splitList(value, node.items?.type ?? "string")
              : undefined
        if (items === undefined) {
            return fail(
                `expected a list, got ${typeof value}.`,
                "Write the items separated by commas, or one per line inside <<< >>>.",
            )
        }
        const itemNode: JsonSchemaNode = node.items ?? { type: "string" }
        const out: unknown[] = []
        for (const item of items) {
            const converted = convertOne(itemNode, item, field)
            if (!converted.ok) return converted
            out.push(converted.value)
        }
        return { ok: true, value: out }
    }

    // Repeated keys are how a list gets written by accident on a scalar field. Saying so is more
    // useful than joining the values and pretending that was the intent.
    if (Array.isArray(value)) {
        return fail(
            `was given ${value.length} times but takes a single value.`,
            "Give it once. For a value spanning several lines, open it with <<< and close it with >>>.",
        )
    }

    return convertOne(node, value, field)
}

function convertOne(node: JsonSchemaNode, value: unknown, _field: string): Converted {
    const converted = convertScalar(node, value)
    if (!converted.ok) return converted

    if (node.enum === undefined || node.enum.length === 0) return converted

    const allowed = node.enum
    const match = allowed.find(
        (candidate) =>
            String(candidate).toLowerCase() === String(converted.value).toLowerCase().trim(),
    )
    if (match !== undefined) return { ok: true, value: match }

    return fail(
        `must be one of ${allowed.map((item) => String(item)).join(", ")}, got ${JSON.stringify(shorten(String(value)))}.`,
        `Copy one of the listed values exactly: ${allowed.map((item) => String(item)).join(" | ")}.`,
    )
}

/**
 * Match what the model wrote against what the tool declares, coerce, and validate.
 *
 * Every problem is collected: a block with three bad fields should produce three field errors, so
 * the single repair step can fix all of them at once instead of discovering them one at a time.
 */
export function coerceArgs(spec: ToolSpec, raw: Readonly<Record<string, unknown>>): Coercion {
    const properties = spec.parameters.properties
    const names = Object.keys(properties)
    const required = new Set(spec.parameters.required ?? [])

    const byNormalised = new Map<string, string[]>()
    for (const name of names) {
        const key = normaliseKey(name)
        const bucket = byNormalised.get(key)
        if (bucket === undefined) byNormalised.set(key, [name])
        else bucket.push(name)
    }

    const errors: FieldError[] = []
    const args: Record<string, unknown> = {}
    const seen = new Set<string>()

    for (const [writtenKey, value] of Object.entries(raw)) {
        const candidates = byNormalised.get(normaliseKey(writtenKey)) ?? []
        // Two declared fields differing only in case or separator: tolerant matching would have to
        // pick one, so it refuses and names both. This is a provider schema problem, and guessing
        // would hide it.
        const name = candidates.length === 1 ? candidates[0] : undefined

        if (name === undefined) {
            const suggestion = nearest(writtenKey, names)
            errors.push({
                field: writtenKey,
                message:
                    candidates.length > 1
                        ? `is ambiguous — this tool declares ${candidates.join(" and ")}.`
                        : "is not a field of this tool.",
                hint:
                    candidates.length > 1
                        ? `Write the field name exactly as listed: ${candidates.join(" or ")}.`
                        : suggestion === undefined
                          ? `This tool takes: ${names.length === 0 ? "no fields" : names.join(", ")}.`
                          : `Did you mean ${suggestion}?`,
            })
            continue
        }

        const node = properties[name]
        if (node === undefined) continue

        // An empty value is an omission, not a value. `subject:` with nothing after it is the model
        // saying it has nothing — treating it as the empty string would send a blank email.
        if (typeof value === "string" && value.trim() === "") continue

        seen.add(name)
        const converted = convert(node, value, name)
        if (converted.ok) {
            args[name] = converted.value
        } else {
            errors.push({
                field: name,
                message: converted.message ?? "could not be used.",
                hint: converted.hint ?? "Check the field list for this tool.",
            })
        }
    }

    for (const name of names) {
        if (seen.has(name)) continue
        const node = properties[name]
        if (node === undefined) continue

        if (required.has(name)) {
            errors.push({
                field: name,
                message: "is required but was not given.",
                hint: `Add a line \`${name}: <value>\`${
                    node.description === undefined ? "" : ` — ${node.description.trim()}`
                }.`,
            })
            continue
        }
        if (node.default !== undefined) args[name] = node.default
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, args }
}
