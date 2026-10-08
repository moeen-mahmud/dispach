# Run with Docker

The Compose deployment starts the runtime, browser UI, and persisted state with no model call during boot.

## Start the server

```bash
git clone https://github.com/moeen-mahmud/dispach.git
cd dispach
cp .env.example .env
```

Set `DISPACH_API_TOKEN` in `.env` to a long random value. Then build and start the stack:

```bash
docker compose up -d --build --wait
```

The server is ready when this request succeeds:

```bash
curl --fail http://localhost:7420/v1/ready
```

Readiness does not require a model key. Dispach deliberately completes local startup before it connects to channels or remote tool catalogues.

## Authenticate API calls

```bash
export TOKEN="$(grep '^DISPACH_API_TOKEN=' .env | cut -d= -f2-)"

curl --fail \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:7420/v1/agents
```

Open `http://localhost:7420/docs` for the live API reference. The browser application is served from the same origin.

## Persisted state

Compose stores agents, conversations, keys, and runtime data in a named volume. `docker compose down` stops the deployment without deleting that volume. `docker compose down -v` deletes it and should only be used when you intend to remove all runtime data.

Continue with [Create an agent](create-an-agent.md).
