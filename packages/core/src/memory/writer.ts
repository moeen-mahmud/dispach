/**
 * `memory_write`'s other half: eviction, which is what stops the carried file growing until the agent
 * refuses to boot.
 *
 * ## The bug this exists to fix
 *
 * `MEMORY.md` ships with `eviction: oldest` in its frontmatter, sits in the `volatile` tier with a
 * 2,000-token budget, and is appended to by `memory_write`. Nothing consumed that field, and the
 * workspace budget is a **hard load failure** — not a truncation, deliberately, because an agent running
 * on half its instructions with no error anywhere is worse than one that refuses to start. Measured on a
 * freshly scaffolded agent: about two hundred saved notes and `validate` reports
 *
 *     workspace_budget_exceeded: Workspace over budget: MEMORY.md is 7843 tokens
 *                                against its 2000-token budget.
 *
 * So the tool the agent is told to use for remembering things was, used enough, a tool that bricked it.
 * Eviction is the declared remedy and this is it.
 *
 * ## Oldest means *highest in the file*, not earliest stamp
 *
 * `memory_write` appends, so document order already is chronological — and a stamp is a value a person
 * can hand-edit, while a position is not. Sorting by stamp would let one mistyped year pin a note in the
 * carried file forever, or evict a fresh one. Position is the honest reading of "oldest" and needs no
 * trust in the contents.
 *
 * ## What eviction is allowed to touch
 *
 * Only **top-level list items**. Frontmatter, HTML comments, headings and prose stay exactly where they
 * are, at their original bytes: they are the file's structure, a person wrote them, and a memory tool
 * that quietly deleted a heading would be a memory tool nobody left enabled. It also means the file
 * remains recognisably the one the author laid out — which matters because slot 4 shows it to the model
 * every turn and `MEMORY.md` is a file people read.
 *
 * The consequence is a case eviction cannot fix and therefore reports: a file whose *prelude* alone
 * exceeds the budget, or one down to its last note. Both are refused out loud rather than silently
 * leaving the file over budget, because the next load is the thing that fails and it fails on boot.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { estimateTokens } from "../context/tokens.ts"
import { HarnessError } from "../errors.ts"
import { strip, withoutFrontmatter } from "../workspace/frontmatter.ts"

/** A top-level list item and the lines it occupies. */
export interface Entry {
    readonly start: number
    /** Exclusive. */
    readonly end: number
    readonly text: string
}

/** `- `, `* `, `+ `, `1. ` at column zero. Indented markers belong to the item above them. */
const TOP_LEVEL_ITEM = /^(?:[-*+]|\d+[.)])[ \t]+\S/
const STAMP = /\*\*(\d{4})-(\d{2})-\d{2}T/

/**
 * Split raw file lines into the entries eviction may move and everything it may not.
 *
 * An entry runs to the next top-level marker, the next heading, or the next line at column zero that is
 * not a continuation — the same absorption rule `passages.ts` applies, restricted to column zero because
 * only a top-level item is a whole note.
 */
export function entriesIn(lines: readonly string[]): readonly Entry[] {
    const out: Entry[] = []
    let start = -1

    const close = (end: number): void => {
        if (start === -1) return
        out.push({ start, end, text: lines.slice(start, end).join("\n").trimEnd() })
        start = -1
    }

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (TOP_LEVEL_ITEM.test(line)) {
            close(i)
            start = i
            continue
        }
        if (start === -1) continue
        // Blank lines and indented lines continue the open entry; anything else at column zero ends it.
        if (line.trim() === "" || /^[ \t]/.test(line)) continue
        close(i)
    }
    close(lines.length)

    return out
}

/** What the workspace loader will bill for this file: frontmatter and comments stripped. */
export function injectedTokens(raw: string): number {
    return estimateTokens(strip(withoutFrontmatter(raw)))
}

/**
 * `2026-08.md` for a stamped entry, from its own stamp; the current month otherwise.
 *
 * Monthly rather than daily files, so a year of saved notes is twelve archives rather than three hundred.
 * The index treats every source separately and re-splits a changed one wholesale, so fewer, larger files
 * mean fewer reconciliation passes — and a person browsing `memory/` gets something readable.
 */
export function archiveNameFor(text: string, now: Date): string {
    const stamp = STAMP.exec(text)
    if (stamp !== null) return `${stamp[1]}-${stamp[2]}.md`
    const year = now.getUTCFullYear()
    const month = `${now.getUTCMonth() + 1}`.padStart(2, "0")
    return `${year}-${month}.md`
}

export interface EvictionPlan {
    /** Entries to move out, oldest first. */
    readonly evict: readonly Entry[]
    /** The file body after removing them. */
    readonly remaining: string
    /** Tokens the remaining body will be billed. */
    readonly tokens: number
    /** Set when the budget cannot be met by evicting notes. Reported, never ignored. */
    readonly shortfall?: string
}

/**
 * Decide what to move out so the file fits its budget.
 *
 * Evicts one entry at a time from the top and re-measures, rather than estimating how many to take: the
 * estimator is non-linear in the text it is given (newlines are counted separately), so "remove N tokens
 * worth" and "remove until it measures under budget" are different answers, and only the second is the
 * one the loader will agree with.
 *
 * **The last entry is never evicted.** A single note over budget is a configuration problem — the budget
 * is smaller than one thing the agent is meant to remember — and emptying the file would hide it while
 * still failing the load. `shortfall` names it instead.
 */
export function planEviction(raw: string, budget: number): EvictionPlan {
    const lines = raw.split(/\r?\n/)
    const entries = entriesIn(lines)

    const evict: Entry[] = []
    let kept = entries
    let body = raw
    let tokens = injectedTokens(body)

    while (tokens > budget && kept.length > 1) {
        const oldest = kept[0]
        if (oldest === undefined) break
        evict.push(oldest)
        kept = kept.slice(1)
        body = removeEntries(lines, evict)
        tokens = injectedTokens(body)
    }

    if (tokens <= budget) return { evict, remaining: body, tokens }

    return {
        evict,
        remaining: body,
        tokens,
        shortfall:
            kept.length <= 1
                ? `${tokens} tokens remain against a ${budget}-token budget with one note left, so eviction cannot help`
                : `${tokens} tokens remain against a ${budget}-token budget`,
    }
}

/** The file without these entries. Shared by eviction and `memory_forget`. */
export function removeEntries(lines: readonly string[], evict: readonly Entry[]): string {
    const drop = new Set<number>()
    for (const entry of evict) {
        for (let i = entry.start; i < entry.end; i += 1) drop.add(i)
    }
    return (
        lines
            .filter((_, i) => !drop.has(i))
            .join("\n")
            // A removed block leaves the blank lines that surrounded it; collapse them so the file does not
            // accumulate a growing gap where its history used to be.
            .replace(/\n{3,}/g, "\n\n")
    )
}

export interface NoteResult {
    /** The file the note was appended to, as the manifest names it. */
    readonly file: string
    /** How many older notes were moved out to make room. */
    readonly evicted: number
    /** Archive files written, relative to the memory directory. */
    readonly archives: readonly string[]
    /** Present when the file is still over budget afterwards. The caller must surface it. */
    readonly shortfall?: string
}

export interface AppendNoteInput {
    /** Absolute path of the carried file. */
    readonly path: string
    /** As the manifest names it, for the observation. */
    readonly name: string
    /** The file's effective token budget, from its frontmatter or its tier. */
    readonly budget: number
    /** Absolute path of the archive directory. Created on first eviction, never before. */
    readonly archiveDir: string
    readonly text: string
    readonly tags: readonly string[]
    readonly now: Date
}

/**
 * Append a note, then evict until the file fits.
 *
 * Append-then-evict rather than evict-then-append, so the note being saved is never the one displaced —
 * a save that silently discarded the thing it was asked to remember would be the worst available
 * outcome, and it is reachable whenever a file is already at its limit.
 *
 * The write order is: archive first, then the trimmed carried file. A crash between them leaves a note
 * in both places, which the content-derived passage id collapses to one row on the next index; the
 * reverse order would lose it entirely.
 */
export async function appendNote(input: AppendNoteInput): Promise<NoteResult> {
    const labels = input.tags.length === 0 ? "" : ` _(${input.tags.join(", ")})_`
    const line = `\n- **${input.now.toISOString()}**${labels} ${input.text}\n`

    await appendFile(input.path, line, "utf8")
    return await evictToBudget(input)
}

/**
 * Move the oldest notes out of the carried file until it fits its budget. What `appendNote` does after
 * every save, and what an import does after appending a bundle's notes (R11).
 */
export async function evictToBudget(input: {
    readonly path: string
    readonly name: string
    readonly budget: number
    readonly archiveDir: string
    readonly now: Date
}): Promise<NoteResult> {
    const raw = await readFile(input.path, "utf8")
    const plan = planEviction(raw, input.budget)
    if (plan.evict.length === 0) {
        return {
            file: input.name,
            evicted: 0,
            archives: [],
            ...(plan.shortfall === undefined ? {} : { shortfall: plan.shortfall }),
        }
    }

    const grouped = new Map<string, string[]>()
    for (const entry of plan.evict) {
        const name = archiveNameFor(entry.text, input.now)
        grouped.set(name, [...(grouped.get(name) ?? []), entry.text])
    }

    await mkdir(input.archiveDir, { recursive: true })
    for (const [name, blocks] of grouped) {
        await appendFile(join(input.archiveDir, name), `${blocks.join("\n")}\n`, "utf8")
    }
    await writeFile(input.path, plan.remaining, "utf8")

    return {
        file: input.name,
        evicted: plan.evict.length,
        archives: [...grouped.keys()].sort(),
        ...(plan.shortfall === undefined ? {} : { shortfall: plan.shortfall }),
    }
}

/**
 * The refusal for a workspace whose volatile files are all read-only.
 *
 * Kept here beside the writer rather than in `errors.ts` with the rest, because it is the one refusal
 * whose reason is a *workspace authoring* decision rather than a runtime fault, and its hint has to name
 * the field that caused it.
 */
export function memoryTargetMissing(): HarnessError {
    return new HarnessError({
        code: "memory_no_write_target",
        message: "No workspace file accepts a memory note.",
        hint: "Give one volatile file `editable: append` or `editable: replace` in its frontmatter. memory_write takes no file argument on purpose — the runtime resolves one target, because choosing a file would be a second decision on every save.",
    })
}
