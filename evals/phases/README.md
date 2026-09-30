# Phase-scoped tool visibility, measured — and the number is negative

Decision 4.8 puts phase scoping in **core** rather than in a plugin on the strength of a striking
published figure: constraining the tool space per phase took local models from 2/10 to 10/10 on a
benchmark subset with no model change. This repo had never measured it. `CLAUDE.md` is explicit —
never claim a performance property without a number in `evals/` — so here is the number, and it does
not say what the feature's rationale says.

```bash
bun run eval:phases                                   # uses MODEL_ID / MODEL_BASE_URL
bun run eval:phases -- --repeats 3 --model <id> --base-url <url>
```

## Method

Two arms over the same fixtures, same endpoint, same prompts:

| arm | catalogue |
| --- | --- |
| `full` | all 10 fixture tools, as an unphased agent sees it |
| `triage` | the 5 read tools plus `phase_set`, as a `triage` phase sees it |

Scored on the **24 of 37** tasks where both arms answer the same question: those whose correct first
step is a read tool, and those whose correct first step is no tool at all (`abstain`, `restraint`).
Write-expecting tasks are excluded, and the exclusion is the honest half — under phases those become
two-step problems (`phase_set`, then the tool), so scoring them against a single-step harness would
measure the harness. Three outcomes only: `correct`, `misrouted`, `critical`. Argument coercion is
orthogonal to how many tools were in front of the model, and folding it in would let a change in
field-filling move a figure about routing.

## Two runs — deepseek-v4-pro, 24 tasks, 1 repeat

| run | `full` | `triage` | delta |
| --- | --- | --- | --- |
| first | 87.5% | 75.0% | **−12.5pp** |
| second, after re-wording `phase_set`'s refusal guidance | 83.3% | 75.0% | **−8.3pp** |

**The constraint cost accuracy on this model, and the mechanism is visible.** Both arms fail the same
three `calendar_list_events` tasks. The `triage` arm adds three more, and every one is in the
**`restraint` group** — tasks whose correct answer is to call nothing:

```
triage, run 1:  email_search / phase_set / file_read   called when none was wanted
triage, run 2:  email_search ×2 / phase_set            called when none was wanted
```

Routing was not damaged; **abstention** was. One failure is a literal `phase_set` call on a task
needing no tool, which names the cause: being told you are in a narrow phase with more tools elsewhere
reads as an instruction to move. Two of the others are read tools present in *both* arms, so what
changed was not their availability but the framing around them.

**Re-wording did not fix it.** `phase_set`'s `whenNotToUse` now leads with "most turns" and states that
being in a narrow phase is not a reason to leave it. The `triage` arm did not move at all (18/24 both
times). The wording is kept because it is more accurate, not because it helped.

## Why this is not yet a result to act on

**The endpoint is not deterministic.** The `full` arm scored 21/24 and then 20/24 on identical runs at
`temperature: 0` — 4.2pp of run-to-run variance. This repo has recorded the opposite for a local
qwen endpoint, where two runs were byte-identical and `--repeats` measured nothing; a hosted MoE is not
that, and the lesson generalises the wrong way if only half of it is remembered. With n=24 and ~4pp of
noise, an 8pp difference is a signal to investigate, not a measurement.

**And this is the wrong population.** Decision 4.8's claim is about *small* models — the 2/10 → 10/10
figure is from local models, where the benefit of a smaller search space is supposed to outweigh the
cost of an extra decision. deepseek-v4-pro is a frontier model with no trouble routing over ten tools,
so the only thing this arm can show is the **cost** side. It shows it clearly.

`SMALL_MODEL_BASE_URL` was not configured when this ran. Until it is, the acceptance criterion in
`docs/05-PLAN.md` stays unticked.

## What would settle it

1. ~~A small model (`qwen3.5:9b` or below) through both arms, `--repeats 3`.~~ Done below, on a 3B.
2. Harder read tasks, so the `full` arm is not near its ceiling — a 24-task probe on which a frontier
   model scores 87% cannot show a benefit even if one exists.
3. A multi-step harness, so write-expecting tasks stop being excluded and the two-hop cost is measured
   rather than reasoned about.

## Four arms, and the small model — 2026-09-02

Two arms were added to isolate the mechanism the deepseek run suggested. Every extra failure under
`triage` was a restraint task and one was a literal `phase_set` call — so is the cost the *restriction*,
or its *advertisement*? `phase_set`'s summary reads "Other phases: act (adds 5 tools)". The new arms
vary only that:

| arm | catalogue | `phase_set` says |
| --- | --- | --- |
| `triage` | 5 read tools + `phase_set` | "Other phases: act (adds 5 tools)" |
| `triage-quiet` | 5 read tools + `phase_set` | nothing about other phases |
| `triage-locked` | 5 read tools | — no `phase_set` at all |

```bash
bun run eval:phases -- --model llama3.2:3b --base-url http://127.0.0.1:11434/v1 --temperature 0 \
    --out evals/phases/llama3.2-3b
```

### `llama3.2:3b` — local, temperature 0, one pass (`llama3.2-3b/results.json`)

| arm | correct | critical | restraint misses | accuracy | vs full |
| --- | --- | --- | --- | --- | --- |
| `full` | 10/24 | **6** | 5 | 41.7% | |
| `triage` | 17/24 | 0 | 4 | 70.8% | **+29.2pp** |
| `triage-quiet` | 17/24 | 0 | 4 | 70.8% | +29.2pp |
| `triage-locked` | 16/24 | 0 | 5 | 66.7% | +25.0pp |

**On the small model the sign flips, and the gain is where decision 4.8 said it would be.** Given all
ten tools, the 3B fired a mutating tool on **six** tasks that wanted none — `email_send` twice,
`calendar_create_event` twice, `notify_slack`, `file_write` — including a draft-not-send and a
no-recipient task. Under any triage arm it fired none, because the write tools were not in front of it.
Routing among the read tools was unchanged (the same `sql_query`-for-`file_read` miss in every arm),
and restraint was not improved: it still *reached* for a read tool on five or four of the restraint
tasks. What phases bought a small model is exactly the README's phrase from the first run — the
critical outcome made *structurally* impossible rather than merely unlikely — and it is worth 29
points here against −12.5 on the frontier model.

**Advertisement did not matter on the 3B.** `triage` and `triage-quiet` are identical to the task
(17/24, the same seven misses). `triage-locked` loses one more, a `code_review` reach on a review task.
So the escape-hatch mechanism the frontier run suggested is not visible at this size; whether it is real
on a frontier model is the question a frontier run of the two new arms would answer, and the only
frontier endpoint reachable today fails to produce NLT tool calls at all — see below.

The same warnings apply as to the first run: n=24, one pass, one small model. A local temperature-0
endpoint has been byte-deterministic here before, so repeats would not widen the sample; more tasks
would. The direction is unambiguous; the size of the effect is not.

### `gpt-5.6-luna`, native dialect — two passes (`gpt-5.6-luna-native/results.json`)

```bash
bun run eval:phases -- --model gpt-5.6-luna --base-url https://api.openai.com/v1 --api-key-env MODEL_API_KEY \
    --dialect native --temperature none --reasoning none --max-tokens none --repeats 2 --out evals/phases/gpt-5.6-luna-native
```

| arm | correct | critical | restraint misses | accuracy | vs full |
| --- | --- | --- | --- | --- | --- |
| `full` | 46/48 | **2** | 0 | 95.8% | |
| `triage` | 44/48 | 0 | 2 | 91.7% | −4.2pp |
| `triage-quiet` | 44/48 | 0 | 3 | 91.7% | −4.2pp |
| `triage-locked` | **48/48** | 0 | 0 | **100.0%** | +4.2pp |

**The exit, not the advertisement.** `triage` and `triage-quiet` are equal, and the misses are the same
shape in both: a literal `phase_set` call on `restraint-no-recipient` in every pass, plus `phase_set`
on a chain task that wanted a read first. Removing the sentence about what the other phase adds
changed nothing; removing `phase_set` itself removed every miss. On this model the agent reaches for
the *exit*, whatever it is told lies beyond it. That revises the first run's hypothesis — it was the
tool, not its summary.

**A restriction with no exit was never worse than the full catalogue, on any of the three models.**
`triage-locked` scored +4.2pp here, +25.0pp on the 3B, and both criticals in this model's `full` arm
(`notify_slack` fired first on `chain-query-then-notify`, both passes) are structurally impossible
under it. The honest half stays: the thirteen write-expecting tasks are excluded from every arm, and
under `triage-locked` they are not two-step but *impossible*. What these numbers say is that on the
tasks a read-only phase can answer, the phase costs nothing when it cannot be left and something when
it can.

Frontier caveats as before: n=24 × 2 passes, a hosted endpoint at its default temperature (`gpt-5*`
refuses any other), so the 4.2pp differences here are one task's worth and inside the noise this repo
has measured on deepseek. The locked arm's 48/48 is not one task's worth.

### `gpt-5.6-luna`, NLT — invalid, and kept (`gpt-5.6-luna/results.json`)

37.5% in all four arms, identical per-task pattern, two passes. **Not a phases result.** Under NLT this
model, with `reasoning_effort: none`, produced prose with no `ACTION:` syntax in any of 120
non-correct replies — several of them asking permission to search rather than searching. Every routing
task therefore scored "called nothing" and every abstain task scored correct, in all arms alike. Kept
because it is the cleanest demonstration this repo has that an NLT figure on a model that does not
write NLT measures the dialect and not the feature — the same trap `evals/tools` documents from the
other side — and because it is why `--dialect native` now exists.
