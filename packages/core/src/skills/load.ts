/**
 * Activation: rank, threshold, take what fits, then read only the bodies that won.
 *
 * The read happens here rather than at boot, and that ordering is the whole reason the catalogue holds
 * frontmatter and a token count instead of text. At most `maxActive` files are opened per turn — one, by
 * default — against fifty held in memory and re-rendered on every boot. It also means an edited body
 * takes effect on the next turn rather than the next restart, which is the behaviour anyone editing a
 * skill expects.
 *
 * Selection happens **once per turn**, never per step, exactly as knowledge does. Re-selecting per step
 * would let two steps of one turn follow different procedures, which is worse than following a
 * mediocre one consistently.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { activate } from "../context/activate.ts"
import { estimateTokens } from "../context/tokens.ts"
import { type ErrorDetail, skillNotApplied } from "../errors.ts"
import { DEFAULT_PROMPT_STYLE, type PromptStyle, renderPromptStyle } from "../model/prompt-style.ts"
import { isScaffold } from "./authoring.ts"
import { parseSkillFile } from "./frontmatter.ts"
import type { Skill, SkillCatalogue } from "./index.ts"
import { bm25Selector, type SkillSelector } from "./select.ts"

export interface ActiveSkill {
    readonly name: string
    readonly score: number
    /** Rendered and stripped. What goes into `SLOT.skill`. */
    readonly content: string
    readonly tokens: number
    /** Absolute. Part B resolves `scripts/` against it. */
    readonly dir: string
}

export interface Activation {
    readonly active: readonly ActiveSkill[]
    /**
     * Anything a person should be told about this activation, for the caller to put on the bus.
     *
     * Returned rather than emitted because core does not own the bus at this depth — and returned at
     * all because the alternative is dropping a skill silently, which is how a workspace ends up with
     * a procedure that appears to be installed and never runs.
     */
    readonly notes: readonly ErrorDetail[]
}

export interface ActivateSkillsOptions {
    /**
     * The turn's input, and the previous assistant turn when there is one.
     *
     * Both, because a follow-up rarely repeats the subject: "now do the other one" carries no term any
     * skill's description contains, and the assistant's previous turn is where the subject still is.
     */
    readonly input: string
    readonly catalogue: SkillCatalogue
    readonly selector?: SkillSelector
    /** The same style the catalogue's token counts were measured under. */
    readonly style?: PromptStyle
}

export function activateSkills(options: ActivateSkillsOptions): Activation {
    const { catalogue } = options
    if (catalogue.skills.length === 0 || catalogue.maxActive <= 0) return { active: [], notes: [] }

    const selector = options.selector ?? bm25Selector
    const style = options.style ?? DEFAULT_PROMPT_STYLE

    const ranked = selector(
        options.input,
        catalogue.skills.filter((skill) => !isScaffold(skill.frontmatter)),
    )
    // The threshold is the caller's to apply, not the selector's — a selector that filtered would be
    // deciding one of the three limits it exists to be prevented from widening.
    const above = ranked.filter((scored) => scored.score >= catalogue.threshold)
    const chosen = activate(
        above.map((scored) => scored.skill),
        // No budget: `maxActive` is the whole limit for skills (decision 11.59).
        { maxActive: catalogue.maxActive },
    )
    const scoreOf = new Map(above.map((scored) => [scored.skill.name, scored.score]))

    const active: ActiveSkill[] = []
    const notes: ErrorDetail[] = []

    for (const skill of chosen) {
        let content: string
        try {
            content = renderPromptStyle(bodyOf(skill), style)
        } catch (cause) {
            // A skill that indexed cleanly and cannot be read now has been deleted or broken between
            // boot and this turn. Reported and skipped: refusing the turn would make an unrelated
            // question fail because of a file it never needed.
            notes.push(
                skillNotApplied(
                    skill.name,
                    `its SKILL.md could not be read — ${reason(cause)}`,
                    "The file was readable when the catalogue was scanned, so it has been deleted, renamed or broken since. Run `skills validate` to see the current state; the next restart re-scans.",
                ),
            )
            continue
        }

        // Re-measured rather than trusted: the catalogue's figure was taken at the last cold scan and the
        // file may have been edited since. Nothing refuses on size any more — the number is carried so a
        // caller can report what a turn actually spent.
        const tokens = estimateTokens(content)

        active.push({
            name: skill.name,
            score: scoreOf.get(skill.name) ?? 0,
            content,
            tokens,
            dir: skill.dir,
        })
    }

    return { active, notes }
}

function bodyOf(skill: Skill): string {
    const path = join(skill.dir, "SKILL.md")
    return parseSkillFile(skill.name, readFileSync(path, "utf8")).body
}

function reason(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
}
