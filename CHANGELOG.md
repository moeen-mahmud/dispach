# Changelog

## Unreleased

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.14

- `PATCH /v1/agents/:id/config` with a value already in the file writes nothing and does not reload the agent; the reply says `changed: false, reloaded: false`. A configuration applied in full on every sync no longer reloads the agent once per setting.
- `PATCH /config` takes `{changes: [{path, value} | {path, remove: true}, …]}`: several settings checked together, written once, one reload. Any refusal writes none. The single `{path, value}` body is unchanged. The client has `setConfigs(changes)`, and `setConfig`'s result now carries `changed` and `reloaded`.
- Removing a block's last key removes the block, so removing `limits.noProgress.sameTool` no longer leaves an empty `noProgress:` that would not load.
- `limits.noProgress` and `limits.noProgress.sameTool` are settable by a person through `PATCH /config` and the `config` command. `config_set` cannot change them.
- `media.speech`: a voice note is answered with the text reply and then a voice note of it. Typed messages are answered in text only, as before. The provider is `aws` (Amazon Polly: `options {region, voiceId, engine}`; needs `polly:SynthesizeSpeech`) or `openai` (`/audio/speech`). Voice notes go out on WhatsApp and Telegram, an audio file on Slack, and none on Teams. A long reply becomes several notes. Each note emits `media.result {kind: "speech", characters}`.
- Amazon Transcribe voice notes in formats other than Ogg/Opus and FLAC (Slack WebM, Teams M4A, MP3) are decoded with `ffmpeg` first. They were refused before. The image now includes `ffmpeg`.
- `turn.start` carries `inputKind: "voice"` when the input was a transcribed voice note.
- Each workspace file now reaches the model labelled with its name, in the model's delimiter style (`<file name="SOUL.md" tier="static">`, `## SOUL.md`, or `SOUL.md:`). The configuration block gains a `context files` row naming the files, and `config_read`'s summary lists `context.soul.file`, `context.static`, `context.volatile` and `context.reminder` (read-only) with the same note. Asked whether its files were loading, an agent saw no names, said they were not, and re-read them until `no_progress`. The first turn after upgrading misses the prompt cache once, because the cached prefix changed.
- `subagents` is settable as a whole list by a person or embedder through `PATCH /config` and `changes[]`, checked as at load (`subagent_tool_not_pinned` and the rest). The agent's `config_set` cannot set it. Any edit that unpins a slug a child uses is now refused instead of breaking the next boot.
- `subagents[].timeoutMs` bounds a child's routed calls instead of `limits.toolTimeoutMs`, so a slow child can get minutes while every other tool keeps its own bound.
- Bedrock: OpenAI models (`openai.*`, GPT-6 Luna and the rest) no longer repeat a tool call until `no_progress`. A turn's own calls and results now follow the person's message, as they already did for Claude and Nova. Before, the tool result and the restated question were sent as one message, and the model read it as a new request.
- A member's connected apps are theirs alone. Every Composio tool, and the tools of an MCP server declared `personal: true`, are left out of any turn that does not act for the agent's assigned owner: another member asking, a delegation from their agent, a stand-in, or a channel sender who is not the owner. A call to one is refused as `tool_personal`, with a `tool.gated` event. `PUT /v1/agents/:id/assignee` takes `channelIds`, the owner's own channel senders, so the owner's WhatsApp keeps their apps (store migration 30). Unassigned agents and turns with no person are unchanged.
- An agent that will not load can be repaired over the API, instead of answering 404 everywhere. `GET /v1/agents/:id` says `failed` with the load error, or `not_running`. `GET`/`PATCH /config` and `PATCH /vars` edit its files, answering `applied: false` until `POST /start`. The new `PUT /v1/agents/:id/workspace/:file` replaces a declared workspace file. On a running agent it reloads, and the old text is put back if the new one would not load. `context.budgets.*` is settable by a person.
- media-aws (Transcribe, Polly, Nova Canvas) reads a container-credentials endpoint itself, as Bedrock does. A silo's `169.254.170.2:4000` endpoint failed every voice note with "not a valid container metadata service hostname", and the endpoint's own refusal code (`credit_exhausted`) is now the media error's code.
- media-aws: an access refusal's hint now says in plain words what the agent's credentials do not allow (voice notes, spoken replies, image generation), then the one permission to grant. The old hint mentioned "the pod's service account", and agents repeated it to people.
- `context.modelIdentity: hidden` (default `shown`): the agent's prompt and `config_read` no longer name its model, endpoint, transport or key variable, nor its media models and providers. Everything else stays readable and settable. Person-only. Events and the API are unchanged.
- `memory_forget`, a local tool: `{query}` lists the agent's notes containing every word, with ids, and deletes nothing; `{ids}` deletes exactly those from the carried file and the archives, or from the space for the space writer. Past conversation messages the asking person said (or the agent replied in their turns) are listed too and redacted in place, along with the conversation that asked and any tool call or result elsewhere that carries the forgotten text (the call keeps its shape), the turn whose `memory_write` saved a deleted note (its reply included), and the silo's own webhook delivery log; the memory index is re-read at once; recall, a rebuild and an export cannot bring them back. Refused in rooms and stand-ins. Emits `memory.forgotten {scope, count, messages?}`. `init` pins it; it is not added to `policy.allow`.
- A turn records the participant it was taken for (`turns.participant_id`, migration 31).
- To stop an earlier conversation from being recalled (`includeHistory`), use `POST /v1/agents/:id/sessions/:key/recall {"recall": false}`, which keeps the history (pilot.10), or `DELETE /v1/agents/:id/sessions/:key`, which removes it and its index entries. A note saved in `MEMORY.md` is a file and has to be edited.

### Since 0.2.0-pilot.13

- Bedrock: Nova no longer fails on the second call of a native tool turn with "extraneous key [cachePoint] is not permitted". pilot.13's rolling cache point is left out of a Nova message that carries a tool result; Claude keeps it.
- `finalText` on a turn's result and on `turn.end`: the last step's prose alone. The reply still joins every step's, so a lead-in a model repeats before each tool call ("Yes, Outlook. Let me try…") appears once in `finalText`.
- `delivery.reply: final` (settable with `PATCH /config` and by the agent's `config_set`) makes a channel reply (WhatsApp, Telegram, Slack, Teams) the last step's prose alone. The default, `all`, keeps every step's joined, as before.
- Errors take an optional `detail`: a provider's own words, verbatim. Bedrock now puts AWS's text there instead of in `message`, so an access refusal's assumed-role ARN is no longer in what an embedder shows people. A failed turn's record carries it as `errorDetail` (store migration 29).
- `channels[].role` runs a channel's turns on a model role declared under `model:`, e.g. WhatsApp on a cheaper model than the web chat. Absent is `main`. A role that is not declared refuses the manifest.
- The reminder tier now opens with a line saying it is the agent's own instructions and the person did not write it. On Bedrock, any system message after the start of the conversation is sent fenced in `<system>…</system>` rather than as bare user text. A model had read an unframed reminder as something the person pasted.
- A workspace file that reaches the model with an unrendered `{{vars.…}}` placeholder is reported as `workspace_unrendered_var`, on the agent's warnings and by `validate`. A placeholder inside an HTML comment, which the model never sees, is not.
- `tools.providers.system.confineReads: true` confines `file_read`, `glob` and `grep` to the agent's directory and its `writeRoots`, a symlink pointing out included, so in a silo one agent cannot read another's notes. Off by default; `config_set` cannot set it; `exec` is not bound by it.
- `skills.trusted: [names]`: only these skills' scripts become tools, and `GET /v1/agents/:id/skills` marks each skill `trusted`. Any other skill, such as one a person uploaded or a community skill, is still used for its steps, and its scripts are listed as documentation only. Absent, every skill's scripts run, as before. `config_set` cannot set it.
- A tool pinned with `config_set` works without a restart. When its provider already has it (a slug `composio_search` just found), it is callable on the next step of the same turn. Either way the agent reloads once the turn ends, so it is pinned from the next message. Plugin API: `ToolContext.pinTools(slugs)`.
- A reload refused before it waited (a file on disk that does not load) now emits `agent.reloaded` with `ok: false`, as a refusal after the wait already did, so a webhook sees every refusal.

### Since 0.2.0-pilot.12

- Claude 5.x (Sonnet 5.5, Opus 5.5, Fable 5.1) with thinking: a tool turn no longer fails at its second step with "Invalid signature in thinking block … bound to a different conversation". For a role whose thinking is replayed, the turn's own calls and results now follow its input instead of preceding it, so each step only appends to the last. On Bedrock, a replay that is still refused (a compaction or phase change mid-turn) is sent again once without thinking, and reported as a retry. Other models keep today's order.
- Bedrock: prompt-caching models (Claude, Nova) get a rolling cache point at the end of every request, and their turn's trace follows the input, so each step of a tool loop reads the earlier steps from the cache instead of resending them at full price.
- `limits.noProgress.sameTool: N` ends a turn as `no_progress` after N calls to one tool, whatever the arguments. Off unless set.
- WhatsApp: a 515 "restart required" close reconnects at once, without showing "disconnected" or counting a failure.
- A recalled excerpt of another conversation (`memory.includeHistory`) now says it is a different conversation and background only, not a task to continue. A new chat had taken a just-finished chat's task as its own and re-proposed it until `no_progress`.
- New event `memory.recalled` lists the passages a turn's prompt recalled (`source`, `score`), so where something in a reply came from shows on the stream.
- Bedrock: Amazon Nova's `<thinking>…</thinking>`, which it writes into its reply text once it is given tools, is now treated as reasoning: shown and stored as reasoning, never in the reply. A tag split across stream chunks is handled. Other models' text is untouched.

### Since 0.2.0-pilot.11

- A tool provider is no longer asked to refresh a pinned slug another provider resolved. Composio fetched `GET /tools/<slug>` for every pinned MCP tool on each boot, reload and `tools/refresh`, and got a 404 each time; it now fetches only slugs nobody resolved, so a cold cache still heals.
- A backup's `store.db` no longer carries the serve leases of the process it was taken from. A restore that started within 90 seconds of the backup was refused with `agent_already_serving`, naming a pid that belonged to something else in the new container.

### Since 0.2.0-pilot.10

- `GET /v1/backup?include=home` adds the rest of the state directory under `home/`: stopped agents, templates, and anything an embedder keeps beside the store, such as a team drive and its git directory. It never adds the live `store.db*`, `logs/` or the `sources/` clone cache. `.env` files and the host token are added only with `include=env`, and `.git` directories only with `include=git`. `backup.json` records the directory, and the wire spec's restore steps cover it.
- A file that grows or shrinks while a backup is being read no longer corrupts the archive. Its entry holds exactly the size it had when the backup started.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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
















## 0.2.0-pilot.15 — 2026-10-08

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.14

- `PATCH /v1/agents/:id/config` with a value already in the file writes nothing and does not reload the agent; the reply says `changed: false, reloaded: false`. A configuration applied in full on every sync no longer reloads the agent once per setting.
- `PATCH /config` takes `{changes: [{path, value} | {path, remove: true}, …]}`: several settings checked together, written once, one reload. Any refusal writes none. The single `{path, value}` body is unchanged. The client has `setConfigs(changes)`, and `setConfig`'s result now carries `changed` and `reloaded`.
- Removing a block's last key removes the block, so removing `limits.noProgress.sameTool` no longer leaves an empty `noProgress:` that would not load.
- `limits.noProgress` and `limits.noProgress.sameTool` are settable by a person through `PATCH /config` and the `config` command. `config_set` cannot change them.
- `media.speech`: a voice note is answered with the text reply and then a voice note of it. Typed messages are answered in text only, as before. The provider is `aws` (Amazon Polly: `options {region, voiceId, engine}`; needs `polly:SynthesizeSpeech`) or `openai` (`/audio/speech`). Voice notes go out on WhatsApp and Telegram, an audio file on Slack, and none on Teams. A long reply becomes several notes. Each note emits `media.result {kind: "speech", characters}`.
- Amazon Transcribe voice notes in formats other than Ogg/Opus and FLAC (Slack WebM, Teams M4A, MP3) are decoded with `ffmpeg` first. They were refused before. The image now includes `ffmpeg`.
- `turn.start` carries `inputKind: "voice"` when the input was a transcribed voice note.
- Each workspace file now reaches the model labelled with its name, in the model's delimiter style (`<file name="SOUL.md" tier="static">`, `## SOUL.md`, or `SOUL.md:`). The configuration block gains a `context files` row naming the files, and `config_read`'s summary lists `context.soul.file`, `context.static`, `context.volatile` and `context.reminder` (read-only) with the same note. Asked whether its files were loading, an agent saw no names, said they were not, and re-read them until `no_progress`. The first turn after upgrading misses the prompt cache once, because the cached prefix changed.
- `subagents` is settable as a whole list by a person or embedder through `PATCH /config` and `changes[]`, checked as at load (`subagent_tool_not_pinned` and the rest). The agent's `config_set` cannot set it. Any edit that unpins a slug a child uses is now refused instead of breaking the next boot.
- `subagents[].timeoutMs` bounds a child's routed calls instead of `limits.toolTimeoutMs`, so a slow child can get minutes while every other tool keeps its own bound.
- Bedrock: OpenAI models (`openai.*`, GPT-6 Luna and the rest) no longer repeat a tool call until `no_progress`. A turn's own calls and results now follow the person's message, as they already did for Claude and Nova. Before, the tool result and the restated question were sent as one message, and the model read it as a new request.
- A member's connected apps are theirs alone. Every Composio tool, and the tools of an MCP server declared `personal: true`, are left out of any turn that does not act for the agent's assigned owner: another member asking, a delegation from their agent, a stand-in, or a channel sender who is not the owner. A call to one is refused as `tool_personal`, with a `tool.gated` event. `PUT /v1/agents/:id/assignee` takes `channelIds`, the owner's own channel senders, so the owner's WhatsApp keeps their apps (store migration 30). Unassigned agents and turns with no person are unchanged.
- An agent that will not load can be repaired over the API, instead of answering 404 everywhere. `GET /v1/agents/:id` says `failed` with the load error, or `not_running`. `GET`/`PATCH /config` and `PATCH /vars` edit its files, answering `applied: false` until `POST /start`. The new `PUT /v1/agents/:id/workspace/:file` replaces a declared workspace file. On a running agent it reloads, and the old text is put back if the new one would not load. `context.budgets.*` is settable by a person.
- media-aws (Transcribe, Polly, Nova Canvas) reads a container-credentials endpoint itself, as Bedrock does. A silo's `169.254.170.2:4000` endpoint failed every voice note with "not a valid container metadata service hostname", and the endpoint's own refusal code (`credit_exhausted`) is now the media error's code.
- media-aws: an access refusal's hint now says in plain words what the agent's credentials do not allow (voice notes, spoken replies, image generation), then the one permission to grant. The old hint mentioned "the pod's service account", and agents repeated it to people.
- `context.modelIdentity: hidden` (default `shown`): the agent's prompt and `config_read` no longer name its model, endpoint, transport or key variable, nor its media models and providers. Everything else stays readable and settable. Person-only. Events and the API are unchanged.
- `memory_forget`, a local tool: `{query}` lists the agent's notes containing every word, with ids, and deletes nothing; `{ids}` deletes exactly those from the carried file and the archives, or from the space for the space writer. Past conversation messages the asking person said (or the agent replied in their turns) are listed too and redacted in place, along with the conversation that asked and any tool call or result elsewhere that carries the forgotten text (the call keeps its shape), the turn whose `memory_write` saved a deleted note (its reply included), and the silo's own webhook delivery log; the memory index is re-read at once; recall, a rebuild and an export cannot bring them back. Refused in rooms and stand-ins. Emits `memory.forgotten {scope, count, messages?}`. `init` pins it; it is not added to `policy.allow`.
- A turn records the participant it was taken for (`turns.participant_id`, migration 31).
- To stop an earlier conversation from being recalled (`includeHistory`), use `POST /v1/agents/:id/sessions/:key/recall {"recall": false}`, which keeps the history (pilot.10), or `DELETE /v1/agents/:id/sessions/:key`, which removes it and its index entries. A note saved in `MEMORY.md` is a file and has to be edited.

### Since 0.2.0-pilot.13

- Bedrock: Nova no longer fails on the second call of a native tool turn with "extraneous key [cachePoint] is not permitted". pilot.13's rolling cache point is left out of a Nova message that carries a tool result; Claude keeps it.
- `finalText` on a turn's result and on `turn.end`: the last step's prose alone. The reply still joins every step's, so a lead-in a model repeats before each tool call ("Yes, Outlook. Let me try…") appears once in `finalText`.
- `delivery.reply: final` (settable with `PATCH /config` and by the agent's `config_set`) makes a channel reply (WhatsApp, Telegram, Slack, Teams) the last step's prose alone. The default, `all`, keeps every step's joined, as before.
- Errors take an optional `detail`: a provider's own words, verbatim. Bedrock now puts AWS's text there instead of in `message`, so an access refusal's assumed-role ARN is no longer in what an embedder shows people. A failed turn's record carries it as `errorDetail` (store migration 29).
- `channels[].role` runs a channel's turns on a model role declared under `model:`, e.g. WhatsApp on a cheaper model than the web chat. Absent is `main`. A role that is not declared refuses the manifest.
- The reminder tier now opens with a line saying it is the agent's own instructions and the person did not write it. On Bedrock, any system message after the start of the conversation is sent fenced in `<system>…</system>` rather than as bare user text. A model had read an unframed reminder as something the person pasted.
- A workspace file that reaches the model with an unrendered `{{vars.…}}` placeholder is reported as `workspace_unrendered_var`, on the agent's warnings and by `validate`. A placeholder inside an HTML comment, which the model never sees, is not.
- `tools.providers.system.confineReads: true` confines `file_read`, `glob` and `grep` to the agent's directory and its `writeRoots`, a symlink pointing out included, so in a silo one agent cannot read another's notes. Off by default; `config_set` cannot set it; `exec` is not bound by it.
- `skills.trusted: [names]`: only these skills' scripts become tools, and `GET /v1/agents/:id/skills` marks each skill `trusted`. Any other skill, such as one a person uploaded or a community skill, is still used for its steps, and its scripts are listed as documentation only. Absent, every skill's scripts run, as before. `config_set` cannot set it.
- A tool pinned with `config_set` works without a restart. When its provider already has it (a slug `composio_search` just found), it is callable on the next step of the same turn. Either way the agent reloads once the turn ends, so it is pinned from the next message. Plugin API: `ToolContext.pinTools(slugs)`.
- A reload refused before it waited (a file on disk that does not load) now emits `agent.reloaded` with `ok: false`, as a refusal after the wait already did, so a webhook sees every refusal.

### Since 0.2.0-pilot.12

- Claude 5.x (Sonnet 5.5, Opus 5.5, Fable 5.1) with thinking: a tool turn no longer fails at its second step with "Invalid signature in thinking block … bound to a different conversation". For a role whose thinking is replayed, the turn's own calls and results now follow its input instead of preceding it, so each step only appends to the last. On Bedrock, a replay that is still refused (a compaction or phase change mid-turn) is sent again once without thinking, and reported as a retry. Other models keep today's order.
- Bedrock: prompt-caching models (Claude, Nova) get a rolling cache point at the end of every request, and their turn's trace follows the input, so each step of a tool loop reads the earlier steps from the cache instead of resending them at full price.
- `limits.noProgress.sameTool: N` ends a turn as `no_progress` after N calls to one tool, whatever the arguments. Off unless set.
- WhatsApp: a 515 "restart required" close reconnects at once, without showing "disconnected" or counting a failure.
- A recalled excerpt of another conversation (`memory.includeHistory`) now says it is a different conversation and background only, not a task to continue. A new chat had taken a just-finished chat's task as its own and re-proposed it until `no_progress`.
- New event `memory.recalled` lists the passages a turn's prompt recalled (`source`, `score`), so where something in a reply came from shows on the stream.
- Bedrock: Amazon Nova's `<thinking>…</thinking>`, which it writes into its reply text once it is given tools, is now treated as reasoning: shown and stored as reasoning, never in the reply. A tag split across stream chunks is handled. Other models' text is untouched.

### Since 0.2.0-pilot.11

- A tool provider is no longer asked to refresh a pinned slug another provider resolved. Composio fetched `GET /tools/<slug>` for every pinned MCP tool on each boot, reload and `tools/refresh`, and got a 404 each time; it now fetches only slugs nobody resolved, so a cold cache still heals.
- A backup's `store.db` no longer carries the serve leases of the process it was taken from. A restore that started within 90 seconds of the backup was refused with `agent_already_serving`, naming a pid that belonged to something else in the new container.

### Since 0.2.0-pilot.10

- `GET /v1/backup?include=home` adds the rest of the state directory under `home/`: stopped agents, templates, and anything an embedder keeps beside the store, such as a team drive and its git directory. It never adds the live `store.db*`, `logs/` or the `sources/` clone cache. `.env` files and the host token are added only with `include=env`, and `.git` directories only with `include=git`. `backup.json` records the directory, and the wire spec's restore steps cover it.
- A file that grows or shrinks while a backup is being read no longer corrupts the archive. Its entry holds exactly the size it had when the backup started.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.14 — 2026-10-07

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.13

- Bedrock: Nova no longer fails on the second call of a native tool turn with "extraneous key [cachePoint] is not permitted". pilot.13's rolling cache point is left out of a Nova message that carries a tool result; Claude keeps it.
- `finalText` on a turn's result and on `turn.end`: the last step's prose alone. The reply still joins every step's, so a lead-in a model repeats before each tool call ("Yes, Outlook. Let me try…") appears once in `finalText`.
- Errors take an optional `detail`: a provider's own words, verbatim. Bedrock now puts AWS's text there instead of in `message`, so an access refusal's assumed-role ARN is no longer in what an embedder shows people. A failed turn's record carries it as `errorDetail` (store migration 29).
- `channels[].role` runs a channel's turns on a model role declared under `model:`, e.g. WhatsApp on a cheaper model than the web chat. Absent is `main`. A role that is not declared refuses the manifest.
- The reminder tier now opens with a line saying it is the agent's own instructions and the person did not write it. On Bedrock, any system message after the start of the conversation is sent fenced in `<system>…</system>` rather than as bare user text. A model had read an unframed reminder as something the person pasted.
- A workspace file that reaches the model with an unrendered `{{vars.…}}` placeholder is reported as `workspace_unrendered_var`, on the agent's warnings and by `validate`. A placeholder inside an HTML comment, which the model never sees, is not.
- `tools.providers.system.confineReads: true` confines `file_read`, `glob` and `grep` to the agent's directory and its `writeRoots`, a symlink pointing out included, so in a silo one agent cannot read another's notes. Off by default; `config_set` cannot set it; `exec` is not bound by it.
- `skills.trusted: [names]`: only these skills' scripts become tools. Any other skill, such as one a person uploaded or a community skill, is still used for its steps, and its scripts are listed as documentation only. Absent, every skill's scripts run, as before. `config_set` cannot set it.
- A tool pinned with `config_set` works without a restart. When its provider already has it (a slug `composio_search` just found), it is callable on the next step of the same turn. Either way the agent reloads once the turn ends, so it is pinned from the next message. Plugin API: `ToolContext.pinTools(slugs)`.
- A reload refused before it waited (a file on disk that does not load) now emits `agent.reloaded` with `ok: false`, as a refusal after the wait already did, so a webhook sees every refusal.

### Since 0.2.0-pilot.12

- Claude 5.x (Sonnet 5.5, Opus 5.5, Fable 5.1) with thinking: a tool turn no longer fails at its second step with "Invalid signature in thinking block … bound to a different conversation". For a role whose thinking is replayed, the turn's own calls and results now follow its input instead of preceding it, so each step only appends to the last. On Bedrock, a replay that is still refused (a compaction or phase change mid-turn) is sent again once without thinking, and reported as a retry. Other models keep today's order.
- Bedrock: prompt-caching models (Claude, Nova) get a rolling cache point at the end of every request, and their turn's trace follows the input, so each step of a tool loop reads the earlier steps from the cache instead of resending them at full price.
- `limits.noProgress.sameTool: N` ends a turn as `no_progress` after N calls to one tool, whatever the arguments. Off unless set.
- WhatsApp: a 515 "restart required" close reconnects at once, without showing "disconnected" or counting a failure.
- A recalled excerpt of another conversation (`memory.includeHistory`) now says it is a different conversation and background only, not a task to continue. A new chat had taken a just-finished chat's task as its own and re-proposed it until `no_progress`.
- New event `memory.recalled` lists the passages a turn's prompt recalled (`source`, `score`), so where something in a reply came from shows on the stream.
- Bedrock: Amazon Nova's `<thinking>…</thinking>`, which it writes into its reply text once it is given tools, is now treated as reasoning: shown and stored as reasoning, never in the reply. A tag split across stream chunks is handled. Other models' text is untouched.

### Since 0.2.0-pilot.11

- A tool provider is no longer asked to refresh a pinned slug another provider resolved. Composio fetched `GET /tools/<slug>` for every pinned MCP tool on each boot, reload and `tools/refresh`, and got a 404 each time; it now fetches only slugs nobody resolved, so a cold cache still heals.
- A backup's `store.db` no longer carries the serve leases of the process it was taken from. A restore that started within 90 seconds of the backup was refused with `agent_already_serving`, naming a pid that belonged to something else in the new container.

### Since 0.2.0-pilot.10

- `GET /v1/backup?include=home` adds the rest of the state directory under `home/`: stopped agents, templates, and anything an embedder keeps beside the store, such as a team drive and its git directory. It never adds the live `store.db*`, `logs/` or the `sources/` clone cache. `.env` files and the host token are added only with `include=env`, and `.git` directories only with `include=git`. `backup.json` records the directory, and the wire spec's restore steps cover it.
- A file that grows or shrinks while a backup is being read no longer corrupts the archive. Its entry holds exactly the size it had when the backup started.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.13 — 2026-10-07

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.12

- Claude 5.x (Sonnet 5.5, Opus 5.5, Fable 5.1) with thinking: a tool turn no longer fails at its second step with "Invalid signature in thinking block … bound to a different conversation". For a role whose thinking is replayed, the turn's own calls and results now follow its input instead of preceding it, so each step only appends to the last. On Bedrock, a replay that is still refused (a compaction or phase change mid-turn) is sent again once without thinking, and reported as a retry. Other models keep today's order.
- Bedrock: prompt-caching models (Claude, Nova) get a rolling cache point at the end of every request, and their turn's trace follows the input, so each step of a tool loop reads the earlier steps from the cache instead of resending them at full price.
- `limits.noProgress.sameTool: N` ends a turn as `no_progress` after N calls to one tool, whatever the arguments. Off unless set.
- WhatsApp: a 515 "restart required" close reconnects at once, without showing "disconnected" or counting a failure.
- A recalled excerpt of another conversation (`memory.includeHistory`) now says it is a different conversation and background only, not a task to continue. A new chat had taken a just-finished chat's task as its own and re-proposed it until `no_progress`.
- New event `memory.recalled` lists the passages a turn's prompt recalled (`source`, `score`), so where something in a reply came from shows on the stream.
- Bedrock: Amazon Nova's `<thinking>…</thinking>`, which it writes into its reply text once it is given tools, is now treated as reasoning: shown and stored as reasoning, never in the reply. A tag split across stream chunks is handled. Other models' text is untouched.

### Since 0.2.0-pilot.11

- A tool provider is no longer asked to refresh a pinned slug another provider resolved. Composio fetched `GET /tools/<slug>` for every pinned MCP tool on each boot, reload and `tools/refresh`, and got a 404 each time; it now fetches only slugs nobody resolved, so a cold cache still heals.
- A backup's `store.db` no longer carries the serve leases of the process it was taken from. A restore that started within 90 seconds of the backup was refused with `agent_already_serving`, naming a pid that belonged to something else in the new container.

### Since 0.2.0-pilot.10

- `GET /v1/backup?include=home` adds the rest of the state directory under `home/`: stopped agents, templates, and anything an embedder keeps beside the store, such as a team drive and its git directory. It never adds the live `store.db*`, `logs/` or the `sources/` clone cache. `.env` files and the host token are added only with `include=env`, and `.git` directories only with `include=git`. `backup.json` records the directory, and the wire spec's restore steps cover it.
- A file that grows or shrinks while a backup is being read no longer corrupts the archive. Its entry holds exactly the size it had when the backup started.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.12 — 2026-10-07

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.11

- A tool provider is no longer asked to refresh a pinned slug another provider resolved. Composio fetched `GET /tools/<slug>` for every pinned MCP tool on each boot, reload and `tools/refresh`, and got a 404 each time; it now fetches only slugs nobody resolved, so a cold cache still heals.
- A backup's `store.db` no longer carries the serve leases of the process it was taken from. A restore that started within 90 seconds of the backup was refused with `agent_already_serving`, naming a pid that belonged to something else in the new container.

### Since 0.2.0-pilot.10

- `GET /v1/backup?include=home` adds the rest of the state directory under `home/`: stopped agents, templates, and anything an embedder keeps beside the store, such as a team drive and its git directory. It never adds the live `store.db*`, `logs/` or the `sources/` clone cache. `.env` files and the host token are added only with `include=env`, and `.git` directories only with `include=git`. `backup.json` records the directory, and the wire spec's restore steps cover it.
- A file that grows or shrinks while a backup is being read no longer corrupts the archive. Its entry holds exactly the size it had when the backup started.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.11 — 2026-10-06

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.10

- `GET /v1/backup?include=home` adds the rest of the state directory under `home/`: stopped agents, templates, and anything an embedder keeps beside the store, such as a team drive and its git directory. It never adds the live `store.db*`, `logs/` or the `sources/` clone cache. `.env` files and the host token are added only with `include=env`, and `.git` directories only with `include=git`. `backup.json` records the directory, and the wire spec's restore steps cover it.
- A file that grows or shrinks while a backup is being read no longer corrupts the archive. Its entry holds exactly the size it had when the backup started.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.10 — 2026-10-06

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.9

- `tools.providers.web.baseUrl` (the search backend) and `tools.providers.web.firecrawl.baseUrl` (scrape, crawl, map) point the web provider at a relay with the same paths and bodies, so a platform key need not be in the agent's environment. `tool.usage` is unchanged.
- `config_set` can no longer set any provider's `baseUrl`, by path or inside a `tools.providers` value. Composio's was settable before, which let an agent send its token to an address of its choosing.
- An agent asked by another member's agent is now also told that its owner's private notes and memory are not in the turn, and to say it cannot confirm something it cannot check (availability, a preference) rather than guess. Not said when the owner is the one asking.
- Bedrock: a 5xx from the container-credentials endpoint carries the body's own `code` (or `bedrock_credentials_unavailable`) and is retried, instead of reaching the turn as `model_http_error`.
- `POST /v1/agents/:id/sessions/:key/recall {recall: false}` takes a conversation out of history recall without deleting it: its passages go at once and stay out. `true` puts it back. The session then reads `recall: false`; the client's `setRecall` sends it.
- `GET /v1/backup?include=env,git` adds each agent's `.env` and `.git`, and `backup.json` records each agent's directory. Restoring is documented in the wire spec: with the server stopped, `store.db` to the store path and each `agents/<id>/` to its recorded directory.
- The wire spec lists what `tool.usage`'s `units` counts for each web provider and operation.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.9 — 2026-10-06

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.8

- `tools.providers.system.env: scrub` (or a list of names to pass) keeps the runtime's secrets out of what `exec` and skill scripts see. It is off by default, so nothing changes until a manifest sets it, and the agent cannot change it.
- `X_FILE` sets `X` from that file when the CLI starts, unless `X` is set already. The value never appears in the process's environment block. `AWS_*` is left to the SDK.
- Bedrock: when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set, the endpoint's own refusal code (for example `credit_exhausted`) is the turn's error code, terminal, instead of `bedrock_credentials_missing`.
- Firecrawl, first-class: `tools.providers.web.firecrawl: {}` routes `web_fetch` through Firecrawl's scrape (JavaScript pages come back as markdown) and adds `web_crawl` and `web_map`. `backend: firecrawl` is a search backend too.
- Every web search, scrape, crawl and map emits `tool.usage` (`provider`, `unit`, `units`, `participant`). Any tool can report its spend this way through `ToolContext.meter`.
- An agent asked by another member's agent is told whose agent it is and who is asking. Participants take `title` and `timezone` (`POST /v1/participants`), and both appear in that note.
- An MCP server's `turnHeader` sends the turn id with every call, and the call id in `<turnHeader>-Call`.
- `GET /v1/backup` (admin, unscoped key) streams the silo as a tar.gz: a consistent store snapshot plus every hosted agent's directory, without `.env` files.
- `GET /v1/agents/:id/assignee` reads the assignment back.
- `exec` no longer says "the requested timeout was longer than allowed" on a call that asked for no timeout. It said so on every such call, because the declared default was clamped.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.8 — 2026-10-05

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.7

- `PATCH /config` takes `{path, remove: true}` to take a field out of the manifest, so it returns to its default, with the same checks as a set: a required field is refused, and a field that is not there is left alone. The client's `removeConfig(path)` sends it.
- Security fixes from development: the code-scanning and Dependabot findings, the websocket's internal errors logging their cause, and a security policy with private reporting.
- Bedrock: GPT-6 models (`openai.gpt-6*`, Luna among them) are no longer sent `temperature` or `topP`, which they refuse on every turn. A role that sets either gets a `model_sampling_unsupported` warning at load, as Claude 4.7 and later do. gpt-oss and Nova still get both.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.7 — 2026-10-05

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.6

- `POST /messages` takes `role`: run that turn on a model role declared under `model:`, as a schedule does. An undeclared role is refused before the turn starts (`model_role_unknown`). The client's `send` takes it too.
- A person adds or replaces a named role with `PATCH /config path model.<name>` (a map: `{id, api or baseUrl, apiKeyEnv, …}`).
- A turn on any role other than main, a schedule's or a message's, is budgeted against that role's own context window instead of main's.
- Photos sent on Telegram, WhatsApp, Slack and Teams reach the model with the turn, as `POST /messages` `images` do (at most five, each up to 3.75 MB). On a model that reads no images, the sender is told so. Channel plugins put them on `RawInbound.images`.
- Two members' agents may delegate to each other (`delegation.to` both ways). This was refused at load as `team_cycle`. A delegation is one hop: the asked agent cannot hand the work on.
- An agent asked by another member's agent reads its owner's shared notes and the space, not its private memory, unless it is working for its own owner. Before, a delegated turn read everything and returned the result to the person who asked.
- `PATCH /config` sets `delegation.offer` and `delegation.to`. An offer change reloads the agents that may ask, and each one is reported under `peers`.
- Under NLT, a tool field that takes a list of objects works: a JSON list kept its objects as `"[object Object]"` and was refused, and `{…}, {…}` or a pretty-printed object was split into fragments. The catalogue now names an object field's own keys instead of `list of object` alone.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.6 — 2026-10-05

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.5

- Bedrock: Claude 4.7 and later (Sonnet 5.5, Opus 5.5) take `reasoningEffort` as adaptive thinking with an effort instead of the thinking budget they refuse. `reasoningEffort` gains `xhigh` and `max`. `none` is each model's own off switch, or low effort where thinking cannot be turned off, said at load. `temperature` and `topP` are not sent to models that refuse them. `openai.*` models get the effort as `reasoning: {effort}`.
- `gpt-6*` resolves to its own capability row (1,050,000 window, 128,000 output, native tools, vision; VelaCrew's figures).
- A refused reply (a model's safety classifier, a guardrail, or a chat-completions `content_filter` finish) ends the turn as an error, `model_refused`, instead of an empty answer.
- `subagents:` runs a routed tool call in a throwaway child of the same agent. The parent reads the child's artifact (`{summary}` by default) instead of the raw output. Routing happens after the policy and the write gate, so a refused call starts no child.
- A child inherits its parent's taint, stand-in deferral, acting participant and cancellation, and never spawns one of its own. Its tools must be ones the parent pins.
- `model.subagent` (or `subagents[].model`) runs children on a cheaper model. Their usage rows and `model.result` events say `role: subagent`.
- A subagent's events carry `parentTurnId` and `parentSessionKey`, and `handoff.start`/`handoff.result` gain `kind`, `name` and the parent's `callId`. A turn's stream includes its subagents' events with `children: true` (also on the client's `stream()`), and still ends on its own `turn.end`. A key scoped to a session reaches the subagents that session ran.
- The chat shows a routed call's subagent under its tool row: one line (`↳ subagent inbox · 3 steps · 1.2k tokens · ok`) that ⌥r opens to the child's calls, in the TUI and as a folded block in the web UI. ⌥r works on a model that streams no reasoning when there is a subagent block to open.
- A turn whose own tool result pushed the prompt past compaction's first threshold could lose its whole history mid-turn, repeat the call and end in `no_progress` (since 0.1.0). It happened whenever the compaction stages that ran could change nothing, which is the usual case for one large result in the current turn.
- A subagent is told what the person asked, ahead of the call it was handed, and reads its call's whole output up to its own window rather than the parent's `observationMaxTokens`.
- `submit_artifact` must be the only call in its step (`ToolSpec.alone`). A subagent or team member that submitted in the same step as its tool call was reporting a result that did not exist yet.
- Under the NLT dialect, an unclosed `<invoke name="…">` line is treated as an attempted call and asked for again, instead of being shown as the reply.
- `bun run eval:subagents` measures routed calls against keeping the work in the parent's context (`evals/subagents/`).
- The web chat shows a quick reply as it arrives. A reply whose tokens finished before the page attached to the turn was missing from the replay, so the page drew no reply until a reload. The client's `send` takes `chunks: true` to record a turn's tokens from its first one, and the web sends with it.
- Conversation lists (the web sidebar, the TUI's session picker, `run --continue`) leave out the sessions a subagent or a team handoff ran in. The API still lists them.
- `run --continue` and a bare `run --session` no longer fail with "Cannot access 'source' before initialization" when no host is running (broken since 0.1.0).
- Bedrock: a tool turn in a fresh session no longer fails on its second step with "A conversation must start with a user message" (Nova Micro under the NLT dialect). The turn's input is sent first whenever the request would otherwise open with the model's own call, under both dialects.
- `run --plain` prints only its own conversation's events, so a subagent's reply no longer appears inside the parent's.
- The release image builds its tarball once, natively, instead of once per platform under emulation.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.5 — 2026-10-02

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.4

- A tool result cut to fit `observationMaxTokens` is stored whole, and its marker names the id to read it with `artifact_read`. Reading an untrusted result back is untrusted too, so it no longer reopens the write gate.
- `GET /v1/agents/:id` answers a stopped agent with the listing's `status: "disabled"` row instead of 404. Routes that act on it are still 404.
- The `workspace_rule_budget` refusal names the lines it counted and their files. `context.rules.onExceed` is settable through `PATCH /config` (by a person), so a misread line no longer holds every reload.
- Under `tools.dialect: native` a skill script (`skill.pdf.extract`) is sent as `skill__pdf__extract` instead of failing the turn that activates it.
- Nova Micro, Lite and Pro resolve to their own capability rows (window, output, tools) instead of the 8,192-token fallback.
- A release run from a branch says it built and pushed nothing, and tags its build with the version.
- `POST /messages` takes `images`: a path inside the agent's directory (or inline base64), PNG, JPEG, GIF or WebP. The model sees them on that turn through Bedrock or an OpenAI-compatible endpoint; history keeps `[image: <path>]`. A model without vision refuses with `model_no_vision`, and `capabilities.vision` can say otherwise. The client's `send` takes `images` too.
- A schedule takes `tools.allow` (the phase grammar), `timeoutMs` and `maxSteps`, in the manifest and over the API. They only narrow the agent's own tools and `limits`; an allow entry naming nothing is `schedule_tool_unknown`. `POST …/schedules/:sid/run` runs with the same limits as a timed fire.
- `POST /messages` takes `runtimeNote`: your application's note about the message (the active project, today's date), shown to the model in its own block labelled as not the person's, for that turn only. It is kept on the turn record (`note`) and never in history. A peer agent cannot send one. The client's `send` takes it too.
- `tools.eventDetail: redacted` (off by default, a person's setting) adds the call's arguments to `tool.call` and the first 2 KB of its output to `tool.result`. Credential-named fields and the values of secret-named environment variables are replaced with `[redacted]`.
- `POST /v1/agents/:id/tools/refresh {providers?}` fetches the tool providers' catalogues and schemas now, and reloads the agent only if what it serves changed (a reload during a turn lands when the turn ends, 202). It reports `added`, `removed`, `changed` and `reload`, and emits `agent.tools.refreshed`.
- `PATCH /v1/agents/:id/vars {vars}` applies changed template variables to an agent made from a template: only files nobody edited since they were rendered are rewritten (`skipped` names the rest), memory never is, and the agent reloads. A result the agent refuses to load is put back. Agents created from a template now carry `.template.json` for this.
- `ink` and `react` are optional dependencies, so an application using `dispach/client` can install with `--omit=optional` and get no terminal UI. A default install is unchanged. A UI command on such an install says which package is missing. (The client has imported nothing and shipped complete types since pilot.3.)
- A scheduled run that ends `timeout`, `max_steps`, `no_progress` or `error` is recorded as an error, and `schedule.error` carries the turn's code (`turn_timeout`, …). It used to be recorded `ok`.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.4 — 2026-10-01

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.3

- A path rule in `tools.policy` matches the normalised path: `workspace/../.env` no longer walks past `deny: ["file_read(.env)"]`.
- `model.main.maxTokens`, `model.main.reasoningEffort` and `tools.budget.max` are settable through settings and `PATCH /config` (by a person, not the agent). Under Bedrock thinking the answer gets 16,384 tokens past the budget, up from 4,096.
- A model role no schedule names yet loads, unless it looks like a typo of `main`, `selector` or `compactor`.
- A Bedrock credentials endpoint that refuses is `bedrock_credentials_refused` with its status, not `bedrock_credentials_missing`.
- `DELETE /v1/agents/:id?confirm=<id>` deletes an agent for good: off the host, out of the store, and its sandbox directory last. Admin; refuses an id two directories share.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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

## 0.2.0-pilot.3 — 2026-10-01

A pre-release for the multiplayer runtime: one silo per user, run by a control plane.

### Since 0.2.0-pilot.2

- `POST /v1/agents/:id/deliveries {channel, to, text, key}`: exact text on one of the agent's channels, with no turn, through the outbox. The text joins that conversation's history as the agent's. `admin`; a repeated `key` is neither sent nor recorded again.
- A tool schema's nullable field (`type: ["string", "null"]`, or `anyOf` with `{type: "null"}`) is read as its type; only a union of two real types is refused. An MCP tool nobody pinned can no longer refuse the whole agent.
- `file_read` and `grep` never read a secret: `.env` and key files, credential directories, and a process's `environ`, through a symlink too.
- A tool argument that is a list of objects arrives as objects; each item was turned into text first, so the call failed, then its repair, and the turn ended `tool_repair_failed`.
- `dispach/client` and `dispach/wire` ship self-contained type declarations. They re-exported packages nobody can install, so every imported type was unresolved; `verify:package` now type-checks them from a clean install.

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
