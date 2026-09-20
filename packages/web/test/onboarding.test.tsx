/**
 * The provisioning form, asserted on **rendered markup**.
 *
 * Same argument as `panels.test.tsx`: props in, markup out, so `renderToStaticMarkup` produces
 * exactly what a browser is handed with no DOM and no new dependency. What it catches that a
 * reducer test cannot is the part a person actually interacts with — whether a secret is masked,
 * whether a field that should be hidden is in the document anyway, and whether the sentence after
 * a create says what happened.
 *
 * The last one is not cosmetic. `POST /v1/agents` answers `201` whether or not adoption succeeded,
 * because the agent is on disk either way — so "created" and "created and running" are two
 * different things that must not render the same.
 */

import { describe, expect, test } from "bun:test"
import type { ProvisionOfferLike, ProvisionStepLike } from "@dispach/client"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { initialAnswers } from "../src/lib/provision-form.ts"
import { Created, Onboarding } from "../src/onboarding.tsx"

function step(partial: Partial<ProvisionStepLike> & { readonly step: string }): ProvisionStepLike {
    return { prompt: partial.step, fallback: "", optional: false, secret: false, ...partial }
}

const STEPS: readonly ProvisionStepLike[] = [
    step({ step: "name", prompt: "The agent's name" }),
    step({
        step: "preset",
        prompt: "Model endpoint",
        fallback: "openai",
        choices: [
            { value: "openai", label: "OpenAI", hint: "needs a key" },
            { value: "ollama", label: "Ollama" },
        ],
    }),
    step({ step: "apiKey", prompt: "Model API key", optional: true, secret: true }),
    step({
        step: "telegram",
        prompt: "Telegram?",
        fallback: "none",
        choices: [
            { value: "none", label: "no" },
            { value: "connected", label: "yes" },
        ],
    }),
    step({
        step: "telegramToken",
        prompt: "Telegram bot token",
        optional: true,
        secret: true,
        requires: { step: "telegram", value: "connected" },
    }),
]

function offer(overrides: Partial<ProvisionOfferLike> = {}): ProvisionOfferLike {
    return { available: true, local: true, steps: STEPS, ...overrides }
}

function form(
    answers: Readonly<Record<string, string>>,
    overrides: Partial<Parameters<typeof Onboarding>[0]> = {},
): string {
    return renderToStaticMarkup(
        createElement(Onboarding, {
            offer: offer(),
            answers,
            busy: false,
            touched: false,
            onAnswer: () => {},
            onSubmit: () => {},
            onOpen: () => {},
            ...overrides,
        }),
    )
}

describe("the fields", () => {
    test("a secret is masked, and kept out of the browser's own stores", () => {
        /**
         * The value is sent once, written into the agent's `.env` at `0600`, and read back by no
         * route — so a browser offering to remember it would hold the only recoverable copy
         * anywhere, and `new-password` is what declines that. `spellCheck` off because a red
         * underline under a key reads as a typo in it.
         */
        const html = form(initialAnswers(STEPS))
        // Sliced per field rather than matched as one literal: React's attribute order is not part
        // of any contract, and a test that depends on it fails on a React upgrade rather than on a
        // regression.
        const field = (name: string): string =>
            html.slice(html.indexOf(`id="provision-${name}"`)).split("/>")[0] ?? ""
        expect(field("apiKey")).toContain('type="password"')
        expect(field("apiKey")).toContain('autoComplete="new-password"')
        expect(field("apiKey")).toContain('spellCheck="false"')
        // And a non-secret is not masked, or the assertion above passes by masking everything.
        expect(field("name")).toContain('type="text"')
        expect(field("name")).not.toContain("password")
    })

    test("a choice renders as a control whose default is selectable", () => {
        const html = form(initialAnswers(STEPS))
        expect(html).toContain('<select id="provision-preset"')
        expect(html).toContain('value="openai"')
        // The hint is the dim half of a row, appended rather than replacing the label — the same
        // separation the terminal's picker keeps.
        expect(html).toContain("OpenAI — needs a key")
        expect(html).toContain(">Ollama<")
    })

    test("a conditional field is absent from the document, not merely hidden", () => {
        // Absent, because a field in the markup is a field that gets submitted, and an answer to a
        // question nobody was asked is what this route was corrected for.
        expect(form(initialAnswers(STEPS))).not.toContain("provision-telegramToken")
        expect(form({ ...initialAnswers(STEPS), telegram: "connected" })).toContain(
            "provision-telegramToken",
        )
    })

    test("an empty required field is flagged only after an attempt", () => {
        // A form that opens with a red field reads as broken. `touched` is set on submit.
        expect(form(initialAnswers(STEPS))).not.toContain("invalid")
        const tried = form(initialAnswers(STEPS), { touched: true })
        expect(tried).toContain("field invalid")
        expect(tried).toContain("needs an answer")
        // `'` arrives as `&#x27;` — this is serialised markup, not a DOM.
        expect(tried).toContain("The agent&#x27;s name — still needed.")
    })

    test("the fields are disabled while a create is in flight", () => {
        // A second submit would write a second agent, and the name is the collision.
        const html = form(initialAnswers(STEPS), { busy: true })
        expect(html).toContain("disabled")
        expect(html).toContain("creating…")
    })
})

describe("a server that will not provision says which reason", () => {
    test("no provisioner is a different sentence from a remote bind", () => {
        /**
         * `GET /v1/provision` reports `available` and `local` separately precisely so a page can
         * say which — a `501` and a `403` from the create would each only say "no", after somebody
         * had filled a form in.
         */
        const none = renderToStaticMarkup(
            createElement(Onboarding, {
                offer: offer({ available: false, steps: [] }),
                answers: {},
                busy: false,
                touched: false,
                onAnswer: () => {},
                onSubmit: () => {},
                onOpen: () => {},
            }),
        )
        expect(none).toContain("no provisioner")
        expect(none).toContain("dispach init")
        expect(none).not.toContain("provision-name")

        const remote = renderToStaticMarkup(
            createElement(Onboarding, {
                offer: offer({ local: false }),
                answers: initialAnswers(STEPS),
                busy: false,
                touched: false,
                onAnswer: () => {},
                onSubmit: () => {},
                onOpen: () => {},
            }),
        )
        expect(remote).toContain("loopback")
        // And it names the container, which is the deployment this is reached from most often.
        expect(remote).toContain("0.0.0.0")
        expect(remote).not.toContain("provision-name")
    })
})

describe("what it says after creating one", () => {
    const result = {
        id: "milo",
        dir: "/home/dispach/.dispach/agents/milo",
        files: ["agent.yaml", ".env"],
        adopted: ["milo"],
    }

    test("adopted reads as running, and offers the way in", () => {
        const html = renderToStaticMarkup(
            createElement(Created, { result, blank: [], onOpen: () => {} }),
        )
        expect(html).toContain("milo")
        expect(html).toContain("/home/dispach/.dispach/agents/milo")
        expect(html).toContain("2 files")
        expect(html).toContain("adopted")
        expect(html).toContain("open milo")
    })

    test("written-and-not-running is a different sentence, and offers no way in", () => {
        /**
         * The agent exists on disk either way, so this is not a failed creation — reporting one
         * while a complete agent sits in the sandbox would send somebody to create a second. But
         * an `open` here would land a chat on an agent whose every send answers 404, which is the
         * poll loop 11.224 removed.
         */
        const html = renderToStaticMarkup(
            createElement(Created, {
                result: {
                    ...result,
                    adopted: [],
                    error: {
                        code: "provision_adopt_failed",
                        message: "MODEL_API_KEY is not set",
                        hint: "Fix what the message names and `start` it.",
                    },
                },
                blank: [],
                onOpen: () => {},
            }),
        )
        expect(html).toContain("not running")
        expect(html).toContain("MODEL_API_KEY is not set")
        expect(html).toContain("start")
        expect(html).not.toContain("open milo")
    })

    test("a blank secret is named, with the file and why no route can fill it", () => {
        const html = renderToStaticMarkup(
            createElement(Created, {
                result,
                blank: [
                    step({ step: "telegramToken", prompt: "Telegram bot token", secret: true }),
                ],
                onOpen: () => {},
            }),
        )
        expect(html).toContain("Telegram bot token")
        expect(html).toContain("/home/dispach/.dispach/agents/milo/.env")
        // The reason, not just the instruction: `.env` is a protected path, so this is the only
        // place it can be said.
        expect(html).toContain("protected path")
    })
})
