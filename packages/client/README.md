# @dispach/client

A typed client for the Dispach agent server. No dependency beyond the standard library and
`@dispach/core`, which supplies the SSE parser and the event types — so the client cannot drift
from the runtime's own catalogue.

```bash
bun add @dispach/client
```

```ts
import { createClient } from "@dispach/client"

const client = createClient({
    baseUrl: "http://localhost:7420",
    token: process.env.DISPACH_API_TOKEN,
})

const agent = client.agent("milo")
const turn = await agent.send("what's on my calendar today?")

for await (const token of turn.tokens()) process.stdout.write(token)
```

## Turns are detached, and this client cannot change that

`send` returns once the server has **accepted** the turn, not when it finishes. Dropping the
iterator, losing the connection or exiting the process does not cancel it — only `stop()` does.
That is a property of the protocol rather than a convenience of this package, and a client that
cancelled on disconnect would be lying about it.

Which is what makes reattaching the normal case rather than a recovery path:

```ts
const turn = await agent.send("summarise the quarter")
console.log(turn.turnId)          // persist this anywhere

// later, in another process, after a page refresh, on another machine:
const text = await agent.turn(turnId).text()
```

## Three ways to read a turn

| | Use when |
| --- | --- |
| `turn.tokens()` | Animating text. Yields the reply's deltas, excluding the model's reasoning. |
| `turn.text()` | You want the answer. Waits for the turn, returns the stored text. |
| `turn.stream()` | Anything else. Every frame, as a discriminated union. |

`stream()` is the honest view and yields a union rather than bare events, because a turn stream is
not a flat sequence: it announces its replay, carries events, and can end three different ways.

```ts
for await (const item of turn.stream({ chunks: true })) {
    switch (item.kind) {
        case "replay":
            if (item.report.truncated) {
                // The buffer dropped its oldest events. Text assembled from what follows is short.
            }
            break
        case "event":
            if (item.event.type === "tool.call") { /* item.event.data is typed */ }
            break
        case "ended":
            // Finished before you attached; its buffer has been evicted. `item.status` is the
            // stored outcome and `turn.get()` has the full text.
            break
        case "unavailable":
            // Recorded as running, and not observable from the process you asked — one store is
            // shared by every process under a sandbox root. Poll `turn.get()`.
            break
    }
}
```

`isEvent(event, "model.chunk")` narrows, so `event.data.delta` is typed rather than cast.

### Per-token frames are opt-in

`{ chunks: true }`, per connection, default off. Not caution — a token event is one envelope and
one ISO timestamp per token, and most clients are watching a turn's progress rather than animating
its text. `tokens()` asks for them on your behalf.

### A truncated replay is refused, not quietly shortened

`tokens()` throws `replay_truncated` rather than yielding a fragment whose front is missing. A
reattaching client that concatenated one would build a shorter reply and believe it — no error and
no symptom, which is the failure the `stream.replay` preamble exists to make visible. Putting that
behind a field you have to remember to check would undo it.

```ts
// Knowingly accepting a fragment:
for await (const token of turn.tokens({ allowTruncated: true })) { … }
```

This only happens when reattaching to a turn that has already produced more events than the buffer
holds. Streaming from the start of a turn is never truncated.

## When the sender is not you

```ts
const turn = await agent.send("the nightly build failed on arm64", {
    from: { id: "agent:ci-bot", name: "CI", kind: "agent" },
    idempotencyKey: crypto.randomUUID(),
})
if (turn.replayed) return // a retry: that turn already ran, nothing new happened
```

`from.kind` is a declaration with consequences, and it is the only field that has them:

| `kind` | |
| --- | --- |
| omitted, or `"user"` | Nothing changes. The text reaches the prompt exactly as it would without `from`. |
| `"agent"` | The server fences the text as data and blocks mutating tools for the whole turn. |

There is no `trust` option beside it, here or on the wire, for the same reason `exec` has no `env`
map: the pair could disagree, and the dangerous half is the one that would win quietly. If you want
a peer's message treated as trusted you have to call it a user, which is at least a sentence about
what you believe.

`replayed` is a **boolean on every handle**, including one from `agent.turn(id)`. It exists to be
branched on: enqueueing a notification twice because a retry looked like a fresh turn is the
failure the key prevents, and only a caller who can see the replay can avoid it. A key reused with
different text throws `idempotency_key_reused` rather than answering with the earlier turn.

## Errors

Every failure is a `DispachError` carrying the wire's own `code`, `hint`, `field` and `status`.
Branch on `code`, never on `message`.

```ts
import { DispachError } from "@dispach/client"

try {
    await agent.send("hi")
} catch (error) {
    if (error instanceof DispachError) {
        console.error(error.code)   // "agent_not_found"
        console.error(error.hint)   // what to do about it
    }
}
```

A transport failure — DNS, a refused connection, an aborted request — is also a `DispachError`
(`transport_failed`), so one `catch` is a complete answer. A response that is not the documented
error shape, such as a proxy's HTML 502, becomes `http_502` rather than a JSON parse error
replacing a useful status.

Every code the server can return is tabled in
[`docs/04-SPEC-WIRE.md`](../../docs/04-SPEC-WIRE.md), and `packages/server/test/spec.test.ts`
asserts that table is complete and that every reachable failure carries a hint.

## The firehose

```ts
for await (const item of client.events({ types: ["tool.call", "tool.result"] })) {
    if (item.kind === "subscribed") console.log("filter:", item.report)
    if (item.kind === "event") record(item.event)
}
```

The first frame is always `subscribed`, reporting the filter the server resolved — including
whether tokens are on and why. An unknown type is refused with `unknown_event_type` naming the
nearest real one, rather than opening a stream that matches nothing forever.

## Introspection

```ts
await client.ready()          // false while still starting, rather than throwing
await client.health()
await client.agents()

await agent.describe()        // model, window, dialect, counts, entryPhase, warnings
await agent.turn(id).get()    // the stored row, including `sender` when one was declared
await agent.tools()           // the resolved catalogue with tags and phase visibility
await agent.skills()          // `configured: false` distinguishes "no skills block"
await agent.sessions()
await agent.schedules()
await agent.context()         // the prompt the next turn would send
```

## Testing against it

`createClient` takes a `fetch`, and the server's `createHandler` is a plain
`(Request) => Promise<Response>` — so the two compose with no port and no server process:

```ts
const handler = createHandler({ runtime, allowUnauthenticated: true })
const client = createClient({
    baseUrl: "http://localhost:7420",
    fetch: (url, init) => handler(new Request(url as string, init)),
})
```

That is how this package's own tests run, deliberately: a mocked transport would let the client
agree with a fixture instead of with the runtime.
