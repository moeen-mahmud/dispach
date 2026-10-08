# Workspaces and memory

Workspace files become ordered context blocks, each with a distinct lifetime and purpose.

## File tiers

| Tier | Typical content | Prompt behavior |
| --- | --- | --- |
| Static | Identity and stable operating context | Cache-stable and read-only |
| Examples | Extracted worked examples | Stable, before volatile content |
| Volatile | Editable notes and current state | Re-read as it changes |
| Reminder | Short rules that must remain visible | Placed after conversation history |
| Knowledge | Topic-specific reference pages | Activated by keywords under a budget |

Frontmatter configures a file for authors, and HTML comments can carry editing guidance. Neither reaches the model. The loader strips both before budgeting and prompt assembly.

Every configured file has a hard budget. Exceeding it names the file and stops loading; the runtime does not truncate instructions into a plausible but incomplete prompt.

## Identity and operations

`SOUL.md` describes who the agent is. A capability gate can choose a full or hand-distilled version for different models. `AGENTS.md` describes responsibilities and operating procedures. Both can coexist because they answer different questions.

## Long-term memory

Memory uses SQLite FTS5 lexical search. `memory_write` resolves one editable target from the volatile tier, so the model does not choose arbitrary files. If no configured volatile file is writable, the tool refuses and names the problem.

The binding tier order, budgets, rendering, and knowledge selection rules are in the Workspace
specification.
