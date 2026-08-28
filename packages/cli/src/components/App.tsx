/**
 * The chat surface — a full-screen session on the alternate buffer.
 *
 * Thin on purpose. Everything worth testing lives in pure modules — `keymap.ts` decides what a keystroke
 * means, `editor.ts` applies it to the line, `transcript.ts` turns bus events into rows, `lib/scroll.ts`
 * moves the window, `lib/chat-frame.ts` decides how many rows each part of the frame may have — so this
 * file is composition plus the decisions that need Ink itself: when to unmount, what to do about a
 * submission arriving mid-turn, and which surface currently owns the keyboard.
 *
 * ## What Phase 5.5 changed here
 *
 * The conversation is no longer in `<Static>`. It is a buffer of rows with a window over it, because
 * `<Static>` writes to the scrollback and the alternate screen discards its buffer on the way out — the
 * two cannot both be true. That has two consequences worth stating before editing:
 *
 * - **The frame has a hard height.** Everything visible must add up to at most the terminal's rows, or
 *   Ink's own output scrolls the buffer and the layout comes apart. `chatFrame` owns that arithmetic; no
 *   row count is invented in this file.
 * - **^C at an idle prompt takes two presses.** With the buffer discarded on exit, a single reflexive ^C
 *   during a long reply would throw the visible conversation away. `keymap.ts` owns the decision; the
 *   timer that expires it lives here, because a pure function cannot hold a clock.
 *
 * The Ctrl-C contract from Phase 1 is otherwise unchanged: during a turn it cancels the turn and the
 * prompt comes back.
 */

import { BRAND, VERSION } from "@dispach/core"
import { Box, Text, useApp, useInput } from "ink"
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BRAND_INDENT, Brandmark } from "#components/Brandmark"
import { CommandOutput } from "#components/CommandOutput"
import type { ConfigEditorProps } from "#components/ConfigEditor"
import { HistorySearch } from "#components/HistorySearch"
import { Live } from "#components/Live"
import { Palette } from "#components/Palette"
import { Prompt } from "#components/Prompt"
import type { SessionPickerProps } from "#components/SessionPicker"
import type { SkillBrowserProps } from "#components/SkillBrowser"
import { Spinner } from "#components/Spinner"
import { StatusBar } from "#components/StatusBar"
import { Transcript } from "#components/Transcript"
import { applyIntent, EMPTY_EDITOR, selectionRange, submit } from "#editor"
import { useElapsed } from "#hooks/useElapsed"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { useTurn } from "#hooks/useTurn"
import { keyContext, keyToIntent } from "#keymap"
import { chatFrame, composerHit, transcriptHit, transcriptRowsAfterBrand } from "#lib/chat-frame"
import { copyToClipboard } from "#lib/clipboard"
import type { EditorRow } from "#lib/config-editor"
import { applyEditorRow, editorRowsFor } from "#lib/config-rows"
import {
    EXIT_ARM_MS,
    FALLBACK_COLUMNS,
    LANDING_LIST_ROWS,
    MULTI_CLICK_MS,
    SEARCH_ROWS,
    SESSION_PICKER_ROWS,
} from "#lib/const"
import { offeredCommands, paletteEntries, paletteFor, paletteSelection } from "#lib/palette"
import type { AppProps } from "#lib/schema"
import { screenColumns, titleLine } from "#lib/screen"
import { FOLLOWING, scroll, slice } from "#lib/scroll"
import {
    NEW_SESSION_HINT,
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import type { SessionRowSource } from "#lib/sessions-view"
import { runSubcommand } from "#lib/subcommand"
import {
    beginSelection,
    dragSelection,
    endSelection,
    extendSelection,
    lineAt,
    selectedText,
    type TextPoint,
    type TextSelection,
    wordAt,
} from "#lib/text-selection"
import { THEME } from "#lib/theme"
import { wordmark } from "#lib/wordmark"
import { lastStats, transcriptRows } from "#transcript"

/**
 * What is layered over the conversation.
 *
 * `output` is a command's captured text; `skills` is the one bespoke view a session hosts so far. Both
 * take the keyboard while open and both *replace* the transcript rather than sitting under it — sharing
 * the screen pushed the conversation off the top of a full-screen frame, which on a surface with no
 * scrollback means gone. Closing either returns to the prompt with the draft untouched, which is what
 * makes a pane an interlude rather than a detour.
 */
type Pane =
    | { readonly kind: "none" }
    | {
          readonly kind: "output"
          readonly label: string
          readonly lines: readonly string[] | undefined
          readonly code?: number
          readonly offset: number
      }
    | { readonly kind: "skills" }
    /**
     * The conversation switcher. `undefined` while the store is being read.
     *
     * Loaded when the pane opens rather than kept current, because the list changes only when a turn ends
     * and re-reading it on every frame would put a database query in the render path.
     */
    | { readonly kind: "sessions"; readonly stored: readonly SessionRowSource[] | undefined }
    /**
     * The settings editor. `rows` is read when the pane opens, not kept current.
     *
     * Read once because the editor re-reads after each write of its own — keeping it live here would put
     * a file read in the render path for a surface that already knows when it has changed something.
     */
    | { readonly kind: "config"; readonly rows: readonly EditorRow[] }

export function App({
    agent,
    bus,
    sessionKey,
    model,
    agentName,
    warnings,
    freshSession,
    initial,
    correctKeys,
    showReasoning,
    quiet,
    onRestart,
    onSwitch,
    onNew,
    sessions,
    initialDraft,
    manifestPath,
    catalogue,
    status,
    contextView,
}: AppProps) {
    const { exit } = useApp()
    const size = useTerminalSize()
    const columns = screenColumns(size.columns, FALLBACK_COLUMNS)
    const { state, busy, send, cancel, note, trim } = useTurn({ agent, bus, sessionKey, initial })
    // A draft handed in by a `/restart` opens the prompt with the cursor at its end, which is where the
    // person left it. Only the initial value — a later prop change must not overwrite what is being
    // typed now, which is exactly what `useState`'s initialiser semantics give for free.
    const [editor, setEditor] = useState(() =>
        initialDraft === undefined || initialDraft === ""
            ? EMPTY_EDITOR
            : { ...EMPTY_EDITOR, value: initialDraft, cursor: [...initialDraft].length },
    )

    /**
     * What is on top of the conversation, if anything.
     *
     * A pane is *focused* while it is open, so the prompt's `useInput` stands down — Ink fires every
     * active hook, and two surfaces reading one keystroke is the bug the focus rule exists to prevent.
     */
    const [pane, setPane] = useState<Pane>({ kind: "none" })
    /**
     * The skills view's implementation, loaded when it is first opened.
     *
     * Dynamically, and that is not an optimisation. `browse.ts` also imports this component dynamically,
     * and bun's `--splitting` emits a module's exports **twice** when one importer is static and another is
     * dynamic — producing a bundle that dies at parse time with `Duplicate export of 'SkillBrowser'`, which
     * no test that imports source can see. The props come in as a type, which is erased and creates no
     * edge. `boundaries.test.ts` bans the mixing outright.
     */
    const [Browser, setBrowser] = useState<ComponentType<SkillBrowserProps> | undefined>(undefined)
    /**
     * The session switcher's implementation, loaded when the pane first opens.
     *
     * Dynamically for the same reason `Browser` is, and it was caught by the boundaries test rather than
     * remembered: `run.ts` mounts this component too, for a bare `--session` before any chat exists. One
     * static importer and one dynamic one makes bun's `--splitting` emit its exports **twice**, and the
     * built binary then dies at parse time with `Duplicate export of 'SessionPicker'` while every test —
     * which imports source — passes. Both edges dynamic, no duplicate.
     */
    const [Editor, setEditor_] = useState<ComponentType<ConfigEditorProps> | undefined>(undefined)
    const [Sessions, setSessions] = useState<ComponentType<SessionPickerProps> | undefined>(
        undefined,
    )
    /** Where the conversation window sits. Starts and returns to following the newest row. */
    const [view, setView] = useState(FOLLOWING)
    /** A first ^C has landed. Expires, which is why it is here and not in the keymap. */
    const [armed, setArmed] = useState(false)
    /** `/exit` asked; the next keystroke answers. `undefined` means nothing is being confirmed. */
    const [confirming, setConfirming] = useState(false)
    /**
     * Reasoning shown whole rather than folded to a count. Session-wide, and `⌥r` toggles it.
     *
     * Folded is the default because a real turn produced a twenty-three-row block for a one-sentence
     * answer, which filled the terminal and left the reply itself somewhere above the fold.
     */
    const [expandReasoning, setExpandReasoning] = useState(false)
    /**
     * The mouse selection over the transcript, in buffer coordinates.
     *
     * Cleared by eviction below rather than re-keyed: rows are addressed by position, so dropping any from
     * the front shifts every index — a selection kept across a trim would silently start covering different
     * text, which is the "looks live and is not" failure `pinned` exists to prevent. There is also nothing
     * to copy from rows that no longer exist.
     */
    const [selection, setSelection] = useState<TextSelection | undefined>(undefined)
    /**
     * The previous press, for counting clicks.
     *
     * A ref rather than state: nothing renders from it, and putting it in state would redraw the whole tree
     * on every press. Multi-click has to be inferred from time and position because a terminal reports
     * three presses and never a "double click" — the same reason the reference CLI keeps its own window.
     */
    const lastPress = useRef<{ at: TextPoint; when: number; clicks: number } | undefined>(undefined)
    // Derived from the buffer rather than stored, so the only palette state is where the cursor is.
    const palette = pane.kind === "none" ? paletteFor(editor.value) : undefined
    const [paletteIndex, setPaletteIndex] = useState(0)

    const elapsed = useElapsed(busy)
    const last = useMemo(() => lastStats(state.items), [state.items])

    /**
     * The conversation, wrapped to the width and flattened to rows.
     *
     * Memoised on the three things it depends on. Without that it would re-flatten and re-wrap the whole
     * history on every streamed token, which is the cost `<Static>` used to remove for free.
     */
    const rows = useMemo(
        () => transcriptRows(state.items, { showReasoning, quiet, columns, expandReasoning }),
        [state.items, showReasoning, quiet, columns, expandReasoning],
    )

    /**
     * The landing state: a new conversation with nothing sent into it yet.
     *
     * It is a *state of the one frame*, not a screen of its own, and that is the whole design. As a separate
     * screen it was swapped out the moment anything reached the transcript — which `/help`, `/tools` and
     * `/restart` all do — so the landing screen "disappeared" for almost every command. And anything added to
     * the other layout was silently missing from it: the palette drew nothing there for a day, and `/exit`'s
     * "press y" prompt was invisible, because both live in the layout that was not on screen. One frame
     * removes that class of bug rather than fixing instances of it.
     *
     * `freshSession` is the host's answer to "is this conversation new". It used to be load-bearing for a
     * second reason — the chat did not render stored messages, so an empty transcript was equally true of a
     * resumed session — and that is no longer the case: `seedHistory` paints the conversation, so the `user`
     * clause below is now true on its own for anything resumed. Both are kept because they answer different
     * questions, and the remaining job of `freshSession` is the genuinely new session, where there is no
     * history for the second clause to find. The second half is what the owner chose: slash commands, notes
     * and the banner all keep the brand mark, because they are setup rather than conversation. It goes when
     * you actually start talking, and does not come back.
     */
    const landing = freshSession === true && !state.items.some((item) => item.role === "user")

    // A longer list while landing: there is no conversation to hide behind it, and the screen somebody opens
    // before they know the commands should show all of them rather than six and a counter.
    const listRows = landing ? LANDING_LIST_ROWS : SEARCH_ROWS
    const frame = chatFrame({
        rows: size.rows,
        columns,
        editor,
        live: state.live,
        showReasoning,
        palette,
        paletteMaxRows: listRows,
        searchMaxRows: listRows,
        confirming,
        landing,
        hint: landing,
    })
    /**
     * The brand mark, rendered here so the conversation is charged what it actually draws.
     *
     * `frame.brand` is an allowance and `wordmark` usually takes far less of it — charging the allowance
     * wasted eleven rows on a thirty-row terminal, and the banner ended up scrolled to a mid-wrap fragment of
     * a store path with a third of the screen blank. Computed once and handed to `Brandmark` as lines, so
     * there is no second derivation that could disagree about how tall the frame is.
     */
    const mark =
        frame.brand > 0
            ? wordmark(BRAND.name, { columns: columns - BRAND_INDENT, rows: frame.brand })
            : undefined
    const window = slice(
        view,
        rows.length,
        transcriptRowsAfterBrand(frame, mark?.lines.length ?? 0),
    )

    /**
     * Bound the transcript, but only while following the tail.
     *
     * Every item is re-derived and re-wrapped on each frame now that the conversation is a windowed buffer
     * rather than `<Static>` output, so an unbounded one is unbounded work per keystroke. The gate is the
     * point: rows are addressed by position, so dropping any from the front shifts every offset below
     * them — evicting while somebody is parked twelve turns back would leave their offset untouched and
     * the text under it different, which is a session that looks live and is not. Deferring costs nothing,
     * because `esc` returns to the tail and the next append trims then.
     *
     * Called on every change with no check of its own: a buffer under the cap reduces to identical state,
     * so React bails out of the render.
     */
    // `state.items.length` below is a *trigger*, not a read: the body never looks at it, and it is there
    // so a growing conversation re-runs the check. The lint rule offers to remove it, and taking that
    // offer would leave the cap enforced once at mount and never again — a fix that lints clean and does
    // nothing, which is why the suppression carries a reason rather than the dependency being dropped.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a deliberate trigger dependency; see above
    useEffect(() => {
        if (!view.pinned) return
        // Eviction shifts every row index, so a selection made before a trim would afterwards cover
        // different text — the same hazard `pinned` exists for, applied to a highlight. Cleared rather
        // than re-keyed: there is nothing to copy from rows that are gone, and a highlight that quietly
        // slid onto another reply is worse than one that disappeared.
        setSelection(undefined)
        trim()
    }, [view.pinned, state.items.length, trim])

    // The armed ^C expires on its own. A prompt that stayed armed indefinitely would turn a ^C pressed
    // minutes ago into the reason a later one ended the session.
    useEffect(() => {
        if (!armed) return
        const timer = setTimeout(() => setArmed(false), EXIT_ARM_MS)
        return () => clearTimeout(timer)
    }, [armed])

    /**
     * A submitted line: a slash command, or a message for the model.
     *
     * `draft` is what is *left in the buffer* afterwards, and it has to be passed in rather than read from
     * `editor` here. This closure captures the editor as it was when the frame rendered — before the submit
     * cleared it — so reading `editor.value` returned the command that was just consumed. `/restart` then
     * carried `/restart` across as the draft, which re-opened the palette on top of the new banner: the
     * screen came back identical to before enter was pressed, with the message hidden behind the list, and
     * the restart looked like it had done nothing at all.
     *
     * For a typed command the residual is always empty — `COMMAND_SHAPE` matches the whole trimmed line, so
     * a command cannot share the buffer with a draft. It stays a parameter because a restart offered by a
     * *pane* could, and that is what the carry-across exists for.
     */
    const onSubmit = (text: string, draft: string): void => {
        // Both renderers dispatch through the same table, so `--plain` and the rich path cannot
        // answer the same typed command differently.
        // `offered` is what turns a typed `/config get x` into a command rather than a message. Without
        // it the list defaults to empty, so **no** CLI command resolved when typed with arguments: the
        // palette ran them and typing the same thing sent it to the model as prose, which then answered
        // about it. Selecting `/config` from the list worked, and typing `/config get model.main.id` cost
        // a turn — the same command, two answers, which is exactly what `resolveSessionCommand` living in
        // one place is supposed to prevent.
        const command = resolveSessionCommand(text, offeredCommands())
        if (command !== undefined) {
            switch (command.kind) {
                case "exit":
                    // Asked, not done. `/exit` is typed deliberately, but so is every other slash command,
                    // and the one that discards the visible conversation is worth one keystroke of
                    // confirmation on a surface where leaving takes the screen with it.
                    setConfirming(true)
                    return
                case "restart":
                    // The settings an agent booted with are fixed for its lifetime, so a
                    // configuration change needs a new one. Nothing is lost: the conversation lives
                    // in the store and the new agent resumes the same session key.
                    // The unsent draft rides across the restart. `/restart` rebuilds the agent to
                    // pick up a settings change; throwing away a half-written message on the way is a
                    // second, unasked-for consequence of asking for the first.
                    onRestart?.(draft)
                    exit()
                    return
                case "new":
                    // The same unmount-and-reopen route `/restart` and `/sessions` take, for the same
                    // reason: a transcript cannot be re-keyed in place. Nothing is destroyed — the
                    // conversation being left keeps its key, and the next banner names it.
                    onNew?.(draft)
                    exit()
                    return
                case "help":
                    note(sessionHelpText())
                    return
                case "tools":
                    note(toolsReport(toolsView(agent)))
                    return
                case "context":
                    // Same shape as `status` below: a component cannot block, so the note is the
                    // acknowledgement. Absent means the surface is not offered rather than accepted
                    // and silently billed to the model, which is what `/status` did for three phases.
                    if (contextView === undefined) {
                        note("context is unavailable in this session")
                        return
                    }
                    contextView()
                        .then(note)
                        .catch((error: unknown) =>
                            note(
                                `could not read the context: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                        )
                    return
                case "status":
                    // Declared in `SESSION_COMMANDS`, advertised in `/help` and generated into the
                    // palette — and unhandled here, so it fell out of this switch and was sent to the
                    // model as prose. Not a type error: the union's first member is
                    // `{kind: SessionCommandKind}` and this switch has no exhaustiveness guard, which
                    // is why `boundaries.test.ts` now walks every kind. Seventh instance in this repo
                    // of every layer being right and one not being connected.
                    //
                    // Awaited through `.then` rather than inline: a component cannot block, and the
                    // note *is* the acknowledgement — the same shape `reset` below uses.
                    if (status === undefined) {
                        note("status is unavailable in this session")
                        return
                    }
                    status()
                        .then(note)
                        .catch((error: unknown) =>
                            note(
                                `could not read the status: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                        )
                    return
                case "reset":
                    // Fire-and-report rather than awaited: a component cannot block, and the note is
                    // the acknowledgement. A failure surfaces as a rejected promise, so it is caught.
                    agent
                        .clearSession(sessionKey)
                        .then(() => note("session cleared — memory files on disk are untouched"))
                        .catch((error: unknown) =>
                            note(
                                `could not clear the session: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                        )
                    return
                case "command":
                    // Through `dispatch`, which is the palette's path too — its own comment says it is
                    // shared "so the two cannot diverge", and until now only one of the two reached it.
                    if (dispatch(`/${command.name}`, command.rest)) return
                    note(unknownCommandText({ word: `/${command.name}` }))
                    return
                case "unknown":
                    note(unknownCommandText(command))
                    return
            }
        }
        if (busy) {
            // Two turns on one session would interleave in the history the next turn is conditioned
            // on. Refusing is honest; queueing silently would make the reply order unpredictable.
            note("a turn is still running — ^C cancels it, then send again")
            return
        }
        send(text)
    }

    /**
     * Run a command and show what it printed.
     *
     * The pane opens *before* the command starts, with a spinner, for the same reason the skills browser
     * mounts before it fetches: a command that takes a second with nothing on screen is indistinguishable
     * from a keystroke that did nothing.
     */
    const openCommand = useCallback(
        (name: string, rest: string) => {
            setPane({ kind: "output", label: `/${name}`, lines: undefined, offset: 0 })
            void runSubcommand({ name, rest, manifestPath: manifestPath ?? "" })
                .then((result) =>
                    setPane({
                        kind: "output",
                        label: `/${name}`,
                        lines: result.lines,
                        code: result.code,
                        offset: 0,
                    }),
                )
                .catch((error: unknown) =>
                    setPane({
                        kind: "output",
                        label: `/${name}`,
                        lines: [error instanceof Error ? error.message : String(error)],
                        code: 1,
                        offset: 0,
                    }),
                )
        },
        [manifestPath],
    )

    /** A slash command, from the palette or from a typed line. Shared so the two cannot diverge. */
    const dispatch = useCallback(
        (word: string, rest: string) => {
            const entry = paletteEntries().find((candidate) => candidate.word === word)
            if (entry === undefined) return false
            if (entry.kind === "view") {
                if (
                    entry.word === "/sessions" &&
                    sessions !== undefined &&
                    onSwitch !== undefined
                ) {
                    // Opened before the read finishes, with the spinner the pane draws for an undefined
                    // list — the same reason the catalogue mounts before it fetches: a keystroke followed
                    // by nothing is indistinguishable from a keystroke that did nothing.
                    setPane({ kind: "sessions", stored: undefined })
                    void import("#components/SessionPicker").then((module) =>
                        // Wrapped in a function, or `useState` would call the component as an updater.
                        setSessions(() => module.SessionPicker),
                    )
                    void sessions()
                        .then((stored) => setPane({ kind: "sessions", stored }))
                        .catch((error: unknown) => {
                            setPane({ kind: "none" })
                            note(
                                `could not read the stored conversations: ${error instanceof Error ? error.message : String(error)}`,
                            )
                        })
                    return true
                }
                if (entry.word === "/config" && (rest.trim() === "" || rest.trim() === "edit")) {
                    // Bare `/config` is the editor; `/config list` and the rest are still the plain
                    // command in an output pane, which the fallthrough below handles.
                    if (manifestPath === undefined) {
                        note("this session has no manifest path, so there is nothing to edit")
                        return true
                    }
                    setPane({ kind: "config", rows: editorRowsFor(manifestPath) })
                    void import("#components/ConfigEditor").then((module) =>
                        // Wrapped in a function, or `useState` would call the component as an updater.
                        setEditor_(() => module.ConfigEditor),
                    )
                    return true
                }
                if (entry.word === "/skills" && catalogue !== undefined) {
                    setPane({ kind: "skills" })
                    void import("#components/SkillBrowser").then((module) =>
                        // Wrapped in a function, or `useState` would call the component as an updater.
                        setBrowser(() => module.SkillBrowser),
                    )
                    return true
                }
                // A view named in the table with nothing built yet falls back to its own output, which is
                // still the command doing its job — better than a palette entry that does nothing.
                openCommand(entry.word.slice(1), rest)
                return true
            }
            if (entry.kind === "output") {
                openCommand(entry.word.slice(1), rest)
                return true
            }
            return false
        },
        // `manifestPath` is read by the `/config` branch. A prop that does not change in practice, and
        // listing it is what stops a later change from being captured stale — the same reason the rule
        // exists rather than a suppression here.
        [openCommand, catalogue, sessions, onSwitch, note, manifestPath],
    )

    // ── the pane has the keyboard while it is open ────────────────────────────────────────
    useInput(
        (input, key) => {
            if (pane.kind !== "output") return
            if (key.escape || input === "q") {
                setPane({ kind: "none" })
                return
            }
            const total = pane.lines?.length ?? 0
            const step = key.pageDown || key.pageUp ? frame.pane : 1
            const delta =
                key.downArrow || key.pageDown ? step : key.upArrow || key.pageUp ? -step : 0
            if (delta !== 0) {
                setPane({
                    ...pane,
                    offset: Math.max(0, Math.min(pane.offset + delta, Math.max(0, total - 1))),
                })
            }
        },
        { isActive: pane.kind === "output" },
    )

    useInput(
        (input, reported) => {
            // Modifiers off the wire where they can be had, before anything reads one.
            //
            // Ink folds the super bit into `meta` on its legacy path (`modifier & 10`), so `cmd+←` and
            // `⌥←` arrive as the same keystroke and both word-move — measured in a real Warp session.
            // First line of the handler rather than beside `keyToIntent`, because the palette branch below
            // reads `key.escape` and `key.upArrow` too, and a correction applied after it would be one
            // that two of the three branches never got.
            const key = correctKeys === undefined ? reported : correctKeys(reported, input)

            // A pending confirmation owns the keyboard for exactly one keystroke. Anything other than a
            // yes is a no — including a stray arrow, because the safe answer to an unclear one is to stay.
            if (confirming) {
                setConfirming(false)
                if (input.toLowerCase() === "y" || key.return) exit()
                return
            }

            // The palette owns the keys it needs while it is open, and hands everything else to the editor —
            // so typing continues to narrow the list rather than being swallowed by it.
            if (palette !== undefined) {
                if (key.escape) {
                    setEditor((current) => applyIntent(current, { kind: "killToStart" }))
                    setPaletteIndex(0)
                    return
                }
                if (key.upArrow || key.downArrow) {
                    setPaletteIndex((at) =>
                        Math.max(
                            0,
                            Math.min(at + (key.downArrow ? 1 : -1), palette.matches.length - 1),
                        ),
                    )
                    return
                }
                if (key.tab) {
                    const chosen = paletteSelection(palette, paletteIndex)
                    if (chosen !== undefined) {
                        setEditor((current) =>
                            applyIntent(
                                { ...current, value: "", cursor: 0 },
                                {
                                    kind: "insert",
                                    text: chosen.word,
                                },
                            ),
                        )
                    }
                    return
                }
                const selected = paletteSelection(palette, paletteIndex)
                // Only intercepted when something is selected. With no match, enter falls through to the
                // ordinary submit path, which reports `/skils is not a command` and suggests the nearest
                // one — swallowing it here made a mistyped command do nothing at all, which is worse.
                if (key.return && selected !== undefined) {
                    const chosen = selected
                    setPaletteIndex(0)
                    setEditor((current) => ({ ...current, value: "", cursor: 0 }))
                    // A session verb goes through the same submit path a typed line takes, so `/help` and
                    // `/reset` behave identically whether they were completed or typed out.
                    // The buffer was cleared in the same handler, so nothing is left behind.
                    if (chosen.kind === "session") onSubmit(chosen.word, "")
                    else dispatch(chosen.word, "")
                    return
                }
            }

            const intent = keyToIntent(
                input,
                key,
                keyContext(editor, busy, { armed, scrolled: !view.pinned }),
            )

            // Any keystroke that is not the second ^C disarms. Without this the warning would stay true
            // while somebody typed a whole message, and the ^C they pressed at the end of it — meaning
            // "cancel that" — would end the session instead.
            if (armed && intent.kind !== "exit") setArmed(false)

            if (intent.kind === "arm") {
                setArmed(true)
                return
            }
            if (intent.kind === "scroll") {
                // `times` is the wheel: one chunk can carry several notches, and applying one of them makes
                // a flick of the wheel move a single row. Folded rather than given its own move, so the
                // clamping at both ends stays in one function.
                const times = Math.max(1, intent.times ?? 1)
                setView((current) => {
                    let next = current
                    for (let step = 0; step < times; step += 1) {
                        next = scroll(next, intent.move, rows.length, frame.transcript)
                    }
                    return next
                })
                return
            }
            if (intent.kind === "pointer") {
                // Screen cell to buffer row, through the one function that owns the frame's vertical
                // arithmetic. `undefined` means the cell was chrome — the header, the composer, the status
                // line — and a click there clears the selection rather than selecting the nearest row,
                // because clamping would make clicking the status bar highlight the last reply.
                const hit = transcriptHit(
                    { column: intent.column, row: intent.row },
                    { brandLines: mark?.lines.length ?? 0, from: window.from, to: window.to },
                )
                if (hit === undefined) {
                    // Not the transcript — try the composer. Selecting your own draft with the mouse is
                    // the same gesture and a different target, so it is the same branch rather than a
                    // second handler that would have to re-derive which cell belongs to whom.
                    const offset = composerHit(
                        { column: intent.column, row: intent.row },
                        { editor, columns, rows: size.rows, hint: landing },
                    )
                    if (offset === undefined) {
                        // Genuine chrome. A press clears both selections rather than clamping to whatever
                        // is nearest, because a click on the status line that highlighted the last reply
                        // would look deliberate.
                        if (intent.gesture === "press") {
                            setSelection(undefined)
                            setEditor((current) => ({ ...current, anchor: undefined }))
                        }
                        return
                    }
                    setSelection(undefined)
                    setEditor((current) =>
                        intent.gesture === "press" && !intent.shift
                            ? // A press places the caret and starts a possible selection from it; the
                              // anchor is set now so the first drag report has something to extend from.
                              { ...current, cursor: offset, anchor: offset }
                            : // A drag, or a shift-click, moves the cursor and keeps the anchor — which is
                              // exactly what `extend` does for a shifted motion, expressed directly
                              // because there is no motion here, only a destination.
                              {
                                  ...current,
                                  cursor: offset,
                                  anchor: current.anchor ?? current.cursor,
                              },
                    )
                    return
                }
                if (intent.gesture === "press") {
                    // Shift extends whatever is already there, which is the gesture for correcting a
                    // selection that stopped a word short. Checked before the click count, because a
                    // shift-click is a deliberate second gesture rather than a fast repeat of the first.
                    if (intent.shift && selection !== undefined) {
                        setSelection(extendSelection(selection, hit))
                        lastPress.current = undefined
                        return
                    }
                    const previous = lastPress.current
                    const repeat =
                        previous !== undefined &&
                        Date.now() - previous.when <= MULTI_CLICK_MS &&
                        previous.at.row === hit.row &&
                        previous.at.column === hit.column
                    // Third click wraps back to one, so a fourth starts a fresh drag rather than doing
                    // nothing — a count that only grew would leave rapid clicking permanently stuck on
                    // "line".
                    const clicks = repeat ? (previous.clicks % 3) + 1 : 1
                    lastPress.current = { at: hit, when: Date.now(), clicks }
                    // One selection at a time. Two visible highlights with one clipboard between them is
                    // a screen that cannot say what ⌘C would copy.
                    setEditor((current) => ({ ...current, anchor: undefined }))
                    setSelection(
                        clicks === 3
                            ? lineAt(rows, hit)
                            : clicks === 2
                              ? wordAt(rows, hit)
                              : beginSelection(hit),
                    )
                    return
                }
                if (intent.gesture === "drag") {
                    setSelection((current) =>
                        current === undefined ? undefined : dragSelection(current, hit),
                    )
                    return
                }
                // Release. The clipboard is written here and nowhere else, because `cmd+c` cannot reach a
                // terminal app — the terminal claims it and finds no native selection, mouse tracking
                // having disabled the one it would have used. Copying on mouse-up is what makes `cmd+v`
                // work, and a copy that failed says so rather than leaving the previous clipboard in place
                // looking like the wrong text was selected.
                // Derived from *this* report rather than from the state in the closure. A release carries
                // its own final position, and `selection` here is whatever the last render saw — which on
                // a fast drag-and-release is one motion behind, so copying from it would drop the last few
                // characters somebody deliberately included.
                const finished =
                    selection === undefined
                        ? undefined
                        : endSelection(dragSelection(selection, hit))
                setSelection(finished)
                const text = selectedText(rows, finished)
                if (text !== "") {
                    void copyToClipboard(text).then((result) => {
                        if (!result.copied && result.problem !== "nothing selected") {
                            note(`could not copy: ${result.problem ?? "unknown"}`)
                        }
                    })
                }
                return
            }
            if (intent.kind === "copySelection" || intent.kind === "cutSelection") {
                const range = selectionRange(editor)
                if (range === undefined) {
                    note("nothing selected — hold shift with a motion, or drag in the box")
                    return
                }
                const text = [...editor.value].slice(range.start, range.end).join("")
                if (intent.kind === "cutSelection")
                    setEditor((current) => applyIntent(current, intent))
                void copyToClipboard(text).then((result) => {
                    if (!result.copied) note(`could not copy: ${result.problem ?? "unknown"}`)
                })
                return
            }
            if (intent.kind === "reasoning") {
                // A chord with nothing to act on has to say so.
                //
                // Reported as "⌥r doesn't do anything", and it was arriving and resolving correctly the
                // whole time: it toggles a fold, and a fold with nothing in it looks exactly like a dead
                // key. Two different reasons for that, and they need two different sentences — a model
                // that never streams reasoning is not the same as a turn that has not produced any yet,
                // and only the first is worth changing a flag over.
                // Visibility, not existence — and the order matters. `useTurn` appends a reasoning item
                // for every delta the model streams *regardless* of `showReasoning`, and `transcript.ts`
                // filters them out at render. So a session with reasoning hidden has items that cannot be
                // shown, and testing existence first fell through to a toggle whose rows were filtered
                // away: silently nothing, which is the failure this whole branch exists to prevent.
                if (!showReasoning) {
                    note(
                        "reasoning is off: either this model does not stream it, or --no-reasoning is set",
                    )
                    return
                }
                if (!state.items.some((item) => item.role === "reasoning")) {
                    note("no reasoning to show yet — this expands it once a turn has streamed some")
                    return
                }
                // Unfolding changes how tall the conversation is, so the window has to be told to follow
                // the newest row again — leaving it parked would put the reader at a row that has moved.
                setExpandReasoning((current) => !current)
                setView(FOLLOWING)
                return
            }
            if (intent.kind === "exit") {
                exit()
                return
            }
            if (intent.kind === "cancel") {
                cancel()
                return
            }
            if (intent.kind === "submit") {
                const committed = submit(editor)
                setEditor(committed.state)
                // Sending is an implicit "take me back to the newest row": a reply arriving into a window
                // parked ten screens up would be generated where nobody can see it.
                setView(FOLLOWING)
                if (committed.text !== "") onSubmit(committed.text, committed.state.value)
                return
            }
            if (intent.kind === "paste") {
                // Inserted with its newlines intact, as one message.
                //
                // This used to submit every finished line in the chunk, and that was right when the buffer
                // could not hold a newline: the alternative then was silently running the words together.
                // Now that a message is composed rather than typed on one line, sending line-by-line is the
                // bug multi-line composition exists to remove — pasting a twelve-line code block produced
                // twelve messages, each conditioned on the last, and no way to edit any of them.
                setEditor((current) =>
                    applyIntent(current, { kind: "insert", text: intent.lines.join("\n") }),
                )
                return
            }
            // The match list changes underneath the cursor on every keystroke, so keeping its position
            // would silently highlight a different entry than the one on screen — the same reason the
            // history search resets its index.
            if (palette !== undefined) setPaletteIndex(0)
            setEditor((current) => applyIntent(current, intent))
        },
        { isActive: pane.kind === "none" },
    )

    if (pane.kind === "config") {
        return (
            <Box flexDirection="column" width={columns} height={size.rows}>
                <Text color={THEME.accent} bold wrap="truncate">
                    {titleLine({ title: `${BRAND.name} ${VERSION}`, summary: "settings" }, columns)}
                </Text>
                {Editor === undefined ? (
                    <Box marginLeft={2}>
                        <Spinner label="reading the settings" />
                    </Box>
                ) : (
                    <Editor
                        rows={pane.rows}
                        apply={(row, raw) => applyEditorRow(manifestPath ?? "", row, raw)}
                        reload={() => editorRowsFor(manifestPath ?? "")}
                        columns={columns}
                        window={SESSION_PICKER_ROWS}
                        onDone={(changed) => {
                            setPane({ kind: "none" })
                            // An agent's settings are fixed for the lifetime of the process running it,
                            // so a change that is not followed by a restart is a change that silently
                            // did not apply — rule 8's shape. The draft rides across, for the reason
                            // `/restart` carries it: throwing away a half-written message is a second,
                            // unasked-for consequence of asking for the first.
                            if (changed) {
                                onRestart?.(editor.value)
                                exit()
                            }
                        }}
                    />
                )}
                {/*
                 * The slack goes *below* a long list, not above it. Bottom-anchoring is right for the
                 * conversation switcher — a dozen short rows that read as a menu — and wrong here: the
                 * settings run past twenty rows, so a spacer above them started the list mid-screen with
                 * eight blank rows over it and the rest running off the bottom.
                 */}
                <Box flexGrow={1} />
            </Box>
        )
    }

    if (pane.kind === "sessions") {
        return (
            <Box flexDirection="column" width={columns} height={size.rows}>
                <Text color={THEME.accent} bold wrap="truncate">
                    {titleLine(
                        { title: `${BRAND.name} ${VERSION}`, summary: "pick a conversation" },
                        columns,
                    )}
                </Text>
                <Box flexGrow={1} />
                {pane.stored === undefined || Sessions === undefined ? (
                    <Box marginLeft={2}>
                        <Spinner label="reading the stored conversations" />
                    </Box>
                ) : (
                    <Sessions
                        sessions={pane.stored}
                        now={Date.now()}
                        columns={columns}
                        maxRows={SESSION_PICKER_ROWS}
                        current={sessionKey}
                        onDone={(picked) => {
                            if (picked === undefined || picked === sessionKey) {
                                // Esc, or the one already open. Either way nothing is worth a rebuild.
                                setPane({ kind: "none" })
                                return
                            }
                            onSwitch?.(picked, editor.value)
                            exit()
                        }}
                    />
                )}
                <Box flexGrow={1} />
            </Box>
        )
    }

    if (pane.kind === "skills" && catalogue !== undefined && Browser !== undefined) {
        return (
            <Browser
                title={`${BRAND.name} ${VERSION}`}
                agents={[]}
                target={manifestPath ?? ""}
                load={catalogue.load}
                install={catalogue.install}
                onDone={() => setPane({ kind: "none" })}
            />
        )
    }

    const header = titleLine(
        {
            title: `${BRAND.name} ${VERSION}`,
            summary: "",
            agent: { name: agentName, model },
            ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
        },
        columns,
    )

    return (
        // Fixed height, because the alternate screen has no scrollback to absorb an overshoot: one row too
        // many and Ink's own output scrolls the buffer, which leaves the status line halfway up the display.
        <Box flexDirection="column" width={columns} height={size.rows}>
            {/*
             * Above the one-line header, and only while landing. Nothing appears or disappears when it goes —
             * the line below it is the same line either way, which is what makes the collapse read as the same
             * screen with less on it rather than as a different screen.
             */}
            {mark === undefined ? null : (
                <>
                    <Brandmark lines={mark.lines} />
                    <Text> </Text>
                </>
            )}
            <Text color={THEME.accent} bold wrap="truncate">
                {header}
            </Text>

            {pane.kind === "output" ? (
                <Box flexDirection="column">
                    <CommandOutput
                        lines={pane.lines}
                        label={pane.label}
                        offset={pane.offset}
                        maxRows={frame.pane}
                        {...(pane.code === undefined ? {} : { code: pane.code })}
                    />
                    <Text dimColor wrap="truncate">
                        {"  "}↑↓ scroll · esc back to the prompt
                    </Text>
                </Box>
            ) : (
                <Transcript
                    rows={rows}
                    slice={window}
                    {...(selection === undefined ? {} : { selection })}
                />
            )}

            {/*
             * Absorbs the slack, so the composer sits on the bottom edge of every frame.
             *
             * Unconditional, and that is the whole of decision 11.98's reversal. It used to stand down while
             * landing, on the grounds that twelve blank rows between the banner and the input read as a
             * half-empty screen — but a bottom-anchored input is where the eye already rests, so what those
             * rows read as is a prompt waiting. The reference CLI puts ~25 there and nobody reports it.
             *
             * The cost of the old arrangement was not the blank rows, it was that the composer *moved*: it
             * was drawn under whatever content existed, so it walked down the screen as the first few
             * messages arrived and only settled once the transcript filled the window. The place you type
             * should not move. A spacer costs nothing once the transcript is full, because by then there is
             * no slack left for it to take.
             */}
            <Box flexGrow={1} />

            {state.live === undefined ? null : (
                <Live live={state.live} showReasoning={showReasoning} columns={columns} />
            )}
            {palette === undefined ? null : (
                <Palette
                    palette={palette}
                    index={paletteIndex}
                    width={columns}
                    maxRows={listRows}
                />
            )}
            <HistorySearch editor={editor} width={columns} maxRows={listRows} />
            {/*
             * Rendered once, in the one frame, which is the fix rather than a feature: this lived only in the
             * transcript layout, so `/exit` typed on the landing screen asked for a confirmation nobody could
             * see — the session simply appeared to ignore the command until a second keystroke ended it.
             */}
            {confirming ? (
                <Text color={THEME.warning} wrap="truncate">
                    {"  leave this session? press y to confirm · any other key stays"}
                </Text>
            ) : null}
            <Prompt
                editor={editor}
                busy={busy}
                columns={columns}
                {...(landing ? { placeholder: "Ask anything…" } : {})}
            />
            {/*
             * The keys worth knowing before there is a conversation to learn them from. It stands down once
             * one exists: the status line already carries `^C`, and a permanent hint is a row of conversation.
             */}
            {landing ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {NEW_SESSION_HINT}
                </Text>
            ) : null}
            {/* The status line is the footer, under the input — where every reference CLI puts
                it, and where the eye rests between keystrokes. */}
            <StatusBar
                status={state.status}
                model={model}
                sessionKey={sessionKey}
                elapsedMs={elapsed}
                last={last}
                quiet={quiet}
                armed={armed}
                {...(state.pressure === undefined ? {} : { pressure: state.pressure })}
                {...(state.phase === undefined ? {} : { phase: state.phase })}
            />
        </Box>
    )
}
