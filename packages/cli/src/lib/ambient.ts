/**
 * Which environment an agent actually runs under, and in what order.
 *
 * ## The bug this exists to fix
 *
 * A sandbox agent's own `.env` said `MODEL_ID=deepseek-v4-flash`. The agent ran a whole session
 * on `deepseek-v4-pro`, because the binary was launched from a project checkout whose own `.env`
 * happens to set that variable, Bun auto-loads a `.env` from the current directory into
 * `process.env` before any of this code runs, and core's documented rule is that the real
 * environment beats a `.env` beside the manifest.
 *
 * Every step of that is working as designed and the outcome is wrong. The rule exists so an
 * **operator's explicit export** beats a committed file — `MODEL_ID=x <binary> run milo`, or a
 * container's environment. A `.env` file sitting in whatever directory you happened to be standing
 * in is not that. It is configuration for *that project*, and an agent that lives in the home
 * sandbox has nothing to do with it.
 *
 * ## The order, stated
 *
 * 1. A variable genuinely exported into the environment.
 * 2. The `.env` beside the agent's own manifest.
 * 3. A `.env` in the directory the command was run from.
 *
 * Core still implements "real environment wins" exactly as documented. This decides what counts as
 * the real environment before core sees it, which is CLI policy — the same place the home sandbox
 * lives, and for the same reason: core is what an embedder runs other people's agents on, and a
 * container's environment must keep winning there without any of this.
 *
 * ## The one case it gets wrong, stated too
 *
 * An export and the cwd `.env` that set a variable to the *same string* are indistinguishable from
 * inside the process, so such a variable is treated as coming from the file and loses to the agent's
 * own `.env`. That is a rare configuration and a mild wrong answer. The behaviour it replaces was a
 * common configuration and a silent one: every sandbox agent reconfigured by whichever directory you
 * were standing in.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { type EnvSource, parseDotEnv } from "@dispach/core"

/**
 * The `.env` in a directory, or nothing.
 *
 * Exported because `config-env.ts` needs the same three layers this module resolves in order to say
 * *which* of them a value came from, and two readers of one file is how two answers to one question
 * come about.
 */
export function readDotEnv(dir: string): Record<string, string> {
    const path = join(dir, ".env")
    if (!existsSync(path)) return {}
    try {
        return parseDotEnv(readFileSync(path, "utf8"))
    } catch {
        // An unreadable or malformed `.env` is not this function's business to report. Core reads
        // the agent's own file and fails loudly there; a cwd file we only consult to *demote* is
        // safe to skip entirely.
        return {}
    }
}

export interface AmbientOptions {
    /** Defaults to `process.env`. Injected by tests, which must never read the real environment. */
    readonly env?: EnvSource
    readonly cwd?: string
    /** Defaults to real filesystem reads. */
    readonly readDir?: (dir: string) => Record<string, string>
}

/**
 * The environment to hand core for these manifests.
 *
 * Returns `process.env` unchanged whenever nothing is in tension — no cwd `.env`, or none of its
 * variables collide with an agent's own file. The common case therefore costs two `existsSync`
 * calls and changes nothing, which matters: this runs on the boot path.
 */
export function ambientEnv(
    manifestPaths: readonly string[],
    options: AmbientOptions = {},
): EnvSource {
    const env = options.env ?? process.env
    const cwd = resolve(options.cwd ?? process.cwd())
    const read = options.readDir ?? readDotEnv

    const cwdEnv = read(cwd)
    if (Object.keys(cwdEnv).length === 0) return env

    // Every variable any of these agents sets for itself. A multi-agent runtime is rare and the
    // union is the right answer for it: a variable one agent owns should not be overridden for that
    // agent because a sibling left it alone.
    const owned = new Set<string>()
    for (const path of manifestPaths) {
        const dir = dirname(resolve(path))
        if (dir === cwd) continue // The cwd file *is* the agent's file. Nothing to demote.
        for (const key of Object.keys(read(dir))) owned.add(key)
    }
    if (owned.size === 0) return env

    const demoted = [...owned].filter((key) => key in cwdEnv && env[key] === cwdEnv[key])
    if (demoted.length === 0) return env

    const next: EnvSource = { ...env }
    for (const key of demoted) delete next[key]
    return next
}

/**
 * What was demoted, for the one line that says so.
 *
 * Separate from the value above because silence was half the original bug. A person who has just
 * written `MODEL_ID` into a project `.env` and finds their agent ignoring it deserves the same
 * sentence as the person who found their agent obeying it.
 */
export function demotedKeys(
    manifestPaths: readonly string[],
    options: AmbientOptions = {},
): readonly string[] {
    const env = options.env ?? process.env
    const after = ambientEnv(manifestPaths, options)
    return Object.keys(env).filter((key) => key in env && !(key in after))
}
