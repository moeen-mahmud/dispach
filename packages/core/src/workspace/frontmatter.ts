/**
 * Frontmatter parsing and pre-injection stripping.
 *
 * Both halves exist for the same reason, from opposite directions. The frontmatter is *for the
 * loader* — tier, editability, budget — and the HTML comments are *for the author*. Neither is for
 * the model, and neither may reach it.
 *
 * That is not a tidiness argument. The workspace templates carry their authoring guidance in HTML
 * comments precisely because this strips them, so the guidance is free at runtime. If the stripping
 * regresses, every agent pays several hundred tokens per turn, forever, for documentation it cannot
 * use — and nothing reports it, because a slightly larger system prompt has no symptom. So it is
 * asserted on the assembled prefix rather than trusted here.
 */

import { parse as parseYaml } from "yaml"
import { knowledgeFileInvalid, workspaceFrontmatterInvalid } from "../errors.ts"
import { stripHtmlComments } from "../text.ts"

export type Tier = "static" | "volatile" | "reminder"
export type Editable = "none" | "append" | "replace"
export type Eviction = "oldest" | "none"

export interface Frontmatter {
    readonly tier?: Tier
    readonly editable?: Editable
    readonly budget?: number
    readonly eviction?: Eviction
}

export interface ParsedFile {
    readonly frontmatter: Frontmatter
    /** The body, with frontmatter and HTML comments removed. Ready for injection. */
    readonly body: string
}

const TIERS: readonly string[] = ["static", "volatile", "reminder"]
const EDITABLE: readonly string[] = ["none", "append", "replace"]
const EVICTION: readonly string[] = ["oldest", "none"]

/**
 * Leading `---` ... `---`, and only leading.
 *
 * Anchored at position 0 with no leading-whitespace tolerance, because a `---` further down a
 * markdown file is a horizontal rule and swallowing the text above it would silently delete
 * instructions. A file whose frontmatter is one blank line too low simply has none, which is
 * visible the moment its tier does not apply.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** `<!-- ... -->`, non-greedy so adjacent comments do not merge into one span. */

/** Three or more consecutive newlines, left behind wherever a comment block was removed. */
const BLANK_RUN = /\n{3,}/g

/**
 * The body with any leading frontmatter block removed, and nothing else done to it.
 *
 * Exported for `memory/passages.ts`, which reads markdown a person may have put frontmatter on but
 * which carries none of the workspace tier keys — `readFrontmatter` would refuse those as unknown, so
 * it needs the removal without the validation. Sharing the function rather than the regex is the
 * point: `FRONTMATTER` is anchored at position 0 for a measured reason (a `---` further down is a
 * horizontal rule, and swallowing the text above it deletes instructions silently), and a second copy
 * of that anchoring is a second chance to get it wrong.
 */
export function withoutFrontmatter(raw: string): string {
    const match = FRONTMATTER.exec(raw)
    return match === null || match === undefined ? raw : raw.slice(match[0].length)
}

export function parseWorkspaceFile(name: string, raw: string): ParsedFile {
    const match = FRONTMATTER.exec(raw)
    const frontmatter =
        match === undefined || match === null ? {} : readFrontmatter(name, match[1] ?? "")
    const withoutFrontmatter =
        match === null || match === undefined ? raw : raw.slice(match[0].length)

    return { frontmatter, body: strip(withoutFrontmatter) }
}

/**
 * Remove HTML comments and normalise the whitespace they leave behind.
 *
 * Comments are stripped everywhere, including inside fenced code blocks. That is a deliberate
 * simplification and the trade is stated rather than hidden: an `AGENT.md` demonstrating HTML markup
 * in a fence would lose the commented line. The alternative — a fence-aware scanner — is more code
 * defending a case no identity file has, against a failure mode (guidance leaking to the model) that
 * every identity file has.
 */
export function strip(text: string): string {
    return stripHtmlComments(text).replace(BLANK_RUN, "\n\n").trim()
}

export interface ParsedKnowledgeFile {
    /** Lowercased, for the case-insensitive gate. Order preserved from the author. */
    readonly keywords: readonly string[]
    /** The body, with frontmatter and HTML comments removed. Ready for injection. */
    readonly body: string
}

/**
 * A knowledge file: the same leading `---` block and the same stripping, a different vocabulary.
 *
 * `keywords` is *required*, unlike every workspace key, because it is the entry's only way in:
 * a knowledge file without keywords can never activate, and a file that can never activate is the
 * starved-by-configuration shape this codebase refuses everywhere else.
 */
export function parseKnowledgeFile(name: string, raw: string): ParsedKnowledgeFile {
    const match = FRONTMATTER.exec(raw)
    if (match === null) {
        throw knowledgeFileInvalid(name, "it has no frontmatter, so it declares no keywords.")
    }

    let parsed: unknown
    try {
        parsed = parseYaml(match[1] ?? "")
    } catch (cause) {
        throw knowledgeFileInvalid(name, "its frontmatter is not valid YAML.", cause)
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw knowledgeFileInvalid(name, "its frontmatter did not parse to a mapping.")
    }

    const record = parsed as Record<string, unknown>
    for (const key of Object.keys(record)) {
        if (key === "keywords") continue
        throw knowledgeFileInvalid(name, `it sets an unknown key "${key}". Known keys: keywords.`)
    }

    const keywords = record.keywords
    if (
        !Array.isArray(keywords) ||
        keywords.length === 0 ||
        keywords.some((keyword) => typeof keyword !== "string" || keyword.trim() === "")
    ) {
        throw knowledgeFileInvalid(name, "keywords must be a non-empty list of non-empty strings.")
    }

    return {
        keywords: keywords.map((keyword: string) => keyword.trim().toLowerCase()),
        body: strip(raw.slice(match[0].length)),
    }
}

function readFrontmatter(name: string, source: string): Frontmatter {
    let parsed: unknown
    try {
        parsed = parseYaml(source)
    } catch (cause) {
        throw workspaceFrontmatterInvalid(name, "it is not valid YAML.", cause)
    }

    if (parsed === null || parsed === undefined) return {}
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw workspaceFrontmatterInvalid(name, "it did not parse to a mapping.")
    }

    const record = parsed as Record<string, unknown>
    const known = new Set(["tier", "editable", "budget", "eviction"])
    for (const key of Object.keys(record)) {
        if (known.has(key)) continue
        throw workspaceFrontmatterInvalid(
            name,
            `it sets an unknown key "${key}". Known keys: ${[...known].join(", ")}.`,
        )
    }

    const out: {
        tier?: Tier
        editable?: Editable
        budget?: number
        eviction?: Eviction
    } = {}

    if (record.tier !== undefined) {
        out.tier = enumValue(name, "tier", record.tier, TIERS) as Tier
    }
    if (record.editable !== undefined) {
        out.editable = enumValue(name, "editable", record.editable, EDITABLE) as Editable
    }
    if (record.eviction !== undefined) {
        out.eviction = enumValue(name, "eviction", record.eviction, EVICTION) as Eviction
    }
    if (record.budget !== undefined) {
        const budget = record.budget
        if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) {
            throw workspaceFrontmatterInvalid(
                name,
                `budget must be a positive whole number of tokens, but is ${JSON.stringify(budget)}.`,
            )
        }
        out.budget = budget
    }

    return out
}

function enumValue(name: string, key: string, value: unknown, allowed: readonly string[]): string {
    if (typeof value === "string" && allowed.includes(value)) return value
    throw workspaceFrontmatterInvalid(
        name,
        `${key} is ${JSON.stringify(value)}, which is not one of: ${allowed.join(" | ")}.`,
    )
}
