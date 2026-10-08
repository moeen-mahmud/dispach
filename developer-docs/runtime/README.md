# Build with Dispach

Dispach is a self-hosted agent runtime that your product calls over HTTP. One process can host many
agents; each agent has its own model, workspace, memory, tools, schedules, channels, and policy.

Choose the path that matches what you are building:

- [Run the server with Docker](quickstart/run-with-docker.md) and reach readiness without first
  configuring a model.
- [Create an agent](quickstart/create-an-agent.md), then
  [send and stream a turn](quickstart/send-and-stream-a-turn.md).
- Use the [TypeScript client](guides/typescript-client.md) when Dispach sits behind an application.
- Read [runtime, agents, and sessions](concepts/runtime-agents-and-sessions.md) before designing a
  multi-tenant integration.
- Read [security and trust](concepts/security-and-trust.md) before enabling system or web tools.

The default documentation variant describes the latest stable release. **Next** follows the
`development` branch and may include pilot behavior. The server always exposes its own exact
version at `GET /v1/health` and its generated reference at `/docs`.

Dispach is the runtime layer: it runs the model loop, executes tools, assembles and compacts context,
persists sessions, and applies control mechanisms. Your product still owns users, billing, product
authorization, and the experience around the agent.
