/**
 * `POST /v1/agents/:id/deliveries`: exact text out on a channel with no turn (QA pilot.3, asked for by
 * an embedder sending reminders and outreach). Sent once per key, and written once into the
 * conversation a reply from that recipient lands in.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, type ChannelHost, type OutboundMessage, Runtime } from "@dispach/core"
import { createHandler } from "../src/handler.ts"

async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "deliveries-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: sender
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: stub
    id: tg
`,
    )
    const sent: OutboundMessage[] = []
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "test-key" },
        store: ":memory:",
        startChannels: true,
        channels: {
            stub: (context) => ({
                id: context.id,
                type: "stub",
                limits: { maxMessageChars: 4096, idempotentSend: false },
                start: async (host: ChannelHost) => host.status("connected"),
                stop: async () => {},
                send: async (message: OutboundMessage) => {
                    sent.push(message)
                    return { ok: true as const, providerMessageId: String(sent.length) }
                },
            }),
        },
    })
    const handler = createHandler({ runtime, allowUnauthenticated: true })
    const post = (body: unknown) =>
        handler(
            new Request("http://127.0.0.1:7420/v1/agents/sender/deliveries", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        )
    return { runtime, sent, post }
}

describe("deliveries", () => {
    test("sends once per key and records the text once, as the agent's, where a reply will land", async () => {
        const { runtime, sent, post } = await setup()
        const body = { channel: "tg", to: "42", text: "Standup in ten minutes.", key: "run-1" }

        const first = await post(body)
        expect(first.status).toBe(202)
        expect(await first.json()).toEqual({ sessionKey: "tg:42", key: "run-1", duplicate: false })
        const again = await post(body)
        expect(again.status).toBe(202)
        expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true)

        expect(sent.map((message) => [message.recipient, message.text])).toEqual([
            ["42", "Standup in ten minutes."],
        ])
        const history = await runtime.agent("sender").history("tg:42")
        expect(history.map((message) => [message.role, message.content])).toEqual([
            ["assistant", "Standup in ten minutes."],
        ])
        await runtime.stop()
    })

    test("an unknown channel is a 404 naming it, and a missing key is refused", async () => {
        const { runtime, sent, post } = await setup()
        const unknown = await post({ channel: "wa", to: "42", text: "x", key: "k" })
        expect(unknown.status).toBe(404)
        expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
            "delivery_channel_unknown",
        )
        const keyless = await post({ channel: "tg", to: "42", text: "x" })
        expect(keyless.status).toBe(400)
        expect(((await keyless.json()) as { error: { code: string } }).error.code).toBe(
            "delivery_key_required",
        )
        expect(sent).toEqual([])
        await runtime.stop()
    })
})
