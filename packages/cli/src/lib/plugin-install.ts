/**
 * Fetching a plugin, and reading what is installed.
 *
 * ## One self-contained bundle, and why that is the whole design
 *
 * Nothing installs dependencies, ever — hard rule 5, and it is what makes this mechanism small
 * enough to be worth having at all. A plugin is fetched as a directory with a runnable entry file
 * and nothing to resolve, so the npm install and the container — whose `node_modules` holds only
 * the two declared dependencies — load a plugin exactly as a checkout does. `notSelfContained` is what keeps that
 * true: a tree that declares runtime dependencies and ships none is refused **here**, rather than
 * half-loading at somebody's next boot.
 *
 * ## Git, and what git costs
 *
 * `realGit` from `lib/source-cache.ts` is reused wholesale — the only network module in the CLI, with
 * prompting disabled in all four ways git can be asked and a wall-clock timeout, because a
 * `git ls-remote` on a repository that does not exist once sat for two minutes waiting for a
 * credential prompt nobody was watching.
 *
 * What git does not buy, stated rather than discovered: no version resolution and no integrity check.
 * A bare spec is whatever that branch points at today. `--ref` pins a tag or a commit, the resolved
 * commit is recorded beside the plugin, and `plugins list` prints it — so "which code is loaded" has
 * an answer. The host-range gate is a **compatibility** check and not an authenticity one; nothing
 * here verifies who published what. npm specs are the thing that would, and they are deliberately out
 * of scope: a registry fetch plus a tar extractor, and a change to "one npm name" worth its own
 * decision rather than arriving as a side effect.
 *
 * ## No registry file
 *
 * `sources` needs `sources.json` because a source is machine-level and nothing else records it. A
 * plugin is selected by each agent's own `plugins:` block, so the manifest *is* the registry, and a
 * second list would be exactly the drift this repo keeps paying for. What lives beside the code is
 * provenance, not selection: `.origin.json`, one file per plugin, deleted with the directory.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { HarnessError } from "@dispach/core"
import { pluginDir, pluginRoot } from "#lib/sandbox"
import { type Git, realGit } from "#lib/source-cache"
import { isSourceName } from "#lib/sources"

/** Provenance, written beside the code. Not a registry — see the module docstring. */
export interface PluginOrigin {
    readonly url: string
    /** The branch, tag or commit asked for, or absent for the remote's default. */
    readonly ref?: string
    /** Subdirectory of the repository the plugin was taken from, when it is a monorepo. */
    readonly path?: string
    /** What the ref resolved to at fetch time. Short, as `git rev-parse --short` prints it. */
    readonly commit: string
    readonly fetchedAt: string
}

export const ORIGIN_FILE = ".origin.json"

export interface InstalledPlugin {
    /** The directory name, which is what a manifest's `plugins:` entry writes. */
    readonly name: string
    readonly dir: string
    readonly origin?: PluginOrigin
}

export function readOrigin(dir: string): PluginOrigin | undefined {
    const path = join(dir, ORIGIN_FILE)
    if (!existsSync(path)) return undefined
    try {
        return JSON.parse(readFileSync(path, "utf8")) as PluginOrigin
    } catch {
        // A corrupt provenance file costs an "unknown origin" line and nothing else. The code beside
        // it still loads, and refusing to list it would hide a plugin that is working.
        return undefined
    }
}

/**
 * Every plugin directory in the root, alphabetical.
 *
 * A listing of what is *available*, which is a different question from what an agent loads — that
 * one only the manifest answers, and `plugins list` prints both.
 */
export function installedPlugins(
    env?: Readonly<Record<string, string | undefined>>,
): readonly InstalledPlugin[] {
    const root = pluginRoot(env)
    let entries: string[]
    try {
        entries = readdirSync(root)
    } catch {
        // No plugins yet is the normal state, not an error.
        return []
    }
    const found: InstalledPlugin[] = []
    for (const name of entries.sort()) {
        if (name.startsWith(".") || name.endsWith(".partial")) continue
        const dir = join(root, name)
        if (!existsSync(join(dir, "package.json")) && !existsSync(join(dir, "index.js"))) continue
        const origin = readOrigin(dir)
        found.push({ name, dir, ...(origin === undefined ? {} : { origin }) })
    }
    return found
}

/**
 * The entry file a directory would be loaded through — the same derivation the loader performs.
 *
 * Duplicated deliberately and narrowly: core's version *throws* the load-time refusals, and this one
 * answers "would it load" before anything is renamed into place. The shape it has to agree about is
 * one field of one file, and `plugins add` asserts the agreement by loading through it.
 */
export function entryOf(dir: string): string {
    const packageFile = join(dir, "package.json")
    if (!existsSync(packageFile)) return join(dir, "index.js")
    try {
        const parsed = JSON.parse(readFileSync(packageFile, "utf8")) as { main?: unknown }
        if (typeof parsed.main === "string" && parsed.main !== "") return join(dir, parsed.main)
    } catch {
        // Reported by the caller's own check, which has a better sentence for it than this does.
    }
    return join(dir, "index.js")
}

/**
 * Why this tree cannot be loaded without an install, or `undefined` when it can.
 *
 * A committed `node_modules` clears it: vendoring the dependencies is a perfectly good way to be
 * self-contained, and refusing a tree that already has what it declares would be refusing the thing
 * being asked for.
 */
export function notSelfContained(dir: string): string | undefined {
    const packageFile = join(dir, "package.json")
    if (!existsSync(packageFile)) return undefined
    let parsed: { dependencies?: Record<string, string> }
    try {
        parsed = JSON.parse(readFileSync(packageFile, "utf8")) as {
            dependencies?: Record<string, string>
        }
    } catch (cause) {
        return `its package.json is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`
    }
    const declared = Object.keys(parsed.dependencies ?? {})
    if (declared.length === 0) return undefined
    if (existsSync(join(dir, "node_modules"))) return undefined
    const shown = declared.slice(0, 4).join(", ")
    return `it declares ${declared.length} runtime ${declared.length === 1 ? "dependency" : "dependencies"} (${shown}${declared.length > 4 ? ", …" : ""}) and ships no node_modules`
}

/** What a person typed, turned into something to clone. */
export interface PluginSpec {
    readonly name: string
    readonly url: string
    readonly ref?: string
    readonly path?: string
}

/**
 * Where a repository URL's plugin name comes from.
 *
 * The subdirectory when the URL names one — a monorepo's `packages/channel-whatsapp` is the plugin,
 * not the repository — and the repository name otherwise. Refused rather than transformed when it is
 * not a usable directory name: silently lowercasing `My-Channel` would put the code somewhere
 * other than where the `plugins:` entry the person then reads says it is.
 */
export function pluginNameFor(url: string, path: string | undefined): string {
    const segment =
        (path ?? url)
            .split("/")
            .filter((part) => part.length > 0)
            .pop() ?? ""
    const name = segment.replace(/\.git$/, "")
    if (!isSourceName(name)) {
        throw new HarnessError({
            code: "plugin_name_invalid",
            message: `${JSON.stringify(name || url)} is not a usable plugin directory name`,
            hint: "A plugin is installed into one lowercase path segment — letters, digits and single hyphens — because that segment is what the manifest's `plugins:` entry names. Pass `--name <name>` to choose it.",
        })
    }
    return name
}

export interface FetchPluginResult {
    readonly dir: string
    readonly commit: string
}

/**
 * Clone a plugin into the root, replacing whatever was there only once it has worked.
 *
 * `<dir>.partial` then a rename, the same discipline `fetchSource` uses and for the same reason: an
 * interrupted update leaves the previous copy intact and loadable, and an interrupted *first* fetch
 * leaves no directory rather than an empty one that reads as a plugin with nothing in it.
 *
 * `.git` is dropped afterwards, which is where this differs from a skills source. A source is a
 * working copy that `sources update` re-clones; a plugin directory is a vendored artefact that
 * `.origin.json` describes, and leaving a checkout there invites a `git pull` that would move the
 * code out from under the recorded commit with nothing reporting it.
 *
 * The caller decides whether the result is acceptable *before* renaming — see `plugins add`, which
 * loads the plugin out of the partial directory and refuses there. A command that undoes a mistake
 * must not sit behind the load the mistake breaks.
 */
export async function fetchPlugin(
    spec: PluginSpec,
    options: {
        readonly env?: Readonly<Record<string, string | undefined>>
        readonly git?: Git
        /** Called with the partial directory before it is renamed into place. Throwing discards it. */
        readonly inspect?: (dir: string) => Promise<void> | void
    } = {},
): Promise<FetchPluginResult> {
    const git = options.git ?? realGit
    const target = pluginDir(spec.name, options.env)
    const partial = `${target}.partial`

    mkdirSync(pluginRoot(options.env), { recursive: true })
    rmSync(partial, { recursive: true, force: true })

    const result = await git([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        ...(spec.ref === undefined ? [] : ["--branch", spec.ref]),
        spec.url,
        partial,
    ])
    if (result.code !== 0) {
        rmSync(partial, { recursive: true, force: true })
        throw cloneFailed(spec, result.stderr, result.timedOut === true)
    }

    const head = await git(["rev-parse", "--short", "HEAD"], partial)
    const commit = head.code === 0 ? head.stdout.trim() : "unknown"

    // The plugin is the named subdirectory when there is one, so everything downstream — the
    // inspection, the entry, the origin file — is about the tree that will actually be loaded.
    const from = spec.path === undefined ? partial : join(partial, spec.path)
    if (!existsSync(from)) {
        rmSync(partial, { recursive: true, force: true })
        throw new HarnessError({
            code: "plugin_path_missing",
            message: `${spec.url} has no ${spec.path} at ${commit}`,
            hint: "The path comes from the URL you pasted — .../tree/<branch>/<subdir>. Check it against the repository, or pass the repository URL on its own.",
        })
    }
    rmSync(join(from, ".git"), { recursive: true, force: true })

    try {
        await options.inspect?.(from)
    } catch (error) {
        rmSync(partial, { recursive: true, force: true })
        throw error
    }

    rmSync(target, { recursive: true, force: true })
    if (from === partial) {
        renameSync(partial, target)
    } else {
        renameSync(from, target)
        rmSync(partial, { recursive: true, force: true })
    }

    const origin: PluginOrigin = {
        url: spec.url,
        ...(spec.ref === undefined ? {} : { ref: spec.ref }),
        ...(spec.path === undefined ? {} : { path: spec.path }),
        commit,
        fetchedAt: new Date().toISOString(),
    }
    writeFileSync(join(target, ORIGIN_FILE), `${JSON.stringify(origin, null, 4)}\n`)
    return { dir: target, commit }
}

function cloneFailed(spec: PluginSpec, stderr: string, timedOut: boolean): HarnessError {
    const said = stderr.trim().split("\n").slice(-3).join(" ")
    if (timedOut) {
        return new HarnessError({
            code: "plugin_fetch_timeout",
            message: `${spec.name}: git did not finish in time`,
            hint: `Check the network and try again — the partial fetch was discarded, so whatever was installed as ${spec.name} is untouched.`,
        })
    }
    return new HarnessError({
        code: "plugin_fetch_failed",
        message: `${spec.name}: could not clone ${spec.url}${said.length === 0 ? "" : ` — ${said}`}`,
        hint: "A private repository needs a credential helper git can use without prompting. Check the URL and the --ref; nothing was written.",
    })
}
