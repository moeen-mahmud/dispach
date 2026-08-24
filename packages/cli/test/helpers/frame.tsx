/**
 * Rendering a component and reading the frame it painted.
 *
 * ## Why this file is the point of the phase
 *
 * `ink-testing-library` has been a declared devDependency of this package since Ink was introduced and
 * no test had ever imported it. So every `.tsx` in the tree was verified only through its pure
 * reducers, and "the reducer is right" is not the same claim as "the row is one line" — which is how a
 * catalogue whose layout was asserted as strings still wrapped on a real terminal, and how a fetch
 * that blocked the event loop still echoed arrow keys into the middle of the output.
 *
 * A frame test observes what a person actually sees. It is the guard at the *end* of the pipeline,
 * which is the only place several of this repo's bugs were ever observable: `TurnInput.skills` and
 * `ChatMessage.toolCalls` were both every-layer-correct and one-layer-disconnected.
 *
 * ## Why not `ink-testing-library`'s own `render`
 *
 * Its fake stdout hardcodes `get columns() { return 100 }`, has no `rows`, and emits no `resize`. Two
 * of the three things this phase exists to fix are therefore untestable through it: the layout at a
 * narrow and a wide terminal, and a terminal being resized while a list is open. So the streams are
 * built here — modelled on that implementation, which is the reference for what Ink 7 actually needs
 * from them — with the width settable and a `resize()` that fires the event `useTerminalSize` listens
 * for. `debug: true` is the load-bearing render option: it makes Ink write whole frames instead of
 * cursor-relative diffs, which is what makes a frame readable as text at all.
 *
 * ## Characters, not bytes
 *
 * `width()` counts code points. Measuring these frames with `awk` reported 69 lines over 100 columns
 * where there were none, because `length()` counts bytes and `…`, `·`, `◉` and every box-drawing glyph
 * in the theme are multi-byte. Any width assertion that does not go through here is suspect.
 *
 * ## Colour
 *
 * Frames arrive without escape codes under `bun test`, because chalk sees no TTY and disables colour —
 * but that is chalk's inference about the environment, not a guarantee this file should rest on. Every
 * frame is stripped regardless, so a test cannot start passing or failing because of how something
 * else in the process configured colour.
 */

import { EventEmitter } from "node:events"
import { render } from "ink"
import type { ReactElement } from "react"
import { FALLBACK_COLUMNS, FALLBACK_ROWS } from "#lib/const"

/**
 * Stripping the escapes Ink writes, built from named introducers rather than embedded in a literal.
 *
 * A local implementation rather than a dependency: decision 11.10 is about *runtime* dependencies and
 * this is a test helper, but two named sequences are also not worth a package.
 *
 * Assembled through `new RegExp` for a reason beyond readability. A control character inside a regex
 * *literal* is a lint error — correctly, since it is almost always a mistake — and the honest fix is
 * not a suppression but naming the bytes. `ESC [ … m` says what it matches; forty characters of
 * character class after an invisible introducer does not.
 */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

/** `ESC [ … <letter>` — colour, cursor movement, erase: everything Ink emits to draw a frame. */
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
/** `ESC ] … BEL` — an OSC, for a hyperlink or a window title. */
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g")
/** A lone introducer from a sequence that was cut. It occupies no column, so nothing is lost. */
const STRAY_ESC = new RegExp(ESC, "g")

export function stripAnsi(text: string): string {
    return text.replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(STRAY_ESC, "")
}

/** Visible width in code points — the number of columns a terminal actually spends on a line. */
export function width(line: string): number {
    return [...stripAnsi(line)].length
}

export interface Frame {
    /** The painted frame, ANSI stripped, split on newlines, trailing blank lines removed. */
    readonly lines: readonly string[]
    /** The frame as one string, for an assertion that spans a line break. */
    readonly text: string
    /** The widest line, in characters. */
    readonly widest: number
}

function frameOf(raw: string | undefined): Frame {
    const lines = stripAnsi(raw ?? "").split("\n")
    // Ink pads a frame to the height it last drew, so trailing blanks are the renderer's artefact
    // rather than the component's. Leading and interior blanks are kept — a margin is a layout
    // decision worth asserting.
    while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop()
    return {
        lines,
        text: lines.join("\n"),
        widest: lines.reduce((most, line) => Math.max(most, width(line)), 0),
    }
}

/**
 * A stdout Ink will render into, whose size can be changed and announced.
 *
 * `isTTY` is true because the components under test are the rich path by definition; a plain-path test
 * asserts on captured text and never comes here.
 */
class FakeStdout extends EventEmitter {
    isTTY = true
    columns: number
    rows: number
    readonly writes: string[] = []

    constructor(columns: number, rows: number) {
        super()
        this.columns = columns
        this.rows = rows
    }

    write = (frame: string): boolean => {
        this.writes.push(frame)
        return true
    }

    /** Change the size and tell the app, the way a terminal does. */
    resize(columns: number, rows: number): void {
        this.columns = columns
        this.rows = rows
        this.emit("resize")
    }
}

/** A stdin Ink's input parser accepts. Every method it calls, and nothing else. */
class FakeStdin extends EventEmitter {
    isTTY = true
    data: string | null = null

    write = (data: string): void => {
        this.data = data
        this.emit("readable")
        this.emit("data", data)
    }

    read = (): string | null => {
        const { data } = this
        this.data = null
        return data
    }

    setEncoding(): void {}
    setRawMode(): void {}
    resume(): void {}
    pause(): void {}
    ref(): void {}
    unref(): void {}
}

/**
 * How long Ink holds a lone ESC before deciding it was the escape key.
 *
 * Measured, then confirmed in `ink/build/components/App.js:45` —
 * `pendingInputFlushDelayMilliseconds = 20`. A bare ESC could be the first byte of `ESC [ A`, so the
 * parser waits before committing. Without allowing for it, pressing escape in a test does *nothing*:
 * the first version of these tests read the frame immediately and saw the escape silently dropped,
 * which looked exactly like a component ignoring the key.
 *
 * ESC-prefixed sequences that are already complete — `ESC b`, `ESC [1;3D`, `ESC CR` — arrive at once
 * and need none of this.
 */
const ESCAPE_FLUSH_MS = 20

/** The escape sequences Ink's parser reads, so a test presses a key rather than a byte. */
export const KEY = {
    up: "\u001B[A",
    down: "\u001B[B",
    right: "\u001B[C",
    left: "\u001B[D",
    enter: "\r",
    escape: "\u001B",
    tab: "\t",
    space: " ",
    backspace: "\u007F",
    delete: "\u001B[3~",
    pageUp: "\u001B[5~",
    pageDown: "\u001B[6~",
    /** Option+arrow as Apple Terminal sends it (an ESC prefix) and as iTerm2 does (CSI 1;3). */
    metaLeft: "\u001Bb",
    metaRight: "\u001Bf",
    csiMetaLeft: "\u001B[1;3D",
    csiMetaRight: "\u001B[1;3C",
    /** Option+enter: ESC then carriage return. The one newline chord every terminal can send. */
    metaEnter: "\u001B\r",
    metaBackspace: "\u001B\u007F",
    /**
     * Home and End, all four spellings in the wild. Ink flags the first pair and not the second, which
     * is why the keymap keeps a raw-sequence fallback as well as reading `key.home`/`key.end`.
     */
    home: "\u001B[H",
    end: "\u001B[F",
    homeTilde: "\u001B[1~",
    endTilde: "\u001B[4~",
    /**
     * Under the kitty keyboard protocol. `CSI <codepoint>;<modifier>u` for a letter, `CSI 1;<modifier><final>`
     * for an arrow; the modifier is `1 + shift(1) + alt(2) + ctrl(4) + super(8)`.
     *
     * These are the spellings that actually reach us now the protocol is negotiated, and until this table
     * had them **no test in the repo had ever fed a modified chord through Ink's parser** — `metaLeft` and
     * friends above were defined and never used, so the dual-spelling claim in `keymap.ts` was only ever
     * asserted against hand-built flag objects.
     */
    kittyMetaR: "\u001B[114;3u",
    /**
     * Arrows carry the `:1` event type, and that is not decoration.
     *
     * Ink's kitty branch for special keys is `/^\x1b\[(\d+);(\d+):(\d+)([A-Za-z~])$/` — it **requires**
     * the `:eventType` field. Without it, `CSI 1;9D` falls through to Ink's *legacy* branch, which folds
     * super into meta (`modifier & 10`), and cmd+← becomes indistinguishable from ⌥← all over again. That
     * is the whole reason `reportEventTypes` is negotiated alongside `disambiguateEscapeCodes`, and the
     * reason this table cannot use the shorter spelling: a terminal that omits the field gives us no cmd
     * chords, and no amount of code on this side can recover the bit Ink has already merged away.
     */
    kittySuperLeft: "\u001B[1;9:1D",
    kittySuperRight: "\u001B[1;9:1C",
    kittySuperUp: "\u001B[1;9:1A",
    kittySuperDown: "\u001B[1;9:1B",
    kittyCtrlLeft: "\u001B[1;5:1D",
    kittyCtrlRight: "\u001B[1;5:1C",
    /** A letter, so the `CSI codepoint;modifier u` form — no event type needed for Ink to read it. */
    kittySuperZ: "\u001B[122;9u",
    /** Backspace is codepoint 127, so cmd+backspace is `CSI 127;9u`. */
    kittySuperBackspace: "\u001B[127;9u",
    /** A key *release*: event type 3 in the `:` field. Ink parses it and filters nothing. */
    kittyMetaRRelease: "\u001B[114;3:3u",
    ctrl: (letter: string): string =>
        String.fromCharCode(letter.toLowerCase().charCodeAt(0) - "a".charCodeAt(0) + 1),
} as const

export interface Harness {
    /** The most recent frame. */
    frame(): Frame
    /** Every frame drawn, for asserting that something animated — or that nothing redrew. */
    frames(): readonly Frame[]
    /** Send keystrokes, one at a time, letting React flush between them. */
    press(...keys: readonly string[]): Promise<void>
    /** Resize the terminal and let the app react. */
    resize(columns: number, rows?: number): Promise<void>
    /** Let effects, timers and awaited work run. */
    settle(ms?: number): Promise<void>
    /** The columns the app is currently laid out for. */
    columns(): number
    unmount(): void
}

export interface MountOptions {
    readonly columns?: number
    readonly rows?: number
}

export function mount(element: ReactElement, options: MountOptions = {}): Harness {
    const stdout = new FakeStdout(
        options.columns ?? FALLBACK_COLUMNS,
        options.rows ?? FALLBACK_ROWS,
    )
    const stdin = new FakeStdin()
    const instance = render(element, {
        // Ink's options want the real stream types. These implement the surface it actually uses —
        // which is the whole reason this harness exists — so the cast is through `unknown` rather than
        // through `any`: it narrows one assertion instead of disabling checking on the value.
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        // Whole frames instead of cursor-relative diffs. Without it a "frame" is a pile of escape
        // sequences and nothing can be read out of it.
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
    })

    const settle = async (ms = 0) => {
        await new Promise((resolve) => setTimeout(resolve, ms))
    }

    return {
        frame: () => frameOf(stdout.writes.at(-1)),
        frames: () => stdout.writes.map((raw) => frameOf(raw)),
        press: async (...keys) => {
            for (const key of keys) {
                stdin.write(key)
                // A lone ESC is held by the parser; anything else has already been decided.
                await settle(key === KEY.escape ? ESCAPE_FLUSH_MS * 2 : 0)
            }
        },
        resize: async (columns, rows) => {
            stdout.resize(columns, rows ?? stdout.rows)
            await settle()
        },
        settle,
        columns: () => stdout.columns,
        unmount: () => instance.unmount(),
    }
}

/**
 * Render once and read the frame — the common case, with no keyboard involved.
 *
 * Unmounts before returning, because a component holding an interval (the spinner does) keeps the test
 * process alive otherwise, and a suite that hangs at the end is worse than one that fails.
 */
export function renderFrame(element: ReactElement, options: MountOptions = {}): Frame {
    const harness = mount(element, options)
    const frame = harness.frame()
    harness.unmount()
    return frame
}

/**
 * The lines wider than the terminal the component was given.
 *
 * The single most useful check here: it is what a reducer test structurally cannot see, and a wrapped
 * row destroys the one property a list has — that a row is a row. Returns the offending lines rather
 * than a boolean, so a failure names what overflowed instead of only that something did.
 */
export function overflowing(frame: Frame, columns: number): readonly string[] {
    return frame.lines.filter((line) => width(line) > columns)
}
