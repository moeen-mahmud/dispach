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
 * Refused pairings before this stops asking.
 *
 * Low on purpose. Each attempt is a failed pairing recorded against a real WhatsApp number, and a
 * banned number has no appeal — so the cost of one attempt too many is far higher than the cost of
 * asking somebody to run the command again. Three is enough to ride out a single bad response and
 * far short of anything that looks like abuse.
 */
const MAX_PAIRING_REJECTIONS = 3

/** How many of our own sent message ids to remember, so a reply is never read back as input. */
const SENT_ID_MEMORY = 512

/**
 * How long a QR is offered before the next one replaces it.
 *
 * WhatsApp rotates it at roughly this interval and Baileys emits each one; this is what a reader
 * is told so a code nobody scanned in time reads as expired rather than as a broken scanner.
 */
const QR_TTL_MS = 60_000

/**
 * How long a pairing code is offered before it is treated as lapsed.
 *
 * Longer than the QR's, because the two rotate differently: WhatsApp reissues a QR every twenty
 * seconds or so, while a code is requested once and stays typeable for minutes. Generous rather
 * than exact — the cost of saying "expired" early is somebody discarding a code that still works.
 */
const PAIRING_CODE_TTL_MS = 180_000

/** How long to let the socket settle before asking for a code. Baileys' examples use the same. */
const PAIRING_CODE_DELAY_MS = 3_000

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
 * That is why nothing this project ships runs under Bun: the npm bin, the brew formula and the
 * container image all run under Node since 0.1.3. What still reaches this line is `bun run
 * src/index.ts` from a checkout, and a channel that connects to nothing and reports nothing is the
 * exact failure this runtime exists to refuse — so it is named at start, as an error rather than a
 * refusal, because the cause is somebody else's and may be fixed without a release here.
 */
const BUN_LIMITATION = {
    code: "whatsapp_bun_unsupported",
    message:
        "WhatsApp pairing does not complete under Bun — the socket opens and the handshake never finishes.",
    hint: "Measured against the same bundle: it pairs under Node in about two seconds and never under Bun. Every shipped install (npm, brew, the container) runs under Node; this process is running from a checkout with `bun run`. Use `node` — or the installed command — instead. It keeps trying regardless, in case the cause is fixed upstream.",
} as const

/**
 * Whether this session has been accepted by the phone, whether or not login has finished.
 *
 * **`registered` alone was the bug.** After the code is typed, `pair-success` arrives, Baileys
 * writes `account` (and `me`, `platform`, `signalIdentities`) and logs *"expect to restart the
 * connection"*; WhatsApp then closes with 515 and login completes on the reconnect — and only
 * *then* does `messages-recv.js` set `registered = true`. On that reconnect `registered` is still
 * false, so a guard reading it requested a **second** code, and `requestPairingCode` overwrites
 * `me` and starts a fresh pairing on top of the one that was about to finish. Measured on a real
 * session: the phone listed the device, and the creds on disk held `me` and `pairingCode` and none
 * of the pair-success fields — the state that second request leaves behind.
 *
 * `account` is written by pair-success and by nothing else, so it is the signal. Unknown reads as
 * paired, for the reason `#requestCode` already gives: treating a working session as unpaired is
 * the worse of the two errors.
 */
function pairedOnDisk(socket: WhatsAppSocket): boolean {
    const creds = socket.authState?.creds
    if (creds === undefined) return true
    return creds.registered === true || (creds.account !== undefined && creds.account !== null)
}

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
    /**
     * Ask WhatsApp for an eight-character code to type into the phone, instead of a QR to scan.
     *
     * Optional because it is a property of the installed Baileys rather than of this interface —
     * a build without it must degrade to the QR, not fail to start.
     */
    requestPairingCode?(phoneNumber: string): Promise<string>
    /**
     * Baileys' own view of this session. Absent on a stub.
     *
     * Two fields matter and they are set at different moments. `account` is written by
     * `pair-success` — the phone accepted the code — and survives the restart WhatsApp then
     * demands. `registered` is written only once login completes on the connection *after* that
     * restart. In between, a session is paired and not yet registered, and that window is where
     * a guard reading only `registered` asks for a second code.
     */
    authState?: { creds?: { registered?: boolean; account?: unknown } }
    /**
     * The linked account, once connected. `id` is a phone JID or a LID; `lid` is the LID form when
     * Baileys knows it. Both are needed to recognise the owner's own messages, because WhatsApp
     * addresses the same chat by either depending on the peer.
     */
    user?: { id: string; lid?: string }
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
        /**
         * The other spelling of `remoteJid`. WhatsApp now addresses many chats by **LID** — an
         * opaque per-account id ending `@lid` — and carries the phone-number form here, or the
         * reverse. Reading only `remoteJid` reports a LID's digits as the sender, which matches
         * nobody's `allowFrom`.
         */
        remoteJidAlt?: string | null
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
        /** The bracketed half of the Linked-devices label. `Ubuntu` when absent. */
        readonly deviceName?: string
        readonly onUpdate: (update: ConnectionUpdate) => void
        readonly onCreds: () => void | Promise<void>
        readonly onMessages: (upsert: MessagesUpsert) => void
    }): Promise<WhatsAppSocket>
}

export interface WhatsAppTransportOptions {
    readonly id: string
    /** Where Baileys keeps the paired session. Absolute by the time it reaches here. */
    readonly authDir: string
    /**
     * The number of the WhatsApp account this agent becomes a linked device of, digits only.
     *
     * Set it and pairing is an **eight-character code typed into the phone** instead of a QR to
     * scan — which is the only route that works at all when the surface offering it cannot draw a
     * QR, and the better one everywhere else.
     *
     * **This is not `allowFrom`, and the two must never be folded together.** `allowFrom` is the
     * inbound gate: who may talk to the agent. This is the account it *runs as*. They are usually
     * different people, and conflating them is the documented "chat not found" class of failure
     * one field over.
     */
    readonly pairWith?: string
    /**
     * What the phone shows under *Linked devices*, in the bracket: `Google Chrome (<deviceName>)`.
     *
     * The left token is a protobuf enum the phone renders from `platformType`, so it cannot carry
     * a name; the bracket is `browser[0]`, the one free-text slot. Optional and off by default
     * because WhatsApp validates the pairing-by-code request against canonical browser labels and
     * **some accounts refuse a non-standard one** (Baileys #2560, OpenWA #1666): the code is
     * issued, the phone says it could not link, and the socket is closed as logged out. The
     * refusal names this field when it is set.
     */
    readonly deviceName?: string
    /** Injected by the tests, which never reach WhatsApp. */
    readonly api?: BaileysApi
    /**
     * How long to let the socket settle before asking for a pairing code.
     *
     * A seam for the same reason `api` is one: the wait is three seconds of real time, and a suite
     * that actually slept it would trade a fast check for a slow one and teach everybody to skip
     * the file. Nothing in a manifest sets this.
     */
    readonly pairingDelayMs?: number
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

    /**
     * The paired account may always talk to its own agent. Set from `pairWith`, because the
     * person who typed the code is the account, and an empty `allowFrom` refused exactly them.
     */
    readonly alwaysAllow: readonly string[]
    readonly #authDir: string
    readonly #pairWith: string | undefined
    readonly #deviceName: string | undefined
    readonly #pairingDelayMs: number
    readonly #api: BaileysApi | undefined

    #host: ChannelHost | undefined
    #socket: WhatsAppSocket | undefined
    #running = false
    #failures = 0
    /**
     * A code has been issued for this socket, so the QR updates that keep arriving are ignored.
     *
     * Baileys emits `qr` on the same connection whether or not a pairing code was requested, and
     * it reissues roughly every twenty seconds. Without this the channel's status alternates
     * between the code somebody is typing and a barcode they did not ask for — and the code
     * disappears from the panel mid-entry, which reads as the pairing having failed.
     *
     * Per socket, cleared on reconnect, because a fresh socket needs a fresh code.
     *
     * Set **before** the request rather than after it, because the settle wait is three seconds and
     * Baileys emits its first QR inside that window: without it the panel showed a barcode, then
     * replaced it with a code, which reads as the first one having failed. Cleared again if the
     * request is refused, since the QR is then the only route left and suppressing it would leave
     * a channel offering nothing at all.
     */
    #codeIssued = false
    /**
     * Whether this attempt began from a session WhatsApp had already registered.
     *
     * **This, and not "has it connected yet", is what tells a revocation from a refused pairing.**
     * The first version used a connection having opened in *this process*, which is a different
     * question and got the documented case backwards: credentials revoked from the phone while the
     * process was down produce a `loggedOut` on the very first connect, and that must still wipe
     * and offer a fresh code — it is the stuck-with-no-QR state the branch exists for.
     *
     * Unknown counts as registered, which is the same default `#requestCode` takes and for the same
     * reason: treating a working session as unpaired is the worse of the two errors.
     */
    #startedRegistered = true
    /** Consecutive `loggedOut` closes on a session that has never connected. */
    #pairingRejections = 0
    /** Set when pairing has been refused enough times to stop asking. Ends the reconnect loop. */
    #pairingGivenUp = false
    /**
     * The linked account's own identities, normalised. Filled from `socket.user` on open.
     *
     * What makes a self-chat answerable: the owner typing to themselves arrives as `fromMe` on a
     * chat whose peer is one of these, and that is the one `fromMe` message the agent must read.
     */
    #ownJids = new Set<string>()
    /**
     * Ids of messages this transport sent, so its own replies are never read back as input.
     *
     * A ring rather than a growing set: an agent that answers for a week would otherwise hold
     * every id it ever sent. Baileys ids are unique per session, so recent is enough.
     */
    #sentIds: string[] = []
    #loop: Promise<void> | undefined

    constructor(options: WhatsAppTransportOptions) {
        this.id = options.id
        this.#authDir = options.authDir
        this.#pairWith = options.pairWith
        this.#deviceName = options.deviceName
        this.alwaysAllow =
            options.pairWith === undefined || options.pairWith === "" ? [] : [options.pairWith]
        this.#pairingDelayMs = options.pairingDelayMs ?? PAIRING_CODE_DELAY_MS
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
            if (id !== undefined && id !== null) {
                this.#sentIds.push(id)
                if (this.#sentIds.length > SENT_ID_MEMORY) this.#sentIds.shift()
            }
            return id === undefined || id === null
                ? { ok: true }
                : { ok: true, providerMessageId: id }
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
        while (this.#running && !this.#pairingGivenUp) {
            try {
                const api = this.#api ?? (await loadBaileys())
                mkdirSync(this.#authDir, { recursive: true, mode: 0o700 })
                // **Decided before the socket exists, not once a code is in hand.** The intent to
                // pair by code is known from the configuration, and Baileys starts emitting QRs as
                // soon as it connects — so a flag set after the request leaves a window in which a
                // barcode reaches the panel and is then replaced, which reads as a failed attempt.
                // `#requestCode` clears it again if the request is refused.
                this.#codeIssued = this.#pairWith !== undefined && this.#pairWith !== ""
                const socket = await api.connect({
                    authDir: this.#authDir,
                    ...(this.#deviceName === undefined ? {} : { deviceName: this.#deviceName }),
                    onUpdate: (update) => this.#onUpdate(host, update),
                    onCreds: () => this.#secureAuthDir(),
                    onMessages: (upsert) => this.#onMessages(host, upsert),
                })
                this.#socket = socket
                // Captured before anything can change it: `creds.update` fires during pairing, so
                // reading this at close time would report the state pairing left behind rather than
                // the one it started from.
                this.#startedRegistered = pairedOnDisk(socket)
                await this.#requestCode(host, socket)
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

    /**
     * Ask for a pairing code, when a number was configured and this session is not already linked.
     *
     * **Guarded on `registered`, which is the whole correctness of it.** Asking again on a session
     * that is already paired is at best wasted and at worst logs the device out — and this runs
     * inside the reconnect loop, so every transient close would reach it. Baileys' own creds are
     * the authority; a build that does not expose them is treated as *registered* rather than not,
     * because re-pairing a working channel is the worse of the two errors.
     *
     * A failure here is reported and **not** rethrown: the QR path is still live on the same
     * socket, so a channel that cannot get a code can still be paired by scanning. Turning that
     * into a reconnect would take the QR away too.
     */
    async #requestCode(host: ChannelHost, socket: WhatsAppSocket): Promise<void> {
        const number = this.#pairWith
        if (number === undefined || number === "") return
        if (pairedOnDisk(socket)) return
        if (typeof socket.requestPairingCode !== "function") {
            host.status(
                "needs_input",
                `channel "${this.id}" is set to pair by code and this build of baileys cannot`,
                {
                    kind: "qr",
                    payload: "",
                    expiresAt: new Date(Date.now() + QR_TTL_MS).toISOString(),
                },
            )
            return
        }
        try {
            // WhatsApp refuses a request that arrives before the socket has finished opening, and
            // the refusal is a close rather than an error — indistinguishable from a network fault
            // at the point it surfaces. Baileys' own examples wait; so does this.
            await sleep(this.#pairingDelayMs)
            if (!this.#running) return
            const code = await socket.requestPairingCode(number)
            host.status(
                "needs_input",
                `enter this code on WhatsApp for +${number} — Linked devices › Link with phone number`,
                {
                    kind: "pairing_code",
                    payload: code,
                    expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString(),
                },
            )
        } catch (cause) {
            // The QR is the only route left, so it must start reaching the host again.
            this.#codeIssued = false
            this.#report(host, cause)
        }
    }

    /** Resolves when `connection: "close"` is seen, which is what `#onUpdate` sets. */
    #closed(): Promise<void> {
        /**
         * **Already stopped means already closed**, and without this the loop parks forever.
         *
         * `stop()` resolves whatever promise this last handed out — but between `api.connect`
         * returning and this being called there is a window with no promise to resolve, so a
         * `stop()` landing in it resolved nothing and the `await this.#loop` inside it then waited
         * on a promise nobody would ever settle. The window was one await wide and grew to two when
         * pairing-code requests landed between them, at which point a test that stops immediately
         * after starting hung for its full timeout — which is exactly what a process that will not
         * exit looks like from outside, and is the same failure `stop()` already carries a comment
         * about.
         */
        if (!this.#running) return Promise.resolve()
        return new Promise((resolve) => {
            this.#resolveClosed = resolve
        })
    }
    #resolveClosed: (() => void) | undefined

    #onUpdate(host: ChannelHost, update: ConnectionUpdate): void {
        if (update.qr !== undefined && update.qr !== "" && !this.#codeIssued) {
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
            this.#pairingRejections = 0
            this.#failures = 0
            const me = this.#socket?.user
            this.#ownJids.clear()
            if (me?.id !== undefined) this.#ownJids.add(bareJid(me.id))
            if (me?.lid !== undefined) this.#ownJids.add(bareJid(me.lid))
            host.status("connected", "paired")
            return
        }

        if (update.connection === "close") {
            const code = update.lastDisconnect?.error?.output?.statusCode
            if (code === LOGGED_OUT) {
                /**
                 * **Two different events wear this status code, and treating them alike burns the
                 * number.**
                 *
                 * A session that *had* connected and is now logged out was revoked by a person, on
                 * the phone's linked-devices screen. Wiping and pairing again is exactly right.
                 *
                 * A session that has **never** connected and is logged out had its *pairing attempt*
                 * refused. Wiping and retrying immediately is then a loop: measured in the container
                 * at three codes in fifteen seconds, each invalidated before anybody could finish
                 * typing the one before it — and every pass is another failed pairing against a real
                 * WhatsApp number, which decision 8.4 says is the thing that gets an account banned
                 * with no appeal. The old code never touched `#failures` here, so the backoff stayed
                 * at one second forever.
                 *
                 * So a refused pairing counts, backs off, and eventually stops asking.
                 */
                this.#wipeCredentials()
                if (this.#startedRegistered) {
                    this.#pairingRejections = 0
                    host.status("disconnected", "logged out — pairing again, scan the next QR")
                    host.error({
                        code: "whatsapp_logged_out",
                        message: `Channel "${this.id}" was logged out of WhatsApp.`,
                        hint: "The stored session was revoked — from the phone's linked-devices screen, or by WhatsApp. The saved credentials have been deleted and a new QR follows; scan it to pair again.",
                    })
                } else {
                    this.#pairingRejections += 1
                    this.#failures += 1
                    if (this.#pairingRejections >= MAX_PAIRING_REJECTIONS) {
                        this.#pairingGivenUp = true
                        host.status(
                            "error",
                            `pairing refused ${this.#pairingRejections} times — not asking again`,
                        )
                        host.error({
                            code: "whatsapp_pairing_refused",
                            message: `WhatsApp refused ${this.#pairingRejections} pairing attempts for channel "${this.id}" and none completed.`,
                            hint: onBun()
                                ? "This is what the Bun limitation looks like from the outside: a code is issued and invalidated seconds later. Pair using the npm-installed package, whose bin runs under Node, then bring the paired session back. Retrying here only spends failed pairings against the number."
                                : this.#deviceName !== undefined
                                  ? `deviceName is set ("${this.#deviceName}"), and some accounts refuse a non-standard device name under pairing-by-code. Remove deviceName from the channel and pair again; check the number too. Repeated failed pairings are the thing that gets an account restricted, so this stops rather than continuing.`
                                  : "Check that the number is the one WhatsApp is registered to, in digits with no +. Repeated failed pairings are the thing that gets an account restricted, so this stops rather than continuing.",
                        })
                    } else {
                        host.status("disconnected", "pairing refused — trying once more")
                    }
                }
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
            const raw = toInbound(message, { ownJids: this.#ownJids, sentIds: this.#sentIds })
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
/** What `toInbound` needs to know about this connection that a message does not carry. */
export interface InboundContext {
    /** The linked account's own identities, from `bareJid`. Empty before the first open. */
    readonly ownJids: ReadonlySet<string>
    /** Ids of messages this transport sent. */
    readonly sentIds: readonly string[]
}

const NO_CONTEXT: InboundContext = { ownJids: new Set(), sentIds: [] }

export function toInbound(
    message: WhatsAppMessage,
    context: InboundContext = NO_CONTEXT,
):
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
    const id = message.key?.id

    /**
     * **`fromMe` is two different things, and the old filter dropped both.**
     *
     * The agent's own replies come back on the stream as `fromMe`, and answering them is an agent
     * talking to itself — that is the case the filter was written for. But **the owner typing in
     * the chat with themselves is also `fromMe`**, because they *are* the account, and that is the
     * one conversation a person linking their own number most expects to work. Measured: a freshly
     * paired agent showed as a linked device and answered nothing, because every message its owner
     * sent it was discarded here as its own echo.
     *
     * So the two are told apart by what only the transport knows: a message it sent has an id it
     * recorded, and a chat with the owner has the owner's own JID as its peer. `fromMe` on any
     * *other* chat is the owner talking to a third party from their phone, which is not the
     * agent's conversation and stays skipped. OpenClaw calls this `selfChatMode` and defaults it
     * on.
     */
    if (message.key?.fromMe === true) {
        if (id !== null && id !== undefined && context.sentIds.includes(id)) return undefined
        const peer = bareJid(jid)
        const alt = message.key?.remoteJidAlt
        const peerAlt = alt === null || alt === undefined ? undefined : bareJid(alt)
        const isSelfChat =
            context.ownJids.has(peer) || (peerAlt !== undefined && context.ownJids.has(peerAlt))
        if (!isSelfChat) return undefined
    }
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

    // **The phone-number form, whichever field carries it.** WhatsApp addresses many chats by LID
    // now and puts the phone form in `remoteJidAlt`, or the reverse; `numberOf` on a LID reports
    // digits that are nobody's phone number, so an `allowFrom` written from a contact card matched
    // no one. Delivery uses the same form, so a reply goes back to a JID Baileys can route.
    const phoneJid = phoneJidOf(jid, message.key?.remoteJidAlt)
    const name = message.pushName
    return {
        ...(id === null || id === undefined ? {} : { providerMessageId: id }),
        peerId: phoneJid,
        // Digits with no `+` — the spelling the JID itself carries. `allowFrom` is normalised the
        // same way on its side now, so `+880…` written from a contact card matches this.
        senderHandle: numberOf(phoneJid),
        ...(name === null || name === undefined || name === "" ? {} : { senderName: name }),
        text,
        receivedAt: new Date(seconds === undefined ? Date.now() : seconds * 1000).toISOString(),
    }
}

/** Of a JID and its alternate spelling, the one that names a phone number; else the primary. */
export function phoneJidOf(jid: string, alt: string | null | undefined): string {
    if (jid.endsWith("@s.whatsapp.net")) return jid
    if (alt?.endsWith("@s.whatsapp.net") === true) return alt
    return jid
}

/**
 * A JID with its device suffix removed, for comparing identities.
 *
 * A linked device is `8801711223344:12@s.whatsapp.net`; the account is `8801711223344@s.whatsapp.net`.
 * Same person, and the comparison that recognises the owner's self-chat has to say so.
 */
export function bareJid(jid: string): string {
    const at = jid.indexOf("@")
    if (at === -1) return jid
    const local = jid.slice(0, at)
    const colon = local.indexOf(":")
    return `${colon === -1 ? local : local.slice(0, colon)}${jid.slice(at)}`
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
        connect: async ({ authDir, deviceName, onUpdate, onCreds, onMessages }) => {
            const { state, saveCreds } = await useMultiFileAuthState(authDir)
            const socket = make({
                auth: state,
                // Baileys prints its own QR to stdout by default, which would paint over a
                // rendered frame and put a credential-shaped block in a log file. The runtime
                // carries the payload instead, through `needs_input`.
                printQRInTerminal: false,
                /**
                 * **The device identity, and pairing by code does not work under the default.**
                 *
                 * Baileys defaults to `Browsers.macOS('Chrome')`, and against that
                 * `requestPairingCode` is answered with a close and then a `loggedOut` — measured,
                 * on a fresh session, twice. `Ubuntu/Chrome` pairs. Written as the literal triple
                 * the helper produces rather than importing `Browsers`, so this stays one value
                 * read in one place instead of an interop question on a namespace that already
                 * needs two spellings above.
                 *
                 * Slot 0 is what the phone prints in the bracket of the Linked-devices label; slot
                 * 1 selects a `PlatformType` enum (the "Google Chrome" half) and cannot carry a
                 * name. `deviceName` replaces slot 0 only — the pairing request's
                 * `companion_platform_display` is built from both, and a non-canonical one is
                 * what some accounts refuse, which is why the field is opt-in.
                 */
                browser: [deviceName ?? "Ubuntu", "Chrome", "22.04.4"],
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
