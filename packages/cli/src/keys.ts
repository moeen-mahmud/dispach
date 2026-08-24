/**
 * `keys` — press a chord and see what actually arrived.
 *
 * The instrument this repo did not have. Every previous round of keyboard work was diagnosed by reading
 * Ink's parser and reasoning about what a terminal *probably* sends, which is exactly what CLAUDE.md says
 * not to do — and it is how `⌥r` stayed broken through nine rounds while every test passed: the tests
 * built `KeyState` objects by hand, so they proved the switch and never the delivery.
 *
 * Three layers per keystroke, so a failure names which one is wrong: the bytes the terminal wrote, Ink's
 * reading of them, and the intent this repo's keymap resolved. Paste it into an issue and there is nothing
 * left to guess about.
 */

import { HarnessError } from "@dispach/core"
import { ENTER_ALT_SCREEN, EXIT_OK, FALLBACK_COLUMNS } from "#lib/const"
import { flushOutput, markAltScreen, onExit, restoreTerminal } from "#lib/exit"
import { negotiateKeyboard } from "#lib/keyboard"
import { resolveModeFromProcess } from "#lib/output"
import { screenColumns } from "#lib/screen"
import { openTap } from "#lib/stdin-tap"
import { detectTerminal, recipeFor } from "#lib/terminal"

export interface KeysCommandOptions {
    readonly noEnhancedKeys?: boolean
}

export async function keysCommand(options: KeysCommandOptions = {}): Promise<number> {
    // A surface that mounts Ink refuses a non-terminal. Without the check the alternate-screen sequence
    // goes into a pipe and Ink's own raw-mode error leaves the command exiting 0 — a failure reporting
    // success, which hard rule 8 exists to prevent. Name the alternative: "needs a terminal" on its own
    // is a dead end for somebody scripting.
    const decision = resolveModeFromProcess({ plain: false, json: false, oneShot: false })
    if (decision.mode !== "rich") {
        throw new HarnessError({
            code: "cli_keys_needs_terminal",
            message: "The key probe needs a terminal — it has nothing to read on a pipe.",
            hint: `Not one here (${decision.because}). Run it in the terminal whose keys you want to inspect; there is no scripted form, because the answer is a property of that terminal.`,
        })
    }

    const keyboard = negotiateKeyboard(options.noEnhancedKeys)
    const asked = keyboard.kittyKeyboard !== undefined
    const id = detectTerminal(process.env)
    const terminal = recipeFor(id)?.name ?? id

    const [{ render }, { createElement }, { KeyProbe }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/KeyProbe"),
    ])

    let finish: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
        finish = resolve
    })

    // Before `render`, for the reason `lib/stdin-tap.ts` gives: `useInput` reports `input: ""` for a
    // special key, so a probe built on `input` alone shows no bytes for any arrow, Home, or cmd chord —
    // exactly the keys it exists to diagnose. The same tap also corrects the modifiers, so the probe
    // reports what the chat will actually resolve rather than what Ink said in isolation.
    const tap = openTap()
    onExit(() => {
        tap.close()
    })

    markAltScreen()
    process.stdout.write(ENTER_ALT_SCREEN)

    const instance = render(
        createElement(KeyProbe, {
            // A pty can report `columns === 0`, which `?? fallback` does not cover.
            columns: screenColumns(process.stdout.columns, FALLBACK_COLUMNS),
            asked,
            terminal,
            takeRaw: tap.takeRaw,
            correctKeys: tap.correct,
            onDone: finish,
        }),
        { exitOnCtrlC: false, ...keyboard },
    )
    onExit(() => instance.unmount())
    await closed
    instance.unmount()
    tap.close()
    restoreTerminal()
    await flushOutput()
    return EXIT_OK
}
