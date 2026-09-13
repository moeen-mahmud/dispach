/**
 * The entry point: parse, dispatch, exit.
 *
 * No shebang here — the build prepends one via `--banner`. Two would be a syntax error, and the
 * source is never executed directly: `bun run src/index.ts` and `node dist/index.js` are the two
 * supported ways in.
 *
 * Three rules hold here and nowhere else.
 *
 * **It imports no Ink and no React.** The rich renderer is reached through a dynamic `import()` in
 * `run.ts`, because loading it costs ~170-210 ms under Node — more than the entire runtime of
 * `validate --json`. A static import anywhere on this path would be paid by every command.
 *
 * **Commands return exit codes; they never call `process.exit`.** Exiting mid-write discards buffered
 * stdout when the output is a pipe, which is how `--json` gets read. This file is the one exception,
 * on the last line, and only after `finish` has drained the output — a command that exits by itself
 * skips the teardowns and the drain both.
 *
 * **Asking for help is a success.** The previous entry point set exit code 1 for `--help` given
 * without a command, reporting failure for the one thing that had worked.
 */

import { HarnessError, VERSION } from "@dispach/core"
import { agentsCommand } from "#agents"
import { browseCommand } from "#browse"
import { daemonCommand } from "#daemon"
import { initCommand } from "#init"
import { keysCommand } from "#keys"
import { parse } from "#lib/args"
import { askExactly, askYesNo } from "#lib/confirm"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { readEnv } from "#lib/env"
import { finishNow, installGuards } from "#lib/exit"
import { helpText } from "#lib/help"
import { resolveAgentRef } from "#lib/sandbox"
import { quietAcceptedWarnings } from "#lib/warnings"
import { memoryCommand } from "#memory"
import { modelCommand } from "#model"
import { removeCommand } from "#remove"
import { runCommand } from "#run"
import { schedulesCommand } from "#schedules"
import { serveCommand } from "#serve"
import { sessionsCommand } from "#sessions"
import { skillsCommand } from "#skills"
import { soulCommand } from "#soul"
import { sourcesCommand } from "#sources"
import { stopCommand } from "#stop"
import { terminalSetupCommand } from "#terminal-setup"
import { toolsCommand } from "#tools"
import { validateCommand } from "#validate"
import { workspaceCommand } from "#workspace"

function report(error: unknown): number {
    if (error instanceof HarnessError) {
        // `format()` prints the code, the field, the hint, and every sub-failure — so a command line
        // with two mistakes in it reports both rather than one at a time.
        process.stderr.write(`${error.format()}\n`)
    } else if (error instanceof Error) {
        process.stderr.write(`${error.message}\n`)
        if (readEnv().debug && error.stack !== undefined) process.stderr.write(`${error.stack}\n`)
    } else {
        process.stderr.write(`${String(error)}\n`)
    }
    return EXIT_FAILURE
}

async function dispatch(argv: readonly string[]): Promise<number> {
    const result = parse(argv)

    switch (result.kind) {
        case "version":
            process.stdout.write(`${VERSION}\n`)
            return EXIT_OK

        case "help":
            process.stdout.write(helpText(result.command))
            return EXIT_OK

        case "usage":
            // Invoked with nothing to do. The help goes to stdout because it was not an error in the
            // arguments — but the code is non-zero, because nothing was accomplished.
            process.stdout.write(helpText())
            return EXIT_FAILURE

        case "command":
            break
    }

    const { command, positionals, flags } = result.parsed
    // Present when the command's first argument is required; `init` and `run` legitimately take
    // none. Each case knows which it is.
    const manifestPath = positionals[0] as string
    // Every manifest-taking command accepts a sandbox agent name too — one resolver, applied
    // here at the dispatch layer, so `sessions milo` works the moment `run milo` does. The
    // resolution throws with the candidate list and a nearest-match hint.
    const resolved = (): string => resolveAgentRef(manifestPath)

    switch (command.name) {
        case "init": {
            // `--dir`, never a positional: `init milo` read as the agent's name and meant the
            // directory. The parser refuses a positional now, with the spec's own two-readings hint.
            const dir = flags.str("dir")
            const user = flags.str("user")
            const name = flags.str("name")
            const purpose = flags.str("purpose")
            const preset = flags.str("preset")
            const model = flags.str("model")
            const baseUrl = flags.str("base-url")
            const apiKeyEnv = flags.str("api-key-env")
            const system = flags.str("system")
            const web = flags.str("web")
            const webBackend = flags.str("web-backend")
            const composio = flags.str("composio")
            const telegram = flags.str("telegram")
            const telegramAllow = flags.str("telegram-allow")
            const server = flags.str("server")
            const schedules = flags.str("schedules")
            const skills = flags.str("skills")
            const daemon = flags.str("daemon")
            return await initCommand({
                ...(dir === undefined ? {} : { dir }),
                ...(user === undefined ? {} : { user }),
                ...(name === undefined ? {} : { name }),
                ...(purpose === undefined ? {} : { purpose }),
                ...(preset === undefined ? {} : { preset }),
                ...(model === undefined ? {} : { model }),
                ...(baseUrl === undefined ? {} : { baseUrl }),
                ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
                ...(system === undefined ? {} : { system }),
                ...(web === undefined ? {} : { web }),
                ...(webBackend === undefined ? {} : { webBackend }),
                ...(composio === undefined ? {} : { composio }),
                ...(telegram === undefined ? {} : { telegram }),
                ...(schedules === undefined ? {} : { schedules }),
                ...(telegramAllow === undefined ? {} : { telegramAllow }),
                ...(server === undefined ? {} : { server }),
                ...(skills === undefined ? {} : { skills }),
                ...(daemon === undefined ? {} : { daemon }),
                yes: flags.bool("yes"),
                plain: flags.bool("plain"),
            })
        }

        case "run": {
            const session = flags.str("session")
            const input = flags.str("input")
            const store = flags.str("store")
            return await runCommand({
                // Bare `run` hands the sandbox the decision; a given ref resolves path-or-name.
                ...(positionals[0] === undefined ? {} : { manifestPath: resolved() }),
                ...(session === undefined ? {} : { sessionKey: session }),
                continueSession: flags.bool("continue"),
                ...(input === undefined ? {} : { once: input }),
                ...(store === undefined ? {} : { store }),
                ephemeral: flags.bool("ephemeral"),
                quiet: flags.bool("quiet"),
                showReasoning: flags.bool("show-reasoning"),
                noReasoning: flags.bool("no-reasoning"),
                // Only when actually written. `flags.bool` returns `false` for an absent boolean, and
                // passing that would turn "no opinion" into "definitely on" and override the env var.
                ...(flags.bool("no-enhanced-keys") ? { noEnhancedKeys: true } : {}),
                plain: flags.bool("plain"),
            })
        }

        case "schedules": {
            const store = flags.str("store")
            const id = flags.str("id")
            const enable = flags.str("enable")
            const disable = flags.str("disable")
            return await schedulesCommand({
                manifestPath: resolved(),
                ...(store === undefined ? {} : { store }),
                ...(id === undefined ? {} : { id }),
                ...(enable === undefined ? {} : { enable }),
                ...(disable === undefined ? {} : { disable }),
                recipients: flags.bool("recipients"),
                json: flags.bool("json"),
            })
        }

        case "sessions": {
            const session = flags.str("session")
            const store = flags.str("store")
            const limit = flags.num("limit")
            return await sessionsCommand({
                manifestPath: resolved(),
                ...(session === undefined ? {} : { sessionKey: session }),
                ...(store === undefined ? {} : { store }),
                ...(limit === undefined ? {} : { limit }),
                json: flags.bool("json"),
                clear: flags.bool("clear"),
                turns: flags.bool("turns"),
            })
        }

        case "memory": {
            const limit = flags.num("limit")
            const store = flags.str("store")
            return await memoryCommand({
                // Positional 0 is the action, as for `soul` and `daemon` — so `resolved()` must not run
                // here; the manifest is positional 1.
                action: manifestPath,
                manifestPath: resolveAgentRef(positionals[1] ?? ""),
                ...(positionals[2] === undefined ? {} : { query: positionals[2] }),
                ...(limit === undefined ? {} : { limit }),
                ...(store === undefined ? {} : { store }),
                all: flags.bool("all"),
                json: flags.bool("json"),
            })
        }

        case "config": {
            // As for `soul` and `daemon`, positional 0 is the action, so `resolved()` must not run —
            // the agent is positional 1 and this command resolves it itself.
            const { configCommand, readAction } = await import("#config")
            // `config <agent>` with no action is the editor, so the split is not positional. The six
            // action words win and anything else is an agent — the same rule a slash command uses.
            const asked = readAction(manifestPath, positionals[1])
            return await configCommand({
                action: asked.action,
                ...(asked.ref === undefined ? {} : { ref: asked.ref }),
                ...(positionals[2] === undefined ? {} : { name: positionals[2] }),
                ...(positionals[3] === undefined ? {} : { value: positionals[3] }),
                ...(flags.str("channel") === undefined
                    ? {}
                    : { channel: flags.str("channel") as string }),
                remove: flags.bool("remove"),
                yes: flags.bool("yes"),
                ...(flags.str("store") === undefined
                    ? {}
                    : { store: flags.str("store") as string }),
            })
        }

        case "validate":
            return validateCommand({ manifestPath: resolved(), json: flags.bool("json") })

        case "workspace":
            return workspaceCommand({
                manifestPath: resolved(),
                json: flags.bool("json"),
                strict: flags.bool("strict"),
            })

        case "soul": {
            const out = flags.str("out")
            return soulCommand({
                // For this command the first positional is the action, not a manifest.
                action: manifestPath,
                file: positionals[1] as string,
                ...(out === undefined ? {} : { out }),
            })
        }

        case "skills": {
            // Bare `skills` is the catalogue. Checked before the manifest is resolved, because browsing
            // is not about an agent — the agent is chosen on the second screen.
            if (positionals.length === 0) {
                return await browseCommand({
                    plain: flags.bool("plain"),
                    json: flags.bool("json"),
                })
            }
            // Positional 0 is the action, so the manifest is positional 1 — the same shape `soul` uses
            // and the reason `resolved()` is not called here.
            const skill = positionals[2]
            return skillsCommand({
                action: manifestPath,
                manifestPath: resolveAgentRef(positionals[1] ?? ""),
                ...(skill === undefined ? {} : { name: skill }),
                json: flags.bool("json"),
                strict: flags.bool("strict"),
            })
        }

        case "sources": {
            // Positional 0 is the action and there is no manifest, so `resolveAgentRef` never runs —
            // this command answers about the machine, not about an agent.
            const path = flags.str("path")
            const ref = flags.str("ref")
            return await sourcesCommand({
                action: manifestPath,
                rest: positionals.slice(1),
                ...(path === undefined ? {} : { path }),
                ...(ref === undefined ? {} : { ref }),
                json: flags.bool("json"),
            })
        }

        case "agents":
            return await agentsCommand({
                manifestPaths: positionals.map((ref) => resolveAgentRef(ref)),
                json: flags.bool("json"),
            })

        case "serve": {
            const port = flags.num("port")
            const host = flags.str("host")
            const store = flags.str("store")
            return await serveCommand({
                manifestPath: resolved(),
                ...(port === undefined ? {} : { port }),
                ...(host === undefined ? {} : { host }),
                ...(store === undefined ? {} : { store }),
                json: flags.bool("json"),
            })
        }

        case "keys":
            return await keysCommand({ noEnhancedKeys: flags.bool("no-enhanced-keys") })

        case "terminal-setup":
            return await terminalSetupCommand({
                dryRun: flags.bool("dry-run"),
                yes: flags.bool("yes"),
                json: flags.bool("json"),
                confirm: askYesNo,
            })

        case "remove":
            return await removeCommand({
                // A bare ref, never `resolved()`: removal is about a sandbox directory, and a resolved
                // manifest path would make `remove ./anything` look supported. `remove.ts` refuses a path.
                ...(manifestPath === undefined ? {} : { ref: manifestPath }),
                dryRun: flags.bool("dry-run"),
                filesOnly: flags.bool("files-only"),
                prune: flags.bool("prune"),
                all: flags.bool("all"),
                yes: flags.bool("yes"),
                json: flags.bool("json"),
                ...(flags.str("store") === undefined
                    ? {}
                    : { store: flags.str("store") as string }),
                confirm: askExactly,
            })

        case "stop":
            return await stopCommand({
                // Optional on purpose: bare `stop` is the point of the command.
                ...(manifestPath === undefined ? {} : { manifestPath: resolved() }),
                dryRun: flags.bool("dry-run"),
                json: flags.bool("json"),
            })

        case "daemon": {
            const lines = flags.num("lines")
            return await daemonCommand({
                // As for `soul`, the first positional is the action rather than a manifest — so
                // `resolved()` must not run here. The agent is positional 1, and it is optional:
                // bare `daemon status` reports on every installed agent.
                action: manifestPath,
                ...(positionals[1] === undefined
                    ? {}
                    : { manifestPath: resolveAgentRef(positionals[1]) }),
                ...(lines === undefined ? {} : { lines }),
                follow: flags.bool("follow"),
                truncate: flags.bool("truncate"),
                dryRun: flags.bool("dry-run"),
                json: flags.bool("json"),
            })
        }

        case "model": {
            const price = flags.num("price")
            return await modelCommand({
                manifestPath: resolveAgentRef(positionals[1] as string),
                window: flags.bool("window"),
                ...(price === undefined ? {} : { price }),
                write: flags.bool("write"),
                yes: flags.bool("yes"),
                json: flags.bool("json"),
            })
        }

        case "tools":
            return await toolsCommand({
                manifestPath: resolved(),
                warm: flags.bool("warm"),
                json: flags.bool("json"),
            })

        default:
            // Unreachable: `parse` refuses an unknown command with a suggestion. Present so that
            // adding a command to lib/commands.ts without wiring it fails loudly rather than
            // silently doing nothing and exiting 0.
            throw new HarnessError({
                code: "cli_command_unwired",
                message: `Command "${command.name}" is declared but not wired up.`,
                hint: "Add a case for it in src/index.ts.",
            })
    }
}

// Before anything opens a store, which is what makes Node emit its `node:sqlite` experimental
// warning into the middle of a command's output. See `lib/warnings.ts` for what is filtered and why
// the list is specific rather than "every ExperimentalWarning".
quietAcceptedWarnings()
installGuards()

// One way out for every route, so the terminal is restored and buffered output drains before the
// process ends — and then the process actually ends.
//
// `finish` alone was the bug: it sets `process.exitCode` and lets the event loop empty, which assumes
// the loop can empty. A runtime leaves a keep-alive socket to the tool provider in Node's global
// `fetch` pool, so it does not — measured at 180 seconds still alive after `/exit`, and the `tools`
// command killed at 30. `lib/exit.ts` carries the numbers.
await dispatch(process.argv.slice(2))
    .catch(report)
    .then((code) => finishNow(code))
