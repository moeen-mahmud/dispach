import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfigError } from "../src/errors.ts"
import { DEFAULT_PROMPT_STYLE } from "../src/model/prompt-style.ts"
import { cachePath, loadSkills } from "../src/skills/index.ts"
import { activateSkills } from "../src/skills/load.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const roots: string[] = []

function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "skills-"))
    roots.push(dir)
    return dir
}

afterEach(() => {
    while (roots.length > 0) {
        const dir = roots.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

function write(skillsDir: string, name: string, body: string, extra = ""): string {
    const dir = join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "SKILL.md")
    writeFileSync(
        path,
        `---\nname: ${name}\ndescription: Handles ${name} work for the team.${extra}\n---\n\n${body}\n`,
        "utf8",
    )
    return path
}

function load(
    skillsDir: string,
    options: { agentDir?: string; budget?: number; maxActive?: number } = {},
) {
    return loadSkills({
        dir: skillsDir,
        maxActive: options.maxActive ?? 1,
        threshold: 0.35,
        style: DEFAULT_PROMPT_STYLE,
        ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    })
}

describe("the scan", () => {
    test("finds every skill, sorted by name", () => {
        const dir = root()
        write(dir, "zebra", "Do zebra things.")
        write(dir, "alpha", "Do alpha things.")
        expect(load(dir).skills.map((skill) => skill.name)).toEqual(["alpha", "zebra"])
    })

    test("a directory with no SKILL.md is skipped rather than refused", () => {
        // `assets/` or a stray folder beside the skills is ordinary. Refusing the load over one would
        // make the skills directory unusable for anything but skills.
        const dir = root()
        write(dir, "alpha", "Do alpha things.")
        mkdirSync(join(dir, "shared-assets"), { recursive: true })
        expect(load(dir).skills.map((skill) => skill.name)).toEqual(["alpha"])
    })

    test("a missing directory is a load failure, naming the path", () => {
        try {
            load(join(root(), "nope"))
            throw new Error("expected a throw")
        } catch (error) {
            // `toBeInstanceOf` is outside the harness's closed matcher list, and the code is the more
            // useful assertion anyway: it is what a caller switches on.
            expect((error as ConfigError).code).toBe("skills_dir_missing")
            expect((error as ConfigError).field).toBe("skills.dir")
        }
    })

    test("an empty directory loads to an empty catalogue", () => {
        expect(load(root()).skills).toEqual([])
    })

    test("body tokens are measured, which is what makes the budget check possible", () => {
        const dir = root()
        write(dir, "alpha", "word ".repeat(400))
        const skill = load(dir).skills[0]
        expect(skill?.tokens).toBeGreaterThan(100)
    })

    test("a huge body loads, because size is shown rather than refused", () => {
        // Was a refusal against `skills.budget`, and the budget is gone (decision 11.59). A cap on skills
        // only ever turned "the right procedure" into "no procedure": `maxActive` already bounds a turn to
        // one body, and the size of that body is printed in the catalogue where the choice is made.
        const dir = root()
        write(dir, "alpha", "word ".repeat(20_000))
        const catalogue = load(dir)
        expect(catalogue.skills.length).toBe(1)
        expect(catalogue.skills[0]?.tokens).toBeGreaterThan(10_000)
    })
})

describe("the cache", () => {
    test("a cold scan writes it and a second scan reads it", () => {
        const dir = root()
        const agent = root()
        write(dir, "alpha", "Do alpha things.")

        expect(load(dir, { agentDir: agent }).cached).toBe(false)
        expect(readFileSync(cachePath(agent), "utf8")).toContain("alpha")
        expect(load(dir, { agentDir: agent }).cached).toBe(true)
    })

    test("touching one file re-reads one file", () => {
        const dir = root()
        const agent = root()
        write(dir, "alpha", "Do alpha things.")
        const beta = write(dir, "beta", "Do beta things.")
        load(dir, { agentDir: agent })

        // A future mtime rather than `Date.now()`: the two files were written in the same millisecond on
        // a fast disk, so nudging beta forward is the only reliable way to make exactly one entry stale.
        const later = new Date(Date.now() + 10_000)
        utimesSync(beta, later, later)

        const second = load(dir, { agentDir: agent })
        expect(second.cached).toBe(false)
        expect(second.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"])
    })

    test("a changed rendering discards it, because the token counts were measured under the old one", () => {
        const dir = root()
        const agent = root()
        write(dir, "alpha", "Do alpha things.")
        loadSkills({ dir, maxActive: 1, threshold: 0.35, agentDir: agent })

        const other = loadSkills({
            dir,
            maxActive: 1,
            threshold: 0.35,
            agentDir: agent,
            style: { ...DEFAULT_PROMPT_STYLE, delimiters: "xml" },
        })
        expect(other.cached).toBe(false)
    })

    test("a corrupt cache is a cold scan, not a parse error", () => {
        const dir = root()
        const agent = root()
        write(dir, "alpha", "Do alpha things.")
        load(dir, { agentDir: agent })
        writeFileSync(cachePath(agent), "{ this is not json", "utf8")
        expect(load(dir, { agentDir: agent }).cached).toBe(false)
    })

    test("an unwritable cache directory does not fail the boot", () => {
        // A workspace mounted read-only is a real deployment. Losing the cache costs one cold scan per
        // boot, which is not worth refusing to start over.
        //
        // The unwritable path is a regular *file* standing where the cache directory would go, so
        // `mkdirSync` fails `ENOTDIR` immediately. Two other spellings were tried and are worse.
        // `/proc/nonexistent-and-unwritable` **hangs the process on Linux**: procfs answers `mkdir`
        // with `ENOENT` although the parent exists, so Node's recursive mkdirp walks up, finds
        // `/proc`, retries the child, and loops forever — blocking the event loop, which is why no
        // `--test-timeout` can fire and why `node --test` stopped dispatching after this file for
        // five days of CI. On macOS the same path resolves to nothing and fails in a millisecond, so
        // it looked correct everywhere it was run. And `chmod 0o500` on a real directory passes
        // vacuously as root — the write succeeds — which is a container and most CI images.
        const dir = root()
        write(dir, "alpha", "Do alpha things.")
        const blocked = join(root(), "not-a-directory")
        writeFileSync(blocked, "", "utf8")
        const catalogue = load(dir, { agentDir: blocked })
        expect(catalogue.skills.length).toBe(1)
    })

    test("omitting agentDir disables caching entirely", () => {
        const dir = root()
        write(dir, "alpha", "Do alpha things.")
        expect(load(dir).cached).toBe(false)
    })
})

describe("fifty skills", () => {
    function fifty(): { dir: string; agent: string } {
        const dir = root()
        const agent = root()
        for (let index = 0; index < 50; index++) {
            write(dir, `skill-${String(index).padStart(2, "0")}`, `Step one.\nStep two.\n`)
        }
        return { dir, agent }
    }

    test("fifty skills scan, and the second scan is served from the cache", () => {
        // No clock. The 50 ms cold / 5 ms warm criterion lived here as two `toBeLessThan` calls and
        // failed 2 runs in 3 with builds running beside it — which is a shared CI runner every time.
        // Widening the numbers would have relaxed a published criterion quietly, so they moved to
        // `bun run eval:skills`, which takes a median over repeats, states the criterion, and enforces
        // a ceiling ten times above it. `evals/skills/README.md` carries the measurements. What is
        // left here is the part that is not about time and does not flake.
        const { dir, agent } = fifty()

        const cold = load(dir, { agentDir: agent })
        expect(cold.skills.length).toBe(50)
        expect(cold.cached).toBe(false)

        const warm = load(dir, { agentDir: agent })
        expect(warm.cached).toBe(true)
        expect(warm.skills.length).toBe(50)
        // A cache is only worth having if it returns the same catalogue, and a token count that moved
        // would betray that faster than a list of names — the counts are what the budget reads.
        expect(warm.skills.map((skill) => skill.tokens)).toEqual(
            cold.skills.map((skill) => skill.tokens),
        )
    })
})

describe("activation", () => {
    function catalogueOf(dir: string, maxActive = 1) {
        return load(dir, { maxActive })
    }

    test("the body is read on activation, not at scan time", () => {
        const dir = root()
        write(dir, "alpha", "The alpha procedure body.")
        write(dir, "beta", "The beta procedure body.")
        write(dir, "gamma", "Unrelated.")
        write(dir, "delta", "Unrelated.")

        const { active } = activateSkills({
            input: "alpha",
            catalogue: catalogueOf(dir),
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active.length).toBe(1)
        expect(active[0]?.name).toBe("alpha")
        expect(active[0]?.content).toContain("The alpha procedure body.")
    })

    test("an edited body takes effect on the next turn, without a re-scan", () => {
        const dir = root()
        write(dir, "alpha", "Original body.")
        write(dir, "beta", "Unrelated.")
        write(dir, "gamma", "Unrelated.")
        write(dir, "delta", "Unrelated.")
        const catalogue = catalogueOf(dir)

        write(dir, "alpha", "Replaced body.")
        const { active } = activateSkills({
            input: "alpha",
            catalogue,
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active[0]?.content).toContain("Replaced body.")
    })

    test("a body that grew since the scan still activates, and the turn is charged what it really costs", () => {
        // Was a drop against `skills.budget`, which is gone (decision 11.59). The re-measure stays: the
        // catalogue's figure is from the last cold scan, and the activation reports what the file costs
        // *now* rather than what it cost then. Nothing refuses on size.
        const dir = root()
        write(dir, "alpha", "Small body.")
        write(dir, "beta", "Unrelated.")
        write(dir, "gamma", "Unrelated.")
        write(dir, "delta", "Unrelated.")
        const catalogue = catalogueOf(dir)
        const scanned = catalogue.skills.find((skill) => skill.name === "alpha")?.tokens ?? 0

        write(dir, "alpha", "word ".repeat(500))
        const { active, notes } = activateSkills({
            input: "alpha",
            catalogue,
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active.length).toBe(1)
        expect(notes).toEqual([])
        expect(active[0]?.tokens).toBeGreaterThan(scanned)
    })

    test("a deleted body is dropped with a named reason rather than failing the turn", () => {
        const dir = root()
        write(dir, "alpha", "Body.")
        write(dir, "beta", "Unrelated.")
        write(dir, "gamma", "Unrelated.")
        write(dir, "delta", "Unrelated.")
        const catalogue = catalogueOf(dir)

        rmSync(join(dir, "alpha"), { recursive: true, force: true })
        const { active, notes } = activateSkills({
            input: "alpha",
            catalogue,
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active).toEqual([])
        expect(notes[0]?.code).toBe("skill_not_applied")
    })

    test("nothing activates below the threshold", () => {
        const dir = root()
        write(dir, "alpha", "Body.")
        write(dir, "beta", "Unrelated.")
        write(dir, "gamma", "Unrelated.")
        write(dir, "delta", "Unrelated.")
        const { active } = activateSkills({
            input: "what is the capital of peru",
            catalogue: catalogueOf(dir),
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active).toEqual([])
    })

    test("maxActive of zero activates nothing, whatever the scores", () => {
        const dir = root()
        write(dir, "alpha", "Body.")
        const { active } = activateSkills({
            input: "alpha",
            catalogue: catalogueOf(dir, 0),
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active).toEqual([])
    })

    test("an empty catalogue activates nothing", () => {
        const { active, notes } = activateSkills({
            input: "anything",
            catalogue: catalogueOf(root()),
            style: DEFAULT_PROMPT_STYLE,
        })
        expect(active).toEqual([])
        expect(notes).toEqual([])
    })
})
