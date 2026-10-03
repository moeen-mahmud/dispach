# evals/subagents — is routing bulk tool work to a subagent worth it?

Decision 14.69 routes a call like a mailbox listing to a throwaway child, so the parent reads an
artifact instead of the raw output. The unit tests prove the isolation. This measures whether it is
worth paying for.

```bash
bun run eval:subagents --model <id> --base-url <url>
bun run eval:subagents ... --subagent-model <cheap id> --price-main 0.27,1.10 --price-subagent 0.07,0.28
bun run eval:subagents ... --tasks mail-triage,logs --arms inline,routed
```

## Three arms, ten tasks of two turns

| Arm | |
| --- | --- |
| `inline` | No subagents. Compaction on, `artifact_read` in the catalogue: an observation over `observationMaxTokens` is cut with a pointer to the whole of it (pilot.5). **The baseline to beat.** |
| `routed` | The task's tool is routed to a child on `main`. |
| `routed-cheap` | The same, with the child on `--subagent-model`. Run only when that is given. |

Each task's tool returns a 1.6k-5.9k-token deterministic observation (`fixtures.ts`). The second turn
asks something only the first call's facts answer, so an artifact that dropped them fails it.

## What is counted

Billed tokens from the endpoint's own usage, never estimates. The parent's prompt tokens are the
context claim; the total, and its cost at the given prices, is the bill. A turn passes when its reply
holds every required fact, checked by string.

**The docs claim only what a run here shows.** If `routed` does not beat `inline` on success or cost,
the result is that routing pays only with a cheaper child model, or not at all.

## Results

Not yet run against a real endpoint. A dry run against a scripted local endpoint checked the
mechanics only (arms complete, children return artifacts, parent and child are counted apart); its
pass rates are meaningless because the scripted answers are canned.

The dry run also found a bug that had nothing to do with subagents: a compaction ladder whose stages
changed nothing emptied the turn's history (decision 14.73).
