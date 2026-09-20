/**
 * The `run` command. Two renderers, one setup.
 *
 * The rich path is the Ink app; the plain path is line-oriented and writes tokens to stdout as they
 * arrive. Which one runs is decided once, by `resolveMode`, and never re-decided mid-process.
 *
 * **Ink is imported lazily, and only on the rich path.** Measured: `react` + `ink` cost ~65 ms to
 * import under Bun and ~170-210 ms under Node, against a ~70 ms total runtime for `validate --json`.
 * A static import at the top of this file would be paid by every invocation of every command, so the
 * dynamic `import()` below is load-bearing rather than stylistic. A test asserts it stays that way.
 *
 * The plain path keeps Phase 1's behaviour deliberately unchanged, including the Ctrl-C contract and
 * the streaming writes, because both were verified against a real endpoint and a real SIGINT.
 */

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { createInterface, type Interface } from "node:readline"
import { createClient } from "@dispach/client"
import {
    type Agent,
    type AnyEvent,
    BRAND,
    defaultStorePath,
    describeWindowSource,
    type ErrorDetail,
    endedBadly,
    endNote,
    HarnessError,
    processAlive,
    Runtime as RuntimeClass,
    VERSION,
    windowReport,
} from "@dispach/core"
import { fetchCatalogue } from "#browse"
import { initInteractive } from "#init"
import { ambientEnv, demotedKeys } from "#lib/ambient"
import { installReport } from "#lib/browse"
import {
    ENTER_ALT_SCREEN,
    EXIT_FAILURE,
    EXIT_OK,
    FALLBACK_COLUMNS,
    PROMPT,
    SESSION_PICKER_ROWS,
} from "#lib/const"
import {
    flushOutput,
    markAltScreen,
    markMouse,
    markTerminalDirty,
    onExit,
    restoreTerminal,
} from "#lib/exit"
import { negotiateKeyboard } from "#lib/keyboard"
import { agentIdFor, hostToken, liveHostOf } from "#lib/lifecycle"
import { ENABLE_MOUSE } from "#lib/mouse"
import { resolveModeFromProcess } from "#lib/output"
import { BUILT_IN_PLUGINS, CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { keyValue } from "#lib/render"
import { priorMessages, reopenNote, resumeNotice } from "#lib/resume"
import { listAgents, storePath } from "#lib/sandbox"
import type { RunOptions } from "#lib/schema"
import { screenColumns } from "#lib/screen"
import {
    type ContextView,
    contextReport,
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    unknownCommandText,
} from "#lib/session-commands"
import { newSessionKey } from "#lib/session-key"
import {
    type AgentSource,
    embeddedSource,
    hostFrom,
    type LiveHost,
    remoteSource,
    type SourceSession,
} from "#lib/source"
import type { CatalogueEntry } from "#lib/source-cache"
import { openTap } from "#lib/stdin-tap"
import type { RenderMode } from "#lib/types"
import { type InstallOutcome, skillsCommand } from "#skills"
import { type PriorMessage, seed, seedHistory } from "#transcript"

/** Opening lines: what is loaded, what session, and whether the last turn finished. */
async function bannerLines(
    agent: Agent,
    sessionKey: string,
    storeLocation: string,
    bootMs: number,
    /**
     * Why this banner is being printed.
     *
     * A boolean answered "is this the first one" and there are now four answers: a `/restart` rebuilt the
     * agent, a session switch rebuilt it to move conversations, and `/new` rebuilt it onto a conversation
     * that did not exist a moment ago. They need different sentences — the restart note is about
     * configuration and would be a lie about a switch — and they agree about the boot number, because in
     * every case the process has been alive for however long the last conversation lasted and
     * time-since-process-start has stopped meaning anything.
     *
     * Closed on purpose: a new reason cannot be added without the compiler demanding a sentence for it.
     */
    reopened: "first" | "restart" | "switch" | "new",
    demoted: readonly string[] = [],
    /**
     * The conversation being left behind, for the one sentence that has to name it.
     *
     * Last, after the defaulted `demoted`: inserted next to `reopened` where it reads best, it would
     * have silently taken the argument the existing call site passes for `demoted`. A positional
     * parameter is added at the end or every caller is re-read.
     */
    previousKey?: string,
) {
    const described = agent.describe()
    const [turns, resumed] = await Promise.all([
        agent.turns(sessionKey, 1),
        agent.store.messages.count(agent.id, sessionKey),
    ])

    // The title first, then the session. The rich path drops the title row — its one-line header restates
    // it, and the two together put the same brand, agent and model on screen twice — so anything that is
    // *not* in that header has to live below it. `window` moved down for exactly that reason: it is a fact
    // about this session's budget rather than part of the title.
    const lines = [
        `${BRAND.name} ${VERSION} · ${described.id} · ${described.model}`,
        `session ${sessionKey} · ${resumed} message(s) · window ${described.window} · store ${storeLocation}`,
        // Points at `/help` rather than listing commands: the list belongs to the table that
        // implements them, and a banner enumerating a subset is the drift this change removed.
        `ready in ${bootMs.toFixed(0)} ms · /help for commands and keys · /exit to leave`,
    ]

    // One function decides the sentence, and it is pure — see `lib/resume.ts`. Written inline here it
    // needed a live agent and a store to reach, so the only part of this banner a person reads was the
    // only part nothing could check.
    const note = reopenNote(reopened, previousKey)
    if (note !== undefined) lines.push(note)

    // Naming a reaped turn is the point of reaping it: the previous run died mid-generation, and the
    // person restarting is the one who needs to know.
    if (turns[0]?.errorCode === "turn_abandoned") {
        lines.push(
            "note: the previous turn in this session did not finish — the process exited while it was generating.",
        )
    }

    // Load warnings, read off the agent rather than caught on the bus.
    //
    // `Runtime.create` emits them as `agent.warning` during boot — which finishes *before* this
    // command subscribes to anything, so every one of them has been landing in an empty room: a
    // trimmed catalogue, a tool declared trusted by its provider, a shell that can only run once a
    // turn. Silent, and precisely the class of thing the loud resolution path exists to prevent.
    //
    // Reading the resolved state instead of racing the bus is also the more honest fix. These are
    // properties of the loaded agent, not events, and something that is true for the whole session
    // belongs where a person will still see it after scrolling.
    for (const warning of [...agent.warnings, ...agent.tools.warnings]) {
        lines.push(`note: ${warning.message}\n      ${warning.hint}`)
    }

    // The other half of the same honesty. Core warns when the environment *took* a variable from the
    // agent's own .env; this says when the CLI decided a .env in the current directory should not
    // have. Someone who just wrote MODEL_ID into a project file and finds their agent ignoring it
    // needs the sentence as much as the person who found their agent obeying it.
    if (demoted.length > 0) {
        lines.push(
            `note: ${demoted.join(", ")} in the .env here ${demoted.length === 1 ? "was" : "were"} ignored — this agent's own .env sets ${demoted.length === 1 ? "it" : "them"}.\n      A .env in the directory you launched from configures that project, not an agent living somewhere else. Export the variable to override the agent's own file.`,
        )
    }

    return lines
}

export async function runCommand(options: RunOptions): Promise<number> {
    const oneShot = options.once !== undefined
    const decision = resolveModeFromProcess({
        json: false,
        plain: options.plain === true,
        oneShot,
    })
    const { mode } = decision

    // No agent named: the sandbox decides. One agent auto-runs; several open the picker at a
    // terminal and list plainly everywhere else; none goes straight to the wizard (rich) or an
    // error naming `init` (plain) — an empty sandbox with no guidance is a dead end.
    if (options.manifestPath === undefined) {
        const picked = await pickFromSandbox(mode, decision.because, options)
        if (typeof picked === "number") return picked
        return runCommand({ ...options, manifestPath: picked })
    }

    // The CLI opts into persistence explicitly — core defaults to memory so that embedding the
    // library never writes to someone's working directory uninvited. The default store lives at
    // the sandbox root: one store for every agent, wherever `run` is invoked from — a cwd-relative
    // default gave the same agent a different session history in every directory.
    const legacy = defaultStorePath()
    if (options.store === undefined && options.ephemeral !== true && existsSync(legacy)) {
        process.stdout.write(
            `note: a session store exists at ${legacy} from an earlier version — pass --store ${legacy} to keep using it; the default is now ${storePath()}\n`,
        )
    }
    // One teardown for however many runtimes this call goes through. Registering inside the loop
    // would hold a reference to every dead one; `Runtime.stop` is already idempotent, so the live
    // reference is the only thing that has to move.
    let current: RuntimeClass | undefined
    onExit(() => current?.stop("cli-exit"))

    // Outlives every runtime this call builds. See `Wired.reader`.
    const reader: { current: Interface | undefined } = { current: undefined }
    // The unsent message, carried across a `/restart` for the same reason the reader is: both belong to
    // the command rather than to one mount, and the restart tears the mount down.
    const draft: { current: string } = { current: "" }

    // Resolved once per call and then carried, because `/restart` must not silently move the conversation.
    //
    // Empty rather than absent means a bare `--session`: "ask me which one". Resolution needs the store, so
    // it happens inside the loop once a runtime exists — and the box is what keeps a picked key stable
    // across a restart, the same reason the reader and the draft live out here.
    const session: { current: string | undefined } = { current: options.sessionKey }
    // Whether the splash stands in for the transcript. Carried beside the key, and both survive a
    // `/restart` — which is not new, so the restarted session goes straight to the conversation.
    const freshSession = { current: false }
    /** The key the last iteration was on, for the `/new` banner. Undefined on the first. */
    const leaving: { current: string | undefined } = { current: undefined }
    const quiet = options.quiet === true
    // Why the loop is on this iteration. `switch` is set by the in-session picker, which reaches the loop
    // the same way `/restart` does — by unmounting — because `useReducer`'s initial state only seeds on
    // mount, so a transcript cannot be re-keyed in place. Rebuilding is a hundred and fifty milliseconds
    // and it re-reads the store, which is exactly what moving to another conversation wants.
    let reopened: "first" | "restart" | "switch" | "new" = "first"
    /**
     * A conversation the running session asked to move to. Applied at the top of the next iteration.
     *
     * Carries its *reason* rather than sitting beside a second `mintedNew` boolean: two pieces of state
     * answering one question is how they come to disagree, and `reopened` is a closed union, so a reason
     * with no banner sentence is a compile error rather than a silent rebuild nobody explains.
     */
    const switchTo: { current: { key: string; reason: "switch" | "new" } | undefined } = {
        current: undefined,
    }

    /**
     * **Attach to a live host, or build a runtime — never both.**
     *
     * This is 17.1, and the sequence that makes it necessary is one command long: `run` declares
     * `needsServer`, so since 16.4 it already installs and starts a server — and then built a
     * *second* runtime for an agent that server was holding. Two processes on one SQLite file are
     * not two views of a conversation; they are two writers, and the runtime said so out loud, in
     * slot 2, to the model (`declined`, decision 5.17).
     *
     * `--ephemeral` is excluded by definition: it asks for an in-memory store, which is a request
     * for a runtime of one's own. Everything else attaches when something is there to attach to,
     * `--input` included — the plan's wording put one-shots on the embedded path, but its stated
     * reason was "starts no channels or schedules", and attaching starts none either. What a
     * one-shot gains is the thing the phase is about: one writer.
     *
     * Nothing here falls back *from* attached to embedded. If a host holds the lease and cannot be
     * reached, that is a fault to report rather than route around: quietly starting a second
     * runtime is exactly the state this removes, and it would look like success.
     */
    const attached =
        options.ephemeral === true
            ? undefined
            : hostFrom(await liveHostOf(agentIdFor(options.manifestPath), options.store))
    if (attached !== undefined) {
        return await runAttached({
            ...options,
            host: attached,
            mode: mode === "rich" ? "rich" : "plain",
            quiet,
            oneShot,
            reader,
            draft,
            session,
            random: randomBytes,
        })
    }

    // `/restart` rebuilds the agent in this process rather than replacing the process.
    //
    // The settings an agent booted with are fixed for its lifetime — the catalogue is resolved once,
    // and slot 1 is rendered once, both deliberately — so a configuration change genuinely needs a new
    // agent and there is no honest way to apply one in place. Re-execing would work and would throw
    // away the terminal; this keeps the scrollback, and the conversation was never in memory anyway.
    for (;;) {
        const runtime = await RuntimeClass.create({
            agents: [options.manifestPath],
            toolProviders: TOOL_PROVIDERS,
            builtInPlugins: BUILT_IN_PLUGINS,
            scriptRunner: scriptRunner(),
            channels: CHANNELS,
            // A `.env` in the directory this was launched from loses to the agent's own. See
            // `lib/ambient.ts` — core's "real environment wins" is untouched; this decides what
            // counts as the real environment.
            env: ambientEnv([options.manifestPath]),
            store: options.ephemeral === true ? ":memory:" : (options.store ?? storePath()),
        })
        current = runtime

        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("The manifest produced no agent.")

        // The conversation this run belongs to.
        //
        // After the runtime, because both interesting answers read the store: `--continue` wants the most
        // recent conversation and a bare `--session` wants the list. Once resolved it is carried, so a
        // `/restart` rebuilds the agent and stays in the same conversation.
        if (session.current === undefined || session.current === "") {
            const resolved = await resolveSession({
                list: () => source.sessions(),
                mode,
                asked: session.current,
                wantsContinue: options.continueSession === true,
                random: randomBytes,
            })
            if (typeof resolved === "number") {
                await runtime.stop("cli-exit")
                return resolved
            }
            session.current = resolved.sessionKey
            freshSession.current = resolved.fresh
        }
        const sessionKey = session.current

        // Reasoning is shown by default on a model that has any.
        //
        // It used to be opt-in behind --show-reasoning, which meant the normal experience of a
        // reasoning model was a cursor sitting still for thirty seconds with nothing to look at,
        // and no indication anything was happening. The thinking is the only signal there is
        // during that time, and it is already being streamed and thrown away. `--no-reasoning`
        // turns it off; `--show-reasoning` stays, and is now a no-op that harms nobody's scripts.
        const reasons = agent.roles.main.capabilities.thinking !== "none"
        const showReasoning = options.noReasoning === true ? false : reasons

        const banner =
            quiet || oneShot
                ? []
                : await bannerLines(
                      agent,
                      sessionKey,
                      runtime.store.location,
                      // After a restart the process has been alive for however long the conversation
                      // lasted, so time-since-process-start stops meaning anything. The first boot
                      // reports it because that is the number the sub-second claim is about.
                      reopened === "first" ? runtime.boot.processMs : runtime.boot.bootMs,
                      reopened,
                      demotedKeys([options.manifestPath]),
                      leaving.current,
                  )

        // The conversation so far, for the rich path only. `history` is the same read `send` performs, so
        // what is painted is exactly what the model is conditioned on — minus the runtime's own messages,
        // which `origin` identifies and which are not part of the conversation a person is resuming.
        // Which origins and roles count, and why each exclusion is deliberate, is `lib/resume.ts` —
        // extracted so it can be tested without standing up a runtime, which is what let the previous
        // two versions of this be wrong in a way only a live resume would show.
        const prior: readonly PriorMessage[] =
            mode === "rich" && !quiet && !oneShot
                ? priorMessages(await agent.history(sessionKey), agent.describe().dialect)
                : []

        const source = embeddedSource({
            agent,
            bus: runtime.bus,
            send: (text, sendOptions) => agent.send(text, sendOptions),
            history: async (key) =>
                priorMessages(await agent.history(key), agent.describe().dialect),
            sessions: async () => await agent.store.sessions.list(agent.id),
            clearSession: async (key) => {
                await agent.clearSession(key)
            },
            context: async (key) => contextViewOf(agent, key),
            streamFilter: () => agent.streamFilter(),
            description: {
                agentId: agent.id,
                name: agent.describe().name,
                model: agent.describe().model,
                dialect: agent.describe().dialect,
                window: agent.describe().window,
                catalogueTokens: agent.describe().catalogueTokens,
                thinking: agent.roles.main.capabilities.thinking,
                // Read off the agent, never caught on the bus: `Runtime.create` emits
                // `agent.warning` during boot, which finishes before anything could subscribe.
                warnings: [...agent.warnings, ...agent.tools.warnings],
            },
        })

        const wired = {
            ...options,
            source,
            embedded: { agent, runtime },
            sessionKey,
            banner,
            prior,
            quiet,
            reader,
            draft,
            showReasoning,
            freshSession: freshSession.current,
            switchTo,
            random: randomBytes,
        }
        const outcome = mode === "rich" ? await runRich(wired) : await runPlain(wired)

        await runtime.stop(outcome === RESTART ? "restart" : "cli-exit")
        if (outcome !== RESTART) return outcome
        if (switchTo.current === undefined) {
            reopened = "restart"
        } else {
            reopened = switchTo.current.reason
            // Read before the key is replaced: the sentence a `/new` prints is about the conversation
            // being left, which is the one thing the next banner cannot derive from its own state.
            leaving.current = sessionKey
            session.current = switchTo.current.key
            switchTo.current = undefined
        }
        // The splash does not come back after a rebuild, even when the key is unchanged and nothing has
        // been sent. The reason for the rebuild is a line in the banner, and a welcome screen in front of it
        // would hide the one sentence explaining what just happened.
        freshSession.current = false
    }
}

/**
 * What a renderer returns when the answer is "build it again", not "we are done".
 *
 * A symbol rather than a magic exit code: every other value this returns is a process exit status, and
 * a status that secretly means something else is the kind of overload that survives until someone
 * returns it by accident.
 */
/** One install per skill, so a partial failure keeps the successful ones with a reason for the rest. */
function installSkills(
    skills: readonly CatalogueEntry[],
    manifestPath: string,
): readonly InstallOutcome[] {
    const outcomes: InstallOutcome[] = []
    for (const entry of skills) {
        skillsCommand({
            action: "install",
            manifestPath,
            name: `${entry.source}/${entry.skill}`,
            quiet: true,
            collect: outcomes,
        })
    }
    return outcomes
}

const RESTART = Symbol("restart")
type RunOutcome = number | typeof RESTART

/**
 * Bare `run`: resolve the sandbox into either a manifest path to run or an exit code.
 *
 * The picker is the third Ink surface, mounted the same lazy way; picking unmounts it before the
 * chat mounts, so the two screens stack naturally in scrollback. "Create a new agent" chains
 * through `initInteractive` — one wizard entry point — and straight into the chat with the result.
 */
async function pickFromSandbox(
    mode: string,
    because: string,
    options: RunOptions,
): Promise<string | number> {
    const agents = listAgents()

    if (agents.length === 0) {
        if (mode === "rich") {
            // First run, empty sandbox: the wizard IS the answer to "run what?".
            const created = await initInteractive({ plain: options.plain === true })
            if (created.kind === "aborted") {
                process.stdout.write("nothing to run\n")
                return EXIT_OK
            }
            if (created.kind === "failed") return created.code
            return created.manifestPath
        }
        throw new HarnessError({
            code: "cli_sandbox_empty",
            message: "No agent named, and the sandbox is empty.",
            hint: `Create one with \`${BRAND.slug} init\`, or pass a path to an agent.yaml.`,
        })
    }

    if (agents.length === 1 && agents[0] !== undefined) {
        // The overwhelmingly common case costs zero keystrokes; saying so keeps it explicable.
        process.stdout.write(`running ${agents[0].ref} — the only agent in the sandbox\n`)
        return agents[0].manifestPath
    }

    if (mode !== "rich") {
        // Scriptable contexts get the list and a non-zero exit: nothing ran.
        for (const agent of agents) {
            process.stdout.write(
                `${agent.ref}\t${agent.problem ?? agent.modelId ?? "?"}\t${agent.dir}\n`,
            )
        }
        process.stderr.write(
            `pass an agent name or a manifest path — the picker needs a terminal (${because})\n`,
        )
        return EXIT_FAILURE
    }

    const [{ render }, { createElement }, { Picker }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/Picker"),
    ])
    let result: { kind: "run"; manifestPath: string } | { kind: "create" } | { kind: "quit" } = {
        kind: "quit",
    }
    // eslint-free narrowing escape: the callback assignment below is invisible to control-flow
    // analysis, so the read after waitUntilExit goes through a widened alias.
    markTerminalDirty()
    const instance = render(
        createElement(Picker, {
            title: `${BRAND.name} ${VERSION}`,
            agents,
            onDone: (picked) => {
                result = picked
            },
        }),
        { exitOnCtrlC: false, ...negotiateKeyboard(options.noEnhancedKeys) },
    )
    onExit(() => instance.unmount())
    await instance.waitUntilExit()
    instance.unmount()

    const picked = result as
        | { kind: "run"; manifestPath: string }
        | { kind: "create" }
        | { kind: "quit" }
    if (picked.kind === "quit") {
        process.stdout.write("nothing run\n")
        return EXIT_OK
    }
    if (picked.kind === "create") {
        const created = await initInteractive({ plain: options.plain === true })
        if (created.kind === "aborted") {
            process.stdout.write("nothing to run\n")
            return EXIT_OK
        }
        if (created.kind === "failed") return created.code
        return created.manifestPath
    }
    return picked.manifestPath
}

/**
 * Which conversation this run belongs to, or an exit code if the answer is "none".
 *
 * Three inputs, and the contradictory pair is refused rather than ranked. `--continue --session x` says
 * both "the most recent one" and "this one"; picking a winner would silently ignore half of what was
 * typed, and there is no reading of it that is obviously intended.
 *
 * The default is a **new** key. That is the behaviour change: every run used to land in `local:default`,
 * so an agent's store was one unbroken transcript and this morning's question was conditioned on
 * yesterday's debugging. It applies to `--input` too, which makes a scripted one-shot stateless unless it
 * names a session — deliberately, because a one-shot that quietly accumulated history grows its own
 * context until compaction starts thrashing, and `--session` is right there for the case somebody wants
 * the thread.
 */
export interface ResolvedSession {
    readonly sessionKey: string
    /**
     * The key was generated for this run, so there is nothing behind it.
     *
     * Carried rather than re-derived from a message count, because the two answers differ: a conversation
     * that was resumed and then cleared has no messages and is not new. This is what puts the splash in
     * front of a new conversation and keeps it away from a resumed one.
     */
    readonly fresh: boolean
}

async function resolveSession(input: {
    /**
     * How to list conversations — not an `Agent`.
     *
     * The only thing this ever wanted from one, and taking the list instead is what lets an
     * attached run reuse it verbatim: it asks the *host* for its sessions, where an embedded run
     * asks its own store. A second copy of this function for the attached path would be a second
     * set of answers to "what does `--continue` mean when there is nothing stored", and those are
     * the cases somebody gets wrong once and never notices.
     */
    readonly list: () => Promise<readonly SourceSession[]>
    readonly mode: RenderMode
    /** `""` for a bare `--session`; `undefined` for not asked at all. */
    readonly asked: string | undefined
    readonly wantsContinue: boolean
    readonly random: (count: number) => Uint8Array
}): Promise<ResolvedSession | number> {
    const fresh = (): ResolvedSession => ({
        sessionKey: newSessionKey(input.random),
        fresh: true,
    })

    if (input.wantsContinue && input.asked === "") {
        throw new HarnessError({
            code: "cli_session_ambiguous",
            message: "--continue and a bare --session ask for different things.",
            hint: "--continue takes the most recent conversation without asking; --session on its own opens the list. Pass one.",
        })
    }

    if (input.wantsContinue) {
        const stored = await input.list()
        const recent = mostRecent(stored)
        if (recent === undefined) {
            // Not an error: an agent you have never talked to has no most-recent conversation, and refusing
            // would make `-c` unusable as a habit — you would have to remember whether this is the first time.
            process.stdout.write(
                "no stored conversation with this agent yet — starting a new one\n",
            )
            return fresh()
        }
        return { sessionKey: recent.sessionKey, fresh: false }
    }

    if (input.asked === "") {
        const stored = await input.list()
        if (stored.length === 0) {
            process.stdout.write(
                "no stored conversation with this agent yet — starting a new one\n",
            )
            return fresh()
        }
        if (input.mode !== "rich") {
            // The plain path lists them and refuses, rather than guessing. Same shape as the agent picker:
            // a surface that needs a keyboard says so and prints what you would have chosen from.
            for (const row of [...stored].sort(byRecency)) {
                process.stdout.write(
                    `${row.sessionKey}\t${row.messages}\t${row.turns}\t${row.lastActivityAt}\n`,
                )
            }
            process.stderr.write(
                "pass --session <key> — the picker needs a terminal, and --continue takes the most recent without one\n",
            )
            return EXIT_FAILURE
        }
        const picked = await pickSession([...stored].sort(byRecency))
        // Esc means "leave things as they are", which for a run that has not started yet is a new
        // conversation rather than no conversation. Quitting would make esc a way to fail to launch.
        return picked === undefined ? fresh() : { sessionKey: picked, fresh: false }
    }

    return input.asked === undefined ? fresh() : { sessionKey: input.asked, fresh: false }
}

/** Most recently touched first. One comparator, so the picker and `--continue` agree about "recent". */
function byRecency(left: SourceSession, right: SourceSession): number {
    return Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
}

function mostRecent(sessions: readonly SourceSession[]): SourceSession | undefined {
    return [...sessions].sort(byRecency)[0]
}

/** The session picker, mounted the same lazy way as every other Ink surface. */
async function pickSession(sessions: readonly SourceSession[]): Promise<string | undefined> {
    const [{ render }, { createElement }, { SessionPicker }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/SessionPicker"),
    ])

    let picked: string | undefined
    markTerminalDirty()
    const instance = render(
        createElement(SessionPicker, {
            sessions: sessions.map((row) => ({
                sessionKey: row.sessionKey,
                messages: row.messages,
                turns: row.turns,
                lastActivityAt: row.lastActivityAt,
                phase: row.phase,
            })),
            now: Date.now(),
            columns: screenColumns(process.stdout.columns, FALLBACK_COLUMNS),
            maxRows: SESSION_PICKER_ROWS,
            onDone: (key) => {
                picked = key
                instance.unmount()
            },
        }),
        { exitOnCtrlC: false, ...negotiateKeyboard() },
    )
    onExit(() => instance.unmount())
    await instance.waitUntilExit()
    return picked
}

/**
 * The banner for an attached run. Shorter than the embedded one, and short for a reason.
 *
 * Three of `bannerLines`' facts are about a runtime *in this process* and would be lies here: the
 * boot figure (nothing booted), the store location (none is open), and any warning read off a live
 * agent at load. What replaces them is the one fact an attached run has and an embedded one does
 * not — **where the agent actually is** — because "this is a view" is only useful if it says a view
 * of *what*, and a pid plus an address is what somebody can act on.
 *
 * Synchronous, unlike its embedded twin: everything it prints came back with the description.
 */
function attachedBanner(
    source: AgentSource,
    sessionKey: string,
    host: LiveHost,
    reopened: "first" | "restart" | "switch" | "new",
    previousKey?: string,
): readonly string[] {
    const described = source.describe()
    const lines = [
        `${BRAND.name} ${VERSION} · ${described.agentId} · ${described.model}`,
        `session ${sessionKey} · window ${described.window} · attached to ${host.baseUrl} (pid ${host.pid})`,
        // The sentence that makes the mode legible. Without it, `/exit` leaving a bot answering
        // Telegram reads as a command that failed to stop something.
        `a view — the agent keeps running when you leave · /help for commands · /exit to detach`,
    ]
    const note = reopenNote(reopened, previousKey)
    if (note !== undefined) lines.push(note)
    // Read off the description rather than caught on the stream: these are emitted during the
    // host's boot, which finished long before this process subscribed to anything.
    for (const warning of described.warnings) lines.push(`warning: ${warning.message}`)
    return lines
}

/**
 * A run that is a **view**: no runtime, no store, no lease.
 *
 * The mirror of the loop below, and deliberately shorter, because most of what that loop does is
 * about owning a runtime. There is no rebuild here — `/restart` asks the host to replace the agent
 * and the screen stays up, since there is nothing in this process to rebuild — so the only reason
 * to go round again is a conversation switch.
 *
 * It opens no database on purpose. Reading history and sessions locally would make the store path a
 * second source of truth that can disagree with the host while both look correct: a stale `--store`
 * would show a different conversation than the one being appended to. The lease carries a
 * `baseUrl` (16.3) precisely so this does not have to guess a port either.
 */
async function runAttached(
    input: RunOptions & {
        readonly host: LiveHost
        readonly mode: "rich" | "plain"
        readonly quiet: boolean
        readonly oneShot: boolean
        readonly reader: { current: Interface | undefined }
        readonly draft: { current: string }
        readonly session: { current: string | undefined }
        readonly random: (count: number) => Uint8Array
    },
): Promise<number> {
    const manifestPath = input.manifestPath ?? ""
    const agentId = agentIdFor(manifestPath)
    // The credential comes from the manifest's *layered* env, which is the same place `serve` read
    // it — never from `ambientEnv`, which answers "what is in this process" and made a token sitting
    // beside the manifest invisible once already.
    const token = hostToken(manifestPath)
    const client = createClient({
        baseUrl: input.host.baseUrl,
        ...(token === undefined ? {} : { token }),
    })

    const described = await client.agent(agentId).describe()
    const source = remoteSource({
        client,
        agentId,
        host: input.host,
        description: {
            agentId,
            name: described.name,
            model: described.model ?? "unknown",
            dialect: described.dialect ?? "nlt",
            window: described.window ?? 0,
            catalogueTokens: described.catalogueTokens ?? 0,
            // Not on the wire: a description says what the agent is, and whether a model reasons is
            // a capability the host resolved. Reasoning streams whenever the host sends it, which
            // is the honest default — `--no-reasoning` still turns it off.
            thinking: "unknown",
            // `WireError` is the client's name for the same `{code, message, hint, field?}`. A
            // cast rather than a remap: remapping four fields by hand is where a `field` goes
            // missing and nothing reports it.
            warnings: (described.warnings ?? []) as readonly ErrorDetail[],
        },
    })

    const switchTo: { current: { key: string; reason: "switch" | "new" } | undefined } = {
        current: undefined,
    }
    let reopened: "first" | "restart" | "switch" | "new" = "first"
    const leaving: { current: string | undefined } = { current: undefined }
    const freshSession = { current: false }

    for (;;) {
        if (input.session.current === undefined || input.session.current === "") {
            const resolved = await resolveSession({
                list: () => source.sessions(),
                mode: input.mode,
                asked: input.session.current,
                wantsContinue: input.continueSession === true,
                random: input.random,
            })
            if (typeof resolved === "number") return resolved
            input.session.current = resolved.sessionKey
            freshSession.current = resolved.fresh
        }
        const sessionKey = input.session.current ?? ""

        const banner =
            input.quiet || input.oneShot
                ? []
                : attachedBanner(source, sessionKey, input.host, reopened, leaving.current)

        const prior =
            input.mode === "rich" && !input.quiet && !input.oneShot
                ? await source.history(sessionKey)
                : []

        const wired: Wired = {
            ...input,
            source,
            sessionKey,
            banner,
            prior,
            quiet: input.quiet,
            reader: input.reader,
            draft: input.draft,
            showReasoning: input.noReasoning !== true,
            freshSession: freshSession.current,
            switchTo,
            random: input.random,
        }
        const outcome = input.mode === "rich" ? await runRich(wired) : await runPlain(wired)
        if (outcome !== RESTART) {
            await source.close()
            return outcome
        }
        // The only way back round: a conversation switch. `/restart` never gets here, because
        // attached it is a request to the host and the screen never comes down.
        if (switchTo.current === undefined) {
            reopened = "restart"
        } else {
            reopened = switchTo.current.reason
            leaving.current = sessionKey
            input.session.current = switchTo.current.key
            switchTo.current = undefined
        }
        freshSession.current = false
    }
}

interface Wired extends RunOptions {
    /**
     * Where the agent is. What the screen gets, and the only one of these two an attached run has.
     *
     * `agent` stays beside it for the helpers that genuinely need a live one — the banner's boot
     * figure, the manifest dump `/status` prints embedded. Those are facts about a runtime *in this
     * process*, so an attached run answers them differently rather than not at all.
     */
    readonly source: AgentSource
    /**
     * The live runtime, when this process is the one hosting.
     *
     * **Absent when attached**, which is the shape of the whole change: a view of somebody else's
     * agent has no `Agent` object and no store handle, and the compiler is what stops a helper
     * quietly reaching for one. Everything the screen needs goes through `source`; what is left
     * here are the facts that are only true of a runtime *in this process* — the boot figure, and
     * the manifest dump `/status` prints embedded.
     */
    readonly embedded?: { readonly agent: Agent; readonly runtime: RuntimeClass }
    /**
     * Resolved, not the raw flag: on by default for a model that reasons, off under
     * `--no-reasoning`. Narrowed to a required boolean here so no renderer has to re-decide.
     */
    readonly showReasoning: boolean
    readonly sessionKey: string
    readonly banner: readonly string[]
    readonly quiet: boolean
    /** The session key was generated for this run, so the splash stands in for an empty transcript. */
    readonly freshSession: boolean
    /**
     * The conversation as it already stands, for the rich path to paint.
     *
     * Read here rather than inside the component because the host owns the store. Empty on a fresh
     * session, and empty on the plain path deliberately: `--plain` has to match a pipe byte for byte,
     * and a piped REPL replaying its own history would change what every existing script reads.
     */
    readonly prior: readonly PriorMessage[]
    /**
     * Where the running session asked to move to, and why. Read by the loop, not by the renderer.
     *
     * The reason rides with the key because the loop has to tell a `/sessions` switch from a `/new`, and
     * a second boolean beside this box would be a second answer to one question.
     */
    readonly switchTo: { current: { key: string; reason: "switch" | "new" } | undefined }
    /** Six bytes, injected so a test gets the key it asked for. `randomBytes` in production. */
    readonly random: (count: number) => Uint8Array
    /**
     * The line reader, owned by `runCommand` so it survives a `/restart`.
     *
     * Rebuilding it per runtime is the obvious thing and it breaks: a second `createInterface` over a
     * pipe that the first one already read to EOF returns immediately, so everything after `/restart`
     * is silently dropped. A terminal probably tolerates it — and "probably" is the problem, since it
     * cannot be tested where there is no tty. Sharing one reader removes the difference rather than
     * betting on it.
     */
    readonly reader: { current: Interface | undefined }
    /** The unsent message, surviving a restart. Empty on a fresh run. */
    readonly draft: { current: string }
}

/**
 * The Ink app.
 *
 * `exitOnCtrlC: false` is not optional. Ink's default is to handle Ctrl-C itself and exit the
 * process, which would silently undo the contract Phase 1 established and measured — Ctrl-C cancels
 * the turn, not the process — and the failure would look like "cancellation kills the session".
 */
async function runRich(wired: Wired): Promise<RunOutcome> {
    const [{ render }, { createElement }, { App }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/App"),
    ])

    // The session takes the whole terminal.
    //
    // `markAltScreen` before the sequence, not after: it is what teaches every exit route — an explicit
    // `finish`, a signal, a crash guard, `process.on("exit")` — to swap back out. Setting it and failing
    // to enter would be the worse order, because a `1049l` sent to a terminal that never entered the
    // buffer clears the output that was just written to it.
    //
    // The buffer is discarded on the way out and never joins the scrollback, which is the whole point and
    // also the cost: the conversation is gone from the screen the moment the session ends. That is what
    // the pointer line below exists for, and what makes `^C` take two presses.
    // Before `render`, which is the whole point: two listeners on one `data` event both receive the
    // chunk, ordering is registration order, and this one has to have parsed a sequence before Ink's
    // handler fires for it. `lib/csi.ts` says what it is for — Ink merges the super bit into `meta`, so
    // without this `cmd+←` is `⌥←`.
    const tap = openTap()
    onExit(() => {
        tap.close()
    })

    markAltScreen()
    // Tracking with the buffer swap, and only here: the chat is the one surface whose keymap claims every
    // mouse report, and a surface that asked for them without claiming them would have Ink type them into
    // it as text. `markMouse` is what teaches every exit route to switch it off again — including a crash,
    // because leaving it on hands the shell a terminal that reports clicks into its prompt.
    markMouse()
    process.stdout.write(`${ENTER_ALT_SCREEN}${ENABLE_MOUSE}`)

    let restart = false
    const instance = render(
        createElement(App, {
            source: wired.source,
            onSwitch: (sessionKey: string, draft: string) => {
                // The same route a `/restart` takes, for the reason stated at `reopened`: a transcript
                // cannot be re-keyed in place, so the conversation moves by rebuilding.
                restart = true
                wired.switchTo.current = { key: sessionKey, reason: "switch" }
                wired.draft.current = draft
            },
            onNew: (draft: string) => {
                // Identical to `onSwitch` but for a key that did not exist a moment ago. Minted here
                // rather than in the component: `run.ts` owns the randomness and its injection point,
                // and a component that reaches for crypto is one no test can pin to a known key.
                restart = true
                wired.switchTo.current = { key: newSessionKey(wired.random), reason: "new" }
                wired.draft.current = draft
            },
            sessions: async () => {
                // Through the source, so an attached view lists the conversations the *host* has
                // rather than whatever a local store happens to hold. That is the whole reason an
                // attached run opens no database: two readings of "which conversations exist" can
                // disagree while both look correct, and only one of them is being written to.
                const stored = await wired.source.sessions()
                return [...stored].sort(byRecency).map((row) => ({
                    sessionKey: row.sessionKey,
                    messages: row.messages,
                    turns: row.turns,
                    lastActivityAt: row.lastActivityAt,
                    phase: row.phase,
                }))
            },
            onRestart: (draft: string) => {
                restart = true
                // Written into the box the loop owns, the same way the readline instance is carried.
                // A local would be lost the moment this function returns, which is exactly when the
                // next mount needs it.
                wired.draft.current = draft
            },
            sessionKey: wired.sessionKey,
            model: wired.source.describe().model,
            agentName: wired.source.describe().agentId,
            // Only before the first message, and only in a conversation with nothing behind it.
            freshSession: wired.freshSession,
            // The count in the one-line header. The messages themselves are in the banner, which scrolls;
            // on a surface with no scrollback a session-wide fact that has scrolled away is a fact nobody
            // has, so the header keeps the number and says where to find the text.
            warnings: wired.source.describe().warnings.map((warning) => warning.message),
            // Without the title row: `titleLine` above the transcript already carries the brand, the
            // agent and the model, and printing both put one sentence on screen twice — measured at 100
            // columns, rows 6 and 8 of a fresh session. The plain path keeps it, because there is no
            // header there and it is the only place the version appears.
            initial: seedHistory(seed(wired.banner.slice(1)), wired.prior),
            correctKeys: tap.correct,
            showReasoning: wired.showReasoning,
            quiet: wired.quiet,
            // So a slash command runs against *this* agent: without it a child would resolve whichever
            // agent the cwd suggests, which would not look wrong in the output.
            ...(wired.manifestPath === undefined ? {} : { manifestPath: wired.manifestPath }),
            // The host owns the filesystem and the network; the screen owns neither. Injected here rather
            // than imported by the component, which also keeps `browse.ts` out of its import graph.
            catalogue: {
                load: (onStatus: (line: string) => void) => fetchCatalogue({ onStatus }),
                install: async (skills, into) => installReport(installSkills(skills, into)),
            },
            // The same definition the plain REPL calls at its own `/status`, reached through a callback
            // rather than by handing the component a runtime — one function, two callers, so the two
            // paths cannot come to disagree about whether a channel is connected.
            // Two statuses, chosen by which kind of run this is — never one with half its
            // sentences blanked. See `attachedStatus`.
            status: () =>
                wired.embedded === undefined
                    ? attachedStatus(wired.source)
                    : sessionStatus(wired.embedded),
            contextView: () => sessionContext(wired, wired.sessionKey),
            ...(wired.draft.current === "" ? {} : { initialDraft: wired.draft.current }),
        }),
        { exitOnCtrlC: false, ...negotiateKeyboard(wired.noEnhancedKeys) },
    )
    onExit(() => instance.unmount())

    await instance.waitUntilExit()

    // Restore *before* writing, or the notice lands on the buffer that is about to be discarded.
    // `restoreTerminal` is idempotent and runs again from the exit hook, so doing it here costs nothing
    // and is the only way to get a byte onto the shell's own screen.
    restoreTerminal()
    if (!restart) {
        process.stdout.write(
            resumeNotice({
                ref: wired.source.describe().agentId,
                sessionKey: wired.sessionKey,
            }),
        )
    }
    return restart ? RESTART : EXIT_OK
}

/** Line-oriented, and byte-identical whether stdout is a terminal or a pipe. */
async function runPlain(wired: Wired): Promise<RunOutcome> {
    const { source, sessionKey, quiet } = wired

    let atLineStart = true
    const write = (text: string) => {
        if (text === "") return
        process.stdout.write(text)
        atLineStart = text.endsWith("\n")
    }
    /** A line of its own, whatever the reply was part-way through writing. */
    const row = (text: string) => {
        if (!atLineStart) write("\n")
        write(`${text}\n`)
    }

    if (wired.banner.length > 0) write(`${wired.banner.join("\n")}\n\n`)

    // A one-shot run prints the answer and nothing else, because something is parsing it. Tool rows
    // are for a person watching, so they follow the same rule as the banner and the stats line.
    const showRows = !quiet && wired.once === undefined

    // Streaming goes through the bus rather than a callback: the CLI is a subscriber like any other,
    // which is what keeps the server and the CLI from needing different cores.
    let streaming = false
    let lastKind: "text" | "reasoning" | undefined

    // With a line-oriented dialect the invocation *is* text, so raw deltas would put `ACTION:` and
    // `END` in front of the person and run them into the answer. The filter comes from the agent
    // rather than being chosen here: which dialect is in play is config, and one place decides it.
    // One per turn, told where the steps end — it owns the paragraph break between them.
    let filter = source.streamFilter()

    const show = (text: string) => {
        if (text === "") return
        write(text)
        streaming = true
    }

    /**
     * One wildcard subscription, switching on type — not seven by name.
     *
     * Named subscriptions were right while this read a bus directly. They are not expressible over
     * a source, which hands out one stream, and that turns out to be the better shape for the same
     * reason `useTurn` already gives: a subscription list silently misses any event a later phase
     * adds, while a switch with no branch simply ignores it. `{ chunks: true }` is the source's
     * business now, which is where it belongs — this path has always needed per-token frames and
     * had to remember to ask.
     */
    const unsubscribe = wired.source.subscribe((event: AnyEvent) => {
        switch (event.type) {
            case "model.result":
                show(filter.endStep())
                return

            case "model.chunk": {
                const { delta, kind } = event.data
                if (kind === "reasoning" && wired.showReasoning !== true) return

                // A reasoning model streams its scratchpad and then its answer with no separator of
                // its own, so the two run together mid-sentence. The label is worth two lines: the
                // whole point of showing reasoning is being able to tell it apart from the reply.
                if (kind !== lastKind) {
                    if (lastKind !== undefined) write("\n\n")
                    if (wired.showReasoning === true) {
                        write(kind === "reasoning" ? "· reasoning ·\n" : "· reply ·\n")
                    }
                    lastKind = kind
                }

                // Reasoning is not parsed for tool calls, so it is not filtered for them either.
                if (kind === "reasoning") {
                    write(delta)
                    streaming = true
                    return
                }
                show(filter.push(delta))
                return
            }

            case "tool.result": {
                if (!showRows) return
                const { slug, ok, latencyMs, truncated } = event.data
                row(
                    `  · ${slug} — ${ok ? "ok" : "failed"} · ${latencyMs} ms${truncated ? " · observation trimmed" : ""}`,
                )
                return
            }

            // Every warning, and exempt from `showRows` like a gated call. It used to be one code —
            // `manifest_changed` — so an agent that rewrote its own configuration was reported and
            // everything else was not: a truncated reply, a repeated call, a compactor that silently
            // fell back to a mechanical digest, a prompt over the window. `showRows` exists to keep a
            // one-shot run free of *progress* rows, and a warning is not progress.
            case "agent.warning":
                row(`  · ${event.data.message}\n    ${event.data.hint}`)
                return

            case "tool.repair":
                // Worth a line of its own: a silent repair looks like a slow turn.
                if (showRows)
                    row(`  · ${event.data.slugs.join(", ")} — could not be used, asking again`)
                return

            // Deliberately NOT gated on `showRows`. Every other row here is for a person watching,
            // and suppressing them in a one-shot run is right — but a blocked write is the run doing
            // less than it was asked to, and a scripted caller parsing the output needs to know that
            // even more than a person does.
            case "tool.gated":
                row(`  · ${event.data.slug} — blocked: ${event.data.reason}`)
                return

            // Also not gated on `showRows`. The ladder ran and the budget was still short, so history
            // was cut anyway — the same class as a blocked write: the run did less than it was asked
            // to, and for six phases the only trace was a field on `AssembledContext` nothing read.
            case "context.dropped":
                row(
                    `  · context: ${event.data.messages} older message(s) did not fit the ${event.data.budget}-token budget and were left out`,
                )
                return

            default:
                return
        }
    })

    /**
     * A typed line that was a command rather than a prompt.
     *
     * Shared by both input branches, and driven by the same table the rich path uses. Before this,
     * the banner advertised `/help` and this path had no case for it, so it went to the model as a
     * prompt — a billed call answering a question about the CLI it knows nothing about.
     */
    const dispatch = async (
        trimmed: string,
    ): Promise<"exit" | "restart" | "handled" | "prompt"> => {
        const command = resolveSessionCommand(trimmed)
        if (command === undefined) return "prompt"
        switch (command.kind) {
            case "exit":
                return "exit"
            case "restart": {
                /**
                 * Attached, this is a request to the host — and the loop does not go round.
                 *
                 * The same branch `App` takes, and it has to be here too for the reason the
                 * both-paths guard exists one file over: a command handled on one output path and
                 * not the other is invisible. Left alone, the plain path returned `"restart"`, the
                 * attached loop re-banners, and it printed *"the configuration on disk is now the
                 * one in force"* — a sentence about a rebuild that never happened, which is worse
                 * than doing nothing because somebody would believe it.
                 */
                const reload = source.reload
                if (reload === undefined) return "restart"
                try {
                    const adopted = await reload()
                    row(`reloaded ${adopted.join(", ")} — this conversation continues`)
                } catch (error) {
                    row(
                        `could not reload: ${error instanceof Error ? error.message : String(error)}`,
                    )
                }
                return "handled"
            }
            case "new":
                // The same outcome `/restart` returns, with a key in the box — which is exactly what the
                // rich path's `onNew` does. No new outcome value: the loop below already turns "restart"
                // into `RESTART`, and the box is what makes this a move rather than a rebuild in place.
                wired.switchTo.current = { key: newSessionKey(wired.random), reason: "new" }
                return "restart"
            case "help":
                row(sessionHelpText())
                return "handled"
            case "tools":
                row(toolsReport(await source.tools()))
                return "handled"
            case "status":
                row(
                    wired.embedded === undefined
                        ? await attachedStatus(source)
                        : await sessionStatus(wired.embedded),
                )
                return "handled"
            case "context":
                row(await sessionContext(wired, sessionKey))
                return "handled"
            case "reset":
                await source.clearSession(sessionKey)
                row("session cleared — memory files on disk are untouched")
                return "handled"
            case "unknown":
                row(unknownCommandText(command))
                return "handled"
            case "command":
                // A CLI command typed at the plain prompt. Not run here: the plain path is a pipe's
                // path, and a command that expects to own the terminal has no business in one. Named
                // rather than silently sent to the model, which is the failure this dispatch exists for.
                row(
                    `${command.name} is a command, not a prompt — run it at a terminal, or in another shell as \`${BRAND.slug} ${command.name}${command.rest === "" ? "" : ` ${command.rest}`}\``,
                )
                return "handled"
        }
    }

    let controller: AbortController | undefined
    let cancelledAt = 0
    let exitCode: RunOutcome = EXIT_OK

    const onInterrupt = (rl = wired.reader.current): void => {
        if (controller !== undefined && !controller.signal.aborted) {
            cancelledAt = performance.now()
            controller.abort()
            return
        }
        // Closing the readline interface ends the `for await` loop, which returns through the
        // `finally` below. Calling process.exit here would discard a non-zero code set by an earlier
        // failed turn, and could truncate piped output mid-write.
        rl?.close()
        write("\n")
    }

    const runOne = async (input: string): Promise<void> => {
        controller = new AbortController()
        streaming = false
        lastKind = undefined
        filter = source.streamFilter()

        const result = await source.send(input, { sessionKey, signal: controller.signal })
        controller = undefined

        // The filter withholds a trailing line break, since it cannot know whether more follows.
        show(filter.end())
        if (streaming && !atLineStart) write("\n")
        else if (!streaming && result.text !== "") write(`${result.text}\n`)

        // One formatter for every ending, shared with the transcript. The previous version had a
        // sentence for three of the six reasons and printed the `max_steps` one only when the reply was
        // empty — so an agent that stopped mid-task having produced prose said nothing at all.
        const note = endNote(result.reason, {
            steps: result.steps,
            durationMs: result.durationMs,
            ...(cancelledAt === 0 ? {} : { cancelledAfterMs: performance.now() - cancelledAt }),
        })
        if (note !== undefined) write(`\n(${note})\n`)
        if (result.reason === "error" && result.error !== undefined) {
            process.stderr.write(
                `\n${result.error.code}: ${result.error.message}\n  hint: ${result.error.hint}\n`,
            )
        }
        if (endedBadly(result.reason)) exitCode = EXIT_FAILURE

        if (!quiet && result.reason === "final") {
            write(
                `  ${result.tokens.prompt} prompt · ${result.tokens.output} output · ${result.durationMs} ms\n\n`,
            )
        }

        // Bound the memory a long piped session can hold: stdout to a pipe is asynchronous, and a
        // slow reader would otherwise let unwritten replies accumulate for the life of the process.
        await flushOutput()
    }

    const sigintHandler = () => onInterrupt()
    process.on("SIGINT", sigintHandler)

    try {
        if (wired.once !== undefined) {
            await runOne(wired.once)
            return exitCode
        }

        if (process.stdin.isTTY !== true) {
            const rl = wired.reader.current ?? createInterface({ input: process.stdin })
            wired.reader.current = rl
            for await (const line of rl) {
                const trimmed = line.trim()
                if (trimmed === "") continue
                // Commands work in a pipe too. A script that pipes `/exit` means it — this branch
                // used to skip the word and keep reading, which is the one place the piped path
                // disagreed with the terminal about what a typed line meant.
                const outcome = await dispatch(trimmed)
                if (outcome === "exit") break
                if (outcome === "restart") {
                    exitCode = RESTART
                    break
                }
                if (outcome === "handled") continue
                await runOne(trimmed)
            }
            return exitCode
        }

        // `terminal: false` is the whole point of this branch.
        //
        // Node's readline decides for itself whether to run in terminal mode, by reading
        // `output.isTTY` — so at a terminal it repaints the prompt with cursor-control sequences
        // (`ESC[1G`, `ESC[0J`, `ESC[3G`) that the same command piped never emits. That silently
        // breaks the property plain mode exists for: `--plain` at a terminal must produce exactly
        // what a pipe produces. Only the rich path is allowed to move a cursor.
        //
        // The cost is that readline no longer echoes or edits: the tty driver does both, because
        // nothing here puts stdin in raw mode. Typing, backspace and Ctrl-D behave as they do in any
        // line-buffered program. Arrow-key history is lost on this path — the rich path owns that.
        const rl =
            wired.reader.current ??
            createInterface({
                input: process.stdin,
                output: process.stdout,
                prompt: PROMPT,
                terminal: false,
            })
        wired.reader.current = rl
        // Outside terminal mode readline never emits its own SIGINT, so the process-level handler
        // installed below is the only one that fires. It closes `reader`, which ends the loop.
        rl.prompt()
        for await (const line of rl) {
            const trimmed = line.trim()

            if (trimmed === "") {
                rl.prompt()
                continue
            }

            const outcome = await dispatch(trimmed)
            if (outcome === "exit") break
            if (outcome === "restart") {
                exitCode = RESTART
                break
            }
            if (outcome === "handled") {
                rl.prompt()
                continue
            }

            await runOne(trimmed)
            rl.prompt()
        }
        // Closed only when this really is the end. A restart hands the same reader to the next
        // runtime, and closing it here would end the session the restart was meant to continue.
        if (exitCode !== RESTART) {
            rl.close()
            wired.reader.current = undefined
        }
        return exitCode
    } finally {
        process.off("SIGINT", sigintHandler)
        unsubscribe()
    }
}

/**
 * `/status` — what this agent is, and what is actually running.
 *
 * The human twin of context slot 2. That block tells the *model* its model, window, channels,
 * server and permissions on every turn; until this existed the person at the prompt could not see
 * any of it, which is the same asymmetry slot 2 was added to remove, pointed the other way.
 *
 * State, not configuration, for the same reason slot 2 is: told only what the manifest says, an
 * agent under `run` concluded its Telegram runtime had died and reported that nothing was listening
 * on its port — from inside the running process. Every statement was true of the file and false of
 * the moment. So a configured-but-not-started channel says exactly that, and names what does start
 * it.
 */
/**
 * `/status` for a run that owns its runtime — the manifest, and what is actually running here.
 *
 * Takes the embedded pair rather than the whole `Wired` so the compiler decides where it can be
 * called from. Every sentence it prints is about *this process*: whether channels are connected in
 * this session, whether the port is bound here, which store file is open. An attached run answers
 * the same question about a different process and therefore has its own version — `attachedStatus`
 * — rather than this one with the interesting halves blanked out.
 */
async function sessionStatus(embedded: {
    readonly agent: Agent
    readonly runtime: RuntimeClass
}): Promise<string> {
    const { agent, runtime } = embedded
    const described = agent.describe()
    const manifest = agent.manifest
    // `channels.started`, never "are any registered". A binding exists under `run` too, so reading
    // its presence as "connected" is decision 5.17's bug wearing a different hat — and it was,
    // until this screen was built and said so out loud.
    const configured = manifest.channels
        .filter((channel) => channel.enabled)
        .map((channel) => `${channel.id} (${channel.type})`)
        .join(", ")
    const channels =
        configured === ""
            ? "none — reached through this session and the HTTP API only"
            : runtime.channels.started
              ? `${configured} — connected in this session`
              : `${configured} — configured, NOT running here; \`serve\` starts channels, \`run\` does not`

    const server = !manifest.server.enabled
        ? "off"
        : `enabled on ${manifest.server.host}:${manifest.server.port}, NOT bound here — \`serve\` binds it`

    // Per role, and only the roles carrying their own configuration: an agent can run three models on
    // three endpoints, and until this existed only main's window was reported anywhere at all — so a
    // compactor budgeting against the fallback's 8,192 had nothing that could say so.
    const windows = windowReport(manifest)
    const others = windows.filter(
        (entry) => entry.role !== "main" && entry.role === entry.configuredAs,
    )

    return keyValue([
        { label: "agent", value: `${described.id} (${described.name})` },
        {
            label: "model",
            value: `${described.model} · ${manifest.tools.dialect} · ${described.window} token window (${describeWindowSource(windows[0]?.window)})`,
        },
        ...others.map((entry) => ({
            label: entry.role,
            value: `${entry.modelId} · ${entry.window.contextWindow} token window (${describeWindowSource(entry.window)})`,
        })),
        { label: "channels", value: channels },
        { label: "http api", value: server },
        { label: "store", value: runtime.store.location },
        { label: "background", value: await supervision(runtime, described.id) },
    ])
}

/**
 * `/status` for a run that is a **view** — what it is attached to, and what the host says.
 *
 * Not `sessionStatus` with the runtime facts blanked out. The interesting sentences there are all
 * about the process rendering them — "connected in this session", "NOT bound here", which store
 * file is open — and every one of them would be a lie about an agent hosted somewhere else. The
 * question a person types `/status` to ask is the same; the true answer is different.
 *
 * Decision 5.17's failure, one process boundary out, is exactly what this exists to avoid: an agent
 * was told its Telegram channel was not running *in this session* while a `serve` in the next
 * terminal was polling it. The host's own view of its channels is the honest source, so that is
 * what is printed — with the pid and address, because "somewhere else" is not an answer somebody
 * can act on.
 */
async function attachedStatus(source: AgentSource): Promise<string> {
    const described = source.describe()
    const host = source.host
    const [tools, sessions] = await Promise.all([source.tools(), source.sessions()])
    return keyValue([
        { label: "agent", value: `${described.agentId} (${described.name})` },
        {
            label: "attached to",
            value: host === undefined ? "a host" : `${host.baseUrl} · pid ${host.pid}`,
        },
        {
            label: "this session",
            value: "a view — the agent runs in the host, and stays running when this exits",
        },
        { label: "model", value: `${described.model} · ${described.window} token window` },
        { label: "dialect", value: described.dialect },
        {
            label: "tools",
            value: `${tools.tools.length} pinned · ${tools.catalogueTokens} catalogue tokens per turn`,
        },
        { label: "conversations", value: `${sessions.length} on this agent` },
        {
            label: "warnings",
            value:
                described.warnings.length === 0
                    ? "none"
                    : described.warnings.map((warning) => warning.message).join("; "),
        },
    ])
}

/**
 * `/context` — what is in the prompt right now, and what the percentage is a percentage of.
 *
 * Through `previewContext`, which calls `assembleContext` with the same arguments `send` does. A
 * second assembly here would answer a question about a prompt nothing sends, and would drift the
 * first time a slot moved — the rule the HTTP surface's context endpoint already follows.
 */
/**
 * The view `/context` renders, from a live agent.
 *
 * Extracted from `sessionContext` so the source can hand one back without the formatter caring
 * where it came from. Everything but `windowSource` is `previewContext`'s own output — which is
 * exactly what `GET /v1/agents/:id/context` returns, because that route calls the same method with
 * the same arguments `send` does rather than rebuilding the argument list.
 */
async function contextViewOf(agent: Agent, sessionKey: string): Promise<ContextView> {
    const preview = await agent.previewContext({ sessionKey })
    const [main] = windowReport(agent.manifest)
    return {
        slots: preview.slots,
        history: preview.history,
        cache: preview.cache,
        total: preview.total,
        window: preview.window,
        windowSource: describeWindowSource(main?.window),
        wireTokens: preview.wireTokens,
        reserveOutput: preview.reserveOutput,
        calibration: preview.calibration,
        lastCompaction:
            preview.compactions === 0
                ? undefined
                : `${preview.compactions} stage${preview.compactions === 1 ? "" : "s"} run this session`,
    }
}

async function sessionContext(wired: Wired, sessionKey: string): Promise<string> {
    return contextReport(await wired.source.context(sessionKey))
}

/**
 * Who, if anyone, is keeping this agent up — and the three answers are genuinely different.
 *
 * "Not supervised" was the first version, derived from this runtime not holding the lease. It was
 * wrong in the most misleading direction available: a REPL correctly *declines* the lease when a
 * service already holds it, so an agent that had been running as a daemon for a week reported
 * itself unsupervised to the person looking straight at it.
 */
async function supervision(runtime: RuntimeClass, agentId: string): Promise<string> {
    if (runtime.owned.includes(agentId)) return "this session is serving this agent"
    const lease = await runtime.store.leases.get(agentId)
    if (lease !== undefined && processAlive(lease.pid)) {
        return lease.mode === "daemon"
            ? `running as a background service · pid ${lease.pid} · \`${BRAND.slug} daemon status ${agentId}\``
            : `served by another session · pid ${lease.pid} (${lease.mode})`
    }
    return `not supervised — \`${BRAND.slug} daemon install ${agentId}\` keeps it running without a terminal`
}
