# Changelog

## Unreleased

```bash
npm i -g dispach@0.1.3
brew upgrade moeen-mahmud/tap/dispach
docker pull ghcr.io/moeen-mahmud/dispach:0.1.3
```

### Runtime

- Every install runs under Node: npm, the Homebrew formula (now `depends_on "node"`) and the container image (`node:24-trixie-slim`).
- **Breaking:** the compiled single-file binaries are no longer published.
- `/v1/ws` works under Node.
- `docker-compose.yml` pulls `ghcr.io/moeen-mahmud/dispach` by default.

### Pairing

- `init` starts the background service, adopts the new agent and pairs WhatsApp through it. No `serve` needed afterwards.
- `init` defaults to installing the background service. `--daemon none` opts out.
- `channels pair <agent> <channel>` starts a host if needed, shows the code and waits for the phone. Telegram reloads the agent after the token is set.
- New `deviceName` on the WhatsApp channel sets the Linked-devices label to `Google Chrome (<name>)`.

### CLI

- `dispach agents` lists the agents in the sandbox.
- `dispach restart <agent>` reloads one agent; bare, restarts the service.
- `dispach status` shows the service, agents, channels and pending pairing codes.
- `dispach logs` is an alias for `daemon logs`.

### Channels

- WhatsApp is bundled, like Telegram.
- WhatsApp pairs with an 8-character code via `pairWith`; without it, a QR.
- The paired account is always allowed to message the agent.
- Chatting with yourself works.
- Phone numbers accept `+` and separators.
- `channels <agent> [connect | disconnect | credential | unpair]`, and matching API routes.

**Baileys reverse-engineers WhatsApp Web and a number can be banned. Use a spare one.**

### Plugins

- `plugins add | list | remove`.
- **Breaking:** `dispach plugins <agent>` is now `dispach plugins list <agent>`.

### Serving

- A broken channel, plugin or tool provider is a warning; the agent still starts.
- A taken port moves the server to the next free one. An explicit `--port` still refuses.
- Failed turns show their error in the browser and on the `serve` log.

### Fixes

- `init --daemon service` did not install the service.
- Slash commands in `--plain` sessions were sent to the model.
- `web` suggested a non-existent command for minting a key.
- A second pairing code could be requested mid-login.
- A refused pairing retried forever; it now stops after three.
- `channels list` reported enabled channels as connected.
- The QR is drawn in the browser.
- The landing palette overflowed a 30-row terminal.

## 0.1.2 — 2026-09-22

```bash
npm i -g dispach@0.1.2
brew upgrade moeen-mahmud/tap/dispach
docker pull ghcr.io/moeen-mahmud/dispach:0.1.2
```

### Models

- A model id that matches only a family row (e.g. `deepseek-v4.1-flash` → `deepseek-v4*`) now warns at boot and in `validate`, instead of reading as an exact match.
- New `init --preset` choices: OpenRouter, Groq, NVIDIA NIM and Ollama Cloud.
- Custom model roles have their key and base URL validated.

### init

- The "Serve the HTTP API?" question is gone; the API is on by default. `--server none` opts out.

### Fixes

- A shell command cut short by a blank line is refused and repaired instead of run.

## 0.1.1 — 2026-09-21

```bash
npm i -g dispach@0.1.1
brew upgrade moeen-mahmud/tap/dispach
docker pull ghcr.io/moeen-mahmud/dispach:0.1.1
```

### Web UI

- Settings are editable from the browser (`GET`/`PATCH /v1/agents/:id/config`).
- Schedules can be created, enabled, disabled, deleted and run from the browser.
- Replies no longer repeat or arrive garbled.
- The permanent "Failed to fetch" banner is gone.
- The transcript reads oldest-first.
- An agent created from the browser is recognised as running.

### API

- `PATCH` and `DELETE` on a schedule declared in the manifest answer `409` instead of being undone at the next boot.

### Plugins

- A plugin-supplied channel type (`PluginContext.defineChannel`) works under `serve`.
- A plugin that fails to load skips its agent instead of stopping the host.

## 0.1.0 — 2026-09-21

The first release.

```bash
npm i -g dispach
brew install moeen-mahmud/tap/dispach
docker run ghcr.io/moeen-mahmud/dispach:0.1.0
```

- Always-on server: `serve` hosts every agent; `run` and `web run` attach to it.
- Tool loop with five-stage compaction, phase-scoped tools and NLT as the default tool dialect.
- Shell and file tools with a policy engine; web fetch and search; Composio.
- Memory (SQLite FTS5) and skills installable from GitHub catalogues.
- Telegram channel with an idempotent outbox.
- Cron, interval and one-shot schedules.
- HTTP API under `/v1` with SSE streams, an OpenAPI document and `/docs`.
- Scoped operator keys.
- Browser UI for chat, agents, panels and provisioning.
- Docker image and a compose file.
- Typed client: `import { createClient } from "dispach/client"`.
