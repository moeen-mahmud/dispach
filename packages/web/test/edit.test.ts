/**
 * The two ways an editing form goes wrong without looking wrong.
 *
 * Both are about text. The value travels to the server as text on purpose — one parser for the
 * person's two editors — so *how* a value is written back is the whole correctness of the panel,
 * and `JSON.stringify` is the plausible answer that breaks scalars.
 */

import { expect, test } from "bun:test"
import { asText, canSubmit } from "../src/lib/edit.ts"

test("a scalar is its own text, and a structure is JSON", () => {
    // The case that rules `JSON.stringify` out as the general answer: with it, this is `"gpt-4o"`
    // *including the quotes*, and a number becomes the string "40" in the manifest.
    expect(asText("gpt-4o-mini")).toBe("gpt-4o-mini")
    expect(asText(40)).toBe("40")
    expect(asText(true)).toBe("true")
    // A list and a map go as JSON, which is valid YAML flow style — so the same parser reads back
    // the same structure.
    expect(asText(["now", "memory_write"])).toBe('["now","memory_write"]')
    expect(asText({ system: {} })).toBe('{"system":{}}')
})

test("an unset field opens empty, never on the word undefined", () => {
    expect(asText(undefined)).toBe("")
    expect(asText(null)).toBe("")
})

test("an unchanged value cannot be submitted", () => {
    // A write replaces the agent. Replacing it to apply nothing is a restart nobody asked for.
    const setting = { path: "limits.maxSteps", means: "…", value: 40 }
    expect(canSubmit({ setting, text: "40", confirmed: false })).toBe(false)
    expect(canSubmit({ setting, text: "41", confirmed: false })).toBe(true)
})

test("an empty box cannot be submitted", () => {
    // Clearing a field is a real intention and is not the same as setting it to nothing, so it
    // wants its own action rather than arriving as `""` from a box somebody emptied by accident.
    const setting = { path: "model.main.id", means: "…", value: "gpt-4o-mini" }
    expect(canSubmit({ setting, text: "", confirmed: false })).toBe(false)
    expect(canSubmit({ setting, text: "   ", confirmed: false })).toBe(false)
})

test("a field carrying a confirm sentence cannot be submitted unconfirmed", () => {
    // The same rule the server refuses by, applied where the button is — so the reason is readable
    // before the round trip rather than as a 409 afterwards.
    const setting = {
        path: "tools.untrusted.onMutate",
        means: "…",
        confirm: "Setting this to allow turns off the check…",
        value: "refuse",
    }
    expect(canSubmit({ setting, text: "allow", confirmed: false })).toBe(false)
    expect(canSubmit({ setting, text: "allow", confirmed: true })).toBe(true)
})
