/**
 * In-session commands, and the property that makes the help trustworthy.
 *
 * The last suite here is the point of the file. Command help is *generated* from the table, so it
 * cannot drift. Key-binding help cannot be generated — `keyToIntent` is a function, and what `^C`
 * means depends on whether a turn is running — so the loop is closed from both ends instead: every
 * documented chord must produce a real intent, and every chord that produces one must be documented.
 * That is what caught five working bindings the old hand-written string never mentioned.
 */

import { describe, expect, test } from "bun:test"
import { type KeyContext, keyToIntent } from "#keymap"
import {
    contextReport,
    DOCUMENTED_CTRL_LETTERS,
    DOCUMENTED_META_LETTERS,
    KEY_BINDINGS,
    META_LETTERS_THAT_ARE_ARROWS,
    resolveSessionCommand,
    SESSION_COMMANDS,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import type { KeyState } from "#lib/types"

describe("recognising a command", () => {
    test("every canonical word resolves to its own kind", () => {
        for (const spec of SESSION_COMMANDS) {
            expect(resolveSessionCommand(spec.word)).toEqual({ kind: spec.kind })
        }
    })

    test("every alias resolves to the same kind as its word", () => {
        for (const spec of SESSION_COMMANDS) {
            for (const alias of spec.aliases) {
                expect(resolveSessionCommand(alias)).toEqual({ kind: spec.kind })
            }
        }
    })

    test("case and surrounding whitespace do not matter", () => {
        expect(resolveSessionCommand("  /HELP  ")).toEqual({ kind: "help" })
        expect(resolveSessionCommand("/Tools")).toEqual({ kind: "tools" })
    })
})

describe("/new and /reset are the pair a person picks between", () => {
    /**
     * They read as synonyms and are not: one keeps the conversation and one destroys it. The names cannot
     * carry that — "new" and "reset" both mean "start over" in ordinary use — so the summaries have to,
     * and this is the only place a person sees them side by side.
     */
    const summaryOf = (kind: string) =>
        SESSION_COMMANDS.find((spec) => spec.kind === kind)?.summary ?? ""

    test("the destructive one says it clears in place, keeping the key", () => {
        expect(summaryOf("reset")).toContain("in place")
        expect(summaryOf("reset")).toContain("key")
    })

    test("the other says the conversation survives, and how to get back to it", () => {
        expect(summaryOf("new")).toContain("stays in the store")
        expect(summaryOf("new")).toContain("/sessions")
    })

    test("and they do not read the same", () => {
        expect(summaryOf("new")).not.toBe(summaryOf("reset"))
    })
})

describe("what is a prompt and not a command", () => {
    // Each of these is a thing someone genuinely says to an agent. Refusing any of them would cost
    // a real message to save a typo.
    test.each([
        ["ordinary prose", "what time is it"],
        ["an absolute path", "/etc/passwd is world-readable, is that expected?"],
        ["a path alone", "/usr/local/bin"],
        ["a slash inside a word", "read the and/or clause back to me"],
        ["a command mentioned in a sentence", "what does /help print"],
        ["nothing at all", ""],
    ])("%s goes to the model", (_label, text) => {
        expect(resolveSessionCommand(text)).toBeUndefined()
    })
})

describe("a word that meant to be a command", () => {
    test("a near miss names the nearest match", () => {
        expect(resolveSessionCommand("/tols")).toEqual({
            kind: "unknown",
            word: "/tols",
            nearest: "/tools",
        })
    })

    test("nothing close enough suggests nothing rather than something wrong", () => {
        // A bad suggestion is worse than none — it sends someone off to read about the wrong thing.
        const command = resolveSessionCommand("/subscribe")
        if (command === undefined || command.kind !== "unknown") {
            throw new Error(`expected an unknown-command result, got ${JSON.stringify(command)}`)
        }
        expect(command.nearest).toBeUndefined()
    })

    test("the refusal says how to send it to the model instead", () => {
        const text = unknownCommandText({ word: "/tols", nearest: "/tools" })
        expect(text).toContain("/tols is not a command")
        expect(text).toContain("/tools")
        expect(text).toContain("/help")
    })
})

describe("help text is generated, not written", () => {
    test("every command word appears", () => {
        const help = sessionHelpText()
        for (const spec of SESSION_COMMANDS) {
            expect(help).toContain(spec.word)
            for (const alias of spec.aliases) expect(help).toContain(alias)
            expect(help).toContain(spec.summary)
        }
    })

    test("every key binding appears", () => {
        const help = sessionHelpText()
        for (const binding of KEY_BINDINGS) {
            expect(help).toContain(binding.chord)
            expect(help).toContain(binding.summary)
        }
    })
})

describe("/tools", () => {
    const VIEW = {
        dialect: "nlt",
        catalogueTokens: 412,
        tools: [
            {
                slug: "now",
                mutating: false,
                trust: "trusted",
                summary: "the current date and time",
            },
            { slug: "memory_write", mutating: true, trust: "trusted", summary: "append a note" },
        ],
    }

    test("reports the count, the call format, and what slot 1 costs every turn", () => {
        const report = toolsReport(VIEW)
        expect(report).toContain("2 tools")
        expect(report).toContain("call format nlt")
        expect(report).toContain("412 tokens")
        // "dialect nlt" led this line once and read as a third tool. The count leads now, and the
        // protocol is labelled rather than named, because the name means nothing to a reader.
        expect(report.includes("dialect nlt")).toBe(false)
    })

    test("marks a mutating tool as a write", () => {
        const lines = toolsReport(VIEW).split("\n")
        expect(lines.find((line) => line.includes("memory_write"))).toContain("write")
        expect(lines.find((line) => line.includes("now"))).toContain("read")
    })

    test("an agent with no tools says so, and says where they would go", () => {
        const report = toolsReport({ dialect: "nlt", catalogueTokens: 0, tools: [] })
        expect(report).toContain("no tools")
        expect(report).toContain("tools.local")
    })

    test("projects a live agent's description and catalogue", () => {
        const view = toolsView({
            describe: () => ({ dialect: "native", catalogueTokens: 0, window: 32_768 }),
            tools: {
                specs: () => [
                    {
                        slug: "now",
                        mutating: false,
                        summary: "the current date and time",
                        provider: "local",
                    },
                ],
            },
        })
        expect(view).toEqual({
            dialect: "native",
            catalogueTokens: 0,
            tools: [
                {
                    slug: "now",
                    mutating: false,
                    // Absent on the spec, settled here. The registry normalises it for anything it
                    // resolved, so this fallback only fires for a spec built by hand — and printing
                    // an empty column would be the wrong way to discover that.
                    trust: "trusted",
                    summary: "the current date and time",
                },
            ],
        })
    })
})

// ─── the drift loop ──────────────────────────────────────────────────────────────────────

const NO_KEYS: KeyState = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    home: false,
    end: false,
    super: false,
}

/** Both, because `^C` and `^D` answer differently depending on which one holds. */
const CONTEXTS: readonly KeyContext[] = [
    {
        busy: false,
        empty: true,
        firstLine: true,
        lastLine: true,
        searching: false,
        armed: false,
        scrolled: false,
    },
    {
        busy: true,
        empty: false,
        firstLine: true,
        lastLine: true,
        searching: false,
        armed: false,
        scrolled: false,
    },
]

function honoured(letter: string): boolean {
    return CONTEXTS.some(
        (context) => keyToIntent(letter, { ...NO_KEYS, ctrl: true }, context).kind !== "none",
    )
}

function honouredWithMeta(letter: string): boolean {
    return CONTEXTS.some(
        (context) => keyToIntent(letter, { ...NO_KEYS, meta: true }, context).kind !== "none",
    )
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("")

describe("documented bindings and real bindings are the same set", () => {
    test("every documented chord is one the prompt actually honours", () => {
        for (const letter of DOCUMENTED_CTRL_LETTERS) {
            expect(honoured(letter)).toBe(true)
        }
    })

    test("every chord the prompt honours is documented", () => {
        const documented = new Set(DOCUMENTED_CTRL_LETTERS)
        const missing = ALPHABET.filter((letter) => honoured(letter) && !documented.has(letter))
        expect(missing).toEqual([])
    })

    test("every documented option chord is one the prompt actually honours", () => {
        // This arm did not exist, and its absence is the whole reason `⌥r` could be documented in the
        // table, bound in the keymap, handled in `App.tsx`, and still reach nothing — the ctrl loop below
        // has been two-way since Phase 2 and the option chords were simply never walked.
        for (const letter of DOCUMENTED_META_LETTERS) {
            expect(honouredWithMeta(letter), letter).toBe(true)
        }
    })

    test("every option chord the prompt honours is documented", () => {
        const documented = new Set([...DOCUMENTED_META_LETTERS, ...META_LETTERS_THAT_ARE_ARROWS])
        const missing = ALPHABET.filter(
            (letter) => honouredWithMeta(letter) && !documented.has(letter),
        )
        expect(missing).toEqual([])
    })

    test("the arrows are documented too", () => {
        expect(keyToIntent("", { ...NO_KEYS, upArrow: true }, CONTEXTS[0] as KeyContext).kind).toBe(
            "historyPrev",
        )
        expect(sessionHelpText()).toContain("↑ / ↓")
    })
})

describe("/tools shows trust", () => {
    test("an untrusted tool is labelled, because it is what blocks a later write", () => {
        const report = toolsReport({
            dialect: "nlt",
            catalogueTokens: 855,
            tools: [
                { slug: "now", mutating: false, trust: "trusted", summary: "the time" },
                { slug: "exec", mutating: true, trust: "untrusted", summary: "a shell command" },
            ],
        })
        // "Why was my second exec blocked?" is answered by this column and nothing else here.
        expect(report).toContain("untrusted")
        expect(report).toContain("trusted")
        // The header counts tools and names the protocol as a protocol — `dialect nlt` leading the
        // line once read as a third tool.
        expect(report).toContain("2 tools · call format nlt")
    })
})

describe("contextReport", () => {
    const view = {
        slots: [
            { slot: 0, label: "identity", tokens: 412, pinned: true },
            { slot: 1, label: "tools", tokens: 688, pinned: true },
            { slot: 9, label: "history", tokens: 1464, pinned: false },
        ],
        total: 2564,
        window: 393_216,
        windowSource: "registry deepseek-v4-flash*",
        wireTokens: 0,
        reserveOutput: 8192,
        calibration: { ratio: 1, samples: 0 },
        lastCompaction: undefined,
        history: [],
        cache: undefined,
    }

    test("the budget is written as its subtraction, not as a result", () => {
        // The whole reason this screen exists. `ctx 61%` has never said what it is 61% *of*, and the
        // denominator is not the window: `assembleContext` is handed `window − wireTokens` and then
        // subtracts `reserveOutput` from that. A reader who disagrees with the number can see which
        // term they disagree with.
        const out = contextReport(view)
        expect(out).toContain("385024 = window 393216 − wire 0 − reserveOutput 8192")
    })

    test("the percentage divides by the budget, never by the window", () => {
        // 2564/385024 is 0.7%; 2564/393216 is 0.65%. Close enough to look right and wrong for the
        // reason the report exists, which is why the assertion is on the figure rather than the shape.
        expect(contextReport(view)).toContain("2564 tokens · 0.7% of budget")
    })

    test("wireTokens is a real term and moves the budget", () => {
        // Zero under `nlt` and non-zero under `native`, where the catalogue rides in the request body
        // and is charged without ever being a block.
        const out = contextReport({ ...view, wireTokens: 1200 })
        expect(out).toContain("383824 = window 393216 − wire 1200 − reserveOutput 8192")
    })

    test("an uncalibrated session says the number is a raw estimate", () => {
        // The estimator runs 16-20% low on tool-heavy prompts — the overflow direction, exactly when
        // the window is tight. A percentage with no samples behind it carries that bias untouched.
        expect(contextReport(view)).toContain("estimated")
        expect(contextReport(view)).toContain("runs low")
    })

    test("a calibrated one says by how much, and how many figures back it", () => {
        const out = contextReport({ ...view, calibration: { ratio: 1.18, samples: 4 } })
        expect(out).toContain("corrected ×1.18 from 4 reported figures")
        expect(out.includes("estimated")).toBe(false)
    })

    test("every slot is listed with its number, and pinning is marked", () => {
        const out = contextReport(view)
        expect(out).toContain("identity")
        expect(out).toContain("history")
        // Pinned blocks survive every compaction stage including S5, so which ones they are is the
        // difference between a prompt that can shrink and one that cannot.
        const historyRow = out.split("\n").find((line) => line.includes("history")) ?? ""
        expect(historyRow.includes("pinned")).toBe(false)
        const identityRow = out.split("\n").find((line) => line.includes("identity")) ?? ""
        expect(identityRow).toContain("pinned")
    })

    test("a session with no compaction says so rather than leaving the row out", () => {
        // `keyValue` drops an empty value, and a missing row reads as "no such concept" — the same
        // reason slot 2 prints `none` for an absent capability instead of omitting the line.
        expect(contextReport(view)).toContain("none this session")
        expect(contextReport({ ...view, lastCompaction: "3 stages run this session" })).toContain(
            "3 stages run this session",
        )
    })
})
