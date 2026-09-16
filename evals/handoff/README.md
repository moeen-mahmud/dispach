# evals/handoff — does delegation cost the parent fewer tokens?

Decision 10.2 justifies context-isolated sub-agents with that claim. Phase 10B's unit tests prove
the **isolation** — the supervisor's prompt contains the artifact and not the transcript, asserted
on a character count in `packages/core/test/team.test.ts` — which is a structural fact and not an
economic one. This measures the economic one.

```bash
bun run eval:handoff --manifest examples/team/agent.yaml
bun run eval:handoff --model <id> --base-url <url> --repeats 2
```

## Two arms, one task

| Arm | |
| --- | --- |
| `delegated` | A supervisor with two members. Hands out two self-contained sub-tasks, gets two validated artifacts, writes the answer itself. |
| `inline` | One agent, no team, same overall task with the same sub-tasks as explicit instructions. |

Same endpoint, same task, same expected output. What differs is where the intermediate work lives.

## The headline is the PARENT's prompt tokens, and the total is reported beside it

Delegation **moves** tokens rather than destroying them: the members pay for the work the parent no
longer carries. Whether the *total* falls depends on the members running a cheaper model, which is
a configuration choice rather than a property of the mechanism. The claim under test is about the
parent's context, because that is what runs out.

Verified against a local fixture endpoint, which showed exactly that shape — parent down 31.6%,
total up. If a run ever reports the total falling too, that is a fact about the model configuration
and should be read as one.

## It refuses to print a ratio of two estimates

The figure is read from the endpoint's own `usage.prompt_tokens` via `model.result`'s
`promptTokensReported` flag — never from `estimateTokens`, which `evals/budget` measured running
**16–20% low** on exactly the observation-heavy prompts a long inline conversation produces. An
estimated comparison would be biased in favour of the arm being advocated for. When any call
reports no usage the script says so and exits 1 rather than printing a percentage.

## Not yet run against a real endpoint

The script is verified end to end against a fixture; the number in `results.json` is whatever the
last real run produced, and there has not been one. One endpoint would be a **lead** rather than a
result in any case — `00-DECISIONS.md` records a hosted MoE moving 4.2pp between two identical runs
at temperature 0, so a single-run delta wants repeats and a second endpoint before it is a claim.
