# Density: what an idle silo costs

Phase 25's question is whether a hosted product can exist at all. A silo is one `serve` process
holding one user's (or one team space's) agents. Nobody talks to most of them most of the time, so
the number that decides it is **what an idle silo costs to keep**.

```bash
bun run build
bun run eval:tenancy                                  # 1, 10, 100 agents, 3 runs each
# inside the image — measures the published tarball, not this checkout:
docker run --rm --entrypoint sh -v "$PWD/scripts:/repo/scripts:ro" \
  -v "$PWD/packages/core/src:/repo/packages/core/src:ro" -v "$PWD/evals/tenancy:/out" \
  ghcr.io/moeen-mahmud/dispach:latest \
  -c 'node /repo/scripts/eval-tenancy.ts --entry "$(npm root -g)/dispach/dist/index.js" --out /out'
```

## Method

- The agent is what `init --yes` generates: workspace files, the `system`, `web` and `composio`
  providers named, a starter skill, no channels. Copied N times with fresh ids into an empty sandbox.
- `serve` under Node 24, the shipped runtime. No model call is ever made.
- **Idle RSS** is the median of five samples a second apart, after ten seconds of quiet, so the
  post-readiness provider refresh is over. **Cold start** is spawn → `/v1/ready` 200, interpreter
  included. **Resume** is `SIGSTOP` for 2 s, then `SIGCONT` → `/v1/health` 200.
- Resume is an approximation of a platform suspend. A Fly suspend snapshots the whole VM and its
  restore time is Fly's. What this shows is that the process needs nothing re-established after a
  freeze before it serves again.

## Results — 2026-09-24, the image (`linux/arm64`, 4 vCPU, Node v24.21.0), 3 runs each

| agents in the silo | idle RSS | cold start → ready | resume after freeze |
| --- | --- | --- | --- |
| 1 | **104 MiB** | 118 ms | 6 ms |
| 10 | **120 MiB** | 151 ms | 6 ms |
| 100 | **178 MiB** | 516 ms | 5 ms |

Runs agreed within 2 MiB and 50 ms (`results.json` has every run). These are the figures after the
WhatsApp library was made lazy. The first measurement, the same day and before that change, was
116 / 143 / 195 MiB and 143 / 210 / 494 ms.

**The marginal agent is about 0.75 MiB. The silo is the cost.** About 104 MiB is spent before the
first agent: the plan's "~42 MB floor" is Node plus `node:sqlite` alone, and it was never the
runtime's figure. Measured by importing each package on its own under Node, before the change:

| loaded | RSS |
| --- | --- |
| `node` + `node:sqlite`, nothing else | 42 MiB |
| `@dispach/core` | 73 MiB |
| `@dispach/channel-whatsapp` on its own | 96 MiB, ~23 MiB of it the WhatsApp library |
| whole `serve`, bare manifest | 138 MiB (heap *used* 22 MiB, heap *reserved* 57 MiB) → **112 MiB lazy** |

Two levers:

- **Taken: the WhatsApp library is behind a dynamic import.** It always was in source, but the
  channel package built without splitting, so the library was inlined into its `dist` and reached
  the CLI bundle as a static import. Every `serve` paid for it whether or not any agent named a
  WhatsApp channel. The package now marks it external, the CLI bundle splits it into a chunk only
  `start()` reaches, and `cli/test/bundle.test.ts` asserts that from the built bundle.
- **Not taken: `NODE_OPTIONS=--max-semi-space-size=1`.** It took the bare `serve` from 138 to
  123 MiB before the change by shrinking V8's reserved young generation. That is an operator
  setting, and its effect on turn latency is unmeasured.

## What a silo costs per month

Prices as of 2026-09-24, excluding VAT. Fly from [docs.fly.io/about/pricing](https://docs.fly.io/about/pricing/),
Amsterdam at the 1.0× regional rate: shared-cpu-1x at 256 MB $2.02, 512 MB $3.31. A stopped or
suspended Machine pays only for rootfs, at $0.15/GB-month, and a volume costs $0.15/GB-month.
Hetzner from [costgoat.com](https://costgoat.com/pricing/hetzner) (dated 2026-09-05): CX23, 2 vCPU,
4 GB, IPv4 included, €5.49. Hetzner's own page did not render prices, and other aggregators still
show the pre-April-2026 €3.99. **Check both before quoting a price.**

**Fly, one Machine per silo, autosuspend.** Use 512 MB. The idle silo fits in 256 MB, but a turn has
no headroom there, and an out-of-memory kill mid-turn is the worst failure available. With the
image's ~0.7 GB rootfs and a 1 GB volume for `store.db`:

| share of the month the silo is awake | $/silo/month |
| --- | --- |
| 100% (never suspends) | $3.46 |
| 10% (~2.4 h a day) | **$0.58** |
| 2% (~30 min a day) | **$0.32** |

The formula is `3.31·f + 0.105·(1−f) + 0.15`. The plan's estimate was $0.35–0.50, and the measured
inputs agree with it at low activity.

**Hetzner, many silos per box, always on.** Allow 160 MiB per silo of 1–10 agents, and keep 0.8 GB
for the OS, Docker and turn spikes. That gives 20 silos on a CX23: **€0.27/silo/month**, with no
suspend and no waker. It is cheaper, but a silo shares a kernel with the others rather than getting
its own VM. That fits the threat model (decision 14.3): a process boundary per tenant, with
containment as a deployment concern.

**Verdict: not a negative result.** At pilot scale, a silo costs cents a month on either platform.
Model tokens are billed through BYOK and dwarf the cost of the silo. Model tokens, not hosting,
decide the price, which is why `10-BUSINESS.md` §4 sets the price as a base fee plus a charge per
active agent.

## Suspending safely — measured in the image

With a 2-minute `every` schedule and a mock endpoint, `/v1/activity` reported `nextWakeAt` equal to
the row's `nextRunAt`, jitter included:

- **Frozen across two boundaries, then woken** (`docker pause`, 5.5 min): the schedule fired
  **once** on wake, not once per missed boundary, and `nextWakeAt` moved to the next occurrence.
  This is the suspend path.
- **Stopped and started again past two boundaries**: nothing fired, and the next occurrence was
  scheduled. This is the documented catch-up policy for a recurring schedule (skip, count the
  misses; `schedule/kinds.ts`).
- **Stopped, then started 2 s after `nextWakeAt`**: that occurrence was **skipped** too, because boot
  treats it as downtime.

So a waker that **suspends** can wake at `nextWakeAt` or late, and the schedule fires once. A waker
that **stops** a Machine must start it **before** `nextWakeAt`, with enough margin for a cold start
(~0.5 s at 100 agents; allow seconds on a platform). If it starts the Machine late, that occurrence
is skipped. An `at` one-shot fires late in both cases.
