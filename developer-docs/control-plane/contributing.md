# Contributing to the control plane

Control-plane changes must preserve three boundaries:

1. Communicate with silos only through the public runtime API.
2. Keep runtime and control-plane imports separate in both directions.
3. Keep control-plane code out of the published `dispach` package.

The package runs directly under Node 24 and uses the repository's Bun, Biome, and TypeScript toolchain.

```bash
bun test packages/control
bun run --cwd packages/control typecheck
bun run check:deps
```

The fast tests use fake silos. Lifecycle, proxy isolation, backup, and real-image behavior require Docker:

```bash
docker compose build
bun run --cwd packages/control test:e2e
```

Build the runtime image from the same commit before the end-to-end test. Otherwise the test may exercise a cached registry image against new control-plane code.

Changes that add a lifecycle operation should cover busy-silo refusal, persistence behavior, authentication, and cleanup. Destructive operations must be explicit and must never report success after partial failure.

Review [`packages/control/LICENSE.md`](../../packages/control/LICENSE.md) before contributing; this package uses a different license from the Apache-2.0 runtime.
