/**
 * `init --skills find`: search the catalogues and install the best match, during setup.
 *
 * ## Why this exists
 *
 * The question used to be "starter template or empty directory", and a fresh agent asked what skills it
 * had answered — after four tool calls — that it had one, the blank template, and so "effectively zero
 * working skills". Both answers were technically the offer and neither was a skill. Meanwhile `sources
 * search` existed and nothing anywhere mentioned it: a capability reachable only by someone who already
 * knows the command name, which is decision 4.53's exact shape and the reason every capability the
 * runtime has is a question in `init`.
 *
 * ## Words, not a slug
 *
 * A slug is something you only have if you already know the catalogue, which is the state this question
 * exists to fix. So the wizard asks what the agent will do often and this ranks 440-odd real skills
 * against it with **`bm25Selector` — the same function that decides activation at runtime**. What init
 * installs is therefore what will actually fire, and a phrase that installs nothing is a phrase that
 * would have activated nothing.
 *
 * ## Three things it must not do
 *
 * Fail the init. A network that is down, no `git`, or a phrase that matches nothing all leave a valid
 * agent with an empty skills directory and a sentence saying so — never a broken agent and never a
 * silent substitution of some other answer, which would be answering a question the person did not ask.
 *
 * Reach a network on a scripted run. The `skills` fallback is `starter`, so `--yes` and every
 * non-interactive path arrive here with nothing to do. Only an explicit answer gets here.
 *
 * Leave the agent unbootable. A skill declaring Python fails at *load* on a machine without it, so the
 * catalogue is loaded once after installing and anything that breaks it is removed again. Installing a
 * skill that stops the agent starting would be strictly worse than installing none.
 */

import { rmSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import {
    bm25Selector,
    HarnessError,
    loadManifest,
    loadSkills,
    resolveCapabilities,
    type Skill,
} from "@dispach/core"
import { EXIT_OK } from "#lib/const"
import type { InitAnswers } from "#lib/init-flow"
import { forgetOrigin } from "#lib/origins"
import { scriptRunner } from "#lib/providers"
import { bullet, indent } from "#lib/render"
import {
    type CatalogueEntry,
    fetchSource,
    type Git,
    isCached,
    readCatalogue,
} from "#lib/source-cache"
import { loadSources } from "#lib/sources"
import { skillsCommand } from "#skills"

export interface FindSkillOptions {
    readonly answers: InitAnswers
    readonly manifestPath: string
    /** Layered onto the manifest environment — `init` stubs the key it has written as an empty line. */
    readonly envOverlay?: Readonly<Record<string, string | undefined>>
    /** Injected by the tests, which never reach a network. */
    readonly git?: Git
    readonly env?: Readonly<Record<string, string | undefined>>
}

/** How many alternatives are named when the top match is installed, so the choice is inspectable. */
const ALTERNATIVES = 3

export async function findAndInstallSkill(options: FindSkillOptions): Promise<void> {
    if (options.answers.skills !== "find") return
    const words = options.answers.skillsSearch?.trim() ?? ""
    if (words === "") {
        // Reachable by pressing enter through the wizard with no purpose set, since the phrase defaults
        // to the purpose. Said out loud: an answer of "yes, find one" followed by silence and an empty
        // directory is the shape hard rule 8 exists for.
        process.stdout.write(
            "\nno words to search for, so no skill was installed — `sources search <words>` when you know what you want\n",
        )
        return
    }

    const sources = loadSources(options.env)
    if (sources.length === 0) {
        process.stdout.write(
            "\nno skill sources are configured, so there was nothing to search\n\n  `sources add <url>` adds one, then `skills install <agent> <source>/<skill>`.\n",
        )
        return
    }

    process.stdout.write(
        `\nsearching ${sources.length} skill source(s) for ${JSON.stringify(words)}\n`,
    )
    const entries: CatalogueEntry[] = []
    const unreachable: string[] = []
    for (const spec of sources) {
        if (!isCached(spec.name, options.env)) {
            try {
                await fetchSource(spec, {
                    ...(options.env === undefined ? {} : { env: options.env }),
                    ...(options.git === undefined ? {} : { git: options.git }),
                })
            } catch (error) {
                unreachable.push(
                    `${spec.name} — ${error instanceof HarnessError ? error.message : String(error)}`,
                )
                continue
            }
        }
        entries.push(...readCatalogue(spec, options.env))
    }
    for (const line of unreachable) process.stdout.write(indent(`could not fetch ${line}\n`))

    if (entries.length === 0) {
        process.stdout.write(
            `${indent("no source could be read, so no skill was installed — the directory is there and empty")}\n${indent("`sources update` reports why; `sources search <words>` when it works", 4)}\n`,
        )
        return
    }

    const ranked = rank(words, entries)
    if (ranked.length === 0) {
        process.stdout.write(
            `${indent(`nothing in ${entries.length} skills matches those words, so none was installed`)}\n${indent("the ranking is lexical: try the words a skill's own description would use, with `sources search`", 4)}\n`,
        )
        return
    }

    const best = ranked[0] as CatalogueEntry
    const ref = `${best.source}/${best.skill}`
    process.stdout.write(`${indent(`best of ${entries.length}: ${ref}`)}\n`)
    if (ranked.length > 1) {
        // The runners-up, so the pick is inspectable rather than magic — and so a wrong first choice is
        // one `skills install` away from being fixed instead of a mystery.
        process.stdout.write(
            `${indent(
                `also matched: ${ranked
                    .slice(1, 1 + ALTERNATIVES)
                    .map((entry) => `${entry.source}/${entry.skill}`)
                    .join(", ")}`,
                4,
            )}\n`,
        )
    }
    process.stdout.write("\n")

    // The install itself is `skills install`, called rather than reimplemented: it owns the budget
    // check, the destination-name-from-frontmatter rule, the provenance record and the disclosure of
    // installed code. A second copy here would be the one that drifts.
    const code = skillsCommand({
        action: "install",
        manifestPath: options.manifestPath,
        name: ref,
        // The same registry this function just searched. Without it `install` resolves the ref against
        // the real home directory while the search read a sandbox — two different catalogues inside one
        // command, which is exactly how it failed the first time.
        ...(options.env === undefined ? {} : { sandboxEnv: options.env }),
        ...(options.envOverlay === undefined ? {} : { envOverlay: options.envOverlay }),
    })
    if (code !== EXIT_OK) return

    const broke = brokenBy(options.manifestPath, options.envOverlay)
    if (broke !== undefined) {
        // Removed rather than left with a warning. A skill that fails the load means the agent does not
        // start at all, and finishing init by handing someone an agent that cannot boot — with the fix
        // being "delete the thing init just installed" — is worse than installing nothing.
        rollback(options.manifestPath, best.skill, options.envOverlay)
        process.stdout.write(
            `\n${bullet(`${ref} was removed again: it does not load on this machine`)}\n${indent(broke, 4)}\n${indent("everything else is fine; `sources search` for one that needs no extra runtime", 4)}\n`,
        )
    }
}

function rank(words: string, entries: readonly CatalogueEntry[]): readonly CatalogueEntry[] {
    const byKey = new Map<string, CatalogueEntry>()
    const skills: Skill[] = entries
        .filter((entry) => entry.problem === undefined)
        .map((entry) => {
            const key = `${entry.source}/${entry.skill}`
            byKey.set(key, entry)
            return {
                name: key,
                dir: entry.dir,
                tokens: entry.tokens,
                scripts: [],
                ignoredScripts: [],
                frontmatter: { name: key, description: entry.description, metadata: {} },
            }
        })
    return bm25Selector(words, skills)
        .filter((scored) => scored.score > 0)
        .map((scored) => byKey.get(scored.skill.name))
        .filter((entry): entry is CatalogueEntry => entry !== undefined)
}

/**
 * The message a freshly-installed skill would fail the agent's boot with, or `undefined`.
 *
 * `loadSkills` rather than `validate`: the two ask different questions, and a missing interpreter is
 * invisible to the manifest loader — it is the *catalogue* scan that probes for `python3` and refuses.
 */
function brokenBy(
    manifestPath: string,
    envOverlay?: Readonly<Record<string, string | undefined>>,
): string | undefined {
    try {
        const loaded = loadManifest(manifestPath, {
            // Or an unfilled key is reported as the freshly-installed skill's fault, and the skill is
            // rolled back for something that has nothing to do with it.
            ...(envOverlay === undefined ? {} : { env: { ...process.env, ...envOverlay } }),
        })
        const configured = loaded.manifest.skills
        if (configured === undefined) return undefined
        const capabilities = resolveCapabilities(
            loaded.manifest.model.main.id,
            loaded.manifest.model.main.capabilities,
        )
        loadSkills({
            dir: isAbsolute(configured.dir) ? configured.dir : resolve(loaded.dir, configured.dir),
            maxActive: configured.maxActive,
            threshold: configured.threshold,
            style: capabilities.promptStyle,
            agentDir: loaded.dir,
            runner: scriptRunner(),
        })
        return undefined
    } catch (error) {
        return error instanceof HarnessError ? error.message : String(error)
    }
}

function rollback(
    manifestPath: string,
    name: string,
    envOverlay?: Readonly<Record<string, string | undefined>>,
): void {
    try {
        const loaded = loadManifest(manifestPath, {
            ...(envOverlay === undefined ? {} : { env: { ...process.env, ...envOverlay } }),
        })
        const configured = loaded.manifest.skills
        if (configured === undefined) return
        const dir = isAbsolute(configured.dir)
            ? configured.dir
            : resolve(loaded.dir, configured.dir)
        rmSync(join(dir, name), { recursive: true, force: true })
        forgetOrigin(dir, name)
    } catch {
        // The caller is already reporting a failure and naming the skill; a second failure here would
        // replace that report with a stack trace about cleanup.
    }
}
