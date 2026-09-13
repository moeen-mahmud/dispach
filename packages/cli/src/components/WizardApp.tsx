/**
 * The init wizard's Ink root: one `useInput`, a pure reducer, and the kit.
 *
 * Deliberately NO `<Static>` anywhere here — answered lines are editable via esc-back, which is
 * incompatible with Static's write-once contract, and the whole wizard is a couple of dozen
 * dynamic rows with no streaming, so full-frame redraw is free. Do not "optimise" this into
 * Static; the transcript's constraints do not apply to a form.
 */

import { BRAND } from "@dispach/core"
import { Box, Text, useApp, useInput } from "ink"
import { useCallback, useEffect, useReducer, useState } from "react"
import { fetchCatalogue } from "#browse"
import { Banner } from "#components/Banner"
import { BRAND_INDENT, Brandmark } from "#components/Brandmark"
import { CheckList } from "#components/CheckList"
import { SelectList } from "#components/SelectList"
import { Spinner } from "#components/Spinner"
import { SummaryCard } from "#components/SummaryCard"
import { TextField } from "#components/TextField"
import { WizardFrame } from "#components/WizardFrame"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { keyToCheckIntent, keyToWizardIntent } from "#keymap"
import { type BrowseRow, chosenEntries, selectableOf } from "#lib/browse"
import { FALLBACK_COLUMNS, FALLBACK_ROWS, FIELD_ROWS } from "#lib/const"
import type { PartialAnswers, QuestionDefaults } from "#lib/init-flow"
import { firstSelectable, type MultiSelectState, reduceMultiSelect } from "#lib/multiselect"
import { screenColumns, screenRows } from "#lib/screen"
import { GLYPH, THEME } from "#lib/theme"
import {
    answeredRows,
    currentQuestion,
    isSecretStep,
    isSelectStep,
    partialOf,
    reduceWizard,
    selectOptions,
    startWizard,
    stepCounts,
    summaryRows,
    type WizardState,
} from "#lib/wizard"
import { wordmark } from "#lib/wordmark"

/**
 * Rows the wizard body needs before a wordmark is affordable — the field box, the answered-so-far list as
 * it grows, the step line, and a margin. Measured against the tallest question rather than the current one:
 * a mark that fitted on step 1 and pushed the step line off the screen on step 12 is worse than no mark.
 */
const WIZARD_BODY_ROWS = 16
/** The mark never takes more than the chat's own largest tier, however tall the terminal is. */
const WORDMARK_MAX_ROWS = 5

export interface WizardAppProps {
    readonly title: string
    readonly given: PartialAnswers
    readonly defaults: QuestionDefaults
    /** The collected answers, or undefined when the person backed out. */
    readonly onDone: (answers: PartialAnswers | undefined) => void
}

/**
 * The catalogue step, which is a *screen* rather than a question.
 *
 * It lives in the root's own state instead of the pure reducer for one reason: it needs a network fetch, and
 * `nextQuestion` is a pure synchronous function over static option tables. That was the excuse for asking a
 * text question instead — "what does it do often?" — in a tree that already had a checklist. Wrong: the
 * reducer's shape is a fact about the reducer, and the *flow* is what the person sees. So the answer stays a
 * static three-way choice, and picking happens here, between two questions, with the remaining questions
 * carrying on afterwards.
 *
 * `fetchCatalogue` reports progress through a callback rather than to stdout, because writing to stdout
 * while Ink owns the frame paints over it — and being *async* is what keeps the spinner turning and the
 * keystrokes consumed. A blocking `spawnSync` here froze the app and let the tty echo the arrow keys
 * somebody pressed during a twenty-second clone, straight into the middle of the output.
 */
type Catalogue =
    | { readonly kind: "idle" }
    | { readonly kind: "fetching"; readonly status: string }
    | {
          readonly kind: "picking"
          readonly rows: readonly BrowseRow[]
          readonly picked: MultiSelectState
      }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "done"; readonly refs: readonly string[] }

export function WizardApp({ title, given, defaults, onDone }: WizardAppProps) {
    const { exit } = useApp()
    // The live size, so a resize re-picks the wordmark's tier rather than freezing whichever one fitted at
    // launch. `screenColumns` is what handles a stream reporting a width of zero.
    const size = useTerminalSize()
    const [catalogue, setCatalogue] = useState<Catalogue>({ kind: "idle" })
    const [state, dispatch] = useReducer(
        (current: WizardState, action: Parameters<typeof reduceWizard>[1]) =>
            reduceWizard(current, action),
        undefined,
        () => startWizard(given, defaults),
    )

    const finish = useCallback(
        (answers: PartialAnswers | undefined) => {
            onDone(answers)
            exit()
        },
        [onDone, exit],
    )

    // Answered `find`, and the answer came from the *log* rather than from a flag — a `--skills find` run
    // would otherwise open the picker before the first question, which is not "in the flow", it is instead
    // of it.
    const wantsCatalogue = state.log.some(
        (entry) => entry.step === "skills" && entry.value === "find",
    )

    useEffect(() => {
        if (!wantsCatalogue || catalogue.kind !== "idle") return
        setCatalogue({ kind: "fetching", status: "reading the catalogue" })
        void (async () => {
            try {
                const rows = await fetchCatalogue({
                    onStatus: (status) => setCatalogue({ kind: "fetching", status }),
                })
                if (rows.length === 0) {
                    setCatalogue({
                        kind: "failed",
                        message: "no catalogue could be read — carrying on without skills",
                    })
                    return
                }
                const selectable = selectableOf(rows)
                setCatalogue({
                    kind: "picking",
                    rows,
                    picked: {
                        cursor: { index: firstSelectable(selectable), count: rows.length },
                        chosen: [],
                    },
                })
            } catch (error) {
                // Never fatal. A network that is down must not cost somebody the agent they were setting up.
                setCatalogue({
                    kind: "failed",
                    message: error instanceof Error ? error.message : String(error),
                })
            }
        })()
    }, [wantsCatalogue, catalogue.kind])

    // A failure is shown for a moment and then stepped past, rather than blocking on a keypress nobody
    // needs to make: there is no decision left to take.
    useEffect(() => {
        if (catalogue.kind !== "failed") return
        const timer = setTimeout(() => setCatalogue({ kind: "done", refs: [] }), 1400)
        return () => clearTimeout(timer)
    }, [catalogue])

    useEffect(() => {
        if (state.phase === "done") {
            const refs = catalogue.kind === "done" ? catalogue.refs : []
            finish({
                ...partialOf(state),
                ...(refs.length === 0 ? {} : { skillsPick: refs.join(",") }),
            })
        }
        if (state.phase === "aborted") finish(undefined)
    }, [state, finish, catalogue])

    useInput((input, key) => {
        // While the catalogue owns the screen it owns the keyboard. Routed here rather than by disabling
        // `useInput`: Ink allows one handler per root, and two would race for the same keypress.
        if (catalogue.kind === "picking") {
            const rows = catalogue.rows
            const selectable = selectableOf(rows)
            const intent = keyToCheckIntent(input, key)
            switch (intent.kind) {
                case "move":
                case "toggle":
                case "all":
                    setCatalogue({
                        ...catalogue,
                        picked: reduceMultiSelect(
                            catalogue.picked,
                            intent.kind === "move"
                                ? { kind: "move", move: intent.move }
                                : { kind: intent.kind },
                            selectable,
                        ),
                    })
                    return
                case "none-selected":
                    setCatalogue({
                        ...catalogue,
                        picked: reduceMultiSelect(catalogue.picked, { kind: "none" }, selectable),
                    })
                    return
                case "confirm":
                case "cancel":
                    // Enter with nothing ticked and esc are the same outcome — no skills — and both carry
                    // on with the remaining questions rather than ending anything.
                    setCatalogue({
                        kind: "done",
                        refs:
                            intent.kind === "cancel"
                                ? []
                                : chosenEntries(rows, catalogue.picked.chosen).map(
                                      (entry) => `${entry.source}/${entry.skill}`,
                                  ),
                    })
                    return
                default:
                    return
            }
        }
        if (catalogue.kind === "fetching" || catalogue.kind === "failed") return

        const intent = keyToWizardIntent(input, key, {
            select: isSelectStep(state) || state.phase === "confirm",
            empty: state.editor.value === "",
        })
        switch (intent.kind) {
            case "abort":
                dispatch({ kind: "abort" })
                return
            case "back":
                dispatch({ kind: "back" })
                return
            case "commit":
                dispatch({ kind: "commit" })
                return
            case "list":
                dispatch({ kind: "list", intent: intent.intent })
                return
            case "edit":
                dispatch({ kind: "edit", intent: intent.intent })
                return
        }
    })

    if (state.phase === "done" || state.phase === "aborted") return null

    if (catalogue.kind === "fetching") {
        return (
            <Box flexDirection="column">
                <Banner title="Skills" lines={["choosing what this agent knows how to do"]} />
                <Box marginTop={1} paddingLeft={2}>
                    <Spinner label={catalogue.status} />
                </Box>
            </Box>
        )
    }

    if (catalogue.kind === "failed") {
        return (
            <Box flexDirection="column">
                <Banner title="Skills" lines={["carrying on without them"]} />
                <Box marginTop={1} paddingLeft={2}>
                    <Text color={THEME.warning}>{catalogue.message}</Text>
                </Box>
            </Box>
        )
    }

    if (catalogue.kind === "picking") {
        const ticked = catalogue.picked.chosen.length
        return (
            <Box flexDirection="column">
                <Banner
                    title="Skills"
                    lines={["space ticks · a all · n none · enter continues · esc skips"]}
                />
                <Box marginTop={1}>
                    <CheckList
                        rows={catalogue.rows}
                        index={catalogue.picked.cursor.index}
                        chosen={catalogue.picked.chosen}
                        window={screenRows(undefined, FALLBACK_ROWS)}
                        width={screenColumns(undefined, FALLBACK_COLUMNS)}
                    />
                </Box>
                <Box marginTop={1} paddingLeft={2}>
                    <Text color={ticked === 0 ? THEME.muted : THEME.success}>
                        {ticked === 0
                            ? "nothing ticked — enter carries on without any"
                            : `${ticked} ticked`}
                    </Text>
                </Box>
            </Box>
        )
    }

    const counts = stepCounts(state)
    // Rows the wizard body needs before a picture is affordable: the field box, the answered-so-far list,
    // the step line, and a margin. Below that the mark degrades and then goes.
    const mark = wordmark(BRAND.name, {
        columns: screenColumns(size.columns, FALLBACK_COLUMNS) - BRAND_INDENT,
        rows: Math.min(WORDMARK_MAX_ROWS, Math.max(0, size.rows - WIZARD_BODY_ROWS)),
    })

    const hint =
        state.phase === "confirm"
            ? "enter confirm · esc back · ^C quit — nothing written"
            : "enter accepts · esc back · ^C quit — nothing written"

    return (
        <Box flexDirection="column">
            {/*
             * The wordmark, then a one-line header — the chat's own shape, and the same `wordmark` rather
             * than a second mark for a second surface.
             *
             * It replaces a boxed title rather than sitting above one. Keeping both would put the product
             * name on screen twice, three rows apart, which is the duplication the chat banner had until
             * this phase — a picture of the name above a box that also spells it, three rows apart.
             *
             * The budget is what makes it degrade. `wordmark` walks its tiers down to a single spaced-out
             * line and there is no floor below that, so a short or narrow terminal loses the picture rather
             * than the questions.
             */}
            {mark.lines.length > 0 ? <Brandmark lines={mark.lines} /> : null}
            <Box marginTop={mark.lines.length > 0 ? 1 : 0}>
                <Text dimColor wrap="truncate">
                    {title} · a few questions — nothing is written until you confirm
                </Text>
            </Box>
            {state.phase === "confirm" ? (
                <Box flexDirection="column" marginTop={1}>
                    <SummaryCard rows={summaryRows(state)} />
                    <Box marginTop={1} flexDirection="column">
                        <Text>Write the files?</Text>
                        <SelectList
                            items={[{ label: "yes" }, { label: "no, go back" }]}
                            index={state.select.index}
                        />
                    </Box>
                    <Text dimColor>{hint}</Text>
                </Box>
            ) : (
                <Box marginTop={1}>
                    <WizardFrame
                        step={counts.asked}
                        total={counts.total}
                        answered={answeredRows(state)}
                        hint={hint}
                    >
                        {isSelectStep(state) ? (
                            <Box flexDirection="column">
                                <Text>{currentQuestion(state)?.prompt ?? ""}</Text>
                                <SelectList
                                    items={selectOptions(state).map((option) => ({
                                        label: option.label,
                                        ...(option.hint === undefined ? {} : { hint: option.hint }),
                                    }))}
                                    index={state.select.index}
                                    numbered
                                />
                            </Box>
                        ) : (
                            <TextField
                                label={currentQuestion(state)?.prompt ?? ""}
                                editor={state.editor}
                                // Not a bug fix here: the bordered frame already bounds the text, so a
                                // long answer wrapped without this — measured, rather than assumed after
                                // the settings editor turned out to be broken. Passed because the
                                // component that owns a bounded window should do its own wrapping, and
                                // because `maxRows` is a real bound on the height that did not exist.
                                columns={
                                    screenColumns(size.columns, FALLBACK_COLUMNS) - BRAND_INDENT
                                }
                                maxRows={FIELD_ROWS}
                                placeholder={currentQuestion(state)?.fallback ?? ""}
                                {...(state.error === undefined ? {} : { error: state.error })}
                                {...(isSecretStep(state) ? { secret: true } : {})}
                            />
                        )}
                    </WizardFrame>
                </Box>
            )}
            {state.error !== undefined && (isSelectStep(state) || state.phase === "confirm") ? (
                <Text color={THEME.error}>
                    {GLYPH.error}
                    {state.error}
                </Text>
            ) : null}
        </Box>
    )
}
