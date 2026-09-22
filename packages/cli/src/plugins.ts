/**
 * `plugins` — install one, list what an agent loaded, or remove one.
 *
 * ## Three questions, and why `list` answers two of them
 *
 * `plugins list` was the whole command for three phases: the surface decision 7.5 promised, since
 * `permissions` is advisory vocabulary and a vocabulary nobody can read is one nobody declares
 * accurately. It prints the declarations beside what each plugin registered, which together answer
 * the only two questions worth asking of a plugin — what did naming this buy me, and what did it ask
 * for. It is a command rather than a line in `validate` because `plugin.loaded` fires during boot,
 * before anything can subscribe, so the runtime carries the report and this reads it.
 *
 * It now also prints **which lookup answered** for each entry. With three lookups — the binary's own
 * registry, the plugin root, then a module import — "which code is loaded" stops being derivable from
 * the manifest alone, and an installed plugin shadowed by a same-named bundled one would otherwise be
 * invisible.
 *
 * ## Why `add` verifies before it writes
 *
 * A manifest naming a plugin that will not load **does not load**, so an `add` that wrote the entry
 * and left a broken directory behind would brick the agent and report success — and `plugins remove`,
 * the command that undoes it, would be reachable only by hand-editing the file. So the order is:
 * fetch to a partial directory, refuse there, and only then rename into place and write the entry.
 *
 * The verification is `conformance()` from `@dispach/core/testing` — the same suite the plugin's own
 * author runs, rather than a second definition of "well-formed" living here. It calls `setup` once
 * into a void, so nothing is constructed and no credential is read. That does mean **reading the
 * declarations runs the plugin's module scope**, which `add` says out loud: there is no way to learn
 * what a plugin declares without loading it, because the declarations are its default export, and a
 * second place to declare them would be a second thing to keep in step.
 */

import { existsSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import {
    BRAND,
    editManifest,
    HarnessError,
    type Permission,
    type Plugin,
    Runtime,
    readManifestHeader,
    satisfiesApiRange,
    VERSION,
} from "@dispach/core"
import { conformance } from "@dispach/core/testing"
import { ambientEnv } from "#lib/ambient"
import { EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import {
    entryOf,
    fetchPlugin,
    type InstalledPlugin,
    installedPlugins,
    notSelfContained,
    pluginNameFor,
} from "#lib/plugin-install"
import {
    BUILT_IN_PLUGIN_SPECS,
    BUILT_IN_PLUGINS,
    CHANNELS,
    scriptRunner,
    TOOL_PROVIDERS,
} from "#lib/providers"
import { keyValue, type Row } from "#lib/render"
import { listAgents, pluginDir, pluginRoot, storePath } from "#lib/sandbox"
import type { PluginsOptions } from "#lib/schema"
import { looksLikePath } from "#lib/source-cache"
import { isSourceName, parseSourceUrl } from "#lib/sources"

export async function pluginsCommand(options: PluginsOptions): Promise<number> {
    switch (options.action) {
        case "list":
            return await listCommand(options)
        case "add":
            return await addCommand(options)
        case "remove":
            return await removeCommand(options)
        default:
            throw new HarnessError({
                code: "cli_plugins_action_unknown",
                message: `plugins: ${JSON.stringify(options.action)} is not an action`,
                hint: `Actions are list, add and remove — \`${BRAND.slug} plugins list <agent>\`.`,
            })
    }
}

// ─── list ────────────────────────────────────────────────────────────────────────────────

async function listCommand(options: PluginsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        toolProviders: TOOL_PROVIDERS,
        builtInPlugins: BUILT_IN_PLUGINS,
        pluginRoot: pluginRoot(options.env),
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv([options.manifestPath]),
        store: storePath(options.env),
        lease: false,
    })
    onExit(() => runtime.stop("cli-exit"))

    const loaded = [...runtime.plugins.values()].flat()
    const installed = installedPlugins(options.env)

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                { plugins: loaded, installed, available: BUILT_IN_PLUGIN_SPECS },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    if (loaded.length === 0) {
        // Names what could be written rather than printing an empty table. A capability reachable
        // only by somebody who already knows the field names is a capability the surface is hiding —
        // the same reason `init` asks about every provider the runtime has.
        process.stdout.write(
            `No plugins. This binary can resolve these by name:\n\n${BUILT_IN_PLUGIN_SPECS.map(
                (spec) => `  - "${spec}"`,
            ).join(
                "\n",
            )}\n\nAdd a \`plugins:\` block to agent.yaml naming the ones you want, or fetch one with \`${BRAND.slug} plugins add <agent> <repo>\`.\n`,
        )
        if (installed.length > 0) {
            process.stdout.write(
                `\nInstalled in ${pluginRoot(options.env)} and named by no agent:\n${installed
                    .map((entry) => `  - "${entry.name}"`)
                    .join("\n")}\n`,
            )
        }
        return EXIT_OK
    }

    const rows: Row[] = loaded.map((plugin) => ({
        label: plugin.name,
        value: `${plugin.version}  ${`${plugin.setupMs} ms`.padStart(9)}`,
        note: `${lookupNote(plugin.spec, plugin.lookup, installed)} — ${
            plugin.registered.length === 0 ? "registered nothing" : plugin.registered.join(", ")
        }`,
    }))
    process.stdout.write(`${keyValue(rows)}\n`)

    // Printed separately, and only when something declared one. Advisory in v1 — the line says so,
    // because a permission list that reads as enforcement is worse than none: it invites the belief
    // that installing a plugin is bounded by what it declared.
    const declaring = loaded.filter((plugin) => plugin.permissions.length > 0)
    if (declaring.length > 0) {
        process.stdout.write("\nDeclared access — advisory in v1, recorded and not enforced:\n")
        for (const plugin of declaring) {
            for (const permission of plugin.permissions) {
                process.stdout.write(
                    `  ${plugin.name}  ${permission.kind}  ${permissionDetail(permission)}\n`,
                )
            }
        }
    }

    const unused = installed.filter((entry) => !loaded.some((plugin) => plugin.spec === entry.name))
    if (unused.length > 0) {
        process.stdout.write(
            `\nAlso installed, named by no agent: ${unused.map((entry) => entry.name).join(", ")}\n`,
        )
    }
    return EXIT_OK
}

/** Which of the three lookups answered, with the commit when provenance knows one. */
function lookupNote(spec: string, lookup: string, installed: readonly InstalledPlugin[]): string {
    if (lookup !== "installed") return lookup === "registry" ? "built in" : "imported"
    const origin = installed.find((entry) => entry.name === spec)?.origin
    return origin === undefined ? "installed" : `installed ${origin.commit}`
}

function permissionDetail(permission: Permission): string {
    switch (permission.kind) {
        case "network":
            return permission.hosts.join(", ")
        case "env":
            return permission.vars.join(", ")
        case "fs":
            return `${permission.paths.join(", ")} (${permission.mode})`
        case "exec":
            return permission.commands.join(", ")
        default:
            return permission.tables.join(", ")
    }
}

// ─── add ─────────────────────────────────────────────────────────────────────────────────

async function addCommand(options: PluginsOptions): Promise<number> {
    const typed = options.rest?.[0]
    if (typed === undefined || typed === "") {
        throw new HarnessError({
            code: "cli_plugins_add_needs_repo",
            message: "plugins add needs a repository",
            hint: `\`${BRAND.slug} plugins add <agent> <owner/repo> [--ref v1.0.0]\`. A plugin is fetched with git — an owner/repo shorthand, a clone URL, the page URL you were reading (whose .../tree/<branch>/<subdir> is understood), or a local repository while you are writing one.`,
        })
    }
    // A local repository is a first-class spec, because it is the only way an author can test the
    // bundle they are about to publish: `plugins:` can already name a relative path, but that is not
    // what runs in the container — a vendored copy in the plugin root is. Filesystem-first, the rule
    // `resolveAgentRef` and `skills install` both follow, so a path is never read as `owner/repo`.
    const parsed = looksLikePath(typed)
        ? { url: resolve(typed.replace(/^file:\/\//, "")) }
        : parseSourceUrl(typed)
    // A `--ref` beats one read out of a `/tree/<branch>/` URL: the flag is what somebody typed on
    // purpose, and the URL's branch is usually whatever page they happened to be reading.
    const ref = options.ref ?? parsed.ref
    const name =
        options.name === undefined ? pluginNameFor(parsed.url, parsed.path) : checked(options.name)

    const existing = installedPlugins(options.env).find((entry) => entry.name === name)
    if (existing?.origin !== undefined && existing.origin.url !== parsed.url) {
        throw new HarnessError({
            code: "plugin_name_taken",
            message: `A different plugin is already installed as "${name}" — from ${existing.origin.url}`,
            hint: `Two repositories cannot share one directory, and the directory name is what a manifest's \`plugins:\` entry means. Pass \`--name <name>\`, or \`${BRAND.slug} plugins remove <agent> ${name}\` first.`,
        })
    }

    process.stdout.write(
        `Fetching ${parsed.url}${ref === undefined ? "" : ` at ${ref}`} as "${name}"…\n`,
    )

    let report: Awaited<ReturnType<typeof conformance>> | undefined

    const fetched = await fetchPlugin(
        {
            name,
            url: parsed.url,
            ...(ref === undefined ? {} : { ref }),
            ...(parsed.path === undefined ? {} : { path: parsed.path }),
        },
        {
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.git === undefined ? {} : { git: options.git }),
            // Everything that could refuse runs here, against the partial directory, so a refusal
            // leaves whatever was installed under this name untouched and the manifest unwritten.
            inspect: async (dir) => {
                const problem = notSelfContained(dir)
                if (problem !== undefined) {
                    throw new HarnessError({
                        code: "plugin_not_self_contained",
                        message: `${name} cannot be loaded as fetched: ${problem}`,
                        hint: "A plugin is distributed as one self-contained bundle. Nothing is installed while this runtime runs (hard rule 5), so a declared dependency would simply be missing at boot. Ask the author to bundle their dependencies, or commit node_modules in the distribution repository.",
                    })
                }
                const entry = entryOf(dir)
                if (!existsSync(entry)) {
                    throw new HarnessError({
                        code: "plugin_entry_missing",
                        message: `${name} has no entry file — ${entry.slice(dir.length + 1)} is not in the repository`,
                        hint: "A plugin directory is entered through the `main` its package.json names, defaulting to index.js. A distribution repository commits its built entry file; a source checkout does not, which is usually what this means.",
                    })
                }
                const plugin = await pluginFromFile(name, entry)
                report = await conformance(plugin)
                if (!report.ok) {
                    throw new HarnessError({
                        code: "plugin_not_conformant",
                        message: `${report.declared.name} does not meet the plugin contract:\n${report.findings
                            .filter((finding) => finding.level === "error")
                            .map((finding) => `  ${finding.check}: ${finding.message}`)
                            .join("\n")}`,
                        hint: `This is the same suite the plugin's own author runs — \`conformance()\` from ${BRAND.packageScope}/core/testing. Nothing was installed. Report it upstream with the checks named above.`,
                    })
                }
                // A range that does not admit this host is a **warning** in the suite, because
                // running it against a newer host than a plugin targets is a normal thing for an
                // author to do. Installing is not: the loader refuses this at boot, so writing the
                // entry would leave an agent that will not start, reported as success.
                if (satisfiesApiRange(VERSION, report.declared.apiRange) !== true) {
                    throw new HarnessError({
                        code: "plugin_api_mismatch",
                        message: `${report.declared.name} ${report.declared.version} supports host ${report.declared.apiRange}, and this host is ${VERSION}`,
                        hint: "The loader refuses this at boot, so installing it would write an entry that stops the agent starting. Look for a newer release of the plugin, or a `--ref` that matches this host.",
                    })
                }
            },
        },
    )

    // Disclosure after the fetch rather than before, and the reason is stated rather than hidden:
    // what a plugin declares *is* its default export, so there is nothing to read without loading
    // the module — which has now happened. The alternative is a second place to declare it.
    const declared = report?.declared
    process.stdout.write(
        `\n${declared?.name ?? name} ${declared?.version ?? "?"}  (${fetched.commit})\n` +
            `  from       ${parsed.url}${ref === undefined ? "" : ` at ${ref}`}\n` +
            `  installed  ${fetched.dir}\n` +
            `  host range ${declared?.apiRange ?? "?"} — this host is ${VERSION}\n` +
            `  registers  ${report === undefined || report.registered.length === 0 ? "nothing" : report.registered.join(", ")}\n`,
    )
    if (declared !== undefined && declared.permissions.length > 0) {
        process.stdout.write(
            `\nIt declares access to:\n${declared.permissions
                .map((permission) => `  ${permission.kind}  ${permissionDetail(permission)}`)
                .join("\n")}\n` +
                "\nAdvisory only. `permissions` is recorded and enforced by nothing in v1 (decision 7.5) —\n" +
                "a plugin is trusted in-process code, so this list is what the author says it needs, not a\n" +
                "boundary. Install plugins you trust.\n",
        )
    } else {
        process.stdout.write(
            "\nIt declares no access. That is not a guarantee: `permissions` is advisory in v1, so a\nplugin that declares nothing can still do anything this process can. Install plugins you trust.\n",
        )
    }
    const warnings = report?.findings.filter((finding) => finding.level === "warning") ?? []
    for (const warning of warnings) {
        process.stdout.write(`\nnote: ${warning.check} — ${warning.message}\n`)
    }

    // The manifest entry is the **directory** name, which is not always the plugin's own `name` —
    // `--name` decides one and the author decides the other. Said out loud when they differ, because
    // `plugins list` keys its rows by the plugin's name and the manifest by the directory, and
    // somebody reading both would otherwise have two names and no stated relationship.
    if (declared !== undefined && declared.name !== name) {
        process.stdout.write(
            `\nnote: it calls itself "${declared.name}"; the \`plugins:\` entry is the directory, "${name}".\n`,
        )
    }

    const result = await addToManifest(options.manifestPath, name)
    process.stdout.write(
        result === "already"
            ? `\n${options.manifestPath} already names "${name}".\n`
            : `\nAdded "${name}" to the plugins: block in ${options.manifestPath}.\nIt loads at the next start — an agent's plugins are fixed for its lifetime, so restart a running one.\n`,
    )
    return EXIT_OK
}

function checked(name: string): string {
    if (isSourceName(name)) return name
    throw new HarnessError({
        code: "plugin_name_invalid",
        message: `--name ${JSON.stringify(name)} is not a usable plugin directory name`,
        hint: "Lowercase letters, digits and single hyphens. That segment is what the manifest's `plugins:` entry names, so it has to be a directory name and a YAML scalar at once.",
    })
}

/**
 * Load a file and get the plugin out of it.
 *
 * Deliberately narrow: two conditions, and `conformance()` produces every other finding. A third
 * definition of "is this a plugin" — after the loader's and the suite's — is what this avoids.
 */
async function pluginFromFile(name: string, entry: string): Promise<Plugin> {
    let module: unknown
    try {
        module = await import(entry)
    } catch (cause) {
        throw new HarnessError({
            code: "plugin_import_failed",
            message: `${name}: ${entry} could not be imported — ${cause instanceof Error ? cause.message : String(cause)}`,
            hint: "A plugin is one self-contained ES module. A bare `require` or an unresolved import is what this usually means, and neither can be fixed by installing anything: nothing is installed while this runtime runs. Nothing was installed.",
            cause,
        })
    }
    const candidate = (module as { default?: unknown }).default
    if (candidate === null || typeof candidate !== "object") {
        throw new HarnessError({
            code: "plugin_malformed",
            message: `${name}: ${entry} has no object as its default export`,
            hint: `A plugin is the module's default export: an object with \`name\`, \`version\`, a \`${BRAND.slug}Api\` host range and \`setup\`. A named export is not searched for and a factory function is not called, because a wrong guess produces a plugin that registers nothing and reports success.`,
        })
    }
    if (typeof (candidate as { setup?: unknown }).setup !== "function") {
        throw new HarnessError({
            code: "plugin_malformed",
            message: `${name}: the default export of ${entry} has no \`setup\` function`,
            hint: "`setup(context)` is the whole extension surface — it registers channels, tool providers, a script runner or middleware, and does no work.",
        })
    }
    return candidate as Plugin
}

/** Append the entry unless it is already there. The one manifest writer does the placing. */
async function addToManifest(manifestPath: string, name: string): Promise<"written" | "already"> {
    const header = readManifestHeader(manifestPath)
    const refs = header.plugins ?? []
    const already = refs.some((ref) => (typeof ref === "string" ? ref : ref.spec) === name)
    if (already) return "already"
    await editManifest({
        file: manifestPath,
        path: ["plugins"],
        // Strings, not `{spec}` maps: a bare entry is what a manifest should carry when there is no
        // config, and the object form is for the entries that need one.
        value: [...refs.map((ref) => (typeof ref === "string" ? ref : ref.spec)), name],
    })
    return "written"
}

// ─── remove ──────────────────────────────────────────────────────────────────────────────

async function removeCommand(options: PluginsOptions): Promise<number> {
    const name = options.rest?.[0]
    if (name === undefined || name === "") {
        throw new HarnessError({
            code: "cli_plugins_remove_needs_name",
            message: "plugins remove needs a name",
            hint: `\`${BRAND.slug} plugins remove <agent> <name>\`, where the name is the \`plugins:\` entry — \`plugins list <agent>\` prints them.`,
        })
    }

    const header = readManifestHeader(options.manifestPath)
    const refs = (header.plugins ?? []).map((ref) => (typeof ref === "string" ? ref : ref.spec))
    if (refs.includes(name)) {
        await editManifest({
            file: options.manifestPath,
            path: ["plugins"],
            value: refs.filter((ref) => ref !== name),
        })
        // A pointer rather than a claim. Whether anything in the manifest *depended* on this plugin
        // is only knowable by loading it, which has just been deleted — and the consequence is loud
        // at the next start (`channels[0] declares type "x", which is not registered here`), so what
        // is worth buying here is the one command that says so before that start.
        process.stdout.write(
            `Dropped "${name}" from ${options.manifestPath}.\nRun \`${BRAND.slug} validate ${options.manifestPath}\` — a channel or tool provider it supplied is now unresolved.\n`,
        )
    } else {
        process.stdout.write(`${options.manifestPath} does not name "${name}".\n`)
    }

    const dir = pluginDir(name, options.env)
    if (!existsSync(dir)) {
        process.stdout.write(`Nothing installed at ${dir}.\n`)
        return EXIT_OK
    }

    // The directory is machine-level and shared, so deleting it while another agent still names it
    // would break that agent at its next start — with the damage done by a command somebody ran
    // about a different agent. Named rather than deleted, which is the same call `remove` makes
    // about two directories sharing one manifest id.
    const others = otherAgentsNaming(name, options.manifestPath, options.env)
    if (others.length > 0) {
        process.stdout.write(
            `Kept ${dir} — still named by ${others.join(", ")}.\nRemove it from those agents first, or delete the directory by hand.\n`,
        )
        return EXIT_OK
    }
    rmSync(dir, { recursive: true, force: true })
    process.stdout.write(`Deleted ${dir}.\n`)
    return EXIT_OK
}

/** Sandbox agents other than this one whose `plugins:` names it. Header reads, so no credentials. */
function otherAgentsNaming(
    name: string,
    exceptManifest: string,
    env?: Readonly<Record<string, string | undefined>>,
): readonly string[] {
    const found: string[] = []
    for (const agent of listAgents(env)) {
        if (agent.manifestPath === exceptManifest) continue
        try {
            const header = readManifestHeader(agent.manifestPath)
            const refs = (header.plugins ?? []).map((ref) =>
                typeof ref === "string" ? ref : ref.spec,
            )
            if (refs.includes(name)) found.push(agent.ref)
        } catch {
            // A broken manifest cannot be asked. Not a reason to refuse the delete — `listAgents`
            // already surfaces it, and treating unreadable as "names it" would make one corrupt
            // agent pin every plugin on the machine forever.
        }
    }
    return found
}
