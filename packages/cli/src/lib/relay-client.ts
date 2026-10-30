/**
 * The runtime's side of the control plane's peer-ask relay (decision 15.10,
 * `docs/24-SPEC-PEER-ASK.md`). Built by `serve` only when the control plane put a relay URL and token
 * in this silo's environment; a self-hosted install has neither, and nothing about it changes.
 *
 * The peer list is cached in one file beside the store, keyed by agent id, because an agent is built
 * before readiness and may not touch the network then (hard rule 4): it boots from the saved list and
 * the runtime refreshes it afterwards.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import type { RelayClient, RemotePeer } from "@dispach/core"

type Cache = Record<string, readonly RemotePeer[]>

function readCache(file: string): Cache {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Cache)
            : {}
    } catch {
        // Missing on a first boot, and a broken file is a list to fetch again: either way, no peers
        // until the refresh after readiness.
        return {}
    }
}

/** The control plane's refusal, said as an error a person can act on. */
async function refusal(response: Response, what: string): Promise<Error> {
    const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; hint?: string }
    }
    const detail = body.error
    return new Error(
        detail?.message === undefined
            ? `the control plane answered ${response.status} to ${what}`
            : `${detail.message}${detail.hint === undefined ? "" : ` ${detail.hint}`}`,
    )
}

export function relayClient(init: {
    readonly url: string
    readonly token: string
    readonly cacheFile: string
    readonly fetch?: typeof fetch
}): RelayClient {
    const doFetch = init.fetch ?? globalThis.fetch
    const base = init.url.replace(/\/+$/, "")
    const headers = { authorization: `Bearer ${init.token}` }
    const cache = readCache(init.cacheFile)

    return {
        cachedPeers: (agentId) => cache[agentId] ?? [],

        async refreshPeers(agentId, participantId) {
            const response = await doFetch(
                `${base}/v1/relay/peers?participant=${encodeURIComponent(participantId)}`,
                { headers },
            )
            if (!response.ok) throw await refusal(response, "the peer list")
            const { peers } = (await response.json()) as { peers: readonly RemotePeer[] }
            cache[agentId] = peers
            // Written whole and renamed into place, so a crash mid-write leaves the previous list.
            const partial = `${init.cacheFile}.partial`
            writeFileSync(partial, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
            renameSync(partial, init.cacheFile)
            return peers
        },

        async ask(request) {
            const response = await doFetch(`${base}/v1/relay/ask`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({
                    participant: request.participantId,
                    toSilo: request.silo,
                    toAgent: request.agent,
                    question: request.question,
                    askedBy: request.fromAgent,
                    sessionKey: request.sessionKey,
                }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
            })
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as {
                    error?: { code: string; message: string; hint: string }
                }
                return {
                    text: "",
                    reason: "error",
                    steps: 0,
                    tokens: { prompt: 0, output: 0 },
                    error: body.error ?? {
                        code: "relay_unavailable",
                        message: `The control plane answered ${response.status}.`,
                        hint: "Check the control plane is reachable from this silo.",
                    },
                }
            }
            return (await response.json()) as Awaited<ReturnType<RelayClient["ask"]>>
        },
    }
}
