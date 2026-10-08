# Repository map

The monorepo separates the harness, its transports, and optional providers.

| Path | Responsibility |
| --- | --- |
| `packages/core` | Loop, context, tool contracts, memory, stores, schedules, plugins |
| `packages/server` | HTTP router, auth, SSE, WebSocket, and OpenAPI generation |
| `packages/client` | Typed remote client and stream state machine |
| `packages/cli` | Published `dispach` package, commands, and terminal UI |
| `packages/channel-*` | First-party channel transports |
| `packages/tools-*` | System, web, and external tool providers |
| `packages/web` | Browser application served by the server |
| `packages/control` | FSL-licensed, HTTP-only silo control plane |
| `docs` | Binding decisions, architecture, specifications, plan, and QA |
| `developer-docs` | Public GitBook source for users and contributors |
| `examples` | Runnable manifests and workspaces |
| `evals` | Fixtures, tasks, and committed evidence for performance claims |
| `scripts` | Builds, checks, benchmarks, evaluations, and release automation |

`packages/core` imports no sibling package. The dependency check also keeps the control plane isolated from the runtime in both directions.

Before changing behavior, read the decision log at `docs/00-DECISIONS.md`, find the current work in
`docs/05-PLAN.md`, and inspect any binding specification for the surface you are touching.
