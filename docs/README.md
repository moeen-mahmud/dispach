# Dispach — Planning Documents

Design and implementation plan for **Dispach**, a lightweight, model-agnostic agent
runtime. Apache-2.0. Repo: `github.com/moeen-mahmud/dispach` (moves to HelicanHQ later).
VelaOps is its first consumer, not its owner.

> A dispach holds and governs a keep on behalf of its lord — commands the garrison,
> controls the gate, keeps the place running when nobody is watching. The runtime hosts
> agents, gates their tool access, and runs unattended. VelaOps owns the keep.

## Read in this order

| Doc | What it settles |
| --- | --- |
| `00-DECISIONS.md` | Every locked decision with rationale. Read first; it explains *why* the rest looks the way it does. |
| `01-ARCHITECTURE.md` | Module map, the agent loop, context assembly, compaction ladder, boot budget. |
| `02-SPEC-MANIFEST.md` | `agent.yaml` — the single config contract. |
| `03-SPEC-PLUGIN-API.md` | Plugin and middleware contracts. |
| `04-SPEC-WIRE.md` | HTTP/SSE surface and the lifecycle event schema. |
| `05-PLAN.md` | Every phase with acceptance criteria, plus the carried backlog. The build order. |
| `06-VELAOPS-INTEGRATION.md` | Migration strategy and what must never leak into core. **The compat adapter it once described was deleted rather than built** — VelaOps calls `/v1` like any other client. |
| `07-SPEC-WORKSPACE.md` | The tiered agent workspace — the `SOUL.md` identity pair, `AGENTS.md`, `POLICY.md`, `USER.md`, `MEMORY.md`, `REMINDER.md`, budgets, and per-model rendering. Supersedes `context.files` in doc 02, which survives as a deprecated alias. |
| `08-MEMORY.md` | How memory is stored, retrieved, and injected — Phase 6 through 6.5, with the numbers. |
| `09-API-GUIDE.md` | The agent server walked through, `compose up` to a streamed reply. The *guide*; doc 04 is the contract. |
| `12-OPENCLAW-CUTOVER.md` | Moving off the runtime this one replaces. |
| `13-QA.md` | The manual QA pass before a release reaches anyone: upgrade, CLI, server, channels, API, control plane, numbers. |
| `17-KUBERNETES.md` | Running the image on a cluster, and the volume-ownership trap. |
| `22-PLAN-0.3.0.md` | The 0.3 line: console, one conversation per person across surfaces, peer ask. |
| `23-SPEC-SESSIONS.md` | `sessions.scope`, the owner's conversation and its rotation, and the `agents:<P>` memory pool. |

`10`, `11`, `14`–`16` and `18`–`21` are private working documents (the business plan, the 0.2.0
plan, VelaCrew's notes) and are gitignored on purpose, which is why the numbering has gaps. Anything they decide that
the code depends on is recorded in `00-DECISIONS.md`, and a rule that exists only in a private file
does not bind anybody reading this repo.

`CLAUDE.md` lives at the repo root, not here. It is the standing brief for coding agents.

## Using these with Claude Code

Written to be handed to an agent one phase at a time:

```
1. Point Claude Code at CLAUDE.md + docs/05-PLAN.md
2. Say: "implement Phase N"
3. It reads that phase's Deliverables, Files, and Non-goals
4. It stops at the acceptance criteria and reports
5. You review, verify, commit
```

Phases are dependency-ordered and each ends at a state where the thing runs. Do not let an
agent start Phase N+1 before Phase N's acceptance criteria pass — several of these
subsystems are only testable end-to-end.

## Status

**Shipped: `dispach@0.2.0`.** Phases 0 through 19 are built, the last being the VelaOps cutover, and the 0.2.0 line on top of them. This section named Phase 3 as the
frontier and "everything from Phase 4 on" as design-only for long enough to be actively misleading,
which is the drift the closing paragraph below warns about — so it is now a pointer rather than a
second copy of the plan:

> **`05-PLAN.md` marks every phase through 19 `built` with the date it landed.** The 0.2.0 work
> after it is summarised in `CHANGELOG.md` and `developer-docs/runtime/whats-new-0-2-0.md`. Read it
> there. A status summary maintained by hand in a second file is a status summary that is right on
> the day it is written, which is the whole lesson of the six phantom event rows in doc 04 — and of
> this section, which went on calling WhatsApp and the MCP provider unbuilt after both had shipped.

In one paragraph: the manifest and loop, the store, both tool dialects, the tiered workspace, the
system and web providers with a policy engine and a hardline floor, MCP as a tool provider
(`packages/tools-mcp`, one provider among several per decision 4.7, never the substrate),
Telegram and WhatsApp channels plus Slack, Teams and A2A (experimental in 0.2.0), the HTTP/SSE/WS
server, an idempotent outbox, memory on FTS5, skills with two catalogues, the compaction ladder,
phase scoping, scheduling, the plugin API with all four middleware wrap points, supervisor
delegation, launchd services, the Docker image and compose front door, a typed client, scoped
operator keys, the full-screen TUI, and a browser console on the same origin as the API — which
since the 0.3 line covers models (Bedrock and fallbacks included), tools, schedules, usage, turns,
files, people, rooms, actions, shared memory, webhooks and backups.

Measured numbers live in `evals/`, each with a script to reproduce it.

When code and these documents disagree, **the code wins** and the doc is stale — fix it in
the same PR. A planning doc that quietly drifts from the implementation is worse than no
doc, which is a lesson VelaOps already paid for.
