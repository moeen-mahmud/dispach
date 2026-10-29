# 22 — The 0.3 line

Planned with Moeen on 2026-10-28/29. Decisions 15.1–15.14 carry the reasoning; this file is the
order and the bar. One GitHub issue and one branch off `development` per phase.

| Phase | Issue | What | Status |
| --- | --- | --- | --- |
| 32 | #64 | README: the docker one-liner and every stale claim | **built** (PR #69) |
| 33 | #67 | The web console reaches what the runtime does; Bedrock preset | **built** (PR #70) |
| 34 | #65 | One conversation per person across surfaces; the owner's shared memory pool | **built** |
| 35 | #66 | `ask_agent` between one owner's agents, in a silo | planned |
| 36 | #66 | The same ask across silos, relayed by the control plane | planned |

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

Spec: `24-SPEC-PEER-ASK.md` (written when the phase starts). Decision 15.9. Agents with the same
assignee are peers by default; `ask_agent(peer, text)` runs one hop in an `ask:<runId>` session,
acting for the owner.

## Phase 36 — peer ask across silos

Decision 15.10. The control plane verifies both silos belong to one person, mints a 60-second
participant-bound key on the target and relays an ordinary owner turn. Designed in the phase 35
spec; built after it.
