/**
 * `delivery.reply: final` sends a channel the last step's prose alone (pilot.14, VelaCrew): Haiku's
 * "Yes, Outlook. Let me try…" before each tool call reached WhatsApp once per step. Asserted on what
 * the transport was asked to send.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChannelFactory,
    type ChannelHost,
    type ChatChunk,
    type ModelTransport,
    Runtime,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

async function reply(delivery: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "channel-reply-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: replier
model:
  main:
    id: scripted
    api: scripted
    capabilities:
      nativeTools: true
tools:
  dialect: native
  local: [now]
channels:
  - type: stub
    id: wa
    allowFrom: ['*']
${delivery}`,
    )
    let calls = 0
    const scripted: ModelTransport = {
        create: (context) => ({
            id: context.id,
            async *chat(): AsyncIterable<ChatChunk> {
                calls += 1
                if (calls === 1) {
                    yield { type: "text", delta: "Yes, Outlook. Let me try." }
                    yield { type: "tool_call", call: { id: "c1", name: "now", arguments: "{}" } }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                yield { type: "text", delta: "You have two unread messages." }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
    let host: ChannelHost | undefined
    const sent: string[] = []
    const stub: ChannelFactory = (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        start: async (h: ChannelHost) => {
            host = h
        },
        stop: async () => {},
        send: async (message) => {
            sent.push(message.text)
            return { ok: true as const, providerMessageId: String(sent.length) }
        },
    })
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: { scripted },
        channels: { stub },
        startChannels: true,
    })
    host?.receive({
        peerId: "p1",
        senderId: "42",
        text: "any mail?",
        receivedAt: new Date().toISOString(),
    })
    for (let i = 0; i < 200 && sent.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await runtime.stop()
    return sent.join("\n")
}

describe("a channel reply", () => {
    test("joins every step's prose by default, as before", async () => {
        const text = await reply("")
        expect(text).toContain("Yes, Outlook. Let me try.")
        expect(text).toContain("You have two unread messages.")
    })

    test("is the final answer alone under delivery.reply: final", async () => {
        expect(await reply("delivery:\n  reply: final\n")).toBe("You have two unread messages.")
    })
})
