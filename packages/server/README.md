# @dispach/server

The HTTP, SSE and WebSocket surface described in `docs/04-SPEC-WIRE.md`. Framework-free.

```ts
import { serve } from "@dispach/server"

const running = await serve({ runtime, host: "127.0.0.1", port: 7420, token })
console.log(running.url)
```

Or mount it inside something you already run — `createHandler` is a plain function:

```ts
import { createHandler } from "@dispach/server"

const handler = createHandler({ runtime, token })
const response = await handler(new Request("http://x/v1/health"))
```

That shape is the point. Every route is testable by constructing a `Request` and asserting on a
`Response`, so the only tests that open a port are the ones about ports.

From the CLI:

```bash
dispach serve ./agent.yaml            # reads the manifest's server block
dispach serve ./agent.yaml --port 8080 --host 0.0.0.0
```

## Authentication

`Authorization: Bearer <token>`, and there are **two kinds** of token. The configured one comes from
the variable named by `server.tokenEnv`. An **operator key** is minted at `POST /v1/keys` or with
`dispach credential`, is stored hashed, can be revoked, and can carry a `scope` narrowing it to
named agents, a session-key prefix, a set of capabilities and an expiry. What is stored is an
**unsalted `SHA-256` fingerprint** and never the secret — unsalted deliberately, because a KDF buys
work per guess against a secret somebody *chose*, and this one is 256 bits of entropy nobody chose;
salting would only stop the digest being a usable lookup key. One authenticator serves
every route including the WebSocket — `/v1/ws` once compared `?token=` against the configured token
alone, so an operator key authenticated everything *except* the socket, which was a divergence
rather than a decision.

On the socket the credential travels in `Sec-WebSocket-Protocol`
(`new WebSocket(url, ["dispach.bearer", key])`), because a browser cannot set ordinary headers on a
handshake and a credential in a URL lands in an access log, a `Referer` and anything that proxies.
The server **echoes** the chosen subprotocol, or the browser closes the socket instantly with no
readable reason. `?token=` is still accepted and **deprecated** — removing it in the same change
that introduced the replacement would break every client using the form the spec had advertised
since Phase 13, for no security a deprecation window does not also buy (decision 11.235).

Open, needing no credential at all:

- `GET /v1/health` and `GET /v1/ready` — a load balancer's probe cannot hold your token, and one
  getting a 401 forever would mark a healthy container unhealthy.
- `GET /docs`, `GET /v1/openapi.json`, and the browser UI's own assets — the moment a reference is
  most useful is before you have a credential.
- `POST /v1/channels/:channelId/webhook/:agentId` — the provider does not have one either.
  Verification is the channel transport's, because only it knows what its provider signs.

Two rules worth knowing before designing against it:

- **A non-loopback bind with no token refuses to start.** An agent with shell access on `0.0.0.0`
  behaves identically to a safe one right up until someone finds it, and bind time is the one moment
  the person who made the choice is present to see the refusal.
- **Out of scope answers `404`, not `403`** — byte-identical to an agent that does not exist, code
  included, because a refusal that confirms existence turns a key narrowed to one tenant into a
  directory of the others. A *capability* refusal is the exception at `403 capability_required`,
  since it discloses nothing about what exists. Listings **filter** rather than refuse.

## Streaming

SSE frames name their event so `EventSource` can dispatch without parsing, with a comment heartbeat
every 15 seconds to survive proxy idle timeouts. `Bun.serve`'s own `idleTimeout` is derived from
that heartbeat rather than left at its 10-second default, which was closing streams before the first
keep-alive frame.

**A turn is not bound to the connection that started it.** Disconnecting unsubscribes a listener;
only `POST /v1/agents/:id/turns/:turnId/stop` ends a turn early, and partial content is persisted
then and never on disconnect. Reattaching replays the turn's buffered events and then tails.

## Known divergences from the spec

Exactly one is left. This table carried four for months and **three had been fixed** — a
divergence list that outlives the divergences is worse than none, because it is the file somebody
checks before deciding a route is unusable.

| Endpoint | Behaviour | Why |
| --- | --- | --- |
| `GET /v1/ws` | `501` under Node | Bun has an upgrade path in `Bun.serve`; Node needs a dependency for an endpoint the spec itself calls secondary. It answers 501 naming the reason, which beats a connection failure a client would read as a network problem. Decision 11.23 — this row cited 11.21, which is about `createHandler` being a plain function. |

Retired, with what each actually does now:

- **`POST /v1/agents/:id/reload`** answered `501` and now **works** — `Runtime.replace` (16.2b)
  disposes the agent and re-adopts it from its manifest, answering
  `{ id, status: "loaded", adopted: [...] }`. The reasoning behind the old `501` is intact and is
  *why* it is a replace: a catalogue resolves once per instance and the cached prefix depends on
  that, so a changed manifest gets a **new instance** rather than a mutated one. It answers `409`
  while a turn is in flight, because tearing one down would close its store under a turn recorded
  as running.
- **`GET /v1/agents/:id/skills`** returns the real catalogue — `configured`, `maxActive`,
  `threshold`, `cached` and an entry per skill. The field is `configured`, never `supported`, which
  is what the table named.
- **`/v1/agents/:id/schedules*`** is full CRUD plus an out-of-band `POST …/run`. A schedule the
  *manifest* declares answers `409 schedule_manifest_owned` on a write, because reconciliation
  restores every field from the file at the next boot — so a `200` there was a success report on a
  change that did not survive.
