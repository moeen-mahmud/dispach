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
- Resume is `docker pause`/`unpause` in effect: the cgroup freezer, which is what the control
  plane's Docker driver does. A platform that snapshots a whole VM has its own restore time, which
  is the platform's. What this shows is that the process needs nothing re-established after a
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

**The control plane is cloud-agnostic** (decision 14.12). It places silos through one `Placer`
interface, and v0's only driver is Docker, which runs the same on a laptop, an EC2 host or any VM.
So the cost is decided by a *shape*, not a vendor: many silos packed onto a host, or one VM or task
per silo. The measurement above is of a process and holds for either.

Sizing: budget **130 MiB per silo** of 1–10 agents (idle 104–120 MiB plus headroom for a turn), and
keep 0.8 GB of each host for the OS, Docker and turn spikes. **A paused container keeps its memory**,
so on a packed host suspending saves CPU and not RAM. RAM decides how many silos fit, and every
silo, awake or not, occupies its slot.

### AWS — the target for the hosted product

Prices as of 2026-09-24, us-east-1, on-demand, Linux:

- **EC2**: t4g.medium (2 vCPU, 4 GiB) $0.0336/h = $24.53/mo; t4g.large (8 GiB) $49.06/mo
  ([Vantage](https://instances.vantage.sh/aws/ec2/t4g.medium)).
- **Storage and addresses**: gp3 $0.08/GB-month ([AWS](https://aws.amazon.com/ebs/pricing/)); a
  public IPv4 $0.005/h = $3.65/mo, one per host. That IPv4 price was not re-checked today.
- **Fargate ARM**: $0.03238 per vCPU-hour and $0.00356 per GB-hour
  ([AWS](https://aws.amazon.com/fargate/pricing/); its table prints per-second rates under an
  "hour" heading).

**EC2 Graviton host, silos packed with the Docker driver: the chosen shape.**

| host | $/month (instance + 20 GB gp3 + IPv4) | silos at 130 MiB | **$/silo/month** |
| --- | --- | --- | --- |
| t4g.medium, 4 GiB | $29.78 | 25 | **$1.19** |
| t4g.large, 8 GiB | $54.31 | 56 | **$0.97** |

- **CPU credits:** t4g instances are burstable, with a 20–30% baseline per vCPU. An idle or paused
  silo spends nothing, and a turn mostly waits on the model endpoint. A host with many busy silos
  can run out of credits, though, and in `unlimited` mode that is billed. Watch `CPUCreditBalance`.
- **Reserved or Savings Plan pricing** takes roughly a third off these figures. It isn't counted
  here.

**Fargate, one task per silo, for comparison.** The smallest ARM task is 0.25 vCPU and 0.5 GB, which
comes to $0.009875/h:

- **Always on: $7.21/silo/month.**
- **Stopped when idle, awake 10%: ~$0.72**, plus EFS for `store.db`, because a task's disk does not
  survive a stop.
- **What stopping costs you:** Fargate has no pause, so "suspend" is a stop and a cold start of tens
  of seconds. A stopped silo also skips a recurring schedule due while it was down (below), unless
  core gains a boot grace window. Not the chosen shape.

### Reference points

- **Hetzner CX23**, 4 GB, €5.49 with IPv4 ([costgoat.com](https://costgoat.com/pricing/hetzner),
  dated 2026-09-05; other aggregators still show the pre-April-2026 €3.99): 25 silos at 130 MiB,
  **€0.22/silo/month**.
- **A microVM platform that bills a suspended VM only for its disk** (Fly Machines:
  [$3.31/mo](https://docs.fly.io/about/pricing/) for 512 MB awake, $0.15/GB-month suspended):
  $0.32–0.58/silo/month at 2–10% awake. This is the one shape where suspending saves memory as well
  as CPU, at the price of a VM per silo.

**Isolation** is the same in every packed shape: a silo shares a kernel with its neighbours. That
fits the threat model (decision 14.3): a process boundary per tenant, with containment as a
deployment concern. A VM per silo is a driver choice, not a runtime change.

**Verdict: not a negative result.** On the AWS shape a silo costs about a dollar a month, and the
agents inside it cost cents each. Model tokens are billed through BYOK and dwarf both. That is why
`10-BUSINESS.md` §4 prices the product as a base fee plus a charge per active agent.

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

So a driver that **pauses** can wake at `nextWakeAt` or late, and the schedule fires once. This is
the Docker driver. A driver that **stops** a silo, as Fargate would, must start it **before** `nextWakeAt`, with enough margin for a cold start
(~0.5 s at 100 agents; allow seconds on a platform). If it starts the silo late, that occurrence
is skipped. An `at` one-shot fires late in both cases.
