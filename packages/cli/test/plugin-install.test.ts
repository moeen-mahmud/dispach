/**
 * Fetching a plugin, with git injected and `<ENVPREFIX>HOME` pointed at a tmpdir.
 *
 * **Nothing here reaches a network and nothing here touches the real plugin root.** The fake `Git`
 * writes the tree a clone would have produced, which leaves the interesting parts real: the
 * self-contained check, the subdirectory case, the partial-then-rename swap, and the provenance file.
 *
 * The swap is the thing most worth testing rather than reading. A failure part-way through must leave
 * whatever was installed under that name loadable — an interrupted update that left a half-fetched
 * directory would be a broken agent at the next start, caused by a command that reported an error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRAND } from "@dispach/core"
import {
    entryOf,
    fetchPlugin,
    installedPlugins,
    notSelfContained,
    ORIGIN_FILE,
    type PluginOrigin,
    pluginNameFor,
} from "#lib/plugin-install"
import { pluginDir, pluginRoot } from "#lib/sandbox"
import type { Git } from "#lib/source-cache"

const dirs: string[] = []
let home = ""
let env: Record<string, string | undefined> = {}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-plugins-"))
    dirs.push(home)
    env = { [`${BRAND.envPrefix}HOME`]: home }
})

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
}

/** A clone that writes `files` into the target directory, keyed by path inside the repository. */
function fakeGit(files: Readonly<Record<string, string>>, commit = "abc1234"): Git {
    return async (args) => {
        if (args[0] === "clone") {
            const target = args[args.length - 1] as string
            for (const [path, text] of Object.entries(files)) write(join(target, path), text)
            write(join(target, ".git", "HEAD"), "ref: refs/heads/main\n")
            return { code: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "rev-parse") return { code: 0, stdout: `${commit}\n`, stderr: "" }
        return { code: 0, stdout: "", stderr: "" }
    }
}

const BUNDLE = {
    "package.json": JSON.stringify({ name: "a-plugin", version: "1.0.0", main: "dist/index.js" }),
    "dist/index.js": "export default { name: 'a-plugin' }\n",
}

describe("the name a plugin is installed under", () => {
    test("comes from the repository, and from the subdirectory when the URL names one", () => {
        expect(pluginNameFor("https://github.com/owner/some-plugin", undefined)).toBe("some-plugin")
        // A monorepo's package is the plugin, not the repository it happens to live in.
        expect(pluginNameFor("https://github.com/owner/mono", "packages/channel-signal")).toBe(
            "channel-signal",
        )
        expect(pluginNameFor("https://github.com/owner/some-plugin.git", undefined)).toBe(
            "some-plugin",
        )
    })

    test("is refused rather than transformed when it is not a directory name", () => {
        // Lowercasing it silently would put the code somewhere other than where the `plugins:` entry
        // a person then reads says it is.
        for (const url of ["https://github.com/owner/My-Plugin", "https://github.com/owner/a_b"]) {
            let code = ""
            try {
                pluginNameFor(url, undefined)
            } catch (error) {
                code = (error as { code: string }).code
            }
            expect(code).toBe("plugin_name_invalid")
        }
    })
})

describe("self-contained, which is the whole distribution rule", () => {
    test("no package.json declares nothing, so there is nothing to install", () => {
        const dir = join(home, "plain")
        write(join(dir, "index.js"), "")
        expect(notSelfContained(dir)).toBeUndefined()
    })

    test("an empty dependencies block is fine", () => {
        const dir = join(home, "empty")
        write(join(dir, "package.json"), JSON.stringify({ dependencies: {} }))
        expect(notSelfContained(dir)).toBeUndefined()
    })

    test("declared dependencies with nothing to resolve them is the refusal", () => {
        const dir = join(home, "needy")
        write(
            join(dir, "package.json"),
            JSON.stringify({ dependencies: { baileys: "^7", pino: "^9" } }),
        )
        const problem = notSelfContained(dir)
        expect(problem).toContain("2 runtime dependencies")
        expect(problem).toContain("baileys")
    })

    test("a committed node_modules clears it — vendoring is a way of being self-contained", () => {
        const dir = join(home, "vendored")
        write(join(dir, "package.json"), JSON.stringify({ dependencies: { baileys: "^7" } }))
        mkdirSync(join(dir, "node_modules"), { recursive: true })
        expect(notSelfContained(dir)).toBeUndefined()
    })

    test("a package.json that will not parse is reported here, not at the next boot", () => {
        const dir = join(home, "broken")
        write(join(dir, "package.json"), "{nope")
        expect(notSelfContained(dir)).toContain("not valid JSON")
    })
})

describe("the entry derivation agrees with the loader's", () => {
    test("main when there is one, index.js when there is not", () => {
        const dir = join(home, "e")
        write(join(dir, "package.json"), JSON.stringify({ main: "dist/index.js" }))
        expect(entryOf(dir)).toBe(join(dir, "dist", "index.js"))
        const bare = join(home, "bare")
        mkdirSync(bare, { recursive: true })
        expect(entryOf(bare)).toBe(join(bare, "index.js"))
    })
})

describe("fetching", () => {
    test("clones, drops .git, and records where the code came from", async () => {
        const result = await fetchPlugin(
            { name: "a-plugin", url: "https://github.com/owner/a-plugin", ref: "v1.0.0" },
            { env, git: fakeGit(BUNDLE, "deadbee") },
        )
        expect(result.dir).toBe(pluginDir("a-plugin", env))
        expect(result.commit).toBe("deadbee")
        expect(existsSync(join(result.dir, "dist", "index.js"))).toBe(true)
        // A plugin directory is a vendored artefact, not a checkout: leaving .git there invites a
        // `git pull` that moves the code out from under the recorded commit with nothing reporting it.
        expect(existsSync(join(result.dir, ".git"))).toBe(false)

        const origin = JSON.parse(
            readFileSync(join(result.dir, ORIGIN_FILE), "utf8"),
        ) as PluginOrigin
        expect(origin.url).toBe("https://github.com/owner/a-plugin")
        expect(origin.ref).toBe("v1.0.0")
        expect(origin.commit).toBe("deadbee")
    })

    test("--ref reaches git as --branch, which is the only thing that pins the code", async () => {
        const seen: string[][] = []
        const git: Git = async (args) => {
            seen.push([...args])
            if (args[0] === "clone") {
                write(join(args[args.length - 1] as string, "index.js"), "")
                return { code: 0, stdout: "", stderr: "" }
            }
            return { code: 0, stdout: "aaa1111\n", stderr: "" }
        }
        await fetchPlugin(
            { name: "pinned", url: "https://example.test/p", ref: "v2" },
            { env, git },
        )
        expect(seen[0]).toContain("--branch")
        expect(seen[0]).toContain("v2")
    })

    test("a subdirectory URL installs the subdirectory, not the repository", async () => {
        const result = await fetchPlugin(
            {
                name: "channel-signal",
                url: "https://github.com/owner/mono",
                path: "packages/channel-signal",
            },
            {
                env,
                git: fakeGit({
                    "README.md": "the monorepo",
                    "packages/channel-signal/package.json": JSON.stringify({ main: "index.js" }),
                    "packages/channel-signal/index.js": "",
                }),
            },
        )
        expect(existsSync(join(result.dir, "index.js"))).toBe(true)
        // The repository's own root is not the plugin and must not come along.
        expect(existsSync(join(result.dir, "README.md"))).toBe(false)
        expect(existsSync(join(result.dir, "packages"))).toBe(false)
    })

    test("a subdirectory that is not in the repository is refused, and nothing is left behind", async () => {
        let code = ""
        try {
            await fetchPlugin(
                { name: "absent", url: "https://example.test/p", path: "packages/nope" },
                { env, git: fakeGit({ "index.js": "" }) },
            )
        } catch (error) {
            code = (error as { code: string }).code
        }
        expect(code).toBe("plugin_path_missing")
        expect(existsSync(`${pluginDir("absent", env)}.partial`)).toBe(false)
    })

    test("a failed clone leaves no directory at all, rather than an empty one", async () => {
        const git: Git = async () => ({ code: 128, stdout: "", stderr: "repository not found" })
        let code = ""
        try {
            await fetchPlugin({ name: "gone", url: "https://example.test/gone" }, { env, git })
        } catch (error) {
            code = (error as { code: string }).code
        }
        expect(code).toBe("plugin_fetch_failed")
        expect(existsSync(pluginDir("gone", env))).toBe(false)
        expect(existsSync(`${pluginDir("gone", env)}.partial`)).toBe(false)
    })

    test("a refusal from inspect leaves the previous copy installed and loadable", async () => {
        // The whole reason the inspection runs against the partial directory. An `add` that refused
        // *after* replacing the directory would break an agent that was working a moment earlier.
        await fetchPlugin(
            { name: "a-plugin", url: "https://github.com/owner/a-plugin" },
            { env, git: fakeGit(BUNDLE, "first11") },
        )
        let code = ""
        try {
            await fetchPlugin(
                { name: "a-plugin", url: "https://github.com/owner/a-plugin", ref: "broken" },
                {
                    env,
                    git: fakeGit({ "package.json": JSON.stringify({ main: "dist/index.js" }) }),
                    inspect: () => {
                        throw Object.assign(new Error("no entry"), { code: "plugin_entry_missing" })
                    },
                },
            )
        } catch (error) {
            code = (error as { code: string }).code
        }
        expect(code).toBe("plugin_entry_missing")
        const dir = pluginDir("a-plugin", env)
        expect(existsSync(join(dir, "dist", "index.js"))).toBe(true)
        const origin = JSON.parse(readFileSync(join(dir, ORIGIN_FILE), "utf8")) as PluginOrigin
        expect(origin.commit).toBe("first11")
        expect(existsSync(`${dir}.partial`)).toBe(false)
    })

    test("re-fetching replaces the tree rather than merging into it", async () => {
        await fetchPlugin(
            { name: "a-plugin", url: "https://github.com/owner/a-plugin" },
            { env, git: fakeGit({ ...BUNDLE, "stale.js": "gone next time" }, "old0000") },
        )
        const result = await fetchPlugin(
            { name: "a-plugin", url: "https://github.com/owner/a-plugin" },
            { env, git: fakeGit(BUNDLE, "new1111") },
        )
        expect(existsSync(join(result.dir, "stale.js"))).toBe(false)
        expect(result.commit).toBe("new1111")
    })
})

describe("what is installed, which is a different question from what an agent loads", () => {
    test("nothing installed is the normal first state, not an error", () => {
        expect(installedPlugins(env)).toEqual([])
        expect(existsSync(pluginRoot(env))).toBe(false)
    })

    test("lists directories with their provenance, and skips a partial fetch", async () => {
        await fetchPlugin(
            { name: "a-plugin", url: "https://github.com/owner/a-plugin" },
            { env, git: fakeGit(BUNDLE, "cafe123") },
        )
        write(join(`${pluginDir("half", env)}.partial`, "index.js"), "")
        const found = installedPlugins(env)
        expect(found.map((entry) => entry.name)).toEqual(["a-plugin"])
        expect(found[0]?.origin?.commit).toBe("cafe123")
    })

    test("a plugin whose provenance file is gone is still listed", async () => {
        await fetchPlugin(
            { name: "a-plugin", url: "https://github.com/owner/a-plugin" },
            { env, git: fakeGit(BUNDLE) },
        )
        rmSync(join(pluginDir("a-plugin", env), ORIGIN_FILE))
        const found = installedPlugins(env)
        expect(found.map((entry) => entry.name)).toEqual(["a-plugin"])
        expect(found[0]?.origin).toBeUndefined()
    })
})
