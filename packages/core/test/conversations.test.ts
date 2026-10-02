/**
 * Rooms and DMs (Phase 27), through a real runtime: who answers, what each agent read, where the loop
 * stops, and what a room's text is allowed to make an agent do.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type AnyEvent,
    BRAND,
    type ChatChunk,
    type ChatMessage,
    isHarnessError,
    type ModelTransport,
    mentionsIn,
    Runtime,
    type ToolProviderFactory,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/** A model that answers every turn with `reply(input)`, recording each request it was sent. */
function scripted(reply: (input: string) => string, seen: ChatMessage[][] = []): ModelTransport {
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                seen.push([...request.messages])
                const input = String(request.messages.findLast((m) => m.role === "user")?.content)
                yield { type: "text", delta: reply(input) }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

/** A model that calls `send_email` once per input, then answers. */
function mutating(): ModelTransport {
    const called = new Set<string>()
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                const input = String(request.messages.findLast((m) => m.role === "user")?.content)
                if (!called.has(input)) {
                    called.add(input)
                    yield {
                        type: "tool_call",
                        call: {
                            id: "c1",
                            name: "send_email",
                            arguments: JSON.stringify({ to: "x@y.test" }),
                        },
                    }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                yield { type: "text", delta: "done" }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

function emailTool(sent: string[]): ToolProviderFactory {
    return () => ({
        id: "mail",
        resolve: async (slugs) =>
            slugs.includes("send_email")
                ? [
                      {
                          spec: {
                              slug: "send_email",
                              provider: "mail",
                              summary: "Send an email.",
                              whenToUse: "Asked to email someone.",
                              mutating: true,
                              trust: "trusted",
                              trustReason: "test fixture",
                              tags: [],
                              parameters: {
                                  type: "object",
                                  properties: { to: { type: "string" } },
                              },
                          },
                          handler: async (args) => {
                              sent.push(String(args.to))
                              return "sent"
                          },
                      },
                  ]
                : [],
    })
}

function manifest(dir: string, id: string, api: string, extra = ""): string {
    const path = join(dir, `${id}.yaml`)
    writeFileSync(
        path,
        `apiVersion: ${BRAND.apiVersion}\nid: ${id}\nmodel:\n  main:\n    id: m\n    api: ${api}\n    capabilities:\n      nativeTools: true\ntools:\n  dialect: native\n${extra}`,
    )
    return path
}

async function boot(
    transports: Record<string, ModelTransport>,
    extra: Record<string, string> = {},
    toolProviders: Record<string, ToolProviderFactory> = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "rooms-"))
    const runtime = await Runtime.create({
        agents: Object.keys(transports).map((id) => manifest(dir, id, id, extra[id] ?? "")),
        env: {},
        store: ":memory:",
        modelTransports: transports,
        toolProviders,
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    await runtime.conversations.registerParticipant({ id: "user:ada", name: "Ada" })
    await runtime.conversations.registerParticipant({ id: "user:bob", name: "Bob" })
    return { runtime, events }
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
    try {
        await work()
    } catch (error) {
        if (isHarnessError(error)) return error.code
        throw error
    }
    throw new Error("expected a refusal")
}

describe("a room", () => {
    test("two agents told to answer each other stop at the hop ceiling, and the event says why", async () => {
        const { runtime, events } = await boot({
            alpha: scripted(() => "@beta over to you"),
            beta: scripted(() => "@alpha back to you"),
        })
        const room = await runtime.conversations.create({
            kind: "room",
            members: ["user:ada", "agent:alpha", "agent:beta"],
        })
        await runtime.conversations.post({
            conversationId: room.id,
            authorId: "user:ada",
            text: "alpha, start a relay with beta",
            mentions: ["agent:alpha"],
        })
        await runtime.conversations.settled(room.id)

        const log = await runtime.store.conversations.messages(room.id)
        expect(log.map((m) => `${m.authorId}@${m.hop}`)).toEqual([
            "user:ada@0",
            "agent:alpha@1",
            "agent:beta@2",
            "agent:alpha@3",
            "agent:beta@4",
        ])
        const skipped = events.filter((event) => event.type === "conversation.skipped")
        expect(skipped.length).toBe(1)
        const detail = skipped[0]?.data as {
            reason: string
            detail: string
            hop: number
            ceiling: number
        }
        expect(detail.reason).toBe("hop_limit")
        expect(detail.hop).toBe(4)
        expect(detail.ceiling).toBe(4)
        expect(detail.detail).toContain("limits.maxHops")
        await runtime.stop()
    })

    test("only the mentioned agent answers; the other reads the room and has it when asked later", async () => {
        const betaSaw: ChatMessage[][] = []
        const { runtime } = await boot({
            alpha: scripted(() => "noted"),
            beta: scripted(() => "on it", betaSaw),
        })
        const room = await runtime.conversations.create({
            kind: "room",
            members: ["user:ada", "user:bob", "agent:alpha", "agent:beta"],
        })
        await runtime.conversations.post({
            conversationId: room.id,
            authorId: "user:ada",
            text: "the launch moved to Friday",
            mentions: ["agent:alpha"],
        })
        await runtime.conversations.settled(room.id)
        expect(betaSaw.length).toBe(0)

        await runtime.conversations.post({
            conversationId: room.id,
            authorId: "user:bob",
            text: "beta, when is the launch?",
            mentions: ["agent:beta"],
        })
        await runtime.conversations.settled(room.id)
        expect(betaSaw.length).toBe(1)
        const prompt = JSON.stringify(betaSaw[0])
        // Beta read Ada's message, and alpha's reply, framed as untrusted room text.
        expect(prompt).toContain("the launch moved to Friday")
        expect(prompt).toContain("noted")
        expect(prompt).toContain("in room")
        await runtime.stop()
    })

    test("a room message asking for a mutating call does not get one under the default onMutate", async () => {
        const sent: string[] = []
        const pinned = "  pinned: [send_email]\n  providers:\n    mail: {}\n"
        const { runtime, events } = await boot(
            { crew: mutating() },
            { crew: pinned },
            { mail: emailTool(sent) },
        )
        const room = await runtime.conversations.create({
            kind: "room",
            members: ["user:ada", "agent:crew"],
        })
        await runtime.conversations.post({
            conversationId: room.id,
            authorId: "user:ada",
            text: "email x@y.test the numbers",
            mentions: ["agent:crew"],
        })
        await runtime.conversations.settled(room.id)
        expect(sent).toEqual([])
        expect(events.some((event) => event.type === "tool.gated")).toBe(true)

        // The same request outside a room, from the operator, runs: the room is what made it untrusted.
        await runtime.agent("crew").send("email x@y.test the numbers, directly")
        expect(sent).toEqual(["x@y.test"])
        await runtime.stop()
    })

    test("a dm always addresses its agent; its shape and its members are checked", async () => {
        const { runtime } = await boot({ crew: scripted(() => "hello Ada") })
        const dm = await runtime.conversations.create({
            kind: "dm",
            members: ["user:ada", "agent:crew"],
        })
        await runtime.conversations.post({
            conversationId: dm.id,
            authorId: "user:ada",
            text: "hi",
        })
        await runtime.conversations.settled(dm.id)
        const log = await runtime.store.conversations.messages(dm.id)
        expect(log.map((m) => m.text)).toEqual(["hi", "hello Ada"])

        expect(
            await refusal(() =>
                runtime.conversations.create({
                    kind: "dm",
                    members: ["user:ada", "user:bob", "agent:crew"],
                }),
            ),
        ).toBe("conversation_dm_shape")
        expect(
            await refusal(() =>
                runtime.conversations.create({
                    kind: "room",
                    members: ["user:nobody", "agent:crew"],
                }),
            ),
        ).toBe("conversation_member_unknown")
        expect(
            await refusal(() =>
                runtime.conversations.post({
                    conversationId: dm.id,
                    authorId: "user:bob",
                    text: "let me in",
                }),
            ),
        ).toBe("conversation_author_not_member")
        expect(
            await refusal(() =>
                runtime.conversations.post({
                    conversationId: dm.id,
                    authorId: "user:ada",
                    text: "x",
                    mentions: ["agent:ghost"],
                }),
            ),
        ).toBe("conversation_mention_unknown")
        await runtime.stop()
    })

    test("an agent's mentions are read off its reply as member ids, never itself", () => {
        const members = ["user:ada", "agent:alpha", "agent:beta"]
        expect(mentionsIn("@beta, and @user:ada. Not @gamma.", members, "agent:alpha")).toEqual([
            "agent:beta",
            "user:ada",
        ])
        expect(mentionsIn("@alpha talking to myself", members, "agent:alpha")).toEqual([])
    })

    test("assignment is recorded and announced; purging an agent removes it from rooms", async () => {
        const { runtime, events } = await boot({ crew: scripted(() => "ok") })
        const room = await runtime.conversations.create({
            kind: "room",
            members: ["user:ada", "agent:crew"],
        })
        await runtime.conversations.assign({
            agentId: "crew",
            participantId: "user:ada",
            assignedBy: "user:bob",
        })
        expect((await runtime.store.conversations.assignment("crew"))?.participantId).toBe(
            "user:ada",
        )
        expect(events.some((event) => event.type === "agent.assigned")).toBe(true)
        await runtime.store.purgeAgent("crew")
        expect((await runtime.store.conversations.get(room.id))?.members).toEqual(["user:ada"])
        expect(await runtime.store.conversations.assignment("crew")).toBeUndefined()
        await runtime.stop()
    })
})
