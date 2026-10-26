# Spot check: a promise after a real write is a reply (decision 14.130)

NLT, the 10 single and chain tasks, 2 repeats, Grok 4.7, Kimi K3 and GPT-6 Luna: the models where the
14.123 nudge mattered. Run 2026-10-26 on an image built from the working tree of `release/0.2.1` with the
fix (`silenceOf` no longer flags a promise once a mutating tool succeeded), $0.31 in all.

| Model | This run | `sweep-4f3e00a`, same tasks |
| --- | --- | --- |
| Grok 4.7 | 8/20 | 20/50 |
| Kimi K3 | 12/20 | 22/50 |
| GPT-6 Luna | 10/20 | 27/50 |

Twenty runs per model detect a large regression and nothing finer. The two failures whose reply ends on
a promise made no tool call at all, so the nudge still applied to them; none is a save followed by a
promise, the case the fix lets through.
