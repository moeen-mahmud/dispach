/**
 * Turning a `team:` block into loaded manifests, and refusing a bad graph before anything runs.
 *
 * A team member is a **full agent with its own manifest file**, not a nested block. Both shapes
 * were considered and the nested one loses on the same argument twice: a member needs `model`,
 * `tools` and `context` to be an agent at all, so three nested members is a four-hundred-line
 * manifest nobody reads — and `extends:` already exists for sharing the boring parts. A separate
 * file also means a member can be `validate`d and `run` on its own, which is the only practical way
 * to debug one.
 *
 * ## Why the graph is checked here and not at the third hop
 *
 * Every edge in a team graph is a `team.members[].manifest` path, so the whole graph is static and
 * visible at load. `A → B → A` does not need a chain threaded through `AgentSendOptions` and
 * `ToolContext` to be caught at runtime; it needs a walk over the manifests nobody has run yet.
 * Same principle as `validateSchedules` parsing a cron expression during `validate` rather than
 * leaving it to the scheduler: a limit enforced only at runtime is a limit somebody discovers when
 * their agent stops halfway through a task it reported starting.
 *
 * ## Members are loaded and not *served*
 *
 * `Runtime.list()` excludes them, which is what keeps `GET /v1/agents` and every route behind
 * `withAgent` from addressing one. That is not tidiness: a member is an implementation detail of
 * its supervisor, and an addressable member is a way to reach the member's tool catalogue while
 * bypassing whatever policy the supervisor was carrying. `runtime.agent(id)` still resolves one,
 * because the handoff runner needs it — the boundary is the *served* surface, not the process.
 */

import { isAbsolute, resolve } from "node:path"
import { HarnessError } from "../errors.ts"
import { type LoadedManifest, loadManifest } from "../manifest/load.ts"
import type { TeamMemberConfig } from "../manifest/schema.ts"
import { checkTeamGraph } from "./supervisor.ts"

export interface ExpandedTeams {
    /** Every manifest to build an agent from: the originals first, then members in discovery order. */
    readonly loaded: readonly LoadedManifest[]
    /** Agent ids that exist only to receive handoffs. Excluded from `Runtime.list()`. */
    readonly memberIds: ReadonlySet<string>
    /** A supervisor's declared members, by supervisor id. */
    readonly teams: ReadonlyMap<string, readonly TeamMemberConfig[]>
}

/**
 * Load every team member reachable from the given manifests, breadth-first.
 *
 * Breadth-first rather than depth-first so the error a person sees names the shallowest problem:
 * with two faults in one graph, the one nearer the manifest they are editing is the one worth
 * reporting.
 */
export function expandTeams(
    roots: readonly LoadedManifest[],
    loadOptions: Parameters<typeof loadManifest>[1],
): ExpandedTeams {
    const byId = new Map<string, LoadedManifest>()
    const teams = new Map<string, readonly TeamMemberConfig[]>()
    const memberIds = new Set<string>()
    const order: LoadedManifest[] = []

    for (const root of roots) {
        byId.set(root.manifest.id, root)
        order.push(root)
    }

    const queue: LoadedManifest[] = [...roots]
    while (queue.length > 0) {
        const parent = queue.shift()
        if (parent === undefined) continue
        const team = parent.manifest.team
        if (team === undefined) continue
        teams.set(parent.manifest.id, team.members)

        for (const member of team.members) {
            const path = isAbsolute(member.manifest)
                ? member.manifest
                : resolve(parent.dir, member.manifest)

            const already = byId.get(member.id)
            if (already !== undefined) {
                // Shared members are fine and are loaded **once**: two supervisors delegating to one
                // researcher is a reasonable team, and loading the manifest twice would give them
                // two agents with one id, which `Runtime.create` already refuses by name. What is
                // checked is that they agree about *which file* it is — the same id pointing at two
                // manifests is a mistake no later error would explain.
                if (already.path !== path) {
                    throw new HarnessError({
                        code: "team_member_conflict",
                        message: `Two team entries call themselves "${member.id}" and name different manifests.`,
                        hint: `One is ${already.path}, the other is ${path}. An agent id is used in session keys and in handoff events, so one id must mean one agent. Rename one member, or point both at the same file.`,
                        field: "team.members",
                    })
                }
                memberIds.add(member.id)
                continue
            }

            const loadedMember = loadManifest(path, loadOptions)
            if (loadedMember.manifest.id !== member.id) {
                // Checked rather than trusted, and the reason is that nothing downstream would
                // notice: the `handoff` argument, the session key, the `handoff.*` events and the
                // stored row would each use whichever id their layer happened to have, and a reader
                // chasing a delegation would find two names for one run.
                throw new HarnessError({
                    code: "team_member_id_mismatch",
                    message: `Team member "${member.id}" points at a manifest whose id is "${loadedMember.manifest.id}".`,
                    hint: `Make them match: either rename the member entry to "${loadedMember.manifest.id}", or change the id in ${path}. The name in the team block is what the model passes to handoff and what every event reports, so it has to be the agent's real id.`,
                    field: "team.members",
                })
            }

            byId.set(member.id, loadedMember)
            memberIds.add(member.id)
            order.push(loadedMember)
            queue.push(loadedMember)
        }
    }

    // After loading, because a cycle's ids only exist once every manifest in it has been read — and
    // the walk needs the whole graph to report the path rather than just the repeated name.
    const membersOf = (id: string): readonly string[] =>
        (teams.get(id) ?? []).map((member) => member.id)
    for (const root of roots) checkTeamGraph(root.manifest.id, membersOf)

    return { loaded: order, memberIds, teams }
}
