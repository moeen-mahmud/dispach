# 20 — Peer ask: two-way delegation between members

Status: **accepted and built** (Moeen, 2026-10-05; decision 14.80). All four recommendations were taken. One change from the text below: the onward ask is not refused by the handler. `handoff` is left out of the asked turn's catalogue through `toolsAllow`, so there is no second roster variant and no `team_peer_onward`.

## The request

VelaCrew runs one agent per team member and wants any member's agent to be able to ask another's:
Alice's agent asks Bob's, and Bob's asks Alice's. Today they cannot:

1. **The cycle check refuses it at load.** `delegation.to` edges join the team graph, and
   `checkTeamGraph` (`team/supervisor.ts:77`) treats `A → B` plus `B → A` as `team_cycle`, so the
   runtime will not boot the pair.
2. **`delegation` is not a setting.** Nothing in `manifest/settings.ts` covers `delegation.offer` or
   `delegation.to`, so `PATCH /config` cannot set it. VelaCrew would have to rewrite manifests.

VelaCrew works around both with an "ask on the bus" step in its own engine (room + mentions). That
works, so this is not urgent. A built-in version would let them drop it.

## What exists

- Cross-member delegation (Phase 28): a target declares `delegation.offer {task, artifact}`, a
  coordinator declares `delegation.to: [ids] | "*"`, and the coordinator gets those peers in its
  `handoff` tool beside its team. The handoff is the team one: a fresh `handoff:` session, a typed
  artifact, the shared depth limit (`MAX_TEAM_DEPTH = 2`).
- The member's turn acts for the person who asked the coordinator (`crossMember` →
  `participant: context.actingParticipant`, `supervisor.ts:217`).
- The roster renders into slot 1 once, at load. A peer adopted or edited later reaches the
  coordinator's roster only after the coordinator reloads.

## Proposal

### 1. A peer ask is one hop, enforced when it runs

**Static cycle detection stays for team edges and stops covering peer edges.** A peer ask can't
loop, because **a turn started by a peer ask cannot ask a peer onward.** Alice's agent asks Bob's,
Bob's agent answers, and the chain ends there. Subagents work the same way: depth 1, with the
reason stated rather than a counter.

- Mechanism: the handoff session for a `crossMember` call is marked as delegated. In that turn the
  `handoff` tool's roster leaves out cross-member entries. If the agent has no team of its own, the
  tool isn't offered at all.
  - The roster for delegated turns is built **at load**, as a second byte-stable variant beside the
    normal one, so slot 1 stays cache-stable for both.
  - The `handoff` handler also refuses a peer call from a delegated session (`team_peer_onward`,
    with a hint). That covers the case where a model names a member it was never shown.
- Bob's own in-process team: **not offered either**, by recommendation (see decision 2). That
  makes a peer ask "ask, answer, done", and its worst-case cost is one member's turn.
- Validation:
  - `A ↔ B` and `"*"` everywhere both load;
  - `team → team → team` past depth 2 is still refused statically, as now;
  - the existing `team_cycle` tests keep passing for team edges.

### 2. What a peer-asked turn may read — the decision that matters most

**Today, and this is an existing exposure, not something the proposal adds:**
1. A cross-member handoff runs the target with no conversation and no `onBehalfOf`.
2. So `readPlan` (`memory/scopes.ts:87`) returns `private: true`.
3. Bob's agent therefore reads Bob's `USER.md`, `MEMORY.md` and private recall while doing a task for
   Alice.
4. The artifact it returns goes back to Alice.

One direction made this a narrow case. Two directions make it the normal one.

Recommendation: **a peer-asked turn reads like a stand-in**, and its rules already exist:
- it reads Bob's `owner:` scope and the `space`;
- it never reads private memory and never writes it;
- the volatile tier is dropped.

The exception is when the person being acted for **is** Bob, Bob's own agent working for him. Then
it reads everything, as his DM does. Implementation: `runHandoff` passes `standingInFor` (or a new
`askedBy`) when `crossMember`, and `#readPlan` maps it. That's one branch, which
`memory-scopes.test.ts` can assert in both directions.

This fix is worth doing **even if peer ask is not built**, because one-way delegation has the same
exposure.

### 3. `delegation` becomes a person's setting

- Add `delegation.offer` (a map: `{task, artifact}`) and `delegation.to` (a list or `"*"`) as rows
  with `agentListed: false`, beside `allowFrom`.
  - Whom an agent may hand work to is a "who", which by decision 11.29 belongs to the person. An agent
    that could widen `to` could be talked into it by the message it's reading.
- `config_set` keeps refusing both. The floor lists them alongside `allowFrom`.
- **The roster is fixed at load, so a change has to reach the other side.**
  - A PATCH to Bob's `offer` reloads Bob, plus every agent in the silo whose `to` names Bob or is
    `"*"`.
  - A PATCH to Alice's `to` reloads Alice.
  - Without these reloads, the edit reports success and nothing changes until some unrelated restart:
    the "looks live and isn't" shape.
- The reload uses the existing trial-then-swap path, so a bad `offer` artifact schema leaves every
  agent on its old configuration.

### 4. What does not change

- One member at a time, a fresh session, a typed artifact, and the handoff events (`handoff.start` /
  `handoff.result` with `kind`, `name`, `callId`).
- The acting participant is still the person who asked the coordinator, so an embedder authorises
  Bob's tool calls against Alice. Under recommendation 2, that is also the person whose access
  bounds what Bob's agent reads.
- No new event types.

## Decisions for Moeen

1. **One hop** (recommended) or a runtime chain counter allowing `A → B → C`? One hop needs no new
   field. A counter needs a number in `evals/` before it has a manifest field, per the
   `MAX_TEAM_DEPTH` note.
2. **Bob's own team inside a peer-asked turn:** off (recommended) or on, within `MAX_TEAM_DEPTH`?
3. **What a peer-asked turn reads:** stand-in rules (recommended), or unchanged? Also: fix it now for
   one-way delegation, before pilot.7 ships?
4. **`delegation.*` over PATCH:** person-only (recommended), and is reloading the affected peers
   automatically acceptable?

## Size, if accepted

- Core:
  - the static walk skips peer edges;
  - delegated-session marking and the second roster variant;
  - the onward refusal;
  - the read-plan branch;
  - two settings rows and the peer-reload set.
- Server: none beyond the settings rows, since PATCH already reloads.
- Tests:
  - `A ↔ B` loads and answers both ways;
  - an onward ask is not offered and is refused if attempted;
  - a peer-asked turn sees no private note, while the owner-for-self case does;
  - a PATCH to `offer` refreshes the asker's roster.

Each test is revert-checked. Docs: `02-SPEC-MANIFEST`, `04-SPEC-WIRE` (settings), and a decision row.
