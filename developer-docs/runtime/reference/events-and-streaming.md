# Events and streaming

Events use an append-only type catalogue within wire version `v: 1`. Each envelope includes its type, timestamp, agent scope, and type-specific data.

Common event families include:

| Prefix | Meaning |
| --- | --- |
| `runtime.*` | Startup and runtime state |
| `turn.*` | Acceptance, execution, completion, stop, or failure |
| `model.*` | Model request, reasoning, chunks, and response accounting |
| `tool.*` | Calls, results, policy decisions, and failures |
| `approval.*` | Human approval requested or resolved |
| `delivery.*` | Outbox and channel delivery state |
| `schedule.*` | Reconciliation and trigger state |
| `stream.*` | Subscription, replay, end, and availability metadata |

## Turn streams

`GET /v1/agents/:agentId/turns/:turnId/stream` is an SSE stream for one turn. Its preamble tells the client whether buffered events were replayed or truncated. `chunks=true` opts that connection into per-token model chunks.

Turn execution is detached from this connection. Reconnect with the same turn ID or read the stored turn resource.

## Runtime event stream

The server-wide event endpoint can filter by event type and authorized agent scope. Webhooks use the same event catalogue but deliver only webhook-eligible types.

In TypeScript, import `AnyEvent`, `EVENT_TYPES`, and narrowing helpers from `dispach/wire`, or consume the discriminated stream items returned by `dispach/client`.

The authoritative schemas and delivery rules are in the [wire specification](../../../docs/04-SPEC-WIRE.md). The current endpoint shapes are in the [generated HTTP API](../../reference/README.md).
