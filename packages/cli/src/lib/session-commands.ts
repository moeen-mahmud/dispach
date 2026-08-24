/**
 * What you can type at a running prompt, as data.
 *
 * The outer CLI's help is generated from `COMMANDS`, so a flag the parser honours cannot be missing
 * from `--help`. The in-session help had no such link: it was a string in a component, and the two
 * drifted in both directions — `/help` was advertised by the banner and unhandled on the plain path,
 * where it was sent to the model as a prompt, while five working key chords went undocumented.
 *
 * So the same discipline applies here. One table drives dispatch *and* the help text, which closes
 * the drift for commands. Key bindings cannot be generated the same way, because they live in a
 * function rather than a table — `keyToIntent` decides what `^C` means from whether a turn is in
 * flight. The loop is closed by tests instead: every documented chord is walked through the real
 * `keyToIntent`, and every chord it honours is required to appear here.
 *
 * Pure, and free of Ink: both renderers dispatch through this, which is what keeps `--plain` and the
 * rich path from answering the same keystroke differently.
 */

import { nearest } from "@dispach/core"

export type SessionCommandKind = "help" | "status" | "restart" | "tools" | "reset" | "exit"

export interface SessionCommandSpec {
    readonly kind: SessionCommandKind
    readonly word: string
    /** Accepted and not advertised individually; they appear beside the canonical word. */
    readonly aliases: readonly string[]
    readonly summary: string
}

export const SESSION_COMMANDS: readonly SessionCommandSpec[] = [
    { kind: "help", word: "/help", aliases: [], summary: "this list" },
    {
        // The human twin of context slot 2. Until this existed, the *model* was told its model,
        // window, channels, server and permissions on every turn — and the person at the prompt
        // had no way to see any of it. An agent that knows more about the runtime than its operator
        // does is the same asymmetry, pointed the other way, that slot 2 was added to fix.
        kind: "status",
        word: "/status",
        aliases: [],
        summary: "model, channels, server, store — what this agent is and what is actually running",
    },
    {
        kind: "restart",
        word: "/restart",
        aliases: [],
        summary:
            "restart the agent, for any configuration changes to take effect (memory files on disk are untouched)",
    },
    {
        kind: "tools",
        word: "/tools",
        aliases: [],
        summary: "what the model may call, and what the catalogue costs every turn",
    },
    {
        kind: "reset",
        word: "/reset",
        aliases: [],
        summary: "clear this session's history — memory files on disk are untouched",
    },
    {
        kind: "exit",
        word: "/exit",
        aliases: ["/quit", ":q"],
        // Says that it asks, because it does. The session takes the whole terminal and its buffer is
        // discarded on the way out, so leaving is not a keystroke to make by accident — the same reasoning
        // that made ^C take two presses.
        summary: "leave — asks first, because the screen goes with it",
    },
]

export interface KeyBindingSpec {
    /** As shown to a reader. Ctrl chords are written `^X`, and the drift test reads them back out. */
    readonly chord: string
    readonly summary: string
}

/**
 * How to put a line break in a message, as one line of hint text.
 *
 * ⌥⏎ leads because it is the chord that works everywhere: it arrives as ESC then carriage return, which
 * is a sequence every terminal can send and Ink already parses. The backslash is the fallback for anyone
 * whose Option key is bound to something else.
 *
 * Shift+⏎ is deliberately absent. It requires the terminal to send a distinguishable sequence — kitty's
 * `CSI 13;2u`, which `terminal-setup` installs for the terminals that can be taught — and whether it
 * reaches this process cannot be detected from inside it. A hint naming a chord that silently *sends*
 * the message instead is worse than one naming only what always works.
 */
export const NEWLINE_HINT = "⌥⏎ or a trailing \\ for a new line · ⏎ sends"

/**
 * The one line of guidance a brand-new conversation carries.
 *
 * Everything on it is true of this runtime, which is the whole reason it is written here rather than
 * copied from a screenshot of another tool: `/` really does open the palette, and `^C` really does take
 * two presses. A hint naming a chord that does something else — or nothing — is worse than no hint, and
 * this is the one screen where a person has no conversation to learn the keys from.
 */
export const NEW_SESSION_HINT = "/ commands · ⏎ sends · ⇧⏎ new line · ^C twice leaves"

export const KEY_BINDINGS: readonly KeyBindingSpec[] = [
    {
        chord: "^C",
        summary:
            "cancel the turn in flight — at an idle prompt, press it twice to leave (the screen goes with it)",
    },
    { chord: "^D", summary: "leave when the line is empty; delete forward when it is not" },
    { chord: "^A / ^E", summary: "start of line / end of line" },
    { chord: "^B / ^F", summary: "back one character / forward one" },
    { chord: "^U / ^K", summary: "delete to the start of the line / to the end" },
    { chord: "^W", summary: "delete the word before the cursor" },
    { chord: "^P / ^N", summary: "previous / next of what you have already sent" },
    {
        chord: "↑ / ↓",
        summary:
            "a line up or down inside the message — the same history at its first and last line",
    },
    {
        // Both, and the qualification belongs here rather than in the composer hint. ⌥⏎ arrives as `ESC`
        // then carriage return and works in every terminal; ⇧⏎ needs one that can distinguish it, which
        // the kitty keyboard protocol delivers where it negotiates — and where it does not, ⇧⏎ *is* ⏎ and
        // silently sends the message. A permanently-visible hint cannot carry that condition; this line
        // can, which is the split `Prompt.tsx` documents.
        chord: "⌥⏎ / ⇧⏎",
        summary:
            "a new line in the message — ⌥⏎ everywhere, ⇧⏎ where the terminal can tell it apart (`keys` says); a trailing \\ does the same; ⏎ sends it",
    },
    { chord: "⌥← / ⌥→", summary: "back one word / forward one — ^← / ^→ do the same" },
    { chord: "⌥⌫ / ⌥d", summary: "delete the word before the cursor / after it" },
    { chord: "Home / End", summary: "start of line / end of line, the same as ^A / ^E" },
    {
        // Cmd chords need the kitty keyboard protocol, which is negotiated at mount and simply does not
        // arrive on a terminal that declines it — so this row names the readline equivalent alongside,
        // rather than describing a chord that silently does nothing on half the terminals in use.
        chord: "cmd← / cmd→",
        summary: "start of line / end of line, where the terminal reports cmd (else ^A / ^E)",
    },
    {
        chord: "cmd↑ / cmd↓",
        summary: "the start / end of the whole message, however many lines it has",
    },
    { chord: "cmd⌫ / cmd⌦", summary: "delete to the start of the line / to the end" },
    { chord: "cmdz / cmd⇧z", summary: "undo / redo, the same as ^Z / ^Y" },
    {
        // One row for the whole family, because the rule is one sentence: shift turns any motion above
        // into a selection. Listing ten shifted chords separately would be ten rows saying that once each.
        chord: "⇧ + any motion",
        summary:
            "select as the cursor moves — ⇧← a character, ⇧⌥← a word, ⇧cmd← to the line start, ⇧cmd↑ to the top; typing or ⌫ replaces what is selected",
    },
    { chord: "cmda", summary: "select the whole message" },
    {
        chord: "^R",
        summary: "search what you have already sent — ↑↓ to pick, ⏎ to use it, esc to cancel",
    },
    {
        // Not SIGTSTP: Ink puts stdin in raw mode, so the terminal never generates the signal. Suspend
        // is genuinely gone here, which is why it is written down rather than left to be discovered.
        chord: "^Z / ^Y",
        summary: "undo / redo the last edit — suspend is not available inside a session",
    },
    {
        // Deliberately not ^U/^D, which would be the shell habit: both are already taken above, both are
        // documented, and a scroll key that silently deleted half a message is the worse bug by far.
        chord: "PgUp / PgDn",
        summary: "back and forward through the conversation a screen at a time",
    },
    { chord: "⌥↑ / ⌥↓", summary: "the same, one row at a time" },
    { chord: "⌥PgUp / ⌥PgDn", summary: "the start of the conversation / back to the newest reply" },
    {
        chord: "^O / ⌥r",
        summary:
            "show the model's reasoning whole — folded to a few rows so the reply stays findable; ^O works on every terminal, ⌥r needs one that reports it",
    },
    { chord: "esc", summary: "return to the newest reply when you have scrolled away" },
]

/**
 * Every Ctrl letter the table documents, read back out of the chord strings rather than listed
 * again — a second list is one more thing that can disagree with the first. The drift test walks
 * these through `keyToIntent` and requires every letter it honours to appear here.
 */
export const DOCUMENTED_CTRL_LETTERS: readonly string[] = KEY_BINDINGS.flatMap((spec) =>
    [...spec.chord.matchAll(/\^([A-Za-z])/g)].map((match) => (match[1] ?? "").toLowerCase()),
)

/**
 * Every option-letter chord the table documents, read back the same way.
 *
 * The ctrl list above has had a two-way drift test since Phase 2 and the option chords never did — so
 * `⌥r` was documented, bound, handled, and reaching nothing, with no test anywhere able to say so. The
 * asymmetry was not a decision: `^` is one character to match and `⌥` is one the regex simply never
 * learned about.
 */
export const DOCUMENTED_META_LETTERS: readonly string[] = KEY_BINDINGS.flatMap((spec) =>
    // A *lowercase* letter that no other letter follows, which is narrower than the ctrl regex for two
    // reasons the first version of this got wrong. `⌥PgUp` starts with a capital and is a key name, so
    // a `[A-Za-z]` class extracted a phantom `⌥p` and the test failed against a chord that does not
    // exist. And a letter chord is always one letter here, so requiring nothing after it keeps a future
    // `⌥Home` out of the list too.
    [...spec.chord.matchAll(/⌥([a-z])(?![A-Za-z])/g)].map((match) => match[1] ?? ""),
)

/**
 * Letters a terminal sends *as* an option chord without anybody pressing them.
 *
 * `⌥←` reaches us as `ESC b` from Apple Terminal and as `CSI 1;3D` from iTerm2, so `keyToIntent` honours
 * `meta` plus the letter `b` — and that is an encoding, not a binding. Documenting `⌥b` would advertise a
 * chord nobody uses to mean a thing they already have an arrow key for. Listed here rather than dropped
 * from the check, so the exemption is a decision with a reason on it instead of a hole in the test.
 */
export const META_LETTERS_THAT_ARE_ARROWS: readonly string[] = ["b", "f"]

export type SessionCommand =
    | { readonly kind: SessionCommandKind; readonly rest?: string }
    /**
     * A slash command this table does not own — a CLI command, offered in a session.
     *
     * Resolved here rather than in the renderer so both paths agree about what a typed line means, and
     * carried with its arguments intact for whichever host runs it.
     */
    | { readonly kind: "command"; readonly name: string; readonly rest: string }
    /** Looked like a command and was not one. Refused rather than billed as a prompt. */
    | { readonly kind: "unknown"; readonly word: string; readonly nearest?: string }

/**
 * One word starting with a slash, and nothing else on the line.
 *
 * Deliberately narrow, because the alternative costs real messages. `/etc/passwd is world-readable`
 * and `and/or` are things a person says to an agent; a second slash or a space means this is prose
 * and goes to the model untouched. What remains — a lone `/word` — can only have been meant as a
 * command, so getting it wrong is worth reporting.
 */
const COMMAND_SHAPE = /^\/[A-Za-z][\w-]*$/

/**
 * The same word, followed by arguments.
 *
 * The narrow rule above still decides everything it can, and this only adds a case it cannot reach:
 * `/logs 200` and `/skills validate` need a space, which the narrow rule reads as prose. The escape is
 * **the first token being exactly a known command** — decidable from the tables alone, with no
 * heuristic. So `/etc/passwd is world-readable` still goes to the model, because `/etc` is not a
 * command; and a mistyped `/skils validate` is prose rather than a refusal, which is the one thing this
 * loosening costs and the cheaper of the two errors.
 */
const COMMAND_WITH_ARGS = /^(\/[A-Za-z][\w-]*)\s+(.*)$/

const KNOWN = new Map<string, SessionCommandKind>(
    SESSION_COMMANDS.flatMap((spec) =>
        [spec.word, ...spec.aliases].map((word) => [word.toLowerCase(), spec.kind] as const),
    ),
)

/**
 * `undefined` means "this is a prompt" — the overwhelming majority of lines.
 *
 * `offered` is the set of CLI command names a session exposes, passed in rather than imported: this
 * module is dispatch and `commands.ts` is the table, and importing one into the other would put the
 * whole command surface behind every consumer of `resolveSessionCommand`, including the plain path.
 */
export function resolveSessionCommand(
    text: string,
    offered: readonly string[] = [],
): SessionCommand | undefined {
    const trimmed = text.trim()
    const kind = KNOWN.get(trimmed.toLowerCase())
    if (kind !== undefined) return { kind }

    const names = new Set(offered)
    if (names.has(trimmed.slice(1).toLowerCase()) && COMMAND_SHAPE.test(trimmed)) {
        return { kind: "command", name: trimmed.slice(1).toLowerCase(), rest: "" }
    }

    const withArgs = COMMAND_WITH_ARGS.exec(trimmed)
    if (withArgs !== null) {
        const head = (withArgs[1] ?? "").toLowerCase()
        const rest = withArgs[2] ?? ""
        const known = KNOWN.get(head)
        if (known !== undefined) return { kind: known, rest }
        if (names.has(head.slice(1))) {
            return { kind: "command", name: head.slice(1), rest }
        }
        // Not a known first token, so the narrow rule stands and this is prose.
        return undefined
    }

    if (!COMMAND_SHAPE.test(trimmed)) return undefined

    const suggestion = nearest(trimmed.toLowerCase(), [
        ...KNOWN.keys(),
        ...offered.map((name) => `/${name}`),
    ])
    return {
        kind: "unknown",
        word: trimmed,
        ...(suggestion === undefined ? {} : { nearest: suggestion }),
    }
}

const COMMAND_COLUMN = 20

function commandLine(spec: SessionCommandSpec): string {
    const forms = [spec.word, ...spec.aliases].join(" / ")
    return `  ${forms.padEnd(COMMAND_COLUMN)}${spec.summary}`
}

function keyLine(spec: KeyBindingSpec): string {
    return `  ${spec.chord.padEnd(COMMAND_COLUMN)}${spec.summary}`
}

/** Generated, so a command the prompt honours cannot be missing from it. */
export function sessionHelpText(): string {
    return [
        "commands:",
        ...SESSION_COMMANDS.map(commandLine),
        "",
        "keys:",
        ...KEY_BINDINGS.map(keyLine),
    ].join("\n")
}

export function unknownCommandText(command: {
    readonly word: string
    readonly nearest?: string
}): string {
    const suggestion = command.nearest === undefined ? "" : ` Did you mean ${command.nearest}?`
    return `${command.word} is not a command.${suggestion} Type /help for the list — or add a space if you meant to say it to the model.`
}

/** The narrow slice of an agent `/tools` reports on. Structural, so core owns no CLI shapes. */
export interface ToolsView {
    readonly dialect: string
    readonly catalogueTokens: number
    readonly tools: readonly {
        readonly slug: string
        readonly mutating: boolean
        /**
         * Whether this tool's output may carry text a stranger wrote.
         *
         * Shown because it is not cosmetic: an untrusted tool taints the turn, and after it has run
         * a mutating call needs an explicit rule or a live approval. "Why did my second `exec` get
         * blocked?" is answered by this column and by nothing else on this surface.
         */
        readonly trust: string
        /**
         * Why a tool declares itself trusted when a provider tool defaults to untrusted.
         *
         * Shown here rather than warned about at boot. The warning fired on every start of every agent
         * using the system provider — four tools whose output the runtime composed — and a warning that
         * is always present for a correct configuration is one people stop reading. The reason belongs
         * where someone is already looking at the catalogue.
         */
        readonly trustReason?: string
        readonly summary: string
    }[]
}

/**
 * The part of an agent this needs, stated structurally.
 *
 * `Agent` satisfies it without being named, which keeps the projection below testable with a plain
 * object rather than a live runtime — and a projection nobody can test is one that quietly stops
 * matching what it projects.
 */
export interface AgentToolsSource {
    describe(): { readonly dialect: string; readonly catalogueTokens: number }
    readonly tools: {
        specs(): readonly {
            readonly slug: string
            readonly mutating: boolean
            /** Optional here because it is optional on `ToolSpec`; the registry settles it. */
            readonly trust?: string
            readonly trustReason?: string
            readonly summary: string
        }[]
    }
}

/** Here rather than in each renderer, so the two cannot show different things. */
export function toolsView(agent: AgentToolsSource): ToolsView {
    const described = agent.describe()
    return {
        dialect: described.dialect,
        catalogueTokens: described.catalogueTokens,
        tools: agent.tools.specs().map((spec) => ({
            slug: spec.slug,
            mutating: spec.mutating,
            // Already normalised by the registry, so the fallback is unreachable for anything that
            // came through one — but `ToolSpec.trust` is optional in the type, and a view that
            // silently printed nothing would be the wrong way to find that out.
            trust: spec.trust ?? "trusted",
            ...(spec.trustReason === undefined ? {} : { trustReason: spec.trustReason }),
            summary: spec.summary,
        })),
    }
}

/**
 * What the model can actually call.
 *
 * Worth a command because the catalogue is resolved once at load and is otherwise invisible: when a
 * model will not call a tool you believe is pinned, whether it is *in* the catalogue is the first
 * question, and `catalogueTokens` is the recurring cost of every turn in the session.
 */
export function toolsReport(view: ToolsView): string {
    if (view.tools.length === 0) {
        return `no tools — this agent pinned none, so the model can only reply. Add them under tools.local or tools.pinned. (call format ${view.dialect})`
    }

    const pad = view.tools.reduce((longest, tool) => Math.max(longest, tool.slug.length), 0)
    const rows = view.tools.flatMap((tool) => [
        `  ${tool.slug.padEnd(pad)}  ${tool.mutating ? "write" : "read "}  ${
            tool.trust === "untrusted" ? "untrusted" : "trusted  "
        }  ${tool.summary}`,
        // Only a tool that opted out of the untrusted default has one, so this is rare and worth the
        // line when it appears: it is the difference between a fence someone removed on purpose and one
        // a package forgot.
        // Aligned under the summary column: 2 leading spaces, the slug, and the two fixed columns
        // with their separators. Computed rather than hardcoded, or it drifts the first time a column
        // changes width.
        ...(tool.trustReason === undefined
            ? []
            : [`${" ".repeat(2 + pad + 2 + 5 + 2 + 9 + 2)}trusted: ${tool.trustReason}`]),
    ])
    return [
        // "dialect nlt" led the line once and read as a third tool — and asked about it, the model
        // guessed NLTK, because the dialect is harness plumbing it is never told the name of. The
        // count leads; the protocol is labelled as what it is.
        `${view.tools.length} tool${view.tools.length === 1 ? "" : "s"} · call format ${view.dialect} · catalogue ${view.catalogueTokens} tokens, on every turn`,
        ...rows,
    ].join("\n")
}
