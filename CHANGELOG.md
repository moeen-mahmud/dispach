# Changelog

## Unreleased

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Fixed in the QA pass

- `serve` no longer exits for every agent when one of them is refused at build time (a media key not set yet, a workspace file over budget); that agent is listed as not served.
- The web app gives a new conversation its own session instead of `api:default`, reopens it after a reload, and opens a conversation at its newest reply.
- `tools --warm` no longer stops at a provider it cannot warm (the default `composio: {}` without a key), and still fails when a pinned tool is left uncovered.
- `config edit` fits a 40-row terminal; the init summary no longer runs "Background service" into its value; the Teams status names its real webhook path.
- The manifest spec now says that recurring schedules fire up to a tenth of their interval late, the same amount every time.
- Every agent in the sandbox now shares one host token, in `agents/.api-token`. `run`, `stop` and `start` used to get a 401 for every agent but the first. On upgrade, the file takes the token the host was already using.
- A room member can no longer write an agent's private memory: `memory_write` refuses in any turn that cannot read that memory. The space writer's notes still go to the space.
- `status` finds a server hosting zero agents; it used to say nothing was running.
- An unfilled starter skill is never selected; `skills validate` still names it.
- A stand-in is told that saving a note is queued for approval like any other change.

### Runtime API

- Agent templates: `GET /v1/templates` and `POST /v1/agents {"template", "vars"}`. Secret vars go to `.env`, never into a file.
- Per-agent secrets: `GET`/`PUT /v1/agents/:id/secrets`. Names only on the way out; a `PUT` adopts an agent waiting for its key.
- Every model call is metered: `GET /v1/usage` (by agent, model, day, sender) and `GET /v1/agents/:id/turns`.
- Outbound webhooks, signed with Standard Webhooks: `POST`/`GET`/`DELETE /v1/webhooks`. A private receiver needs `DISPACH_WEBHOOK_ALLOW`.
- `limits.maxConcurrentTurns` and `limits.tokens`: over either, a turn is refused with `429`, never cut off.
- `GET /v1/activity` for a waker: idle or not, and when the next schedule is due.
- `model.result` carries `firstTokenMs`.

### Rooms

- Participants, rooms and DMs over `/v1/participants` and `/v1/conversations`. In a room an agent answers only when mentioned; in a DM, always. Each room message is a `conversation.message` event and a row in the conversation's log.
- Agents replying to each other stop at `limits.maxHops` (default 4), with `conversation.skipped` saying why.
- Room text is untrusted to every agent, so a mutating call from a room needs a `policy.allow` rule or an approval.
- A key bound to a participant posts only as them and sees only their conversations. An admin participant can assign an agent to a member; `GET /v1/agents/:id` shows it.

### Stand-ins and delegation

- A DM can hold two people and their agents. When one is offline (`PUT /v1/participants/:id/presence`), their agent answers for them after `standIn.escalateAfterMs`, says so at first contact, and marks each reply `onBehalfOf`.
- A stand-in never commits: a mutating call is queued for the owner (`GET /v1/actions`), even with the tool allowed, and runs only when they approve it.
- `delegation.offer` and `delegation.to` let a coordinator hand work to another member's agent, with the same handoff a team uses.

### Agents talking to agents

- `@dispach/channel-a2a`: an agent answers A2A v1.0 peers over JSON-RPC (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`) and publishes an Agent Card. A peer's text is untrusted and its turn acts for nobody.
- `a2a_send(peer, text)` asks a peer the manifest names. It is mutating, and its answer is untrusted.
- Plugins can mount HTTP routes (`defineRoute`), under `/v1/agents/:id/plugins/<name>/`, behind the same auth, capability and scope checks as every route.
- A new key capability, `peer`, reaches only a plugin route that asks for it.

### Team memory

- Shared memory scopes: the space, a person's owner scope, and projects, over `/v1/memory/notes` and `/v1/projects`. Agents recall them next to their own notes.
- A stand-in reads its owner's scope and the space, never the agent's private memory; a room turn reads shared scopes only.
- Every read of someone's owner scope for somebody else is recorded: `GET /v1/participants/:id/memory/reads` and `memory.read`.
- `PUT /v1/memory/space/writer` names the one non-admin who may write the space. An agent named there saves `memory_write` to the space.
- An agent id may no longer start with `~`.
- Move memory and knowledge between agents: `GET /v1/agents/:id/export` returns a JSON bundle, and `POST /v1/agents/:id/import` merges it, note by note for memory and `skip` or `overwrite` for knowledge. A bundle the agent would not load is rolled back.

### Media

- `media.transcription` and `media.image`: `openai` (any `/audio/transcriptions` and `/images/generations` endpoint) is built in; `aws` (Amazon Transcribe, Nova Canvas) comes from `@dispach/media-aws`. Set through settings, the API or `config_set`.
- `image_generate` saves a PNG under the agent's `media/` and sends it with the reply on Telegram, WhatsApp and Slack.
- Media calls are metered: `images` and `audioSeconds` in `/v1/usage`, and a `media.result` event.

### Fixes

- A team member or delegate with no tools of its own can return its artifact; every handoff to one used to fail.
- A reload onto a manifest the agent cannot be built from now fails and leaves the running agent in place, instead of removing it.

### Channels

- Microsoft Teams: `type: teams` with `appId`, `passwordEnv` and `tenantId`. Webhook-only; every activity's Bot Framework token is verified. Answers direct messages, and in group chats and channels only when @mentioned, in the thread.
- Voice notes on Telegram, WhatsApp, Slack and Teams become text before the turn, under a hard timeout; a note that cannot be transcribed gets a reply saying so.
- Slack: `type: slack` with `appTokenEnv` and `botTokenEnv`. Socket Mode, so no public endpoint. Answers direct messages, and in channels only when @mentioned, in the thread; replies render markdown.

### Reload

- A reload while a turn is running no longer answers `409`: it is `202 pending`, the running turn finishes on the old settings, and the agent swaps as soon as it is idle (`agent.reloaded`). `PATCH /config`, channel changes and secrets apply the same way.
- `limits.reloadHoldMs` (default 30 s): after it, new turns wait for the swap and run on the new settings.
- A manifest broken on disk is refused before the old agent is torn down, so it keeps serving.

### MCP

- MCP servers are configured through settings (TUI, web app, `PATCH /config`). A config the provider refuses — a credential in a URL — is refused before it is written.
- A server added from settings works with no restart and no warm step: once its cache fills, the agent reloads itself.
- `tools.providers.mcp`: tools from remote MCP servers over Streamable HTTP, pinned by name as `<server>__<tool>`. Resolved from a cache at boot, so a server that is down cannot hold startup; `tools --warm` fills it.
- Mutating unless the server marks a tool read-only; output is untrusted. `policyArgs` lets a policy rule reach a proxy tool's inner tool (`deny: ["huly__invoke_tool(delete_*)"]`). `participantHeader` forwards who the turn acts for.

### Acting participant

- Every tool receives `ctx.actingParticipant`: who the turn acts for, from the API sender or the channel's sender, never from the model. `null` for schedules, peer agents and the operator.
- `POST /v1/keys {"scope": {"participant"}}`: a key that speaks only as that participant. A `from` naming anyone else is `403 sender_not_bound_participant`; an omitted one is filled in.

### Kubernetes

- `docs/17-KUBERNETES.md` and `examples/kubernetes/silo.yaml`: storage split, read-only root, probes, SIGTERM, egress list.
- The store refuses to open on NFS or EFS (`store_on_network_filesystem`); `DISPACH_ALLOW_NETWORK_STORE=1` overrides.
- `DISPACH_DRAIN_MS`: a stop waits that long for running turns, and `/v1/ready` answers `draining`. Unset, a stop does not wait.

### Models

- `model.<role>.api` selects a transport (default `chat-completions`); `options` carries its settings. `baseUrl` is required only for chat-completions.
- AWS Bedrock: `api: bedrock-converse`, `options: {region, profile?}`. Credentials from the AWS default chain (env, container credentials, Pod Identity, instance role), never the manifest. Prompt caching, signed thinking, native tools, cache-read and cache-write usage. AccessDenied is terminal. The SDK loads on the first call.
- `model.<role>.fallbacks`: other models tried in order when the endpoint fails before any output. Never on a 4xx the caller caused, never on a 403.
- Signed thinking is replayed with tool results for Anthropic-family models. It was documented as built and was not.
- `model.result` carries `callId`, the answering `model`, `role`, `cachedPromptTokens`, `cacheWriteTokens` and `sender`; `model.fallback` is new.
- `/v1/usage` sums `cacheWriteTokens`. A usage row carries its call's id, and a call recorded twice is one row.

### Plugins

- `defineModelTransport(api, transport)` registers a model transport.

- **Breaking:** a plugin declares `dispachApi: "^0.2"` to load on 0.2. A plugin still on `^0.1` is refused at boot with `plugin_api_mismatch`, naming the range.
- A pre-release host is checked as the release it precedes: `0.2.0-pilot.1` satisfies `^0.2`.

### Fixes

- A container killed rather than stopped no longer blocks its replacement for 45 minutes on a dead pid-1 lease.
- WhatsApp's library loads only when a WhatsApp channel starts.
- `status` in a container no longer says "running in a terminal".
- A flag with a long placeholder in `--help` no longer runs into its description.
- A webhook whose receiver does not resolve for a moment (restarting, a DNS blip) is retried, not dropped.
- In the container, a refusal thrown by a bundled package keeps its own code and hint: a public bind with no token said every port was taken.
- Bedrock: the example model ids exist, and a new account's refusals name the use-case form or account verification.
- A bad `scope.*` field on `POST /v1/keys` returns its own error code, not `request_body_invalid`.
- `dispach … | head` no longer prints `uncaught exception: write EPIPE`, or exits 134: a reader that closes early ends the output, and the command keeps its exit code.
- The agent's `config_set` refuses a provider config the provider would refuse, like every other editor.

### Control plane (new, `packages/control`, FSL-1.1)

- Places one runtime per user (Docker), proxies `/silos/:subject/v1/…` with the silo's own keys, and creates, recreates, backs up, restores and deletes silos.
- Always on: `DISPACH_CONTROL_SUSPEND=on` pauses idle silos as a cost option, and is off by default. A backup no longer leaves a silo paused when suspend is off.
- The pilot monitor (`DISPACH_CONTROL_HOOK_URL`): rolling rates per silo, `GET /v1/monitor` and `/v1/monitor/failures`, and rate alerts to Telegram.

### Tooling

- `bun run eval:scenarios`: a real agent and model, mocked tools, and a calibrated judge.
- A tag with a `-` publishes a pre-release: npm `next`, a GitHub pre-release, no Homebrew formula, and no `latest` image tag.



## 0.2.0-pilot.2 — 2026-09-29

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Fixed in the QA pass

- `serve` no longer exits for every agent when one of them is refused at build time (a media key not set yet, a workspace file over budget); that agent is listed as not served.
- The web app gives a new conversation its own session instead of `api:default`, reopens it after a reload, and opens a conversation at its newest reply.
- `tools --warm` no longer stops at a provider it cannot warm (the default `composio: {}` without a key), and still fails when a pinned tool is left uncovered.
- `config edit` fits a 40-row terminal; the init summary no longer runs "Background service" into its value; the Teams status names its real webhook path.
- The manifest spec now says that recurring schedules fire up to a tenth of their interval late, the same amount every time.
- Every agent in the sandbox now shares one host token, in `agents/.api-token`. `run`, `stop` and `start` used to get a 401 for every agent but the first. On upgrade, the file takes the token the host was already using.
- A room member can no longer write an agent's private memory: `memory_write` refuses in any turn that cannot read that memory. The space writer's notes still go to the space.
- `status` finds a server hosting zero agents; it used to say nothing was running.
- An unfilled starter skill is never selected; `skills validate` still names it.
- A stand-in is told that saving a note is queued for approval like any other change.

### Runtime API

- Agent templates: `GET /v1/templates` and `POST /v1/agents {"template", "vars"}`. Secret vars go to `.env`, never into a file.
- Per-agent secrets: `GET`/`PUT /v1/agents/:id/secrets`. Names only on the way out; a `PUT` adopts an agent waiting for its key.
- Every model call is metered: `GET /v1/usage` (by agent, model, day, sender) and `GET /v1/agents/:id/turns`.
- Outbound webhooks, signed with Standard Webhooks: `POST`/`GET`/`DELETE /v1/webhooks`. A private receiver needs `DISPACH_WEBHOOK_ALLOW`.
- `limits.maxConcurrentTurns` and `limits.tokens`: over either, a turn is refused with `429`, never cut off.
- `GET /v1/activity` for a waker: idle or not, and when the next schedule is due.
- `model.result` carries `firstTokenMs`.

### Rooms

- Participants, rooms and DMs over `/v1/participants` and `/v1/conversations`. In a room an agent answers only when mentioned; in a DM, always. Each room message is a `conversation.message` event and a row in the conversation's log.
- Agents replying to each other stop at `limits.maxHops` (default 4), with `conversation.skipped` saying why.
- Room text is untrusted to every agent, so a mutating call from a room needs a `policy.allow` rule or an approval.
- A key bound to a participant posts only as them and sees only their conversations. An admin participant can assign an agent to a member; `GET /v1/agents/:id` shows it.

### Stand-ins and delegation

- A DM can hold two people and their agents. When one is offline (`PUT /v1/participants/:id/presence`), their agent answers for them after `standIn.escalateAfterMs`, says so at first contact, and marks each reply `onBehalfOf`.
- A stand-in never commits: a mutating call is queued for the owner (`GET /v1/actions`), even with the tool allowed, and runs only when they approve it.
- `delegation.offer` and `delegation.to` let a coordinator hand work to another member's agent, with the same handoff a team uses.

### Agents talking to agents

- `@dispach/channel-a2a`: an agent answers A2A v1.0 peers over JSON-RPC (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`) and publishes an Agent Card. A peer's text is untrusted and its turn acts for nobody.
- `a2a_send(peer, text)` asks a peer the manifest names. It is mutating, and its answer is untrusted.
- Plugins can mount HTTP routes (`defineRoute`), under `/v1/agents/:id/plugins/<name>/`, behind the same auth, capability and scope checks as every route.
- A new key capability, `peer`, reaches only a plugin route that asks for it.

### Team memory

- Shared memory scopes: the space, a person's owner scope, and projects, over `/v1/memory/notes` and `/v1/projects`. Agents recall them next to their own notes.
- A stand-in reads its owner's scope and the space, never the agent's private memory; a room turn reads shared scopes only.
- Every read of someone's owner scope for somebody else is recorded: `GET /v1/participants/:id/memory/reads` and `memory.read`.
- `PUT /v1/memory/space/writer` names the one non-admin who may write the space. An agent named there saves `memory_write` to the space.
- An agent id may no longer start with `~`.
- Move memory and knowledge between agents: `GET /v1/agents/:id/export` returns a JSON bundle, and `POST /v1/agents/:id/import` merges it, note by note for memory and `skip` or `overwrite` for knowledge. A bundle the agent would not load is rolled back.

### Media

- `media.transcription` and `media.image`: `openai` (any `/audio/transcriptions` and `/images/generations` endpoint) is built in; `aws` (Amazon Transcribe, Nova Canvas) comes from `@dispach/media-aws`. Set through settings, the API or `config_set`.
- `image_generate` saves a PNG under the agent's `media/` and sends it with the reply on Telegram, WhatsApp and Slack.
- Media calls are metered: `images` and `audioSeconds` in `/v1/usage`, and a `media.result` event.

### Fixes

- A team member or delegate with no tools of its own can return its artifact; every handoff to one used to fail.
- A reload onto a manifest the agent cannot be built from now fails and leaves the running agent in place, instead of removing it.

### Channels

- Microsoft Teams: `type: teams` with `appId`, `passwordEnv` and `tenantId`. Webhook-only; every activity's Bot Framework token is verified. Answers direct messages, and in group chats and channels only when @mentioned, in the thread.
- Voice notes on Telegram, WhatsApp, Slack and Teams become text before the turn, under a hard timeout; a note that cannot be transcribed gets a reply saying so.
- Slack: `type: slack` with `appTokenEnv` and `botTokenEnv`. Socket Mode, so no public endpoint. Answers direct messages, and in channels only when @mentioned, in the thread; replies render markdown.

### Reload

- A reload while a turn is running no longer answers `409`: it is `202 pending`, the running turn finishes on the old settings, and the agent swaps as soon as it is idle (`agent.reloaded`). `PATCH /config`, channel changes and secrets apply the same way.
- `limits.reloadHoldMs` (default 30 s): after it, new turns wait for the swap and run on the new settings.
- A manifest broken on disk is refused before the old agent is torn down, so it keeps serving.

### MCP

- MCP servers are configured through settings (TUI, web app, `PATCH /config`). A config the provider refuses — a credential in a URL — is refused before it is written.
- A server added from settings works with no restart and no warm step: once its cache fills, the agent reloads itself.
- `tools.providers.mcp`: tools from remote MCP servers over Streamable HTTP, pinned by name as `<server>__<tool>`. Resolved from a cache at boot, so a server that is down cannot hold startup; `tools --warm` fills it.
- Mutating unless the server marks a tool read-only; output is untrusted. `policyArgs` lets a policy rule reach a proxy tool's inner tool (`deny: ["huly__invoke_tool(delete_*)"]`). `participantHeader` forwards who the turn acts for.

### Acting participant

- Every tool receives `ctx.actingParticipant`: who the turn acts for, from the API sender or the channel's sender, never from the model. `null` for schedules, peer agents and the operator.
- `POST /v1/keys {"scope": {"participant"}}`: a key that speaks only as that participant. A `from` naming anyone else is `403 sender_not_bound_participant`; an omitted one is filled in.

### Kubernetes

- `docs/17-KUBERNETES.md` and `examples/kubernetes/silo.yaml`: storage split, read-only root, probes, SIGTERM, egress list.
- The store refuses to open on NFS or EFS (`store_on_network_filesystem`); `DISPACH_ALLOW_NETWORK_STORE=1` overrides.
- `DISPACH_DRAIN_MS`: a stop waits that long for running turns, and `/v1/ready` answers `draining`. Unset, a stop does not wait.

### Models

- `model.<role>.api` selects a transport (default `chat-completions`); `options` carries its settings. `baseUrl` is required only for chat-completions.
- AWS Bedrock: `api: bedrock-converse`, `options: {region, profile?}`. Credentials from the AWS default chain (env, container credentials, Pod Identity, instance role), never the manifest. Prompt caching, signed thinking, native tools, cache-read and cache-write usage. AccessDenied is terminal. The SDK loads on the first call.
- `model.<role>.fallbacks`: other models tried in order when the endpoint fails before any output. Never on a 4xx the caller caused, never on a 403.
- Signed thinking is replayed with tool results for Anthropic-family models. It was documented as built and was not.
- `model.result` carries `callId`, the answering `model`, `role`, `cachedPromptTokens`, `cacheWriteTokens` and `sender`; `model.fallback` is new.
- `/v1/usage` sums `cacheWriteTokens`. A usage row carries its call's id, and a call recorded twice is one row.

### Plugins

- `defineModelTransport(api, transport)` registers a model transport.

- **Breaking:** a plugin declares `dispachApi: "^0.2"` to load on 0.2. A plugin still on `^0.1` is refused at boot with `plugin_api_mismatch`, naming the range.
- A pre-release host is checked as the release it precedes: `0.2.0-pilot.1` satisfies `^0.2`.

### Fixes

- A container killed rather than stopped no longer blocks its replacement for 45 minutes on a dead pid-1 lease.
- WhatsApp's library loads only when a WhatsApp channel starts.
- `status` in a container no longer says "running in a terminal".
- A flag with a long placeholder in `--help` no longer runs into its description.
- A webhook whose receiver does not resolve for a moment (restarting, a DNS blip) is retried, not dropped.
- In the container, a refusal thrown by a bundled package keeps its own code and hint: a public bind with no token said every port was taken.
- Bedrock: the example model ids exist, and a new account's refusals name the use-case form or account verification.
- A bad `scope.*` field on `POST /v1/keys` returns its own error code, not `request_body_invalid`.
- `dispach … | head` no longer prints `uncaught exception: write EPIPE`, or exits 134: a reader that closes early ends the output, and the command keeps its exit code.
- The agent's `config_set` refuses a provider config the provider would refuse, like every other editor.

### Control plane (new, `packages/control`, FSL-1.1)

- Places one runtime per user (Docker), proxies `/silos/:subject/v1/…` with the silo's own keys, and creates, recreates, backs up, restores and deletes silos.
- Always on: `DISPACH_CONTROL_SUSPEND=on` pauses idle silos as a cost option, and is off by default. A backup no longer leaves a silo paused when suspend is off.
- The pilot monitor (`DISPACH_CONTROL_HOOK_URL`): rolling rates per silo, `GET /v1/monitor` and `/v1/monitor/failures`, and rate alerts to Telegram.

### Tooling

- `bun run eval:scenarios`: a real agent and model, mocked tools, and a calibrated judge.
- A tag with a `-` publishes a pre-release: npm `next`, a GitHub pre-release, no Homebrew formula, and no `latest` image tag.

## 0.2.0-pilot.1 — 2026-09-28

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Runtime API

- Agent templates: `GET /v1/templates` and `POST /v1/agents {"template", "vars"}`. Secret vars go to `.env`, never into a file.
- Per-agent secrets: `GET`/`PUT /v1/agents/:id/secrets`. Names only on the way out; a `PUT` adopts an agent waiting for its key.
- Every model call is metered: `GET /v1/usage` (by agent, model, day, sender) and `GET /v1/agents/:id/turns`.
- Outbound webhooks, signed with Standard Webhooks: `POST`/`GET`/`DELETE /v1/webhooks`. A private receiver needs `DISPACH_WEBHOOK_ALLOW`.
- `limits.maxConcurrentTurns` and `limits.tokens`: over either, a turn is refused with `429`, never cut off.
- `GET /v1/activity` for a waker: idle or not, and when the next schedule is due.
- `model.result` carries `firstTokenMs`.

### Plugins

- **Breaking:** a plugin declares `dispachApi: "^0.2"` to load on 0.2. A plugin still on `^0.1` is refused at boot with `plugin_api_mismatch`, naming the range.
- A pre-release host is checked as the release it precedes: `0.2.0-pilot.1` satisfies `^0.2`.

### Fixes

- A container killed rather than stopped no longer blocks its replacement for 45 minutes on a dead pid-1 lease.
- WhatsApp's library loads only when a WhatsApp channel starts.
- `status` in a container no longer says "running in a terminal".
- A flag with a long placeholder in `--help` no longer runs into its description.

### Control plane (new, `packages/control`, FSL-1.1)

- Places one runtime per user (Docker), proxies `/silos/:subject/v1/…` with the silo's own keys, and creates, recreates, backs up, restores and deletes silos.
- Always on: `DISPACH_CONTROL_SUSPEND=on` pauses idle silos as a cost option, and is off by default. A backup no longer leaves a silo paused when suspend is off.
- The pilot monitor (`DISPACH_CONTROL_HOOK_URL`): rolling rates per silo, `GET /v1/monitor` and `/v1/monitor/failures`, and rate alerts to Telegram.

### Tooling

- `bun run eval:scenarios`: a real agent and model, mocked tools, and a calibrated judge.
- A tag with a `-` publishes a pre-release: npm `next`, a GitHub pre-release, no Homebrew formula, and no `latest` image tag.

## 0.1.3 — 2026-09-23

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
