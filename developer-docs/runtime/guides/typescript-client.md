# TypeScript client

The published `dispach` package includes a typed client with no terminal UI import on its client path.

## Install and connect

```bash
npm install dispach
```

```ts
import { createClient } from "dispach/client"

const client = createClient({
  baseUrl: "http://localhost:7420",
  token: process.env.DISPACH_API_TOKEN,
})

const agent = client.agent("milo")
```

## Send and render text

```ts
const turn = await agent.send("Summarize today's incidents", {
  idempotencyKey: crypto.randomUUID(),
})

for await (const token of turn.tokens()) {
  process.stdout.write(token)
}
```

`send()` resolves when the server accepts the turn. Dropping the iterator does not cancel it.

Persist `turn.turnId` when work must survive a process or page reload:

```ts
const text = await agent.turn(savedTurnId).text()
```

## Handle the complete stream

Use `stream()` when the application needs tools, approvals, replay state, or lifecycle events:

```ts
for await (const item of turn.stream({ chunks: true })) {
  switch (item.kind) {
    case "replay":
      if (item.report.truncated) console.warn("early events are unavailable")
      break
    case "event":
      if (item.event.type === "tool.call") console.log(item.event.data.slug)
      break
    case "ended":
      console.log(item.status)
      break
    case "unavailable":
      console.log(await turn.get())
      break
  }
}
```

`tokens()` refuses a truncated replay by default because concatenating it would produce incomplete text without an obvious error. Use the full stream report before deliberately accepting a fragment.

The checked-in package [client README](../../../packages/client/README.md) covers approvals, scoped keys, sessions, errors, and server-wide event streams.
