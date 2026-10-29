# Claim register

Every number Dispach says in public, with the evidence behind it. A claim that is not here, or
is not `verified`, does not go in a README, a docs page, a release note or a post.

Statuses: **verified** (a committed file in this repo carries the number), **cite** (external
research, linked; not reproduced here), **needs-run** (true as far as we know, no committed
result yet), **fix** (the prose and the evidence disagree), **remove** (no evidence found).

## Harness head-to-head

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| Dispach native scores 125/125 on five of the eleven models compared with other harnesses, and 99–100% on eight of fourteen models | `evals/harness/summary.json`, `evals/harness/runs/sweep-4f3e00a/` (2026-10-23) | 25 multi-turn tasks × 5 repeats, tools executed, graded by final state | One benchmark of our own design | verified |
| Matches or beats Hermes 0.19.0 on 8 of 11 models, and costs the least of the three harnesses on 10 of 11 (level with Hermes on GPT-6.1 Sol) | `evals/harness/summary.json` | Same tasks, isolation and pinned providers for all three harnesses | Rival arms measured 2026-10-22/23, Dispach on 2026-10-23; the 95% intervals of every Dispach–Hermes pair overlap, gpt-oss-20b only just (70–84% against 82–93%) | verified |
| OpenClaw 2026.10.5 scores lowest on every model, 11–60 runs behind | `evals/harness/summary.json` | As above | Each harness on its own documented defaults | verified |
| Hermes leads on the small open models: qwen3.5-9b 112 vs 104, gpt-oss-20b 111 vs 97 | `evals/harness/summary.json` | As above | The qwen3.5-9b intervals overlap widely; the gpt-oss-20b ones only just | verified |

## Tool dialect (NLT vs native)

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| NLT ahead of native: qwen3.5:9b 94.6% vs 91.9%, deepseek-chat 97.3% vs 86.5%, deepseek-reasoner 91.9% vs 89.2% | `evals/tools/results.json`, `evals/tools/qwen-3pass/results.json` (2026-08-14) | 37 fixtures, one model call each, routing + argument coercion, temperature 0 | No tool is executed. The qwen margin is **one fixture**. qwen NLT has a 2.7% critical rate against native's 0.0% | verified |
| Native ties or beats NLT on every model on multi-turn tool work; NLT falls to 50–68% on Grok 4.7, Kimi K3, Gemma 4 26B-A4B and GPT-6 Luna | `evals/harness/summary.json`, `evals/harness/runs/sweep-4f3e00a/results.json` (2026-10-23) | 25 multi-turn tasks × 5 repeats per model, tools executed and graded by final state, pinned providers | One benchmark; qwen3.5-9b under NLT paused at 52 of 125 runs | verified |
| NLT uses 21–23% fewer prompt tokens | `evals/tools/results.json` | Same run | Prompt tokens only, not total cost | verified |
| +14.9pp accuracy, 93% fewer critical errors, −25% tokens; +24 to +43pp on small models | Somma, Plante & Premji, 2026 replication of Johnson et al. 2025, [arXiv 2607.03953](https://arxiv.org/abs/2607.03953), 14 models, 8,560 trials | External | Preprint. Frontier models (GPT-5, Gemini 2.5 Pro) show smaller or reversed gains. Our own eval cannot test the critical-error claim. **Not reproduced on multi-turn work:** in `evals/harness/runs/sweep-552660a/`, native tied or beat NLT on 13 of 14 models, NLT 37–62% on five | cite |
| Decision 4.1's local deltas | `evals/tools/results.json` | — | 4.1 now quotes the committed +10.8 / +2.7pp and says the earlier +13.5 / +5.4pp run was overwritten | verified |

## Phase-scoped tools

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| Constraining tools per phase took local models from 2/10 to 10/10 | None found in the repo or in a search | — | Decision 4.5 now names it as unsourced motivation beside the negative local result. Never quoted publicly | remove |
| On deepseek-v4-pro, phase scoping **cost** 8.3–12.5pp | `evals/phases/results.json` | 24 of 37 tasks, 1 repeat, two runs | Frontier model only; the small-model arm has never been run. Run-to-run noise was 4.2pp | verified (negative) |

## Boot and runtime

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| Boot to `runtime.ready` under 1000 ms, CI fails at 1200 ms | `scripts/bench-boot.ts:18`, `.github/workflows/ci.yml` | Every CI run | Boot, not response latency | verified |
| Boot to ready ~65 ms (0.2.0; ~53 ms at 0.1.3) | `evals/boot/results.json` (`bench:boot --write`) | 7-run median, Apple M4 Pro, bun, load average recorded | Boot, not response latency. One machine | verified |
| Container image 867 MB | `docker image inspect`, 2026-10-20; re-measured on every push by the `image size` step in `.github/workflows/ci.yml` | arm64 Docker Desktop, 0.2.0 release candidate | 701 MB at 0.1.3; the static `ffmpeg` layer is 104 MB. Reported by CI on every push, no longer gated | verified |
| `Runtime.create` 20.6 ms | `evals/boot/results.json` (`createMs`) | Same run as boot | — | verified |
| Importing Ink and React costs ~170-210 ms under Node, so no shared CLI path imports them | `packages/cli/test/boundaries.test.ts` (structural guard); measured in decision 11.5 prose | Node 24, Apple M4 Pro | The guard is structural; the figure is from one machine and not re-measured by CI | needs-run |
| `docker compose up -d --wait` reaches healthy in about six seconds; 26 `model.chunk` frames in the first streamed turn | README `## Docker` prose, measured by hand 2026-10-20 | arm64 Docker Desktop, 0.2.0 | Dominated by the first healthcheck probe interval; the frame count is one DeepSeek reply | needs-run |
| Image size breakdown: 110 MB Debian, 160 MB Node, 158 MB apt (git 92 MB), 47 MB uv, 58 MB package | `docker history` by hand, 2026-10-20 | arm64, 0.2.0 | Not re-measured by CI (only the total is) | needs-run |
| An earlier run at load average ~5 measured 91 ms boot | Hand-recorded beside `evals/boot/results.json`, superseded by the committed run | Same machine | Illustrates load sensitivity only | needs-run |
| A remote provider's post-ready refresh takes ~1.5 s, so awaiting it in boot would multiply boot | Decision 4.21 prose only (1,474 ms) | Composio, one cold cache | No committed result | needs-run |
| The gateway Dispach replaced blocked for minutes on network calls during hook initialisation | None committed | OpenClaw gateway on our deployment | The README now says "observed, not measured" and gives no number; a figure needs the log evidence | needs-run |
| Idle silo: 104 / 120 / 178 MiB RSS and 118 / 151 / 516 ms cold start for 1 / 10 / 100 agents; resume 5–6 ms | `evals/tenancy/results.json` (2026-09-24) | linux/arm64 image, Node 24 | One machine | verified |

## Prompting, context and memory

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| One emphatic framing line lifts qwen3.5:9b all-rules compliance by 20pp; deepseek-chat unchanged | `evals/prompt-style/results-intensity-6rules.json` | 6 rules, 20 tasks | p≈0.16; the whole lift comes from one rule (`digits`) | verified |
| Example placement (system vs user) makes no difference | `evals/prompt-style/results.json` | Same | Saturated at 100% in both arms: "no difference at this difficulty", nothing more | verified |
| Rule compliance: deepseek-v4-pro saturated at 64/64 | `evals/rules/README.md` | 1–6 rules | Saturated | verified |
| Rule compliance on a small model | `evals/rules/results.json` holds a qwen3.5:9b run at 0.990; the README says no run finished | — | Which is current is not recorded; the README now says so. Neither is quoted | needs-run |
| Token-estimate correction: mean error 14.2% uncalibrated, 2.9% with the shipped EMA | `evals/budget/results.json` | deepseek-v4-pro, 31 turns | One endpoint | verified |
| A model writing a shell script into `exec` damages 25% of multi-line arguments, half silently | `evals/nlt-heredoc/results.json` (2026-09-13) | deepseek-chat, 8 tasks × 2 | A floor on the problem, one endpoint; the backstop false-repairs about a third | verified |
| Memory retrieval: median 0.34 ms, slowest 3.7 ms over 5,000 passages | `evals/memory/results.json` | No model; FTS5 candidates scored in `rank/bm25.ts` | One machine | verified |
| Skill-index scan, 50 skills: cold well under the 50 ms criterion, warm under 5 ms | `evals/skills/results.json` | bun, macOS arm64 | Cold varies with load (5–11 ms measured); quote the criterion, not a point | verified |

## Safety and agents

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| Prompt injection via a fetched page: 0 of 6 cases executed | `evals/web/results.json`, `evals/web/native/results.json`, `evals/web/flash/results.json` (2026-08-15) | deepseek-v4-pro (NLT and native), deepseek-v4-flash | Measures the **model**: the write gate never fired. The gate is proven by `trust.test.ts`, not by this eval. No small model was run | verified |
| Agent scenarios: 4 of 4 pass | `evals/scenarios/example/results.json` (2026-09-27) | deepseek-v4-pro judged by deepseek-v4-flash | Only 2 runs | verified |
| Delegation cuts the parent's prompt by 31.6% | Fixture-only run, no `results.json` | — | Never run against a real endpoint; total tokens went **up** | needs-run |
| Routing bulk tool work to a subagent pays for itself | `evals/subagents/results.json` is a dry run against canned answers | — | The README says so: mechanics only, pass rates meaningless | needs-run |

## Self-configuration

| Claim | Evidence | Scope | Limitation | Status |
| --- | --- | --- | --- | --- |
| With the settings floor, 0 of 167 protected writes were saved, though the models attempted one in 65 of those cases | Hossain and Mahmud, 2026, *What May an Agent Change About Itself? A Containment Floor for Self-Configuring Agent Runtimes*, [arXiv 2610.06274](https://arxiv.org/abs/2610.06274); the floor is `floorRefusal` in `packages/tools-system/src/config.ts` | The paper's own runs, with the floor on and off | Preprint, not peer-reviewed. The runs are not committed in this repo, so the number is the paper's | cite |

## Reproducing

Every `verified` row names its file. The command that produced it is in that directory's
`README.md`. A claim whose evidence changes gets its row updated in the same commit.
