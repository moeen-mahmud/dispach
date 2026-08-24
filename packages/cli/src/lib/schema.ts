/**
 * Contracts between modules — what the parser produces, what a command takes, what a component
 * receives. Domain shapes live in `types.ts`.
 */

import type { Agent, EventBus } from "@dispach/core"
import type { BrowseRow, InstallReport } from "#lib/browse"
import type { Slice } from "#lib/scroll"
import type { SessionRowSource } from "#lib/sessions-view"
import type { CatalogueEntry } from "#lib/source-cache"
import type { TextSelection } from "#lib/text-selection"
import type {
    EditorState,
    EnvFacts,
    KeyState,
    LiveTurn,
    RenderMode,
    TranscriptRow,
    TranscriptState,
    TurnStats,
    TurnStatus,
} from "#lib/types"

// ─── the command table ───────────────────────────────────────────────────────────────────

export type FlagKind = "boolean" | "string" | "number"

export interface FlagSpec {
    /** Long form, written without the leading dashes. */
    readonly name: string
    readonly short?: string
    readonly kind: FlagKind
    readonly help: string
    /** Shown in help as `--session <key>`. Value-taking flags should set it. */
    readonly placeholder?: string
    /** Appended to the help line in parentheses. */
    readonly defaultHelp?: string
    /** Numbers only. Both are enforced by the parser, not by the call site. */
    readonly min?: number
    readonly integer?: boolean
    /**
     * The value to use when the flag is written with nothing after it.
     *
     * A value-taking flag normally consumes the next token *unconditionally*, dash or not, because
     * whether a token is a value is the spec's decision and not the token's — `--input -5` means the
     * text "-5". Declaring `bare` inverts that for one flag: a missing next token, or one starting with
     * a dash, means the flag was written on its own and this value stands in.
     *
     * Per-spec rather than global, because the safety of the inversion is a fact about the *field*.
     * A session key never starts with a dash, so `--session --plain` can only mean a bare `--session`;
     * an `--input` beginning with a dash is ordinary text, and giving that flag a bare form would make
     * a real message unsendable.
     */
    readonly bare?: string
}

export interface ArgSpec {
    readonly name: string
    readonly required: boolean
    readonly variadic?: boolean
    readonly help: string
    /**
     * The fixed set this argument accepts, when it is a verb rather than a value.
     *
     * Structured rather than prose in `help`, because prose is invisible to every check. `soul`'s
     * single action lived inside its help string for three phases, so nothing could tell whether
     * the command still accepted what the help claimed — and a second action-taking command made
     * that a class of drift rather than one oddity. `help.ts` renders these as an `actions:` block
     * and a test asserts every action the command body accepts appears here, which is the same
     * guarantee the flag table already gives flags.
     */
    readonly choices?: readonly { readonly value: string; readonly help: string }[]
}

export interface CommandSpec {
    readonly name: string
    readonly summary: string
    readonly args: readonly ArgSpec[]
    readonly flags: readonly FlagSpec[]
    /**
     * How this command appears inside a running session, as a slash command.
     *
     * - `view`   — a bespoke interactive screen exists for it.
     * - `output` — run it and show the text it prints, in a scrollable pane.
     * - `hidden` — not offered in a session at all.
     *
     * Required, and that is the point. The palette is generated from this table so a new flag reaches
     * the TUI with nothing to remember, and hiding a command that does not belong in a session — `stop`
     * would end the session it was typed into — has to be *declared* rather than achieved by leaving it
     * out of a second hand-written list. A second list is the drift `session-commands.ts` was written to
     * end; making the field mandatory means a new command cannot be silently absent instead.
     */
    readonly inSession: "view" | "output" | "hidden"
}

// ─── parser output ───────────────────────────────────────────────────────────────────────

export type FlagValue = string | number | boolean

export interface FlagValues {
    /** Throws if the spec declares this flag as something other than a string. */
    str(name: string): string | undefined
    num(name: string): number | undefined
    /** Absent switches are `false`, never `undefined` — there is no third state. */
    bool(name: string): boolean
    has(name: string): boolean
}

export interface Parsed {
    readonly command: CommandSpec
    readonly positionals: readonly string[]
    readonly flags: FlagValues
}

export type ParseResult =
    | { readonly kind: "command"; readonly parsed: Parsed }
    | { readonly kind: "help"; readonly command: CommandSpec | undefined }
    | { readonly kind: "version" }
    /** Invoked with nothing to do. Print help, exit non-zero — being lost is not success. */
    | { readonly kind: "usage" }

// ─── rendering ───────────────────────────────────────────────────────────────────────────

export interface ModeInputs {
    readonly json: boolean
    readonly plain: boolean
    /** `--input <text>`: one turn, print, exit. */
    readonly oneShot: boolean
    readonly stdinIsTTY: boolean
    readonly stdoutIsTTY: boolean
    readonly env: EnvFacts
}

export interface ModeDecision {
    readonly mode: RenderMode
    /** Printable, and what makes this resolution debuggable rather than mysterious. */
    readonly because: string
}

// ─── process teardown ────────────────────────────────────────────────────────────────────

export interface TerminalHandles {
    readonly out: { write(chunk: string): boolean; readonly isTTY?: boolean | undefined }
    readonly in: {
        readonly isTTY?: boolean | undefined
        setRawMode?: ((mode: boolean) => void) | undefined
    }
}

// ─── command options ─────────────────────────────────────────────────────────────────────

/**
 * Every command takes a plain options object and returns an exit code. It never calls
 * `process.exit` itself: that would discard buffered stdout on a pipe, and it makes a command
 * impossible to call from a test.
 */
export interface RunOptions {
    /** Absent = bare `run`: the sandbox decides (picker, auto-run, or the wizard). */
    readonly manifestPath?: string
    /**
     * Which conversation to open.
     *
     * Three states, not two. A key names one; **`""`** is a bare `--session`, meaning "show me the list";
     * absent means a new conversation. The empty string carries real intent here, which is why it is not
     * normalised away on the boundary — `lib/args.ts` produces it from `FlagSpec.bare`.
     */
    readonly sessionKey?: string
    /** `--continue`: the most recent conversation with this agent, without asking. */
    readonly continueSession?: boolean
    /** Run a single turn with this input and exit. Non-interactive, and always plain. */
    readonly once?: string
    readonly store?: string
    readonly ephemeral?: boolean
    readonly quiet?: boolean
    readonly showReasoning?: boolean
    /** Turns off the reasoning stream that a thinking model shows by default. */
    readonly noReasoning?: boolean
    /**
     * Do not negotiate the kitty keyboard protocol for this session.
     *
     * `undefined` means "no opinion", which `negotiateKeyboard` resolves from `<ENVPREFIX>NO_CSI_U` —
     * so this is threaded as-is rather than coerced to a boolean, or a flag nobody passed would
     * silently override an environment somebody set.
     */
    readonly noEnhancedKeys?: boolean
    readonly plain?: boolean
}

export interface MemoryOptions {
    readonly action: string
    readonly manifestPath: string
    /** The words to rank against. Required for `search`, unused by `rebuild`. */
    readonly query?: string
    readonly store?: string
    readonly limit?: number
    /** Show passages below the manifest's threshold too, marked. */
    readonly all?: boolean
    readonly json?: boolean
}

export interface SessionsOptions {
    readonly manifestPath: string
    /** Inspect this session instead of listing them. */
    readonly sessionKey?: string
    readonly store?: string
    readonly json?: boolean
    readonly limit?: number
    /** Delete the named session's history. Requires `sessionKey`. */
    readonly clear?: boolean
    /** Show turn records rather than messages. Requires `sessionKey`. */
    readonly turns?: boolean
}

export interface ValidateOptions {
    readonly manifestPath: string
    readonly json?: boolean
}

export interface InitOptions {
    readonly dir?: string
    readonly user?: string
    readonly name?: string
    readonly purpose?: string
    readonly preset?: string
    readonly model?: string
    readonly baseUrl?: string
    readonly apiKeyEnv?: string
    /** `none`, `read`, or `full` — how much of this machine the agent may touch. */
    readonly system?: string
    readonly web?: string
    readonly webBackend?: string
    /** `none` or `connected` — whether the agent reaches other apps through Composio. */
    readonly composio?: string
    /** `none` or `connected` — whether people can message it on Telegram. */
    readonly telegram?: string
    /** One Telegram handle, or empty for an allowlist that permits nobody. */
    readonly telegramAllow?: string
    /** `none` or `local` — whether to serve the HTTP API on loopback. */
    readonly server?: string
    /** `none` or `starter` — whether to scaffold a skills directory, and whether to seed it. */
    readonly skills?: string
    readonly daemon?: string
    /** Take every default; never ask, even at a terminal. */
    readonly yes?: boolean
    readonly plain?: boolean
}

export interface AgentsOptions {
    readonly manifestPaths: readonly string[]
    readonly json?: boolean
}

// ─── component props ─────────────────────────────────────────────────────────────────────

export interface AppProps {
    readonly agent: Agent
    readonly bus: EventBus
    readonly sessionKey: string
    readonly model: string
    /** Notes printed once above the conversation: version, session, store, any reaped turn. */
    readonly initial: TranscriptState
    /**
     * The key Ink reported, with its modifiers read off the raw bytes.
     *
     * Injected because the tap it reads from has to be registered *before* `render`, which a component
     * cannot do for itself. Optional, and the default is identity: a frame test mounts this component with
     * no stdin to tap, and a missing correction has to mean "trust Ink" rather than "crash".
     */
    readonly correctKeys?: (key: KeyState, input: string) => KeyState
    readonly showReasoning: boolean
    readonly quiet: boolean
    /**
     * Asked for `/restart`. The component unmounts; whoever mounted it rebuilds the agent.
     *
     * A callback rather than a return value because Ink owns the exit: the screen has to come down
     * before a new runtime prints its banner, and only `useApp().exit` can bring it down.
     */
    readonly onRestart?: (draft: string) => void
    /**
     * A message that was being written when the last agent was torn down.
     *
     * The only state that has to survive a `/restart`, and the only one that cannot survive it on its
     * own: everything else is either persisted in the store or rebuilt from the manifest, while an
     * unsent draft lives in a component that the restart unmounts. History is not carried across —
     * it is the store's, and a restart re-reads it.
     */
    readonly initialDraft?: string
    /**
     * The agent's manifest, for a slash command that runs as a child process.
     *
     * A pane runs `<binary> validate <manifest> --plain` rather than calling the function, because Ink
     * owns stdout while a session is mounted — see `lib/subcommand.ts`. Without the path the child would
     * resolve whichever agent the *cwd* suggests, which is a different agent than the one being talked to
     * and would not look wrong in the output.
     */
    readonly manifestPath?: string
    /**
     * The catalogue wiring for a hosted `/skills` pane.
     *
     * Injected rather than imported, which is the view contract's rule applied one level up: the host
     * owns the filesystem and the network, the screen owns neither. It is also what keeps `browse.ts` out
     * of this component's import graph — importing it dynamically here while the wizard imported it
     * statically made bun's splitting emit its exports twice, and a `Duplicate export` crashes the built
     * binary while every test, which imports source, passes.
     *
     * Absent means `/skills` falls back to running the command in an output pane, which still works.
     */
    readonly catalogue?: {
        readonly load: (onStatus: (line: string) => void) => Promise<readonly BrowseRow[]>
        readonly install: (
            skills: readonly CatalogueEntry[],
            manifestPath: string,
        ) => Promise<InstallReport>
    }
    /**
     * `/status` — what this agent is and what is actually running.
     *
     * Injected for the same reason `catalogue` is: the host owns the runtime, the screen owns neither it
     * nor the filesystem. Specifically it needs `runtime.channels.started`, which is the difference
     * between a channel that is *configured* and one that is *connected* — and the whole reason this
     * screen exists is that reading the manifest instead produced an agent reporting a live Telegram
     * binding from inside a `run` where nothing was listening.
     *
     * Absent means `/status` is not offered, which is honest; it must never mean the word is accepted
     * and silently billed to the model as prose, which is what it did before this prop existed.
     */
    readonly status?: () => Promise<string>
    /**
     * `/context` — the prompt's per-slot cost and the budget it is measured against.
     *
     * Injected like `status`, and session-local for a reason worth stating: `subcommandArgv` passes
     * only a manifest path and `--plain`, so a command pane's child boots its *own* runtime with its
     * own empty session and would confidently report a different conversation's context.
     */
    readonly contextView?: () => Promise<string>
    /** The agent's id, for the one-line header. Distinct from `model`, which is the endpoint's. */
    readonly agentName: string
    /**
     * This conversation has no history, so the splash stands in for the transcript until something is said.
     *
     * Passed rather than derived, and that is the point: the chat does not render stored history — a
     * resumed session's messages live in the store and reach the *model*, not the screen — so "the
     * transcript is empty" is true of a resumed conversation as well, and deriving from it would put a
     * welcome screen in front of a conversation somebody is trying to continue. Only `run` knows whether
     * the key it resolved was freshly generated.
     */
    readonly freshSession?: boolean
    /**
     * Move to another stored conversation.
     *
     * The component unmounts and the host reopens with the key given — the same route `onRestart` takes,
     * because `useReducer`'s initial state seeds only on mount and a transcript therefore cannot be
     * re-keyed in place. The draft rides across for the same reason it rides across a restart: throwing
     * away a half-written message is a second consequence of asking for the first.
     */
    readonly onSwitch?: (sessionKey: string, draft: string) => void
    /**
     * The stored conversations, for the `/sessions` switcher.
     *
     * A function rather than an array, because the list is only wanted when the pane opens and it is a
     * store read — and injected rather than imported, which is the view contract applied one level up: the
     * host owns the filesystem, the screen owns neither it nor the network.
     */
    readonly sessions?: () => Promise<readonly SessionRowSource[]>
    /**
     * Load warnings, as a count in the header.
     *
     * The messages themselves are already in the banner. What the header needs is the *number*, because
     * on the alternate screen the banner scrolls out of the window and a session-wide fact that has
     * scrolled away is a fact nobody has. Passed in rather than read off the agent here, so the component
     * stays testable with a plain array — and so the CLI's own demoted-variable notes are counted
     * alongside the runtime's, which only the host knows about.
     */
    readonly warnings?: readonly string[]
}

export interface TranscriptProps {
    /**
     * The live mouse selection, in buffer coordinates, or `undefined`.
     *
     * Buffer coordinates rather than screen ones, so scrolling leaves it alone: the window moves and the
     * selection does not. `undefined` renders exactly what this component rendered before it existed.
     */
    readonly selection?: TextSelection
    /** Already flattened and wrapped by `transcriptRows`, so a row here is a row on screen. */
    readonly rows: readonly TranscriptRow[]
    /** Which of them to draw, and how many are out of sight. Decided by `lib/scroll.ts`. */
    readonly slice: Slice
}

export interface LiveProps {
    readonly live: LiveTurn
    readonly showReasoning: boolean
    readonly columns: number
}

export interface StatusBarProps {
    readonly status: TurnStatus
    readonly model: string
    readonly sessionKey: string
    readonly elapsedMs: number
    readonly last: TurnStats | undefined
    readonly quiet: boolean
    /**
     * A ^C has been pressed at an idle prompt and the next one leaves.
     *
     * On the status line rather than in a popup because this is where the ^C hint already lives, and the
     * two have to be the same sentence: a footer that reads "^C exits" while a first press has already
     * been absorbed is a footer that lied about the keystroke somebody just made.
     */
    readonly armed?: boolean
    /** Prompt fullness as a fraction of the budget, when a step has reported one. */
    readonly pressure?: number
    /** The phase, once one has been entered. Absent on an agent that declares none. */
    readonly phase?: string
}

export interface PromptProps {
    readonly editor: EditorState
    readonly busy: boolean
    /**
     * The screen's width. The box takes it explicitly and the text is wrapped to what is left inside it.
     *
     * Not optional, and that is the point: a composer with no width lets Ink measure the box from its
     * content, which makes a long message wider than the terminal and hands the wrapping to whichever
     * terminal is running it — cut in one, ragged over the border in another.
     */
    readonly columns: number
    /**
     * Shown dim, with the cursor on its first character, while the buffer is empty.
     *
     * Only the splash passes one. In the transcript the prompt sits under a conversation that already
     * says what this is, and a permanent "Ask anything…" there would be a label on something obvious.
     */
    readonly placeholder?: string
}

export interface BrandmarkProps {
    /**
     * The wordmark's rows, already rendered by `lib/wordmark.ts` from `BRAND.name`.
     *
     * Passed in rather than computed here, because the caller has to know the mark's real height to charge
     * the conversation for it — and computing it in both places would be two derivations that can disagree
     * about how many rows are on screen, which on a fixed-height frame is how the layout comes apart.
     */
    readonly lines: readonly string[]
}
