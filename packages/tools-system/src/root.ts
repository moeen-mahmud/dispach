/**
 * Where the agent is allowed to change things.
 *
 * Protected paths (`protect.ts`) answer "which files are never writable". This answers the opposite
 * and more useful question: **which files are writable at all.** A deny list has to anticipate every
 * path worth protecting; a root has to anticipate nothing, because everything outside it is refused
 * by default and the list of exceptions is written by a person.
 *
 * ## The default is the workspace, not the agent directory
 *
 * `<agentDir>/workspace` — the directory the agent's own files already live in. An agent asked to
 * "save a summary" writes it beside its notes rather than into whatever directory the process happened
 * to start in, and an agent that has misunderstood a request cannot damage anything a person cares
 * about while misunderstanding it.
 *
 * A manifest with no `workspace/` falls back to the agent's own directory, because refusing every
 * write on a layout the runtime supports would be a worse answer than a narrower root.
 *
 * ## How a person opens it up
 *
 * `tools.providerConfig.writeRoots` — absolute paths, or paths relative to the agent directory. That
 * *is* "the user named where it may operate": it is in the manifest, in the file they read to
 * understand their agent, and it took a deliberate edit. Nothing the model says at runtime can add
 * one, which is the property that makes the default worth having.
 *
 * ## What this does not cover, said plainly
 *
 * **`exec` is not confined by it, and cannot be.** `sh -c "echo x > ~/notes"` carries its target
 * inside a string no path check can see; all this can do is decide where the shell *starts*. An agent
 * that pins `exec` has been granted the machine, and the roots below then apply only to the file
 * tools. That is a real reduction for a read-only or file-only agent and close to decorative for a
 * shell one — worth saying rather than leaving to be discovered.
 *
 * Reads are deliberately **not** confined. Being pointed at a project and asked about it is the
 * ordinary case, credentials are already refused everywhere by `protect.ts`, and a runtime that could
 * not read outside one directory would be answering a different question than the one anyone asked.
 */

import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { JsonSchemaNode, ToolSpec } from "@dispach/core"
import { fileReadOutsideRoot } from "./errors.ts"

/**
 * Expand a leading `~` before anything compares the path to a root.
 *
 * Not a convenience. `~/sample/x.txt` is not absolute, so without this it resolved *against the
 * workspace* and created a directory literally named `~` inside it — a silently wrong location that
 * passes every confinement check. Expanded, it is the home directory, is outside the root, and is
 * refused by name. A model that writes `~` means the home directory and should be told it cannot have
 * it, not quietly given somewhere else.
 */
export function expandTilde(path: string): string {
    if (path === "~") return homedir()
    return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path
}

/** The subdirectory a workspace lives in, relative to the agent's own directory. */
export const WORKSPACE_DIR = "workspace"

export interface Roots {
    /** Where a relative path resolves and where writes are confined. Absolute. */
    readonly primary: string
    /** Additional writable roots from the manifest. Absolute. */
    readonly extra: readonly string[]
    /**
     * Reads confined to the same roots (pilot.14, `tools.providers.system.confineReads`). Off, a read
     * may go anywhere but a secret, as it always could; on, another agent's notes in the same silo
     * are out of reach too. `exec` is not bound by it, which its description says.
     */
    readonly confineReads: boolean
}

/**
 * Resolve the roots for an agent.
 *
 * `existsSync` rather than a promise because provider construction is synchronous, and because the
 * answer cannot change while the process lives: a `workspace/` created later does not retroactively
 * become the root of a session already running under a different one.
 */
export function resolveRoots(
    agentDir: string,
    writeRoots: readonly string[] = [],
    confineReads = false,
): Roots {
    const base = resolve(agentDir)
    const workspace = resolve(base, WORKSPACE_DIR)
    return {
        primary: existsSync(workspace) ? workspace : base,
        extra: writeRoots.map((entry) =>
            isAbsolute(entry) ? resolve(entry) : resolve(base, entry),
        ),
        confineReads,
    }
}

/** A path with its symlinks followed, or as given when it does not exist yet. */
function real(path: string): string {
    try {
        return realpathSync(path)
    } catch {
        return path
    }
}

/**
 * Refuse a read outside the roots when reads are confined. Both sides are real paths: a symlink
 * inside the workspace that points at another agent's directory is that directory, and macOS's
 * `/var` → `/private/var` would otherwise refuse every path under a temp root.
 */
export function assertReadable(absolute: string, roots: Roots): void {
    if (!roots.confineReads) return
    const target = real(absolute)
    if (writable(roots).some((root) => within(target, real(root)))) return
    throw fileReadOutsideRoot(absolute, writable(roots))
}

/** Is `absolute` inside `root`, counting the root itself? */
export function within(absolute: string, root: string): boolean {
    if (absolute === root) return true
    const rel = relative(root, absolute)
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
}

/** Every writable root, primary first — the order the refusal message lists them in. */
export function writable(roots: Roots): readonly string[] {
    return [roots.primary, ...roots.extra]
}

/** True when this path may be written. */
export function isWritable(absolute: string, roots: Roots): boolean {
    return writable(roots).some((root) => within(absolute, root))
}

/**
 * The sentence every path-taking argument carries, naming the actual directory.
 *
 * Enforcement without instruction is what produced the failure this exists to stop. The tools were
 * confined and the model was never told where it worked — so asked to "create a sample folder" it
 * chose the home directory, which is where a person would put one, and nothing in its context
 * suggested otherwise. A refusal it did not expect is a worse experience than a default it knew.
 *
 * On every argument rather than stated once, because the reminder has to be next to the decision. A
 * small model reads the field it is about to fill in, not the paragraph above the catalogue — the same
 * reasoning that keeps `whenNotToUse` on each tool instead of in a preamble. It costs a few tokens per
 * tool and it is fixed at load, so it stays inside the cache-stable prefix.
 */
export function whereYouWork(roots: Roots, mode: "write" | "read" | "shell"): string {
    const extra = roots.extra.length === 0 ? "" : ` Also writable: ${roots.extra.join(", ")}.`
    if (mode === "read") {
        return roots.confineReads
            ? ` Relative paths are resolved against ${roots.primary}. Only ${writable(roots).join(", ")} can be read; anything elsewhere is refused.`
            : ` Relative paths are resolved against ${roots.primary}. Reading elsewhere is allowed — give an absolute path for it.`
    }
    if (mode === "write") {
        return ` You work in ${roots.primary}. A relative path lands there, and that is where anything you create belongs unless the person names somewhere else. Writing anywhere else is refused.${extra}`
    }
    // The shell gets a *different* sentence, and the difference is the point. Telling it that writing
    // outside the workspace "is refused" would be a lie — a command carries its target inside a string
    // no path check can look inside, and the model would discover that by succeeding. A prompt that
    // claims a guarantee the runtime does not provide is worse than one that claims none.
    return ` Every command starts in ${roots.primary}, and that is where anything you create belongs unless the person names somewhere else. Nothing stops a command from leaving it, so this one is on you: use a relative path, and do not reach for ~ or an absolute path outside it on your own initiative.${extra}`
}

/**
 * Copy a spec with the working directory named in the arguments that take a path.
 *
 * The specs are module constants so they can be asserted without building a provider; the directory is
 * only known per agent. Rewriting on construction keeps both.
 */
export function locate(
    spec: ToolSpec,
    roots: Roots,
    fields: readonly string[],
    mode: "write" | "read" | "shell" = spec.mutating ? "write" : "read",
): ToolSpec {
    const properties: Record<string, JsonSchemaNode> = { ...spec.parameters.properties }
    for (const field of fields) {
        const node = properties[field]
        if (node === undefined) continue
        properties[field] = {
            ...node,
            description: `${node.description ?? ""}${whereYouWork(roots, mode)}`,
        }
    }
    return { ...spec, parameters: { ...spec.parameters, properties } }
}
