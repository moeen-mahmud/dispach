/**
 * Per-model rendering of authored workspace files.
 *
 * Authors write one markdown file with `<example>` delimiters. The runtime renders it for the
 * model in front of it, because published prompting guidance is written for frontier models and a
 * significant fraction of it inverts at 3–8B. Anthropic recommends XML tags, having trained Claude
 * on them; controlled cross-model work finds no reliable markdown advantage in general and a 22–37%
 * token penalty for structured formats. Both results hold. The resolution is per-model rendering
 * rather than a house style — which is why this is a *capability* and never a constant.
 *
 * Phase 3 supplied the worked example of the cost of getting this wrong, from the other direction:
 * NLT's preamble carried a metasyntactic placeholder that frontier models read as metasyntax and
 * qwen3.5:9b read as the format, and the same bytes moved a benchmark 65 points. See decision 4.19.
 *
 * **What this file does not do.** It does not rewrite the author's sentences. Everything here is a
 * transformation of *delimiters and structure*, never of prose — automatic rewriting of an
 * instruction is the same hazard as the placeholder above, applied to a file the author cannot
 * see the rendered form of.
 */

/** Which class of model the shipped defaults are keyed to. Diagnostic, not behavioural. */
export type PromptStyleClass = "anthropic" | "openai" | "small-open-weight" | "default"

export interface PromptStyle {
    /**
     * How example blocks and section structure are marked.
     *
     * `xml` keeps the authored `<example>` tags — Claude was trained on them. `markdown` promotes
     * them to headings. `plain` reduces them to a labelled line and strips heading syntax, on the
     * evidence that models imitate the form of what they read: a bulleted, headed file produces a
     * bulleted, headed agent regardless of what the file says about formatting.
     */
    readonly delimiters: "xml" | "markdown" | "plain"
    readonly intensity: "emphatic" | "neutral" | "soft"
    /** Where example blocks are placed. Settled by `evals/prompt-style/`, not by picking a vendor. */
    readonly examplesIn: "system" | "user"
    readonly skillsIn: "system" | "user"
}

export const DEFAULT_PROMPT_STYLE: PromptStyle = {
    delimiters: "markdown",
    intensity: "neutral",
    examplesIn: "system",
    skillsIn: "system",
}

/**
 * Parameter size in billions, from the model id.
 *
 * Read from the id rather than tabulated per pattern because the registry's patterns cannot express
 * it: `qwen3.5*` matches both `qwen3.5:9b` and `qwen3.5:72b`, and those two want opposite
 * `intensity` values. Size is the thing that actually predicts the inversion, and it is written in
 * the id — `llama3.1:8b`, `qwen2.5-14b-instruct`, `mixtral-8x7b`.
 *
 * `8x7b` is deliberately read as 7, not 56: a mixture-of-experts model activates one expert's worth
 * of parameters per token and behaves like the smaller number for this purpose.
 */
export function parameterBillions(modelId: string): number | undefined {
    const id = modelId.toLowerCase()
    const mixture = /(?<!\d)(\d+)x(\d+(?:\.\d+)?)b\b/.exec(id)
    if (mixture !== null) return Number(mixture[2])
    const plain = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)b\b/.exec(id)
    if (plain === null) return undefined
    const value = Number(plain[1])
    return Number.isFinite(value) ? value : undefined
}

/** Below this, published frontier-model prompting guidance starts to invert. */
export const SMALL_MODEL_BILLIONS = 14

export function promptStyleClass(modelId: string): PromptStyleClass {
    const id = modelId.toLowerCase()

    // Size first: a small open-weight model is a small open-weight model whatever family it is in,
    // and the whole reason this capability exists is that the guidance inverts by size.
    const billions = parameterBillions(id)
    if (billions !== undefined && billions < SMALL_MODEL_BILLIONS) return "small-open-weight"

    if (id.startsWith("claude-")) return "anthropic"
    if (id.startsWith("gpt-") || /^o\d/.test(id)) return "openai"
    return "default"
}

/**
 * The shipped default for a model id.
 *
 * Conservative in the same sense as the capability registry: wrong here costs style, not
 * correctness, and any of it is one `model.<role>.capabilities.promptStyle` block away from fixed.
 */
export function defaultPromptStyle(modelId: string): PromptStyle {
    switch (promptStyleClass(modelId)) {
        case "anthropic":
            return {
                delimiters: "xml",
                intensity: "neutral",
                examplesIn: "system",
                skillsIn: "system",
            }
        case "openai":
            // Examples in the user message per OpenAI's guidance, which puts tone and role in the
            // system message and task-specific detail in user messages. Anthropic says the opposite.
            // `evals/prompt-style/` settles it; until then each vendor's own advice is the default
            // for its own models, which is the least presumptuous place to stand.
            return {
                delimiters: "markdown",
                intensity: "neutral",
                examplesIn: "user",
                skillsIn: "user",
            }
        case "small-open-weight":
            // `emphatic` is the inversion made concrete. Anthropic now advises *removing* emphatic
            // phrasing because current models overtrigger on it; a 7B model has the opposite failure
            // mode and needs the imperative framing that a frontier model no longer does.
            return {
                delimiters: "plain",
                intensity: "emphatic",
                examplesIn: "system",
                skillsIn: "system",
            }
        default:
            return DEFAULT_PROMPT_STYLE
    }
}

const EXAMPLE_OPEN = /^[ \t]*<example(?:\s[^>]*)?>[ \t]*$/
const EXAMPLE_CLOSE = /^[ \t]*<\/example>[ \t]*$/
const RULES_OPEN = /^[ \t]*<rules(?:\s[^>]*)?>[ \t]*$/
const RULES_CLOSE = /^[ \t]*<\/rules>[ \t]*$/
const HEADING = /^(#{1,6})\s+(.*)$/

/**
 * What `intensity` actually varies: one generated line in front of the author's rules.
 *
 * The spec described `emphatic` as adding "imperative framing and repetition". The framing is here;
 * the repetition is the `reminder` tier, which already re-asserts one or two rules at the recency
 * position and does it better — duplicating a rule block inside slot 0 would double its token cost
 * to say the same thing twice in the same place, where attention is identical.
 *
 * Nothing here touches the author's sentences. `emphatic` for a 7B model and `neutral` for a
 * frontier one differ by this line and nothing else, so the rendered form stays predictable from the
 * authored one — which matters most for the file whose rendered form nobody ever looks at.
 */
const RULE_FRAMING: Record<PromptStyle["intensity"], string | undefined> = {
    // Anthropic now advises removing exactly this phrasing, because current models overtrigger on
    // it. A 7B model has the opposite failure mode. That inversion is the whole reason the field
    // exists rather than a house style.
    emphatic: "Follow these rules exactly. They are not suggestions.",
    neutral: undefined,
    soft: "Where it helps:",
}

export interface ExtractedExamples {
    /** The authored text with its example blocks removed. Everything else is untouched. */
    readonly body: string
    /** The example blocks, tags intact, in authored order. Empty string when there are none. */
    readonly examples: string
}

/**
 * Pull `<example>` blocks out of authored text, for `examplesIn: user`.
 *
 * Operates on the *authored* form and keeps the tags, so the extracted text renders through
 * `renderPromptStyle` exactly like it would have in place — same delimiters, same numbering. The
 * split is a move, never a rewrite: concatenating `examples` back into `body` reproduces every
 * authored sentence, which is what the placement eval depends on. Measuring `system` against `user`
 * only means something if the bytes are the same and only the position moved.
 *
 * Fence-aware for the same reason the renderer is: inside a fence the author is showing text, not
 * writing it, and an `<example>` tag there is part of a demonstration rather than a delimiter.
 */
export function extractExamples(text: string): ExtractedExamples {
    if (text === "") return { body: "", examples: "" }

    const body: string[] = []
    const examples: string[] = []
    let inFence = false
    let inExample = false

    for (const line of text.split("\n")) {
        if (/^\s*(?:```|~~~)/.test(line)) {
            inFence = !inFence
            ;(inExample ? examples : body).push(line)
            continue
        }
        if (!inFence && !inExample && EXAMPLE_OPEN.test(line)) {
            inExample = true
            examples.push(line)
            continue
        }
        if (!inFence && inExample && EXAMPLE_CLOSE.test(line)) {
            inExample = false
            examples.push(line)
            // A blank line between blocks, so two adjacent examples do not run together.
            examples.push("")
            continue
        }
        ;(inExample ? examples : body).push(line)
    }

    return {
        body: body
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        examples: examples
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
    }
}

/**
 * Render authored text for one model.
 *
 * Line-oriented and deliberately dull. A markdown parser would be more correct about nested
 * constructs and would also be the first non-trivial runtime dependency in the tree, for a
 * transformation whose entire job is example delimiters and heading markers.
 */
export function renderPromptStyle(text: string, style: PromptStyle): string {
    if (text === "") return ""

    const out: string[] = []
    let exampleIndex = 0
    let inFence = false

    for (const line of text.split("\n")) {
        // Inside a fence the author is showing text, not writing it. Rewriting a heading there
        // would corrupt an example of markdown into an example of something else.
        if (/^\s*(?:```|~~~)/.test(line)) {
            inFence = !inFence
            out.push(line)
            continue
        }
        if (inFence) {
            out.push(line)
            continue
        }

        if (EXAMPLE_OPEN.test(line)) {
            exampleIndex += 1
            out.push(openExample(style.delimiters, exampleIndex))
            continue
        }
        if (EXAMPLE_CLOSE.test(line)) {
            out.push(closeSection(style.delimiters, "example"))
            continue
        }

        if (RULES_OPEN.test(line)) {
            out.push(openRules(style))
            const framing = RULE_FRAMING[style.intensity]
            if (framing !== undefined) out.push(framing)
            continue
        }
        if (RULES_CLOSE.test(line)) {
            out.push(closeSection(style.delimiters, "rules"))
            continue
        }

        const heading = HEADING.exec(line)
        if (heading !== null && style.delimiters === "plain") {
            // The text survives; only the marker goes. A heading carries meaning an author put
            // there, and deleting the line would delete a section label the file's prose refers to.
            out.push(heading[2] ?? "")
            continue
        }

        out.push(line)
    }

    // Rendering can leave a blank line where a closing tag was. Collapse, then trim, so two
    // different `delimiters` values do not differ only in trailing whitespace.
    return out
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

function openExample(delimiters: PromptStyle["delimiters"], index: number): string {
    if (delimiters === "xml") return "<example>"
    if (delimiters === "markdown") return `#### Example ${index}`
    return `Example ${index}:`
}

function openRules(style: PromptStyle): string {
    if (style.delimiters === "xml") return "<rules>"
    if (style.delimiters === "markdown") return "#### Rules"
    return "Rules:"
}

/** Only XML has a closing form. The others are a label, and a label does not close. */
function closeSection(delimiters: PromptStyle["delimiters"], tag: "example" | "rules"): string {
    return delimiters === "xml" ? `</${tag}>` : ""
}
