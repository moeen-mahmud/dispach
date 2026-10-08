/**
 * `memory_forget` (pilot.15, VelaCrew's "memory purge" skill), through a real runtime: a query lists and
 * deletes nothing, ids delete exactly those notes from the carried file and the archive, recall cannot
 * find them afterwards, and a turn that may not write private memory may not delete it either.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AnyEvent, BRAND, type ChatChunk, type ModelTransport, Runtime } from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/**
 * "forget <words>" lists with `query`; "confirm" deletes every id the last listing showed. The
 * observations it read are kept so a test can see what the model was told.
 */
function model(observations: string[]): ModelTransport {
    let listed: string[] = []
    // The input slot follows the history, so a tool result is never the last message: key on the input.
    let called = ""
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                const input = String(request.messages.findLast((m) => m.role === "user")?.content)
                if (called === input) {
                    const text = String(
                        request.messages.findLast((m) => m.role === "tool")?.content,
                    )
                    observations.push(text)
                    const ids = text.match(/\b(?:mem|mn|msg)_[0-9a-z_]+/g)
                    if (ids !== null && text.includes("Nothing is deleted yet")) listed = ids
                    // The agent restates a saved note in its own words, which no text match finds.
                    yield {
                        type: "text",
                        delta: input.startsWith("note my ")
                            ? `Remembered: your ${input.slice("note my ".length)}.`
                            : "done",
                    }
                    yield { type: "finish", reason: "stop" }
                    return
                }
                called = input
                if (input.startsWith("say ")) {
                    yield { type: "text", delta: `Noted: ${input.slice(4)}` }
                    yield { type: "finish", reason: "stop" }
                    return
                }
                if (input.startsWith("note ")) {
                    yield {
                        type: "tool_call",
                        call: {
                            id: "w1",
                            name: "memory_write",
                            arguments: JSON.stringify({ text: input.slice(5) }),
                        },
                    }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                const args = input.startsWith("forget ")
                    ? { query: input.slice("forget ".length) }
                    : { ids: listed }
                yield {
                    type: "tool_call",
                    call: { id: "f1", name: "memory_forget", arguments: JSON.stringify(args) },
                }
                yield { type: "finish", reason: "tool_calls" }
            },
        }),
    }
}

const CARRIED = `---
tier: volatile
editable: replace
budget: 2000
eviction: oldest
---

# What I know

- **2026-10-01T10:00:00Z** Ada is negotiating with Acme about the renewal.
- **2026-10-02T10:00:00Z** Ada prefers meetings before noon.
`
const ARCHIVE = `# Archive

- **2026-08-01T10:00:00Z** The Acme contract renews in March.
`

async function boot() {
    const dir = mkdtempSync(join(tmpdir(), "forget-"))
    mkdirSync(join(dir, "workspace"), { recursive: true })
    mkdirSync(join(dir, "memory"), { recursive: true })
    writeFileSync(join(dir, "workspace", "MEMORY.md"), CARRIED)
    writeFileSync(join(dir, "memory", "2026-08.md"), ARCHIVE)
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: adabot
model:
  main:
    id: m
    api: scripted
    capabilities:
      nativeTools: true
context:
  workspace: ./workspace
  volatile:
    - MEMORY.md
memory:
  dir: ./memory
  threshold: 0.01
tools:
  dialect: native
  pinned: [memory_write, memory_forget]
  policy:
    allow: [memory_write, memory_forget]
standIn:
  enabled: true
  escalateAfterMs: 0
`,
    )
    const observations: string[] = []
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: { scripted: model(observations) },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    const agent = runtime.agent("adabot")
    if (agent === undefined) throw new Error("adabot did not load")
    const files = {
        carried: () => readFileSync(join(dir, "workspace", "MEMORY.md"), "utf8"),
        archive: () => readFileSync(join(dir, "memory", "2026-08.md"), "utf8"),
    }
    return { runtime, agent, observations, events, files }
}

describe("memory_forget", () => {
    test("a query lists and deletes nothing; the ids then delete exactly those notes", async () => {
        const { runtime, agent, observations, events, files } = await boot()

        await agent.send("forget acme")
        expect(observations[0]).toContain("2 notes in your notes match")
        expect(observations[0]).toContain("renewal")
        expect(observations[0]).toContain("renews in March")
        expect(files.carried()).toBe(CARRIED)
        expect(files.archive()).toBe(ARCHIVE)

        await agent.send("confirm")
        expect(observations[1]).toContain("Deleted 2 notes")
        // The note about meetings, the frontmatter and the headings are the person's and stay.
        expect(files.carried()).not.toContain("Acme")
        expect(files.carried()).toContain("prefers meetings before noon")
        expect(files.carried()).toContain("# What I know")
        expect(files.carried()).toContain("eviction: oldest")
        expect(files.archive()).not.toContain("Acme")
        expect(files.archive()).toContain("# Archive")

        const forgotten = events.filter((event) => event.type === "memory.forgotten")
        expect(forgotten.map((event) => event.data)).toEqual([{ scope: "private", count: 2 }])
        // Recall reconciles against the files, so nothing indexed can bring them back.
        const search = await agent.searchMemory({ query: "acme contract renewal" })
        expect(search.hits.some((hit) => hit.passage.text.includes("Acme"))).toBe(false)
        await runtime.stop()
    })

    test("a stand-in may not delete the owner's private notes", async () => {
        const { runtime, agent, observations, events, files } = await boot()
        await runtime.conversations.registerParticipant({ id: "user:ada", name: "Ada" })
        await runtime.conversations.registerParticipant({ id: "user:bob", name: "Bob" })
        await runtime.conversations.assign({ agentId: "adabot", participantId: "user:ada" })

        await agent.send("forget acme", {
            sessionKey: "api:bob",
            participant: { id: "user:bob", via: "api", onBehalfOf: "user:ada" },
        })
        expect(observations.join("\n")).not.toContain("match")
        expect(files.carried()).toBe(CARRIED)
        expect(events.some((event) => event.type === "memory.forgotten")).toBe(false)
        expect(observations.join("\n")).toContain("cannot change your private memory")
        await runtime.stop()
    })

    test("the space writer forgets the team's notes, and only those", async () => {
        const { runtime, agent, observations, events, files } = await boot()
        await runtime.conversations.setSpaceWriter("agent:adabot")
        await runtime.conversations.addNote({
            scope: "space",
            text: "Acme is the anchor customer.",
        })
        await runtime.conversations.addNote({ scope: "space", text: "Retro is on Fridays." })

        await agent.send("forget acme")
        expect(observations[0]).toContain("1 note in the team's shared memory matches")
        await agent.send("confirm")
        const left = await runtime.conversations.notes("space")
        expect(left.map((note) => note.text)).toEqual(["Retro is on Fridays."])
        expect(files.carried()).toBe(CARRIED)
        expect(events.find((event) => event.type === "memory.forgotten")?.data).toEqual({
            scope: "space",
            count: 1,
        })
        await runtime.stop()
    })

    test("past conversations are listed, redacted, and gone from recall, the asking included", async () => {
        const { runtime, agent, observations, events } = await boot()
        await runtime.conversations.registerParticipant({ id: "user:ada", name: "Ada" })
        await runtime.conversations.registerParticipant({ id: "user:bob", name: "Bob" })
        await runtime.conversations.assign({ agentId: "adabot", participantId: "user:ada" })
        const as = (id: string, session: string) => ({
            sessionKey: session,
            participant: { id, via: "api" as const },
        })

        await agent.send("note my dentist is Dr Rahman", as("user:ada", "api:one"))
        await agent.send("say my dentist is Dr Okafor", as("user:bob", "api:bob"))

        // A webhook already carried it; the silo's own copy of that delivery goes too.
        await runtime.store.webhooks.create({
            subscriptionId: "wh_1",
            url: "https://hooks.example.com/a",
            secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0",
            types: ["turn.end"],
            createdAt: new Date().toISOString(),
        })
        await runtime.store.webhooks.enqueue({
            subscriptionId: "wh_1",
            messageId: "m1",
            agentId: "adabot",
            eventType: "turn.end",
            body: JSON.stringify({ data: { finalText: "Remembered: your dentist is Dr Rahman." } }),
            at: new Date().toISOString(),
        })

        await agent.send("forget my dentist", as("user:ada", "api:two"))
        const listing = observations.at(-1) ?? ""
        expect(listing).toContain("Rahman")
        expect(listing).toContain("said to you")
        // Bob said it to the same agent, and it is not Ada's to forget.
        expect(listing).not.toContain("Okafor")

        await agent.send("confirm", as("user:ada", "api:two"))
        // The index is brought up to date by the delete itself, not by whichever turn reads it next.
        expect(await runtime.store.memory.candidates("adabot", ["rahman"], 10)).toEqual([])
        expect(observations.at(-1)).toContain("Deleted")
        expect(events.find((event) => event.type === "memory.forgotten")?.data).toEqual({
            scope: "private",
            count: 1,
            messages: 1,
        })

        // Nothing Ada said about it survives anywhere a later session could read it, the request
        // to forget included; Bob's conversation is untouched.
        // Content and tool-call arguments both: memory_write's own call carried the fact verbatim.
        const texts = async (key: string) =>
            (await runtime.store.messages.page("adabot", key, { limit: 100 })).messages
                .map((message) => `${message.content} ${JSON.stringify(message.toolCalls ?? [])}`)
                .join("\n")
        expect(await texts("api:one")).not.toContain("Rahman")
        expect(await texts("api:two")).not.toContain("Rahman")
        expect(await texts("api:two")).not.toContain("dentist")
        expect(await texts("api:bob")).toContain("Okafor")
        const delivered = await runtime.store.webhooks.claimDue(
            ["adabot"],
            "9999-01-01T00:00:00Z",
            10,
        )
        expect(delivered.map((row) => row.body).join("\n")).not.toContain("Rahman")
        // The call itself survives, so a native trace still replays.
        const one = (await runtime.store.messages.page("adabot", "api:one", { limit: 100 }))
            .messages
        expect(one.some((message) => message.toolCalls?.[0]?.name === "memory_write")).toBe(true)
        const search = await agent.searchMemory({ query: "dentist Rahman" })
        expect(search.hits.some((hit) => hit.passage.text.includes("Rahman"))).toBe(false)
        await runtime.stop()
    })
})
