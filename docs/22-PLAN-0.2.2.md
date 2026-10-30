# 22 — 0.2.2 (planned as "the 0.3 line")

Planned with Moeen on 2026-10-28/29 as "the 0.3 line". It is released as **0.2.2** (Moeen,
2026-10-30): 0.3.0 is kept for the open issues, which are left for outside contributors. Decisions
15.1–15.17 carry the reasoning; this file is the order and the bar. One GitHub issue and one branch
off `development` per phase.

| Phase | Issue | What | Status |
| --- | --- | --- | --- |
| 32 | #64 | README: the docker one-liner and every stale claim | **built** (PR #69) |
| 33 | #67 | The web console reaches what the runtime does; Bedrock preset | **built** (PR #70) |
| 34 | #65 | One conversation per person across surfaces; the owner's shared memory pool | **built** (PR #71) |
| 35 | #66 | `ask_agent` between one owner's agents, in a silo | **built** (PR #73) |
| 36 | #66 | The same ask across silos, relayed by the control plane | **built** (one PR with 35) |
| — | #74 | Control: a silo's port is fixed for its lifetime | **built** (PR #75) |

## Phase 34 — sessions across surfaces, shared pool

Spec: `23-SPEC-SESSIONS.md`. Decisions 15.6–15.8, 15.12–15.14.

**Deliverables.** `sessions.scope` and `memory.shared` in the manifest; `isOwner` and
`resolveParticipant` in core; `Agent.resolveSessionKey` and per-key serialisation in `send`;
migration 33 (`session_heads`, `participants.channel_ids`); `POST …/sessions/rotate`; the resolved
key in the `202` and `ws.accepted`; participant-bound reach over `owner:`/`peer:`; the `agents:<P>`
scope (read, write, forget, API); `init` minting and registering `me:<id>`; `owner adopt`; the web
and terminal pickers.

**Non-goals.** Merging old histories. A `/new` typed into a messaging channel. A conversation
spanning agents. Changing the default scope. `ask_agent` (phase 35).

**Acceptance.** `23-SPEC-SESSIONS.md` § Acceptance, run in the container: the owner's Telegram and
web turns share one session, a stranger does not, rotation reaches Telegram, agent B recalls agent
A's note. Every existing session test passes unchanged, which is what `channel-peer` staying the
default promises.

## Phase 35 — peer ask in a silo

Spec: `24-SPEC-PEER-ASK.md`. Decisions 15.9, 15.15. `delegation.ask` (off unless declared, `init`
writes it on) and `description` in the manifest; `ask_agent(peer, question)` reaches the same
person's agents and shared ones, one hop, in an `ask:<runId>` session; migration 34 (`handoffs.kind`);
`peer.ask`/`peer.answer`; hot reload of the agents whose peer list moved; the console's Peers section.

## Phase 36 — peer ask across silos

Decisions 15.10, 15.16. Built with phase 35, at Moeen's call. Control gains `person_links`, a relay
token per silo, `GET /v1/relay/peers`, `POST /v1/relay/ask` (a 60-second key minted in the target,
revoked after), an audit row per ask and a rate limit set over the API. The runtime gains `peerAsk`
on `POST /messages`, `RelayClient` in core and its implementation in the CLI, built by `serve`.
