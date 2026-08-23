/**
 * Path globbing and directory walking, hand-rolled.
 *
 * Core's `globToRegExp` is not reusable here: it matches model ids, where `*` may cross anything and
 * there are no path separators to respect. A path glob has to distinguish `*` from `**`, or
 * `src/*.ts` silently matches `src/a/b/c.ts` and every result is wrong in the direction of too many.
 *
 * `node:fs/promises`'s own `glob` would do it, and is not used. The original reason was that it was
 * experimental on Node 22, the version the compatibility leg of CI ran — and **that reason expired**
 * when the floor moved to 24 (decision 13.5), where it is stable. What has not been done is the work
 * that would justify switching: the two engines would each use their own implementation, and whether
 * `Bun.Glob` and `fs.glob` agree on ordering, on following symlinks, and on whether a pattern may
 * escape the root has not been measured here. So this stays for now because one shared matcher cannot
 * disagree with itself, and the note is that it is a candidate for deletion behind a comparison
 * rather than a decision that still stands on its own.
 *
 * ## What is skipped, and why it is a list rather than a rule
 *
 * `node_modules`, `.git`, `dist` and their friends are skipped by name. The tempting general rule —
 * "skip anything hidden" — is wrong in both directions: it would hide `.github/workflows`, which
 * people ask about constantly, and it would still walk `node_modules`, which is where the time goes.
 * A short list of names is honest about being a list, and `hidden: true` turns off the dot-file half
 * of it for the cases that need it.
 */

import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"

/**
 * Directories never descended into, whatever the pattern says.
 *
 * A build output or a dependency tree can hold a hundred thousand files, and walking one to answer
 * "where is the login component" spends a minute to return noise. Every entry here is generated
 * rather than authored — nothing in them is something a person wrote and would look for.
 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    "vendor",
])

/**
 * A path glob, compiled.
 *
 * `**` crosses separators, `*` and `?` do not, and a leading double-star followed by a slash also
 * matches zero directories — so a recursive TypeScript pattern finds `index.ts` at the root as well
 * as `src/a/b.ts`. That is the behaviour every shell and editor already has, and its absence reads as
 * "the tool is broken" rather than "the pattern was too strict".
 */
export function globToRegExp(pattern: string): RegExp {
    let source = ""
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i] ?? ""
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                // `**/` — zero or more directories. Consume the slash so the separator is optional.
                if (pattern[i + 2] === "/") {
                    source += "(?:.*/)?"
                    i += 2
                    continue
                }
                source += ".*"
                i += 1
                continue
            }
            source += "[^/]*"
            continue
        }
        if (char === "?") {
            source += "[^/]"
            continue
        }
        source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`^${source}$`)
}

export interface WalkOptions {
    /** Walk stops here. Reported rather than silently trimmed — see `WalkResult.truncated`. */
    readonly limit: number
    /** Descend into dot-directories. `SKIPPED_DIRS` still applies. */
    readonly hidden?: boolean
    /** Called per file with its path relative to the root, using forward slashes. */
    readonly accept?: (relativePath: string) => boolean
}

export interface WalkResult {
    /** Relative to the root, forward-slashed, in the order found. */
    readonly files: readonly string[]
    /** True when `limit` stopped the walk. Never silent — a partial answer must say so. */
    readonly truncated: boolean
}

/** Forward slashes whatever the platform, because a pattern is written with them. */
function posix(path: string): string {
    return sep === "/" ? path : path.split(sep).join("/")
}

/**
 * Breadth-first, so a cut-off walk returns the shallow files rather than one deep branch.
 *
 * Depth-first with a limit is the shape that looks fine in a test on a small tree and returns
 * nothing useful on a real repository: it spends the whole budget inside the first subdirectory it
 * happens to enter.
 */
export async function walk(root: string, options: WalkOptions): Promise<WalkResult> {
    const files: string[] = []
    const queue: string[] = [root]

    while (queue.length > 0) {
        const dir = queue.shift()
        if (dir === undefined) break

        let entries: Dirent[]
        try {
            entries = await readdir(dir, { withFileTypes: true })
        } catch {
            // Unreadable directory. Skipped rather than fatal: one permission-denied subdirectory
            // must not turn a whole search into an error, and the caller sees the files that were
            // readable — which is the useful half of the answer.
            continue
        }

        for (const entry of entries) {
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
                if (SKIPPED_DIRS.has(entry.name)) continue
                if (options.hidden !== true && entry.name.startsWith(".")) continue
                queue.push(full)
                continue
            }
            if (!entry.isFile()) continue
            if (options.hidden !== true && entry.name.startsWith(".")) continue

            const rel = posix(relative(root, full))
            if (options.accept !== undefined && !options.accept(rel)) continue
            if (files.length >= options.limit) return { files, truncated: true }
            files.push(rel)
        }
    }

    return { files, truncated: false }
}
