/**
 * Silo lifecycle, and the loop that suspends idle silos and wakes them in time.
 *
 * **What this owns and what it refuses** (decision 14.6 in the runtime's repo): placing, routing,
 * suspending, waking and deleting silos, minting keys in them, and summing their usage. Never a
 * second copy of anything a silo decides — who a key reaches, what an agent may do, whether a turn
 * is allowed. A silo answers those itself, over `/v1`, and this process only forwards.
 *
 * **When to pause is the silo's answer, not a guess.** `GET /v1/activity` says whether a turn is
 * running or a delivery is owed and when the next schedule is due; this process adds only what the
 * silo cannot know — whether a proxied request is still open, and how long since the last one.
 */

import { createHash, randomBytes } from "node:crypto"
import type { Readable } from "node:stream"
import { BRAND } from "./brand.ts"
import type { Monitor } from "./monitor.ts"
import { ControlError, type Placer } from "./placer.ts"
import type { Silo, SiloStore } from "./store.ts"

/** Docker's own name rule, so a subject is always a valid container and volume name. */
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

export interface SiloActivity {
    readonly idle: boolean
    readonly nextWakeAt?: string
}

export interface ControlOptions {
    readonly store: SiloStore
    readonly placer: Placer
    /**
     * Whether the sweep pauses idle silos at all. **Off by default: the product is always-on**, like
     * every agent harness a person expects to answer (decision 14.14). A paused silo holds no live
     * channel connection, so WhatsApp and a Telegram long-poll go deaf while it sleeps. On is a cost
     * option for a deployment whose silos are reached only through this proxy.
     */
    readonly suspend?: boolean
    /** Quiet time after the last proxied request before an idle silo is paused, when `suspend` is on. */
    readonly idleMs?: number
    /** How long before `nextWakeAt` a paused silo is woken. */
    readonly wakeMarginMs?: number
    /** How often the sweep runs. */
    readonly sweepMs?: number
    readonly readyTimeoutMs?: number
    readonly now?: () => number
    readonly fetch?: typeof fetch
    readonly log?: (line: string) => void
    /** Subscribes each new silo to the pilot monitor. */
    readonly monitor?: Monitor
    /**
     * Where silos reach this process for the peer-ask relay (decision 15.10). Set, every silo created
     * or recreated gets a relay token and this URL in its environment; absent, the relay is off.
     */
    readonly relayUrl?: string
}

/** How a relay token is stored and looked up: never the token itself. */
export const relayDigest = (token: string): string =>
    createHash("sha256").update(token).digest("hex")

export function checkSubject(subject: string): void {
    if (!SUBJECT.test(subject)) {
        throw new ControlError({
            code: "subject_invalid",
            message: `"${subject}" is not a usable subject.`,
            hint: "A subject is the embedder's own id for a user or team space: 1–63 characters of letters, digits, '_', '.' or '-', starting with a letter or digit. Hash or encode anything else before sending it.",
            status: 400,
        })
    }
}

export class ControlPlane {
    readonly store: SiloStore
    readonly #placer: Placer
    readonly #suspendIdle: boolean
    readonly #idleMs: number
    readonly #wakeMarginMs: number
    readonly #sweepMs: number
    readonly #readyTimeoutMs: number
    readonly #now: () => number
    readonly #fetch: typeof fetch
    readonly #log: (line: string) => void
    readonly #monitor: Monitor | undefined
    readonly #relayUrl: string | undefined
    /** Proxied requests still open, per subject. A streaming turn holds its silo awake. */
    readonly #open = new Map<string, number>()
    /** One wake or create in flight per subject; a burst of requests shares it. */
    readonly #pending = new Map<string, Promise<Silo>>()
    #timer: ReturnType<typeof setInterval> | undefined
    #sweeping = false
    /** Silos known to keep their address across a restart, so the sweep stops asking Docker. */
    readonly #pinned = new Set<string>()

    constructor(options: ControlOptions) {
        this.store = options.store
        this.#placer = options.placer
        this.#suspendIdle = options.suspend ?? false
        this.#idleMs = options.idleMs ?? 60_000
        this.#wakeMarginMs = options.wakeMarginMs ?? 30_000
        this.#sweepMs = options.sweepMs ?? 5_000
        this.#readyTimeoutMs = options.readyTimeoutMs ?? 60_000
        this.#now = options.now ?? Date.now
        this.#fetch = options.fetch ?? globalThis.fetch
        this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
        this.#monitor = options.monitor
        this.#relayUrl = options.relayUrl
    }

    /**
     * A fresh relay token for a silo's environment, with only its hash kept. Minted again on every
     * recreate, which is also how a silo created before the relay existed gets one.
     */
    #relayEnv(): { env: Readonly<Record<string, string>>; hash?: string } {
        if (this.#relayUrl === undefined) return { env: {} }
        const token = randomBytes(32).toString("base64url")
        return {
            env: {
                [BRAND.runtime.relayUrlEnv]: this.#relayUrl,
                [BRAND.runtime.relayTokenEnv]: token,
            },
            hash: relayDigest(token),
        }
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────────────────────

    /** Idempotent: a subject that already has a silo gets it back, `created: false`. */
    async create(subject: string): Promise<{ silo: Silo; created: boolean }> {
        checkSubject(subject)
        const existing = this.store.get(subject)
        if (existing !== undefined) return { silo: existing, created: false }
        const inFlight = this.#pending.get(subject)
        if (inFlight !== undefined) return { silo: await inFlight, created: false }

        const work = (async () => {
            const token = randomBytes(32).toString("base64url")
            const relay = this.#relayEnv()
            const placed = await this.#placer.create(subject, token, relay.env)
            const at = this.#iso()
            this.store.insert({
                subject,
                name: placed.name,
                baseUrl: placed.baseUrl,
                token,
                status: "running",
                createdAt: at,
                lastActiveAt: at,
            })
            if (relay.hash !== undefined) this.store.setRelayTokenHash(subject, relay.hash)
            try {
                await this.#ready(placed.baseUrl, subject)
            } catch (error) {
                // Not half-created: a row with no working silo behind it is "looks live and is not".
                await this.#placer.remove(placed.name).catch(() => {})
                this.store.delete(subject)
                throw error
            }
            await this.#watch(this.#must(subject))
            return this.#must(subject)
        })()
        this.#pending.set(subject, work)
        try {
            return { silo: await work, created: true }
        } finally {
            this.#pending.delete(subject)
        }
    }

    /**
     * Pause now, on the operator's word. Refused while the silo is busy: freezing a turn mid-stream
     * leaves its model call to time out, which is a failure the person in the conversation sees.
     */
    async pause(subject: string): Promise<Silo> {
        const silo = this.#find(subject)
        if (silo.status === "paused") return silo
        await this.#suspend(silo, await this.#requireIdle(silo))
        return this.#must(subject)
    }

    async wake(subject: string): Promise<Silo> {
        return this.ensureAwake(this.#find(subject))
    }

    /**
     * Replace the container with the current image and environment, keeping its data. Refused while
     * busy, for the same reason `pause` is.
     */
    async recreate(subject: string): Promise<Silo> {
        const silo = this.#find(subject)
        if (silo.status === "running") {
            // Asked at the address it answers on now. A container that is not up cannot be busy, and
            // replacing it is how it comes back, so that is not a refusal.
            const located = await this.#locate(silo)
            if (located !== undefined) await this.#requireIdle(located)
        }
        const relay = this.#relayEnv()
        const placed = await this.#placer.recreate(subject, silo.token, relay.env)
        if (relay.hash !== undefined) this.store.setRelayTokenHash(subject, relay.hash)
        this.store.setBaseUrl(subject, placed.baseUrl)
        this.store.setStatus(subject, "running")
        this.store.touch(subject, this.#iso())
        await this.#ready(placed.baseUrl, subject)
        this.#pinned.add(subject)
        this.#log(`recreated ${subject}`)
        return this.#must(subject)
    }

    /**
     * The silo's data as a tar stream, taken while it is paused — so the copy is crash-consistent.
     *
     * Afterwards it is left paused only when suspending is on, where the next message or schedule
     * wakes it. With suspending off nothing would: a Telegram long-poll or a WhatsApp socket cannot
     * wake a frozen process, so a nightly backup left every channel deaf until somebody used the
     * web app. So a silo this call paused is woken once the archive has been read or abandoned.
     */
    async backup(subject: string): Promise<Readable> {
        const silo = this.#find(subject)
        const pausedHere = silo.status === "running"
        if (pausedHere) {
            const activity = await this.#requireIdle(silo)
            await this.#suspend(silo, activity)
        }
        const tar = await this.#placer.exportData(silo.name)
        if (pausedHere && !this.#suspendIdle) {
            tar.once("close", () => {
                this.wake(subject).catch((error: unknown) =>
                    this.#log(`backup: ${subject} not woken afterwards: ${String(error)}`),
                )
            })
        }
        return tar
    }

    /**
     * Replace the silo's data with a backup, then start it. Everything the silo held before is gone,
     * so a busy silo is refused rather than overwritten mid-turn.
     */
    async restore(subject: string, tar: Readable): Promise<Silo> {
        const silo = this.#find(subject)
        if (silo.status === "running") await this.#requireIdle(silo)
        await this.#placer.importData(silo.name, tar)
        await this.#placer.start(silo.name)
        const baseUrl = await this.#placer.address(silo.name)
        this.store.setBaseUrl(subject, baseUrl)
        this.store.setStatus(subject, "running")
        this.store.touch(subject, this.#iso())
        await this.#ready(baseUrl, subject)
        if (this.#monitor !== undefined) {
            // The archive may carry another silo's subscription; this one reports as itself.
            const restored = this.#must(subject)
            await this.#monitor
                .reattach(restored, (s, path, init) => this.siloFetch(s, path, init))
                .catch((error: unknown) =>
                    this.#log(`monitor: ${subject} not re-subscribed: ${String(error)}`),
                )
        }
        this.#log(`restored ${subject}`)
        return this.#must(subject)
    }

    /** Removes the silo and **its volume**: every agent, conversation and key in it. */
    async remove(subject: string): Promise<void> {
        const silo = this.#find(subject)
        await this.#placer.remove(silo.name)
        this.store.delete(subject)
    }

    // ─── Inside a silo ──────────────────────────────────────────────────────────────────────

    /** Awake, at its current address, with the idle clock restarted. Concurrent callers share a wake. */
    async ensureAwake(silo: Silo): Promise<Silo> {
        this.store.touch(silo.subject, this.#iso())
        if (silo.status === "running") return this.#must(silo.subject)
        const inFlight = this.#pending.get(silo.subject)
        if (inFlight !== undefined) return inFlight
        const work = (async () => {
            await this.#placer.wake(silo.name)
            const baseUrl = await this.#placer.address(silo.name)
            if (baseUrl !== silo.baseUrl) this.store.setBaseUrl(silo.subject, baseUrl)
            this.store.setStatus(silo.subject, "running")
            this.store.touch(silo.subject, this.#iso())
            this.#log(`woke ${silo.subject}`)
            return this.#must(silo.subject)
        })()
        this.#pending.set(silo.subject, work)
        try {
            return await work
        } finally {
            this.#pending.delete(silo.subject)
        }
    }

    /** Mark a proxied request open; the returned function closes it. */
    hold(subject: string): () => void {
        this.#open.set(subject, (this.#open.get(subject) ?? 0) + 1)
        let done = false
        return () => {
            if (done) return
            done = true
            this.#open.set(subject, Math.max(0, (this.#open.get(subject) ?? 1) - 1))
            this.store.touch(subject, this.#iso())
        }
    }

    /** A request to the silo as its operator — the silo's own token, which nothing else holds. */
    async siloFetch(silo: Silo, path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set("authorization", `Bearer ${silo.token}`)
        try {
            return await this.#fetch(`${silo.baseUrl}${path}`, { ...init, headers })
        } catch (error) {
            throw new ControlError({
                code: "silo_unreachable",
                message: `Silo "${silo.subject}" did not answer at ${silo.baseUrl}: ${String(error)}.`,
                hint: `Check the container is up (docker ps --filter label=${BRAND.label}). POST /v1/silos/<subject>/recreate brings back one that is down, keeping its data and its port.`,
                status: 502,
            })
        }
    }

    /**
     * A request to the silo with a credential the silo itself minted — never its token. The relay
     * sends a question this way, so the silo's scope rules decide what the turn reaches (rule 2).
     */
    async fetchAs(
        silo: Silo,
        path: string,
        credential: string,
        init: RequestInit = {},
    ): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set("authorization", `Bearer ${credential}`)
        try {
            return await this.#fetch(`${silo.baseUrl}${path}`, { ...init, headers })
        } catch (error) {
            throw new ControlError({
                code: "silo_unreachable",
                message: `Silo "${silo.subject}" did not answer at ${silo.baseUrl}: ${String(error)}.`,
                hint: `Check the container is up (docker ps --filter label=${BRAND.label}). POST /v1/silos/<subject>/recreate brings back one that is down, keeping its data and its port.`,
                status: 502,
            })
        }
    }

    async activity(silo: Silo): Promise<SiloActivity> {
        const response = await this.siloFetch(silo, "/v1/activity")
        if (!response.ok) {
            throw new ControlError({
                code: "silo_activity_unreadable",
                message: `Silo "${silo.subject}" answered ${response.status} to GET /v1/activity.`,
                hint: "The silo's runtime predates 0.2.0's activity route, or its token was changed by hand. Upgrade the image; the silo is left running rather than paused blind.",
                status: 502,
            })
        }
        return (await response.json()) as SiloActivity
    }

    // ─── The sweep ──────────────────────────────────────────────────────────────────────────

    /**
     * One pass: pause what is idle, wake what is due. Each silo's failure is logged and the pass
     * moves on — one broken silo must not keep the rest awake or asleep.
     */
    async sweep(): Promise<void> {
        if (this.#sweeping) return
        this.#sweeping = true
        try {
            const now = this.#now()
            for (const silo of this.store.list()) {
                try {
                    if (silo.status === "running") {
                        if (await this.#maybePin(silo)) continue
                        await this.#maybeSuspend(silo, now)
                    } else await this.#maybeWake(silo, now)
                } catch (error) {
                    const code = error instanceof ControlError ? error.code : "sweep_failed"
                    this.#log(`sweep ${silo.subject}: ${code}: ${String(error)}`)
                }
            }
        } finally {
            this.#sweeping = false
        }
    }

    /** Subscribe every silo the monitor is not yet hearing from — silos created before it existed. */
    async watchAll(): Promise<void> {
        for (const silo of this.store.list()) await this.#watch(silo)
    }

    async #watch(silo: Silo): Promise<void> {
        if (this.#monitor === undefined) return
        try {
            const awake = await this.ensureAwake(silo)
            await this.#monitor.attach(awake, (s, path, init) => this.siloFetch(s, path, init))
        } catch (error) {
            // Never fails the silo: an unmonitored silo still serves its user, and the report names it.
            this.#log(`monitor: ${silo.subject} not subscribed: ${String(error)}`)
        }
    }

    start(): void {
        if (this.#timer !== undefined) return
        this.#timer = setInterval(() => void this.sweep(), this.#sweepMs)
    }

    stop(): void {
        if (this.#timer !== undefined) clearInterval(this.#timer)
        this.#timer = undefined
    }

    async #maybeSuspend(silo: Silo, now: number): Promise<void> {
        if (!this.#suspendIdle) return
        if ((this.#open.get(silo.subject) ?? 0) > 0) return
        if (now - Date.parse(silo.lastActiveAt) < this.#idleMs) return
        const activity = await this.activity(silo)
        if (!activity.idle) return
        await this.#suspend(silo, activity)
    }

    /**
     * Recreate a silo placed before ports were fixed, keeping the port it has now — its address does
     * not change, and from then on no restart moves it. Only when idle, like an operator's recreate;
     * a busy one is tried again next pass. True when it was recreated.
     */
    async #maybePin(silo: Silo): Promise<boolean> {
        if (this.#pinned.has(silo.subject)) return false
        if (await this.#placer.pinned(silo.name)) {
            this.#pinned.add(silo.subject)
            return false
        }
        const located = await this.#locate(silo)
        if (located !== undefined) {
            const activity = await this.activity(located)
            if (!activity.idle || (this.#open.get(silo.subject) ?? 0) > 0) return false
        }
        await this.recreate(silo.subject)
        this.#log(`pinned ${silo.subject} to ${this.#must(silo.subject).baseUrl}`)
        return true
    }

    /**
     * The silo at the address it answers on now, stored if it moved; undefined when its container is
     * not up. Only a silo placed before ports were fixed can move.
     */
    async #locate(silo: Silo): Promise<Silo | undefined> {
        const baseUrl = await this.#placer.address(silo.name).catch(() => undefined)
        if (baseUrl === undefined) return undefined
        if (baseUrl !== silo.baseUrl) this.store.setBaseUrl(silo.subject, baseUrl)
        return this.#must(silo.subject)
    }

    async #maybeWake(silo: Silo, now: number): Promise<void> {
        if (silo.nextWakeAt === undefined) return
        if (Date.parse(silo.nextWakeAt) - this.#wakeMarginMs > now) return
        // Woken early by the margin and kept awake at least `idleMs` by the touch in `ensureAwake`,
        // so the schedule fires inside a running process — the path measured to fire exactly once.
        await this.ensureAwake(silo)
    }

    async #requireIdle(silo: Silo): Promise<SiloActivity> {
        const activity = await this.activity(silo)
        if (!activity.idle || (this.#open.get(silo.subject) ?? 0) > 0) {
            throw new ControlError({
                code: "silo_busy",
                message: `Silo "${silo.subject}" has a turn running, a delivery owed, or a request open.`,
                hint: "Nothing was done. Retry when it is idle — GET /v1/silos/<subject> shows when it was last active.",
                status: 409,
            })
        }
        return activity
    }

    async #suspend(silo: Silo, activity: SiloActivity): Promise<void> {
        await this.#placer.pause(silo.name)
        this.store.setStatus(silo.subject, "paused", activity.nextWakeAt)
        this.#log(
            `paused ${silo.subject}${activity.nextWakeAt === undefined ? "" : ` until ${activity.nextWakeAt}`}`,
        )
    }

    async #ready(baseUrl: string, subject: string): Promise<void> {
        // Real time, not the injected clock: this is a wait on a process, not a schedule decision.
        const deadline = Date.now() + this.#readyTimeoutMs
        while (Date.now() < deadline) {
            try {
                const response = await this.#fetch(`${baseUrl}/v1/ready`)
                if (response.ok) return
            } catch {
                // Not listening yet.
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new ControlError({
            code: "silo_not_ready",
            message: `Silo "${subject}" did not become ready within ${this.#readyTimeoutMs} ms.`,
            hint: "Nothing was kept: the container was removed. Run the image by hand (`docker run --rm <image>`) to see why it does not start — usually the image cannot be pulled or the host is out of memory.",
            status: 502,
        })
    }

    #find(subject: string): Silo {
        checkSubject(subject)
        const silo = this.store.get(subject)
        if (silo === undefined) {
            throw new ControlError({
                code: "silo_not_found",
                message: `No silo for "${subject}".`,
                hint: "Create it with POST /v1/silos {subject}. Subjects are case-sensitive.",
                status: 404,
            })
        }
        return silo
    }

    #must(subject: string): Silo {
        const silo = this.store.get(subject)
        if (silo === undefined) {
            throw new Error(
                `Silo "${subject}" vanished mid-operation. hint: it was deleted by a concurrent request; retry.`,
            )
        }
        return silo
    }

    #iso(): string {
        return new Date(this.#now()).toISOString()
    }
}
