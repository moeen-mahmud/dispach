/**
 * The WhatsApp `ChannelTransport`: Baileys over the WhatsApp Web protocol.
 *
 * ## What is different from every other channel here
 *
 * **Pairing is a conversation with a person, not a credential in a file.** Telegram is a token you
 * paste once; WhatsApp is a QR code somebody has to scan with a phone, and the code rotates roughly
 * every twenty seconds. That is the whole reason `ChannelStatus` has a `needs_input` member and an
 * `input` payload beside it — built, wired through the agent resource, the `serve` banner and the
 * web panel, and until now produced by nothing. This is its first producer.
 *
 * Two consequences follow and neither is optional. `issuedAt` is the runtime's and is always
 * present, so a page opened a minute after the code was issued can show it as stale rather than as
 * broken; and the payload is *stored* by the hub, so a browser that opens after the QR was emitted
 * still has it. A channel that only ever emitted the code would be pairable exclusively by whoever
 * happened to be watching at the right second.
 *
 * ## The loop
 *
 * `start()` returns once **running**, not once connected — the same rule Telegram follows, and
 * sharper here: a pairing can take minutes of human time, and awaiting it would make boot wait on
 * somebody finding their phone. Everything after that happens on Baileys' event stream, and the
 * reconnect loop catches everything and never ends on its own. A loop that throws and returns leaves
 * a process that is running, reports nothing, and receives nothing forever.
 *
 * ## `loggedOut` is the one disconnect that is not transient
 *
 * Every other close is retried. `loggedOut` means the session was revoked — from the phone, or by
 * WhatsApp — and the stored credentials are now *worse than nothing*: reconnecting with them fails
 * forever and never issues a new QR, which is the "stuck with no QR" state that is the whole failure
 * mode worth caring about here. So they are deleted and pairing starts again from scratch.
 */

import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
// Types only: a runtime import would bundle a second copy of core into this plugin. See index.ts.
import type {
    ChannelHost,
    ChannelLimits,
    ChannelTransport,
    OutboundMessage,
    SendResult,
} from "@dispach/core"

/**
 * WhatsApp's own text cap, in UTF-16 code units.
 *
 * The provider's number rather than a readability judgement — the outbox chunks against it, and a
 * cap chosen for taste would silently split messages WhatsApp would have delivered whole.
 */
const MAX_MESSAGE_CHARS = 65_536

/**
 * Between chunks. Higher than Telegram's 350 ms on purpose: this is an unofficial client on an
 * account that can be banned, and a burst of messages is the shape that gets one flagged.
 */
const MIN_SEND_INTERVAL_MS = 1_000

/** After a dropped connection. Capped, because a client that stops trying never comes back. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const

/**
 * How long a QR is offered before the next one replaces it.
 *
 * WhatsApp rotates it at roughly this interval and Baileys emits each one; this is what a reader
 * is told so a code nobody scanned in time reads as expired rather than as a broken scanner.
 */
const QR_TTL_MS = 60_000

/** Baileys' `loggedOut`, inlined so the bundle does not depend on the enum's runtime shape. */
const LOGGED_OUT = 401

/**
 * Measured, reproduced at three levels, and said out loud rather than left to a README.
 *
 * Under Bun the WebSocket **opens** and Baileys' handshake never completes: no QR, no error, no
 * close — the same bundle gets a QR under Node in about two seconds. A raw `ws` probe to
 * `wss://web.whatsapp.com/ws/chat` opens under both, so it is not the transport layer and not this
 * code; it is somewhere inside the Noise handshake. Bun also warns that `ws`'s `upgrade` and
 * `unexpected-response` events are unimplemented, which is a real gap and may or may not be this one.
 *
 * That matters because it decides **where this channel works**: the npm-installed `dispach` runs
 * under `#!/usr/bin/env node` and pairs; the compiled binary and the container image are Bun and do
 * not. A channel that connects to nothing and reports nothing is the exact failure this runtime
 * exists to refuse, so it is named at start — as an error rather than a refusal, because the cause
 * is somebody else's and may be fixed without a release here.
 */
const BUN_LIMITATION = {
    code: "whatsapp_bun_unsupported",
    message:
        "WhatsApp pairing does not complete under Bun — the socket opens and the handshake never finishes.",
    hint: "Measured against the same bundle: it pairs under Node in about two seconds and never under Bun. Run the npm-installed `dispach` (its bin runs under Node) rather than the compiled binary or the container image, both of which are Bun. It keeps trying regardless, in case the cause is fixed upstream.",
} as const

/** True under Bun. `Bun` is a global the runtime defines and Node does not. */
function onBun(): boolean {
    return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
}

/**
 * The slice of Baileys this transport uses.
 *
 * Declared rather than imported as types, because the package is loaded through a dynamic import —
 * the socket is not constructed until `start()`, so a manifest that names the channel but never
 * runs it pays nothing, and an agent that never uses WhatsApp never loads 6.8 MB of it.
 */
export interface WhatsAppSocket {
    ev: {
        on(event: "connection.update", handler: (update: ConnectionUpdate) => void): void
        on(event: "creds.update", handler: () => void | Promise<void>): void
        on(event: "messages.upsert", handler: (upsert: MessagesUpsert) => void): void
    }
    sendMessage(
        jid: string,
        content: { text: string },
    ): Promise<{ key?: { id?: string } } | undefined>
    sendPresenceUpdate(presence: string, jid?: string): Promise<void>
    logout(): Promise<void>
    end(error?: Error): void
}

export interface ConnectionUpdate {
    connection?: "close" | "connecting" | "open"
    qr?: string
    lastDisconnect?: { error?: { output?: { statusCode?: number }; message?: string } }
}

export interface MessagesUpsert {
    type: string
    messages: readonly WhatsAppMessage[]
}

export interface WhatsAppMessage {
    key?: {
        remoteJid?: string | null
        fromMe?: boolean | null
        id?: string | null
        participant?: string | null
    }
    pushName?: string | null
    messageTimestamp?: number | { toNumber(): number } | null
    message?: {
        conversation?: string | null
        extendedTextMessage?: { text?: string | null } | null
        imageMessage?: { caption?: string | null } | null
        videoMessage?: { caption?: string | null } | null
        documentMessage?: { caption?: string | null } | null
    } | null
}

/** What `start()` needs from Baileys. Injected whole so a test never loads the real package. */
export interface BaileysApi {
    connect(options: {
        readonly authDir: string
        readonly onUpdate: (update: ConnectionUpdate) => void
        readonly onCreds: () => void | Promise<void>
        readonly onMessages: (upsert: MessagesUpsert) => void
    }): Promise<WhatsAppSocket>
}

export interface WhatsAppTransportOptions {
    readonly id: string
    /** Where Baileys keeps the paired session. Absolute by the time it reaches here. */
    readonly authDir: string
    /** Injected by the tests, which never reach WhatsApp. */
    readonly api?: BaileysApi
}

export class WhatsAppTransport implements ChannelTransport {
    readonly id: string
    readonly type = "whatsapp"
    readonly limits: ChannelLimits = {
        maxMessageChars: MAX_MESSAGE_CHARS,
        // **Honest `false`.** Baileys generates the message id client-side, and WhatsApp does not
        // promise to deduplicate a re-sent one — so declaring `true` would convert the outbox's
        // visible `uncertain` flag into a silent duplicate, which is strictly worse than the
        // ambiguity it would be hiding.
        idempotentSend: false,
        minSendIntervalMs: MIN_SEND_INTERVAL_MS,
    }

    readonly #authDir: string
    readonly #api: BaileysApi | undefined

    #host: ChannelHost | undefined
    #socket: WhatsAppSocket | undefined
    #running = false
    #failures = 0
    #loop: Promise<void> | undefined

    constructor(options: WhatsAppTransportOptions) {
        this.id = options.id
        this.#authDir = options.authDir
        this.#api = options.api
    }

    /**
     * Begin connecting. Returns once running, never once paired.
     *
     * The connection is established on a detached loop for the reason every channel here follows and
     * one more: pairing is a person finding their phone, and a boot that waited for that is a boot
     * that never finishes on a fresh install.
     */
    async start(host: ChannelHost): Promise<void> {
        if (this.#running) return
        this.#running = true
        this.#host = host
        // No `status("starting")` here: `ChannelHub.startAgent` emits it for every transport just
        // before calling this, and a second one printed the line twice on the serve banner.
        if (onBun()) host.error(BUN_LIMITATION)
        this.#loop = this.#connect(host)
    }

    async stop(): Promise<void> {
        if (!this.#running) return
        this.#running = false
        try {
            // `end`, never `logout`: logging out **revokes the pairing**, so a restart would need
            // somebody to scan a QR again. Stopping a process is not a decision to unpair.
            this.#socket?.end()
        } catch {
            // Best effort — the process is going away either way.
        }
        this.#socket = undefined
        // **Released here rather than waited for.** The loop parks on a promise that a
        // `connection: "close"` event resolves, and `stop()` awaits the loop — so leaving it to the
        // provider to emit that event makes our own shutdown depend on a socket we have just told
        // to end. It hung for the full test timeout the first time this ran, which is what a
        // process that will not exit looks like from outside.
        this.#resolveClosed?.()
        this.#resolveClosed = undefined
        await this.#loop?.catch(() => {})
        this.#loop = undefined
        this.#host?.status("disconnected")
        this.#host = undefined
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const socket = this.#socket
        if (socket === undefined) {
            return {
                ok: false,
                // Retryable: the outbox holds it and the reconnect loop is still trying. A reply
                // written while the link was down should arrive when it comes back, not be lost.
                retryable: true,
                error: {
                    code: "whatsapp_not_connected",
                    message: `Channel "${this.id}" is not connected to WhatsApp.`,
                    hint: "The reconnect loop keeps trying and the outbox holds this message. If it never connects, the pairing was probably revoked — check the channel's status, which carries the QR when one is waiting to be scanned.",
                },
            }
        }
        try {
            const sent = await socket.sendMessage(jidOf(message.recipient), {
                text: message.text,
            })
            const id = sent?.key?.id
            return id === undefined ? { ok: true } : { ok: true, providerMessageId: id }
        } catch (cause) {
            return {
                ok: false,
                retryable: true,
                error: {
                    code: "whatsapp_send_failed",
                    message: cause instanceof Error ? cause.message : String(cause),
                    hint: "Retried, because an unclassified failure from an unofficial client is not one known to be permanent. A recipient that does not exist on WhatsApp fails this way too, and that one will not recover — check the number against `allowFrom`.",
                },
            }
        }
    }

    /**
     * Forget the pairing: delete the session and drop the socket so the loop offers a QR again.
     *
     * Safe while running and while stopped, which the interface requires and which matters here
     * because the useful moment is *while* it is connected to the wrong phone. It does not call
     * Baileys' `logout()`: that asks WhatsApp to revoke the device and needs a live connection, so
     * it fails exactly when somebody most wants this — when the session is broken. Deleting the
     * credentials achieves the local half unconditionally, and the phone's linked-devices screen is
     * where a stale entry is removed.
     */
    async reset(): Promise<void> {
        this.#wipeCredentials()
        try {
            this.#socket?.end()
        } catch {
            // Best effort: the session is already gone, and the loop reconnects either way.
        }
        this.#socket = undefined
        this.#failures = 0
        this.#host?.status("disconnected", "unpaired — scan the next QR to link a device")
        // Releases the loop's wait so it reconnects immediately rather than after the next close
        // event, which a socket we have just ended may never send.
        this.#resolveClosed?.()
        this.#resolveClosed = undefined
    }

    async typing(recipient: string): Promise<void> {
        await this.#socket?.sendPresenceUpdate("composing", jidOf(recipient))
    }

    /**
     * Connect, and keep reconnecting. The only thing that ends this is `stop()`.
     *
     * Baileys hands back a socket whose events carry everything; a close is either transient (retry
     * with backoff) or `loggedOut` (wipe and start pairing again). Anything thrown here is caught and
     * retried, because a loop that returns leaves a channel that is registered, reports nothing and
     * receives nothing.
     */
    async #connect(host: ChannelHost): Promise<void> {
        while (this.#running) {
            try {
                const api = this.#api ?? (await loadBaileys())
                mkdirSync(this.#authDir, { recursive: true, mode: 0o700 })
                const socket = await api.connect({
                    authDir: this.#authDir,
                    onUpdate: (update) => this.#onUpdate(host, update),
                    onCreds: () => this.#secureAuthDir(),
                    onMessages: (upsert) => this.#onMessages(host, upsert),
                })
                this.#socket = socket
                // Returns once the socket exists. Everything after this is events, and the loop
                // only comes round again when one of them says the connection closed.
                await this.#closed()
            } catch (cause) {
                if (!this.#running) return
                this.#report(host, cause)
            }
            if (!this.#running) return
            await sleep(this.#backoff())
        }
    }

    /** Resolves when `connection: "close"` is seen, which is what `#onUpdate` sets. */
    #closed(): Promise<void> {
        return new Promise((resolve) => {
            this.#resolveClosed = resolve
        })
    }
    #resolveClosed: (() => void) | undefined

    #onUpdate(host: ChannelHost, update: ConnectionUpdate): void {
        if (update.qr !== undefined && update.qr !== "") {
            // **The first producer of `needs_input`.** The payload is the raw QR string — the
            // caller renders it, because a terminal wants an ASCII block and a browser wants an
            // <img>, and a transport that picked one would be wrong for the other.
            host.status("needs_input", `scan to pair channel "${this.id}"`, {
                kind: "qr",
                payload: update.qr,
                expiresAt: new Date(Date.now() + QR_TTL_MS).toISOString(),
            })
            return
        }

        if (update.connection === "open") {
            this.#failures = 0
            host.status("connected", "paired")
            return
        }

        if (update.connection === "close") {
            const code = update.lastDisconnect?.error?.output?.statusCode
            if (code === LOGGED_OUT) {
                // **The one disconnect that is not transient.** Reconnecting with revoked
                // credentials fails forever and never issues a QR, which is the stuck-with-no-QR
                // state worth all of this care. Deleting them is what makes the next loop pass
                // start a fresh pairing.
                this.#wipeCredentials()
                host.status("disconnected", "logged out — pairing again, scan the next QR")
                host.error({
                    code: "whatsapp_logged_out",
                    message: `Channel "${this.id}" was logged out of WhatsApp.`,
                    hint: "The stored session was revoked — from the phone's linked-devices screen, or by WhatsApp. The saved credentials have been deleted and a new QR follows; scan it to pair again.",
                })
            } else {
                this.#failures += 1
                // Reported on the first failure and every eighth after it, so a long outage leaves
                // a trail without burying every other event in the stream.
                if (this.#failures === 1 || this.#failures % 8 === 0) {
                    host.status(
                        "disconnected",
                        update.lastDisconnect?.error?.message ?? "connection closed",
                    )
                }
            }
            this.#socket = undefined
            this.#resolveClosed?.()
            this.#resolveClosed = undefined
        }
    }

    #onMessages(host: ChannelHost, upsert: MessagesUpsert): void {
        // `notify` is a live message; `append` is history syncing after a pair, which must not be
        // answered — a fresh pairing replays days of conversation, and answering all of it is the
        // worst possible first impression.
        if (upsert.type !== "notify") return
        for (const message of upsert.messages) {
            const raw = toInbound(message)
            if (raw !== undefined) host.receive(raw)
        }
    }

    #report(host: ChannelHost, cause: unknown): void {
        this.#failures += 1
        if (this.#failures !== 1 && this.#failures % 8 !== 0) return
        host.status("error", cause instanceof Error ? cause.message : String(cause))
        host.error({
            code: "whatsapp_connect_failed",
            message: `Channel "${this.id}" could not connect: ${cause instanceof Error ? cause.message : String(cause)}`,
            hint: "The loop keeps retrying and the rest of the runtime is unaffected. If it never connects, check network access and whether the paired number is still linked in WhatsApp's linked-devices screen.",
        })
    }

    #backoff(): number {
        const index = Math.min(this.#failures, RECONNECT_BACKOFF_MS.length - 1)
        return RECONNECT_BACKOFF_MS[index] ?? 1_000
    }

    /**
     * Delete the paired session.
     *
     * The whole directory, because Baileys spreads a session across `creds.json` and one file per
     * signal key — leaving any of it behind produces a half-session that fails in ways nobody can
     * diagnose, which is worse than pairing again.
     */
    #wipeCredentials(): void {
        rmSync(this.#authDir, { recursive: true, force: true })
    }

    /**
     * `0600` on every credential file, re-applied whenever Baileys writes one.
     *
     * Not once at creation: `useMultiFileAuthState` writes a new file per signal key as a
     * conversation goes on, and each arrives at the process umask. A session file is a credential —
     * whoever has it *is* the paired device — so this is the same rule `.env` follows at `0600`.
     */
    #secureAuthDir(): void {
        try {
            chmodSync(this.#authDir, 0o700)
            for (const name of readdirSync(this.#authDir)) {
                chmodSync(join(this.#authDir, name), 0o600)
            }
        } catch {
            // A file that vanished between the listing and the chmod is a wipe racing a write, and
            // the next pass covers whatever is left. Not worth failing a connection over.
        }
    }
}

/**
 * One WhatsApp message as the runtime sees it, or `undefined` for one there is nothing to answer.
 *
 * Exported for the test, which asserts on this mapping rather than on a live pairing.
 */
export function toInbound(message: WhatsAppMessage):
    | {
          providerMessageId?: string
          peerId: string
          senderHandle?: string
          senderName?: string
          text: string
          receivedAt: string
      }
    | undefined {
    const jid = message.key?.remoteJid
    if (jid === null || jid === undefined || jid === "") return undefined
    // Our own messages come back on the stream. Answering them is an agent talking to itself.
    if (message.key?.fromMe === true) return undefined
    // A group has its own JID shape and a `participant`. Out of scope in v1 rather than
    // half-supported: `allowFrom` is per sender and a group's rules are a different question.
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return undefined

    const body = message.message
    const text =
        body?.conversation ??
        body?.extendedTextMessage?.text ??
        body?.imageMessage?.caption ??
        body?.videoMessage?.caption ??
        body?.documentMessage?.caption ??
        ""
    if (text.trim() === "") return undefined

    const stamp = message.messageTimestamp
    const seconds =
        typeof stamp === "number"
            ? stamp
            : typeof stamp?.toNumber === "function"
              ? stamp.toNumber()
              : undefined

    const id = message.key?.id
    const name = message.pushName
    return {
        ...(id === null || id === undefined ? {} : { providerMessageId: id }),
        peerId: jid,
        // **The digits, with no `+`.** `allowFrom` is compared after folding case and dropping one
        // leading `@`, and nothing strips a `+` — so this is the one spelling that matches an entry
        // somebody typed, and it is the spelling the JID itself carries. The factory warns about
        // the other one rather than trying to accept both, because two spellings for one field is
        // how an allowlist comes to match nobody.
        senderHandle: numberOf(jid),
        ...(name === null || name === undefined || name === "" ? {} : { senderName: name }),
        text,
        receivedAt: new Date(seconds === undefined ? Date.now() : seconds * 1000).toISOString(),
    }
}

/** `8801711223344@s.whatsapp.net` → `8801711223344`. Also tolerates a bare number. */
export function numberOf(jid: string): string {
    const at = jid.indexOf("@")
    const local = at === -1 ? jid : jid.slice(0, at)
    // Baileys appends a device suffix on a linked device: `8801711223344:12@s.whatsapp.net`.
    const colon = local.indexOf(":")
    return colon === -1 ? local : local.slice(0, colon)
}

/** A recipient as `deliver.to` or a session key spells it, turned into something Baileys accepts. */
export function jidOf(recipient: string): string {
    return recipient.includes("@") ? recipient : `${numberOf(recipient)}@s.whatsapp.net`
}

/**
 * Load Baileys and adapt it to `BaileysApi`.
 *
 * Dynamic, so an agent that names this channel but never starts it pays nothing — and so the 6.8 MB
 * of bundled protocol code is off the path of every command that is not `serve`.
 */
async function loadBaileys(): Promise<BaileysApi> {
    const module = (await import("baileys")) as unknown as BaileysModule
    // CommonJS interop: the package's default export is the namespace under some loaders and the
    // function under others. Reading both is what stops this failing differently under Bun and Node.
    const exported = module.default
    const nested = typeof exported === "function" ? exported.default : undefined
    const make = typeof exported === "function" ? (nested ?? exported) : module.makeWASocket
    const useMultiFileAuthState =
        module.useMultiFileAuthState ??
        (typeof exported === "function" ? exported.useMultiFileAuthState : undefined)
    if (typeof make !== "function" || typeof useMultiFileAuthState !== "function") {
        throw new Error(
            "the installed baileys package does not export makeWASocket and useMultiFileAuthState",
        )
    }

    return {
        connect: async ({ authDir, onUpdate, onCreds, onMessages }) => {
            const { state, saveCreds } = await useMultiFileAuthState(authDir)
            const socket = make({
                auth: state,
                // Baileys prints its own QR to stdout by default, which would paint over a
                // rendered frame and put a credential-shaped block in a log file. The runtime
                // carries the payload instead, through `needs_input`.
                printQRInTerminal: false,
                // Silenced for the same reason: this process has an event bus and a log file of
                // its own, and a second logger writing to stdout is how a TUI gets corrupted.
                logger: silentLogger(),
                markOnlineOnConnect: false,
            })
            socket.ev.on("connection.update", onUpdate)
            socket.ev.on("creds.update", async () => {
                await saveCreds()
                await onCreds()
            })
            socket.ev.on("messages.upsert", onMessages)
            return socket
        },
    }
}

interface BaileysModule {
    default?: BaileysFactory & { default?: BaileysFactory; useMultiFileAuthState?: AuthStateLoader }
    makeWASocket?: BaileysFactory
    useMultiFileAuthState?: AuthStateLoader
}

type BaileysFactory = (config: Record<string, unknown>) => WhatsAppSocket
type AuthStateLoader = (
    folder: string,
) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>

/** Pino's shape, doing nothing. A logger that writes to stdout corrupts a rendered frame. */
function silentLogger(): Record<string, unknown> {
    const noop = (): void => {}
    const logger: Record<string, unknown> = {
        level: "silent",
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        fatal: noop,
    }
    logger.child = () => logger
    return logger
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
