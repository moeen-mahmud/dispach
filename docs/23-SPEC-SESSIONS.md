# 23 — Sessions across surfaces, and an owner's shared memory

Status: **accepted and built** (Moeen, 2026-10-29; issue #65; decisions 15.6–15.8, 15.12–15.14).
Phase 34 in `22-PLAN-0.3.0.md`. This document is binding the way `02` and `04` are: a field, route
or rule it names changes here in the same PR as the code.

## The problem

One person talking to one agent gets a conversation per surface. The web mints `web:<id>`, the
terminal `local:<id>`, Telegram `tg:<chat>`, WhatsApp `wa:<jid>`, an API caller `api:default`. Each
has its own history, so "the thing I told you on Telegram this morning" is not in the web chat's
context, and recall finds it only if the model happens to search for it. Separately, two agents
working for the same person remember nothing of each other: private memory is one corpus per agent,
and the only shared scope a person has, `owner:<P>`, is written by the person alone (14.41).

## Terms

- **Owner** — the participant an agent is assigned to (`PUT /v1/agents/:id/assignee`). On a
  self-hosted install, `init` mints one: `me:` plus six base-32 symbols (15.7).
- **Scope** — `sessions.scope` in the manifest: how a turn's session key is chosen.
- **Base key** — `owner:<P>` or `peer:<P>`: the name of a person's conversation with this agent.
- **Head** — the key a base currently points at. A base nobody rotated is its own head.
- **Pool** — `agents:<P>`, the memory scope P's agents share.

## Manifest

```yaml
sessions:
  scope: owner        # owner | peer | channel-peer. Default channel-peer.
memory:
  shared: true        # read and write agents:<owner>. Default true; only matters when assigned.
```

`sessions.scope`:

| Value | Meaning |
| --- | --- |
| `channel-peer` | **Default.** Today's behaviour: the key the surface sent is the key used. |
| `owner` | Turns attributed to the owner land in the owner's head, from any surface. Everyone else keeps their surface key. |
| `peer` | `owner`, and every other registered participant also gets one conversation (`peer:<Q>`) across the surfaces their `channelIds` name. Unregistered senders keep their surface key. |

The default stays `channel-peer` because embedders choose and parse their own keys (VelaCrew's
per-conversation chat, `api:a2a-<taskId>`, the run id inside a schedule key), and changing it would
merge conversations an embedder kept apart on purpose. `init` writes `scope: owner` into what it
generates. `owner` or `peer` on an agent with no assignment loads, behaves as `channel-peer`, and
puts `sessions_scope_unassigned` on `agent.warnings` naming `owner adopt`.

`memory.shared: false` opts this agent out of the pool in both directions: it neither reads
`agents:<P>` nor leaves copies in it; `memory_write` still saves to its own files, as it always does.

## Resolving a turn's key

`Agent.resolveSessionKey(requested, turn)` is public and pure over the store: the server calls it
**before** answering `202`, and `send` calls it again. Resolving a key that is already resolved
returns it unchanged, so the two calls agree. Rules, first match wins:

| # | Condition | Key used |
| --- | --- | --- |
| 1 | `scope` is `channel-peer`, or the agent has no assignment | `requested` |
| 2 | The turn is a peer ask, a child turn, or `from.kind` is `agent` | `requested` |
| 3 | `source` starts with `schedule:` | `requested` — a `shared:<key>` schedule names its own key |
| 4 | `requested`'s channel segment is `room`, `subagent`, `handoff`, `schedule` or `ask` | `requested` |
| 5 | `requested` is exactly a base key (`owner:<P>`, `peer:<Q>`) the caller may use | that base's head |
| 6 | `requested`'s channel segment is `owner` or `peer` | `requested` — an older rotation, named on purpose |
| 7 | The acting participant is the owner (below), or there is none | head of `owner:<owner>` |
| 8 | `scope` is `peer` and the participant resolves to a registered participant Q | head of `peer:<Q>` |
| 9 | otherwise | `requested` |

Rule 7's "there is none" covers the operator: the terminal, the operator token, an unscoped key
with no `from`. Unattributed work on the owner's own agent is already work for the owner (14.42),
and here it means the terminal and the web console share the owner's conversation. A key bound to a
participant always has one (`senderFor`), so it lands in that participant's conversation and no
other.

The reply still goes back where the message came from: `ChannelHub` gives the outbox
`channelId`/`recipient`/`thread` from the inbound message on every turn, and nothing reads a
session's channel back out of its key for delivery. The outbox row carries the **resolved** key,
which is only its dedupe group and event context.

### Who is the owner

`isOwner(assignment, participant)` replaces three strict comparisons (`#notTheOwners`,
`#auditReads`, `#forget`'s unattributed check):

- `participant.onBehalfOf` set (a stand-in) → never the owner.
- `participant.id === assignment.participantId` → the owner.
- `via: "channel"`: the owner when an entry `<type>:<x>` in `assignment.channelIds` has the
  participant's channel type and `x` matches the sender's id **or handle** under `allowFrom`'s
  normalisation (`normaliseSender`: case folded, one `@` optional, a phone number folded to digits).
  Telegram stamps a numeric id while `allowFrom` holds `@handle`, and WhatsApp a JID while it holds
  `+880…`, so `ActingParticipant` gains `handles` — the sender's handle the channel saw. Never the
  peer id: in a group that is the group, and matching it would make every member the owner.

`resolveParticipant(participants, participant)` is the same match against every participant's own
`channelIds`, for `peer` scope.

### Rotation ("new conversation")

`owner:<P>` names a person's conversation; which history it means is the head. Starting a new
conversation rotates the head to `<base>~<6 symbols>` (the session-key alphabet), from every surface
at once: the web's "+ new", the terminal's new conversation and `POST …/sessions/rotate` all mean
"Telegram's next message lands in the fresh one too". The old head stays listed and readable, and
naming it explicitly still continues it (rule 6).

`~` because a key travels in a URL path, where `#` ends it. Participant ids are opaque, so a rotated
key is never decoded back into its owner: the head table says what a base points at, and the reach
check below anchors on the fixed suffix.

## Concurrency

Per-key serialisation lived in `ChannelHub` and `ConversationHub` only; two HTTP turns, or a
Telegram turn and a web turn, never shared a key before and could race now. `Agent.send`
serialises on `(agent, resolved key)` after admission, the same promise chain `channels.ts` uses.
A child, a peer ask and a room turn use their own keys, so a turn waiting on one of them never waits
on itself.

## Wire

- `POST /v1/agents/:id/messages` and the WebSocket `send` frame: `sessionKey` is a **request**. The
  `202` body and `ws.accepted` carry the key the turn will use, which a client adopts.
- `POST /v1/agents/:id/sessions/rotate` (`chat`): body `{from?}`, the same sender rules as a
  message. Rotates the caller's base and answers `{sessionKey, previous}`. `409
  session_not_rotatable` when the agent's scope or the caller has no base to rotate.
- `SessionSummary` gains `head: boolean` — the current conversation of its base.
- `POST /v1/participants` accepts `channelIds` (`participant_channel_ids_invalid`): what `peer`
  scope matches a channel sender by.
- `GET /v1/agents/:id` gains `sessionScope`.
- **Reach**: a key bound to participant P reaches exactly `owner:P`, `peer:P` and their rotations
  (`<base>~<6 symbols>`), on top of any `scope.sessions` prefix. An id that is literally another
  id plus `~` and six base-32 symbols would be ambiguous; no issuer mints one, and this sentence is
  the record that it was considered.
- Memory scope grammar gains `agents:<P>`; `memory_scope_invalid` names it.

## Shared pool `agents:<P>`

- **Read** exactly where private memory is read (`ReadPlan.private`): the owner's own turns, the
  owner's DM, the operator, schedules. Never by a stand-in, a room or another member's peer ask —
  `memory_write` landed in private memory before this, and a stand-in could not read it then
  either (15.13).
- **Write**: `memory_write` from a turn that reads private memory saves to the agent's own files
  as before and then leaves a copy in the pool, when `memory.shared` is on and the agent is
  assigned; the space writer still wins (14.41). The copy is written by `agent:<id>`, indexed at the
  next read like any shared scope, and never recalled by the agent that wrote it.
- **API**: P (a bound key) and P's agents write it; a key bound to anybody else, an admin
  included, gets `403 memory_scope_forbidden` — the 14.41 rule with no admin exception (15.8).
  Reads through the API follow the same rule. The unbound operator token is not a participant and
  passes, exactly as it does for `owner:<P>`.
- **Forget**: `memory_forget` on private memory lists and deletes pool notes too.
- No audit row: nothing reads the pool for somebody else.

## Owner on a self-hosted install

`init` reads `<stateDir>/agents/.owner` (beside the host token, the path a test redirects), minting
`me:<6 symbols>` the first time, so every agent in the sandbox has the same owner. It registers the
participant (`role: admin`) in the sandbox store and assigns the new agent, before any host adopts
it, with `channelIds` derived from each channel's `allowFrom` as `<type>:<entry>` (`*` skipped) —
at `init` that list is the person's own handle. Only for an agent written inside the sandbox; one
written elsewhere is told the command below. `POST /v1/agents` does the same through
`Provisioner.claim`; an agent made from a template is not claimed, since its manifest is the
operator's.

`allowFrom` entries added later are **not** copied into `channelIds`: `config allow @colleague`
lets a colleague in, and copying it would make them the owner. Fail-closed — the cost is a handle
not recognised as the owner, never a stranger recognised as one. Re-running `owner adopt` merges
what `allowFrom` holds then, on purpose.

`dispach owner adopt <agent>` does the same for an agent that already exists — registers, assigns
(merging `channelIds` already there), writes `sessions.scope: owner` and asks a running host to
reload it. Idempotent. An agent assigned to somebody else is refused (`owner_assigned_elsewhere`)
rather than taken over. `owner show` prints the id.

## Store

Migration 33:

- `session_heads (agent_id, base_key, head_key, rotated_at)`, primary key `(agent_id, base_key)`,
  purged with the agent.
- `participants.channel_ids TEXT` (JSON array), NULL before.

No `turns` column: `turns.source` and `turns.participant_id` already say which surface and which
sender each turn came from.

## Pickers

`owner:*` renders as "You", `peer:<P>` as the participant's id, and a conversation a rotation left
behind as "You · earlier" (the web adds its date). A web tab and a terminal with no conversation of
their own open the person's current one; "+ new conversation" (web) and `/new` (terminal) rotate,
the web only once the first message is sent, so a click alone never moves where Telegram lands.
Old per-surface histories stay listed. Nothing is merged retroactively: `POST
…/sessions/:key/recall {recall: false}` is the lever when an old one keeps surfacing in recall.

## Non-goals

- Merging existing histories into the owner's conversation.
- A `/new` command typed into Telegram or WhatsApp. Rotation reaches those channels; starting it
  from them is a channel-command feature this runtime does not have.
- One conversation across *agents*. A session belongs to one agent; the pool is what crosses agents.
- Changing the default scope.

## Acceptance

1. As the owner, a Telegram message and a web message land in one `owner:me:…` session, and each
   reply arrives on the surface it was asked on.
2. A stranger on Telegram keeps `tg:<chat>`.
3. A room, a schedule, a child turn and an `api:a2a-…` turn from an agent sender keep their keys.
4. Two concurrent sends to one owner key run one after the other; a child turn under an owner-keyed
   parent completes.
5. Rotate, then a Telegram message lands in the new head; the old head is still listed.
6. `memory_write` from agent A is recalled by agent B with the same owner; `memory.shared: false`
   opts out; a stand-in turn does not read it; an admin key that is not P gets `403` on it.
7. `init` registers `me:<id>` once per sandbox; `owner adopt` makes an existing agent behave as 1.
8. `channel-peer` agents are byte-identical: every existing session test passes unchanged.
