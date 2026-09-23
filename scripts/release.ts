#!/usr/bin/env bun
/**
 * Cut a release: one version, written into the three places that must agree, with the changelog
 * section dated — then the gate, then the two git commands printed for a person to run.
 *
 * ## What it replaces
 *
 * Changesets owned exactly one number here — `packages/cli/package.json` — and a generated
 * changelog nobody read beside the hand-written one everybody did; `changeset publish` was never
 * invoked by anything, because the `v*` tag already published everything. For a one-package repo
 * with a sole author that was ceremony without a job. This script does the bump; the tag does the
 * rest (`.github/workflows/release.yml`).
 *
 * ## What it refuses
 *
 * - A version that is not newer than the current one (npm versions are immutable).
 * - A dirty working tree, unless `--allow-dirty`: the bump should be the only change in its commit.
 * - An empty `## Unreleased` section: a release with no notes is refused here, and again in CI.
 *
 * ## What it never does
 *
 * Commit, tag or push (hard rule 1). It prints the commands. The tag is what publishes, and a tag
 * pushed by a script is a release nobody reviewed.
 *
 *     bun run release 0.1.3            # bump, date the section, run the gate, print the commands
 *     bun run release 0.1.3 --no-gate  # skip build/test/lint/verify (they run in CI anyway)
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const PACKAGE = join(ROOT, "packages", "cli", "package.json")
const VERSION_TS = join(ROOT, "packages", "core", "src", "version.ts")
const CHANGELOG = join(ROOT, "CHANGELOG.md")

function fail(message: string, hint: string): never {
    process.stderr.write(`\n  ${message}\n  hint: ${hint}\n\n`)
    process.exit(1)
}

function run(command: string, args: readonly string[]): string {
    const result = Bun.spawnSync([command, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) {
        fail(
            `${command} ${args.join(" ")} exited ${result.exitCode}`,
            new TextDecoder().decode(result.stderr).trim() || "See the output above.",
        )
    }
    return new TextDecoder().decode(result.stdout)
}

function parse(version: string): readonly [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    if (match === null) fail(`"${version}" is not a version`, "Three numbers: 0.1.3.")
    return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function newer(next: string, current: string): boolean {
    const a = parse(next)
    const b = parse(current)
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
    }
    return false
}

const argv = process.argv.slice(2)
const version = argv.find((arg) => !arg.startsWith("--"))
if (version === undefined) fail("No version given", "bun run release 0.1.3")
parse(version)

const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as { version: string }
if (!newer(version, pkg.version)) {
    fail(
        `${version} is not newer than the current ${pkg.version}`,
        "npm versions are immutable: pick the next number rather than reusing one.",
    )
}

if (!argv.includes("--allow-dirty")) {
    const status = run("git", ["status", "--porcelain"]).trim()
    if (status !== "") {
        fail(
            "The working tree is not clean",
            "Commit or stash first, so the version bump is the only change in its commit. --allow-dirty skips this.",
        )
    }
}

const changelog = readFileSync(CHANGELOG, "utf8")
const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |Z)/m.exec(changelog)
const body = unreleased?.[1]?.trim() ?? ""
if (unreleased === null || body === "" || body === "_Nothing yet._") {
    fail(
        "CHANGELOG.md has nothing under ## Unreleased",
        "`bun run changelog:draft` drafts them from the commits since the last release; edit, then run this again.",
    )
}

const date = new Date().toISOString().slice(0, 10)
const dated = changelog.replace(
    /^## Unreleased\n/m,
    `## Unreleased\n\n_Nothing yet._\n\n## ${version} — ${date}\n`,
)
writeFileSync(CHANGELOG, dated)

writeFileSync(
    PACKAGE,
    readFileSync(PACKAGE, "utf8").replace(`"version": "${pkg.version}"`, `"version": "${version}"`),
)

const versionTs = readFileSync(VERSION_TS, "utf8")
if (!versionTs.includes(`VERSION = "${pkg.version}"`)) {
    fail(
        `packages/core/src/version.ts does not say ${pkg.version}`,
        "The three version spots disagree already; fix version.ts by hand, then run this again.",
    )
}
writeFileSync(VERSION_TS, versionTs.replace(`VERSION = "${pkg.version}"`, `VERSION = "${version}"`))

// The lockfile records workspace versions.
run("bun", ["install"])

process.stdout.write(`\n  ${pkg.version} → ${version}\n`)
process.stdout.write(
    "    packages/cli/package.json\n    packages/core/src/version.ts\n    CHANGELOG.md\n    bun.lock\n",
)

if (!argv.includes("--no-gate")) {
    for (const step of ["build", "test", "typecheck", "lint", "verify:package"]) {
        process.stdout.write(`\n  bun run ${step}\n`)
        const result = Bun.spawnSync(["bun", "run", step], {
            cwd: ROOT,
            stdout: "inherit",
            stderr: "inherit",
        })
        if (result.exitCode !== 0) {
            fail(
                `bun run ${step} failed`,
                "The files above are already written; fix the failure and run the gate again, or commit with --no-gate and let CI be the judge.",
            )
        }
    }
}

process.stdout.write(`
  Review the diff, then:

    git add -A && git commit -m "release: ${version}"
    git tag -a v${version} -m "v${version}"
    git push && git push origin v${version}

  The tag publishes: npm, the GitHub Release (notes from CHANGELOG.md), the Homebrew tap, the image.
  Watch it at https://github.com/moeen-mahmud/dispach/actions — it needs NPM_TOKEN and TAP_TOKEN set.

`)
