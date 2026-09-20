/**
 * Writing an agent to disk — the one path, shared by `init` and by `POST /v1/agents`.
 *
 * ## Why this module exists at all
 *
 * Provisioning has two front doors now: a wizard at a terminal and an HTTP route a browser or a
 * platform calls. They must produce **byte-identical** agents, and the only way to promise that is
 * for there to be one writer. Two would be the shape this repo keeps paying for — right when
 * written, divergent at the next change, with the symptom being an agent that works when created
 * one way and not the other.
 *
 * `complete` and `fillDefaults` moved here from `init.ts` for that reason: they *are* the funnel
 * both paths pass through, and `complete`'s own comments are a monument to what happens when a
 * default lives anywhere else (`apiKeyEnv` was dropped from generated manifests entirely when its
 * question was removed, and `--schedules daily` was accepted and lost in two separate literals).
 *
 * ## What the HTTP path is allowed to decide, and what it is not
 *
 * **Not the directory.** `dir` and `dirChoice` are refused over the wire and the agent always lands
 * in the sandbox. Where an agent lives on disk is the operator's decision, not a caller's — and a
 * route that honoured a path would write wherever it was pointed, which is a very short step from
 * a request that overwrites something. The route is loopback-gated in this phase, and that gate is
 * not a reason to also hand over the filesystem.
 *
 * **Not which variables hold secrets.** A secret answer is written into the `.env` at `0600` once
 * and no route ever reads it back. `SECRET_STEPS` is what a client masks; nothing here echoes one.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { HarnessError } from "@dispach/core"
import {
    dirFor,
    type GeneratedFile,
    type InitAnswers,
    type InitStep,
    nextQuestion,
    type PartialAnswers,
    planFiles,
    presetById,
    type Question,
    type QuestionDefaults,
    SECRET_STEPS,
    STEP_ORDER,
    validateAnswer,
} from "#lib/init-flow"

export const FLAG_FOR: Record<InitStep, string> = {
    user: "--user",
    name: "--name",
    purpose: "--purpose",
    preset: "--preset",
    model: "--model",
    baseUrl: "--base-url",
    apiKeyEnv: "--api-key-env",
    // No flag, on purpose: a key on the command line lands in shell history. With --yes the .env
    // is written with an empty value and the next steps say where to put it.
    apiKey: "(asked at the prompt only)",
    system: "--system",
    web: "--web",
    webBackend: "--web-backend",
    // No flag, same reason as the model key.
    webKey: "(asked at the prompt only)",
    composio: "--composio",
    composioKey: "(asked at the prompt only)",
    telegram: "--telegram",
    telegramAllow: "--telegram-allow",
    // No flag, same reason as every other secret: a token on a command line lands in history.
    telegramToken: "(asked at the prompt only)",
    schedules: "--schedules",
    server: "--server",
    skills: "--skills",
    skillsSearch: "--skills",
    skillsPick: "--skills",
    daemon: "--daemon",
    // Never asked and never a flag — generated, because it is ours rather than a third party's.
    serverToken: "(generated)",
    dirChoice: "--dir",
    dir: "--dir",
}

/**
 * Non-interactive: every unanswered question takes its default, and a question with no default is
 * a refusal, not a guess. All gaps report at once — with `--preset custom` that is the endpoint
 * flags too, not just the names — and the refusal says *why* the questions could not be asked,
 * which is the mode decision's `because` string doing its first useful work.
 */
export function fillDefaults(
    partial: Partial<Record<InitStep, string>>,
    because: string,
    defaults: QuestionDefaults,
): void {
    const missing: InitStep[] = []
    for (;;) {
        const question = nextQuestion(partial, defaults)
        if (question === undefined) break
        if (question.optional === true) {
            // An empty answer is the answer. Refusing here would make `--yes` demand a secret it
            // deliberately offers no flag for.
            partial[question.step] = ""
            continue
        }
        if (question.fallback === "") {
            missing.push(question.step)
            // Placeholder purely to advance the walk; discarded by the throw below.
            partial[question.step] = "(missing)"
            continue
        }
        const checked = validateAnswer(question.step, question.fallback)
        if (checked.ok) partial[question.step] = checked.value
    }
    if (missing.length > 0) {
        const flags = missing.map((step) => FLAG_FOR[step]).join(", ")
        throw new HarnessError({
            code: "cli_init_missing_answers",
            message: `Not interactive (${because}), and ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no default.`,
            hint: `Pass ${flags} — an agent's name is not something to guess — or run the command at a terminal to be asked. Everything with a sensible default (purpose, preset, endpoint, directory) already took it.`,
        })
    }
}

export function complete(
    partial: Partial<Record<InitStep, string>>,
    defaults: QuestionDefaults,
): InitAnswers {
    // `apiKeyEnv` and `apiKey` legitimately stay undefined — the first for a keyless endpoint, the
    // second for anyone exporting the variable another way. Everything else is present once
    // nextQuestion returns undefined.
    const answers = partial as Record<
        Exclude<
            InitStep,
            | "apiKeyEnv"
            | "apiKey"
            | "webBackend"
            | "webKey"
            | "composioKey"
            | "skillsSearch"
            | "skillsPick"
            | "schedules"
            | "dir"
            | "dirChoice"
        >,
        string
    > & {
        /**
         * Undefined unless `--schedules` was passed: this capability has no wizard step at all.
         * Defaulted below, at the funnel, for the reason `apiKeyEnv` is.
         */
        schedules?: string
        /** Undefined unless the skills answer was `find`; its question is skipped otherwise. */
        skillsSearch?: string
        /** Undefined unless the wizard's catalogue step ran and something was ticked. */
        skillsPick?: string
        apiKeyEnv?: string
        apiKey?: string
        // Both stay undefined unless the web answer was `search` — the flow skips their questions,
        // so `nextQuestion` returning undefined does not mean they were answered.
        webBackend?: string
        webKey?: string
        /** Undefined unless the Composio answer was `connected`, for the same reason. */
        composioKey?: string
        /** Both stay undefined unless the Telegram answer was `connected`. */
        telegramToken?: string
        telegramAllow?: string
        /** Undefined unless `dirChoice` was `custom`; derived below otherwise. */
        dir?: string
        /** Undefined when `--dir` answered the question, which is what skips it. */
        dirChoice?: string
    }
    // Which variable holds the key is no longer asked — it comes from `--api-key-env`, or from the
    // preset. Defaulted HERE, at the one funnel both the wizard and the scripted path pass through:
    // when this lived in the question list, removing the question silently dropped `apiKeyEnv` from
    // the manifest altogether and generated an agent with no key configuration at all.
    const preset = presetById(answers.preset)
    const keyVar = answers.apiKeyEnv ?? preset?.apiKeyEnv

    // `dir` stops being asked the moment the answer is `sandbox` or `here`, so its value has to be
    // derived at this funnel — the same rule `apiKeyEnv` above is a monument to. `dirFor` is the one
    // derivation, shared with the confirm screen, so the summary cannot describe a directory other
    // than the one written. An explicit answer still wins: `--dir` sets both fields.
    const dir = answers.dir ?? dirFor(answers.dirChoice, answers.name, defaults)
    if (dir === undefined) {
        throw new HarnessError({
            code: "cli_init_no_directory",
            message: `The directory answer was ${JSON.stringify(answers.dirChoice)}, which resolves to no path.`,
            hint: "This is a bug in the CLI: every dirChoice except `custom` must derive a path in `dirFor`, and `custom` must have asked the dir question. Pass --dir <path> to get past it.",
        })
    }

    return {
        user: answers.user,
        name: answers.name,
        purpose: answers.purpose,
        preset: answers.preset as InitAnswers["preset"],
        model: answers.model,
        baseUrl: answers.baseUrl,
        system: answers.system,
        web: answers.web,
        ...(answers.webBackend === undefined ? {} : { webBackend: answers.webBackend }),
        ...(answers.webKey === undefined || answers.webKey === ""
            ? {}
            : { webKey: answers.webKey }),
        composio: answers.composio,
        ...(answers.composioKey === undefined || answers.composioKey === ""
            ? {}
            : { composioKey: answers.composioKey }),
        telegram: answers.telegram,
        ...(answers.telegramToken === undefined || answers.telegramToken === ""
            ? {}
            : { telegramToken: answers.telegramToken }),
        ...(answers.telegramAllow === undefined || answers.telegramAllow === ""
            ? {}
            : { telegramAllow: answers.telegramAllow }),
        // `none` writes the commented block with its worked example — see SCHEDULE_CHOICES. Defaulted
        // here rather than as a step fallback because there is no step: this funnel is the one place
        // both the wizard and `--schedules daily` pass through, which is the lesson `apiKeyEnv` above
        // records from the last time a question was removed and its field silently went missing.
        schedules: answers.schedules ?? "none",
        server: answers.server,
        skills: answers.skills,
        // Carried explicitly. This funnel is a literal, not a spread, so a step that is collected and not
        // listed here is silently dropped — which is what happened: `--skills "pdf tables"` set the answer
        // to `find` and lost the words, and init reported "no words to search for" about a phrase the
        // person had just typed. The same shape as `apiKeyEnv` above, and the reason that comment exists.
        ...(answers.skillsSearch === undefined || answers.skillsSearch === ""
            ? {}
            : { skillsSearch: answers.skillsSearch }),
        ...(answers.skillsPick === undefined || answers.skillsPick === ""
            ? {}
            : { skillsPick: answers.skillsPick }),
        daemon: answers.daemon,
        // Minted here rather than in the flow, which is a PURE module and must stay deterministic.
        // Only for an agent that asked for a server: an unused 64-hex string in every generated
        // .env is a secret nobody chose and one more thing to wonder about.
        ...(answers.server === "local" ? { serverToken: randomToken() } : {}),
        ...(keyVar === undefined ? {} : { apiKeyEnv: keyVar }),
        ...(answers.apiKey === undefined || answers.apiKey === ""
            ? {}
            : { apiKey: answers.apiKey }),
        ...(answers.dirChoice === undefined ? {} : { dirChoice: answers.dirChoice }),
        dir,
    }
}

/**
 * The server token a generated manifest names, when the server answer asked for one.
 *
 * Moved here verbatim with `complete`, its only caller. 256 bits of `crypto.getRandomValues`, hex.
 */
function randomToken(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

// ─── the shared writer ──────────────────────────────────────────────────────────────────

/**
 * Write a planned agent, refusing rather than overwriting.
 *
 * Per-target checks rather than "directory not empty": a fresh `git init`'d directory must work,
 * and the refusal names every collision at once rather than one per run.
 *
 * `.env` alone gets `0600`. It holds every credential this agent has — the model key, a bot token,
 * a Composio key — and the default `0644` made all of them readable by anything running on the
 * machine. That matters more under a service manager, which hands a job almost no environment and
 * whose unit carries no secrets by design, so this file is the *only* path credentials arrive by.
 */
export function writeAgentFiles(targetDir: string, files: readonly GeneratedFile[]): void {
    const collisions = files
        .map((file) => join(targetDir, file.relPath))
        .filter((path) => existsSync(path))
    if (collisions.length > 0) {
        throw new HarnessError({
            code: "cli_init_target_exists",
            message: `${collisions.length} of the files init would write already exist: ${collisions.join(", ")}`,
            hint: "Nothing is overwritten and there is no --force — replacing a personalised workspace is exactly the loss this command exists to prevent. Point init at a fresh directory, or delete the files first if they really are disposable.",
        })
    }

    for (const file of files) {
        const path = join(targetDir, file.relPath)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.contents, {
            encoding: "utf8",
            ...(file.relPath === ".env" ? { mode: 0o600 } : {}),
        })
    }
}

// ─── the HTTP-facing half ───────────────────────────────────────────────────────────────

/**
 * What opens a step that is not always asked.
 *
 * `telegramToken` is a question only for somebody who said `telegram: connected`, and
 * `nextQuestion` expresses that as a `continue` a client cannot see. This is the same fact,
 * declared — so a browser can render the whole question set and reveal a field when the choice
 * that opens it is made, without re-implementing the walk. A hard-coded condition in the page
 * would be the two-hand-kept-lists shape that `GET /v1/provision` exists to prevent.
 *
 * **Evaluate it transitively.** A step is askable when its requirement is met *and* the step named
 * in that requirement is itself askable. `webKey` requires `web: search`; `web` requires nothing,
 * so the recursion terminates at the default path. Only the nearest opening choice is recorded,
 * because attributing a step to every ancestor would be a second encoding of `STEP_ORDER`'s shape.
 */
export interface StepRequirement {
    readonly step: InitStep
    /** The canonical answer — the choice's `value`, never a menu index. See `canonical`. */
    readonly value: string
}

/** One question, as a client that is not a terminal needs to see it. */
export interface ProvisionStep {
    readonly step: InitStep
    readonly prompt: string
    /**
     * The offered default, as a value a client can use. Empty means the answer is required unless
     * `optional`.
     *
     * **Canonical, never the wizard's own `fallback`.** A `Question` for a menu carries `"1"` —
     * a 1-based index, which `validateAnswer` accepts from a terminal and which matches no
     * `choices[].value` at all. Served raw it gave a `<select>` no selectable default; worse, the
     * walk fed it back to itself, `presetById("1")` answered `undefined`, and `model` and `baseUrl`
     * were therefore served with **empty** defaults where the terminal offers a real model id.
     */
    readonly fallback: string
    /** An empty answer is a real answer. See `Question.optional`. */
    readonly optional: boolean
    /** Mask it, never echo it, never log it. Derived from `SECRET_STEPS`, not restated. */
    readonly secret: boolean
    /** Absent means always asked. See `StepRequirement`. */
    readonly requires?: StepRequirement
    readonly choices?: readonly {
        readonly value: string
        readonly label: string
        /** The dim half of a row — a reason, not a second label. See `Question.options`. */
        readonly hint?: string
    }[]
}

/**
 * Steps no API caller may answer, with the reason each is refused.
 *
 * One map, read by two things that must agree: `provisionSteps` leaves these out of the served
 * list, and `provisionAgent` throws when one arrives anyway. Held together because a question
 * offered by one and refused by the other puts a field in front of somebody that cannot be
 * submitted — and the reverse, a step quietly *accepted* and acted on by nobody, is worse.
 *
 * `daemon` is the one found by building the browser form. It was in `FLAG_FOR`, so it validated
 * and landed in `answers`, and **only `init.ts` ever reads it** — so
 * `POST /v1/agents {"answers":{"daemon":"service"}}` answered `201` and installed no service. It is
 * also the question a running host has already answered: the response's `adopted` field *is* "yes,
 * it is running in the background". It stayed invisible because the walk skips it unless a channel
 * or the server is on, which the default path never is.
 */
const REFUSED_STEPS: ReadonlyMap<InitStep, { readonly code: string; readonly hint: string }> =
    new Map([
        [
            "dir",
            {
                code: "provision_directory_refused",
                hint: "A provisioned agent lands in this host's sandbox, because where an agent lives on disk is the operator's decision rather than a caller's. Use `init --dir` at a terminal to put one somewhere else.",
            },
        ],
        [
            "dirChoice",
            {
                code: "provision_directory_refused",
                hint: "A provisioned agent lands in this host's sandbox, because where an agent lives on disk is the operator's decision rather than a caller's. Use `init --dir` at a terminal to put one somewhere else.",
            },
        ],
        [
            "daemon",
            {
                code: "provision_daemon_refused",
                hint: "This server is already hosting the agent you are creating — that is what `adopted` in the response means. Installing a service unit is `daemon install` at a terminal, and a route that writes one would be a web page installing a background process.",
            },
        ],
    ])

/**
 * Choices a step offers at a terminal and the API cannot honour, with the reason.
 *
 * `skills: find` is a **screen**, not an answer: the terminal mounts a catalogue picker and writes
 * the chosen refs into `skillsPick`. Over the wire it was accepted and produced `skills/.keep` —
 * byte-identical to `none`, while the choice's own label promises a catalogue search. Filtered out
 * of the served choices *and* refused, for the same reason `REFUSED_STEPS` is one map.
 */
const REFUSED_CHOICES: ReadonlyMap<
    InitStep,
    ReadonlyMap<string, { readonly code: string; readonly hint: string }>
> = new Map([
    [
        "skills",
        new Map([
            [
                "find",
                {
                    code: "provision_skills_search_refused",
                    hint: "Searching the catalogues is an interactive picker, not an answer — over the wire it would write no skills and report success. Send `starter` or `none`, then `skills search` and `skills install` once the agent exists.",
                },
            ],
        ]),
    ],
])

/**
 * The answer a client should send for a question's default.
 *
 * `validateAnswer` rather than a lookup, because it is the same function the route validates the
 * answer with — so the served default cannot be a value the route would reject. A fallback that
 * does not validate (the empty one on a required text question) passes through unchanged: empty is
 * what "you must answer this" looks like on the wire, and `optional` says which it is.
 */
function canonical(question: Question): string {
    const checked = validateAnswer(question.step, question.fallback)
    return checked.ok ? checked.value : question.fallback
}

/**
 * One question, for a client that is not a terminal.
 *
 * Exported so the forwarding can be tested against a question carrying a `hint` — only the location
 * question has one today, and that one is filtered out of the served list, so a test over the real
 * walk would assert this by having no data. `secret` is read from `SECRET_STEPS` rather than
 * restated, which is the half that must not drift: a second list of which answers are credentials
 * is the one worth getting wrong.
 */
export function toProvisionStep(question: Question, opened?: StepRequirement): ProvisionStep {
    const refused = REFUSED_CHOICES.get(question.step)
    return {
        step: question.step,
        prompt: question.prompt,
        fallback: canonical(question),
        optional: question.optional === true,
        secret: SECRET_STEPS.has(question.step),
        ...(opened === undefined ? {} : { requires: opened }),
        ...(question.options === undefined
            ? {}
            : {
                  choices: question.options
                      .filter((option) => refused?.has(option.value) !== true)
                      .map((option) => ({
                          value: option.value,
                          label: option.label,
                          // `hint` kept separate from `label`: it is the dim half of a row, a reason
                          // rather than a second label. Folding the two together is what produced a
                          // 79-column row that wrapped at 80 into a line with no pointer and no number.
                          ...(option.hint === undefined ? {} : { hint: option.hint }),
                      })),
              }),
    }
}

/** How far a single walk may go before something is wrong. `STEP_ORDER` is 21 long. */
const WALK_GUARD = 64

/**
 * Every question the wizard can ask, in asking order, with its choices and what opens it.
 *
 * **Walked from `nextQuestion` rather than written down**, which is the whole reason this is safe to
 * serve: the terminal's order, prompts, defaults and choice lists come from the same walk, so a
 * browser cannot render a stale form. A hand-kept list here would be the "two lists" shape that has
 * already cost this repo several rounds — `NO_MANIFEST`, `DOCUMENTED_CTRL_LETTERS`,
 * `THRESHOLD_ORDER`, each right when written and wrong at the next addition.
 *
 * ## Why one walk is not enough
 *
 * `nextQuestion` skips a question whose opening answer was not given, so following the **default**
 * path lists thirteen of the eighteen askable steps and omits every credential but the model key:
 * `telegramToken`, `telegramAllow`, `webBackend`, `webKey`, `composioKey`. A browser built on that
 * could ask for a Telegram agent and not for its token, and would write an agent whose `.env` has
 * to be filled at a terminal before it can start — which is the opposite of what provisioning from
 * a browser is for.
 *
 * So the default path is walked first and its finds carry no `requires`; then every choice it
 * offered is walked as a **branch**, and a step seen for the first time there is attributed to the
 * branch that opened it. Breadth-first, so a step reachable two ways is attributed to the
 * shallowest — and each `step=value` pair is walked at most once, which is what bounds this to
 * roughly twenty short walks rather than a combinatorial explosion.
 *
 * The seed carries the **whole path** taken to reach a branch, not just its own answer: seeded with
 * `webBackend` alone, `nextQuestion` skips it, because it is a question only for somebody who
 * already said `web: search`.
 *
 * Ordering is restored from `STEP_ORDER` at the end, because a branch's finds are discovered after
 * the default path has run past them and "in asking order" is what the wire promises.
 *
 * `REFUSED_STEPS` is omitted rather than offered: a question the route rejects is a field that
 * cannot be submitted, which is worse than not asking.
 */
export function provisionSteps(defaults: QuestionDefaults): readonly ProvisionStep[] {
    const found = new Map<InitStep, ProvisionStep>()
    const walked = new Set<string>()

    /** Follow one path to its end; return every branch it declined to take. */
    const walk = (
        seed: PartialAnswers,
        opened?: StepRequirement,
    ): readonly { readonly seed: PartialAnswers; readonly opened: StepRequirement }[] => {
        const answers: PartialAnswers = { ...seed }
        const branches: { readonly seed: PartialAnswers; readonly opened: StepRequirement }[] = []
        // Bounded: `nextQuestion` is a pure walk over a fixed order, so it terminates — but a bug
        // there would hang a request rather than fail one, and a request that never answers is the
        // worst failure an HTTP surface has.
        for (let guard = 0; guard < WALK_GUARD; guard += 1) {
            const question: Question | undefined = nextQuestion(answers, defaults)
            if (question === undefined) break
            const value = canonical(question)
            if (!REFUSED_STEPS.has(question.step) && !found.has(question.step)) {
                found.set(question.step, toProvisionStep(question, opened))
            }
            for (const option of question.options ?? []) {
                if (option.value === value) continue
                if (REFUSED_CHOICES.get(question.step)?.has(option.value) === true) continue
                branches.push({
                    seed: { ...answers, [question.step]: option.value },
                    opened: { step: question.step, value: option.value },
                })
            }
            /**
             * The **canonical** answer advances the walk, not the wizard's `fallback`.
             *
             * Storing `"1"` made the walk unable to read its own answers: `presetById("1")` is
             * `undefined`, so `model` and `baseUrl` were offered with empty defaults, and every
             * branch test (`partial.web !== "search"`) compared against an index. An optional step
             * with no fallback answers empty, which is what it means — refusing there would make
             * this list unreachable past the first secret.
             */
            answers[question.step] = value
        }
        return branches
    }

    const queue = [...walk({})]
    for (let guard = 0; guard < WALK_GUARD && queue.length > 0; guard += 1) {
        const next = queue.splice(0, queue.length)
        for (const branch of next) {
            const key = `${branch.opened.step}=${branch.opened.value}`
            if (walked.has(key)) continue
            walked.add(key)
            queue.push(...walk(branch.seed, branch.opened))
        }
    }

    return [...found.values()].sort(
        (a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step),
    )
}

export interface ProvisionRequest {
    /** A subset of the steps. Anything absent takes its default, as `init --yes` does. */
    readonly answers: Readonly<Record<string, string>>
    readonly defaults: QuestionDefaults
}

export interface ProvisionResult {
    readonly agentId: string
    readonly dir: string
    readonly manifestPath: string
    /** Relative paths written, so a caller can report what it made without re-reading the disk. */
    readonly files: readonly string[]
}

/**
 * Validate a partial answer set, fill the rest from defaults, and write the agent.
 *
 * The HTTP twin of `init --yes --name x --preset y`, and deliberately built from the same three
 * calls in the same order: `validateAnswer` per supplied step, `fillDefaults` for the rest,
 * `complete` as the funnel. A route that assembled answers any other way would be a second
 * definition of what a valid agent is.
 */
export function provisionAgent(input: ProvisionRequest): ProvisionResult {
    const partial: PartialAnswers = {}

    for (const [key, raw] of Object.entries(input.answers)) {
        const step = key as InitStep
        if (!(step in FLAG_FOR)) {
            throw new HarnessError({
                code: "provision_unknown_answer",
                message: `"${key}" is not a question this runtime asks.`,
                hint: "GET /v1/provision lists every step with its prompt, default and choices. It is generated from the same walk the terminal wizard uses, so it cannot be stale.",
                field: key,
            })
        }
        /**
         * Refused, never ignored, and read off `REFUSED_STEPS` rather than named here.
         *
         * **The directory is not a caller's to choose.** Silently writing somewhere other than
         * where a request asked is the class of surprise this repo writes decisions about, and a
         * route that *honoured* a path would write wherever it was pointed. The loopback gate is
         * not a reason to hand over the filesystem as well. `daemon` is refused for the opposite
         * reason: it was accepted and acted on by nobody.
         */
        const refusedStep = REFUSED_STEPS.get(step)
        if (refusedStep !== undefined) {
            throw new HarnessError({
                code: refusedStep.code,
                message: `"${key}" cannot be set over the API.`,
                hint: refusedStep.hint,
                field: key,
            })
        }
        /**
         * A choice this step offers at a terminal and the API cannot honour.
         *
         * Checked **before** `validateAnswer`, which accepts it: it is a real answer to a real
         * question, and the problem is that the half implementing it lives in `init.ts`. Refusing
         * it after validation would report it as an invalid value, which is a lie about why.
         */
        const refusedChoice = REFUSED_CHOICES.get(step)?.get(raw.trim().toLowerCase())
        if (refusedChoice !== undefined) {
            throw new HarnessError({
                code: refusedChoice.code,
                message: `${key} is ${JSON.stringify(raw)}, which this runtime cannot do over the API.`,
                hint: refusedChoice.hint,
                field: key,
            })
        }
        const checked = validateAnswer(step, raw)
        if (!checked.ok) {
            throw new HarnessError({
                code: "provision_answer_invalid",
                message: `${key} is ${JSON.stringify(raw)}, which ${checked.reason}`,
                hint: "GET /v1/provision lists every step with its prompt, its default and its choices, generated from the same walk the terminal wizard uses.",
                field: key,
            })
        }
        partial[step] = checked.value
    }

    // Everything unanswered takes its default, and anything with no default is refused by name —
    // the same sentence `init --yes` gives, from the same function.
    fillDefaults(partial, "this is the provisioning API", input.defaults)
    const answers: InitAnswers = complete(partial, input.defaults)

    /**
     * The sandbox, always — and **the injected base, never `agentsDir()` directly**.
     *
     * Recomputed from the agent's own name so nothing a caller sent can reach `resolve`; taken from
     * `defaults.agentDirBase` so a test can point it at a tmpdir. Calling `agentsDir()` here read
     * the *real* sandbox root and the first run of this module.s tests wrote three agents into the
     * author's own sandbox — which is precisely the hazard `lib/sandbox.ts` documents: sandbox paths
     * come from there and nowhere else, and a caller that computes one itself has bypassed the
     * override every test depends on.
     */
    const targetDir = resolve(join(input.defaults.agentDirBase, answers.name))
    const files = planFiles({ ...answers, dir: targetDir })
    writeAgentFiles(targetDir, files)

    return {
        agentId: answers.name,
        dir: targetDir,
        manifestPath: join(targetDir, "agent.yaml"),
        files: files.map((file) => file.relPath),
    }
}
