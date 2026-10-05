# docker/

Reproduce, then verify — in that order, because the second step needs a running daemon and the
first does not.

```bash
docker build -f docker/Dockerfile -t dispach .
docker images dispach --format '{{.Size}}'
```

```bash
# Start → ready, hosting nothing. `--init` because `exec` backgrounds children and a
# backgrounded child whose parent is PID 1 has nothing to reap it.
docker run -d --name dispach-check --init -p 7420:7420 \
  -e DISPACH_API_TOKEN=pick-something \
  -v dispach-home:/home/dispach dispach
time (until curl -sf localhost:7420/v1/ready >/dev/null; do sleep 0.05; done)
curl -s localhost:7420/v1/ready                       # {"status":"ready","agents":0}
docker inspect --format '{{.State.Health.Status}}' dispach-check
docker rm -f dispach-check
```

**No agent is mounted and no manifest is named.** The CMD is a bare `serve`, which hosts every
enabled agent in the sandbox — none on a fresh volume. That is the supported first state: the API,
the web UI at `/` and the reference at `/docs` exist before there is anything to talk to, which is
what makes provisioning through them possible at all. An agent arrives either on a mount at
`/agent` (linked into the sandbox as `primary` by `entrypoint.sh`) or from `dispach init` inside
the container — one CMD, both shapes, and the mount is what decides rather than an argument that
has to agree with it.

The token is not optional: the image binds `0.0.0.0` (a process on loopback inside a container is
unreachable through a published port) and a non-loopback bind requires one by design.

`/v1/ready`, `/` and `/docs` need no token, which is the point — an orchestrator's probe cannot
hold one, and the moment a reference is most useful is before you have a credential. Anything else
does:

```bash
docker exec dispach-check dispach init --user you --name milo
docker restart dispach-check          # a bare `serve` reads the sandbox at start
curl -s -X POST localhost:7420/v1/agents/milo/messages \
  -H 'Authorization: Bearer pick-something' -H 'content-type: application/json' \
  -d '{"text":"say hello"}'
```

`init` leaves `MODEL_API_KEY=` empty in that agent's `.env` on purpose — filling it is step 1 of
what it prints. Until then the server **names the agent as not served and stays up**. It did not
always: one half-provisioned agent exited the host, and `restart: unless-stopped` made that a crash
loop which took the API and the page down with it, nine restarts deep, with a perfectly worded
message going to `docker logs`. A host does not get to fail because one of N agents is
misconfigured — the same reasoning that has `listAgents` show a broken directory rather than omit
it. A manifest **named on the command line** still refuses, because there the caller asked for that
agent by path and serving something else is the worse error.

## Measured

arm64 Docker Desktop, 2026-09-21, on the compose stack (`name: dispach`, so the container is
`dispach-server-1`):

| | |
| --- | --- |
| start → `/v1/ready` | under 1 s, hosting nothing |
| healthcheck | healthy, 0 restarts |
| agents at first boot | **0** — the state the server is designed to start in |
| web UI, `/docs`, `/v1/openapi.json` | 200, unauthenticated |
| store | `~/.dispach/store.db` on the volume, as uid 1000 |

Image size is re-measured by the CI `docker` job on every push. What CI measures on
`ubuntu-latest` is amd64; the figures above are arm64.

## Three things a real run found, none of them visible by reading

1. **`COPY tsconfig.json`** — there is no root `tsconfig.json`. Every package's tsconfig extends
   `tsconfig.base.json`, and that is the only root config the build needs. `biome.json` was being
   copied too and is not needed at all: it configures lint and format, neither of which an image
   build runs.
2. **`bun install` ran the root `prepare` script**, which is `husky`. In the production stage husky
   is a devDependency that is not installed, so the install died with `husky: not found` and exit
   127. Both installs pass `--ignore-scripts` now — a git-hooks installer has no business in an
   image build, and there is no `.git` in the build context for it to act on.
3. **The compose project name is the directory name.** Compose names a container
   `<project>-<service>-<n>` and derives the project from the checkout directory, so this ran as
   `dispach-agent-1` long after the rename — a stale brand that `git grep` could never find,
   because the string was in no file. `name: dispach` in `docker-compose.yml` is the fix, and it is
   the same class as the tracked-filename half of hard rule 3: a name that lives outside the tree.
