/**
 * `skills list|show|validate <manifest>` — what this agent knows how to do, and how well it is written.
 *
 * Three questions, deliberately not one command. `list` is the inventory, `show` is one skill in full —
 * including the parts the model never sees, which is the only way to check what it *will* see — and
 * `validate` is the authoring read.
 *
 * `validate` warns and exits 0, with `--strict` for CI. That is the `workspace` split rather than the
 * `validate` one: a skill that does not load already fails here loudly, because this calls the same
 * `loadSkills` the runtime does, and everything past that is a judgement. In particular a missing
 * when-not-to-use is a warning and never a refusal — requiring it would reject every skill vendored from
 * `anthropics/skills` and withdraw decision 6.1's compliance claim to buy a nag.
 *
 * A `ScriptRunner` is supplied here for the same reason `run` supplies one: without it a skill's
 * `scripts/` is never scanned, so `skills list` would report "no scripts" for a skill that ships three.
 * The command answers about the runtime, not about a subset of it.
 */

import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import {
    checkSkillAuthoring,
    type ErrorDetail,
    editManifestSync,
    HarnessError,
    isSkillName,
    loadManifest,
    loadSkills,
    nearest,
    parseSkillFile,
    resolveCapabilities,
    type Skill,
    type SkillsConfig,
    whenNotToUseKey,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { forgetOrigin, type Origin, readOrigins, recordOrigins } from "#lib/origins"
import { scriptRunner } from "#lib/providers"
import { bullet, indent, keyValue, section } from "#lib/render"
import {
    type CatalogueEntry,
    isCached,
    looksLikePath,
    readCatalogue,
    readMeta,
} from "#lib/source-cache"
import { loadSources, parseSkillRef, type SkillRef, type SourceSpec } from "#lib/sources"
import { fillTemplate, SKILL_TEMPLATE } from "#lib/templates"

/** A skill found in a fetched source, with everything provenance needs. */
interface Located {
    readonly entry: CatalogueEntry
    readonly spec: SourceSpec
    readonly commit: string
}

const SKILL_FILE = "SKILL.md"

/**
 * The actions this command accepts, pinned so `--help` and the switch below cannot drift.
 *
 * The same guard `DAEMON_ACTIONS` gets: a verb added in one place and not the other fails a test rather
 * than at the moment somebody types it.
 */
export const SKILLS_ACTIONS = ["list", "show", "new", "install", "remove", "validate"] as const

export interface SkillsOptions {
    readonly manifestPath: string
    /** `list`, `show` or `validate`. Checked by the dispatcher against the spec's `choices`. */
    readonly action: string
    /**
     * The skill `show`, `new` and `remove` act on — or, for `install`, the directory to copy from.
     *
     * One positional rather than three, because the parser has one slot after the manifest and a
     * command with `--name`, `--from` and `--skill` flags reads worse than the thing it replaced.
     */
    readonly name?: string
    readonly json?: boolean
    /** `validate` only: exit non-zero when anything was reported. */
    readonly strict?: boolean
    /**
     * The `<ENVPREFIX>HOME` override that says where the source registry and cache live.
     *
     * Deliberately **not** the manifest environment — that one is `ambientEnv` below and answers "which
     * model, which key". This one answers "which `sources.json`", and it exists because `install` resolves
     * a `<source>/<skill>` ref against it: without the field, this command read the real home directory
     * while its caller read a sandbox, so an install driven from a test or from `init` looked up a
     * registry nobody had written to and reported `no source called test` on a source that plainly existed.
     */
    readonly sandboxEnv?: Readonly<Record<string, string | undefined>>
    /**
     * Extra variables layered on top of the resolved manifest environment.
     *
     * One caller: `init`, which stubs the API key variable it has just written as an empty line. Without
     * it, installing a skill during setup failed with `model.main.apiKeyEnv names MODEL_API_KEY, which is
     * not set` — correct, useless, and about a key nobody could have filled in yet. `init`'s own load
     * check has always done this; the command it calls needed the same courtesy.
     */
    readonly envOverlay?: Readonly<Record<string, string | undefined>>
    /**
     * Report nothing and let the caller summarise. Set by a batch install.
     *
     * Eleven ticked skills produced **eleven** `from/installed/this installed code/next` blocks — a screenful
     * of repeated narrative for one action, which is what "the TUI should be everything" was objecting to.
     * The per-skill report is right for `skills install <one>` and wrong the moment there are eleven, so the
     * caller decides. `collect` is how it gets the facts it needs to write one summary instead.
     */
    readonly quiet?: boolean
    /** Appended to, when given: what happened to each skill this call touched. */
    readonly collect?: InstallOutcome[]
}

/** What one install did, for a caller aggregating several. */
export interface InstallOutcome {
    readonly name: string
    readonly ok: boolean
    /** Why not, when `ok` is false. */
    readonly reason?: string
    /** Files that would run, relative to the skills directory. */
    readonly runnable: readonly string[]
}

export function skillsCommand(options: SkillsOptions): number {
    try {
        const loaded = loadManifest(options.manifestPath, {
            // The same environment `run` uses, or this reports on a different agent — the asymmetry
            // every command that loads a manifest exists to avoid.
            env: { ...ambientEnv([options.manifestPath]), ...options.envOverlay },
        })

        // `new` and `install` are the two that may run with nothing configured — turning skills on is
        // exactly what they are for, so they do it rather than reporting that it has not been done.
        const creating = options.action === "new" || options.action === "install"
        const configured = creating
            ? enable(loaded.path, loaded.dir, loaded.manifest.skills)
            : loaded.manifest.skills
        if (configured === undefined) {
            return unconfigured(options)
        }

        const capabilities = resolveCapabilities(
            loaded.manifest.model.main.id,
            loaded.manifest.model.main.capabilities,
        )
        const resolvedDir = isAbsolute(configured.dir)
            ? configured.dir
            : resolve(loaded.dir, configured.dir)

        // `new` and `remove` run **before** the catalogue is loaded, and that ordering is the fix for a
        // dead end this command had: a skill over `skills.budget` fails the load, so with `remove` behind
        // `loadSkills` the one command that could undo it was the one that could not run. Neither needs a
        // catalogue — one writes a directory, the other deletes one — so neither waits for it.
        if (options.action === "new") return create(resolvedDir, options)
        if (options.action === "remove") return remove(resolvedDir, options)

        const catalogue = loadSkills({
            dir: resolvedDir,
            maxActive: configured.maxActive,
            threshold: configured.threshold,
            style: capabilities.promptStyle,
            agentDir: loaded.dir,
            runner: scriptRunner(),
        })

        switch (options.action) {
            case "list":
                return list(resolvedDir, catalogue.skills, catalogue, options)
            case "show":
                return show(catalogue.skills, options)
            case "install":
                return install(resolvedDir, options)
            default:
                // `validate` is the fallback rather than a named case because the parser has already
                // rejected anything outside `SKILLS_ACTIONS`, and the safest thing to do with an action
                // that somehow got through is the one that changes nothing.
                return validate(catalogue.skills, options)
        }
    } catch (error) {
        if (options.json === true && error instanceof HarnessError) {
            process.stdout.write(
                `${JSON.stringify({ ok: false, error: error.toDetail(), details: error.details }, null, 2)}\n`,
            )
            return EXIT_FAILURE
        }
        throw error
    }
}

/**
 * No `skills:` block at all.
 *
 * Not an error — an agent without skills is an ordinary agent — but it names the block, because someone
 * who typed this command was looking for something and "no skills" without a way forward is the shape
 * decision 4.53 objects to.
 */
function unconfigured(options: SkillsOptions): number {
    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ ok: true, configured: false, skills: [] }, null, 2)}\n`,
        )
        return EXIT_OK
    }
    // Two commands, not a YAML fragment. This used to print the block to add by hand, which is the
    // workaround `skills new` was built to remove — and it kept printing it for a phase after that
    // command existed, so the one place someone lands when looking for skills was the one place still
    // recommending the manual edit.
    process.stdout.write(
        "this agent has no skills configured\n\n" +
            "  · find one and install it — searches the catalogues, 440+ skills:\n" +
            "      sources search <what it should do>\n" +
            `      skills install ${options.manifestPath} <source>/<skill>\n\n` +
            "  · or write your own from a template:\n" +
            `      skills new ${options.manifestPath} <name>\n\n` +
            "  either one turns skills on for this agent; neither needs agent.yaml edited by hand\n",
    )
    return EXIT_OK
}

function list(
    dir: string,
    skills: readonly Skill[],
    catalogue: {
        readonly maxActive: number
        readonly threshold: number
        readonly cached: boolean
    },
    options: SkillsOptions,
): number {
    // Read here rather than inside the loop: one file for the whole directory, and a listing that opened
    // it per skill would be doing filesystem work proportional to a catalogue it already has in memory.
    const origins = readOrigins(dir)
    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    ok: true,
                    configured: true,
                    cached: catalogue.cached,
                    maxActive: catalogue.maxActive,
                    threshold: catalogue.threshold,
                    skills: skills.map((skill) => ({
                        ...summarise(skill),
                        ...(origins[skill.name] === undefined
                            ? {}
                            : { origin: origins[skill.name] }),
                    })),
                },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    if (skills.length === 0) {
        process.stdout.write(
            `no skills in ${dir}\n\n  \`sources search <what it should do>\` ranks 440+ from the configured catalogues, then\n  \`skills install <agent> <source>/<skill>\`. \`skills new <agent> <name>\` writes one from a template.\n`,
        )
        return EXIT_OK
    }

    process.stdout.write(
        `${keyValue([
            { label: "skills", value: String(skills.length) },
            { label: "per turn", value: `at most ${catalogue.maxActive}` },
            { label: "threshold", value: catalogue.threshold.toFixed(2) },
            { label: "index", value: catalogue.cached ? "cached" : "scanned" },
        ])}\n`,
    )

    process.stdout.write(`${section("catalogue")}\n`)
    for (const skill of skills) {
        const scripts = skill.scripts.length === 0 ? "" : `  ${skill.scripts.length} script(s)`
        // A missing negative guidance is flagged even in `list`, because it is the one thing that is
        // both cheap to fix and invisible until something routes wrongly.
        const gap = skill.frontmatter.whenNotToUse === undefined ? "  no when-not-to-use" : ""
        // Where it came from, on the line that lists it. The origins file is hidden by a leading dot to
        // stay out of the way; that must not make it hidden *information*.
        const origin = origins[skill.name]
        const from = origin === undefined ? "" : `  ${origin.source}@${origin.commit}`
        process.stdout.write(
            `  ${skill.name.padEnd(20)} ${String(skill.tokens).padStart(5)} tokens${scripts}${from}${gap}\n`,
        )
    }
    return EXIT_OK
}

function show(skills: readonly Skill[], options: SkillsOptions): number {
    const wanted = options.name
    if (wanted === undefined) {
        process.stdout.write("skills show needs a skill name — `skills list` names them\n")
        return EXIT_FAILURE
    }
    const skill = skills.find((entry) => entry.name === wanted)
    if (skill === undefined) {
        const known = skills.map((entry) => entry.name).join(", ")
        process.stdout.write(`no skill named ${wanted}${known === "" ? "" : `. Known: ${known}`}\n`)
        return EXIT_FAILURE
    }

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, skill: detail(skill) }, null, 2)}\n`)
        return EXIT_OK
    }

    const { frontmatter } = skill
    process.stdout.write(
        `${keyValue([
            { label: "name", value: skill.name },
            { label: "directory", value: skill.dir },
            { label: "body", value: `${skill.tokens} tokens` },
            ...(frontmatter.license === undefined
                ? []
                : [{ label: "license", value: frontmatter.license }]),
            ...(frontmatter.compatibility === undefined
                ? []
                : [{ label: "needs", value: frontmatter.compatibility }]),
        ])}\n`,
    )

    process.stdout.write(`${section("description")}\n`)
    process.stdout.write(`${indent(frontmatter.description)}\n`)

    process.stdout.write(`${section("when not to use")}\n`)
    process.stdout.write(
        `${indent(
            frontmatter.whenNotToUse ??
                `not declared — add metadata.${whenNotToUseKey()} to improve routing`,
        )}\n`,
    )

    if (skill.scripts.length > 0) {
        process.stdout.write(`${section("scripts")}\n`)
        for (const plan of skill.scripts) {
            process.stdout.write(
                `${bullet(`${plan.slug} — scripts/${plan.file} via ${plan.interpreter ?? "its own shebang"}`)}\n`,
            )
        }
    }

    if (skill.ignoredScripts.length > 0) {
        process.stdout.write(`${section("in scripts/ and not runnable")}\n`)
        for (const ignored of skill.ignoredScripts) {
            process.stdout.write(`${bullet(`${ignored.file} — ${ignored.reason}`)}\n`)
        }
    }

    if (frontmatter.allowedTools !== undefined) {
        process.stdout.write(`${section("allowed-tools, declared and not honoured")}\n`)
        // Printed rather than ignored, and labelled rather than merely printed. A downloaded folder does
        // not widen what this agent may run — that is `tools.policy`, and only a person edits it.
        process.stdout.write(`${indent(frontmatter.allowedTools)}\n`)
        process.stdout.write(
            `${indent("this runtime reads the field and never acts on it; permissions live in tools.policy")}\n`,
        )
    }

    const extra = Object.entries(frontmatter.metadata).filter(([key]) => key !== whenNotToUseKey())
    if (extra.length > 0) {
        process.stdout.write(`${section("metadata")}\n`)
        process.stdout.write(`${keyValue(extra.map(([label, value]) => ({ label, value })))}\n`)
    }

    return EXIT_OK
}

function validate(skills: readonly Skill[], options: SkillsOptions): number {
    const findings = checkSkillAuthoring(skills)

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                { ok: findings.length === 0, skills: skills.map(summarise), findings },
                null,
                2,
            )}\n`,
        )
        return options.strict === true && findings.length > 0 ? EXIT_FAILURE : EXIT_OK
    }

    // Every skill is named whether or not it has findings, so a clean one is visibly checked rather
    // than merely absent from a list of problems.
    const byName = new Map<string, ErrorDetail[]>()
    for (const finding of findings) {
        const name = skills.find((skill) => finding.message.includes(` ${skill.name}:`))?.name
        const key = name ?? ""
        byName.set(key, [...(byName.get(key) ?? []), finding])
    }

    for (const skill of skills) {
        const own = byName.get(skill.name) ?? []
        process.stdout.write(
            `  ${skill.name.padEnd(20)} ${own.length === 0 ? "ok" : `${own.length} warning(s)`}\n`,
        )
    }

    if (findings.length === 0) {
        process.stdout.write("\nno findings\n")
        return EXIT_OK
    }

    for (const finding of findings) {
        process.stdout.write(`\n  ${finding.code}: ${finding.message}\n`)
        process.stdout.write(`    hint: ${finding.hint}\n`)
    }
    process.stdout.write(
        `\n${findings.length} finding(s) — warnings, not failures. --strict exits non-zero.\n`,
    )
    return options.strict === true ? EXIT_FAILURE : EXIT_OK
}

function summarise(skill: Skill) {
    return {
        name: skill.name,
        tokens: skill.tokens,
        hasWhenNotToUse: skill.frontmatter.whenNotToUse !== undefined,
        scripts: skill.scripts.map((plan) => plan.slug),
        ignoredScripts: skill.ignoredScripts,
    }
}

function detail(skill: Skill) {
    return {
        ...summarise(skill),
        dir: skill.dir,
        description: skill.frontmatter.description,
        ...(skill.frontmatter.whenNotToUse === undefined
            ? {}
            : { whenNotToUse: skill.frontmatter.whenNotToUse }),
        ...(skill.frontmatter.license === undefined ? {} : { license: skill.frontmatter.license }),
        ...(skill.frontmatter.compatibility === undefined
            ? {}
            : { compatibility: skill.frontmatter.compatibility }),
        ...(skill.frontmatter.allowedTools === undefined
            ? {}
            : { allowedToolsDeclaredNotHonoured: skill.frontmatter.allowedTools }),
        metadata: skill.frontmatter.metadata,
    }
}

// ─── writing ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn skills on for an agent that has not got them, and return the resolved config.
 *
 * Both halves or neither: `skills.dir` naming a directory that does not exist is a **load failure**, so
 * writing the block without creating the directory would leave an agent that refuses to start. That is
 * the reason this is a command rather than a `config_set` path — the agent cannot be trusted to do two
 * things atomically, and it is exactly the shape that made `config_set` report a pending `tokenEnv`.
 *
 * The manifest goes through `editManifest`, the one writer every surface uses. It used to place the
 * block itself and write it unvalidated, on the reasoning that "the next load" would catch a bad
 * result — which is the failure that validation exists to prevent, because the next load is a person's
 * agent refusing to start after this command reported success. The block is a fixed known-good shape,
 * so nothing was ever actually broken; the *guarantee* differed by which caller you happened to be.
 *
 * The uncommenting this used to do itself is `uncommentInSource` now, reached automatically for a
 * top-level path: `setInSource` appends to a parent and `skills` has none, so it declines, and the
 * generated manifest ships the line commented under its own heading. Generalising it was worth doing —
 * `channels` needed exactly the same thing, and writing it for the first time had been reflowing 98
 * lines of somebody's manifest.
 */
function enable(
    manifestPath: string,
    agentDir: string,
    existing: SkillsConfig | undefined,
): SkillsConfig | undefined {
    const dir = existing?.dir ?? "./skills"
    const absolute = isAbsolute(dir) ? dir : resolve(agentDir, dir)
    mkdirSync(absolute, { recursive: true })

    if (existing !== undefined) return existing

    const written = editManifestSync({ file: manifestPath, path: ["skills"], value: block(dir) })
    process.stdout.write(`${keyValue([{ label: "enabled", value: `skills.dir = ${dir}` }])}\n`)
    if (written.reflowed) {
        // Said rather than swallowed. A manifest with no commented `# skills:` line to uncomment — a
        // hand-written one — goes through the round-trip, which is valid and moves comments, and
        // finding that in a later `git diff` with nothing having mentioned it is the worse outcome.
        process.stdout.write(
            `${bullet("the file was re-serialised to add the block — it is valid, and comments may have moved")}\n`,
        )
    }
    // Validated before it was written, so this is a resolved config rather than an assumption.
    return { dir, ...DEFAULTS }
}

/** Written once, so what is stored and what is printed cannot disagree. */
const DEFAULTS = { maxActive: 1, threshold: 0.35 } as const

function block(dir: string): Record<string, unknown> {
    return { dir, ...DEFAULTS }
}

function create(dir: string, options: SkillsOptions): number {
    const name = options.name
    if (name === undefined) {
        process.stdout.write("skills new needs a name — `skills new <manifest> <name>`\n")
        return EXIT_FAILURE
    }
    if (!isSkillName(name)) {
        // The spec's own rule, checked here so a scaffold the loader would refuse is never written.
        process.stdout.write(
            `${name} is not a legal skill name: lowercase letters, digits and single hyphens, never leading, trailing or doubled, at most 64 characters.\n`,
        )
        return EXIT_FAILURE
    }

    const target = join(dir, name)
    if (existsSync(target)) {
        process.stdout.write(`${target} already exists — nothing was written\n`)
        return EXIT_FAILURE
    }

    mkdirSync(target, { recursive: true })
    writeFileSync(
        join(target, "SKILL.md"),
        fillTemplate(SKILL_TEMPLATE, {
            SKILL_NAME: name,
            WHEN_NOT_TO_USE_KEY: whenNotToUseKey(),
        }),
        "utf8",
    )

    process.stdout.write(
        `${keyValue([
            { label: "created", value: join(target, "SKILL.md") },
            { label: "name", value: name },
        ])}\n`,
    )
    process.stdout.write(
        `${section("next")}\n` +
            `${bullet("edit the description — it is the only thing selection reads, so name the words someone would actually type")}\n` +
            `${bullet("write the steps in place of the placeholder body")}\n` +
            `${bullet(`skills validate — it warns until the scaffold is replaced`)}\n` +
            `${bullet("restart the agent: the catalogue is scanned once at boot")}\n`,
    )
    return EXIT_OK
}

/**
 * Copy a skill, or a directory of skills, into this agent.
 *
 * A **local path only**, and that is a decision rather than an unfinished feature. A skill may ship
 * executable scripts, so installing one from a URL is running someone else's code on this machine — a
 * thing that deserves its own decision about provenance and trust, not a flag added beside a copy
 * command. `git clone` or `gh repo clone` first, then install from the path; the network stays out of a
 * command whose job is to move files.
 *
 * Modes are preserved, because an executable bit is what makes a script runnable at all.
 */
function install(dir: string, options: SkillsOptions): number {
    const from = options.name
    if (from === undefined) {
        process.stdout.write(
            "skills install needs something to install — `skills install <manifest> anthropic/pdf`, or a local path\n\n  `sources search <what you need>` finds one.\n",
        )
        return EXIT_FAILURE
    }

    // Filesystem-first, which is git's pathspec rule and the one `resolveAgentRef` already follows: a
    // name shadowed by a directory in the cwd resolves to the directory, with a note, rather than
    // silently installing something else.
    const asPath = looksLikePath(from)
    let origin: Located | undefined
    if (!asPath) {
        const located = locate(from, options.sandboxEnv)
        if (located === undefined) return EXIT_FAILURE
        origin = located
    }

    const source = origin === undefined ? resolve(from) : origin.entry.dir
    if (origin === undefined) {
        if (!existsSync(source) || !statSync(source).isDirectory()) {
            process.stdout.write(`${source} is not a directory\n`)
            return EXIT_FAILURE
        }
        if (
            existsSync(from) &&
            loadSources(options.sandboxEnv).some((spec) => spec.name === from)
        ) {
            process.stdout.write(
                `note: ${from} is also a source, and a directory of that name here wins — \`sources search\` to install from the source instead\n\n`,
            )
        }
    }

    const origins: Record<string, Origin> = {}
    const runnable: string[] = []

    // One skill, or a folder holding several. Detected rather than flagged: `skills/` from a cloned
    // repository and a single `pdf/` are both obvious to look at, and asking which would be a question
    // the filesystem has already answered.
    const single = existsSync(join(source, SKILL_FILE))
    const candidates = single
        ? [source]
        : readdirSync(source, { withFileTypes: true })
              .filter(
                  (entry) =>
                      entry.isDirectory() && existsSync(join(source, entry.name, SKILL_FILE)),
              )
              .map((entry) => join(source, entry.name))

    if (candidates.length === 0) {
        process.stdout.write(
            `no ${SKILL_FILE} in ${source} or in any directory directly inside it\n`,
        )
        return EXIT_FAILURE
    }

    const installed: string[] = []
    const skipped: string[] = []
    for (const candidate of candidates) {
        // The destination is the skill's declared `name`, not the source folder's — the spec requires
        // them to match, so a mismatched source is a skill that would fail to load wherever it landed.
        let name: string
        try {
            const parsed = parseSkillFile(
                basename(candidate),
                readFileSync(join(candidate, SKILL_FILE), "utf8"),
            )
            name = parsed.frontmatter.name
        } catch (error) {
            skipped.push(
                `${basename(candidate)} — ${error instanceof Error ? error.message : String(error)}`,
            )
            continue
        }
        const target = join(dir, name)
        if (existsSync(target)) {
            skipped.push(`${name} — already installed at ${target}`)
            continue
        }
        // No size check. There was one, against `skills.budget`, and it is what turned a person ticking
        // eleven skills into "9 of 11 installed" — refusing `pptx` at 5,441 tokens and `skill-creator` at
        // 9,065 against a default of 5,000 they never chose. The budget is gone (decision 11.59): the
        // catalogue prints every body's size on the row where the choice is made, and a large skill that
        // somebody picked on purpose is not a configuration error.
        cpSync(candidate, target, { recursive: true, preserveTimestamps: true })
        installed.push(name)
        if (origin !== undefined) {
            origins[name] = {
                source: origin.spec.name,
                url: origin.spec.url,
                repoPath: origin.entry.repoPath,
                commit: origin.commit,
                ...(origin.spec.ref === undefined ? {} : { ref: origin.spec.ref }),
                installedAt: new Date().toISOString(),
            }
        }
        // Named, not counted. This is the only moment somebody can decide to go and read code they are
        // about to give an agent, and "3 runnable files" does not tell them which files.
        runnable.push(...scriptFiles(target).map((file) => `${name}/${relative(target, file)}`))
    }

    if (Object.keys(origins).length > 0) recordOrigins(dir, origins)

    if (options.collect !== undefined) {
        for (const name of installed) {
            options.collect.push({
                name,
                ok: true,
                runnable: runnable.filter((file) => file.startsWith(`${name}/`)),
            })
        }
        for (const entry of skipped) {
            const cut = entry.indexOf(" — ")
            options.collect.push({
                name: cut === -1 ? entry : entry.slice(0, cut),
                ok: false,
                reason: cut === -1 ? entry : entry.slice(cut + 3),
                runnable: [],
            })
        }
    }
    if (options.quiet === true) return installed.length === 0 ? EXIT_FAILURE : EXIT_OK

    process.stdout.write(
        `${keyValue([
            {
                label: "from",
                value:
                    origin === undefined
                        ? source
                        : `${origin.spec.name} (${origin.spec.url}) at ${origin.commit}`,
            },
            { label: "installed", value: installed.join(", ") },
            { label: "skipped", value: skipped.length === 0 ? "" : String(skipped.length) },
        ])}\n`,
    )
    for (const entry of skipped) process.stdout.write(`${bullet(entry)}\n`)
    if (runnable.length > 0) {
        // Disclosure rather than a prompt. Nothing runs at install time — a skill script becomes a tool
        // only once the skill activates, and it arrives `untrusted` and `mutating`, so the write gate and
        // `tools.policy` both still apply. A confirmation dialog on every install would be answered
        // reflexively within a week and would buy none of that.
        process.stdout.write(
            `${section("this installed code, which the agent can run")}\n${runnable
                .slice(0, 12)
                .map((file) => bullet(file))
                .join("\n")}\n`,
        )
        if (runnable.length > 12) {
            process.stdout.write(`${indent(`… and ${runnable.length - 12} more`)}\n`)
        }
        process.stdout.write(
            `${indent("read them before the agent does; `tools.policy` can name a skill script by slug")}\n`,
        )
    }
    if (installed.length > 0) {
        process.stdout.write(
            `${section("next")}\n${bullet("skills validate — a vendored skill usually has no negative guidance, which is a warning and not a problem")}\n${bullet("restart the agent: the catalogue is scanned once at boot")}\n`,
        )
    }
    return installed.length === 0 ? EXIT_FAILURE : EXIT_OK
}

/**
 * Turn `pdf` or `anthropic/pdf` into a folder in the source cache.
 *
 * Ambiguity is refused rather than resolved by source order: with two sources carrying a `pdf`, picking
 * the first would install one and report a name that describes both, and the person would find out which
 * they got by reading the file. Naming the candidates costs one retyped command and cannot be wrong.
 */
function locate(
    ref: string,
    env?: Readonly<Record<string, string | undefined>>,
): Located | undefined {
    let parsed: SkillRef
    try {
        parsed = parseSkillRef(ref)
    } catch (error) {
        if (!(error instanceof HarnessError)) throw error
        process.stdout.write(`${error.message}\n\n  ${error.hint}\n`)
        return undefined
    }

    const sources = loadSources(env)
    const named =
        parsed.source === undefined
            ? sources
            : sources.filter((spec) => spec.name === parsed.source)
    if (named.length === 0) {
        const suggestion = nearest(
            parsed.source ?? "",
            sources.map((spec) => spec.name),
        )
        process.stdout.write(
            `no source called ${parsed.source}\n\n  ${suggestion === undefined ? "`sources list` shows them." : `Did you mean ${suggestion}?`}\n`,
        )
        return undefined
    }

    const cold = named.filter((spec) => !isCached(spec.name, env))
    if (cold.length === named.length) {
        // The distinction that matters: an empty cache is not a mistyped name, and only this layer knows
        // which. Reporting "no skill called pdf" against a cache that has never been fetched blames the
        // person for the tool's state — the same failure `explainUnresolved` exists to prevent.
        process.stdout.write(
            `${named.length === 1 ? `${named[0]?.name} has not` : "no source has"} been fetched yet, so there is nothing to install from\n\n  \`sources update${parsed.source === undefined ? "" : ` ${parsed.source}`}\` first, or \`sources search ${parsed.skill}\` which fetches on demand.\n`,
        )
        return undefined
    }

    const entries = named
        .filter((spec) => isCached(spec.name, env))
        .flatMap((spec) => readCatalogue(spec, env).map((entry) => ({ entry, spec })))
    const matches = entries.filter((row) => row.entry.skill === parsed.skill)

    if (matches.length === 0) {
        const suggestion = nearest(
            parsed.skill,
            entries.map((row) => row.entry.skill),
        )
        process.stdout.write(
            `no skill called ${parsed.skill} in ${named.map((spec) => spec.name).join(", ")}\n\n  ${
                suggestion === undefined
                    ? `\`sources search ${parsed.skill}\` ranks what is there.`
                    : `Did you mean ${suggestion}? \`sources search ${parsed.skill}\` ranks the alternatives.`
            }\n`,
        )
        return undefined
    }
    if (matches.length > 1) {
        process.stdout.write(
            `${matches.length} sources carry a skill called ${parsed.skill}\n\n${matches
                .map((row) => `  ${row.spec.name}/${row.entry.skill} — ${row.spec.url}\n`)
                .join("")}\n  Name one.\n`,
        )
        return undefined
    }

    const only = matches[0] as { entry: CatalogueEntry; spec: SourceSpec }
    if (only.entry.problem !== undefined) {
        process.stdout.write(
            `${only.spec.name}/${only.entry.skill} will not load: ${only.entry.problem}\n\n  Nothing was copied. That is upstream's to fix — installing a hand-edited copy from a path is the way round it.\n`,
        )
        return undefined
    }
    return {
        entry: only.entry,
        spec: only.spec,
        commit: readMeta(only.spec.name, env).commit ?? "unknown",
    }
}

/** Files under an installed skill that would run. Same over-reporting rule as the catalogue's. */
function scriptFiles(dir: string, depth = 0): string[] {
    if (depth > 3) return []
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name.startsWith(".")) continue
            found.push(...scriptFiles(full, depth + 1))
            continue
        }
        if (!entry.isFile()) continue
        const executable = (statSync(full).mode & 0o111) !== 0
        if (executable || SCRIPT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
            found.push(full)
        }
    }
    return found
}

const SCRIPT_EXTENSIONS = [".py", ".sh", ".js", ".ts", ".mjs", ".rb", ".pl"]

/**
 * Deletes files, and says what it removed rather than only that it did.
 *
 * Reads the directory rather than the catalogue on purpose — see the ordering note at the call site. A
 * skill that breaks the load is precisely the skill someone needs to remove.
 */
function remove(dir: string, options: SkillsOptions): number {
    const name = options.name
    if (name === undefined) {
        process.stdout.write("skills remove needs a name — `skills list` names them\n")
        return EXIT_FAILURE
    }
    const target = join(dir, name)
    if (!existsSync(join(target, SKILL_FILE))) {
        const known = existsSync(dir)
            ? readdirSync(dir, { withFileTypes: true })
                  .filter(
                      (entry) =>
                          entry.isDirectory() && existsSync(join(dir, entry.name, SKILL_FILE)),
                  )
                  .map((entry) => entry.name)
                  .join(", ")
            : ""
        process.stdout.write(`no skill named ${name}${known === "" ? "" : `. Known: ${known}`}\n`)
        return EXIT_FAILURE
    }

    // Counted before the delete, so the report is about what was actually there rather than a guess.
    const files = countFiles(target)
    const origin = readOrigins(dir)[name]
    rmSync(target, { recursive: true, force: true })
    // The claim goes with the directory. A record saying `pdf` came from a commit, pointing at a folder
    // that is gone, is worse than no record: the next `install` of the same name would look like a
    // re-install of exactly that commit.
    forgetOrigin(dir, name)
    process.stdout.write(
        `${keyValue([
            { label: "removed", value: target },
            { label: "files", value: String(files) },
            ...(origin === undefined
                ? []
                : [
                      {
                          label: "came from",
                          value: `${origin.source} (${origin.url}) at ${origin.commit}`,
                      },
                  ]),
        ])}\n`,
    )
    process.stdout.write(`${bullet("restart the agent: the catalogue is scanned once at boot")}\n`)
    return EXIT_OK
}

function countFiles(dir: string): number {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
    }
    return total
}
