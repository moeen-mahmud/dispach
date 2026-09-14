/**
 * Prompts that provoke a multi-line shell value, which is where the NLT parser loses one.
 *
 * Every task here asks for something whose natural `exec` argument spans lines — a script piped to
 * an interpreter, a file written with a shell heredoc, a loop. That is deliberate and it is the
 * whole fixture: the carried backlog records the leak against `python3 <<PY`, and the repo's own
 * rule is that the set of malformations is not enumerable, so the shapes have to be collected from
 * a model rather than invented here.
 *
 * What is **not** here: a task whose right answer is a one-line command. Those are covered by
 * `evals/tools` and would only dilute the rate this fixture exists to measure.
 *
 * The two shapes already known, recorded so a reader knows what the collector is looking for:
 *
 *   blank line     `command: python3 <<PY` … blank … rest of the script becomes the **reply**,
 *                  the truncated command is a valid string, nothing is reported. Silent.
 *   bare `word:`   `try:` inside an unwrapped value becomes a field, `coerceArgs` says it is not a
 *                  field of this tool, and the model earns a repair. Loud, and survivable.
 */

export interface HeredocTask {
    readonly id: string
    /** What the person asks for. */
    readonly prompt: string
    /**
     * Why this one provokes a multi-line value — read when a task stops provoking anything and
     * somebody has to decide whether the model changed or the prompt went stale.
     */
    readonly provokes: string
}

export const HEREDOC_TASKS: readonly HeredocTask[] = [
    {
        id: "python-heredoc",
        prompt: "Write a Python script that prints the first 20 prime numbers and run it right now, without saving it to a file first.",
        provokes:
            "python3 <<PY — the exact shape in the carried backlog, and the most idiomatic way to run a script without a file.",
    },
    {
        id: "python-blank-lines",
        prompt: "Run a Python script that defines a function to reverse a string, then a separate function to check if a word is a palindrome, then tests both. Don't save it to a file. Leave a blank line between the functions so it's readable.",
        provokes:
            "Asks for the blank line explicitly. PEP 8 puts one between top-level definitions anyway, so this is what a model produces unprompted on any script longer than a few lines.",
    },
    {
        id: "python-try-except",
        prompt: "Without creating any files, run a Python one-off that tries to open /etc/hostname, prints its contents, and handles the case where it doesn't exist.",
        provokes:
            "`try:` and `except` — the loud variant, where a bare word-colon line becomes a field and earns a repair.",
    },
    {
        id: "bash-loop",
        prompt: "Run a shell loop that prints each .md file in the current directory along with its line count.",
        provokes: "A `for … do … done` written across lines rather than with semicolons.",
    },
    {
        id: "write-yaml-heredoc",
        prompt: "Create a file called ci.yml in the current directory containing a GitHub Actions workflow that runs `bun test` on push. Use the shell to write it.",
        provokes: "`cat > ci.yml <<'YAML'` with a blank-line-separated YAML document inside it.",
    },
    {
        id: "write-script-file",
        prompt: "Write a bash script to deploy.sh that checks a DEPLOY_ENV variable is set, exits with a message if it isn't, and otherwise prints what it would do. Make it executable.",
        provokes:
            "A heredoc holding a script that itself contains blank lines and an `if` block, then a second command to chmod it.",
    },
    {
        id: "sql-multiline",
        prompt: "Run a SQL query against the SQLite database at ./store.db that lists the five largest tables by row count. Format the query readably across multiple lines.",
        provokes:
            "Asks for readable formatting of a value that has no reason to be one line — the same class, with no interpreter involved.",
    },
    {
        id: "multi-step-script",
        prompt: "Check whether this project's tests pass: find the test command in package.json, then run it, then summarise what failed.",
        provokes:
            "No multi-line value is required at all. Present as a control — if this one truncates, the diagnosis is wrong.",
    },
]
