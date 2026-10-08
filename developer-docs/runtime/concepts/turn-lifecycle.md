# Turn lifecycle

Every inbound message follows the same path whether it came from HTTP, a channel, or a schedule:

```text
resolve agent and session
  -> assemble budgeted context
  -> call the model
  -> parse and validate tool calls
  -> execute allowed tools
  -> append observations and repeat
  -> deliver through the idempotent outbox
  -> persist the result
```

## Acceptance and execution

The HTTP message endpoint returns `202` after the turn has been accepted. Execution continues independently. The runtime records lifecycle and tool events while the turn is live and persists its final status and text.

Limits in the manifest bound steps, time, output, and context pressure. When context approaches its threshold, the harness applies progressive compaction rather than waiting for one emergency summary. Pinned instruction blocks survive every stage.

## Completion

A caller should handle successful completion, explicit stop, model or tool error, timeout, and step-limit exhaustion. Treat the stored turn resource as the final record. A stream is a live view that may begin late or reconnect after its buffer has lost early frames.

## Delivery

Channel delivery is routed through an outbox with derived idempotency keys. Persisting an outbound
item before delivery prevents duplicate enqueue and lets the runtime recover unfinished work after a
crash.

Exactly-once delivery still depends on the channel provider. If a process dies after sending bytes
but before receiving the provider acknowledgement, a recovered item is retried and marked
`uncertain`. A provider with idempotent sends can deduplicate that retry; Telegram cannot, so that
specific crash window can produce a duplicate rather than silently lose the reply.
