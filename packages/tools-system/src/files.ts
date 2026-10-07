/**
 * `file_read`, `file_write`, `file_edit` — the structured half of system access.
 *
 * ## Why these exist when `exec` could do all of it
 *
 * Not convenience. A `file_write` call carries a `path` field, so a policy rule can match the target
 * exactly and the protected set can refuse it; `echo x > "$F"` carries the same target inside a
 * string nothing can inspect. **The structured tools are the layer where permissions actually
 * work**, which is why `exec`'s own description argues for them and why they are worth the catalogue
 * tokens they cost.
 *
 * ## Trust: these three are `trusted`, and that is not an oversight
 *
 * `file_read` is `untrusted` — a file on disk may have been downloaded a minute ago. The three
 * writers return text the *runtime* composed ("Wrote 42 lines to notes.md") and never echo content,
 * so marking them untrusted would mean a write tainted the turn and blocked the next write. That is
 * the once-per-turn trap `exec` warns about, arrived at by accident rather than by design.
 *
 * ## Where a relative path resolves
 *
 * Against the shell session's working directory, the same one `exec`'s `cd` moves — not against
 * `process.cwd()` and not against the agent's directory unconditionally. One notion of "where we
 * are" across the whole package is what makes `cd ~/project` followed by `file_read package.json`
 * behave the way a person means it. Without it the two tools disagree about the same words, which is
 * a bug the model gets blamed for.
 *
 * ## Read before edit
 *
 * `file_edit` matches an exact, unique string rather than a line number. A line number is a fact
 * about a file the model may last have seen several turns ago; an exact string carries its own
 * proof. Two matches is a failure and not a coin toss, because the alternative is editing the wrong
 * one and reporting success.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { stripControl, type Tool, type ToolHandler } from "@dispach/core"
import {
    fileEditAmbiguous,
    fileEditNoMatch,
    fileIsBinary,
    fileMissing,
    fileOutsideRoot,
    filePathEmpty,
    fileProtected,
    fileSecret,
    fileTooLarge,
} from "./errors.ts"
import { SYSTEM_PROVIDER_ID } from "./paths.ts"
import { protectedReason, secretReason } from "./protect.ts"
import { assertReadable, expandTilde, isWritable, locate, type Roots, writable } from "./root.ts"
import type { ShellSessions } from "./session.ts"

/**
 * Read cap, in bytes. Well above the observation budget on purpose: the tool reads the file and
 * then reports how much of it the model is seeing, which is more useful than refusing outright.
 */
export const MAX_READ_BYTES = 2_000_000

/** Lines returned when the caller names no window. */
export const DEFAULT_READ_LINES = 400

export interface FileOptions {
    readonly sessions: ShellSessions
    /** The agent's own directory, for the protected set. */
    readonly agentDir: string
    /**
     * Where writes are allowed, and where a relative path resolves when no shell has moved.
     *
     * Two mechanisms, not one. `protect` is a deny list and has to anticipate every path worth
     * protecting; the root anticipates nothing, because everything outside it is refused and the
     * exceptions are written by a person. Both apply, and `protect` wins — a protected file inside
     * the root is still protected.
     */
    readonly roots: Roots
    readonly protect?: readonly string[]
}

/** A file whose bytes are not text. Cheap and good enough: real binaries hit a NUL almost at once. */
function looksBinary(bytes: Uint8Array): boolean {
    const window = bytes.subarray(0, 8_000)
    return window.includes(0)
}

export const FILE_READ_SPEC: Tool["spec"] = {
    slug: "file_read",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Reads a file and returns its contents.",
    whenToUse:
        "you need to see what is in a file — its code, its configuration, its text — before answering about it or changing it",
    whenNotToUse:
        "you are looking for which files exist or which ones mention something; that is glob and grep. Never read a file by running cat through the shell",
    mutating: false,
    trust: "untrusted",
    policyArg: "path",
    policyArgIsPath: true,
    tags: ["read", "file"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "The file, absolute or relative to the current working directory.",
            },
            offset: {
                type: "integer",
                description: "First line to return, counting from 1. Use for a long file.",
            },
            limit: {
                type: "integer",
                description: `How many lines to return. Defaults to ${DEFAULT_READ_LINES}.`,
                default: DEFAULT_READ_LINES,
            },
        },
        required: ["path"],
    },
}

export const FILE_WRITE_SPEC: Tool["spec"] = {
    slug: "file_write",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Writes a file, creating any folders it needs, and replaces it if it already exists.",
    whenToUse:
        "you are creating a new file, or replacing one whose whole contents you are producing. Folders in the path are created for you, so this needs no separate step and no shell",
    whenNotToUse:
        "you are changing part of an existing file — that is file_edit, which cannot silently destroy the rest of it",
    mutating: true,
    trust: "trusted",
    trustReason:
        "It reports what it wrote — the path, the line count — and never any of the content, so nothing from the file reaches the model through it.",
    policyArg: "path",
    policyArgIsPath: true,
    tags: ["write", "file"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "The file, absolute or relative to the current working directory.",
            },
            content: { type: "string", description: "The complete new contents." },
        },
        required: ["path", "content"],
    },
}

export const FILE_EDIT_SPEC: Tool["spec"] = {
    slug: "file_edit",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Replaces an exact piece of text in a file, leaving the rest untouched.",
    whenToUse:
        "you are changing part of a file you have already read — a line, a block, a value — and everything else should stay as it is",
    whenNotToUse:
        "you have not read the file in this conversation, or you are writing the whole thing; guessing at text that is already there fails rather than damaging the file, but it still wastes the step",
    mutating: true,
    trust: "trusted",
    trustReason:
        "It reports which occurrence changed and how long the file now is, never the text on either side of the change.",
    policyArg: "path",
    policyArgIsPath: true,
    tags: ["write", "file"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "The file, absolute or relative to the current working directory.",
            },
            find: {
                type: "string",
                description:
                    "The exact text to replace, copied from the file including its indentation. It must appear exactly once unless all is true.",
            },
            replace: { type: "string", description: "What to put in its place." },
            all: {
                type: "boolean",
                description: "Replace every occurrence instead of requiring exactly one.",
                default: false,
            },
        },
        required: ["path", "find", "replace"],
    },
}

/**
 * The one place a caller-supplied path becomes an absolute one.
 *
 * `resolve` rather than string concatenation, because the string form leaves `../` in the path and a
 * confinement check performed on `<root>/../../etc/passwd` passes. The traversal has to be collapsed
 * *before* anything compares the result to a root, and doing it here means no caller can forget.
 */
export function resolvePath(
    raw: unknown,
    sessions: ShellSessions,
    sessionKey: string,
    base: string,
): string {
    const given = expandTilde(typeof raw === "string" ? raw.trim() : "")
    if (given === "") throw filePathEmpty()
    const from = sessions.lastCwd(sessionKey) ?? base
    return isAbsolute(given) ? resolve(given) : resolve(from, given)
}

/**
 * Every check a write has to pass, in the order it has to pass them.
 *
 * The root is checked first because it is the cheaper and broader question — "may this agent change
 * anything here at all" — and the protected set second, because a protected file *inside* the root is
 * still protected. Both refusals name what would change the answer, except the one that nothing does.
 */
function assertWritable(path: string, options: FileOptions): void {
    if (!isWritable(path, options.roots)) {
        throw fileOutsideRoot(path, writable(options.roots))
    }
    const refusal = protectedReason(path, {
        agentDir: options.agentDir,
        ...(options.protect === undefined ? {} : { extra: options.protect }),
    })
    if (refusal !== undefined) throw fileProtected(path, refusal)
}

function numberArg(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function fileReadHandler(options: FileOptions): ToolHandler {
    return async (args, context) => {
        const path = resolvePath(
            args.path,
            options.sessions,
            context.sessionKey,
            options.roots.primary,
        )

        assertReadable(path, options.roots)
        // The real path: a symlink named `notes.txt` that points at `.env` is still `.env`.
        const secret = secretReason(await realpath(path).catch(() => path)) ?? secretReason(path)
        if (secret !== undefined) throw fileSecret(path, secret)

        let size: number
        try {
            size = (await stat(path)).size
        } catch {
            throw fileMissing(path)
        }
        if (size > MAX_READ_BYTES) throw fileTooLarge(path, size, MAX_READ_BYTES)

        const bytes = await readFile(path)
        if (looksBinary(bytes)) throw fileIsBinary(path, size)

        // Escapes stripped here as well as in the trust renderer. A file that was downloaded can
        // carry them, and the byte counts reported below are computed on what the model will
        // actually see rather than on what was on disk.
        const text = stripControl(bytes.toString("utf8"))
        const lines = text.split("\n")
        const offset = Math.max(1, numberArg(args.offset) ?? 1)
        const limit = Math.max(1, numberArg(args.limit) ?? DEFAULT_READ_LINES)
        const slice = lines.slice(offset - 1, offset - 1 + limit)

        if (slice.length === 0) {
            return `${path} has ${lines.length} lines, so there is nothing at line ${offset}.`
        }

        const body = slice.join("\n")
        const shown = offset - 1 + slice.length
        // A window is announced only when there is more to come. Saying "lines 1-12 of 12" on every
        // short file is a per-call tax for information the model already has.
        if (offset === 1 && shown >= lines.length) return body
        return `Lines ${offset}-${shown} of ${lines.length} in ${path}:\n${body}`
    }
}

export function fileWriteHandler(options: FileOptions): ToolHandler {
    return async (args, context) => {
        const path = resolvePath(
            args.path,
            options.sessions,
            context.sessionKey,
            options.roots.primary,
        )
        assertWritable(path, options)

        const content = typeof args.content === "string" ? args.content : String(args.content ?? "")
        const existed = await stat(path).then(
            () => true,
            () => false,
        )

        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, "utf8")

        // The count is stated so the model does not read the file back to check — a re-read after
        // every write doubles the steps of any editing task, and small models do it by default
        // unless the acknowledgement is specific enough to be believable.
        const lines = content === "" ? 0 : content.split("\n").length
        return `${existed ? "Replaced" : "Created"} ${path} — ${lines} line${lines === 1 ? "" : "s"}, ${content.length} characters.`
    }
}

export function fileEditHandler(options: FileOptions): ToolHandler {
    return async (args, context) => {
        const path = resolvePath(
            args.path,
            options.sessions,
            context.sessionKey,
            options.roots.primary,
        )
        assertWritable(path, options)

        const find = typeof args.find === "string" ? args.find : ""
        const replace = typeof args.replace === "string" ? args.replace : ""

        let before: string
        try {
            before = await readFile(path, "utf8")
        } catch {
            throw fileMissing(path)
        }

        const occurrences = find === "" ? 0 : before.split(find).length - 1
        if (occurrences === 0) throw fileEditNoMatch(path, find)
        if (occurrences > 1 && args.all !== true) throw fileEditAmbiguous(path, occurrences)

        const after =
            args.all === true ? before.split(find).join(replace) : before.replace(find, replace)
        await writeFile(path, after, "utf8")

        const changed = args.all === true ? occurrences : 1
        return `Edited ${path} — replaced ${changed} occurrence${changed === 1 ? "" : "s"}. The file is now ${after.split("\n").length} lines.`
    }
}

export function fileTools(options: FileOptions): readonly Tool[] {
    // The directory is named in the `path` argument of each, because that is the field the model is
    // filling in when it decides where something goes.
    const at = (spec: Tool["spec"]): Tool["spec"] => locate(spec, options.roots, ["path"])
    return [
        { spec: at(FILE_READ_SPEC), handler: fileReadHandler(options) },
        { spec: at(FILE_WRITE_SPEC), handler: fileWriteHandler(options) },
        { spec: at(FILE_EDIT_SPEC), handler: fileEditHandler(options) },
    ]
}
