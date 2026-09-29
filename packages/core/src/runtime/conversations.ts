/**
 * Rooms and DMs: more than one human and more than one agent in a conversation (Phase 27).
 *
 * **One log, a session per agent.** A message is written once to the conversation's log — the room as
 * the embedder shows it — and reaches each member agent through that agent's own `room:<id>`
 * session: as a turn when the message addresses it, as a history entry when it does not. So an
 * agent mentioned later has read the room, and the history, compaction and memory it already has
 * apply with nothing new (decision 14.31).
 *
 * **Addressed means structurally addressed.** In a room an agent takes a turn only when a message's
 * `mentions` name it; in a DM a human's message always addresses the agent. A human's mentions come
 * from the embedder's own UI; an agent's are read off its reply as `@<id>` tokens that name members.
 *
 * **The loop guard is a hop count, never a name.** A human's message is hop 0 and each agent reply is
 * one more than the message it answered. An agent's message addresses another agent only while its
 * hop is under that agent's `limits.maxHops`; past it the agent reads the message and does not
 * answer, and `conversation.skipped` says why. Two agents of the same kind in one room is exactly
 * what a check on names would miss.
 *
 * **Room text is untrusted to every agent that reads it** — the sender carries `room`, and
 * `trustOfSender` decides the rest. Serialised per agent and conversation, like a channel's queue,
 * so an observation and a turn in one session never race each other through its history.
 */

import { randomUUID } from "node:crypto"
import { GovernorError, HarnessError } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { TurnSender } from "../loop/sender.ts"
import type {
    AssignmentRecord,
    ConversationKind,
    ConversationMessageRecord,
    ConversationRecord,
    ConversationStore,
    ParticipantRecord,
} from "../store/store.ts"
import type { Agent } from "./agent.ts"

export const AGENT_PARTICIPANT = "agent:"

/** The participant id of an agent. */
export function agentParticipant(agentId: string): string {
    return `${AGENT_PARTICIPANT}${agentId}`
}

/** The agent an id names, or undefined for a human. */
export function agentOf(participantId: string): string | undefined {
    return participantId.startsWith(AGENT_PARTICIPANT)
        ? participantId.slice(AGENT_PARTICIPANT.length)
        : undefined
}

/** The session an agent keeps a conversation in. */
export function roomSessionKey(conversationId: string): string {
    return `room:${conversationId}`
}

/**
 * The members an agent's reply mentions: `@id` tokens naming a member, as written or with the agent
 * prefix (`@crew` for `agent:crew`). The author is never among them.
 */
export function mentionsIn(text: string, members: readonly string[], author: string): string[] {
    const found = new Set<string>()
    for (const match of text.matchAll(/@([A-Za-z0-9_.:-]+)/g)) {
        const token = (match[1] ?? "").replace(/[.:,-]+$/, "")
        const id = members.includes(token)
            ? token
            : members.includes(agentParticipant(token))
              ? agentParticipant(token)
              : undefined
        if (id !== undefined && id !== author) found.add(id)
    }
    return [...found]
}

function refused(code: string, message: string, hint: string, field?: string): HarnessError {
    return new HarnessError({ code, message, hint, ...(field === undefined ? {} : { field }) })
}

export interface ConversationHubOptions {
    readonly store: ConversationStore
    readonly bus: EventBus
    /** The agent a runtime hosts under this id, or undefined. Read lazily: agents come and go. */
    readonly agent: (id: string) => Agent | undefined
    readonly now?: () => Date
}

export class ConversationHub {
    readonly #store: ConversationStore
    readonly #bus: EventBus
    readonly #agent: (id: string) => Agent | undefined
    readonly #now: () => Date
    readonly #queues = new Map<string, Promise<void>>()

    constructor(options: ConversationHubOptions) {
        this.#store = options.store
        this.#bus = options.bus
        this.#agent = options.agent
        this.#now = options.now ?? (() => new Date())
    }

    get store(): ConversationStore {
        return this.#store
    }

    async registerParticipant(input: {
        readonly id: string
        readonly name?: string
        readonly role?: "admin" | "member"
    }): Promise<ParticipantRecord> {
        if (agentOf(input.id) !== undefined) {
            throw refused(
                "participant_id_reserved",
                `"${input.id}" is an agent's participant id.`,
                "Agents are participants already, as agent:<agentId>; register only humans, under the id your own system knows them by.",
                "id",
            )
        }
        return this.#store.upsertParticipant({
            id: input.id,
            kind: "human",
            ...(input.name === undefined ? {} : { name: input.name }),
            role: input.role ?? "member",
            createdAt: this.#now().toISOString(),
        })
    }

    /** Every member must exist: a registered human, or an agent this runtime hosts. */
    async #checkMembers(members: readonly string[]): Promise<void> {
        for (const member of members) {
            const agentId = agentOf(member)
            const exists =
                agentId === undefined
                    ? (await this.#store.participant(member)) !== undefined
                    : this.#agent(agentId) !== undefined
            if (!exists) {
                throw refused(
                    "conversation_member_unknown",
                    `No participant "${member}".`,
                    agentId === undefined
                        ? "Register a human with POST /v1/participants first. Agents join as agent:<agentId>."
                        : "That agent is not hosted here. GET /v1/agents lists the ones that are.",
                    "members",
                )
            }
        }
    }

    async create(input: {
        readonly kind: ConversationKind
        readonly members: readonly string[]
        readonly title?: string
    }): Promise<ConversationRecord> {
        const members = [...new Set(input.members)]
        await this.#checkMembers(members)
        const agents = members.filter((member) => agentOf(member) !== undefined)
        const humans = members.length - agents.length
        if (input.kind === "dm" && (agents.length !== 1 || humans !== 1)) {
            throw refused(
                "conversation_dm_shape",
                `A dm is one human and one agent; this names ${humans} human(s) and ${agents.length} agent(s).`,
                'Use kind "room" for anything larger. In a room an agent answers only when mentioned.',
                "members",
            )
        }
        return this.#store.create({
            id: `cv_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
            kind: input.kind,
            ...(input.title === undefined ? {} : { title: input.title }),
            members,
            createdAt: this.#now().toISOString(),
        })
    }

    async setMembers(
        conversationId: string,
        add: readonly string[],
        remove: readonly string[],
    ): Promise<ConversationRecord> {
        const conversation = await this.#require(conversationId)
        if (conversation.kind === "dm") {
            throw refused(
                "conversation_dm_shape",
                "A dm's members are fixed.",
                "Create a room to bring in anybody else.",
                "members",
            )
        }
        await this.#checkMembers(add)
        return this.#store.setMembers(conversationId, add, remove)
    }

    async #require(conversationId: string): Promise<ConversationRecord> {
        const conversation = await this.#store.get(conversationId)
        if (conversation === undefined) {
            throw refused(
                "conversation_not_found",
                `No conversation "${conversationId}".`,
                "GET /v1/conversations lists the ones this credential can see.",
            )
        }
        return conversation
    }

    /**
     * A human's message: logged, announced, and handed to each member agent. Returns once logged;
     * the turns it starts run behind it, as a channel's do.
     */
    async post(input: {
        readonly conversationId: string
        readonly authorId: string
        readonly text: string
        readonly mentions?: readonly string[]
    }): Promise<ConversationMessageRecord> {
        const conversation = await this.#require(input.conversationId)
        if (
            !conversation.members.includes(input.authorId) ||
            agentOf(input.authorId) !== undefined
        ) {
            throw refused(
                "conversation_author_not_member",
                `${input.authorId} is not a human member of this conversation.`,
                "Only a member posts, and agents post by answering. Add the participant with PATCH /v1/conversations/:id/members.",
                "authorId",
            )
        }
        const mentions = [...new Set(input.mentions ?? [])]
        const outside = mentions.filter((id) => !conversation.members.includes(id))
        if (outside.length > 0) {
            throw refused(
                "conversation_mention_unknown",
                `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not in this conversation.`,
                "A mention names a member by participant id: agent:<agentId> for an agent.",
                "mentions",
            )
        }
        const message = await this.#append({
            conversationId: conversation.id,
            authorId: input.authorId,
            origin: "human",
            text: input.text,
            mentions,
            hop: 0,
        })
        this.#fanOut(conversation, message)
        return message
    }

    /** Resolves when every turn and observation queued for the conversation has run. */
    async settled(conversationId?: string): Promise<void> {
        for (;;) {
            const pending = [...this.#queues.entries()]
                .filter(
                    ([key]) => conversationId === undefined || key.endsWith(`␟${conversationId}`),
                )
                .map(([, work]) => work)
            if (pending.length === 0) return
            await Promise.allSettled(pending)
        }
    }

    async assign(input: {
        readonly agentId: string
        readonly participantId: string
        readonly assignedBy?: string
    }): Promise<AssignmentRecord> {
        if (this.#agent(input.agentId) === undefined) {
            throw refused(
                "agent_not_found",
                `No agent "${input.agentId}".`,
                "GET /v1/agents lists the ones hosted here.",
            )
        }
        if ((await this.#store.participant(input.participantId)) === undefined) {
            throw refused(
                "participant_not_found",
                `No participant "${input.participantId}".`,
                "An agent is assigned to a registered human. POST /v1/participants registers one.",
                "participantId",
            )
        }
        const record = await this.#store.assign({
            agentId: input.agentId,
            participantId: input.participantId,
            ...(input.assignedBy === undefined ? {} : { assignedBy: input.assignedBy }),
            assignedAt: this.#now().toISOString(),
        })
        this.#bus.emit(
            "agent.assigned",
            {
                participantId: record.participantId,
                ...(record.assignedBy === undefined ? {} : { assignedBy: record.assignedBy }),
            },
            { agentId: input.agentId },
        )
        return record
    }

    async #append(
        message: Omit<ConversationMessageRecord, "id" | "seq" | "createdAt">,
    ): Promise<ConversationMessageRecord> {
        const stored = await this.#store.append({
            ...message,
            id: `cm_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
            createdAt: this.#now().toISOString(),
        })
        const author = agentOf(stored.authorId)
        this.#bus.emit(
            "conversation.message",
            {
                conversationId: stored.conversationId,
                messageId: stored.id,
                authorId: stored.authorId,
                origin: stored.origin,
                text: stored.text,
                mentions: [...stored.mentions],
                hop: stored.hop,
                ...(stored.turnId === undefined ? {} : { turnId: stored.turnId }),
            },
            author === undefined ? {} : { agentId: author },
        )
        return stored
    }

    #fanOut(conversation: ConversationRecord, message: ConversationMessageRecord): void {
        for (const member of conversation.members) {
            const agentId = agentOf(member)
            if (agentId === undefined || member === message.authorId) continue
            const addressed =
                conversation.kind === "dm"
                    ? message.origin === "human"
                    : message.mentions.includes(member)
            this.#enqueue(agentId, conversation.id, () =>
                this.#deliver(agentId, conversation.id, message, addressed),
            )
        }
    }

    #enqueue(agentId: string, conversationId: string, work: () => Promise<void>): void {
        const key = `${agentId}␟${conversationId}`
        const next = (this.#queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
        this.#queues.set(key, next)
        void next
            .catch(() => {})
            .finally(() => {
                if (this.#queues.get(key) === next) this.#queues.delete(key)
            })
    }

    async #deliver(
        agentId: string,
        conversationId: string,
        message: ConversationMessageRecord,
        addressed: boolean,
    ): Promise<void> {
        const agent = this.#agent(agentId)
        if (agent === undefined) return
        const author = await this.#store.participant(message.authorId)
        const from: TurnSender = {
            id: message.authorId,
            kind: message.origin === "human" ? "user" : "agent",
            ...(author?.name === undefined ? {} : { name: author.name }),
            room: conversationId,
        }
        const sessionKey = roomSessionKey(conversationId)
        const skip = (reason: "hop_limit" | "refused" | "failed", detail: string) =>
            this.#bus.emit(
                "conversation.skipped",
                {
                    conversationId,
                    messageId: message.id,
                    reason,
                    detail,
                    hop: message.hop,
                    ceiling: agent.manifest.limits.maxHops,
                },
                { agentId, sessionKey },
            )

        const ceiling = agent.manifest.limits.maxHops
        if (addressed && message.origin === "agent" && message.hop >= ceiling) {
            skip(
                "hop_limit",
                `${message.authorId} addressed ${agentId} at hop ${message.hop}, and ${agentId}'s limits.maxHops is ${ceiling}. It read the message and did not answer; a human's next message starts again at hop 0.`,
            )
            addressed = false
        }
        if (!addressed) {
            await agent.observe(message.text, { sessionKey, from })
            return
        }

        let text: string
        let turnId: string
        try {
            const result = await agent.send(message.text, {
                sessionKey,
                source: `room:${conversationId}`,
                from,
                ...(message.origin === "human"
                    ? { participant: { id: message.authorId, via: "api" as const } }
                    : {}),
            })
            text = result.text.trim()
            turnId = result.turnId
        } catch (cause) {
            skip(
                cause instanceof GovernorError ? "refused" : "failed",
                cause instanceof Error ? cause.message : String(cause),
            )
            return
        }
        if (text === "") return
        const conversation = await this.#store.get(conversationId)
        if (conversation === undefined) return
        const self = agentParticipant(agentId)
        const reply = await this.#append({
            conversationId,
            authorId: self,
            origin: "agent",
            text,
            mentions: mentionsIn(text, conversation.members, self),
            hop: message.hop + 1,
            turnId,
        })
        this.#fanOut(conversation, reply)
    }
}
