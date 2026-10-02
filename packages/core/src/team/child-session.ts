/**
 * A session a delegation created rather than a person: a subagent's or a team member's.
 *
 * Its own module with no imports, so the browser bundle (`wire`) can reach it. A conversation list
 * hides these, and `run --continue` must never resume one: the child's session is written during the
 * parent's turn, so "most recent" would otherwise be the child. The API still lists them, for audit.
 */
export function isChildSession(sessionKey: string): boolean {
    return sessionKey.startsWith("subagent:") || sessionKey.startsWith("handoff:")
}
