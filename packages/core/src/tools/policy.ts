/**
 * The tool policy: which calls run, which ask, and which are refused.
 *
 * Pure, and deliberately so. Deciding is a function of (config, call); asking a person is a
 * question about the front end. Keeping the decision here means the CLI, the server, and a
 * scheduled run cannot answer it differently — and it means the whole thing is testable without a
 * terminal.
 *
 * ## Why this is `tools.policy` and not `tools.permissions`
 *
 * `permissions` already names the plugin manifest's block, which is advisory, recorded, and
 * deliberately **unenforced**. Giving an enforced security control the same word as the project's
 * one famously unenforced block is the worst available name.
 *
 * ## What a rule can and cannot do
 *
 * `Tool` or `Tool(pattern)`. Evaluation order is **deny → ask → allow, first match wins**, and rule
 * specificity does not reorder it — so a deny rule cannot carry allowlist exceptions, and a broad
 * `deny` beats a narrow `allow` every time. Anything less predictable becomes a rule nobody can
 * reason about at the moment they most need to.
 *
 * A pattern matches against the **match string** the tool supplies: the command for a shell tool,
 * the path for a file tool. A rule naming a *primary content field* — `exec(command:rm *)` — is
 * refused with a warning rather than honoured, because a compound command defeats it, and a rule
 * that can be defeated is worse than no rule: it reads as protection.
 *
 * ## The parts that hold when everything else is misconfigured
 *
 * - **The hardline floor.** A handful of commands are refused regardless of mode, allow rules, or
 *   any future bypass flag. A floor that can be lowered is not a floor.
 * - **Fail closed.** A command that cannot be parsed, or one long enough that parsing it is
 *   meaningless, asks rather than allows.
 * - **Compound commands are matched per subcommand.** `git status && rm -rf ~` must not slip
 *   through on the strength of its first half.
 *
 * ## What this does not do, stated plainly
 *
 * Rules that constrain shell *arguments* are fragile, and pretending otherwise would be the
 * dangerous kind of comfort. `exec(curl https://github.com/*)` does not survive a flag before the
 * URL, a different protocol, a redirect, or `U=https://evil.example && curl $U`. Structured tools —
 * a `path` field a rule can match exactly — are the layer where policy actually works; the shell
 * layer is best-effort, and an OS sandbox is the only complete answer. Encoded here as a limit
 * rather than discovered later.
 */

import type { OnMutate } from "./trust.ts"

/** What happens to calls no rule mentions. */
export type PolicyMode = "ask" | "allow" | "deny"

/** What the engine decided. `ask` needs an approver; with none, `onNoApprover` settles it. */
export type PolicyEffect = "allow" | "ask" | "deny"

export interface PolicyConfig {
    readonly mode: PolicyMode
    readonly allow: readonly string[]
    readonly deny: readonly string[]
    /** What `ask` means when nothing can reach a person — an unattended run, a schedule, a pipe. */
    readonly onNoApprover: "deny" | "allow"
}

/**
 * The default, and why it is `allow` rather than `ask`.
 *
 * **Pinning is the primary authorization here.** Unlike a coding agent that starts with a shell and
 * the whole filesystem, a dispach agent has exactly the tools its manifest pinned — an author who
 * wrote `tools.local: [now, memory_write]` has already said what this agent may do. Defaulting to
 * `ask` would re-ask that question on every call, and since most runs are unattended (a schedule, a
 * channel, a pipe) `onNoApprover` would then answer it `deny` and the agent would do nothing at all.
 *
 * So the policy is a *second* layer, for tools too broad to authorize wholesale — `exec` above all.
 * A manifest that pins one narrows it with `deny` rules or flips `mode` outright.
 *
 * The trust gate is unaffected either way: a tainted mutating call still needs a matching `allow`
 * rule or a live approval, and `mode: allow` is the absence of a rule rather than one.
 */
export const DEFAULT_POLICY: PolicyConfig = {
    mode: "allow",
    allow: [],
    deny: [],
    onNoApprover: "deny",
}

export interface PolicyQuery {
    readonly slug: string
    /**
     * What a pattern matches against. The command for a shell tool, the path for a file tool.
     * Absent means the tool offers nothing to match, so only a bare `Tool` rule can name it.
     */
    readonly match?: string
}

export interface PolicyDecision {
    readonly effect: PolicyEffect
    /** Why, in a line a person can act on. Surfaced in the refusal and in the approval prompt. */
    readonly reason: string
    /** The rule that decided, when a rule did. Absent when the mode decided. */
    readonly rule?: string
}

/** A parsed rule. `pattern` absent means the bare form, which matches every call to that tool. */
interface Rule {
    readonly source: string
    readonly slug: string
    readonly pattern?: string
}

// ─── the hardline floor ──────────────────────────────────────────────────────────────────

/**
 * Refused regardless of mode, of any allow rule, and of any future bypass flag.
 *
 * Short on purpose. Every entry is a command whose *intent* is unambiguous and whose cost is
 * unrecoverable — not a list of things that are merely risky, which is what `deny` rules are for.
 * A floor that grows into a general blocklist becomes one people turn off.
 */
const HARDLINE: readonly { readonly pattern: RegExp; readonly what: string }[] = [
    {
        pattern: /\brm\s+(?:-[\w-]+\s+)*-[\w]*[rR][\w]*f|\brm\s+(?:-[\w-]+\s+)*-[\w]*f[\w]*[rR]/i,
        what: "a recursive forced delete",
    },
    { pattern: /--no-preserve-root/i, what: "a delete that disables the root guard" },
    { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, what: "a fork bomb" },
    { pattern: /\bmkfs(\.\w+)?\b/i, what: "a filesystem format" },
    { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, what: "a raw write to a block device" },
]

/** Only the truly unrecoverable half of a recursive delete: one aimed at `/` or `~`. */
const HARDLINE_TARGET = /\s(?:\/|~|\$HOME|\/\*|~\/\*)\s*$/

function hardlineFailure(command: string): string | undefined {
    for (const entry of HARDLINE) {
        if (!entry.pattern.test(command)) continue
        // A recursive delete of a project directory is ordinary work; one aimed at the filesystem
        // root or the home directory is not. Only the second is floor material — the first is what
        // `deny` rules and approval are for.
        if (entry.what.includes("recursive") && !HARDLINE_TARGET.test(command)) continue
        return entry.what
    }
    return undefined
}

// ─── parsing ─────────────────────────────────────────────────────────────────────────────

const RULE = /^([A-Za-z_][\w-]*)(?:\((.*)\)\s*)?$/

/**
 * Fields whose value is the whole point of the call, and which a rule therefore may not address
 * by name. `exec(command:rm *)` looks like a constraint and is defeated by `ls && rm -rf ~`.
 */
const CONTENT_FIELDS = new Set(["command", "path", "file_path", "url", "content"])

export interface ParsedPolicy {
    readonly deny: readonly Rule[]
    readonly ask: readonly Rule[]
    readonly allow: readonly Rule[]
    /** Rules that were refused, each with the reason. Surfaced at load, never silently dropped. */
    readonly rejected: readonly { readonly source: string; readonly why: string }[]
}

function parseRule(source: string): { rule?: Rule; why?: string } {
    const trimmed = source.trim()
    const match = RULE.exec(trimmed)
    if (match === null) {
        return { why: "it is not of the form Tool or Tool(pattern)" }
    }
    const slug = match[1] ?? ""
    const pattern = match[2]

    if (pattern !== undefined) {
        const field = /^([A-Za-z_]\w*)\s*:/.exec(pattern)?.[1]
        if (field !== undefined && CONTENT_FIELDS.has(field)) {
            return {
                why: `it addresses "${field}", which carries the whole call — a compound command or a renamed path defeats such a rule, so it would read as protection without being any`,
            }
        }
        return { rule: { source: trimmed, slug, pattern: pattern.trim() } }
    }
    return { rule: { source: trimmed, slug } }
}

export function parsePolicy(config: PolicyConfig): ParsedPolicy {
    const rejected: { source: string; why: string }[] = []
    const take = (sources: readonly string[]): Rule[] => {
        const kept: Rule[] = []
        for (const source of sources) {
            const { rule, why } = parseRule(source)
            if (rule !== undefined) kept.push(rule)
            else rejected.push({ source, why: why ?? "it could not be read" })
        }
        return kept
    }

    return { deny: take(config.deny), ask: [], allow: take(config.allow), rejected }
}

// ─── matching ────────────────────────────────────────────────────────────────────────────

/**
 * `*` matches any run of characters. `:*` at the very end is the same as ` *`, which is the form
 * Claude Code popularised; anywhere else the colon is a literal, because `git:* push` means nothing.
 */
function patternToRegex(pattern: string): RegExp {
    const trailing = pattern.endsWith(":*") ? `${pattern.slice(0, -2)} *` : pattern
    const escaped = trailing.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    // A pattern ending in ` *` should also match the bare command with no arguments at all.
    const body = escaped.replace(/\\?\*/g, ".*").replace(/ \.\*$/, "(?: .*)?")
    return new RegExp(`^${body}$`, "i")
}

/** Wrappers that do not change *what* runs, only how. Stripped before matching. */
const WRAPPERS =
    /^(?:timeout\s+\S+|time|nice(?:\s+-n\s+\S+)?|stdbuf(?:\s+-\S+)*|command|builtin)\s+/i

/**
 * Wrappers that DO change what runs, listed so nobody adds them to the set above by analogy.
 * `docker exec` runs elsewhere; `npx` fetches; `devbox run` enters another environment. Stripping
 * any of them would let `exec(docker *)` authorise a shell inside a container.
 */
export const NEVER_STRIPPED: readonly string[] = [
    "npx",
    "docker",
    "podman",
    "devbox",
    "mise",
    "uvx",
]

function stripWrappers(command: string): string {
    let current = command.trim()
    for (let i = 0; i < 4 && WRAPPERS.test(current); i += 1) {
        current = current.replace(WRAPPERS, "").trim()
    }
    return current
}

/** Above this, the parse is meaningless and the call asks instead. */
const MAX_MATCHABLE = 10_000

// No `\s*` either side: `stripWrappers` trims each part, and the padding made the split quadratic.
const SEPARATORS = /&&|\|\||;|\||&|\n/

/**
 * Split a shell string into the commands it actually runs.
 *
 * A rule must match every one of them: `git status && rm -rf ~` is not a `git status` call with a
 * footnote. Quoting is not honoured — a separator inside quotes splits too — which errs toward more
 * fragments and therefore toward asking, the safe direction.
 */
export function subcommands(command: string): readonly string[] {
    return command
        .split(SEPARATORS)
        .map((part) => stripWrappers(part))
        .filter((part) => part !== "")
}

function matches(rule: Rule, query: PolicyQuery, fragment: string | undefined): boolean {
    if (rule.slug.toLowerCase() !== query.slug.toLowerCase()) return false
    if (rule.pattern === undefined) return true
    if (fragment === undefined) return false
    return patternToRegex(rule.pattern).test(fragment)
}

/** A rule covers a call only when it covers every fragment of it. */
function covers(rule: Rule, query: PolicyQuery, fragments: readonly string[]): boolean {
    if (rule.pattern === undefined) return rule.slug.toLowerCase() === query.slug.toLowerCase()
    if (fragments.length === 0) return matches(rule, query, query.match)
    return fragments.every((fragment) => matches(rule, query, fragment))
}

/** True when any fragment matches — the right test for a rule that forbids. */
function touches(rule: Rule, query: PolicyQuery, fragments: readonly string[]): boolean {
    if (rule.pattern === undefined) return rule.slug.toLowerCase() === query.slug.toLowerCase()
    if (fragments.length === 0) return matches(rule, query, query.match)
    return fragments.some((fragment) => matches(rule, query, fragment))
}

// ─── the decision ────────────────────────────────────────────────────────────────────────

export function decidePolicy(config: PolicyConfig, query: PolicyQuery): PolicyDecision {
    const parsed = parsePolicy(config)
    const command = query.match

    if (command !== undefined) {
        const floor = hardlineFailure(command)
        if (floor !== undefined) {
            return {
                effect: "deny",
                reason: `${query.slug} was refused: this is ${floor}, which is never permitted — not by an allow rule, not by any mode.`,
            }
        }
        if (command.length > MAX_MATCHABLE) {
            return {
                effect: "ask",
                reason: `${query.slug} was too long to analyse (${command.length} characters), so it is being asked rather than matched.`,
            }
        }
    }

    const fragments = command === undefined ? [] : subcommands(command)

    // Deny first, and a deny that touches ANY fragment wins. Specificity never reorders this, so a
    // narrow allow cannot carve an exception out of a broad deny.
    for (const rule of parsed.deny) {
        if (touches(rule, query, fragments)) {
            return {
                effect: "deny",
                reason: `${query.slug} is denied by the rule ${rule.source}.`,
                rule: rule.source,
            }
        }
    }

    // An allow must cover EVERY fragment. Half an allowlisted compound is not allowlisted.
    for (const rule of parsed.allow) {
        if (covers(rule, query, fragments)) {
            return {
                effect: "allow",
                reason: `${query.slug} is allowed by the rule ${rule.source}.`,
                rule: rule.source,
            }
        }
    }

    switch (config.mode) {
        case "allow":
            return { effect: "allow", reason: `No rule matched, and tools.policy.mode is allow.` }
        case "deny":
            return { effect: "deny", reason: `No rule matched, and tools.policy.mode is deny.` }
        default:
            return {
                effect: "ask",
                reason: `No rule matched ${query.slug}, so it needs an answer from a person.`,
            }
    }
}

/**
 * Settle an `ask` when nothing can reach a person.
 *
 * Separate from `decidePolicy` because whether an approver exists is a fact about the front end,
 * not about the policy — and because a scheduled run answering this differently from a terminal is
 * the whole reason it is written down.
 */
export function resolveWithoutApprover(
    decision: PolicyDecision,
    config: PolicyConfig,
): PolicyDecision {
    if (decision.effect !== "ask") return decision
    if (config.onNoApprover === "allow") {
        return {
            ...decision,
            effect: "allow",
            reason: `${decision.reason} Nobody is available to ask, and tools.policy.onNoApprover is allow.`,
        }
    }
    return {
        ...decision,
        effect: "deny",
        reason: `${decision.reason} Nobody is available to ask — this run has no terminal — so it is refused. Add a tools.policy.allow rule for it, or set onNoApprover to allow.`,
    }
}

// ─── composing the policy with the trust gate ────────────────────────────────────────────

export interface AuthorizeInput {
    readonly policy: PolicyConfig
    readonly query: PolicyQuery
    readonly mutating: boolean
    /** Untrusted content has already entered this turn. */
    readonly tainted: boolean
    readonly onMutate: OnMutate
    /** Whether anything can actually reach a person right now. */
    readonly approver: boolean
}

export interface Authorization {
    readonly effect: PolicyEffect
    readonly reason: string
    readonly rule?: string
    /**
     * The **trust gate** stopped this, not a policy rule. The two are refused differently: a gated
     * call emits `tool.gated` and tells the model the rule is standing, because retrying is the
     * observed failure mode there.
     */
    readonly gated?: boolean
}

/**
 * The one place the write gate and the policy meet.
 *
 * Adding a shell tool breaks a naive gate, and the collision is worth naming: `exec` is `mutating`
 * *and* its output is `untrusted` — `curl` is the whole internet and `cat` reads whatever was
 * downloaded. Under a flat "a tainted turn refuses mutating calls" rule the first `exec` taints the
 * turn and every later one is refused, so the feature is dead on arrival.
 *
 * The resolution is not a weaker gate but a precise one. The gate exists because **the model** may
 * be talked into something by a stranger's text. It is not there to veto **the user**:
 *
 * > A tainted mutating call needs *explicit authorization* — a rule the user wrote, or an approval
 * > the user gave. It may not proceed on the model's say-so alone.
 *
 * So a matching `allow` rule satisfies it; `confirm` asks when someone is there; `refuse` never
 * asks, which is what makes it the right default for the unattended runs this runtime exists for.
 */
export function authorize(input: AuthorizeInput): Authorization {
    const decision = decidePolicy(input.policy, input.query)

    // A policy denial outranks everything: it is the user's own standing instruction, and the
    // hardline floor arrives through here too.
    if (decision.effect === "deny") return decision

    const needsAuthorization = input.tainted && input.mutating && input.onMutate !== "allow"

    // `decision.rule`, not `decision.effect`. A blanket `mode: allow` is the *absence* of a rule —
    // "do not ask me about tools" — and reading it as authorisation for a stranger's page to drive
    // a write would be the gate quietly turning itself off. `tools.untrusted.onMutate` is the knob
    // that says that on purpose.
    if (needsAuthorization && decision.rule === undefined) {
        // `confirm` may still ask — but only if there is somebody to ask.
        if (input.onMutate === "confirm" && input.approver) {
            return {
                effect: "ask",
                reason: `${input.query.slug} changes something, and untrusted content reached this turn — asking before it runs.`,
            }
        }
        return {
            effect: "deny",
            gated: true,
            reason: `${input.query.slug} was blocked: untrusted content entered this turn, and tools.untrusted.onMutate is "${input.onMutate}" with no rule or approval authorising it.`,
        }
    }

    if (decision.effect === "ask" && !input.approver) {
        return resolveWithoutApprover(decision, input.policy)
    }
    return decision
}

/**
 * Tools that this configuration allows exactly once per turn — reported at load, not discovered
 * mid-turn.
 *
 * A tool that is both `mutating` and `untrusted` taints the turn with its own first call, and every
 * later call to it then needs the explicit authorisation `authorize` demands. `exec` is the whole
 * class: its output is untrusted because `curl` is the internet, and it changes things because that
 * is what a shell is for. The gate is right to require a rule — but with none written, the second
 * `exec` of a turn is refused and the first is not, which reads as a bug in the runtime rather than
 * as the configuration it is.
 *
 * So it is said at load, where it can be fixed, rather than at the moment a half-finished turn stops.
 * A warning and not a failure: an agent that runs one command per turn and reports back is a
 * perfectly reasonable thing to want, and this cannot tell that apart from an oversight.
 *
 * Only bare-name rules count as cover. A narrow `exec(git *)` deliberately leaves everything outside
 * it gated, which is the configuration working as intended and not something to warn about — so the
 * check asks whether *some* rule could authorise a second call at all, not whether every call is
 * covered.
 */
export function onceOnlyTools(input: {
    readonly tools: readonly {
        readonly slug: string
        readonly mutating: boolean
        readonly trust?: string
    }[]
    readonly policy: PolicyConfig
    readonly onMutate: OnMutate
}): readonly string[] {
    if (input.onMutate === "allow") return []
    // `allow` only. A `deny` rule naming the tool authorises nothing — `authorize` requires a rule
    // that *permits*, and a deny rule that fails to match leaves the decision ruleless and therefore
    // gated. Counting one as cover would have silenced this warning for the configuration most likely
    // to need it: someone who thought about the shell hard enough to restrict it.
    const named = new Set(parsePolicy(input.policy).allow.map((rule) => rule.slug.toLowerCase()))
    return input.tools
        .filter(
            (tool) =>
                tool.mutating && tool.trust === "untrusted" && !named.has(tool.slug.toLowerCase()),
        )
        .map((tool) => tool.slug)
}
