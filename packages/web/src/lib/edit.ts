/**
 * What an editing form may submit, and how a value is written back as text.
 *
 * ## Why this is a module
 *
 * Two questions the editing panels get wrong quietly if they answer them in JSX. Neither needs a
 * DOM, and both have a wrong answer that renders perfectly:
 *
 * 1. **A value is sent as text**, because one parser serves both of the person's editors — the
 *    terminal's `config set` and this. `JSON.stringify` is the obvious way to turn a list back into
 *    text and it is wrong for a *string*: it would send `"gpt-4o-mini"` with the quotes, which YAML
 *    reads back as the same string, and `"40"` for a number, which it reads back as the string
 *    `"40"`. The manifest then holds a quoted number and the schema refuses it — an edit that looks
 *    like it round-tripped and did not.
 * 2. **A field with a `confirm` sentence needs the box ticked**, and a form that submits without it
 *    earns a 409 the person cannot see the reason for. Deciding submittability here means the
 *    button can be disabled with the same rule the server refuses by.
 */

/** One editable field, as `GET /v1/agents/:id/config` reports it. */
export interface EditableSetting {
    readonly path: string
    readonly means: string
    readonly confirm?: string
    readonly value?: unknown
}

/**
 * A value as the text an editor should open on.
 *
 * A scalar is its own text — that is what makes `model.main.id` an ordinary input and `40` a number
 * on the way back. A list or a map is written as JSON, which is valid YAML flow style and therefore
 * reads back as the same structure through the same parser.
 *
 * An absent value is the empty string, not `"undefined"`: the field is unset, and a form opening on
 * the word `undefined` invites somebody to save it.
 */
export function asText(value: unknown): string {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return JSON.stringify(value)
}

/**
 * Whether this edit may be submitted.
 *
 * The empty string is refused for the same reason the parser refuses to guess: clearing a field is
 * a real intention and it is *not* the same as setting it to nothing, so it wants its own action
 * rather than an empty box that silently writes `""`. Unchanged text is refused because a write
 * replaces the agent, and replacing it to apply nothing is a restart nobody asked for.
 */
export function canSubmit(input: {
    readonly setting: EditableSetting
    readonly text: string
    readonly confirmed: boolean
}): boolean {
    if (input.text.trim() === "") return false
    if (input.text === asText(input.setting.value)) return false
    // The server refuses without this, by the same rule. Deciding it here is what lets the button
    // say so before somebody spends a round trip finding out.
    if (input.setting.confirm !== undefined && !input.confirmed) return false
    return true
}
