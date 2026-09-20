/**
 * `needs_input`: a channel that is running and waiting for a *person*.
 *
 * The state exists before any transport produces it. WhatsApp's link-device QR is the first
 * instance and a re-auth is the second, and the reason to build the seam early is not tidiness —
 * `status` is a string on the wire, so once a client reads it, changing that field's type is a
 * breaking change inside `v: 1`. Adding a member is not.
 *
 * Two properties are what this file is for, and each was a decision rather than a discovery.
 *
 * The payload is **stored**, not merely emitted: a browser that opens after the QR was issued
 * would otherwise hold a `needs_input` it cannot act on and no way to ask for the bytes. And a
 * `needs_input` carrying nothing is **refused** rather than recorded, because replacing a state a
 * client can render with one it cannot turns a channel that is waiting into a channel that looks
 * broken. The refusal is unreachable from TypeScript — `ChannelHost.status` is overloaded — so
 * what is exercised here is the runtime half a plugin written in JavaScript reaches.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { ChannelHost, ChannelStatus } from "../src/channels/channel.ts"
import { EventBus } from "../src/events/bus.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { ChannelFactory } from "../src/runtime/channels.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }

/** A transport that reports whatever the test tells it to, and connects to nothing. */
function reporting(report: (host: ChannelHost) => void): ChannelFactory {
    return (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        start: async (host: ChannelHost) => {
            report(host)
        },
        stop: async () => {},
        send: async () => ({ ok: true as const, providerMessageId: "1" }),
    })
}

function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "channel-input-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: waiting
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: stub
    id: wa
`,
        "utf8",
    )
    return dir
}

/** Boots with channels started, so the stub's `start` has already reported. */
async function booted(
    report: (host: ChannelHost) => void,
): Promise<{ runtime: Runtime; events: AnyEvent[]; cleanup: () => void }> {
    const dir = manifest()
    const events: AnyEvent[] = []
    // Subscribed before `Runtime.create`, which is what `RuntimeOptions.bus` is for: channels start
    // *inside* the call, so a listener attached to `runtime.bus` afterwards misses every status
    // they emitted on the way up.
    const bus = new EventBus({ runtimeId: "rt_test" })
    bus.on("*", (event) => {
        events.push(event)
    })
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: ENV,
        bus,
        channels: { stub: reporting(report) },
        startChannels: true,
    })
    return { runtime, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function statusEvents(events: AnyEvent[]): {
    status: string
    detail?: string
    input?: { kind: string; payload: string; issuedAt: string; expiresAt?: string }
}[] {
    return events
        .filter((event) => event.type === "agent.channel.status")
        .map(
            (event) =>
                event.data as {
                    status: string
                    detail?: string
                    input?: {
                        kind: string
                        payload: string
                        issuedAt: string
                        expiresAt?: string
                    }
                },
        )
}

describe("a channel waiting on a person", () => {
    test("the payload is on the agent resource, not only on the event", async () => {
        const { runtime, events, cleanup } = await booted((host) => {
            host.status("needs_input", "scan to link WhatsApp", {
                kind: "qr",
                payload: "2@AbCdEf",
            })
        })
        try {
            /**
             * Read *after* the emission, with no subscription involved. This is the whole reason
             * the hub stores it: a page that opens a moment late would otherwise see a state it
             * cannot act on, with the bytes gone.
             */
            const channels = runtime.channels.statusOf("waiting")
            expect(channels.length).toBe(1)
            expect(channels[0]?.status).toBe("needs_input")
            expect(channels[0]?.detail).toBe("scan to link WhatsApp")
            expect(channels[0]?.input?.kind).toBe("qr")
            expect(channels[0]?.input?.payload).toBe("2@AbCdEf")
            // Stamped by the runtime so one clock decides it, and required rather than optional
            // because a payload whose age is unknown cannot be shown safely.
            expect(Number.isFinite(Date.parse(channels[0]?.input?.issuedAt ?? ""))).toBe(true)

            // And on the event too, for a client that *was* subscribed.
            const waiting = statusEvents(events).filter((data) => data.status === "needs_input")
            expect(waiting.length).toBe(1)
            expect(waiting[0]?.input?.payload).toBe("2@AbCdEf")
            expect(waiting[0]?.detail).toBe("scan to link WhatsApp")
        } finally {
            await runtime.stop()
            cleanup()
        }
    })

    test("a channel waiting on a person does not stop the runtime being ready", async () => {
        // `start()` returns once *running*, never once connected — so an agent whose channel needs
        // a QR scanned is live and serving, and `needs_input` is how that becomes visible instead
        // of looking like a hang.
        const { runtime, cleanup } = await booted((host) => {
            host.status("needs_input", undefined, { kind: "qr", payload: "x" })
        })
        try {
            expect(runtime.list().length).toBe(1)
            expect(runtime.channels.started).toBe(true)
            // No `detail` rather than an empty one: a client renders a sentence it was given, and
            // "" is a sentence.
            expect(runtime.channels.statusOf("waiting")[0]?.detail).toBeUndefined()
        } finally {
            await runtime.stop()
            cleanup()
        }
    })

    test("expiresAt is forwarded verbatim, and absent when the transport does not know", async () => {
        const stamp = "2026-09-19T10:00:20.000Z"
        const withExpiry = await booted((host) => {
            host.status("needs_input", "scan", {
                kind: "qr",
                payload: "a",
                expiresAt: stamp,
            })
        })
        try {
            // Forwarded rather than computed: only the provider knows its rotation period, and a
            // runtime guessing one would mark a live code stale or a stale one live.
            expect(withExpiry.runtime.channels.statusOf("waiting")[0]?.input?.expiresAt).toBe(stamp)
        } finally {
            await withExpiry.runtime.stop()
            withExpiry.cleanup()
        }

        const without = await booted((host) => {
            host.status("needs_input", "scan", { kind: "qr", payload: "a" })
        })
        try {
            // Absent means "the transport does not know", never "it does not expire" — so it must
            // not arrive as a value a client would compare against the clock.
            expect(
                without.runtime.channels.statusOf("waiting")[0]?.input?.expiresAt,
            ).toBeUndefined()
        } finally {
            await without.runtime.stop()
            without.cleanup()
        }
    })
})

describe("a needs_input with nothing to act on", () => {
    test("the previous state is kept and the refusal is reported", async () => {
        const { runtime, events, cleanup } = await booted((host) => {
            host.status("connected", "long-poll")
            /**
             * The JavaScript-plugin path. TypeScript refuses this through the overloads on
             * `ChannelHost.status`, so the cast is how a test reaches the runtime half — and the
             * cast is deliberately to the *signature*, not to `never`, because an `as never` on a
             * fixture defeats the check that would catch the argument list being wrong.
             */
            const loose = host.status as (status: ChannelStatus, detail?: string) => void
            loose("needs_input", "scan something")
        })
        try {
            // Not recorded. Replacing a state a client can render with one it cannot is a channel
            // that reads as broken rather than as waiting, which is strictly worse than the
            // transport's own bug.
            const channel = runtime.channels.statusOf("waiting")[0]
            expect(channel?.status).toBe("connected")
            expect(channel?.detail).toBe("long-poll")
            expect(channel?.input).toBeUndefined()

            // And it fails loudly, on the bus, where `serve` writes it to stderr.
            const errors = events
                .filter((event) => event.type === "agent.channel.error")
                .map((event) => event.data as { code: string; hint: string })
            expect(errors.map((error) => error.code)).toContain("channel_input_missing")
            expect(errors[0]?.hint).toContain("kind")

            // The refused report is absent from the status stream too, so a subscribed client and
            // a late one agree about what the channel is doing.
            expect(statusEvents(events).map((data) => data.status)).toEqual([
                "starting",
                "connected",
            ])
        } finally {
            await runtime.stop()
            cleanup()
        }
    })
})

describe("the event schema does not keep its own copy of the states", () => {
    test("`status` is the imported type, not a restated literal union", () => {
        /**
         * A drift guard, not a style check.
         *
         * `agent.channel.status` restated `"starting" | "connected" | "disconnected" | "error"` as
         * a second literal for four phases — right when written, and silently wrong at the next
         * member. That is the hand-kept-list shape this runtime has paid for repeatedly
         * (`NO_MANIFEST` omitting `soul`, `THRESHOLD_ORDER` describing a ladder that had moved,
         * the wire doc's six phantom event rows), and it goes unnoticed because both copies are
         * correct on the day they are written.
         */
        const source = readFileSync(
            join(dirname(new URL(import.meta.url).pathname), "..", "src", "events", "types.ts"),
            "utf8",
        )
        expect(source).toContain("status: ChannelStatus")
        expect(source).toContain("input?: IssuedChannelInput")
        // Revert-checked: re-inlining the union puts this string back and turns the test red.
        expect(source).toContain("import type { ChannelStatus, IssuedChannelInput }")
    })
})
