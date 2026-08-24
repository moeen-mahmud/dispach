/**
 * Which terminal this is, and what it would take to make shift+enter send a newline.
 *
 * ## The problem, stated once
 *
 * A terminal sends the byte `CR` for enter. For shift+enter it sends… `CR`. The two are the same
 * keystroke as far as the process is concerned, which is why every terminal-based chat app either
 * documents a different chord or asks you to install a key binding.
 *
 * The sequence to install is `CSI 13;2u` — the kitty keyboard protocol's encoding of "return with
 * shift". Ink already parses it into `return + shift` (measured, not assumed), so nothing in the runtime
 * needs to change: the terminal either sends something distinguishable or it does not.
 *
 * ⌥⏎ is always available and needs none of this, because it arrives as `ESC` then `CR` — two bytes, and
 * therefore already distinguishable. That is why it is the documented chord and this command is an
 * optional convenience rather than a prerequisite.
 *
 * ## Why some terminals are written and others are explained
 *
 * A terminal whose configuration is a text file can be edited safely: append a line, keep a backup, and
 * a person can read the diff. A terminal whose configuration is a binary plist inside an array of
 * profiles cannot — iTerm2 also holds its preferences in memory and rewrites them on quit, so an edit
 * made underneath it is silently discarded. Writing one anyway would produce the worst outcome
 * available: a command that reports success and changes nothing.
 *
 * So `write` terminals get a file edit and `explain` terminals get the exact steps. The difference is a
 * property of the terminal, recorded here rather than discovered per user.
 *
 * Pure and PURE-listed: detection is a function of the environment *passed in*, and the recipes are
 * data. The file I/O lives in `terminal-setup.ts`.
 */

/** The sequence a terminal must send for shift+enter. Ink parses this into `return + shift`. */
export const SHIFT_ENTER_SEQUENCE = "\u001B[13;2u"

/** The same thing spelled for a config file that wants an escaped literal rather than the byte. */
export const SHIFT_ENTER_ESCAPED = "\\x1b[13;2u"

import { BRAND } from "@dispach/core"

export type TerminalId =
    | "vscode"
    | "ghostty"
    | "kitty"
    | "wezterm"
    | "iterm2"
    | "apple"
    | "warp"
    | "unknown"

export interface TerminalRecipe {
    readonly id: TerminalId
    readonly name: string
    /**
     * `write` — the configuration is a text file this command can append to.
     * `explain` — it is not, so the steps are printed and a person performs them.
     * `unverified` — the terminal is known, and there is no recipe anyone has checked.
     *
     * The third state earns itself because both alternatives are worse. Reporting a known terminal as
     * "not recognised" is a lie about what we know; inventing a recipe for it produces the one outcome
     * this module is arranged to avoid — a command that reports success and changes nothing. Found by
     * running the command: the author's own terminal turned out to be one of these.
     *
     * There was briefly a fourth, `none` — "nothing to configure" — added when the kitty keyboard protocol
     * turned out to make shift+⏎ work in Warp on its own. It is gone, because the measurement behind it was
     * incomplete: the protocol fixes the *arrow* chords and not the letter ones, so Warp does have a step
     * after all. Recorded here rather than silently reverted, because the mistake is the useful part — a
     * state was invented for a case that a fuller measurement dissolved, and a state nothing reaches is
     * exactly the dead vocabulary this repo keeps removing.
     */
    readonly how: "write" | "explain" | "unverified"
    /** Path relative to the home directory. Absent for an `explain` terminal. */
    readonly configPath?: string
    /** The line to add. Absent for an `explain` terminal. */
    readonly line?: string
    /** How to tell whether the line is already there — a substring, not a regex, so it cannot over-match. */
    readonly marker?: string
    /** For `explain`: the steps, in order. */
    readonly steps?: readonly string[]
    /** Why this terminal cannot be configured automatically. Present whenever `how` is `explain`. */
    readonly reason?: string
}

const RECIPES: readonly TerminalRecipe[] = [
    {
        id: "vscode",
        name: "VS Code's integrated terminal",
        how: "write",
        configPath: "Library/Application Support/Code/User/keybindings.json",
        // `sendSequence` is the only command that can put arbitrary bytes on the pty; the JSON escape
        // is what VS Code's argument parser expects, not a shell escape.
        line: `{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b[13;2u" } }`,
        marker: "workbench.action.terminal.sendSequence",
    },
    {
        id: "ghostty",
        name: "Ghostty",
        how: "write",
        configPath: ".config/ghostty/config",
        line: `keybind = shift+enter=text:${SHIFT_ENTER_ESCAPED}`,
        marker: "shift+enter=text:",
    },
    {
        id: "kitty",
        name: "kitty",
        how: "write",
        configPath: ".config/kitty/kitty.conf",
        // kitty speaks this protocol natively, but only advertises it to an application that asks. Ink
        // does not ask, so the mapping is still needed.
        line: `map shift+enter send_text all ${SHIFT_ENTER_ESCAPED}`,
        marker: "map shift+enter send_text",
    },
    {
        id: "wezterm",
        name: "WezTerm",
        how: "write",
        configPath: ".wezterm.lua",
        line: `-- shift+enter: { key = 'Enter', mods = 'SHIFT', action = wezterm.action.SendString '\\x1b[13;2u' },`,
        marker: "mods = 'SHIFT', action = wezterm.action.SendString",
    },
    {
        id: "warp",
        name: "Warp",
        how: "explain",
        // Corrected twice, and the second correction is the instructive one.
        //
        // It was `unverified`. Then the kitty keyboard protocol turned out to fix the *arrow* chords, so
        // this became `none` — nothing to configure. Measured against a real session, that was wrong for
        // **letters**: ⌥r still arrives as the composed character `®`, because Warp resolves Option to a
        // character before the protocol layer ever sees the key. Pushing `CSI > 3 u` does not change it.
        //
        // So there is one thing to configure after all, and it is a Warp setting rather than a file. What
        // it buys is only the option-*letter* chords: ⌥←/⌥→ and every cmd chord already work without it,
        // because those carry their modifier inside the sequence.
        reason: "Option is resolved to a character before the keyboard protocol sees it, so ⌥ plus a letter arrives as text like `®` unless Warp is told otherwise",
        steps: [
            "Settings → Features → Keys → tick “Left and Right Option Key is Meta”",
            "That is only needed for ⌥ plus a *letter*. ⌥ and cmd with arrows already work, and so does shift+⏎",
            `Every letter chord here has a control-key twin that needs none of this — \`${BRAND.slug} keys\` shows exactly what your terminal sends`,
        ],
    },
    {
        id: "iterm2",
        name: "iTerm2",
        how: "explain",
        reason: "its preferences are a binary plist it rewrites on quit, so an edit made underneath it is discarded",
        steps: [
            "Settings → Profiles → Keys → Key Mappings",
            "Press +, then press shift and return together to capture the key",
            "Set Action to “Send Hex Codes”",
            "Enter: 0x1b 0x5b 0x31 0x33 0x3b 0x32 0x75",
        ],
    },
    {
        id: "apple",
        name: "Terminal.app",
        how: "explain",
        reason: "its key bindings live in the same binary preferences file, and it caches them while running",
        steps: [
            "Settings → Profiles → Keyboard",
            "Press +, choose Return as the key and tick Shift",
            "Set Action to “Send Text” and enter: \\033[13;2u",
        ],
    },
]

/**
 * Which terminal is running this, from the environment it was given.
 *
 * Order matters. VS Code sets `TERM_PROGRAM=vscode` while its integrated terminal may *also* be running
 * under another emulator's variables, and the innermost one is the one whose key bindings apply. The
 * program-specific variables are therefore checked before the generic `TERM`, which is the only one a
 * multiplexer rewrites.
 */
export function detectTerminal(env: Readonly<Record<string, string | undefined>>): TerminalId {
    const program = env.TERM_PROGRAM ?? ""
    if (program === "vscode") return "vscode"
    if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR !== undefined) return "ghostty"
    if (env.KITTY_WINDOW_ID !== undefined || env.TERM === "xterm-kitty") return "kitty"
    if (env.WEZTERM_PANE !== undefined) return "wezterm"
    if (program === "WarpTerminal") return "warp"
    if (program === "iTerm.app") return "iterm2"
    if (program === "Apple_Terminal") return "apple"
    return "unknown"
}

export function recipeFor(id: TerminalId): TerminalRecipe | undefined {
    return RECIPES.find((recipe) => recipe.id === id)
}

/** Every terminal this command knows, for `--help` and for the "not this one" message. */
export function knownTerminals(): readonly TerminalRecipe[] {
    return RECIPES
}

/**
 * Is the binding already installed?
 *
 * Substring rather than an exact line, because a person may have written it differently — a different
 * indent, a comment after it, VS Code's own formatting of the JSON. Reporting "already configured" for a
 * hand-written equivalent is right; rewriting it would produce a duplicate binding whose behaviour
 * depends on which the terminal reads last.
 */
export function alreadyConfigured(contents: string, recipe: TerminalRecipe): boolean {
    return recipe.marker !== undefined && contents.includes(recipe.marker)
}

/**
 * The file's new contents.
 *
 * VS Code's `keybindings.json` is an array, so the line goes *inside* it and cannot simply be appended;
 * everything else is a line-oriented config where appending is correct. Both cases keep whatever was
 * there — this never rewrites a file it did not author.
 */
export function withBinding(contents: string, recipe: TerminalRecipe): string | undefined {
    const line = recipe.line
    if (line === undefined) return undefined
    if (recipe.id !== "vscode") {
        const body = contents.trimEnd()
        return body === "" ? `${line}\n` : `${body}\n${line}\n`
    }

    // An empty or missing keybindings.json becomes a one-element array. Anything else must be an array
    // literal, and the insert goes after the opening bracket so no trailing-comma question arises.
    const body = contents.trim()
    if (body === "" || body === "[]") return `[\n    ${line}\n]\n`
    const open = body.indexOf("[")
    if (open === -1) return undefined
    const rest = body.slice(open + 1).trimStart()
    // `]` immediately after the bracket means the array only *looked* non-empty (comments, whitespace).
    const separator = rest.startsWith("]") ? "" : ","
    return `${body.slice(0, open + 1)}\n    ${line}${separator}\n${body.slice(open + 1)}`
}
