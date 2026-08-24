/**
 * `config` — a person changing an agent's settings without hand-editing YAML.
 *
 * ## Why this exists
 *
 * `config_read`/`config_set` shipped in Phase 3.6 and are the *agent's*. There was no equivalent for a
 * person, so the routes were editing `agent.yaml` by hand, re-running `init` into a fresh directory, or
 * asking the agent (which needs `config_set` pinned, a matching allow rule, and a restart).
 *
 * The inversion is the argument for the command. Decision 11.29 reserves `allowFrom`, `server.host`,
 * `server.tokenEnv` and `writeRoots` **for the person**, floored so the agent cannot widen its own
 * reach — and that is right. But the only editor ever built was the agent's, so the fields designated
 * as the person's had the worst ergonomics in the system: unvalidated YAML that fails at the next boot.
 * It compounds with `.env` being protected *precisely* so the agent cannot supply its own secrets,
 * which left the one actor who can fill in `MODEL_API_KEY` with no tool for doing it.
 *
 * ## What this does not own
 *
 * The write. `editManifest` places, validates against the real schema, checks that the providers still
 * resolve, and only then writes — one writer for every surface, because the three that existed made
 * the guarantee depend on which caller you happened to be.
 *
 * ## Why nothing here is floored
 *
 * The agent's floor exists because an agent that could widen its own inbound gate could be *talked
 * into* it by the message it is reading. A person at a terminal is not that threat. Two edits are
 * confirmed rather than refused — `tools.policy.deny` and `onMutate: allow` — and `lib/config-view.ts`
 * decides which, so "what needs a confirmation" is assertable without performing one.
 */

import { readFileSync } from "node:fs"
import {
    HarnessError,
    manifestDocument,
    manifestValueAt,
    nearest,
    parseSettingValue,
    processAlive,
    readManifestHeader,
    type Setting,
    SqliteStore,
    settingByPath,
} from "@dispach/core"
import { applyAllow, applySecret, applySet, checkedHandle } from "#lib/config-apply"
import type { EditorRow } from "#lib/config-editor"
import { agentEnv } from "#lib/config-env"
import { applyEditorRow, currentValues, editorRowsFor } from "#lib/config-rows"
import {
    confirmationFor,
    envNeeds,
    renderChange,
    renderOne,
    renderSettings,
    settablePaths,
    showValue,
    unmet,
} from "#lib/config-view"
import { askSecret, askYesNo } from "#lib/confirm"
import {
    ENTER_ALT_SCREEN,
    EXIT_FAILURE,
    EXIT_OK,
    FALLBACK_COLUMNS,
    MAX_SCREEN_ROWS,
} from "#lib/const"
import { flushOutput, markAltScreen, onExit, restoreTerminal } from "#lib/exit"
import { negotiateKeyboard } from "#lib/keyboard"
import { resolveModeFromProcess } from "#lib/output"
import { bullet, keyValue } from "#lib/render"
import { resolveAgentRef, storePath } from "#lib/sandbox"
import { screenColumns } from "#lib/screen"

export interface ConfigCommandOptions {
    /** `list` | `get` | `set` | `env` | `allow`. */
    readonly action?: string
    /** A path or a sandbox agent name. */
    readonly ref?: string
    /** A setting path, an env variable name, or a handle, depending on the action. */
    readonly name?: string
    readonly value?: string
    readonly channel?: string
    readonly remove?: boolean
    readonly yes?: boolean
    readonly store?: string
    /** Injected by tests. */
    readonly confirm?: (question: string) => Promise<boolean>
    readonly secret?: (question: string) => Promise<string | undefined>
    /**
     * The `<ENVPREFIX>HOME` override that relocates the whole sandbox. **Not** the manifest
     * environment: that one is `ambientEnv`, computed from the resolved path, and answers "is this
     * variable set". Two env concepts in one options object want two names — conflating them has
     * already cost a round, where `skills install` consulted a different registry from `init`.
     */
    readonly sandboxEnv?: Readonly<Record<string, string | undefined>>
    readonly out?: (text: string) => void
}

const ACTIONS = ["list", "get", "set", "env", "allow", "edit"] as const

/**
 * Read the action and the agent out of the positionals, allowing `config <agent>` with no action.
 *
 * The editor is what most people want from this command, so typing its name and an agent has to work.
 * Disambiguated the way this repo already does it twice over: a slash command takes arguments only
 * after a token that is *exactly* a known command, and `resolveAgentRef` lets the filesystem win with a
 * note on genuine ambiguity. Here the six action words win, and anything else is an agent.
 *
 * The collision is an agent literally named after an action, and it gets the note rather than silence —
 * running the wrong thing quietly is the failure worth avoiding, and it does not look wrong in output.
 */
export function readAction(
    first: string | undefined,
    second: string | undefined,
    warn: (line: string) => void = (line) => process.stderr.write(line),
): { readonly action: string; readonly ref: string | undefined } {
    const given = (first ?? "").trim()
    if (given === "") return { action: "edit", ref: undefined }
    if (!ACTIONS.includes(given as (typeof ACTIONS)[number])) {
        return { action: "edit", ref: given }
    }
    if (second !== undefined && ACTIONS.includes(second as (typeof ACTIONS)[number])) {
        // Both words are action names, so one of them is an agent and only the order says which. The
        // first wins, and the note is what stops a silently-wrong run — the same choice
        // `resolveAgentRef` makes for a bare name shadowed by a directory.
        warn(`note: reading "${given}" as the action and "${second}" as the agent\n`)
    }
    if (second === undefined && given !== "list") {
        // A known action word with nothing after it. `config edit` alone is the editor with no agent,
        // which fails later with the usual missing-manifest error; anything else is ambiguous only if an
        // agent has that name, and `resolveAgentRef` is what finds out.
        return { action: given, ref: undefined }
    }
    return { action: given, ref: second }
}

export async function configCommand(options: ConfigCommandOptions): Promise<number> {
    const out = options.out ?? ((text: string) => process.stdout.write(text))
    const action = options.action ?? ""
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        const suggestion = nearest(action, [...ACTIONS])
        throw new HarnessError({
            code: "cli_config_action_unknown",
            message: `"${action}" is not something config does.`,
            hint: `One of: ${ACTIONS.join(", ")}.${
                suggestion === undefined ? "" : ` Did you mean ${suggestion}?`
            }`,
        })
    }

    const manifestPath = resolveAgentRef(options.ref ?? "", options.sandboxEnv)

    switch (action) {
        case "list": {
            out(`${renderSettings(currentValues(manifestPath), manifestPath)}\n`)
            // What is currently missing belongs here rather than on every `set`: this is the command
            // whose job is the overview, and a note repeated on unrelated edits is one nobody reads.
            const missing = unmet(
                envNeeds(manifestDocument(readFileSync(manifestPath, "utf8"))),
                agentEnv(manifestPath),
            )
            for (const need of missing) {
                out(`\n${bullet(`${need.name} is not set — ${need.why}`)}\n`)
                out(`${bullet(`\`config env <agent> ${need.name}\` fills it in`)}\n`)
            }
            return EXIT_OK
        }
        case "get":
            return get(manifestPath, options, out)
        case "set":
            return await set(manifestPath, options, out)
        case "env":
            return await env(manifestPath, options, out)
        case "edit":
            return await edit(manifestPath, options, out)
        default:
            return await allow(manifestPath, options, out)
    }
}

function get(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): number {
    const path = (options.name ?? "").trim()
    const setting = requireSetting(path)
    const row = currentValues(manifestPath).find((entry) => entry.setting.path === setting.path)
    out(`${renderOne(setting, row?.value)}\n`)
    return EXIT_OK
}

function requireSetting(path: string): Setting {
    const found = settingByPath(path)
    if (found !== undefined) return found
    const suggestion = nearest(path, [...settablePaths()])
    throw new HarnessError({
        code: "cli_config_path_unknown",
        message: `"${path}" is not a setting.`,
        hint: `\`config list <agent>\` shows every one with its current value.${
            suggestion === undefined ? "" : ` Did you mean ${suggestion}?`
        }`,
        field: "path",
    })
}

async function set(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    const path = (options.name ?? "").trim()
    const setting = requireSetting(path)

    if (setting.via !== undefined) {
        throw new HarnessError({
            code: "cli_config_needs_action",
            message: `${setting.path} is not set by a dotted path.`,
            hint: `Use \`${setting.via}\` — it lives inside a list entry, and it gets its value checked against the service that issues it rather than written verbatim.`,
            field: "path",
        })
    }
    if (options.value === undefined) {
        throw new HarnessError({
            code: "cli_config_value_missing",
            message: `No value given for ${path}.`,
            hint: `A bare word, a number, a list as ["a", "b"], or a map as {k: v}. \`config get <agent> ${path}\` shows what it is now.`,
            field: "value",
        })
    }

    const value = parseSettingValue(options.value)

    // The confirmation, before anything is read or written. It is not a floor — these edits are the
    // person's to make — but both of them stop a check from running, and an edit whose whole effect is
    // invisible until something exploits it is worth one sentence and a keypress.
    const warning = confirmationFor(setting, value)
    if (warning !== undefined && options.yes !== true) {
        out(`${bullet(warning)}\n`)
        const ask = options.confirm ?? askYesNo
        if (!(await ask(`Change ${setting.path} anyway?`))) {
            out(`${keyValue([{ label: "unchanged", value: setting.path }])}\n`)
            return EXIT_OK
        }
    }

    // The agent's own layered environment, not this process's. `ambientEnv` alone does not do it: it
    // demotes a colliding cwd variable and never adds the agent's own file, so a token sitting beside
    // the manifest read as unset.
    const ambient = agentEnv(manifestPath)
    const before = unmet(
        envNeeds(manifestDocument(readFileSync(manifestPath, "utf8"))),
        ambient,
    ).map((need) => need.name)

    // `applySet` owns the write, so the editor and this command cannot validate a value differently.
    const result = await applySet(manifestPath, path, options.value)

    // Newly required only. Computed either side of the edit rather than guessed from the value, so
    // `server.enabled true` reports the token it has just made load-bearing and `limits.maxSteps 9`
    // reports nothing — which a live run got wrong in the other direction, warning that an agent with
    // a disabled server "will refuse to start".
    const pending = unmet(
        envNeeds(manifestDocument(readFileSync(manifestPath, "utf8"))),
        ambient,
    ).filter((need) => !before.includes(need.name))

    const held = await running(manifestPath, options)
    out(
        `${renderChange({
            path,
            before: result.before,
            after: value,
            file: manifestPath,
            reflowed: result.reflowed,
            ...(held === undefined ? {} : { running: held }),
            pending,
            restartHint: restartHint(held?.mode),
        })}\n`,
    )
    return EXIT_OK
}

/**
 * How this agent comes back, phrased for how it is currently held.
 *
 * All three `RuntimeMode` values, because the generic sentence is useless for two of them. `embedded` is
 * the case that matters most and is easiest to miss: it is *this* session, so the answer is one word the
 * person can type — and a live run reported `pid 90050, embedded` under "it is started again", which is
 * true and gives them nothing.
 */
function restartHint(mode: string | undefined): string {
    if (mode === "daemon") return "`daemon restart <agent>`"
    if (mode === "embedded") return "`/restart` in this session"
    if (mode === "terminal") return "that process being started again"
    return "it is started again"
}

/**
 * A live process holding this agent, or `undefined`.
 *
 * Never a refusal, only a note. Fixing a misconfiguration *while it is running and broken* is the main
 * thing this command is for, so refusing in that state would block the case it exists to serve.
 *
 * Liveness is re-checked rather than trusted: a lease row is a claim, and a boot that failed after
 * claiming leaves a row seconds old with no process under it — which once blocked every retry for
 * ninety seconds while naming a pid that no longer existed.
 */
async function running(
    manifestPath: string,
    options: ConfigCommandOptions,
): Promise<{ readonly pid: number; readonly mode: string } | undefined> {
    let agentId: string | undefined
    try {
        agentId = readManifestHeader(manifestPath).id
    } catch {
        return undefined
    }
    if (agentId === undefined) return undefined

    try {
        const store = await SqliteStore.open({
            path: options.store ?? storePath(options.sandboxEnv),
        })
        try {
            for (const lease of await store.leases.all()) {
                if (lease.agentId !== agentId) continue
                if (!processAlive(lease.pid)) continue
                return { pid: lease.pid, mode: lease.mode }
            }
        } finally {
            await store.close()
        }
    } catch {
        // A missing or unreadable store is not a reason to refuse a manifest edit. The note is a
        // courtesy; the write is the command.
        return undefined
    }
    return undefined
}

/**
 * Put a secret in the `.env` beside the manifest.
 *
 * The value is prompted and never taken from an argument: an argument lands in shell history and in
 * `ps`, readable by every local process for the lifetime of the call. Not a TTY refuses rather than
 * reading a pipe, so a CI run is told nothing was written instead of a secret arriving from a source
 * the caller did not audit.
 *
 * Written 0600 whichever way the file arrived. Under a service manager this file is the *only* path
 * credentials take — launchd hands a job almost no environment and a plist carries none on purpose —
 * so tightening it is right even when this command did not create it.
 */
async function env(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    const name = (options.name ?? "").trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new HarnessError({
            code: "cli_config_env_name_invalid",
            message: `"${name}" is not an environment variable name.`,
            hint: "Letters, digits and underscores, not starting with a digit — MODEL_API_KEY, TELEGRAM_BOT_TOKEN. `config list <agent>` shows which ones this agent names.",
            field: "name",
        })
    }

    // Statically imported, not `await import`. A module reached both ways makes `bun build
    // --splitting` emit its exports twice and the binary refuses to parse — and `bun test` sails
    // through it, because tests import source and the failure is in the bundle. `confirm.ts` pulls in
    // only `node:readline`, so there is nothing to defer.
    const ask = options.secret ?? askSecret
    const value = await ask(`value for ${name} (not echoed):`)
    if (value === undefined) {
        throw new HarnessError({
            code: "cli_config_env_no_value",
            message: `Nothing was written for ${name}.`,
            hint: "A secret is read from a prompt, never from an argument or a pipe — an argument is visible in `ps` and in shell history. Run this at a terminal, or edit the .env beside the manifest yourself.",
        })
    }
    if (value === "") {
        throw new HarnessError({
            code: "cli_config_env_empty",
            message: `An empty value for ${name} would not start the agent.`,
            hint: "A variable set to nothing fails the load exactly as a missing one does. Nothing was written.",
        })
    }

    // The write itself is `applySecret`, which the editor calls too — two callers deciding separately
    // whether to tighten the file's mode is the same class of split as two manifest writers.
    const applied = applySecret(manifestPath, name, value)
    out(`${keyValue([{ label: "set", value: applied.note }])}\n`)
    out(`${bullet("takes effect the next time the agent starts")}\n`)
    return EXIT_OK
}

/**
 * Add or remove a handle on a channel's `allowFrom`.
 *
 * Its own action rather than a `config set` path for two reasons. The source editor matches `key:` at
 * an indent and cannot index a sequence, so the field is not addressable — and rewriting the whole
 * `channels` list to change one handle is the dead end this command exists to remove. The second is
 * better: a handle can be *checked against the service that issues it*, and an impossible one is
 * otherwise a bot that is connected, healthy and silently refusing the one person it was set up for.
 */
async function allow(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    const channels = manifestValueAt(readFileSync(manifestPath, "utf8"), ["channels"])
    if (!Array.isArray(channels) || channels.length === 0) {
        throw new HarnessError({
            code: "cli_config_no_channels",
            message: "This agent has no channels, so there is nobody to allow.",
            hint: "`config set <agent> channels '[{type: telegram, id: tg, tokenEnv: TELEGRAM_BOT_TOKEN, mode: longpoll}]'` declares one first.",
        })
    }

    const entries = channels.filter(
        (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    const ids = entries.map((entry) => String(entry.id ?? "")).filter((id) => id !== "")
    const wanted = options.channel?.trim()
    if (wanted === undefined && entries.length > 1) {
        throw new HarnessError({
            code: "cli_config_channel_ambiguous",
            message: `This agent has ${entries.length} channels, so --channel says which.`,
            hint: `One of: ${ids.join(", ")}.`,
            field: "channel",
        })
    }
    const at =
        wanted === undefined ? 0 : entries.findIndex((entry) => String(entry.id ?? "") === wanted)
    if (at === -1) {
        throw new HarnessError({
            code: "cli_config_channel_unknown",
            message: `No channel with id "${wanted}".`,
            hint: `Declared: ${ids.join(", ")}.${
                nearest(wanted ?? "", ids) === undefined
                    ? ""
                    : ` Did you mean ${nearest(wanted ?? "", ids)}?`
            }`,
            field: "channel",
        })
    }

    const target = entries[at] as Record<string, unknown>
    const handle = checkedHandle(options.name ?? "", String(target.type ?? ""))
    const current = Array.isArray(target.allowFrom) ? target.allowFrom.map(String) : []

    const next =
        options.remove === true
            ? current.filter((entry) => entry !== handle)
            : current.includes(handle)
              ? current
              : [...current, handle]

    if (next.length === current.length && options.remove === true) {
        out(
            `${keyValue([
                { label: "unchanged", value: `${handle} was not on ${String(target.id)}` },
            ])}\n`,
        )
        return EXIT_OK
    }
    if (next.length === current.length) {
        // Idempotent on purpose: running it twice is what somebody does when they are not sure it
        // took, and reporting a second write they did not make would be a small lie.
        out(
            `${keyValue([{ label: "already allowed", value: `${handle} on ${String(target.id)}` }])}\n`,
        )
        return EXIT_OK
    }

    // `applyAllow` owns the write and the handle check, so the editor cannot validate a handle
    // differently from this command. It takes the whole list, because the whole list is what gets
    // written: one entry's key is not addressable by the source editor.
    const result = await applyAllow(manifestPath, String(target.id ?? ""), next)
    const held = await running(manifestPath, options)

    out(
        `${keyValue([
            { label: options.remove === true ? "removed" : "allowed", value: handle },
            { label: "channel", value: String(target.id) },
            { label: "now", value: showValue(next) },
            { label: "file", value: manifestPath },
        ])}\n`,
    )
    if (result.reflowed) {
        out(`${bullet("the file was re-serialised — it is valid, and comments may have moved")}\n`)
    }
    if (held !== undefined) {
        out(
            `${bullet(
                `this agent is running (pid ${held.pid}, ${held.mode}) and holds its settings for its lifetime — the change applies after ${restartHint(held.mode)}`,
            )}\n`,
        )
    }
    return EXIT_OK
}

export const CONFIG_EXIT_FAILURE = EXIT_FAILURE

/**
 * The editor, standalone.
 *
 * Alternate screen, because it waits for keys: it takes the terminal and gives it back. A changed flag
 * comes back through `onDone` so the one line printed afterwards can say a restart is needed — printed
 * on the real screen after the restore, because hard rule 8 does not stop applying when a screen closes.
 */
async function edit(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    // Refused rather than attempted without a terminal. Two things went wrong otherwise, and the second
    // is the serious one: the alternate-screen sequence was written into a *pipe*, and Ink's own "raw
    // mode is not supported" error left the command exiting **0** — a failure that reported success,
    // which hard rule 8 exists to prevent. `browse` and `init` already ask this question the same way.
    const decision = resolveModeFromProcess({ plain: false, json: false, oneShot: false })
    if (decision.mode !== "rich") {
        throw new HarnessError({
            code: "cli_config_edit_needs_terminal",
            message: "The settings editor needs a terminal.",
            hint: `Not one here (${decision.because}). \`config list\` reads them and \`config set\` changes one, both of which work on a pipe.`,
        })
    }

    const [{ render }, { createElement }, { ConfigEditor }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/ConfigEditor"),
    ])

    let changed = false
    let finish: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
        finish = resolve
    })

    markAltScreen()
    process.stdout.write(ENTER_ALT_SCREEN)

    // No wrapper component: the editor is a *view*, so it owns its own state and its single `useInput`,
    // exactly as `SkillBrowser` and `SessionPicker` do. Holding it here needed `useState` in this file,
    // which is a shared command path — and a static React import there costs ~170-210 ms on every
    // command including `validate --json`, which a boundaries test refuses outright.
    const instance = render(
        createElement(ConfigEditor, {
            rows: editorRowsFor(manifestPath),
            apply: (row: EditorRow, raw: string) => applyEditorRow(manifestPath, row, raw),
            reload: () => editorRowsFor(manifestPath),
            // A pty can report `columns === 0`, which `?? fallback` does not cover — measured, and it
            // once laid a picker's rows out for half the terminal, uniformly, on every row.
            columns: screenColumns(process.stdout.columns, FALLBACK_COLUMNS),
            window: MAX_SCREEN_ROWS,
            onDone: (didChange: boolean) => {
                changed = didChange
                finish()
            },
        }),
        { exitOnCtrlC: false, ...negotiateKeyboard() },
    )
    onExit(() => instance.unmount())
    await closed
    instance.unmount()
    restoreTerminal()
    await flushOutput()

    const held = await running(manifestPath, options)
    if (!changed) {
        out(`${keyValue([{ label: "unchanged", value: manifestPath }])}\n`)
        return EXIT_OK
    }
    out(`${keyValue([{ label: "changed", value: manifestPath }])}\n`)
    out(`${bullet(`takes effect after ${restartHint(held?.mode)}`)}\n`)
    return EXIT_OK
}
