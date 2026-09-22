/**
 * Structural guards.
 *
 * These assert facts about the source tree rather than about behaviour, because the facts are
 * expensive to check by hand and silent when broken. The lazy-Ink boundary in particular fails
 * invisibly: adding `import { Text } from "ink"` to a command module keeps every test passing and
 * every output identical, while quietly adding ~200 ms to every invocation of every command.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { BRAND } from "@dispach/core"
import { DAEMON_ACTIONS } from "#daemon"
import { COMMANDS } from "#lib/commands"
import { helpText } from "#lib/help"
import { SESSION_COMMANDS } from "#lib/session-commands"
import { spawnCapture } from "#lib/spawn"
import { SKILLS_ACTIONS } from "#skills"

const SRC = resolve(import.meta.dirname, "..", "src")

function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
        else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full)
    }
    return out
}

const FILES = sourceFiles(SRC).map((path) => ({
    path: relative(SRC, path),
    text: readFileSync(path, "utf8"),
}))

/** `import … from "x"` and `export … from "x"`, but not `await import("x")`. */
function staticImportsOf(text: string, pkg: string): boolean {
    return new RegExp(
        `(?:^|\\n)\\s*(?:import|export)[^\\n]*from\\s*["']${pkg}(?:/[^"']*)?["']`,
    ).test(text)
}

describe("the rich renderer stays lazy", () => {
    const RICH_ONLY = ["ink", "react"]

    test("at least one file does import it, or this test proves nothing", () => {
        const importers = FILES.filter((file) =>
            RICH_ONLY.some((pkg) => staticImportsOf(file.text, pkg)),
        )
        expect(importers.length).toBeGreaterThan(0)
    })

    test("only components and hooks import Ink or React statically", () => {
        const offenders = FILES.filter(
            (file) =>
                !file.path.startsWith("components/") &&
                !file.path.startsWith("hooks/") &&
                RICH_ONLY.some((pkg) => staticImportsOf(file.text, pkg)),
        ).map((file) => file.path)

        // Measured: react + ink cost ~65 ms to import under Bun and ~170-210 ms under Node, against
        // a ~90 ms total runtime for `validate --json`. Any static import on a shared path is paid by
        // every command.
        expect(offenders).toEqual([])
    })

    test("the entry point reaches the app only through a dynamic import", () => {
        const entry = FILES.find((file) => file.path === "index.ts")
        expect(entry).toBeDefined()
        expect(staticImportsOf(entry?.text ?? "", "#components/App")).toBe(false)
    })

    test("run.ts loads the renderer dynamically", () => {
        const run = FILES.find((file) => file.path === "run.ts")
        expect(run?.text).toContain('import("ink")')
        expect(staticImportsOf(run?.text ?? "", "ink")).toBe(false)
    })

    test("init.ts loads the renderer dynamically too", () => {
        // The wizard is the second Ink surface; the same laziness contract applies — a
        // flag-driven `init --yes` must never pay for a renderer it does not mount.
        const init = FILES.find((file) => file.path === "init.ts")
        expect(init?.text).toContain('import("ink")')
        expect(staticImportsOf(init?.text ?? "", "ink")).toBe(false)
    })

    test("the entry point reaches no screen root statically", () => {
        const entry = FILES.find((file) => file.path === "index.ts")?.text ?? ""
        for (const root of ["#components/App", "#components/WizardApp", "#components/Picker"]) {
            expect(staticImportsOf(entry, root)).toBe(false)
        }
    })
})

describe("the pure modules stay pure", () => {
    // These four are the ones worth unit-testing, and each would become untestable the moment it
    // reached for a terminal, a clock, or a renderer.
    const PURE = [
        "transcript.ts",
        "keymap.ts",
        "editor.ts",
        "lib/wrap.ts",
        "lib/args.ts",
        "lib/init-flow.ts",
        "lib/templates.ts",
        "lib/theme.ts",
        "lib/select.ts",
        // The key probe's formatter. Pure because the whole point of it is to be believable: every line
        // it prints is asserted here rather than read off somebody's screen, and a module that reached
        // for `process.env` to decide what a terminal is would be reporting a guess.
        "lib/keys-view.ts",
        // Display width. Pure because every wrapped row, every frame height and now every mouse column
        // depends on it, and a table of ranges is exactly the thing to assert directly rather than
        // through three layers of layout.
        "lib/width.ts",
        // The transcript's mouse selection. Pure because the whole design is that it holds *buffer*
        // coordinates rather than screen ones, and that claim is only worth making if the arithmetic can
        // be asserted without a terminal, a mouse, or a rendered frame.
        "lib/text-selection.ts",
        "lib/wizard.ts",
        // The daemon's three. `launchd.ts` renders a plist and parses `launchctl` output;
        // `daemon-plan.ts` decides what would stop an install and what a service's state means;
        // `render.ts` is the plain path's shared vocabulary. Keeping all three pure is what lets
        // every plist key, every wait-status decode and every verdict be asserted without
        // installing a service on the machine running the tests.
        "lib/launchd.ts",
        "lib/daemon-plan.ts",
        "lib/render.ts",
        // `remove`'s half. Pure so the cases that matter — a manifest id shared by two directories, a
        // live lease, an installed service, rows nobody claims — are a table rather than nine ways of
        // breaking a real sandbox. It also decides the *order* of an irreversible sequence, which is
        // exactly the thing that must be assertable without performing it.
        "lib/remove-plan.ts",
        // Which stored messages a resumed conversation paints. Pure because the alternative was four
        // chained lambdas inside a function that needs a live runtime, and the only way to check it was
        // to resume a real session and look — which is how it shipped wrong twice.
        "lib/resume.ts",
        // `config`'s two halves. This surface can disable the write gate and open a bind address to the
        // network, so *which* edits need a confirmation has to be assertable without performing one —
        // the same argument `remove-plan.ts` makes about an irreversible sequence's order.
        "lib/config-view.ts",
        // The editor's arithmetic: which rows exist, where the cursor may land, what a field starts
        // with. Pure so the two things most likely to be wrong are data — the cursor stepping over a
        // heading, and a secret never being seeded into a buffer.
        "lib/config-editor.ts",
        // Text in, text out. A `.env` writer that reflowed the file would drop the comments naming where
        // each key came from, which matters more here than in the manifest.
        "lib/dotenv-edit.ts",
        // The kit's half of a screen that is not a renderer: what the header says and whether the
        // footer fits. Pure so both can be asserted as strings, which is the only way the *content* of
        // a header was ever observable — before this it lived in JSX in three components.
        "lib/screen.ts",
        "lib/rows.ts",
        "lib/multiselect.ts",
        "lib/browse.ts",
        // Stage 7's two. `scroll.ts` is where a window sits in a buffer; `chat-frame.ts` is how many rows
        // each part of a full-screen session may have. Pure because the alternate screen makes both
        // load-bearing — a frame one row too tall scrolls the buffer it is drawn on — and arithmetic that
        // can only be checked by looking at a terminal is arithmetic nobody checks.
        "lib/scroll.ts",
        "lib/chat-frame.ts",
        // Naming a conversation and listing them. Pure so the key can be asserted from fixed bytes and the
        // row layout as strings — the two things that decide whether a key is typeable and whether a list
        // is legible, neither of which is observable from a running store.
        "lib/session-key.ts",
        "lib/sessions-view.ts",
        // The wordmark. Pure because it is the largest thing hard rule 3 touches — an ASCII wordmark is a
        // brand string, so it is *rendered* from `BRAND.name` rather than written down, and the property
        // that a rename still draws is only assertable as strings.
        "lib/wordmark.ts",
        // Phase 5.6's two. `composer.ts` is where the caret sits once the input box wraps its own text —
        // pure because the render and the frame arithmetic both call it, and a disagreement between them
        // is a composer drawn under the status line. `mouse.ts` is what a wheel notch means; pure because
        // Ink hands a mouse report over as *text*, so the only thing standing between a scroll and a
        // corrupted message is a function over a string.
        "lib/composer.ts",
        "lib/mouse.ts",
    ]

    test("they import no renderer and no node built-ins", () => {
        for (const name of PURE) {
            const file = FILES.find((candidate) => candidate.path === name)
            expect(file).toBeDefined()
            const text = file?.text ?? ""
            expect(staticImportsOf(text, "ink")).toBe(false)
            expect(staticImportsOf(text, "react")).toBe(false)
            expect(staticImportsOf(text, "node:.*")).toBe(false)
        }
    })

    test("they do not read process state", () => {
        for (const name of PURE) {
            const text = FILES.find((candidate) => candidate.path === name)?.text ?? ""
            // `resolveMode` takes its inputs as arguments precisely so that the interesting logic is
            // a pure function; the same rule applies to the reducers.
            expect(text).not.toContain("process.env")
            expect(text).not.toContain("process.stdout")
        }
    })
})

describe("no module is both statically and dynamically imported", () => {
    /**
     * The bug this exists for is fatal and invisible to every other test.
     *
     * `bun build --splitting` emits a module's exports **twice** when one file imports it statically and
     * another imports it with `await import()`. The bundle then dies at parse time —
     * `SyntaxError: Duplicate export of 'browseCommand'` — and nothing in the suite notices, because tests
     * import source. It happened twice in one afternoon, for `browse.ts` and for `SkillBrowser`.
     *
     * `bundle.test.ts` starts the binary, which catches it for anything `--version` and `--help` reach.
     * It cannot reach the rich path: the whole point of the lazy-Ink boundary is that those chunks load
     * only at a terminal. So the mixing itself is what gets banned, from the source text, where it is
     * plainly visible.
     *
     * Splitting is not negotiable in the other direction: it is what keeps `import("ink")` out of the
     * startup path, and dropping it would hoist Ink into the main bundle and cost every command ~200 ms.
     */
    function dynamicImportsOf(text: string): readonly string[] {
        return [...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map(
            (match) => match[1] ?? "",
        )
    }

    /**
     * Static specifiers that create a *runtime* edge.
     *
     * `import type` is excluded, and has to be: a type import is erased before the bundler sees it, so it
     * cannot produce a duplicate export — and counting it would forbid the one arrangement that fixes the
     * problem, which is a component whose props are imported as types and whose implementation is loaded
     * dynamically.
     */
    function staticSpecifiersOf(text: string): readonly string[] {
        return [
            ...text.matchAll(
                /(?:^|\n)\s*(?:import|export)(?!\s+type\s)[^\n]*from\s*["']([^"']+)["']/g,
            ),
        ].map((match) => match[1] ?? "")
    }

    test("the two sets do not overlap for any internal module", () => {
        const statics = new Set<string>()
        const dynamics = new Set<string>()
        for (const file of FILES) {
            // Internal only. `ink` and `react` are external to the bundle, so importing them both ways is
            // exactly what the lazy boundary requires and is not this rule's business.
            for (const spec of staticSpecifiersOf(file.text)) {
                if (spec.startsWith("#")) statics.add(spec)
            }
            for (const spec of dynamicImportsOf(file.text)) {
                if (spec.startsWith("#")) dynamics.add(spec)
            }
        }
        const both = [...dynamics].filter((spec) => statics.has(spec)).sort()
        expect(both).toEqual([])
    })

    test("and there really are dynamic imports, or this test proves nothing", () => {
        const found = FILES.flatMap((file) => dynamicImportsOf(file.text))
        expect(found.length).toBeGreaterThan(0)
    })
})

describe("every component is verified by a frame test", () => {
    /**
     * The rule that closes the hole this whole area was built in.
     *
     * `ink-testing-library` was a declared devDependency from the commit that introduced Ink, and no
     * test ever imported it — so every `.tsx` in the tree was checked only through its pure reducers.
     * That is a real check and a different claim: `lib/rows.ts` was asserted as strings and correct
     * while the rendered list still wrapped at 40 columns, because nothing looked at a finished line.
     *
     * Enforced structurally rather than by intention, because the failure is silent in exactly the way
     * a missing test always is: nothing goes red when a component arrives without one.
     *
     * A component may be covered by a file named after it, or by one of the grouped files — the small
     * presentational pieces live together in `kit`, the input-owning screen roots in `roots`, and
     * splitting them into sixteen files of four assertions would be sixteen copies of the same import.
     */
    const GROUPED = ["kit", "roots"]

    function componentNames(): string[] {
        return FILES.filter(
            (file) => file.path.startsWith("components/") && file.path.endsWith(".tsx"),
        ).map((file) => file.path.slice("components/".length, -".tsx".length))
    }

    function frameTests(): { readonly name: string; readonly text: string }[] {
        const dir = resolve(import.meta.dirname, "components")
        return readdirSync(dir)
            .filter((entry) => entry.endsWith(".test.tsx"))
            .map((entry) => ({
                name: entry.slice(0, -".test.tsx".length),
                text: readFileSync(join(dir, entry), "utf8"),
            }))
    }

    test("there are components to check, and frame tests that check them", () => {
        expect(componentNames().length).toBeGreaterThan(0)
        expect(frameTests().length).toBeGreaterThan(0)
    })

    test("each component is imported by a frame test", () => {
        const tests = frameTests()
        const missing = componentNames().filter((name) => {
            const own = tests.find((file) => file.name === name.toLowerCase())
            if (own !== undefined) return false
            // Otherwise a grouped file has to actually import it — asserted by the import, not by the
            // file merely existing, or a component could be listed nowhere and still pass.
            return !tests
                .filter((file) => GROUPED.includes(file.name))
                .some((file) => file.text.includes(`#components/${name}`))
        })
        expect(missing).toEqual([])
    })

    test("the frame harness is the only way a test measures a rendered width", () => {
        // `awk` reported 69 overlong lines where there were none, because `length()` counts bytes and
        // the theme's glyphs are multi-byte. Any width assertion has to go through `width()`, which
        // counts code points.
        const offenders = frameTests()
            .filter((file) => file.text.includes(".length >") && !file.text.includes("width("))
            .map((file) => file.name)
        expect(offenders).toEqual([])
    })
})

describe("exactly one module may spawn a subprocess", () => {
    /**
     * The CLI spawned nothing at all until the daemon needed `launchctl`, and that is worth
     * keeping true of everything except the one seam built for it. A second call site is a second
     * place tests would have to intercept, and the first one that forgets reaches the real
     * `~/Library/LaunchAgents` on somebody's machine.
     *
     * The seam moved out of `lib/service.ts` when `git` became the second thing worth running, and it
     * moved rather than becoming a two-entry allowlist: an allowlist is what this rule turns into if a
     * new caller is ever the answer, and it would grow once per phase. `lib/service.ts` and
     * `lib/source-cache.ts` both call `spawnCapture`, and neither knows how a process is started.
     */
    const SPAWNER = "lib/spawn.ts"

    test("only the shared spawn seam imports node:child_process", () => {
        const offenders = FILES.filter(
            (file) => file.path !== SPAWNER && staticImportsOf(file.text, "node:child_process"),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    test("and it really does — otherwise this test proves nothing", () => {
        const seam = FILES.find((file) => file.path === SPAWNER)?.text ?? ""
        expect(staticImportsOf(seam, "node:child_process")).toBe(true)
    })
})

describe("every host that loads plugins names the plugin root", () => {
    /**
     * The plugin root is the middle of the loader's three lookups, and it is the **host's** to supply:
     * core must not derive a sandbox path, because one module owning them is what lets a test redirect
     * them (`provisionAgent` computed one itself once and wrote three agents into the author's real
     * home directory).
     *
     * Which means ten object literals have to name it, and this project has paid six separate rounds
     * for exactly that shape — `apiKeyEnv`, `ChatMessage.toolCalls`, `TurnInput.skills`,
     * `ToolContext.readArtifact`, `ToolContext.memoryDir`, `init --schedules daily` — a field declared
     * on a type, dropped by one conditional spread, and invisible to `tsc`. Here the symptom would be
     * the recorded asymmetry with the polarity reversed: `validate` reporting a manifest broken that
     * `run` boots perfectly well, because only one of the two looked in the directory the plugin is in.
     *
     * So it is asserted structurally rather than once per command. A new host is covered with nothing
     * to remember, which is the same reason `CommandSpec.inSession` is required and the flag walk below
     * reads `index.ts`.
     */
    const HOSTS = FILES.filter(
        (file) =>
            file.text.includes("Runtime.create({") || file.text.includes("agentPluginSupply({"),
    )

    test("there are hosts to check — otherwise this test proves nothing", () => {
        expect(HOSTS.length).toBeGreaterThan(5)
    })

    test("each one passes pluginRoot()", () => {
        // Matched as a *call* rather than as the literal `pluginRoot()`: a command with a test seam
        // passes `pluginRoot(options.env)`, which is the same fact about the same module.
        const offenders = HOSTS.filter((file) => !/\bpluginRoot\(/.test(file.text)).map(
            (file) => file.path,
        )
        expect(offenders).toEqual([])
    })

    test("and only lib/sandbox.ts derives it", () => {
        const offenders = FILES.filter(
            (file) =>
                file.path !== "lib/sandbox.ts" &&
                /join\(\s*sandboxRoot\([^)]*\),\s*"plugins"/.test(file.text),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })
})

describe("the WhatsApp channel stays out of the binary", () => {
    /**
     * Baileys reverse-engineers WhatsApp Web, which WhatsApp's terms do not permit and for which
     * there is no appeal when a number is banned. That is a risk an operator takes deliberately for
     * an account they chose; it is not one this runtime takes on behalf of everybody who installs
     * it. So the package is built, typechecked, linted and tested with everything else — contract
     * drift against `ChannelTransport` is caught by our own suite rather than by somebody else's CI
     * — and reaches an agent only through `plugins add`.
     *
     * What actually pulls a package into the binary is a static import in `providers.ts` plus the
     * workspace devDependency. Neither is a thing anybody would notice adding, and adding either
     * would put 7 MB of unofficial protocol code into the tarball, the four compiled binaries and
     * the image. So both are asserted, and against `package.json` rather than against the built
     * bundle: a `dist` scan would go green on a stale build.
     */
    const WHATSAPP = "channel-whatsapp"

    test("no CLI source imports it", () => {
        // An *import*, not a mention: `lib/plugin-install.ts` names the package in a comment as the
        // example of a monorepo subdirectory, which is exactly the thing this rule is about and not
        // a violation of it.
        const offenders = FILES.filter((file) =>
            new RegExp(`from ["'][^"']*${WHATSAPP}`).test(file.text),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    test("and it is not a dependency of the published package", () => {
        const manifest = JSON.parse(
            readFileSync(join(SRC, "..", "package.json"), "utf8"),
        ) as Record<string, Record<string, string> | undefined>
        for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
            expect(Object.keys(manifest[section] ?? {}).join(" ")).not.toContain(WHATSAPP)
        }
    })

    test("the package really is there — otherwise this test proves nothing", () => {
        expect(existsSync(join(SRC, "..", "..", WHATSAPP, "package.json"))).toBe(true)
    })
})

describe("a generated session key has one derivation", () => {
    /**
     * `sessionKeyFrom` turns bytes into `local:xxxxxx`. `resolveSession` called it inline, and `/new`
     * needed the same call — at which point "what a generated conversation is called" would have existed
     * in two places, which is how two surfaces come to disagree about it. Same reasoning that moved
     * `logPaths` into `lib/sandbox.ts` rather than letting `remove` keep a copy.
     *
     * Structural rather than a unit test, because `resolveSession` is private to `run.ts` and exporting it
     * to prove this would be a change made only for the test. What the rule actually says is: outside the
     * module that owns keys, the only route to a fresh one is `newSessionKey`.
     */
    const OWNER = "lib/session-key.ts"

    test("only the key module calls sessionKeyFrom", () => {
        const offenders = FILES.filter(
            (file) => file.path !== OWNER && /\bsessionKeyFrom\s*\(/.test(file.text),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    test("and it really does call it — otherwise this test proves nothing", () => {
        const owner = FILES.find((file) => file.path === OWNER)?.text ?? ""
        expect(/\bsessionKeyFrom\s*\(/.test(owner)).toBe(true)
    })
})

describe("both renderers open a new conversation the same way", () => {
    /**
     * Structural, and it says so: the plain path's dispatch is private to `runPlain` and needs a live
     * agent and a store to reach, so the honest proof is running the binary. What this *can* pin is the
     * regression that would otherwise be silent — `/new` returning the restart outcome without putting a
     * key in the box, which turns it into `/restart` with a different name, on one path only.
     *
     * Two sites, because there are two renderers and the whole point of `session-commands.ts` is that
     * they cannot answer one keystroke differently. One `switch` site, because a `/sessions` move must not
     * quietly become a `/new` — that would discard the conversation somebody chose.
     */
    const RUN = FILES.find((file) => file.path === "run.ts")?.text ?? ""

    test("run.ts is where this lives — otherwise the counts below prove nothing", () => {
        expect(RUN).not.toBe("")
    })

    // The trailing brace is what makes these count *assignments*. Without it the union in the box's own
    // type declaration matches too, which is how the first version of this test reported three writes
    // where there is one — a count is only a count of the thing you meant if the pattern excludes the
    // declaration of it.
    const assigned = (reason: string) =>
        [...RUN.matchAll(new RegExp(`reason:\\s*"${reason}"\\s*}`, "g"))].length

    test("each path mints a key and marks the reason", () => {
        expect(assigned("new")).toBe(2)
        // Twice for `/new`, once for `resolveSession`'s fresh path — the shared derivation.
        expect([...RUN.matchAll(/newSessionKey\(/g)]).toHaveLength(3)
    })

    test("moving to a chosen conversation stays its own reason", () => {
        expect(assigned("switch")).toBe(1)
    })
})

describe("help lists everything a command accepts", () => {
    /**
     * The flag half of this has been pinned since Phase 2.5. The *action* half had no check at
     * all: `soul`'s single verb lived inside a prose help string, invisible to anything, and
     * `daemon` arriving with seven of them turned that from an oddity into a class of drift. So
     * actions are structured data now, and the guarantee is the same one flags already have.
     */
    test("every action-taking command enumerates its actions", () => {
        for (const command of COMMANDS) {
            const action = command.args.find((arg) => arg.name === "action")
            if (action === undefined) continue
            expect(action.choices ?? []).not.toEqual([])
            const help = helpText(command)
            for (const choice of action.choices ?? []) {
                expect(help).toContain(choice.value)
                expect(help).toContain(choice.help)
            }
        }
    })

    test("the skills command's actions in help are exactly the ones it accepts", () => {
        const spec = COMMANDS.find((command) => command.name === "skills")
        const listed = (spec?.args.find((arg) => arg.name === "action")?.choices ?? []).map(
            (choice) => choice.value,
        )
        expect(listed).toEqual([...SKILLS_ACTIONS])
    })

    test("the daemon's actions in help are exactly the ones it accepts", () => {
        const spec = COMMANDS.find((command) => command.name === "daemon")
        const listed = (spec?.args.find((arg) => arg.name === "action")?.choices ?? []).map(
            (choice) => choice.value,
        )
        // Compared against the command's own runtime list, so adding a verb in one place and not
        // the other fails here rather than at the moment somebody types it.
        expect(listed).toEqual([...DAEMON_ACTIONS])
    })

    /**
     * A declared flag that nothing reads is accepted, documented, and does nothing.
     *
     * This is the repo's most expensive recurring shape, and it has cost a debugging round six
     * times — `apiKeyEnv`, `ChatMessage.toolCalls`, `TurnInput.skills`, `ToolContext.readArtifact`,
     * `ToolContext.memoryDir`, and `init --schedules daily`, which was parsed and silently dropped
     * by an object literal three lines below its own comment describing the defect. Every instance
     * type-checks, because a conditional spread onto an object literal is not
     * excess-property-checked.
     *
     * The recorded cure is "a test at the far end that reads the value out". This is the structural
     * form of it: one guard for every flag rather than one per flag, so a new one is covered with
     * nothing to remember. Scoped to the command's own `case` block, so a name that happens to
     * appear under a *different* command does not stand in for the wiring.
     *
     * Deliberately a source-text check. It cannot prove the value reaches the command's options —
     * only that the dispatch names it, which is where every one of these has actually gone missing.
     */
    test("every declared flag is read in its own command's dispatch", () => {
        const source = readFileSync(join(SRC, "index.ts"), "utf8")
        const dispatch = (name: string): string | undefined => {
            const start = source.indexOf(`case "${name}":`)
            if (start === -1) return undefined
            const next = source.indexOf("\n        case ", start + 1)
            return source.slice(start, next === -1 ? source.length : next)
        }

        const unread: string[] = []
        for (const command of COMMANDS) {
            const block = dispatch(command.name)
            // A command with no case block is its own failure, and a louder one.
            expect(block).toBeDefined()
            for (const flag of command.flags ?? []) {
                if (block?.includes(`"${flag.name}"`) !== true) {
                    unread.push(`${command.name} --${flag.name}`)
                }
            }
        }
        expect(unread).toEqual([])
    })

    /**
     * Every command declares whether it wants a running host, and one place reads it.
     *
     * The first-run bootstrap is the most invasive thing this product does — it installs a
     * background service — so which commands trigger it must be a decision taken per command
     * rather than membership of a list somebody maintains. Required on the spec for the reason
     * `inSession` is: a new command cannot be silently absent, and cannot be silently *included*
     * either, which is the direction that matters here.
     *
     * The second half is the one that would actually rot: exactly one call site reads the field,
     * so a command cannot opt itself in or out anywhere else.
     */
    test("needsServer is declared by every command and read in one place", () => {
        for (const command of COMMANDS) {
            expect(typeof command.needsServer).toBe("boolean")
        }
        // The three that would be absurd. `serve` *is* the server, `daemon` manages the unit, and
        // a command whose job is stopping things must never start one.
        for (const name of ["serve", "daemon", "stop"]) {
            expect(COMMANDS.find((command) => command.name === name)?.needsServer).toBe(false)
        }

        const index = FILES.find((file) => file.path === "index.ts")?.text ?? ""
        expect(index).toContain("needsServer: command.needsServer")
        /**
         * Two files may *read* it and no more.
         *
         * A read is `.needsServer`, not `needsServer:` — `commands.ts` writes the field on every
         * spec and `schema.ts` declares it, and neither is a policy. `index.ts` passes it across
         * and `bootstrap.ts` acts on it. A third reader would be a second answer to "when does
         * this product install a service", which is the one question that must have one.
         */
        const readers = FILES.filter((file) => file.text.includes(".needsServer")).map(
            (file) => file.path,
        )
        expect(readers.sort()).toEqual(["index.ts", "lib/bootstrap.ts"])
    })
})

/**
 * No test may leave a background service on the machine that ran it.
 *
 * This is here because it happened. `start` declares `needsServer`, so the first spawn in
 * `lifecycle.test.ts` found no live host and installed a **real LaunchAgent** — pointing at a temp
 * store that no longer existed, loaded into launchd, still there after the suite finished. Nothing
 * failed; it was found by listing `~/Library/LaunchAgents` during an unrelated check.
 *
 * `CI` suppresses the bootstrap and is absent locally, which is exactly the wrong way round: the
 * runner is disposable and a developer's machine is the one that keeps the wreckage. So the opt-out
 * has to be explicit in every test that drives the real binary, and this is what makes forgetting
 * it a failing test rather than a plist somebody finds months later.
 */
describe("no test spawns a binary that could install a service", () => {
    test("every test that runs the CLI opts out of the first-run bootstrap", () => {
        const dir = resolve(import.meta.dirname)
        const offenders: string[] = []
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".test.ts")) continue
            const text = readFileSync(join(dir, name), "utf8")
            /**
             * Both halves: a real spawn **and** a reference to our built entry point.
             *
             * Each alone over-matches in a different direction, and both were tried. Matching the
             * path alone fires on *fixture data* — `daemon-plan.test.ts` hands a `scriptPath`
             * string to a pure function that spawns nothing. Matching the spawn alone fires on
             * `stop.test.ts`, which spawns a bare `node -e "setInterval(…)"` as something to
             * signal, and which cannot bootstrap because it never runs this CLI.
             */
            const spawns = /\b(spawn|spawnSync|spawnCaptureAsync)\s*\(/.test(text)
            const runsOurBinary = /"dist"[^\n]*"index\.js"|dist\/index\.js|\bBINARY\b/.test(text)
            if (!spawns || !runsOurBinary) continue
            /**
             * `bundle.test.ts` is exempt **on purpose**, and it is the stronger guard of the two:
             * it runs only `--version` and `--help`, and asserts `stderr` is empty. Those return
             * before the bootstrap is reached, so its silence is what proves asking for help never
             * installs anything — setting the opt-out there would throw that proof away.
             */
            if (name === "bundle.test.ts") continue
            if (!text.includes("NO_BOOTSTRAP")) offenders.push(name)
        }
        expect(offenders).toEqual([])
    })
})

describe("only the rich path moves a cursor", () => {
    test("the interactive readline is pinned out of terminal mode", () => {
        // Found by running `--plain` under a pty: Node's readline decides terminal mode from
        // `output.isTTY` rather than from the mode this CLI already resolved, so a plain run at a
        // terminal repainted its prompt with ESC[1G / ESC[0J / ESC[3G that the same command piped
        // never emitted — breaking the one property plain mode exists for.
        const run = FILES.find((file) => file.path === "run.ts")?.text ?? ""
        expect(run).toContain("createInterface({")
        expect(run).toContain("terminal: false")
    })
})

describe("hard rule 3 — the brand lives in one file", () => {
    test("no tracked path contains the brand, which is what makes the rename script correct", () => {
        /**
         * Hard rule 3's own words are *"no directory, type, interface, or variable contains"* the
         * slug — and nothing enforced the **path** half until a stray file proved why it matters.
         *
         * A `packages/cli/bin/<oldslug>.js` survived the 2026-08-19 rename and sat in the tree for
         * over a month: a dead launcher, unreferenced by `bin` and excluded from `files`, carrying
         * the previous brand **in its filename**. `git grep` could not see it, because grep searches
         * contents; and `scripts/rename-brand.ts` could not either, because it only ever rewrites
         * file contents and never renames a path (`renameSync` appears in it zero times).
         *
         * That is not a defect in the script. It is only correct *given this invariant*: if no
         * tracked path ever contains the brand, a rename has no path to rename. So the invariant is
         * what gets asserted, and the decisions log's claim that "the tree was clean" after that
         * rename was false by exactly one file — which is why this is a test rather than a note.
         *
         * A path carrying an **old** brand is not catchable here — nothing can enumerate names the
         * project has not chosen yet. What this guarantees is that no *future* rename leaves one.
         */
        const tracked = spawnCapture({
            command: "git",
            args: ["ls-files"],
            cwd: resolve(import.meta.dir, "..", "..", ".."),
        })
        expect(tracked.notFound).toBe(false)
        const offenders = tracked.stdout
            .split("\n")
            .filter((path) => path !== "" && path.toLowerCase().includes(BRAND.slug.toLowerCase()))
        expect(offenders).toEqual([])
    })

    test("no source file spells the product name", () => {
        // `rename-brand.ts` rewrites `brand.ts` and package manifests. A literal anywhere else,
        // including in a comment, goes stale on the first rename.
        // Reads the real brand rather than a copy of it. The import scope legitimately contains
        // the slug, so it is stripped before looking.
        const offenders = FILES.filter((file) =>
            file.text.replaceAll(BRAND.packageScope, "").toLowerCase().includes(BRAND.slug),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    /**
     * The root config files a rename has to carry with it, guarded by their **consequence** rather
     * than by the rename script's own classification.
     *
     * `rename-brand.ts` *reports* a file it leaves alone, and a report is what made this a
     * two-commit problem once already (decision 11.142, the Dockerfile). Three more were found
     * adding the compose file: `.gitignore`, `.dockerignore` and the reference manifest. The
     * sharpest was `.gitignore` — renamed, it would go on ignoring the old state directory and
     * stop ignoring the new one, so the next `git add` offers up a `store.db` full of
     * conversation history.
     *
     * Asserting the script's straggler list is empty is **not** the guard, and believing otherwise
     * cost a round: a file can be both rewritten (its `@scope` imports) and reported (it mentions
     * the brand for some other reason), so that list has 35 legitimate entries and a test over it
     * would be red for correct code. These read the derived values out of the real `BRAND`
     * instead, so they go red on a stale file however the script decides to treat it.
     */
    const rootFile = (name: string) => readFileSync(join(SRC, "..", "..", "..", name), "utf8")

    test("both ignore files ignore the state directory", () => {
        for (const name of [".gitignore", ".dockerignore"]) {
            expect(rootFile(name)).toContain(BRAND.stateDir)
        }
    })

    test("the compose front door names the token variable the runtime reads", () => {
        // `serve` refuses a non-loopback bind without this variable, and the image binds
        // 0.0.0.0 — so a stale name here is a `docker compose up` that fails at the refusal with
        // a correct message about a variable the compose file never sets.
        const token = `${BRAND.envPrefix}API_TOKEN`
        expect(rootFile("docker-compose.yml")).toContain(token)
        expect(rootFile(".env.example")).toContain(token)
    })

    test("the compose file does not override the image's command", () => {
        // The image's CMD carries `--host 0.0.0.0`. A compose `command:` replaces CMD wholesale,
        // so adding one drops the host flag and the process listens on loopback inside the
        // container — which no published port can reach. It builds, starts, reports healthy and
        // answers nothing, which is the failure with the least to go on.
        const compose = rootFile("docker-compose.yml")
        const directives = compose
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .map((line) => line.trim())
        expect(directives.filter((line) => line.startsWith("command:"))).toEqual([])
        // Same argument for the healthcheck: two definitions to keep in step, and this one wins.
        expect(directives.filter((line) => line.startsWith("healthcheck:"))).toEqual([])
    })
})

describe("the image can build what the repo builds", () => {
    /** The Dockerfile split at its stage boundaries, so a claim can be made about one stage. */
    function stages(): { readonly builder: string; readonly runtime: string } {
        const dockerfile = readFileSync(join(SRC, "..", "..", "..", "docker", "Dockerfile"), "utf8")
        const parts = dockerfile.split(/^FROM /m)
        const builder = parts.find((part) => part.includes("AS builder")) ?? ""
        const runtime = parts.find((part) => part.includes("AS runtime")) ?? ""
        expect(builder).not.toBe("")
        expect(runtime).not.toBe("")
        return { builder, runtime }
    }

    test("the builder copies every workspace package's manifest", () => {
        // A hand-kept list of workspace members, and it bit immediately: adding a new workspace
        // package to the root `build` script broke the image, because `bun install` inside the
        // builder never saw that package and core then would not resolve from it. The failure is a
        // `TS2307` in a container build — far from the edit that caused it, and invisible until
        // somebody builds the image. Derived here instead.
        //
        // **Once, not twice.** This asserted two copies until 15.5, because both stages installed:
        // the builder to link the workspace, the runtime to install production dependencies. The
        // runtime stage has no install any more — the application is one compiled binary — so a
        // second copy would be a stage doing work nothing needs.
        const { builder } = stages()
        const packages = readdirSync(join(SRC, "..", ".."), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
        const missing = packages.filter(
            (name) =>
                (builder.match(new RegExp(`^COPY packages/${name}/package\\.json `, "gm")) ?? [])
                    .length !== 1,
        )
        expect(missing).toEqual([])
    })

    test("the runtime stage installs nothing and carries no source", () => {
        // The property that makes one manifest copy correct, and it is worth locking rather than
        // implying. A runtime `bun install --production` is how ~17 MB of `react-devtools-core`
        // reached every shipped image: `ink` declares it a **peerDependency**, so `--production`
        // does not skip it. Deleting the install is what makes that unrepresentable; reintroducing
        // one would restore the cost silently, and the image would still work.
        //
        // No `COPY packages/` either: the whole application is the compiled binary, so a `dist/`
        // arriving in the runtime stage means something is being resolved at boot that should have
        // been bundled.
        const { runtime } = stages()
        expect(runtime).not.toContain("bun install")
        expect(runtime.match(/^COPY packages\//m)).toBeNull()
        // And the binary is there, which is the other half of "the application is one file".
        expect(runtime).toContain("COPY --from=builder")
    })
})

describe("the process actually leaves", () => {
    test("the entry point exits deliberately rather than waiting for the loop", () => {
        // `finish` sets `process.exitCode` and lets the event loop empty, which assumes the loop can
        // empty. A command that boots a runtime leaves a keep-alive socket to the tool provider in
        // Node's global `fetch` pool, so it does not: measured at 180 seconds still alive after
        // `/exit`, and the `tools` command killed at 30. Reverting the last line to `finish(code)` restores
        // the hang and changes nothing else, which is why it is asserted from the source text.
        const entry = FILES.find((file) => file.path === "index.ts")?.text ?? ""
        expect(entry).toContain("finishNow(code)")
        expect(entry).not.toContain("=> finish(code)")
    })

    test("no command exits on its own, so the drain is never skipped", () => {
        // The other half: the exit is safe only because `finish` has already flushed stdout. A command
        // calling `process.exit` itself skips the teardowns and the drain both, which is the truncation
        // the entry point's docstring has forbidden since Phase 2 — `lib/exit.ts` is the one exception.
        const offenders = FILES.filter(
            (file) => file.path !== "lib/exit.ts" && /(?<!\.)\bprocess\.exit\(/.test(file.text),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })
})

test("every session command in the table is handled by the chat", () => {
    // `/status` was declared in `SESSION_COMMANDS`, advertised in `/help`, generated into the palette —
    // and had no `case` in `App.tsx`, so it fell out of the switch and was billed to the model as prose.
    // TypeScript cannot catch it: `SessionCommand`'s first member is `{kind: SessionCommandKind}` and the
    // switch carries no exhaustiveness guard, so a missing arm is a fall-through rather than an error.
    //
    // Same shape as the CLI-command test below and as `DOCUMENTED_CTRL_LETTERS` — the drift this repo
    // keeps paying for is a table that grows a row while the thing consuming it does not.
    const app = FILES.find((file) => file.path === "components/App.tsx")?.text ?? ""
    expect(SESSION_COMMANDS.length).toBeGreaterThan(0)
    // Collected rather than asserted per row: `toContain` against a 1,000-line file prints the whole
    // file as the diff, which is a guard nobody can read the failure of. This prints the words.
    const unhandled = SESSION_COMMANDS.filter(
        (command) => !app.includes(`case "${command.kind}"`),
    ).map((command) => command.word)
    expect(unhandled).toEqual([])
})

test("every command in the table is wired to an implementation", () => {
    // The entry point throws for an unwired command, but only when someone runs it. This catches it
    // at test time instead.
    const entry = FILES.find((file) => file.path === "index.ts")?.text ?? ""
    expect(COMMANDS.length).toBeGreaterThan(0)
    for (const command of COMMANDS) {
        expect(entry).toContain(`case "${command.name}"`)
    }
})

test("an event a person must see is handled on BOTH output paths", () => {
    /**
     * The two paths reach the same events by different routes, and a gap in either is invisible.
     *
     * The rich path's reducer takes everything and falls into `default`, silently doing nothing for
     * a type it does not name. The plain path used *named* subscriptions, where the same event was
     * simply absent — and since 17.1 it takes one wildcard from the source and switches, which
     * makes both paths the same shape and this check the same string on both. That is a small win
     * on its own: the asymmetry this test was written to police is gone, and what is left is the
     * ordinary risk that somebody adds an event and handles it in one place.
     */
    const transcript = FILES.find((file) => file.path === "transcript.ts")?.text ?? ""
    const plain = FILES.find((file) => file.path === "run.ts")?.text ?? ""

    for (const type of ["tool.gated", "context.dropped"]) {
        expect(transcript).toContain(`case "${type}"`)
        expect(plain).toContain(`case "${type}"`)
    }

    // And the plain path takes its stream from the source rather than a bus it happens to hold —
    // without which an attached run would print no tokens at all and look like a hung model.
    expect(plain).toContain("wired.source.subscribe(")
})

test("every way a turn can end has a sentence, on one shared formatter", () => {
    // `endNote` lives in core and is called by the plain path, the transcript reducer and the channel
    // delivery path. Three formatters is how the same ending came to be described three ways and
    // reported on one surface: `stats.reason` reached the transcript and was rendered nowhere, and the
    // plain path's `max_steps` line printed only when the reply was empty.
    const plain = FILES.find((file) => file.path === "run.ts")?.text ?? ""
    const transcript = FILES.find((file) => file.path === "transcript.ts")?.text ?? ""
    expect(plain).toContain("endNote(")
    expect(transcript).toContain("endNote(")
    // And the exit code comes off the same union, so a new reason cannot exit 0 by omission.
    expect(plain).toContain("endedBadly(")
})

test("a blocked write is reported even when tool rows are suppressed", () => {
    // `showRows` hides tool chatter in one-shot and --quiet runs, because something is parsing the
    // output. A gate refusal is the exception: it means the run did less than it was asked to.
    const plain = FILES.find((file) => file.path === "run.ts")?.text ?? ""
    const handler = plain.slice(plain.indexOf('runtime.bus.on("tool.gated"'))
    const body = handler.slice(0, handler.indexOf("}),"))
    expect(body.includes("showRows")).toBe(false)
})

describe("first-party packages use only the public core API", () => {
    /**
     * The premise of the plugin API, asserted rather than trusted.
     *
     * `03-SPEC-PLUGIN-API.md` opens by saying that if a first-party package needs something the
     * plugin API cannot express, **the API is wrong and gets fixed** — no private back doors. That
     * promise is worth exactly as much as the thing checking it: a deep import into `@dispach/core/src`
     * or a relative reach across package boundaries would keep every test green while quietly making
     * the first-party packages a privileged class that third-party ones cannot imitate.
     *
     * Scanned as text rather than by importing, so a package that would not even compile against the
     * public surface is still caught.
     */
    const PACKAGES = resolve(import.meta.dirname, "..", "..")
    const FIRST_PARTY = ["channel-telegram", "tools-composio", "tools-system", "tools-web"]

    const EXTERNAL = FIRST_PARTY.flatMap((name) => {
        const dir = join(PACKAGES, name, "src")
        return sourceFiles(dir).map((path) => ({
            package: name,
            path: relative(PACKAGES, path),
            text: readFileSync(path, "utf8"),
        }))
    })

    test("nothing reaches past the package root of @dispach/core", () => {
        // `@dispach/core/src/...`, `@dispach/core/dist/...` — anything but the bare specifier.
        const offenders = EXTERNAL.filter((file) =>
            /from\s*["']@dispach\/core\/[^"']+["']/.test(file.text),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    test("nothing reaches into another package by relative path", () => {
        const offenders = EXTERNAL.filter((file) =>
            /from\s*["']\.\.\/\.\.\/[^"']*(?:core|channel-|tools-)[^"']*["']/.test(file.text),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    test("each one is a plugin: a default export the loader can read", () => {
        // The acceptance criterion is that these packages *live on* the API rather than beside it.
        // A package that exports a factory and no plugin is still wired the old way.
        for (const name of FIRST_PARTY) {
            const index = readFileSync(join(PACKAGES, name, "src", "index.ts"), "utf8")
            expect({ name, hasPlugin: /export default \{/.test(index) }).toEqual({
                name,
                hasPlugin: true,
            })
        }
    })
})
