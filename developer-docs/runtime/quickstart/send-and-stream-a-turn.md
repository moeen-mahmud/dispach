# Send and stream a turn

A message request accepts a turn and returns immediately. The turn continues inside the runtime if the HTTP client disconnects.

## Start a turn

Use an idempotency key when a caller may retry the request:

```bash
export IDEMPOTENCY_KEY="$(uuidgen)"

curl --fail \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"text":"What can you do?"}' \
  http://localhost:7420/v1/agents/milo/messages | jq
```

The `202` response contains `turnId` and `sessionKey`. Persist the turn ID; it is the handle used to poll, stream, stop, and reattach.

## Read the result

```bash
export TURN_ID='t_...'

curl --fail \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7420/v1/agents/milo/turns/$TURN_ID" | jq
```

## Stream events

```bash
curl --no-buffer --fail \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7420/v1/agents/milo/turns/$TURN_ID/stream?chunks=true"
```

The first stream frame describes replay state. A reconnect can receive buffered events, report that the oldest events were truncated, or tell the caller that the recorded turn is no longer observable from this process. Fetch the stored turn for the authoritative final text.

Passing `chunks=true` adds per-token model events. Leave it off for clients that only need progress and lifecycle events.

## Stop explicitly

Closing the stream does not cancel work. Stop a turn through its endpoint:

```bash
curl --fail -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7420/v1/agents/milo/turns/$TURN_ID/stop"
```

For application code, the [TypeScript client](../guides/typescript-client.md) handles these stream states as a discriminated union.
