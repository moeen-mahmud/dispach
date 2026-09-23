#!/usr/bin/env bun
/**
 * Draft the next release's notes from conventional commits, into `## Unreleased` in CHANGELOG.md.
 *
 * The range is every commit since the tag of the **published** version (`packages/cli/package.json`),
 * with any tag inside it ignored, so a stray local tag cannot split the draft in two. The draft is
 * a starting point: commit subjects are written for reviewers, so edit it into what somebody
 * installing the release needs to know, then `bun run release <version>`.
 *
 * It never overwrites notes already written under Unreleased — it refuses and prints the draft.
 *
 *     bun run changelog:draft
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const CHANGELOG = join(ROOT, "CHANGELOG.md")
const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "cli", "package.json"), "utf8")) as {
    version: string
}

function fail(message: string, hint: string): never {
    process.stderr.write(`\n  ${message}\n  hint: ${hint}\n\n`)
    process.exit(1)
}

const from = `v${pkg.version}`
const known = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${from}^{commit}`], {
    cwd: ROOT,
})
if (known.exitCode !== 0) {
    fail(
        `No tag ${from}`,
        "The draft starts at the tag of the published version. Fetch tags: git fetch --tags.",
    )
}

const cliff = Bun.spawnSync(
    [
        join(ROOT, "node_modules", ".bin", "git-cliff"),
        "--config",
        join(ROOT, "cliff.toml"),
        `${from}..HEAD`,
        "--ignore-tags",
        ".*",
        "--strip",
        "all",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
)
if (cliff.exitCode !== 0) {
    fail("git-cliff failed", new TextDecoder().decode(cliff.stderr).trim() || "Run bun install.")
}
const draft = new TextDecoder().decode(cliff.stdout).trim()
if (draft === "") {
    fail(
        `No feat, fix or perf commits since ${from}`,
        "Nothing to draft; write the notes by hand under ## Unreleased.",
    )
}

const changelog = readFileSync(CHANGELOG, "utf8")
const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog)
if (unreleased === null)
    fail("CHANGELOG.md has no ## Unreleased heading", "Add one under # Changelog.")
const existing = (unreleased[1] ?? "").trim()
if (existing !== "" && existing !== "_Nothing yet._") {
    process.stdout.write(`${draft}\n`)
    fail(
        "## Unreleased already has notes, so nothing was written",
        "The draft is printed above; merge what you want by hand.",
    )
}

writeFileSync(
    CHANGELOG,
    changelog.replace(
        /^## Unreleased\n[\s\S]*?(?=^## |(?![\s\S]))/m,
        `## Unreleased\n\n${draft}\n\n`,
    ),
)
process.stdout.write(
    `drafted ${from}..HEAD into CHANGELOG.md under ## Unreleased — edit it, then bun run release <version>\n`,
)
