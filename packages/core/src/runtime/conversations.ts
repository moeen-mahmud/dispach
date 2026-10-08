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
import { parseScope } from "../memory/scopes.ts"
import type {
    AssignmentRecord,
    ConversationKind,
    ConversationMessageRecord,
    ConversationRecord,
    ConversationStore,
    DeferredActionRecord,
    MemoryNoteRecord,
    MemoryReadRecord,
    ParticipantRecord,
    ProjectRecord,
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
        readonly title?: string
        readonly timezone?: string
    }): Promise<ParticipantRecord> {
        if (input.timezone !== undefined && !isTimeZone(input.timezone)) {
            throw refused(
                "participant_timezone_invalid",
                `"${input.timezone}" is not a timezone this runtime knows.`,
                'An IANA zone name, such as "Europe/London" or "Asia/Dhaka".',
                "timezone",
            )
        }
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
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
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
        const humans = members.filter((member) => agentOf(member) === undefined)
        if (input.kind === "dm") await this.#checkDmShape(humans, agents)
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

    /**
     * A dm is one human and their agent, or two people with their agents present (Phase 28): at
     * most one agent each, and each assigned to one of the two — the agent that stands in for them.
     */
    async #checkDmShape(humans: readonly string[], agents: readonly string[]): Promise<void> {
        const shape = (why: string) =>
            refused(
                "conversation_dm_shape",
                `${why} This names ${humans.length} human(s) and ${agents.length} agent(s).`,
                'A dm is one human and one agent, or two humans with the agents assigned to them (PUT /v1/agents/:id/assignee). Use kind "room" for anything else.',
                "members",
            )
        if (humans.length === 1 && agents.length === 1) return
        if (humans.length !== 2 || agents.length === 0 || agents.length > 2) {
            throw shape("That is not a dm.")
        }
        const owners = new Set<string>()
        for (const member of agents) {
            const owner = (await this.#store.assignment(agentOf(member) ?? ""))?.participantId
            if (owner === undefined || !humans.includes(owner) || owners.has(owner)) {
                throw shape(`${member} is not the one agent assigned to either person.`)
            }
            owners.add(owner)
        }
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
        readonly channelIds?: readonly string[]
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
            ...(input.channelIds === undefined ? {} : { channelIds: input.channelIds }),
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

    /**
     * Who may write a shared scope (Phase 29). `actorId` absent is the operator — an unbound key,
     * already admitted by its capability — who may write anything an admin may.
     *
     * - `owner:<X>`: only X. Not even an admin: another member's memory is theirs to edit (a non-goal).
     * - `space`: an admin, or the one designated space writer.
     * - `project:<id>`: an admin, into a project that exists.
     */
    async #mayWrite(scope: string, actorId: string | undefined): Promise<void> {
        const actor = actorId === undefined ? undefined : await this.#store.participant(actorId)
        if (actorId !== undefined && actor === undefined) {
            throw refused(
                "participant_not_found",
                `No participant "${actorId}".`,
                "POST /v1/participants registers one.",
            )
        }
        const admin = actorId === undefined || actor?.role === "admin"
        if (scope.startsWith("owner:")) {
            const owner = scope.slice("owner:".length)
            if ((await this.#store.participant(owner)) === undefined) {
                throw refused(
                    "participant_not_found",
                    `No participant "${owner}" for scope ${scope}.`,
                    "An owner scope belongs to a registered human. POST /v1/participants registers one.",
                    "scope",
                )
            }
            if (actorId !== undefined && actorId !== owner) {
                throw refused(
                    "memory_scope_forbidden",
                    `${actorId} may not write ${scope}.`,
                    "An owner scope is written only by its owner; an admin writes the space or a project instead.",
                    "scope",
                )
            }
            return
        }
        if (scope.startsWith("project:")) {
            const id = scope.slice("project:".length)
            if ((await this.#store.project(id)) === undefined) {
                throw refused(
                    "project_not_found",
                    `No project "${id}".`,
                    "PUT /v1/projects/:id creates one.",
                    "scope",
                )
            }
        }
        if (admin) return
        if (scope === "space" && (await this.#store.spaceWriter()) === actorId) return
        throw refused(
            "memory_scope_forbidden",
            `${actorId} may not write ${scope}.`,
            scope === "space"
                ? "The space is read-only except to admins and its designated writer (PUT /v1/memory/space/writer)."
                : "A project's memory is written by an admin.",
            "scope",
        )
    }

    #scope(value: string): string {
        const scope = parseScope(value)
        if (scope === undefined) {
            throw refused(
                "memory_scope_invalid",
                `"${value}" is not a memory scope.`,
                "A shared scope is `space`, `owner:<participantId>` or `project:<projectId>`. An agent's private memory is written by the agent itself.",
                "scope",
            )
        }
        return scope
    }

    async addNote(input: {
        readonly scope: string
        readonly text: string
        readonly authorId?: string
    }): Promise<MemoryNoteRecord> {
        const scope = this.#scope(input.scope)
        const text = input.text.trim()
        if (text === "") {
            throw refused(
                "memory_note_empty",
                "A note needs text.",
                "Send `text`: one or two sentences worth remembering.",
                "text",
            )
        }
        await this.#mayWrite(scope, input.authorId)
        return this.#store.addNote({
            id: `mn_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
            scope,
            text,
            writtenBy: input.authorId ?? "operator",
            createdAt: this.#now().toISOString(),
        })
    }

    /** Readable by whoever may write it, and by everyone for the space and projects. */
    async notes(scopeValue: string, actorId?: string): Promise<readonly MemoryNoteRecord[]> {
        const scope = this.#scope(scopeValue)
        if (scope.startsWith("owner:")) await this.#mayWrite(scope, actorId)
        return this.#store.notes(scope)
    }

    async deleteNote(id: string, actorId?: string): Promise<void> {
        const note = await this.#store.note(id)
        if (note === undefined) {
            throw refused(
                "memory_note_not_found",
                `No note "${id}".`,
                "GET /v1/memory/notes?scope=… lists a scope's notes.",
            )
        }
        await this.#mayWrite(note.scope, actorId)
        await this.#store.deleteNote(id)
    }

    /** The owner's audit: every read of their scope made for somebody else. Theirs, or an admin's. */
    async reads(participantId: string, actorId?: string): Promise<readonly MemoryReadRecord[]> {
        if (actorId !== undefined && actorId !== participantId) {
            const actor = await this.#store.participant(actorId)
            if (actor?.role !== "admin") {
                throw refused(
                    "memory_scope_forbidden",
                    `${actorId} may not read ${participantId}'s memory audit.`,
                    "A person's audit is theirs, or an admin's.",
                )
            }
        }
        return this.#store.reads(`owner:${participantId}`)
    }

    async upsertProject(input: {
        readonly id: string
        readonly name?: string
        readonly agents?: readonly string[]
    }): Promise<ProjectRecord> {
        for (const agentId of input.agents ?? []) this.#requireAgent(agentId)
        const existing = await this.#store.project(input.id)
        const saved = await this.#store.upsertProject({
            id: input.id,
            ...(input.name === undefined ? {} : { name: input.name }),
            createdAt: existing?.createdAt ?? this.#now().toISOString(),
        })
        if (input.agents === undefined) return saved
        const remove = (existing?.agents ?? []).filter((id) => !input.agents?.includes(id))
        return this.#store.setProjectAgents(input.id, input.agents, remove)
    }

    async setSpaceWriter(writer: string, setBy?: string): Promise<void> {
        const agentId = agentOf(writer)
        if (agentId !== undefined) this.#requireAgent(agentId)
        else if ((await this.#store.participant(writer)) === undefined) {
            throw refused(
                "participant_not_found",
                `No participant "${writer}".`,
                "The space writer is a registered human or a hosted agent (agent:<id>).",
                "writer",
            )
        }
        await this.#store.setSpaceWriter(writer, setBy, this.#now().toISOString())
    }

    #requireAgent(agentId: string): void {
        if (this.#agent(agentId) === undefined) {
            throw refused(
                "agent_not_found",
                `No agent "${agentId}".`,
                "GET /v1/agents lists the ones hosted here.",
            )
        }
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
        const humans = conversation.members.filter((member) => agentOf(member) === undefined)
        // Two people and their agents: an agent answers only by standing in for its owner.
        const personal = conversation.kind === "dm" && humans.length === 2
        for (const member of conversation.members) {
            const agentId = agentOf(member)
            if (agentId === undefined || member === message.authorId) continue
            if (personal) {
                if (message.origin === "human") this.#maybeStandIn(agentId, conversation, message)
                else
                    this.#enqueue(agentId, conversation.id, () =>
                        this.#deliver(agentId, conversation.id, message, false),
                    )
                continue
            }
            const addressed =
                conversation.kind === "dm"
                    ? message.origin === "human"
                    : message.mentions.includes(member)
            this.#enqueue(agentId, conversation.id, () =>
                this.#deliver(agentId, conversation.id, message, addressed),
            )
        }
        // A person speaking in a conversation is plainly there: anything waiting to answer for them
        // in it is withdrawn, and the message it was waiting on is read instead.
        if (message.origin === "human") this.#withdraw(message.authorId, conversation.id)
    }

    /** Messages waiting for an owner to stay away long enough, by owner. */
    readonly #pending = new Map<
        string,
        {
            conversationId: string
            agentId: string
            message: ConversationMessageRecord
            timer: ReturnType<typeof setTimeout>
        }[]
    >()

    /**
     * A person's message to someone whose agent may stand in for them. The agent answers when its
     * owner is offline and stays so for `standIn.escalateAfterMs`; otherwise it reads the message.
     * Presence nobody pushed reads as online — an agent never speaks for someone it was not told is
     * away.
     */
    #maybeStandIn(
        agentId: string,
        conversation: ConversationRecord,
        message: ConversationMessageRecord,
    ): void {
        void (async () => {
            const agent = this.#agent(agentId)
            const owner = (await this.#store.assignment(agentId))?.participantId
            const standIn = agent?.manifest.standIn
            const observe = () =>
                this.#enqueue(agentId, conversation.id, () =>
                    this.#deliver(agentId, conversation.id, message, false),
                )
            if (
                agent === undefined ||
                owner === undefined ||
                owner === message.authorId ||
                standIn?.enabled !== true
            ) {
                observe()
                return
            }
            if ((await this.#store.participant(owner))?.presence !== "offline") {
                observe()
                return
            }
            const entry = {
                conversationId: conversation.id,
                agentId,
                message,
                timer: setTimeout(() => {
                    this.#remove(owner, entry)
                    this.#enqueue(agentId, conversation.id, () =>
                        this.#standIn(agentId, owner, message),
                    )
                }, standIn.escalateAfterMs),
            }
            entry.timer.unref?.()
            this.#pending.set(owner, [...(this.#pending.get(owner) ?? []), entry])
        })()
    }

    #remove(owner: string, entry: { timer: ReturnType<typeof setTimeout> }): void {
        const left = (this.#pending.get(owner) ?? []).filter((candidate) => candidate !== entry)
        if (left.length === 0) this.#pending.delete(owner)
        else this.#pending.set(owner, left)
    }

    /** The owner is back, or spoke: waiting stand-ins become reads. */
    #withdraw(owner: string, conversationId?: string): void {
        for (const entry of this.#pending.get(owner) ?? []) {
            if (conversationId !== undefined && entry.conversationId !== conversationId) continue
            clearTimeout(entry.timer)
            this.#remove(owner, entry)
            this.#enqueue(entry.agentId, entry.conversationId, () =>
                this.#deliver(entry.agentId, entry.conversationId, entry.message, false),
            )
        }
    }

    /** Pushed by the embedder. Coming online withdraws every stand-in waiting to answer for them. */
    async setPresence(
        participantId: string,
        presence: "online" | "offline",
    ): Promise<ParticipantRecord> {
        const updated = await this.#store.setPresence(
            participantId,
            presence,
            this.#now().toISOString(),
        )
        if (updated === undefined) {
            throw refused(
                "participant_not_found",
                `No participant "${participantId}".`,
                "POST /v1/participants registers one.",
            )
        }
        if (presence === "online") this.#withdraw(participantId)
        return updated
    }

    /**
     * Answer for an absent owner: disclosed at first contact, marked `onBehalfOf` on every message,
     * and unable to commit — every mutating call is queued for the owner, whatever the policy allows.
     */
    async #standIn(
        agentId: string,
        owner: string,
        message: ConversationMessageRecord,
    ): Promise<void> {
        const agent = this.#agent(agentId)
        if (agent === undefined) return
        // Checked again at the moment of answering: they may have come back while the timer ran.
        if ((await this.#store.participant(owner))?.presence !== "offline") {
            await this.#deliver(agentId, message.conversationId, message, false)
            return
        }
        const ownerName = (await this.#store.participant(owner))?.name ?? owner
        const sender = await this.#store.participant(message.authorId)
        const senderName = sender?.name ?? message.authorId
        const self = agentParticipant(agentId)
        const log = await this.#store.messages(message.conversationId, { limit: 500 })
        const disclosed = log.some((entry) => entry.authorId === self && entry.onBehalfOf === owner)
        const sessionKey = roomSessionKey(message.conversationId)
        const from: TurnSender = {
            id: message.authorId,
            kind: "user",
            ...(sender?.name === undefined ? {} : { name: sender.name }),
            room: message.conversationId,
        }
        let result: Awaited<ReturnType<Agent["send"]>>
        try {
            result = await agent.send(message.text, {
                sessionKey,
                source: `room:${message.conversationId}`,
                from,
                participant: { id: message.authorId, via: "api", onBehalfOf: owner },
                runtimeNote: `You are standing in for ${ownerName}, who is away, answering ${senderName} as ${ownerName}'s agent. You cannot commit ${ownerName} to anything: whatever would change something is queued for ${ownerName} to approve — saving a note included, whatever your permissions say — and you should say so plainly.`,
                deferMutations: async (call) => {
                    const action = await this.#store.deferAction({
                        id: `da_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
                        agentId,
                        conversationId: message.conversationId,
                        ownerId: owner,
                        requestedBy: message.authorId,
                        slug: call.slug,
                        args: call.args,
                        status: "pending",
                        createdAt: this.#now().toISOString(),
                    })
                    this.#bus.emit(
                        "action.deferred",
                        {
                            actionId: action.id,
                            conversationId: action.conversationId,
                            ownerId: owner,
                            requestedBy: action.requestedBy,
                            slug: action.slug,
                        },
                        { agentId, sessionKey },
                    )
                    return `Queued for ${ownerName}'s approval as ${action.id}. It has NOT happened. Tell ${senderName} that ${ownerName} will decide.`
                },
            })
        } catch (cause) {
            this.#bus.emit(
                "conversation.skipped",
                {
                    conversationId: message.conversationId,
                    messageId: message.id,
                    reason: cause instanceof GovernorError ? "refused" : "failed",
                    detail: cause instanceof Error ? cause.message : String(cause),
                    hop: message.hop,
                    ceiling: agent.manifest.limits.maxHops,
                },
                { agentId, sessionKey },
            )
            return
        }
        const text = result.text.trim()
        if (text === "") return
        const conversation = await this.#store.get(message.conversationId)
        if (conversation === undefined) return
        const reply = await this.#append({
            conversationId: message.conversationId,
            authorId: self,
            origin: "agent",
            // The disclosure is the runtime's, not the model's, so it cannot be talked out of it.
            text: disclosed
                ? text
                : `(${ownerName}'s agent, answering while ${ownerName} is away.) ${text}`,
            mentions: [],
            hop: message.hop + 1,
            turnId: result.turnId,
            onBehalfOf: owner,
        })
        this.#fanOut(conversation, reply)
    }

    /**
     * The owner's answer to a queued action. Approved, the exact call runs as the owner's agent and
     * its outcome is posted into the conversation; denied, that is posted. Decided once.
     */
    async decideAction(actionId: string, approve: boolean): Promise<DeferredActionRecord> {
        const action = await this.#store.action(actionId)
        if (action === undefined || action.status !== "pending") {
            throw refused(
                action === undefined ? "action_not_found" : "action_already_decided",
                action === undefined
                    ? `No action "${actionId}".`
                    : `Action ${actionId} was already ${action.status}.`,
                "GET /v1/actions lists the ones waiting on you.",
            )
        }
        const agent = this.#agent(action.agentId)
        const owner = await this.#store.participant(action.ownerId)
        const ownerName = owner?.name ?? action.ownerId
        let status: "done" | "failed" | "denied" = "denied"
        let result: string | undefined
        if (approve) {
            if (agent === undefined) {
                status = "failed"
                result = `The agent ${action.agentId} is not hosted any more.`
            } else {
                const ran = await agent.runApproved(
                    { slug: action.slug, args: action.args },
                    {
                        sessionKey: roomSessionKey(action.conversationId),
                        participant: { id: action.ownerId, via: "api" },
                    },
                )
                status = ran.ok ? "done" : "failed"
                result = ran.output
            }
        }
        const decided = await this.#store.decideAction(
            action.id,
            status,
            result,
            this.#now().toISOString(),
        )
        if (decided === undefined) {
            throw refused(
                "action_already_decided",
                `Action ${actionId} was decided by someone else first.`,
                "Nothing ran twice. GET /v1/actions shows its outcome.",
            )
        }
        this.#bus.emit(
            "action.decided",
            { actionId: action.id, conversationId: action.conversationId, status },
            { agentId: action.agentId },
        )
        const conversation = await this.#store.get(action.conversationId)
        if (conversation !== undefined) {
            const said =
                status === "denied"
                    ? `${ownerName} declined ${action.slug}.`
                    : status === "done"
                      ? `${ownerName} approved ${action.slug}; it is done. ${(result ?? "").slice(0, 400)}`
                      : `${ownerName} approved ${action.slug}, and it failed: ${(result ?? "").slice(0, 400)}`
            const note = await this.#append({
                conversationId: conversation.id,
                authorId: agentParticipant(action.agentId),
                origin: "agent",
                text: said,
                mentions: [],
                hop: 1,
                onBehalfOf: action.ownerId,
            })
            this.#fanOut(conversation, note)
        }
        return decided
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

/** Whether the runtime's own clock can render this zone: the same check that will use it. */
function isTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone })
        return true
    } catch {
        return false
    }
}
