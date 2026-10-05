/**
 * Stand-ins and cross-member delegation (Phase 28), through a real runtime: who answers in a DM
 * between two people, what a stand-in may not do, and a delegation to another member's agent.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type ActingParticipant,
    type AnyEvent,
    BRAND,
    type ChatChunk,
    type ChatMessage,
    isHarnessError,
    type ModelTransport,
    Runtime,
    type ToolProviderFactory,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

type Step = { tool: string; args: Record<string, unknown> } | { text: string }

/**
 * A model that plays `script` once per distinct input, one entry per model call, then says "ok".
 * Records every request's messages.
 */
function scripted(
    script: (input: string) => readonly Step[],
    seen: ChatMessage[][] = [],
): ModelTransport {
    const progress = new Map<string, number>()
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                seen.push([...request.messages])
                const input = String(request.messages.findLast((m) => m.role === "user")?.content)
                const index = progress.get(input) ?? 0
                progress.set(input, index + 1)
                const step = script(input)[index] ?? { text: "ok" }
                if ("tool" in step) {
                    yield {
                        type: "tool_call",
                        call: {
                            id: `c${index}`,
                            name: step.tool,
                            arguments: JSON.stringify(step.args),
                        },
                    }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                yield { type: "text", delta: step.text }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

function tools(
    sent: string[],
    seenBy: (ActingParticipant | null | undefined)[],
): ToolProviderFactory {
    const spec = (slug: string, mutating: boolean) => ({
        slug,
        provider: "kit",
        summary: slug,
        whenToUse: slug,
        mutating,
        trust: "trusted" as const,
        trustReason: "test fixture",
        tags: [],
        parameters: { type: "object" as const, properties: { to: { type: "string" as const } } },
    })
    return () => ({
        id: "kit",
        resolve: async (slugs) =>
            [
                {
                    spec: spec("send_email", true),
                    handler: async (args: Readonly<Record<string, unknown>>) => {
                        sent.push(String(args.to))
                        return `sent to ${String(args.to)}`
                    },
                },
                {
                    spec: spec("whoami", false),
                    handler: async (
                        _args: unknown,
                        context: { actingParticipant?: ActingParticipant | null },
                    ) => {
                        seenBy.push(context.actingParticipant)
                        return "noted"
                    },
                },
            ].filter((tool) => slugs.includes(tool.spec.slug)),
    })
}

function write(dir: string, id: string, extra: string): string {
    const path = join(dir, `${id}.yaml`)
    writeFileSync(
        path,
        `apiVersion: ${BRAND.apiVersion}\nid: ${id}\nmodel:\n  main:\n    id: m\n    api: ${id}\n    capabilities:\n      nativeTools: true\ntools:\n  dialect: native\n  pinned: [send_email, whoami]\n  providers:\n    kit: {}\n  policy:\n    allow: [send_email]\n${extra}`,
    )
    return path
}

async function boot(transports: Record<string, ModelTransport>, extra: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "standin-"))
    const sent: string[] = []
    const seenBy: (ActingParticipant | null | undefined)[] = []
    const runtime = await Runtime.create({
        agents: Object.keys(transports).map((id) => write(dir, id, extra[id] ?? "")),
        env: {},
        store: ":memory:",
        modelTransports: transports,
        toolProviders: { kit: tools(sent, seenBy) },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    return { runtime, sent, seenBy, events }
}

async function pair(
    adaScript: (input: string) => readonly Step[],
    escalateAfterMs = 0,
    adaSeen: ChatMessage[][] = [],
) {
    const booted = await boot(
        {
            adabot: scripted(adaScript, adaSeen),
            bobbot: scripted(() => [{ text: "bob's agent should never speak here" }]),
        },
        {
            adabot: `standIn:\n  enabled: true\n  escalateAfterMs: ${escalateAfterMs}\n`,
            bobbot: "standIn:\n  enabled: true\n",
        },
    )
    const hub = booted.runtime.conversations
    await hub.registerParticipant({ id: "user:ada", name: "Ada" })
    await hub.registerParticipant({ id: "user:bob", name: "Bob" })
    await hub.assign({ agentId: "adabot", participantId: "user:ada" })
    await hub.assign({ agentId: "bobbot", participantId: "user:bob" })
    const dm = await hub.create({
        kind: "dm",
        members: ["user:ada", "user:bob", "agent:adabot", "agent:bobbot"],
    })
    const say = async (text: string) => {
        await hub.post({ conversationId: dm.id, authorId: "user:bob", text })
        await new Promise((resolve) => setTimeout(resolve, escalateAfterMs + 20))
        await hub.settled(dm.id)
    }
    const log = () => booted.runtime.store.conversations.messages(dm.id)
    return { ...booted, hub, dm, say, log }
}

describe("a stand-in in a DM between two people", () => {
    test("with Ada present her agent stays silent; with Ada away it answers, disclosed once", async () => {
        const adaSeen: ChatMessage[][] = []
        const { runtime, hub, say, log } = await pair(
            () => [{ text: "She is out until Monday." }],
            0,
            adaSeen,
        )
        await say("is Ada around?")
        expect((await log()).map((m) => m.authorId)).toEqual(["user:bob"])

        await hub.setPresence("user:ada", "offline")
        await say("when is Ada back?")
        await say("and the report?")
        const replies = (await log()).filter((m) => m.origin === "agent")
        expect(replies.map((m) => [m.authorId, m.onBehalfOf])).toEqual([
            ["agent:adabot", "user:ada"],
            ["agent:adabot", "user:ada"],
        ])
        expect(replies[0]?.text).toBe(
            "(Ada's agent, answering while Ada is away.) She is out until Monday.",
        )
        expect(replies[1]?.text).toBe("She is out until Monday.")
        // The agent was told what it is doing, outside the fence around Bob's words.
        const prompt = JSON.stringify(adaSeen.at(-1))
        expect(prompt).toContain("You are standing in for Ada")
        expect(prompt).toContain("is Ada around?")
        await runtime.stop()
    })

    test("Ada coming back before escalateAfterMs withdraws it; her agent only reads the message", async () => {
        const { runtime, hub, dm, log } = await pair(() => [{ text: "answering for Ada" }], 300)
        await hub.setPresence("user:ada", "offline")
        await hub.post({ conversationId: dm.id, authorId: "user:bob", text: "quick question" })
        await hub.setPresence("user:ada", "online")
        await new Promise((resolve) => setTimeout(resolve, 400))
        await hub.settled(dm.id)
        expect((await log()).filter((m) => m.origin === "agent")).toEqual([])
        await runtime.stop()
    })

    test("Ada replying herself before escalateAfterMs withdraws it, though she is still marked away", async () => {
        const { runtime, hub, dm, log } = await pair(() => [{ text: "answering for Ada" }], 300)
        await hub.setPresence("user:ada", "offline")
        await hub.post({ conversationId: dm.id, authorId: "user:bob", text: "quick question" })
        await hub.post({ conversationId: dm.id, authorId: "user:ada", text: "here, one sec" })
        await new Promise((resolve) => setTimeout(resolve, 400))
        await hub.settled(dm.id)
        expect((await log()).filter((m) => m.origin === "agent")).toEqual([])
        await runtime.stop()
    })

    test("a mutating call is queued for Ada even with the tool in policy.allow, and runs when she approves", async () => {
        const { runtime, hub, sent, events, say, log } = await pair((input) =>
            input.includes("invoice")
                ? [
                      { tool: "send_email", args: { to: "finance@x.test" } },
                      { text: "I've asked Ada to approve sending it." },
                  ]
                : [{ text: "noted" }],
        )
        await hub.setPresence("user:ada", "offline")
        await say("please email the invoice to finance")
        expect(sent).toEqual([])
        const deferred = events.filter((event) => event.type === "action.deferred")
        expect(deferred.length).toBe(1)
        const [action] = await runtime.store.conversations.actions({ ownerId: "user:ada" })
        expect(action?.status).toBe("pending")
        expect(action?.args).toEqual({ to: "finance@x.test" })
        expect((await log()).at(-1)?.text).toContain("I've asked Ada to approve")

        const decided = await hub.decideAction(action?.id ?? "", true)
        expect(decided.status).toBe("done")
        expect(sent).toEqual(["finance@x.test"])
        expect((await log()).at(-1)?.text).toContain("Ada approved send_email; it is done.")
        let second: string | undefined
        try {
            await hub.decideAction(action?.id ?? "", true)
        } catch (error) {
            second = isHarnessError(error) ? error.code : "other"
        }
        expect(second).toBe("action_already_decided")
        expect(sent).toEqual(["finance@x.test"])
        await runtime.stop()
    })

    test("a declined action never runs, and Bob's agent never speaks for Ada", async () => {
        const { runtime, hub, sent, say, log } = await pair(() => [
            { tool: "send_email", args: { to: "x@y.test" } },
            { text: "Queued for Ada." },
        ])
        await hub.setPresence("user:ada", "offline")
        await say("email x@y.test")
        const [action] = await runtime.store.conversations.actions({ status: "pending" })
        await hub.decideAction(action?.id ?? "", false)
        expect(sent).toEqual([])
        const authors = new Set((await log()).map((m) => m.authorId))
        expect(authors.has("agent:bobbot")).toBe(false)
        expect((await log()).at(-1)?.text).toBe("Ada declined send_email.")
        await runtime.stop()
    })

    test("a dm of two people takes only the agents assigned to them", async () => {
        const { runtime } = await boot(
            { adabot: scripted(() => []), stray: scripted(() => []) },
            {},
        )
        const hub = runtime.conversations
        await hub.registerParticipant({ id: "user:ada" })
        await hub.registerParticipant({ id: "user:bob" })
        await hub.assign({ agentId: "adabot", participantId: "user:ada" })
        let code: string | undefined
        try {
            await hub.create({ kind: "dm", members: ["user:ada", "user:bob", "agent:stray"] })
        } catch (error) {
            code = isHarnessError(error) ? error.code : "other"
        }
        expect(code).toBe("conversation_dm_shape")
        await runtime.stop()
    })
})

describe("delegation to another member's agent", () => {
    const offer =
        "delegation:\n  offer:\n    task: Looks things up in the research archive.\n    artifact:\n      type: object\n      properties:\n        finding: { type: string }\n      required: [finding]\n"

    test("runs in a fresh session, returns the typed artifact, and acts for the person who asked", async () => {
        const coordinatorSaw: ChatMessage[][] = []
        const { runtime, seenBy } = await boot(
            {
                coord: scripted(
                    () => [
                        {
                            tool: "handoff",
                            args: { member: "research", task: "Find one fact about WAL." },
                        },
                        { text: "Research says WAL allows concurrent readers." },
                    ],
                    coordinatorSaw,
                ),
                research: scripted(() => [
                    { tool: "whoami", args: {} },
                    {
                        tool: "submit_artifact",
                        args: { finding: "WAL lets readers run beside one writer." },
                    },
                    { text: "submitted" },
                ]),
            },
            { coord: 'delegation:\n  to: "*"\n', research: offer },
        )
        const result = await runtime.agent("coord").send("ask research about WAL", {
            from: { id: "user:ada", kind: "user" },
        })
        expect(result.text).toContain("WAL allows concurrent readers")
        const observation = JSON.stringify(coordinatorSaw.at(-1))
        expect(observation).toContain("WAL lets readers run beside one writer.")
        const [handoff] = await runtime.store.handoffs.forTurn("coord", result.turnId)
        expect(handoff?.memberSession.startsWith("handoff:")).toBe(true)
        // The delegate's tools act for Ada, who asked the coordinator: she stays accountable.
        expect(seenBy).toEqual([{ id: "user:ada", via: "api" }])
        await runtime.stop()
    })

    test("a delegate with no tools of its own can still return its artifact", async () => {
        // The image's shape: a delegate with no tools block at all, on the text dialect. Its only
        // tool is the turn's `submit_artifact`, which had nothing to layer onto and was dropped.
        const dir = mkdtempSync(join(tmpdir(), "bare-"))
        const coord = write(dir, "coord", 'delegation:\n  to: "*"\n')
        const research = join(dir, "research.yaml")
        writeFileSync(
            research,
            `apiVersion: ${BRAND.apiVersion}\nid: research\nmodel:\n  main:\n    id: m\n    api: research\n${offer}`,
        )
        const runtime = await Runtime.create({
            agents: [coord, research],
            env: {},
            store: ":memory:",
            modelTransports: {
                coord: scripted(() => [
                    { tool: "handoff", args: { member: "research", task: "One fact about WAL." } },
                    { text: "done" },
                ]),
                research: scripted(() => [
                    {
                        text: "ACTION: submit_artifact\nfinding: WAL lets readers run beside one writer.\nEND",
                    },
                    { text: "submitted" },
                ]),
            },
            toolProviders: { kit: tools([], []) },
        })
        const result = await runtime.agent("coord").send("ask research")
        const [handoff] = await runtime.store.handoffs.forTurn("coord", result.turnId)
        expect(handoff?.outcome).toBe("ok")
        await runtime.stop()
    })

    test("two members' agents can ask each other, and an asked agent cannot ask onward (pilot.7)", async () => {
        // `to: "*"` plus an offer on both used to be refused at load as `team_cycle`. A peer ask is
        // one hop instead: the asked agent's catalogue has no handoff, so A ↔ B cannot loop.
        const both = `delegation:\n  to: "*"\n${offer.replace("delegation:\n", "")}`
        const asks = (other: string) =>
            scripted((input) =>
                input.startsWith("ask")
                    ? [
                          { tool: "handoff", args: { member: other, task: "One fact about WAL." } },
                          { text: "done" },
                      ]
                    : [
                          // Tries to hand the work on; the tool is not in its catalogue.
                          { tool: "handoff", args: { member: other, task: "You do it." } },
                          {
                              tool: "submit_artifact",
                              args: { finding: `from ${other === "left" ? "right" : "left"}` },
                          },
                          { text: "submitted" },
                      ],
            )
        const { runtime, events } = await boot(
            { left: asks("right"), right: asks("left") },
            { left: both, right: both },
        )
        for (const [from, to] of [
            ["left", "right"],
            ["right", "left"],
        ] as const) {
            const result = await runtime.agent(from).send("ask the other")
            const [handoff] = await runtime.store.handoffs.forTurn(from, result.turnId)
            expect(handoff?.outcome).toBe("ok")
            expect(handoff?.memberId).toBe(to)
        }
        // Exactly the two asks: neither asked agent started a handoff of its own.
        expect(events.filter((event) => event.type === "handoff.start").length).toBe(2)
        await runtime.stop()
    })
})
