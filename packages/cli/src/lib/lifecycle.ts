/**
 * Reaching a running host, and reading the durable on/off switch.
 *
 * Shared by `serve`, `stop` and `start`, because all three ask the same two questions and a second
 * answer to either is a disagreement waiting to happen: *which agents is this sandbox supposed to
 * run*, and *where is the process already running them*.
 *
 * **Why an HTTP request rather than a signal.** Since one process hosts several agents, stopping
 * one by signalling the lease holder takes every other agent in that process down with it. A signal
 * also cannot name an agent. So `stop` posts to the host, which disposes exactly one — and the
 * address comes off the lease row rather than from a manifest, because `--port` overrides the file,
 * `--port 0` picks one at random and a container republishes it. Guessing 7420 is how a second host
 * on 7421 becomes invisible to the one command that must never miss it.
 *
 * **The fallback is the old behaviour, not an error.** A lease with no address is a `run` REPL or an
 * embedded runtime — real states, serving no HTTP — and those are still stopped by signalling the
 * process, which is what `stop` did for every lease before any of this existed.
 */

import { dirname } from "node:path"
import {
    BRAND,
    type LeaseRecord,
    loadManifest,
    processAlive,
    readManifestHeader,
    SqliteStore,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { listAgents, storePath } from "#lib/sandbox"

/** An agent the sandbox holds, with the durable switch resolved. */
export interface HostableAgent {
    readonly agentId: string
    readonly manifestPath: string
    readonly enabled: boolean
    /** Why it was switched off, when somebody said. */
    readonly reason?: string
}

/**
 * The manifests a bare `serve` should host, and the ones it should not.
 *
 * A listing rather than a filter, because the caller has to *report* what it is skipping: an agent
 * missing from a banner with no line explaining it is the "I set this up and it is not running"
 * failure the switch exists to make explicable.
 *
 * Broken entries are dropped here rather than surfaced, and that is the one thing this hides: a
 * directory whose header will not parse has no id, so there is nothing to look the state up by and
 * nothing to serve. the agents listing is what shows those, and it shows them already.
 */
export async function hostableAgents(
    paths: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    store?: string,
): Promise<readonly HostableAgent[]> {
    const found: { agentId: string; manifestPath: string }[] = []

    if (paths.length === 0) {
        // The bare form: whatever the sandbox holds. This is what the service unit runs, and it is
        // why `agent_state` exists — "every agent here" needs an answer to "except which".
        for (const agent of listAgents(env)) {
            if (agent.problem !== undefined || agent.id === undefined) continue
            found.push({ agentId: agent.id, manifestPath: agent.manifestPath })
        }
    } else {
        for (const manifestPath of paths) {
            // The header, not a full load: reading a manifest to learn its id must not depend on
            // the agent's credentials being present, which is the whole reason
            // `readManifestHeader` exists and why the picker is built on it.
            const header = readManifestHeader(manifestPath)
            found.push({ agentId: header.id ?? "", manifestPath })
        }
    }

    const disabled = await withStore(
        async (db) =>
            new Map(
                (await db.agentState.list())
                    .filter((row) => !row.enabled)
                    .map((row) => [row.agentId, row.reason]),
            ),
        store,
    )

    return found.map((entry) => {
        const reason = disabled?.get(entry.agentId)
        const off = disabled?.has(entry.agentId) === true
        return {
            ...entry,
            enabled: !off,
            ...(reason === undefined ? {} : { reason }),
        }
    })
}

/**
 * Open the store, ask one question, close it.
 *
 * Deliberately a second, short-lived connection rather than the one `Runtime.create` opens: the
 * answer is needed *before* the runtime exists, because it decides which agents the runtime is
 * asked for. Handing the runtime a caller-owned store would work and would move shutdown ownership
 * into the command, which is a larger change than one sequential read deserves — the migrations are
 * already applied, so this costs a couple of milliseconds.
 *
 * `undefined` on any failure, and the callers treat that as "nothing is disabled". A missing store
 * is the ordinary first-run state, and a `serve` that refused to start because it could not read an
 * on/off table would be a worse failure than the one it was guarding against.
 *
 * **The path is threaded rather than defaulted at each call site**, because `serve` honours
 * `--store` and these helpers did not — so a host serving out of one database would have read its
 * on/off switch from another. Invisible in normal use, where both resolve to the sandbox, and
 * wrong in exactly the configuration the tests use.
 */
async function withStore<T>(
    work: (store: SqliteStore) => Promise<T>,
    path?: string,
): Promise<T | undefined> {
    let store: SqliteStore | undefined
    try {
        store = await SqliteStore.open({ path: path ?? storePath() })
        return await work(store)
    } catch {
        return undefined
    } finally {
        await store?.close()
    }
}

/** The durable switch, written from a command rather than through a host. */
export async function writeAgentState(
    agentId: string,
    enabled: boolean,
    reason?: string,
    store?: string,
): Promise<void> {
    await withStore(async (db) => {
        if (enabled) await db.agentState.enable(agentId)
        else
            await db.agentState.disable(
                agentId,
                new Date().toISOString(),
                reason === undefined ? undefined : reason,
            )
    }, store)
}

/** Whether this agent is switched off, and why. */
export async function agentStateOf(
    agentId: string,
    store?: string,
): Promise<{ enabled: boolean; reason?: string } | undefined> {
    return await withStore(async (db) => {
        const row = await db.agentState.get(agentId)
        if (row === undefined) return { enabled: true }
        return { enabled: row.enabled, ...(row.reason === undefined ? {} : { reason: row.reason }) }
    }, store)
}

/**
 * The live process serving this agent, if there is one.
 *
 * Liveness is re-checked here rather than trusted from the row, for the recorded reason: a boot
 * that fails *after* claiming leaves a lease seconds old with no process under it, and anything
 * reading a lease to decide what to do has to probe rather than believe the heartbeat.
 */
export async function liveHostOf(
    agentId: string,
    store?: string,
): Promise<LeaseRecord | undefined> {
    return await withStore(async (db) => {
        const lease = await db.leases.get(agentId)
        if (lease === undefined) return undefined
        if (lease.pid === process.pid || !processAlive(lease.pid)) return undefined
        return lease
    }, store)
}

/**
 * Any live host with an HTTP address, for `start`.
 *
 * **Not `liveHostOf(agentId)`, and that is the whole reason this exists.** A stopped agent has no
 * lease — `dispose` released it — so looking for "the host holding this agent" finds nothing and
 * `start` would report that nothing was running while a host sat there ready to adopt it. Found by
 * running the pair in order rather than by reading either one.
 *
 * With several hosts this asks the first by agent id. Nondeterministic and harmless: any host can
 * serve any agent in the sandbox, and one that cannot look the manifest up answers `501` rather
 * than failing quietly.
 */
export async function anyLiveHost(store?: string): Promise<LeaseRecord | undefined> {
    const hosts = (await liveHosts(store)).filter((lease) => lease.baseUrl !== undefined)
    return [...hosts].sort((a, b) => a.agentId.localeCompare(b.agentId))[0]
}

/** Every live lease, for the commands that report on the whole sandbox. */
export async function liveHosts(store?: string): Promise<readonly LeaseRecord[]> {
    return (
        (await withStore(
            async (db) =>
                (
                    await db.leases.all()
                ).filter((lease) => lease.pid !== process.pid && processAlive(lease.pid)),
            store,
        )) ?? []
    )
}

/**
 * The credential a running host will want, best effort.
 *
 * The manifest's live env is the authority — that is where `serve` itself read the token from — so
 * this loads it. When the load fails it falls back to the process environment under the brand's
 * default variable, because the common reason for a failed load is a missing *model* key and
 * refusing to stop an agent over that would be absurd. A wrong or absent token is not silent: the
 * request comes back `401` and the caller says which variable to set.
 */
/**
 * The agent id a manifest declares, without loading it.
 *
 * `readManifestHeader` rather than `loadManifest` for the reason `lib/sandbox.ts` already records:
 * loading checks that the key variables are set, so a *lookup* built on it fails exactly when the
 * agent is misconfigured — which is when you most need to name it. Here that would mean `run` and
 * `web` refusing to find a host for an agent whose `.env` is incomplete.
 */
export function agentIdFor(manifestPath: string | undefined): string {
    return manifestPath === undefined || manifestPath === ""
        ? ""
        : (readManifestHeader(manifestPath).id ?? "")
}

export function hostToken(manifestPath: string): string | undefined {
    const fallback = process.env[`${BRAND.envPrefix}API_TOKEN`]
    try {
        const loaded = loadManifest(manifestPath, { env: ambientEnv([manifestPath]) })
        const configured = loaded.env[loaded.manifest.server.tokenEnv]
        return configured === undefined || configured === "" ? fallback : configured
    } catch {
        return fallback === "" ? undefined : fallback
    }
}

export interface HostReply {
    readonly ok: boolean
    readonly status: number
    /** The server's own `error.message`, when it sent one. */
    readonly detail?: string
    /**
     * The parsed success body, for the callers that need one.
     *
     * `stop` and `start` only ever asked whether it worked, so this was discarded. Minting a
     * credential is the first caller that needs what came back — the secret is printed **once** and
     * exists nowhere else, so throwing the body away would make the command useless.
     */
    readonly body?: unknown
    /** The server's `error.hint`, which is the half a person acts on. */
    readonly hint?: string
}

/**
 * POST to a running host, with a bounded wait.
 *
 * Bounded because the alternative is a stop command that hangs on a wedged host, and the whole
 * brief for `stop` is that a person reaching for it is not in a position to go investigating. A
 * timeout falls through to the process-level stop, which is the thing that works on a host that has
 * stopped answering.
 */
export async function postToHost(
    lease: LeaseRecord,
    path: string,
    body: Readonly<Record<string, unknown>>,
    manifestPath?: string,
): Promise<HostReply> {
    const base = lease.baseUrl
    if (base === undefined) return { ok: false, status: 0, detail: "this host serves no HTTP" }
    const token = manifestPath === undefined ? undefined : hostToken(manifestPath)

    try {
        const response = await fetch(`${base}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        })
        if (response.ok) {
            const body: unknown = await response.json().catch(() => undefined)
            return {
                ok: true,
                status: response.status,
                ...(body === undefined ? {} : { body }),
            }
        }
        const parsed = (await response.json().catch(() => undefined)) as
            | { error?: { message?: string; hint?: string } }
            | undefined
        return {
            ok: false,
            status: response.status,
            ...(parsed?.error?.message === undefined ? {} : { detail: parsed.error.message }),
            ...(parsed?.error?.hint === undefined ? {} : { hint: parsed.error.hint }),
        }
    } catch (error) {
        return {
            ok: false,
            status: 0,
            detail: error instanceof Error ? error.message : String(error),
        }
    }
}

/**
 * Any method against a running host, with the same bound and the same error shape.
 *
 * `postToHost` is this with `POST` and a body; both exist because a `GET` with a `content-type` and
 * an empty body is a request some proxies mangle, and because the one-method version read better at
 * the four call sites that had it. This is what `credential list` and `credential revoke` need.
 */
export async function callHost(
    lease: LeaseRecord,
    method: string,
    path: string,
    manifestPath?: string,
): Promise<HostReply> {
    const base = lease.baseUrl
    if (base === undefined) return { ok: false, status: 0, detail: "this host serves no HTTP" }
    const token = manifestPath === undefined ? undefined : hostToken(manifestPath)
    try {
        const response = await fetch(`${base}${path}`, {
            method,
            headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
        })
        const body: unknown = await response.json().catch(() => undefined)
        if (response.ok) {
            return { ok: true, status: response.status, ...(body === undefined ? {} : { body }) }
        }
        const parsed = body as { error?: { message?: string; hint?: string } } | undefined
        return {
            ok: false,
            status: response.status,
            ...(parsed?.error?.message === undefined ? {} : { detail: parsed.error.message }),
            ...(parsed?.error?.hint === undefined ? {} : { hint: parsed.error.hint }),
        }
    } catch (error) {
        return {
            ok: false,
            status: 0,
            detail: error instanceof Error ? error.message : String(error),
        }
    }
}

/** Long enough for a dispose that waits on a channel to stop, short enough not to read as a hang. */
const HOST_TIMEOUT_MS = 10_000

/** The sandbox manifest declaring this id, for the host's `resolveAgent` lookup. */
export function manifestForId(
    agentId: string,
    env?: Readonly<Record<string, string | undefined>>,
): string | undefined {
    for (const agent of listAgents(env)) {
        if (agent.id === agentId) return agent.manifestPath
    }
    return undefined
}

/** The directory an agent's manifest sits in, for messages that name a `.env`. */
export function agentDirOf(manifestPath: string): string {
    return dirname(manifestPath)
}
