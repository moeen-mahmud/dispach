/**
 * The person who owns the agents on this machine (decisions 15.7, 15.14).
 *
 * Participants are the embedder's (14.2), and a self-hosted install has no embedder, so `init` mints
 * one: `me:` plus six base-32 symbols. Not bare `me` — two people in one team silo would both be
 * `me`. Stored beside the host token, under the agents directory, for the reason that file is there:
 * it is the path a test redirects, and a dotfile `listAgents` never mistakes for an agent.
 */

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BRAND, HarnessError, keySymbols, manifestValueAt, type Store } from "@dispach/core"

export function ownerPath(agentsBase: string): string {
    return join(agentsBase, ".owner")
}

/** The sandbox's owner id, minted and written the first time anything asks. */
export function sandboxOwner(
    agentsBase: string,
    random: (size: number) => Uint8Array = randomBytes,
): string {
    try {
        const id = readFileSync(ownerPath(agentsBase), "utf8").trim()
        if (id !== "") return id
    } catch {
        // None yet: minted below.
    }
    const id = `me:${keySymbols(random(6))}`
    mkdirSync(agentsBase, { recursive: true })
    writeFileSync(ownerPath(agentsBase), `${id}\n`, { encoding: "utf8", mode: 0o600 })
    return id
}

/**
 * The owner's own channel senders, from each channel's `allowFrom`, as `<type>:<entry>`.
 *
 * `*` is skipped: it lets anybody in and must never make anybody the owner. A colleague listed in
 * `allowFrom` by handle does become one, which is why `owner adopt` prints the list it wrote. A group
 * does not: a channel turn carries the person who wrote, never the group, as its sender.
 */
export function ownerChannelIds(
    channels: readonly { readonly type: string; readonly allowFrom?: readonly string[] }[],
): string[] {
    return channels.flatMap((channel) =>
        (channel.allowFrom ?? [])
            .filter((entry) => entry !== "*")
            .map((entry) => `${channel.type}:${entry}`),
    )
}

/**
 * Register the owner once, and make them this agent's owner. Channel senders already on the
 * assignment are kept: a person who added one by hand should not lose it to a later `init`.
 *
 * Refuses an agent somebody else owns rather than taking it over: an embedder's member agent
 * reassigned from a terminal would start answering the wrong person as its owner.
 */
export async function claimAgent(
    store: Store,
    input: {
        readonly agentId: string
        readonly owner: string
        readonly channelIds: readonly string[]
        readonly now?: Date
    },
): Promise<{ readonly channelIds: readonly string[] }> {
    const conversations = store.conversations
    const at = (input.now ?? new Date()).toISOString()
    const existing = await conversations.assignment(input.agentId)
    if (existing !== undefined && existing.participantId !== input.owner) {
        throw new HarnessError({
            code: "owner_assigned_elsewhere",
            message: `Agent "${input.agentId}" is assigned to ${existing.participantId}, not to ${input.owner}.`,
            hint: `Somebody else is this agent's owner, and taking it over would make it answer the wrong person as its owner. If it really is yours, unassign it first (DELETE /v1/agents/${input.agentId}/assignee) and run \`${BRAND.slug} owner adopt ${input.agentId}\` again.`,
        })
    }
    if ((await conversations.participant(input.owner)) === undefined) {
        await conversations.upsertParticipant({
            id: input.owner,
            kind: "human",
            role: "admin",
            createdAt: at,
        })
    }
    const channelIds = [...new Set([...(existing?.channelIds ?? []), ...input.channelIds])]
    await conversations.assign({
        agentId: input.agentId,
        participantId: input.owner,
        ...(channelIds.length === 0 ? {} : { channelIds }),
        assignedAt: at,
    })
    return { channelIds }
}

/**
 * Claim the agent a manifest describes for the sandbox owner, reading its id and channels from the
 * file — the one derivation `init` and `owner adopt` share, so the two cannot disagree about whose
 * senders count.
 */
export async function claimManifest(
    store: Store,
    manifestPath: string,
    agentsBase: string,
): Promise<{
    readonly agentId: string
    readonly owner: string
    readonly channelIds: readonly string[]
}> {
    const source = readFileSync(manifestPath, "utf8")
    const agentId = String(manifestValueAt(source, ["id"]) ?? "")
    const channels = manifestValueAt(source, ["channels"])
    const owner = sandboxOwner(agentsBase)
    const { channelIds } = await claimAgent(store, {
        agentId,
        owner,
        channelIds: ownerChannelIds(
            Array.isArray(channels)
                ? (channels as { type: string; allowFrom?: string[] }[]).filter(
                      (channel) => typeof channel?.type === "string",
                  )
                : [],
        ),
    })
    return { agentId, owner, channelIds }
}
