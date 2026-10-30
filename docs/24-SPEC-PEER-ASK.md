# 24 — Peer ask between one person's agents

Status: **accepted and built** (Moeen, 2026-10-29; issue #66; decisions 15.9, 15.10, 15.15, 15.16).
Phases 35 and 36 in `22-PLAN-0.2.2.md`, built in one PR. Binding the way `02` and `04` are: a field,
route or rule it names changes here in the same PR as the code.

## The problem

"Ask milo what it is working on" has no path. `handoff` is typed: the target must declare
`delegation.offer` with an artifact schema (10.1, 14.80), and a status question has no schema. Across
silos, a person's personal agents and their team's agents run in different runtimes (14.1), and the
only path between them is `a2a_send`, which is untrusted and acts for nobody (14.47), so the asked
agent answers a stranger rather than its own owner's other agent.

## Terms

- **Owner** — the participant an agent is assigned to (`23-SPEC-SESSIONS.md`).
- **Peer** — another agent the same person owns, in this silo (local) or in a silo of theirs that
  the control plane links (remote).
- **Principal** — the embedder's opaque id for one human, used only by the control plane to say
  that a participant in silo A and a participant in silo B are the same person.

## Decisions taken for this spec (Moeen, 2026-10-29)

| | |
| --- | --- |
| Scope | In-silo and cross-silo, one PR. |
| Default | Schema default off; `init` writes it on, as #65 did with `sessions.scope`. Nothing VelaCrew provisions, and nothing already deployed, changes. |
| Reach | Same owner only. Another member's agent stays the typed `handoff` path; `delegation.to` keeps its meaning. |
| Asked turn's tools | Its full catalogue, minus `handoff` and `ask_agent`. |
| Silo → control credential | A per-silo relay token, minted by control, passed in the silo's env, stored hashed. |
| Same person across silos | Links written by the embedder through an operator route: opaque id pairs, nothing else. |
| Remote peer discovery | Control lists them; the runtime caches the list. |
| Who may ask across silos | Only a turn acting for the owner. |
| Shared agents | An agent assigned to nobody is a shared agent. It is askable by anyone's agent, reading only its projects' memory, with its full catalogue. It is never chattable through this feature. |
| Rate limit | Set through the control plane, never env: a global default plus a per-person override. |
| Peer descriptions | A top-level `description` on the manifest, shown in the peer list. |
| Changes to peers | Hot reload: an assignment, `delegation.ask` or `description` change reloads the agents whose peer list it changes. |
| Shared agents opt in too | An unassigned agent is askable only if it declares `delegation.ask`, so upgrading never exposes an existing team bot. |
| Remote refresh | After readiness, then every 15 minutes. |

## Manifest

```yaml
description: Tracks the release checklist and CI health   # optional; one line, at most 200 characters
delegation:
  ask: true      # ask_agent to this person's other agents, and be asked by them. Default false.
```

- `description` says what the agent is for. It is shown beside the agent's id in every peer's
  `ask_agent` description, in `GET /v1/agents`, and in the console. `init` writes the "what is it for"
  answer it already asks for. `config_set` may write it: it is a fact about the agent, not a "who".

- `delegation.ask` is a person-only setting, like the rest of `delegation` (14.80): `config_set`
  refuses it, `config set` and the web console write it.
- `init` writes `ask: true` beside `sessions.scope: owner`.
- **Both sides opt in.** A is offered B only when both declare `ask: true` and B is either assigned
  to A's owner (a sibling) or assigned to nobody (a shared agent). An agent the person switched off
  is not asked by its siblings.
- An agent with `ask: true` and no assignment is a **shared agent**: it can be asked, and it has no
  `ask_agent` of its own, because it has no owner to act for.

## Shared agents

An agent assigned to nobody, declaring `delegation.ask: true`, is askable by the agent of anybody in
the silo, and across silos by anybody linked to that silo. It is "askable in terms of its projects,
not chattable":

- **Reads.** The asked turn reads the `project:<id>` scopes the shared agent is a member of, and the
  space. It does **not** read its own private memory or its volatile tier (`USER.md`, `MEMORY.md`),
  nor any person's `owner:` or `agents:` scope. Today an unassigned agent withholds nothing from
  anybody (14.107). A peer ask to an unassigned agent already got the non-private plan (the space
  only); this adds the agent's `project:<id>` scopes to that branch.
- **Tools.** Its full catalogue, minus `handoff` and `ask_agent`, so "log this call in the CRM" works.
  It acts for the asking person: the turn carries their participant, and the audit names them.
- **Not chattable.** `ask_agent` starts every ask in a fresh `ask:<runId>` session with nothing
  carried between asks. The relay accepts whatever `ask:` key the calling silo names, so that
  freshness is the runtime's doing, not something control enforces. Rooms and the console reach it exactly as they do
  today. This feature adds no conversation with it, and takes none away.
- The peer-ask note tells it who is asking and for whom, that it is a shared agent answering from
  the team's projects, and to say so rather than guess where it cannot check something.

## The tool

`ask_agent`, a core tool registered when `delegation.ask` is true and at least one peer resolves.

```
ask_agent(peer, question)
  peer      enum of peer ids (local: "nova"; remote: "<silo>/<agent>")
  question  string, the whole question; the peer sees nothing else of this conversation
```

- `policyArg: "peer"`, so `deny ask_agent(nova)` is expressible.
- `mutating: true`. A turn tainted by untrusted content cannot call it under `onMutate: refuse`.
  That is what stops a web page steering a sibling's full catalogue.
- `trust: "trusted"`. The answer is observed as "answer from <peer>, acting for the same owner", the
  class `handoff`'s artifact already has (15.9).
- Its description lists each peer: id, manifest `name`, `description`, whether it is shared, and
  whether it is in another silo. Slot 1, rebuilt when the peer list changes (see Hot reload).
- Result: the peer's reply text. Outcomes mirror `handoff` minus the artifact: `ok`, `budget` (the
  peer's own limits stopped it, with its partial reply), `error` (the model sees `peer_ask_failed`
  with the peer's message; the peer's own code is on `peer.answer` and the `handoffs` row). Every
  outcome names the peer's session key.

## The asked turn (local)

- A fresh session `ask:<runId>`. `resolveSessionKey` leaves it untouched (`peerAsk` set, 15.6).
- `peerAsk: {askedBy: <asker id>}` and the asker's acting participant. The owner seen on a channel
  (`telegram:<id>`, recognised through `channelIds`) is passed as the owner's participant id, as a
  remote ask is. When that id is the owner's, `readPlan` answers as an own-owner turn: private
  memory, the pool, personal tools. Any other asker, including a turn with no person behind it (a
  schedule, the operator), gets 14.80's stand-in reading. The peer-ask note
  says it is the owner's own agent asking, and to answer from everything it knows; it does not say
  "another member's agent", which is the typed `handoff`'s wording.
- `handoff` and `ask_agent` removed: one hop. A ↔ B asking each other is two asks, never a loop, so
  there is no load-time cycle walk (14.80).
- Bounded by the asker's `limits.toolTimeoutMs` through `ToolContext.deadlineMs`, and by the
  peer's own `limits`. The asker's cancel aborts a local peer's turn. A remote ask is abandoned
  instead: it ends as `error`, and the turn in the other silo runs to its own end.
- Recorded in `handoffs` with `kind = 'ask'` (migration 34 adds `kind`, default `'handoff'`).

## Hot reload

A peer list is rendered into slot 1, so a change reloads the agents whose list it changes, through
the existing reload path (the trial build, then the swap, with held turns following the successor).
Nothing waits for a restart. The runtime records each agent's list as it was built, and a **peer
check** recomputes every list and reloads the agents whose list moved. It runs after:

- an assignment through the hub (`agent.assigned`: the API, `runtime.conversations`) or
  `DELETE /v1/agents/:id/assignee`. `init` and `owner adopt` write the store from another process
  and are picked up by the `adopt` or reload that follows them;
- any `adopt` — a new agent, or one reloaded because its `delegation.ask` or `description` changed;
- a `dispose` other than a replacement;
- a refresh of the remote list.

Checks are coalesced and never overlap, and the reloads inside one run **one at a time**: an agent
being replaced is briefly in no list, so two siblings rebuilt together each missed the other and the
next check reloaded them both again, forever. Each reload reports itself on `agent.reloaded`.
`Runtime.peersSettled()` resolves once no check is running or queued.

## Events (append-only, `v: 1`)

| Type | Fields |
| --- | --- |
| `peer.ask` | `askId`, `peer`, `remote`, `sessionKey` (the peer's), `callId?` |
| `peer.answer` | `askId`, `peer`, `sessionKey`, `outcome` (`ok`, `budget`, `error`), `steps`, `tokens`, `errorCode?` |

## Across silos

### Control plane

**Relay token.** When control knows its relay URL (`DISPACH_CONTROL_RELAY_URL`, or `HOOK_URL`), it
mints a token at every `create` **and every `recreate`** and passes it in the silo's environment
beside the silo token, as `DISPACH_RELAY_URL` and `DISPACH_RELAY_TOKEN` — names that cannot collide
with control's own `DISPACH_CONTROL_` prefix. Control stores only a SHA-256, in
`silos.relay_token_hash`, so it cannot hand the same token back; minting again on recreate is what
makes that work, and it is also how a silo created before the relay gets one: recreate it. The calling
silo is the one whose hash matches, never a field in the body.

**Links.** A new table, written by the embedder only:

```sql
CREATE TABLE IF NOT EXISTS person_links (
    principal      TEXT NOT NULL,
    subject        TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    PRIMARY KEY (principal, subject),
    UNIQUE (subject, participant_id)
);
```

| Route (operator token) | |
| --- | --- |
| `PUT /v1/people/:principal/silos/:subject` | `{participantId}`; links them. `404` if the silo does not exist, `409 participant_linked_elsewhere` if that participant is already another person's. |
| `DELETE /v1/people/:principal/silos/:subject` | Unlinks. |
| `GET /v1/people/:principal` | The principal's links and their effective rate. |

Deleting a silo deletes its links and its audit rows with the rest (`SiloStore.delete`). No name,
email or anything else about the person is stored (14.2, 14.6).

**Rate limit**, stored in control's database and set over the operator API, never from env:

```sql
CREATE TABLE IF NOT EXISTS relay_config (id INTEGER PRIMARY KEY CHECK (id = 1), ask_rate_per_minute INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS people (principal TEXT PRIMARY KEY, ask_rate_per_minute INTEGER);
```

| Route (operator token) | |
| --- | --- |
| `GET`/`PUT /v1/relay/config` | `{askRatePerMinute}`, the default for everybody. 30 until set. |
| `PUT /v1/people/:principal` | `{askRatePerMinute: n \| null}`; `null` returns them to the default. |

`GET /v1/people/:principal` includes the effective rate and whether it is an override. The window is
a sliding minute over the `relay_asks` audit rows for that principal, written when an ask **starts**
(so a burst counts before any of it finishes), which also lets the limit survive a control restart.

**Silo routes** (relay token; matched before the operator gate, as `/hooks` is):

`GET /v1/relay/peers?participant=<P>` — every agent in the caller's linked silos (other than the
caller) that declares `delegation.ask` and is assigned either to that silo's linked participant or to
nobody (shared). Control wakes each silo, reads `GET /v1/agents` with the silo token (which gains
`description`, `assignee` and `ask` per agent, and skips a stopped one), and answers
`{peers: [{silo, agent, name, description, shared}]}`. An unlinked `P` answers an empty list, not an
error, so a silo cannot probe who is linked.

`POST /v1/relay/ask {participant, toSilo, toAgent, question, askedBy, sessionKey}`, `sessionKey`
starting `ask:` (`relay_ask_invalid` otherwise):

1. The caller is the silo matching the token. `participant` must be linked in it, giving a
   principal. `toSilo` must be linked to the same principal, giving the target participant. Either
   failing answers `404 relay_peer_unknown`. So does a `toAgent` the listing would not offer there
   (another person's, one without `delegation.ask`, a stopped one, or none): the same function decides
   both. The same answer for all of them, so a caller cannot tell which, and no key is minted.
2. Rate limit per principal, at the effective rate (`relay_rate_limited`, 429, `Retry-After`).
3. `hold` and `ensureAwake` the target for the whole relay.
4. Mint a key on the target: `scope: {participant: <target P>, agents: [toAgent], can: ["chat"],
   sessions: "ask:"}`, `expiresIn: 60`, with the silo token. That token lists agents, mints and
   revokes; it never sends a message.
5. `POST /v1/agents/:toAgent/messages` **with the minted key**: `{text: question, sessionKey:
   "ask:<id>", peerAsk: {askedBy: "<caller silo>/<askedBy>"}, stream: true}`. Control reads the SSE
   stream to `turn.end` and collects the reply. The target silo decides everything the key reaches
   (14.6); control never calls `messages` with the silo token.
6. Revoke the minted key. Finish the audit row. Answer `{text, reason, steps, tokens, sessionKey,
   error?}`: the asked turn's own error, unchanged, when it failed.

Audit: `relay_asks(id, at, principal, from_subject, from_agent, to_subject, to_agent, outcome,
duration_ms)`, deleted with either silo. The question and answer text are not stored in control.
Both silos already store their own turn.

### The runtime

- **`peerAsk` on the wire.** `POST /messages` accepts `peerAsk: {askedBy: string}`
  (`message_peer_ask_invalid` otherwise). Any client may set it: it only removes `handoff` and
  `ask_agent`, keeps the session key as sent, and tells the agent who asked, so it narrows what a turn
  can do and never widens it. That is how the relayed turn stays one hop. Not on the WebSocket `send`
  frame: the relay speaks HTTP.
- **`RelayClient`**, an interface in core (`cachedPeers(agentId)`, `refreshPeers(agentId,
  participantId)`, `ask(...)`), passed in through `RuntimeOptions.relay`. The implementation lives in
  the CLI (`lib/relay-client.ts`) and is built by `serve` only when both variables are set. Core
  imports nothing.
- **Discovery follows the remote-provider rule**: resolve from disk at boot, refresh after
  readiness. The list is cached in `relay-peers.json` beside the store, keyed by agent id, written
  whole and renamed into place. The first boot has no cache, so it has no remote peers until the
  refresh lands; a refreshed list that differs reloads the agent (Hot reload). Control unreachable
  keeps the cached list and emits `agent.warning peer_list_stale`. No network before
  `runtime.ready` (hard rule 4).
- **Who may ask remotely.** A remote ask is relayed as the owner, so `ask_agent` refuses a remote
  peer on any turn whose acting participant is not the owner (`peer_owner_only`), before anything is
  sent; the remote peers stay listed, because the catalogue is fixed at load and cannot vary per
  turn. Control checks again: the participant in the request must be linked in the calling silo. The
  request names the owner's participant id, not the sender's channel id.
- **Audit on the asking side** is the `handoffs` row (`kind = 'ask'`, peer `"<silo>/<agent>"`), and
  on the asked side the turn itself, attributed to the target participant with `peerAsk` set.

## Errors (each with a hint)

Runtime: `peer_unknown`, `peer_question_required`, `peer_owner_only`, `peer_ask_failed`,
`peer_list_stale` (a warning), `message_peer_ask_invalid`. Control: `relay_off`,
`relay_token_invalid`, `relay_ask_invalid`, `relay_peer_unknown`, `relay_rate_limited`,
`relay_rate_invalid`, `relay_unavailable`, `relay_stream_ended`, `principal_invalid`,
`participant_required`, `participant_linked_elsewhere`. The asked turn's own errors pass through
unchanged. A `description` over 200 characters or on two lines is a schema refusal naming the field.

## Web and CLI

- Web Team panel: a "Peers" section listing local and remote peers (shared, another silo), and the
  `delegation.ask` switch, written through `PATCH /config`.
- `GET /v1/agents/:id` carries `peers`, from the same computation the reload check makes.
- The terminal shows an `ask_agent` call as any tool row; its observation names the peer's session.

## Tests

Core (`peer-ask.test.ts`): the same person's agents and shared ones offered, another person's not, and
a shared agent gets no tool; one side without `ask` hides both; the asked turn's request body has
neither delegation tool and does carry the owner's private memory, with the owner-ask note; the
`handoffs` row and both events; a shared agent's asked turn carries its project note and not its
`MEMORY.md`, with its own tools; a `deny ask_agent(nova)` rule; an assignment change reloads the asker
and not an agent whose list did not move; a remote ask relayed as the owner's participant id, and a
stranger's turn refused before the relay is called. Server: `peerAsk` keeps the `ask:` key under owner
scope and reaches the model (read from the request body); a malformed one is refused. CLI: the cached
list survives a restart, a refusal keeps it, and the ask body. Control (`relay.test.ts`): relay tokens
in the environment and only a hash stored, refused for the operator's token, replaced on recreate;
peers are the person's own and shared ones, and an unlinked participant gets an empty list; the minted
key's scope, that the question is sent with it rather than the silo token, and that it is revoked; one
404 for an unlinked person and a foreign silo; the rate limit at the default, under an override and
back after `null`; one participant is one person; deleting a silo deletes its links. Reverted fixes
were checked to turn their tests red.
