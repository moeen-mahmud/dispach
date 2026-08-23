/**
 * The init wizard's question flow and file plan — pure data in, pure data out.
 *
 * Deliberately renderer-free and process-free (it is in the boundaries test's PURE list): the
 * readline loop in `init.ts` is one consumer, a flag-driven non-interactive run is another, and
 * an Ink wizard would be a third if one ever pays for itself. The flow cannot know which is
 * driving it, which is what keeps the three from diverging.
 *
 * Generated text carries two kinds of content. Everything *structural* — identity, voice, rules,
 * policy — is genuinely filled from the answers, so the agent runs and validates immediately.
 * The three dialogue examples keep their `{{INPUT_n}}`/`{{REPLY_n}}` placeholders on purpose:
 * examples are the highest-leverage section of an identity file and stock ones teach a stock
 * voice, so the `workspace` command keeps warning until a person writes real exchanges.
 */

import { BRAND, whenNotToUseKey } from "@dispach/core"
import { fillTemplate, SKILL_TEMPLATE, WORKSPACE_TEMPLATES } from "#lib/templates"

/**
 * The local tools every generated agent starts with, and the one line of guidance each carries
 * into the generated manifest and the wizard's tools screen — single-sourced so the two cannot
 * drift, and pinned by a test to core's `LOCAL_TOOL_SLUGS` so a new local tool cannot ship
 * without init knowing.
 */
export const INIT_LOCAL_TOOLS: readonly { readonly slug: string; readonly note: string }[] = [
    { slug: "now", note: "read-only: runs in parallel with other reads" },
    {
        slug: "memory_write",
        note: "mutating: serialises, holds a reserved write slot, never retried",
    },
    {
        slug: "artifact_read",
        // Pinned by default rather than offered as a choice, and that is not the usual bias here.
        // Compaction is always on — the thresholds are manifest values with defaults — so a generated
        // agent will eventually replace a large tool result with a pointer whether or not anyone
        // decided anything. Without this tool that pointer names an id nothing can resolve: the
        // model is told detail was removed and given no way to get it back, which is worse than
        // either having the tool or never seeing the marker.
        note: "read-only: follows the pointer compaction leaves behind",
    },
]

/** Exported so the drift test can compare against core without re-deriving the mapping. */
export const INIT_LOCAL_TOOL_SLUGS: readonly string[] = INIT_LOCAL_TOOLS.map((tool) => tool.slug)

export type PresetId = "openai" | "anthropic" | "deepseek" | "ollama" | "custom"

export interface Preset {
    readonly id: PresetId
    readonly label: string
    /** Empty for `custom`, which has no defaults to offer. */
    readonly modelId: string
    readonly baseUrl: string
    /** Absent means the manifest omits `apiKeyEnv` entirely — a keyless local endpoint. */
    readonly apiKeyEnv?: string
}

/**
 * The same presets the examples' `.env.example` documents, plus Ollama, which the examples only
 * mention in prose. `custom` exists so an unlisted endpoint is a first-class answer rather than
 * a fight with the nearest preset.
 */
export const PRESETS: readonly Preset[] = [
    {
        id: "openai",
        label: "OpenAI",
        modelId: "gpt-5-6-sol",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "anthropic",
        label: "Anthropic (OpenAI-compatible endpoint)",
        modelId: "claude-sonnet-5",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        modelId: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "ollama",
        label: "Ollama (local, no key)",
        modelId: "qwen3.5:9b",
        baseUrl: "http://localhost:11434/v1",
    },
    {
        id: "custom",
        label: "custom OpenAI-compatible endpoint or OpenRouter",
        modelId: "",
        baseUrl: "",
        apiKeyEnv: "MODEL_API_KEY",
    },
] as const

export function presetById(id: string): Preset | undefined {
    return PRESETS.find((preset) => preset.id === id)
}

export interface InitAnswers {
    /** The person's name. */
    readonly user: string
    /** The agent's name. Drives the manifest `id` and the default directory. */
    readonly name: string
    /** One line: what the agent is for. */
    readonly purpose: string
    readonly preset: PresetId
    readonly model: string
    readonly baseUrl: string
    /**
     * The env var the manifest names. Absent = the manifest omits the field entirely (a keyless
     * endpoint). Set from `--api-key-env` or the preset, never asked: which *variable* holds the
     * key is a detail of the generated file, and asking for it while asking for every other value
     * outright is the confusing shape this replaced.
     */
    readonly apiKeyEnv?: string
    /**
     * The key itself. Written to the gitignored `.env` beside the manifest, never to `agent.yaml`
     * — hard rule 10 is about what the *manifest* contains, and it still holds: the manifest names
     * the variable, this fills it in.
     *
     * Empty is a legitimate answer for anyone who exports the variable another way, and the next
     * steps keep saying so.
     */
    readonly apiKey?: string
    /**
     * How much of this machine the agent may touch: `none`, `read`, or `full`.
     *
     * Asked rather than left as a commented block, because the block was the bug. The generated
     * manifest named neither the provider nor the tools, so shell access was reachable only by
     * someone who already knew the field names — which is the opposite of what a generated file is
     * for. The answer writes real config, permission rules included, and `none` writes the same
     * block commented out so the shape is still there to uncomment.
     */
    readonly system: string
    /**
     * Whether it can reach the internet: `none`, `fetch`, or `search`.
     *
     * Asked for the same reason `system` is, and found the same way. The web provider was generated
     * commented out, so asked whether it could search the web an agent answered that the only route
     * was shell access and `curl` — a correct reading of its own catalogue and a false statement
     * about the runtime. Every capability this runtime has is a question here now; a generated file
     * that hides its own options is not doing the job a generated file exists for.
     */
    readonly web: string
    /** Which search backend, when `web` is `search`. Ignored otherwise. */
    readonly webBackend?: string
    /**
     * The search key itself, written to the gitignored `.env` beside the manifest. Same rule as the
     * model key: the manifest names the variable, no flag accepts the value.
     */
    readonly webKey?: string
    /**
     * Whether the agent reaches the person's other apps through Composio: `none` or `connected`.
     *
     * A question for the same reason `system` and `web` are — the provider shipped finished and
     * generated as a single commented line, which is the third time a built capability reached a
     * generated manifest hidden. What differs is what the answer can *do*, and the difference is
     * real rather than an inconsistency to iron out: see `COMPOSIO_CHOICES`.
     */
    readonly composio: string
    /**
     * The Composio key, written to the gitignored `.env`. Same rule as every other secret here: the
     * manifest names the variable, no flag accepts the value.
     */
    readonly composioKey?: string
    /**
     * Whether people can message it on Telegram: `none` or `connected`.
     *
     * A question for the same reason `system`, `web` and `composio` are, and found the same way —
     * Phase 4 shipped the channel and `init` generated it commented, so the only route to a working
     * bot was knowing the field names. It is the fourth time a finished capability reached a
     * generated manifest hidden, which is why the rule is now standing rather than case by case.
     */
    readonly telegram: string
    /**
     * The bot token, written to the gitignored `.env`. Same rule as every other secret: the
     * manifest names the variable, no flag accepts the value.
     */
    readonly telegramToken?: string
    /**
     * Who may message it — one Telegram handle, or empty.
     *
     * Empty is a real answer and a safe one: `allowFrom: []` permits nobody, and the first message
     * from anyone prints the exact line to add. That is a better first run than guessing a handle
     * into the file, because a wrong handle fails the same way an empty list does and says less.
     */
    readonly telegramAllow?: string
    /**
     * Whether to serve the HTTP API: `none` or `local`.
     *
     * `local` binds loopback. A public bind is a deliberate edit afterwards, and it refuses to
     * start without a token — which is why the generated `.env` gets one rather than an empty line.
     */
    readonly server: string
    /**
     * The API token, generated rather than asked. Not a third-party credential and not a choice —
     * `openssl rand -hex 32` is what someone does by hand here, so the command does it.
     */
    readonly serverToken?: string
    /**
     * Whether to keep it running in the background: `none` or `service`.
     *
     * Writes nothing — see `DAEMON_CHOICES`. It decides whether the last screen names the command,
     * which is the whole of its job: `serve` dies with its terminal, and nothing in the flow said so.
     */
    readonly daemon: string
    /**
     * Whether the agent gets a skills directory: `none` or `starter`.
     *
     * `none` still writes the block and an empty directory rather than omitting it. A configured-and-empty
     * directory is a switch that is off, which slot 2 reports as such; no block at all is a concept the
     * agent does not have and will not ask about — decision 5.19, and the same reason `--system none`
     * still names its provider.
     */
    readonly skills: string
    /**
     * Words to search the skill sources for. **Set by `--skills "<phrase>"` and never asked.**
     *
     * It was a wizard question for exactly one commit, and that was the wrong answer to "ask about skills
     * during init": a text box asking what the agent does often, in a tree that already had a catalogue
     * picker. At a terminal `find` now shows the real list and this stays empty. It survives for the
     * scripted path, where a picker cannot run — the ranking is the same `bm25Selector` that decides
     * activation, so what a CI run installs is what will fire.
     */
    readonly skillsSearch?: string
    /**
     * Comma-separated `<source>/<skill>` refs the person ticked in the wizard's catalogue step.
     *
     * Not in `STEP_ORDER` and never produced by `nextQuestion`: the catalogue is a *screen*, not a question,
     * and `nextQuestion` is pure and synchronous. The wizard root fetches, shows the checklist, and writes
     * the answer here — which keeps the reducer static-option-only while the flow still contains the list.
     */
    readonly skillsPick?: string
    /** Target directory, as given — the command resolves it against the cwd. */
    readonly dir: string
}

/**
 * What web access an agent may be given, and what each answer pins.
 *
 * `none` still names the provider, exactly as `--system none` does — naming is what makes
 * `available()` run, and `available()` is the only reason the model can say "web_search exists and is
 * not enabled for me" rather than "I cannot search the web".
 *
 * `fetch` is separated from `search` because they have genuinely different costs: `web_fetch` needs
 * no account anywhere, and `web_search` needs a key from a third party. Collapsing them would force
 * anyone who wants to hand their agent a URL to go and sign up for something first.
 */
export const WEB_CHOICES: readonly {
    readonly value: string
    readonly label: string
    readonly pinned: readonly string[]
}[] = [
    {
        value: "none",
        label: "No — but it will know the web tools exist and can ask you to enable them",
        pinned: [],
    },
    {
        value: "fetch",
        label: "Read pages — it can open a URL you give it. No account or key needed",
        pinned: ["web_fetch"],
    },
    {
        value: "search",
        label: "Search and read — needs an API key from a search provider",
        pinned: ["web_search", "web_fetch"],
    },
]

export function webChoice(value: string): (typeof WEB_CHOICES)[number] | undefined {
    return WEB_CHOICES.find((choice) => choice.value === value)
}

/** The search backends, with the variable each conventionally reads. */
export const WEB_BACKENDS: readonly {
    readonly value: string
    readonly label: string
    readonly apiKeyEnv: string
}[] = [
    {
        value: "tavily",
        label: "Tavily — built for agents, generous free tier",
        apiKeyEnv: "TAVILY_API_KEY",
    },
    { value: "brave", label: "Brave Search", apiKeyEnv: "BRAVE_API_KEY" },
    { value: "exa", label: "Exa — neural search, returns page excerpts", apiKeyEnv: "EXA_API_KEY" },
]

export function webBackendByValue(value: string): (typeof WEB_BACKENDS)[number] | undefined {
    return WEB_BACKENDS.find((backend) => backend.value === value)
}

/** The variable the Composio provider reads when the manifest names none. Its own default. */
export const COMPOSIO_KEY_ENV = "COMPOSIO_API_KEY"

/**
 * Whether the agent is wired to the person's other apps, and what `connected` actually pins.
 *
 * **It pins two tools, and neither is an app tool.** `composio_search` finds the tools a task needs
 * and records their definitions; `composio_connect` returns the sign-in link for an account. Between
 * them the agent gets from "connect my Gmail" to a pinned, working `GMAIL_SEND_EMAIL` without anyone
 * opening a dashboard: it searches, hands over the link, writes the slug into `tools.pinned` with
 * `config_set`, and asks for a restart.
 *
 * The restart is the design rather than a limitation worked around. Decision 4.7 fixes the working
 * set at load because search-then-execute is two-hop reasoning and small models fail it — and that
 * still holds, because this is *setup*, which happens once, at the moment a person is already
 * pausing to click an OAuth link. What is deliberately absent is a `composio_execute(slug, args)`
 * that runs anything discovered: that would make every Composio task two-hop, forever, on every
 * model.
 *
 * The route this replaces was not a worse route, it was **no route**. `tools --warm` refreshes the
 * slugs already in `pinned`, so a slug had to be known before it could be warmed and warmed before
 * it could be pinned — the only way in was composio.dev in a browser, and nothing said so. An agent
 * asked to connect a Gmail account spent 4,417 output tokens establishing that.
 *
 * `none` names the provider with nothing pinned, exactly as `web` does. It did not while this
 * provider had no `available()` worth calling; three fixed meta tools changed that premise, and
 * "I could search your apps if you enable composio_search" is the sentence `available()` exists for.
 */
export const COMPOSIO_CHOICES: readonly {
    readonly value: string
    readonly label: string
    readonly pinned: readonly string[]
}[] = [
    {
        value: "none",
        label: "No — but it will know the route exists and can tell you how to switch it on",
        pinned: [],
    },
    {
        value: "connected",
        label: "Yes — Gmail, Slack, Notion and ~1,000 more, via a Composio account",
        // Not the workbench. It runs Python somewhere no rule written in this manifest can reach —
        // a broader grant than `exec`, and one that belongs behind a deliberate edit rather than an
        // answer to "can it use your other apps?".
        pinned: ["composio_search", "composio_connect"],
    },
]

export function composioChoice(value: string): (typeof COMPOSIO_CHOICES)[number] | undefined {
    return COMPOSIO_CHOICES.find((choice) => choice.value === value)
}

/**
 * What system access an agent may be given, and what each answer pins.
 *
 * Three rather than two because "can it read my files" and "can it change them" are genuinely
 * different questions, and collapsing them forces anyone who wants a reviewer or a summariser to
 * grant a shell they never needed.
 */
export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN"

/**
 * Whether the agent is reachable on Telegram.
 *
 * Unlike `web` and `system`, `none` writes nothing live: a channel has no `available()` for the
 * model to read, so naming a switched-off one would buy none of what naming a provider buys. It
 * writes the same block commented, with a heading that does not end in a colon — uncommenting one
 * that did turned the heading itself into a YAML key, which is a papercut this generated exactly
 * once before someone hit it.
 */
export const TELEGRAM_CHOICES: readonly {
    readonly value: string
    readonly label: string
}[] = [
    { value: "none", label: "No — it is reachable through the CLI and the API only" },
    { value: "connected", label: "Yes — a Telegram bot, long-poll (needs no public URL)" },
]

export function telegramChoice(value: string): (typeof TELEGRAM_CHOICES)[number] | undefined {
    return TELEGRAM_CHOICES.find((choice) => choice.value === value)
}

/**
 * Whether to serve the HTTP surface.
 *
 * Loopback only. Binding a public host is a deliberate edit, and it refuses to start without a
 * token — so the generated `.env` carries a real one rather than an empty line to fill in. That is
 * the one secret this command can legitimately mint: it is ours, not a third party's, and there is
 * no shell-history risk because nothing types it.
 */
export const SERVER_CHOICES: readonly {
    readonly value: string
    readonly label: string
}[] = [
    { value: "none", label: "No" },
    { value: "local", label: "Yes — HTTP, SSE and WebSocket on 127.0.0.1:7420" },
]

export function serverChoice(value: string): (typeof SERVER_CHOICES)[number] | undefined {
    return SERVER_CHOICES.find((choice) => choice.value === value)
}

/**
 * Whether this agent should keep running without a terminal.
 *
 * The answer writes **nothing** — no service, no manifest field. Not a service, because at this
 * point in the flow the `.env` is still empty of the bot token in the common case, and the install
 * check that exists to catch exactly that would fail; installing anyway would produce a service
 * that fails from birth, which is the failure this whole capability was designed against. Not a
 * manifest field, because whether *this machine* supervises the agent is a fact about the machine
 * and would make the manifest non-portable.
 *
 * What it changes is the last screen: the command appears in the next steps, at the moment it
 * becomes runnable. A capability reachable only by someone who already knows the field names is a
 * capability the generated file is hiding — the standing rule that put `system`, `web` and Composio
 * in here too.
 */
export const DAEMON_CHOICES: readonly {
    readonly value: string
    readonly label: string
}[] = [
    { value: "none", label: "No — it runs while you have `serve` open in a terminal" },
    { value: "service", label: "Yes — in the background: starts at login, restarts on crash" },
]

export function daemonChoice(value: string): (typeof DAEMON_CHOICES)[number] | undefined {
    return DAEMON_CHOICES.find((choice) => choice.value === value)
}

/**
 * Whether to scaffold a skills directory, and what to put in it.
 *
 * A question rather than a field to discover, per the standing rule: every capability the runtime has is
 * asked about here. `starter` writes one worked skill because an empty directory teaches nothing about the
 * format, and the format has parts — the `metadata` key for negative guidance, the fact that the body is
 * injected verbatim — that a person will not guess.
 */
export const SKILLS_CHOICES: readonly {
    readonly value: string
    readonly label: string
}[] = [
    {
        // First, because it is the only answer that produces a working procedure — and the label says
        // what it costs, since the catalogues are ~40 MB fetched once per machine and shared by every
        // agent on it, not per agent.
        value: "find",
        label: "Yes — pick from the catalogue: real skills, tick as many as you want",
    },
    { value: "starter", label: "Yes — with one worked example to copy" },
    { value: "none", label: "An empty directory — the concept is there, the procedures are not" },
]

export function skillsChoice(value: string): (typeof SKILLS_CHOICES)[number] | undefined {
    return SKILLS_CHOICES.find((choice) => choice.value === value)
}

export const SYSTEM_CHOICES: readonly {
    readonly value: string
    readonly label: string
    readonly pinned: readonly string[]
    /** Mutating slugs that need an allow rule, or the first untrusted read gates them. */
    readonly allow: readonly string[]
}[] = [
    {
        value: "none",
        label: "No — it can talk and remember, and change its own settings when you ask",
        /**
         * Not empty, and the emptiness was the bug.
         *
         * With nothing pinned there is no provider, so `available()` is never called and the agent is
         * never told the file tools exist — asked to create a file it said "I don't have a tool that
         * touches your file system", which is true and useless. Asked to enable one it said the tools
         * are fixed at startup, which was also true and is the thing that was supposed to be fixed.
         *
         * So every level, including this one, can read its own configuration and change it when asked.
         * That is the whole of "it should always be able to update its own configuration" — and this is
         * the level where it matters most, because it is the only route out of it.
         */
        pinned: ["config_read", "config_set"],
        allow: ["memory_write", "config_set"],
    },
    {
        value: "read",
        label: "Read only — it can read and search files, but change nothing",
        // `config_read` on every level above `none`: without it the agent cannot tell you which
        // setting to change when a request needs a tool it does not have, which is the whole point of
        // telling it that the tool exists.
        pinned: ["file_read", "glob", "grep", "config_read", "config_set"],
        // `memory_write` is mutating and a file read taints the turn, so without this the agent
        // could read one file and then never save a note again for the rest of that turn.
        allow: ["memory_write", "config_set"],
    },
    {
        // The level that makes confinement *real*. `full` pins `exec`, and a shell carries its target
        // inside a string no path check can look inside — so the write root binds the file tools and
        // not the shell. Verified live: a full agent refused a `file_write` outside the root and then
        // did the same thing with `echo … >`. Anyone who wants "only inside workspace/, never
        // anywhere" and means it wants this level, and there was no way to ask for it.
        value: "write",
        label: "Read and write files — confined to its own workspace, no shell",
        pinned: [
            "file_read",
            "file_write",
            "file_edit",
            "glob",
            "grep",
            "config_read",
            "config_set",
        ],
        allow: ["memory_write", "file_write", "file_edit", "config_set"],
    },
    {
        value: "full",
        label: "Yes — read and write files, run commands, and change its own configuration",
        pinned: [
            "file_read",
            "file_write",
            "file_edit",
            "glob",
            "grep",
            "exec",
            "config_read",
            "config_set",
        ],
        allow: ["memory_write", "file_write", "file_edit", "exec", "config_set"],
    },
]

export function systemChoice(value: string) {
    return SYSTEM_CHOICES.find((choice) => choice.value === value)
}

export type InitStep = keyof InitAnswers

/**
 * Answers as they accumulate: every step is a string until `complete` narrows them, because they
 * arrive from readline and flags as text and are validated per step, not per type.
 */
export type PartialAnswers = Partial<Record<InitStep, string>>

/** The asking order. `apiKeyEnv` is skipped when the chosen preset is keyless. */
const STEP_ORDER: readonly InitStep[] = [
    "user",
    "name",
    "purpose",
    "preset",
    "model",
    "baseUrl",
    "apiKey",
    "system",
    "web",
    "webBackend",
    "webKey",
    "composio",
    "composioKey",
    "telegram",
    "telegramAllow",
    "telegramToken",
    "server",
    "skills",
    "daemon",
    "dir",
]

/**
 * Steps whose answer must never be echoed, logged, or shown in a summary.
 *
 * The renderer reads this rather than special-casing a slug, so a second secret question later
 * cannot be added without the masking coming with it.
 */
export const SECRET_STEPS: ReadonlySet<InitStep> = new Set<InitStep>([
    "apiKey",
    "webKey",
    "composioKey",
    "telegramToken",
])

export interface Question {
    readonly step: InitStep
    /** One line, printed before the input prompt. */
    readonly prompt: string
    /** Offered default; empty string means the answer is required — unless `optional`. */
    readonly fallback: string
    /**
     * An empty answer is a real answer here, not a missing one.
     *
     * Stated rather than inferred from an empty fallback: those two things look identical and mean
     * opposite things to the non-interactive path, which must refuse for one and proceed for the
     * other.
     */
    readonly optional?: boolean
    /**
     * Present when the answer is one of a fixed set, which the renderer draws as a list rather than
     * a text field.
     *
     * On the question rather than hardcoded in the wizard: the preset menu was the only select for
     * three phases, and "is this the preset step" was written into the reducer, the renderer and the
     * cursor-prefill in three separate places. A second select had to either repeat all three or
     * generalise them, and generalising is what stops a third one repeating them again.
     */
    readonly options?: readonly { readonly value: string; readonly label: string }[]
}

/**
 * The manifest `id` and default directory name, from the agent's name.
 *
 * Kebab-case because the id is a slug (session keys, API paths) and the directory is typed into
 * shells. A name that reduces to nothing ("!!!") falls back to "agent" rather than producing an
 * invalid id.
 */
export function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    return slug === "" ? "agent" : slug
}

/**
 * The next unanswered question, or undefined when the flow is complete.
 *
 * Model and base URL default from the chosen preset, so at a TTY the happy path is naming two
 * people and pressing return a few times. `custom` offers no defaults — an unlisted endpoint has
 * nothing honest to prefill.
 */
export interface QuestionDefaults {
    /**
     * Where agents live when nobody says otherwise — the command layer passes the sandbox's
     * agents directory. Passed in rather than computed because this module is PURE: it may not
     * touch the filesystem, the home directory, or the environment.
     */
    readonly agentDirBase?: string
}

export function nextQuestion(
    partial: PartialAnswers,
    defaults: QuestionDefaults = {},
): Question | undefined {
    const preset = partial.preset === undefined ? undefined : presetById(partial.preset)

    for (const step of STEP_ORDER) {
        if (partial[step] !== undefined) continue
        // A keyless preset asks no key question. An explicit --api-key-env still lands in
        // `partial` before this runs, so the deliberate keyed-proxy override survives the skip.
        if (step === "apiKey" && preset !== undefined && preset.apiKeyEnv === undefined) {
            continue
        }
        // The backend and its key are only questions for someone who asked for search. Skipped
        // rather than asked-and-ignored: an answer the flow discards is a question that lies.
        if ((step === "webBackend" || step === "webKey") && partial.web !== "search") continue
        // Same rule: nobody who said no to Composio is asked for a Composio key.
        if (step === "composioKey" && partial.composio !== "connected") continue
        // And nobody who said no to Telegram is asked for a bot token or an allowlist.
        if (
            (step === "telegramToken" || step === "telegramAllow") &&
            partial.telegram !== "connected"
        ) {
            continue
        }
        // And nobody with neither a channel nor a server is asked about a background service —
        // there would be nothing for it to keep up, which is the same refusal `daemon install`
        // makes. An answer the flow discards is a question that lies.
        if (step === "daemon" && partial.telegram !== "connected" && partial.server !== "local") {
            continue
        }

        switch (step) {
            case "user":
                return { step, prompt: "Your name", fallback: "" }
            case "name":
                return { step, prompt: "The agent's name", fallback: "" }
            case "purpose":
                return {
                    step,
                    prompt: "What is it for, in one line",
                    fallback: "helping with whatever comes up",
                }
            case "preset":
                return {
                    step,
                    // Short title plus `options`, rather than a prompt with the menu baked into it.
                    // The menu text was written for a renderer that never used it — the wizard drew
                    // its own list from PRESETS — so the choices lived in two places and only one of
                    // them was ever read. One source now, and `system` gets the same treatment for
                    // free rather than adding a second special case.
                    prompt: "Model endpoint",
                    fallback: "1",
                    options: PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
                }
            case "model":
                return { step, prompt: "Model id", fallback: preset?.modelId ?? "" }
            case "baseUrl":
                return { step, prompt: "Base URL", fallback: preset?.baseUrl ?? "" }
            case "apiKey":
                return {
                    step,
                    prompt: `Model API key`,
                    // Empty is allowed and means "I supply it another way" — the next steps then
                    // say where to put it. There is deliberately no flag for this: a key passed on
                    // the command line lands in shell history, which is why `--yes` takes the empty
                    // answer rather than refusing for want of one.
                    fallback: "",
                    optional: true,
                }
            case "system":
                return {
                    step,
                    prompt: "Can it act on this computer?",
                    fallback: "1",
                    options: SYSTEM_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "web":
                return {
                    step,
                    prompt: "Can it reach the internet?",
                    fallback: "1",
                    options: WEB_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "webBackend":
                return {
                    step,
                    prompt: "Search backend",
                    fallback: "1",
                    options: WEB_BACKENDS.map((backend) => ({
                        value: backend.value,
                        label: backend.label,
                    })),
                }
            case "webKey":
                return {
                    step,
                    prompt: `${webBackendByValue(partial.webBackend ?? "tavily")?.label.split(" —")[0] ?? "Search"} API key`,
                    // Empty is a real answer, exactly as it is for the model key: the variable can be
                    // exported another way, and the next steps say where it goes. No flag, for the
                    // same reason — a key on the command line lands in shell history.
                    fallback: "",
                    optional: true,
                }
            case "composio":
                return {
                    step,
                    prompt: "Can it use your other apps?",
                    fallback: "1",
                    options: COMPOSIO_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "composioKey":
                return {
                    step,
                    prompt: "Composio API key",
                    // Empty is a real answer, as everywhere else a secret is asked for. There is no
                    // flag for the value — a key on a command line lands in shell history.
                    fallback: "",
                    optional: true,
                }
            case "telegram":
                return {
                    step,
                    prompt: "Can people message it on Telegram?",
                    fallback: "1",
                    options: TELEGRAM_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "telegramAllow":
                return {
                    step,
                    prompt: "Your Telegram handle — who may message it",
                    // Empty permits nobody, which is the safe default and a workable first run:
                    // the first message from anyone is refused with the exact line to add.
                    fallback: "",
                    optional: true,
                }
            case "telegramToken":
                return {
                    step,
                    prompt: "Telegram bot token (from @BotFather)",
                    // Empty is a real answer, as everywhere else a secret is asked for, and there
                    // is no flag — a token on a command line lands in shell history.
                    fallback: "",
                    optional: true,
                }
            case "server":
                return {
                    step,
                    prompt: "Serve the HTTP API?",
                    fallback: "1",
                    options: SERVER_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "skills":
                return {
                    step,
                    prompt: "Give it a skills directory? A skill is a procedure it follows when the turn calls for one.",
                    // A name rather than `"1"`, which decouples the default from the order on screen —
                    // and that separation is the point. `find` is listed first because it is the answer
                    // that produces a working agent, and pressing enter on a labelled option that says
                    // "downloads" is consent. The *fallback* stays `starter`, so `--yes` and every
                    // non-interactive run reach no network: a scripted init that silently clones two
                    // repositories is a surprise nobody asked for.
                    fallback: "starter",
                    options: SKILLS_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "daemon":
                return {
                    step,
                    prompt: "Keep it running in the background?",
                    fallback: "1",
                    options: DAEMON_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
                }
            case "dir":
                return {
                    step,
                    prompt: "Directory to create",
                    // Plain "/" concatenation is deliberate: node's fs accepts it on every
                    // platform, and a PURE module cannot import node:path to join.
                    fallback:
                        partial.name === undefined
                            ? ""
                            : defaults.agentDirBase === undefined
                              ? `./${slugify(partial.name)}`
                              : `${defaults.agentDirBase}/${slugify(partial.name)}`,
                }
        }
    }

    return undefined
}

/**
 * Is this a handle Telegram could actually issue, normalised to a leading `@`?
 *
 * Exported and shared because two surfaces ask it — `init` when the handle is typed, and `config
 * allow` when one is added later — and *a check only one of them performs is a check they disagree
 * with*. That is the `ruleBudgetFailure` lesson: the rule guard first lived in `Agent.create` alone,
 * and `validate` happily reported ok on a manifest `run` refused.
 *
 * Checked against Telegram's real username rule: letters, digits and underscores, five to thirty-two
 * of them. Not pedantry — a hyphen cannot occur in a real handle, so `@ada-lovelace` matches nobody,
 * and the only symptom is the bot silently refusing every message from the one person it was set up
 * for. That refusal names the problem perfectly and writes it to a log file, which under a background
 * service nobody opens. The moment it is typed is the only cheap place to catch it.
 */
export function telegramHandle(raw: string): Answered {
    const handle = raw.trim()
    if (/\s/.test(handle)) {
        return { ok: false, reason: "is one handle, with no spaces — for example @moeen." }
    }
    const bare = handle.startsWith("@") ? handle.slice(1) : handle
    if (!/^[A-Za-z0-9_]{5,32}$/.test(bare)) {
        return {
            ok: false,
            reason: /-/.test(bare)
                ? "contains a hyphen, and a Telegram handle cannot — they are letters, digits and underscores only. Did you mean an underscore?"
                : "is not a Telegram handle: 5-32 characters, letters, digits and underscores only. Leave it empty to allow nobody for now.",
        }
    }
    return { ok: true, value: `@${bare}` }
}

export type Answered =
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: string }

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/**
 * Per-step validation, with the loader's own rules applied early.
 *
 * The base-URL checks are the same two `manifest/validate.ts` enforces at load — failing here,
 * at the question, beats generating a directory whose first validate names the mistake back.
 */
export function validateAnswer(step: InitStep, raw: string): Answered {
    const value = raw.trim()

    switch (step) {
        case "user":
        case "name":
        case "model":
        case "purpose":
            return value === "" ? { ok: false, reason: "cannot be empty." } : { ok: true, value }

        case "preset": {
            const byNumber = PRESETS[Number(value) - 1]
            const chosen = byNumber ?? presetById(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${PRESETS.length}, or a name: ${PRESETS.map((p) => p.id).join(", ")}.`,
                  }
                : { ok: true, value: chosen.id }
        }

        case "web": {
            const byNumber = WEB_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? webChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${WEB_CHOICES.length}, or a name: ${WEB_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "webBackend": {
            const byNumber = WEB_BACKENDS[Number(value) - 1]
            const chosen = byNumber ?? webBackendByValue(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${WEB_BACKENDS.length}, or a name: ${WEB_BACKENDS.map((b) => b.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "webKey":
        case "composioKey":
        case "telegramToken":
            return { ok: true, value }

        case "telegramAllow": {
            // Empty permits nobody, which is a real and safe answer. A handle is normalised to a
            // leading `@` so the file reads the way a person writes it — matching folds case and
            // treats the prefix as optional either way, so this is cosmetic rather than load-bearing.
            const handle = value.trim()
            if (handle === "") return { ok: true, value: "" }
            return telegramHandle(handle)
        }

        case "telegram": {
            const byNumber = TELEGRAM_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? telegramChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${TELEGRAM_CHOICES.length}, or a name: ${TELEGRAM_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "server": {
            const byNumber = SERVER_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? serverChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${SERVER_CHOICES.length}, or a name: ${SERVER_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "skillsPick":
            // Refs the wizard collected from its own checklist. Nothing to validate: they came from the
            // catalogue this process just read, not from a person typing.
            return { ok: true, value: value.trim() }
        case "skillsSearch":
            // Flag-only, and never refused. `--skills "pdf tables"` is the scripted path where a picker
            // cannot run; at a terminal this step is not asked at all, because `find` shows the catalogue.
            return { ok: true, value: value.trim() }
        case "skills": {
            const byNumber = SKILLS_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? skillsChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${SKILLS_CHOICES.length}, or a name: ${SKILLS_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "daemon": {
            const byNumber = DAEMON_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? daemonChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${DAEMON_CHOICES.length}, or a name: ${DAEMON_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "composio": {
            const byNumber = COMPOSIO_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? composioChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${COMPOSIO_CHOICES.length}, or a name: ${COMPOSIO_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "baseUrl": {
            let url: URL
            try {
                url = new URL(value)
            } catch {
                return {
                    ok: false,
                    reason: "must be an absolute URL, e.g. https://api.example.com/v1.",
                }
            }
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                return { ok: false, reason: "only http and https are supported." }
            }
            if (url.pathname.endsWith("/chat/completions")) {
                return {
                    ok: false,
                    reason: "must end at the version segment — the runtime appends /chat/completions itself.",
                }
            }
            return { ok: true, value }
        }

        case "apiKeyEnv":
            return ENV_NAME.test(value)
                ? { ok: true, value }
                : { ok: false, reason: "must be an env var name, like MODEL_API_KEY." }

        case "apiKey":
            // Never rejected. Key formats differ per vendor and change without notice, so a shape
            // check here would refuse a valid key on the vendor's say-so — and the endpoint gives
            // an honest 401 on the first turn anyway. Empty means "not now".
            return { ok: true, value }

        case "serverToken":
            // Never asked — generated by the command, so there is nothing here to reject. Present
            // so the switch stays exhaustive over InitStep, which is what makes adding a step
            // without validating it a compile error rather than a silent pass-through.
            return { ok: true, value }

        case "system": {
            const byNumber = SYSTEM_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? systemChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${SYSTEM_CHOICES.length}, or a name: ${SYSTEM_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "dir":
            return value === "" ? { ok: false, reason: "cannot be empty." } : { ok: true, value }
    }
}

/**
 * The whole `providers` map and the `pinned` list under it.
 *
 * One block rather than three, because there is one `providers:` key: system is the one the wizard
 * asks about, and web and Composio sit beside it commented, at the indentation that makes them work.
 * A generated file whose other options live somewhere the reader has to assemble is the failure this
 * exists to prevent — the previous template mentioned neither the provider nor a single tool slug, so
 * the only way to reach shell access was to already know the field names.
 *
 * `none` still writes the map, commented, with the exact lines to uncomment.
 */
function systemBlock(answers: InitAnswers): readonly string[] {
    const system = answers.system
    const choice = systemChoice(system) ?? SYSTEM_CHOICES[0]
    const shell = choice?.pinned.includes("exec") === true
    const files = choice?.pinned.includes("file_read") === true
    const writes = choice?.pinned.includes("file_write") === true

    const intro: readonly string[] =
        choice === undefined || choice.pinned.length === 0
            ? [`  # Nothing is enabled. Add tools here and permit them in the policy block below.`]
            : !files
              ? [
                    // The configuration-only level. Everything the agent lacks is still named to it, so
                    // "I can't do that" becomes "I can't do that yet, and here is the line that would
                    // let me" — and `config_set` is what writes that line when you say go ahead.
                    `  # This agent cannot read, write or run anything. It CAN read this file and change it when`,
                    `  # you ask — which is how you turn the rest on without editing YAML yourself.`,
                    `  #`,
                    `  # It is told which tools exist and are not enabled, so ask it for something it cannot do`,
                    `  # and it will name the tool and offer to add it. A change takes effect on the next start.`,
                    `  #`,
                    `  # To enable them by hand instead, add to pinned:`,
                    `  #   file_read, glob, grep      read and search files`,
                    `  #   file_write, file_edit      change files, confined to workspace/`,
                    `  #   exec                       run shell commands — the confinement does not bind it`,
                ]
              : shell
                ? [
                      `  # This agent can read and change files and run shell commands. What it may run is decided`,
                      `  # by the policy block below — narrow it, and prefer the file tools over the shell, whose`,
                      `  # target a rule cannot see inside a command string.`,
                      `  #`,
                      `  # Writes are confined to workspace/. To open another directory, give the system`,
                      `  # provider a writeRoots list — the agent cannot add one to itself, by design.`,
                      `  # That confinement binds the file tools and NOT exec, whose target lives inside a`,
                      `  # shell string no path check can see.`,
                  ]
                : writes
                  ? [
                        // The level where "only inside workspace/" is a true sentence, and the only
                        // one — which is the whole reason it exists. Saying so here is the point:
                        // this text used to be the read-only paragraph, so a `--system write` agent
                        // was generated with a comment claiming it could change nothing.
                        `  # This agent can read files and change them, and cannot run commands. That combination`,
                        `  # is the only one in which "confined to workspace/" is a true statement — a shell`,
                        `  # carries its target inside a string no path check can look inside.`,
                        `  #`,
                        `  # To open another directory, give the system provider a writeRoots list. The agent`,
                        `  # cannot add one to itself, by design.`,
                    ]
                  : [
                        `  # This agent can read and search files and change nothing. Reading is still not nothing:`,
                        `  # anything it reads can carry text a stranger wrote, which is why the write gate exists.`,
                        `  #`,
                        `  # Reading is not confined; changing things would be, but nothing here changes things.`,
                    ]

    // Every level pins something — `none` still gets `config_read`/`config_set`, which is the only
    // route out of `none` — so the provider and the list are always written, never commented.
    const pinned = choice?.pinned ?? []
    const webPinned = webChoice(answers.web)?.pinned ?? []
    const backend = searchBackend(answers)

    return [
        `  # ── providers: where tools come from ──`,
        ...intro,
        `  #`,
        `  # Several may be configured at once — this is a map, not a choice. Each block is that`,
        `  # provider's own configuration and it refuses a key it does not read.`,
        `  providers:`,
        `    system: {}`,
        ...(shell
            ? [
                  `    #   system: { writeRoots: [~/code/my-project] }  # absolute, or relative to this file`,
              ]
            : []),
        ``,
        // Always named, whatever the answer — naming a provider is what lets the agent be TOLD its
        // tools exist. Left commented out, asked whether it could search the web an agent answered
        // that the only route was shell access and curl: true of its catalogue, false of this
        // runtime, and the worse of the two answers.
        ...(webPinned.length === 0
            ? [
                  `    # Named with nothing pinned. It cannot reach the internet, and it knows the two`,
                  `    # tools exist and will tell you which one to enable rather than saying it can't.`,
                  `    # web_fetch needs no key; web_search needs one, named here:`,
                  `    #   web: { backend: tavily, apiKeyEnv: TAVILY_API_KEY }   # tavily | brave | exa`,
                  `    web: {}`,
              ]
            : backend === undefined
              ? [
                    `    # Reading pages only. No key and no account: web_fetch takes a URL you or the`,
                    `    # person gave it. To add search, pick a backend and name its variable:`,
                    `    #   web: { backend: tavily, apiKeyEnv: TAVILY_API_KEY }   # tavily | brave | exa`,
                    `    web: {}`,
                ]
              : [
                    `    # Search and page reading. The key lives in the .env beside this file; this names`,
                    `    # only the variable, and a literal key here fails validation.`,
                    `    web:`,
                    `      backend: ${backend.value}`,
                    `      apiKeyEnv: ${backend.apiKeyEnv}`,
                ]),
        `    # Addresses on this machine or this network are refused and no setting permits them.`,
        `    # Neither tool can change anything, but what they return is text a stranger wrote — so it`,
        `    # is fenced as data, and a tool that CHANGES something needs an allow rule after one runs.`,
        ``,
        ...composioBlock(answers),
        ``,
        `  # What the model is actually given, from any provider above. A slug no configured provider`,
        `  # has fails the load naming it — nothing is ever dropped quietly.`,
        `  pinned:`,
        ...pinned.map((slug) => `    - ${slug}`),
        ...webPinned.map((slug) => `    - ${slug}`),
        ...(webPinned.includes("web_search") ? [] : [`    # - web_search`]),
        ...(webPinned.includes("web_fetch") ? [] : [`    # - web_fetch`]),
        ...composioPinned(answers).map((slug) => `    - ${slug}`),
        ...(composioEnabled(answers)
            ? [
                  `    # App tools land here once composio_search has found them — ask the agent for what`,
                  `    # you want and it writes the slug itself. A slug typed in by hand needs`,
                  `    # \`${BRAND.slug} tools . --warm\` first: boot resolves from a cache and makes no`,
                  `    # request, so an unwarmed slug fails the load rather than fetching.`,
                  `    # - GMAIL_FETCH_EMAILS`,
                  `    # - composio_workbench   # runs Python in Composio's sandbox, under no rule here`,
              ]
            : [`    # - GMAIL_FETCH_EMAILS`]),
    ]
}

/** Whether this agent was wired to Composio. One reading, so no caller re-derives it. */
export function composioEnabled(answers: InitAnswers): boolean {
    return answers.composio === "connected"
}

/** The Composio meta tools this answer pins. Empty for `none`. */
export function composioPinned(answers: InitAnswers): readonly string[] {
    return composioChoice(answers.composio)?.pinned ?? []
}

/**
 * Which pinned meta tools need an allow rule.
 *
 * A list rather than a `!== "composio_search"` test, so adding a third meta tool is a decision
 * someone makes here rather than a default they inherit by omission. Pinned by a test against the
 * provider's own specs, because a tool that becomes mutating later and is not listed here goes back
 * to stopping mid-turn with nothing explaining why.
 */
const MUTATING_META: readonly string[] = ["composio_connect", "composio_workbench"]

function isMutatingMeta(slug: string): boolean {
    return MUTATING_META.includes(slug)
}

/**
 * The Composio entry in the `providers` map — named either way, configured when asked for.
 *
 * `none` used to leave it commented, because a provider holding 25,000 tools had no `available()`
 * worth calling and naming it told the model nothing. The meta tools changed that premise: the agent
 * can now say "I could search your apps if you switch this on", which is the entire reason decision
 * 4.53 names a provider that is switched off.
 */
function composioBlock(answers: InitAnswers): readonly string[] {
    const shared = [
        `    # Your other apps — Gmail, Slack, Notion, ~1,000 more — through a Composio account.`,
        `    # Two tools do the setup: composio_search finds what a task needs and saves the`,
        `    # definitions, composio_connect returns the sign-in link. Ask the agent for an app and it`,
        `    # pins the slug itself with config_set; the new tool is live after a restart.`,
    ]

    if (!composioEnabled(answers)) {
        return [
            ...shared,
            `    # Named with nothing pinned, so it knows the route exists and can tell you the line`,
            `    # to add. To switch it on: pin the two tools below, put a key in .env, and give this`,
            `    # block the two settings shown here.`,
            `    #   composio: { apiKeyEnv: ${COMPOSIO_KEY_ENV}, userId: default }`,
            `    composio: {}`,
        ]
    }

    return [
        ...shared,
        `    composio:`,
        `      apiKeyEnv: ${COMPOSIO_KEY_ENV}`,
        `      # Whose accounts these are, in Composio's terms — not a name of yours. One person on`,
        `      # one machine wants "default", and a connection made under it is reused by every later`,
        `      # session. Change it only to keep two people's accounts apart on one agent.`,
        `      userId: default`,
    ]
}

/**
 * The permission rules, and the `allow` entries without which the agent stops working mid-turn.
 *
 * Those entries look like they weaken the gate and are what makes it usable: a mutating call in a
 * turn that has already read a file needs a rule naming the tool, and a blanket `mode` is the
 * absence of one. Generated with the comment explaining what removing them costs, because the
 * alternative — a fresh agent that reads one file and then refuses to save a note — reads as a
 * broken runtime rather than as a security setting.
 */
function policyBlock(answers: InitAnswers): readonly string[] {
    const choice = systemChoice(answers.system) ?? SYSTEM_CHOICES[0]
    const shell = choice?.pinned.includes("exec") === true
    // `composio_connect` is mutating and `composio_search` is untrusted, so the first search taints
    // the turn and the connect that has to follow it has nothing to point at. That is the gate
    // working exactly as designed and indistinguishable from a broken runtime while the one useful
    // sequence — find the app, hand over the sign-in link — stops halfway through.
    const allow = [...(choice?.allow ?? []), ...composioPinned(answers).filter(isMutatingMeta)]

    const lines = [
        `  # ── which calls run, which ask, and which are refused ──`,
        `  # deny wins over allow, first match, and being more specific never reorders that. A rule`,
        `  # naming a primary content field — exec(command:rm *) — is refused at load, because a`,
        `  # compound command defeats it and a rule that can be defeated reads as protection.`,
        `  #`,
        `  # Below every setting here is a floor that cannot be lowered: rm -rf / and rm -rf ~,`,
        `  # --no-preserve-root, fork bombs, mkfs, and dd to a block device are never permitted.`,
        `  policy:`,
        `    mode: allow                 # allow | ask | deny — for calls no rule mentions`,
    ]

    if (allow.length === 0) {
        return [...lines, `    allow: []`, `    deny: []`, `    onNoApprover: deny`]
    }

    return [
        ...lines,
        `    # Authorises these even once untrusted content has entered the turn. Remove one and that`,
        `    # tool stops working for the rest of any turn that has read a file — which is the gate`,
        `    # doing its job, and worth choosing on purpose rather than discovering.`,
        `    allow:`,
        ...allow.map((slug) => `      - "${slug}"`),
        ...(shell
            ? [
                  `    deny:`,
                  `      # Narrow these to taste. A pattern matches the command, and every part of a`,
                  `      # compound must match for an allow — so "git status && rm -rf x" is not allowed`,
                  `      # by exec(git status:*).`,
                  `      - "exec(rm *)"`,
                  `      - "exec(sudo *)"`,
              ]
            : [`    deny: []`]),
        `    onNoApprover: deny          # what "ask" means with nobody to ask — a schedule, a pipe`,
    ]
}

export interface GeneratedFile {
    /** Relative to the target directory. */
    readonly relPath: string
    readonly contents: string
}

/**
 * The full file plan. Pure — the command decides where it lands and whether anything exists.
 *
 * Identity and operations are different files, per the split the wider ecosystem converged
 * on (OpenClaw, soul.md): the soul pair answers *who the agent is*, AGENTS.md answers *what
 * it does and how* — responsibilities, workflow, the memory procedure, and eventually the
 * team routing. They coexist; what must not exist is a second *identity* document.
 */
export function planFiles(answers: InitAnswers): readonly GeneratedFile[] {
    const substitutions = substitutionsFor(answers)
    return [
        { relPath: "agent.yaml", contents: manifestFor(answers) },
        ...(
            [
                "SOUL.md",
                "SOUL.compact.md",
                "AGENTS.md",
                "POLICY.md",
                "USER.md",
                "MEMORY.md",
                "REMINDER.md",
            ] as const
        ).map((name) => ({
            relPath: `workspace/${name}`,
            contents: fillTemplate(WORKSPACE_TEMPLATES[name], substitutions),
        })),
        // `starter` seeds one worked skill; `none` still gets the directory, because `skills.dir`
        // naming a path that does not exist is a load failure and the block is written either way.
        // `.keep` is what makes an empty directory survive a git checkout.
        ...(answers.skills === "starter"
            ? [
                  {
                      relPath: "skills/starter/SKILL.md",
                      contents: fillTemplate(SKILL_TEMPLATE, substitutions),
                  },
              ]
            : [{ relPath: "skills/.keep", contents: "" }]),
        // `knowledge.dir` naming a path that does not exist is a load failure, exactly as with
        // skills, and the block is written either way. `.keep` rather than a README because every
        // *.md* here is an entry and must declare frontmatter keywords — a README.md explaining
        // how to author one would fail the very load it was written to help with.
        { relPath: "knowledge/.keep", contents: "" },
        { relPath: ".env.example", contents: envExampleFor(answers) },
        { relPath: ".env", contents: envFor(answers) },
        // The generated .env carries real endpoint values and eventually a key; a repo-ready
        // directory that would commit it by default is a trap. Kept even in the sandbox —
        // people run `git init` there too.
        { relPath: ".gitignore", contents: ".env\n" },
    ]
}

/**
 * What fills the templates.
 *
 * The wording descends from the filled reference workspace, with pronouns replaced by the
 * user's name — a generated file must not guess anyone's pronouns. The dialogue examples'
 * `INPUT_n`/`REPLY_n` are deliberately absent from this map: they stay placeholders until a
 * person writes real exchanges, and the `workspace` command keeps saying so.
 *
 * Every sentence here is audited against the rule counter (`workspace/rules.ts`): the prose
 * avoids obligation markers and imperative openers, so whichever identity file the soul gate
 * ships, the counted total is 1 (RULE_HONESTY's "don't") against the default budget of 2 —
 * a test pins this, because one synonym swap ("never guess") would silently bust it. Three
 * rules ship; the counter's keyword heuristic sees one, and that is fine — the budget guards
 * against obligation *density*, and the pin is what notices if a rewrite changes the count.
 */
function substitutionsFor(answers: InitAnswers): Record<string, string> {
    const { user, name, purpose } = answers
    // One line each — the rule counter is line-based, and these three survive distillation
    // verbatim into every model's context. REMINDER reuses the confirm rule byte-for-byte:
    // two phrasings of one rule read as two rules. The memory rule exists because the gap
    // it closes was observed, not imagined: a generated agent told a durable fact answered
    // warmly and saved nothing, and the recall the person then saw came from session
    // history — which evaporates on a fresh session. The tool catalogue's whenToUse alone
    // did not move a frontier model to save; the identity file is what sets behaviour.
    const ruleConfirm = `I confirm before anything that sends, spends, schedules, or deletes, because I'm wired into live systems and mistakes there are expensive.`
    const ruleHonesty = `When I don't know something I say so and offer to go find out, rather than producing something plausible and letting ${user} discover the difference later.`
    const ruleMemory = `When ${user} tells me something worth keeping — a fact about them, a preference, a decision — I save it with memory_write in the same turn, because the conversation is not memory and a new session starts without it.`

    return {
        AGENT_NAME: name,
        USER: user,
        // Derived, never written out. The starter skill needs the real metadata key and hard rule 3
        // forbids a source file from spelling the brand — so the template carries a placeholder, quoted
        // because `{{FOO}}: bar` is a YAML flow mapping and fails to parse before substitution.
        WHEN_NOT_TO_USE_KEY: whenNotToUseKey(),
        // `init` scaffolds it as `starter`; `skills new` substitutes the name it was given.
        SKILL_NAME: "starter",
        RULE_CONFIRM: ruleConfirm,
        RULE_HONESTY: ruleHonesty,
        RULE_MEMORY: ruleMemory,

        SOUL_WHO:
            `I'm ${name}. I work with ${user}, and this is what I'm for: ${purpose}. ` +
            `The relationship is the point — I'm not a search box; I'm closer to a colleague ` +
            `who holds context so ${user} doesn't have to.`,
        SOUL_MEASURE:
            `The measure of whether I'm working is not how impressive my answers are — it's ` +
            `whether ${user}'s day runs smoother because I was in it.`,
        SOUL_ANSWERS:
            `I lead with the answer and put the reasoning after it, when the reasoning is worth ` +
            `having. Disagreement is part of the job: if I think an idea is bad I say so once, ` +
            `plainly, with the reason, and then help with it anyway if ${user} still wants it. ` +
            `When I'm unsure I name the part I'm unsure about instead of hedging the whole ` +
            `answer into mush — an unhelpful answer isn't the safe one, it just moves the cost ` +
            `somewhere ${user} can't see it.`,
        SOUL_VOICE:
            `I write the way people write to each other: plain sentences, no headers, no bullet ` +
            `lists unless there's genuinely a list. Short is a courtesy. I skip performed ` +
            `enthusiasm and padded pleasantries — warmth, where it shows, is in remembering ` +
            `things ${user} didn't ask me to remember.`,
        SOUL_REFUSE:
            `A yes-machine. The moment I optimise for sounding agreeable over being right, I ` +
            `stop being worth talking to.`,

        SOUL_COMPACT_WHO:
            `I'm ${name}. I work with ${user} — ${purpose}. The measure of whether I'm working ` +
            `is whether ${user}'s day runs smoother because I was in it.`,
        SOUL_COMPACT_ANSWERS:
            `I lead with the answer and put the reasoning after it. When I'm unsure I name the ` +
            `part I'm unsure about instead of hedging the whole answer into mush.`,
        SOUL_COMPACT_VOICE:
            `I write plain sentences: no headers, no bullet lists unless there's genuinely a ` +
            `list. Short is a courtesy.`,

        // AGENTS.md — operations, deliberately personality-free. Declarative first person
        // throughout ("I check…", never "Check…"): an imperative opener or a modal would
        // count against the same rule budget as the soul's <rules> block.
        RESPONSIBILITIES:
            `My job: ${purpose}. A task ${user} hands me stays mine until it's done, handed ` +
            `back, or blocked — and when it's blocked, ${user} hears what's blocking it ` +
            `rather than silence.`,
        WORKFLOW:
            `I look at what I already know — the files in my context and what ${user} told me ` +
            `earlier — before asking ${user} to repeat themselves. For anything with more than ` +
            `one step I say the plan in a line first, so a wrong direction costs one message ` +
            `instead of the whole job. Work that touches live systems goes through the ` +
            `confirmation rule in my identity file.`,
        MEMORY_PROCEDURE:
            `Durable facts about ${user} — names, dates, preferences, decisions — go through ` +
            `memory_write the moment I learn them, into my workspace files. Those files come ` +
            `back to me automatically each turn; when a saved note and what ${user} just said ` +
            `disagree, the person wins and the note gets corrected.`,

        BOUNDARIES:
            `If something involves a person other than ${user}, I ask what they want shared ` +
            `before including it — ${user} knows the relationship and I don't.`,
        UNCERTAINTY_BEHAVIOUR:
            `When I can't reach a tool or a request is ambiguous, I say which part is unclear ` +
            `and ask, because guessing just moves the cost somewhere ${user} can't see it.`,
        USER_FACTS: `${user} is the person I work for.\nWhat they brought me in for: ${purpose}.`,
        REMINDER_RULE: ruleConfirm,
    }
}

/**
 * The generated manifest, in the reference style: everything init configured is live, and
 * everything a later phase delivers is present but commented, labelled with its phase — so the
 * file teaches its own surface. A commented section is REFUSED AT LOAD if uncommented before its
 * phase ships; the runtime never silently ignores configuration.
 *
 * Every mention of the binary interpolates `BRAND.slug` (hard rule 3), and the endpoint values
 * live in `.env` so switching providers never edits this file.
 */
/** One section header, so every generated section is ruled to the same width. */
const rule = (title: string): string =>
    `# \u2500\u2500 ${title} ${"\u2500".repeat(Math.max(1, 88 - title.length))}`

/**
 * The `channels` and `delivery` sections.
 *
 * Live when the answer was `connected`, commented otherwise — a channel has no `available()`, so
 * naming a switched-off one buys none of what naming a switched-off *provider* buys. The commented
 * heading deliberately does not end in a colon: one that did became a YAML key the moment someone
 * uncommented the block, which is how `Unrecognized key: "Phase 4 — channels, delivery, and the
 * HTTP server"` happened to the first person who tried it.
 */
function channelsBlock(answers: InitAnswers): readonly string[] {
    if (answers.telegram !== "connected") {
        return [
            rule("channels — not configured"),
            `# Reachable through the CLI and the API only.`,
            `#`,
            `# You do not have to edit this by hand: ask the agent — "put yourself on Telegram" —`,
            `# and it writes the block below with config_set, then tells you which variable to fill`,
            `# in. Two things stay yours either way, and it will say so rather than doing them:`,
            `# the token, because .env is protected, and allowFrom, because who may talk to it is`,
            `# not its decision. Get a token from @BotFather with /newbot.`,
            `#`,
            `# allowFrom is INBOUND ONLY, and omitting it permits nobody — which is safe and`,
            `# workable: message the bot and the log prints the exact line to paste here.`,
            `# channels:`,
            `#   - type: telegram`,
            `#     id: tg`,
            `#     tokenEnv: ${TELEGRAM_TOKEN_ENV}`,
            `#     mode: longpoll`,
            `#     allowFrom: ["@your-handle"]`,
            `# delivery:`,
            `#   default: tg`,
            ``,
        ]
    }

    const handle = answers.telegramAllow ?? ""
    return [
        rule("channels"),
        `# Long-poll: no public URL, no inbound firewall rule. Switch to webhook by setting`,
        `# mode: webhook and webhookUrl once this runtime has a public HTTPS address.`,
        `#`,
        `# The bot connects AFTER the runtime is ready and never blocks it — a bad token surfaces`,
        `# as an event and the HTTP surface keeps serving. Only \`${BRAND.slug} serve\` starts it;`,
        `# \`${BRAND.slug} run\` builds the same agent with channels switched off.`,
        `channels:`,
        `  - type: telegram`,
        `    id: tg                     # the channel segment of every session key it produces`,
        `    tokenEnv: ${TELEGRAM_TOKEN_ENV}`,
        `    mode: longpoll             # or webhook, with webhookUrl below`,
        `    # webhookUrl: https://your-host/v1/channels/tg/webhook/${slugify(answers.name)}`,
        ...(handle === ""
            ? [
                  `    # INBOUND ONLY, and an empty list permits nobody — which is the safe default.`,
                  `    # Message the bot and the log prints the exact line to paste here.`,
                  `    allowFrom: []`,
              ]
            : [
                  `    # INBOUND ONLY. It grants nothing on delivery, and omitting it permits nobody.`,
                  `    allowFrom: ["${handle}"]`,
              ]),
        ``,
        `# Where a turn with no origin goes — a scheduled run, or an API call asking for delivery.`,
        `delivery:`,
        `  default: tg`,
        ``,
    ]
}

/**
 * The `server` section.
 *
 * Written either way, unlike `channels`: `enabled: false` is a complete and readable statement of
 * the choice, and the fields around it are the ones someone changes next. A public bind refuses to
 * start without a token, which is why the generated `.env` carries a real one.
 */
function serverBlock(answers: InitAnswers): readonly string[] {
    const on = answers.server === "local"
    return [
        rule("http api"),
        `# ${on ? "Loopback only" : 'Off — ask the agent to "turn on your HTTP API" and it flips this'}.`,
        `# A non-loopback host REFUSES to start without a token, and host and tokenEnv are the two`,
        `# fields the agent may not change: an agent that runs shell commands, exposed on 0.0.0.0,`,
        `# looks identical to a safe one until someone finds it.`,
        `server:`,
        `  enabled: ${on}`,
        `  host: 127.0.0.1`,
        `  port: 7420`,
        `  tokenEnv: ${BRAND.envPrefix}API_TOKEN`,
        ``,
    ]
}

function manifestFor(answers: InitAnswers): string {
    const slug = slugify(answers.name)

    const lines = [
        `# ${answers.name} — generated by \`${BRAND.slug} init\`.`,
        `#`,
        `# Everything active below is what init configured; everything commented arrives with the`,
        `# phase named beside it, and is REFUSED AT LOAD if uncommented early — the runtime never`,
        `# silently ignores configuration. docs/02-SPEC-MANIFEST.md is the binding reference.`,
        ``,
        `apiVersion: ${BRAND.apiVersion}`,
        `id: ${slug}`,
        `name: ${answers.name}`,
        ``,
        rule("model"),
        `model:`,
        `  main:`,
        // Literal, not \${MODEL_ID}. Which model an agent runs on is not a secret, and hard rule 10
        // governs secrets — so the indirection bought nothing and cost three things: the sandbox
        // picker listed every agent as "\${MODEL_ID}" because `readManifestHeader` deliberately does
        // not expand; a stray .env in the directory you launched from silently changed the model,
        // and with it the resolved contextWindow, thinking mode and promptStyle; and `validate`
        // checked whichever agent the ambient environment happened to describe.
        //
        // \${VAR} still expands everywhere. It is simply not what a generated file should reach for
        // when the value is a fact about this agent.
        `    id: ${answers.model}`,
        `    # Must end at the version segment; the runtime appends /chat/completions itself.`,
        `    baseUrl: ${answers.baseUrl}`,
        `    # Both take \${VAR} if you would rather set them from the environment — a container, say.`,
        `    # The KEY never goes here in either form; the manifest names its variable, below.`,
    ]
    if (answers.apiKeyEnv !== undefined) {
        lines.push(
            `    # The *name* of an env var, never a value — a literal key fails validation.`,
            `    apiKeyEnv: ${answers.apiKeyEnv}`,
        )
    }
    lines.push(
        `    temperature: 0.3`,
        `    # reasoningEffort: none   # none | minimal | low | medium | high — a reasoning model`,
        `    #                         # bills its thinking to the output budget; verify per endpoint`,
        `    # topP: 0.95`,
        `    # maxTokens: 4096`,
        `    # streamUsage: true       # OpenAI extension; needed for real token counts on Ollama`,
        `    # Override the shipped capability registry only when it is wrong for your endpoint.`,
        `    # capabilities:`,
        `    #   contextWindow: 32768`,
        `    #   thinking: none        # none | anthropic | openai | deepseek`,
        `    #   promptStyle:          # how workspace files render for this model (Phase 3.5)`,
        `    #     delimiters: plain   # xml | markdown | plain`,
        `    #     intensity: emphatic # emphatic | neutral | soft`,
        ``,
        `  # A cheap model for tool selection and summarisation. \`$ref\` reuses a role.`,
        `  # selector:`,
        `  #   id: a-cheaper-model`,
        `  #   baseUrl: ${answers.baseUrl}`,
        `  # compactor: { $ref: model.selector }`,
        ``,
        rule("context"),
        `context:`,
        `  workspace: ./workspace`,
        ``,
        `  # Tier 0 — cached, read-only. Identity is NOT listed here: the soul below (or its`,
        `  # distilled compact file) ships it. AGENTS.md is operations — what the agent does,`,
        `  # not who it is — which is why the two coexist.`,
        `  static:`,
        `    - AGENTS.md`,
        `    - POLICY.md`,
        ``,
        `  # Tier 1 — after the cache breakpoint, so a memory write never invalidates the prefix.`,
        `  volatile:`,
        `    - USER.md`,
        `    - MEMORY.md`,
        ``,
        `  # Tier 2 — re-asserted after the history, where attention is strongest.`,
        `  reminder: REMINDER.md`,
        ``,
        `  # How much of the window to keep free for the reply, so the prompt cannot crowd it out.`,
        `  # This is NOT a cap on what the model may generate — nothing is sent as max_tokens unless`,
        `  # you set model.main.maxTokens. Generous because a reasoning model thinks here too.`,
        `  reserveOutput: 8192`,
        ``,
        `  # Capability-gated identity: SOUL.md ships only to a model meeting \`requires\`; anything`,
        `  # else gets the hand-edited compact file. Edit SOUL.md first, then re-derive`,
        `  # SOUL.compact.md to match — never the reverse.`,
        `  soul:`,
        `    file: SOUL.md`,
        `    requires: { contextWindow: ">=200000", class: frontier }`,
        `    onUnmet: distill`,
        `    distilled: SOUL.compact.md`,
        ``,
        `  # Defaults shown; uncomment to change. Budgets fail the load naming the file — never`,
        `  # silent truncation.`,
        `  # observationMaxTokens: 2000`,
        `  # budgets: { static: 2000, volatile: 3500, reminder: 500, total: 6000 }`,
        `  # rules:`,
        `  #   perRuleSuccess: 0.90    # measure with \`${BRAND.slug} eval rules\`, do not guess`,
        `  #   reliabilityTarget: 0.80 # at 0.90 per rule this permits TWO rules, not four`,
        `  #   onExceed: fail`,
        ``,
        rule("tools"),
        `tools:`,
        `  # Config only, never auto-detected: behaviour must not drift when the model changes.`,
        `  dialect: nlt`,
        ``,
        `  # Built-in tools, resolved from memory. Never sent to a remote provider.`,
        `  local:`,
        ...INIT_LOCAL_TOOLS.map((tool) => `    - ${tool.slug.padEnd(14)}# ${tool.note}`),
        ``,
        `  budget:`,
        `    max: 24`,
        `    reserveWrite: 6   # slots held for mutating tools so reads cannot starve writes`,
        ``,
        ...systemBlock(answers),
        ``,
        `  # tools.search finds a TOOL in the provider's catalogue — nothing to do with web search.`,
        `  # Off by design in v1: search-then-execute is two-hop reasoning, where small models fail.`,
        `  search:`,
        `    enabled: false`,
        ``,
        ...policyBlock(answers),
        ``,
        `  # ── the write gate ──`,
        `  # A tool whose output came from outside this conversation taints the turn. After that, a`,
        `  # tool that CHANGES something needs explicit authorisation — one of the allow rules above,`,
        `  # or a live approval. "refuse" never prompts, which is what makes it right for a schedule.`,
        `  untrusted:`,
        `    onMutate: refuse            # refuse | confirm | allow`,
        ``,
        rule("limits"),
        `limits:`,
        `  # Generous, because a step budget is not a plan. The old default here was 6 — sized for a`,
        `  # two-tool chain, call/observe/call/observe/reply and one spare — and it cut a real agent`,
        `  # off one step after it had installed the dependency it needed, with the reply ending on`,
        `  # "Let me install it". Real work recovers, and recovery costs steps.`,
        `  maxSteps: 40`,
        `  # This is what catches a model that is stuck rather than working: identical consecutive`,
        `  # calls, same tool AND same arguments. Two is a retry, often correct. Three is a pattern.`,
        `  noProgress:`,
        `    identicalCalls: 3`,
        `  # Both of these were overridden here at 120000 and 30000, tighter than the defaults for no`,
        `  # stated reason — and 6 steps x 30s already exceeded the 120s turn, so the wall clock would`,
        `  # have fired first on slow tools. The schema defaults are 1800000 and 120000; uncomment to`,
        `  # change them rather than to restate them.`,
        `  # turnTimeoutMs: 1800000`,
        `  # toolTimeoutMs: 120000`,
        ``,
        ...channelsBlock(answers),
        ...serverBlock(answers),
        rule("later phases — refused at load until they ship"),
        `# Phase 7 — phase-scoped tool visibility (the strongest published small-model lever)`,
        `# phases:`,
        `#   triage: { entry: true, allow: ["now"] }`,
        `#   act:    { allow: ["*"] }`,
        ``,
        // Written whether or not a starter skill was scaffolded. The directory always exists, so an
        // empty one is a switch that is off — which slot 2 reports as such — rather than a concept the
        // agent does not have and will never ask about.
        `# Skills — procedures the harness selects from the turn's input, at most maxActive per turn.`,
        `# The model does not choose one; ranking happens before the turn. \`skills list\` shows them.`,
        `skills:`,
        `  dir: ./skills`,
        `  maxActive: 1`,
        `  threshold: 0.35        # normalised floor; below it nothing activates`,
        `  #                      # there is no token budget: maxActive is the only limit, and a`,
        `  #                      # skill's size is shown in the catalogue where you choose it`,
        ``,
        // Named and switched on, for the reason the web provider had to learn twice: a capability left
        // commented out is one the model cannot know it lacks, and the only route to it is knowing the
        // field names already. The block it replaced said `k: 6` — a field that does not exist in the
        // schema, so uncommenting it would have failed the load. Nothing checks a comment.
        `# Memory — what carries across sessions. Retrieved per turn and BM25-ranked, never pinned:`,
        `# slot 7 is retrieved, and compaction may drop it. \`memory search <agent> "..."\` shows what a`,
        `# question would recall; \`memory rebuild <agent>\` re-reads the notes and the conversations.`,
        `memory:`,
        `  retriever: fts5`,
        `  dir: ./memory          # where eviction files older notes. Indexed, never carried;`,
        `  #                      # created on first eviction, so its absence is not an error`,
        `  maxActive: 5`,
        `  threshold: 0.2         # same scale as skills.threshold — both go through rank/bm25.ts`,
        `  budget: 2000           # a ceiling, not a target. One exchange bills about 370 tokens`,
        `  includeHistory: true   # index what was said, not only what was deliberately saved.`,
        `  #                      # Tool output is never indexed at any setting: it is where text a`,
        `  #                      # stranger wrote lives, and indexing it outlives the write gate`,
        ``,
        // Named and switched on for the reason skills above is: `knowledge.dir` naming a path that
        // does not exist is a load failure, so the directory is scaffolded and an empty one is a
        // switch that is off rather than a concept the agent does not have. It shipped commented
        // out for three phases behind a "create ./knowledge first" note — which is the same shape
        // as the web provider and memory, a capability reachable only by knowing the field names.
        `# Knowledge — reference material that activates only on the turns that mention it. Tier 3:`,
        `# retrieved, never pinned, outside the workspace budget, and compaction may drop it.`,
        `# Every .md in that directory is an entry and must open with frontmatter naming its`,
        `# keywords, so a plain README.md there fails the load. An entry looks like:`,
        `#   ---`,
        `#   keywords: [invoice, billing, VAT]`,
        `#   ---`,
        `#   Whatever this agent should know whenever one of those words comes up.`,
        `knowledge:`,
        `  dir: ./knowledge`,
        `  maxActive: 2           # entries in one turn`,
        `  budget: 600            # total across them. One entry over this fails the load: it could`,
        `  #                      # never activate, and silently unreachable is the wrong answer.`,
        `  #                      # Matching is whole-word and case-insensitive against the input`,
        ``,
        `# Phase 8 — schedules`,
        `# schedules:`,
        `#   - id: morning-brief`,
        `#     kind: cron`,
        `#     expr: "0 8 * * *"`,
        `#     task: "Summarise the day ahead."`,
        `#     deliver: { channel: tg, to: "@your-handle" }`,
        ``,
        `# Phase 9 — plugins`,
        `# plugins:`,
        `#   - "${BRAND.packageScope}/channel-telegram"`,
        ``,
    )
    return lines.join("\n")
}

function envFor(answers: InitAnswers): string {
    // Secrets and nothing else. The model id and the base URL are facts about this agent and live
    // in agent.yaml where a person reads them; a file that also held them made the manifest
    // unreadable on its own and let any other .env on the machine change which model ran.
    const lines = [
        `# Secrets for this agent. Gitignored, and the only thing that belongs here.`,
        `# Everything else — model, endpoint, tools, permissions — is in agent.yaml.`,
    ]
    if (answers.apiKeyEnv !== undefined) {
        // The value the wizard collected, or an empty line to fill in. This file is gitignored and
        // sits beside the manifest, which is the whole point: the manifest names the variable, the
        // key lives here. A key is still never accepted as a command-line flag — that writes it
        // into shell history — so the scripted path leaves this blank and the next steps say so.
        lines.push(`${answers.apiKeyEnv}=${answers.apiKey ?? ""}`)
    }
    // Only when search was chosen. Writing an empty TAVILY_API_KEY into every agent's .env would put
    // a variable nobody asked for in front of everybody, and `web_search` names the missing one at
    // the moment it is called anyway.
    const backend = searchBackend(answers)
    if (backend !== undefined) {
        lines.push("")
        lines.push(`# ${backend.label.split(" —")[0] ?? backend.value}, for web_search.`)
        lines.push(`${backend.apiKeyEnv}=${answers.webKey ?? ""}`)
    }
    // Same rule again: only written for an agent that asked for it. An empty COMPOSIO_API_KEY in
    // every generated .env is a variable nobody chose, and the provider names the missing one at
    // the moment it needs it anyway.
    if (composioEnabled(answers)) {
        lines.push("")
        lines.push(`# Composio, for your other apps. Needed to warm the cache and to execute.`)
        lines.push(`${COMPOSIO_KEY_ENV}=${answers.composioKey ?? ""}`)
    }
    if (answers.telegram === "connected") {
        lines.push("")
        lines.push(`# Telegram. From @BotFather with /newbot; /revoke invalidates it immediately.`)
        lines.push(`${TELEGRAM_TOKEN_ENV}=${answers.telegramToken ?? ""}`)
    }
    // The one secret here that is *ours* rather than a third party's, so it is generated rather
    // than left blank: a public bind refuses to start without it, and `openssl rand -hex 32` is
    // exactly what someone does by hand at this point.
    if (answers.serverToken !== undefined && answers.serverToken !== "") {
        lines.push("")
        lines.push(`# The HTTP API's bearer token. Generated — replace it whenever you like.`)
        lines.push(`${BRAND.envPrefix}API_TOKEN=${answers.serverToken}`)
    }
    return `${lines.join("\n")}\n`
}

/** The chosen search backend, or undefined when this agent does not search. */
function searchBackend(answers: InitAnswers): (typeof WEB_BACKENDS)[number] | undefined {
    if (answers.web !== "search") return undefined
    return webBackendByValue(answers.webBackend ?? "tavily") ?? WEB_BACKENDS[0]
}

/**
 * The committed template beside the gitignored real thing.
 *
 * Once the model id and the base URL moved into the manifest, this stopped being a menu of endpoints
 * — switching endpoint is now `config_set model.main.id` or two lines in agent.yaml — and became
 * what its name says: the list of variables that must exist, with no values in it.
 */
function envExampleFor(answers: InitAnswers): string {
    const backend = searchBackend(answers)
    const lines = [
        `# Copy to .env beside the manifest and fill in the values. Never commit the copy.`,
        `# Only secrets belong here. The model, the endpoint, the tools and the permissions are all`,
        `# in agent.yaml, where you can read them without opening a second file.`,
        ``,
    ]
    if (answers.apiKeyEnv === undefined) {
        lines.push(
            `# This endpoint needs no key — agent.yaml omits apiKeyEnv entirely, so there is nothing`,
            `# to put here yet. A hosted endpoint would name its variable there and you would set it`,
            `# here, like:`,
            `#   MODEL_API_KEY=`,
        )
    } else {
        lines.push(`${answers.apiKeyEnv}=`)
    }
    if (backend !== undefined) {
        lines.push(``, `# ${backend.label.split(" —")[0] ?? backend.value}, for web_search.`)
        lines.push(`${backend.apiKeyEnv}=`)
    }
    if (composioEnabled(answers)) {
        lines.push(``, `# Composio, for your other apps.`)
        lines.push(`${COMPOSIO_KEY_ENV}=`)
    }
    return `${lines.join("\n")}\n`
}
