# docker/

Reproduce, then verify — in that order, because the second step needs a running daemon and the
first does not.

```bash
docker build -f docker/Dockerfile -t dispach .
docker images dispach --format '{{.Size}}'            # Phase 11 target: under 150 MB
```

```bash
# Start → ready. The target is under 2 s including container overhead.
docker run -d --name dispach-check -p 7420:7420 \
  --env-file examples/minimal/.env \
  -e DISPACH_API_TOKEN=pick-something \
  -v "$PWD/examples/minimal:/agent" -v dispach-state:/state dispach
time (until curl -sf localhost:7420/v1/ready >/dev/null; do sleep 0.05; done)
docker inspect --format '{{.State.Health.Status}}' dispach-check
docker rm -f dispach-check
```

The token is not optional: the image binds `0.0.0.0` (a process on loopback inside a container is
unreachable through a published port) and a non-loopback bind requires one by design.

`/v1/ready` needs no token, which is the point — an orchestrator's probe cannot hold one. Anything
else does:

```bash
curl -s -X POST localhost:7420/v1/agents/minimal/messages \
  -H 'Authorization: Bearer pick-something' -H 'content-type: application/json' \
  -d '{"text":"say hello"}'
```

## Measured

arm64 Docker Desktop, 2026-09-14:

| | |
| --- | --- |
| image | **83 MB** (target: under 150 MB) |
| start → `/v1/ready` | **147 ms** (target: under 2 s) |
| healthcheck | healthy |
| a real turn | round-tripped against DeepSeek through `POST /v1/agents/:id/messages` |
| store | written to `/state` as uid 1000 |

The CI `docker` job rebuilds and re-measures the first two on every push. One number is unverified
and stays that way here: amd64. The image is not multi-arch (a Phase 11 non-goal), so what CI
measures on `ubuntu-latest` is the amd64 figure and what is above is arm64.

## Two things the first build found

Both were wrong in the Dockerfile and invisible without a daemon, which is the argument for the CI
job rather than for more careful reading.

1. **`COPY tsconfig.json`** — there is no root `tsconfig.json`. Every package's tsconfig extends
   `tsconfig.base.json`, and that is the only root config the build needs. `biome.json` was being
   copied too and is not needed at all: it configures lint and format, neither of which an image
   build runs.
2. **`bun install` ran the root `prepare` script**, which is `husky`. In the production stage husky
   is a devDependency that is not installed, so the install died with `husky: not found` and exit
   127. Both installs pass `--ignore-scripts` now — a git-hooks installer has no business in an
   image build, and there is no `.git` in the build context for it to act on.
