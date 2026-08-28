/**
 * The wizard reducer: forward flow, esc-back over the answer log, and the honest step count.
 *
 * Driven exactly the way `WizardApp` drives it, so a passing test here is the wizard working —
 * the component adds only pixels.
 */

import { describe, expect, test } from "bun:test"
import {
    currentQuestion,
    isSelectStep,
    partialOf,
    reduceWizard,
    startWizard,
    stepCounts,
    summaryRows,
    type WizardState,
} from "#lib/wizard"

function type(state: WizardState, text: string): WizardState {
    return [...text].reduce(
        (current, char) =>
            reduceWizard(current, { kind: "edit", intent: { kind: "insert", text: char } }),
        state,
    )
}

function commit(state: WizardState): WizardState {
    return reduceWizard(state, { kind: "commit" })
}

function answer(state: WizardState, text: string): WizardState {
    return commit(type(state, text))
}

describe("the happy path", () => {
    test("answers every step, reaches confirm, and yields the collected answers", () => {
        let state = startWizard({}, {})
        state = answer(state, "Moeen") // user
        state = answer(state, "Milo") // name
        state = commit(state) // purpose: empty commit takes the fallback
        // preset: select step; move to deepseek (index 2) and choose
        expect(isSelectStep(state)).toBe(true)
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "jump", index: 2 } },
        })
        state = commit(state)
        state = commit(state) // model: preset default
        state = commit(state) // baseUrl: preset default
        state = commit(state) // apiKey: empty is a real answer — supply it later
        state = commit(state) // system: select step, default "no system access"
        state = commit(state) // web: select step, default "no internet"
        state = commit(state) // composio: select step, default "no other apps"
        state = commit(state) // telegram: select step, default "not on Telegram"
        state = commit(state) // server: select step, default "no HTTP API"
        state = commit(state) // skills: select step, index 0 opens the catalogue picker after the wizard
        state = commit(state) // dir: derived from name
        expect(state.phase).toBe("confirm")

        const partial = partialOf(state)
        expect(partial.user).toBe("Moeen")
        expect(partial.preset).toBe("deepseek")
        expect(partial.model).toBe("deepseek-v4-flash")
        expect(partial.dir).toBe("./milo")

        // Confirm: index 0 is yes.
        state = commit(state)
        expect(state.phase).toBe("done")
    })

    test("a keyless preset skips the key question and the step total shrinks", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x" }, {})
        const totalBefore = stepCounts(state).total
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "jump", index: 3 } },
        }) // ollama
        state = commit(state)
        expect(stepCounts(state).total).toBe(totalBefore - 1)
        state = commit(state) // model default
        state = commit(state) // baseUrl default
        state = commit(state) // system default
        state = commit(state) // web default
        state = commit(state) // composio default
        state = commit(state) // telegram default
        state = commit(state) // server default
        state = commit(state) // skills — index 0 opens the catalogue picker after the wizard
        state = commit(state) // dir — apiKeyEnv was skipped
        expect(state.phase).toBe("confirm")
        expect(partialOf(state).apiKeyEnv).toBe(undefined)
    })
})

describe("validation", () => {
    test("an invalid answer sets the error and stays on the question", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x", preset: "custom" }, {})
        state = answer(state, "some-model") // model (custom has no default)
        state = answer(state, "https://x.example/v1/chat/completions") // baseUrl — the classic mistake
        expect(state.error).toContain("version segment")
        expect(currentQuestion(state)?.step).toBe("baseUrl")
        // Editing clears the error.
        state = reduceWizard(state, { kind: "edit", intent: { kind: "killToStart" } })
        expect(state.error).toBe(undefined)
    })
})

describe("back navigation", () => {
    test("esc pops the last wizard answer; flag-given answers are never poppable", () => {
        let state = startWizard({ user: "Moeen" }, {})
        state = answer(state, "Milo") // name (wizard-asked)
        expect(currentQuestion(state)?.step).toBe("purpose")
        state = reduceWizard(state, { kind: "back" })
        expect(currentQuestion(state)?.step).toBe("name")
        // Backing again does nothing: `user` came from a flag and stays answered.
        state = reduceWizard(state, { kind: "back" })
        expect(currentQuestion(state)?.step).toBe("name")
        expect(partialOf(state).user).toBe("Moeen")
    })

    test("re-answering the preset re-derives the downstream defaults", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x" }, {})
        state = commit(state) // preset: default index 0 = openai
        expect(currentQuestion(state)?.fallback).toBe("gpt-5-6-sol")
        state = reduceWizard(state, { kind: "back" }) // back onto preset
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "jump", index: 2 } },
        })
        state = commit(state) // deepseek now
        expect(currentQuestion(state)?.fallback).toBe("deepseek-v4-flash")
    })

    test("declining the confirm screen reopens the last question", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x", preset: "ollama" }, {})
        state = commit(state) // model
        state = commit(state) // baseUrl
        state = commit(state) // system
        state = commit(state) // web
        state = commit(state) // composio
        state = commit(state) // telegram
        state = commit(state) // server
        state = commit(state) // skills — index 0 opens the catalogue picker after the wizard
        state = commit(state) // dir
        expect(state.phase).toBe("confirm")
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "down" } },
        })
        state = commit(state) // "no, go back"
        expect(state.phase).toBe("asking")
        expect(currentQuestion(state)?.step).toBe("dir")
    })
})

describe("abort", () => {
    test("abort works from any phase and is terminal", () => {
        let state = startWizard({}, {})
        state = reduceWizard(state, { kind: "abort" })
        expect(state.phase).toBe("aborted")
        expect(reduceWizard(state, { kind: "commit" }).phase).toBe("aborted")
    })
})

describe("flags answering everything", () => {
    const ALL_FLAGS = {
        user: "Moeen",
        name: "Milo",
        purpose: "x",
        preset: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
        system: "none",
        web: "none",
        composio: "none",
        telegram: "none",
        server: "none",
        schedules: "none",
        skills: "starter",
        dir: "./milo",
    }

    test("still asks for the key, which is the one thing no flag carries", () => {
        // Deliberate: a key passed on the command line lands in shell history, so at a terminal it
        // is asked for even when every other answer arrived as a flag. The alternative was writing
        // an empty MODEL_API_KEY= and producing an agent that cannot run.
        const state = startWizard(ALL_FLAGS, {})
        expect(state.phase).toBe("asking")
        expect(currentQuestion(state)?.step).toBe("apiKey")
    })

    test("answering it reaches confirm, and the key is never shown back", () => {
        let state = startWizard(ALL_FLAGS, {})
        state = reduceWizard(state, { kind: "edit", intent: { kind: "insert", text: "sk-secret" } })
        state = reduceWizard(state, { kind: "commit" })

        expect(state.phase).toBe("confirm")
        const endpoint = summaryRows(state).find((row) => row.label === "endpoint")?.value ?? ""
        expect(endpoint.includes("sk-secret")).toBe(false)
        expect(endpoint).toContain("MODEL_API_KEY=")
    })

    test("a keyless preset asks nothing and opens on confirm", () => {
        const state = startWizard({ ...ALL_FLAGS, preset: "ollama" }, {})
        expect(state.phase).toBe("confirm")
        expect(summaryRows(state).map((row) => row.label)).toEqual([
            "agent",
            "for",
            "endpoint",
            "directory",
        ])
    })
})

describe("the skills question never becomes a text box", () => {
    /**
     * The regression guard for a real complaint. `find` was implemented as a wizard *question* — "What
     * does it do often? Words a skill's own description would use" — in a tree that already had a
     * catalogue picker, so init asked somebody to describe a skill instead of showing them the skills.
     * The answer opens the picker after the wizard; the wizard itself asks nothing more.
     */
    test("choosing `find` asks no follow-up question", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x", preset: "ollama" }, {})
        state = commit(state) // model
        state = commit(state) // baseUrl
        state = commit(state) // system
        state = commit(state) // web
        state = commit(state) // composio
        state = commit(state) // telegram
        state = commit(state) // server
        expect(currentQuestion(state)?.step).toBe("skills")
        state = commit(state) // index 0 is `find`
        expect(partialOf(state).skills).toBe("find")
        // Straight to the next real question. A `skillsSearch` step here is the defect.
        expect(currentQuestion(state)?.step).toBe("dir")
        expect(partialOf(state).skillsSearch).toBe(undefined)
    })

    test("`find` and `starter` ask the same number of questions", () => {
        // If one answer added a step, the step counter would jump mid-flow — and the reason it used to was
        // that the expensive answer asked for words it did not need.
        const base = { user: "M", name: "Pip", purpose: "x", preset: "ollama" } as const
        const withFind = stepCounts(startWizard({ ...base, skills: "find" }, {})).total
        const withStarter = stepCounts(startWizard({ ...base, skills: "starter" }, {})).total
        expect(withFind).toBe(withStarter)
    })
})
