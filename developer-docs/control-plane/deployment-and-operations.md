# Deployment and operations

The bundled deployment runs one control-plane container with access to the host Docker daemon.

```bash
export DISPACH_CONTROL_TOKEN="$(openssl rand -base64 32)"
export DISPACH_IMAGE="ghcr.io/moeen-mahmud/dispach:<version>"
docker compose -f packages/control/compose.yaml up -d --build
```

Pin the runtime image. The control plane stores one row per silo in SQLite and creates a persistent volume for each silo.

## Network and trust

The Compose deployment binds the control API to `127.0.0.1:7600`. Put authenticated TLS termination in front of it. Silos share a private Docker network and expose no host port.

The Docker socket grants host-root-equivalent control. Run the control plane only on a host you trust with that authority, never inside a tenant silo.

## Lifecycle operations

- `pause` and `backup` refuse with `409 silo_busy` while a turn, delivery, or proxy request is open.
- `recreate` replaces the container with the configured image and environment while preserving its volume.
- Backup pauses the silo for a crash-consistent archive and excludes read-only templates.
- Restore empties the volume before extraction so the result exactly matches the archive.

After changing `DISPACH_IMAGE` or named silo environment values, restart the control plane and recreate silos gradually. Retry busy silos instead of interrupting their active work.

## Suspension and monitoring

Set `DISPACH_CONTROL_SUSPEND=on` only when losing channel connectivity during idle periods is acceptable. The sweeper consults each runtime's activity endpoint and wakes before its next schedule.

Setting `DISPACH_CONTROL_HOOK_URL` enables the pilot monitor. It consumes signed runtime webhooks, measures rolling turn and tool-error rates, and alerts once on threshold crossing and once on recovery. Your deployment must allow silos to reach that hook URL.

The complete environment table and routes are maintained in [`packages/control/README.md`](../../packages/control/README.md).
