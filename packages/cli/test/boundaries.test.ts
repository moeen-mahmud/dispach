/**
 * Structural guards.
 *
 * These assert facts about the source tree rather than about behaviour, because the facts are
 * expensive to check by hand and silent when broken. The lazy-Ink boundary in particular fails
 * invisibly: adding `import { Text } from "ink"` to a command module keeps every test passing and
 * every output identical, while quietly adding ~200 ms to every invocation of every command.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { BRAND } from "@dispach/core"
import { DAEMON_ACTIONS } from "#daemon"
import { COMMANDS } from "#lib/commands"
import { helpText } from "#lib/help"
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
    // The two paths subscribe differently, and that asymmetry is a real trap. The rich path uses
    // `bus.on("*")`, so a new event type reaches the reducer for free — and falls into its
    // `default` case, silently doing nothing. The plain path uses named subscriptions, so the same
    // event is simply absent. Either way the failure is invisible, which is the worst shape for a
    // blocked write. Pinned rather than left to vigilance.
    const transcript = FILES.find((file) => file.path === "transcript.ts")?.text ?? ""
    const plain = FILES.find((file) => file.path === "run.ts")?.text ?? ""

    for (const type of ["tool.gated", "context.dropped"]) {
        expect(transcript).toContain(`case "${type}"`)
        expect(plain).toContain(`runtime.bus.on("${type}"`)
    }
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
