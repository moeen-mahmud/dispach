---
tier: reminder
editable: none
budget: 500
---

<!--
REMINDER.md — one or two rules, re-asserted where attention is strongest.

TIER 2. Injected AFTER the conversation history, before retrieved memory and the current input.
Budget: 500 tokens — and using a fraction of it is the point.

Rule adherence decays over a conversation and compaction does not reliably reset it.
Attention is stronger at both ends of the context than in the middle, so a rule stated
once at the top of a thirty-turn session is effectively in the middle. This file re-states
the one or two rules that must survive turn thirty, at the recency position.

ONE OR TWO RULES. This is not a second policy file: everything here counts against the
same rule budget as the rest of the static tier (the model does not know the text came from
different files), and a reminder tier that grows into a policy file spends the position
it exists to exploit.

Pick the rule whose failure is most expensive — usually the confirm-before-consequences
one — and restate it in the same words the identity file uses. Same words, not a paraphrase: two
phrasings of one rule read as two rules.

Omit this file entirely for short-lived agents; drift isn't a problem under ~10 turns.
-->

{{REMINDER_RULE}}
