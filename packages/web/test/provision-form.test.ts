/**
 * The form's rules, with none of its content.
 *
 * Every question comes off the wire, generated from the walk the terminal wizard follows — so what
 * is testable here is not *which* fields exist but what a form does with a step that is only asked
 * because of an earlier answer. Pure, so the interesting cases need no page.
 *
 * The step fixtures below are hand-written **on purpose**: they are the wire's shape, not the
 * wizard's output, and asserting against the real walk would couple this to whatever questions the
 * runtime happens to ask today. `packages/cli/test/provision.test.ts` is what holds the real walk
 * to its promises.
 */

import { describe, expect, test } from "bun:test"
import type { ProvisionStepLike } from "@dispach/client"
import {
    askable,
    blankSecrets,
    initialAnswers,
    missingAnswers,
    payloadFor,
    visibleSteps,
} from "../src/lib/provision-form.ts"

function step(partial: Partial<ProvisionStepLike> & { readonly step: string }): ProvisionStepLike {
    return {
        prompt: partial.step,
        fallback: "",
        optional: false,
        secret: false,
        ...partial,
    }
}

/** Two levels of condition, because one level is right today and wrong at the next capability. */
const STEPS: readonly ProvisionStepLike[] = [
    step({ step: "name" }),
    step({ step: "purpose", fallback: "whatever comes up" }),
    step({
        step: "web",
        fallback: "none",
        choices: [
            { value: "none", label: "no" },
            { value: "search", label: "search" },
        ],
    }),
    step({
        step: "webBackend",
        fallback: "tavily",
        requires: { step: "web", value: "search" },
        choices: [
            { value: "tavily", label: "Tavily" },
            { value: "brave", label: "Brave" },
        ],
    }),
    step({
        step: "webKey",
        optional: true,
        secret: true,
        requires: { step: "web", value: "search" },
    }),
    step({
        step: "braveRegion",
        requires: { step: "webBackend", value: "brave" },
    }),
]

describe("which fields a form draws", () => {
    test("a conditional field is absent until its choice is made", () => {
        const off = initialAnswers(STEPS)
        expect(visibleSteps(STEPS, off).map((entry) => entry.step)).toEqual([
            "name",
            "purpose",
            "web",
        ])
        const on = { ...off, web: "search" }
        expect(visibleSteps(STEPS, on).map((entry) => entry.step)).toEqual([
            "name",
            "purpose",
            "web",
            "webBackend",
            "webKey",
        ])
    })

    test("a requirement is evaluated transitively, not one link deep", () => {
        /**
         * The wire records only the **nearest** opening choice, so `braveRegion` says
         * `webBackend: brave` and says nothing about `web: search` — which `webBackend` itself
         * requires. A form that stopped at the first link would draw a region field on a server
         * with the web switched off, and the route would refuse the answer as unknown.
         */
        const brave = { ...initialAnswers(STEPS), webBackend: "brave" }
        expect(askable(STEPS, STEPS[5] as ProvisionStepLike, brave)).toBe(false)
        expect(askable(STEPS, STEPS[5] as ProvisionStepLike, { ...brave, web: "search" })).toBe(
            true,
        )
    })

    test("a requirement naming a step that is not in the list hides the field", () => {
        // A requirement nothing can satisfy is a form bug either way, and drawing the field would
        // put a value in front of somebody that the route then refuses as an unknown answer.
        const orphan = [step({ step: "ghost", requires: { step: "gone", value: "x" } })]
        expect(visibleSteps(orphan, { gone: "x" })).toEqual([])
    })

    test("the defaults are the server's own", () => {
        // Including the hidden ones, so changing a choice back does not discard what was typed
        // under it. `payloadFor` is what decides whether an answer is *sent*.
        expect(initialAnswers(STEPS).webBackend).toBe("tavily")
        expect(initialAnswers(STEPS).purpose).toBe("whatever comes up")
    })
})

describe("what the submit gate blocks", () => {
    test("a required field with no answer is named, an optional one is not", () => {
        const answers = { ...initialAnswers(STEPS), web: "search" }
        expect(missingAnswers(STEPS, answers).map((entry) => entry.step)).toEqual(["name"])
        // `webKey` is empty and optional — a secret supplied another way is a real answer.
        expect(missingAnswers(STEPS, answers).map((entry) => entry.step)).not.toContain("webKey")
    })

    test("a hidden required field is not a blocker", () => {
        // Its default is filled server side, exactly as `init --yes` does with a flag nobody passed.
        // Counting it would make the form unsubmittable for a question nobody was asked.
        const answers = { ...initialAnswers(STEPS), name: "milo", webBackend: "brave" }
        expect(missingAnswers(STEPS, answers)).toEqual([])
    })

    test("whitespace is not an answer", () => {
        const answers = { ...initialAnswers(STEPS), name: "   " }
        expect(missingAnswers(STEPS, answers).map((entry) => entry.step)).toEqual(["name"])
    })
})

describe("what is sent", () => {
    test("a hidden answer is not sent, however it got there", () => {
        /**
         * The shape this route was just corrected for: an answer to a question that was not asked
         * is accepted, validated, and acted on by nobody. A form holding `webKey` from a choice
         * that was since changed back must not ship it.
         */
        const answers = { ...initialAnswers(STEPS), name: "milo", webKey: "tvly-secret" }
        expect(payloadFor(STEPS, answers)).toEqual({
            name: "milo",
            purpose: "whatever comes up",
            web: "none",
        })
    })

    test("an empty answer is omitted rather than sent as an empty string", () => {
        // Absence means "take the default" on this route; `""` means "supplied another way". A
        // required field the operator never touched must not become a refusal.
        expect(payloadFor(STEPS, { ...initialAnswers(STEPS), name: "" })).not.toHaveProperty("name")
    })

    test("an answer is trimmed", () => {
        expect(payloadFor(STEPS, { ...initialAnswers(STEPS), name: "  milo  " }).name).toBe("milo")
    })
})

describe("what is still missing afterwards", () => {
    test("a secret left empty is reported, and only if it was asked for", () => {
        /**
         * `.env` is a **protected path**: neither the agent nor any route can fill it in later, so
         * an agent provisioned with an empty token needs a terminal visit — and this is the only
         * place anybody is told. A secret for a question nobody was asked is not missing.
         */
        const on = { ...initialAnswers(STEPS), name: "milo", web: "search" }
        expect(blankSecrets(STEPS, on).map((entry) => entry.step)).toEqual(["webKey"])
        expect(blankSecrets(STEPS, { ...on, webKey: "tvly-x" })).toEqual([])
        expect(blankSecrets(STEPS, { ...initialAnswers(STEPS), name: "milo" })).toEqual([])
    })
})
