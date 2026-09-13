/**
 * The passage splitter: what counts as one retrievable unit, and what must never become one.
 *
 * Two assertions carry more weight than the rest. **Frontmatter and HTML comments must not survive**,
 * for the reason the workspace loader has the same rule — a comment that reaches slot 7 is billed on
 * every matching turn forever for guidance the model cannot use. And **an empty passage must never be
 * emitted**: BM25 divides by the corpus average document length, so a run of zero-term rows drags that
 * average down and silently inflates every real passage's score, which reads as retrieval getting
 * better rather than as a bug.
 */

import { derivedId } from "../src/ids.ts"
import { document, impliedDate, splitPassages } from "../src/memory/passages.ts"
import { describe, expect, test } from "./_harness.ts"

const FALLBACK = "2026-01-01T00:00:00Z"

function split(text: string, source = "2026-08.md") {
    return splitPassages({ text, source, fallbackAt: FALLBACK })
}

describe("splitPassages", () => {
    test("one bullet is one passage, with its stamp, tags and heading", () => {
        const passages = split(
            [
                "## Preferences",
                "",
                "- **2026-08-19T10:00:00Z** _(project, style)_ Moeen prefers tabs in generated YAML.",
                "- **2026-08-18T09:00:00Z** _(project)_ Boot must stay under a second.",
            ].join("\n"),
        )

        expect(passages.length).toBe(2)
        expect(passages[0]?.heading).toBe("Preferences")
        expect(passages[0]?.at).toBe("2026-08-19T10:00:00Z")
        expect(passages[0]?.stamped).toBe(true)
        expect(passages[0]?.tags).toEqual(["project", "style"])
        expect(passages[1]?.tags).toEqual(["project"])
        // Verbatim: a retrieved note is never rewritten, so the stamp stays in the text too.
        expect(passages[0]?.text.includes("prefers tabs in generated YAML")).toBe(true)
    })

    test("a wrapped bullet and an indented sub-list stay in one passage", () => {
        const passages = split(
            [
                "- The deploy runs in two stages",
                "  and the second one waits on approval.",
                "",
                "    - staging first",
                "    - production after a manual gate",
                "- A separate note.",
            ].join("\n"),
        )

        expect(passages.length).toBe(2)
        expect(passages[0]?.text.includes("waits on approval")).toBe(true)
        expect(passages[0]?.text.includes("production after a manual gate")).toBe(true)
        expect(passages[1]?.text).toBe("- A separate note.")
    })

    test("a bullet ends at a line back at its own indent", () => {
        const passages = split(["- a bullet", "prose that follows it"].join("\n"))

        expect(passages.length).toBe(2)
        expect(passages[0]?.text).toBe("- a bullet")
        expect(passages[1]?.text).toBe("prose that follows it")
    })

    test("prose between headings is one passage per section", () => {
        const passages = split(
            [
                "# Deployment",
                "",
                "The pipeline is green before merge.",
                "It runs on every push.",
                "",
                "# Rollback",
                "",
                "One command, no ceremony.",
            ].join("\n"),
        )

        expect(passages.length).toBe(2)
        expect(passages[0]?.heading).toBe("Deployment")
        expect(passages[0]?.text.includes("every push")).toBe(true)
        expect(passages[1]?.heading).toBe("Rollback")
        expect(passages[1]?.text).toBe("One command, no ceremony.")
    })

    test("frontmatter and HTML comments never reach a passage", () => {
        const passages = split(
            [
                "---",
                "tier: volatile",
                "eviction: oldest",
                "---",
                "",
                "<!-- authoring guidance the model must never be billed for -->",
                "",
                "- **2026-08-19T10:00:00Z** a real note",
            ].join("\n"),
        )

        expect(passages.length).toBe(1)
        const all = passages.map((p) => p.text).join("\n")
        expect(all.includes("tier: volatile")).toBe(false)
        expect(all.includes("eviction")).toBe(false)
        expect(all.includes("authoring guidance")).toBe(false)
    })

    test("blank runs and horizontal rules produce no empty passages", () => {
        const passages = split(["- one", "", "", "", "- two", "", ""].join("\n"))

        expect(passages.length).toBe(2)
        for (const passage of passages) expect(passage.text.trim() === "").toBe(false)
    })

    test("an empty or comment-only document yields nothing", () => {
        expect(split("").length).toBe(0)
        expect(split("   \n\n  ").length).toBe(0)
        expect(split("<!-- only a comment -->").length).toBe(0)
    })

    test("an unstamped passage takes the date implied by the filename, and says so", () => {
        const monthly = split("- a note nobody stamped", "2026-08.md")
        expect(monthly[0]?.at).toBe("2026-08-01T00:00:00Z")
        expect(monthly[0]?.stamped).toBe(false)

        const daily = split("- a note nobody stamped", "memory/2026-08-19.md")
        expect(daily[0]?.at).toBe("2026-08-19T00:00:00Z")

        const unnamed = split("- a note nobody stamped", "MEMORY.md")
        expect(unnamed[0]?.at).toBe(FALLBACK)
    })

    test("identity is content-derived, so the same note in two files is one row", () => {
        const here = split("- **2026-08-19T10:00:00Z** the same words", "2026-08.md")
        const there = split("- **2026-08-19T10:00:00Z** the same words", "MEMORY.md")

        expect(here[0]?.id).toBe(there[0]?.id)
        expect(here[0]?.id).toBe(derivedId("mem", here[0]?.text ?? ""))
        expect(here[0]?.source).toBe("2026-08.md")
        expect(there[0]?.source).toBe("MEMORY.md")
    })

    test("passages come back in document order", () => {
        const passages = split(["- first", "- second", "- third"].join("\n"))
        expect(passages.map((p) => p.text)).toEqual(["- first", "- second", "- third"])
    })
})

describe("impliedDate", () => {
    test("a month resolves to its first day, which biases the passage older", () => {
        // Deliberate: an unstamped note must not be able to outrank a stamped one written after it.
        expect(impliedDate("memory/2026-08.md")).toBe("2026-08-01T00:00:00Z")
    })

    test("a day wins over the month inside the same name", () => {
        expect(impliedDate("2026-08-19.md")).toBe("2026-08-19T00:00:00Z")
    })

    test("a name with no date implies nothing", () => {
        expect(impliedDate("MEMORY.md")).toBe(undefined)
        expect(impliedDate("notes.md")).toBe(undefined)
    })
})

describe("document", () => {
    test("the scored document weights the heading before the text", () => {
        const passages = split(["## Formatting", "- prefers tabs"].join("\n"))
        const withHeading = passages[0]
        expect(withHeading === undefined).toBe(false)
        expect(withHeading === undefined ? "" : document(withHeading)).toBe(
            "Formatting\nFormatting\n- prefers tabs",
        )
    })

    test("author tags are weighted retrieval fields rather than display-only metadata", () => {
        const tagged = split("- _(style)_ commit messages are imperative")[0]
        expect(tagged === undefined).toBe(false)
        expect(tagged === undefined ? "" : document(tagged)).toBe(
            "style\nstyle\n-  commit messages are imperative",
        )
    })

    test("a top-level passage is scored on its text alone", () => {
        const bare = split("- prefers tabs")[0]
        expect(bare === undefined).toBe(false)
        expect(bare === undefined ? "" : document(bare)).toBe("- prefers tabs")
    })
})
