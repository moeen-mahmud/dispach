/**
 * Paths the file tools will not write to, whatever the policy said.
 *
 * ## Why this is checked *after* the policy allowed the call, and is still "before allow rules"
 *
 * The policy answers "may this tool run"; this answers "may it run against *that*". A `policy.allow`
 * rule cannot reach past it, which is the whole point: the protected set includes the manifest and
 * the policy file, so a rule that authorised writing to them would be a rule authorising its own
 * replacement. Ordering it this way needs no special case in the engine — the refusal simply is not
 * the engine's to make.
 *
 * ## Why it matters more here than in the runtimes this is modelled on
 *
 * Elsewhere, protecting config stops an agent breaking its own setup. Here the workspace files **are
 * the agent** — `SOUL.md` is who it is, `AGENTS.md` is what it does, `POLICY.md` is what it will not
 * do. A `file_write` to any of them is the agent editing its own constitution, and a model that has
 * just read a hostile page is exactly the one that would be asked to.
 *
 * `USER.md` and `MEMORY.md` are deliberately absent: they are the volatile tier, the files
 * `memory_write` exists to append to, and protecting them would break remembering.
 *
 * ## The limit, stated rather than discovered
 *
 * This binds the **file tools**. It does not bind `exec`, and it cannot: `echo x > SOUL.md` carries
 * its target inside a shell string, where no path check can see it. That is the same asymmetry that
 * makes `exec`'s description argue for the structured tools — a `path` field is checkable and a
 * command line is not. Anyone who pins `exec` has granted more than this file protects, and saying
 * so here is cheaper than implying a boundary that is not there.
 */

import { isAbsolute, relative, resolve, sep } from "node:path"

/**
 * Files whose contents decide what the agent is or what it may do, relative to the agent's own
 * directory. Matched against the agent directory and its `workspace/` subdirectory.
 */
export const PROTECTED_NAMES: readonly string[] = [
    "agent.yaml",
    "agent.yml",
    "SOUL.md",
    "SOUL.compact.md",
    "AGENTS.md",
    "POLICY.md",
    "REMINDER.md",
]

/**
 * Credential material, matched **anywhere** on the filesystem rather than relative to anything.
 *
 * Both reference runtimes ship a version of this list, and it is the one part of the set that is
 * about the machine rather than about the agent: a key in `~/.ssh` is not the agent's business at
 * any path, under any manifest.
 */
export const PROTECTED_DIRS: readonly string[] = [".ssh", ".aws", ".kube", ".gnupg", ".docker"]

/** Basenames refused anywhere. `.env` and everything that looks like one of its variants. */
const PROTECTED_FILE = /^(?:\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|id_[a-z0-9]+|.*\.pem|.*\.key)$/i

export interface ProtectOptions {
    /** The agent's own directory — where the manifest and workspace live. */
    readonly agentDir: string
    /** Extra patterns from `tools.providerConfig.protect`. Widening only; nothing narrows this. */
    readonly extra?: readonly string[]
}

function segments(path: string): readonly string[] {
    return path.split(sep).filter((part) => part !== "")
}

/**
 * Why this path may not be written, or `undefined` if it may.
 *
 * Takes an already-resolved absolute path. Resolving inside would hide the one mistake this has to
 * catch — a relative path resolved against the wrong base is a check performed on a different file
 * than the one about to be written.
 */
/**
 * Why this path may not be **read**, or `undefined` if it may (QA pilot.3).
 *
 * The credential half of the write list, plus a process's environment. Reading was unconfined, so an
 * agent could `file_read` its own `.env` or `/proc/self/environ` and put every secret the silo holds
 * into its context — and from there into a reply. Narrower than the write list on purpose: an agent
 * reading its own `SOUL.md` or `agent.yaml` is fine, and `config_read` exists to do the second. Like
 * the write list, it does not bind `exec`.
 */
export function secretReason(absolute: string): string | undefined {
    const parts = segments(absolute)
    const name = parts[parts.length - 1] ?? ""
    for (const dir of PROTECTED_DIRS) {
        if (parts.includes(dir)) return `${dir}/ holds credentials`
    }
    if (PROTECTED_FILE.test(name)) {
        return `${name} holds secrets — the manifest names environment variables, and their values are not the agent's`
    }
    if (parts[0] === "proc" && (name === "environ" || name === "cmdline")) {
        return `${absolute} is a process's environment, which holds this runtime's secrets`
    }
    return undefined
}

export function protectedReason(absolute: string, options: ProtectOptions): string | undefined {
    const parts = segments(absolute)
    const name = parts[parts.length - 1] ?? ""

    for (const dir of PROTECTED_DIRS) {
        if (parts.includes(dir)) {
            return `${dir}/ holds credentials, and nothing under it is writable by an agent`
        }
    }

    if (PROTECTED_FILE.test(name)) {
        return `${name} holds secrets — the manifest names environment variables, and their values are not the agent's to edit`
    }

    const agentDir = resolve(options.agentDir)
    const within = relative(agentDir, absolute)
    const inside = within !== "" && !within.startsWith("..") && !isAbsolute(within)

    if (inside) {
        const tail = within.split(sep)
        const last = tail[tail.length - 1] ?? ""
        if (PROTECTED_NAMES.includes(last)) {
            return `${within} is part of this agent's own definition — who it is, what it does, or what it is permitted to do — and it is not editable from inside a turn`
        }
        if (tail[0]?.startsWith(".") === true) {
            return `${within} is runtime state this agent depends on`
        }
    }

    for (const pattern of options.extra ?? []) {
        if (absolute.includes(pattern) || name === pattern) {
            return `${name} is listed in tools.providerConfig.protect`
        }
    }

    return undefined
}
