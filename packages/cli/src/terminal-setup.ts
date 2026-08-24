/**
 * `terminal-setup` — teach this terminal to send shift+enter.
 *
 * The one command in this binary that edits a file outside the workspace and outside the sandbox. So the
 * rules are stricter than anywhere else, and they are the rules the plan set:
 *
 * 1. **Show the change before making it.** The file and the exact line, printed.
 * 2. **Ask, unless told not to.** `--yes` skips the question, `--dry-run` writes nothing at all.
 * 3. **Back the file up first**, beside itself, so an unwanted change is one `mv` from undone.
 * 4. **Never rewrite a file it cannot parse.** For VS Code that means valid JSON; a config it does not
 *    understand is reported and left alone, because a broken keybindings file is a worse outcome than
 *    an unconfigured chord.
 *
 * A terminal whose configuration is a binary plist is *explained* rather than written — see
 * `lib/terminal.ts` for why writing one would report success and change nothing.
 *
 * None of this is required to use the runtime: ⌥⏎ works everywhere without it.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BRAND } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { bullet, indent, keyValue, section, tildify } from "#lib/render"
import {
    alreadyConfigured,
    detectTerminal,
    knownTerminals,
    recipeFor,
    type TerminalRecipe,
    withBinding,
} from "#lib/terminal"

export interface TerminalSetupOptions {
    readonly dryRun?: boolean
    readonly yes?: boolean
    readonly json?: boolean
    /** Injected by tests; the process environment otherwise. */
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Injected by tests, so no test writes into a real home directory. */
    readonly home?: string
    /** Asks the question. Absent means non-interactive, which is treated as "no". */
    readonly confirm?: (question: string) => Promise<boolean>
}

export async function terminalSetupCommand(options: TerminalSetupOptions): Promise<number> {
    const env = options.env ?? ambientEnv([])
    const home = options.home ?? env.HOME ?? ""
    const id = detectTerminal(env)
    const recipe = recipeFor(id)

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    terminal: id,
                    how: recipe?.how ?? "unknown",
                    configPath:
                        recipe?.configPath === undefined
                            ? undefined
                            : join(home, recipe.configPath),
                    line: recipe?.line,
                    steps: recipe?.steps,
                },
                null,
                2,
            )}\n`,
        )
        return recipe === undefined ? EXIT_FAILURE : EXIT_OK
    }

    process.stdout.write(
        `${section("shift+enter", true)}\n${indent(
            `⌥ or ⇧ ⏎ already puts a new line in a message, everywhere, with no setup. This command is for shift+⏎, which a terminal can only send once it has been given a key binding.`,
        )}\n`,
    )

    if (recipe === undefined) {
        // Named rather than guessed at. A wrong guess would write a binding into a file the terminal
        // never reads, and then report that shift+enter works.
        process.stdout.write(
            `\n${section("this terminal was not recognised")}\n${indent(
                `TERM_PROGRAM=${env.TERM_PROGRAM ?? "(unset)"} TERM=${env.TERM ?? "(unset)"}`,
            )}\n${indent(
                `known: ${knownTerminals()
                    .map((known) => known.name)
                    .join(", ")}`,
            )}\n${bullet("⌥⏎ works here regardless — nothing needs configuring for it")}\n`,
        )
        return EXIT_FAILURE
    }

    process.stdout.write(`\n${section(recipe.name)}\n`)

    if (recipe.how !== "write") {
        process.stdout.write(
            `${indent(
                recipe.how === "unverified"
                    ? `no verified recipe for this one — ${recipe.reason ?? "nobody has checked it"}`
                    : `this one has to be done by hand — ${recipe.reason ?? "its settings are not a text file"}`,
            )}\n\n`,
        )
        for (const [at, step] of (recipe.steps ?? []).entries()) {
            process.stdout.write(`${indent(`${at + 1}. ${step}`)}\n`)
        }
        process.stdout.write(
            recipe.how === "unverified"
                ? `\n${bullet("⌥⏎ works here today — nothing has to be configured for it")}\n`
                : `\n${bullet("then restart the terminal and press shift+⏎ in a session to check it")}\n`,
        )
        // Zero either way: being told exactly what to do, and being told honestly that nobody has
        // checked this terminal, are both this command doing its job.
        return EXIT_OK
    }

    return await applyRecipe(recipe, { ...options, env, home })
}

async function applyRecipe(
    recipe: TerminalRecipe,
    options: TerminalSetupOptions & { readonly home: string },
): Promise<number> {
    const path = join(options.home, recipe.configPath ?? "")
    const existing = existsSync(path) ? readFileSync(path, "utf8") : ""

    if (alreadyConfigured(existing, recipe)) {
        process.stdout.write(
            `${indent("already configured — a binding for shift+enter is present")}\n${indent(
                tildify(path, options.home),
                4,
            )}\n`,
        )
        return EXIT_OK
    }

    const updated = withBinding(existing, recipe)
    if (updated === undefined) {
        // The file exists and is not the shape this knows how to edit. Reported, never guessed at.
        process.stdout.write(
            `${indent(`this file is not in a shape this command can edit safely:`)}\n${indent(
                tildify(path, options.home),
                4,
            )}\n${bullet("add the line below by hand:")}\n${indent(recipe.line ?? "", 4)}\n`,
        )
        return EXIT_FAILURE
    }

    process.stdout.write(
        `${keyValue([
            { label: "file", value: tildify(path, options.home) },
            { label: "exists", value: existing === "" ? "no — it will be created" : "yes" },
            { label: "add", value: recipe.line ?? "" },
        ])}\n`,
    )

    if (options.dryRun === true) {
        process.stdout.write(`\n${bullet("--dry-run: nothing was written")}\n`)
        return EXIT_OK
    }

    if (options.yes !== true) {
        const confirmed =
            options.confirm === undefined ? false : await options.confirm("write this change?")
        if (!confirmed) {
            // Not an error: declining is a legitimate answer, and the line is on screen to copy.
            process.stdout.write(`\n${bullet("nothing was written")}\n`)
            return EXIT_OK
        }
    }

    try {
        mkdirSync(dirname(path), { recursive: true })
        if (existing !== "") {
            // Beside the file rather than in a temp directory, so it is found by whoever goes looking.
            copyFileSync(path, `${path}.${BRAND.slug}-backup`)
        }
        writeFileSync(path, updated, "utf8")
    } catch (error) {
        process.stderr.write(
            `could not write ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        return EXIT_FAILURE
    }

    process.stdout.write(
        `\n${section("done")}\n${
            existing === ""
                ? ""
                : `${indent(`a copy of the old file is at ${tildify(`${path}.${BRAND.slug}-backup`, options.home)}`)}\n`
        }${bullet("restart the terminal, then press shift+⏎ in a session to check it")}\n`,
    )
    return EXIT_OK
}
