/**
 * The real provisioner: the walk a browser renders, and the writer both front doors share.
 *
 * ## The property that matters
 *
 * An agent created over HTTP must be **byte-identical** to one created at a terminal. There is one
 * way to promise that — one writer — and these tests are what keep it true: the step list is walked
 * from `nextQuestion` rather than written down, and `provisionAgent` reaches `planFiles` through the
 * same `validateAnswer` → `fillDefaults` → `complete` sequence `init --yes` does.
 *
 * The other half is what the API is *not* allowed to decide. `dir` is refused rather than honoured,
 * because a route that wrote wherever it was pointed is a very short step from one that overwrites
 * something — and the loopback gate is not a reason to hand over the filesystem too.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessError } from "@dispach/core"
import { SECRET_STEPS } from "#lib/init-flow"
import { provisionAgent, provisionSteps, toProvisionStep } from "#lib/provision"

const dirs: string[] = []
afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

function sandbox(): string {
    const dir = mkdtempSync(join(tmpdir(), "provision-test-"))
    dirs.push(dir)
    return dir
}

function defaults(): { agentDirBase: string } {
    return { agentDirBase: sandbox() }
}

describe("the step list a client renders", () => {
    const steps = provisionSteps(defaults())

    test("it is the wizard's own walk, in asking order", () => {
        const names = steps.map((step) => step.step)
        // Walked from `nextQuestion`, not written down. A hand-kept list here would be the "two
        // lists" shape this repo has paid for repeatedly — right when written, wrong at the next
        // addition, with nothing reporting the gap.
        expect(names[0]).toBe("user")
        expect(names).toContain("name")
        expect(names).toContain("preset")
        expect(names).toContain("server")
        // **The directory questions are absent**, because the route refuses them: offering a
        // field that cannot be submitted is worse than not asking. The terminal still asks them.
        expect(names).not.toContain("dirChoice")
        expect(names).not.toContain("dir")
    })

    test("every secret is flagged, and the flag comes from one place", () => {
        for (const step of steps) {
            expect(step.secret).toBe(SECRET_STEPS.has(step.step))
        }
        // And at least one really is, or the assertion above passes by having nothing to check.
        expect(steps.filter((step) => step.secret).length).toBeGreaterThan(0)
    })

    test("a choice question carries its options", () => {
        const preset = steps.find((step) => step.step === "preset")
        expect(preset?.choices?.length).toBeGreaterThan(2)
        expect(preset?.choices?.map((choice) => choice.value)).toContain("openai")
        // Every choice question is forwarded, not just the first — `preset` was the only select for
        // three phases and "is this the preset step" ended up written into three places.
        for (const name of ["system", "web", "server", "skills"]) {
            expect(steps.find((step) => step.step === name)?.choices?.length).toBeGreaterThan(1)
        }
    })

    test("a hint is forwarded separately from its label", () => {
        /**
         * Asserted through the mapper rather than the walk, and that is the point: only the
         * location question carries a hint today and it is filtered out of the served list, so a
         * test over the real walk would pass by having no data to check — the "empty result reads
         * like a pass" shape this repo keeps catching.
         */
        const mapped = toProvisionStep({
            step: "preset",
            prompt: "which endpoint?",
            fallback: "openai",
            options: [{ value: "openai", label: "OpenAI", hint: "needs a key" }],
        })
        expect(mapped.choices).toEqual([{ value: "openai", label: "OpenAI", hint: "needs a key" }])
        // A question with no hint carries none, rather than an empty string a client would render.
        const bare = toProvisionStep({
            step: "preset",
            prompt: "p",
            fallback: "",
            options: [{ value: "a", label: "A" }],
        })
        expect(bare.choices).toEqual([{ value: "a", label: "A" }])
        // And the secret flag comes from `SECRET_STEPS`, not from the question.
        expect(toProvisionStep({ step: "apiKey", prompt: "p", fallback: "" }).secret).toBe(true)
    })

    test("a required question is distinguishable from an optional one", () => {
        // They look identical from a fallback alone — an empty default and "no answer needed" mean
        // opposite things to a non-interactive caller.
        const name = steps.find((step) => step.step === "name")
        expect(name?.fallback).toBe("")
        expect(name?.optional).toBe(false)
        expect(steps.find((step) => step.step === "apiKey")?.optional).toBe(true)
    })
})

describe("the branches a single walk cannot reach", () => {
    const steps = provisionSteps(defaults())
    const named = (name: string) => steps.find((step) => step.step === name)

    test("a conditional step is served, and declares what opens it", () => {
        /**
         * Following the default path alone lists thirteen steps and **omits every credential but
         * the model key** — `nextQuestion` skips a question whose opening answer was not given, so
         * `telegramToken` is never reached from `telegram: none`. A browser built on that could ask
         * for a Telegram agent and not for its token, and would write an agent whose `.env` has to
         * be filled at a terminal before it can start.
         */
        expect(named("telegramToken")?.requires).toEqual({
            step: "telegram",
            value: "connected",
        })
        expect(named("telegramAllow")?.requires).toEqual({
            step: "telegram",
            value: "connected",
        })
        expect(named("composioKey")?.requires).toEqual({
            step: "composio",
            value: "connected",
        })
        // `webBackend` and `webKey` are both opened by the same answer, and neither by the other:
        // a chain that attributed the key to the backend would hide it behind a second choice.
        expect(named("webBackend")?.requires).toEqual({ step: "web", value: "search" })
        expect(named("webKey")?.requires).toEqual({ step: "web", value: "search" })
    })

    test("a step on the default path declares no requirement", () => {
        // Or a client would hide the whole form waiting for a condition nothing can satisfy.
        for (const name of ["user", "name", "preset", "model", "apiKey", "system", "skills"]) {
            expect(named(name)?.requires).toBeUndefined()
        }
    })

    test("every secret the wizard can ask for is reachable", () => {
        /**
         * The real assertion of the stage. Three of the four secrets are conditional, so the
         * single-path walk served exactly one of them — and the one thing that stops a provisioned
         * agent working is an empty credential.
         */
        const reachable = new Set(steps.map((step) => step.step))
        for (const secret of SECRET_STEPS) {
            expect(reachable.has(secret)).toBe(true)
        }
        expect(steps.filter((step) => step.secret).length).toBe(SECRET_STEPS.size)
    })

    test("asking order survives being discovered out of order", () => {
        // A branch's finds are discovered after the default path has run past them, and "in asking
        // order" is what the wire promises. Restored from `STEP_ORDER`, which is the authority.
        const names = steps.map((step) => step.step)
        expect(names.indexOf("telegramToken")).toBeGreaterThan(names.indexOf("telegram"))
        expect(names.indexOf("telegramToken")).toBeLessThan(names.indexOf("server"))
        expect(names.indexOf("webBackend")).toBeGreaterThan(names.indexOf("web"))
        expect(names.indexOf("webKey")).toBeLessThan(names.indexOf("composio"))
    })

    test("the default a client is given is a value it may send back", () => {
        /**
         * **Found by building the form.** A `Question` for a menu carries `"1"` — a 1-based index
         * that `validateAnswer` accepts from a terminal and that matches no `choices[].value` at
         * all, so a `<select>` built from the served choices had no selectable default.
         *
         * The deeper half: the walk fed that index back to *itself*, `presetById("1")` answered
         * `undefined`, and `model` and `baseUrl` were therefore served with **empty** defaults
         * where the terminal offers a real model id and endpoint.
         */
        for (const step of steps) {
            if (step.choices === undefined) continue
            expect(step.choices.map((choice) => choice.value)).toContain(step.fallback)
        }
        expect(named("model")?.fallback).not.toBe("")
        expect(named("baseUrl")?.fallback).toMatch(/^https:\/\//)
    })

    test("what the API cannot do is not offered", () => {
        const names = steps.map((step) => step.step)
        // `daemon` was in `FLAG_FOR`, so it validated and landed in `answers` — and only `init.ts`
        // ever reads it, so the route answered 201 and installed nothing.
        expect(names).not.toContain("daemon")
        expect(names).not.toContain("dir")
        expect(names).not.toContain("dirChoice")
        // `skills: find` is a screen, not an answer: over the wire it wrote `skills/.keep`,
        // byte-identical to `none`, while its own label promises a catalogue search.
        expect(named("skills")?.choices?.map((choice) => choice.value)).toEqual(["starter", "none"])
    })
})

describe("creating an agent from a partial answer set", () => {
    test("defaults fill the rest, and the files land in the sandbox", () => {
        const base = defaults()
        const result = provisionAgent({ answers: { user: "Ada", name: "Milo" }, defaults: base })

        expect(result.agentId).toBe("Milo")
        expect(result.manifestPath).toBe(join(result.dir, "agent.yaml"))
        /**
         * **Inside the base this call was handed**, which is the assertion that was missing.
         *
         * The first version of `provisionAgent` called `agentsDir()` directly and wrote three
         * agents into the author's real `~/.dispach`. These tests did not fail — the *second* run
         * did, on a collision, which is a day later and in a different file. `lib/sandbox.ts`'s own
         * rule is that sandbox paths come from there and nowhere else so a test can redirect them;
         * a caller that computes one itself has bypassed exactly that.
         */
        expect(result.dir.startsWith(base.agentDirBase)).toBe(true)
        expect(existsSync(result.manifestPath)).toBe(true)
        // The real loader's own check is `validate`'s job; what matters here is that a one-answer
        // request produced a complete agent, exactly as `init --yes --name Milo` does.
        expect(result.files).toContain("agent.yaml")
        expect(result.files).toContain("workspace/SOUL.md")
        expect(readFileSync(result.manifestPath, "utf8")).toContain("id: milo")
    })

    test("the .env is 0600 and nothing reads it back", () => {
        const result = provisionAgent({
            answers: { user: "Ada", name: "keeper" },
            defaults: defaults(),
        })
        const envPath = join(result.dir, ".env")
        expect(existsSync(envPath)).toBe(true)
        // Under a service manager this file is the *only* path credentials arrive by — a unit
        // carries none on purpose, because its manager echoes the environment in plaintext.
        expect(statSync(envPath).mode & 0o777).toBe(0o600)
        // The result names the file and never its contents. A route that returned a secret it had
        // just written would make the 0600 pointless.
        expect(JSON.stringify(result)).not.toContain("MODEL_API_KEY=")
    })

    test("an existing agent is refused rather than overwritten", () => {
        const base = defaults()
        provisionAgent({ answers: { user: "Ada", name: "twice" }, defaults: base })
        // Replacing a personalised workspace is exactly the loss this refusal exists to prevent,
        // and there is no --force anywhere near it.
        expect(() =>
            provisionAgent({ answers: { user: "Ada", name: "twice" }, defaults: base }),
        ).toThrow(/already exist/)
    })
})

describe("what an API caller may not decide", () => {
    test("the directory is refused, not ignored", () => {
        for (const key of ["dir", "dirChoice"]) {
            let error: unknown
            try {
                provisionAgent({
                    answers: { user: "Ada", name: "elsewhere", [key]: "/tmp/anywhere" },
                    defaults: defaults(),
                })
            } catch (caught) {
                error = caught
            }
            // Refused rather than silently ignored: writing somewhere other than where a request
            // asked is the class of surprise this repo writes decisions about, and honouring it
            // would write wherever it was pointed.
            expect((error as HarnessError).code).toBe("provision_directory_refused")
        }
    })

    test("a step nothing acts on is refused rather than reported as done", () => {
        /**
         * `daemon` validated, landed in `answers`, and was read by **nobody** —
         * `POST /v1/agents {"answers":{"daemon":"service"}}` answered `201` and installed no
         * service. Hard rule 8's shape from inside a route: a caller that asked for a background
         * process was told it had one.
         *
         * It is also the question a running host has already answered. The response's `adopted`
         * field *is* "yes, it is running in the background".
         */
        let error: unknown
        try {
            provisionAgent({
                answers: { user: "Ada", name: "svc", telegram: "connected", daemon: "service" },
                defaults: defaults(),
            })
        } catch (caught) {
            error = caught
        }
        expect((error as HarnessError).code).toBe("provision_daemon_refused")
        expect((error as HarnessError).field).toBe("daemon")
        expect((error as HarnessError).hint).toContain("adopted")
    })

    test("a choice only a terminal can honour is refused, and says which", () => {
        /**
         * `skills: find` mounts a catalogue picker and writes the chosen refs into `skillsPick`.
         * Over the wire it produced `skills/.keep` — indistinguishable from `none` — and reported
         * success, while the choice's own label promises a search of 440+ skills.
         *
         * Refused **before** `validateAnswer`, which accepts it: it is a real answer to a real
         * question, and reporting it as an invalid value would be a lie about why.
         */
        let error: unknown
        try {
            provisionAgent({
                answers: { user: "Ada", name: "finder", skills: "find" },
                defaults: defaults(),
            })
        } catch (caught) {
            error = caught
        }
        expect((error as HarnessError).code).toBe("provision_skills_search_refused")
        expect((error as HarnessError).field).toBe("skills")
        // And the two answers it *can* honour still work, or the refusal above is a regression
        // rather than a fix.
        for (const skills of ["starter", "none"]) {
            expect(
                provisionAgent({
                    answers: { user: "Ada", name: `ok-${skills}`, skills },
                    defaults: defaults(),
                }).agentId,
            ).toBe(`ok-${skills}`)
        }
    })

    test("a step that does not exist is named", () => {
        let error: unknown
        try {
            provisionAgent({
                answers: { user: "Ada", name: "x", favourite: "blue" },
                defaults: defaults(),
            })
        } catch (caught) {
            error = caught
        }
        expect((error as HarnessError).code).toBe("provision_unknown_answer")
        expect((error as HarnessError).field).toBe("favourite")
    })

    test("a bad answer carries the step and the reason", () => {
        let error: unknown
        try {
            provisionAgent({
                answers: { user: "Ada", name: "x", preset: "nonesuch" },
                defaults: defaults(),
            })
        } catch (caught) {
            error = caught
        }
        expect((error as HarnessError).code).toBe("provision_answer_invalid")
        expect((error as HarnessError).message).toContain("nonesuch")
    })

    test("an answer with no default and no value is refused by name", () => {
        let error: unknown
        try {
            // Two questions have no fallback: who you are and what the agent is called. Neither
            // is something to guess, which is the same sentence `init --yes` gives — and the
            // refusal names both at once rather than one per round trip.
            provisionAgent({ answers: {}, defaults: defaults() })
        } catch (caught) {
            error = caught
        }
        expect((error as HarnessError).message).toContain("user")
        expect((error as HarnessError).message).toContain("name")
    })
})
