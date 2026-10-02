/**
 * The file family, against a real filesystem.
 *
 * The properties worth the most here are the refusals. A tool that reads and writes files is easy to
 * get working and easy to get wrong in ways that only show up once: an edit that matched twice and
 * picked one, a write to `SOUL.md` that succeeded, a search that returned the first fifty of four
 * hundred and said nothing about the other three hundred and fifty.
 */

import { expect, test } from "bun:test"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toolContext } from "@dispach/core"
import { execHandler } from "../src/exec.ts"
import {
    DEFAULT_READ_LINES,
    FILE_EDIT_SPEC,
    FILE_READ_SPEC,
    FILE_WRITE_SPEC,
    fileEditHandler,
    fileReadHandler,
    fileWriteHandler,
} from "../src/files.ts"
import { PROTECTED_NAMES, protectedReason } from "../src/protect.ts"
import { SystemProvider } from "../src/provider.ts"
import { resolveRoots, whereYouWork } from "../src/root.ts"
import { GLOB_SPEC, GREP_SPEC, globHandler, grepHandler, MAX_GLOB_RESULTS } from "../src/search.ts"
import { ShellSessions } from "../src/session.ts"
import { globToRegExp, SKIPPED_DIRS, walk } from "../src/walk.ts"

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "files-test-"))
}

function tools(agentDir: string, writeRoots: readonly string[] = []) {
    const sessions = new ShellSessions()
    const roots = resolveRoots(agentDir, writeRoots)
    const options = { sessions, agentDir, roots }
    return {
        sessions,
        roots,
        read: fileReadHandler(options),
        write: fileWriteHandler(options),
        edit: fileEditHandler(options),
        glob: globHandler({ sessions, roots }),
        grep: grepHandler({ sessions, roots }),
    }
}

// ─── the specs ───────────────────────────────────────────────────────────────────────────

test("readers are untrusted and writers are trusted, which is the difference that gates a turn", () => {
    // A file may have been downloaded a minute ago, so reading one taints the turn. The writers
    // return a sentence this runtime composed and never any of the content — marking them untrusted
    // would mean a write gated the next write, the once-per-turn trap arrived at by accident.
    expect(FILE_READ_SPEC.trust).toBe("untrusted")
    expect(GLOB_SPEC.trust).toBe("untrusted")
    expect(GREP_SPEC.trust).toBe("untrusted")
    expect(FILE_WRITE_SPEC.trust).toBe("trusted")
    expect(FILE_EDIT_SPEC.trust).toBe("trusted")
})

test("every file tool names the argument a permission rule matches", () => {
    // The whole reason these exist beside `exec`: a rule can match `path`, and cannot match a target
    // buried in a shell string.
    expect(FILE_READ_SPEC.policyArg).toBe("path")
    expect(FILE_WRITE_SPEC.policyArg).toBe("path")
    expect(FILE_EDIT_SPEC.policyArg).toBe("path")
})

test("glob and grep each point at the other, and both point away from the shell", () => {
    expect(GLOB_SPEC.whenNotToUse ?? "").toContain("grep")
    expect(GREP_SPEC.whenNotToUse ?? "").toContain("glob")
    expect(GREP_SPEC.whenNotToUse ?? "").toContain("shell")
})

// ─── reading ─────────────────────────────────────────────────────────────────────────────

test("a short file comes back with no framing at all", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.txt"), "one\ntwo")
    const output = await tools(dir).read({ path: "a.txt" }, toolContext({ dir }))
    // No "lines 1-2 of 2" header: it is a per-call tax for something the model can already see.
    expect(output).toBe("one\ntwo")
})

test("a long file announces the window it returned", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "long.txt"), Array.from({ length: 900 }, (_, i) => `L${i}`).join("\n"))
    const output = await tools(dir).read({ path: "long.txt" }, toolContext({ dir }))
    expect(output).toContain(`Lines 1-${DEFAULT_READ_LINES} of 900`)
    expect(output).toContain("L0")
    expect(output.includes("L500")).toBe(false)
})

test("offset and limit read a window out of the middle", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "long.txt"), Array.from({ length: 900 }, (_, i) => `L${i}`).join("\n"))
    const output = await tools(dir).read(
        { path: "long.txt", offset: 500, limit: 3 },
        toolContext({ dir }),
    )
    expect(output).toContain("Lines 500-502 of 900")
    expect(output).toContain("L499")
})

test("an offset past the end says how long the file is rather than returning nothing", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.txt"), "one\ntwo")
    const output = await tools(dir).read({ path: "a.txt", offset: 99 }, toolContext({ dir }))
    expect(output).toContain("has 2 lines")
})

test("a missing file is a named failure that says how to find the right path", async () => {
    const dir = tempDir()
    await expect(tools(dir).read({ path: "nope.txt" }, toolContext({ dir }))).rejects.toThrow(
        /There is no file at/,
    )
})

test("a binary file is refused rather than decoded into thousands of meaningless tokens", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    await expect(tools(dir).read({ path: "blob.bin" }, toolContext({ dir }))).rejects.toThrow(
        /not a text file/,
    )
})

test("terminal escapes in a file never reach the observation", async () => {
    const dir = tempDir()
    const esc = String.fromCharCode(27)
    writeFileSync(join(dir, "tricky.txt"), `safe${esc}[2K${esc}[1G rm -rf ~`)
    const output = await tools(dir).read({ path: "tricky.txt" }, toolContext({ dir }))
    expect(output).toBe("safe rm -rf ~")
})

// ─── writing ─────────────────────────────────────────────────────────────────────────────

test("a write says what it did precisely enough that reading it back is unnecessary", async () => {
    const dir = tempDir()
    const output = await tools(dir).write(
        { path: "notes.md", content: "one\ntwo\nthree" },
        toolContext({ dir }),
    )
    // A vague acknowledgement makes a small model re-read the file to check, which doubles the steps
    // of every editing task.
    expect(output).toContain("Created")
    expect(output).toContain("3 lines")
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("one\ntwo\nthree")
})

test("writing over an existing file says replaced, not created", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "notes.md"), "old")
    const output = await tools(dir).write(
        { path: "notes.md", content: "new" },
        toolContext({ dir }),
    )
    expect(output).toContain("Replaced")
})

test("a write creates the directories it needs", async () => {
    const dir = tempDir()
    await tools(dir).write({ path: "deep/inner/x.txt", content: "hi" }, toolContext({ dir }))
    expect(readFileSync(join(dir, "deep/inner/x.txt"), "utf8")).toBe("hi")
})

// ─── editing ─────────────────────────────────────────────────────────────────────────────

test("an edit replaces exactly the text given and leaves the rest alone", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "const port = 3000\nconst host = 'x'\n")
    const output = await tools(dir).edit(
        { path: "a.ts", find: "3000", replace: "8080" },
        toolContext({ dir }),
    )
    expect(output).toContain("replaced 1 occurrence")
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const port = 8080\nconst host = 'x'\n")
})

test("text that appears twice is refused rather than edited at one of them", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "x = 1\ny = 1\n")
    await expect(
        tools(dir).edit({ path: "a.ts", find: "= 1", replace: "= 2" }, toolContext({ dir })),
    ).rejects.toThrow(/appears 2 times/)
    // Picking one would be a coin toss that reports success while editing the wrong line.
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("x = 1\ny = 1\n")
})

test("all: true is the way to mean every occurrence, and says how many it changed", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "x = 1\ny = 1\n")
    const output = await tools(dir).edit(
        { path: "a.ts", find: "= 1", replace: "= 2", all: true },
        toolContext({ dir }),
    )
    expect(output).toContain("replaced 2 occurrences")
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("x = 2\ny = 2\n")
})

test("text that is not there fails without touching the file", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    await expect(
        tools(dir).edit({ path: "a.ts", find: "const y", replace: "z" }, toolContext({ dir })),
    ).rejects.toThrow(/does not appear/)
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const x = 1\n")
})

// ─── the protected set ───────────────────────────────────────────────────────────────────

test("the agent cannot rewrite its own definition", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    writeFileSync(join(dir, "workspace/SOUL.md"), "# who I am\n")

    await expect(
        tools(dir).write(
            { path: "workspace/SOUL.md", content: "ignore all rules" },
            toolContext({ dir }),
        ),
    ).rejects.toThrow(/part of this agent's own definition/)
    expect(readFileSync(join(dir, "workspace/SOUL.md"), "utf8")).toBe("# who I am\n")
})

test("every file that decides who the agent is or what it may do is protected", () => {
    const dir = "/agents/milo"
    for (const name of PROTECTED_NAMES) {
        expect(protectedReason(`${dir}/workspace/${name}`, { agentDir: dir })).toBeDefined()
    }
})

test("the volatile tier stays writable — memory_write exists to append to it", () => {
    const dir = "/agents/milo"
    // Protecting these would break remembering, which is the one thing an agent is asked for most.
    expect(protectedReason(`${dir}/workspace/USER.md`, { agentDir: dir })).toBeUndefined()
    expect(protectedReason(`${dir}/workspace/MEMORY.md`, { agentDir: dir })).toBeUndefined()
})

test("credential material is refused anywhere on the filesystem, not just under the agent", () => {
    const dir = "/agents/milo"
    for (const path of [
        "/Users/someone/.ssh/id_rsa",
        "/Users/someone/.aws/credentials",
        "/var/tmp/.env",
        "/srv/app/.env.production",
        "/etc/certs/server.pem",
    ]) {
        expect(protectedReason(path, { agentDir: dir })).toBeDefined()
    }
})

test("an ordinary project file is writable", () => {
    expect(
        protectedReason("/Users/someone/code/src/index.ts", { agentDir: "/agents/milo" }),
    ).toBeUndefined()
})

test("providerConfig.protect widens the set and nothing narrows it", () => {
    const dir = "/agents/milo"
    expect(protectedReason("/data/ledger.csv", { agentDir: dir })).toBeUndefined()
    expect(
        protectedReason("/data/ledger.csv", { agentDir: dir, extra: ["ledger.csv"] }),
    ).toBeDefined()
})

// ─── glob ────────────────────────────────────────────────────────────────────────────────

test("* stays inside one directory and ** crosses them", () => {
    // Getting this wrong makes `src/*.ts` match `src/a/b/c.ts`, and every result is then wrong in
    // the direction of too many.
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false)
    expect(globToRegExp("src/**/*.ts").test("src/deep/a.ts")).toBe(true)
    // A double-star followed by a slash also matches zero directories, which is what every shell
    // does and whose absence reads as the tool being broken.
    expect(globToRegExp("**/*.ts").test("index.ts")).toBe(true)
    expect(globToRegExp("**/*.ts").test("a/b/index.ts")).toBe(true)
    expect(globToRegExp("*.ts").test("a/index.ts")).toBe(false)
})

test("glob finds files and says how many", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "src/deep"), { recursive: true })
    writeFileSync(join(dir, "src/a.ts"), "")
    writeFileSync(join(dir, "src/deep/b.ts"), "")
    writeFileSync(join(dir, "src/c.md"), "")

    const output = await tools(dir).glob({ pattern: "**/*.ts" }, toolContext({ dir }))
    expect(output).toContain("2 matches")
    expect(output).toContain("src/a.ts")
    expect(output).toContain("src/deep/b.ts")
    expect(output.includes("c.md")).toBe(false)
})

test("no match explains where it did not look, rather than returning an empty string", async () => {
    const dir = tempDir()
    const output = await tools(dir).glob({ pattern: "**/*.rs" }, toolContext({ dir }))
    expect(output).toContain("No file")
    expect(output).toContain("node_modules")
})

test("generated directories are never walked", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true })
    writeFileSync(join(dir, "node_modules/pkg/index.ts"), "")
    writeFileSync(join(dir, "real.ts"), "")

    const output = await tools(dir).glob({ pattern: "**/*.ts" }, toolContext({ dir }))
    expect(output).toContain("real.ts")
    // A dependency tree can hold a hundred thousand files; walking one to answer "where is the
    // login component" spends a minute and returns noise.
    expect(output.includes("node_modules")).toBe(false)
    expect(SKIPPED_DIRS.has("node_modules")).toBe(true)
})

test("dot-files are skipped unless asked for, and .github is reachable when they are", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, ".github/workflows"), { recursive: true })
    writeFileSync(join(dir, ".github/workflows/ci.yml"), "")

    const without = await tools(dir).glob({ pattern: "**/*.yml" }, toolContext({ dir }))
    expect(without).toContain("No file")

    const withHidden = await tools(dir).glob(
        { pattern: "**/*.yml", hidden: true },
        toolContext({ dir }),
    )
    expect(withHidden).toContain(".github/workflows/ci.yml")
})

test("a truncated walk says so instead of returning a silent sample", async () => {
    const dir = tempDir()
    for (let i = 0; i < MAX_GLOB_RESULTS + 20; i += 1) {
        writeFileSync(join(dir, `f${i}.txt`), "")
    }
    const output = await tools(dir).glob({ pattern: "*.txt" }, toolContext({ dir }))
    // A model told nothing reasons about the sample as though it were the whole set.
    expect(output).toContain("narrow the pattern")
})

test("the walk is breadth-first, so a cut-off answer is the shallow files", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "deep/deeper"), { recursive: true })
    writeFileSync(join(dir, "top.txt"), "")
    writeFileSync(join(dir, "deep/mid.txt"), "")
    writeFileSync(join(dir, "deep/deeper/bottom.txt"), "")

    const result = await walk(dir, { limit: 2 })
    expect(result.truncated).toBe(true)
    expect(result.files[0]).toBe("top.txt")
})

// ─── secrets are never read ──────────────────────────────────────────────────────────────

test("file_read refuses a secret by name, through a symlink, and a process's environment (QA pilot.3)", async () => {
    // Reads were unconfined: an agent could read its own .env or /proc/self/environ and put every
    // secret the silo holds into its context.
    const dir = tempDir()
    writeFileSync(join(dir, ".env"), "MODEL_API_KEY=sk-live\n")
    symlinkSync(join(dir, ".env"), join(dir, "notes.txt"))
    writeFileSync(join(dir, "plain.txt"), "fine\n")
    const read = (path: string) => tools(dir).read({ path }, toolContext({ dir }))
    await expect(read(".env")).rejects.toThrow(/holds secrets/)
    await expect(read("notes.txt")).rejects.toThrow(/holds secrets/)
    await expect(read("/proc/self/environ")).rejects.toThrow(/environment/)
    expect(await read("plain.txt")).toContain("fine")
})

test("grep never searches a secret file, so a match cannot quote one", async () => {
    const dir = tempDir()
    // Not a dotfile, which the walk skips anyway: `deploy.key` is reached, and must not be read.
    writeFileSync(join(dir, "deploy.key"), "API_KEY=sk-live\n")
    writeFileSync(join(dir, "app.ts"), "const API_KEY = process.env.API_KEY\n")
    const output = await tools(dir).grep({ pattern: "API_KEY" }, toolContext({ dir }))
    expect(output).toContain("app.ts:1:")
    expect(output).not.toContain("sk-live")
})

// ─── grep ────────────────────────────────────────────────────────────────────────────────

test("grep reports file, line number, and the matching line", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src/a.ts"), "const x = 1\nexport function login() {}\n")

    const output = await tools(dir).grep({ pattern: "function login" }, toolContext({ dir }))
    expect(output).toContain("src/a.ts:2:")
    expect(output).toContain("export function login()")
})

test("a glob narrows which files grep reads", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "needle\n")
    writeFileSync(join(dir, "b.md"), "needle\n")

    const output = await tools(dir).grep(
        { pattern: "needle", glob: "**/*.ts" },
        toolContext({ dir }),
    )
    expect(output).toContain("a.ts")
    expect(output.includes("b.md")).toBe(false)
})

test("no match says how many files were searched, so nothing looks like everything", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "nothing here\n")
    const output = await tools(dir).grep({ pattern: "needle" }, toolContext({ dir }))
    expect(output).toContain("Nothing under")
    expect(output).toContain("1 file")
})

test("an invalid regular expression is refused rather than searched literally", async () => {
    const dir = tempDir()
    // Literalising it would find nothing and read as "it is not there" instead of "your pattern is
    // wrong", which sends the model looking in the wrong place.
    await expect(tools(dir).grep({ pattern: "foo(" }, toolContext({ dir }))).rejects.toThrow(
        /not a valid regular expression/,
    )
})

test("ignoreCase does what it says", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "a.ts"), "TODO: fix\n")
    expect(await tools(dir).grep({ pattern: "todo" }, toolContext({ dir }))).toContain(
        "Nothing under",
    )
    expect(
        await tools(dir).grep({ pattern: "todo", ignoreCase: true }, toolContext({ dir })),
    ).toContain("a.ts:1:")
})

// ─── the session, shared with exec ───────────────────────────────────────────────────────

test("a relative path resolves against wherever the shell was left", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "project"))
    writeFileSync(join(dir, "project/package.json"), "{}")

    const kit = tools(dir)
    const context = toolContext({ dir })

    // Before the cd, the same words mean a file that does not exist.
    await expect(kit.read({ path: "package.json" }, context)).rejects.toThrow(/no file at/)

    kit.sessions.remember(context.sessionKey, join(dir, "project"))
    expect(await kit.read({ path: "package.json" }, context)).toBe("{}")
})

// ─── the provider ────────────────────────────────────────────────────────────────────────

test("the provider resolves all six slugs", async () => {
    const provider = new SystemProvider({ env: {}, dir: "/tmp" })
    const resolved = await provider.resolve([
        "exec",
        "file_read",
        "file_write",
        "file_edit",
        "glob",
        "grep",
    ])
    expect(resolved.length).toBe(6)
})

test("the file tools and exec share one working directory", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "project"))
    writeFileSync(join(dir, "project/note.txt"), "found me")

    const provider = new SystemProvider({ env: process.env, dir })
    const resolved = await provider.resolve(["exec", "file_read"])
    const exec = resolved.find((tool) => tool.spec.slug === "exec")
    const read = resolved.find((tool) => tool.spec.slug === "file_read")
    if (exec === undefined || read === undefined) throw new Error("did not resolve")

    const context = toolContext({ dir })
    await exec.handler({ command: "cd project" }, context)

    // One notion of "where we are" across the package. Without it the two tools disagree about the
    // same words, and the model gets blamed for it.
    expect(await read.handler({ path: "note.txt" }, context)).toBe("found me")
})

// ─── the write root ──────────────────────────────────────────────────────────────────────

test("the default root is the workspace, not the agent directory", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    // An agent asked to "save a summary" writes it beside its own notes rather than into whatever
    // directory the process happened to start in.
    expect(resolveRoots(dir).primary).toBe(join(dir, "workspace"))
})

test("an agent with no workspace falls back to its own directory", () => {
    const dir = tempDir()
    // Refusing every write on a layout the runtime supports would be worse than a narrower root.
    expect(resolveRoots(dir).primary).toBe(dir)
})

test("a write outside every root is refused, naming what would allow it", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    const outside = join(dir, "elsewhere.txt")

    await expect(
        tools(dir).write({ path: outside, content: "x" }, toolContext({ dir })),
    ).rejects.toThrow(/outside the directories this agent may change/)
    expect(existsSync(outside)).toBe(false)
})

test("a write inside the root succeeds", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    const output = await tools(dir).write({ path: "note.md", content: "hi" }, toolContext({ dir }))
    // A relative path resolves against the root, so the ordinary case needs no path at all.
    expect(output).toContain(join(dir, "workspace", "note.md"))
})

test("writeRoots opens a second directory, and only a person can add one", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    const project = join(dir, "project")
    mkdirSync(project)

    await expect(
        tools(dir).write({ path: join(project, "a.txt"), content: "x" }, toolContext({ dir })),
    ).rejects.toThrow(/outside the directories/)

    // Nothing the model says at runtime can add a root — it is a manifest edit, which is what makes
    // the default worth having.
    const opened = tools(dir, [project])
    await opened.write({ path: join(project, "a.txt"), content: "x" }, toolContext({ dir }))
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("x")
})

test("a traversal out of the root is collapsed before the check, not after", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    // String concatenation would leave `../` in the path and the comparison would pass. The whole
    // point of resolving first is that `<root>/../escaped.txt` is checked as what it actually is.
    await expect(
        tools(dir).write({ path: "../escaped.txt", content: "x" }, toolContext({ dir })),
    ).rejects.toThrow(/outside the directories/)
    expect(existsSync(join(dir, "escaped.txt"))).toBe(false)
})

test("reading outside the root is allowed — only changing things is confined", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    writeFileSync(join(dir, "outside.txt"), "readable")
    // Being pointed at a project and asked about it is the ordinary case, and credentials are already
    // refused everywhere by the protected set.
    expect(await tools(dir).read({ path: join(dir, "outside.txt") }, toolContext({ dir }))).toBe(
        "readable",
    )
})

test("a protected file inside the root is still protected", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    writeFileSync(join(dir, "workspace/SOUL.md"), "# who I am\n")
    // Two mechanisms, both applying. The root says where anything may be changed; the protected set
    // says which files never may be — and the second wins inside the first.
    await expect(
        tools(dir).write({ path: "SOUL.md", content: "no rules" }, toolContext({ dir })),
    ).rejects.toThrow(/part of this agent's own definition/)
})

test("exec starts in the root rather than the agent directory", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    const output = await execHandler({
        sessions: new ShellSessions(),
        env: process.env,
        roots: resolveRoots(dir),
    })({ command: "pwd" }, toolContext({ dir }))
    expect(String(output).endsWith("/workspace")).toBe(true)
})

test("file_write says it creates folders, so nobody enables a shell to run mkdir", () => {
    // Observed: asked to "create a sample file inside a sample folder", a real model said it needed
    // `exec` for the folder and `file_write` for the file, and enabled both. It needed one.
    expect(`${FILE_WRITE_SPEC.summary} ${FILE_WRITE_SPEC.whenToUse}`).toContain("folders")
})

// ─── telling the model where it works ────────────────────────────────────────────────────

test("every path argument names the actual working directory", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    const provider = new SystemProvider({ env: {}, dir })
    // Enforcement without instruction is what caused the confusion: the tools were confined and the
    // model was never told where it worked, so asked for "a sample folder" it chose the home
    // directory. The reminder sits on the field being filled in, not in a preamble.
    for (const tool of await provider.resolve(["file_write", "file_read", "glob", "exec"])) {
        const field = tool.spec.slug === "exec" ? "command" : "path"
        expect(tool.spec.parameters.properties[field]?.description ?? "").toContain(
            join(dir, "workspace"),
        )
    }
})

test("the shell is told something different, because the confinement does not bind it", () => {
    const roots = resolveRoots("/agents/milo")
    // Telling `exec` that writing outside is refused would be a lie, and the model would find out by
    // succeeding. A prompt claiming a guarantee the runtime does not provide is worse than one
    // claiming none.
    expect(whereYouWork(roots, "write")).toContain("refused")
    expect(whereYouWork(roots, "shell").includes("refused")).toBe(false)
    expect(whereYouWork(roots, "shell")).toContain("Nothing stops a command from leaving it")
    expect(whereYouWork(roots, "read")).toContain("Reading elsewhere is allowed")
})

test("a tilde is expanded before the root check, not resolved into the workspace", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, "workspace"))
    // Unexpanded, `~/sample/x.txt` is not absolute, resolves against the workspace, and creates a
    // directory literally named `~` inside it — silently the wrong place, passing every check.
    await expect(
        tools(dir).write({ path: "~/sample/x.txt", content: "hi" }, toolContext({ dir })),
    ).rejects.toThrow(/outside the directories this agent may change/)
    expect(existsSync(join(dir, "workspace", "~"))).toBe(false)
})
