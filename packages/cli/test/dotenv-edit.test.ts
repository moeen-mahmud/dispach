/**
 * `upsertEnv` — one variable set in a `.env` without disturbing the rest.
 *
 * The assertions that matter are the round-trip ones. This module writes and `parseDotEnv` reads, and
 * they are the only two things that have to agree about quoting; asserting the written text alone would
 * check the half nobody consumes.
 */

import { describe, expect, test } from "bun:test"
import { parseDotEnv } from "@dispach/core"
import { renderEnvValue, upsertEnv } from "#lib/dotenv-edit"

const FILE = `# The endpoint's key. From the dashboard, not from a chat log.
MODEL_API_KEY=sk-old
# A bot token — @BotFather, /newbot.
TELEGRAM_BOT_TOKEN=
`

describe("upsertEnv", () => {
    test("replaces in place and keeps every comment", () => {
        const { text, replaced } = upsertEnv(FILE, "MODEL_API_KEY", "sk-new")
        expect(replaced).toBe(true)
        expect(text).toBe(FILE.replace("sk-old", "sk-new"))
    })

    test("replacing in place is what stops a second, shadowing assignment", () => {
        // `parseDotEnv` takes the last one, so an append-only writer leaves a file whose earlier lines
        // are lies — the value is right and the file is misleading to read.
        const once = upsertEnv(FILE, "MODEL_API_KEY", "sk-1").text
        const twice = upsertEnv(once, "MODEL_API_KEY", "sk-2").text
        expect(twice.match(/MODEL_API_KEY=/g)?.length).toBe(1)
        expect(parseDotEnv(twice).MODEL_API_KEY).toBe("sk-2")
    })

    test("an absent variable is appended with exactly one trailing newline", () => {
        const { text, replaced } = upsertEnv(FILE, "TAVILY_API_KEY", "tvly-1")
        expect(replaced).toBe(false)
        expect(text.endsWith("TAVILY_API_KEY=tvly-1\n")).toBe(true)
        expect(text.endsWith("\n\n")).toBe(false)
        expect(parseDotEnv(text).TAVILY_API_KEY).toBe("tvly-1")
    })

    test("an `export` prefix is preserved", () => {
        // It is there because something sources this file rather than reading it, and dropping it would
        // break that quietly.
        const { text } = upsertEnv("export MODEL_API_KEY=old\n", "MODEL_API_KEY", "new")
        expect(text).toBe("export MODEL_API_KEY=new\n")
    })

    test("a commented-out assignment is left alone", () => {
        // Documentation, and possibly a value somebody deliberately disabled. Uncommenting it would
        // resurrect that; the real assignment is appended instead.
        const { text, replaced } = upsertEnv("# MODEL_API_KEY=disabled\n", "MODEL_API_KEY", "live")
        expect(replaced).toBe(false)
        expect(text).toContain("# MODEL_API_KEY=disabled")
        expect(parseDotEnv(text).MODEL_API_KEY).toBe("live")
    })

    test("an empty file gains one line", () => {
        expect(upsertEnv("", "K", "v").text).toBe("K=v\n")
    })
})

describe("renderEnvValue round-trips through parseDotEnv", () => {
    // The values that break a naive writer: a `#` becomes a comment, a leading quote is eaten as an
    // opening quote, surrounding space is trimmed, and an empty value is indistinguishable from absent.
    for (const value of [
        "sk-plain",
        "with space",
        "has#hash",
        "trailing ",
        '"quoted"',
        "'single'",
        "",
        "back\\slash",
        "new\nline",
    ]) {
        test(`${JSON.stringify(value)} survives`, () => {
            const text = upsertEnv("", "K", value).text
            expect(parseDotEnv(text).K).toBe(value)
        })
    }

    test("a value needing no quotes is written bare, so the file stays readable", () => {
        expect(renderEnvValue("sk-abc123")).toBe("sk-abc123")
    })
})

describe("parseDotEnv inline-comment and escape bugs (#29)", () => {
    test("a quoted value keeps its comment out and its quotes off", () => {
        expect(parseDotEnv('KEY="sk-abc" # prod key').KEY).toBe("sk-abc")
        expect(parseDotEnv("KEY='sk-abc' # prod key").KEY).toBe("sk-abc")
        expect(parseDotEnv('KEY="sk-abc"').KEY).toBe("sk-abc")
    })

    test("an escaped backslash stays a backslash: \\\\n is not a newline", () => {
        expect(parseDotEnv('B="a\\\\nb"').B).toBe("a\\nb")
        expect(
            parseDotEnv("C:\\\\new dir".replace("\\\\", "\\\\") && 'DIR="C:\\\\new dir"').DIR,
        ).toBe("C:\\new dir")
    })

    test("renderEnvValue and parseDotEnv round-trip a Windows path", () => {
        const value = "C:\\new dir"
        expect(parseDotEnv(`DIR=${renderEnvValue(value)}`).DIR).toBe(value)
    })
})
