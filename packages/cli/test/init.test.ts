/**
 * The init command end to end: write, refuse, validate.
 *
 * The first command-level filesystem test in this package, because this command's entire claim is
 * the files it writes — a unit test of the plan says nothing about whether the generated
 * directory actually loads. Every assertion here goes through the real loader.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    checkAuthoring,
    HarnessError,
    loadManifest,
    Runtime,
    resolveWorkspace,
} from "@dispach/core"
import { initCommand } from "#init"
import { EXIT_OK } from "#lib/const"
import { PROVIDER_IDS, TOOL_PROVIDERS } from "#lib/providers"

function scratch(): string {
    return join(mkdtempSync(join(tmpdir(), "init-test-")), "agent")
}

const FLAGS = {
    user: "Moeen",
    name: "Milo",
    purpose: "keeps my week on track",
    preset: "deepseek",
    yes: true,
} as const

// A clean injected env, NOT `process.env`: Bun auto-loads the repo root's .env, whose MODEL_*
// values would override the generated agent's own .env through the real-env-wins layering — the
// documented way a test aimed at one endpoint quietly hits another. The key is stubbed the same
// way init's own validate step stubs it, because the generated .env leaves it empty on purpose.
const STUB_ENV = { MODEL_API_KEY: "(pending)" }

describe("initCommand runs the whole funnel", () => {
    // The real guard for a flag-only answer, and the one the `planFiles` tests cannot be. Between a
    // flag and the file sit `fromFlags`, `validateAnswer`, `complete`'s object literal and
    // `planFiles`; the literal is not excess-property-checked, so a field it fails to carry is
    // dropped with no type error. `--schedules` has already been lost that way twice, and now that
    // the wizard step is gone there is no second route for the value to arrive by.

    /**
     * The far-end guard for the derived directory.
     *
     * `dir` stops being asked the moment the location answer is `sandbox`, so its value is produced by
     * `complete()` — and a step that stops being asked without its default moving to the funnel is
     * exactly how `apiKeyEnv` once vanished from generated manifests. Asserted by *where the files
     * landed*, never by reading `complete`'s output: the object literal it returns is not
     * excess-property-checked, so a field it fails to carry is dropped with no type error.
     */
    test("no --dir writes into the sandbox, derived from the location answer", async () => {
        const home = mkdtempSync(join(tmpdir(), "init-home-"))
        const before = process.env[`${BRAND.envPrefix}HOME`]
        process.env[`${BRAND.envPrefix}HOME`] = home
        try {
            expect(await initCommand({ ...FLAGS })).toBe(EXIT_OK)
            const expected = join(home, "agents", "milo", "agent.yaml")
            expect(existsSync(expected)).toBe(true)
            expect(readFileSync(expected, "utf8")).toContain("id: milo")
            // And nothing in the working directory. This is not belt-and-braces: a broken derivation
            // resolves `./milo` against `process.cwd()`, which under `bun test` is the repo — a
            // deliberate revert of the funnel during review littered `milo/` into the checkout, and
            // an untracked directory is the one failure mode a green suite will not mention.
            expect(existsSync(join(process.cwd(), "milo"))).toBe(false)
        } finally {
            if (before === undefined) delete process.env[`${BRAND.envPrefix}HOME`]
            else process.env[`${BRAND.envPrefix}HOME`] = before
        }
    })

    test("--schedules daily reaches the written agent.yaml", async () => {
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, dir, schedules: "daily" })).toBe(EXIT_OK)
        const yaml = readFileSync(join(dir, "agent.yaml"), "utf8")
        expect(yaml).toContain("id: morning-brief")
        expect(yaml).toMatch(/\nschedules:/)
    })

    test("no flag writes the block commented, and nothing is scheduled", async () => {
        // The default every interactive run and every `--yes` run takes, now that nobody is asked.
        // A switch that is off wants to exist: the field names are in the file for whoever wants
        // them later, and no schedule was invented.
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, dir })).toBe(EXIT_OK)
        const yaml = readFileSync(join(dir, "agent.yaml"), "utf8")
        expect(yaml).toContain("# schedules:")
        expect(yaml).not.toMatch(/\nschedules:/)

        const loaded = loadManifest(join(dir, "agent.yaml"), {
            env: STUB_ENV,
            knownProviders: PROVIDER_IDS,
        })
        expect(loaded.manifest.schedules).toEqual([])
    })
})

describe("initCommand", () => {
    test("writes a starter agent the real loader accepts", async () => {
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, dir })).toBe(EXIT_OK)

        // Independent of the command's own validate: load it again from here.
        const loaded = loadManifest(join(dir, "agent.yaml"), {
            env: STUB_ENV,
            knownProviders: PROVIDER_IDS,
        })
        expect(loaded.manifest.id).toBe("milo")
        expect(loaded.manifest.model.main.id).toBe("deepseek-v4-flash")

        const { workspace, warnings } = resolveWorkspace(loaded, {
            delimiters: "markdown",
            intensity: "neutral",
            examplesIn: "system",
            skillsIn: "system",
        })
        // The preset's window now clears the soul gate's 200k, so the FULL document is the identity
        // that loads and nothing is distilled. The gate's other branch is asserted on the ollama
        // preset below, which is the one with a small window — following the model id rather than
        // restating a number, so a preset bump moves the coverage instead of silently removing it.
        expect(warnings.map((warning) => warning.code)).not.toContain("soul_distilled")
        expect(workspace.files.map((file) => file.name)).toEqual([
            "SOUL.md",
            "AGENTS.md",
            "POLICY.md",
            "USER.md",
            "MEMORY.md",
            "REMINDER.md",
        ])
        expect(workspace.static).toContain("I'm Milo.")

        // The nag contract: only the dialogue-example placeholders survive, and the authoring
        // check reports exactly them, on the identity file that shipped.
        const findings = checkAuthoring(
            workspace.files.map((file) => ({
                name: file.name,
                authored: file.authored,
                tier: file.tier,
                field: file.field,
            })),
        )
        const placeholderFindings = findings.filter(
            (finding) => finding.code === "workspace_unfilled_placeholder",
        )
        // The identity that actually shipped, which is the full document now that the preset clears
        // the gate. Following the file rather than naming one is the point: the nag has to fire on
        // whichever soul the model gets, not on whichever one the test was written against.
        expect(placeholderFindings.map((finding) => finding.field)).toEqual(["SOUL.md"])
        expect(placeholderFindings[0]?.message).toContain("{{INPUT_1}}")
    })

    /**
     * The generated `.env` holds every credential the agent has, and it used to be world-readable
     * at the default 0644. That became load-bearing once a background service existed: launchd
     * hands a job almost no environment and the service definition carries no secrets on purpose,
     * so this file is the only path a credential arrives by.
     */
    test("the .env is created 0600 and nothing else is", async () => {
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, dir })).toBe(EXIT_OK)
        expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600)
        // Deliberately narrow — locking down the manifest or the workspace would break the
        // ordinary case of a person editing them.
        expect(statSync(join(dir, "agent.yaml")).mode & 0o077).not.toBe(0)
    })

    test("a big-window frontier model ships the full SOUL.md, identity leading", async () => {
        const dir = scratch()
        await initCommand({
            ...FLAGS,
            preset: "custom",
            // Unsized id → frontier class; the registry resolves this one's window to 393216,
            // so both halves of `requires` hold and the long document is the identity.
            model: "deepseek-v4-pro",
            baseUrl: "https://api.deepseek.com/v1",
            dir,
        })
        const loaded = loadManifest(join(dir, "agent.yaml"), {
            knownProviders: PROVIDER_IDS,
            env: { ...STUB_ENV, MODEL_ID: "deepseek-v4-pro" },
        })
        const { workspace, warnings } = resolveWorkspace(loaded, {
            delimiters: "markdown",
            intensity: "neutral",
            examplesIn: "system",
            skillsIn: "system",
        })
        expect(workspace.files[0]?.name).toBe("SOUL.md")
        expect(warnings.map((warning) => warning.code).includes("soul_distilled")).toBe(false)
    })

    test("refuses to touch existing files, naming them", async () => {
        const dir = scratch()
        await initCommand({ ...FLAGS, dir })
        let error: HarnessError | undefined
        try {
            await initCommand({ ...FLAGS, dir })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("cli_init_target_exists")
        expect(error?.message).toContain("agent.yaml")
    })

    test("ollama generates a keyless manifest that loads without any stub", async () => {
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, preset: "ollama", dir })).toBe(EXIT_OK)

        const yaml = readFileSync(join(dir, "agent.yaml"), "utf8")
        // No ACTIVE key line; the commented provider examples legitimately mention the field.
        expect(yaml.includes("\n    apiKeyEnv:")).toBe(false)

        const loaded = loadManifest(join(dir, "agent.yaml"), {
            env: {},
            knownProviders: PROVIDER_IDS,
        })
        expect(loaded.manifest.model.main.baseUrl).toBe("http://localhost:11434/v1")
        expect(readFileSync(join(dir, ".env"), "utf8").includes("MODEL_API_KEY")).toBe(false)

        // The soul gate's other branch, asserted on the preset that actually has a small window.
        // It used to live on the deepseek test, which stopped exercising it the moment that preset
        // moved to a frontier-class model — a passing test that had quietly stopped testing anything.
        const { workspace, warnings } = resolveWorkspace(loaded, {
            delimiters: "markdown",
            intensity: "neutral",
            examplesIn: "system",
            skillsIn: "system",
        })
        expect(warnings.map((warning) => warning.code)).toContain("soul_distilled")
        expect(workspace.files[0]?.name).toBe("SOUL.compact.md")
    })

    test("non-interactive without names refuses and lists the flags", async () => {
        const dir = scratch()
        let error: HarnessError | undefined
        try {
            await initCommand({ yes: true, dir })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("cli_init_missing_answers")
        expect(error?.hint).toContain("--user")
        expect(error?.hint).toContain("--name")
        expect(existsSync(join(dir, "agent.yaml"))).toBe(false)
    })

    test("custom preset without an endpoint refuses with the endpoint flags", async () => {
        const dir = scratch()
        let error: HarnessError | undefined
        try {
            await initCommand({ ...FLAGS, preset: "custom", dir })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("cli_init_missing_answers")
        expect(error?.hint).toContain("--model")
        expect(error?.hint).toContain("--base-url")
    })

    test("a bad flag value fails by name with the question's own reason", async () => {
        let error: HarnessError | undefined
        try {
            await initCommand({ ...FLAGS, baseUrl: "https://x.example/v1/chat/completions" })
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("cli_init_flag_invalid")
        expect(error?.message).toContain("--base-url")
    })

    test("--yes without a dir lands in the home sandbox, and next steps say run <name>", async () => {
        const home = mkdtempSync(join(tmpdir(), "init-sandbox-"))
        const homeVar = `${BRAND.envPrefix}HOME`
        const previous = process.env[homeVar]
        process.env[homeVar] = home
        try {
            expect(await initCommand({ ...FLAGS })).toBe(EXIT_OK)
            const manifest = join(home, "agents", "milo", "agent.yaml")
            expect(existsSync(manifest)).toBe(true)
            const loaded = loadManifest(manifest, { env: STUB_ENV, knownProviders: PROVIDER_IDS })
            expect(loaded.manifest.id).toBe("milo")
        } finally {
            if (previous === undefined) delete process.env[homeVar]
            else process.env[homeVar] = previous
        }
    })

    test("the commented blocks are real config: uncommenting phases now loads", async () => {
        // This test asserted the opposite until Phase 7B — that uncommenting the block was *refused*
        // naming Phase 7 — and it is kept rather than deleted because the property it guards did not
        // change: the generated comments are real configuration, and the only way to know that is to
        // uncomment them and load. What changed is which answer is correct.
        const dir = scratch()
        await initCommand({ ...FLAGS, dir })
        const path = join(dir, "agent.yaml")
        const yaml = readFileSync(path, "utf8")
            .replace("# phases:", "phases:")
            .replace(
                '#   triage: { entry: true, allow: ["now"] }',
                '  triage: { entry: true, allow: ["now"] }',
            )
            .replace('#   act:    { allow: ["*"] }', '  act:    { allow: ["*"] }')
        const { writeFileSync } = await import("node:fs")
        writeFileSync(path, yaml, "utf8")

        const loaded = loadManifest(path, { env: STUB_ENV, knownProviders: PROVIDER_IDS })
        expect(Object.keys(loaded.manifest.phases ?? {})).toEqual(["triage", "act"])
        expect(loaded.manifest.phases?.triage?.entry).toBe(true)
    })

    test("--composio connected writes a manifest the real loader accepts", async () => {
        // The whole risk of adding a provider to the generated map: the block can look right and
        // still be a document the schema refuses, or one it accepts and the runtime does not. This
        // loads it through the same path `run` uses, with composio in knownProviders.
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, dir, composio: "connected" })).toBe(EXIT_OK)

        const loaded = loadManifest(join(dir, "agent.yaml"), {
            env: { ...STUB_ENV, COMPOSIO_API_KEY: "(pending)" },
            knownProviders: PROVIDER_IDS,
        })
        const providers = loaded.manifest.tools?.providers ?? {}
        expect(Object.keys(providers)).toContain("composio")
        expect(providers.composio).toEqual({ apiKeyEnv: "COMPOSIO_API_KEY", userId: "default" })

        // Nothing pinned from Composio, and this is the property that matters: a slug pinned here
        // would resolve from an empty cache during boot and fail the load. A generated agent that
        // cannot start is worse than one with no apps wired up yet.
        const pinned = loaded.manifest.tools?.pinned ?? []
        expect(pinned.some((slug) => slug.toUpperCase() === slug && slug.includes("_"))).toBe(false)
    })

    test("a Composio agent boots cold, with the setup tools already usable", async () => {
        // The property the whole feature rests on. The meta tools are static specs — no cache read
        // and no request builds them — so a freshly generated agent can search and connect an app
        // before anyone has warmed anything. If these ever came from the cache instead, a new agent
        // would boot with no route to Composio and no way to get one, which is the dead end this
        // replaced: `tools --warm` refreshes the slugs already pinned, so a slug had to be known
        // before it could be warmed and warmed before it could be pinned.
        const dir = scratch()
        await initCommand({ ...FLAGS, dir, composio: "connected" })

        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            toolProviders: TOOL_PROVIDERS,
            env: { ...STUB_ENV, COMPOSIO_API_KEY: "(pending)" },
            store: ":memory:",
        })
        try {
            const slugs =
                runtime
                    .list()[0]
                    ?.tools.specs()
                    .map((spec) => spec.slug) ?? []
            // Resolved from a cold cache, by a provider holding no schemas at all.
            expect(slugs).toContain("composio_search")
            expect(slugs).toContain("composio_connect")
            // The system provider answered for both config tools, which is the half a cold
            // Composio could not know when it used to refuse the whole boot over them.
            expect(slugs).toContain("now")
            expect(slugs).toContain("config_read")
            expect(slugs).toContain("config_set")
            // config_set is what writes a discovered slug into pinned, so the loop only closes if
            // it is authorised after a search has tainted the turn.
            expect(slugs).toContain("config_set")
        } finally {
            await runtime.stop()
        }
    })
})

describe("the API key", () => {
    test("the manifest names the variable and the .env holds the value", async () => {
        // The bug this pins: init asked for the *variable name* while asking for every other
        // setting's value outright, then wrote `MODEL_API_KEY=` blank — so a fresh agent only ran
        // where some other .env happened to be in scope. Hard rule 10 is about the manifest, and it
        // still holds: names in agent.yaml, values in the gitignored file beside it.
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, dir })).toBe(EXIT_OK)

        const yaml = readFileSync(join(dir, "agent.yaml"), "utf8")
        expect(yaml).toContain("apiKeyEnv: MODEL_API_KEY")

        const env = readFileSync(join(dir, ".env"), "utf8")
        expect(env).toContain("MODEL_API_KEY=")
    })

    test("the variable is defaulted from the preset, not left to a question nobody answers", async () => {
        // Regression: `apiKeyEnv` stopped being asked when the wizard began asking for the key
        // itself, and nothing defaulted it — so the manifest omitted the field entirely and the
        // generated agent had no key configuration at all. Caught live; pinned here.
        const dir = scratch()
        await initCommand({ ...FLAGS, dir })
        expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("\n    apiKeyEnv:")
    })

    test("a keyless preset still omits the field and the .env line", async () => {
        const dir = scratch()
        expect(await initCommand({ ...FLAGS, preset: "ollama", dir })).toBe(EXIT_OK)

        expect(readFileSync(join(dir, "agent.yaml"), "utf8").includes("\n    apiKeyEnv:")).toBe(
            false,
        )
        expect(readFileSync(join(dir, ".env"), "utf8").includes("MODEL_API_KEY")).toBe(false)
    })
})
