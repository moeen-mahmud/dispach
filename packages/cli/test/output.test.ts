import { describe, expect, test } from "bun:test"
import { resolveMode } from "#lib/output"
import type { ModeInputs } from "#lib/schema"
import type { EnvFacts } from "#lib/types"

const QUIET_ENV: EnvFacts = {
    noColor: false,
    dumbTerminal: false,
    ci: false,
    debug: false,
    sandboxHome: undefined,
    noEnhancedKeys: false,
}

/** A terminal with nothing unusual in the environment. */
const tty: ModeInputs = {
    json: false,
    plain: false,
    oneShot: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: QUIET_ENV,
}

function mode(overrides: Partial<ModeInputs>): string {
    return resolveMode({ ...tty, ...overrides }).mode
}

function withEnv(overrides: Partial<EnvFacts>): Partial<ModeInputs> {
    return { env: { ...QUIET_ENV, ...overrides } }
}

describe("precedence, highest first", () => {
    test("--json beats everything, including --plain", () => {
        expect(mode({ json: true, plain: true })).toBe("json")
        expect(mode({ json: true, stdoutIsTTY: false })).toBe("json")
    })

    test("--plain beats a perfectly good terminal", () => {
        expect(mode({ plain: true })).toBe("plain")
    })

    test("--input is plain even at a terminal", () => {
        // Otherwise `--input` means one thing in a shell script and another in a shell, and the
        // output of a scripted turn would depend on who was watching.
        expect(mode({ oneShot: true })).toBe("plain")
    })

    test("a piped stdout is plain", () => {
        expect(mode({ stdoutIsTTY: false })).toBe("plain")
    })

    test("a piped stdin is plain even when stdout is a terminal", () => {
        // `echo hi | dispach run …` has nothing to drive an input line with.
        expect(mode({ stdinIsTTY: false })).toBe("plain")
    })

    test("a terminal with a clean environment is rich", () => {
        expect(mode({})).toBe("rich")
    })
})

describe("environment", () => {
    test("NO_COLOR forces plain", () => {
        expect(mode(withEnv({ noColor: true }))).toBe("plain")
    })

    test("a dumb terminal forces plain", () => {
        expect(mode(withEnv({ dumbTerminal: true }))).toBe("plain")
    })

    test("CI forces plain", () => {
        // CI logs are files that happen to scroll; cursor movement in one is noise forever.
        expect(mode(withEnv({ ci: true }))).toBe("plain")
    })

    test("DEBUG changes how failures print, not how output renders", () => {
        expect(mode(withEnv({ debug: true }))).toBe("rich")
    })
})

describe("the decision explains itself", () => {
    test("every mode comes back with a non-empty reason", () => {
        const cases: Partial<ModeInputs>[] = [
            { json: true },
            { plain: true },
            { oneShot: true },
            { stdoutIsTTY: false },
            { stdinIsTTY: false },
            withEnv({ noColor: true }),
            withEnv({ dumbTerminal: true }),
            withEnv({ ci: true }),
            {},
        ]
        for (const overrides of cases) {
            expect(resolveMode({ ...tty, ...overrides }).because.length).toBeGreaterThan(0)
        }
    })

    test("the reason names the input that decided it", () => {
        expect(resolveMode({ ...tty, ...withEnv({ noColor: true }) }).because).toContain("NO_COLOR")
        expect(resolveMode({ ...tty, stdoutIsTTY: false }).because).toContain("stdout")
    })
})

test("resolution is total — no input combination falls through", () => {
    const bools = [true, false]
    for (const json of bools) {
        for (const plain of bools) {
            for (const oneShot of bools) {
                for (const stdinIsTTY of bools) {
                    for (const stdoutIsTTY of bools) {
                        const decision = resolveMode({
                            json,
                            plain,
                            oneShot,
                            stdinIsTTY,
                            stdoutIsTTY,
                            env: QUIET_ENV,
                        })
                        expect(["json", "plain", "rich"]).toContain(decision.mode)
                    }
                }
            }
        }
    }
})
