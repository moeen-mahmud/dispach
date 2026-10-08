# Configuration

`agent.yaml` is the declarative source for an agent. The loader rejects unknown or invalid values and reports a corrective hint.

| Area | Controls |
| --- | --- |
| `model` | Roles, model IDs, endpoints, key environment names, capabilities, and dialect |
| `context` | Workspace tiers, budgets, soul selection, examples, knowledge, and prompt style |
| `tools` | Pinned providers and tools, policy, untrusted-write behavior, and provider settings |
| `phases` | Per-phase instructions, transitions, and visible tools |
| `limits` | Steps, duration, context thresholds, output reserve, and concurrency |
| `memory` | Store and retrieval behavior |
| `schedules` | Cron, interval, and one-shot inbound triggers |
| `channels` | Transport configuration and inbound allowlists |
| `delivery` | Outbound routing and retry behavior |
| `plugins` | Packages loaded at boot and their configuration |
| `server` | HTTP binding and server behavior for the agent runtime |

Use the CLI field catalogue when possible:

```bash
dispach config list milo
dispach config set milo model.main.id gpt-4.1-mini
dispach validate milo
```

Secrets are values in the environment; configuration stores only their variable names. Plugins resolve at boot, and the runtime never installs packages on demand.

The authoritative field-by-field contract is [docs/02-SPEC-MANIFEST.md](../../../docs/02-SPEC-MANIFEST.md). Workspace configuration is specified separately in [docs/07-SPEC-WORKSPACE.md](../../../docs/07-SPEC-WORKSPACE.md). Use [`examples/reference/agent.yaml`](../../../examples/reference/agent.yaml) as the current full example.
