---
name: starter
description: Replace this description with what the skill does and when to use it, naming the specific words someone would type — file formats, tool names, the error they are looking at. Selection is lexical and this sentence is all it has.
metadata:
  "dispach-when-not-to-use": >
    Replace this too. Say what this skill is NOT for, and name the skill or the plain answer
    that handles those cases instead.
---

<!--
SKILL.md — one procedure the agent follows on the turns that call for it.

The format is agentskills.io, so this folder is portable to other clients. The spec's fields are
`name` (which must equal this directory's name), `description`, and optionally `license`,
`compatibility`, `metadata` and `allowed-tools`. Anything else is ignored rather than refused.

HOW SELECTION WORKS, because it changes how you write the description. The harness ranks every
skill's name and description against what was just asked, picks at most `skills.maxActive`, and
injects the winner. The model does not choose — so the description is a routing signal aimed at a
lexical scorer, not a pitch aimed at a reader. Concrete nouns beat adjectives. A description whose
only distinctive word is a common verb activates on any turn using that verb: measured, a skill
opening "Write and debug a Dockerfile" was selected for "write me a haiku about autumn".

Negative guidance is not a spec field, which is why it lives under `metadata`. It is worth writing
anyway — negative examples are the cheapest routing improvement available — and `skills validate`
warns when it is missing. It is never required to load, so a skill vendored from elsewhere works
as it arrives.

THE BODY IS INJECTED VERBATIM on every turn this skill activates, so every line below is paid for.
Write steps, not background. Detail that is only occasionally needed goes in `references/` for the
model to read on demand. These HTML comments are stripped before the model sees the file, so
authoring notes like this one are free.

SCRIPTS. Drop an executable into `scripts/` and it becomes a tool named
`skill.starter.<filename>`, callable only while this skill is active. A `.py` runs under `python3`,
or under `uv run` if this folder has a `pyproject.toml` or `requirements.txt`; `.ts` and `.js` run
under the host; anything else needs an executable bit and a shebang. A file in `scripts/` that
matches none of those will never run, and `skills validate` says so. A deterministic script beats
instructions the model has to interpret — prefer one wherever the work is mechanical.
-->

Replace everything below with the steps.

1. State the first step as an action, not a topic.
2. Where a step has a rule that was learned the hard way, say the rule and why — a step with a
   reason generalises to the case you did not think of.
3. Say what to report at the end, and what not to do. A procedure that does not say where it stops
   gets carried into the next turn.
