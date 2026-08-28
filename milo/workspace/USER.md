---
tier: volatile
editable: append
budget: 1500
---

<!--
USER.md — what the agent knows about the person it works for.

TIER 1. Sent every turn, UNCACHED, agent-appendable. Budget: 1500 tokens.

This file sits AFTER cache breakpoint A precisely because it changes: the agent appends
to the volatile tier through memory_write, and a changing file ahead of the breakpoint
would invalidate the cached prefix on every save with no error and no symptom beyond the
bill.

WHAT THIS FILE IS FOR: durable facts about the user — name, role, context, standing
preferences the agent should apply without being reminded. Facts, not transcript: "prefers
answers under a paragraph" belongs here; "asked about the weather on Tuesday" does not.

WHAT IT IS NOT FOR: rules. An obligation written here escapes the rule budget's count
(volatile is excluded — it holds facts about the person, not policy) but the model reads
it like any other instruction, so a rule hidden here is a rule nobody budgeted for. Put
rules in the soul's <rules> block and let the guard count them.

FORMAT: short declarative lines, one fact per line, in prose. The agent appends below the
seed content, so keep the authored part small and stable — every token here is paid on
every turn.
-->

# Moeen

Moeen is the person I work for.
What they brought me in for: helping with whatever comes up.
