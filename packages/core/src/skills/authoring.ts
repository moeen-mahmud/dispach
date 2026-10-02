/**
 * How well a skill is *written*, as distinct from whether it loads.
 *
 * Every finding here is a warning and nothing in this file can refuse a skill. That split is the same one
 * `validate` and `workspace` already draw: a file the loader cannot parse stops the runtime and belongs there, and
 * "your description rests on one word" is a note from a careful reader. A heuristic judgement that
 * refuses to load a file is a heuristic nobody keeps.
 *
 * It lives in core rather than in the CLI for the reason `ruleBudgetFailure` does: a check only one caller
 * performs is a check the callers disagree about. `skills validate` is the only consumer today; Phase 9's
 * plugin surface and any future `doctor` get the same answers by calling the same function.
 *
 * The single-term check is the one to keep. It exists because measurement found it: with a corpus of eight
 * skills, `docker-build`'s description — opening "Write and debug a Dockerfile" — was activated by "write
 * me a haiku about autumn", scoring 0.451 against a 0.35 threshold. Lexically that is indistinguishable
 * from a real match, so no threshold fixes it; the fix is authoring, and this is where an author hears
 * about it.
 */

import { type ErrorDetail, skillAuthoring } from "../errors.ts"
import { DESCRIPTION_MAX } from "./frontmatter.ts"
import type { Skill } from "./index.ts"
import { terms } from "./select.ts"

/** The spec's own recommendation for a `SKILL.md` body. Above it, a warning — and only ever a warning. */
const BODY_TOKENS_ADVISED = 5_000

/**
 * Below this, a description has too little for selection to work with.
 *
 * Forty characters is roughly "Handles invoices." plus a clause — enough to be a sentence and not enough
 * to say both what it does and when to use it, which is what the spec asks for.
 */
const DESCRIPTION_MIN = 40

/**
 * Phrases the shipped starter skill uses where a person is meant to write their own text.
 *
 * Coupled to that template on purpose, exactly as the workspace checks are coupled to `{{THING}}`. A
 * skill cannot use `{{...}}` for this — `description: {{FOO}}` is a YAML flow mapping and fails to parse —
 * so the scaffold says what it wants in prose and this recognises the prose. The point is the same: a
 * generated file that validates clean the moment it is written teaches nobody to edit it.
 */
const SCAFFOLD_MARKERS: readonly string[] = ["Replace this", "Replace everything below"]

/**
 * Still the scaffold `init` wrote: its description is instructions to a person, not a skill.
 *
 * Also what keeps it out of selection (`activateSkills`). Ranked, its placeholder description
 * matched ordinary turns ("file", "tool", "error"), and the model was handed "replace everything
 * below with the steps" and complained about it to the person (QA 0.2.0).
 */
export function isScaffold(frontmatter: {
    readonly description: string
    readonly whenNotToUse?: string
}): boolean {
    return SCAFFOLD_MARKERS.some(
        (marker) =>
            frontmatter.description.includes(marker) ||
            (frontmatter.whenNotToUse ?? "").includes(marker),
    )
}

/**
 * A term is discriminating within this workspace when it appears in at most half of the descriptions.
 *
 * The same rule the selector applies, deliberately: an authoring warning that used a different definition
 * would tell people to fix something the scorer does not care about.
 */
function discriminatingTerms(skill: Skill, corpus: readonly Skill[]): readonly string[] {
    const document = new Set(terms(`${skill.frontmatter.name} ${skill.frontmatter.description}`))
    const total = corpus.length
    const counts = new Map<string, number>()
    for (const other of corpus) {
        for (const term of new Set(
            terms(`${other.frontmatter.name} ${other.frontmatter.description}`),
        )) {
            counts.set(term, (counts.get(term) ?? 0) + 1)
        }
    }
    return [...document].filter((term) => {
        const df = counts.get(term) ?? 0
        return df > 0 && (total < 3 || df <= total / 2)
    })
}

export function checkSkillAuthoring(skills: readonly Skill[]): readonly ErrorDetail[] {
    const findings: ErrorDetail[] = []

    for (const skill of skills) {
        const { frontmatter } = skill

        // Reported first and on its own: every other finding about a scaffold is noise, since the text
        // being judged is text nobody wrote.
        if (isScaffold(frontmatter)) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    "it is still the scaffold — its description and negative guidance are the instructions, not a skill",
                    "Write what this procedure does, when to reach for it, and the steps. Until then it is ranked against real skills on placeholder text and will activate on the wrong turns or on none. The other authoring checks are skipped for this skill until it is filled in.",
                ),
            )
            continue
        }

        if (frontmatter.whenNotToUse === undefined) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    "it declares no negative guidance",
                    "Add it under metadata as <brand>-when-not-to-use. Negative examples are the cheapest routing improvement available — a reported 73% to 85% — and the spec defines no field for them, which is why metadata is where they go. Not required to load: a skill vendored from elsewhere will not have one.",
                ),
            )
        }

        if (frontmatter.description.length > DESCRIPTION_MAX) {
            // A warning rather than a refusal, and the reason is in `readDescription`: `anthropics/skills`'
            // own `claude-api` is 1,068 characters against a documented 1,024, so enforcing it at load
            // would drop a flagship skill written by the people who wrote the spec.
            findings.push(
                skillAuthoring(
                    skill.name,
                    `its description is ${frontmatter.description.length} characters, over the spec's ${DESCRIPTION_MAX}`,
                    "Nothing here refuses it — the string is ranked, shown and budgeted whatever its length — but a client that enforces the cap will reject the skill, and every character is in the cache-stable prefix of every turn.",
                ),
            )
        }

        if (frontmatter.description.length < DESCRIPTION_MIN) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    `its description is ${frontmatter.description.length} characters`,
                    "The description is the only thing selection has to go on, and the spec asks it to say both what the skill does and when to use it. A short one competes badly against every other skill in the workspace.",
                ),
            )
        } else if (!/\bwhen\b/i.test(frontmatter.description)) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    "its description never says when to use the skill",
                    'The spec asks for both halves: what it does, and when to reach for it. "Use when the user mentions PDFs, forms, or document extraction" is the half that turns a description into a routing signal.',
                ),
            )
        }

        // The measured one. Ranked *after* the description checks so an author fixing a thin description
        // usually fixes this at the same time.
        const distinctive = discriminatingTerms(skill, skills)
        if (skills.length >= 3 && distinctive.length < 2) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    distinctive.length === 0
                        ? "no word in its name or description distinguishes it from the other skills here"
                        : `only one word distinguishes it from the other skills here: "${distinctive[0]}"`,
                    'Selection is lexical, so a description resting on one word activates on any turn that happens to use it — measured: a skill opening "Write and debug a Dockerfile" was selected for "write me a haiku about autumn". Add the specific nouns someone would actually type: file formats, tool names, the words in the error they are looking at.',
                ),
            )
        }

        if (skill.tokens > BODY_TOKENS_ADVISED) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    `its body is ${skill.tokens} tokens`,
                    `The spec recommends keeping a SKILL.md body under ${BODY_TOKENS_ADVISED} tokens and moving detail into references/, which the model reads on demand rather than on every activation. Nothing refuses it — there is no skills budget — so this is the only place the cost is reported before a turn pays it.`,
                ),
            )
        }

        for (const ignored of skill.ignoredScripts) {
            findings.push(
                skillAuthoring(
                    skill.name,
                    `scripts/${ignored.file} will never run — ${ignored.reason}`,
                    "Give it an executable bit and a shebang, rename it to .py, .ts or .js, or move it out of scripts/. Left as it is, it looks installed and silently does nothing, which is the failure this warning exists to prevent.",
                ),
            )
        }
    }

    return findings
}
