---
tier: volatile
editable: replace
budget: 2000
eviction: oldest
---

<!--
MEMORY.md — the agent's working memory.

TIER 1. Sent every turn, UNCACHED, agent-writable (replace + oldest-first eviction).
Budget: 2000 tokens.

memory_write lands here. The runtime resolves ONE write target — the writable
volatile file that declared `eviction: oldest` — and the model never chooses a
filename, because choosing would be a second decision on every save and that is
the two-hop shape small models fail. Declared order does not decide it: USER.md
is listed first and is writable, and saves still land HERE. That is why USER.md
does not grow until the agent refuses to boot.

WHAT THIS FILE IS FOR: state that matters across sessions but is not a durable
fact about the user — open threads, decisions taken, things promised. It is
capped and evicting by design: working memory that only ever grows becomes a
second conversation history, paid for on every turn.

WHAT IT IS NOT FOR: an archive. When something stops being working state and
becomes a fact about the person, it belongs in USER.md; when it is reference
material needed only sometimes, it belongs in knowledge/, which costs nothing
on the turns that don't mention it.

Leave the body empty below this comment. The agent fills it; you don't.
-->
