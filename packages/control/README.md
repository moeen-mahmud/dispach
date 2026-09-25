# Dispach Control

The control plane for Dispach silos, in `packages/control` of the Dispach repository. One person signs up
to your product, and a silo exists for them: a Dispach runtime holding their agents, placed,
routed, keyed, suspended when idle and woken when a message arrives or a schedule comes due.

A silo is one runtime per user or per team space (decision 14.1 in `docs/00-DECISIONS.md`). This process decides
where silos run and when they sleep. Everything inside a silo — agents, conversations, who a key
may reach — is the silo's own business, asked over `/v1` like any other client. This package
imports nothing from the runtime, and nothing in the runtime imports it; `bun run check:deps`
enforces both directions.

**Licence: this package only is [FSL-1.1-ALv2](LICENSE.md).** You may use it for anything,
including commercially inside your own product, **except** to offer a competing hosted service.
Each release becomes Apache-2.0 two years after it is published. Everything else in this repository,
the runtime included, is Apache-2.0 and stays so. `verify:package` checks that no code from here
reaches the runtime's npm tarball.

## Run it

Needs Node 24+ and a Docker daemon it may use. Nothing is built; Node runs the TypeScript directly.

```bash
export DISPACH_CONTROL_TOKEN="$(openssl rand -base64 32)"
node packages/control/src/main.ts                                    # http://127.0.0.1:7600

curl -s -H "Authorization: Bearer $DISPACH_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"subject":"user_42"}' localhost:7600/v1/silos
# → 201 {"subject":"user_42","status":"running",…,"created":true}      ~240 ms to ready

curl -s -H "Authorization: Bearer $DISPACH_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"label":"user_42 app"}' localhost:7600/v1/silos/user_42/keys
# → 201 {"keyId":"…","secret":"…"}      minted by the silo itself; shown once

# From here on, the silo's own API, through the proxy, with that key:
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"template":"support","name":"Helper","vars":{"apiKey":"sk-…"}}' \
  localhost:7600/silos/user_42/v1/agents
curl -sN -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"hello","stream":true,"chunks":true}' \
  localhost:7600/silos/user_42/v1/agents/helper/messages
```

Templates come from `DISPACH_CONTROL_TEMPLATES`, a host directory mounted read-only into every
silo, in the runtime's template format (`docs/09-API-GUIDE.md` §1b).

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /v1/health` | open | `{status, silos}` |
| `POST /v1/silos` `{subject}` | operator | Create the subject's silo. Idempotent: `201` new, `200` existing |
| `GET /v1/silos` | operator | Every silo: subject, status, created, last active, next wake |
| `GET /v1/silos/:subject` | operator | One silo |
| `POST /v1/silos/:subject/pause` | operator | Pause now. `409 silo_busy` while a turn, a delivery or a proxied request is open |
| `POST /v1/silos/:subject/wake` | operator | Wake now |
| `POST /v1/silos/:subject/recreate` | operator | New container, current image and `SILO_ENV`, same volume. How an upgrade rolls out. `409` while busy |
| `GET /v1/silos/:subject/backup` | operator | The silo's data as tar.gz, taken paused (crash-consistent) and left paused. Templates excluded. `409` while busy |
| `PUT /v1/silos/:subject/backup` | operator | Restore that archive into this silo, **replacing** everything in it, keys included |
| `DELETE /v1/silos/:subject` | operator | Remove the silo **and its volume**. Irreversible: it holds the silo's only store |
| `POST /v1/silos/:subject/keys` | operator | Mint a key inside the silo; the body is the runtime's `POST /v1/keys` (label, scope, expiry) |
| `GET /v1/usage?by=&from=&to=` | operator | Each silo's `GET /v1/usage`, side by side |
| `ANY /silos/:subject/v1/…` | a silo key | The silo's own `/v1`, woken first if paused, streamed through |

**Operator** means `Authorization: Bearer $DISPACH_CONTROL_TOKEN`. A silo key is refused on operator
routes, and the operator token is refused by every silo.

## What holds

- **A silo's credential reaches nothing in another silo.** The proxy forwards the caller's
  `Authorization` header and adds nothing — not the silo's token, not the operator's — so each silo
  authenticates its own keys, and a key from one is unknown to every other. An unknown subject gets
  the runtime's own `401` body, byte for byte, so the proxy is no way to learn which subjects exist.
  All of this is asserted end to end against the real image (`test/e2e.test.ts`).
- **A request with no credential never wakes a silo.** It cannot succeed, so it must not cost a silo
  its sleep.
- **A silo is paused only when it says it is idle.** The runtime's `GET /v1/activity` reports
  whether a turn is running or a delivery is owed. This process adds only what the silo cannot
  know: whether a proxied request is still open (a streaming turn holds its silo awake), and how long
  it has been quiet (`IDLE_MS`).
- **A paused silo is woken before its next schedule**, `WAKE_MARGIN_MS` ahead of the `nextWakeAt` it
  reported when paused, and kept awake at least `IDLE_MS`, so the schedule fires inside a running
  process. This is the path `evals/tenancy/` measured to fire exactly once.
- **Every silo's token lives in this process's database and nowhere a route can return.**

## Measured — 2026-09-24, Docker Desktop on an M-series Mac, the runtime's current image

`bun run test:e2e`, run twice, with a mock model endpoint on the same host, so these are the control
plane's and runtime's own costs. A real model adds its own first-token latency on top.

| | run 1 | run 2 |
| --- | --- | --- |
| create → ready | 241, 250 ms | 239, 236 ms |
| first token, silo awake | 22, 6, 7 ms | 19, 8, 6 ms |
| **first token, silo paused → woken by the message** | **59, 64, 72 ms** | **60, 56, 71 ms** |

Waking a paused silo costs about **60 ms** before the first token. An idle silo costs 104–120 MiB
of RAM, paused or not (`evals/tenancy/`), so on a packed host a pause saves CPU, not
memory.

## Where silos run

`Placer` (`src/placer.ts`) is the whole of the cloud-agnosticism: create, pause, wake, remove,
address. v0 has one driver, **Docker**, which is also the AWS path: many silos on an EC2 Graviton
host, `docker pause` as suspend. Each silo publishes its port on `127.0.0.1` only. When this process
runs in a container on the same network, set `DISPACH_CONTROL_NETWORK` instead, and silos are reached
by name with no port published. A driver that *stops* silos rather than pausing them (Fargate) would
have to start them before `nextWakeAt`, because a runtime that starts after an occurrence skips it.

## Deploy on one host

```bash
export DISPACH_CONTROL_TOKEN="$(openssl rand -base64 32)"
export DISPACH_IMAGE=ghcr.io/moeen-mahmud/dispach:<version>      # pin it; a note says so if you do not
docker compose -f packages/control/compose.yaml up -d --build
```

The control plane runs in its own container (this package's `Dockerfile`: Node, the Docker CLI,
`src/`), and drives the host's Docker through its socket. Silos join the `dispach-silos` network and
publish no port; the control plane's `127.0.0.1:7600` is the only way in, so put TLS in front of it.
That is also the AWS shape: the same compose file on an EC2 host.

**Operating it:** see `EMBEDDING.md` for what a product's backend calls through a user's life —
sign-up, agents, messages, webhooks, billing, backup, upgrade, deletion.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DISPACH_CONTROL_TOKEN` | — (required) | The operator token |
| `DISPACH_CONTROL_HOST` / `_PORT` | `127.0.0.1` / `7600` | Bind |
| `DISPACH_CONTROL_DB` | `control.db` | SQLite file: one row per silo |
| `DISPACH_CONTROL_IMAGE` | `ghcr.io/moeen-mahmud/dispach:latest` | Pin a version in production; roll a new one out with `recreate` |
| `DISPACH_CONTROL_TEMPLATES` | — | Host directory of agent templates, mounted read-only. A path on the Docker host |
| `DISPACH_CONTROL_SILO_ENV` | — | Names of variables every silo gets, copied from this process's environment: `DISPACH_WEBHOOK_ALLOW,MODEL_BASE_URL`. Values never in the database, never on a command line; a named one that is unset refuses the boot. Reaches existing silos on `recreate` |
| `DISPACH_CONTROL_NETWORK` | — | Docker network to attach silos to |
| `DISPACH_CONTROL_IDLE_MS` | `60000` | Quiet time before an idle silo is paused |
| `DISPACH_CONTROL_WAKE_MARGIN_MS` | `30000` | How early a silo is woken for a schedule |
| `DISPACH_CONTROL_SWEEP_MS` | `5000` | How often the pause/wake pass runs |

## Not in v0, deliberately

- **WebSocket proxying.** The SSE routes carry the same events.
- **More than one instance.** Single process, one SQLite file. The in-memory "request open" count
  is what stops a pause mid-stream, so two instances would each think the other's streams were
  idle.
- **Backups on a schedule.** `GET …/backup` is a call to make from cron or your job runner; this
  process does not keep copies of its own.
- **Usage without waking.** `GET /v1/usage` wakes paused silos to ask them. A silo's figures cannot
  change while it sleeps, so a snapshot taken at pause is the fix once the silo count makes waking
  costly.
- **Rate limits in front of the proxy.** Anyone who knows a subject can wake its silo with a wrong
  key (then gets `401`). Keep the proxy behind your backend, or rate-limit it, until this grows a
  limit of its own.
- **Billing, SSO, sign-up, team spaces.** Your product owns people (decision 14.2); a subject
  is your opaque id for one of them.

**Trust:** the Docker socket is root on its host. This process holds it, so it belongs on a host
you would give root to, never in a silo.

## Develop

From the repository root; the package shares the workspace's Bun, Biome and TypeScript.

```bash
bun test packages/control                        # fast: fake silos
bun run --cwd packages/control test:e2e          # real Docker, the real image; cleans up after itself
bun run --cwd packages/control typecheck && bun run check:deps
```

The e2e runs against whatever `ghcr.io/moeen-mahmud/dispach:latest` the local daemon has, so
`docker compose build` first tests this commit's runtime against this commit's control plane.
