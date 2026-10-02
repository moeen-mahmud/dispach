/**
 * Export and import a slice of one agent (doc 16 R11): its memory and its knowledge, as a JSON bundle.
 *
 * A person syncing knowledge between their personal agent and a team agent is always the one who asks,
 * and the embedder brokers it — it scans for secrets and decides who may. So this module is only the
 * mechanism, and it is narrow on purpose:
 *
 * - **Three logical paths, never physical ones.** `MEMORY.md` means *the carried memory file*,
 *   whatever the workspace calls it; `memory/<name>.md` means the agent's `memory.dir`;
 *   `knowledge/<name>.md` its `knowledge.dir`. A bundle from an agent whose memory lives in `./notes`
 *   lands correctly in one whose memory lives in `./memory`, and no path in a bundle can name anything
 *   else — not `agent.yaml`, not `.env`, not a skill (skills carry scripts, and are left out).
 * - **Notes are merged, files are not.** A memory file gains the bundle's notes it lacks, one top-level
 *   item at a time, so importing the same bundle twice changes nothing. A knowledge file is kept
 *   (`skip`) or replaced (`overwrite`).
 * - **Nothing is imported that the agent cannot load.** The carried file and knowledge are read at
 *   load, so a change to either reloads the agent — and a reload that refuses (an entry with no
 *   keywords, a file over its budget) restores every file the import touched. The archive is indexed
 *   by the next turn's `syncFiles`, which is also why an import cannot fall into the reconcile trap:
 *   it writes files, and files are what that pass enumerates.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { HarnessError, isHarnessError } from "../errors.ts"
import { isSessionSource } from "../memory/conversation.ts"
import { isScopeSource } from "../memory/scopes.ts"
import { entriesIn, evictToBudget } from "../memory/writer.ts"
import { writeTarget } from "../workspace/load.ts"
import type { Agent } from "./agent.ts"

export const BUNDLE_VERSION = 1

/** What a bundle may carry, by section. */
export const BUNDLE_SECTIONS = ["MEMORY.md", "memory/", "knowledge/"] as const
export type BundleSection = (typeof BUNDLE_SECTIONS)[number]

export interface BundleFile {
    /** `MEMORY.md`, `memory/<name>.md` or `knowledge/<name>.md`. */
    readonly path: string
    readonly content: string
}

export interface AgentBundle {
    readonly version: typeof BUNDLE_VERSION
    readonly agentId: string
    readonly exportedAt: string
    readonly files: readonly BundleFile[]
}

export interface ImportReport {
    /** Files that did not exist and were written whole. */
    readonly added: readonly string[]
    /** Memory files that gained notes, with how many. */
    readonly merged: readonly { readonly path: string; readonly notes: number }[]
    /** Paths that changed nothing: every note already there, or a knowledge file kept under `skip`. */
    readonly skipped: readonly string[]
    readonly overwritten: readonly string[]
    /** Notes moved from the carried file into the archive to keep it under its budget. */
    readonly evicted: number
    /** Whether the agent was reloaded to pick up the carried file or knowledge. */
    readonly reload: "none" | "loaded" | "pending"
}

const FILE_NAME = /^[^/\\.][^/\\]*\.md$/

function refused(code: string, message: string, hint: string, field?: string): HarnessError {
    return new HarnessError({ code, message, hint, ...(field === undefined ? {} : { field }) })
}

interface Roots {
    readonly carried?: {
        readonly path: string
        readonly name: string
        readonly budget?: number
        readonly eviction?: string
    }
    readonly memoryDir?: string
    readonly knowledgeDir?: string
}

function rootsOf(agent: Agent): Roots {
    const target = writeTarget(agent.workspace)
    const at = (dir: string) => (isAbsolute(dir) ? dir : resolve(agent.dir, dir))
    return {
        ...(target?.path === undefined || target.mode === "refused"
            ? {}
            : {
                  carried: {
                      path: target.path,
                      name: target.name,
                      ...(target.budget === undefined ? {} : { budget: target.budget }),
                      ...(target.eviction === undefined ? {} : { eviction: target.eviction }),
                  },
              }),
        ...(agent.manifest.memory === undefined
            ? {}
            : { memoryDir: at(agent.manifest.memory.dir) }),
        ...(agent.manifest.knowledge === undefined
            ? {}
            : { knowledgeDir: at(agent.manifest.knowledge.dir) }),
    }
}

/** Flat `.md` files, as `enumerateFiles` and `loadKnowledge` read them. A missing directory is empty. */
function markdownIn(dir: string | undefined): string[] {
    if (dir === undefined) return []
    try {
        return readdirSync(dir)
            .filter(
                (name) => FILE_NAME.test(name) && !isSessionSource(name) && !isScopeSource(name),
            )
            .sort()
    } catch {
        return []
    }
}

/** The sections a caller named, refused by name when one is not a section. */
export function bundleSections(requested: readonly string[] | undefined): readonly BundleSection[] {
    if (requested === undefined || requested.length === 0) return BUNDLE_SECTIONS
    return requested.map((value, index) => {
        const section = BUNDLE_SECTIONS.find((known) => known === value)
        if (section === undefined) {
            throw refused(
                "bundle_path_not_allowed",
                `"${value}" is not something a bundle can carry.`,
                `A bundle carries ${BUNDLE_SECTIONS.join(", ")} and nothing else — never the manifest, secrets or skills.`,
                `paths.${index}`,
            )
        }
        return section
    })
}

export function exportBundle(
    agent: Agent,
    sections: readonly BundleSection[] = BUNDLE_SECTIONS,
    now = new Date(),
): AgentBundle {
    const roots = rootsOf(agent)
    const files: BundleFile[] = []
    if (
        sections.includes("MEMORY.md") &&
        roots.carried !== undefined &&
        existsSync(roots.carried.path)
    ) {
        files.push({ path: "MEMORY.md", content: readFileSync(roots.carried.path, "utf8") })
    }
    for (const [section, dir] of [
        ["memory/", roots.memoryDir],
        ["knowledge/", roots.knowledgeDir],
    ] as const) {
        if (!sections.includes(section) || dir === undefined) continue
        for (const name of markdownIn(dir)) {
            files.push({
                path: `${section}${name}`,
                content: readFileSync(join(dir, name), "utf8"),
            })
        }
    }
    return { version: BUNDLE_VERSION, agentId: agent.id, exportedAt: now.toISOString(), files }
}

/** Where one bundle path lands, or a refusal naming the field. Checked for every file before any write. */
function destination(
    file: BundleFile,
    index: number,
    roots: Roots,
): {
    readonly abs: string
    readonly kind: "carried" | "memory" | "knowledge"
} {
    const field = `files.${index}.path`
    if (file.path === "MEMORY.md") {
        if (roots.carried === undefined) {
            throw refused(
                "bundle_memory_not_writable",
                "This agent has no writable memory file to merge MEMORY.md into.",
                "Give a volatile workspace file `editable: append` or `replace`, or export without MEMORY.md.",
                field,
            )
        }
        return { abs: roots.carried.path, kind: "carried" }
    }
    const slash = file.path.indexOf("/")
    const section = file.path.slice(0, slash + 1)
    const name = file.path.slice(slash + 1)
    const known = section === "memory/" || section === "knowledge/"
    if (!known || !FILE_NAME.test(name) || isSessionSource(name) || isScopeSource(name)) {
        throw refused(
            "bundle_path_not_allowed",
            `"${file.path}" is not a path a bundle can carry.`,
            "A bundle carries MEMORY.md, memory/<name>.md and knowledge/<name>.md — one level, markdown only, never the manifest, secrets or skills.",
            field,
        )
    }
    const dir = section === "memory/" ? roots.memoryDir : roots.knowledgeDir
    if (dir === undefined) {
        throw refused(
            section === "memory/" ? "bundle_no_memory" : "bundle_no_knowledge",
            `This agent has no ${section === "memory/" ? "memory" : "knowledge"} block, so "${file.path}" has nowhere to go.`,
            `Add a \`${section === "memory/" ? "memory" : "knowledge"}:\` block to the manifest, or export without ${section}.`,
            field,
        )
    }
    return { abs: join(dir, name), kind: section === "memory/" ? "memory" : "knowledge" }
}

/** Top-level notes the target lacks, as text ready to append. Exact duplicates are the same note. */
function newNotes(existing: string, incoming: string): readonly string[] {
    const have = new Set(entriesIn(existing.split(/\r?\n/)).map((entry) => entry.text))
    return entriesIn(incoming.split(/\r?\n/))
        .map((entry) => entry.text)
        .filter((text) => !have.has(text))
}

export async function importBundle(input: {
    readonly agent: Agent
    readonly bundle: unknown
    readonly mode?: "skip" | "overwrite"
    /** Rebuild the agent from disk. Throws when it will not load, which rolls the import back. */
    readonly reload: () => Promise<"loaded" | "pending">
    readonly now?: Date
}): Promise<ImportReport> {
    const now = input.now ?? new Date()
    const mode = input.mode ?? "skip"
    const files = readBundle(input.bundle)
    const roots = rootsOf(input.agent)
    const targets = files.map((file, index) => ({ file, ...destination(file, index, roots) }))

    // The snapshot is every file an import can change: the ones it names, and the whole archive,
    // because eviction appends to archive files whose names depend on the notes it moves.
    const snapshot = new Map<string, string | undefined>()
    const keep = (path: string) => {
        if (!snapshot.has(path))
            snapshot.set(path, existsSync(path) ? readFileSync(path, "utf8") : undefined)
    }
    for (const target of targets) keep(target.abs)
    for (const name of markdownIn(roots.memoryDir)) keep(join(roots.memoryDir ?? "", name))
    if (roots.carried !== undefined) keep(roots.carried.path)

    const added: string[] = []
    const merged: { path: string; notes: number }[] = []
    const skipped: string[] = []
    const overwritten: string[] = []
    let evicted = 0
    let needsReload = false
    try {
        for (const { file, abs, kind } of targets) {
            const before = snapshot.get(abs)
            if (kind === "knowledge") {
                if (before === file.content || (before !== undefined && mode === "skip")) {
                    skipped.push(file.path)
                    continue
                }
                writeFileSync(abs, file.content, "utf8")
                ;(before === undefined ? added : overwritten).push(file.path)
                needsReload = true
                continue
            }
            if (before === undefined) {
                writeFileSync(abs, file.content, "utf8")
                added.push(file.path)
                needsReload ||= kind === "carried"
                continue
            }
            const notes = newNotes(readFileSync(abs, "utf8"), file.content)
            if (notes.length === 0) {
                skipped.push(file.path)
                continue
            }
            writeFileSync(
                abs,
                `${readFileSync(abs, "utf8").trimEnd()}\n\n${notes.join("\n")}\n`,
                "utf8",
            )
            merged.push({ path: file.path, notes: notes.length })
            needsReload ||= kind === "carried"
        }

        const carried = roots.carried
        if (
            needsReload &&
            carried?.eviction === "oldest" &&
            carried.budget !== undefined &&
            roots.memoryDir !== undefined
        ) {
            evicted = (
                await evictToBudget({
                    path: carried.path,
                    name: carried.name,
                    budget: carried.budget,
                    archiveDir: roots.memoryDir,
                    now,
                })
            ).evicted
        }

        const reload = needsReload ? await input.reload() : "none"
        return { added, merged, skipped, overwritten, evicted, reload }
    } catch (error) {
        restore(snapshot, roots.memoryDir)
        if (!isHarnessError(error)) throw error
        throw new HarnessError({
            code: "bundle_import_refused",
            message: `Nothing was imported: the agent would not load with this bundle. ${error.message}`,
            hint: error.hint,
            ...(error.field === undefined ? {} : { field: error.field }),
        })
    }
}

/** Put every file back as it was, and remove the ones the import created. */
function restore(
    snapshot: ReadonlyMap<string, string | undefined>,
    memoryDir: string | undefined,
): void {
    for (const [path, content] of snapshot) {
        if (content === undefined) rmSync(path, { force: true })
        else writeFileSync(path, content, "utf8")
    }
    // An archive file eviction created is not in the snapshot, because it did not exist.
    for (const name of markdownIn(memoryDir)) {
        const path = join(memoryDir ?? "", name)
        if (!snapshot.has(path)) rmSync(path, { force: true })
    }
}

/** The bundle's shape, refused field by field before anything is written. */
function readBundle(value: unknown): readonly BundleFile[] {
    const record =
        typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
    if (record.version !== BUNDLE_VERSION) {
        throw refused(
            "bundle_version_unsupported",
            `This bundle is version ${JSON.stringify(record.version)}; this build reads version ${BUNDLE_VERSION}.`,
            "Export the bundle again with GET /v1/agents/:id/export on a build that matches.",
            "version",
        )
    }
    if (!Array.isArray(record.files)) {
        throw refused(
            "bundle_files_invalid",
            "A bundle needs a `files` list.",
            'Send the body GET /v1/agents/:id/export returned: { "version": 1, "files": [{ "path", "content" }] }.',
            "files",
        )
    }
    const seen = new Set<string>()
    return record.files.map((entry: unknown, index) => {
        const file =
            typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {}
        if (typeof file.path !== "string" || typeof file.content !== "string") {
            throw refused(
                "bundle_files_invalid",
                `files.${index} needs a string \`path\` and a string \`content\`.`,
                "Each entry is { path, content }, as an export writes it.",
                `files.${index}`,
            )
        }
        if (seen.has(file.path)) {
            throw refused(
                "bundle_files_invalid",
                `"${file.path}" appears twice.`,
                "A bundle names each path once.",
                `files.${index}.path`,
            )
        }
        seen.add(file.path)
        return { path: file.path, content: file.content }
    })
}
