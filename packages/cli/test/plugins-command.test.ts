/**
 * `plugins add` and `plugins remove` against a real generated agent, with git injected.
 *
 * ## What these are actually guarding
 *
 * `add` writes a `plugins:` entry into a manifest, and a manifest naming a plugin that will not load
 * **does not load**. So an `add` that wrote the entry and left a broken directory behind would brick
 * the agent and report success — and the command that undoes it would be reachable only by
 * hand-editing YAML. That is the recorded `skills install` failure exactly: it happily installed a
 * skill whose size failed the load, which broke `list`, `validate`, every turn *and* `remove`.
 *
 * Every refusal below therefore asserts two things — the code, and that **nothing was written**: no
 * directory, and no entry in the manifest. The second half is the one that would rot.
 *
 * Also asserted at the far end, on the file rather than on a return value: this repo has lost a
 * threaded value to a conditional spread six separate times, and `plugins add` threads a name from a
 * URL through a fetch, a conformance run and the one manifest writer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRAND, VERSION } from "@dispach/core"
import { provisionAgent } from "#lib/provision"
import { pluginDir } from "#lib/sandbox"
import type { Git } from "#lib/source-cache"
import { pluginsCommand } from "#plugins"

const dirs: string[] = []
let home = ""
let env: Record<string, string | undefined> = {}
let manifestPath = ""
let out = ""
let restore: (() => void) | undefined

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-plugins-cmd-"))
    dirs.push(home)
    env = { [`${BRAND.envPrefix}HOME`]: home }
    const agents = join(home, "agents")
    mkdirSync(agents, { recursive: true })
    const result = provisionAgent({
        answers: { user: "Ada", name: "scout" },
        defaults: { agentDirBase: agents },
    })
    manifestPath = join(result.dir, "agent.yaml")

    out = ""
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
        out += chunk
        return true
    }) as typeof process.stdout.write
    restore = () => {
        process.stdout.write = write
    }
})

afterEach(() => {
    restore?.()
    restore = undefined
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
}

function fakeGit(files: Readonly<Record<string, string>>, commit = "abc1234"): Git {
    return async (args) => {
        if (args[0] === "clone") {
            const target = args[args.length - 1] as string
            for (const [path, text] of Object.entries(files)) write(join(target, path), text)
            return { code: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "rev-parse") return { code: 0, stdout: `${commit}\n`, stderr: "" }
        return { code: 0, stdout: "", stderr: "" }
    }
}

/**
 * A plugin as a distribution repository ships one: a built entry file and no dependencies.
 *
 * Written as source text because `add` really imports it — which is the only way to learn what a
 * plugin declares, since the declarations *are* its default export.
 */
function bundle(
    body: string,
    packageJson: Readonly<Record<string, unknown>> = {},
): Record<string, string> {
    return {
        "package.json": JSON.stringify({ name: "fixture", main: "index.mjs", ...packageJson }),
        "index.mjs": body,
    }
}

const GOOD = bundle(`export default {
    name: "signal",
    version: "1.0.0",
    ${BRAND.slug}Api: "*",
    permissions: [{ kind: "network", hosts: ["signal.example"] }],
    setup(context) { context.defineChannel("signal", () => ({})) },
}
`)

async function add(
    repo: string,
    files: Record<string, string>,
    extra: { ref?: string; name?: string } = {},
): Promise<{ code: number; error?: { code: string } }> {
    try {
        const code = await pluginsCommand({
            action: "add",
            manifestPath,
            rest: [repo],
            ...extra,
            env,
            git: fakeGit(files),
        })
        return { code }
    } catch (error) {
        return { code: -1, error: error as { code: string } }
    }
}

function manifest(): string {
    return readFileSync(manifestPath, "utf8")
}

/** Active lines only: the generated manifest ships a commented `plugins:` example. */
function active(): string {
    return manifest()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
}

/**
 * How many active list entries name this plugin.
 *
 * Quotes are the renderer's decision, not ours: `renderScalar` writes a scalar bare when parsing it
 * back returns the identical string, so `signal` is unquoted and a name that YAML would read as a
 * number or a boolean would not be. Matching either spelling is what keeps this test about the write
 * rather than about the quoting rule.
 */
function names(plugin: string): number {
    const pattern = new RegExp(`^\\s+- ["']?${plugin}["']?\\s*$`, "gm")
    return active().match(pattern)?.length ?? 0
}

describe("add, when the plugin is good", () => {
    test("installs it, names it in the manifest, and discloses what it declared", async () => {
        const result = await add("owner/signal", GOOD)
        expect(result.code).toBe(0)

        // The far end: the entry is in the file, not merely in a return value. The generated manifest
        // ships `plugins:` commented under a phase heading, so this also proves the write uncommented
        // it in place rather than reflowing the file.
        expect(active()).toContain("plugins:")
        expect(names("signal")).toBe(1)
        // The generated manifest ships `plugins:` commented under a phase heading, so this also
        // proves the write uncommented it in place — the alternative reflowed 98 lines once.
        expect(manifest()).not.toContain("# plugins:")

        expect(existsSync(join(pluginDir("signal", env), "index.mjs"))).toBe(true)

        // Disclosure. The permission list and the sentence that it is advisory are the point: a
        // permission list read as enforcement is worse than none.
        expect(out).toContain("signal 1.0.0")
        expect(out).toContain("channel:signal")
        expect(out).toContain("network  signal.example")
        expect(out).toMatch(/advisory/i)
        expect(out).toContain(VERSION)
    })

    test("a plugin declaring no access says so, and says that is not a guarantee", async () => {
        const result = await add(
            "owner/quiet",
            bundle(
                `export default { name: "quiet", version: "1.0.0", ${BRAND.slug}Api: "*", setup(c) { c.defineChannel("quiet", () => ({})) } }`,
            ),
        )
        expect(result.code).toBe(0)
        expect(out).toContain("declares no access")
        expect(out).toContain("not a guarantee")
    })

    test("adding it twice does not write the entry twice", async () => {
        await add("owner/signal", GOOD)
        await add("owner/signal", GOOD)
        expect(names("signal")).toBe(1)
        expect(out).toContain("already names")
    })

    test("--name decides the directory, and the entry says the same thing", async () => {
        const result = await add("owner/signal", GOOD, { name: "my-channel" })
        expect(result.code).toBe(0)
        // The directory name *is* what the manifest entry means, so the two cannot disagree.
        expect(existsSync(pluginDir("my-channel", env))).toBe(true)
        expect(names("my-channel")).toBe(1)
        // Two names, one stated relationship: the plugin calls itself `signal`, and the entry is the
        // directory. `plugins list` keys its rows by the first and the manifest by the second.
        expect(out).toContain('it calls itself "signal"')
    })
})

describe("add refuses, and writes nothing when it does", () => {
    async function refused(
        repo: string,
        files: Record<string, string>,
    ): Promise<{ code: string; directory: boolean; named: boolean }> {
        const name = repo.split("/")[1] as string
        const result = await add(repo, files)
        return {
            code: result.error?.code ?? `no refusal (exit ${result.code})`,
            directory: existsSync(pluginDir(name, env)),
            named: names(name) > 0,
        }
    }

    test("a tree that would need an install — hard rule 5, stated as a refusal", async () => {
        const found = await refused(
            "owner/needy",
            bundle(`export default { name: "needy" }`, { dependencies: { baileys: "^7.0.0" } }),
        )
        expect(found.code).toBe("plugin_not_self_contained")
        expect(found.directory).toBe(false)
        expect(found.named).toBe(false)
    })

    test("a source checkout with no built entry — the commonest mistake, named as itself", async () => {
        const found = await refused("owner/unbuilt", {
            "package.json": JSON.stringify({ main: "dist/index.js" }),
            "src/index.ts": "export default {}",
        })
        expect(found.code).toBe("plugin_entry_missing")
        expect(found.directory).toBe(false)
        expect(found.named).toBe(false)
    })

    test("a module that is not a plugin", async () => {
        const found = await refused("owner/notaplugin", bundle("export default 42\n"))
        expect(found.code).toBe("plugin_malformed")
        expect(found.named).toBe(false)
    })

    test("an object with no setup", async () => {
        const found = await refused(
            "owner/nosetup",
            bundle(`export default { name: "x", version: "1.0.0" }`),
        )
        expect(found.code).toBe("plugin_malformed")
        expect(found.named).toBe(false)
    })

    test("a plugin the conformance suite fails — the same suite its author runs", async () => {
        const found = await refused(
            "owner/unversioned",
            bundle(
                `export default { name: "unversioned", version: "not-semver", ${BRAND.slug}Api: "*", setup(c) { c.defineChannel("x", () => ({})) } }`,
            ),
        )
        expect(found.code).toBe("plugin_not_conformant")
        expect(found.named).toBe(false)
    })

    test("a host range this host does not satisfy — a warning to the suite, a refusal to install", async () => {
        /**
         * The suite only *warns* here, because running it against a newer host than a plugin targets
         * is a normal thing for an author to do. Installing is not: the loader refuses this at boot,
         * so writing the entry would leave an agent that will not start, reported as a success.
         */
        const found = await refused(
            "owner/ancient",
            bundle(
                `export default { name: "ancient", version: "1.0.0", ${BRAND.slug}Api: "^99.0.0", setup(c) { c.defineChannel("x", () => ({})) } }`,
            ),
        )
        expect(found.code).toBe("plugin_api_mismatch")
        expect(found.directory).toBe(false)
        expect(found.named).toBe(false)
    })

    test("a second repository under a name that is taken", async () => {
        await add("owner/signal", GOOD)
        const result = await add("someone-else/signal", GOOD)
        expect(result.error?.code).toBe("plugin_name_taken")
        // And the first one is untouched, which is the whole reason this is a refusal.
        expect(existsSync(join(pluginDir("signal", env), "index.mjs"))).toBe(true)
    })

    test("no repository at all", async () => {
        try {
            await pluginsCommand({ action: "add", manifestPath, rest: [], env })
            expect.unreachable()
        } catch (error) {
            expect((error as { code: string }).code).toBe("cli_plugins_add_needs_repo")
        }
    })
})

describe("remove", () => {
    test("drops the entry and the directory", async () => {
        await add("owner/signal", GOOD)
        const code = await pluginsCommand({
            action: "remove",
            manifestPath,
            rest: ["signal"],
            env,
        })
        expect(code).toBe(0)
        expect(names("signal")).toBe(0)
        expect(existsSync(pluginDir("signal", env))).toBe(false)
    })

    test("keeps the directory when another agent still names it", async () => {
        /**
         * The directory is machine-level and shared. Deleting it while another agent names it would
         * break that agent at its next start — damage done by a command somebody ran about a
         * *different* agent, which is the same call `remove` makes about two directories sharing one
         * manifest id: name it, do not delete it.
         */
        await add("owner/signal", GOOD)
        const other = provisionAgent({
            answers: { user: "Ada", name: "twin" },
            defaults: { agentDirBase: join(home, "agents") },
        })
        const twin = join(other.dir, "agent.yaml")
        await pluginsCommand({
            action: "add",
            manifestPath: twin,
            rest: ["owner/signal"],
            env,
            git: fakeGit(GOOD),
        })

        await pluginsCommand({ action: "remove", manifestPath, rest: ["signal"], env })
        expect(names("signal")).toBe(0)
        expect(existsSync(pluginDir("signal", env))).toBe(true)
        expect(out).toContain("still named by twin")
    })

    test("a name no agent and no directory has is reported, not an error", async () => {
        const code = await pluginsCommand({
            action: "remove",
            manifestPath,
            rest: ["absent"],
            env,
        })
        expect(code).toBe(0)
        expect(out).toContain('does not name "absent"')
        expect(out).toContain("Nothing installed")
    })

    test("no name at all", async () => {
        try {
            await pluginsCommand({ action: "remove", manifestPath, rest: [], env })
            expect.unreachable()
        } catch (error) {
            expect((error as { code: string }).code).toBe("cli_plugins_remove_needs_name")
        }
    })
})
