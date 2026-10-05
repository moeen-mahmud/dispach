#!/usr/bin/env bun
/**
 * Rebrand the runtime in one commit.
 *
 *   bun scripts/rename-brand.ts <new-slug> [--dry]
 *
 * Three kinds of file are rewritten:
 *
 * 1. `packages/core/src/brand.ts`, which owns the name.
 * 2. Every `package.json`, which owns the npm identity.
 * 3. Any source or config file that imports a first-party package by scope — `@<slug>/core`.
 *
 * The third is not a loosening of the rule. A scoped import specifier is *derived* from the
 * package.json name, so leaving it behind would rename the package and break every importer:
 * "renames throughout" would be false. Only the `@<slug>/` prefix is touched in those files,
 * never prose, so the diff stays reviewable.
 *
 * Nothing else in the tree contains the brand as a directory, type, interface, or variable —
 * that constraint is what makes this script possible, and code review is what keeps it true.
 *
 * Prose is deliberately left alone. Docs and READMEs describe *this* project; rewriting them
 * would turn a rename into an unreviewable diff, and Phase 0's acceptance criterion is that
 * `git diff --name-only` after a rename lists only brand.ts and package.json files.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { DEFAULT_BRAND, SLUG_PATTERN, titleCaseSlug } from "../packages/core/src/brand.ts"

const ROOT = resolve(import.meta.dirname, "..")
const SKIP_DIRS = new Set(["node_modules", "dist"])

/** Lockfiles record workspace package names; they are regenerated, never hand-edited. */
const REGENERATED = new Set(["bun.lock", "bun.lockb", "package-lock.json"])

const args = process.argv.slice(2)
const dryRun = args.includes("--dry")
const newSlug = args.find((a) => !a.startsWith("-"))

function fail(message: string, hint: string): never {
    console.error(`rename-brand: ${message}`)
    console.error(`  hint: ${hint}`)
    process.exit(1)
}

if (newSlug === undefined) {
    fail("no new brand slug given", "usage: bun scripts/rename-brand.ts <new-slug> [--dry]")
}
if (!SLUG_PATTERN.test(newSlug)) {
    fail(
        `"${newSlug}" is not a usable slug`,
        "The slug becomes an env var prefix, a dot-directory, and an npm scope: lowercase " +
            "alphanumeric with inner hyphens, e.g. acme or acme-run.",
    )
}

const oldSlug = DEFAULT_BRAND.slug
if (newSlug === oldSlug) {
    fail(`the brand is already "${oldSlug}"`, "Nothing to do. Pass a different slug.")
}

/** Shared with brand.ts so the display form cannot drift between the two. */
const titleCase = titleCaseSlug

/**
 * Three cases, because the brand appears as a slug (`.<slug>`, `@<slug>/core`), a display
 * name (`Slug`), and an env prefix (`SLUG_API_TOKEN`). Longest-first ordering is unnecessary
 * since the three forms cannot overlap.
 *
 * This file deliberately contains no brand literal of its own — it learns the current one
 * from brand.ts. Otherwise it would report itself as a straggler below, which is a decent
 * self-test for the rule.
 */
const substitutions: [RegExp, string][] = [
    [new RegExp(oldSlug.toUpperCase(), "g"), newSlug.toUpperCase()],
    [new RegExp(titleCase(oldSlug), "g"), titleCase(newSlug)],
    [new RegExp(oldSlug, "g"), newSlug],
]

function rewrite(source: string): string {
    let out = source
    for (const [pattern, replacement] of substitutions) out = out.replace(pattern, replacement)
    return out
}

function walk(dir: string, onFile: (path: string) => void): void {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            // Dot-directories hold tooling state, not source. `.github` and `.changeset` contain no
            // brand string, so skipping them costs nothing and keeps the report readable.
            if (entry.startsWith(".")) continue
            walk(full, onFile)
        } else {
            onFile(full)
        }
    }
}

/**
 * Files the brand is *derived into* rather than merely mentioned in, and which this script rewrites
 * in full.
 *
 * `brand.ts` owns the name. `package.json` files carry the scope. The Dockerfile carries the env var
 * prefix and the state path, both computed from the slug exactly like the scope is — so leaving it
 * out made a rename two commits: the tree, and then somebody noticing later that the image sets
 * `<OLDSLUG>_HOME`. Hard rule 3's promise is that a rename is one commit, and a build artifact that
 * needs a manual decision is the same defect as a stray literal.
 */
const inScope: string[] = [
    join(ROOT, "packages", "core", "src", "brand.ts"),
    // The control plane's own copy: it is FSL-licensed and may not import core's, so it carries the
    // brand itself — and is rewritten in full for the same reason core's is.
    join(ROOT, "packages", "control", "src", "brand.ts"),
    join(ROOT, "packages", "control", "Dockerfile"),
    join(ROOT, "packages", "control", "compose.yaml"),
    join(ROOT, "docker", "Dockerfile"),
    // The entrypoint carries the state directory, because it links the mounted agent into the
    // sandbox and `<slug>` is half that path. Left out, a rename would leave a script that
    // silently linked nothing into a directory nothing reads — the link is made at start, so
    // there is no build to fail and no straggler report to notice.
    join(ROOT, "docker", "entrypoint.sh"),
    // The compose file and its example environment carry the env var prefix, the image tag and
    // the state volume's name — all derived from the slug exactly like the package scope is.
    // Left out, they are reported as "left alone — review these", which makes a rename two
    // commits: the tree, and then somebody noticing later that `docker compose up` still wants
    // `<OLDSLUG>_API_TOKEN`. Hard rule 3's promise is one commit, and the front door needing a
    // manual decision is the same defect as a stray literal. Decision 11.142, one file over.
    join(ROOT, "docker-compose.yml"),
    join(ROOT, ".env.example"),
    // The ignore files carry the state directory, and `.gitignore`'s omission was the worst of
    // the three found here: after a rename it would go on ignoring the *old* state directory and
    // stop ignoring the new one, so the next `git add` would offer up a `store.db` full of
    // conversation history. A straggler report is not protection against that.
    join(ROOT, ".gitignore"),
    join(ROOT, ".dockerignore"),
    // The reference manifest carries `apiVersion: <slug>/v1`, which a rename must rewrite or the
    // file stops loading — plus `@<slug>/` provider comments and `<slug> …` command examples.
    join(ROOT, "examples", "reference", "agent.yaml"),
]
/** Files where only the `@<slug>/` package scope is rewritten. */
const scopeOnly: string[] = []
const stragglers: string[] = []
const regenerated: string[] = []

const oldScope = `@${oldSlug}/`
const newScope = `@${newSlug}/`
const oldApiVersionPrefix = `apiVersion: ${oldSlug}/v`
const newApiVersionPrefix = `apiVersion: ${newSlug}/v`
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml"]

walk(ROOT, (path) => {
    if (path.endsWith("package.json")) {
        inScope.push(path)
        return
    }
    if (inScope.includes(path)) return

    const source = readFileSync(path, "utf8")
    const mentionsBrand = source.includes(oldSlug) || source.includes(titleCase(oldSlug))
    if (!mentionsBrand) return

    if (REGENERATED.has(path.slice(path.lastIndexOf("/") + 1))) {
        regenerated.push(path)
        return
    }

    // `apiVersion: <slug>/v1` is derived from the brand exactly like the package scope is, so a
    // shipped example must move with it — otherwise every example in the tree stops loading the
    // moment someone renames the project.
    const isManifest = path.endsWith(".yaml") || path.endsWith(".yml")
    if (isManifest && source.includes(oldApiVersionPrefix)) {
        scopeOnly.push(path)
        const withoutApiVersion = source.split(oldApiVersionPrefix).join("")
        if (withoutApiVersion.includes(oldSlug) || withoutApiVersion.includes(titleCase(oldSlug))) {
            stragglers.push(path)
        }
        return
    }

    // A scoped import is derived from a package name, so it is ours to rewrite.
    const isCode = CODE_EXTENSIONS.some((extension) => path.endsWith(extension))
    if (isCode && source.includes(oldScope)) {
        scopeOnly.push(path)
        // Still report it if it mentions the brand for some *other* reason too.
        const withoutScope = source.split(oldScope).join("")
        if (withoutScope.includes(oldSlug) || withoutScope.includes(titleCase(oldSlug))) {
            stragglers.push(path)
        }
        return
    }

    stragglers.push(path)
})

const changed: string[] = []
for (const path of inScope) {
    const source = readFileSync(path, "utf8")
    const next = rewrite(source)
    if (next === source) continue
    if (!dryRun) writeFileSync(path, next)
    changed.push(relative(ROOT, path))
}

const rescoped: string[] = []
for (const path of scopeOnly) {
    const source = readFileSync(path, "utf8")
    const next = source
        .split(oldScope)
        .join(newScope)
        .split(oldApiVersionPrefix)
        .join(newApiVersionPrefix)
    if (next === source) continue
    if (!dryRun) writeFileSync(path, next)
    rescoped.push(relative(ROOT, path))
}

console.log(`rename-brand: ${oldSlug} → ${newSlug}${dryRun ? " (dry run)" : ""}`)
for (const path of changed) console.log(`  rewrote ${path}`)
for (const path of rescoped) console.log(`  rescoped ${path}`)

const prose = stragglers.filter(
    (p) => p.endsWith(".md") || p.endsWith(".txt") || p.endsWith("LICENSE"),
)
const config = stragglers.filter((p) => !prose.includes(p))

if (prose.length > 0) {
    console.log(`\n  left alone (prose — rewrite by hand if you mean to): ${prose.length} file(s)`)
}
if (config.length > 0) {
    // `.gitignore` legitimately lands here: it ignores the state directory by literal name and
    // is not a package.json. Anything else in this list is worth a look — a config file that
    // hardcodes the brand is a rename this script cannot make.
    console.log("\n  left alone (non-prose — review these):")
    for (const path of config) console.log(`    ${relative(ROOT, path)}`)
}

if (regenerated.length > 0) {
    console.log(
        `\n  regenerated, not edited: ${regenerated.map((p) => relative(ROOT, p)).join(", ")}`,
    )
}

console.log(
    "\n  next: bun install (to refresh the lockfile's workspace names), then bun test && " +
        "bun run build. Anything listed above as left alone needs a manual decision.",
)
