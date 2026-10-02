/**
 * The `native` dialect.
 *
 * The first suite is the most important one in the file, and it is not about native at all — it
 * asserts that both dialects put the *same guidance* in front of the model. Without it, an eval
 * comparing NLT's prose catalogue against a bare `description: summary` would be measuring the
 * guidance and reporting the number as a property of the dialect. That result would look like
 * publishable evidence and be worth nothing.
 *
 * The rest is the wire protocol's own failure modes: a truncated argument document, a call with no
 * name, and the requirement that every announced call be answered before the model speaks again.
 */

import type { ChatMessage } from "../src/model/provider.ts"
import type { StepOutput } from "../src/tools/dialect/dialect.ts"
import {
    nativeDialect,
    nativeWireTokens,
    parseNative,
    renderNativeDescription,
} from "../src/tools/dialect/native.ts"
import { nltDialect, renderNltEntry } from "../src/tools/dialect/nlt.ts"
import { ToolRegistry } from "../src/tools/registry.ts"
import { renderTrusted, untrustedFence } from "../src/tools/trust.ts"
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
            body: { type: "string" },
        },
        required: ["to", "body"],
    },
}

const READ_ONLY: ToolSpec = {
    slug: "now",
    provider: "local",
    summary: "Reports the current date and time.",
    whenToUse: "anything depends on today's date",
    whenNotToUse: "the person gave you a date already",
    mutating: false,
    tags: ["read"],
    parameters: { type: "object", properties: {} },
}

function output(over: Partial<StepOutput> = {}): StepOutput {
    return { text: "", calls: [], ...over }
}

// ─── the fairness property ───────────────────────────────────────────────────────────────

describe("both dialects give the model the same guidance", () => {
    test("the native description carries what the NLT catalogue entry carries", () => {
        const prose = renderNltEntry(SPEC)
        const description = renderNativeDescription(SPEC)

        // Not a string comparison — the *renderings* differ, deliberately. What must not differ is
        // which facts reach the model.
        for (const fact of [
            SPEC.summary,
            SPEC.whenToUse,
            SPEC.whenNotToUse as string,
            "Do NOT use when",
        ]) {
            expect(prose).toContain(fact)
            expect(description).toContain(fact)
        }
    })

    test("a state-changing tool is flagged as one in both", () => {
        expect(renderNltEntry(SPEC)).toContain("Changes state: yes")
        expect(renderNativeDescription(SPEC)).toContain("Changes state: yes")
        // As a positive assertion rather than `.not`: the dual-runtime harness keeps a deliberately
        // closed matcher list, and this reads the same either way.
        expect(renderNativeDescription(READ_ONLY).includes("Changes state")).toBe(false)
    })

    test("a missing negative case is admitted in both, never fabricated or dropped", () => {
        const { whenNotToUse: _omitted, ...bare } = SPEC
        expect(renderNltEntry(bare)).toContain("no guidance was supplied")
        expect(renderNativeDescription(bare)).toContain("no guidance was supplied")
    })

    test("the schema is passed through unchanged — one schema, two renderings", () => {
        const [definition] = nativeDialect.requestTools([SPEC]) ?? []
        expect(definition?.parameters).toEqual(SPEC.parameters)
    })
})

// ─── the request ─────────────────────────────────────────────────────────────────────────

describe("what goes on the wire", () => {
    test("one definition per tool, named by slug", () => {
        const definitions = nativeDialect.requestTools([READ_ONLY, SPEC]) ?? []
        expect(definitions.map((definition) => definition.name)).toEqual(["now", "send_email"])
    })

    test("an empty catalogue sends no tools parameter at all", () => {
        expect(nativeDialect.requestTools([])).toBeUndefined()
    })

    test("slot 1 is empty — the catalogue is in the request", () => {
        expect(nativeDialect.renderCatalogue([SPEC])).toEqual([])
    })

    test("the wire catalogue's cost is reported, since the context budget cannot see it", () => {
        const definitions = nativeDialect.requestTools([SPEC]) ?? []
        expect(nativeWireTokens(definitions)).toBeGreaterThan(0)
        expect(nativeWireTokens([])).toBe(0)
    })

    test("a dotted slug goes out as __, and the reply resolves back to the slug (pilot.5)", async () => {
        // Skill scripts are `skill.<skill>.<script>` and join mid-session, so a native agent failed on
        // the first turn that activated a scripted skill.
        const definitions =
            nativeDialect.requestTools([{ ...SPEC, slug: "skill.pdf.extract" }]) ?? []
        expect(definitions[0]?.name).toBe("skill__pdf__extract")

        const registry = await ToolRegistry.create({
            pinned: ["skill.pdf.extract"],
            providers: [
                {
                    id: "skills",
                    resolve: async () => [
                        {
                            spec: { ...SPEC, slug: "skill.pdf.extract", provider: "skills" },
                            handler: () => "ok",
                        },
                    ],
                    list: async () => ["skill.pdf.extract"],
                },
            ],
        })
        const parsed = nativeDialect.parse({
            text: "",
            calls: [{ id: "c1", name: "skill__pdf__extract", arguments: "{}" }],
        })
        // Policy and events read the resolved spec, so they see the dotted slug.
        expect(registry.resolve(parsed.intents[0]?.slug ?? "").spec.slug).toBe("skill.pdf.extract")
    })

    test("a mapped name another slug would also answer to is refused, not guessed", () => {
        let caught: unknown
        try {
            nativeDialect.requestTools([
                { ...SPEC, slug: "skill.pdf.extract" },
                { ...SPEC, slug: "skill_pdf_extract" },
            ])
        } catch (error) {
            caught = error
        }
        expect((caught as { code?: string })?.code).toBe("native_tool_name_collision")
        // Two plain slugs that collide only in normalisation were never mapped, so they are not this
        // dialect's to refuse.
        expect(() =>
            nativeDialect.requestTools([
                { ...SPEC, slug: "send_email" },
                { ...SPEC, slug: "send-email" },
            ]),
        ).not.toThrow()
    })

    test.each([
        ["a space", "send email"],
        ["a colon", "tag:write"],
    ])("a slug the wire format cannot carry is refused at load — %s", (_label, slug) => {
        // Refused rather than rewritten: only a dot has a mapping, because only a dot has a reason
        // (skill scripts) and a way back the registry already provides.
        let caught: unknown
        try {
            nativeDialect.requestTools([{ ...SPEC, slug }])
        } catch (error) {
            caught = error
        }
        expect((caught as { code?: string })?.code).toBe("native_tool_name_invalid")
        // And the hint names the way out rather than only the rule.
        expect((caught as { hint?: string })?.hint).toContain("nlt")
    })

    test("the same slug is perfectly fine under NLT", () => {
        expect(renderNltEntry({ ...SPEC, slug: "gmail.send" })).toContain("gmail.send")
    })
})

// ─── reading the reply ───────────────────────────────────────────────────────────────────

describe("parsing tool_calls", () => {
    test("a call becomes an intent, keeping the provider's id", () => {
        const parsed = parseNative(
            output({
                text: "Sending that now.",
                calls: [
                    {
                        id: "call_abc",
                        name: "send_email",
                        arguments: '{"to":"a@b.c","body":"hi"}',
                    },
                ],
            }),
        )
        expect(parsed.intents).toEqual([
            { callId: "call_abc", slug: "send_email", args: { to: "a@b.c", body: "hi" } },
        ])
        expect(parsed.text).toBe("Sending that now.")
        expect(parsed.malformed).toBeUndefined()
    })

    test("several calls keep the order the model asked for", () => {
        const parsed = parseNative(
            output({
                calls: [
                    { id: "c1", name: "now", arguments: "{}" },
                    { id: "c2", name: "send_email", arguments: '{"to":"x"}' },
                ],
            }),
        )
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["now", "send_email"])
    })

    test("a tool taking no arguments streams an empty document, and that is not an error", () => {
        const parsed = parseNative(output({ calls: [{ id: "c1", name: "now", arguments: "" }] }))
        expect(parsed.intents).toEqual([{ callId: "c1", slug: "now", args: {} }])
    })

    test("double-encoded arguments are unwrapped once — several proxies do this", () => {
        const parsed = parseNative(
            output({ calls: [{ id: "c1", name: "now", arguments: '"{\\"tz\\":\\"UTC\\"}"' }] }),
        )
        expect(parsed.intents[0]?.args).toEqual({ tz: "UTC" })
    })

    test("no text is not a failure when there are calls — many models send only the call", () => {
        const parsed = parseNative(output({ calls: [{ id: "c1", name: "now", arguments: "{}" }] }))
        expect(parsed.text).toBe("")
        expect(parsed.intents.length).toBe(1)
    })
})

describe("arguments that cannot be read", () => {
    /**
     * The reason this path exists at all. `now` has no required fields, so treating an unreadable
     * document as "no arguments" would run it — reporting success for a call the model did not make.
     * The check is that it becomes an intent nobody executes, not an intent with empty arguments.
     */
    test("truncated JSON is malformed, not an empty argument set", () => {
        const parsed = parseNative(
            output({ calls: [{ id: "c1", name: "now", arguments: '{"timezone":"Europe/Lon' }] }),
        )
        expect(parsed.intents).toEqual([])
        expect(parsed.malformed?.length).toBe(1)
        expect(parsed.malformed?.[0]?.field).toBe("now.arguments")
        expect(parsed.malformed?.[0]?.hint).toContain("output limit")
    })

    test.each([
        ["an array", "[1,2]", "an array"],
        ["a number", "42", "number"],
        ["null", "null", "object"],
    ])("%s is refused, because arguments are always an object", (_label, raw, expected) => {
        const parsed = parseNative(output({ calls: [{ id: "c1", name: "now", arguments: raw }] }))
        expect(parsed.intents).toEqual([])
        expect(parsed.malformed?.[0]?.message).toContain(expected)
    })

    test("a call with no function name is reported rather than dropped", () => {
        const parsed = parseNative(output({ calls: [{ id: "c1", name: "  ", arguments: "{}" }] }))
        expect(parsed.intents).toEqual([])
        expect(parsed.malformed?.[0]?.field).toContain("unnamed")
    })

    test("one unreadable call does not discard a readable one from the same step", () => {
        // Both are reported: the readable intent still exists, and the loop refuses to run *any* of
        // them because a step is all-or-nothing. Dropping the good one here would hide what happened.
        const parsed = parseNative(
            output({
                calls: [
                    { id: "c1", name: "now", arguments: "{}" },
                    { id: "c2", name: "send_email", arguments: "{oops" },
                ],
            }),
        )
        expect(parsed.intents.map((intent) => intent.callId)).toEqual(["c1"])
        expect(parsed.malformed?.length).toBe(1)
    })
})

// ─── writing the history back ────────────────────────────────────────────────────────────

describe("the assistant message", () => {
    test("replays the calls, so the tool messages after it answer something", () => {
        const calls = [{ id: "c1", name: "now", arguments: "{}" }]
        expect(nativeDialect.renderCall(output({ text: "One moment.", calls }))).toEqual({
            role: "assistant",
            content: "One moment.",
            toolCalls: calls,
        })
    })

    test("a plain reply carries no calls key", () => {
        expect(nativeDialect.renderCall(output({ text: "Nine o'clock." }))).toEqual({
            role: "assistant",
            content: "Nine o'clock.",
        })
    })
})

function result(over: Partial<ToolResult> = {}): ToolResult {
    return {
        callId: "c1",
        slug: "now",
        ok: true,
        output: "2026-08-13",
        trust: "trusted",
        latencyMs: 1,
        bytes: 10,
        truncated: false,
        ...over,
    }
}

describe("observations", () => {
    test("one tool message per call, each naming the call it answers", () => {
        const messages = nativeDialect.renderObservation([
            result(),
            result({ callId: "c2", slug: "send_email", ok: false, output: "no recipient" }),
        ])
        expect(messages.map((message) => message.role)).toEqual(["tool", "tool"])
        expect(messages.map((message) => message.toolCallId)).toEqual(["c1", "c2"])
        expect(messages[1]?.content).toBe("no recipient")
    })

    test("a tool that returned nothing says so rather than looking like a blank success", () => {
        expect(nativeDialect.renderObservation([result({ output: "  " })])[0]?.content).toBe(
            "(no output)",
        )
    })

    test("no continue-or-reply nudge — the protocol already says an assistant turn follows", () => {
        // NLT needs that line because prose is its only channel. Repeating it per tool message here
        // would spend tokens telling the model something the API told it structurally.
        const native = nativeDialect.renderObservation([result()])[0]?.content ?? ""
        const nlt = nltDialect.renderObservation([result()])[0]?.content ?? ""
        expect(nlt).toContain("Continue.")
        expect(native.includes("Continue.")).toBe(false)
    })
})

describe("the one repair", () => {
    const CALLS = [
        { id: "c1", name: "now", arguments: "{}" },
        { id: "c2", name: "send_email", arguments: "{oops" },
    ]

    function repair(): readonly ChatMessage[] {
        return nativeDialect.renderRepair(
            [
                {
                    field: "send_email.arguments",
                    message: "was not valid JSON.",
                    hint: "Send one JSON object.",
                },
            ],
            output({ calls: CALLS }),
        )
    }

    test("every announced call is answered, including the unreadable one", () => {
        // An unanswered `tool_calls` entry is a protocol error, and the unreadable call never became
        // an intent — which is exactly why this is driven by the step's calls rather than its intents.
        const answered = repair()
            .filter((message) => message.role === "tool")
            .map((message) => message.toolCallId)
        expect(answered).toEqual(["c1", "c2"])
    })

    test("the broken call is told what was wrong with it", () => {
        const broken = repair().find((message) => message.toolCallId === "c2")
        expect(broken?.content).toContain("was not valid JSON.")
        expect(broken?.content).toContain("Send one JSON object.")
    })

    test("a call that was fine is told it did not run, and why", () => {
        // The difference between "retry everything" and "your call vanished".
        const fine = repair().find((message) => message.toolCallId === "c1")
        expect(fine?.content).toContain("was not run")
        expect(fine?.content).toContain("all of its calls or none")
    })

    test("and one instruction at the end, saying it is the only retry", () => {
        const last = repair().at(-1)
        expect(last?.role).toBe("user")
        expect(last?.content).toContain("only retry")
    })
})

describe("streaming", () => {
    test("nothing is held back — a call is not text here", () => {
        const filter = nativeDialect.createStreamFilter()
        expect(filter.push("ACTION: now\n")).toBe("ACTION: now\n")
        expect(filter.end()).toBe("")
    })
})

describe("the trust boundary, rendered", () => {
    test("every announced call is answered, gated ones included", () => {
        // The protocol invariant: an unanswered tool_call makes the endpoint reject the next
        // request outright. This is the test that fails if anyone ever "optimises" the write gate
        // by dropping the call instead of answering it.
        const messages = nativeDialect.renderObservation([
            result({ callId: "c1" }),
            result({ callId: "c2", ok: false, gated: true, output: "was not run" }),
            result({ callId: "c3" }),
        ])
        expect(messages.map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"])
    })

    test("an untrusted tool message carries the same fence NLT produced", () => {
        // Asserted against the shared helper rather than an inline literal, so the two dialects
        // cannot drift into delimiting the same bytes differently.
        const untrusted = result({
            slug: "web_fetch",
            trust: "untrusted",
            output: "a page of text long enough to be worth fencing",
        })
        const [message] = nativeDialect.renderObservation([untrusted])
        expect(message?.content).toBe(renderTrusted(untrusted))
        expect(message?.content).toContain(untrustedFence("web_fetch").open)
    })
})
