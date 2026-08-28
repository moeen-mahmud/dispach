/**
 * The init flow as pure data: sequencing, validation, and the file plan.
 *
 * The property that matters most is the ollama one — `apiKeyEnv` must be *absent* from the
 * generated manifest, not empty, because `apiKeyEnv: ""` fails schema while an omitted field is
 * a keyless endpoint. An empty-string slip here would generate agents that refuse to load.
 */

import { describe, expect, test } from "bun:test"
import { countRules, LOCAL_TOOL_SLUGS, parseWorkspaceFile, rulesBlocksOnly } from "@dispach/core"
import {
    COMPOSIO_KEY_ENV,
    dirFor,
    INIT_LOCAL_TOOL_SLUGS,
    type InitAnswers,
    nextQuestion,
    PRESETS,
    planFiles,
    SECRET_STEPS,
    slugify,
    validateAnswer,
} from "#lib/init-flow"

/**
 * The sandbox base every caller must now supply. `agentDirBase` was optional and its absence fell
 * back to a cwd-relative `./<slug>` — a second, silent default that put agents in whichever checkout
 * the command ran from. Required means these call sites are the compiler's problem, not a habit.
 */
const DEFAULTS = { agentDirBase: "/home/x/.brand/agents" }

const ANSWERS: InitAnswers = {
    user: "Moeen",
    name: "Milo",
    purpose: "keeps my week on track",
    preset: "deepseek",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "MODEL_API_KEY",
    apiKey: "sk-test-value",
    system: "none",
    web: "none",
    composio: "none",
    telegram: "none",
    schedules: "none",
    server: "none",
    skills: "starter",
    daemon: "none",
    dirChoice: "custom",
    dir: "./milo",
}

describe("slugify", () => {
    test.each([
        ["Milo", "milo"],
        ["Vela Ops Bot", "vela-ops-bot"],
        ["  weird -- name!! ", "weird-name"],
        ["!!!", "agent"],
    ] as [string, string][])("%s → %s", (name, slug) => {
        expect(slugify(name)).toBe(slug)
    })
})

describe("nextQuestion", () => {
    test("asks in order and completes", () => {
        const partial: Record<string, string> = {}
        const seen: string[] = []
        for (;;) {
            const question = nextQuestion(partial, DEFAULTS)
            if (question === undefined) break
            seen.push(question.step)
            partial[question.step] =
                question.step === "preset" ? "deepseek" : question.fallback || "x"
        }
        // No webBackend or webKey: the fallback answer to the web question is "1" — none — and a
        // backend nobody will use is a question that lies. No composioKey, no telegramAllow and no
        // telegramToken, for the same reason.
        expect(seen).toEqual([
            "user",
            "name",
            "purpose",
            "preset",
            "model",
            "baseUrl",
            "apiKey",
            "system",
            "web",
            "composio",
            "telegram",
            "server",
            "skills",
            "dirChoice",
        ])
    })

    test("a keyless preset skips the key question entirely", () => {
        const partial: Record<string, string> = {
            user: "Moeen",
            name: "Milo",
            purpose: "x",
            preset: "ollama",
        }
        const steps: string[] = []
        for (;;) {
            const question = nextQuestion(partial, DEFAULTS)
            if (question === undefined) break
            steps.push(question.step)
            partial[question.step] = question.fallback || "x"
        }
        expect(steps.includes("apiKey")).toBe(false)
    })

    test("model and base URL default from the chosen preset; custom offers nothing", () => {
        expect(
            nextQuestion({ user: "a", name: "b", purpose: "c", preset: "deepseek" }, DEFAULTS)
                ?.fallback,
        ).toBe("deepseek-v4-flash")
        expect(
            nextQuestion({ user: "a", name: "b", purpose: "c", preset: "custom" }, DEFAULTS)
                ?.fallback,
        ).toBe("")
    })

    /**
     * The location question is a menu whose first option is the sandbox.
     *
     * This replaces a pair of tests that asserted *two* defaults — `./milo` with no base, the sandbox
     * with one — which documented the cwd-relative fallback as supported behaviour rather than as the
     * hazard it was. There is one default now and pressing enter takes it.
     */
    test("the location question defaults to the sandbox", () => {
        const { dir: _dir, dirChoice: _choice, ...answered } = ANSWERS
        const question = nextQuestion(answered, DEFAULTS)
        expect(question?.step).toBe("dirChoice")
        expect(question?.options?.[0]?.value).toBe("sandbox")
        // The fallback is an index into the options; "1" has to *be* the sandbox row, or enter
        // silently picks something else.
        expect(question?.fallback).toBe("1")
    })

    test("every option names the path it resolves to, not just the concept", () => {
        const { dir: _dir, dirChoice: _choice, ...answered } = ANSWERS
        const options = nextQuestion(answered, DEFAULTS)?.options ?? []
        expect(options[0]?.label).toContain("/home/x/.brand/agents/milo")
        expect(options[1]?.label).toContain("./milo")
    })

    /**
     * The follow-up exists only for `custom` — an answer the flow discards is a question that lies,
     * which is the same rule `web: search` follows for its backend.
     */
    test("only `custom` asks for a path", () => {
        const { dir: _dir, ...answered } = ANSWERS
        for (const choice of ["sandbox", "here"]) {
            expect(nextQuestion({ ...answered, dirChoice: choice }, DEFAULTS)).toBeUndefined()
        }
        const question = nextQuestion({ ...answered, dirChoice: "custom" }, DEFAULTS)
        expect(question?.step).toBe("dir")
        // No fallback: "somewhere else" with nothing typed would otherwise be a third directory
        // default arriving by the back door.
        expect(question?.fallback).toBe("")
    })

    test("dirFor derives the two non-custom answers and nothing else", () => {
        expect(dirFor("sandbox", "milo", DEFAULTS)).toBe("/home/x/.brand/agents/milo")
        expect(dirFor("here", "milo", DEFAULTS)).toBe("./milo")
        expect(dirFor("custom", "milo", DEFAULTS)).toBeUndefined()
        expect(dirFor("sandbox", undefined, DEFAULTS)).toBeUndefined()
    })

    test("the location answer is validated by number or by name", () => {
        expect(validateAnswer("dirChoice", "1")).toEqual({ ok: true, value: "sandbox" })
        expect(validateAnswer("dirChoice", "here")).toEqual({ ok: true, value: "here" })
        expect(validateAnswer("dirChoice", "4").ok).toBe(false)
        expect(validateAnswer("dirChoice", "elsewhere").ok).toBe(false)
    })
})

describe("validateAnswer", () => {
    /**
     * The bug this was written for cost a working bot and looked like a broken runtime.
     *
     * `@moeen-mahmud` was accepted into `allowFrom`. A Telegram username cannot contain a hyphen,
     * so it matched nobody — and the only symptom was the bot silently refusing every message from
     * the person it had just been set up for, while `daemon status` correctly reported it running.
     * The moment the handle is typed is the only cheap place to catch a handle that cannot exist.
     */
    test("a handle that Telegram could not issue is refused at the prompt", () => {
        const hyphen = validateAnswer("telegramAllow", "@moeen-mahmud")
        expect(hyphen.ok).toBe(false)
        if (!hyphen.ok) {
            expect(hyphen.reason).toContain("hyphen")
            // Names the likely intent, because a hyphen here is almost always a mistyped underscore.
            expect(hyphen.reason).toContain("underscore")
        }
        expect(validateAnswer("telegramAllow", "@ab").ok).toBe(false)
        expect(validateAnswer("telegramAllow", "@has space").ok).toBe(false)
        expect(validateAnswer("telegramAllow", "@dots.not.allowed").ok).toBe(false)
    })

    test("a real handle passes, with or without the @", () => {
        expect(validateAnswer("telegramAllow", "@moeen_mahmud")).toEqual({
            ok: true,
            value: "@moeen_mahmud",
        })
        // Normalised to a leading @ so the generated file reads the way a person writes it.
        expect(validateAnswer("telegramAllow", "moeen_mahmud")).toEqual({
            ok: true,
            value: "@moeen_mahmud",
        })
        expect(validateAnswer("telegramAllow", "Ada2000")).toEqual({ ok: true, value: "@Ada2000" })
    })

    test("empty still permits nobody, which is the safe default and a real answer", () => {
        expect(validateAnswer("telegramAllow", "")).toEqual({ ok: true, value: "" })
    })

    test("presets accept a number or a name", () => {
        expect(validateAnswer("preset", "3")).toEqual({ ok: true, value: "deepseek" })
        expect(validateAnswer("preset", "OLLAMA")).toEqual({ ok: true, value: "ollama" })
        expect(validateAnswer("preset", "9").ok).toBe(false)
    })

    test("the base URL rules are the loader's own, applied at the question", () => {
        expect(validateAnswer("baseUrl", "https://api.deepseek.com/v1").ok).toBe(true)
        expect(validateAnswer("baseUrl", "not a url").ok).toBe(false)
        expect(validateAnswer("baseUrl", "ftp://x.example/v1").ok).toBe(false)
        // The mistake the loader names at load, refused here instead — at the question.
        expect(validateAnswer("baseUrl", "https://api.example.com/v1/chat/completions").ok).toBe(
            false,
        )
    })

    test("env var names are names", () => {
        expect(validateAnswer("apiKeyEnv", "MODEL_API_KEY").ok).toBe(true)
        expect(validateAnswer("apiKeyEnv", "sk-abc123").ok).toBe(false)
        expect(validateAnswer("apiKeyEnv", "lower_case").ok).toBe(false)
    })

    test("names cannot be empty", () => {
        expect(validateAnswer("user", "  ").ok).toBe(false)
        expect(validateAnswer("name", "Milo")).toEqual({ ok: true, value: "Milo" })
    })
})

describe("planFiles", () => {
    test("plans the full starter set — the soul pair for identity, AGENTS.md for operations", () => {
        expect(planFiles(ANSWERS).map((file) => file.relPath)).toEqual([
            "agent.yaml",
            "workspace/SOUL.md",
            "workspace/SOUL.compact.md",
            "workspace/AGENTS.md",
            "workspace/POLICY.md",
            "workspace/USER.md",
            "workspace/MEMORY.md",
            "workspace/REMINDER.md",
            "skills/starter/SKILL.md",
            "knowledge/.keep",
            ".env.example",
            ".env",
            ".gitignore",
        ])
    })

    test("AGENTS.md is operations, fully filled, and adds nothing the rule counter sees", () => {
        const files = planFiles(ANSWERS)
        const ops = files.find((f) => f.relPath === "workspace/AGENTS.md")
        expect(ops?.contents).toContain("# What I do")
        expect(ops?.contents).toContain("memory_write")
        // Fully filled — the dialogue-example nag lives in the soul, not here.
        expect(ops?.contents.includes("{{")).toBe(false)
        // The whole point of the declarative style: an ops file that reads as zero rules.
        const body = parseWorkspaceFile("workspace/AGENTS.md", ops?.contents ?? "").body
        expect(countRules(body)).toHaveLength(0)
    })

    test("both souls are filled; the dialogue examples stay placeholders", () => {
        const files = planFiles(ANSWERS)
        for (const relPath of ["workspace/SOUL.md", "workspace/SOUL.compact.md"]) {
            const soul = files.find((f) => f.relPath === relPath)
            expect(soul?.contents).toContain("# Who Milo is")
            expect(soul?.contents).toContain("I work with Moeen")
            expect(soul?.contents.includes("{{SOUL_")).toBe(false)
            expect(soul?.contents.includes("{{RULE_")).toBe(false)
            // The nag mechanism: examples wait for a person.
            expect(soul?.contents).toContain("{{INPUT_1}}")
            expect(soul?.contents).toContain("{{REPLY_3}}")
        }
    })

    test("the reminder restates the confirm rule byte-for-byte — one rule, one phrasing", () => {
        const files = planFiles(ANSWERS)
        const soul = files.find((f) => f.relPath === "workspace/SOUL.md")
        const reminder = files.find((f) => f.relPath === "workspace/REMINDER.md")
        const confirm = "I confirm before anything that sends, spends, schedules, or deletes"
        expect(soul?.contents).toContain(confirm)
        expect(reminder?.contents).toContain(confirm)
    })

    test("the generated manifest is reference-style: live tools block, commented later phases", () => {
        const yaml = planFiles(ANSWERS).find((f) => f.relPath === "agent.yaml")?.contents ?? ""
        // Active: the soul gate and the local tools.
        expect(yaml).toContain("soul:")
        expect(yaml).toContain("distilled: SOUL.compact.md")
        expect(yaml).toContain("- now")
        expect(yaml).toContain("- memory_write")
        expect(yaml).toContain("- AGENTS.md") // operations file, listed in static
        expect(yaml.includes("- AGENT.md\n")).toBe(false) // the old identity file is gone
        // The providers map is live with `system` in it, and the other two sit inside it commented
        // at the indentation that makes them work — one key, three providers, which is the whole
        // point of the map replacing the scalar.
        // Both first-party providers are named and neither is pinned. Naming is what lets the agent
        // be *told* its tools exist: with `web` commented out, asked whether it could search the web
        // it answered that the only route was shell access and curl — true of its catalogue, false of
        // this runtime, and the worse answer of the two.
        expect(yaml).toContain("  providers:\n    system: {}")
        expect(yaml).toContain("\n    web: {}")
        // All three now, including composio: the meta tools gave it an available() worth calling,
        // so a provider left switched off can still say what it would offer.
        expect(yaml).toContain("\n    composio: {}")
        // Skills are live rather than commented, and the directory is scaffolded beside the manifest —
        // a `skills.dir` naming a path that does not exist is a load failure, so the two ship together
        // or neither does.
        expect(yaml).toContain("\nskills:\n  dir: ./skills")
        // Memory is live too, and the assertion is the positive one on purpose: it shipped commented
        // under a "Phase 6" heading for a phase that had already landed, so every generated agent
        // remembered nothing and said "I don't have notes from our earlier session" — which reads as
        // nothing having been saved rather than as a switch being off. The commented block also said
        // `k: 6`, a field that does not exist, so uncommenting it would have failed the load: nothing
        // checks a comment, which is the whole argument for not shipping capabilities inside one.
        expect(yaml).toContain("\nmemory:\n  retriever: fts5")
        expect(yaml).toContain("includeHistory: true")
        expect(yaml.includes("# memory:")).toBe(false)
        expect(yaml.includes("k: 6")).toBe(false)
        // Knowledge, the third capability that shipped inside a comment. Its note said "create
        // ./knowledge first" — true, since a missing dir is a load failure — which made the fix
        // scaffolding the directory rather than leaving the block commented. The heading it sat
        // under named Phase 3.5, a phase that had been built for four phases by then.
        expect(yaml).toContain("\nknowledge:\n  dir: ./knowledge")
        expect(yaml.includes("# knowledge:")).toBe(false)
        // Commented, with phases: uncommenting early must be a load refusal, not decoration.
        for (const line of [
            "# phases:",
            "# channels:",
            "# schedules:",
            "# plugins:",
            "# selector:",
            "#   promptStyle:",
        ]) {
            expect(yaml).toContain(line)
        }
    })

    test("ollama omits apiKeyEnv from the manifest and the key line from .env", () => {
        const answers: InitAnswers = {
            ...ANSWERS,
            preset: "ollama",
            model: "qwen3.5:9b",
            baseUrl: "http://localhost:11434/v1",
        }
        const { apiKeyEnv: _dropped, ...keyless } = answers
        const files = planFiles(keyless as InitAnswers)
        const manifest = files.find((f) => f.relPath === "agent.yaml")
        const env = files.find((f) => f.relPath === ".env")
        // No ACTIVE apiKeyEnv line — the commented provider examples legitimately mention the
        // field, so the assertion targets the uncommented model-block indent.
        expect(manifest?.contents.includes("\n    apiKeyEnv:")).toBe(false)
        expect(env?.contents.includes("MODEL_API_KEY")).toBe(false)
        // The model and the endpoint are in the manifest, literally. A keyless local endpoint
        // therefore has a .env with nothing in it but comments — which is the honest state of
        // affairs, and used to be hidden behind two variables that were never secrets.
        expect(manifest?.contents).toContain("\n    id: qwen3.5:9b")
        expect(manifest?.contents).toContain("\n    baseUrl: http://localhost:11434/v1")
        expect(env?.contents.includes("MODEL_ID=")).toBe(false)
    })

    test("the key the wizard collected lands in .env, so a fresh agent actually runs", () => {
        // The manifest still holds only the variable's *name* — hard rule 10 is about the manifest.
        // The value belongs in the gitignored file beside it, and leaving it blank produced agents
        // that only worked when some other .env happened to be in scope.
        const files = planFiles(ANSWERS)
        expect(files.find((f) => f.relPath === ".env")?.contents).toContain(
            "MODEL_API_KEY=sk-test-value",
        )
        const yaml = files.find((f) => f.relPath === "agent.yaml")?.contents ?? ""
        expect(yaml).toContain("apiKeyEnv: MODEL_API_KEY")
        expect(yaml.includes("sk-test-value")).toBe(false)
    })

    test("no key given leaves the line blank to be filled in", () => {
        const { apiKey: _omitted, ...noKey } = ANSWERS
        const env = planFiles(noKey).find((f) => f.relPath === ".env")
        expect(env?.contents).toContain("MODEL_API_KEY=\n")
    })

    test(".gitignore covers the .env that carries the key", () => {
        const gitignore = planFiles(ANSWERS).find((f) => f.relPath === ".gitignore")
        expect(gitignore?.contents).toBe(".env\n")
    })

    test(".env.example names the variables and holds no values", () => {
        // It stopped being a menu of endpoints when the endpoint moved into the manifest. What is
        // left is what its name always claimed: which variables have to exist.
        const example = planFiles(ANSWERS).find((f) => f.relPath === ".env.example")
        expect(example?.contents).toContain("\nMODEL_API_KEY=\n")
        expect(example?.contents.includes("MODEL_ID")).toBe(false)
        expect(example?.contents.includes("deepseek")).toBe(false)
    })

    test("the manifest carries the model and the endpoint; the .env carries only the key", () => {
        const files = planFiles(ANSWERS)
        const manifest = files.find((f) => f.relPath === "agent.yaml")?.contents ?? ""
        const env = files.find((f) => f.relPath === ".env")?.contents ?? ""

        // The three things the indirection cost, in one test: a picker that could not tell two
        // agents apart (headers are read without expansion), a stray .env changing the resolved
        // capabilities, and a validate that checked whichever agent the environment described.
        expect(manifest).toContain("\n    id: deepseek-v4-pro")
        expect(manifest).toContain("\n    baseUrl: https://api.deepseek.com/v1")
        expect(manifest.includes("${MODEL_ID}")).toBe(false)
        expect(manifest.includes("${MODEL_BASE_URL}")).toBe(false)

        // Hard rule 10 is untouched: the manifest names the key's variable and never holds it.
        expect(manifest).toContain("apiKeyEnv: MODEL_API_KEY")
        expect(manifest.includes("sk-test-value")).toBe(false)
        expect(env).toContain("MODEL_API_KEY=sk-test-value")
        expect(env.includes("MODEL_ID")).toBe(false)
    })

    test("no generated file guesses pronouns for the user", () => {
        for (const file of planFiles(ANSWERS)) {
            for (const word of [" he ", " she ", " his ", " her ", " him "]) {
                expect(file.contents.toLowerCase().includes(word)).toBe(false)
            }
        }
    })
})

describe("PRESETS", () => {
    test("exactly one preset is keyless, and it is the local one", () => {
        const keyless = PRESETS.filter((preset) => preset.apiKeyEnv === undefined)
        expect(keyless.map((preset) => preset.id)).toEqual(["ollama"])
    })
})

describe("INIT_LOCAL_TOOLS", () => {
    test("pins the runtime's local tool list — a new tool cannot ship without init knowing", () => {
        expect([...INIT_LOCAL_TOOL_SLUGS].sort()).toEqual([...LOCAL_TOOL_SLUGS].sort())
    })
})

describe("rule budget pin", () => {
    // The default guard allows 2 rules (perRuleSuccess .9, target .8). The generated prose is
    // worded to count exactly 1 (RULE_HONESTY's "don't") on EITHER gate path, and this pin is
    // what keeps a future synonym swap ("never guess") from silently busting the load.
    function countedRules(relPaths: readonly string[]): number {
        const files = planFiles(ANSWERS)
        const text = relPaths
            .map((relPath) => {
                const file = files.find((f) => f.relPath === relPath)
                const body = parseWorkspaceFile(relPath, file?.contents ?? "").body
                return relPath === "workspace/SOUL.md" ? rulesBlocksOnly(body) : body
            })
            .join("\n")
        return countRules(text).length
    }

    test("full-document path counts at most 2 rules", () => {
        const counted = countedRules([
            "workspace/SOUL.md",
            "workspace/AGENTS.md",
            "workspace/POLICY.md",
            "workspace/REMINDER.md",
        ])
        expect(counted).toBeLessThanOrEqual(2)
    })

    test("distilled path counts at most 2 rules — the compact file gets no prose exemption", () => {
        const counted = countedRules([
            "workspace/SOUL.compact.md",
            "workspace/AGENTS.md",
            "workspace/POLICY.md",
            "workspace/REMINDER.md",
        ])
        expect(counted).toBeLessThanOrEqual(2)
    })
})

describe("the web question", () => {
    function withWeb(over: Partial<InitAnswers>): string {
        return (
            planFiles({ ...ANSWERS, ...over }).find((f) => f.relPath === "agent.yaml")?.contents ??
            ""
        )
    }

    test("none still names the provider, so the agent can say the tools exist", () => {
        // The bug this answers: with the block commented out, an agent asked whether it could search
        // the web replied that the only route was shell access and curl — true of its catalogue and
        // false of the runtime. Naming a provider is what makes available() run.
        const yaml = withWeb({ web: "none" })
        expect(yaml).toContain("\n    web: {}")
        expect(yaml).toContain("    # - web_fetch")
        expect(yaml.includes("\n    - web_fetch")).toBe(false)
    })

    test("fetch pins the keyless tool and only that one", () => {
        const yaml = withWeb({ web: "fetch" })
        expect(yaml).toContain("\n    - web_fetch")
        expect(yaml).toContain("    # - web_search")
    })

    test("search writes the backend and the variable, never a key", () => {
        const yaml = withWeb({ web: "search", webBackend: "brave", webKey: "brave-secret" })
        expect(yaml).toContain("backend: brave")
        expect(yaml).toContain("apiKeyEnv: BRAVE_API_KEY")
        expect(yaml).toContain("\n    - web_search")
        // Hard rule 10: the manifest names the variable and never holds the value.
        expect(yaml.includes("brave-secret")).toBe(false)
    })

    test("the key lands in the gitignored .env, and only for a searching agent", () => {
        const withKey = planFiles({
            ...ANSWERS,
            web: "search",
            webBackend: "exa",
            webKey: "exa-secret",
        }).find((f) => f.relPath === ".env")?.contents
        expect(withKey).toContain("EXA_API_KEY=exa-secret")

        // A blank TAVILY_API_KEY in the .env of every agent that will never search is a variable
        // nobody asked for, in front of everybody.
        const without = planFiles({ ...ANSWERS, web: "fetch" }).find(
            (f) => f.relPath === ".env",
        )?.contents
        expect((without ?? "").includes("API_KEY=") && !(without ?? "").includes("TAVILY")).toBe(
            true,
        )
    })

    test("the backend and its key are asked only of someone who chose search", () => {
        const base = {
            user: "M",
            name: "W",
            purpose: "x",
            preset: "deepseek",
            model: "m",
            baseUrl: "https://x.example/v1",
            apiKey: "",
            system: "none",
        }
        // An answer the flow would discard is a question that lies.
        expect(nextQuestion({ ...base, web: "fetch" }, DEFAULTS)?.step).toBe("composio")
        expect(nextQuestion({ ...base, web: "search" }, DEFAULTS)?.step).toBe("webBackend")
        expect(nextQuestion({ ...base, web: "search", webBackend: "exa" }, DEFAULTS)?.step).toBe(
            "webKey",
        )
    })

    test("the web answers are validated by name or by number", () => {
        expect(validateAnswer("web", "2")).toEqual({ ok: true, value: "fetch" })
        expect(validateAnswer("web", "SEARCH")).toEqual({ ok: true, value: "search" })
        expect(validateAnswer("web", "maybe").ok).toBe(false)
        expect(validateAnswer("webBackend", "3")).toEqual({ ok: true, value: "exa" })
        expect(validateAnswer("webBackend", "google").ok).toBe(false)
    })
})

describe("the Composio question", () => {
    function generated(over: Partial<InitAnswers>, file = "agent.yaml"): string {
        return planFiles({ ...ANSWERS, ...over }).find((f) => f.relPath === file)?.contents ?? ""
    }

    /** The uncommented entries under `pinned:`, which is what the runtime actually resolves. */
    function pinnedSlugs(yaml: string): readonly string[] {
        return yaml
            .slice(yaml.indexOf("  pinned:"))
            .split("\n")
            .filter((line) => /^\s+- /.test(line))
            .map((line) => line.trim().slice(2))
    }

    test("connected writes a live provider entry with the key variable and the account", () => {
        const yaml = generated({ composio: "connected" })
        expect(yaml).toContain("    composio:\n")
        expect(yaml).toContain(`      apiKeyEnv: ${COMPOSIO_KEY_ENV}`)
        expect(yaml).toContain("      userId: default")
        expect(yaml.includes("    # composio:")).toBe(false)
    })

    test("connected pins the two setup tools and no app tool", () => {
        // The pair is the whole route: search finds a task's tools and saves their definitions,
        // connect returns the sign-in link. An app tool cannot be pinned here — init makes no
        // requests, so it has no slug to write and no schema to warm — and does not need to be:
        // the agent discovers one and pins it itself.
        const yaml = generated({ composio: "connected" })
        const active = pinnedSlugs(yaml)
        expect(active).toContain("composio_search")
        expect(active).toContain("composio_connect")
        // No TOOLKIT_ACTION slug, which is what an unwarmed pin would be — and a load failure.
        expect(active.some((slug) => slug === slug.toUpperCase() && slug.includes("_"))).toBe(false)
        // The workbench runs code under no rule this manifest can write. Never by default.
        expect(active).not.toContain("composio_workbench")
    })

    test("connected allows composio_connect, or the one useful sequence stops halfway", () => {
        // search is untrusted and connect is mutating, so the first search taints the turn and the
        // connect that has to follow it has no authorisation to point at. That is the write gate
        // working as designed, and indistinguishable from a broken runtime from the outside.
        const yaml = generated({ composio: "connected" })
        const policy = yaml.slice(yaml.indexOf("  policy:"), yaml.indexOf("  untrusted:"))
        expect(policy).toContain('- "composio_connect"')
        // Not search: it is read-only, so it never needs one.
        expect(policy.includes('- "composio_search"')).toBe(false)
    })

    test("none names the provider with nothing pinned, exactly as web does", () => {
        // It used to be commented, because a 25,000-tool catalogue had no available() worth calling
        // so naming it told the model nothing. Two fixed meta tools changed that premise: "I could
        // search your apps if you enable composio_search" is the sentence available() exists for.
        const yaml = generated({ composio: "none" })
        expect(yaml).toContain("    composio: {}")
        expect(pinnedSlugs(yaml).some((slug) => slug.startsWith("composio_"))).toBe(false)
        // Still not hidden: the exact line to add is in the file.
        expect(yaml).toContain(
            `    #   composio: { apiKeyEnv: ${COMPOSIO_KEY_ENV}, userId: default }`,
        )
    })

    test("the key reaches .env only when Composio was asked for", () => {
        expect(generated({ composio: "connected", composioKey: "cmp-live" }, ".env")).toContain(
            `${COMPOSIO_KEY_ENV}=cmp-live`,
        )
        // Chosen but not typed: the variable is present and empty, so the next steps can point at it.
        expect(generated({ composio: "connected" }, ".env")).toContain(`${COMPOSIO_KEY_ENV}=`)
        // Not chosen: absent entirely. An empty variable nobody asked for in front of everybody is
        // the noise this rule exists to avoid.
        expect(generated({ composio: "none" }, ".env").includes(COMPOSIO_KEY_ENV)).toBe(false)
        expect(generated({ composio: "none" }, ".env.example").includes(COMPOSIO_KEY_ENV)).toBe(
            false,
        )
        expect(generated({ composio: "connected" }, ".env.example")).toContain(
            `${COMPOSIO_KEY_ENV}=`,
        )
    })

    test("the key question is asked only of someone who connected", () => {
        const base = {
            user: "M",
            name: "W",
            purpose: "x",
            preset: "deepseek",
            model: "m",
            baseUrl: "https://x.example/v1",
            apiKey: "",
            system: "none",
            web: "none",
        }
        expect(nextQuestion({ ...base, composio: "none" }, DEFAULTS)?.step).toBe("telegram")
        expect(nextQuestion({ ...base, composio: "connected" }, DEFAULTS)?.step).toBe("composioKey")
    })

    test("the answers are validated by name or by number", () => {
        expect(validateAnswer("composio", "1")).toEqual({ ok: true, value: "none" })
        expect(validateAnswer("composio", "2")).toEqual({ ok: true, value: "connected" })
        expect(validateAnswer("composio", "CONNECTED")).toEqual({ ok: true, value: "connected" })
        expect(validateAnswer("composio", "gmail").ok).toBe(false)
        // Never rejected, exactly like every other secret here.
        expect(validateAnswer("composioKey", "anything")).toEqual({
            ok: true,
            value: "anything",
        })
    })

    test("the key is a secret step, so no renderer can echo it back", () => {
        expect(SECRET_STEPS.has("composioKey")).toBe(true)
    })
})

describe("schedules, which is a flag and not a question", () => {
    /** The generated `agent.yaml`, which is the only place the answer can be checked honestly. */
    const manifest = (schedules: string): string => {
        const file = planFiles({ ...ANSWERS, schedules }).find((f) => f.relPath === "agent.yaml")
        return file?.contents ?? ""
    }

    test("each answer reaches the generated manifest", () => {
        // This covers the *generator* only — `planFiles` is handed answers, so neither of the two
        // object-literal funnels that dropped `--schedules` (the one in `init.ts`, three lines below
        // its own comment describing this defect, and the flag dispatch in `index.ts`) is on this
        // path. The comment here used to claim otherwise. The funnel guard is
        // `initCommand runs the whole funnel` in `init.test.ts`, which reads the written file — and
        // it matters more now than it did, because with the wizard step gone the flag is the only
        // route a value takes.
        expect(manifest("daily")).toContain("id: morning-brief")
        expect(manifest("daily")).toContain('expr: "0 8 * * *"')
        expect(manifest("hourly")).toContain("id: hourly-check")
        expect(manifest("hourly")).toContain("expr: 1h")
    })

    test("`none` still writes the block, commented, with the field names in it", () => {
        // A switch that is off wants to exist — the standing rule after the web provider shipped
        // commented out. What `none` must not do is invent a schedule nobody asked for.
        const off = manifest("none")
        expect(off).toContain("# schedules:")
        expect(off).toContain("#     kind: cron               # cron | every | at")
        expect(off).not.toContain("\nschedules:")
    })

    test("every answer names only serve as the thing that fires them", () => {
        // The gap slot 2 and `status` both exist to close: configured is not running.
        for (const answer of ["none", "daily", "hourly"]) {
            expect(manifest(answer)).toContain("serve` fires these")
        }
    })
})
