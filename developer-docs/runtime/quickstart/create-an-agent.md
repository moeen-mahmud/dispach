# Create an agent

The provisioning endpoint creates a complete agent from answers, validates it with the real manifest loader, and adopts it into the running process. A restart is not required.

## Inspect the available questions

```bash
curl --fail \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:7420/v1/provision | jq
```

Check the response's `allowed` field before presenting provisioning in your product. The response also describes the current questions, choices, and defaults, so a client does not need to duplicate the wizard schema.

## Provision with the defaults

The default preset uses OpenAI. Supply the future owner's display name, an agent name, and the model key:

```bash
curl --fail \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"answers":{"user":"Ada","name":"milo","apiKey":"sk-..."}}' \
  http://localhost:7420/v1/agents | jq
```

A successful response has status `201` and includes the new agent ID. The key is written to the agent's protected environment file; the manifest stores only the environment variable name.

For another OpenAI-compatible endpoint, include `model` and `baseUrl` in `answers`. Use the value returned by `GET /v1/provision` instead of hard-coding provider choices.

## Confirm adoption

```bash
curl --fail \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:7420/v1/agents/milo | jq
```

The same operation is available interactively inside the container:

```bash
docker compose exec server dispach init
```

Continue with [Send and stream a turn](send-and-stream-a-turn.md).
