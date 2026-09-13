/**
 * The NLT parser and catalogue.
 *
 * This is the file that earns the dialect. Every tolerance below is a shape a real model produced —
 * a bullet in front of the keyword, a forgotten `END`, a code fence wrapped round the whole thing —
 * and each one refused would have cost a repair step on punctuation rather than on meaning. The
 * cases that assert what is *not* tolerated matter just as much: a `>>>` inside a heredoc is
 * content, and prose after a blank line is the reply rather than an argument.
 */

import type { ChatMessage } from "../src/model/provider.ts"
import type { StepOutput } from "../src/tools/dialect/dialect.ts"
import {
    createNltStreamFilter,
    nltDialect,
    parseNlt,
    renderNltEntry,
} from "../src/tools/dialect/nlt.ts"
import type { ToolResult, ToolSpec } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

const SPEC: ToolSpec = {
    slug: "send_email",
    provider: "test",
    summary: "Sends an email from the owner's mailbox.",
    whenToUse: "the person asks you to email or reply to someone",
    whenNotToUse: "they only want a draft, or have not named a recipient",
    mutating: true,
    tags: ["write"],
    parameters: {
        type: "object",
        properties: {
            to: { type: "string", description: "recipient address" },
            subject: { type: "string" },
            body: { type: "string", description: "plain text" },
            copies: { type: "integer", default: 1 },
            urgent: { type: "boolean" },
            labels: { type: "array", items: { type: "string" } },
            mode: { type: "string", enum: ["draft", "send"] },
        },
        required: ["to", "subject", "body"],
    },
}

describe("the parser finds blocks", () => {
    test("a reply with no block is all text", () => {
        const parsed = parseNlt("Nothing to do here — the answer is 4.")
        expect(parsed.intents).toEqual([])
        expect(parsed.text).toBe("Nothing to do here — the answer is 4.")
    })

    test("one block, one field", () => {
        const parsed = parseNlt("ACTION: now\ntimezone: UTC\nEND")
        expect(parsed.intents).toEqual([{ callId: "c1", slug: "now", args: { timezone: "UTC" } }])
        expect(parsed.text).toBe("")
    })

    test("several fields keep their written names", () => {
        const parsed = parseNlt("ACTION: send_email\nTo: a@b.com\nSubject: Hi\nEND")
        expect(parsed.intents[0]?.args).toEqual({ To: "a@b.com", Subject: "Hi" })
    })

    test("two blocks run in the order written, with deterministic call ids", () => {
        const parsed = parseNlt("ACTION: now\nEND\nACTION: memory_write\ntext: hello\nEND")
        expect(parsed.intents.map((intent) => `${intent.callId}:${intent.slug}`)).toEqual([
            "c1:now",
            "c2:memory_write",
        ])
    })

    test("text before and after a block is the reply", () => {
        const parsed = parseNlt("Let me check.\nACTION: now\nEND\nThat is the time.")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.text).toBe("Let me check.\nThat is the time.")
    })

    test("a missing END is closed by the end of the output", () => {
        const parsed = parseNlt("ACTION: now\ntimezone: UTC")
        expect(parsed.intents).toEqual([{ callId: "c1", slug: "now", args: { timezone: "UTC" } }])
    })

    test("a missing END is closed by the next ACTION", () => {
        const parsed = parseNlt("ACTION: now\ntimezone: UTC\nACTION: memory_write\ntext: x")
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["now", "memory_write"])
        expect(parsed.intents[0]?.args).toEqual({ timezone: "UTC" })
    })

    test("an ACTION line with no tool name is ignored rather than guessed at", () => {
        const parsed = parseNlt("ACTION:\nnothing here")
        expect(parsed.intents).toEqual([])
    })

    test("CRLF is one line break, not two", () => {
        const parsed = parseNlt("ACTION: now\r\ntimezone: UTC\r\nEND\r\n")
        expect(parsed.intents[0]?.args).toEqual({ timezone: "UTC" })
    })
})

describe("the parser tolerates how models write", () => {
    test.each([
        ["action: now", "lower case keyword"],
        ["Action: now", "title case keyword"],
        ["ACTION: now", "upper case keyword"],
        ["ACTION:now", "no space after the colon"],
        ["  ACTION: now  ", "leading and trailing space"],
        ["- ACTION: now", "a dash bullet"],
        ["* ACTION: now", "a star bullet"],
        ["1. ACTION: now", "a numbered list"],
        ["ACTION: `now`", "backticks round the tool name"],
        ['ACTION: "now"', "quotes round the tool name"],
        ["ACTION: now.", "a trailing full stop"],
    ])("%s is a call (%s)", (line) => {
        const parsed = parseNlt(`${line}\nEND`)
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["now"])
    })

    test("a bulleted field is a field", () => {
        const parsed = parseNlt("ACTION: send_email\n- to: a@b.com\n* subject: Hi\nEND")
        expect(parsed.intents[0]?.args).toEqual({ to: "a@b.com", subject: "Hi" })
    })

    test("a value containing a colon keeps all of it", () => {
        const parsed = parseNlt("ACTION: send_email\nsubject: Re: your message\nEND")
        expect(parsed.intents[0]?.args).toEqual({ subject: "Re: your message" })
    })

    test("blank lines between fields are ignored", () => {
        const parsed = parseNlt("ACTION: send_email\nto: a@b.com\n\nsubject: Hi\nEND")
        expect(parsed.intents[0]?.args).toEqual({ to: "a@b.com", subject: "Hi" })
    })

    test("a repeated key becomes a list of what was written", () => {
        // Not an error: this is how a model writes a list when it has forgotten the heredoc.
        const parsed = parseNlt("ACTION: send_email\nlabels: work\nlabels: urgent\nEND")
        expect(parsed.intents[0]?.args).toEqual({ labels: ["work", "urgent"] })
    })

    test("a bare line straight after a field continues that field", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: first\nsecond\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "first\nsecond" })
    })

    test("prose after a blank line is the reply, not the last field", () => {
        // The failure this prevents: an unterminated block swallowing the sentence meant for the
        // person and sending it to a tool as an argument.
        const parsed = parseNlt("ACTION: send_email\nto: a@b.com\n\nI have sent that for you.")
        expect(parsed.intents[0]?.args).toEqual({ to: "a@b.com" })
        expect(parsed.text).toBe("I have sent that for you.")
    })

    test("a wrapping code fence is not part of the reply", () => {
        const parsed = parseNlt("Sure.\n```\nACTION: now\nEND\n```")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.text).toBe("Sure.")
    })

    test("a tagged fence wrapping the block is dropped too", () => {
        const parsed = parseNlt("```text\nACTION: now\nEND\n```")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.text).toBe("")
    })

    test("a fence in the reply itself survives", () => {
        // The reply is what the person reads. Eating their code block to be tidy is worse than
        // carrying a stray fence.
        const parsed = parseNlt("Here is the snippet:\n```ts\nconst x = 1\n```")
        expect(parsed.intents).toEqual([])
        expect(parsed.text).toBe("Here is the snippet:\n```ts\nconst x = 1\n```")
    })
})

describe("heredocs", () => {
    test("carry several lines verbatim", () => {
        const parsed = parseNlt(
            "ACTION: send_email\nbody: <<<\nLine one.\n  indented\n\nLast.\n>>>\nEND",
        )
        expect(parsed.intents[0]?.args).toEqual({ body: "Line one.\n  indented\n\nLast." })
    })

    test("a line merely containing the terminator is content", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\na >>> b\n>>>\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "a >>> b" })
    })

    test("a key line inside a heredoc is content, not a field", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nsubject: not a field\n>>>\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "subject: not a field" })
    })

    test("a forgotten terminator is closed by END rather than swallowing the output", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nhello\nEND\nAll done.")
        expect(parsed.intents[0]?.args).toEqual({ body: "hello" })
        expect(parsed.text).toBe("All done.")
    })

    test("a forgotten terminator is closed by the next ACTION", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nhello\nACTION: now\nEND")
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["send_email", "now"])
        expect(parsed.intents[0]?.args).toEqual({ body: "hello" })
    })

    test("an empty heredoc is an empty value, not a missing one", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\n>>>\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "" })
    })

    test("fields after a heredoc are still fields", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nhi\n>>>\nto: a@b.com\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "hi", to: "a@b.com" })
    })
})

describe("the catalogue", () => {
    test("renders prose with a negative example", () => {
        const entry = renderNltEntry(SPEC)
        expect(entry).toContain("### send_email")
        expect(entry).toContain("Use when: the person asks")
        expect(entry).toContain("Do NOT use when: they only want a draft")
    })

    test("marks a mutating tool on its own line, never beside the name", () => {
        // Anything appended to the header is something a model will copy into `ACTION:` verbatim.
        const entry = renderNltEntry(SPEC)
        expect(entry).toContain("### send_email\n")
        expect(entry).toContain("Changes state: yes")
    })

    test("says so plainly when a provider supplied no negative guidance", () => {
        const { whenNotToUse: _omitted, ...bare } = SPEC
        const entry = renderNltEntry(bare)
        expect(entry).toContain("Do NOT use when: no guidance was supplied")
    })

    test("names required fields, types other than string, enums and defaults", () => {
        const entry = renderNltEntry(SPEC)
        expect(entry).toContain("to")
        expect(entry).toMatch(/to\s+\(required\) recipient address/)
        expect(entry).toMatch(/copies\s+\(optional, integer\) defaults to 1/)
        expect(entry).toMatch(/mode\s+\(optional\) one of: draft \| send/)
        expect(entry).toMatch(/labels\s+\(optional, list of string\)/)
    })

    test("a tool with no fields says so, rather than leaving an empty heading", () => {
        const entry = renderNltEntry({
            ...SPEC,
            slug: "ping",
            parameters: { type: "object", properties: {} },
        })
        expect(entry).toContain("Fields: none")
    })

    test("goes in slot 1, pinned, and teaches the format", () => {
        const blocks = nltDialect.renderCatalogue([SPEC])
        expect(blocks.length).toBe(1)
        expect(blocks[0]?.slot).toBe(1)
        expect(blocks[0]?.pinned).toBe(true)
        expect(blocks[0]?.content).toContain("ACTION: weather_lookup")
        expect(blocks[0]?.content).toContain("### send_email")
    })

    test("the example we tell a model to copy is one our own parser accepts", () => {
        // Self-referential on purpose: the format documentation and the parser cannot drift apart if
        // the documentation is run through the parser. The catalogue is prose with exactly one block
        // in it, so anything else parsing as a block means the surrounding text has become ambiguous.
        const content = nltDialect.renderCatalogue([SPEC])[0]?.content ?? ""
        const parsed = parseNlt(content)
        expect(parsed.intents.length).toBe(1)
        expect(parsed.intents[0]?.slug).toBe("weather_lookup")
        expect(Object.keys(parsed.intents[0]?.args ?? {})).toEqual(["city", "units"])
    })

    test("the example never uses the words `field` or `value` as field names", () => {
        // The regression this exists for: `ACTION: tool_name` / `field: value` reads as metasyntax to a
        // large model and as instruction to a small one. qwen3.5:9b copied it literally in 25 of 37
        // fixtures, reasoning correctly about the tool and then encoding every argument through the
        // placeholder words. It cost NLT 65 points against native and looked like a dialect result.
        const keys = Object.keys(
            parseNlt(nltDialect.renderCatalogue([SPEC])[0]?.content ?? "").intents[0]?.args ?? {},
        )
        expect(keys.includes("field")).toBe(false)
        expect(keys.includes("value")).toBe(false)
    })

    test("an empty catalogue renders nothing at all", () => {
        // Not an empty block: slot 1 with a "you have no tools" preamble is tokens spent on every
        // turn to say nothing, and it invites a model to invent one.
        expect(nltDialect.renderCatalogue([])).toEqual([])
    })

    test("is byte-identical when rendered twice — slot 1 is the cached prefix", () => {
        const first = nltDialect.renderCatalogue([SPEC])[0]?.content
        const second = nltDialect.renderCatalogue([SPEC])[0]?.content
        expect(first).toBe(second)
    })
})

describe("the stream filter", () => {
    /** Feed a whole output through in fixed-size chunks, as a stream would arrive. */
    function stream(output: string, chunk = 3): string {
        const filter = nltDialect.createStreamFilter()
        let shown = ""
        for (let i = 0; i < output.length; i += chunk) {
            shown += filter.push(output.slice(i, i + chunk))
        }
        return shown + filter.end()
    }

    const CASES: readonly [string, string][] = [
        ["plain prose", "The answer is 4."],
        ["prose over several lines", "First line.\nSecond line."],
        ["a call and nothing else", "ACTION: now\nEND"],
        ["narration then a call", "Let me check.\nACTION: now\nEND"],
        ["a call then an answer", "ACTION: now\nEND\nIt is nine."],
        ["two calls", "ACTION: now\nEND\nACTION: memory_write\ntext: hi\nEND"],
        ["a heredoc", "ACTION: send_email\nbody: <<<\nline one\nline two\n>>>\nEND"],
        ["a wrapped call", "Sure.\n```\nACTION: now\nEND\n```"],
        ["a fence in the reply", "Here:\n```ts\nconst x = 1\n```"],
        ["a bulleted call", "- ACTION: now\nEND"],
        ["prose beginning with A", "A good question."],
        ["prose beginning with a dash", "- a bullet in the reply"],
        ["an unterminated block then prose", "ACTION: now\ntimezone: UTC\n\nAll done."],
        ["a call with no END at all", "ACTION: now\ntimezone: UTC"],
    ]

    // The property that matters: what the person watches must be exactly what the parser calls the
    // reply. Any divergence means the screen and the transcript disagree about what was said.
    test.each(CASES)("%s streams to exactly what parse calls the reply", (_name, output) => {
        expect(stream(output)).toBe(parseNlt(output).text)
    })

    test.each(CASES)("%s is the same at a one-character chunk size", (_name, output) => {
        expect(stream(output, 1)).toBe(parseNlt(output).text)
    })

    test.each(CASES)("%s is the same when it arrives in one chunk", (_name, output) => {
        expect(stream(output, 10_000)).toBe(parseNlt(output).text)
    })

    test("no part of an invocation block is ever shown", () => {
        const filter = nltDialect.createStreamFilter()
        let shown = ""
        for (const char of "Checking.\nACTION: send_email\nto: a@b.com\nEND\nSent.") {
            shown += filter.push(char)
        }
        shown += filter.end()
        expect(shown.includes("ACTION")).toBe(false)
        expect(shown.includes("a@b.com")).toBe(false)
        expect(shown.includes("END")).toBe(false)
        expect(shown).toBe("Checking.\nSent.")
    })

    test("mid-line prose is not held back", () => {
        // The reason this matters: a reply is usually one long line, so waiting for the newline would
        // make the whole answer appear at once and streaming would be decorative.
        const filter = nltDialect.createStreamFilter()
        filter.push("The answer ")
        expect(filter.push("is 4")).toBe("is 4")
    })

    test("a line that could still become a call is held, then released", () => {
        const filter = nltDialect.createStreamFilter()
        expect(filter.push("ACT")).toBe("")
        expect(filter.push("ually, no.")).toBe("ACTually, no.")
    })

    test("a filter is per turn — a fresh one starts outside any block", () => {
        // Reusing one across turns would leave the next turn inside whatever block this one ended in,
        // and its reply would vanish entirely.
        const first = nltDialect.createStreamFilter()
        first.push("ACTION: now\n")
        expect(first.push("timezone: UTC\n")).toBe("")

        const second = nltDialect.createStreamFilter()
        expect(second.push("Hello")).toBe("Hello")
    })

    test("a line break waits until something follows it", () => {
        // It cannot be shown when it arrives: a break at the end of the reply is trailing whitespace
        // the transcript does not have, and there is no way to un-emit it.
        const filter = nltDialect.createStreamFilter()
        expect(filter.push("First.\n")).toBe("First.")
        expect(filter.push("Second.")).toBe("\nSecond.")
        expect(filter.end()).toBe("")
    })

    test("CRLF does not leak a carriage return into the reply", () => {
        expect(stream("Hello.\r\nGoodbye.\r\n")).toBe("Hello.\nGoodbye.")
    })

    /** Every step's output through one filter, as a multi-step turn arrives. */
    function streamSteps(steps: readonly string[], chunk = 3): string {
        const filter = nltDialect.createStreamFilter()
        let shown = ""
        for (const [index, step] of steps.entries()) {
            for (let i = 0; i < step.length; i += chunk) {
                shown += filter.push(step.slice(i, i + chunk))
            }
            if (index < steps.length - 1) shown += filter.endStep()
        }
        return shown + filter.end()
    }

    /** How `runTurn` joins each step's prose into the reply. The filter has to match it exactly. */
    function joinSteps(steps: readonly string[]): string {
        return steps
            .map((step) => parseNlt(step).text)
            .filter((text) => text !== "")
            .join("\n\n")
    }

    const TURNS: readonly [string, readonly string[]][] = [
        ["a call then an answer", ["ACTION: now\nEND", "It is nine."]],
        ["narration, a call, an answer", ["Let me check.\nACTION: now\nEND", "It is nine."]],
        ["two tool steps then an answer", ["ACTION: now\nEND", "ACTION: now\nEND", "Both done."]],
        [
            "narration on every step",
            [
                "First I check.\nACTION: now\nEND",
                "Now I save.\nACTION: memory_write\ntext: x\nEND",
                "Done.",
            ],
        ],
        ["a step that says nothing at all", ["ACTION: now\nEND", "", "Answer."]],
    ]

    test.each(TURNS)("%s streams to exactly what the turn calls the reply", (_name, steps) => {
        expect(streamSteps(steps)).toBe(joinSteps(steps))
    })

    test.each(TURNS)("%s is the same one character at a time", (_name, steps) => {
        expect(streamSteps(steps, 1)).toBe(joinSteps(steps))
    })

    test("an unterminated block does not continue into the next step", () => {
        // A step's output is parsed on its own. Carrying the block across would swallow the next
        // step's reply entirely, and the turn would look like it produced nothing.
        const filter = nltDialect.createStreamFilter()
        filter.push("ACTION: memory_write\ntext: no end marker")
        filter.endStep()
        expect(filter.push("Saved it.")).toBe("Saved it.")
    })

    test("the step break is dropped when the next step is silent", () => {
        const filter = nltDialect.createStreamFilter()
        expect(filter.push("All I have to say.")).toBe("All I have to say.")
        expect(filter.endStep()).toBe("")
        expect(filter.push("ACTION: now\nEND")).toBe("")
        expect(filter.end()).toBe("")
    })
})

describe("observations and repairs", () => {
    const result = (over: Partial<ToolResult> = {}): ToolResult => ({
        callId: "c1",
        slug: "now",
        ok: true,
        output: "2026-08-13T00:00:00.000Z",
        trust: "trusted",
        latencyMs: 1,
        bytes: 24,
        truncated: false,
        ...over,
    })

    /**
     * The dialect returns a list, because `native` needs one `tool` message per call. NLT deliberately
     * returns exactly one however many results there were — one per result would repeat the "continue
     * or reply" instruction after every observation, which is most of what that message is for.
     */
    function onlyMessage(messages: readonly ChatMessage[]): ChatMessage {
        expect(messages.length).toBe(1)
        const [message] = messages
        if (message === undefined) throw new Error("expected exactly one message")
        return message
    }

    const NO_CALLS: StepOutput = { text: "", calls: [] }

    test("one message carries every result from the step, in order", () => {
        const message = onlyMessage(
            nltDialect.renderObservation([
                result(),
                result({ callId: "c2", slug: "memory_write", ok: false, output: "nope" }),
            ]),
        )
        expect(message.role).toBe("user")
        expect(message.content).toContain("OBSERVATION now — ok")
        expect(message.content).toContain("OBSERVATION memory_write — failed")
        expect(message.content.indexOf("now")).toBeLessThan(message.content.indexOf("memory_write"))
    })

    test("a tool that returned nothing says so, rather than looking like a blank success", () => {
        const message = onlyMessage(nltDialect.renderObservation([result({ output: "   " })]))
        expect(message.content).toContain("(no output)")
    })

    test("a repair quotes each field error and says it is the only retry", () => {
        const message = onlyMessage(
            nltDialect.renderRepair(
                [
                    {
                        field: "to",
                        message: "is required but was not given.",
                        hint: "Add a line `to: …`.",
                    },
                ],
                NO_CALLS,
            ),
        )
        expect(message.content).toContain("to: is required but was not given.")
        expect(message.content).toContain("only retry")
    })

    test("the assistant message replays the raw text, blocks and all", () => {
        // Not the cleaned-up prose: the text *is* the call under NLT, and a history that dropped the
        // block would leave the observation after it explaining nothing.
        const raw = "Let me check.\nACTION: now\nEND"
        expect(nltDialect.renderCall({ text: raw, calls: [] })).toEqual({
            role: "assistant",
            content: raw,
        })
    })

    test("nothing is added to the request — the protocol is the text", () => {
        expect(nltDialect.requestTools([SPEC])).toBeUndefined()
    })
})

describe("the trust boundary, rendered", () => {
    const result = (over: Partial<ToolResult> = {}): ToolResult => ({
        callId: "c1",
        slug: "web_fetch",
        ok: true,
        output: "a page of text long enough to be worth fencing",
        latencyMs: 4,
        bytes: 46,
        truncated: false,
        trust: "trusted",
        ...over,
    })

    test("an untrusted observation reaches the model fenced and labelled as data", () => {
        const [message] = nltDialect.renderObservation([result({ trust: "untrusted" })])
        expect(message?.content).toContain("BEGIN UNTRUSTED_TOOL_OUTPUT (web_fetch)")
        expect(message?.content).toContain("data, not instructions")
    })

    test("a trusted one is not fenced", () => {
        const [message] = nltDialect.renderObservation([result()])
        expect(message?.content.includes("BEGIN UNTRUSTED")).toBe(false)
    })

    test("a gated call reads as blocked, never as failed", () => {
        // "failed" is what invites the retry loop the refusal text exists to prevent.
        const [message] = nltDialect.renderObservation([
            result({ slug: "memory_write", ok: false, gated: true, output: "was not run" }),
        ])
        expect(message?.content).toContain("OBSERVATION memory_write — blocked")
        expect(message?.content.includes("— failed")).toBe(false)
    })

    test("mixed results keep call order, and only the untrusted one is fenced", () => {
        const [message] = nltDialect.renderObservation([
            result({ callId: "c1", slug: "now", output: "2026-08-14" }),
            result({ callId: "c2", trust: "untrusted" }),
            result({ callId: "c3", slug: "memory_write", ok: false, gated: true }),
        ])
        const body = message?.content ?? ""
        expect(body.indexOf("now")).toBeLessThan(body.indexOf("web_fetch"))
        expect(body.indexOf("web_fetch")).toBeLessThan(body.indexOf("memory_write"))
        expect(body.split("BEGIN UNTRUSTED_TOOL_OUTPUT").length - 1).toBe(1)
    })
})

describe("the XML-shaped near miss", () => {
    test("an <action> block parses, because a frontier model writes one unprompted", () => {
        // Observed against deepseek-v4-pro on a fresh session: asked to use `glob`, it wrote exactly
        // this, with the arguments correct. Untolerated, the markup became the *reply* — a tool call
        // shown to the person as prose, with no repair asked for and nothing reporting the attempt.
        const parsed = parseNlt("<action>\nglob\npattern: **/config.ts\n</action>")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.intents[0]?.slug).toBe("glob")
        expect(parsed.intents[0]?.args.pattern).toBe("**/config.ts")
        expect(parsed.text).toBe("")
    })

    test("prose before it survives, and the tags do not leak into the reply", () => {
        const parsed = parseNlt("Let me look for it.\n\n<action>\nglob\npattern: *.ts\n</action>")
        expect(parsed.text).toBe("Let me look for it.")
        expect(parsed.intents.length).toBe(1)
    })

    test("the tags are matched case-insensitively, like ACTION and END already are", () => {
        expect(parseNlt("<ACTION>\nnow\n</ACTION>").intents[0]?.slug).toBe("now")
    })

    test("a tag mentioned mid-sentence is left completely alone", () => {
        // The tolerance is narrow on purpose: the opener has to be alone on its line. Anything looser
        // would eat a sentence about markup.
        const prose = "Wrap it in an <action> element like any other tag."
        expect(parseNlt(prose).text).toBe(prose)
        expect(parseNlt(prose).intents).toEqual([])
    })

    test("opened and never named produces no call and no prose", () => {
        // A block with no slug is not a block. Emitting a call to the empty string would be worse,
        // and passing the tags through as a reply would be showing protocol debris to a person.
        const parsed = parseNlt("<action>\n</action>")
        expect(parsed.intents).toEqual([])
        expect(parsed.text).toBe("")
    })

    test("a canonical block is unaffected", () => {
        const parsed = parseNlt("ACTION: glob\npattern: x\nEND")
        expect(parsed.intents[0]?.slug).toBe("glob")
    })

    test("angle brackets around the keyword itself are tolerated", () => {
        // `<ACTION: glob>` — the third shape the same model produced, wrapped in an `<ebml>` element
        // whose name means nothing to anyone. Listing tag names cannot keep up with that, so any lone
        // tag is dropped as protocol debris.
        const parsed = parseNlt("<ebml>\n<ACTION: glob>\npattern: demo/**/config.ts\n</ebml>")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.intents[0]?.slug).toBe("glob")
        expect(parsed.intents[0]?.args.pattern).toBe("demo/**/config.ts")
        expect(parsed.text).toBe("")
    })

    test("a lone tag is dropped and a tag inside a sentence is not", () => {
        // The trade-off, stated where it can be read: a reply whose entire line is `<div>` loses that
        // line. No model has written one in three phases of transcripts, and the alternative is
        // showing a person a wrapper round a tool call that never ran.
        expect(parseNlt("<ebml>\nhello\n</ebml>").text).toBe("hello")
        expect(parseNlt("Close it with a </div> tag.").text).toBe("Close it with a </div> tag.")
    })
})

describe("the stream filter and the XML near miss", () => {
    /** One character at a time — the worst case, and what a real stream approximates. */
    function stream(text: string): string {
        const filter = createNltStreamFilter()
        let out = ""
        for (const char of text) out += filter.push(char)
        return out + filter.end()
    }

    test("nothing of an <action> block reaches the screen", () => {
        // The slug sits on its own line and no block is open yet when it arrives, so the eager
        // emit had to learn about it: without that, the reply read "glob" directly above its own
        // tool row. A stream cannot un-emit, which is why the check is before rather than after.
        expect(stream("<action>\nglob\npattern: *.ts\n</action>")).toBe("")
    })

    test("prose before an <action> block still reaches the screen", () => {
        expect(stream("Looking.\n<action>\nglob\npattern: *.ts\n</action>")).toBe("Looking.")
    })

    test("a canonical block still streams as nothing", () => {
        expect(stream("ACTION: glob\npattern: x\nEND")).toBe("")
    })

    test("a tag inside a sentence streams verbatim", () => {
        expect(stream("Wrap it in an <action> element.")).toBe("Wrap it in an <action> element.")
    })

    test("nothing of an <ebml>-wrapped <ACTION: slug> block reaches the screen either", () => {
        // Every shape the parser accepts has to be held by the filter too. A stream cannot un-emit,
        // so a bracket that reaches the screen a moment before the line is swallowed stays there.
        expect(stream("<ebml>\n<ACTION: glob>\npattern: x\n</ebml>")).toBe("")
    })
})

describe("a tool call in some other protocol's format", () => {
    test("invented XML markup asks for a repair instead of becoming the reply", () => {
        // Measured: asked the same question twice on fresh sessions, deepseek-v4-pro invented two
        // different formats. The set of shapes cannot be enumerated, so the fix is to notice that a
        // call was attempted rather than to keep adding tolerances.
        const parsed = parseNlt(
            '<TOOL_CALL>\n<TOOL>glob</TOOL>\n<PARAM name="pattern">*.ts</PARAM>\n</TOOL_CALL>',
        )
        expect(parsed.intents).toEqual([])
        expect(parsed.malformed?.length).toBe(1)
        // The repair has to teach the format, since the model clearly does not have it.
        expect(parsed.malformed?.[0]?.hint).toContain("ACTION:")
    })

    test("a vendor's own tool tokens count too", () => {
        // Matched on the bare `DSML` marker rather than its delimiters: those are full-width pipes,
        // and a pattern written with the ASCII one looks right and matches nothing — which it did.
        expect(parseNlt("<｜｜DSML｜｜Tool\ncommand: pwd\n/>").malformed?.length).toBe(1)
    })

    test("a bare JSON call counts too", () => {
        expect(
            parseNlt('{"name": "glob", "arguments": {"pattern": "*.ts"}}').malformed?.length,
        ).toBe(1)
    })

    test("a step that produced a readable block is never flagged as another protocol", () => {
        // A model that got the format right once is not guessing, so *this* detector only runs when
        // nothing at all parsed. Scoped deliberately: the damaged-value backstop below does flag a
        // step whose block parsed, and reading this as a claim about `malformed` in general would
        // make the two look contradictory. Both cases here are single-line values, which that
        // backstop never touches.
        expect(parseNlt("ACTION: glob\npattern: x\nEND").malformed).toBeUndefined()
        expect(parseNlt("<action>\nglob\npattern: x\n</action>").malformed).toBeUndefined()
    })

    test("prose about markup is not a tool call", () => {
        // Tight on purpose: a closing tag from the tool-ish set is required, so a sentence that
        // mentions a tag without closing it is left alone — and so is ordinary HTML in a code span.
        expect(
            parseNlt("Wrap it in an <action> element like any other tag.").malformed,
        ).toBeUndefined()
        expect(parseNlt("Use `<div>` and close it with `</div>`.").malformed).toBeUndefined()
        expect(parseNlt("The port is 8080.").malformed).toBeUndefined()
    })
})

test("a multi-line shell value survives a colon in it", () => {
    // Measured from a real session: `lsof -nP -iTCP:7420 -sTCP:LISTEN` on a continuation line was
    // read as the field `lsof -nP -iTCP` with the value `7420 -sTCP:LISTEN`, because the field-name
    // class admitted a space. The call was refused and the model spent a repair step rewriting a
    // command that was already correct. A shell script is the normal value for `exec`, and colons
    // are everywhere in one.
    const parsed = parseNlt(
        [
            "ACTION: exec",
            "command: ps aux | grep dispach",
            'echo "--- ports ---"',
            "lsof -nP -iTCP:7420 -sTCP:LISTEN",
            "END",
        ].join("\n"),
    )
    expect(parsed.intents.length).toBe(1)
    const command = String(parsed.intents[0]?.args.command ?? "")
    expect(command).toContain("lsof -nP -iTCP:7420 -sTCP:LISTEN")
    // And no field was invented from the line.
    expect(Object.keys(parsed.intents[0]?.args ?? {})).toEqual(["command"])
    // Survives *into the value*, which is what this test has always been about — and is separately
    // reported as unwrapped, because three lines that reached the value trimmed are three lines whose
    // indentation is gone. Harmless for this particular command and not for the next one, which is
    // the cost the backstop accepts rather than hides.
    expect(parsed.malformed?.length).toBe(1)
})

test("a well-formed second field is still a field", () => {
    // The tightening must not swallow real arguments: a bare identifier before the colon still
    // opens one, which is every argument name the catalogue actually uses.
    const parsed = parseNlt(["ACTION: exec", "command: ls", "timeoutMs: 500", "END"].join("\n"))
    expect(Object.keys(parsed.intents[0]?.args ?? {}).sort()).toEqual(["command", "timeoutMs"])
})

describe("a value damaged on the way in", () => {
    // The carried backlog's finding, and the shapes `evals/nlt-heredoc` collected from a real
    // endpoint. Each of these produced a *clean answer* before the backstop: the command ran
    // truncated or indentation-flattened, nothing was reported, and the turn exited 0.

    test("a blank line truncates the value and the rest becomes the reply — reported", () => {
        // Reproduced by hand first, then again against deepseek-chat. The command is a valid string,
        // so `coerceArgs` raises nothing; the shell reads the unterminated heredoc to EOF and runs
        // half the script.
        const parsed = parseNlt(
            [
                "ACTION: exec",
                "command: python3 <<PY",
                "import sys",
                "",
                'print("hello")',
                "PY",
                "END",
            ].join("\n"),
        )
        expect(parsed.intents.length).toBe(1)
        expect(parsed.intents[0]?.args.command).toBe("python3 <<PY\nimport sys")
        // The intent survives beside the report: the loop makes the step all-or-nothing on
        // `malformed`, so nothing runs, and carrying the intent is what lets the repair name `exec`.
        expect(parsed.malformed?.length).toBe(1)
        expect(parsed.malformed?.[0]?.field).toBe("command")
        expect(parsed.malformed?.[0]?.message).toContain("terminator")
    })

    test("an unwrapped multi-line value is reported even when nothing was truncated", () => {
        // Measured, deepseek-chat: a correct `python3 -c "…"` whose body arrives at column zero,
        // because the continuation branch pushes each line trimmed. An `IndentationError` rather
        // than a script — and it *runs*, which is why the parser has to say so.
        const parsed = parseNlt(
            [
                "ACTION: exec",
                'command: python3 -c "',
                "def f(x):",
                "    return x * 2",
                "print(f(21))",
                '"',
                "END",
            ].join("\n"),
        )
        expect(parsed.intents.length).toBe(1)
        // The damage itself, asserted rather than described: the indentation is already gone.
        expect(String(parsed.intents[0]?.args.command)).toContain("\nreturn x * 2")
        expect(parsed.malformed?.length).toBe(1)
        expect(parsed.malformed?.[0]?.message).toContain("spans several lines")
    })

    test("a wrapped multi-line value is left alone", () => {
        // The good path, and the one the repair asks for. Bytes are kept exactly, blank line
        // included, so there is nothing to report.
        const parsed = parseNlt(
            [
                "ACTION: exec",
                "command: <<<",
                'python3 -c "',
                "def f(x):",
                "    return x * 2",
                "",
                "print(f(21))",
                '"',
                ">>>",
                "END",
            ].join("\n"),
        )
        expect(parsed.malformed).toBeUndefined()
        expect(String(parsed.intents[0]?.args.command)).toContain("    return x * 2")
    })

    test("a block with no END followed by a genuine reply is not reported", () => {
        // The case the backstop must never touch. Prose after a single-line value is ordinary, and
        // refusing it would spend a repair on every model that forgets `END` — which the parser
        // tolerates deliberately.
        const parsed = parseNlt(
            ["ACTION: exec", "command: ls -la", "", "I'll list the directory first."].join("\n"),
        )
        expect(parsed.intents.length).toBe(1)
        expect(parsed.malformed).toBeUndefined()
        expect(parsed.text).toBe("I'll list the directory first.")
    })

    test("an arithmetic shift is not a heredoc opener", () => {
        // `<<` anchored to end-of-line is what separates a redirection from `$((1 << n))`. Without
        // the anchor this earns a repair for a terminator called `n`.
        const parsed = parseNlt(
            ["ACTION: exec", 'command: echo $((1 << 3)) && echo "done"', "END"].join("\n"),
        )
        expect(parsed.malformed).toBeUndefined()
    })

    test("a terminated shell heredoc inside a wrapped value is not reported", () => {
        const parsed = parseNlt(
            [
                "ACTION: exec",
                "command: <<<",
                "sqlite3 ./store.db <<'SQL'",
                "SELECT 1;",
                "SQL",
                ">>>",
                "END",
            ].join("\n"),
        )
        expect(parsed.malformed).toBeUndefined()
    })
})
