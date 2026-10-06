/**
 * `ScriptRunner`, implemented on the machinery `exec` already uses.
 *
 * This file exists so that `packages/core` can decide *which* interpreter runs a skill's script without
 * ever starting a process. Everything a child process needs to be safe was learned here and stays here:
 *
 * - **`detached: true` and `kill(-pid)`**, so an over-running `sh -c "a | b | c"` is stopped whole rather
 *   than having two of its three stages orphaned.
 * - **A file descriptor rather than a pipe**, so a child whose output the parent stops reading does not
 *   die of `EPIPE` — which is what makes leaving one running possible at all.
 * - **The registry and its cap of 8**, reaped by `ToolProvider.stop()`. A day of test runs once left 33
 *   orphaned shells on a machine: load average 351, and a `runtime.ready` of 132 seconds that looked
 *   like a slow runtime rather than a littering one.
 *
 * A skill script therefore inherits `exec`'s deadline behaviour, backgrounding included. That is
 * deliberate rather than incidental: a script that outruns its ceiling has usually done real work, its
 * output keeps accumulating in a file whose path the observation names, and the reaper owns the cleanup.
 * Killing it to be tidy would throw the work away and still need the same reaper.
 */

import { statSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { delimiter, join } from "node:path"
import type { ScriptRunner, ScriptRunRequest, ScriptRunResult } from "@dispach/core"
import { childEnv, type EnvPolicy } from "./env.ts"
import { readOutput } from "./output.ts"
import { spillDir } from "./paths.ts"
import { runCommand } from "./run.ts"

export interface SystemScriptRunnerOptions {
    /** The manifest's environment layered over the ambient one. Values, not names. */
    readonly env: Readonly<Record<string, string | undefined>>
    /**
     * The system provider's `env` policy, read at each run: the provider is built after this runner
     * is registered, so the policy is not known yet when the constructor runs. Absent is `inherit`.
     */
    readonly policy?: () => EnvPolicy
}

/** POSIX single-quoting, so a path with a space or a quote in it survives the shell. */
function quote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
}

export class SystemScriptRunner implements ScriptRunner {
    readonly #env: Readonly<Record<string, string | undefined>>
    readonly #policy: () => EnvPolicy

    constructor(options: SystemScriptRunnerOptions) {
        this.#env = options.env
        this.#policy = options.policy ?? (() => "inherit")
    }

    /**
     * Whether a bare command name is on `PATH`.
     *
     * A filesystem walk, never an execution: `python3 --version` would be a process started during boot,
     * and `uv` in particular can reach the network on first run. Answers for a bare name only, which is
     * all `ScriptPlan.requires` ever holds — `uv`, `python3`, `bun` or `node`.
     */
    has(command: string): boolean {
        const path = this.#env.PATH ?? process.env.PATH ?? ""
        for (const dir of path.split(delimiter)) {
            if (dir === "") continue
            try {
                const found = statSync(join(dir, command))
                if (found.isFile() && (found.mode & 0o111) !== 0) return true
            } catch {
                // Not here. The next entry is the only thing this tells us anything about.
            }
        }
        return false
    }

    async run(request: ScriptRunRequest): Promise<ScriptRunResult> {
        const dir = spillDir()
        await mkdir(dir, { recursive: true })
        // Named from the command rather than a clock or a counter, both of which make a test
        // non-deterministic — the same trick `exec` uses for the same reason.
        const stamp = fingerprint([request.command, ...request.args].join(" "))
        const outPath = join(dir, `skill-${stamp}.out`)
        const statusPath = join(dir, `skill-${stamp}.status`)

        const line = [request.command, ...request.args].map(quote).join(" ")
        const run = await runCommand({
            command: line,
            cwd: request.cwd,
            env: childEnv(this.#env, this.#policy()),
            timeoutMs: request.timeoutMs,
            pty: false,
            background: false,
            signal: request.signal,
            outPath,
            statusPath,
        })

        const observation = await readOutput(outPath)
        await rm(statusPath, { force: true })
        // Kept when it spilled or when the child is still writing to it — in both cases the path is the
        // only way back to the output, and deleting it is the one thing that cannot be undone.
        if (!observation.spilled && run.ending !== "backgrounded") {
            await rm(outPath, { force: true })
        }

        const timedOut = run.ending === "killed" || run.ending === "backgrounded"
        const body = observation.spilled
            ? `${observation.head}\n\n… ${observation.bytes} bytes in total; the rest is at ${outPath}\n\n${observation.tail}`
            : observation.head

        return {
            ok: run.ending === "finished" && run.code === 0,
            output:
                run.ending === "backgrounded"
                    ? `${body}\n\nStill running past ${request.timeoutMs} ms, left going rather than discarded. Output continues to accumulate at ${outPath}.`
                    : body,
            ...(run.code === undefined ? {} : { code: run.code }),
            timedOut,
        }
    }
}

/** FNV-1a. Stable across runs, which is the whole point. */
function fingerprint(text: string): string {
    let hash = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}
