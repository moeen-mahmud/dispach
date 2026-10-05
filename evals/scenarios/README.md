# Scenario evals — layer 2

A real agent, a real model, **mocked tools**, and a judge. The packages' own tests are layer 1
(the machinery against a fake endpoint). This layer answers whether *this agent, with this prompt,
on this model*, does the job.

```bash
JUDGE_BASE_URL=https://api.deepseek.com/v1 JUDGE_MODEL=deepseek-v4-flash JUDGE_API_KEY_ENV=MODEL_API_KEY \
  bun run eval:scenarios evals/scenarios/example --runs 3 --threshold 0.8
```

A suite is a directory: `suite.yaml` (the agent, its mocked tools, calibration cases) and
`scenarios/*.yaml` (one conversation each). A step has a `prompt`, the `expected_calls` checked
against the call log (`in_order`, `exact`, or `any_order`; an empty `exact` means no tool at all),
up to four **binary** `criteria`, and the `mocks` its tools return. Details are in
`scripts/eval-scenarios.ts`.

**The rules:**
- The model is never mocked, only its tools.
- What code can decide (which calls, which arguments), code decides.
- The judge is a different model, answers pass or fail per criterion, and is calibrated on
  known cases before anything is scored.
- A scenario's result is a pass count over runs ("4 of 5"). One below the threshold fails the run.
- **Prompt changes are deploys.** Rerun a template's suite before changing its prompt, its
  workspace or its model.
- A labelled failure from real use becomes a new scenario.

## `example/` — 2026-09-27, deepseek-v4-pro judged by deepseek-v4-flash, 2 runs

| scenario | result |
| --- | --- |
| calendar-today | 2 of 2 |
| email-send | 2 of 2 |
| no-tool-needed | 2 of 2 |
| follow-up | 2 of 2 |

Proven able to fail. With the dentist removed from the calendar mock, *"Mentions the dentist at
15:30"* failed. With the expected recipient changed to `bob@example.com`, the call check failed and
named both addresses. A judge set to the agent's own model is refused.
