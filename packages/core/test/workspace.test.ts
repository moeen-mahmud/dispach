/**
 * The tiered workspace: stripping, tiers, budgets, the rule guard, and the `context.files` alias.
 *
 * Two of these assertions are worth more than the rest and are here first. Frontmatter and HTML
 * comments reaching the model is a failure with no symptom — the agent still answers, and every turn
 * simply costs several hundred tokens more forever. And a budget that truncates rather than fails
 * produces an agent running on partial instructions with nothing anywhere reporting it. Neither is
 * discoverable by using the thing, so both are asserted rather than trusted.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessError } from "../src/errors.ts"
import { DEFAULT_PROMPT_STYLE } from "../src/model/prompt-style.ts"
import { parseWorkspaceFile, strip } from "../src/workspace/frontmatter.ts"
import {
    DEFAULT_WORKSPACE_BUDGETS,
    loadWorkspace,
    planWorkspace,
    ruleBudgetFailure,
    workspaceRefs,
    writeTarget,
} from "../src/workspace/load.ts"
import { allowedRules, checkRules, countRules } from "../src/workspace/rules.ts"
import { describe, expect, test } from "./_harness.ts"

function workspaceDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "workspace-test-"))
    mkdirSync(join(dir, "workspace"), { recursive: true })
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, "workspace", name), content, "utf8")
    }
    return dir
}

/** The manifest slice `planWorkspace` reads, with the schema's defaults applied. */
function context(overrides: Partial<Parameters<typeof planWorkspace>[0]> = {}) {
    return { workspace: "./workspace", files: [], static: [], volatile: [], ...overrides }
}

function load(dir: string, overrides: Partial<Parameters<typeof planWorkspace>[0]> = {}) {
    const plan = planWorkspace(context(overrides), dir)
    return { plan, workspace: loadWorkspace({ refs: plan.refs }) }
}

const RULES = { perRuleSuccess: 0.9, reliabilityTarget: 0.8, onExceed: "fail" } as const

function caught(fn: () => unknown): HarnessError {
    try {
        fn()
    } catch (error) {
        if (error instanceof HarnessError) return error
        throw error
    }
    throw new Error("expected a HarnessError, but nothing was thrown")
}

describe("stripping", () => {
    test("frontmatter and HTML comments never reach the body", () => {
        const parsed = parseWorkspaceFile(
            "AGENT.md",
            [
                "---",
                "tier: static",
                "editable: none",
                "budget: 120",
                "---",
                "<!-- Authoring note: keep this under 500 tokens. -->",
                "You are a careful assistant.",
                "<!-- another note -->",
                "Answer in prose.",
            ].join("\n"),
        )

        expect(parsed.frontmatter.tier).toBe("static")
        expect(parsed.frontmatter.budget).toBe(120)
        expect(parsed.body).toBe("You are a careful assistant.\n\nAnswer in prose.")
        expect(parsed.body.includes("<!--")).toBe(false)
        expect(parsed.body.includes("tier:")).toBe(false)
    })

    test("a `---` further down the file is a horizontal rule, not frontmatter", () => {
        const parsed = parseWorkspaceFile("AGENT.md", "Intro line.\n\n---\n\ntier: not-really\n")
        expect(parsed.frontmatter.tier).toBe(undefined)
        expect(parsed.body.includes("Intro line.")).toBe(true)
    })

    test("a multi-line comment block does not leave a blank-line crater", () => {
        expect(strip("a\n\n<!--\nnote\nnote\n-->\n\nb")).toBe("a\n\nb")
    })

    test("an unknown frontmatter key is refused rather than ignored", () => {
        const error = caught(() => parseWorkspaceFile("AGENT.md", "---\nteir: static\n---\nbody\n"))
        expect(error.code).toBe("workspace_frontmatter_invalid")
        expect(error.message.includes("teir")).toBe(true)
    })

    test("an out-of-range enum names the allowed values", () => {
        const error = caught(() => parseWorkspaceFile("A.md", "---\ntier: cached\n---\nx\n"))
        expect(error.code).toBe("workspace_frontmatter_invalid")
        expect(error.hint.length > 0).toBe(true)
    })
})

describe("tiers", () => {
    test("each tier lands in its own string, in declared order", () => {
        const dir = workspaceDir({
            "AGENT.md": "---\ntier: static\n---\nIdentity.",
            "POLICY.md": "---\ntier: static\n---\nPolicy.",
            "MEMORY.md": "---\ntier: volatile\neditable: replace\n---\nMemory.",
            "REMINDER.md": "---\ntier: reminder\n---\nReminder.",
        })

        const { workspace } = load(dir, {
            static: ["AGENT.md", "POLICY.md"],
            volatile: ["MEMORY.md"],
            reminder: "REMINDER.md",
        })

        expect(workspace.static).toBe("Identity.\n\nPolicy.")
        expect(workspace.volatile).toBe("Memory.")
        expect(workspace.reminder).toBe("Reminder.")
        expect(workspace.files.length).toBe(4)
    })

    test("frontmatter disagreeing with the list that named it is a load failure", () => {
        const dir = workspaceDir({ "MEMORY.md": "---\ntier: volatile\n---\nMemory." })
        const error = caught(() => load(dir, { static: ["MEMORY.md"] }))
        expect(error.code).toBe("workspace_tier_mismatch")
        expect(error.message.includes("MEMORY.md")).toBe(true)
    })

    test("a static file asking to be writable is refused, not quietly downgraded", () => {
        const dir = workspaceDir({ "AGENT.md": "---\neditable: append\n---\nIdentity." })
        const error = caught(() => load(dir, { static: ["AGENT.md"] }))
        expect(error.code).toBe("workspace_not_writable_tier")
    })

    test("volatile defaults to append; static and reminder to none", () => {
        const dir = workspaceDir({
            "AGENT.md": "Identity.",
            "USER.md": "User model.",
            "REMINDER.md": "Reminder.",
        })
        const { workspace } = load(dir, {
            static: ["AGENT.md"],
            volatile: ["USER.md"],
            reminder: "REMINDER.md",
        })
        const editable = Object.fromEntries(workspace.files.map((f) => [f.name, f.editable]))
        expect(editable["AGENT.md"]).toBe("none")
        expect(editable["USER.md"]).toBe("append")
        expect(editable["REMINDER.md"]).toBe("none")
    })

    test("a listed file that is not on disk fails the load naming the field", () => {
        const dir = workspaceDir({ "AGENT.md": "Identity." })
        const error = caught(() => load(dir, { static: ["AGENT.md", "GONE.md"] }))
        expect(error.code).toBe("workspace_file_missing")
        expect(error.field).toBe("context.static[1]")
    })
})

describe("budgets", () => {
    test("a file over its own budget fails the load and names the file", () => {
        const dir = workspaceDir({ "AGENT.md": `---\nbudget: 5\n---\n${"word ".repeat(200)}` })
        const error = caught(() => load(dir, { static: ["AGENT.md"] }))
        expect(error.code).toBe("workspace_budget_exceeded")
        expect(error.message.includes("AGENT.md")).toBe(true)
    })

    test("nothing is truncated to fit — the content is whole or the load fails", () => {
        const body = "word ".repeat(400)
        const dir = workspaceDir({ "AGENT.md": body })
        // Comfortably inside the default 700, so it loads whole rather than being trimmed to it.
        const { workspace } = load(dir, { static: ["AGENT.md"] })
        expect(workspace.static).toBe(body.trim())
    })

    test("the tier total is checked even when every file is individually fine", () => {
        const dir = workspaceDir({
            "A.md": `---\nbudget: 400\n---\n${"word ".repeat(1200)}`,
            "B.md": "---\nbudget: 400\n---\nshort",
        })
        const error = caught(() =>
            loadWorkspace({
                refs: workspaceRefs({
                    base: join(dir, "workspace"),
                    names: ["A.md", "B.md"],
                    tier: "static",
                    field: "context.static",
                }),
                budgets: { ...DEFAULT_WORKSPACE_BUDGETS, static: 700 },
            }),
        )
        // A.md busts its own 400 first, which is the right order: the narrower cap is the one the
        // author set deliberately.
        expect(error.code).toBe("workspace_budget_exceeded")
    })

    test("the overall cap fails even when every tier is within its own", () => {
        const dir = workspaceDir({
            "A.md": "word ".repeat(300),
            "B.md": "word ".repeat(300),
        })
        const error = caught(() =>
            loadWorkspace({
                refs: [
                    ...workspaceRefs({
                        base: join(dir, "workspace"),
                        names: ["A.md"],
                        tier: "static",
                        field: "context.static",
                    }),
                    ...workspaceRefs({
                        base: join(dir, "workspace"),
                        names: ["B.md"],
                        tier: "volatile",
                        field: "context.volatile",
                    }),
                ],
                budgets: { static: 5000, volatile: 5000, reminder: 60, total: 300 },
            }),
        )
        expect(error.code).toBe("workspace_budget_exceeded")
        expect(error.field).toBe("context.budgets.total")
    })

    test("budgets are measured on the stripped text, not the authored file", () => {
        const comment = `<!-- ${"note ".repeat(400)} -->`
        const dir = workspaceDir({ "AGENT.md": `${comment}\nShort identity.` })
        const { workspace } = load(dir, { static: ["AGENT.md"] })
        expect(workspace.static).toBe("Short identity.")
        expect(workspace.tokens.static < 20).toBe(true)
    })
})

describe("the context.files alias", () => {
    test("legacy files load as the static tier, resolving against the manifest directory", () => {
        const dir = mkdtempSync(join(tmpdir(), "workspace-legacy-"))
        writeFileSync(join(dir, "IDENTITY.md"), "Legacy identity.", "utf8")

        const { plan, workspace } = load(dir, { files: ["IDENTITY.md"] })

        expect(workspace.static).toBe("Legacy identity.")
        expect(plan.refs[0]?.tier).toBe("static")
        expect(plan.warnings.length).toBe(1)
        expect(plan.warnings[0]?.code).toBe("context_files_deprecated")
        expect(plan.warnings[0]?.hint.includes("context.static")).toBe(true)
    })

    test("setting both files and static is refused rather than merged", () => {
        const dir = workspaceDir({ "AGENT.md": "Identity." })
        writeFileSync(join(dir, "IDENTITY.md"), "Legacy.", "utf8")
        const error = caught(() => load(dir, { files: ["IDENTITY.md"], static: ["AGENT.md"] }))
        expect(error.code).toBe("workspace_alias_conflict")
    })
})

describe("the rule budget", () => {
    test("the allowance is computed, not tabulated", () => {
        // The table in 07-SPEC-WORKSPACE.md, reproduced by arithmetic. 0.9**2 = 0.81 >= 0.80;
        // 0.9**3 = 0.729 < 0.80. So two, which is the figure authors reliably guess as four.
        expect(allowedRules(0.9, 0.8)).toBe(2)
        expect(allowedRules(0.95, 0.8)).toBe(4)
        expect(allowedRules(0.7, 0.8)).toBe(0)
    })

    test("three rules fail a 0.90/0.80 budget and two pass", () => {
        const three = "- Always cite a source.\n- Never guess a date.\n- Reply in prose."
        const two = "- Always cite a source.\n- Never guess a date."

        expect(
            checkRules(three, { perRuleSuccess: 0.9, reliabilityTarget: 0.8 }).withinBudget,
        ).toBe(false)
        expect(checkRules(two, { perRuleSuccess: 0.9, reliabilityTarget: 0.8 }).withinBudget).toBe(
            true,
        )
    })

    test("examples and code fences are not rules", () => {
        const text = [
            "# Voice",
            "Always answer in prose.",
            "<example>",
            "Never do this, and always avoid that.",
            "</example>",
            "```",
            "must never always",
            "```",
        ].join("\n")

        const counted = countRules(text)
        expect(counted.length).toBe(1)
        expect(counted[0]?.text).toBe("Always answer in prose.")
    })

    test("every counted line is reported, so the heuristic is auditable", () => {
        const check = checkRules("- Never guess.\n- Always cite.\n- Keep replies short.", {
            perRuleSuccess: 0.9,
            reliabilityTarget: 0.8,
        })
        expect(check.counted.map((rule) => rule.text)).toEqual([
            "Never guess.",
            "Always cite.",
            "Keep replies short.",
        ])
        expect(check.expectedCompliance.toFixed(3)).toBe("0.729")
    })

    test("a heading that reads like a rule is not counted as one", () => {
        expect(countRules("## Always be helpful\nprose follows").length).toBe(0)
    })
})

describe("the memory_write target", () => {
    test("the first writable volatile file wins, in declared order", () => {
        const dir = workspaceDir({
            "USER.md": "---\ntier: volatile\neditable: append\n---\nUser model.",
            "MEMORY.md": "---\ntier: volatile\neditable: replace\n---\nMemory.",
        })
        const { workspace } = load(dir, { volatile: ["USER.md", "MEMORY.md"] })
        const target = writeTarget(workspace)
        expect(target?.name).toBe("USER.md")
        expect(target?.mode).toBe("append")
    })

    test("a read-only volatile file refuses rather than returning nothing", () => {
        // Distinct from "no workspace": the author configured a memory file and made it read-only,
        // and telling the model that is different from silently writing somewhere else.
        const dir = workspaceDir({ "MEMORY.md": "---\ntier: volatile\neditable: none\n---\nx" })
        const { workspace } = load(dir, { volatile: ["MEMORY.md"] })
        const target = writeTarget(workspace)
        expect(target?.mode).toBe("refused")
        expect(target?.reason).toBe("none")
        expect(target?.path).toBe(undefined)
    })

    test("no volatile tier means no target at all, so the tool keeps its own fallback", () => {
        const dir = workspaceDir({ "AGENT.md": "Identity." })
        const { workspace } = load(dir, { static: ["AGENT.md"] })
        expect(writeTarget(workspace)).toBe(undefined)
    })
})

describe("rendering and the rule count", () => {
    const AUTHORED = [
        "# Vex",
        "Always cite a source, so the reader can check it.",
        "## Examples",
        "<example>",
        "moeen: send it",
        "Vex: Always confirm before sending, and never guess a recipient.",
        "</example>",
    ].join("\n")

    test("rules are counted on the authored form, not the rendered one", () => {
        // The regression this exists for: `delimiters: markdown` turns `<example>` into a heading,
        // `countRules` excludes examples by looking for that marker, and so the two imperatives
        // inside the worked example started counting as rules the moment rendering landed. A shipped
        // example went from 1 rule to 4 with no edit to the file, and nothing but the boot bench
        // noticed.
        const dir = workspaceDir({ "AGENT.md": AUTHORED })
        const plan = planWorkspace(context({ static: ["AGENT.md"] }), dir)
        const workspace = loadWorkspace({
            refs: plan.refs,
            style: { ...DEFAULT_PROMPT_STYLE, delimiters: "markdown" },
        })

        // Rendered: the example is a heading, so the authored marker is gone from `content`.
        expect(workspace.static.includes("<example>")).toBe(false)
        expect(workspace.static).toContain("#### Example 1")

        // Counted: one rule, the one outside the example.
        expect(ruleBudgetFailure(workspace, RULES)).toBe(undefined)
    })

    test("the authored form is kept beside the rendered one", () => {
        const dir = workspaceDir({ "AGENT.md": AUTHORED })
        const plan = planWorkspace(context({ static: ["AGENT.md"] }), dir)
        const workspace = loadWorkspace({
            refs: plan.refs,
            style: { ...DEFAULT_PROMPT_STYLE, delimiters: "plain" },
        })
        const file = workspace.files[0]
        expect(file?.authored.includes("<example>")).toBe(true)
        expect(file?.content.includes("<example>")).toBe(false)
    })

    test("budgets are measured on the rendered text, which is what gets billed", () => {
        const dir = workspaceDir({ "AGENT.md": AUTHORED })
        const plan = planWorkspace(context({ static: ["AGENT.md"] }), dir)
        const xml = loadWorkspace({
            refs: plan.refs,
            style: { ...DEFAULT_PROMPT_STYLE, delimiters: "xml" },
        })
        const plain = loadWorkspace({
            refs: plan.refs,
            style: { ...DEFAULT_PROMPT_STYLE, delimiters: "plain" },
        })
        // Not an arbitrary assertion: `plain` exists partly because structured formats cost tokens,
        // so if the two ever measured the same the rendering would not be reaching the counter.
        expect(plain.tokens.static < xml.tokens.static).toBe(true)
    })
})

describe("examplesIn: user", () => {
    const AGENT = [
        "---",
        "tier: static",
        "---",
        "# Agent",
        "",
        "I answer briefly, because chat reads best short.",
        "",
        "<example>",
        "user: hi",
        "agent: hello",
        "</example>",
    ].join("\n")

    const USER_STYLE = { ...DEFAULT_PROMPT_STYLE, examplesIn: "user" as const }

    test("static-tier example blocks move to workspace.examples", () => {
        const dir = workspaceDir({ "AGENT.md": AGENT })
        const plan = planWorkspace(context({ static: ["AGENT.md"] }), dir)
        const workspace = loadWorkspace({ refs: plan.refs, style: USER_STYLE })

        expect(workspace.examples).toContain("agent: hello")
        expect(workspace.static.includes("agent: hello")).toBe(false)
        // The move is not a discount: the file's tokens count both halves, because both are billed
        // every turn whichever message they travel in.
        const file = workspace.files[0]
        expect(file !== undefined && file.tokens > 0).toBe(true)
        expect(workspace.static).toContain("I answer briefly")
    })

    test("under examplesIn: system nothing is extracted", () => {
        const dir = workspaceDir({ "AGENT.md": AGENT })
        const plan = planWorkspace(context({ static: ["AGENT.md"] }), dir)
        const workspace = loadWorkspace({ refs: plan.refs })

        expect(workspace.examples).toBe("")
        expect(workspace.static).toContain("agent: hello")
    })

    test("the rule count is unchanged by extraction — it reads the authored form", () => {
        const dir = workspaceDir({ "AGENT.md": AGENT })
        const plan = planWorkspace(context({ static: ["AGENT.md"] }), dir)
        const moved = loadWorkspace({ refs: plan.refs, style: USER_STYLE })
        const inPlace = loadWorkspace({ refs: plan.refs })

        expect(ruleBudgetFailure(moved, RULES)).toBe(ruleBudgetFailure(inPlace, RULES))
    })
})

describe("soul rule counting", () => {
    const SOUL = [
        "---",
        "tier: static",
        "---",
        "# Who I am",
        "",
        "I never get tired of being asked.",
        "",
        "He always wants the short answer first.",
        "",
        "<rules>",
        "I confirm before anything that sends, because mistakes there are expensive.",
        "</rules>",
        "",
        "You must read this paragraph as explanation, never as instruction.",
    ].join("\n")

    test("the full soul document counts only its rules blocks", () => {
        // The prose above carries never/always/must — on an ordinary static file that is three
        // counted rules. On the file the soul gate selected, prose is the premise, not the defect.
        const dir = workspaceDir({ "SOUL.md": SOUL })
        const refs = workspaceRefs({
            base: join(dir, "workspace"),
            names: ["SOUL.md"],
            tier: "static",
            field: "context.soul.file",
        }).map((ref) => ({ ...ref, field: "context.soul.file" }))
        const workspace = loadWorkspace({ refs })

        expect(ruleBudgetFailure(workspace, RULES)).toBe(undefined)
    })

    test("the same text as an ordinary static file counts in full", () => {
        const dir = workspaceDir({ "AGENT.md": SOUL })
        const { workspace } = load(dir, { static: ["AGENT.md"] })
        const failure = ruleBudgetFailure(workspace, RULES)
        expect(failure !== undefined).toBe(true)
    })

    test("the refusal names each counted line and its file in the message the wire carries", () => {
        // pilot.5: the lines were only in `details`, which `toDetail()` drops, so an embedder whose
        // reload was refused saw a count and nothing to act on (VelaCrew).
        const dir = workspaceDir({
            "IDENTITY.md": "You are a helper.",
            "AGENTS.md":
                "Intro.\nYou must reply in English.\nNever share keys.\nAlways cite sources.",
        })
        const { workspace } = load(dir, { static: ["IDENTITY.md", "AGENTS.md"] })
        const failure = ruleBudgetFailure(workspace, {
            ...RULES,
            perRuleSuccess: 0.9,
            reliabilityTarget: 0.85,
        })
        const message = failure?.toDetail().message ?? ""
        expect(message).toContain('"AGENTS.md: You must reply in English."')
        expect(message).toContain('"AGENTS.md: Always cite sources."')
        expect(message).not.toContain("IDENTITY.md:")
    })
})
