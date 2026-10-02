/**
 * An agent's settings, changed in place.
 *
 * A view under the Phase 5.5 contract: it never mounts itself, never calls `useApp().exit()`, and
 * reports through `onDone`. Two hosts use it — `config` mounts it standalone, and the chat opens it as a
 * pane — and neither is visible from here. `focused` gates the `useInput`, because Ink fires **every**
 * active hook: an editor over a live prompt would otherwise have two surfaces reading one keystroke,
 * which is a wrong action rather than a rendering fault.
 *
 * ## Two modes, one keymap
 *
 * Browsing is list navigation; editing a value is the full chat editor. That is exactly the shape
 * `keyToWizardIntent` already describes — `select: true` for the list, `select: false` for the field —
 * so there is no third intent mapper to keep in step. Esc means "back out of this edit" while editing
 * and "close" while browsing, which is what that mapper calls `back` either way; the component decides
 * which, because only it knows the mode.
 *
 * ## Every confirmed edit is written immediately
 *
 * No staged set, no unsaved state, no cancel-all. Each confirmation goes through the same
 * `applySet`/`applyAllow`/`applySecret` the plain commands use, so every state the file is in is valid
 * and a closed pane cannot discard work. The row list is re-read after each write rather than patched,
 * because a write may normalise a value, an `allowFrom` change rewrites the whole channels list, and a
 * secret changes a row without touching the manifest at all.
 */

import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { TextField } from "#components/TextField"
import { applyIntent } from "#editor"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { keyToWizardIntent } from "#keymap"
import {
    beginEdit,
    beginWrite,
    type ConfigEditorState,
    cancelEdit,
    current,
    type EditorRow,
    moveCursor,
    openEditor,
    refuse,
    rowKey,
    settle,
    typing,
} from "#lib/config-editor"
import { FIELD_ROWS, MIN_SCREEN_ROWS, SCREEN_CHROME_ROWS } from "#lib/const"
import { clip, viewportByHeight } from "#lib/rows"
import type { SelectMove } from "#lib/select"
import { THEME } from "#lib/theme"

export interface ConfigEditorProps {
    /** The rows as they are now. Read by the host, because reading a file is not a component's job. */
    readonly rows: readonly EditorRow[]
    /**
     * Perform the row's edit and return the sentence to show, or throw with one.
     *
     * The host owns this because it is the only async part, and because the two hosts resolve the
     * manifest differently — a pane already knows which agent it is talking to.
     */
    readonly apply: (row: EditorRow, raw: string) => Promise<string>
    /** Re-read the rows from disk after a write. */
    readonly reload: () => readonly EditorRow[]
    readonly columns: number
    /**
     * The most rows the list may use. A **ceiling**, not the height: the terminal always wins.
     *
     * Passing it as the height put the whole list on screen at once on a 30-row terminal, which is one
     * row too many — Ink's own output then scrolls the buffer, and the `tools` block, the cursor and the
     * footer all went off the top with nothing saying so. An overflowing frame is corruption, not a
     * scrollbar.
     */
    readonly window: number
    readonly focused?: boolean
    /** True when at least one write landed, so a host can offer a restart. */
    readonly onDone: (changed: boolean) => void
}

export function ConfigEditor({
    rows,
    apply,
    reload,
    columns,
    window,
    focused = true,
    onDone,
}: ConfigEditorProps) {
    const size = useTerminalSize()
    // The same clamp `SkillBrowser` uses. Biased low on purpose: a row short of the terminal is a blank
    // line, and a row over it scrolls the whole layout away.
    const visible = Math.max(MIN_SCREEN_ROWS, Math.min(window, size.rows - SCREEN_CHROME_ROWS))
    // Held here, like every other view in this directory: `SkillBrowser` and `SessionPicker` own their
    // state and their single `useInput` too. The alternative put `useState` in `config.ts`, which is a
    // shared command path — and a static React import there is ~170-210 ms paid by every command,
    // including `validate --json`, which is why a boundaries test refuses it.
    const [state, setState] = useState<ConfigEditorState>(() => openEditor(rows))
    const [changed, setChanged] = useState(false)
    const row = current(state)

    useInput(
        (input, key) => {
            if (state.busy) return

            const intent = keyToWizardIntent(input, key, {
                select: state.mode === "browse",
                empty: state.editor.value === "",
            })

            if (intent.kind === "abort") {
                onDone(changed)
                return
            }
            if (intent.kind === "back") {
                // The same key, two meanings, decided here because only the component knows the mode:
                // leave the field, or leave the editor.
                if (state.mode === "editing") setState(cancelEdit)
                else onDone(changed)
                return
            }
            if (intent.kind === "list") {
                if (intent.intent.kind === "move") {
                    const move = intent.intent.move
                    setState((s) => moveCursor(s, targetOf(move, s)))
                }
                return
            }
            if (intent.kind === "commit") {
                if (state.mode === "browse") {
                    setState(beginEdit)
                    return
                }
                void confirm()
                return
            }
            // An edit keystroke, applied to the buffer.
            setState((s) => typing(s, applyIntent(s.editor, intent.intent)))
        },
        { isActive: focused },
    )

    async function confirm(): Promise<void> {
        const target = current(state)
        if (target === undefined) return
        setState(beginWrite)
        try {
            const note = await apply(target, state.editor.value)
            setChanged(true)
            setState((s) => settle(s, reload(), note))
        } catch (error) {
            setState((s) => refuse(s, error instanceof Error ? error.message : String(error)))
        }
    }

    if (state.mode === "editing" && row !== undefined) {
        return (
            <Box flexDirection="column">
                <Text color={THEME.muted} wrap="truncate">
                    {`  ${describeRow(row)}`}
                </Text>
                <TextField
                    label={labelFor(row)}
                    editor={state.editor}
                    secret={row.kind === "secret"}
                    // Without these the value is clipped at the terminal's edge and the caret sits past
                    // the clip: `tools.pinned` is 92 characters in a generated manifest, so the first
                    // long row anybody opens is one they cannot see themselves typing in.
                    columns={columns}
                    // Generous, because while editing this view *is* the screen: it draws a description,
                    // the field and a hint, and nothing else. `FIELD_ROWS` is the shared floor for a
                    // field sharing space with other content; here the space is free, and a value that
                    // scrolled while two-thirds of the terminal sat empty would be a self-inflicted
                    // version of the bug this fixes. At 40 columns — the documented floor — eight rows
                    // holds about 320 characters, past anything a manifest field contains.
                    maxRows={Math.max(FIELD_ROWS, visible - 2)}
                    {...(state.note === undefined ? {} : { error: state.note })}
                />
                <Text dimColor wrap="truncate">
                    {state.busy ? "  writing…" : `  enter writes it · ${keepHint(row)} · ^C closes`}
                </Text>
            </Box>
        )
    }

    // A heading draws two lines (a gap and its label), so the window is budgeted in lines, not rows.
    const { from, to } = viewportByHeight(
        state.rows.map((row) => (row.kind === "heading" ? 2 : 1)),
        state.cursor,
        visible,
    )
    return (
        <Box flexDirection="column">
            {from > 0 ? <Text dimColor wrap="truncate">{`  ↑ ${from} above`}</Text> : undefined}
            {state.rows.slice(from, to).map((entry, offset) => (
                <Row
                    key={rowKey(entry)}
                    row={entry}
                    selected={from + offset === state.cursor}
                    columns={columns}
                />
            ))}
            {to < state.rows.length ? (
                <Text dimColor wrap="truncate">{`  ↓ ${state.rows.length - to} below`}</Text>
            ) : undefined}
            <Text color={state.note === undefined ? THEME.muted : THEME.accent} wrap="truncate">
                {state.note === undefined
                    ? "  ↑↓ move · enter changes it · esc closes"
                    : `  ${state.note}`}
            </Text>
        </Box>
    )
}

function Row({
    row,
    selected,
    columns,
}: {
    readonly row: EditorRow
    readonly selected: boolean
    readonly columns: number
}) {
    if (row.kind === "heading") {
        return (
            <Text color={THEME.muted} wrap="truncate">
                {`\n  ${row.label}`}
            </Text>
        )
    }
    // The name column is fixed so the values line up, and clipped rather than wrapped: a row that wraps
    // is a broken list, and the alignment is what makes a column of values readable at all.
    const name = clip(labelFor(row), Math.min(34, Math.max(12, Math.floor(columns * 0.34))))
    const value = clip(valueNow(row), Math.max(8, columns - name.length - 8))
    return (
        <Text wrap="truncate">
            {selected ? <Text color={THEME.accent}>{"  ❯ "}</Text> : <Text>{"    "}</Text>}
            <Text>{name.padEnd(Math.min(34, Math.max(12, Math.floor(columns * 0.34))))}</Text>
            <Text color={THEME.muted}>{`  ${value}`}</Text>
        </Text>
    )
}

/**
 * Where a move wants the cursor, before headings are stepped over.
 *
 * A digit jumps to a *row* index, so it can land on a heading — `moveCursor` then walks off it in the
 * direction of travel, which for a jump means whichever way it came from. Handled by asking for the
 * position rather than by the mover knowing about headings, so the skipping lives in one place.
 */
function targetOf(move: SelectMove, state: ConfigEditorState): number {
    switch (move.kind) {
        case "up":
            return state.cursor - 1
        case "down":
            return state.cursor + 1
        case "first":
            return 0
        case "last":
            return state.rows.length - 1
        case "jump":
            return move.index
    }
}

/** The name a row is edited under. */
export function labelFor(row: EditorRow): string {
    switch (row.kind) {
        case "setting":
            return row.setting.path
        case "allow":
            return `${row.channelId}.allowFrom`
        case "secret":
            return row.name
        case "heading":
            return row.label
    }
}

/**
 * What the row currently holds.
 *
 * A secret shows only whether it is **set** — never the value, and not even its length. The point of the
 * masked field is that the value is not on screen, and a listing that leaked it would make the masking
 * decorative.
 */
export function valueNow(row: EditorRow): string {
    switch (row.kind) {
        case "setting":
            return row.value === undefined || row.value === null
                ? "(not set)"
                : typeof row.value === "string"
                  ? row.value
                  : JSON.stringify(row.value)
        case "allow":
            return row.handles.length === 0 ? "(nobody)" : row.handles.join(" ")
        case "secret":
            return row.present ? "(set)" : "(not set)"
        case "heading":
            return ""
    }
}

/**
 * What escape keeps, short enough to be a hint rather than a second copy of the value.
 *
 * Naming the old value is genuinely useful for a scalar — `esc keeps nlt` tells you what backing out
 * gets you. For a list it was a 92-character echo of the line directly above it, truncated by the
 * terminal, which is noise in the one row that should be telling you which keys do what.
 */
function keepHint(row: EditorRow): string {
    const value = valueNow(row)
    return value.length <= KEEP_HINT_CHARS ? `esc keeps ${value}` : "esc cancels"
}

/** Past this, naming the old value is a second copy of it rather than a hint. */
const KEEP_HINT_CHARS = 24

/** The one-line explanation shown above the field while editing. */
function describeRow(row: EditorRow): string {
    switch (row.kind) {
        case "setting":
            return row.setting.means
        case "allow":
            return `handles this channel accepts messages from, separated by spaces. Empty refuses everyone`
        case "secret":
            return row.why
        case "heading":
            return row.label
    }
}
