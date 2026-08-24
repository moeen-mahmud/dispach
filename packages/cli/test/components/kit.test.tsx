/**
 * The kit's small components, as painted.
 *
 * One file for the presentational pieces — banner, spinner, lists, cards, fields, cursor — because each
 * is a handful of assertions and a file each would be sixteen imports of the same harness. The screen
 * roots that own state and input get their own files.
 *
 * What these are worth: `LineCursor` splits on code points so a cursor never lands inside a surrogate
 * pair, and `maskSecret`-adjacent rendering must never leak a value. Both were only ever asserted at the
 * data layer, where "the state is right" and "the screen shows the right thing" are different claims.
 */

import { describe, expect, test } from "bun:test"
import { createElement as h } from "react"
import { Banner } from "#components/Banner"
import { CommandOutput } from "#components/CommandOutput"
import { HistorySearch } from "#components/HistorySearch"
import { KeyProbe } from "#components/KeyProbe"
import { LineCursor } from "#components/LineCursor"
import { Live } from "#components/Live"
import { Palette } from "#components/Palette"
import { Prompt } from "#components/Prompt"
import { SelectList } from "#components/SelectList"
import { Spinner } from "#components/Spinner"
import { StatusBar } from "#components/StatusBar"
import { SummaryCard } from "#components/SummaryCard"
import { TextField } from "#components/TextField"
import { Transcript } from "#components/Transcript"
import { WizardFrame } from "#components/WizardFrame"
import { applyIntent, EMPTY_EDITOR } from "#editor"
import { paletteRows, promptRows, searchRows } from "#lib/chat-frame"
import { LIVE_PANE_MAX_ROWS, MAX_INPUT_ROWS, SEARCH_ROWS } from "#lib/const"
import { paletteFor } from "#lib/palette"
import { FOLLOWING, slice } from "#lib/scroll"
import { GLYPH, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "#lib/theme"
import type { EditorState } from "#lib/types"
import { livePane } from "#lib/wrap"
import { transcriptRows } from "#transcript"
import { KEY, mount, overflowing, renderFrame } from "../helpers/frame.tsx"

const editorWith = (value: string, cursor = value.length) => ({ ...EMPTY_EDITOR, value, cursor })

describe("Banner", () => {
    test("shows the title and every context line", () => {
        const frame = renderFrame(
            h(Banner, { title: "Skills", lines: ["space ticks", "enter installs"] }),
            { columns: 80 },
        )
        expect(frame.text).toContain("Skills")
        expect(frame.text).toContain("space ticks")
        expect(frame.text).toContain("enter installs")
    })

    test("stretches to the terminal rather than fitting its content", () => {
        // Every boxed surface is full width — content-fit boxes beside full-width ones read as
        // different components, and one rule everywhere is what makes the screens look like one thing.
        const narrow = renderFrame(h(Banner, { title: "x", lines: [] }), { columns: 60 })
        const wide = renderFrame(h(Banner, { title: "x", lines: [] }), { columns: 100 })
        expect(wide.widest).toBeGreaterThan(narrow.widest)
    })
})

describe("Spinner", () => {
    test("shows a frame glyph beside its label", () => {
        const frame = renderFrame(h(Spinner, { label: "fetching the catalogue" }), { columns: 80 })
        expect(frame.text).toContain("fetching the catalogue")
        expect(SPINNER_FRAMES.some((glyph) => frame.text.includes(glyph))).toBe(true)
    })

    test("advances — the whole reason it exists", async () => {
        // A spinner that renders one frame and stops is indistinguishable from a hung process, which
        // is the failure it was added to prevent.
        const harness = mount(h(Spinner, { label: "working" }), { columns: 80 })
        const first = harness.frame().text
        await harness.settle(SPINNER_INTERVAL_MS * 3)
        const later = harness.frame().text
        harness.unmount()
        expect(later).not.toBe(first)
    })
})

describe("SelectList", () => {
    const items = [
        { label: "milo", hint: "qwen3.5:9b" },
        { label: "ada", hint: "claude-sonnet" },
    ]

    test("marks exactly one row and shows the hints", () => {
        const frame = renderFrame(h(SelectList, { items, index: 1 }), { columns: 80 })
        expect(frame.lines.filter((line) => line.includes(GLYPH.pointer.trim()))).toHaveLength(1)
        expect(frame.lines[1]).toContain("ada")
        expect(frame.text).toContain("qwen3.5:9b")
    })

    test("numbers the rows when asked, starting at one", () => {
        const frame = renderFrame(h(SelectList, { items, index: 0, numbered: true }), {
            columns: 80,
        })
        expect(frame.lines[0]).toContain("1. milo")
        expect(frame.lines[1]).toContain("2. ada")
    })
})

describe("SummaryCard", () => {
    test("aligns the values in a column past the widest label", () => {
        const frame = renderFrame(
            h(SummaryCard, {
                rows: [
                    { label: "agent", value: "milo" },
                    { label: "endpoint", value: "http://localhost:11434/v1" },
                ],
            }),
            { columns: 80 },
        )
        const starts = ["milo", "http://localhost:11434/v1"].map((value) =>
            (frame.lines.find((line) => line.includes(value)) ?? "").indexOf(value),
        )
        expect(new Set(starts).size).toBe(1)
    })
})

describe("LineCursor", () => {
    test("draws the cursor inside the line, not past it", () => {
        const frame = renderFrame(h(LineCursor, { editor: editorWith("hello", 2) }), {
            columns: 80,
        })
        expect(frame.text).toContain("hello")
    })

    test("an emoji is one cursor step, not two", () => {
        // `"👍".length` is 2, so a cursor counted in UTF-16 units lands inside the surrogate pair and
        // one backspace leaves half a character that renders as a replacement glyph.
        const frame = renderFrame(h(LineCursor, { editor: editorWith("👍ok", 1) }), { columns: 80 })
        expect(frame.text).toContain("👍")
        expect(frame.text).not.toContain("�")
    })

    test("a secret is never rendered, not even to the person typing it", () => {
        const frame = renderFrame(
            h(LineCursor, { editor: editorWith("sk-live-abc123"), secret: true }),
            { columns: 80 },
        )
        expect(frame.text).not.toContain("sk-live")
        expect(frame.text).not.toContain("abc123")
    })

    test("the placeholder shows only while the buffer is empty", () => {
        expect(
            renderFrame(h(LineCursor, { editor: EMPTY_EDITOR, placeholder: "local:default" }), {
                columns: 80,
            }).text,
        ).toContain("local:default")
        expect(
            renderFrame(
                h(LineCursor, { editor: editorWith("mine"), placeholder: "local:default" }),
                {
                    columns: 80,
                },
            ).text,
        ).not.toContain("local:default")
    })
})

describe("TextField", () => {
    test("shows the label, the value and a validation failure together", () => {
        const frame = renderFrame(
            h(TextField, {
                label: "Your name",
                editor: editorWith("ada-lovelace"),
                error: "a Telegram username has no hyphens",
            }),
            { columns: 80 },
        )
        expect(frame.text).toContain("Your name")
        expect(frame.text).toContain("ada-lovelace")
        expect(frame.text).toContain("no hyphens")
    })

    test("a secret field renders neither the value nor a hint of its length in clear", () => {
        const frame = renderFrame(
            h(TextField, {
                label: "Bot token",
                editor: editorWith("123:AAH-secret"),
                secret: true,
            }),
            { columns: 80 },
        )
        expect(frame.text).not.toContain("AAH-secret")
    })
})

describe("Prompt", () => {
    test("renders the prompt glyph and the line", () => {
        const frame = renderFrame(
            h(Prompt, { editor: editorWith("what can you do"), busy: false, columns: 80 }),
            {
                columns: 80,
            },
        )
        expect(frame.text).toContain("what can you do")
    })

    test("is drawn while a turn is running rather than disappearing", () => {
        // The box changes colour when busy; it must not vanish, or there is nothing on screen saying
        // where typing would go.
        const frame = renderFrame(h(Prompt, { editor: EMPTY_EDITOR, busy: true, columns: 80 }), {
            columns: 80,
        })
        expect(frame.lines.length).toBeGreaterThan(0)
    })
})

describe("StatusBar", () => {
    test("names the state in words, not only a colour", () => {
        const frame = renderFrame(
            h(StatusBar, {
                status: "working",
                model: "qwen3.5:9b",
                sessionKey: "local:default",
                elapsedMs: 4200,
                last: undefined,
                quiet: false,
            }),
            { columns: 100 },
        )
        // A dot alone is unreadable without colour, and colour is unavailable over some pipes and to
        // some readers.
        expect(frame.text).toContain("running a tool")
        expect(frame.text).toContain("qwen3.5:9b")
    })

    test("the context gauge appears only when it is worth knowing, and colours when it costs", () => {
        const at = (pressure: number) =>
            renderFrame(
                h(StatusBar, {
                    status: "idle",
                    model: "m",
                    sessionKey: "local:abc123",
                    elapsedMs: 0,
                    last: undefined,
                    quiet: false,
                    pressure,
                }),
                { columns: 100 },
            ).text

        // Below the lowest shipped threshold there is nothing to say, and a gauge that is always on
        // is a gauge nobody reads.
        expect(at(0.3)).not.toContain("ctx")
        expect(at(0.72)).toContain("ctx 72%")
        // Rounded, not truncated: 0.895 is nearer 90 than 89, and a figure a person compares against a
        // threshold should not read low.
        expect(at(0.895)).toContain("ctx 90%")
    })

    test("the phase sits with the session key, because it belongs to the conversation", () => {
        const frame = renderFrame(
            h(StatusBar, {
                status: "idle",
                model: "m",
                sessionKey: "local:abc123",
                elapsedMs: 0,
                last: undefined,
                quiet: false,
                phase: "act",
            }),
            { columns: 100 },
        )
        expect(frame.text).toContain("local:abc123 · act")
    })

    test("shows the elapsed counter, which is what separates slow from hung", () => {
        const frame = renderFrame(
            h(StatusBar, {
                status: "thinking",
                model: "m",
                sessionKey: "s",
                elapsedMs: 12_300,
                last: undefined,
                quiet: false,
            }),
            { columns: 100 },
        )
        expect(frame.text).toContain("12.3s")
    })
})

describe("Live", () => {
    test("renders streaming text", () => {
        const frame = renderFrame(
            h(Live, {
                live: { text: "the answer is", reasoning: "", last: "text" },
                showReasoning: true,
                columns: 80,
            }),
            { columns: 80 },
        )
        expect(frame.text).toContain("the answer is")
    })

    test("shows reasoning only until real text arrives", () => {
        const thinking = renderFrame(
            h(Live, {
                live: { text: "", reasoning: "let me check", last: "reasoning" },
                showReasoning: true,
                columns: 80,
            }),
            { columns: 80 },
        )
        expect(thinking.text).toContain("let me check")
        const answering = renderFrame(
            h(Live, {
                live: { text: "here", reasoning: "let me check", last: "text" },
                showReasoning: true,
                columns: 80,
            }),
            { columns: 80 },
        )
        expect(answering.text).not.toContain("let me check")
    })

    test("caps the pane in rows and says how many are hidden", () => {
        // Ink redraws its whole dynamic tree every frame, so an unbounded live region means redrawing
        // hundreds of lines per token.
        const frame = renderFrame(
            h(Live, {
                live: {
                    text: Array.from({ length: 40 }, (_, at) => `row ${at}`).join("\n"),
                    reasoning: "",
                    last: "text",
                },
                showReasoning: false,
                columns: 80,
            }),
            { columns: 80 },
        )
        expect(frame.text).toContain("hidden while streaming")
        expect(frame.lines.length).toBeLessThan(20)
    })
})

describe("Transcript", () => {
    const ITEMS = [
        { id: "1", role: "user" as const, text: "hello" },
        { id: "2", role: "assistant" as const, text: "hi" },
        { id: "3", role: "error" as const, text: "it broke" },
    ]

    function rowsOf(columns = 80) {
        return transcriptRows(ITEMS, { showReasoning: false, quiet: false, columns })
    }

    test("prefixes each role distinctly", () => {
        const rows = rowsOf()
        const frame = renderFrame(
            h(Transcript, { rows, slice: slice(FOLLOWING, rows.length, rows.length) }),
            { columns: 80 },
        )
        expect(frame.text).toContain("hello")
        expect(frame.text).toContain("hi")
        expect(frame.text).toContain("it broke")
    })

    test("a window shows its slice and counts what is out of sight", () => {
        // The property `<Static>` used to make impossible: a transcript taller than its window, with the
        // reader parked somewhere in the middle of it and told so.
        const rows = rowsOf()
        const frame = renderFrame(
            h(Transcript, { rows, slice: slice({ offset: 0, pinned: false }, rows.length, 2) }),
            { columns: 80 },
        )
        expect(frame.text).toContain("hello")
        expect(frame.text).not.toContain("it broke")
        expect(frame.text).toContain(`${rows.length - 2} rows below`)
    })

    test("the counter row is drawn even when there is nothing to count", () => {
        // Reserved rather than conditional. The caller's window already excludes this row, so appearing
        // only when it has something to say would hand the conversation an extra row on exactly the frame
        // where somebody scrolled — and the layout would jump at the moment they were reading it.
        const rows = rowsOf()
        const whole = renderFrame(
            h(Transcript, { rows, slice: slice(FOLLOWING, rows.length, rows.length) }),
            { columns: 80 },
        )
        expect(whole.lines.length).toBe(rows.length + 1)
    })

    test("every row fits the width it was wrapped for", () => {
        for (const columns of [40, 60, 80, 100, 140]) {
            const long = [
                {
                    id: "1",
                    role: "assistant" as const,
                    text: "the quick brown fox ".repeat(30),
                },
            ]
            const rows = transcriptRows(long, { showReasoning: false, quiet: false, columns })
            const frame = renderFrame(
                h(Transcript, { rows, slice: slice(FOLLOWING, rows.length, rows.length) }),
                { columns },
            )
            expect(overflowing(frame, columns)).toEqual([])
            // Wrapped by us, not by Ink: the row count the window scrolled by has to be the row count
            // painted, or the tail of a reply ends up under the composer.
            expect(frame.lines.length).toBe(rows.length + 1)
        }
    })
})

describe("WizardFrame", () => {
    // JSX rather than `createElement` here, and only here: `WizardFrame` requires `children`, which
    // TypeScript will not accept from createElement's third argument and biome will not accept inside
    // the props object. JSX passes children the way the component declares them, so neither rule has to
    // be bent and the component's API does not change to suit a test.
    test("shows the step counter, the answered rows and the hint", () => {
        const frame = renderFrame(
            <WizardFrame
                step={3}
                total={21}
                answered={[{ label: "Your name", value: "Moeen" }]}
                hint="enter accepts the default"
            >
                {null}
            </WizardFrame>,
            { columns: 80 },
        )
        expect(frame.text).toContain("3")
        expect(frame.text).toContain("21")
        expect(frame.text).toContain("Moeen")
        expect(frame.text).toContain("enter accepts the default")
    })

    test("nothing wraps at a narrow terminal", () => {
        const frame = renderFrame(
            <WizardFrame
                step={19}
                total={21}
                answered={[
                    { label: "Purpose", value: "keeps an eye on the deploy pipeline and says so" },
                ]}
                hint="space ticks · enter continues · esc goes back one question"
            >
                {null}
            </WizardFrame>,
            { columns: 60 },
        )
        expect(overflowing(frame, 60)).toEqual([])
    })
})

// ─── stage 2: the composer ───────────────────────────────────────────────────────────────

const multiline = (text: string, cursor = [...text].length) => ({
    ...EMPTY_EDITOR,
    value: text,
    cursor,
})

describe("LineCursor, with more than one line", () => {
    test("each line of the message is its own row", () => {
        const frame = renderFrame(h(LineCursor, { editor: multiline("first\nsecond\nthird") }), {
            columns: 80,
        })
        expect(frame.lines).toHaveLength(3)
        expect(frame.lines[0]).toContain("first")
        expect(frame.lines[2]).toContain("third")
    })

    test("the gutter is on the first line and the rest stay in the same column", () => {
        // A glyph drawn beside the whole block would leave the second line one column to its left,
        // reading as a separate message.
        const frame = renderFrame(
            h(LineCursor, { editor: multiline("first\nsecond"), gutter: "› " }),
            { columns: 80 },
        )
        expect(frame.lines[0]).toContain("› first")
        expect(frame.lines[1]?.indexOf("second")).toBe(frame.lines[0]?.indexOf("first"))
    })

    test("exactly one line carries the cursor", () => {
        // Asserted through the inverse video the harness strips, so instead: the cursor line renders
        // its text whole and no line is duplicated or lost.
        const frame = renderFrame(h(LineCursor, { editor: multiline("aaa\nbbb", 5) }), {
            columns: 80,
        })
        expect(frame.lines).toHaveLength(2)
        expect(frame.lines[1]).toContain("bbb")
    })

    test("the box caps and says how many lines are out of sight", () => {
        // Ink erases and redraws the dynamic region every frame, so an unbounded box redraws a pasted
        // document on every keystroke — and pushes the conversation off the screen.
        const long = Array.from({ length: 30 }, (_, at) => `line ${at}`).join("\n")
        const frame = renderFrame(
            h(LineCursor, { editor: multiline(long, 0), maxRows: MAX_INPUT_ROWS }),
            { columns: 80 },
        )
        expect(frame.lines.length).toBeLessThanOrEqual(MAX_INPUT_ROWS + 2)
        expect(frame.text).toContain("below")
    })

    test("the view follows the cursor to the end of a long message", () => {
        const long = Array.from({ length: 30 }, (_, at) => `line ${at}`).join("\n")
        const frame = renderFrame(
            h(LineCursor, { editor: multiline(long), maxRows: MAX_INPUT_ROWS }),
            { columns: 80 },
        )
        expect(frame.text).toContain("line 29")
        expect(frame.text).toContain("above")
    })
})

describe("Prompt, composing", () => {
    test("names the newline chord only once the message has a second line", () => {
        // A row spent on every empty prompt for something most messages never need.
        const one = renderFrame(
            h(Prompt, { editor: multiline("one line"), busy: false, columns: 80 }),
            {
                columns: 80,
            },
        )
        expect(one.text).not.toContain("⌥⏎")
        const two = renderFrame(
            h(Prompt, { editor: multiline("one\ntwo"), busy: false, columns: 80 }),
            {
                columns: 80,
            },
        )
        expect(two.text).toContain("⌥⏎")
    })

    test("a long message wraps inside the box instead of being cut at it", () => {
        // The defect, in a frame. Nothing wrapped: each logical line went to Ink with `wrap="truncate"`,
        // so at 100 columns the text was cut at the border and the caret went with it — you could not see
        // what you were typing. Warp instead wrapped the over-wide box and put the tail on the border.
        const message =
            "The quick brown fox jumps over the lazy dog and keeps on jumping well past the right hand edge of this terminal window."
        const editor = { ...EMPTY_EDITOR, value: message, cursor: message.length }
        for (const columns of [40, 60, 80, 100]) {
            const frame = renderFrame(h(Prompt, { editor, busy: false, columns }), { columns })
            expect(overflowing(frame, columns)).toEqual([])
            // Every word survives somewhere in the box, which truncation is exactly what breaks.
            expect(frame.text).toContain("terminal window.")
            // More than one row of text, so it really wrapped rather than fitting by luck.
            expect(frame.lines.length).toBeGreaterThan(3)
        }
    })

    test("the caret stays inside the box at the end of a wrapped line", () => {
        // The reserved column. Wrapping to the full width puts the caret one past the last cell, which the
        // terminal wraps and the border absorbs.
        const message = "wrap me ".repeat(12).trim()
        const editor = { ...EMPTY_EDITOR, value: message, cursor: message.length }
        for (const columns of [40, 47, 61, 80]) {
            const frame = renderFrame(h(Prompt, { editor, busy: false, columns }), { columns })
            expect(overflowing(frame, columns)).toEqual([])
        }
    })

    test("does not advertise shift+enter, which it cannot know works", () => {
        // Naming a chord that silently sends the message instead is worse than naming only ⌥⏎.
        const frame = renderFrame(
            h(Prompt, { editor: multiline("one\ntwo"), busy: false, columns: 80 }),
            {
                columns: 80,
            },
        )
        expect(frame.text).not.toContain("⇧")
        expect(frame.text).not.toContain("shift")
    })

    test("the box grows with the message and stays inside the terminal", () => {
        const frame = renderFrame(
            h(Prompt, { editor: multiline("first\nsecond\nthird"), busy: false, columns: 60 }),
            { columns: 60 },
        )
        expect(frame.text).toContain("third")
        expect(overflowing(frame, 60)).toEqual([])
    })
})

describe("HistorySearch", () => {
    const WITH_HISTORY = {
        ...EMPTY_EDITOR,
        value: "half a draft",
        cursor: 12,
        history: [
            "what tools do you have",
            "why does the outbox double-send on a crash",
            "fix the loader so it reads the manifest first",
        ],
    }
    const opened = (query: string) =>
        [...query].reduce(
            (state, char) => applyIntent(state, { kind: "insert", text: char }),
            applyIntent(WITH_HISTORY, { kind: "searchOpen" }),
        )

    test("renders nothing at all when the search is closed", () => {
        const frame = renderFrame(
            h(HistorySearch, { editor: WITH_HISTORY, width: 80, maxRows: 6 }),
            { columns: 80 },
        )
        expect(frame.text.trim()).toBe("")
    })

    test("lists the matches and shows the query being typed", () => {
        const frame = renderFrame(
            h(HistorySearch, { editor: opened("outbox"), width: 80, maxRows: 6 }),
            {
                columns: 80,
            },
        )
        expect(frame.text).toContain("outbox double-send")
        expect(frame.text).toContain("search: outbox")
    })

    test("marks exactly one match", () => {
        const frame = renderFrame(h(HistorySearch, { editor: opened(""), width: 80, maxRows: 6 }), {
            columns: 80,
        })
        expect(frame.lines.filter((line) => line.includes(GLYPH.pointer.trim()))).toHaveLength(1)
    })

    test("says so when nothing matches, rather than showing an empty box", () => {
        const frame = renderFrame(
            h(HistorySearch, { editor: opened("zzzz"), width: 80, maxRows: 6 }),
            {
                columns: 80,
            },
        )
        expect(frame.text).toContain("nothing you have sent matches")
    })

    test("counts the matches when there is more than one to walk", () => {
        const frame = renderFrame(h(HistorySearch, { editor: opened(""), width: 80, maxRows: 6 }), {
            columns: 80,
        })
        expect(frame.text).toContain("1 of 3")
    })

    test("a multi-line entry is one row", () => {
        const editor = applyIntent(
            { ...WITH_HISTORY, history: ["first line\nsecond line\nthird line"] },
            { kind: "searchOpen" },
        )
        const frame = renderFrame(h(HistorySearch, { editor, width: 80, maxRows: 6 }), {
            columns: 80,
        })
        expect(frame.text).toContain("first line second line third line")
    })

    test("a long entry is clipped rather than wrapped", () => {
        const editor = applyIntent(
            { ...WITH_HISTORY, history: ["x".repeat(300)] },
            { kind: "searchOpen" },
        )
        const frame = renderFrame(h(HistorySearch, { editor, width: 60, maxRows: 6 }), {
            columns: 60,
        })
        expect(overflowing(frame, 60)).toEqual([])
    })
})

describe("Palette", () => {
    const open = (value: string) => {
        const palette = paletteFor(value)
        if (palette === undefined) throw new Error(`no palette for ${value}`)
        return palette
    }

    test("lists matches with their summaries and says what the keys do", () => {
        const frame = renderFrame(
            h(Palette, { palette: open("/sk"), index: 0, width: 100, maxRows: 6 }),
            { columns: 100 },
        )
        expect(frame.text).toContain("/skills")
        expect(frame.text).toContain("tab complete")
    })

    test("marks exactly one entry", () => {
        const frame = renderFrame(
            h(Palette, { palette: open("/"), index: 2, width: 100, maxRows: 6 }),
            { columns: 100 },
        )
        expect(frame.lines.filter((line) => line.includes(GLYPH.pointer.trim()))).toHaveLength(1)
    })

    test("the summaries line up in a column past the longest word", () => {
        const palette = open("/s")
        const frame = renderFrame(h(Palette, { palette, index: 0, width: 120, maxRows: 20 }), {
            columns: 120,
        })
        const starts = palette.matches.map((entry) => {
            const line = frame.lines.find((candidate) => candidate.includes(entry.word))
            return line === undefined ? -1 : line.indexOf(entry.summary.slice(0, 12))
        })
        expect(starts).not.toContain(-1)
        expect(new Set(starts).size).toBe(1)
    })

    test("says so when nothing matches, rather than showing an empty box", () => {
        const frame = renderFrame(
            h(Palette, { palette: open("/zzz"), index: 0, width: 100, maxRows: 6 }),
            { columns: 100 },
        )
        expect(frame.text).toContain("no command starts with /zzz")
    })

    test("a long list scrolls and counts what is out of sight", () => {
        const frame = renderFrame(
            h(Palette, { palette: open("/"), index: 8, width: 100, maxRows: 4 }),
            { columns: 100 },
        )
        expect(frame.text).toContain("above")
    })

    for (const columns of [40, 80, 140]) {
        test(`nothing wraps at ${columns} columns`, () => {
            const frame = renderFrame(
                h(Palette, { palette: open("/"), index: 0, width: columns, maxRows: 8 }),
                { columns },
            )
            expect(overflowing(frame, columns)).toEqual([])
        })
    }
})

describe("CommandOutput", () => {
    const LINES = Array.from({ length: 40 }, (_, at) => `line ${at}`)

    test("a spinner while it is still running", () => {
        // A command that takes a second with nothing on screen is indistinguishable from a keystroke that
        // did nothing.
        const frame = renderFrame(
            h(CommandOutput, { lines: undefined, label: "/status", offset: 0, maxRows: 10 }),
            { columns: 80 },
        )
        expect(frame.text).toContain("running /status")
    })

    test("output that printed nothing says so", () => {
        const frame = renderFrame(
            h(CommandOutput, { lines: [], label: "/validate", offset: 0, maxRows: 10 }),
            { columns: 80 },
        )
        expect(frame.text).toContain("printed nothing")
    })

    test("a non-zero exit is shown, not hidden behind a clean-looking pane", () => {
        const frame = renderFrame(
            h(CommandOutput, {
                lines: ["nope"],
                label: "/validate",
                offset: 0,
                maxRows: 10,
                code: 1,
            }),
            { columns: 80 },
        )
        expect(frame.text).toContain("exited 1")
    })

    test("it scrolls, and counts the lines out of sight in both directions", () => {
        const top = renderFrame(
            h(CommandOutput, { lines: LINES, label: "/status", offset: 0, maxRows: 8 }),
            { columns: 80 },
        )
        expect(top.text).toContain("below")
        const middle = renderFrame(
            h(CommandOutput, { lines: LINES, label: "/status", offset: 20, maxRows: 8 }),
            { columns: 80 },
        )
        expect(middle.text).toContain("above")
        expect(middle.text).toContain("below")
    })

    test("a long line is clipped rather than wrapped", () => {
        const frame = renderFrame(
            h(CommandOutput, {
                lines: ["x".repeat(300)],
                label: "/status",
                offset: 0,
                maxRows: 8,
            }),
            { columns: 60 },
        )
        expect(overflowing(frame, 60)).toEqual([])
    })
})

describe("the chat frame's arithmetic matches what is drawn", () => {
    /**
     * The hazard `lib/chat-frame.ts` documents, pinned.
     *
     * That module restates each component's geometry, because the layout has to be decided before
     * anything is drawn — on the alternate screen a frame one row too tall scrolls the buffer and the
     * status line ends up halfway up the display. A restatement can drift from what it describes, and the
     * only thing that catches it is asserting the number against the actual render.
     */
    function multi(lines: number): EditorState {
        return {
            ...EMPTY_EDITOR,
            value: Array.from({ length: lines }, (_, at) => `line ${at}`).join("\n"),
        }
    }

    test("the composer, empty and composing", () => {
        for (const lines of [1, 2, 5, MAX_INPUT_ROWS, MAX_INPUT_ROWS + 4]) {
            const editor = multi(lines)
            const frame = renderFrame(h(Prompt, { editor, busy: false, columns: 80 }), {
                columns: 80,
            })
            expect(promptRows(editor, 80)).toBe(frame.lines.length)
        }
    })

    test("the composer with a message long enough to wrap", () => {
        // The case the row count was wrong for: nothing wrapped, so lines and rows were the same number
        // and counting either worked. A wrapped message draws more rows than it has lines, and the frame
        // subtracting the smaller figure put the bottom of the composer under the status line.
        for (const columns of [40, 60, 80, 100, 140]) {
            const editor = {
                ...EMPTY_EDITOR,
                value: "wrap me ".repeat(40).trim(),
                cursor: 320,
            }
            const frame = renderFrame(h(Prompt, { editor, busy: false, columns }), { columns })
            expect(promptRows(editor, columns)).toBe(frame.lines.length)
            expect(overflowing(frame, columns)).toEqual([])
        }
    })

    test("the landing composer is exactly as tall as the working one", () => {
        // There used to be a `roomy` landing form three rows taller — padding inside the box and a margin
        // above it, both there to keep the border off the banner while the slack sat *below* the composer.
        // The slack is above it now, so there is nothing to separate it from, and the height has to be the
        // same in both states or `promptRows` is charging for a row that is not drawn. A placeholder is the
        // only thing landing still changes here, and a placeholder occupies the row the caret was already on.
        const editor = multi(1)
        const plain = renderFrame(h(Prompt, { editor, busy: false, columns: 80 }), { columns: 80 })
        const landing = renderFrame(
            h(Prompt, { editor, busy: false, columns: 80, placeholder: "Ask anything…" }),
            { columns: 80 },
        )
        expect(landing.lines.length).toBe(plain.lines.length)
        expect(promptRows(editor, 80)).toBe(landing.lines.length)
    })

    test("the composer with the cursor scrolled into a long message", () => {
        // `LineCursor` follows the cursor through `viewport`, so which notices it draws depends on where
        // the cursor is — which is why `promptRows` calls the same function rather than guessing.
        let editor = multi(MAX_INPUT_ROWS + 6)
        for (let up = 0; up < 8; up += 1) editor = applyIntent(editor, { kind: "lineUp" })
        const frame = renderFrame(h(Prompt, { editor, busy: false, columns: 80 }), { columns: 80 })
        expect(promptRows(editor, 80)).toBe(frame.lines.length)
    })

    test("the palette, matching many, one, and nothing", () => {
        for (const query of ["/", "/st", "/status", "/zzz"]) {
            const palette = paletteFor(query)
            expect(palette).toBeDefined()
            if (palette === undefined) continue
            const frame = renderFrame(
                h(Palette, { palette, index: 0, width: 80, maxRows: SEARCH_ROWS }),
                { columns: 80 },
            )
            expect(paletteRows(palette, SEARCH_ROWS)).toBe(frame.lines.length)
        }
    })

    test("the history search, with matches and without", () => {
        const typed = { ...EMPTY_EDITOR, history: ["what is the time", "who am i"] }
        for (const query of ["", "who", "nothing like this"] as const) {
            let editor = applyIntent(typed, { kind: "searchOpen" })
            for (const char of query) editor = applyIntent(editor, { kind: "insert", text: char })
            const frame = renderFrame(
                h(HistorySearch, { editor, width: 80, maxRows: SEARCH_ROWS }),
                { columns: 80 },
            )
            expect(searchRows(editor, SEARCH_ROWS)).toBe(frame.lines.length)
        }
    })

    test("the live pane, short and clipped", () => {
        for (const words of [3, 40, 400]) {
            const text = "token ".repeat(words).trim()
            const live = { text, reasoning: "", last: "text" as const }
            const frame = renderFrame(h(Live, { live, showReasoning: false, columns: 80 }), {
                columns: 80,
            })
            expect(livePane(text, 80, LIVE_PANE_MAX_ROWS).rows).toBe(frame.lines.length)
        }
    })
})

describe("LineCursor, with a selection", () => {
    // The harness strips ANSI, so the *colour* cannot be asserted here — the same limitation that makes
    // the caret's inverse video untestable, and recorded as such since it was written. What can be
    // asserted is the risk the run splitting actually introduces: a row rebuilt from segments must be the
    // same row. A dropped or duplicated cell would be invisible in a colour assertion and obvious here.
    function selected(value: string, anchor: number, cursor: number, columns: number) {
        return renderFrame(
            h(LineCursor, {
                editor: { ...EMPTY_EDITOR, value, cursor, anchor },
                maxRows: MAX_INPUT_ROWS,
                columns: columns - 4,
            }),
            { columns },
        )
    }

    test("the text survives the split, at every width", () => {
        const message = "select the middle of this sentence please"
        for (const columns of [40, 60, 80, 100]) {
            const frame = selected(message, 7, 17, columns)
            const drawn = frame.lines.join("").replace(/\s+/g, " ")
            for (const word of message.split(" ")) {
                expect(drawn, `${columns}: ${word}`).toContain(word)
            }
            expect(overflowing(frame, columns), String(columns)).toEqual([])
        }
    })

    test("a selection spanning a wrapped row draws on both rows", () => {
        // Two rows, one selection. The offsets are buffer-absolute for exactly this case; line-relative
        // ones would have highlighted the wrong half of the second row.
        // Long enough to actually wrap at this width: the first version was 35 characters in a 36-column
        // window and drew one row, so the assertion it was making could not fail.
        const message = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"
        const frame = selected(message, 3, 40, 40)
        expect(frame.lines.length).toBeGreaterThan(1)
        expect(overflowing(frame, 40)).toEqual([])
    })

    test("a selection across a newline keeps both lines", () => {
        const frame = selected("first line\nsecond line", 3, 15, 60)
        const drawn = frame.lines.join(" ")
        expect(drawn).toContain("first")
        expect(drawn).toContain("second")
    })

    test("a secret field never leaks its value, selected or not", () => {
        // Masking is applied after the split, so the dots have to line up with the runs rather than with
        // the source — which is the one way a highlight could have leaked a character of a password.
        const frame = renderFrame(
            h(LineCursor, {
                editor: { ...EMPTY_EDITOR, value: "hunter2", cursor: 7, anchor: 0 },
                maxRows: MAX_INPUT_ROWS,
                columns: 40,
                secret: true,
            }),
            { columns: 44 },
        )
        expect(frame.text).not.toContain("hunter2")
        expect(frame.text).toContain("•")
    })
})

describe("KeyProbe", () => {
    test("it says what it cannot yet know, rather than guessing", () => {
        // The verdict is the load-bearing line: Ink does not expose whether its handshake succeeded, so
        // before any key is pressed the only honest report is "asked, unproven". A probe that printed
        // "active" on the strength of having *requested* the protocol would be the exact failure it
        // exists to catch — a claim about a terminal that nobody measured.
        const frame = renderFrame(
            h(KeyProbe, { columns: 80, asked: true, terminal: "Warp", onDone: () => {} }),
            { columns: 80 },
        )
        expect(frame.text).toContain("Warp")
        expect(frame.text).toContain("requested")
        expect(frame.text).toContain("nothing pressed yet")
        expect(frame.text).not.toContain("active")
        expect(overflowing(frame, 80)).toEqual([])
    })

    test("with the override set it says the cmd chords cannot arrive", () => {
        const frame = renderFrame(
            h(KeyProbe, { columns: 80, asked: false, terminal: "Warp", onDone: () => {} }),
            { columns: 80 },
        )
        expect(frame.text).toContain("not requested")
    })

    test("a pressed chord shows all three layers, and q leaves", async () => {
        let done = false
        const harness = mount(
            h(KeyProbe, {
                columns: 80,
                asked: true,
                terminal: "Warp",
                onDone: () => {
                    done = true
                },
            }),
            { columns: 80, rows: 30 },
        )
        await harness.press(KEY.kittySuperLeft)
        const frame = harness.frame()
        expect(frame.text).toContain("bytes")
        expect(frame.text).toContain("ink")
        expect(frame.text).toContain("intent")
        expect(frame.text).toContain("cursorHome")
        expect(frame.text).toContain("super")
        // A modifier only the protocol can express, so the verdict is now evidence rather than a hope.
        expect(frame.text).toContain("active")
        expect(overflowing(frame, 80)).toEqual([])
        await harness.press("q")
        harness.unmount()
        expect(done).toBe(true)
    })

    test("^C is recorded rather than obeyed — a probe must be able to show its own exit chord", async () => {
        let done = false
        const harness = mount(
            h(KeyProbe, {
                columns: 80,
                asked: true,
                terminal: "Warp",
                onDone: () => {
                    done = true
                },
            }),
            { columns: 80, rows: 30 },
        )
        await harness.press(KEY.ctrl("c"))
        const frame = harness.frame()
        harness.unmount()
        expect(done).toBe(false)
        expect(frame.text).toContain("ctrl")
    })
})
