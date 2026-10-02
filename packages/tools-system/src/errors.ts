/**
 * Every failure this package can produce, each with a hint.
 *
 * Built on core's `ConfigError` / `ToolError` rather than a local error type, so a shell failure is
 * reported and rendered exactly like a manifest or a Composio failure. The package is a provider,
 * not a second error vocabulary.
 */

import { ConfigError, ToolError } from "@dispach/core"

export function execCommandEmpty(): ToolError {
    return new ToolError({
        code: "exec_command_empty",
        message: "exec was called with no command.",
        hint: "Put the whole shell command in the command field, exactly as it would be typed at a prompt — for example `ls -la` or `npm test`.",
    })
}

export function execWorkdirMissing(path: string, remembered: boolean): ConfigError {
    return new ConfigError({
        code: "exec_workdir_missing",
        message: `The directory to run in does not exist: ${path}`,
        hint: remembered
            ? "This is where a previous exec call left the shell, and it has since been removed or renamed. The remembered directory has been cleared, so the next call starts from the agent's own directory; pass workdir to choose a different one."
            : "workdir must name a directory that already exists. A relative path is resolved against the directory the last exec call ended in, the way a shell would.",
        field: "workdir",
    })
}

export function execPtyUnavailable(platform: string, cause: string): ToolError {
    return new ToolError({
        code: "exec_pty_unavailable",
        message: `A terminal was requested and this machine cannot provide one: ${cause}`,
        hint: `pty: true allocates a terminal with the system \`script\` command, which is missing or unusable on this ${platform} host. Refused rather than quietly falling back to a pipe: the fallback would run the command with no terminal while the observation claimed otherwise, and a program that checks isatty() would take the other branch with nothing reporting it. Re-run with pty omitted if the command does not need one.`,
        field: "pty",
    })
}

export function execSpawnFailed(command: string, cause: string): ToolError {
    return new ToolError({
        code: "exec_spawn_failed",
        message: `The shell could not be started for: ${command}`,
        hint: `The operating system refused before the command ran, so nothing was executed: ${cause}. This is a failure of the host rather than of the command — check that /bin/sh exists and that the directory is readable.`,
    })
}

// ─── the file family ─────────────────────────────────────────────────────────────────────

export function filePathEmpty(): ToolError {
    return new ToolError({
        code: "file_path_empty",
        message: "A file tool was called with no path.",
        hint: "Give the path field a value — either absolute, or relative to the current working directory, which is wherever the last exec call left it.",
    })
}

export function fileMissing(path: string): ToolError {
    return new ToolError({
        code: "file_missing",
        message: `There is no file at ${path}.`,
        hint: "Check the path against what glob returns rather than guessing at it. A relative path is resolved against the current working directory, which starts at the agent's own directory and moves when a shell command changes it.",
        field: "path",
    })
}

export function fileTooLarge(path: string, size: number, max: number): ToolError {
    return new ToolError({
        code: "file_too_large",
        message: `${path} is ${size} bytes, over the ${max}-byte limit for reading.`,
        hint: "Use grep to find the part that matters and read around it with offset and limit, rather than pulling the whole file into the conversation.",
        field: "path",
    })
}

export function fileIsBinary(path: string, size: number): ToolError {
    return new ToolError({
        code: "file_is_binary",
        message: `${path} is not a text file (${size} bytes).`,
        hint: "Refused rather than decoded: a binary rendered as text is thousands of meaningless tokens and no information. If something about the file is needed — its type, its size, what it contains — a shell command that inspects it will answer better.",
        field: "path",
    })
}

/**
 * The refusal that stops an agent editing its own definition.
 *
 * Worded so the model reports rather than retries: there is no argument that gets past this, and a
 * refusal that reads like a transient failure produces the retry storm `memory_write` once caused.
 */
export function fileSecret(path: string, reason: string): ToolError {
    return new ToolError({
        code: "file_secret",
        message: `Refused to read ${path}: ${reason}.`,
        hint: "Credentials are never read into a conversation. If a task needs a key, it is configured by name in the manifest and the tool that needs it reads it; ask the person rather than looking for the value.",
    })
}

export function fileProtected(path: string, reason: string): ToolError {
    return new ToolError({
        code: "file_protected",
        message: `${path} cannot be written: ${reason}.`,
        hint: "This is a standing rule and no permission setting overrides it — a rule that authorised writing to the agent's own definition would be a rule authorising its own replacement. Say what change was wanted and let the person make it themselves.",
        field: "path",
    })
}

export function fileEditNoMatch(path: string, find: string): ToolError {
    const preview = find.length > 120 ? `${find.slice(0, 120)}…` : find
    return new ToolError({
        code: "file_edit_no_match",
        message: `That text does not appear in ${path}: ${JSON.stringify(preview)}`,
        hint: "The match is exact, including indentation and line breaks. Read the file and copy the text out of it rather than reconstructing it from memory — nothing was changed, so the file is still as it was.",
        field: "find",
    })
}

export function fileEditAmbiguous(path: string, occurrences: number): ToolError {
    return new ToolError({
        code: "file_edit_ambiguous",
        message: `That text appears ${occurrences} times in ${path}, so it does not identify one place.`,
        hint: "Nothing was changed: picking one of several matches would be a guess, and a wrong guess reports success while editing the wrong line. Include a surrounding line or two to make it unique, or pass all: true if every occurrence should change.",
        field: "find",
    })
}

export function grepPatternInvalid(pattern: string, cause: string): ToolError {
    return new ToolError({
        code: "grep_pattern_invalid",
        message: `That is not a valid regular expression: ${pattern}`,
        hint: `${cause}. Refused rather than searched literally — a literalised pattern finds nothing and returns an empty result, which reads as "it is not there" instead of "the pattern was wrong". Escape any regex character meant literally, such as a dot or a bracket.`,
        field: "pattern",
    })
}

/**
 * A write outside every writable root.
 *
 * Distinct from `fileProtected` on purpose. That refusal is permanent and no setting overrides it;
 * this one names the setting that would allow it, because "work in my project directory" is an
 * entirely reasonable thing to want and the answer is one line of manifest rather than a refusal.
 */
export function fileOutsideRoot(path: string, roots: readonly string[]): ToolError {
    return new ToolError({
        code: "file_outside_root",
        message: `${path} is outside the directories this agent may change.`,
        hint: `Writable: ${roots.join(", ")}. Everything else is read-only by default — an agent that has misunderstood a request cannot damage anything while misunderstanding it. To work somewhere else, the person you work for adds it to tools.providerConfig.writeRoots in agent.yaml; nothing said in a conversation can add one. Reading outside these directories is allowed and unaffected.`,
        field: "path",
    })
}

// ─── the agent's own configuration ───────────────────────────────────────────────────────

export function configReadFailed(file: string, cause: string): ToolError {
    return new ToolError({
        code: "config_read_failed",
        message: `This agent's configuration could not be read from ${file}.`,
        hint: `${cause}. The agent is running, so the file existed at boot — it has been moved or its permissions have changed since.`,
    })
}

export function configPathUnknown(path: string, known: readonly string[]): ToolError {
    return new ToolError({
        code: "config_path_unknown",
        message: `"${path}" is not a setting config_set will change.`,
        hint: `Settable: ${known.join(", ")}. Deliberately a list rather than anything the schema accepts: a tool that can write any field can write the ones that decide what it is allowed to do, and the list is where that judgement lives. Call config_read with no path to see each one explained.`,
        field: "path",
    })
}

export function configValueUnreadable(raw: string, cause: string): ToolError {
    return new ToolError({
        code: "config_value_unreadable",
        message: `That value could not be read: ${JSON.stringify(raw)}`,
        hint: `${cause}. Write it the way it would appear in the file — a bare word, a number, or a list as ["a", "b"]. Refused rather than guessed at, because guessing is how tools.pinned becomes a list of single characters.`,
        field: "value",
    })
}

export function configInvalid(path: string, raw: string, why: string): ToolError {
    return new ToolError({
        code: "config_invalid",
        message: `Setting ${path} to ${JSON.stringify(raw)} would produce a configuration that does not load: ${why}`,
        hint: "Nothing was written, so the agent is unchanged and still starts. An invalid manifest is not a failure that shows up now — it is one that shows up at the next boot, by which time the change looks like it succeeded.",
        field: "value",
    })
}

/**
 * The floor under `config_set`. Three edits, all in the direction of "stop checking".
 *
 * Everything that *grants* — pinning a tool, adding an allow rule, opening a write root — is settable,
 * because granting is what a person asks for. A guard the agent can switch off on request is not a
 * guard, so these two are not settable at all.
 */
export function configRefused(path: string, why: string): ToolError {
    return new ToolError({
        code: "config_refused",
        message: `${path} cannot be changed from inside a conversation: ${why}.`,
        hint: "No permission rule overrides this, and asking again will not change it. Every other setting can be changed — including enabling a tool or adding a permission rule, which is what this tool is for. Name the exact line you would have added and let the person put it in themselves.",
        field: "path",
    })
}

/**
 * Too many commands already left running in the background.
 *
 * A loud refusal rather than a thirty-fourth silent success. Backgrounding is deliberate — a long
 * build should not be thrown away at the deadline — but nothing bounded it, and a day of that left
 * 33 orphaned shells at ~23% CPU each on the author's machine: load average 351, and a
 * `runtime.ready` that took 132 seconds. The message names what is already running, because "too
 * many" without the list is a refusal nobody can act on.
 */
export function execTooManyBackground(running: readonly string[]): ToolError {
    return new ToolError({
        code: "exec_too_many_background",
        message: `${running.length} commands are already running in the background, which is the limit.`,
        hint: `Wait for one to finish, or stop one yourself. Already running: ${running
            .map((command) => (command.length > 60 ? `${command.slice(0, 57)}...` : command))
            .join(
                "; ",
            )}. A command that outruns its timeout is left running rather than discarded, so a loop that starts one per attempt reaches this quickly — which is the point of the limit.`,
    })
}
