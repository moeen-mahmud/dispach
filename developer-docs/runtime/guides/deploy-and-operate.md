# Deploy and operate

The shipped container runs the published Node 24 package as a non-root user. The process needs persistent storage for agents, stores, keys, and logs.

## Health checks

Use `/v1/ready` for traffic readiness. Local startup completes before channels and remote catalogues connect; inspect status and events for those integrations separately.

```bash
curl --fail http://localhost:7420/v1/ready
dispach status
dispach daemon logs
```

Do not expose a non-loopback server without `DISPACH_API_TOKEN`. Issue scoped keys to applications that should reach only one agent.

## Persistence and backups

Back up the complete Dispach home or the deployment volume while writes are quiesced. A useful backup includes manifests, workspace files, SQLite stores, secret environment files, and key material. Test restore into an isolated home before relying on the procedure.

## Isolation

The runtime policy controls which tool calls may execute. It does not replace container, VM, namespace, or host isolation. Choose the containment boundary from the trust relationship between tenants and from the system tools enabled for their agents.

## Upgrades

Read `CHANGELOG.md`, back up state, deploy one version of the runtime and client contract together, then check readiness and a representative detached turn. OpenAPI and event types are compatibility surfaces; event names are append-only within wire version 1.

For separate per-user containers, use the [control plane](../../control-plane/README.md) rather than building lifecycle management into the runtime process.
