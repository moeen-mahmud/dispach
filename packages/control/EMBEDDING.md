# Embedding per-user agents

What a product's backend does, step by step, to give each of its users their own agents on a
silo. It assumes the control plane is running (`compose.yaml`) and you hold its token. Every call
below is either an **operator** call (`/v1/…`, the control plane's token) or a **silo** call
(`/silos/<subject>/v1/…`, a key minted inside that silo). The silo half is the runtime's own API,
unchanged, so `docs/09-API-GUIDE.md` is its full reference.

```
your backend ──operator token──▶ /v1/silos…            create, key, pause, back up, delete
             ──silo key───────▶ /silos/<subject>/v1…   agents, messages, webhooks, usage
silo         ──signed POST────▶ your backend           webhooks: turns, approvals, failures
```

## 0. Once, when you deploy

- **Pin the runtime image**: `DISPACH_IMAGE=ghcr.io/moeen-mahmud/dispach:<version>`.
- **Write your agent template**, the agent every user gets, in a host directory, and set
  `DISPACH_TEMPLATES` to it. The format is in `docs/09-API-GUIDE.md` §1b. Put your limits in the
  template's manifest, so one user cannot take the whole host:

  ```yaml
  limits:
    maxConcurrentTurns: 2
    tokens: { max: 2000000, windowMs: 86400000 }
  ```

- **Let silos reach your backend.** If it is on a private network (the usual case), allow it and
  hand the setting to every silo:

  ```bash
  DISPACH_WEBHOOK_ALLOW=api.internal,10.0.0.0/8
  DISPACH_SILO_ENV=DISPACH_WEBHOOK_ALLOW
  ```

## 1. A user signs up

```bash
curl -s -H "Authorization: Bearer $CONTROL" -H 'content-type: application/json' \
  -d '{"subject":"u_8f3a"}' $CP/v1/silos                                  # 201, ~240 ms to ready
```

The subject is **your** id for the user, opaque to everything here: 1–63 letters, digits, `_`, `.`
or `-`. The call is idempotent, so it is safe on every login: `200` means the silo already exists.

Then mint the key your backend will use in that silo, and store it server-side against the user.
It is shown once:

```bash
curl -s -H "Authorization: Bearer $CONTROL" -H 'content-type: application/json' \
  -d '{"label":"backend"}' $CP/v1/silos/u_8f3a/keys                        # {"secret":"…"}
```

With no `scope`, that key can do anything in that silo and nothing anywhere else. For a
narrower credential — a browser talking to the silo directly, say — mint one with
`{"label":"web","scope":{"can":["chat","read"],"expiresIn":3600}}`.

## 2. Give them an agent

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"template":"assistant","name":"Assistant","vars":{"company":"Acme"}}' \
  $CP/silos/u_8f3a/v1/agents                                                  # 201 {"id":"assistant",…}
```

If the user brings their own model key, write it with the secrets route. It is write-only; nothing
reads it back:

```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"values":{"MODEL_API_KEY":"sk-…"}}' $CP/silos/u_8f3a/v1/agents/assistant/secrets
```

## 3. They send a message

```bash
curl -sN -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'Idempotency-Key: msg_01J…' \
  -d '{"text":"what is on my calendar?","sessionKey":"app:chat-42","stream":true,"chunks":true,
       "from":{"id":"user:u_8f3a","kind":"user"}}' \
  $CP/silos/u_8f3a/v1/agents/assistant/messages
```

- **A sleeping silo is woken by this request**, about 60 ms before the first token.
- **The turn is not bound to your connection.** A dropped stream loses nothing; reattach with
  `GET …/turns/<turnId>/stream`.
- **`Idempotency-Key`** makes a retry after a timeout safe.
- **`from`** attributes the turn, and usage is split by it.

Over a limit you get `429` with `agent_at_capacity` or `agent_token_budget_exhausted` and a hint.
Show the user something kinder than the hint.

## 4. Hear about it without holding streams open

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"http://api.internal/hooks/agents","types":["turn.end","approval.requested","delivery.failed"]}' \
  $CP/silos/u_8f3a/v1/webhooks                                                # secret shown once
```

Deliveries are [Standard Webhooks](https://www.standardwebhooks.com/): verify each with the
library in your language, and deduplicate on `webhook-id`, which retries keep.

## 5. Bill for it

```bash
curl -s -H "Authorization: Bearer $CONTROL" "$CP/v1/usage?by=agent,model&from=2026-09-01"
```

This returns every silo's usage, per silo, with `promptTokens`, `cachedPromptTokens` and
`outputTokens`, and each figure says whether the endpoint reported it or it was estimated. Note
that this call wakes paused silos to ask them.

## 6. The rest of their life

| When | Call | Note |
| --- | --- | --- |
| They go quiet | nothing | Paused after `IDLE_MS`, woken by their next message or schedule |
| You back up | `GET /v1/silos/u_8f3a/backup` → tar.gz | Pauses the silo for the copy (tens of ms); store it anywhere |
| You restore | `PUT /v1/silos/u_8f3a/backup` with that file | Replaces everything in the silo, keys included |
| You upgrade the runtime | bump `DISPACH_IMAGE`, restart the control plane, then `POST /v1/silos/<s>/recreate` per silo | Keeps each silo's data; refused (`409`) while a silo is busy, so retry |
| They delete their account | `DELETE /v1/silos/u_8f3a` | Container **and volume**: every agent, conversation and key. Irreversible |

## Errors worth handling

| Status | Code | Meaning |
| --- | --- | --- |
| `401` | `unauthorized` | Wrong key for this silo, or no such subject. The two look the same on purpose |
| `404` | `silo_not_found` | Operator call for a subject with no silo; create it |
| `409` | `silo_busy` | Pause, backup, recreate or restore asked of a silo mid-turn; retry shortly |
| `429` | `agent_at_capacity`, `agent_token_budget_exhausted` | The template's limits |
| `502` | `silo_unreachable`, `silo_not_ready` | The container is down or did not start; the message says which |
