# Agent workspace — template

The files an agent carries with it. Copy this directory, fill in the `{{PLACEHOLDERS}}`, point
`agent.yaml` at it.

> The tiered loader (Phase 3.5) reads these directly. `dispach init` scaffolds a new agent from
> this exact set — this directory is the human-edited source of truth, and a CLI test fails if the
> embedded copies drift from it. `agent.workspace.yaml` is a fragment to paste into an
> `agent.yaml`, not a manifest of its own.

`docs/07-SPEC-WORKSPACE.md` is the binding reference. What follows is the short version.

## The governing constraint

Everything in Tier 0 and Tier 1 goes to the model on **every single turn**, forever. A word added
here is a word the model reads a thousand times. Files earn their place or they get deleted.

| Tier | Files | Slot | Cached | Agent may edit | Budget |
| --- | --- | --- | --- | --- | --- |
| 0 — static | `SOUL.md` (or `SOUL.compact.md`), `AGENTS.md`, `POLICY.md` | 0 | yes, before breakpoint A | no | 2,000 |
| 1 — volatile | `USER.md`, `MEMORY.md` | 3 | no | yes, via tools | 3,500 |
| 2 — reminder | `REMINDER.md` | 9 | no | no | 500 |
| 3 — on demand | `knowledge/`, `skills/` | 5 / 4 | n/a | no | not pinned |

Hard total for tiers 0–2 is **6,000 tokens** by default. Over budget fails the load and names the
file. It does not truncate — an agent running on half its instructions with no error anywhere is
worse than one that refuses to start. The budgets are a ceiling, not a target: what a window
*fits* and what a model still *follows* are different numbers, and only the second one matters.

## Why tier controls cache position

Prompt caching only works on a byte-stable prefix. Put a file that changes — memory, user facts, a
timestamp — ahead of the breakpoint and every write invalidates the whole cached prefix, so cost
rises with no error to explain it. Static first, volatile after. That is the entire reason
`MEMORY.md` is not Tier 0.

## The three rules that matter most

**1. Write the files in the style you want back.** Models imitate form as readily as content, so a
file made of bullet lists produces an agent that writes in bullet lists — and a line saying "keep
formatting light" inside such a file is fighting itself, and the file wins. Agents living in
Telegram or WhatsApp, where headers render badly, get prose. Invert it for an agent that produces
structured documents.

**2. Give the reason with the rule.** Explaining the motivation lets the model generalise to cases
you never enumerated. A clause is enough:

```
Weak:    Confirm before sending anything.
Better:  Confirm before anything that sends, spends, or deletes — this runs against live
         systems and mistakes there are expensive.
```

**3. Show, don't describe.** Three to five short dialogue examples do more for voice than any
number of adjectives, and an example demonstrating a rule beats the sentence stating it. Keep them
varied — three examples about deploys produce an agent that steers every conversation toward
deploys.

## Budget your rules

Compliance with n simultaneous rules falls roughly as the per-rule success rate to the power of n.
At 90% per rule: two rules is 81%, four is 66%, ten is 35%. Count every imperative across
the identity file, `AGENTS.md`, `POLICY.md` and `REMINDER.md` together — the model does not
know they came from different files. Over budget, the fix is to **delete rules or move them into code**, never to
reformat them.

Measure your model's rate rather than assuming 90%; small models run lower. `bun run eval:rules`
does it with a verifiable-instruction probe.

## What does not belong here

Deleting these is the point of the design, not an oversight.

| Tempting file | Where it goes instead |
| --- | --- |
| `TOOLS.md` | the tool schemas — prose descriptions duplicate the rendered catalogue and drift from it |
| `HEARTBEAT.md` | `schedules` in `agent.yaml` — a queryable resource, not prompt text |
| `PLATFORM_STATE.md` | a `get_status` tool — volatile state in a cached prefix destroys the cache and is stale on read |
| `KNOWLEDGE.md` | `knowledge/` — facts needed *sometimes* should not cost tokens *always* |
| Long procedures | `skills/` — ~50 tokens pinned for the description, body loads on relevance |
| `IDENTITY.md` | folded into the soul — two identity documents contradict each other |
| Safety-critical guardrails | **code**, at the tool boundary |

That last row is the one people get wrong. Prose guardrails are advisory and can be talked around.
If it would be expensive when it happens, enforce it with an allowlist, a typed parameter, a scoped
credential, or `wrapToolCall` middleware. `POLICY.md` survives only for *soft* boundaries.
