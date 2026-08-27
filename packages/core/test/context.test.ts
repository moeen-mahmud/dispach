/**
 * Context assembly's reported shape.
 *
 * `slotReport` feeds `GET /v1/agents/:id/context` and the `context.assembled` event, and it had no
 * tests at all — which is how it came to drop `label` while `ContextBlock.label`'s own comment
 * described it as existing for that endpoint. An unasserted wire field is one nobody notices the
 * absence of.
 */

import { assembleContext, slotReport } from "../src/context/assemble.ts"
import { SLOT, VOLATILE_HEADER } from "../src/context/blocks.ts"
import { renderConfigSummary } from "../src/context/config-summary.ts"
import { estimateTokens } from "../src/context/tokens.ts"
import { describe, expect, test } from "./_harness.ts"

function assemble() {
    return assembleContext({
        identity: "You are a test fixture.",
        history: [
            { role: "user", content: "first" },
            { role: "assistant", content: "second" },
            { role: "user", content: "third" },
        ],
        input: "what now",
        lastError: "something went wrong earlier",
        window: 8192,
        reserveOutput: 1024,
    })
}

describe("slotReport", () => {
    test("every reported slot carries a label, not just a number", () => {
        // The regression guard. Slot numbers are positional and renumber whenever a slot is inserted,
        // so a consumer reading meaning from the number breaks on the next insertion.
        const report = slotReport(assemble().blocks)
        expect(report.length > 0).toBe(true)
        for (const entry of report) {
            expect(entry.label.length > 0).toBe(true)
        }
    })

    test("labels name the slots actually assembled", () => {
        const byLabel = new Map(slotReport(assemble().blocks).map((e) => [e.label, e.slot]))
        expect(byLabel.get("identity")).toBe(SLOT.identity)
        expect(byLabel.get("history")).toBe(SLOT.history)
        expect(byLabel.get("input")).toBe(SLOT.input)
        expect(byLabel.get("last-error")).toBe(SLOT.error)
    })

    test("blocks sharing a slot collapse to one entry whose tokens sum", () => {
        // Three history messages are three blocks in slot 6. The report is per slot, not per block.
        const assembled = assemble()
        const historyBlocks = assembled.blocks.filter((b) => b.slot === SLOT.history)
        expect(historyBlocks.length).toBe(3)

        const entry = slotReport(assembled.blocks).find((e) => e.slot === SLOT.history)
        const summed = historyBlocks.reduce((total, b) => total + b.tokens, 0)
        expect(entry?.tokens).toBe(summed)
    })

    test("entries are ordered by slot, which is prompt order", () => {
        const slots = slotReport(assemble().blocks).map((e) => e.slot)
        expect([...slots].sort((a, b) => a - b)).toEqual(slots)
    })

    test("pinned survives into the report — it is what says a slot outlives compaction", () => {
        const report = slotReport(assemble().blocks)
        expect(report.find((e) => e.slot === SLOT.identity)?.pinned).toBe(true)
        expect(report.find((e) => e.slot === SLOT.history)?.pinned).toBe(false)
    })

    test("reported tokens total the assembled total", () => {
        const assembled = assemble()
        const total = slotReport(assembled.blocks).reduce((sum, e) => sum + e.tokens, 0)
        expect(total).toBe(assembled.totalTokens)
    })
})

describe("slot numbering", () => {
    test("every slot number is distinct — a collision would merge two slots in the report", () => {
        const numbers = Object.values(SLOT)
        expect(new Set(numbers).size).toBe(numbers.length)
    })

    test("declared order matches numeric order, so the architecture table reads top to bottom", () => {
        // The invariant that makes slot number mean prompt position. Inserting a slot out of order
        // here is how the doc table and the assembled prompt quietly stop agreeing.
        const numbers = Object.values(SLOT)
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers)
    })

    test("the workspace tiers sit where the cache and recency arguments put them", () => {
        // volatile after the cached prefix; reminder after the history and before the input.
        expect(SLOT.volatile > SLOT.tools).toBe(true)
        expect(SLOT.reminder > SLOT.history).toBe(true)
        expect(SLOT.reminder < SLOT.input).toBe(true)
    })
})

describe("workspace tiers in the assembled prompt", () => {
    function withTiers(volatileText: string) {
        return assembleContext({
            identity: "You are a test fixture.",
            toolBlocks: [
                {
                    slot: SLOT.tools,
                    role: "system",
                    content: "TOOLS: none",
                    pinned: true,
                    tokens: 4,
                    label: "tools",
                },
            ],
            volatile: volatileText,
            reminder: "Answer in prose.",
            history: [
                { role: "user", content: "first" },
                { role: "assistant", content: "second" },
            ],
            input: "what now",
            window: 8192,
            reserveOutput: 1024,
        })
    }

    test("a volatile change leaves slots 0 and 1 byte-identical", () => {
        // The whole reason slot 2 exists. Prompt caching matches a byte-exact prefix, so a memory
        // write that moved slot 0's bytes would invalidate the cache on every write — with no error,
        // no failed turn, and no symptom other than the bill.
        const before = withTiers("Known: the user prefers metric units.")
        const after = withTiers("Known: the user prefers metric units. Lives in Lisbon.")

        const prefix = (assembled: ReturnType<typeof withTiers>): string =>
            assembled.blocks
                .filter((b) => b.slot === SLOT.identity || b.slot === SLOT.tools)
                .map((b) => b.content)
                .join(" ")

        expect(prefix(after)).toBe(prefix(before))
        expect(before.blocks.some((b) => b.slot === SLOT.volatile)).toBe(true)
    })

    test("volatile follows the catalogue and precedes the history", () => {
        const slots = withTiers("Memory.").blocks.map((b) => b.slot)
        expect(slots.indexOf(SLOT.volatile) > slots.indexOf(SLOT.tools)).toBe(true)
        expect(slots.indexOf(SLOT.volatile) < slots.indexOf(SLOT.history)).toBe(true)
    })

    test("reminder lands after the history and before the input", () => {
        const slots = withTiers("Memory.").blocks.map((b) => b.slot)
        expect(slots.lastIndexOf(SLOT.history) < slots.indexOf(SLOT.reminder)).toBe(true)
        expect(slots.indexOf(SLOT.reminder) < slots.indexOf(SLOT.input)).toBe(true)
    })

    test("both tiers are pinned, so compaction cannot eat them", () => {
        const report = slotReport(withTiers("Memory.").blocks)
        expect(report.find((e) => e.slot === SLOT.volatile)?.pinned).toBe(true)
        expect(report.find((e) => e.slot === SLOT.reminder)?.pinned).toBe(true)
        expect(report.find((e) => e.slot === SLOT.reminder)?.label).toBe("workspace-reminder")
    })

    test("an empty tier produces no block at all", () => {
        const slots = withTiers("").blocks.map((b) => b.slot)
        expect(slots.includes(SLOT.volatile)).toBe(false)
    })
})

describe("examples and knowledge slots", () => {
    function assembleWithExtras() {
        return assembleContext({
            identity: "You are a test fixture.",
            examples: "Example 1:\nuser: hi\nagent: hello",
            volatile: "## Memory\nremembers things",
            knowledge: [
                { name: "deploys.md", content: "Use blue-green." },
                { name: "oncall.md", content: "Page the secondary first." },
            ],
            history: [{ role: "user", content: "first" }],
            input: "what now",
            window: 8192,
            reserveOutput: 1024,
        })
    }

    test("examples travel as a user message between the catalogue and the volatile tier", () => {
        const blocks = assembleWithExtras().blocks
        const examples = blocks.find((b) => b.label === "workspace-examples")
        expect(examples?.role).toBe("user")
        expect(examples?.slot).toBe(SLOT.examples)
        expect(examples?.pinned).toBe(true)
        // Order in the message sequence: identity, examples, volatile — the byte-stable content
        // stays contiguous ahead of the tier that mutates, or prefix caching loses it.
        const labels = blocks.map((b) => b.label)
        expect(labels.indexOf("workspace-examples")).toBeGreaterThan(labels.indexOf("identity"))
        expect(labels.indexOf("workspace-volatile")).toBeGreaterThan(
            labels.indexOf("workspace-examples"),
        )
    })

    test("knowledge blocks are budgeted but not pinned — compaction may drop them", () => {
        const blocks = assembleWithExtras().blocks
        const knowledge = blocks.filter((b) => b.slot === SLOT.knowledge)
        expect(knowledge.length).toBe(2)
        for (const block of knowledge) {
            expect(block.pinned).toBe(false)
            expect(block.role).toBe("system")
        }
        // They sit after the volatile tier and before the history they inform.
        const labels = blocks.map((b) => b.label)
        expect(labels.indexOf("knowledge:deploys.md")).toBeGreaterThan(
            labels.indexOf("workspace-volatile"),
        )
        expect(labels.indexOf("history")).toBeGreaterThan(labels.indexOf("knowledge:oncall.md"))
    })

    test("absent examples and knowledge assemble exactly as before", () => {
        const labels = assemble().blocks.map((b) => b.label)
        expect(labels.includes("workspace-examples")).toBe(false)
        expect(labels.some((label) => label.startsWith("knowledge:"))).toBe(false)
    })
})

describe("the volatile tier is framed, not bare", () => {
    test("the header says what the block is, in front of the authored text", () => {
        // The bug: a fresh agent whose USER.md said "Moeen is the person I work for" answered "No,
        // I can't read your name. Each session starts fresh." The fact was in its context, twice.
        // Every other slot arrives framed; the one whose job is "what you know about the person"
        // arrived as an unlabelled paragraph.
        const assembled = assembleContext({
            identity: "I am a test agent.",
            volatile: "Moeen is the person I work for.",
            input: "do you know me?",
            history: [],
            window: 8192,
            reserveOutput: 512,
        })
        const block = assembled.blocks.find((entry) => entry.label === "workspace-volatile")
        expect(block?.content.startsWith(VOLATILE_HEADER)).toBe(true)
        // The authored text is untouched and still present — framing is not rewriting.
        expect(block?.content).toContain("Moeen is the person I work for.")
    })

    test("an empty volatile tier gets no block and therefore no header", () => {
        const assembled = assembleContext({
            identity: "I am a test agent.",
            volatile: "   ",
            input: "hi",
            history: [],
            window: 8192,
            reserveOutput: 512,
        })
        expect(assembled.blocks.some((entry) => entry.label === "workspace-volatile")).toBe(false)
    })
})

// ─── slot 2: the agent's own configuration ───────────────────────────────────────────────

describe("the configuration block", () => {
    const base = {
        path: "/agents/milo/agent.yaml",
        window: 65_536,
        tools: ["now", "config_read", "config_set"],
        providers: ["system", "web"],
        channelsStarted: false,
        schedulerStarted: false,
        serverListening: false,
    }

    function manifestFor(over: Record<string, unknown> = {}) {
        return {
            id: "milo",
            name: "Milo",
            model: { main: { id: "deepseek-v4-flash" } },
            tools: {
                dialect: "nlt",
                policy: { mode: "allow", allow: ["exec"], deny: ["exec(rm *)"] },
                untrusted: { onMutate: "refuse" },
            },
            channels: [],
            schedules: [],
            server: { enabled: false, host: "127.0.0.1", port: 7420 },
            ...over,
        } as never
    }

    test("names the file, so the agent knows its settings are a file at all", () => {
        // The failure: an agent asked to put itself on Telegram started writing a bridge. It had
        // config_set pinned and no idea a `channels` setting existed.
        const text = renderConfigSummary({ ...base, manifest: manifestFor() })
        expect(text).toContain("/agents/milo/agent.yaml")
        expect(text).toContain("configuration, not something to build")
    })

    test("an absent capability is a row saying none, never a missing row", () => {
        // A missing row reads as "no such concept". A row saying `none` reads as a switch that is
        // off — which is the difference between inventing a bridge and writing four lines of YAML.
        const text = renderConfigSummary({ ...base, manifest: manifestFor() })
        expect(text).toContain("channels")
        expect(text).toContain("none — I am reached through the CLI and the HTTP API only")
        expect(text).toContain("http api")
    })

    test("the skills row names them, because every real question is which and not how many", () => {
        // The measured defect: the row said "1 available" and a real agent asked "what skills do you
        // have?" spent four tool calls and 1,358 output tokens finding out — `config_read`, two globs and
        // a `file_read`, with its reasoning visibly guessing whether `./skills` resolved against the
        // workspace or the agent directory. That is the two-hop shape this block exists to remove.
        const text = renderConfigSummary({
            ...base,
            skillNames: ["pdf", "release-notes"],
            manifest: manifestFor({
                skills: { dir: "./skills", maxActive: 1, threshold: 0.35, budget: 5000 },
            }),
        })
        expect(text).toContain("pdf, release-notes")
        expect(text).toContain("At most 1 per turn")
        // Naming is not choosing: the harness still selects, and the row must keep saying so or a model
        // reads a list as a menu.
        expect(text).toContain("I do not choose one")
    })

    test("beyond a dozen it names some and counts the rest — slot 2 is a summary, not the catalogue", () => {
        const many = Array.from({ length: 20 }, (_, index) => `skill-${index}`)
        const text = renderConfigSummary({
            ...base,
            skillNames: many,
            manifest: manifestFor({
                skills: { dir: "./skills", maxActive: 1, threshold: 0.35, budget: 5000 },
            }),
        })
        expect(text).toContain("20 available")
        expect(text).toContain("and 8 more")
        expect(text.includes("skill-19")).toBe(false)
    })

    test("configured and empty is a different row from not configured at all", () => {
        const empty = renderConfigSummary({
            ...base,
            skillNames: [],
            manifest: manifestFor({
                skills: { dir: "./skills", maxActive: 1, threshold: 0.35, budget: 5000 },
            }),
        })
        expect(empty).toContain("and empty")
        const absent = renderConfigSummary({ ...base, manifest: manifestFor() })
        expect(absent).toContain("no skills directory is configured")
    })

    test("a configured channel is named with its id and type", () => {
        const text = renderConfigSummary({
            ...base,
            channelsStarted: true,
            schedulerStarted: false,
            serverListening: true,
            manifest: manifestFor({
                channels: [{ id: "tg", type: "telegram", enabled: true }],
                server: { enabled: true, host: "127.0.0.1", port: 7420 },
            }),
        })
        expect(text).toContain("tg (telegram)")
        expect(text).toContain("connected in this session")
        expect(text).toContain("on, 127.0.0.1:7420")
    })

    test("configured but not started says so — state, not configuration", () => {
        // The failure: under `run`, slot 2 described the manifest, so the agent was told
        // "channels: tg (telegram)", concluded the Telegram runtime had died, reported that nothing
        // was listening on 7420 — from inside the running process — and offered a LaunchAgent.
        const text = renderConfigSummary({
            ...base,
            channelsStarted: false,
            schedulerStarted: false,
            serverListening: false,
            manifest: manifestFor({
                channels: [{ id: "tg", type: "telegram", enabled: true }],
                server: { enabled: true, host: "127.0.0.1", port: 7420 },
            }),
        })
        expect(text).toContain("NOT running in this session")
        expect(text).toContain("`serve` starts channels")
        expect(text).toContain("NOT listening in this session")
    })

    test("a disabled channel is not reported as reachable", () => {
        const text = renderConfigSummary({
            ...base,
            manifest: manifestFor({ channels: [{ id: "tg", type: "telegram", enabled: false }] }),
        })
        expect(text).toContain("none — I am reached")
    })

    test("without config_set it says who to ask instead of how to change it", () => {
        // Telling an agent to use a tool it does not have is this file's own failure, reversed.
        const text = renderConfigSummary({ ...base, tools: ["now"], manifest: manifestFor() })
        expect(text).toContain("no tool to change it")
        expect(text.includes("I edit it with config_set")).toBe(false)
    })

    test("it stays small — this is paid on every turn of every session, forever", () => {
        const text = renderConfigSummary({ ...base, manifest: manifestFor() })
        // A guard against drift, not a precise budget: the whole manifest cost 2,766 tokens and
        // was middle-cut on every read, and this is under a tenth of that — which is the anchor the
        // number is checked against rather than the number itself.
        //
        // Raised from 240 when the `memory` row was added, and the row was trimmed twice first: a new
        // *capability* is a legitimate reason for this to grow, a wordier sentence about an existing
        // one is not. The row costs about twelve tokens and it is here because its absence was
        // measured — an agent holding three excerpts of its own earlier sessions still asserted that
        // "the transcripts themselves don't carry over", having no row to tell it otherwise.
        // `estimateTokens` is biased about 10% high, so the real figure sits near 200.
        expect(estimateTokens(text)).toBeLessThan(260)
    })
})

describe("the blunt trim, and what it may not cut", () => {
    /** One oversized observation, larger on its own than the whole prompt budget. */
    function overSized(protectedTail?: number) {
        return assembleContext({
            identity: "You are a test fixture.",
            history: [
                { role: "user", content: "the original request" },
                { role: "assistant", content: "ACTION exec", origin: "call" },
                {
                    role: "user",
                    content: `OBSERVATION exec — ok\n${"row\n".repeat(4000)}`,
                    origin: "observation",
                },
            ],
            input: "what now",
            window: 2000,
            reserveOutput: 500,
            ...(protectedTail === undefined ? {} : { protectedTail }),
        })
    }

    test("what the person said survives even here, and the rest is reported", () => {
        // The last-resort path, reached exactly when the ladder fell short — which is the worst moment
        // to also lose the instruction. One predicate (`isTurnStart`) with the ladder, because two
        // definitions of "what the person said" is how one path honoured the rule and the other did
        // not, on the same session a moment apart.
        const assembled = overSized()
        const history = assembled.blocks.filter((block) => block.slot === SLOT.history)
        expect(history.map((block) => block.content)).toEqual(["the original request"])
        expect(assembled.droppedMessages).toBe(2)
    })

    test("the current turn's call and observation survive whatever they cost", () => {
        // The walk is newest-first and stops at the first message that will not fit, dropping
        // everything older. When the message that will not fit *is* the newest one — a tool result
        // bigger than the remaining budget — that stop happens immediately and takes the whole
        // history with it, including the call and result the model is about to reason over. It then
        // answers as though the tool had never run, and nothing anywhere says so.
        const assembled = overSized(2)
        const history = assembled.blocks.filter((block) => block.slot === SLOT.history)
        expect(history[0]?.content).toBe("ACTION exec")
        expect(history[1]?.content).toContain("OBSERVATION exec")
        // And nothing else, because the tail alone has already passed the window: the request cannot
        // be rescued on top of it. Keeping the tail is a reserve being spent; adding to a prompt that
        // has already passed the window is a request the endpoint refuses.
        expect(history.length).toBe(2)
    })

    test("a request is rescued when there is room for it under the window", () => {
        const assembled = assembleContext({
            identity: "You are a test fixture.",
            history: [
                { role: "user", content: "the original request" },
                { role: "assistant", content: "ACTION exec", origin: "call" },
                {
                    role: "user",
                    content: `OBSERVATION exec — ok\n${"row\n".repeat(2000)}`,
                    origin: "observation",
                },
                { role: "user", content: "and the newest thing I said" },
            ],
            input: "what now",
            window: 3000,
            reserveOutput: 500,
            protectedTail: 1,
        })
        const history = assembled.blocks.filter((block) => block.slot === SLOT.history)
        const contents = history.map((block) => block.content)
        // Both requests, and the observation is what went.
        expect(contents).toContain("the original request")
        expect(contents).toContain("and the newest thing I said")
        expect(contents.some((content) => content.includes("OBSERVATION"))).toBe(false)
        expect(assembled.droppedMessages).toBeGreaterThan(0)
    })

    test("a tail longer than the history is clamped, not trusted", () => {
        // A caller reporting more tail than it passed would otherwise protect a negative range.
        const assembled = overSized(99)
        expect(assembled.blocks.filter((block) => block.slot === SLOT.history).length).toBe(3)
        expect(assembled.droppedMessages).toBe(0)
    })
})
