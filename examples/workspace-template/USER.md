---
tier: volatile
editable: append
budget: 1500
---

<!--
USER.md — what the agent knows about the person it works for.

TIER 1. Sent every turn, UNCACHED. Budget: 1500 tokens.

You write this file. The agent reads it every turn. memory_write does not land
here — that tool writes MEMORY.md, which declared eviction: oldest. This file
is appendable so you can add a standing fact by hand; notes the agent saves
have a budget and an overflow, and this file has neither.

This file sits AFTER cache breakpoint A because the volatile tier changes:
MEMORY.md is rewritten on every save, and a changing file ahead of the
breakpoint would invalidate the cached prefix on every write with no error
and no symptom beyond the bill.

WHAT THIS FILE IS FOR: standing facts about the user — name, role, timezone,
context, preferences they should not have to restate. Facts, not transcript:
"prefers answers under a paragraph" belongs here; "asked about the weather on
Tuesday" does not.

WHAT IT IS NOT FOR: rules. An obligation written here escapes the rule budget's
count (volatile is excluded — it holds facts about the person, not policy) but
the model reads it like any other instruction, so a rule hidden here is a rule
nobody budgeted for. Put rules in the soul's <rules> block and let the guard
count them.

WHAT IT IS NOT FOR: working notes. A save that lands here has no eviction and
grows until the next load fails. Promote a settled fact from MEMORY.md into
this file by hand.

FORMAT: short declarative lines, one fact per line, in prose — not bullets.
Models imitate form. Keep the authored part small and stable — every token
here is paid on every turn.
-->

# {{USER}}

{{USER_FACTS}}

<!--
Add standing facts below, one prose sentence each. Leave a line out rather than
guessing. Timezone, how they like to be addressed, role and recurring people,
length and tone, tools they always want or never want.
-->
