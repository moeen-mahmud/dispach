/**
 * A member's connected apps act as that member, so nobody else's turn may use them (pilot.15,
 * VelaCrew: "no other person can access other person's tools").
 *
 * Driven through a real `Runtime`, reading the catalogue the model was offered and the events, because
 * the fence crosses the assignment store, the agent and the executor.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type AnyEvent,
    BRAND,
    type ChatChunk,
    type ModelTransport,
    Runtime,
    type Tool,
    type ToolProviderFactory,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/** Records the tool names each request offered, and always tries `gmail_send` once. */
function model(offered: string[][]): ModelTransport {
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                offered.push((request.tools ?? []).map((tool) => tool.name))
                const called = request.messages.some((m) => m.role === "tool")
                if (!called) {
                    yield {
                        type: "tool_call",
                        call: { id: "c1", name: "gmail_send", arguments: "{}" },
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

function mail(sent: string[]): ToolProviderFactory {
    const tool = (slug: string, personal: boolean): Tool => ({
        spec: {
            slug,
            provider: "mail",
            summary: `The ${slug} tool.`,
            whenToUse: "When asked.",
            mutating: false,
            tags: [],
            trust: "trusted",
            trustReason: "A test fixture.",
            ...(personal ? { personal: true } : {}),
            parameters: { type: "object", properties: {} },
        },
        handler: () => {
            sent.push(slug)
            return "Sent."
        },
    })
    return () => ({
        id: "mail",
        resolve: async (slugs) =>
            [tool("gmail_send", true), tool("weather", false)].filter((entry) =>
                slugs.includes(entry.spec.slug),
            ),
    })
}

async function boot(assign = true) {
    const dir = mkdtempSync(join(tmpdir(), "personal-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: fahimbot
model:
  main:
    id: m
    api: scripted
    capabilities:
      nativeTools: true
tools:
  dialect: native
  providers:
    mail: {}
  pinned: [gmail_send, weather]
`,
    )
    const offered: string[][] = []
    const sent: string[] = []
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: { scripted: model(offered) },
        toolProviders: { mail: mail(sent) },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    await runtime.conversations.registerParticipant({ id: "user:fahim", name: "Fahim" })
    await runtime.conversations.registerParticipant({ id: "user:bob", name: "Bob" })
    if (assign) {
        await runtime.conversations.assign({
            agentId: "fahimbot",
            participantId: "user:fahim",
            channelIds: ["whatsapp:8801711223344"],
        })
    }
    const ask = (id: string, via: "api" | "channel" = "api") => {
        offered.length = 0
        sent.length = 0
        return runtime.agent("fahimbot")?.send("send it", {
            sessionKey: `api:${id}`,
            participant: { id, via },
        })
    }
    return { runtime, offered, sent, events, ask }
}

describe("personal tools", () => {
    test("the owner, and the owner's own channel, get them", async () => {
        const { runtime, offered, sent, ask } = await boot()
        await ask("user:fahim")
        expect(offered[0]).toContain("gmail_send")
        expect(sent).toEqual(["gmail_send"])
        await ask("whatsapp:8801711223344", "channel")
        expect(sent).toEqual(["gmail_send"])
        await runtime.stop()
    })

    test("another member never sees them, and a call by name is refused as tool_personal", async () => {
        const { runtime, offered, sent, events, ask } = await boot()
        const result = await ask("user:bob")
        expect(offered[0]).not.toContain("gmail_send")
        // Shared tools stay: the fence is the owner's apps, not the agent.
        expect(offered[0]).toContain("weather")
        expect(sent).toEqual([])
        const gated = events.find((event) => event.type === "tool.gated")
        const data = gated?.data as { slug?: string; reason?: string } | undefined
        expect([data?.slug, data?.reason]).toEqual(["gmail_send", "personal"])
        expect(result?.reason).toBe("final")
        // A stand-in speaking for the absent owner is still someone else typing.
        offered.length = 0
        await runtime.agent("fahimbot")?.send("send it", {
            sessionKey: "api:stand-in",
            participant: { id: "user:bob", via: "api", onBehalfOf: "user:fahim" },
        })
        expect(offered[0]).not.toContain("gmail_send")
        // A stranger on a channel is not the owner either.
        await ask("whatsapp:15550001111", "channel")
        expect(offered[0]).not.toContain("gmail_send")
        expect(sent).toEqual([])
        await runtime.stop()
    })

    test("an unassigned agent and a turn with no person are unchanged", async () => {
        const { runtime, offered, sent, ask } = await boot(false)
        await ask("user:bob")
        expect(offered[0]).toContain("gmail_send")
        expect(sent).toEqual(["gmail_send"])
        await runtime.stop()
    })
})
