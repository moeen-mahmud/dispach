/**
 * `memory_forget`'s file half: find the notes `memory_write` left, and delete the ones named (pilot.15).
 *
 * ## Two calls, never one
 *
 * A query finds; only ids delete. "Forget everything about Acme" matched by ranking would delete a note
 * that merely mentions Acme beside something the person meant to keep, with nothing to review first.
 * So a query returns the matches and their ids, the model shows them to the person, and a second call
 * names exactly what goes.
 *
 * ## Matching is substring, not BM25
 *
 * Every word of the query must appear in the note, case-insensitively. Recall's ranking is the wrong
 * tool for choosing what to delete: its threshold hides near-misses and its idf can promote a rare
 * accidental match (the 1998 case in CLAUDE.md). For a list a person reviews, "contains these words"
 * is the rule they can predict.
 *
 * ## What counts as a note
 *
 * A top-level list item — what `memory_write` writes and what eviction moves — in the carried file or
 * an archive. Headings and prose a person wrote stay: they are the file's structure, the same line the
 * eviction writer draws. The id is derived from the note's text with the scheme recall uses
 * (`derivedId("mem", text)`), so it is stable across reads and needs no table to look it up.
 *
 * The index needs no separate step: recall and `memory search` reconcile against the files on every
 * call, and a changed file is re-split wholesale, so a deleted note's row goes with it.
 */

import { readdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { derivedId } from "../ids.ts"
import { entriesIn, removeEntries } from "./writer.ts"

export interface MemoryFile {
    /** As shown to the model: the workspace name, or a path relative to the memory directory. */
    readonly source: string
    readonly path: string
}

export interface ForgettableNote {
    readonly id: string
    readonly source: string
    readonly text: string
}

/** The carried file, then every archive in the memory directory. */
export function memoryFiles(input: {
    readonly carried?: MemoryFile
    readonly archiveDir: string
}): readonly MemoryFile[] {
    let names: string[] = []
    try {
        names = readdirSync(input.archiveDir)
            .filter((name) => name.endsWith(".md"))
            .sort()
    } catch {
        // No archive directory yet: nothing was ever evicted or saved there.
    }
    return [
        ...(input.carried === undefined ? [] : [input.carried]),
        ...names.map((name) => ({ source: name, path: join(input.archiveDir, name) })),
    ]
}

/** Every word of `query`, case-insensitively. An empty query matches nothing, never everything. */
export function matchesQuery(text: string, query: string): boolean {
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== "")
    if (words.length === 0) return false
    const haystack = text.toLowerCase()
    return words.every((word) => haystack.includes(word))
}

async function read(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8")
    } catch {
        return undefined
    }
}

export async function notesIn(files: readonly MemoryFile[]): Promise<readonly ForgettableNote[]> {
    const out: ForgettableNote[] = []
    for (const file of files) {
        const raw = await read(file.path)
        if (raw === undefined) continue
        for (const entry of entriesIn(raw.split(/\r?\n/))) {
            out.push({ id: derivedId("mem", entry.text), source: file.source, text: entry.text })
        }
    }
    return out
}

/** Delete the notes whose id is in `ids`, file by file. Returns what went. */
export async function forgetNotes(
    files: readonly MemoryFile[],
    ids: ReadonlySet<string>,
): Promise<readonly ForgettableNote[]> {
    const forgotten: ForgettableNote[] = []
    for (const file of files) {
        const raw = await read(file.path)
        if (raw === undefined) continue
        const lines = raw.split(/\r?\n/)
        const doomed = entriesIn(lines).filter((entry) => ids.has(derivedId("mem", entry.text)))
        if (doomed.length === 0) continue
        await writeFile(file.path, removeEntries(lines, doomed), "utf8")
        for (const entry of doomed) {
            forgotten.push({
                id: derivedId("mem", entry.text),
                source: file.source,
                text: entry.text,
            })
        }
    }
    return forgotten
}
