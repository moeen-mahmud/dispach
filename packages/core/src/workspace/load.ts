/**
 * The tiered workspace loader. Governed by docs/07-SPEC-WORKSPACE.md.
 *
 * Three tiers, and the tier decides prompt position:
 *
 *   static    slot 0   before cache breakpoint A   read-only
 *   volatile  slot 3   after cache breakpoint A    writable
 *   reminder  slot 9   after the conversation history, before the current input
 *
 * The positions are the reason the tiers exist, and none of the three is expressible by reordering
 * a flat array. `static` and the tool catalogue form the cached prefix, so anything in it that
 * changes between turns silently stops prompt caching working. `volatile` opens the uncached region,
 * which is why `MEMORY.md` lives there: every write changes it. `reminder` sits at the recency
 * position because rule adherence decays across a conversation and attention is stronger at both
 * ends of a context than in the middle — a rule stated once at the top of a thirty-turn session is
 * effectively in the middle.
 *
 * Everything here is synchronous and filesystem-only. It runs inside boot, where hard rule 4 puts
 * the network entirely out of reach.
 */

import { readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, resolve } from "node:path"
import { estimateTokens } from "../context/tokens.ts"
import {
    type ConfigError,
    type ErrorDetail,
    workspaceAliasConflict,
    workspaceBudgetExceeded,
    workspaceFileMissing,
    workspaceNotWritableTier,
    workspaceRuleBudget,
    workspaceTierMismatch,
} from "../errors.ts"
import {
    DEFAULT_PROMPT_STYLE,
    extractExamples,
    type PromptStyle,
    renderPromptStyle,
} from "../model/prompt-style.ts"
import type { WorkspaceWriteTarget } from "../tools/types.ts"
import type { Editable, Eviction, Tier } from "./frontmatter.ts"
import { parseWorkspaceFile } from "./frontmatter.ts"
import { checkRules, rulesBlocksOnly } from "./rules.ts"

export type { Editable, Eviction, Tier } from "./frontmatter.ts"

export interface WorkspaceBudgets {
    readonly static: number
    readonly volatile: number
    readonly reminder: number
    readonly total: number
}

export interface WorkspaceFileRef {
    /** As written in the manifest, for errors the author can act on. */
    readonly name: string
    /** Absolute, already resolved against the workspace directory. */
    readonly path: string
    readonly tier: Tier
    /** Which manifest field listed it, for the error path. */
    readonly field: string
}

export interface WorkspaceFile extends WorkspaceFileRef {
    readonly editable: Editable
    readonly eviction: Eviction
    /** Effective cap: the file's own frontmatter, else the tier's budget. */
    readonly budget: number
    /** Stripped of frontmatter and comments, then rendered for the model. What it actually sees. */
    readonly content: string
    /**
     * Stripped but **not** rendered — the author's own form, `<example>` markers intact.
     *
     * Kept because the rule count reads it. Counting the rendered form was a real bug: the renderer
     * turns `<example>` into a heading under `delimiters: markdown`, `countRules` excludes examples
     * by looking for those markers, and so every imperative inside a worked example started counting
     * as a rule the moment rendering landed — a shipped example went from 1 rule to 4 with no edit
     * to the file. The exclusion is a property of the authored form, so it has to read the authored
     * form.
     */
    readonly authored: string
    /**
     * The file's example blocks, rendered, when the style asked for them in a user message.
     *
     * Empty under `examplesIn: system`, where the blocks stay embedded in `content` exactly as
     * authored. Extraction is a move, never a rewrite — `content` plus `examples` carries every
     * authored sentence either way, and `tokens` counts both because both are billed every turn
     * whichever message they travel in.
     */
    readonly examples: string
    readonly tokens: number
}

export interface Workspace {
    readonly files: readonly WorkspaceFile[]
    /** Slot 0. Byte-stable for the lifetime of the agent. */
    readonly static: string
    /**
     * Slot 2: extracted example blocks, delivered as a user message under `examplesIn: user`.
     *
     * Empty under `examplesIn: system`. Placed *before* the volatile tier because it is byte-stable
     * and prefix caching is contiguous — after `volatile` it would fall out of the cacheable region
     * on every memory write despite never changing.
     */
    readonly examples: string
    /** Slot 3. Re-read on demand; changing it must not disturb slots 0 and 1. */
    readonly volatile: string
    /** Slot 9. */
    readonly reminder: string
    readonly tokens: {
        readonly static: number
        readonly volatile: number
        readonly reminder: number
        readonly total: number
    }
}

export const DEFAULT_WORKSPACE_BUDGETS: WorkspaceBudgets = {
    static: 2000,
    volatile: 3500,
    reminder: 500,
    total: 6000,
}

export interface LoadWorkspaceOptions {
    readonly refs: readonly WorkspaceFileRef[]
    readonly budgets?: WorkspaceBudgets
    /**
     * How the authored text is rendered for the model in front of it.
     *
     * Applied before tokens are counted, because the rendered form is what gets billed. Counting
     * the authored form would let a file pass its budget and then exceed it on the wire, which is
     * the same class of invisible failure the budgets exist to prevent.
     */
    readonly style?: PromptStyle
}

/**
 * Read, strip, budget, and concatenate.
 *
 * The order matters: budgets are checked against the *stripped* text, because stripped text is what
 * the model is billed for. Checking the raw file would charge the author for their own comments and
 * make the templates' inline documentation expensive to write.
 */
export function loadWorkspace(options: LoadWorkspaceOptions): Workspace {
    const budgets = options.budgets ?? DEFAULT_WORKSPACE_BUDGETS
    const style = options.style ?? DEFAULT_PROMPT_STYLE
    const files: WorkspaceFile[] = []

    for (const ref of options.refs) {
        files.push(readOne(ref, budgets, style))
    }

    for (const file of files) {
        if (file.tokens <= file.budget) continue
        throw workspaceBudgetExceeded({
            name: file.name,
            scope: "file",
            tier: file.tier,
            tokens: file.tokens,
            budget: file.budget,
            field: file.field,
        })
    }

    const byTier = (tier: Tier): readonly WorkspaceFile[] => files.filter((f) => f.tier === tier)
    const tokensOf = (tier: Tier): number =>
        byTier(tier).reduce((sum, file) => sum + file.tokens, 0)

    for (const tier of ["static", "volatile", "reminder"] as const) {
        const tokens = tokensOf(tier)
        if (tokens <= budgets[tier]) continue
        throw workspaceBudgetExceeded({
            name: largest(byTier(tier)),
            scope: "tier",
            tier,
            tokens,
            budget: budgets[tier],
            field: `context.budgets.${tier}`,
        })
    }

    const total = files.reduce((sum, file) => sum + file.tokens, 0)
    if (total > budgets.total) {
        throw workspaceBudgetExceeded({
            name: largest(files),
            scope: "total",
            tokens: total,
            budget: budgets.total,
            field: "context.budgets.total",
        })
    }

    // Each file is labelled with its name in the active delimiter style (pilot.15, VelaCrew). With the
    // contents joined bare, a model asked whether SOUL.md was loaded had no way to tie the text it was
    // reading to that name, answered that it was not, and re-read every file until `no_progress`.
    // A label is structure, never a rewrite of the author's prose.
    const join = (tier: Tier): string =>
        byTier(tier)
            .filter((file) => file.content !== "")
            .map((file) => labelled(basename(file.path), tier, file.content, style.delimiters))
            .join("\n\n")

    return {
        files,
        static: join("static"),
        examples: files
            .map((file) => file.examples)
            .filter((examples) => examples !== "")
            .join("\n\n"),
        volatile: join("volatile"),
        reminder: join("reminder"),
        tokens: {
            static: tokensOf("static"),
            volatile: tokensOf("volatile"),
            reminder: tokensOf("reminder"),
            total,
        },
    }
}

export interface RulesConfig {
    readonly perRuleSuccess: number
    readonly reliabilityTarget: number
    readonly onExceed: "fail" | "warn"
}

/**
 * The rule-budget verdict, as data rather than as a throw.
 *
 * Returned rather than thrown so that both callers can apply the same finding under their own
 * `onExceed`: `run` refuses, `validate` reports. That symmetry is the point — a validator that
 * accepts what the runtime refuses is worse than no validator, and the only reliable way to keep
 * the two honest is for them to share the check rather than to each implement it.
 *
 * Counted across `static` and `reminder` together, because the model does not know they came from
 * different files. `volatile` is excluded: it holds facts about the person, not obligations.
 */
export function ruleBudgetFailure(
    workspace: Workspace,
    rules: RulesConfig,
): ConfigError | undefined {
    const parts = workspace.files
        .filter((file) => file.tier === "static" || file.tier === "reminder")
        // The full soul document is exempt from the prose heuristic: it ships only to a model its
        // author declared capable of deriving rules from explanation, and counting a constitution's
        // sentences as rules would fail every soul-bearing manifest. Its <rules> blocks still count
        // — they survive distillation and hold everywhere. The distilled file counts in full, like
        // any static file: it ships to small models, where the budget is the point.
        .map((file) => ({
            name: file.name,
            text:
                file.field === "context.soul.file" ? rulesBlocksOnly(file.authored) : file.authored,
        }))
    const check = checkRules(parts.map((part) => part.text).join("\n"), rules)
    if (check.withinBudget) return undefined
    // Counted over the joined text, as it always was, so no agent's verdict changes; each line is
    // then attributed to the file it sits in. Without the file, "I never…" names a line somebody
    // has to grep five files for (VelaCrew, pilot.4).
    const starts: { readonly name: string; readonly from: number }[] = []
    let from = 1
    for (const part of parts) {
        starts.push({ name: part.name, from })
        from += part.text.split("\n").length
    }
    const fileOf = (line: number) => starts.findLast((start) => start.from <= line)?.name ?? "?"
    return workspaceRuleBudget({
        counted: check.counted.length,
        allowed: check.allowed,
        perRuleSuccess: rules.perRuleSuccess,
        reliabilityTarget: rules.reliabilityTarget,
        lines: check.counted.map((rule) => `${fileOf(rule.line)}: ${rule.text.trim()}`),
    })
}

/**
 * Where `memory_write` should land, given this workspace.
 *
 * The first volatile file wins, in declared order — an explicit order the author already wrote,
 * rather than a filename convention the loader would have to know about. A workspace whose volatile
 * files are all `editable: none` returns a refusal rather than `undefined`, because "you configured
 * a memory file and made it read-only" and "you configured no memory file" call for different
 * things being said to the model.
 */
export function writeTarget(workspace: Workspace): WorkspaceWriteTarget | undefined {
    const volatiles = workspace.files.filter((file) => file.tier === "volatile")
    if (volatiles.length === 0) return undefined

    const canWrite = (file: { readonly editable: string }): boolean =>
        file.editable === "append" || file.editable === "replace"

    // `eviction: oldest` wins over declared order, and that is the author naming the target rather than
    // the loader guessing. The generated workspace lists `USER.md` before `MEMORY.md` and makes both
    // writable, so plain declared order sent every saved note into the hand-written file describing the
    // person — which then grew until it busted its own budget and the agent refused to boot, while the
    // file that exists for notes and declares how to trim them was never touched. A declaration that
    // says "this file accumulates notes and may be trimmed" is exactly the statement a write target
    // needs, and it costs no new field.
    const writable =
        volatiles.find((file) => canWrite(file) && file.eviction === "oldest") ??
        volatiles.find(canWrite)
    if (writable !== undefined) {
        return {
            path: writable.path,
            name: writable.name,
            mode: writable.editable === "replace" ? "replace" : "append",
            budget: writable.budget,
            eviction: writable.eviction,
        }
    }

    const first = volatiles[0]
    if (first === undefined) return undefined
    return { name: first.name, mode: "refused", reason: first.editable }
}

/** An agent with no workspace configured. Distinct from one whose workspace loaded empty. */
export function emptyWorkspace(): Workspace {
    return {
        files: [],
        static: "",
        examples: "",
        volatile: "",
        reminder: "",
        tokens: { static: 0, volatile: 0, reminder: 0, total: 0 },
    }
}

/**
 * Resolve declared names into refs.
 *
 * `base` is the workspace directory for tier lists and the manifest directory for the deprecated
 * `context.files` alias. Keeping the distinction here rather than in the caller is what lets the
 * alias keep its original resolution semantics: a manifest that worked before Phase 3.5 resolves the
 * same paths after it, which is the whole promise of an alias.
 */
export function workspaceRefs(init: {
    base: string
    names: readonly string[]
    tier: Tier
    field: string
}): WorkspaceFileRef[] {
    return init.names.map((name, index) => ({
        name,
        path: isAbsolute(name) ? name : resolve(init.base, name),
        tier: init.tier,
        field: `${init.field}[${index}]`,
    }))
}

export interface WorkspacePlan {
    readonly refs: readonly WorkspaceFileRef[]
    /** Non-fatal, surfaced as `agent.warning`. Currently only the `context.files` deprecation. */
    readonly warnings: readonly ErrorDetail[]
}

/**
 * Turn a manifest's context section into refs, honouring the `context.files` alias.
 *
 * Naming both `files` and `static` is a load failure rather than a merge. The two resolve against
 * different directories, so merging them would produce an ordering nobody wrote and a set of paths
 * nobody can predict from reading the manifest.
 */
export function planWorkspace(context: WorkspaceContextConfig, dir: string): WorkspacePlan {
    const legacy = context.files ?? []
    const declared = context.static ?? []

    if (legacy.length > 0 && declared.length > 0) {
        throw workspaceAliasConflict()
    }

    const workspaceDir = isAbsolute(context.workspace)
        ? context.workspace
        : resolve(dir, context.workspace)

    const refs: WorkspaceFileRef[] = []
    const warnings: ErrorDetail[] = []

    if (legacy.length > 0) {
        // Manifest-relative, as it always was. See the field's comment in schema.ts.
        refs.push(
            ...workspaceRefs({ base: dir, names: legacy, tier: "static", field: "context.files" }),
        )
        warnings.push({
            code: "context_files_deprecated",
            message: `context.files is deprecated; its ${legacy.length} file(s) were loaded as the static tier.`,
            hint: "Move them to context.static and set context.workspace to the directory holding them. The tier lists say which files are cache-stable, which the agent may write to, and which sit after the conversation history — none of which an ordered array can express.",
            field: "context.files",
        })
    }

    refs.push(
        ...workspaceRefs({
            base: workspaceDir,
            names: declared,
            tier: "static",
            field: "context.static",
        }),
    )
    refs.push(
        ...workspaceRefs({
            base: workspaceDir,
            names: context.volatile ?? [],
            tier: "volatile",
            field: "context.volatile",
        }),
    )
    if (context.reminder !== undefined) {
        refs.push(
            ...workspaceRefs({
                base: workspaceDir,
                names: [context.reminder],
                tier: "reminder",
                field: "context.reminder",
            }),
        )
    }

    return { refs, warnings }
}

/** The slice of `context` this module reads. Narrowed so tests need not build a whole manifest. */
export interface WorkspaceContextConfig {
    readonly files?: readonly string[]
    readonly workspace: string
    readonly static?: readonly string[]
    readonly volatile?: readonly string[]
    readonly reminder?: string | undefined
}

function readOne(
    ref: WorkspaceFileRef,
    budgets: WorkspaceBudgets,
    style: PromptStyle,
): WorkspaceFile {
    let raw: string
    try {
        const stat = statSync(ref.path)
        if (stat.isDirectory()) throw new Error("is a directory")
        raw = readFileSync(ref.path, "utf8")
    } catch {
        throw workspaceFileMissing(ref.name, ref.path, ref.field)
    }

    const { frontmatter, body } = parseWorkspaceFile(ref.name, raw)

    // A file that names its own tier and is listed under another is refused rather than resolved in
    // either direction. Silently trusting the list would move a writable file ahead of the cache
    // breakpoint; silently trusting the frontmatter would move a file out of the position its author
    // chose in the manifest. Both are wrong in ways nothing reports.
    if (frontmatter.tier !== undefined && frontmatter.tier !== ref.tier) {
        throw workspaceTierMismatch(ref.name, frontmatter.tier, ref.tier)
    }

    // `static` and `reminder` are read-only by definition of their position: they sit inside the
    // cached prefix, or are re-asserted verbatim after the history. A writable file in either place
    // defeats the reason it is there — a static file that changes invalidates the cached prefix on
    // every write, with no error and no symptom beyond the bill. So a frontmatter asking for it is
    // refused rather than quietly downgraded to read-only.
    if (
        ref.tier !== "volatile" &&
        frontmatter.editable !== undefined &&
        frontmatter.editable !== "none"
    ) {
        throw workspaceNotWritableTier(ref.name, ref.tier, frontmatter.editable)
    }

    // Under `examplesIn: user`, static-tier example blocks move out of the system prefix into a
    // user message. Extraction happens on the authored form so the blocks render through the same
    // path they would have rendered through in place — a move, never a rewrite. Only the static
    // tier: examples live in identity files, and a `volatile` or `reminder` file has no business
    // carrying worked dialogues.
    const extracted =
        style.examplesIn === "user" && ref.tier === "static"
            ? extractExamples(body)
            : { body, examples: "" }

    // Rendered here rather than at assembly for the same reason the catalogue is rendered at load:
    // slot 0 is half of the cache-stable prefix, and a per-turn transformation of it — however
    // deterministic — is one refactor away from varying.
    const content = renderPromptStyle(extracted.body, style)
    const examples = renderPromptStyle(extracted.examples, style)

    return {
        ...ref,
        authored: body,
        editable: ref.tier === "volatile" ? (frontmatter.editable ?? "append") : "none",
        eviction: frontmatter.eviction ?? "none",
        budget: frontmatter.budget ?? budgets[ref.tier],
        content,
        examples,
        // Both halves are billed every turn whichever message they travel in, so the budget sees
        // both — moving examples must not make a file look cheaper than it is.
        tokens: estimateTokens(content) + (examples === "" ? 0 : estimateTokens(examples)),
    }
}

function largest(files: readonly WorkspaceFile[]): string {
    let biggest: WorkspaceFile | undefined
    for (const file of files) {
        if (biggest === undefined || file.tokens > biggest.tokens) biggest = file
    }
    return biggest?.name ?? "(none)"
}

/** One workspace file's text under its own name, in the delimiter style the model is rendered for. */
export function labelled(
    name: string,
    tier: Tier,
    content: string,
    delimiters: PromptStyle["delimiters"],
): string {
    if (delimiters === "xml") return `<file name="${name}" tier="${tier}">\n${content}\n</file>`
    if (delimiters === "markdown") return `## ${name}\n\n${content}`
    return `${name}:\n${content}`
}
