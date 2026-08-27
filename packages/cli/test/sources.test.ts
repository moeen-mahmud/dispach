/**
 * `sources list|add|remove|update|search`, with git injected and `<ENVPREFIX>HOME` pointed at a tmpdir.
 *
 * **Nothing here reaches a network and nothing here touches the real home directory.** Both are the same
 * rule stated twice: a test suite that clones `github/awesome-copilot` is a suite nobody runs, and one
 * that writes to `~/<stateDir>/sources.json` would edit the machine's own registry from a test run.
 *
 * The fake `Git` writes the skill folders a clone would have produced, which makes the interesting part
 * — the scan, the catalogue, the ranking, the atomic swap — exercised for real against real files, with
 * only the download replaced.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRAND } from "@dispach/core"
import { findAndInstallSkill } from "#lib/init-skills"
import { type Git, looksLikePath, readCatalogue, readMeta } from "#lib/source-cache"
import {
    addSource,
    DEFAULT_SOURCES,
    isSourceName,
    loadSources,
    parseSkillRef,
    parseSourceUrl,
    removeSource,
} from "#lib/sources"
import { sourcesCommand } from "#sources"

const dirs: string[] = []
let home = ""
let env: Record<string, string | undefined> = {}
let written = ""
let restore: (() => void) | undefined

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-sources-"))
    dirs.push(home)
    env = { [`${BRAND.envPrefix}HOME`]: home }
    written = ""
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
        written += String(chunk)
        return true
    }) as typeof process.stdout.write
    restore = () => {
        process.stdout.write = original
    }
})

afterEach(() => {
    restore?.()
    restore = undefined
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

interface FakeSkill {
    readonly path: string
    readonly name?: string
    readonly description?: string
    readonly body?: string
    /** Written into the folder to make it look like it ships code. */
    readonly script?: string
}

/**
 * A `Git` that materialises a fixed set of skills instead of cloning.
 *
 * It honours the argument list the real one is driven by — `clone` writes into the target directory,
 * `sparse-checkout` is accepted, `rev-parse` answers a commit — so a change to how `fetchSource` calls
 * git shows up here as a failure rather than being silently unexercised.
 */
function fakeGit(
    skills: readonly FakeSkill[],
    options: { readonly failClone?: boolean; readonly refuseFilter?: boolean } = {},
): { git: Git; calls: string[][] } {
    const calls: string[][] = []
    const git: Git = async (args, cwd) => {
        calls.push([...args])
        if (args[0] === "clone") {
            if (options.failClone === true) {
                return { code: 128, stdout: "", stderr: "fatal: repository not found" }
            }
            if (options.refuseFilter === true && args.includes("--filter=blob:none")) {
                return { code: 128, stdout: "", stderr: "fatal: filter not supported" }
            }
            const target = args[args.length - 1] as string
            mkdirSync(join(target, ".git"), { recursive: true })
            for (const skill of skills) {
                const dir = join(target, skill.path)
                mkdirSync(dir, { recursive: true })
                const name = skill.name ?? skill.path.slice(skill.path.lastIndexOf("/") + 1)
                writeFileSync(
                    join(dir, "SKILL.md"),
                    `---\nname: ${name}\ndescription: ${skill.description ?? `Does ${name} things.`}\n---\n\n${skill.body ?? "Steps go here."}\n`,
                )
                if (skill.script !== undefined) {
                    mkdirSync(join(dir, "scripts"), { recursive: true })
                    writeFileSync(join(dir, "scripts", skill.script), "print('hi')\n")
                }
            }
            return { code: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "rev-parse") return { code: 0, stdout: "abc1234\n", stderr: "" }
        if (args[0] === "sparse-checkout") {
            expect(cwd === undefined).toBe(false)
            return { code: 0, stdout: "", stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
    }
    return { git, calls }
}

const SKILLS: readonly FakeSkill[] = [
    {
        path: "skills/pdf",
        description:
            "Extract text and tables from PDF files, fill forms, and merge documents. Use for PDFs.",
        script: "extract.py",
    },
    {
        path: "skills/chart-builder",
        description: "Draw bar and line charts from tabular numbers and export them as images.",
    },
    // Nested: a skill inside a skill. Real shape, from `github/awesome-copilot` — `qdrant-scaling`
    // carries four of these, and treating a skill folder as a leaf hid fifteen skills on the first run.
    { path: "skills/scaling", description: "Scale a cluster up and out when load grows." },
    {
        path: "skills/scaling/vertical",
        description: "Add memory and cores to one node rather than adding nodes.",
    },
]

async function run(action: string, rest: readonly string[] = [], git?: Git): Promise<number> {
    return await sourcesCommand({
        action,
        rest,
        env,
        ...(git === undefined ? {} : { git }),
    })
}

describe("the registry", () => {
    test("with no file at all, the built-ins are what you get", async () => {
        expect(loadSources(env).map((spec) => spec.name)).toEqual(
            DEFAULT_SOURCES.map((spec) => spec.name),
        )
        expect(existsSync(join(home, "sources.json"))).toBe(false)
    })

    test("built-ins are never written to the file, so a moved repo is fixed by an upgrade", async () => {
        addSource({ name: "mine", url: "https://example.test/skills" }, env)
        const file = JSON.parse(readFileSync(join(home, "sources.json"), "utf8")) as {
            sources: { name: string }[]
        }
        expect(file.sources.map((entry) => entry.name)).toEqual(["mine"])
    })

    test("a user entry overrides a built-in and keeps its position", async () => {
        const first = DEFAULT_SOURCES[0]?.name as string
        addSource({ name: first, url: "https://example.test/other" }, env)
        const loaded = loadSources(env)
        expect(loaded[0]?.name).toBe(first)
        expect(loaded[0]?.url).toBe("https://example.test/other")
        expect(loaded[0]?.builtin).toBe(false)
    })

    test("a built-in can be removed, and stays removed", async () => {
        const first = DEFAULT_SOURCES[0]?.name as string
        expect(removeSource(first, env)).toBe(true)
        expect(loadSources(env).some((spec) => spec.name === first)).toBe(false)
        // Twice is not an error the second time round — it is already gone — but it must report so.
        expect(removeSource(first, env)).toBe(false)
    })

    test("adding a removed built-in back re-enables it", async () => {
        const first = DEFAULT_SOURCES[0]?.name as string
        removeSource(first, env)
        addSource({ name: first, url: "https://example.test/again" }, env)
        expect(loadSources(env).some((spec) => spec.name === first)).toBe(true)
    })

    test("removing something that was never there is reported, not invented", async () => {
        expect(removeSource("nothing-like-this", env)).toBe(false)
    })

    test("unreadable JSON fails loudly rather than falling back to the built-ins", async () => {
        writeFileSync(join(home, "sources.json"), "{ not json")
        expect(() => loadSources(env)).toThrow()
    })

    test("a name that could not be a directory is refused", async () => {
        expect(isSourceName("anthropic")).toBe(true)
        expect(isSourceName("my-skills")).toBe(true)
        expect(isSourceName("../etc")).toBe(false)
        expect(isSourceName("Anthropic")).toBe(false)
        expect(isSourceName("a/b")).toBe(false)
        expect(isSourceName("")).toBe(false)
    })
})

describe("what a person types for a repository", () => {
    test("owner/repo", async () => {
        expect(parseSourceUrl("anthropics/skills").url).toBe("https://github.com/anthropics/skills")
    })

    test("a clone URL, with .git trimmed", async () => {
        expect(parseSourceUrl("https://github.com/a/b.git").url).toBe("https://github.com/a/b")
    })

    test("the page URL from the address bar carries the branch and the subdirectory", async () => {
        // The case that has to work: this is what somebody pastes after browsing a collection, and
        // refusing it would mean the documented way to add a source is to hand-edit what GitHub gave you.
        const parsed = parseSourceUrl("https://github.com/anthropics/skills/tree/main/skills")
        expect(parsed.url).toBe("https://github.com/anthropics/skills")
        expect(parsed.ref).toBe("main")
        expect(parsed.path).toBe("skills")
    })

    test("a page URL with no subdirectory gives a branch and no path", async () => {
        const parsed = parseSourceUrl("https://github.com/anthropics/skills/tree/main")
        expect(parsed.path).toBe(undefined)
        expect(parsed.ref).toBe("main")
    })

    test("an SSH URL is passed through untouched", async () => {
        expect(parseSourceUrl("git@github.com:a/b.git").url).toBe("git@github.com:a/b.git")
    })

    test("prose is not a repository", async () => {
        expect(() => parseSourceUrl("not a repo at all")).toThrow()
        expect(() => parseSourceUrl("")).toThrow()
        expect(() => parseSourceUrl("anthropic")).toThrow()
    })
})

describe("a skill reference", () => {
    test("bare, and source-qualified", async () => {
        expect(parseSkillRef("pdf")).toEqual({ skill: "pdf" })
        expect(parseSkillRef("anthropic/pdf")).toEqual({ source: "anthropic", skill: "pdf" })
    })

    test("three segments is neither, and says so", async () => {
        expect(() => parseSkillRef("a/b/c")).toThrow()
    })

    test("a path is recognised before it is resolved, so a typo reads as a missing path", async () => {
        expect(looksLikePath("./skils/pdf")).toBe(true)
        expect(looksLikePath("/tmp/nothing-here")).toBe(true)
        expect(looksLikePath("~/skills/pdf")).toBe(true)
        expect(looksLikePath("anthropic/pdf")).toBe(false)
    })
})

describe("fetching", () => {
    function only(): void {
        // One source, so a test's assertions are about it and not about whichever built-in came first.
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        addSource({ name: "test", url: "https://example.test/skills", path: "skills" }, env)
    }

    test("a clone lands in the cache, and the meta records commit and count", async () => {
        only()
        const { git } = fakeGit(SKILLS)
        expect(await run("update", [], git)).toBe(0)
        const meta = readMeta("test", env)
        expect(meta.commit).toBe("abc1234")
        expect(meta.skills).toBe(4)
        expect(typeof meta.fetchedAt).toBe("string")
    })

    test("a nested skill is found, not swallowed by its parent", async () => {
        only()
        const { git } = fakeGit(SKILLS)
        await run("update", [], git)
        const names = readCatalogue(
            { name: "test", url: "https://example.test/skills", path: "skills" },
            env,
        ).map((entry) => entry.skill)
        expect(names.includes("scaling")).toBe(true)
        expect(names.includes("vertical")).toBe(true)
    })

    test("the partial-clone filter is tried, and its refusal is a retry rather than a failure", async () => {
        only()
        const { git, calls } = fakeGit(SKILLS, { refuseFilter: true })
        expect(await run("update", [], git)).toBe(0)
        const clones = calls.filter((args) => args[0] === "clone")
        expect(clones.length).toBe(2)
        expect(clones[0]?.includes("--filter=blob:none")).toBe(true)
        expect(clones[1]?.includes("--filter=blob:none")).toBe(false)
    })

    test("a failed fetch leaves the previous copy in place and exits non-zero", async () => {
        only()
        await run("update", [], fakeGit(SKILLS).git)
        const before = readCatalogue(
            { name: "test", url: "https://example.test/skills", path: "skills" },
            env,
        ).length
        expect(await run("update", [], fakeGit([], { failClone: true }).git)).toBe(1)
        const after = readCatalogue(
            { name: "test", url: "https://example.test/skills", path: "skills" },
            env,
        ).length
        // The atomic swap, asserted rather than described: an interrupted update must not empty the cache.
        expect(after).toBe(before)
        expect(existsSync(join(home, "sources", "test.partial"))).toBe(false)
    })

    test("git's own stderr survives into the message", async () => {
        only()
        await run("update", [], fakeGit([], { failClone: true }).git)
        expect(written.includes("repository not found")).toBe(true)
    })

    test("updating a name that is not configured names what is", async () => {
        expect(await run("update", ["nope"], fakeGit(SKILLS).git)).toBe(1)
        expect(written.includes("no source called nope")).toBe(true)
    })

    test("a skill whose frontmatter will not load is listed with its problem, not dropped", async () => {
        only()
        // `name` must equal the directory per the spec. A mismatch is upstream's bug, and hiding the
        // folder would turn it into "that skill does not exist".
        const { git } = fakeGit([{ path: "skills/mismatch", name: "something-else" }])
        await run("update", [], git)
        const entries = readCatalogue(
            { name: "test", url: "https://example.test/skills", path: "skills" },
            env,
        )
        expect(entries.length).toBe(1)
        expect(entries[0]?.problem === undefined).toBe(false)
    })
})

describe("search", () => {
    async function seeded(): Promise<void> {
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        addSource({ name: "test", url: "https://example.test/skills", path: "skills" }, env)
        await run("update", [], fakeGit(SKILLS).git)
        written = ""
    }

    test("the right skill ranks first", async () => {
        await seeded()
        expect(await run("search", ["pull", "the", "tables", "out", "of", "this", "pdf"])).toBe(0)
        expect(written.indexOf("test/pdf")).toBeGreaterThan(-1)
        expect(written.indexOf("test/pdf")).toBeLessThan(
            written.indexOf("test/chart-builder") === -1
                ? 1e9
                : written.indexOf("test/chart-builder"),
        )
    })

    test("a query about nothing in the catalogue matches nothing, and exits 0", async () => {
        await seeded()
        // The criterion that catches a scorer which always returns something. Not a failure: asking is
        // allowed, and the answer is "no".
        expect(await run("search", ["who", "won", "the", "1998", "world", "cup"])).toBe(0)
        expect(written.includes("matches")).toBe(true)
    })

    test("no query lists everything, which is how you browse a source", async () => {
        await seeded()
        expect(await run("search", [])).toBe(0)
        expect(written.includes("4 skills")).toBe(true)
    })

    test("runnable files are counted in the listing, because that is the trust signal", async () => {
        await seeded()
        await run("search", ["pdf"])
        expect(written.includes("1 runnable file")).toBe(true)
    })

    test("a cold source is fetched on first search, and says so", async () => {
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        addSource({ name: "test", url: "https://example.test/skills", path: "skills" }, env)
        expect(await run("search", ["pdf"], fakeGit(SKILLS).git)).toBe(0)
        expect(written.includes("for the first time")).toBe(true)
    })

    test("with every source unfetchable, search fails rather than reporting an empty catalogue", async () => {
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        addSource({ name: "test", url: "https://example.test/skills", path: "skills" }, env)
        expect(await run("search", ["pdf"], fakeGit([], { failClone: true }).git)).toBe(1)
    })

    test("with no sources at all, it says that instead of searching nothing", async () => {
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        expect(await run("search", ["pdf"])).toBe(1)
        expect(written.includes("no sources configured")).toBe(true)
    })
})

describe("add and list through the command", () => {
    test("a URL with no name is named after the owner", async () => {
        expect(await run("add", ["https://github.com/openclaw/skills"])).toBe(0)
        expect(loadSources(env).some((spec) => spec.name === "openclaw")).toBe(true)
    })

    test("a derived name that collides refuses rather than overwriting", async () => {
        await run("add", ["https://github.com/openclaw/skills"])
        written = ""
        expect(await run("add", ["https://github.com/openclaw/other-skills"])).toBe(1)
        expect(written.includes("already a source")).toBe(true)
    })

    test("an explicit name may replace an existing source", async () => {
        await run("add", ["mine", "https://example.test/one"])
        expect(await run("add", ["mine", "https://example.test/two"])).toBe(0)
        expect(loadSources(env).find((spec) => spec.name === "mine")?.url).toBe(
            "https://example.test/two",
        )
    })

    test("--path beats the path inside a page URL", async () => {
        expect(
            await sourcesCommand({
                action: "add",
                rest: ["https://github.com/x/y/tree/main/skills"],
                path: "other",
                env,
            }),
        ).toBe(0)
        expect(loadSources(env).find((spec) => spec.name === "x")?.path).toBe("other")
    })

    test("list reports a source that has never been fetched as exactly that", async () => {
        expect(await run("list")).toBe(0)
        expect(written.includes("never fetched")).toBe(true)
    })

    test("--json carries the registry path, so a script does not guess it", async () => {
        expect(await sourcesCommand({ action: "list", rest: [], json: true, env })).toBe(0)
        const parsed = JSON.parse(written) as { registry: string; sources: unknown[] }
        expect(parsed.registry.startsWith(home)).toBe(true)
        expect(parsed.sources.length).toBe(DEFAULT_SOURCES.length)
    })

    test("every built-in removed is reported, not rendered as an empty table", async () => {
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        written = ""
        expect(await run("list")).toBe(0)
        expect(written.includes("has been removed")).toBe(true)
    })
})

describe("init --skills find", () => {
    /**
     * The question the whole surface hangs off: `init` asking, rather than a person having to already
     * know the word `sources`. Driven through `findAndInstallSkill` with the same fake git, so the fetch,
     * the ranking, the install and the load check all run for real against real files.
     */
    function agentFor(): string {
        const dir = mkdtempSync(join(tmpdir(), "cli-init-skills-"))
        dirs.push(dir)
        mkdirSync(join(dir, "skills"), { recursive: true })
        mkdirSync(join(dir, "workspace"), { recursive: true })
        writeFileSync(join(dir, "IDENTITY.md"), "A probe.")
        writeFileSync(
            join(dir, "agent.yaml"),
            [
                `apiVersion: ${BRAND.apiVersion}`,
                "id: probe",
                "name: Probe",
                "model:",
                "  main:",
                "    id: gpt-4o-mini",
                "    baseUrl: https://api.example.test/v1",
                "context:",
                "  files:",
                "    - IDENTITY.md",
                "skills:",
                "  dir: ./skills",
                "  maxActive: 1",
                "",
            ].join("\n"),
        )
        return join(dir, "agent.yaml")
    }

    const ANSWERS = {
        user: "M",
        name: "T",
        purpose: "p",
        preset: "openai",
        model: "gpt-5-6-sol",
        baseUrl: "https://api.example.test/v1",
        system: "none",
        web: "none",
        composio: "none",
        telegram: "none",
        schedules: "none",
        server: "none",
        daemon: "none",
        dir: "./t",
    } as const

    async function find(words: string | undefined, git?: Git): Promise<string> {
        const manifestPath = agentFor()
        for (const spec of DEFAULT_SOURCES) removeSource(spec.name, env)
        addSource({ name: "test", url: "https://example.test/skills", path: "skills" }, env)
        written = ""
        await findAndInstallSkill({
            answers: {
                ...ANSWERS,
                skills: "find",
                ...(words === undefined ? {} : { skillsSearch: words }),
            },
            manifestPath,
            env,
            ...(git === undefined ? {} : { git }),
        })
        return manifestPath
    }

    test("the best match is installed", async () => {
        const manifestPath = await find("pull the tables out of this pdf", fakeGit(SKILLS).git)
        expect(written.includes("test/pdf")).toBe(true)
        expect(existsSync(join(dirname(manifestPath), "skills", "pdf", "SKILL.md"))).toBe(true)
    })

    test("the runners-up are named, so the pick is inspectable rather than magic", async () => {
        // A query that genuinely matches more than one, which "tables out of this pdf" does not — the
        // first version of this test asserted on the alternatives of a single-hit query and failed.
        await find("scale the node up and add memory", fakeGit(SKILLS).git)
        expect(written.includes("also matched")).toBe(true)
    })

    test("provenance is written, so `skills list` can say where it came from", async () => {
        const manifestPath = await find("pull the tables out of this pdf", fakeGit(SKILLS).git)
        const origins = JSON.parse(
            readFileSync(join(dirname(manifestPath), "skills", ".origins.json"), "utf8"),
        ) as { origins: Record<string, { source: string; commit: string }> }
        expect(origins.origins.pdf?.source).toBe("test")
        expect(origins.origins.pdf?.commit).toBe("abc1234")
    })

    test("an unreachable source leaves a valid agent and says why", async () => {
        // The rule this path exists under: init must not fail because a network did.
        const manifestPath = await find("pdf tables", fakeGit([], { failClone: true }).git)
        expect(written.includes("no source could be read")).toBe(true)
        expect(existsSync(manifestPath)).toBe(true)
        expect(existsSync(join(dirname(manifestPath), "skills", "pdf"))).toBe(false)
    })

    test("a phrase that matches nothing installs nothing, and does not substitute something else", async () => {
        await find("who won the 1998 world cup", fakeGit(SKILLS).git)
        expect(written.includes("matches those words")).toBe(true)
        expect(written.includes("installed")).toBe(true)
    })

    test("no words at all is reported rather than silently skipped", async () => {
        // Reachable by pressing enter through the wizard with no purpose, since the phrase defaults to it.
        await find(undefined)
        expect(written.includes("no words to search for")).toBe(true)
    })

    test("nothing happens at all unless the answer was `find`", async () => {
        const manifestPath = agentFor()
        written = ""
        await findAndInstallSkill({
            answers: { ...ANSWERS, skills: "starter", skillsSearch: "pdf" },
            manifestPath,
            env,
        })
        // The guard that keeps `--yes` and every scripted run off the network: the `skills` fallback is
        // `starter`, so those runs arrive here with nothing to do and must do nothing.
        expect(written).toBe("")
    })
})
