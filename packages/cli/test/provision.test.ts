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
import { dirFor, SECRET_STEPS } from "#lib/init-flow"
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

describe("every preset writes an endpoint that works", () => {
    /**
     * Read out of the **generated manifest and `.env`**, never off the answers object.
     *
     * A preset is three strings and the transport has no provider branch, so the only things that
     * can be wrong are the strings — and each of them is threaded through `complete`, `planFiles`
     * and `writeAgentFiles` by a conditional spread, which is not excess-property-checked. This
     * repo has lost a field to that shape six times; the guard that works every time is one at the
     * far end that reads the value back out.
     */
    const cases = [
        { preset: "openai", baseUrl: "https://api.openai.com/v1", key: true },
        { preset: "anthropic", baseUrl: "https://api.anthropic.com/v1", key: true },
        { preset: "deepseek", baseUrl: "https://api.deepseek.com/v1", key: true },
        { preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", key: true },
        { preset: "groq", baseUrl: "https://api.groq.com/openai/v1", key: true },
        { preset: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", key: true },
        // The pair that made two rows necessary: local needs no key, hosted does.
        { preset: "ollama", baseUrl: "http://localhost:11434/v1", key: false },
        { preset: "ollama-cloud", baseUrl: "https://ollama.com/v1", key: true },
    ] as const

    for (const { preset, baseUrl, key } of cases) {
        test(preset, () => {
            const result = provisionAgent({
                answers: { user: "Ada", name: `p-${preset}`, preset },
                defaults: defaults(),
            })
            const manifest = readFileSync(join(result.dir, "agent.yaml"), "utf8")
            // Comments stripped before asserting: the generated file *explains* that the runtime appends
            // `/chat/completions`, so a naive search finds that sentence and not a defect.
            const active = manifest
                .split("\n")
                .filter((line) => !line.trimStart().startsWith("#"))
                .join("\n")

            expect(active).toContain(`baseUrl: ${baseUrl}`)
            // A base URL carrying the endpoint path is refused three times over — wizard, loader and the
            // generated comment — so a preset shipping one is a preset nobody could use.
            expect(active).not.toContain("/chat/completions")

            // **The keyless case is the point of the pair.** An absent `apiKeyEnv` is what makes the
            // provider send no `authorization` header; a present one is what gives a hosted endpoint a
            // route to a key at all. With one Ollama row, choosing it and editing the URL to the hosted
            // endpoint left a manifest with no way to supply one.
            expect(active.includes("apiKeyEnv:")).toBe(key)
        })
    }
})

describe("the server is on by default, and nobody is asked", () => {
    /**
     * "Serve the HTTP API?" defaulted to **No**, which is the defect. `fallback: "1"` is a 1-based
     * menu index and element 0 of `SERVER_CHOICES` is `none`, so `--yes`, `fillDefaults` and
     * `GET /v1/provision` all produced an agent with its API switched off — while the product *is*
     * an always-on server and the TUI and web UI are views onto it.
     *
     * Asserted on the **generated manifest and `.env`**, not on the answers object. That is this
     * repo's standing guard for exactly this shape: a value carried correctly by every layer and
     * dropped on the way out, six times over.
     */
    test("the funnel defaults it, and the manifest and .env both show it", () => {
        const base = defaults()
        const result = provisionAgent({ answers: { user: "Ada", name: "sentry" }, defaults: base })
        const manifest = readFileSync(join(result.dir, "agent.yaml"), "utf8")
        expect(manifest).toContain("enabled: true")
        // And the token it needs, which only the `local` branch mints.
        expect(readFileSync(join(result.dir, ".env"), "utf8")).toMatch(/API_TOKEN=.+/)
    })

    test("`--server none` is still the deliberate opt-out", () => {
        const result = provisionAgent({
            answers: { user: "Ada", name: "quiet", server: "none" },
            defaults: defaults(),
        })
        const manifest = readFileSync(join(result.dir, "agent.yaml"), "utf8")
        // The block is written either way — what changes is the switch, so the field somebody would
        // go looking for is there to be flipped.
        expect(manifest).toContain("server:")
        expect(manifest).toContain("enabled: false")
    })
})

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
        // **Not** `server`, since 0.1.2. The question was withdrawn — an always-on server is the
        // product, and "Serve the HTTP API?" defaulted to *No* — so the walk no longer produces the
        // step and a browser form no longer offers a control that should never have existed. The
        // default moved to `complete()`, which is what `the funnel defaults it` below asserts.
        expect(names).not.toContain("server")
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
        for (const name of ["system", "web", "telegram", "skills"]) {
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
        // `skills` rather than `server`, which is no longer served — and it has to be a step that
        // really is later in `STEP_ORDER`, or this asserts nothing.
        expect(names.indexOf("telegramToken")).toBeLessThan(names.indexOf("skills"))
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

        /**
         * **The slug, which is the id the manifest declares.** This line read `toBe("Milo")` — the
         * typed name — three lines above an assertion that the manifest says `id: milo`. The two
         * contradicted each other in one test, and the test passed, because nothing joined them up.
         *
         * What it cost: `POST /v1/agents` answered `{ id: "Milo", adopted: ["milo"] }`, so the
         * browser's `adopted.includes(id)` was false and it reported a running agent as "written,
         * and not running" with no error text — there had been no error. The directory landed at
         * `agents/Milo` while every route keys on `milo`, so `dispach validate milo` was refused
         * with "Known agents: Milo. Did you mean Milo?". 17.4's acceptance run missed all of it by
         * using the name `vela`, which is already a slug.
         */
        expect(result.agentId).toBe("milo")
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

    /**
     * **One identity per agent, read out of the generated file rather than from the return value.**
     *
     * The guard this repo has needed six times for this exact shape (`apiKeyEnv`,
     * `ChatMessage.toolCalls`, `TurnInput.skills`, `ToolContext.readArtifact`,
     * `ToolContext.memoryDir`, `init --schedules daily`): a test at the **far end** that reads the
     * value back out, not one at the layer that sets it.
     *
     * A name with a space and a capital is the case that broke — every surface agreed while the
     * name happened to be a slug already, so the divergence was invisible to a whole phase's
     * acceptance run.
     */
    test("a name that is not already a slug still has one identity everywhere", () => {
        const base = defaults()
        const result = provisionAgent({
            answers: { user: "Ada", name: "My Bot" },
            defaults: base,
        })

        // The manifest is the authority: whatever it declares is what `Runtime.adopt` returns and
        // what every route addresses.
        const manifest = readFileSync(result.manifestPath, "utf8")
        expect(manifest).toContain("id: my-bot")
        expect(manifest).toContain("name: My Bot")

        // And all three agree with it. `agentId` is what the HTTP route reports as `id` and
        // compares against `adopted`; the directory is what `resolveAgentRef` looks the agent up by.
        expect(result.agentId).toBe("my-bot")
        expect(result.dir).toBe(join(base.agentDirBase, "my-bot"))
        expect(result.dir.endsWith("My Bot")).toBe(false)
    })

    test("the terminal and the wire derive the same directory from one name", () => {
        // Two front doors, one question. `provisionAgent` recomputed the path from the raw name
        // while the wizard derived it through `dirFor`, so the same answers produced
        // `agents/My Bot` over HTTP and `agents/my-bot` at a terminal. `dirFor` is now the single
        // derivation, which is the rule this module's own header is a monument to.
        const base = defaults()
        const result = provisionAgent({
            answers: { user: "Ada", name: "Milo The Cat" },
            defaults: base,
        })
        // Named and asserted defined before the comparison: `dirFor` answers `undefined` when it
        // cannot resolve a base, and `expect(aString).toBe(undefined)` would fail for the wrong
        // reason — reporting a slug bug where the fixture is what is wrong. It is also what makes
        // this typecheck, which `bun run typecheck` had been red on since this test landed.
        const expected = dirFor("sandbox", "Milo The Cat", base)
        expect(expected).toBeDefined()
        expect(result.dir).toBe(expected as string)
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
