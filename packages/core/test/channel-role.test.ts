/**
 * A channel's turns run on the model role its manifest entry names (pilot.14, VelaCrew, OpenClaw's
 * `modelByChannel`). Asserted at the far end: the model id the transport was asked for.
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

function manifest(channels: string): string {
    const dir = mkdtempSync(join(tmpdir(), "channel-role-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: router
model:
  main:
    id: main-model
    api: rec
  lite:
    id: lite-model
    api: rec
${channels}`,
    )
    return join(dir, "agent.yaml")
}

async function boot(channels: string) {
    const asked: string[] = []
    const rec: ModelTransport = {
        create: (context) => ({
            id: context.id,
            async *chat(): AsyncIterable<ChatChunk> {
                asked.push(context.config.id)
                yield { type: "text", delta: "ok" }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
    const hosts = new Map<string, ChannelHost>()
    const stub: ChannelFactory = (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        start: async (host: ChannelHost) => {
            hosts.set(context.id, host)
        },
        stop: async () => {},
        send: async () => ({ ok: true as const, providerMessageId: "1" }),
    })
    const runtime = await Runtime.create({
        agents: [manifest(channels)],
        env: {},
        store: ":memory:",
        modelTransports: { rec },
        channels: { stub },
        startChannels: true,
    })
    return { runtime, asked, hosts }
}

const say = (host: ChannelHost | undefined, text: string) =>
    host?.receive({ peerId: "p1", senderId: "42", text, receivedAt: new Date().toISOString() })

describe("a channel's model role", () => {
    test("runs that channel's turns on its role, and the others on main", async () => {
        const { runtime, asked, hosts } = await boot(`channels:
  - type: stub
    id: wa
    allowFrom: ['*']
    role: lite
  - type: stub
    id: tg
    allowFrom: ['*']
`)
        say(hosts.get("wa"), "from whatsapp")
        for (let i = 0; i < 100 && asked.length < 1; i += 1)
            await new Promise((resolve) => setTimeout(resolve, 10))
        say(hosts.get("tg"), "from telegram")
        for (let i = 0; i < 100 && asked.length < 2; i += 1)
            await new Promise((resolve) => setTimeout(resolve, 10))
        await runtime.stop()
        expect(asked).toEqual(["lite-model", "main-model"])
    })

    test("a role the manifest does not declare refuses the load", async () => {
        let code: string | undefined
        try {
            await boot(`channels:
  - type: stub
    id: wa
    allowFrom: ['*']
    role: nonexistent
`)
        } catch (error) {
            code = JSON.stringify(error)
        }
        expect(code).toContain("channel_role_unknown")
    })
})
