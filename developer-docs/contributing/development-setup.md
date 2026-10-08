# Development setup

Dispach runs under Node 24 in production and uses Bun for dependency management, builds, linting, and tests.

## Prerequisites

- Node.js 24 or newer
- Bun
- Git
- Docker only for container and control-plane work

## Build a checkout

```bash
git clone https://github.com/moeen-mahmud/dispach.git
cd dispach
bun install
bun run build
```

The full build order matters because workspace packages import sibling `dist` output. A partial build can make the CLI execute stale provider code.

Run the repository gate used by the main CI job:

```bash
bun run lint
bun run build
bun run typecheck
bun run check:deps
bun test
bun run bench:boot -- --ci
bun run docs:check
```

## Link the CLI

```bash
cd packages/cli
bun link
cd ../..
dispach --version
```

The link points to `packages/cli/dist/index.js`. Rebuild after source changes; you do not need to link again.

Use a disposable home while developing commands that create or change agents:

```bash
DISPACH_HOME=/tmp/dispach-dev dispach init
DISPACH_HOME=/tmp/dispach-dev dispach run
```

This prevents tests and manual experiments from touching `~/.dispach`.
