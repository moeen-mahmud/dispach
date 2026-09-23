#!/usr/bin/env bun
/**
 * Print one release's section of `CHANGELOG.md`, for the GitHub Release body.
 *
 * The heading is left out — the release page already carries the tag — and a version with no
 * section is a failure, not an empty body: the workflow runs this before publishing anything, so a
 * tag pushed without notes is refused where the person who pushed it is looking.
 *
 *     bun scripts/changelog-section.ts 0.1.3
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")

export function changelogSection(changelog: string, version: string): string | undefined {
    const lines = changelog.split("\n")
    const start = lines.findIndex((line) =>
        new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`).test(line),
    )
    if (start === -1) return undefined
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i]?.startsWith("## ")) {
            end = i
            break
        }
    }
    return `${lines
        .slice(start + 1, end)
        .join("\n")
        .trim()}\n`
}

if (import.meta.main) {
    const version = process.argv[2]
    if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
        process.stderr.write("\n  usage: bun scripts/changelog-section.ts <version>\n\n")
        process.exit(2)
    }
    const section = changelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version)
    if (section === undefined || section.trim() === "") {
        process.stderr.write(
            `\n  CHANGELOG.md has no section for ${version}\n  hint: \`bun run release ${version}\` turns the Unreleased section into one. A release with no notes is refused rather than published empty.\n\n`,
        )
        process.exit(1)
    }
    process.stdout.write(section)
}
