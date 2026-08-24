import { describe, expect, test } from "bun:test"
import { readEnv } from "#lib/env"

describe("NO_COLOR", () => {
    test("is honoured when present and non-empty", () => {
        expect(readEnv({ NO_COLOR: "1" }).noColor).toBe(true)
        expect(readEnv({ NO_COLOR: "anything at all" }).noColor).toBe(true)
    })

    test("set-but-empty is not a preference", () => {
        // A container passing through an unset variable, per no-color.org.
        expect(readEnv({ NO_COLOR: "" }).noColor).toBe(false)
    })

    test("absent is absent", () => {
        expect(readEnv({}).noColor).toBe(false)
    })
})

describe("TERM", () => {
    test("only the literal dumb terminal counts", () => {
        expect(readEnv({ TERM: "dumb" }).dumbTerminal).toBe(true)
        expect(readEnv({ TERM: "xterm-256color" }).dumbTerminal).toBe(false)
        expect(readEnv({}).dumbTerminal).toBe(false)
    })
})

describe("CI", () => {
    test("any non-empty value except false means CI", () => {
        expect(readEnv({ CI: "true" }).ci).toBe(true)
        expect(readEnv({ CI: "1" }).ci).toBe(true)
    })

    test("CI=false is set by tooling that means it", () => {
        // Taking it literally would strip interactivity from a terminal that has it.
        expect(readEnv({ CI: "false" }).ci).toBe(false)
        expect(readEnv({ CI: "" }).ci).toBe(false)
    })
})

test("DEBUG is read here rather than deep in an error path", () => {
    expect(readEnv({ DEBUG: "1" }).debug).toBe(true)
    expect(readEnv({}).debug).toBe(false)
})

test("the real environment is readable without arguments", () => {
    // Only assertion that touches process.env: the shape, not the values, which vary by machine.
    const facts = readEnv()
    expect(Object.keys(facts).sort()).toEqual([
        "ci",
        "debug",
        "dumbTerminal",
        "noColor",
        "noEnhancedKeys",
        "sandboxHome",
    ])
})
