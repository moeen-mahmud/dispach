/**
 * `init [dir]` — one command from installed binary to an agent that answers.
 *
 * Interactive at a terminal, flag-driven everywhere else, and the same flow either way: the
 * questions live in `lib/init-flow.ts` as pure data, this file just asks them. Non-interactive
 * runs (`--yes`, a pipe, CI) take each question's default and refuse — naming the missing flags —
 * when a question has none, because inventing an agent name is not a default, it is a guess.
 *
 * Nothing is written over an existing file, there is no `--force`, and the wizard never asks for
 * the API key itself: typing a secret into a prompt invites shoulder-surfing, and passing one as
 * a flag writes it into shell history. The generated `.env` carries an empty `KEY=` line and the
 * next-steps block says to fill it.
 *
 * Before exiting 0 the generated directory is validated with the *real* loader — the same
 * sequence `validate` runs — so a template bug is this command's failure, never the user's first.
 */

import { basename, dirname, join, resolve } from "node:path"
import {
    BRAND,
    HarnessError,
    loadManifest,
    resolveCapabilities,
    resolveWorkspace,
    ruleBudgetFailure,
    VERSION,
} from "@dispach/core"
import { installRefs } from "#browse"
import { daemonCommand } from "#daemon"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { markTerminalDirty, onExit } from "#lib/exit"
import {
    COMPOSIO_KEY_ENV,
    composioEnabled,
    type InitAnswers,
    type InitStep,
    planFiles,
    type QuestionDefaults,
    SKILLS_CHOICES,
    slugify,
    TELEGRAM_TOKEN_ENV,
    validateAnswer,
    webBackendByValue,
} from "#lib/init-flow"
import { findAndInstallSkill } from "#lib/init-skills"
import { type PairOutcome, pairLater, pairWhatsApp } from "#lib/init-whatsapp"
import { negotiateKeyboard } from "#lib/keyboard"
import { resolveModeFromProcess } from "#lib/output"
import { complete, FLAG_FOR, fillDefaults, writeAgentFiles } from "#lib/provision"
import { agentsDir, outsideSandboxNote } from "#lib/sandbox"
import type { InitOptions } from "#lib/schema"

/** Which flag supplies each step, for the refusal that names what is missing. */

export type InitResult =
    | { readonly kind: "ok"; readonly manifestPath: string }
    | { readonly kind: "aborted" }
    | { readonly kind: "failed"; readonly code: number }

/** The variable `web_search` will read, or undefined when this agent does not search. */
function searchKeyVar(answers: InitAnswers): string | undefined {
    if (answers.web !== "search") return undefined
    return webBackendByValue(answers.webBackend ?? "tavily")?.apiKeyEnv
}

export async function initCommand(options: InitOptions): Promise<number> {
    const result = await runInit(options)
    if (result.kind === "aborted") {
        process.stdout.write("nothing written\n")
        return EXIT_OK
    }
    return result.kind === "failed" ? result.code : EXIT_OK
}

/**
 * The same flow, returning the created manifest's path — the picker's "create a new agent" chains
 * straight into `run` through this, so there is exactly one wizard entry point.
 */
export async function initInteractive(options: InitOptions): Promise<InitResult> {
    return runInit(options)
}

async function runInit(options: InitOptions): Promise<InitResult> {
    const partial = fromFlags(options)

    // Interactive only when `run` would have rendered rich: both streams are terminals and
    // nothing (CI, NO_COLOR, --plain, a dumb TERM) asked for scriptable behaviour. `--yes` opts
    // out even at a terminal.
    const decision = resolveModeFromProcess({
        json: false,
        plain: options.plain === true,
        oneShot: false,
    })
    const interactive = decision.mode === "rich" && options.yes !== true

    // The dir question defaults into the home sandbox, computed here because the flow module is
    // pure and may not touch the filesystem or environment. An explicit [dir] still overrides.
    const defaults = { agentDirBase: agentsDir() }

    if (interactive) {
        // The Ink wizard, lazily — the renderer must never be paid for by a flag-driven run.
        // Its confirm screen replaces the readline summary too: undefined means the person
        // backed out, and nothing is written.
        const collected = await runWizard(partial, defaults)
        if (collected === undefined) return { kind: "aborted" }
        Object.assign(partial, collected)
    } else {
        fillDefaults(
            partial,
            options.yes === true ? "--yes was passed" : decision.because,
            defaults,
        )
    }

    const answers = complete(partial, defaults)
    const targetDir = resolve(process.cwd(), answers.dir)

    // Said before anything is written, not after: the cost of an out-of-sandbox agent is paid by
    // every later command, and the only moment it is cheap to reconsider is now. Never a refusal —
    // an agent living in a project checkout is a real thing to want, and the failure this replaces
    // was silence, not permission.
    const note = outsideSandboxNote(targetDir)
    if (note !== undefined) process.stderr.write(`${note}\n`)
    const manifestPath = join(targetDir, "agent.yaml")
    const files = planFiles(answers)

    // Per-target checks rather than "directory not empty": a fresh `git init`'d directory must
    // work, and the refusal names every collision at once rather than one per run.
    // The one writer, shared with `POST /v1/agents`. Two would be the shape this repo keeps
    // paying for: right when written, divergent at the next change, with the symptom being an
    // agent that works when created one way and not the other.
    writeAgentFiles(targetDir, files)

    // The real loader, on the real output. The one concession: when the named key var is not in
    // the environment yet — the normal case, the next-steps block is about to say "set it" — it
    // is stubbed so `validateApiKeyEnv` passes while every structural check (schema, budgets,
    // tiers, rule guard, rendering) runs for real. When the var is already exported, no stub:
    // a full honest validate.
    // Hoisted out of the try below, because installing a skill needs the same stub: a manifest written
    // sixty milliseconds ago names a key variable whose line is deliberately empty, so *every* load during
    // init has to tolerate it, not just this one.
    const keyVar = answers.apiKeyEnv
    const needsStub =
        keyVar !== undefined &&
        answers.apiKey === undefined &&
        (process.env[keyVar] === undefined || process.env[keyVar] === "")
    const envOverlay = needsStub && keyVar !== undefined ? { [keyVar]: "(pending)" } : undefined

    let distilled = false
    try {
        const loaded = loadManifest(join(targetDir, "agent.yaml"), {
            ...(needsStub ? { env: { ...process.env, [keyVar]: "(pending)" } } : {}),
        })
        const capabilities = resolveCapabilities(
            loaded.manifest.model.main.id,
            loaded.manifest.model.main.capabilities,
        )
        const { workspace, warnings } = resolveWorkspace(loaded, capabilities.promptStyle)
        const ruleFailure = ruleBudgetFailure(workspace, loaded.manifest.context.rules)
        if (ruleFailure !== undefined && loaded.manifest.context.rules.onExceed === "fail") {
            throw ruleFailure
        }
        // The gate's own verdict, read from its own warning rather than re-derived: on 3 of the
        // 4 concrete presets the compact file is what actually ships, and a done screen that did
        // not say so would leave the person editing a SOUL.md their model never reads first.
        distilled = warnings.some((warning) => warning.code === "soul_distilled")
    } catch (error) {
        // The files stay on disk — they are inspectable evidence — but the exit is a failure and
        // the loader's own report is printed verbatim. A generated agent that cannot load is this
        // command's bug, and hiding it behind exit 0 would be rule 8's exact shape.
        if (error instanceof HarnessError) {
            process.stderr.write(
                `init wrote ${files.length} files to ${targetDir}, but the result does not load:\n${error.format()}\n`,
            )
            return { kind: "failed", code: EXIT_FAILURE }
        }
        throw error
    }

    // Installed *before* the next steps are printed, so the last screen can say what happened
    // rather than instructing someone to do the thing that just happened. The first version had it
    // the other way round and read as a contradiction.
    //
    // The very first version did not install at all, reasoning that the .env would still be empty
    // and the install check would refuse. True of a scripted `--yes` run and false of the one that
    // matters: at a terminal the wizard *asks* for the bot token and writes it, so by this line the
    // agent is complete. Telling someone who just answered "yes, keep it running" to go and type
    // another command is answering a question with homework.
    //
    // Guarded rather than assumed — `daemon install` runs its own checks and refuses if something
    // is missing, and a refusal falls back to naming the command. The one outcome that must not
    // happen is a silent skip after somebody said yes.
    process.stdout.write(`wrote ${files.length} files to ${targetDir} — validated ok\n`)

    // After the load check, so a skill is only ever added to an agent already known to be valid; before
    // the service install, so what gets started is the finished agent rather than one a skill lands in a
    // second later. Cannot fail the init: every failure path inside reports and returns.
    //
    // Nothing is *chosen* here. At a terminal the wizard already showed the catalogue between two of its
    // questions and collected refs into `skillsPick`; this installs them, with one summary rather than one
    // report per skill. A scripted run has no picker, so `--skills "<phrase>"` ranks and installs the best
    // match instead — the same interactive/scripted split this command makes everywhere else.
    if (answers.skills === "find") {
        const refs = (answers.skillsPick ?? "")
            .split(",")
            .map((ref) => ref.trim())
            .filter((ref) => ref !== "")
        if (refs.length > 0) {
            installRefs(refs, manifestPath, {
                ...(envOverlay === undefined ? {} : { envOverlay }),
            })
        } else if (!interactive) {
            await findAndInstallSkill({
                answers,
                manifestPath,
                ...(envOverlay === undefined ? {} : { envOverlay }),
            })
        }
    }

    /**
     * Pair WhatsApp here, while the person who typed the number is still sitting at the terminal.
     *
     * After the skills install so the agent is complete, before the service install so what gets
     * started is an agent whose channel is already linked. It cannot fail the init — every path
     * inside reports and returns — and it is **skipped without a terminal**, because a scripted run
     * has nobody to read a code and opening a socket to WhatsApp in CI is the expensive default the
     * wizard's fallback rule exists to prevent.
     */
    let paired: PairOutcome | undefined
    if (answers.whatsapp === "connected" && (answers.whatsappNumber ?? "") !== "" && interactive) {
        paired = await pairWhatsApp({
            manifestPath,
            dir: targetDir,
            number: answers.whatsappNumber ?? "",
            channelId: "wa",
        })
    }

    let installed = false
    if (answers.daemon === "service") {
        process.stdout.write("\n")
        try {
            installed = (await daemonCommand({ action: "install", manifestPath })) === EXIT_OK
        } catch (error) {
            process.stderr.write(
                `the background service was not installed: ${
                    error instanceof HarnessError ? error.message : String(error)
                }\n`,
            )
        }
    }

    // Named only when it did not finish here, so the closing block never tells somebody to go and
    // scan a code they have already used.
    if (answers.whatsapp === "connected" && paired !== "paired")
        process.stdout.write(`\n${pairLater(slugify(answers.name))}`)
    process.stdout.write(nextSteps(answers, targetDir, distilled, installed))
    return { kind: "ok", manifestPath: join(targetDir, "agent.yaml") }
}

/**
 * `--skills` as a choice, or as a search phrase.
 *
 * `--skills starter` and `--skills none` are the choices; `--skills "pdf tables"` means "find one", with
 * those words. Told apart by membership in `SKILLS_CHOICES` rather than by shape, so the set of choices
 * stays the only thing that decides — and a phrase is never mistaken for a mistyped choice, because a
 * mistyped choice becomes a search that reports finding nothing rather than silently doing something else.
 */
function skillsPair(raw: string | undefined): [InitStep, string | undefined][] {
    if (raw === undefined) return []
    if (SKILLS_CHOICES.some((choice) => choice.value === raw)) return [["skills", raw]]
    return [
        ["skills", "find"],
        ["skillsSearch", raw],
    ]
}

/** Flag values pass the same per-step validation the wizard applies — a bad flag fails by name. */
function fromFlags(options: InitOptions): Partial<Record<InitStep, string>> {
    const given: Partial<Record<InitStep, string>> = {}
    const pairs: readonly [InitStep, string | undefined][] = [
        ["user", options.user],
        ["name", options.name],
        ["purpose", options.purpose],
        ["preset", options.preset],
        ["model", options.model],
        ["baseUrl", options.baseUrl],
        ["apiKeyEnv", options.apiKeyEnv],
        ["system", options.system],
        ["web", options.web],
        ["webBackend", options.webBackend],
        ["composio", options.composio],
        ["telegram", options.telegram],
        ["telegramAllow", options.telegramAllow],
        ["whatsapp", options.whatsapp],
        ["whatsappNumber", options.whatsappNumber],
        ["server", options.server],
        ["schedules", options.schedules],
        // `--skills` takes a choice name *or* the words to search for, and the sugar is here rather than
        // in `validateAnswer` so the per-step validation stays strict — a flag that quietly accepted
        // anything is a flag that mistypes `startr` into a search query for "startr".
        ...skillsPair(options.skills),
        ["daemon", options.daemon],
        ["dir", options.dir],
    ]
    for (const [step, raw] of pairs) {
        if (raw === undefined) continue
        const checked = validateAnswer(step, raw)
        if (!checked.ok) {
            throw new HarnessError({
                code: "cli_init_flag_invalid",
                message: `${FLAG_FOR[step]} is ${JSON.stringify(raw)}, which ${checked.reason}`,
                hint: "The flags take the same values the interactive questions do; run the command at a terminal without flags to be walked through them.",
            })
        }
        given[step] = checked.value
    }
    return given
}

/**
 * The Ink wizard, mounted lazily — the renderer must never be paid for by a flag-driven run.
 *
 * Same shape as run.ts's rich path: literal `import("ink")`, `markTerminalDirty()` before the
 * render, `exitOnCtrlC: false` (the wizard owns ^C as abort), `onExit` unmount. The component
 * calls `onDone` with the collected answers (or undefined on abort) and exits itself; the value
 * is read after `waitUntilExit`.
 */
async function runWizard(
    partial: Partial<Record<InitStep, string>>,
    defaults: QuestionDefaults,
): Promise<Partial<Record<InitStep, string>> | undefined> {
    const [{ render }, { createElement }, { WizardApp }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/WizardApp"),
    ])

    let collected: Partial<Record<InitStep, string>> | undefined
    markTerminalDirty()
    const instance = render(
        createElement(WizardApp, {
            title: `${BRAND.name} ${VERSION}`,
            given: partial,
            defaults,
            onDone: (answers) => {
                collected = answers
            },
        }),
        { exitOnCtrlC: false, ...negotiateKeyboard() },
    )
    onExit(() => instance.unmount())
    await instance.waitUntilExit()
    instance.unmount()
    return collected
}

function nextSteps(
    answers: InitAnswers,
    targetDir: string,
    distilled: boolean,
    installed = false,
): string {
    // An agent inside the sandbox runs by bare name from anywhere; anything else by path.
    const inSandbox = dirname(targetDir) === agentsDir()
    const runRef = inSandbox ? basename(targetDir) : join(targetDir, "agent.yaml")
    const manifest = join(targetDir, "agent.yaml")

    const steps: string[] = []
    // Only when there is genuinely nothing to run with. Telling someone to add a key they just
    // typed in is the kind of instruction people learn to skip past.
    if (answers.apiKeyEnv !== undefined && answers.apiKey === undefined) {
        steps.push(`Add your key: edit ${join(targetDir, ".env")} and set ${answers.apiKeyEnv}=`)
    }
    // Same rule as the model key: only when there is genuinely nothing to search with. A search
    // agent whose key is blank starts fine and fails at the first web_search naming the variable —
    // which is the right failure and a poor first impression if nobody said so here.
    const searchVar = searchKeyVar(answers)
    if (searchVar !== undefined && answers.webKey === undefined) {
        steps.push(
            `Add your search key: edit ${join(targetDir, ".env")} and set ${searchVar}= — web_fetch works without it, web_search does not`,
        )
    }
    // The key, and only the key. Discovering and connecting an app is now something to *ask the
    // agent for* rather than a setup chore — which is the whole change, so a next step telling
    // someone to go and warm a cache would be describing the flow this replaced.
    if (composioEnabled(answers) && answers.composioKey === undefined) {
        steps.push(
            `Add your Composio key: edit ${join(targetDir, ".env")} and set ${COMPOSIO_KEY_ENV}=`,
        )
    }
    // The bot token, and only when it is genuinely missing. A channel whose token is blank fails
    // the *load* — the factory reads it at boot — so this is not a first-turn surprise, it is a
    // `serve` that will not start at all.
    if (answers.telegram === "connected" && answers.telegramToken === undefined) {
        steps.push(
            `Add your bot token: message @BotFather with /newbot, then edit ` +
                `${join(targetDir, ".env")} and set ${TELEGRAM_TOKEN_ENV}=`,
        )
    }
    // `run` never starts a channel and never binds a port, so an agent configured for either has a
    // second thing to know. Said here rather than discovered — the whole reason these capabilities
    // became questions is that a generated file was hiding them. One step rather than two once the
    // service is up: "run it" and "and by the way run starts nothing" are the same sentence, and
    // printing both made steps 1 and 2 read as duplicates of each other.
    const reachable = answers.telegram === "connected" || answers.server === "local"
    const what =
        answers.telegram === "connected" && answers.server === "local"
            ? "the Telegram bot and the HTTP API"
            : answers.telegram === "connected"
              ? "the Telegram bot"
              : "the HTTP API"
    if (reachable && installed) {
        steps.push(
            `${BRAND.slug} run ${runRef} — talks to it right here. It starts no channel and binds ` +
                `no port; ${what} belongs to the service, which is already up.`,
        )
    } else {
        steps.push(`${BRAND.slug} run ${runRef}`)
    }
    if (reachable) {
        if (!installed) {
            steps.push(`${BRAND.slug} serve ${runRef} — starts ${what}; \`run\` starts neither`)
        }
        // And the half `serve` does not cover: it lives and dies with its terminal. Printed only
        // when they asked for it, and only as a command — `init` deliberately does not install,
        // because the token in step 1 is usually still missing at this moment and the check that
        // exists to catch that would refuse. A service that fails from birth is the exact failure
        // this capability was built against.
        if (answers.daemon === "service" && !installed) {
            // Only when the install did not happen. Printed unconditionally it read as a
            // contradiction — a next step telling you to run the command whose output was two
            // lines above.
            steps.push(
                `${BRAND.slug} daemon install ${runRef} — the same thing, supervised: starts at ` +
                    `login and survives a reboot. Do this once the key and token above are in .env; ` +
                    `the install checks them and refuses without them, on purpose.`,
            )
        }
    }
    if (answers.telegram === "connected" && answers.telegramAllow === undefined) {
        steps.push(
            `Message the bot. Nobody is on its allowFrom yet, so it will refuse you — and print ` +
                `the exact line to paste into agent.yaml.`,
        )
    }
    if (composioEnabled(answers)) {
        steps.push(
            `Ask it for an app — "connect my Gmail" — and it finds the tools, gives you the ` +
                `sign-in link, and pins what you need. New tools go live on the next restart.`,
        )
    }
    // Named here whatever was answered, because this is the one screen everybody reads and the sources
    // registry was otherwise reachable only by someone who already knew the word `sources`. The line
    // changes with the answer: somebody who now has a real skill wants "add another", somebody holding a
    // template wants "or take a real one", and somebody who declined wants to know the option exists.
    steps.push(
        answers.skills === "find"
            ? `Add more skills: \`${BRAND.slug} sources search <what it should do>\` ranks every skill in the catalogues, then \`${BRAND.slug} skills install ${runRef} <source>/<skill>\`.`
            : answers.skills === "starter"
              ? `Fill in workspace-level skills/starter/SKILL.md, or take a real one — \`${BRAND.slug} sources search <what it should do>\` searches 440+ from two catalogues.`
              : `Skills are off but the directory is there — \`${BRAND.slug} sources search <what it should do>\` finds one, \`${BRAND.slug} skills new ${runRef} <name>\` writes one.`,
    )
    steps.push(
        `Make workspace/SOUL.md yours, then re-derive SOUL.compact.md to match — ` +
            `\`${BRAND.slug} workspace ${manifest}\` shows exactly what still reads as a template.`,
    )

    // Said before the numbered list, because it changes what the list means: with a service
    // installed, `serve` is not something you need to run and the agent is already answering.
    const serviceNote = installed
        ? `\nit is running in the background now — \`${BRAND.slug} daemon status ${runRef}\` at any time,\nand \`${BRAND.slug} stop\` turns everything off.\n`
        : ""

    const soulNote = distilled
        ? `\nthis model ships SOUL.compact.md — the full SOUL.md needs a 200k+ window on a\nfrontier-class model, and activates automatically if you upgrade.\n`
        : ""

    return (
        `${soulNote}${serviceNote}\n` +
        steps.map((step, index) => `  ${index + 1}. ${step}\n`).join("")
    )
}
