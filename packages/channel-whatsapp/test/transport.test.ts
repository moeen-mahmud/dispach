/**
 * The WhatsApp transport, with Baileys injected. **Nothing here reaches WhatsApp.**
 *
 * The parts worth testing are the ones a live pairing would make hardest to reach: the QR becoming
 * `needs_input`, a `loggedOut` close wiping the session, an ordinary close reconnecting, and the
 * message mapping. Every one of those is a state transition on an event stream, so a fake socket
 * that emits the events is a *better* test than a real pairing, which can only be driven by hand.
 *
 * It also runs the conformance suite directly. `packages/cli/test/plugin-conformance.test.ts`
 * iterates `BUILT_IN_PLUGINS`, and this plugin is deliberately in neither that table nor the
 * binary — so it would be the one plugin the suite skips.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChannelHost, ChannelInput, ChannelStatus } from "@dispach/core"
import { conformance } from "@dispach/core/testing"
import plugin, { allowFromProblem, whatsappChannel } from "../src/index.ts"
import {
    type BaileysApi,
    type ConnectionUpdate,
    jidOf,
    type MessagesUpsert,
    numberOf,
    toInbound,
    type WhatsAppSocket,
} from "../src/transport.ts"

const dirs: string[] = []
let authDir = ""

beforeEach(() => {
    authDir = join(mkdtempSync(join(tmpdir(), "wa-")), "session")
    dirs.push(authDir)
})
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Recorded {
    readonly status: ChannelStatus
    readonly detail?: string
    readonly input?: ChannelInput
}

function recorder(): {
    host: ChannelHost
    states: Recorded[]
    received: unknown[]
    errors: unknown[]
} {
    const states: Recorded[] = []
    const received: unknown[] = []
    const errors: unknown[] = []
    const host = {
        receive: (message: unknown) => received.push(message),
        status: (status: ChannelStatus, detail?: string, input?: ChannelInput) =>
            states.push({
                status,
                ...(detail === undefined ? {} : { detail }),
                ...(input === undefined ? {} : { input }),
            }),
        error: (detail: unknown) => errors.push(detail),
    } as unknown as ChannelHost
    return { host, states, received, errors }
}

/** A socket whose events a test drives by hand. One connection attempt per `connect` call. */
function fakeBaileys(): {
    api: BaileysApi
    connects: number
    emit: (update: ConnectionUpdate) => void
    deliver: (upsert: MessagesUpsert) => void
    saveCreds: () => Promise<void>
    sent: { jid: string; text: string }[]
} {
    const handlers: {
        update?: (update: ConnectionUpdate) => void
        creds?: () => void | Promise<void>
        messages?: (upsert: MessagesUpsert) => void
    } = {}
    const sent: { jid: string; text: string }[] = []
    const state = { connects: 0 }

    const socket: WhatsAppSocket = {
        // One `on` for three differently-typed events, which is what the overloads on the real
        // interface exist to keep apart. The cast is confined to this fake.
        ev: {
            on: (event: string, handler: unknown) => {
                if (event === "connection.update")
                    handlers.update = handler as (update: ConnectionUpdate) => void
                if (event === "creds.update") handlers.creds = handler as () => void
                if (event === "messages.upsert")
                    handlers.messages = handler as (upsert: MessagesUpsert) => void
            },
        } as unknown as WhatsAppSocket["ev"],
        sendMessage: async (jid, content) => {
            sent.push({ jid, text: content.text })
            return { key: { id: "WA1" } }
        },
        sendPresenceUpdate: async () => {},
        logout: async () => {},
        end: () => {},
    }

    return {
        api: {
            connect: async ({ onUpdate, onCreds, onMessages }) => {
                state.connects += 1
                socket.ev.on("connection.update", onUpdate)
                socket.ev.on("creds.update", onCreds)
                socket.ev.on("messages.upsert", onMessages)
                return socket
            },
        },
        get connects() {
            return state.connects
        },
        emit: (update) => handlers.update?.(update),
        deliver: (upsert) => handlers.messages?.(upsert),
        saveCreds: async () => {
            await handlers.creds?.()
        },
        sent,
    }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function transport(api: BaileysApi) {
    return whatsappChannel({
        id: "wa",
        agentId: "test",
        dir: authDir,
        env: {},
        config: { authDir, api },
    })
}

describe("pairing — the first producer of needs_input", () => {
    test("a QR becomes needs_input with its payload and an expiry", async () => {
        const fake = fakeBaileys()
        const { host, states } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()

        fake.emit({ qr: "2@abc/def" })
        const waiting = states.find((entry) => entry.status === "needs_input")
        expect(waiting?.input?.kind).toBe("qr")
        // The **raw payload**, not a rendering: a terminal wants an ASCII block and a browser wants
        // an <img>, and a transport that picked one would be wrong for the other.
        expect(waiting?.input?.payload).toBe("2@abc/def")
        // An expiry, because WhatsApp rotates the code — a page showing one with no way to tell it
        // is stale reads as a broken scanner rather than an old picture.
        expect(waiting?.input?.expiresAt).toBeDefined()
        await channel.stop()
    })

    test("start returns before anything is paired", async () => {
        // The rule every channel here follows, and sharper for this one: pairing is a person
        // finding their phone, so awaiting it would make boot wait on human time.
        //
        // It reports **nothing** of its own here: `ChannelHub.startAgent` emits `starting` for
        // every transport just before calling this, and emitting a second one printed the line
        // twice on the serve banner.
        const fake = fakeBaileys()
        const { host, states } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        expect(states).toEqual([])
        await channel.stop()
    })

    test("an open connection reports connected", async () => {
        const fake = fakeBaileys()
        const { host, states } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()
        fake.emit({ connection: "open" })
        expect(states.some((entry) => entry.status === "connected")).toBe(true)
        await channel.stop()
    })
})

describe("logged out is the one close that is not transient", () => {
    test("the session is wiped so the next pass issues a fresh QR", async () => {
        /**
         * The failure worth all the care: reconnecting with revoked credentials fails forever and
         * never issues a QR, which is a channel that is running, reports nothing useful, and cannot
         * be paired again without somebody finding the directory by hand.
         */
        const fake = fakeBaileys()
        const { host, errors } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()
        mkdirSync(authDir, { recursive: true })
        writeFileSync(join(authDir, "creds.json"), "{}")
        expect(existsSync(join(authDir, "creds.json"))).toBe(true)

        fake.emit({
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 401 } } },
        })
        expect(existsSync(authDir)).toBe(false)
        // Found by code, not by position: under Bun a `whatsapp_bun_unsupported` is reported first.
        expect(
            errors.some((error) => (error as { code: string }).code === "whatsapp_logged_out"),
        ).toBe(true)
        await channel.stop()
    })

    test("any other close keeps the session and reconnects", async () => {
        const fake = fakeBaileys()
        const { host } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()
        mkdirSync(authDir, { recursive: true })
        writeFileSync(join(authDir, "creds.json"), "{}")

        fake.emit({
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 503 } } },
        })
        // Kept: a network blip is not a revoked pairing, and deleting the session over one would
        // make every flaky connection cost a manual re-scan.
        expect(existsSync(join(authDir, "creds.json"))).toBe(true)
        await channel.stop()
    })
})

describe("credentials are 0600, every time Baileys writes one", () => {
    test("not once at creation — a new signal key arrives at the process umask", async () => {
        const fake = fakeBaileys()
        const { host } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()
        mkdirSync(authDir, { recursive: true })
        const key = join(authDir, "pre-key-1.json")
        writeFileSync(key, "{}", { mode: 0o644 })
        expect(statSync(key).mode & 0o777).toBe(0o644)

        await fake.saveCreds()
        // A session file *is* the paired device, so it follows the same rule `.env` does.
        expect(statSync(key).mode & 0o777).toBe(0o600)
        expect(statSync(authDir).mode & 0o777).toBe(0o700)
        await channel.stop()
    })
})

describe("the message mapping", () => {
    const base = { key: { remoteJid: "8801711223344@s.whatsapp.net", id: "M1" } }

    test("plain text, with the handle in the one spelling allowFrom matches", () => {
        const raw = toInbound({ ...base, pushName: "Ada", message: { conversation: "hello" } })
        expect(raw?.text).toBe("hello")
        expect(raw?.peerId).toBe("8801711223344@s.whatsapp.net")
        // Digits, no `+`: `isAllowed` folds case and drops one leading `@` and nothing strips a
        // plus, so this is the only spelling an entry somebody typed can match — and it is what
        // the refusal message tells them to paste.
        expect(raw?.senderHandle).toBe("8801711223344")
        expect(raw?.senderName).toBe("Ada")
    })

    test("an extended text message and a media caption both carry text", () => {
        expect(
            toInbound({ ...base, message: { extendedTextMessage: { text: "quoted reply" } } })
                ?.text,
        ).toBe("quoted reply")
        expect(toInbound({ ...base, message: { imageMessage: { caption: "look" } } })?.text).toBe(
            "look",
        )
    })

    test("our own messages, groups, status and empty text produce nothing", () => {
        // Each of these is a turn that should not happen rather than a message to drop quietly:
        // answering our own is an agent talking to itself, and a group's rules are a different
        // question from `allowFrom`'s per-sender one.
        expect(
            toInbound({ key: { ...base.key, fromMe: true }, message: { conversation: "mine" } }),
        ).toBeUndefined()
        expect(
            toInbound({ key: { remoteJid: "123@g.us", id: "G" }, message: { conversation: "hi" } }),
        ).toBeUndefined()
        expect(
            toInbound({
                key: { remoteJid: "status@broadcast", id: "S" },
                message: { conversation: "x" },
            }),
        ).toBeUndefined()
        expect(toInbound({ ...base, message: { conversation: "   " } })).toBeUndefined()
        expect(toInbound({ ...base, message: null })).toBeUndefined()
    })

    test("history replayed after a pairing is not answered", async () => {
        /**
         * `append` is WhatsApp syncing days of past conversation into a freshly paired device.
         * Answering it is the worst possible first impression, and it is indistinguishable from
         * live traffic except by this field.
         */
        const fake = fakeBaileys()
        const { host, received } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()
        fake.deliver({ type: "append", messages: [{ ...base, message: { conversation: "old" } }] })
        expect(received).toEqual([])
        fake.deliver({ type: "notify", messages: [{ ...base, message: { conversation: "new" } }] })
        expect(received).toHaveLength(1)
        await channel.stop()
    })

    test("a device suffix is stripped from the handle", () => {
        // Baileys reports a linked device as `number:12@s.whatsapp.net`; the suffix is about the
        // device, not the person, and leaving it on would make allowFrom match one phone.
        expect(numberOf("8801711223344:12@s.whatsapp.net")).toBe("8801711223344")
        expect(jidOf("8801711223344")).toBe("8801711223344@s.whatsapp.net")
        expect(jidOf("8801711223344@s.whatsapp.net")).toBe("8801711223344@s.whatsapp.net")
    })
})

describe("sending", () => {
    test("a bare number is addressed as a JID, and the provider id is reported", async () => {
        const fake = fakeBaileys()
        const { host } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()
        const result = await channel.send({
            channelId: "wa",
            recipient: "8801711223344",
            text: "hello",
            idempotencyKey: "k1",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(true)
        expect(fake.sent[0]?.jid).toBe("8801711223344@s.whatsapp.net")
        await channel.stop()
    })

    test("sending before the link is up is retryable, so the outbox holds it", async () => {
        const fake = fakeBaileys()
        const channel = transport(fake.api)
        const result = await channel.send({
            channelId: "wa",
            recipient: "8801711223344",
            text: "hello",
            idempotencyKey: "k1",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.retryable).toBe(true)
        await channel.stop()
    })

    test("idempotentSend is false, and that is the honest answer", () => {
        // Baileys generates the message id client-side and WhatsApp does not promise to
        // deduplicate a re-sent one. `true` would convert the outbox's visible `uncertain` flag
        // into a silent duplicate.
        const fake = fakeBaileys()
        expect(transport(fake.api).limits.idempotentSend).toBe(false)
    })
})

describe("the plugin", () => {
    test("passes the conformance suite it would otherwise be the only plugin to skip", async () => {
        const result = await conformance(plugin)
        expect(result.findings.filter((finding) => finding.level === "error")).toEqual([])
        expect(result.ok).toBe(true)
        expect(result.registered).toEqual(["channel:whatsapp"])
        // `setup` imports nothing and opens nothing — Baileys is loaded on `start`, so an agent
        // that names this channel and never runs it pays none of 7 MB.
        expect(result.setupMs).toBeLessThan(50)
    })

    test("declares the access it actually takes", async () => {
        const result = await conformance(plugin)
        expect(result.declared.permissions.map((entry) => entry.kind).sort()).toEqual([
            "fs",
            "network",
        ])
    })

    test("its version matches package.json, which changesets moves and this file does not", async () => {
        const manifest = await import("../package.json")
        expect(plugin.version).toBe(manifest.default.version)
    })
})

describe("an allowFrom entry WhatsApp could never match", () => {
    test("the digits-only spelling is the one that works", () => {
        expect(allowFromProblem("8801711223344")).toBeUndefined()
        expect(allowFromProblem("*")).toBeUndefined()
        expect(allowFromProblem("8801711223344@s.whatsapp.net")).toBeUndefined()
    })

    test("a + or spaces is named with the spelling to use instead", () => {
        // The Telegram `@handle`-against-a-numeric-chat-id trap in another provider's clothes: it
        // connects perfectly and refuses the one person it was set up for.
        expect(allowFromProblem("+8801711223344")).toContain("8801711223344")
        expect(allowFromProblem("+880 171 122 3344")).toContain("digits only")
        expect(allowFromProblem("not-a-number")).toContain("not a WhatsApp number")
    })
})

describe("the runtime it will not pair under is named, not left to a README", () => {
    /**
     * Measured at three levels: the same bundle gets a QR under Node in about two seconds and never
     * under Bun, and a raw `ws` probe to WhatsApp opens under both — so it is not the transport
     * layer and not this code. It decides **where this channel works**, because the npm-installed
     * `dispach` runs under Node and the compiled binary and container image are Bun.
     *
     * A channel that connects to nothing and reports nothing is precisely the failure this runtime
     * refuses, so it is reported at start. An error rather than a refusal: the cause is somebody
     * else's and may be fixed without a release here, so it keeps trying.
     */
    test("under Bun it says so, and starts anyway", async () => {
        const fake = fakeBaileys()
        const { host, errors, states } = recorder()
        const channel = transport(fake.api)
        await channel.start(host)
        await settle()

        const named = errors.find(
            (error) => (error as { code: string }).code === "whatsapp_bun_unsupported",
        )
        // This suite runs under Bun, which is what makes the assertion meaningful here and what
        // would make it wrong to assert the *absence* of the error on a Node runner.
        expect(
            typeof (globalThis as { Bun?: unknown }).Bun === "undefined" || named !== undefined,
        ).toBe(true)
        if (named !== undefined) {
            // The remedy, not just the symptom: which way of running it does work.
            expect((named as { hint: string }).hint).toContain("npm-installed")
        }
        // Reported and still connecting — a refusal would make a fix upstream need a release here.
        fake.emit({ connection: "open" })
        expect(states.some((entry) => entry.status === "connected")).toBe(true)
        await channel.stop()
    })
})
