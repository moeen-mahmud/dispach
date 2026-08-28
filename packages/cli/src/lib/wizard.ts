/**
 * The init wizard as a pure reducer — a log of answers over `nextQuestion`'s forward-only flow.
 *
 * `nextQuestion` cannot go backwards, so back-navigation is an *answer log*: esc pops the tail
 * and the next question is recomputed from what remains. Popping the tail is always consistent
 * because the log is a prefix of the asking order — re-answering the preset re-derives every
 * downstream default for free. Flag-given answers live in `given` and are never poppable: they
 * were explicit, and backing over them would silently discard something the person typed into a
 * shell.
 *
 * Renderer-free and process-free (PURE-listed): `WizardApp` is one consumer; a test driving the
 * reducer with the same intents is another, and the two cannot diverge.
 */

import { applyIntent, EMPTY_EDITOR } from "#editor"
import type { ListIntent } from "#keymap"
import {
    dirFor,
    type InitStep,
    nextQuestion,
    type PartialAnswers,
    PRESETS,
    presetById,
    type Question,
    type QuestionDefaults,
    SECRET_STEPS,
    validateAnswer,
} from "#lib/init-flow"
import { moveSelect, type SelectState } from "#lib/select"
import type { EditorState, Intent } from "#lib/types"

export type WizardPhase = "asking" | "confirm" | "done" | "aborted"

export interface WizardState {
    /** Flag answers — explicit, never poppable. */
    readonly given: PartialAnswers
    /** What the wizard collected, in asking order. Esc pops the tail. */
    readonly log: readonly { readonly step: InitStep; readonly value: string }[]
    readonly phase: WizardPhase
    /** The current text answer. Reuses the chat editor's state machine wholesale. */
    readonly editor: EditorState
    /** The current select answer (preset step, and the confirm screen's yes/no). */
    readonly select: SelectState
    /** Last validation failure; cleared on the next edit. */
    readonly error: string | undefined
    readonly defaults: QuestionDefaults
}

export function startWizard(given: PartialAnswers, defaults: QuestionDefaults): WizardState {
    const state: WizardState = {
        given,
        log: [],
        phase: "asking",
        editor: EMPTY_EDITOR,
        select: { index: 0, count: PRESETS.length },
        error: undefined,
        defaults,
    }
    // Flags may already answer everything (`init --user … --name … --preset …` at a TTY): the
    // wizard then opens directly on the confirm screen rather than asking zero questions oddly.
    return currentQuestion(state) === undefined ? enterConfirm(state) : state
}

export function partialOf(state: WizardState): PartialAnswers {
    const fromLog = Object.fromEntries(state.log.map((entry) => [entry.step, entry.value]))
    // `given` wins, though overlap cannot occur: nextQuestion never asks an answered step, so the
    // log never contains one.
    return { ...fromLog, ...state.given }
}

export function currentQuestion(state: WizardState): Question | undefined {
    return nextQuestion(partialOf(state), state.defaults)
}

/**
 * Is the current question a fixed set of choices rather than a text field?
 *
 * Read off the question's own `options` rather than compared against a step name. The preset menu was
 * the only select for three phases and "is this the preset step" ended up written into the reducer,
 * the renderer and the cursor prefill — so adding a second one had to either repeat all three or
 * generalise them. Generalising is what stops a third repeating them again.
 */
export function isSelectStep(state: WizardState): boolean {
    return state.phase === "asking" && currentQuestion(state)?.options !== undefined
}

/** The choices on screen, empty when the question is a text field. */
export function selectOptions(state: WizardState): readonly {
    readonly value: string
    readonly label: string
    readonly hint?: string
}[] {
    return currentQuestion(state)?.options ?? []
}

/** Whether the question on screen is one whose answer must never be rendered. */
export function isSecretStep(state: WizardState): boolean {
    const step = currentQuestion(state)?.step
    return state.phase === "asking" && step !== undefined && SECRET_STEPS.has(step)
}

/**
 * Honest step numbering: walk the flow the same way it will actually be asked, so a keyless
 * preset shrinks the total rather than leaving a count that quietly stops being true.
 */
export function stepCounts(state: WizardState): { readonly asked: number; readonly total: number } {
    const walk: Record<string, string> = { ...partialOf(state) }
    let remaining = 0
    for (;;) {
        const question = nextQuestion(walk, state.defaults)
        if (question === undefined) break
        remaining += 1
        walk[question.step] = question.fallback === "" ? "(x)" : question.fallback
    }
    const asked = state.log.length + Object.keys(state.given).length
    return { asked: asked + (state.phase === "asking" ? 1 : 0), total: asked + remaining }
}

export type WizardAction =
    | { readonly kind: "edit"; readonly intent: Intent }
    | { readonly kind: "list"; readonly intent: ListIntent }
    | { readonly kind: "commit" }
    | { readonly kind: "back" }
    | { readonly kind: "abort" }

const CONFIRM_COUNT = 2 // yes / no

function enterConfirm(state: WizardState): WizardState {
    return {
        ...state,
        phase: "confirm",
        editor: EMPTY_EDITOR,
        select: { index: 0, count: CONFIRM_COUNT },
        error: undefined,
    }
}

function freshFor(state: WizardState): Pick<WizardState, "editor" | "select" | "error"> {
    const question = nextQuestion(partialOf(state), state.defaults)
    const options = question?.options
    return {
        editor: EMPTY_EDITOR,
        select: {
            index: cursorFor(question),
            count: options === undefined ? PRESETS.length : options.length,
        },
        error: undefined,
    }
}

/** Prefill the cursor from the question's own fallback ("1" → 0). */
function cursorFor(question: Question | undefined): number {
    const options = question?.options
    if (options === undefined) return 0
    const index = Number(question?.fallback) - 1
    return Number.isInteger(index) && index >= 0 && index < options.length ? index : 0
}

export function reduceWizard(state: WizardState, action: WizardAction): WizardState {
    if (state.phase === "done" || state.phase === "aborted") return state

    switch (action.kind) {
        case "abort":
            return { ...state, phase: "aborted" }

        case "edit":
            if (state.phase !== "asking") return state
            return { ...state, editor: applyIntent(state.editor, action.intent), error: undefined }

        case "list": {
            const intent = action.intent
            if (intent.kind === "move") {
                return { ...state, select: moveSelect(state.select, intent.move), error: undefined }
            }
            if (intent.kind === "choose") return reduceWizard(state, { kind: "commit" })
            if (intent.kind === "back") return reduceWizard(state, { kind: "back" })
            if (intent.kind === "exit") return { ...state, phase: "aborted" }
            return state
        }

        case "back": {
            if (state.phase === "confirm") {
                // Back to the last asked question, its previous answer discarded so it re-asks
                // with the same defaults it had the first time.
                if (state.log.length === 0) return { ...state, phase: "asking", ...freshFor(state) }
                const log = state.log.slice(0, -1)
                const reopened = { ...state, phase: "asking" as const, log }
                return { ...reopened, ...freshFor(reopened) }
            }
            if (state.log.length === 0) return state // nothing wizard-asked to go back to
            const log = state.log.slice(0, -1)
            const popped = { ...state, log }
            return { ...popped, ...freshFor(popped) }
        }

        case "commit": {
            if (state.phase === "confirm") {
                // Index 0 is yes — the summary screen's select. "no" backs into the last question.
                return state.select.index === 0
                    ? { ...state, phase: "done" }
                    : reduceWizard(state, { kind: "back" })
            }

            const question = currentQuestion(state)
            if (question === undefined) return enterConfirm(state)

            const raw =
                question.options !== undefined
                    ? (question.options[state.select.index]?.value ?? "")
                    : state.editor.value.trim() === ""
                      ? question.fallback
                      : state.editor.value

            const checked = validateAnswer(question.step, raw)
            if (!checked.ok) {
                return { ...state, error: checked.reason }
            }

            const advanced: WizardState = {
                ...state,
                log: [...state.log, { step: question.step, value: checked.value }],
            }
            const next = { ...advanced, ...freshFor(advanced) }
            return currentQuestion(next) === undefined ? enterConfirm(next) : next
        }
    }
}

/**
 * What a secret looks like on screen.
 *
 * Enough to recognise a paste went in, never enough to reconstruct. Short values show nothing at
 * all rather than most of themselves.
 */
export function maskSecret(value: string): string {
    if (value === "") return ""
    if (value.length <= 8) return "•".repeat(value.length)
    return `${value.slice(0, 3)}${"•".repeat(6)}${value.slice(-2)}`
}

/** The confirm screen's rows, shared with the plain path's wording. */
export function summaryRows(
    state: WizardState,
): readonly { readonly label: string; readonly value: string }[] {
    const partial = partialOf(state)
    const preset = partial.preset === undefined ? undefined : presetById(partial.preset)
    const endpoint = `${partial.model ?? ""} at ${partial.baseUrl ?? ""}`
    const keyVar = partial.apiKeyEnv ?? preset?.apiKeyEnv
    const key =
        keyVar === undefined
            ? " (no key)"
            : ` (${keyVar}=${partial.apiKey === undefined || partial.apiKey === "" ? "not set yet" : maskSecret(partial.apiKey)})`
    return [
        { label: "agent", value: partial.name ?? "" },
        { label: "for", value: `${partial.user ?? ""} — ${partial.purpose ?? ""}` },
        { label: "endpoint", value: `${endpoint}${key}` },
        // Derived when the answer was `sandbox` or `here`, because the `dir` question is not asked
        // then — and this row is the last thing read before anything is written, so it has to name
        // the directory that will actually exist. `dirFor` is the same function `complete()` calls;
        // a second derivation here is how a confirm screen comes to describe a different path.
        {
            label: "directory",
            value: partial.dir ?? dirFor(partial.dirChoice, partial.name, state.defaults) ?? "",
        },
    ]
}

/** The ✓ lines above the current question. */
export function answeredRows(
    state: WizardState,
): readonly { readonly label: string; readonly value: string }[] {
    const labels: Record<InitStep, string> = {
        user: "Your name",
        name: "Agent name",
        purpose: "Purpose",
        preset: "Endpoint",
        model: "Model",
        baseUrl: "Base URL",
        apiKeyEnv: "Key env var",
        apiKey: "API key",
        web: "Internet",
        webBackend: "Search backend",
        webKey: "Search key",
        system: "System access",
        composio: "Other apps",
        telegram: "Telegram",
        telegramAllow: "Telegram handle",
        telegramToken: "Bot token",
        schedules: "none",
        server: "HTTP API",
        // Was literally `"starter"` — a value pasted into the label column, so the confirm screen
        // showed "starter  starter" for the default answer and "starter  none" for the other one.
        skills: "Skills",
        skillsSearch: "Skill search",
        skillsPick: "Skills picked",
        daemon: "Background service",
        serverToken: "API token",
        composioKey: "Composio key",
        dirChoice: "Location",
        dir: "Directory",
    }
    return state.log.map((entry) => ({
        label: labels[entry.step],
        // A secret is never echoed back, not even to the person who just typed it: these lines
        // stay on screen for the rest of the wizard and end up in scrollback.
        value: SECRET_STEPS.has(entry.step) ? maskSecret(entry.value) : entry.value,
    }))
}
