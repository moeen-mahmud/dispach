/**
 * Who a turn's sender is, among the people this runtime knows (decision 15.7).
 *
 * Three call sites compared ids as strings — the personal-tools fence, the owner-scope audit and
 * `memory_forget`'s reach — and a channel turn never matched any of them: Telegram stamps
 * `telegram:<numeric id>` while the person wrote `@handle` into `allowFrom`, and WhatsApp a JID
 * while they wrote `+880 …`. So a `channelIds` entry is matched the way `allowFrom` is, against the
 * sender's id *and* the handle the channel saw, with `allowFrom`'s normalisation. Same trust
 * boundary, and still closed: no `channelIds`, no channel sender is anybody.
 */

import { normaliseSender } from "../channels/inbox.ts"
import type { ActingParticipant } from "../loop/sender.ts"

/** The part of an assignment or a participant this module reads. */
export interface ChannelIdentity {
    /** `<channel type>:<id or handle>`, as an embedder or `init` wrote it. */
    readonly channelIds?: readonly string[]
}

/** Whether `participant` is the person `assignment` names. A stand-in never is: it acts for someone else. */
export function isOwner(
    assignment: ChannelIdentity & { readonly participantId: string },
    participant: ActingParticipant,
): boolean {
    if (participant.onBehalfOf !== undefined) return false
    if (participant.id === assignment.participantId) return true
    return matchesChannelIds(assignment.channelIds, participant)
}

/**
 * The registered participant a sender is, for `sessions.scope: peer`: by id, or by one of the
 * participant's own `channelIds`. `undefined` for a stranger.
 */
export function resolveParticipant(
    participants: readonly (ChannelIdentity & { readonly id: string })[],
    participant: ActingParticipant,
): string | undefined {
    if (participant.onBehalfOf !== undefined) return undefined
    if (participants.some((known) => known.id === participant.id)) return participant.id
    return participants.find((known) => matchesChannelIds(known.channelIds, participant))?.id
}

function matchesChannelIds(
    channelIds: readonly string[] | undefined,
    participant: ActingParticipant,
): boolean {
    if (channelIds === undefined || channelIds.length === 0) return false
    // The exact form an embedder has written since pilot.15 (`whatsapp:8801…`), whatever the surface.
    if (channelIds.includes(participant.id)) return true
    if (participant.via !== "channel") return false
    const colon = participant.id.indexOf(":")
    if (colon === -1) return false
    const type = participant.id.slice(0, colon)
    const seen = new Set(
        [participant.id.slice(colon + 1), ...(participant.handles ?? [])].map(normaliseSender),
    )
    return channelIds.some((entry) => {
        const at = entry.indexOf(":")
        if (at === -1 || entry.slice(0, at) !== type) return false
        const value = entry.slice(at + 1)
        // `*` lets anybody in through `allowFrom`; it never makes anybody the owner.
        return value !== "*" && seen.has(normaliseSender(value))
    })
}
