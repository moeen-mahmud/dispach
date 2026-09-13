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
| `05-PLAN.md` | Sixteen phases, each with acceptance criteria. The build order. |
| `06-VELAOPS-INTEGRATION.md` | The compat adapter, migration strategy, and what must never leak into core. |
| `07-SPEC-WORKSPACE.md` | The tiered agent workspace — the `SOUL.md` identity pair, `AGENTS.md`, `POLICY.md`, `USER.md`, `MEMORY.md`, `REMINDER.md`, budgets, and per-model rendering. Supersedes `context.files` in doc 02, which survives as a deprecated alias. |
| `08-MEMORY.md` | How memory is stored, retrieved, and injected — Phase 6 through 6.5, with the numbers. |

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

Phases 0–3 implemented and verified: manifest, loop, model layer, store and sessions, the Ink
CLI, and the tool layer with both dialects. Measured numbers live in `evals/` — see
`evals/tools/README.md` for the NLT-versus-native comparison that Phase 3's gate turns on.

Phase 3.5 is in, all of it: the workspace tiers, frontmatter and comment stripping, per-file and
total budgets, the rule guard, `context.files` as a deprecated alias, `promptStyle` rendering,
`examplesIn` placement, `SOUL.md` gating with `soul distill`, `knowledge/`, the `workspace`
command, `eval rules`, and `evals/prompt-style/` with committed numbers behind the `examplesIn`
and `intensity` defaults. Phase 3.7 is in: `init` scaffolds a validated starter agent from the
workspace templates. Phase 3.8 is in: agents live in the `~/.dispach` sandbox and run by bare
name, bare `run` opens a picker, `init` is an Ink wizard generating the SOUL.md identity pair, the
AGENTS.md operations file, and a reference-style manifest, and the chat/wizard/picker surfaces share one TUI kit
(`cli/src/lib/theme.ts` + `components/`). Still design-only: Phase 3.6 and everything from
Phase 4 on.

When code and these documents disagree, **the code wins** and the doc is stale — fix it in
the same PR. A planning doc that quietly drifts from the implementation is worse than no
doc, which is a lesson VelaOps already paid for.
