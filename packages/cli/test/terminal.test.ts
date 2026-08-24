/**
 * Detecting a terminal, and the change each one needs.
 *
 * The recipes are asserted for *shape* rather than against a real terminal, deliberately — the same rule
 * the curated skills list follows. A test that launched Ghostty to check its config syntax would start
 * failing when somebody else changes Ghostty, which is a fact about Ghostty and not about this code. What
 * is checked here is that the line contains the sequence, that the marker would find it again, and that
 * the file surgery keeps whatever was already there.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRAND } from "@dispach/core"
import {
    alreadyConfigured,
    detectTerminal,
    knownTerminals,
    recipeFor,
    SHIFT_ENTER_SEQUENCE,
    withBinding,
} from "#lib/terminal"
import { terminalSetupCommand } from "#terminal-setup"

describe("detection", () => {
    test("each terminal is recognised by what it actually sets", () => {
        expect(detectTerminal({ TERM_PROGRAM: "vscode" })).toBe("vscode")
        expect(detectTerminal({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2")
        expect(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe("apple")
        expect(detectTerminal({ TERM: "xterm-kitty" })).toBe("kitty")
        expect(detectTerminal({ KITTY_WINDOW_ID: "1" })).toBe("kitty")
        expect(detectTerminal({ WEZTERM_PANE: "0" })).toBe("wezterm")
        expect(detectTerminal({ GHOSTTY_RESOURCES_DIR: "/x" })).toBe("ghostty")
    })

    test("Warp is recognised, and its one step is the Option key", () => {
        // Two corrections deep. It was `unverified`; the kitty protocol made the arrow chords work so it
        // became `none`, "nothing to configure"; and then ⌥r turned out to still arrive as the composed
        // character `®`, because Warp resolves Option to a character before the protocol sees the key. So
        // there is a step, it is a Warp setting rather than a file, and it buys only the letter chords.
        expect(detectTerminal({ TERM_PROGRAM: "WarpTerminal" })).toBe("warp")
        expect(recipeFor("warp")?.how).toBe("explain")
        expect(recipeFor("warp")?.steps?.[0]).toContain("Meta")
    })

    test("`unverified` is still reachable vocabulary, and nothing ships using it", () => {
        // Warp was the only one, so this branch has no shipped instance — and unlike the short-lived
        // `none` state, it is worth keeping: the next terminal nobody has checked needs exactly it, and
        // the alternative (calling an unchecked terminal "unrecognised") is a lie about what we know.
        // Asserted rather than assumed, so if it ever becomes false the branch has a real user and this
        // test is the thing to delete.
        expect(knownTerminals().filter((recipe) => recipe.how === "unverified")).toEqual([])
    })

    test("an unknown terminal is unknown, not guessed at", () => {
        // A wrong guess writes a binding into a file the terminal never reads, and then reports that
        // shift+enter works.
        expect(detectTerminal({ TERM: "xterm-256color" })).toBe("unknown")
        expect(detectTerminal({})).toBe("unknown")
    })

    test("VS Code wins over the emulator hosting it", () => {
        // Its integrated terminal runs inside another emulator's environment, and the innermost one is
        // the one whose key bindings apply.
        expect(detectTerminal({ TERM_PROGRAM: "vscode", TERM: "xterm-kitty" })).toBe("vscode")
    })
})

describe("the recipes", () => {
    test("every one either writes a file or explains itself", () => {
        for (const recipe of knownTerminals()) {
            if (recipe.how === "write") {
                expect(recipe.configPath).toBeDefined()
                expect(recipe.line).toBeDefined()
                expect(recipe.marker).toBeDefined()
            } else {
                // Explained or unverified, it still has to say why and point somewhere useful.
                // A terminal that cannot be written has to say why, or the message reads as a shrug.
                expect(recipe.reason).toBeDefined()
                expect((recipe.steps ?? []).length).toBeGreaterThan(0)
            }
        }
    })

    test("a marker finds the line it belongs to", () => {
        // Otherwise a second run appends a duplicate binding whose behaviour depends on which the
        // terminal reads last.
        for (const recipe of knownTerminals()) {
            if (recipe.how !== "write") continue
            expect(alreadyConfigured(recipe.line ?? "", recipe)).toBe(true)
            expect(alreadyConfigured("nothing relevant here\n", recipe)).toBe(false)
        }
    })

    test("every written line carries the sequence Ink parses", () => {
        // `CSI 13;2u` is the whole point; a recipe missing it would configure a chord that sends
        // something the runtime does not recognise.
        const escaped = SHIFT_ENTER_SEQUENCE.replace("\u001B", "")
        for (const recipe of knownTerminals()) {
            if (recipe.how !== "write") continue
            expect(recipe.line).toContain(escaped)
        }
    })

    test("no config path is absolute — they are all relative to home", () => {
        for (const recipe of knownTerminals()) {
            expect(recipe.configPath?.startsWith("/") ?? false).toBe(false)
        }
    })
})

/** The recipe, or a failure that names which one is missing. */
function must(id: Parameters<typeof recipeFor>[0]) {
    const recipe = recipeFor(id)
    if (recipe === undefined) throw new Error(`no recipe for ${id}`)
    return recipe
}

describe("editing the file", () => {
    test("an existing config keeps everything it had", () => {
        const recipe = must("ghostty")
        const before = "theme = dark\nfont-size = 13\n"
        const after = withBinding(before, recipe)
        expect(after).toContain("theme = dark")
        expect(after).toContain("font-size = 13")
        expect(after).toContain("shift+enter")
    })

    test("a missing config becomes a one-line file", () => {
        expect(withBinding("", must("kitty"))).toBe(`${must("kitty").line}\n`)
    })

    test("VS Code's binding goes inside the array, not after it", () => {
        // Appending would produce a file that is not JSON, and VS Code silently ignores the whole thing.
        const before = '[\n    { "key": "cmd+k", "command": "noop" }\n]\n'
        const after = withBinding(before, must("vscode")) ?? ""
        expect(after.trim().startsWith("[")).toBe(true)
        expect(after.trim().endsWith("]")).toBe(true)
        expect(after).toContain("cmd+k")
        expect(JSON.parse(after.replace(/\/\/.*$/gm, ""))).toHaveLength(2)
    })

    test("an empty VS Code array is handled without a stray comma", () => {
        const after = withBinding("[]", must("vscode")) ?? ""
        expect(JSON.parse(after)).toHaveLength(1)
    })

    test("a file that is not the expected shape is refused rather than mangled", () => {
        // A broken keybindings file is a worse outcome than an unconfigured chord.
        expect(withBinding("this is not json at all", must("vscode"))).toBeUndefined()
    })
})

describe("the command", () => {
    function home(): string {
        return mkdtempSync(join(tmpdir(), "terminal-setup-"))
    }

    test("--dry-run writes nothing and says so", async () => {
        const dir = home()
        const lines: string[] = []
        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string) => {
            lines.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        try {
            const code = await terminalSetupCommand({
                env: { TERM: "xterm-kitty" },
                home: dir,
                dryRun: true,
            })
            expect(code).toBe(0)
        } finally {
            process.stdout.write = write
        }
        expect(lines.join("")).toContain("nothing was written")
        expect(() => readFileSync(join(dir, ".config/kitty/kitty.conf"), "utf8")).toThrow()
    })

    test("--yes writes the file and keeps a backup of the old one", async () => {
        const dir = home()
        const path = join(dir, ".config/kitty/kitty.conf")
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, "font_size 13\n", "utf8")

        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = (() => true) as typeof process.stdout.write
        try {
            const code = await terminalSetupCommand({
                env: { TERM: "xterm-kitty" },
                home: dir,
                yes: true,
            })
            expect(code).toBe(0)
        } finally {
            process.stdout.write = write
        }

        const after = readFileSync(path, "utf8")
        expect(after).toContain("font_size 13")
        expect(after).toContain("shift+enter")
        // The backup is beside the file, so whoever goes looking finds it.
        expect(readFileSync(`${path}.${BRAND.slug}-backup`, "utf8")).toBe("font_size 13\n")
    })

    test("a second run reports it is already configured rather than duplicating", async () => {
        const dir = home()
        const write = process.stdout.write.bind(process.stdout)
        const lines: string[] = []
        process.stdout.write = ((chunk: string) => {
            lines.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        try {
            await terminalSetupCommand({ env: { TERM: "xterm-kitty" }, home: dir, yes: true })
            lines.length = 0
            await terminalSetupCommand({ env: { TERM: "xterm-kitty" }, home: dir, yes: true })
        } finally {
            process.stdout.write = write
        }
        expect(lines.join("")).toContain("already configured")
        const after = readFileSync(join(dir, ".config/kitty/kitty.conf"), "utf8")
        expect(after.split("shift+enter")).toHaveLength(2)
    })

    test("declining writes nothing, and is not an error", async () => {
        const dir = home()
        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = (() => true) as typeof process.stdout.write
        try {
            const code = await terminalSetupCommand({
                env: { TERM: "xterm-kitty" },
                home: dir,
                confirm: async () => false,
            })
            // Declining is a legitimate answer and the line was printed to copy.
            expect(code).toBe(0)
        } finally {
            process.stdout.write = write
        }
        expect(() => readFileSync(join(dir, ".config/kitty/kitty.conf"), "utf8")).toThrow()
    })

    test("no confirm function means no, so a piped run changes nothing", async () => {
        const dir = home()
        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = (() => true) as typeof process.stdout.write
        try {
            await terminalSetupCommand({ env: { TERM: "xterm-kitty" }, home: dir })
        } finally {
            process.stdout.write = write
        }
        expect(() => readFileSync(join(dir, ".config/kitty/kitty.conf"), "utf8")).toThrow()
    })

    test("an unrecognised terminal exits non-zero and names what it saw", async () => {
        const lines: string[] = []
        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string) => {
            lines.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        let code = 0
        try {
            code = await terminalSetupCommand({ env: { TERM: "dumb" }, home: home() })
        } finally {
            process.stdout.write = write
        }
        expect(code).toBe(1)
        expect(lines.join("")).toContain("not recognised")
        // And says the chord that does work regardless, so the answer is not only bad news.
        expect(lines.join("")).toContain("⌥⏎")
    })

    test("a terminal configured in its own settings is explained, and exits zero", async () => {
        const lines: string[] = []
        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string) => {
            lines.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        let code = 1
        try {
            code = await terminalSetupCommand({
                env: { TERM_PROGRAM: "WarpTerminal" },
                home: home(),
            })
        } finally {
            process.stdout.write = write
        }
        expect(code).toBe(0)
        expect(lines.join("")).toContain("Warp")
        expect(lines.join("")).toContain("has to be done by hand")
        expect(lines.join("")).toContain("Meta")
        // Not "nobody has checked it": somebody has, and the answer is a named setting.
        expect(lines.join("")).not.toContain("no verified recipe")
    })

    test("an explain-only terminal prints steps and exits zero", async () => {
        const lines: string[] = []
        const write = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string) => {
            lines.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        let code = 1
        try {
            code = await terminalSetupCommand({
                env: { TERM_PROGRAM: "iTerm.app" },
                home: home(),
            })
        } finally {
            process.stdout.write = write
        }
        expect(code).toBe(0)
        expect(lines.join("")).toContain("Key Mappings")
        // And says why it cannot be done for you, rather than reading as a shrug.
        expect(lines.join("")).toContain("binary plist")
    })
})
