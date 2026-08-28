/**
 * The argument parser. Pure — argv in, a decision out, no I/O and no `process`.
 *
 * It replaces a parser that failed silently in four distinct ways, each of which is now a test:
 *
 * - **A value beginning with `-` was swallowed.** The old rule was "consume the next token unless
 *   it looks like a flag", so `--input "-5 degrees"` set `input` to boolean `true`, the caller's
 *   `typeof input === "string"` check failed, and the process opened an interactive session instead
 *   of running the one turn it was asked for. The rule here has no such hole: whether a flag
 *   consumes the next token is a property of the *flag*, declared in `commands.ts`, never a guess
 *   about the value.
 * - **Unknown flags were ignored.** `--sesion local:x` ran against the default session silently.
 * - **A non-numeric `--limit` fell back to the default.**
 * - **`--help` with no command exited 1**, reporting failure for the one thing that had succeeded.
 *
 * Every problem found is collected rather than thrown on sight, so a line with two mistakes reports
 * both. `HarnessError.details` already renders that shape.
 */

import { BRAND, type ErrorDetail, HarnessError } from "@dispach/core"
import { COMMANDS, commandsAccepting, findCommand, flagsFor, GLOBAL_FLAGS } from "#lib/commands"
import type { FlagSpec, FlagValue, FlagValues, ParseResult } from "#lib/schema"

/** Anything wrong with the command line itself. Distinct from anything wrong with a manifest. */
export class UsageError extends HarnessError {}

// ─── nearest match ───────────────────────────────────────────────────────────────────────

function distance(a: string, b: string): number {
    // Two rows rather than a full matrix; the strings here are flag names.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i]
        for (let j = 1; j <= b.length; j += 1) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
            const insertion = (current[j - 1] ?? 0) + 1
            const deletion = (previous[j] ?? 0) + 1
            current.push(Math.min(substitution, insertion, deletion))
        }
        previous = current
    }
    return previous[b.length] ?? Math.max(a.length, b.length)
}

function nearest(word: string, candidates: readonly string[]): string | undefined {
    let best: string | undefined
    let bestScore = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
        const score = distance(word, candidate)
        if (score < bestScore) {
            bestScore = score
            best = candidate
        }
    }
    // A suggestion has to be plausible. Beyond a third of the word it is noise, and noise in an
    // error message is worse than no suggestion at all.
    return best !== undefined && bestScore <= Math.max(2, Math.floor(word.length / 3))
        ? best
        : undefined
}

// ─── flag values ─────────────────────────────────────────────────────────────────────────

class Values implements FlagValues {
    readonly #values: ReadonlyMap<string, FlagValue>
    readonly #specs: ReadonlyMap<string, FlagSpec>

    constructor(values: ReadonlyMap<string, FlagValue>, specs: ReadonlyMap<string, FlagSpec>) {
        this.#values = values
        this.#specs = specs
    }

    #expect(name: string, kind: FlagSpec["kind"]): FlagValue | undefined {
        const spec = this.#specs.get(name)
        if (spec === undefined) {
            throw new UsageError({
                code: "cli_flag_not_declared",
                message: `No flag "${name}" is declared for this command.`,
                hint: "This is a bug in the CLI, not in the command line. Add the flag to lib/commands.ts or fix the reader.",
            })
        }
        if (spec.kind !== kind) {
            throw new UsageError({
                code: "cli_flag_kind_mismatch",
                message: `Flag "${name}" is declared as ${spec.kind} but was read as ${kind}.`,
                hint: "This is a bug in the CLI. The reader and lib/commands.ts disagree.",
            })
        }
        return this.#values.get(name)
    }

    str(name: string): string | undefined {
        const value = this.#expect(name, "string")
        return typeof value === "string" ? value : undefined
    }

    num(name: string): number | undefined {
        const value = this.#expect(name, "number")
        return typeof value === "number" ? value : undefined
    }

    bool(name: string): boolean {
        return this.#expect(name, "boolean") === true
    }

    has(name: string): boolean {
        return this.#values.has(name)
    }
}

// ─── parse ───────────────────────────────────────────────────────────────────────────────

function detail(code: string, message: string, hint: string, field?: string): ErrorDetail {
    return field === undefined ? { code, message, hint } : { code, message, hint, field }
}

function usage(details: ErrorDetail[]): UsageError {
    const first = details[0]
    return new UsageError({
        code: "cli_usage",
        message:
            details.length === 1 && first !== undefined
                ? first.message
                : `${details.length} problems with the command line.`,
        hint:
            details.length === 1 && first !== undefined
                ? first.hint
                : "Each problem below names the flag and its fix.",
        ...(first?.field === undefined ? {} : { field: first.field }),
        details,
    })
}

function readNumber(spec: FlagSpec, raw: string, written: string): number | ErrorDetail {
    const value = Number(raw)
    if (raw.trim() === "" || !Number.isFinite(value)) {
        return detail(
            "cli_flag_not_a_number",
            `${written} expects a number, got ${JSON.stringify(raw)}.`,
            `Pass a number, as in ${written} 50. The old parser silently used the default here, which made a typo look like it worked.`,
            written,
        )
    }
    if (spec.integer === true && !Number.isInteger(value)) {
        return detail(
            "cli_flag_not_an_integer",
            `${written} expects a whole number, got ${raw}.`,
            `Drop the fractional part: ${written} ${Math.trunc(value)}.`,
            written,
        )
    }
    if (spec.min !== undefined && value < spec.min) {
        return detail(
            "cli_flag_below_min",
            `${written} must be at least ${spec.min}, got ${value}.`,
            `Pass ${spec.min} or more.`,
            written,
        )
    }
    return value
}

/**
 * `argv` is everything after the program name.
 *
 * The command comes first, before any flag, as with git and docker. That ordering is what makes the
 * parse unambiguous: flag semantics depend on the command's spec, so the command has to be known
 * before a single flag can be interpreted.
 */
export function parse(argv: readonly string[]): ParseResult {
    const head = argv[0]

    if (head === undefined) return { kind: "usage" }

    if (head.startsWith("-")) {
        // No command. Only the global flags can appear here, and only two of them do anything.
        const globals = new Set(
            GLOBAL_FLAGS.flatMap((flag) =>
                flag.short === undefined
                    ? [`--${flag.name}`]
                    : [`--${flag.name}`, `-${flag.short}`],
            ),
        )
        const unknown = argv.filter((token) => !globals.has(token))
        if (unknown.length > 0) {
            throw usage([
                detail(
                    "cli_no_command",
                    "No command given.",
                    `Run \`${BRAND.slug} --help\` for the command list. Commands are ${COMMANDS.map((c) => c.name).join(", ")}.`,
                    unknown[0],
                ),
            ])
        }
        if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" }
        if (argv.includes("--help") || argv.includes("-h")) {
            return { kind: "help", command: undefined }
        }
        return { kind: "usage" }
    }

    const command = findCommand(head)
    if (command === undefined) {
        const suggestion = nearest(
            head,
            COMMANDS.map((c) => c.name),
        )
        throw usage([
            detail(
                "cli_unknown_command",
                `Unknown command "${head}".`,
                suggestion === undefined
                    ? `Run \`${BRAND.slug} --help\` for the command list.`
                    : `Did you mean "${suggestion}"? Run \`${BRAND.slug} --help\` for the full list.`,
                head,
            ),
        ])
    }

    const specs = new Map(flagsFor(command).map((flag) => [flag.name, flag]))
    const shorts = new Map(
        flagsFor(command)
            .filter((flag) => flag.short !== undefined)
            .map((flag) => [flag.short as string, flag]),
    )

    const values = new Map<string, FlagValue>()
    const positionals: string[] = []
    const errors: ErrorDetail[] = []
    let terminated = false

    const setValue = (spec: FlagSpec, raw: string, written: string): void => {
        if (raw === "") {
            errors.push(
                detail(
                    "cli_flag_empty_value",
                    `${written} was given an empty value.`,
                    "Pass a value, or drop the flag entirely to use the default.",
                    written,
                ),
            )
            return
        }
        if (spec.kind === "number") {
            const result = readNumber(spec, raw, written)
            if (typeof result === "number") values.set(spec.name, result)
            else errors.push(result)
            return
        }
        values.set(spec.name, raw)
    }

    for (let i = 1; i < argv.length; i += 1) {
        const token = argv[i]
        if (token === undefined) continue

        if (terminated) {
            positionals.push(token)
            continue
        }
        if (token === "--") {
            terminated = true
            continue
        }

        if (token.startsWith("--")) {
            const body = token.slice(2)
            const eq = body.indexOf("=")
            const name = eq === -1 ? body : body.slice(0, eq)
            const spec = specs.get(name)

            if (spec === undefined) {
                const elsewhere = commandsAccepting(name, command.name)
                const suggestion = nearest(name, [...specs.keys()])
                errors.push(
                    detail(
                        elsewhere.length > 0 ? "cli_flag_wrong_command" : "cli_unknown_flag",
                        elsewhere.length > 0
                            ? `${command.name} does not accept --${name}.`
                            : `Unknown flag --${name}.`,
                        elsewhere.length > 0
                            ? `--${name} is accepted by: ${elsewhere.join(", ")}.`
                            : suggestion === undefined
                              ? `Run \`${BRAND.slug} ${command.name} --help\` for the flags this command accepts.`
                              : `Did you mean --${suggestion}?`,
                        `--${name}`,
                    ),
                )
                continue
            }

            const written = `--${name}`

            if (spec.kind === "boolean") {
                if (eq !== -1) {
                    errors.push(
                        detail(
                            "cli_flag_takes_no_value",
                            `${written} is a switch and takes no value.`,
                            `Drop the "=${body.slice(eq + 1)}" — pass ${written} on its own.`,
                            written,
                        ),
                    )
                    continue
                }
                values.set(spec.name, true)
                continue
            }

            if (eq !== -1) {
                setValue(spec, body.slice(eq + 1), written)
                continue
            }

            // Consume the next token unconditionally. This is the fix for the swallowed-value bug:
            // whether a token is a value is decided by the spec, never by whether it starts with a
            // dash. `--input -5` means the text "-5".
            const next = argv[i + 1]
            // Unless the spec declares a bare form, in which case a missing token or one starting with a
            // dash means the flag was written on its own. Opt-in per flag, because the inversion is only
            // safe for a field whose values cannot start with a dash — see `FlagSpec.bare`.
            if (spec.bare !== undefined && (next === undefined || next.startsWith("-"))) {
                values.set(spec.name, spec.bare)
                continue
            }
            if (next === undefined) {
                errors.push(
                    detail(
                        "cli_flag_needs_value",
                        `${written} needs a value.`,
                        `Pass one, as in ${written} <${spec.placeholder ?? "value"}>.`,
                        written,
                    ),
                )
                continue
            }
            setValue(spec, next, written)
            i += 1
            continue
        }

        if (token.startsWith("-") && token.length > 1) {
            // Short flags cluster only when every letter is a switch. Anything else is ambiguous
            // about which flag the trailing text belongs to, and guessing is how values get lost.
            for (const letter of [...token.slice(1)]) {
                const spec = shorts.get(letter)
                if (spec === undefined) {
                    errors.push(
                        detail(
                            "cli_unknown_flag",
                            `Unknown flag -${letter}.`,
                            `Run \`${BRAND.slug} ${command.name} --help\` for the flags this command accepts.`,
                            `-${letter}`,
                        ),
                    )
                    continue
                }
                if (spec.kind !== "boolean") {
                    errors.push(
                        detail(
                            "cli_short_flag_needs_value",
                            `-${letter} takes a value and cannot be bundled.`,
                            `Write it on its own: --${spec.name} <${spec.placeholder ?? "value"}>.`,
                            `-${letter}`,
                        ),
                    )
                    continue
                }
                values.set(spec.name, true)
            }
            continue
        }

        positionals.push(token)
    }

    // Help wins over argument checking. Asking how to use a command you invoked wrongly is the most
    // likely next thing you want, and refusing to answer would be perverse.
    const flags = new Values(values, specs)
    if (flags.bool("help")) return { kind: "help", command }
    if (flags.bool("version")) return { kind: "version" }

    // Positional counting is only meaningful once every flag parsed. An unknown flag cannot consume
    // its value — the kind is unknown — so the orphan lands here as a positional, and reporting
    // "takes 1 argument, got 2" alongside the real mistake sends the reader looking in the wrong
    // place. Report causes, never their consequences.
    const variadic = command.args.some((arg) => arg.variadic === true)
    const required = command.args.filter((arg) => arg.required)
    if (errors.length > 0) {
        throw usage(errors)
    } else if (positionals.length < required.length) {
        const missing = required[positionals.length]
        errors.push(
            detail(
                "cli_missing_argument",
                `${command.name} needs ${missing === undefined ? "another argument" : `a ${missing.name}`}.`,
                `Usage: ${BRAND.slug} ${command.name} ${command.args.map((a) => `<${a.name}${a.variadic === true ? "..." : ""}>`).join(" ")}`,
            ),
        )
    } else if (!variadic && positionals.length > command.args.length) {
        const extra = positionals.slice(command.args.length)
        errors.push(
            detail(
                "cli_unexpected_argument",
                `${command.name} takes ${command.args.length} argument(s), got ${positionals.length}.`,
                command.unexpectedArgHint ??
                    `Unexpected: ${extra.join(" ")}. Quote a value containing spaces.`,
            ),
        )
    }

    if (errors.length > 0) throw usage(errors)

    return { kind: "command", parsed: { command, positionals, flags } }
}
