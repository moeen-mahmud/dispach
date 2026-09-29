/**
 * Team memory scopes (Phase 29): which memory a turn may read, and how a shared scope is keyed.
 *
 * Four scopes, a fixed vocabulary:
 * - **private**: everything an agent has today — its workspace memory files, its archive, its indexed
 *   conversations. Keyed by the agent's id, untouched by this module.
 * - **`owner:<participant>`**: notes a person shares with the agents working for them.
 * - **`space`**: the team's notes. Read by everyone; written by admins and one designated writer.
 * - **`project:<id>`**: notes shared by the agents an embedder put in that project.
 *
 * A shared scope is indexed under its own corpus key rather than under a source prefix inside an
 * agent's corpus. That is what keeps it out of the reconcile trap: `syncFiles` and `syncSessions` drop
 * whatever they were not handed *within the corpus they sync*, and a scope's corpus is one neither of
 * them ever syncs.
 */

/** A shared memory scope. `private` is not one: it is the agent's own corpus. */
export type SharedScope = "space" | `owner:${string}` | `project:${string}`

export const SCOPE_SOURCE_PREFIX = "scope:"

/** A shared scope, when `value` is one. */
export function parseScope(value: string): SharedScope | undefined {
    if (value === "space") return "space"
    const [kind, ...rest] = value.split(":")
    const id = rest.join(":")
    if (id === "") return undefined
    if (kind === "owner") return `owner:${id}`
    if (kind === "project") return `project:${id}`
    return undefined
}

/**
 * The memory-store key a scope's passages live under. `~` because a manifest id may not start with one
 * (`AgentManifestSchema`), so no agent's corpus can ever be a scope's.
 */
export function scopeCorpus(scope: string): string {
    return `~${scope}`
}

export function noteSource(scope: string, noteId: string): string {
    return `${SCOPE_SOURCE_PREFIX}${scope}/${noteId}`
}

export function isScopeSource(source: string): boolean {
    return source.startsWith(SCOPE_SOURCE_PREFIX)
}

/** The scope a `noteSource` belongs to. */
export function scopeOfSource(source: string): string | undefined {
    if (!isScopeSource(source)) return undefined
    const rest = source.slice(SCOPE_SOURCE_PREFIX.length)
    const slash = rest.lastIndexOf("/")
    return slash === -1 ? undefined : rest.slice(0, slash)
}

/** How slot 7 names a scope: a frame, never a source string the model has to decode. */
export function describeScope(scope: string): string {
    if (scope === "space") return "the team's shared memory"
    if (scope.startsWith("owner:")) return `the notes ${scope.slice(6)} shares with their agents`
    if (scope.startsWith("project:")) return `project ${scope.slice(8)}'s shared memory`
    return scope
}

/** What one turn may read. */
export interface ReadPlan {
    /** The agent's own corpus, and the workspace's volatile tier that carries the same notes. */
    readonly private: boolean
    readonly scopes: readonly SharedScope[]
    /** Who the agent works for, when anyone: what the audit compares a reader against. */
    readonly owner?: string
}

/**
 * Decide what a turn reads, from who it is for and where it was said.
 *
 * - A stand-in answering for its owner reads the owner's scope and the space, **never private** and
 *   never a project: it is speaking to someone the owner did not choose, about the owner.
 * - A room turn reads the shared scopes only. Other people are in the room, and a private fact said
 *   there is said to all of them. The agent's DM with its own owner is the exception — that is the
 *   owner's private conversation, and the agent's private memory is theirs.
 * - Anything else — the operator, an API caller, a channel, a schedule — reads everything, which is
 *   exactly what every turn read before scopes existed.
 */
export function readPlan(input: {
    /** The absent owner, when this turn is a stand-in. */
    readonly standingInFor?: string
    /** Set when the turn came from a conversation. */
    readonly conversation?: { readonly kind: "room" | "dm"; readonly authorId: string }
    /** Who the agent is assigned to. */
    readonly owner?: string
    readonly projects: readonly string[]
}): ReadPlan {
    if (input.standingInFor !== undefined) {
        return {
            private: false,
            scopes: [`owner:${input.standingInFor}`, "space"],
            ...(input.owner === undefined ? {} : { owner: input.owner }),
        }
    }
    const shared: SharedScope[] = [
        ...(input.owner === undefined ? [] : [`owner:${input.owner}` as const]),
        "space",
        ...input.projects.map((id) => `project:${id}` as const),
    ]
    const conversation = input.conversation
    const ownDm =
        conversation?.kind === "dm" &&
        input.owner !== undefined &&
        conversation.authorId === input.owner
    return {
        private: conversation === undefined || ownDm,
        scopes: shared,
        ...(input.owner === undefined ? {} : { owner: input.owner }),
    }
}
