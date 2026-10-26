# Limits and evidence

What Dispach claims, where each number comes from, what it does not claim, and what it does not do.
Every public number has a row in
[`evals/CLAIMS.md`](https://github.com/moeen-mahmud/dispach/blob/main/evals/CLAIMS.md) naming the
committed file behind it. A number with no row is not used anywhere.

## What is measured

| Claim | Evidence | What it does not show |
| --- | --- | --- |
| Ahead of OpenClaw 2026.10.5 on all 11 models compared, level with or ahead of Hermes 0.19.0 on 8, cheapest of the three on 10 | [Benchmarks](benchmarks.md), [`evals/harness/`](https://github.com/moeen-mahmud/dispach/tree/main/evals/harness) | One benchmark of our own design: 25 tasks × 5 runs, each harness on its own defaults. Every Dispach–Hermes pair's 95% intervals overlap |
| Hermes scores higher on Gemini 4 Argon, qwen3.5-9b and gpt-oss-20b | Same | On qwen the intervals overlap widely, on gpt-oss only just |
| Native tool calls tie or beat NLT on all 13 models measured both ways | Same | qwen3.5-9b under NLT is paused part-way and not reported as a rate |
| NLT wins a single-call routing test (37 fixtures) | [`evals/tools/`](https://github.com/moeen-mahmud/dispach/tree/main/evals/tools) | No tool is executed; the qwen margin is one fixture. A published +14.9pp NLT result did not reproduce on multi-turn work here |
| With the settings floor, 0 of 167 protected writes were saved; the models attempted one in 65 | [preprint, arXiv 2610.06274](https://arxiv.org/abs/2610.06274) | The paper's runs, not committed here; a preprint, not peer-reviewed |
| Boot to `runtime.ready` in about 65 ms; CI fails above 1,200 ms | [`evals/boot/results.json`](https://github.com/moeen-mahmud/dispach/blob/main/evals/boot/results.json) | Boot, not response latency, on one machine |
| Memory retrieval: median 0.34 ms over 5,000 passages | [`evals/memory/`](https://github.com/moeen-mahmud/dispach/tree/main/evals/memory) | Lexical (FTS5); a paraphrase with no shared words is missed |
| An idle silo holds 104 / 120 / 178 MiB for 1 / 10 / 100 agents | [`evals/tenancy/`](https://github.com/moeen-mahmud/dispach/tree/main/evals/tenancy) | One machine |

## Negative results, kept

- **Phase-scoped tools cost 8.3–12.5pp** on deepseek-v4-pro, almost all of it on tasks whose right
  answer is to call nothing. The small-model arm has never been run.
- **A prompt-injection eval measures the model, not the gate**: 0 of 6 injected pages were obeyed,
  and the write gate never fired. The gate itself is proven by unit tests.
- **A model writing a shell script into `exec` damaged 25% of multi-line arguments** under NLT, half
  of them silently (`evals/nlt-heredoc/`).

## What it does not do

- **A policy is not a sandbox.** `tools.policy` decides whether a command runs. Where it runs is the
  deployment's job: a container, a VM. A shell can write anywhere the process can, whatever the
  write root says.
- **Plugins are trusted code**, in-process, with the runtime's privileges. `permissions` is
  documentation, not enforcement.
- **`web_fetch` does not defend against DNS rebinding.** It checks every address a name resolves to,
  but the HTTP client resolves again when it connects.
- **No telemetry.** The runtime reports nothing to anyone, so adoption is counted by asking people.
- **Nothing is hosted.** There is no cloud service and no trial environment; you run it.

## Status

- **Experimental in 0.2.0**, on the HTTP API only, never run against a real tenant or account: rooms,
  stand-ins and team memory, the Slack, Microsoft Teams and A2A channels, and media. These may change
  within 0.2.x.
- **Endpoints re-verified for 0.2.0:** DeepSeek's API and an open-weight model through OpenRouter. The
  benchmark reaches Claude, GPT and Gemini models through OpenRouter as well; OpenAI's and Anthropic's
  own endpoints were not re-run for this release.
- **Platforms:** macOS (launchd services) and Linux, including the container image. On Linux,
  `daemon install` writes a systemd user unit and prints the commands to start it. Windows has never
  been tested.
- **Plugin authoring needs a repository checkout.** The published package exports the HTTP client and
  the event types, not the plugin API.
- **One maintainer.** Issues are answered, but there is no team behind this yet.

## Licensing

The runtime, and everything published to npm, Homebrew and the container registry, is
**Apache-2.0**. One directory is different: `packages/control`, the control plane that places one
runtime per user, is **FSL-1.1-ALv2**. Anyone may use it, commercially too, except to offer a
competing hosted service, and each release becomes Apache-2.0 two years after it ships. It is never
published with the runtime, and the runtime imports nothing from it.
