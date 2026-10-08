#!/usr/bin/env bun
/** Check the repository-backed GitBook site without calling GitBook. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { parse } from "yaml"

const ROOT = resolve(import.meta.dirname, "..")
const DOCS = join(ROOT, "developer-docs")
const CONFIG = join(DOCS, "gitbook-docs.yaml")
const failures: string[] = []

interface SpaceNode {
    readonly type: "space"
    readonly key: string
    readonly title: string
    readonly path: string
    readonly default?: boolean
    readonly content: { readonly directory: string | null; readonly language?: string }
}

interface SectionNode {
    readonly type: "section"
    readonly key: string
    readonly title: string
    readonly path: string
    readonly default?: boolean
    readonly children?: readonly SpaceNode[]
}

const value = parse(readFileSync(CONFIG, "utf8")) as unknown
const site =
    typeof value === "object" && value !== null && "site" in value
        ? (value.site as Record<string, unknown>)
        : undefined
const structure = Array.isArray(site?.structure) ? (site.structure as SectionNode[]) : []

if (typeof site?.title !== "string" || structure.length === 0) {
    failures.push("gitbook-docs.yaml needs site.title and a non-empty site.structure")
}

const keys = new Set<string>()
const directories: string[] = []
const rememberKey = (key: unknown, where: string): void => {
    if (typeof key !== "string" || key === "") {
        failures.push(`${where} has no key`)
    } else if (keys.has(key)) {
        failures.push(`duplicate GitBook key: ${key}`)
    } else {
        keys.add(key)
    }
}

for (const section of structure) {
    if (section.type !== "section") {
        failures.push(`top-level ${section.key ?? "node"} is not a section`)
        continue
    }
    rememberKey(section.key, `section ${section.title ?? "(untitled)"}`)
    const children = Array.isArray(section.children) ? section.children : []
    if (children.filter((child) => child.default === true).length !== 1) {
        failures.push(`section ${section.key} needs exactly one default space`)
    }
    for (const space of children) {
        rememberKey(space.key, `space ${space.title ?? "(untitled)"}`)
        const directory = space.content?.directory
        if (directory === null) continue
        if (typeof directory !== "string" || directory.includes("..")) {
            failures.push(`space ${space.key} has an invalid content.directory`)
            continue
        }
        const absolute = resolve(DOCS, directory)
        directories.push(absolute)
        if (!existsSync(join(absolute, "README.md"))) {
            failures.push(`space ${space.key} has no README.md at ${directory}`)
        }
    }
}
if (structure.filter((section) => section.default === true).length !== 1) {
    failures.push("the site needs exactly one default section")
}

const markdownFiles = (directory: string): string[] => {
    const found: string[] = []
    const walk = (current: string): void => {
        for (const name of readdirSync(current)) {
            const path = join(current, name)
            if (statSync(path).isDirectory()) walk(path)
            else if (extname(path) === ".md") found.push(path)
        }
    }
    walk(directory)
    return found
}

const slug = (heading: string): string =>
    heading
        .toLowerCase()
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s+/g, "-")

const headings = new Map<string, Set<string>>()
const links = new Map<string, string[]>()
const allPages = directories.flatMap(markdownFiles)
for (const file of allPages) {
    const text = readFileSync(file, "utf8")
    headings.set(
        file,
        new Set(
            [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1]?.trim() ?? "")),
        ),
    )
    links.set(
        file,
        [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]?.trim() ?? ""),
    )
}

const navigated = new Set<string>()
for (const [source, targets] of links) {
    for (const raw of targets) {
        if (raw === "" || /^(?:https?:|mailto:)/.test(raw)) continue
        const [encodedPath, anchor] = raw.split("#", 2)
        const localPath = decodeURIComponent(encodedPath ?? "")
        let target = localPath === "" ? source : resolve(dirname(source), localPath)
        if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "README.md")
        if (!existsSync(target)) {
            failures.push(`${relative(ROOT, source)} links to missing ${raw}`)
            continue
        }
        if (extname(target) === ".md") {
            if (source.endsWith("SUMMARY.md")) navigated.add(target)
            if (anchor !== undefined && anchor !== "" && !headings.get(target)?.has(anchor)) {
                failures.push(`${relative(ROOT, source)} links to missing heading ${raw}`)
            }
        }
    }
}

for (const directory of directories) {
    const summary = join(directory, "SUMMARY.md")
    if (!existsSync(summary)) failures.push(`${relative(ROOT, directory)} has no SUMMARY.md`)
}
for (const page of allPages) {
    if (page.endsWith("SUMMARY.md")) continue
    if (!navigated.has(page)) failures.push(`${relative(ROOT, page)} is absent from its SUMMARY.md`)
}

if (failures.length > 0) {
    process.stderr.write(
        `developer documentation failed ${failures.length} check(s):\n${failures
            .map((failure) => `  - ${failure}`)
            .join("\n")}\n`,
    )
    process.exit(1)
}

process.stdout.write(
    `developer documentation: ${structure.length} sections, ${directories.length} repository spaces, ${allPages.length} Markdown files\n`,
)
