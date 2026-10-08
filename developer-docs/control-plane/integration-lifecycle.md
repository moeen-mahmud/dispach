# Integration lifecycle

Your product remains the system of record for users and teams. Pass its stable opaque identifier as the silo `subject`.

## Create a silo and backend key

```bash
curl --fail \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"subject":"u_8f3a"}' \
  "$CONTROL_URL/v1/silos"
```

Creation is idempotent: `201` means created and `200` means it already existed.

Mint a key inside that silo and store the returned secret server-side. It is shown once:

```bash
curl --fail \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label":"product backend"}' \
  "$CONTROL_URL/v1/silos/u_8f3a/keys"
```

## Use the runtime API

Every path after `/silos/<subject>` is the normal runtime API:

```bash
curl --fail \
  -H "Authorization: Bearer $SILO_KEY" \
  -H 'content-type: application/json' \
  -d '{"template":"assistant","name":"Assistant","vars":{"company":"Acme"}}' \
  "$CONTROL_URL/silos/u_8f3a/v1/agents"
```

Keep operator and silo credentials separate. The operator token is refused by silos; a silo key is refused by operator routes.

Use stable session keys and idempotency keys when sending messages. A disconnected proxy stream does not cancel the turn, so reattach through the same proxied turn endpoint.

## Account lifecycle

| Product event | Control action |
| --- | --- |
| User returns | Idempotently ensure the silo exists |
| Plan or template changes | Update through the silo API or recreate on a new image |
| Backup job | Download `GET /v1/silos/:subject/backup` |
| Restore | Upload the archive to `PUT /v1/silos/:subject/backup` |
| Account deletion | Delete the silo only after product confirmation and retention work |

Restore replaces the entire silo volume, including keys. Delete removes the container and its only volume and is irreversible.

The checked-in [embedding walkthrough](../../packages/control/EMBEDDING.md) includes webhooks, usage, and error handling.
