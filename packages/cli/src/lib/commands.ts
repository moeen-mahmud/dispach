/**
 * The command table — data only, no rendering and no parsing.
 *
 * One source of truth for three consumers: `args.ts` parses against it, `help.ts` renders from it,
 * and error messages look flags up in it to say which command *does* accept a flag. Before this
 * existed the usage text was a hand-maintained string with no link to the parser, and it had
 * already drifted — `agents` accepted flags it never documented.
 *
 * Nothing here contains the product name. Command names come from `BRAND.slug`, so a rename stays
 * the one-commit operation hard rule 3 requires.
 */

import { BRAND } from "@dispach/core"
import { DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT } from "#lib/const"
import type { ArgSpec, CommandSpec, FlagSpec } from "#lib/schema"

/** Accepted by every command, so the render mode is answered the same way everywhere. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
    {
        name: "plain",
        kind: "boolean",
        help: "force plain text — no interactive rendering, no colour",
    },
    { name: "help", short: "h", kind: "boolean", help: "show this help and exit" },
    { name: "version", short: "v", kind: "boolean", help: "print the version and exit" },
]

const MANIFEST: ArgSpec = {
    name: "manifest",
    required: true,
    help: "path to an agent.yaml, or the name of a sandbox agent",
}

const STORE: FlagSpec = {
    name: "store",
    kind: "string",
    placeholder: "path",
    help: "session database",
    defaultHelp: `~/${BRAND.stateDir}/store.db`,
}

const SESSION: FlagSpec = {
    name: "session",
    kind: "string",
    placeholder: "key",
    help: "session key",
    // Written on its own, it means "ask me which one" — the interactive twin of `--continue`. Safe as a
    // bare form because a session key cannot start with a dash, which is the condition `FlagSpec.bare`
    // documents; `run` opens the picker and every other command reports that it needs a key.
    bare: "",
}

const JSON_FLAG: FlagSpec = { name: "json", kind: "boolean", help: "machine-readable output" }

export const COMMANDS: readonly CommandSpec[] = [
    {
        // Interactive at a terminal; every question also has a flag so scripts and CI can run it.
        // It never asks for the API key itself — a prompt invites shoulder-surfing and a flag
        // writes the secret into shell history — so the generated .env has an empty line to fill.
        name: "init",

        inSession: "hidden",
        summary: "create a new agent: manifest, workspace, and env files",
        args: [
            {
                name: "dir",
                required: false,
                help: "target directory (default: ./<agent-name-slug>)",
            },
        ],
        flags: [
            { name: "user", kind: "string", placeholder: "name", help: "your name" },
            { name: "name", kind: "string", placeholder: "name", help: "the agent's name" },
            {
                name: "purpose",
                kind: "string",
                placeholder: "text",
                help: "one line: what the agent is for",
            },
            {
                name: "preset",
                kind: "string",
                placeholder: "id",
                help: "model endpoint: openai | anthropic | deepseek | ollama | custom",
                defaultHelp: "openai",
            },
            { name: "model", kind: "string", placeholder: "id", help: "model id" },
            { name: "base-url", kind: "string", placeholder: "url", help: "endpoint base URL" },
            {
                name: "api-key-env",
                kind: "string",
                placeholder: "VAR",
                help: "env var that will hold the key; omitted for ollama",
                defaultHelp: "MODEL_API_KEY",
            },
            {
                name: "system",
                kind: "string",
                placeholder: "level",
                help: "what it may touch on this machine: none | read | write | full",
                defaultHelp: "none",
            },
            {
                name: "web",
                kind: "string",
                placeholder: "level",
                help: "internet access: none | fetch | search",
                defaultHelp: "none",
            },
            {
                name: "web-backend",
                kind: "string",
                placeholder: "id",
                help: "search backend when --web search: tavily | brave | exa",
                defaultHelp: "tavily",
            },
            {
                name: "composio",
                kind: "string",
                placeholder: "level",
                help: "your other apps via Composio: none | connected",
                defaultHelp: "none",
            },
            {
                name: "telegram",
                kind: "string",
                placeholder: "level",
                help: "reachable on Telegram: none | connected",
                defaultHelp: "none",
            },
            {
                name: "telegram-allow",
                kind: "string",
                placeholder: "@handle",
                help: "who may message it — empty permits nobody, which is the safe default",
            },
            {
                name: "server",
                kind: "string",
                placeholder: "level",
                help: "serve the HTTP API: none | local",
                defaultHelp: "none",
            },
            {
                name: "schedules",
                kind: "string",
                placeholder: "what",
                help: "run something on a schedule: none | daily | hourly",
                defaultHelp: "none",
            },
            {
                name: "skills",
                kind: "string",
                placeholder: "level",
                // A phrase as well as a level, because the interesting answer is "find me one". The
                // default stays `starter` so a scripted run reaches no network.
                help: 'none | starter, or words to search the catalogues for — --skills "pdf tables"',
                defaultHelp: "starter",
            },
            {
                name: "daemon",
                kind: "string",
                placeholder: "level",
                help: "keep it running in the background: none | service",
                defaultHelp: "none",
            },
            {
                name: "yes",
                kind: "boolean",
                help: "take every default; never ask, even at a terminal",
            },
        ],
    },
    {
        name: "run",

        inSession: "hidden",
        summary: "start an interactive session — bare `run` picks from the sandbox",
        args: [
            {
                ...MANIFEST,
                required: false,
                help: "path or sandbox agent name (omit to pick from the sandbox)",
            },
        ],
        flags: [
            { ...SESSION, defaultHelp: "a new one each run; bare --session picks from the list" },
            {
                name: "continue",
                short: "c",
                kind: "boolean",
                help: "pick up the most recent conversation with this agent",
            },
            {
                name: "input",
                kind: "string",
                placeholder: "text",
                help: "run one turn, print the reply, exit",
            },
            STORE,
            {
                name: "ephemeral",
                kind: "boolean",
                help: "keep this session in memory only; nothing is written",
            },
            { name: "quiet", kind: "boolean", help: "suppress the banner and per-turn stats" },
            {
                // The same override `keys` carries, on the command that actually holds a session. The env
                // form works everywhere; a flag exists because the case this covers is "try it without,
                // once" and reaching for a variable to answer a one-off question is friction.
                name: "no-enhanced-keys",
                kind: "boolean",
                help: "do not negotiate the kitty keyboard protocol (cmd chords stop arriving)",
            },
            {
                name: "no-reasoning",
                kind: "boolean",
                help: "hide the thinking a reasoning model streams (shown by default)",
            },
            {
                // Kept so existing scripts keep working. Reasoning is on by default now, so this
                // asks for what already happens — harmless, and cheaper than breaking a flag people
                // have in their shell history.
                name: "show-reasoning",
                kind: "boolean",
                help: "no-op: reasoning is shown by default when the model has any",
            },
        ],
    },
    {
        // Reading, enabling and disabling — but never *writing* a schedule.
        //
        // Creating one from the CLI would be a third writer beside the manifest and the API, each
        // with its own idea of what a valid expression is; the manifest is where a schedule belongs,
        // because it is the thing that survives a rebuild and shows up in a diff. What the CLI adds
        // is the two questions a file cannot answer: when does this actually fire next, and did the
        // last run work.
        name: "schedules",

        // A view: a list somebody reads and then acts on, like `sessions`.
        inSession: "view",
        summary: "list schedules, when they next fire, and how the last run went",
        args: [MANIFEST],
        flags: [
            {
                name: "id",
                kind: "string",
                placeholder: "schedule",
                help: "show one schedule in full instead of the list",
            },
            {
                name: "enable",
                kind: "string",
                placeholder: "schedule",
                help: "switch an API-created schedule on; a manifest one is enabled in agent.yaml",
            },
            {
                name: "disable",
                kind: "string",
                placeholder: "schedule",
                help: "switch an API-created schedule off; a manifest one is disabled in agent.yaml",
            },
            STORE,
            JSON_FLAG,
        ],
    },
    {
        name: "sessions",

        // A view rather than an output pane: the list is a *choice*, and reading it read-only was the one
        // thing you could already do by exiting and passing `--session`. Enter switches.
        inSession: "view",
        summary: "list stored sessions, or inspect one",
        args: [MANIFEST],
        flags: [
            { ...SESSION, help: "show one session instead of the list" },
            { name: "turns", kind: "boolean", help: "show turn records instead of messages" },
            {
                name: "clear",
                kind: "boolean",
                help: "delete the named session's history; memory files are untouched",
            },
            {
                name: "limit",
                kind: "number",
                placeholder: "n",
                help: "rows to show",
                defaultHelp: String(DEFAULT_ROW_LIMIT),
                min: MIN_ROW_LIMIT,
                integer: true,
            },
            STORE,
            JSON_FLAG,
        ],
    },
    {
        // Two questions, and they are asked of the *index* rather than of the files. `search` is what
        // makes a ranking explicable — it prints the lexical score beside the boosted one, so "retrieved
        // because it is about your question" and "retrieved because it is recent" are distinguishable
        // without reading the code. `rebuild` exists because staleness detection is mtime plus size, and
        // an edit that preserves both is a real blind spot rather than a hypothetical one.
        name: "memory",

        // A view: the result is a list somebody reads and then wants to act on. Read-only for now —
        // deleting a memory means editing the file, which is the point of files being canonical.
        inSession: "view",
        summary: "search what the agent remembers, or rebuild the index from the files",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    {
                        value: "search",
                        help: "rank the corpus against a query, exactly as a turn would",
                    },
                    {
                        value: "rebuild",
                        help: "forget the index and re-read every file — for an edit that kept the mtime",
                    },
                ],
            },
            { ...MANIFEST, required: true },
            {
                name: "query",
                required: false,
                help: "the words to search for (search only); quote a phrase",
            },
        ],
        flags: [
            STORE,
            {
                name: "limit",
                kind: "number",
                placeholder: "n",
                help: "passages to show",
                defaultHelp: "10",
                min: 1,
                integer: true,
            },
            {
                // The manifest's `memory.threshold` is what a *turn* applies. A search is a person
                // asking what is in there, and a floor that hid the near-misses would make the command
                // useless for the question it exists to answer — "why did it not recall that?"
                name: "all",
                kind: "boolean",
                help: "show passages below the manifest's threshold too, marked",
            },
            JSON_FLAG,
        ],
    },
    {
        // A person's editor for the manifest. `config_read`/`config_set` are the *agent's*, and they
        // are deliberately floored on the fields decision 11.29 reserves for a person — which left
        // those fields with no editor at all until this existed.
        //
        // `view`, because bare `/config` opens the editor — a surface somebody navigates — while every
        // other action is a listing or a one-line report and falls through to an output pane. That
        // fallthrough is the existing contract for a view: "a view named in the table with nothing built
        // yet falls back to its own output".
        name: "config",

        inSession: "view",
        summary: "read and change an agent's settings, and fill in its secrets",
        args: [
            {
                name: "action",
                // Optional, because `config <agent>` with no action opens the editor. `readAction`
                // decides which of the two the first positional is; the six action words win.
                required: false,
                help: "what to do (default: edit)",
                choices: [
                    {
                        value: "edit",
                        help: "the full-screen editor — also what bare `config <agent>` opens",
                    },
                    { value: "list", help: "every setting, its current value, and who may set it" },
                    { value: "get", help: "one setting" },
                    { value: "set", help: "change one setting" },
                    {
                        value: "env",
                        help: "put a secret in the .env beside the manifest, prompted and not echoed",
                    },
                    {
                        value: "allow",
                        help: "add or remove a handle a channel accepts messages from",
                    },
                ],
            },
            // Not required: `config <agent>` puts the agent in positional 0, and `readAction` moves it.
            // Declaring it required would fail on arity before that ever ran.
            { ...MANIFEST, required: false },
            {
                name: "name",
                required: false,
                help: "the setting's dotted path, an env variable name, or a handle",
            },
            { name: "value", required: false, help: "the new value (set only)" },
        ],
        flags: [
            STORE,
            {
                name: "channel",
                kind: "string",
                placeholder: "id",
                help: "which channel to allow on, when there is more than one",
            },
            {
                name: "remove",
                kind: "boolean",
                help: "take the handle off instead of adding it (allow only)",
            },
            {
                // Only reaches the two edits that stop a check running. Everything else applies
                // without asking, so this is not the flag people learn to type by reflex.
                name: "yes",
                kind: "boolean",
                help: "skip the confirmation on an edit that weakens a check",
            },
        ],
    },
    {
        name: "validate",

        inSession: "output",
        summary: "load and validate a manifest, then exit",
        args: [MANIFEST],
        flags: [JSON_FLAG],
    },
    {
        // Distinct from `validate`, which asks whether the manifest loads. This asks whether the
        // *writing* is any good — the authoring rules of 07-SPEC-WORKSPACE.md, which are judgements
        // rather than facts and are therefore warnings that never fail the command.
        name: "workspace",

        inSession: "output",
        summary: "check the workspace files against the authoring rules",
        args: [MANIFEST],
        flags: [
            {
                name: "strict",
                kind: "boolean",
                help: "exit non-zero when any authoring warning is reported",
            },
            JSON_FLAG,
        ],
    },
    {
        // A scaffold, never a summary: headings and <rules> blocks survive verbatim, prose becomes
        // placeholders a person fills. Automatic distillation of an identity document drops exactly
        // the parts that produce voice, which is why this is a command and not something load does.
        name: "soul",

        inSession: "output",
        summary: "scaffold a hand-edited compact identity from a long-form document",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    { value: "distill", help: "scaffold a compact identity beside the source" },
                ],
            },
            { name: "file", required: true, help: "path to the long-form identity document" },
        ],
        flags: [
            {
                name: "out",
                kind: "string",
                placeholder: "path",
                help: "where to write the scaffold",
                defaultHelp: "<file>.compact.md beside the source",
            },
        ],
    },
    {
        // Three questions rather than one. `validate` warns and exits 0 like `workspace` does, because
        // everything it reports is a judgement — a skill that does not load has already failed by then.
        name: "skills",

        inSession: "view",
        summary: "browse the catalogue and install — or list, scaffold, check one agent's skills",
        args: [
            {
                name: "action",
                // Optional, so bare `skills` is the browse screen. That is the entry point somebody who
                // wants a skill actually has: every other form needs an agent, a query or a slug they
                // have not seen yet.
                required: false,
                help: "what to do — omit to browse the catalogue and tick what you want",
                choices: [
                    { value: "list", help: "every skill, its size, and whether it ships scripts" },
                    {
                        value: "show",
                        help: "one skill in full, including what the model never sees",
                    },
                    {
                        value: "new",
                        help: "scaffold a skill, turning skills on for this agent if they are not",
                    },
                    {
                        value: "install",
                        help: "install one by name — anthropic/pdf — or copy from a local path (see `sources`)",
                    },
                    { value: "remove", help: "delete a skill's directory and everything in it" },
                    { value: "validate", help: "authoring warnings — never a refusal" },
                ],
            },
            {
                ...MANIFEST,
                required: false,
                help: "path or sandbox agent name (not used when browsing)",
            },
            {
                name: "name",
                required: false,
                help: "the skill for show, new and remove — for install, <source>/<skill> or a local path",
            },
        ],
        flags: [
            {
                name: "strict",
                kind: "boolean",
                help: "exit non-zero when any authoring warning is reported",
            },
            JSON_FLAG,
        ],
    },
    {
        // Machine-level, so it takes no manifest — the split from `skills` that keeps every positional
        // here meaning one thing. A source is a place the person trusts; a skill is one agent's.
        name: "sources",

        inSession: "view",
        summary: "the repositories skills come from: list, add, search",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    { value: "list", help: "every source, and whether it has been fetched" },
                    { value: "add", help: "add a repository — a URL, or a name and a URL" },
                    { value: "remove", help: "stop searching a source; built-ins included" },
                    { value: "update", help: "re-fetch every source, or the ones named" },
                    {
                        value: "search",
                        help: "find a skill across every source; fetches on first use",
                    },
                ],
            },
            {
                name: "rest",
                required: false,
                variadic: true,
                help: "a name and URL for add, a name for remove or update, words for search",
            },
        ],
        flags: [
            {
                name: "path",
                kind: "string",
                placeholder: "dir",
                help: "subdirectory holding the skills (add)",
                defaultHelp: "the whole repository",
            },
            {
                name: "ref",
                kind: "string",
                placeholder: "branch",
                help: "branch or tag to track (add)",
                defaultHelp: "the remote's default branch",
            },
            JSON_FLAG,
        ],
    },
    {
        name: "agents",

        inSession: "output",
        summary: "list the agents one or more manifests produce",
        args: [{ ...MANIFEST, variadic: true, help: "one or more paths to an agent.yaml" }],
        flags: [JSON_FLAG],
    },
    {
        // The one command whose whole purpose is to make a network call, which is why it is a command
        // rather than something boot does: boot resolves a remote catalogue from disk so that nothing
        // touches the network before readiness, and an empty cache would otherwise deadlock — the load
        // fails on unresolved slugs, so the post-readiness refresh that would have filled it never runs.
        name: "tools",

        inSession: "output",
        summary:
            "show the resolved tool catalogue, or fetch a remote provider's schemas into the cache",
        args: [MANIFEST],
        flags: [
            {
                name: "warm",
                kind: "boolean",
                help: "fetch every pinned slug from the provider and write the resolution cache",
            },
            JSON_FLAG,
        ],
    },
    {
        // The only command that opens a listening socket, and the only one that starts channels.
        // `run` builds the same runtime without them: a REPL that quietly began answering Telegram
        // while you typed at it would be a surprise.
        name: "serve",

        inSession: "hidden",
        summary: "run the HTTP API and connect the agent's channels",
        args: [MANIFEST],
        flags: [
            {
                name: "port",
                kind: "number",
                placeholder: "n",
                help: "port to bind",
                defaultHelp: "server.port, or 7420",
            },
            {
                name: "host",
                kind: "string",
                placeholder: "addr",
                help: "address to bind — a non-loopback host requires an API token",
                defaultHelp: "server.host, or 127.0.0.1",
            },
            STORE,
            JSON_FLAG,
        ],
    },
    {
        // The instrument, not a setting. `terminal-setup` below changes a terminal's configuration; this
        // one only reports what the current terminal already does, which is the question that has to be
        // answered first and could not be until now.
        name: "keys",
        inSession: "hidden",
        summary: "press a chord and see the bytes, Ink's reading of them, and the intent",
        args: [],
        flags: [
            {
                name: "no-enhanced-keys",
                kind: "boolean",
                help: "do not negotiate the kitty keyboard protocol",
            },
        ],
    },
    {
        // The only command that edits a file outside the workspace, which is why it prints the change
        // first and asks. ⌥⏎ needs none of it — this is for people who want shift+⏎ as well.
        name: "terminal-setup",

        inSession: "hidden",
        summary: "teach this terminal to send shift+enter as a new line",
        args: [],
        flags: [
            { name: "dry-run", kind: "boolean", help: "print the change and write nothing" },
            { name: "yes", kind: "boolean", help: "write it without asking" },
            JSON_FLAG,
        ],
    },
    {
        // The switch that turns everything off. Separate from `daemon stop`, which needs you to
        // know the agent: this one finds the services *and* a `serve` left in a forgotten tab.
        // The mirror of `init`: it created a directory, a manifest and a workspace, and everything since
        // has scattered into a shared store keyed by manifest id, a log pair, and possibly a LaunchAgent.
        // `hidden` for the same reason `stop` is — removing the agent you are talking to is worse than
        // stopping it.
        name: "remove",

        inSession: "hidden",
        summary: "delete a sandbox agent: its directory, sessions, memory, logs and service",
        args: [
            {
                name: "agent",
                required: false,
                help: "sandbox agent name (a path is refused — remove only manages agents `init` made)",
            },
        ],
        flags: [
            {
                name: "dry-run",
                kind: "boolean",
                help: "show exactly what would go; delete nothing",
            },
            {
                name: "files-only",
                kind: "boolean",
                help: "delete the directory and keep the sessions, memory and logs",
            },
            {
                name: "prune",
                kind: "boolean",
                help: "delete sessions, memory and logs that no sandbox agent claims any more",
            },
            { name: "all", kind: "boolean", help: "remove every agent in the sandbox" },
            {
                name: "yes",
                kind: "boolean",
                help: "skip the typed confirmation (required to delete anything non-interactively)",
            },
            STORE,
            JSON_FLAG,
        ],
    },
    {
        name: "stop",

        inSession: "hidden",
        summary: "stop everything — background services and any session serving an agent",
        args: [
            {
                name: "agent",
                required: false,
                help: "path or sandbox agent name (omit to stop every agent)",
            },
        ],
        flags: [
            {
                name: "dry-run",
                kind: "boolean",
                help: "list what would be stopped; stop nothing",
            },
            JSON_FLAG,
        ],
    },
    {
        // `serve` stays up only as long as its terminal, which makes an agent configured for a
        // channel answer only while a window is open. This installs it as a supervised service.
        //
        name: "model",

        inSession: "output",
        summary: "ask the endpoint what it can actually do — window, output cap, prompt caching",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    {
                        value: "probe",
                        help: "measure every configured role against its own endpoint",
                    },
                ],
            },
            { name: "agent", required: true, help: "path or sandbox agent name" },
        ],
        flags: [
            {
                name: "window",
                kind: "boolean",
                help: "search for the window by growing a prompt until it is refused — costs real tokens, and prints the estimate first",
            },
            {
                name: "price",
                kind: "number",
                placeholder: "usd",
                help: "dollars per million input tokens, if you want --window's estimate in money",
            },
            {
                name: "write",
                kind: "boolean",
                help: "record a measured ceiling in the manifest; a floor is refused, because a floor is not a window",
            },
            {
                name: "yes",
                kind: "boolean",
                help: "answer the --window spend prompt; nothing else is affected",
            },
            { name: "json", kind: "boolean", help: "machine-readable findings" },
        ],
    },
    {
        // Second action-as-positional command after `soul` — and the reason `ArgSpec.choices`
        // exists, since seven verbs hidden inside a prose help string is a set nothing can check.
        name: "daemon",

        inSession: "output",
        summary: "keep an agent serving in the background — starts at login, restarts on crash",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    {
                        value: "install",
                        help: "check it will boot, write the service, load it, and watch it start",
                    },
                    { value: "uninstall", help: "unload it and remove the service definition" },
                    { value: "start", help: "load it again after a stop" },
                    { value: "stop", help: "unload it, and keep it stopped across a login" },
                    { value: "restart", help: "what you run after editing agent.yaml or .env" },
                    {
                        value: "status",
                        help: "running? how many restarts? why did it stop? — bare, reports every agent",
                    },
                    {
                        value: "logs",
                        help: "the tail of stderr; --lines, --follow, --truncate",
                    },
                ],
            },
            {
                name: "agent",
                // Optional so a bare `daemon status` can answer "is anything running?" — the
                // question people actually have, and one that should not require naming an agent.
                required: false,
                help: "path or sandbox agent name (omit only for status)",
            },
        ],
        flags: [
            {
                name: "lines",
                kind: "number",
                placeholder: "n",
                integer: true,
                min: 1,
                help: "how much of the log to show",
                defaultHelp: "40",
            },
            {
                name: "follow",
                short: "f",
                kind: "boolean",
                help: "keep printing as the service writes — both streams; ctrl-C stops (logs)",
            },
            { name: "truncate", kind: "boolean", help: "empty the log files (logs)" },
            {
                name: "dry-run",
                kind: "boolean",
                help: "print the service definition and the checks; write nothing",
            },
            JSON_FLAG,
        ],
    },
]

export function findCommand(name: string): CommandSpec | undefined {
    return COMMANDS.find((command) => command.name === name)
}

/** Every flag a command accepts: its own plus the global ones. */
export function flagsFor(command: CommandSpec): readonly FlagSpec[] {
    return [...command.flags, ...GLOBAL_FLAGS]
}

/**
 * Commands other than `exclude` that declare `flag`.
 *
 * Turns "unknown flag --json" — true but useless, since `--json` plainly exists — into a message
 * that names where it does work.
 */
export function commandsAccepting(flag: string, exclude: string): readonly string[] {
    return COMMANDS.filter(
        (command) => command.name !== exclude && command.flags.some((f) => f.name === flag),
    ).map((command) => command.name)
}
