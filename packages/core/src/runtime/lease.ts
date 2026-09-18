/**
 * Who is allowed to serve an agent, decided at boot.
 *
 * ## The failure this exists to prevent
 *
 * Telegram allows exactly one `getUpdates` poller per bot token. The poll loop is specified never
 * to exit on its own — it catches everything, backs off, and reports every eighth failure — so a
 * 409 from a *second* poller is indistinguishable, by construction, from the outage that loop
 * exists to survive. Two processes both back off, both keep running forever, and each message
 * lands with whichever won that particular race. Webhook mode does not even produce a 409:
 * `setWebhook` silently moves the hook to the last caller. The transport cannot detect the
 * collision, so something above it has to.
 *
 * The second failure is quieter and was live in this codebase: `turns.reapRunning` and
 * `outbox.recoverInflight` were unfiltered, which is correct for one process on one database and
 * wrong the instant two share a file. A second boot marked the first process's *live* turn failed,
 * and flipped its in-flight delivery back to pending — making it re-send a Telegram message that
 * had already gone, flagged `uncertain`. Decision 8.9 built that flag to make a crash explicable;
 * firing it because someone started an unrelated agent makes it mean nothing.
 *
 * ## Liveness is decided here, not in the store
 *
 * The store records a pid and a heartbeat. Whether that pid is alive is an operating-system
 * question, and a store that answered it would be untestable without spawning processes. This
 * module probes and hands the store a verdict — `stealFrom`, naming the exact holder it believes
 * is dead, so a lease that changed hands between the probe and the claim is still refused rather
 * than stolen from a process that has only just legitimately started.
 *
 * ## Two known imperfections, both deliberate
 *
 * Pids are reused, so a dead lease whose number has been recycled reads as live. The cost is one
 * refusal a person can resolve, against the alternative of two pollers nobody notices.
 *
 * A wedged process — asleep laptop, stopped in a debugger — has a stale heartbeat and a live pid.
 * That is reported as held rather than taken over, because taking it over is exactly how the
 * double-poller gets created.
 */

import { HarnessError } from "../errors.ts"
import type { LeaseRecord, RuntimeMode, Store } from "../store/store.ts"

/**
 * How long a heartbeat may lag before the holder is a candidate for takeover.
 *
 * Generous on purpose. The penalty for waiting is a refusal the person can act on; the penalty for
 * being impatient is two live processes on one bot token.
 */
export const LEASE_STALE_MS = 90_000
export const LEASE_BEAT_MS = 30_000
/**
 * How many stale windows a live pid may go without a heartbeat before it is assumed recycled.
 *
 * A process that holds a lease writes to it every thirty seconds. One that has not in forty-five
 * minutes, while its pid still resolves, is far more likely to be an unrelated program that
 * inherited the number than the original holder — and refusing forever on that evidence would make
 * a lease unrecoverable with no way out but editing the database.
 */
export const LEASE_REUSE_FACTOR = 30

export interface LeaseOutcome {
    /** Agent ids this runtime holds, and may therefore recover rows for. */
    readonly owned: readonly string[]
    /** Leases taken from a process established to be dead, for reporting. */
    readonly tookOver: readonly LeaseRecord[]
    /** Held by someone else. Non-empty only when channels are off — otherwise this throws. */
    readonly declined: readonly LeaseRecord[]
}

export interface ClaimOptions {
    readonly store: Store
    readonly agentIds: readonly string[]
    readonly runtimeId: string
    readonly mode: RuntimeMode
    readonly now: number
    readonly pid?: number
    /**
     * Whether a conflict is fatal.
     *
     * True when this runtime is about to open a channel: a second poller is the failure the lease
     * exists to prevent, so it refuses rather than proceeding. False for a REPL or a one-shot,
     * where two sessions against one agent have always been allowed and breaking that would be a
     * regression for an interactive flow people use daily. A leaseless runtime simply recovers
     * nothing — the rows belong to whoever holds the lease.
     */
    readonly exclusive: boolean
    /** Injected for tests. Real implementation is `process.kill(pid, 0)`. */
    readonly isAlive?: (pid: number) => boolean
}

/**
 * Whether a process exists, without signalling it.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing — the same idiom
 * `tools-system` uses to forget dead backgrounded children. `EPERM` means the process exists and
 * belongs to somebody else, which for our purposes is alive.
 */
export function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export async function claimLeases(options: ClaimOptions): Promise<LeaseOutcome> {
    const alive = options.isAlive ?? processAlive
    const pid = options.pid ?? process.pid
    const nowIso = new Date(options.now).toISOString()

    const owned: string[] = []
    const tookOver: LeaseRecord[] = []
    const declined: LeaseRecord[] = []

    for (const agentId of options.agentIds) {
        const held = await options.store.leases.get(agentId)
        const dead = held !== undefined && held.runtimeId !== options.runtimeId && !live(held)

        const claim = await options.store.leases.claim({
            agentId,
            runtimeId: options.runtimeId,
            pid,
            mode: options.mode,
            now: nowIso,
            ...(dead && held !== undefined ? { stealFrom: held.runtimeId } : {}),
        })

        if (claim.ok) {
            owned.push(agentId)
            if (claim.tookOver !== undefined) tookOver.push(claim.tookOver)
            continue
        }
        declined.push(claim.held)
    }

    /**
     * **`exclusive` refuses the boot only when it has nothing left to serve.**
     *
     * This threw on the *first* conflict, which is right for one agent and wrong for several: a
     * host asked for five agents with one of them held elsewhere refused all five, so a single
     * stale-looking row took every other agent down with it. A lease exists to stop a second
     * poller on one bot token, and declining that one agent is the whole of what that requires.
     *
     * The single-agent behaviour is unchanged by construction: one agent declined means nothing
     * owned, which is still a refusal with the same error naming the same holder.
     */
    if (options.exclusive && owned.length === 0 && declined.length > 0) {
        const first = declined[0]
        if (first !== undefined) throw alreadyServing(first)
    }

    return { owned, tookOver, declined }

    function live(lease: LeaseRecord): boolean {
        // **The pid decides when it says "dead".** A store file is always local to the process
        // reading it, so the operating system is a better witness than a timestamp — and trusting
        // a fresh heartbeat first was wrong in a way that showed up immediately: a boot that fails
        // *after* claiming (a missing channel token, say) leaves a row whose heartbeat is seconds
        // old and whose process is gone. Every retry for the next ninety seconds was then refused,
        // naming a pid that no longer existed, at exactly the moment someone was fixing the fault.
        if (!alive(lease.pid)) return false

        // The pid is alive, which is usually the end of it. The heartbeat only settles the case it
        // cannot: a pid recycled by an unrelated program. Below the stale window that is a live
        // holder — including a wedged one, an asleep laptop or a debugger, where taking the lease
        // is precisely how two pollers end up on one bot token. Far past it, a still-live pid is
        // much more likely to be a reused number than a process that has not written a row in an
        // hour, so the lease becomes takeable rather than stuck forever.
        const beat = Date.parse(lease.heartbeatAt)
        if (!Number.isFinite(beat)) return true
        return options.now - beat < LEASE_STALE_MS * LEASE_REUSE_FACTOR
    }
}

function alreadyServing(held: LeaseRecord): HarnessError {
    const where =
        held.mode === "daemon"
            ? "as a background service"
            : held.mode === "terminal"
              ? "in a terminal"
              : "by an embedding process"
    return new HarnessError({
        code: "agent_already_serving",
        message: `Agent "${held.agentId}" is already being served by pid ${held.pid} ${where}, since ${held.startedAt}.`,
        hint: `Two processes serving one agent is not a slow failure, it is a silent one: a messaging channel allows a single listener per token, and a second one produces conflicts that look exactly like the provider being down — so neither instance receives reliably and nothing reports it. Stop the other one first, or point this one at a different agent. If pid ${held.pid} is not actually running, its lease is released automatically once its heartbeat is ${Math.round(LEASE_STALE_MS / 1000)}s stale.`,
    })
}
