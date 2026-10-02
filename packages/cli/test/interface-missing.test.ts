/** `ink`/`react` left out by `--omit=optional` (pilot.5, #26): named, not a stack trace. */

import { expect, test } from "bun:test"
import { missingInterface } from "#lib/interface-missing"

function notFound(message: string, code = "ERR_MODULE_NOT_FOUND"): Error {
    return Object.assign(new Error(message), { code })
}

test("names ink or react when Node cannot find them, and nothing else", () => {
    expect(missingInterface(notFound("Cannot find package 'ink' imported from /x/App.js"))).toBe(
        "ink",
    )
    expect(
        missingInterface(notFound("Cannot find module 'react/jsx-runtime'", "MODULE_NOT_FOUND")),
    ).toBe("react")
    expect(missingInterface(notFound("Cannot find package 'zod' imported from /x"))).toBeUndefined()
    // Another error that mentions ink is not this one.
    expect(missingInterface(new Error("Cannot find package 'ink'"))).toBeUndefined()
})
