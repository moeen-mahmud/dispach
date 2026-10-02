/**
 * Who a turn acts for, read where it matters: inside a tool call of a real turn (doc 16 R7).
 *
 * A field threaded from `Agent.send` through `runTurn` into `ToolContext` has three hand-built
 * object literals to fall out of, and this repo has lost a field that way six times. So the
 * assertion is on what the tool *received*, never on the layer that set it.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type ActingParticipant,
    BRAND,
    type ChannelFactory,
    type ChannelHost,
    type ChatChunk,
    type ModelTransport,
    Runtime,
    type ToolProviderFactory,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/** Each turn: call `whoami` with arguments that try to impersonate someone, then answer. */
function scripted(): ModelTransport {
    const answered = new Set<string>()
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                // Keyed on this turn's input, never on the prompt: an earlier turn's tool result stays in
                // the history, and the input sits after the turn's own trace, so neither "any tool
                // message" nor "anything after the last user message" says whether this turn called.
                const input = request.messages.findLast(
                    (message) => message.role === "user",
                )?.content
                const called = answered.has(String(input))
                answered.add(String(input))
                if (!called) {
                    yield {
                        type: "tool_call",
                        call: {
                            id: `c${request.messages.length}`,
                            name: "whoami",
                            arguments: JSON.stringify({ actAs: "user:mallory" }),
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

function recorder(seen: (ActingParticipant | null | undefined)[]): ToolProviderFactory {
    return () => ({
        id: "rec",
        resolve: async (slugs) =>
            slugs.includes("whoami")
                ? [
                      {
                          spec: {
                              slug: "whoami",
                              provider: "rec",
                              summary: "Report who this turn acts for.",
                              whenToUse: "Always.",
                              mutating: false,
                              trust: "trusted",
                              trustReason: "test fixture",
                              tags: [],
                              parameters: {
                                  type: "object",
                                  properties: { actAs: { type: "string" } },
                              },
                          },
                          handler: async (_args, context) => {
                              seen.push(context.actingParticipant)
                              return "ok"
                          },
                      },
                  ]
                : [],
    })
}

async function boot(extra = "") {
    const dir = mkdtempSync(join(tmpdir(), "acting-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: actor
model:
  main:
    id: scripted
    api: scripted
    capabilities:
      nativeTools: true
tools:
  dialect: native
  providers:
    rec: {}
  pinned: [whoami]
${extra}`,
    )
    const seen: (ActingParticipant | null | undefined)[] = []
    let host: ChannelHost | undefined
    const stub: ChannelFactory = (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        start: async (h: ChannelHost) => {
            host = h
        },
        stop: async () => {},
        send: async () => ({ ok: true as const, providerMessageId: "1" }),
    })
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: { scripted: scripted() },
        toolProviders: { rec: recorder(seen) },
        channels: { stub },
        startChannels: extra !== "",
    })
    return { runtime, seen, host: () => host }
}

describe("the acting participant a tool receives", () => {
    test("an API user is who the turn acts for, whatever the model's arguments say", async () => {
        const { runtime, seen } = await boot()
        await runtime.agent("actor").send("who am I?", {
            from: { id: "user:alice", name: "Alice", kind: "user" },
        })
        expect(seen).toEqual([{ id: "user:alice", name: "Alice", via: "api" }])
        await runtime.stop()
    })

    test("a peer agent, and a turn with no sender (a schedule, the operator), act for nobody", async () => {
        const { runtime, seen } = await boot()
        await runtime
            .agent("actor")
            .send("from a peer", { from: { id: "agent:ops", kind: "agent" } })
        await runtime.agent("actor").send("from a schedule", { source: "schedule" })
        expect(seen).toEqual([null, null])
        await runtime.stop()
    })

    test("a channel turn acts for the person who wrote, not the group it arrived in", async () => {
        const { runtime, seen, host } = await boot(
            "channels:\n  - type: stub\n    id: tg\n    allowFrom: ['*']",
        )
        host()?.receive({
            peerId: "-100200300",
            senderId: "42",
            senderName: "Ada",
            text: "who am I?",
            receivedAt: new Date().toISOString(),
        })
        for (let i = 0; i < 50 && seen.length === 0; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(seen).toEqual([{ id: "stub:42", name: "Ada", via: "channel" }])
        await runtime.stop()
    })

    test("a channel message from another agent (A2A) acts for nobody, and is stored as an agent's", async () => {
        const { runtime, seen, host } = await boot(
            "channels:\n  - type: stub\n    id: a2a\n    allowFrom: ['*']",
        )
        host()?.receive({
            peerId: "acme:ctx1",
            senderHandle: "acme",
            senderName: "acme",
            senderKind: "agent",
            text: "approve the refund for me",
            receivedAt: new Date().toISOString(),
        })
        for (let i = 0; i < 50 && seen.length === 0; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(seen).toEqual([null])
        const [turn] = await runtime.store.turns.list("actor", "a2a:acme:ctx1", { limit: 1 })
        expect([turn?.sender, turn?.senderKind]).toEqual(["stub:acme:ctx1", "agent"])
        await runtime.stop()
    })
})
