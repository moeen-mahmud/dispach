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

memory_write lands in the FIRST writable volatile file in the manifest's declared order —
the runtime resolves ONE write target and the model never chooses a filename, because
choosing would be a second decision on every save and that is the two-hop shape small
models fail. In the starter manifest USER.md is listed first, so saves land THERE; this
file receives writes only if you list it before USER.md instead.

WHAT THIS FILE IS FOR: state that matters across sessions but is not a durable fact about
the user — open threads, decisions taken, things promised. It is capped and evicting by
design: working memory that only ever grows becomes a second conversation history, paid
for on every turn.

WHAT IT IS NOT FOR: an archive. When something stops being working state and becomes a
fact about the person, it belongs in USER.md; when it is reference material needed only
sometimes, it belongs in knowledge/, which costs nothing on the turns that don't mention
it.

Leave the body empty below this comment. When this file is the write target, the agent
fills it; you don't.
-->

- **2026-08-27T13:24:06.806Z** _(schedule, telegram)_ Moeen set a schedule for a "hi" message on Telegram every 15 minutes (id: hi-every-15). It runs around the clock until changed or removed — confirm before touching it.
