/**
 * A transport may vouch for a sender, and core merges that into the gate.
 *
 * The first working WhatsApp pairing ended in `denied — has no allowFrom, which permits nobody`,
 * addressed to the person whose number the channel had just been paired to. Correct behaviour and
 * the wrong answer: the account owner is not "a sender" to be listed, they *are* the channel.
 *
 * Asserted through a booted runtime rather than on `Inbox` directly, because the defect is one of
 * plumbing — `alwaysAllow` has to travel from the transport the factory returned into the `Inbox`
 * core constructs, and a unit test on either end passes with the wire between them cut.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { ChannelHost } from "../src/channels/channel.ts"
import { EventBus } from "../src/events/bus.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { ChannelFactory } from "../src/runtime/channels.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const OWNER = "8801711223344"

function vouching(
    report: (host: ChannelHost) => void,
    alwaysAllow: readonly string[],
): ChannelFactory {
    return (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        alwaysAllow,
        start: async (host: ChannelHost) => {
            report(host)
        },
        stop: async () => {},
        send: async () => ({ ok: true as const, providerMessageId: "1" }),
    })
}

/** A manifest whose channel names nobody — the state a fresh pairing is in. */
function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "always-allow-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: owned
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: stub
    id: wa
    allowFrom: []
`,
        "utf8",
    )
    return dir
}

async function booted(alwaysAllow: readonly string[]) {
    const dir = manifest()
    const events: AnyEvent[] = []
    let host: ChannelHost | undefined
    const bus = new EventBus({ runtimeId: "rt_test" })
    bus.on("*", (event) => {
        events.push(event)
    })
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: { MODEL_API_KEY: "test-key" },
        bus,
        channels: { stub: vouching((h) => (host = h), alwaysAllow) },
        startChannels: true,
    })
    if (host === undefined) throw new Error("the stub never started")
    return {
        host,
        rejected: () => events.filter((event) => event.type === "agent.channel.rejected"),
        cleanup: async () => {
            await runtime.stop("test")
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

const from = (senderHandle: string) => ({
    peerId: `${senderHandle}@s.whatsapp.net`,
    senderHandle,
    text: "hello",
    receivedAt: new Date().toISOString(),
})

describe("a vouched-for sender passes an empty gate", () => {
    test("the owner is admitted with allowFrom: []", async () => {
        const run = await booted([OWNER])
        try {
            run.host.receive(from(OWNER))
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(run.rejected()).toEqual([])
        } finally {
            await run.cleanup()
        }
    })

    /**
     * Vouching adds to the list the gate reads; it does not switch the gate off. Anyone the
     * transport did not name is refused exactly as before — the property that makes this safe to
     * default on for the account owner.
     */
    test("everyone else is still refused", async () => {
        const run = await booted([OWNER])
        try {
            run.host.receive(from("15551234567"))
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(run.rejected().length).toBe(1)
        } finally {
            await run.cleanup()
        }
    })

    test("a transport that vouches for nobody changes nothing", async () => {
        const run = await booted([])
        try {
            run.host.receive(from(OWNER))
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(run.rejected().length).toBe(1)
        } finally {
            await run.cleanup()
        }
    })
})
