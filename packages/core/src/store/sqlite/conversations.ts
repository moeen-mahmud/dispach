/**
 * `ConversationStore` over SQLite: participants, conversations, their log, and assignments.
 *
 * Its own module because it is its own concern and `store.ts` is already the largest file in core.
 */

import type {
    AssignmentRecord,
    ConversationMessageRecord,
    ConversationRecord,
    ConversationStore,
    DeferredActionRecord,
    ParticipantRecord,
} from "../store.ts"
import type { SqlDatabase } from "./driver.ts"

interface ParticipantRow {
    id: string
    kind: string
    name: string | null
    role: string
    created_at: string
    presence: string | null
    presence_at: string | null
}

interface ActionRow {
    id: string
    agent_id: string
    conversation_id: string
    owner_id: string
    requested_by: string
    slug: string
    args: string
    status: string
    result: string | null
    created_at: string
    decided_at: string | null
}

interface ConversationRow {
    id: string
    kind: string
    title: string | null
    created_at: string
}

interface MessageRow {
    seq: number
    id: string
    conversation_id: string
    author_id: string
    origin: string
    text: string
    mentions: string
    hop: number
    turn_id: string | null
    on_behalf_of: string | null
    created_at: string
}

interface AssignmentRow {
    agent_id: string
    participant_id: string
    assigned_by: string | null
    assigned_at: string
}

const participantOf = (row: ParticipantRow): ParticipantRecord => ({
    id: row.id,
    kind: "human",
    ...(row.name === null ? {} : { name: row.name }),
    role: row.role === "admin" ? "admin" : "member",
    createdAt: row.created_at,
    ...(row.presence === "online" || row.presence === "offline" ? { presence: row.presence } : {}),
    ...(row.presence_at === null ? {} : { presenceAt: row.presence_at }),
})

const actionOf = (row: ActionRow): DeferredActionRecord => ({
    id: row.id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    requestedBy: row.requested_by,
    slug: row.slug,
    args: JSON.parse(row.args) as Record<string, unknown>,
    status: row.status as DeferredActionRecord["status"],
    ...(row.result === null ? {} : { result: row.result }),
    createdAt: row.created_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
})

const messageOf = (row: MessageRow): ConversationMessageRecord => ({
    id: row.id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    origin: row.origin === "agent" ? "agent" : "human",
    text: row.text,
    mentions: JSON.parse(row.mentions) as string[],
    hop: row.hop,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.on_behalf_of === null ? {} : { onBehalfOf: row.on_behalf_of }),
    seq: row.seq,
    createdAt: row.created_at,
})

const assignmentOf = (row: AssignmentRow): AssignmentRecord => ({
    agentId: row.agent_id,
    participantId: row.participant_id,
    ...(row.assigned_by === null ? {} : { assignedBy: row.assigned_by }),
    assignedAt: row.assigned_at,
})

export function sqliteConversations(db: SqlDatabase): ConversationStore & {
    /** For `purgeAgent`: an agent's memberships and its assignment, inside the caller's transaction. */
    purgeAgent(agentId: string): void
} {
    const q = {
        participantUpsert: db.prepare(
            `INSERT INTO participants (id, kind, name, role, created_at) VALUES (?, 'human', ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role`,
        ),
        participantGet: db.prepare("SELECT * FROM participants WHERE id = ?"),
        participantList: db.prepare("SELECT * FROM participants ORDER BY id"),
        participantDelete: db.prepare("DELETE FROM participants WHERE id = ?"),
        conversationInsert: db.prepare(
            "INSERT INTO conversations (id, kind, title, created_at) VALUES (?, ?, ?, ?)",
        ),
        conversationGet: db.prepare("SELECT * FROM conversations WHERE id = ?"),
        conversationList: db.prepare("SELECT * FROM conversations ORDER BY created_at, id"),
        memberAdd: db.prepare(
            "INSERT OR IGNORE INTO conversation_members (conversation_id, participant_id) VALUES (?, ?)",
        ),
        memberRemove: db.prepare(
            "DELETE FROM conversation_members WHERE conversation_id = ? AND participant_id = ?",
        ),
        memberRemoveEverywhere: db.prepare(
            "DELETE FROM conversation_members WHERE participant_id = ?",
        ),
        members: db.prepare(
            "SELECT participant_id FROM conversation_members WHERE conversation_id = ? ORDER BY participant_id",
        ),
        messageInsert: db.prepare(
            `INSERT INTO conversation_messages
                 (id, conversation_id, author_id, origin, text, mentions, hop, turn_id,
                  on_behalf_of, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
        messageBySeq: db.prepare("SELECT * FROM conversation_messages WHERE seq = ?"),
        messagesAfter: db.prepare(
            `SELECT * FROM conversation_messages WHERE conversation_id = ? AND seq > ?
              ORDER BY seq LIMIT ?`,
        ),
        assignmentUpsert: db.prepare(
            `INSERT INTO agent_assignments (agent_id, participant_id, assigned_by, assigned_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (agent_id) DO UPDATE SET participant_id = excluded.participant_id,
                 assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`,
        ),
        assignmentGet: db.prepare("SELECT * FROM agent_assignments WHERE agent_id = ?"),
        assignmentDelete: db.prepare("DELETE FROM agent_assignments WHERE agent_id = ?"),
        assignedTo: db.prepare(
            "SELECT * FROM agent_assignments WHERE participant_id = ? ORDER BY agent_id",
        ),
        presenceSet: db.prepare(
            "UPDATE participants SET presence = ?, presence_at = ? WHERE id = ?",
        ),
        actionInsert: db.prepare(
            `INSERT INTO deferred_actions
                 (id, agent_id, conversation_id, owner_id, requested_by, slug, args, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ),
        actionGet: db.prepare("SELECT * FROM deferred_actions WHERE id = ?"),
        actionsAll: db.prepare("SELECT * FROM deferred_actions ORDER BY created_at, id"),
        actionDecide: db.prepare(
            `UPDATE deferred_actions SET status = ?, result = ?, decided_at = ?
              WHERE id = ? AND status = 'pending'`,
        ),
        actionsDeleteForAgent: db.prepare("DELETE FROM deferred_actions WHERE agent_id = ?"),
    }

    const conversationOf = (row: ConversationRow): ConversationRecord => ({
        id: row.id,
        kind: row.kind === "dm" ? "dm" : "room",
        ...(row.title === null ? {} : { title: row.title }),
        members: q.members
            .all<{ participant_id: string }>(row.id)
            .map((member) => member.participant_id),
        createdAt: row.created_at,
    })

    const get = (id: string): ConversationRecord | undefined => {
        const row = q.conversationGet.get<ConversationRow>(id)
        return row === undefined ? undefined : conversationOf(row)
    }

    return {
        upsertParticipant: async (record) => {
            q.participantUpsert.run(record.id, record.name ?? null, record.role, record.createdAt)
            const row = q.participantGet.get<ParticipantRow>(record.id)
            if (row === undefined)
                throw new Error(`participant "${record.id}" vanished after a write`)
            return participantOf(row)
        },
        participant: async (id) => {
            const row = q.participantGet.get<ParticipantRow>(id)
            return row === undefined ? undefined : participantOf(row)
        },
        participants: async () => q.participantList.all<ParticipantRow>().map(participantOf),
        deleteParticipant: async (id) =>
            db.transaction(() => {
                q.memberRemoveEverywhere.run(id)
                return q.participantDelete.run(id).changes > 0
            }),
        create: async (record) =>
            db.transaction(() => {
                q.conversationInsert.run(
                    record.id,
                    record.kind,
                    record.title ?? null,
                    record.createdAt,
                )
                for (const member of record.members) q.memberAdd.run(record.id, member)
                const created = get(record.id)
                if (created === undefined) throw new Error(`conversation "${record.id}" vanished`)
                return created
            }),
        get: async (id) => get(id),
        list: async () => q.conversationList.all<ConversationRow>().map(conversationOf),
        setMembers: async (id, add, remove) =>
            db.transaction(() => {
                for (const member of add) q.memberAdd.run(id, member)
                for (const member of remove) q.memberRemove.run(id, member)
                const updated = get(id)
                if (updated === undefined) throw new Error(`conversation "${id}" vanished`)
                return updated
            }),
        append: async (message) => {
            const { lastInsertRowid } = q.messageInsert.run(
                message.id,
                message.conversationId,
                message.authorId,
                message.origin,
                message.text,
                JSON.stringify(message.mentions),
                message.hop,
                message.turnId ?? null,
                message.onBehalfOf ?? null,
                message.createdAt,
            )
            const row = q.messageBySeq.get<MessageRow>(lastInsertRowid)
            if (row === undefined) throw new Error(`message "${message.id}" vanished after a write`)
            return messageOf(row)
        },
        messages: async (conversationId, options = {}) =>
            q.messagesAfter
                .all<MessageRow>(conversationId, options.after ?? 0, options.limit ?? 200)
                .map(messageOf),
        assign: async (record) => {
            q.assignmentUpsert.run(
                record.agentId,
                record.participantId,
                record.assignedBy ?? null,
                record.assignedAt,
            )
            const row = q.assignmentGet.get<AssignmentRow>(record.agentId)
            if (row === undefined) throw new Error(`assignment for "${record.agentId}" vanished`)
            return assignmentOf(row)
        },
        assignment: async (agentId) => {
            const row = q.assignmentGet.get<AssignmentRow>(agentId)
            return row === undefined ? undefined : assignmentOf(row)
        },
        unassign: async (agentId) => q.assignmentDelete.run(agentId).changes > 0,
        setPresence: async (id, presence, at) => {
            q.presenceSet.run(presence, at, id)
            const row = q.participantGet.get<ParticipantRow>(id)
            return row === undefined ? undefined : participantOf(row)
        },
        assignedTo: async (participantId) =>
            q.assignedTo.all<AssignmentRow>(participantId).map(assignmentOf),
        deferAction: async (record) => {
            q.actionInsert.run(
                record.id,
                record.agentId,
                record.conversationId,
                record.ownerId,
                record.requestedBy,
                record.slug,
                JSON.stringify(record.args),
                record.createdAt,
            )
            const row = q.actionGet.get<ActionRow>(record.id)
            if (row === undefined) throw new Error(`action "${record.id}" vanished after a write`)
            return actionOf(row)
        },
        action: async (id) => {
            const row = q.actionGet.get<ActionRow>(id)
            return row === undefined ? undefined : actionOf(row)
        },
        actions: async (filter = {}) =>
            q.actionsAll
                .all<ActionRow>()
                .map(actionOf)
                .filter(
                    (action) =>
                        (filter.ownerId === undefined || action.ownerId === filter.ownerId) &&
                        (filter.status === undefined || action.status === filter.status),
                ),
        // ponytail: filters in memory over every action; an indexed query if actions pile up.
        decideAction: async (id, status, result, at) => {
            if (q.actionDecide.run(status, result ?? null, at, id).changes === 0) return undefined
            const row = q.actionGet.get<ActionRow>(id)
            return row === undefined ? undefined : actionOf(row)
        },
        purgeAgent: (agentId) => {
            q.memberRemoveEverywhere.run(`agent:${agentId}`)
            q.assignmentDelete.run(agentId)
            q.actionsDeleteForAgent.run(agentId)
        },
    }
}
