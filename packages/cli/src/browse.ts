/**
 * Bare `skills`, with no arguments: the catalogue, ticked, installed into an agent you pick.
 *
 * This is the entry point the owner asked for and the one the surface was missing. Everything else
 * required knowing something first — `skills list <agent>` needs an agent, `sources search <words>` needs
 * words, and `skills install <agent> <source>/<skill>` needs the name of a skill you have not seen yet.
 * A person who wants skills has none of those, so the command that takes no arguments has to be the one
 * that shows what exists.
 *
 * ## What it does not do
 *
 * It does not fetch on a pipe. `--plain`, a redirect, or CI gets the same list as text, from the same
 * `browseRows`, with the two commands that install a skill non-interactively printed underneath — because
 * a picker is not scriptable and pretending otherwise means somebody's CI job hangs on a keypress.
 *
 * It also does not resolve an agent for you when there are several. Installing somebody else's executable
 * code into whichever agent happened to sort first is not a default worth having, so the second screen
 * asks — and with exactly one agent it does not, because there is nothing to ask.
 */

import { BRAND, HarnessError, VERSION } from "@dispach/core"
import {
    type BrowseInput,
    type BrowseRow,
    browseRows,
    type InstallReport,
    installReport,
} from "#lib/browse"
import { ENTER_ALT_SCREEN, EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { flushOutput, markAltScreen, onExit, restoreTerminal } from "#lib/exit"
import { negotiateKeyboard } from "#lib/keyboard"
import { resolveModeFromProcess } from "#lib/output"
import { bullet, indent, section } from "#lib/render"
import { columnsFor, layoutRow } from "#lib/rows"
import { listAgents, type SandboxAgent } from "#lib/sandbox"
import {
    type CatalogueEntry,
    fetchSource,
    type Git,
    isCached,
    readCatalogue,
} from "#lib/source-cache"
import { loadSources } from "#lib/sources"
import { type InstallOutcome, skillsCommand } from "#skills"

export interface BrowseOptions {
    readonly plain?: boolean
    readonly json?: boolean
    /** Injected by the tests, which never reach a network. */
    readonly git?: Git
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Both overridden in tests; at a terminal they are measured from the stream. */
    readonly rows?: number
    readonly width?: number
}

/**
 * Fetch what is not cached, then build the rows. Shared by the command and by `init`.
 *
 * Announced before the work: the first run pays ~40 MB once per machine and every agent on it shares the
 * result, and a command that pauses for twenty seconds with no output is indistinguishable from one that
 * has hung — the failure this whole area's git wrapper exists to prevent.
 */
/**
 * Fetch what is not cached, then build the rows — reporting progress through a callback.
 *
 * A callback rather than `process.stdout` because one caller is *inside* a rendered screen, where writing
 * to stdout paints over the frame Ink is managing. The other caller passes a writer and gets the same lines
 * on a pipe. This is the seam that lets the init wizard show a spinner instead of a printed line.
 */
export async function fetchCatalogue(
    options: BrowseOptions & { readonly onStatus?: (line: string) => void },
): Promise<readonly BrowseRow[]> {
    const say = options.onStatus ?? (() => {})
    const sources = loadSources(options.env)
    const cold = sources.filter((spec) => !isCached(spec.name, options.env))
    for (const [at, spec] of cold.entries()) {
        say(
            `fetching ${spec.name} (${at + 1} of ${cold.length}) — once per machine, shared by every agent`,
        )
        try {
            const result = await fetchSource(spec, {
                ...(options.env === undefined ? {} : { env: options.env }),
                ...(options.git === undefined ? {} : { git: options.git }),
            })
            say(`${spec.name}: ${result.skills} skills`)
        } catch (error) {
            say(
                `${spec.name} could not be fetched: ${error instanceof HarnessError ? error.message : String(error)}`,
            )
        }
    }
    const inputs: BrowseInput[] = sources
        .filter((spec) => isCached(spec.name, options.env))
        .map((spec) => ({ spec, entries: readCatalogue(spec, options.env) }))
    return browseRows(inputs)
}

/** The same thing for the paths that own the terminal, printing each line as it happens. */
export async function catalogueRows(options: BrowseOptions): Promise<readonly BrowseRow[]> {
    return await fetchCatalogue({
        ...options,
        onStatus: (line) => process.stdout.write(`${line}\n`),
    })
}

/**
 * Install a list of `<source>/<skill>` refs, reporting once.
 *
 * Exported for `init`, whose wizard already collected the refs on its own screen — so it needs the install
 * without the picker.
 */
export function installRefs(
    refs: readonly string[],
    manifestPath: string,
    options: BrowseOptions & { readonly envOverlay?: Readonly<Record<string, string | undefined>> },
): number {
    const outcomes: InstallOutcome[] = []
    for (const ref of refs) {
        skillsCommand({
            action: "install",
            manifestPath,
            name: ref,
            quiet: true,
            collect: outcomes,
            ...(options.env === undefined ? {} : { sandboxEnv: options.env }),
            ...(options.envOverlay === undefined ? {} : { envOverlay: options.envOverlay }),
        })
    }
    return report(outcomes)
}

/**
 * One `skills install` per skill rather than one call with a list.
 *
 * The command's contract is one ref, it reports per skill, and a partial failure leaves the successful
 * ones installed with a named reason for the rest — batching would have to reimplement all of that.
 */
function collectInstall(
    skills: readonly CatalogueEntry[],
    manifestPath: string,
    options: BrowseOptions & { readonly envOverlay?: Readonly<Record<string, string | undefined>> },
): readonly InstallOutcome[] {
    const outcomes: InstallOutcome[] = []
    for (const entry of skills) {
        skillsCommand({
            action: "install",
            manifestPath,
            name: `${entry.source}/${entry.skill}`,
            quiet: true,
            collect: outcomes,
            ...(options.env === undefined ? {} : { sandboxEnv: options.env }),
            ...(options.envOverlay === undefined ? {} : { envOverlay: options.envOverlay }),
        })
    }
    return outcomes
}

/**
 * The one report for a batch, as text.
 *
 * Renders from `installReport`, which the rich result card also reads — so a pipe and a terminal cannot
 * disagree about what happened. Eleven ticked skills used to produce eleven of these.
 */
function report(outcomes: readonly InstallOutcome[]): number {
    const summary = installReport(outcomes)
    process.stdout.write(
        `${section(`installed ${summary.installed.length} of ${summary.total} skill${summary.total === 1 ? "" : "s"}`, true)}\n`,
    )
    if (summary.installed.length > 0) {
        process.stdout.write(`${indent(summary.installed.join(", "))}\n`)
    }
    for (const failure of summary.failed) {
        process.stdout.write(`${bullet(`${failure.name} — ${failure.reason}`)}\n`)
    }
    if (summary.runnable > 0) {
        // Counted here and named per skill by `skills show`. Twelve file paths per skill across eleven
        // skills is 130 lines of disclosure nobody reads, which discloses less than one honest sentence.
        process.stdout.write(
            `${section("code that came with them")}\n${indent(
                `${summary.runnable} runnable file${summary.runnable === 1 ? "" : "s"} across ${summary.withCode} skill${summary.withCode === 1 ? "" : "s"} — \`skills show <agent> <skill>\` names them`,
            )}\n`,
        )
    }
    return summary.failed.length
}

export async function browseCommand(options: BrowseOptions): Promise<number> {
    const sources = loadSources(options.env)
    if (sources.length === 0) {
        process.stdout.write(
            `no skill sources are configured\n\n  \`${BRAND.slug} sources add <url>\` adds one — a repository holding a skills/ directory.\n`,
        )
        return EXIT_FAILURE
    }

    const decision = resolveModeFromProcess({
        plain: options.plain === true,
        json: options.json === true,
        oneShot: false,
    })
    const interactive = decision.mode === "rich" && options.json !== true

    // The plain and JSON paths still fetch first, because they have nothing to render while they wait
    // and a spinner on a pipe is noise. The rich path does the opposite, and that inversion is the
    // whole point of this stage.
    if (!interactive) {
        const rows = await catalogueRows(options)
        if (rows.length === 0) {
            process.stdout.write(
                `nothing to show — no catalogue could be read\n\n  \`${BRAND.slug} sources update\` reports why.\n`,
            )
            return EXIT_FAILURE
        }
        if (options.json === true) return printJson(rows)
        return plainList(rows, listAgents(options.env))
    }

    const agents = listAgents(options.env)
    if (agents.length === 0) {
        // Checked before the mount because it needs no catalogue: fetching 40 MB to then say there is
        // nowhere to put it would be the wrong order to find out in.
        process.stdout.write(
            `${section("no agent to install into", true)}\n${indent(`\`${BRAND.slug} init\` creates one, then this command installs into it.`)}\n`,
        )
        return EXIT_FAILURE
    }

    const [{ render }, { createElement }, { SkillBrowser }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/SkillBrowser"),
    ])

    let report: InstallReport | undefined
    let finish: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
        finish = resolve
    })

    // Alternate screen: this waits for a keypress, so it takes the terminal and gives it back. The
    // enter sequence and the flag are written together — a flag set without the sequence would make the
    // restore clear the screen the output was just written to.
    markAltScreen()
    process.stdout.write(ENTER_ALT_SCREEN)

    const instance = render(
        createElement(SkillBrowser, {
            title: BROWSE_TITLE,
            agents,
            load: (onStatus: (line: string) => void) => fetchCatalogue({ ...options, onStatus }),
            install: async (skills: readonly CatalogueEntry[], manifestPath: string) =>
                installReport(collectInstall(skills, manifestPath, options)),
            onDone: (result: InstallReport | undefined) => {
                report = result
                finish()
            },
        }),
        { exitOnCtrlC: false, ...negotiateKeyboard() },
    )
    onExit(() => instance.unmount())
    await closed
    instance.unmount()
    restoreTerminal()
    await flushOutput()

    // Restored first, then one line on the real screen. A clean exit leaves no trace of the browsing;
    // what it does leave is the pointer to what changed, and any failure, because hard rule 8 does not
    // stop applying because a screen has closed.
    if (report === undefined) return EXIT_OK
    for (const failure of report.failed) {
        process.stderr.write(`${failure.name} — ${failure.reason}\n`)
    }
    if (report.installed.length > 0) {
        process.stdout.write(
            `${report.installed.length} skill${report.installed.length === 1 ? "" : "s"} installed — \`${BRAND.slug} skills list <agent>\` shows them\n`,
        )
    }
    return report.failed.length === report.total && report.total > 0 ? EXIT_FAILURE : EXIT_OK
}

/** The JSON form, unchanged and deliberately not rendered. */
function printJson(rows: readonly BrowseRow[]): number {
    process.stdout.write(
        `${JSON.stringify(
            {
                skills: rows
                    .filter((row) => row.entry !== undefined)
                    .map((row) => ({
                        ref: `${row.entry?.source}/${row.entry?.skill}`,
                        source: row.entry?.source,
                        skill: row.entry?.skill,
                        tokens: row.entry?.tokens,
                        scripts: row.entry?.scripts.length ?? 0,
                        description: row.entry?.description,
                    })),
            },
            null,
            2,
        )}\n`,
    )
    return EXIT_OK
}

/**
 * The pipe's rendering: the same rows, laid out in the same columns, at a fixed 100.
 *
 * Fixed rather than measured, because a redirected stream has no width and output that changed shape
 * depending on the terminal it was *not* written to is output no test can pin.
 */
function plainListText(rows: readonly BrowseRow[]): string {
    const width = 100
    const longest = rows.reduce(
        (max, row) => (row.kind === "item" ? Math.max(max, row.label.length) : max),
        0,
    )
    // `longest + 12` and a matching ceiling, because each name is printed as `<source>/<skill>` here.
    const columns = columnsFor(width, longest + 12, { nameMax: 46 })
    const lines: string[] = []
    for (const row of rows) {
        if (row.kind === "source") {
            lines.push(`\n${row.label}`)
            continue
        }
        if (row.kind === "group") {
            lines.push(`  ${row.label}`)
            continue
        }
        const cells = layoutRow(
            {
                name: `${row.entry?.source}/${row.label}`,
                meta: row.meta ?? "",
                description: row.description ?? "",
            },
            columns,
        )
        lines.push(`    ${cells.name}  ${cells.meta}  ${cells.description}`.trimEnd())
    }
    return lines.join("\n")
}

/**
 * The pipe's answer: the same rows, plus the two commands that install one without a keypress.
 *
 * Exits 0. Asking what exists is a legitimate question and it was answered — unlike bare `run`, which
 * exits non-zero on a pipe because nothing ran and something was supposed to.
 */
function plainList(rows: readonly BrowseRow[], agents: readonly SandboxAgent[]): number {
    process.stdout.write(`${plainListText(rows)}\n`)
    const example = rows.find((row) => row.entry !== undefined)?.entry
    const agent = agents[0]?.ref ?? "<agent>"
    process.stdout.write(
        `${section("install")}\n${indent(`${BRAND.slug} skills install ${agent} ${example?.source ?? "anthropic"}/${example?.skill ?? "pdf"}`)}\n${indent(`${BRAND.slug} skills — at a terminal, ticks several at once`, 2)}\n`,
    )
    return EXIT_OK
}

/** Kept beside the command so the banner and the picker cannot disagree about the version. */
export const BROWSE_TITLE = `${BRAND.name} ${VERSION}`
