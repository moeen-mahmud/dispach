/**
 * Asking agents in another silo through the control plane (decision 15.10,
 * `docs/24-SPEC-PEER-ASK.md`). Core declares the shape; the implementation lives in the CLI and is
 * handed in through `RuntimeOptions.relay`, because core imports nothing that talks to a network
 * service it does not own.
 */

import type { ErrorDetail } from "../errors.ts"
import type { AgentManifest } from "../manifest/schema.ts"

/** An agent in one of the person's other silos, as the control plane lists it. */
export interface RemotePeer {
    readonly silo: string
    readonly agent: string
    readonly name?: string
    readonly description?: string
    /** Assigned to nobody in its silo. */
    readonly shared: boolean
}

export interface RelayClient {
    /**
     * The list saved by the last refresh, read from disk. No network: it is called while an agent is
     * built, before `runtime.ready` (hard rule 4).
     */
    cachedPeers(agentId: string): readonly RemotePeer[]
    /** Ask the control plane again and save the answer. After readiness only. */
    refreshPeers(agentId: string, participantId: string): Promise<readonly RemotePeer[]>
    ask(request: {
        readonly fromAgent: string
        readonly participantId: string
        readonly silo: string
        readonly agent: string
        readonly question: string
        readonly sessionKey: string
        readonly signal?: AbortSignal
    }): Promise<{
        readonly text: string
        readonly reason: string
        readonly steps: number
        readonly tokens: { readonly prompt: number; readonly output: number }
        readonly error?: ErrorDetail
    }>
}

/** What decides an agent's peer list: enough to know whether a change needs a reload. */
export interface AskPeerInfo {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly shared: boolean
    readonly remote: boolean
}

/** One agent as its siblings see it. */
export interface AskCandidate {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly ask: boolean
    /** The participant it is assigned to; absent is a shared agent. */
    readonly owner?: string
}

/**
 * Whom `manifest` may ask: agents in the silo that declare `delegation.ask` and are assigned to the
 * same person or to nobody, then the person's agents in other silos. Empty unless this agent declares
 * `delegation.ask` and has an owner — a shared agent has nobody to act for, so it is asked and never
 * asks. Pure, so the runtime can recompute it to decide whether a change needs a reload.
 */
export function askPeersOf(input: {
    readonly manifest: Pick<AgentManifest, "id" | "delegation">
    readonly owner: string | undefined
    readonly candidates: readonly AskCandidate[]
    readonly remote: readonly RemotePeer[]
}): readonly AskPeerInfo[] {
    if (input.manifest.delegation?.ask !== true || input.owner === undefined) return []
    const local = input.candidates
        .filter(
            (peer) =>
                peer.id !== input.manifest.id &&
                peer.ask &&
                (peer.owner === undefined || peer.owner === input.owner),
        )
        .map((peer) => ({
            id: peer.id,
            // A name equal to the id says nothing twice ("board (board)").
            ...(peer.name === undefined || peer.name === peer.id ? {} : { name: peer.name }),
            ...(peer.description === undefined ? {} : { description: peer.description }),
            shared: peer.owner === undefined,
            remote: false,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    const remote = input.remote
        .map((peer) => ({
            id: `${peer.silo}/${peer.agent}`,
            ...(peer.name === undefined ? {} : { name: peer.name }),
            ...(peer.description === undefined ? {} : { description: peer.description }),
            shared: peer.shared,
            remote: true,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    return [...local, ...remote]
}

/** Equal exactly when two peer lists render the same `ask_agent` description. */
export function askPeerSignature(peers: readonly AskPeerInfo[]): string {
    return JSON.stringify(peers)
}
