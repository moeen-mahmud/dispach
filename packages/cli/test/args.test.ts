import { describe, expect, test } from "bun:test"
import { parse, UsageError } from "#lib/args"
import { COMMANDS, flagsFor } from "#lib/commands"
import { helpText } from "#lib/help"
import type { ParseResult } from "#lib/schema"

/** The happy path, narrowed. Anything else in these tests is a bug in the test. */
function command(argv: readonly string[]) {
    const result = parse(argv)
    if (result.kind !== "command") throw new Error(`expected a command, got ${result.kind}`)
    return result.parsed
}

function refusal(argv: readonly string[]): UsageError {
    try {
        parse(argv)
    } catch (error) {
        if (error instanceof UsageError) return error
        throw error
    }
    throw new Error(`expected ${argv.join(" ")} to be refused`)
}

function codes(error: UsageError): string[] {
    return error.details.map((detail) => detail.code)
}

describe("the four silent failures this parser exists to end", () => {
    test("a value beginning with a dash is a value, not a missing flag", () => {
        // The old parser set `input` to boolean true here, the caller's string check failed, and
        // the process opened an interactive session instead of running one turn.
        const parsed = command(["run", "a.yaml", "--input", "-5 degrees and falling"])
        expect(parsed.flags.str("input")).toBe("-5 degrees and falling")
    })

    test("a value that looks exactly like another flag is still a value", () => {
        expect(command(["run", "a.yaml", "--input", "--quiet"]).flags.str("input")).toBe("--quiet")
        expect(command(["run", "a.yaml", "--input", "--quiet"]).flags.bool("quiet")).toBe(false)
    })

    test("an unknown flag is refused, not ignored", () => {
        const error = refusal(["run", "a.yaml", "--sesion", "local:x"])
        expect(codes(error)).toEqual(["cli_unknown_flag"])
        expect(error.message).toContain("--sesion")
        expect(error.hint).toContain("--session")
    })

    test("a non-numeric number is refused, not defaulted", () => {
        const error = refusal(["sessions", "a.yaml", "--limit", "abc"])
        expect(codes(error)).toEqual(["cli_flag_not_a_number"])
        expect(error.message).toContain("--limit")
    })

    test("--help alone is a success, not a usage failure", () => {
        expect(parse(["--help"])).toEqual({ kind: "help", command: undefined })
        expect(parse(["-h"])).toEqual({ kind: "help", command: undefined })
    })
})

describe("commands", () => {
    test("each declared command parses with its required arguments", () => {
        for (const spec of COMMANDS) {
            // One dummy value per required arg, read from the spec rather than assumed to be one
            // manifest path — `soul` takes an action and a file.
            const args = spec.args.filter((arg) => arg.required).map((arg) => `a-${arg.name}`)
            expect(command([spec.name, ...args]).command.name).toBe(spec.name)
        }
    })

    test("an unknown command suggests the nearest real one", () => {
        const error = refusal(["sesions", "a.yaml"])
        expect(codes(error)).toEqual(["cli_unknown_command"])
        expect(error.hint).toContain("sessions")
    })

    test("a command nothing resembles gets no misleading suggestion", () => {
        expect(refusal(["xyzzy"]).hint).not.toContain("Did you mean")
    })

    test("a flag before the command is refused rather than reinterpreted", () => {
        // The command has to come first: flag semantics depend on the command's spec.
        expect(codes(refusal(["--store", "x.db", "run", "a.yaml"]))).toEqual(["cli_no_command"])
    })

    test("bare invocation asks for help without claiming success", () => {
        expect(parse([])).toEqual({ kind: "usage" })
    })

    test("--version resolves before any argument checking", () => {
        expect(parse(["--version"])).toEqual({ kind: "version" })
        expect(parse(["-v"])).toEqual({ kind: "version" })
    })
})

describe("flag forms", () => {
    test("--flag=value", () => {
        expect(command(["run", "a.yaml", "--session=local:x"]).flags.str("session")).toBe("local:x")
    })

    test("--flag=value keeps an embedded equals sign", () => {
        expect(command(["run", "a.yaml", "--input=a=b"]).flags.str("input")).toBe("a=b")
    })

    test("switches are false when absent, never undefined", () => {
        const parsed = command(["run", "a.yaml"])
        expect(parsed.flags.bool("quiet")).toBe(false)
        expect(parsed.flags.bool("ephemeral")).toBe(false)
    })

    test("a switch given a value is refused", () => {
        expect(codes(refusal(["run", "a.yaml", "--quiet=yes"]))).toEqual([
            "cli_flag_takes_no_value",
        ])
    })

    test("a value flag at the end of the line is refused", () => {
        const error = refusal(["run", "a.yaml", "--store"])
        expect(codes(error)).toEqual(["cli_flag_needs_value"])
        expect(error.hint).toContain("<path>")
    })

    test("an empty value is refused rather than passed through", () => {
        expect(codes(refusal(["run", "a.yaml", "--store="]))).toEqual(["cli_flag_empty_value"])
    })

    test("a flag with a bare form takes it at the end of the line", () => {
        // `--session` on its own means "show me the list", which is intent rather than a mistake.
        expect(command(["run", "a.yaml", "--session"]).flags.str("session")).toBe("")
    })

    test("a bare form is also taken when the next token is a flag", () => {
        // The inversion `FlagSpec.bare` buys: a value-taking flag normally consumes the next token
        // whatever it looks like, because `--input -5` is the text "-5". A session key cannot start with
        // a dash, so here the dash decides — and that safety is a fact about the field, which is why it
        // is declared per flag rather than applied to all of them.
        const parsed = command(["run", "a.yaml", "--session", "--quiet"])
        expect(parsed.flags.str("session")).toBe("")
        expect(parsed.flags.bool("quiet")).toBe(true)
    })

    test("`--session=` is still refused, because that one is a typo", () => {
        // The bare form and an explicit empty value are different claims: somebody who typed `=` meant to
        // pass something. Keeping the refusal is what makes the bare form readable as deliberate.
        expect(codes(refusal(["run", "a.yaml", "--session="]))).toEqual(["cli_flag_empty_value"])
    })

    test("a flag with no bare form keeps consuming a dashed value", () => {
        expect(command(["run", "a.yaml", "--input", "-5"]).flags.str("input")).toBe("-5")
    })

    test("a repeated flag takes the last value", () => {
        // Deliberate: it is what lets a shell alias be overridden on the command line.
        expect(
            command(["run", "a.yaml", "--session", "a:1", "--session", "b:2"]).flags.str("session"),
        ).toBe("b:2")
    })

    test("everything after -- is positional", () => {
        const parsed = command(["agents", "a.yaml", "--", "--not-a-flag.yaml"])
        expect(parsed.positionals).toEqual(["a.yaml", "--not-a-flag.yaml"])
    })
})

describe("short flags", () => {
    test("switches bundle", () => {
        expect(parse(["run", "a.yaml", "-h"])).toEqual({
            kind: "help",
            command: COMMANDS.find((c) => c.name === "run"),
        })
    })

    test("an unknown short flag is refused", () => {
        expect(codes(refusal(["run", "a.yaml", "-z"]))).toEqual(["cli_unknown_flag"])
    })
})

describe("numbers", () => {
    test("a whole number in range is accepted", () => {
        expect(command(["sessions", "a.yaml", "--limit", "10"]).flags.num("limit")).toBe(10)
    })

    test("a fractional value is refused for an integer flag", () => {
        const error = refusal(["sessions", "a.yaml", "--limit", "2.5"])
        expect(codes(error)).toEqual(["cli_flag_not_an_integer"])
        expect(error.hint).toContain("2")
    })

    test("below the declared minimum is refused", () => {
        expect(codes(refusal(["sessions", "a.yaml", "--limit", "0"]))).toEqual([
            "cli_flag_below_min",
        ])
    })

    test("infinity is not a number", () => {
        expect(codes(refusal(["sessions", "a.yaml", "--limit", "Infinity"]))).toEqual([
            "cli_flag_not_a_number",
        ])
    })
})

describe("positional arguments", () => {
    test("a missing manifest names the usage line", () => {
        // `sessions` carries this assertion now: run's manifest became optional (bare `run`
        // opens the sandbox picker), so it can no longer demonstrate a missing required arg.
        const error = refusal(["sessions"])
        expect(codes(error)).toEqual(["cli_missing_argument"])
        expect(error.hint).toContain("sessions <manifest>")
    })

    test("bare run parses — the sandbox decides what it means", () => {
        expect(command(["run"]).positionals).toEqual([])
    })

    test("a second manifest is refused where only one is taken", () => {
        const error = refusal(["run", "a.yaml", "b.yaml"])
        expect(codes(error)).toEqual(["cli_unexpected_argument"])
        expect(error.hint).toContain("b.yaml")
    })

    /**
     * `init milo` created `./milo` in whatever directory you were standing in — the positional was
     * the target *directory* and read as the agent's name. The argument is gone; what matters is
     * that the refusal names both readings, because the generic count sentence ("takes 0
     * argument(s), got 1. Unexpected: milo. Quote a value containing spaces.") is advice for a
     * typo and this was not a typo.
     */
    test("init takes no positional, and the refusal names both readings", () => {
        const error = refusal(["init", "milo"])
        expect(codes(error)).toEqual(["cli_unexpected_argument"])
        expect(error.hint).toContain("--name")
        expect(error.hint).toContain("--dir")
        // The generic advice must NOT survive: it sends the reader looking for a quoting mistake.
        expect(error.hint).not.toContain("Quote a value")
    })

    test("a command without its own hint keeps the generic one", () => {
        expect(refusal(["run", "a.yaml", "b.yaml"]).hint).toContain("Quote a value")
    })

    test("a variadic command takes as many as given", () => {
        expect(command(["agents", "a.yaml", "b.yaml", "c.yaml"]).positionals).toEqual([
            "a.yaml",
            "b.yaml",
            "c.yaml",
        ])
    })
})

describe("flags that exist on another command", () => {
    test("--json on run says where --json does work", () => {
        const error = refusal(["run", "a.yaml", "--json"])
        expect(codes(error)).toEqual(["cli_flag_wrong_command"])
        // "Unknown flag --json" would be true and useless: --json plainly exists.
        expect(error.hint).toContain("sessions")
        expect(error.hint).toContain("validate")
    })
})

describe("several problems at once", () => {
    test("every problem on the line is reported, not just the first", () => {
        const error = refusal(["sessions", "a.yaml", "--sesion", "x", "--limit", "abc"])
        expect(codes(error)).toEqual(["cli_unknown_flag", "cli_flag_not_a_number"])
        expect(error.format()).toContain("--sesion")
        expect(error.format()).toContain("--limit")
    })

    test("a consequence of an earlier mistake is not reported as a second mistake", () => {
        // `--sesion local:x` leaves "local:x" as an orphan positional, so the argument count is
        // wrong too — but only because of the typo. Reporting both sends the reader hunting for a
        // stray path they never typed.
        const error = refusal(["run", "a.yaml", "--sesion", "local:x"])
        expect(codes(error)).toEqual(["cli_unknown_flag"])
        expect(error.format()).not.toContain("argument")
    })

    test("help still wins over a broken line", () => {
        expect(parse(["sessions", "--limit", "abc", "--help"]).kind).toBe("help")
    })
})

describe("reading a flag the spec does not declare is a CLI bug, not a usage error", () => {
    test("an undeclared name throws", () => {
        const parsed = command(["run", "a.yaml"])
        expect(() => parsed.flags.str("nope")).toThrow("is declared")
    })

    test("reading a switch as a string throws", () => {
        const parsed = command(["run", "a.yaml"])
        expect(() => parsed.flags.str("quiet")).toThrow("declared as boolean")
    })
})

describe("help text cannot drift from the parser", () => {
    test("every flag the parser accepts appears in that command's help", () => {
        for (const spec of COMMANDS) {
            const help = helpText(spec)
            for (const flag of flagsFor(spec)) {
                expect(help).toContain(`--${flag.name}`)
            }
        }
    })

    test("global help lists every command and its own flags", () => {
        const help = helpText()
        for (const spec of COMMANDS) expect(help).toContain(spec.name)
        expect(help).toContain("--plain")
    })

    test("a value-taking flag shows its placeholder", () => {
        expect(helpText(COMMANDS.find((c) => c.name === "sessions"))).toContain("--limit <n>")
    })
})

// Kept honest about what `parse` can return: a new kind must be handled everywhere.
test("the result kinds are exactly the four the entry point switches on", () => {
    const kinds: ParseResult["kind"][] = ["command", "help", "version", "usage"]
    expect(kinds).toHaveLength(4)
})
