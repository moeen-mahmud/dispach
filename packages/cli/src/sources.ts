/**
 * `sources list|add|remove|update|search` — the repositories skills are found in.
 *
 * A separate command from `skills`, and the split is the point: **`skills` acts on one agent and always
 * takes a manifest; `sources` is machine-level and never takes one.** Folding these together would have
 * meant a positional whose meaning changes with the verb — the agent for `list`, a sub-verb for
 * `sources`, a query for `search` — which reads badly in `--help` and parses worse. The boundary also
 * happens to be the one this codebase keeps arriving at: what the agent may do is the agent's, and where
 * things come from is the person's.
 *
 * `search` fetches a source that has never been fetched, and never refreshes one that has. That makes
 * the first search work on a new machine with no setup, which is the whole point of shipping defaults,
 * while keeping "go and talk to the network again" an explicit `update`. Both announce what they are
 * doing before they do it, because a command that pauses for nine seconds with no output is
 * indistinguishable from one that has hung — which is exactly the failure this file's git wrapper exists
 * to prevent.
 */

import {
    bm25Selector,
    HarnessError,
    isHarnessError,
    nearest,
    type ScoredSkill,
    type Skill,
} from "@dispach/core"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { bullet, indent, keyValue, section } from "#lib/render"
import {
    type CatalogueEntry,
    fetchSource,
    type Git,
    isCached,
    readCatalogue,
    readMeta,
} from "#lib/source-cache"
import {
    addSource,
    DEFAULT_SOURCES,
    isSourceName,
    loadSources,
    parseSourceUrl,
    registryPath,
    removeSource,
    type SourceSpec,
} from "#lib/sources"

export const SOURCES_ACTIONS = ["list", "add", "remove", "update", "search"] as const

export interface SourcesOptions {
    readonly action: string
    /** Everything after the action: a name, a URL, a query. Meaning is the action's. */
    readonly rest: readonly string[]
    readonly path?: string
    readonly ref?: string
    readonly json?: boolean
    /** Injected by the tests, which never reach a network. */
    readonly git?: Git
    readonly env?: Readonly<Record<string, string | undefined>>
}

/** How many search hits are printed before the rest are counted. */
const TOP = 12

export async function sourcesCommand(options: SourcesOptions): Promise<number> {
    try {
        switch (options.action) {
            case "list":
                return list(options)
            case "add":
                return add(options)
            case "remove":
                return drop(options)
            case "update":
                return await update(options)
            case "search":
                return await search(options)
            default:
                // Unreachable through the dispatcher, which checks against the spec's choices.
                throw new HarnessError({
                    code: "sources_action_unknown",
                    message: `${options.action} is not a sources action`,
                    hint: `One of: ${SOURCES_ACTIONS.join(", ")}.`,
                })
        }
    } catch (error) {
        if (isHarnessError(error)) {
            process.stdout.write(`${error.message}\n\n  ${error.hint}\n`)
            return EXIT_FAILURE
        }
        throw error
    }
}

function list(options: SourcesOptions): number {
    const sources = loadSources(options.env)
    const rows = sources.map((spec) => {
        const meta = readMeta(spec.name, options.env)
        return {
            ...spec,
            cached: isCached(spec.name, options.env),
            commit: meta.commit,
            fetchedAt: meta.fetchedAt,
            skills: meta.skills,
        }
    })

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ registry: registryPath(options.env), sources: rows }, null, 2)}\n`,
        )
        return EXIT_OK
    }

    if (rows.length === 0) {
        process.stdout.write(
            `every built-in source has been removed, and none has been added\n\n  \`sources add <name> <url>\` to add one, or \`sources add ${DEFAULT_SOURCES[0]?.name ?? "anthropic"} ${DEFAULT_SOURCES[0]?.url ?? ""}\` to put a built-in back.\n`,
        )
        return EXIT_OK
    }

    process.stdout.write(section("sources", true))
    for (const row of rows) {
        process.stdout.write(
            `\n${bullet(`${row.name}${row.builtin === true ? "  (built-in)" : ""}`)}\n`,
        )
        process.stdout.write(
            indent(
                keyValue([
                    { label: "url", value: row.url },
                    ...(row.path === undefined ? [] : [{ label: "path", value: row.path }]),
                    ...(row.ref === undefined ? [] : [{ label: "branch", value: row.ref }]),
                    {
                        label: "cached",
                        value: row.cached
                            ? `${row.skills ?? "?"} skills at ${row.commit ?? "?"}, fetched ${row.fetchedAt ?? "at an unknown time"}`
                            : "never fetched — `sources update` or just search, which fetches on demand",
                    },
                ]),
                4,
            ),
        )
    }
    process.stdout.write(`\n${section("registry")}\n${indent(registryPath(options.env))}\n`)
    return EXIT_OK
}

function add(options: SourcesOptions): number {
    const [first, second] = options.rest
    if (first === undefined) {
        throw new HarnessError({
            code: "sources_add_incomplete",
            message: "sources add needs a repository",
            hint: "`sources add <url>` names it after the owner, or `sources add <name> <url>` to choose. A .../tree/<branch>/<subdir> page URL is understood.",
        })
    }

    // `add <url>` and `add <name> <url>` are told apart by which argument looks like a repository,
    // rather than by counting: a one-argument form that guessed wrong would silently register a source
    // called `https:` and fail on the next line.
    const named = second !== undefined
    const rawUrl = named ? (second as string) : first
    const parsed = parseSourceUrl(rawUrl)
    const name = named ? first : derive(parsed.url)

    if (!isSourceName(name)) {
        throw new HarnessError({
            code: "sources_name_invalid",
            message: `${JSON.stringify(name)} is not usable as a source name`,
            hint: "Lowercase letters, digits and single hyphens — it becomes a directory in the cache and the prefix in `install <agent> <source>/<skill>`.",
        })
    }

    const existing = loadSources(options.env).find((spec) => spec.name === name)
    if (existing !== undefined && !named) {
        throw new HarnessError({
            code: "sources_name_taken",
            message: `${name} is already a source, pointing at ${existing.url}`,
            hint: `Give this one its own name: \`sources add <name> ${rawUrl}\`.`,
        })
    }

    // A flag beats the URL, so a page URL can be added and then narrowed without retyping it.
    const path = options.path ?? parsed.path
    const ref = options.ref ?? parsed.ref
    const spec: SourceSpec = {
        name,
        url: parsed.url,
        ...(path === undefined ? {} : { path }),
        ...(ref === undefined ? {} : { ref }),
    }
    addSource(spec, options.env)

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ added: spec }, null, 2)}\n`)
        return EXIT_OK
    }
    process.stdout.write(
        `${keyValue([
            { label: existing === undefined ? "added" : "replaced", value: name },
            { label: "url", value: spec.url },
            ...(spec.path === undefined
                ? [
                      {
                          label: "path",
                          value: "the whole repository — `--path skills` if the skills live in a subdirectory",
                      },
                  ]
                : [{ label: "path", value: spec.path }]),
            ...(spec.ref === undefined ? [] : [{ label: "branch", value: spec.ref }]),
        ])}\n`,
    )
    process.stdout.write(
        `${section("next")}\n${bullet(`sources update ${name}`)}\n${bullet("sources search <what you need>")}\n`,
    )
    return EXIT_OK
}

/**
 * A name for a repository nobody named: its owner.
 *
 * `anthropics/skills` → `anthropics`, `github/awesome-copilot` → `github`. The repository half is the
 * wrong choice — half the candidates on any search are called `skills`, so it collides immediately and
 * carries no information.
 */
function derive(url: string): string {
    const segments = url
        .replace(/\.git$/, "")
        .split(/[:/]/)
        .filter((part) => part.length > 0)
    const owner = segments[segments.length - 2] ?? ""
    return owner
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
}

function drop(options: SourcesOptions): number {
    const name = options.rest[0]
    if (name === undefined) {
        throw new HarnessError({
            code: "sources_remove_incomplete",
            message: "sources remove needs a name",
            hint: "`sources list` shows them.",
        })
    }
    const known = loadSources(options.env).map((spec) => spec.name)
    if (!removeSource(name, options.env)) {
        const suggestion = nearest(name, known)
        throw new HarnessError({
            code: "sources_unknown",
            message: `no source called ${name}`,
            hint:
                suggestion === undefined
                    ? `Configured: ${known.join(", ") || "none"}.`
                    : `Did you mean ${suggestion}?`,
        })
    }
    const builtin = DEFAULT_SOURCES.some((spec) => spec.name === name)
    process.stdout.write(
        `removed ${name}${builtin ? " — a built-in, so it stays out until `sources add` puts it back" : ""}\n`,
    )
    process.stdout.write(
        "\n  The cached copy is left on disk; nothing already installed into an agent is touched.\n",
    )
    return EXIT_OK
}

async function update(options: SourcesOptions): Promise<number> {
    const configured = loadSources(options.env)
    const wanted =
        options.rest.length === 0
            ? configured
            : options.rest.map((name) => {
                  const found = configured.find((spec) => spec.name === name)
                  if (found === undefined) {
                      const suggestion = nearest(
                          name,
                          configured.map((spec) => spec.name),
                      )
                      throw new HarnessError({
                          code: "sources_unknown",
                          message: `no source called ${name}`,
                          hint:
                              suggestion === undefined
                                  ? `Configured: ${configured.map((spec) => spec.name).join(", ") || "none"}.`
                                  : `Did you mean ${suggestion}?`,
                      })
                  }
                  return found
              })

    if (wanted.length === 0) {
        process.stdout.write("no sources configured\n\n  `sources add <url>` to add one.\n")
        return EXIT_OK
    }

    const done: { name: string; commit: string; skills: number }[] = []
    const failed: { name: string; reason: string }[] = []
    for (const spec of wanted) {
        // Announced before the work, not after: a clone of a large repository takes seconds and silence
        // is how a person decides a command has hung.
        if (options.json !== true) process.stdout.write(`fetching ${spec.name} … `)
        try {
            const result = await fetchSource(spec, {
                ...(options.env === undefined ? {} : { env: options.env }),
                ...(options.git === undefined ? {} : { git: options.git }),
            })
            done.push({ name: spec.name, commit: result.commit, skills: result.skills })
            if (options.json !== true) {
                process.stdout.write(
                    `${result.skills} skills at ${result.commit}${result.unfiltered && spec.path !== undefined ? " (full clone — the server refused a partial one)" : ""}\n`,
                )
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            failed.push({ name: spec.name, reason })
            if (options.json !== true) process.stdout.write(`failed\n`)
            if (options.json !== true && isHarnessError(error)) {
                process.stdout.write(`${indent(error.message)}\n${indent(error.hint, 4)}\n`)
            }
        }
    }

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ updated: done, failed }, null, 2)}\n`)
    }
    // One source failing is not the command failing, but a run where nothing worked exits non-zero —
    // hard rule 8: nothing fails silently and exits 0.
    return done.length === 0 ? EXIT_FAILURE : EXIT_OK
}

/**
 * Rank every skill in every source against a query, with the same scorer that decides activation.
 *
 * Deliberate reuse rather than convenience: `bm25Selector` is what the runtime will run against the
 * installed skill's own frontmatter on every turn, so what ranks first here is what will actually
 * activate there. A separate search ranking would let a skill look like the obvious answer in the
 * catalogue and never fire once installed, and nothing would report the discrepancy.
 */
async function search(options: SourcesOptions): Promise<number> {
    const query = options.rest.join(" ").trim()
    const configured = loadSources(options.env)
    if (configured.length === 0) {
        process.stdout.write("no sources configured\n\n  `sources add <url>` to add one.\n")
        return EXIT_FAILURE
    }

    const cold = configured.filter((spec) => !isCached(spec.name, options.env))
    for (const spec of cold) {
        if (options.json !== true)
            process.stdout.write(`fetching ${spec.name} for the first time … `)
        try {
            const result = await fetchSource(spec, {
                ...(options.env === undefined ? {} : { env: options.env }),
                ...(options.git === undefined ? {} : { git: options.git }),
            })
            if (options.json !== true) process.stdout.write(`${result.skills} skills\n`)
        } catch (error) {
            if (options.json !== true) {
                process.stdout.write(`failed\n`)
                if (isHarnessError(error)) process.stdout.write(`${indent(error.message)}\n`)
            }
        }
    }

    const entries = configured.flatMap((spec) => readCatalogue(spec, options.env))
    if (entries.length === 0) {
        process.stdout.write(
            "\nnothing to search — no source has been fetched successfully\n\n  `sources update` reports why.\n",
        )
        return EXIT_FAILURE
    }

    const ranked = query.length === 0 ? entries : rank(query, entries)
    if (ranked.length === 0) {
        process.stdout.write(
            `\nnothing in ${entries.length} skills across ${configured.length} sources matches ${JSON.stringify(query)}\n\n  Try the words a skill's own description would use — the ranking is lexical, not semantic. \`sources search\` with no query lists everything.\n`,
        )
        return EXIT_OK
    }

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    query,
                    searched: entries.length,
                    results: ranked.map((entry) => ({
                        source: entry.source,
                        skill: entry.skill,
                        description: entry.description,
                        tokens: entry.tokens,
                        scripts: entry.scripts.length,
                        repoPath: entry.repoPath,
                        ...(entry.problem === undefined ? {} : { problem: entry.problem }),
                    })),
                },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    const shown = ranked.slice(0, TOP)
    process.stdout.write(
        `\n${section(query.length === 0 ? `${entries.length} skills` : `${ranked.length} of ${entries.length} skills match ${JSON.stringify(query)}`, true)}\n`,
    )
    for (const entry of shown) {
        process.stdout.write(
            `${bullet(`${entry.source}/${entry.skill}`)}  ${entry.tokens} tokens${
                entry.scripts.length === 0
                    ? ""
                    : `, ${entry.scripts.length} runnable file${entry.scripts.length === 1 ? "" : "s"}`
            }${entry.problem === undefined ? "" : "  — will not load"}\n`,
        )
        const summary = entry.problem ?? entry.description
        process.stdout.write(
            `${indent(summary.length > 160 ? `${summary.slice(0, 157)}…` : summary, 4)}\n`,
        )
    }
    if (ranked.length > shown.length) {
        process.stdout.write(
            `\n${indent(`… and ${ranked.length - shown.length} more; narrow the query or use --json`)}\n`,
        )
    }
    process.stdout.write(
        `\n${section("install")}\n${indent(`skills install <agent> ${shown[0]?.source}/${shown[0]?.skill}`)}\n`,
    )
    return EXIT_OK
}

function rank(query: string, entries: readonly CatalogueEntry[]): readonly CatalogueEntry[] {
    const byKey = new Map<string, CatalogueEntry>()
    const skills: Skill[] = entries.map((entry) => {
        const key = `${entry.source}/${entry.skill}`
        byKey.set(key, entry)
        return {
            // The scorer reads `name` and `description` only, so a source-qualified name is what keeps
            // two sources' `pdf` apart in the result set without changing what is scored.
            name: key,
            dir: entry.dir,
            tokens: entry.tokens,
            scripts: [],
            ignoredScripts: [],
            frontmatter: { name: key, description: entry.description, metadata: {} },
        }
    })
    return bm25Selector(query, skills)
        .filter((scored: ScoredSkill) => scored.score > 0)
        .map((scored) => byKey.get(scored.skill.name))
        .filter((entry): entry is CatalogueEntry => entry !== undefined)
}
