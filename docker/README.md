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
  -v "$PWD/examples/minimal:/agent" -v dispach-state:/state dispach
time (until curl -sf localhost:7420/v1/ready >/dev/null; do sleep 0.05; done)
docker inspect --format '{{.State.Health.Status}}' dispach-check
docker rm -f dispach-check
```

`examples/minimal` needs `MODEL_API_KEY` and friends — pass them with `--env-file
examples/minimal/.env`, or point `/agent` at any manifest whose keys you have.

## What is unverified

Every number above. No image has been built from this Dockerfile: the machine it was written on had
no Docker daemon running, so image size, start-to-ready and the mounted-manifest path are all
written and unmeasured.

Three things are the most likely to be wrong, in the order worth checking:

1. **The workspace `bun install --frozen-lockfile` in a stage that has only the manifests.** Bun's
   workspace resolution wants every workspace `package.json` present, which is why each is copied
   individually — a missed one fails the install with a message about a missing workspace rather
   than about the copy.
2. **`--production` dropping something the runtime needs.** Checked rather than left on the list:
   `ink` and `react` are in `packages/cli`'s `dependencies`, and only `@types/react` and
   `ink-testing-library` are dev — so the lazy `import("ink")` survives. Worth re-checking if a
   dependency ever moves, because `serve` never takes the rich path and a container would therefore
   not notice.
3. **The healthcheck's `bun -e`.** It exits non-zero on a non-2xx *and* on a connection refusal, so
   a container that has not bound yet reads as unhealthy until `start-period` elapses. That is the
   intended behaviour; what is worth confirming is that `start-period` is long enough on a cold
   volume, where the measured 53 ms of in-process boot is not the number that matters.
