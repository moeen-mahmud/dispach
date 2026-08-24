/**
 * Putting text on the system clipboard.
 *
 * ## Why this has to exist at all
 *
 * `cmd+c` cannot reach a terminal application. The terminal's own Edit > Copy claims it first, and finds no
 * native selection to copy because mouse tracking disabled the terminal's selection in order to deliver the
 * drag events. The reference CLI says the same thing in its own words and draws the same conclusion: copy
 * on mouse-up, so `cmd+v` then works and the chord nobody can intercept is the one that matters.
 *
 * ## Why not OSC 52
 *
 * There is an escape sequence for this — `OSC 52` asks the terminal to set the clipboard — and it is
 * refused, truncated, or silently ignored by enough terminals that a copy would sometimes do nothing with
 * no way to tell. A subprocess either runs or reports why. It is also the only form that works over ssh
 * *without* the remote terminal cooperating, which is a real advantage OSC 52 has; the trade is taken
 * knowingly, and a failure says which command was missing.
 */

import { spawnCaptureAsync } from "#lib/spawn"

/** Candidates in order of preference, first one present wins. */
const WRITERS: readonly { readonly command: string; readonly args: readonly string[] }[] = [
    // macOS.
    { command: "pbcopy", args: [] },
    // Wayland, before X11: a Wayland session usually has `xclip` too, through Xwayland, and writing to the
    // X clipboard there puts the text somewhere the compositor's own paste will not find it.
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
]

export interface CopyResult {
    readonly copied: boolean
    /** Which command did it, for a message that names what happened rather than asserting success. */
    readonly using?: string
    readonly problem?: string
}

/**
 * Copy `text` to the clipboard, or say why not.
 *
 * Never throws and never reports success it did not have: a copy that silently failed leaves somebody
 * pasting the *previous* contents of their clipboard, which looks like the wrong text was selected.
 */
export async function copyToClipboard(text: string): Promise<CopyResult> {
    if (text === "") return { copied: false, problem: "nothing selected" }
    const missing: string[] = []
    for (const writer of WRITERS) {
        const result = await spawnCaptureAsync({
            command: writer.command,
            args: writer.args,
            input: text,
            // Generous but bounded: a clipboard helper that hangs must not hang the session with it.
            timeoutMs: 2_000,
        })
        if (result.notFound) {
            missing.push(writer.command)
            continue
        }
        if (result.code === 0) return { copied: true, using: writer.command }
        return {
            copied: false,
            using: writer.command,
            problem: result.stderr.trim() || `${writer.command} exited ${result.code}`,
        }
    }
    return { copied: false, problem: `no clipboard command found (tried ${missing.join(", ")})` }
}
