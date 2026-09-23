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

describe("pairing by code, when a number says which account to link", () => {
    /**
     * WhatsApp's alternative to scanning: an eight-character code typed into the phone under
     * Linked devices. It is the only route that works on a surface which cannot draw a barcode,
     * and the better one everywhere else — which is why `pairWith` exists.
     *
     * **`pairWith` is not `allowFrom`.** The first is the account the agent runs as; the second is
     * who may talk to it. Folding them together is the documented "chat not found" class of
     * failure one field over, so they are separate fields and this file asserts both behaviours.
     */
    function codeSocket(options: {
        registered: boolean
        account?: unknown
        code?: string
        fail?: boolean
    }) {
        const asked: string[] = []
        const base = fakeBaileys()
        const api: BaileysApi = {
            connect: async (args) => {
                const socket = await base.api.connect(args)
                return Object.assign(socket, {
                    authState: {
                        creds: {
                            registered: options.registered,
                            ...(options.account === undefined ? {} : { account: options.account }),
                        },
                    },
                    requestPairingCode: async (number: string) => {
                        asked.push(number)
                        if (options.fail === true) throw new Error("bad number")
                        return options.code ?? "K7Q2M4XP"
                    },
                })
            },
        }
        return { api, asked, emit: base.emit }
    }

    function withPairing(api: BaileysApi, pairWith: string) {
        return whatsappChannel({
            id: "wa",
            agentId: "test",
            dir: authDir,
            env: {},
            // The three-second settle is a seam for exactly this: sleeping it here would trade a
            // fast file for a slow one and teach everybody to skip it.
            config: { authDir, api, pairWith, pairingDelayMs: 0 },
        })
    }

    test("an unpaired session asks for a code and reports it as needs_input", async () => {
        const socket = codeSocket({ registered: false })
        const { host, states } = recorder()
        const channel = withPairing(socket.api, "8801711223344")
        await channel.start(host)
        await settle()

        expect(socket.asked).toEqual(["8801711223344"])
        const waiting = states.find((state) => state.status === "needs_input")
        expect(waiting?.input?.kind).toBe("pairing_code")
        expect(waiting?.input?.payload).toBe("K7Q2M4XP")
        // The sentence has to say where to type it; a bare code is a string with no instructions.
        expect(waiting?.detail).toContain("Linked devices")
        await channel.stop()
    })

    /**
     * The guard that matters. This runs inside the **reconnect loop**, so every transient close
     * reaches it — and asking a live session to pair again is at best wasted and at worst logs the
     * device out.
     */
    test("a session already linked is never asked to pair again", async () => {
        const socket = codeSocket({ registered: true })
        const { host } = recorder()
        const channel = withPairing(socket.api, "8801711223344")
        await channel.start(host)
        await settle()

        expect(socket.asked).toEqual([])
        await channel.stop()
    })

    /**
     * **The bug that broke the first real pairing.** After the code is typed, `pair-success`
     * writes `account` and WhatsApp closes with 515; login completes on the reconnect, and only
     * then is `registered` set. On that reconnect a guard reading `registered` asked for a
     * *second* code, and `requestPairingCode` overwrites `me` — a fresh pairing on top of the one
     * about to finish. The phone listed the device; our creds held `me` and `pairingCode` and none
     * of the pair-success fields. `account` is the field pair-success writes and nothing else does.
     */
    test("a session the phone has accepted is not asked to pair again while login finishes", async () => {
        const socket = codeSocket({ registered: false, account: { details: "…" } })
        const { host } = recorder()
        const channel = withPairing(socket.api, "8801711223344")
        await channel.start(host)
        await settle()

        expect(socket.asked).toEqual([])
        await channel.stop()
    })

    /**
     * Baileys keeps emitting `qr` on the same socket whether or not a code was requested, roughly
     * every twenty seconds. Honouring both makes the code vanish from the panel mid-entry, which
     * reads as the pairing having failed.
     */
    test("the QR that keeps arriving does not displace the code", async () => {
        const socket = codeSocket({ registered: false })
        const { host, states } = recorder()
        const channel = withPairing(socket.api, "8801711223344")
        await channel.start(host)
        // **Before the code arrives as well as after.** Baileys emits its first QR inside the
        // settle wait, so suppressing only afterwards showed a barcode and then replaced it with a
        // code — which reads as the first one having failed.
        socket.emit({ qr: "2@duringthewait" })
        await settle()
        socket.emit({ qr: "2@somethingelse" })
        await settle()

        const kinds = states
            .filter((state) => state.status === "needs_input")
            .map((state) => state.input?.kind)
        expect(kinds).toEqual(["pairing_code"])
        await channel.stop()
    })

    /**
     * A failed request does not take the connection down: the QR path is live on the same socket,
     * so a channel that cannot get a code can still be paired by scanning. Turning this into a
     * reconnect would take the QR away too.
     */
    test("a refused request is reported and leaves the QR path working", async () => {
        const socket = codeSocket({ registered: false, fail: true })
        const { host, states, errors } = recorder()
        const channel = withPairing(socket.api, "8801711223344")
        await channel.start(host)
        await settle()
        expect(errors.length).toBeGreaterThan(0)

        socket.emit({ qr: "2@fallback" })
        await settle()
        const waiting = states.find((state) => state.input?.kind === "qr")
        expect(waiting?.input?.payload).toBe("2@fallback")
        await channel.stop()
    })

    /**
     * **Normalised, not refused — a reversal.** The first version refused `+880 1711 223344`, on
     * the reasoning that one spelling is easier to match than two. That put the burden on the
     * person: a number reads off a contact card with a `+` and spaces, means exactly one thing, and
     * OpenClaw folds it ("E.164-style, normalised internally"). So does this now. What is still
     * refused is a value with no number in it, because `requestPairingCode` fails opaquely on one.
     */
    test("a number with a + and spaces is folded to digits, and a non-number is refused", async () => {
        const socket = codeSocket({ registered: false })
        const channel = withPairing(socket.api, "+880 1711-223344")
        const { host } = recorder()
        await channel.start(host)
        await settle()
        expect(socket.asked).toEqual(["8801711223344"])
        await channel.stop()

        expect(() => withPairing(fakeBaileys().api, "not-a-number")).toThrow(/pairWith/)
    })
})

describe("the chat with yourself is the agent's conversation", () => {
    /**
     * Reported the moment pairing first worked: the agent showed as a linked device on the phone
     * and answered nothing. The owner had opened the chat with themselves — the obvious first
     * test for an agent linked to your own number — and every message they typed arrived as
     * `fromMe`, because they *are* the account. The filter written to stop the agent answering
     * its own echo discarded all of it.
     */
    const me = "8801711223344@s.whatsapp.net"
    const context = { ownJids: new Set([me]), sentIds: ["SENT-1"] }
    const at = (jid: string, extra: Record<string, unknown> = {}) => ({
        key: { remoteJid: jid, fromMe: true, id: "IN-1", ...extra },
        message: { conversation: "hello agent" },
    })

    test("the owner typing to themselves is read", () => {
        const raw = toInbound(at(me), context)
        expect(raw?.text).toBe("hello agent")
        expect(raw?.senderHandle).toBe("8801711223344")
    })

    test("the agent's own reply is not read back, even in that chat", () => {
        expect(toInbound(at(me, { id: "SENT-1" }), context)).toBeUndefined()
    })

    test("the owner talking to somebody else from their phone is not the agent's business", () => {
        expect(toInbound(at("15551234567@s.whatsapp.net"), context)).toBeUndefined()
    })

    test("a linked device's suffix does not hide the owner", () => {
        // The account is `…@s.whatsapp.net`; this phone is `…:12@s.whatsapp.net`. Same person.
        expect(toInbound(at("8801711223344:12@s.whatsapp.net"), context)?.text).toBe("hello agent")
    })

    /**
     * WhatsApp now addresses many chats by LID — an opaque id ending `@lid` — and carries the
     * phone form in `remoteJidAlt`. Read only `remoteJid` and the sender is a LID's digits, which
     * is nobody's phone number and matches nobody's `allowFrom`. Nothing to do with self-chat: it
     * broke every third-party sender under LID addressing too.
     */
    test("a LID-addressed chat reports the phone number, from the alternate JID", () => {
        const raw = toInbound(
            {
                key: {
                    remoteJid: "236700000000001@lid",
                    remoteJidAlt: "15551234567@s.whatsapp.net",
                    id: "L1",
                },
                message: { conversation: "hi" },
            },
            context,
        )
        expect(raw?.senderHandle).toBe("15551234567")
        // Delivery goes back to the form Baileys can route.
        expect(raw?.peerId).toBe("15551234567@s.whatsapp.net")
    })

    test("the owner under LID addressing is still the owner", () => {
        const lidContext = { ownJids: new Set([me, "236700000000009@lid"]), sentIds: [] }
        const raw = toInbound(
            {
                key: { remoteJid: "236700000000009@lid", remoteJidAlt: me, fromMe: true, id: "X" },
                message: { conversation: "via lid" },
            },
            lidContext,
        )
        expect(raw?.text).toBe("via lid")
    })
})

describe("a refused pairing stops rather than hammering the number", () => {
    /**
     * Measured in the container on 2026-09-22: three codes in fifteen seconds, each invalidated by
     * a `loggedOut` before anybody could finish typing the one before it. Nobody can enter eight
     * characters in seven seconds, so pairing could never complete — and every pass was another
     * failed pairing recorded against a real WhatsApp number, which decision 8.4 says is what gets
     * an account banned with no appeal.
     *
     * The cause was one branch: `loggedOut` never touched `#failures`, because it was written for
     * the case where a *person* revoked a working session. A refused pairing wears the same status
     * code and is the opposite situation.
     */
    /**
     * A socket reporting `registered: false` — a session that has **never paired**, which is the
     * whole scenario. A fake with no `authState` reads as registered by design, because treating a
     * working session as unpaired is the worse error, so it would exercise the revocation branch
     * instead and prove nothing about this one.
     */
    function rejecting(registered = false) {
        const base = fakeBaileys()
        const api: BaileysApi = {
            connect: async (args) => {
                const socket = await base.api.connect(args)
                return Object.assign(socket, { authState: { creds: { registered } } })
            },
        }
        return {
            api,
            emit: base.emit,
            refuse: () =>
                base.emit({
                    connection: "close",
                    lastDisconnect: { error: { output: { statusCode: 401 } } },
                }),
        }
    }

    function channelFor(api: BaileysApi) {
        return whatsappChannel({
            id: "wa",
            agentId: "test",
            dir: authDir,
            env: {},
            config: { authDir, api, pairWith: "8801711223344", pairingDelayMs: 0 },
        })
    }

    test("it gives up by name after a few refusals, instead of looping", async () => {
        const socket = rejecting()
        const { host, states, errors } = recorder()
        const channel = channelFor(socket.api)
        await channel.start(host)
        await settle()

        for (let attempt = 0; attempt < 6; attempt += 1) {
            socket.refuse()
            await settle()
        }

        const refused = errors.find(
            (entry) => (entry as { code?: string }).code === "whatsapp_pairing_refused",
        )
        expect(refused).toBeDefined()
        expect(states.some((state) => state.status === "error")).toBe(true)
        await channel.stop()
    })

    /**
     * The other half, and the reason this is a *distinction* rather than a cap: a session that
     * really did connect and was then revoked from the phone must still wipe and pair again. That
     * is the stuck-with-no-QR state the logout branch exists for.
     */
    /**
     * The same distinction on the other branch: a 401 on a session pair-success has accepted is a
     * revocation (wipe, offer a fresh code), never a refused pairing — even though `registered`
     * is still false on the reconnect where it would arrive.
     */
    test("a 401 after pair-success is a revocation, not a refusal", async () => {
        const base = fakeBaileys()
        const api: BaileysApi = {
            connect: async (args) => {
                const socket = await base.api.connect(args)
                return Object.assign(socket, {
                    authState: { creds: { registered: false, account: { details: "…" } } },
                })
            },
        }
        const { host, errors } = recorder()
        const channel = channelFor(api)
        await channel.start(host)
        await settle()
        base.emit({
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 401 } } },
        })
        await settle()
        const codes = errors.map((entry) => (entry as { code?: string }).code)
        expect(codes).toContain("whatsapp_logged_out")
        expect(codes).not.toContain("whatsapp_pairing_refused")
        await channel.stop()
    })

    test("a revocation of a registered session still re-pairs", async () => {
        const socket = rejecting(true)
        const { host, errors } = recorder()
        const channel = channelFor(socket.api)
        await channel.start(host)
        await settle()

        socket.refuse()
        await settle()

        expect(
            errors.some((entry) => (entry as { code?: string }).code === "whatsapp_logged_out"),
        ).toBe(true)
        expect(
            errors.some(
                (entry) => (entry as { code?: string }).code === "whatsapp_pairing_refused",
            ),
        ).toBe(false)
        await channel.stop()
    })
})
