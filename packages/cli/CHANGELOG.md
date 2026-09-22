# dispach

## 0.1.2

### Patch Changes

- **`init` knows the endpoints people actually use.** OpenRouter, Groq, NVIDIA NIM and Ollama Cloud
  join the presets. Any OpenAI-compatible `/chat/completions` endpoint already worked — there is no
  provider branch in the transport — so what a preset buys is getting the base URL's _shape_ right: it
  must end at the version segment, because the runtime appends `/chat/completions` itself and a URL
  copied from a provider's docs with the full path is refused.

  **Local Ollama and Ollama Cloud are two presets on purpose.** Local needs no key, and the absent
  `apiKeyEnv` is what makes the manifest omit the field and the provider send no `authorization`
  header at all. The hosted endpoint needs one. With a single preset, choosing it and then editing the
  base URL to the hosted endpoint — the obvious move — produced a keyless manifest with no route to a
  key short of hand-editing the field back in.

  `--preset`'s help text is now **derived from the preset table** rather than written beside it, where
  it had already drifted to five names against nine rows.

  Found while there: `validateApiKeyEnv` and `validateBaseUrls` both iterated a hardcoded
  `["main", "selector", "compactor"]` while the loader walks custom roles too — so a **custom role's**
  `apiKeyEnv` and `baseUrl` were never validated, and those three checks are the whole of that field's
  validation. A custom role naming an unset key loaded cleanly and 401'd at the first turn that used
  it; one whose base URL included `/chat/completions` 404'd there.

- **A model id that matches only a _family_ row now says so.** Reported as "deepseek v4.1 flash seems
  not working", and the mechanism was not a failed match. The capability registry globs `*` and picks
  by specificity, so `deepseek-v4.1-flash` matched `deepseek-v4*` — 11 non-`*` characters — rather than
  the measured `deepseek-v4-flash*` at 17, because the registry cannot express "v4.`<anything>`-flash"
  as a literal prefix. The agent then budgeted against **393,216 tokens against a measured 1,048,576**,
  37.5% of the window, and nothing anywhere reported it: `validate` printed `registry deepseek-v4*`,
  which is exactly what a precise match prints, and the boot warning only fires when no row matched at
  all.

  `family` is now a third provenance between `registry` and `fallback`, with its own warning, because
  "no row matched" and "a family row matched, which is not your model" send a reader to different
  places — the second means a measured sibling may be one version segment away. `registryShadows`
  asserts that any pattern a longer pattern extends is marked as a family, so adding a narrow row
  cannot silently turn the row beneath it into an unmarked net, which is what happened here.

  No pattern was added for v4.1 ids. That would claim a measured number for something nobody has
  probed; `model probe <agent> --window` is the honest route, and the pattern can land with the number
  and the date beside it.

- **A shell command cut in half by a blank line is refused rather than run.** The NLT parser clears an
  open field when it sees a blank line — deliberately, so prose does not glue onto the last value — and
  a model that writes a multi-line script without wrapping it therefore loses everything after the
  first blank. The parser already caught two shapes of that: a value spanning lines unwrapped, and a
  shell heredoc whose terminator never arrived.

  What it could not catch is a value cut after a _single_ line that looks complete.
  `command: ./deploy.sh --stage` is a valid command, so nothing raises, the shell runs it, and the
  flags that followed the blank line are delivered as the reply.

  The obvious detector is unusable, and that is the interesting part: the damaged shape is **textually
  identical** to the most ordinary output there is — a call, a blank line, then the model's reply. A
  detector that fired on it would spend a repair on every model that omits `END`, which costs far more
  than the bug. The discriminator is the **orphan `END`**: a closer arriving with no block open can
  only mean the model believed it was still inside the block the prose interrupted, so the prose was
  the rest of the value. Exact rather than heuristic, and it needs no guess about the prose.

  The root cause is unchanged and stays that way — tolerating blank lines inside values is its own bug,
  and the set of shapes a model writes is not enumerable, which is why a backstop exists at all. This
  makes the loss visible so the step is refused and repaired.

  Evidence, stated rather than implied: replaying the committed 16-attempt corpus gives **identical
  flagged counts** before and after — no regression and no false positive — and no attempt in that
  corpus exhibits the shape, because the two previously-recorded `split` cases were already caught by
  the multi-line signal. This closes a reachable gap rather than an observed one.

- **The HTTP API is on by default, and `init` no longer asks.** "Serve the HTTP API?" defaulted to
  _No_ — the wizard's internal default for a menu is a 1-based index, and element 0 of that list is
  `none` — so `--yes`, the non-interactive funnel and `GET /v1/provision` all produced an agent with
  its API switched off.

  Which is asking whether somebody wants the product. An always-on server is what this runtime is:
  `dispach run` and `dispach web run` are _views_ that attach to a live host and start nothing, and
  nobody answers no at minute two of setting an agent up. The question is withdrawn and `--server none`
  is the opt-out, which is exactly the precedent the `schedules` question set when it was removed — the
  flag stays, the step does not, and the default moves to the one funnel both paths pass through.

  Two consequences carried deliberately. The "keep it running in the background?" question was gated on
  having a channel _or_ a server, so it is now always asked — with the server answer gone, the
  remaining half would have hidden it from exactly the agent that has a server and no channel. And
  `GET /v1/provision` no longer serves the step at all, because that list is generated from the
  wizard's own walk; a browser form loses a control it should never have had.

Generated by Changesets, one entry per change. The **curated** release notes are the root
`CHANGELOG.md`, which is where a reader should start — this file is the record beneath it.

## 0.1.1

### Patch Changes

- **A person can change an agent's settings and schedules from the browser.** Two new routes —
  `GET /v1/agents/:id/config` and `PATCH /v1/agents/:id/config` — are the person's editor reached
  remotely: the same unfloored set of fields `dispach config` offers, the same two confirmations, and
  the same single writer (`core/manifest/edit.ts`) so an edit is validated against the schema, the
  schedule parser and `resolveProviders` before anything is written. The panel is generated from
  `SETTINGS` in core rather than hand-listed, so it covers tools, policy, model, limits, channels,
  delivery, schedules and the server block, and a field added to that table appears with nothing to
  remember. Applying a change replaces the agent, because an agent's settings are fixed for its
  instance's lifetime; the reply reports the write and the application separately, so an edit made
  while a turn is running is reported as written-and-pending rather than as a failure.

  This is not `config_set` with a URL in front of it and it is not a role. `config_set` is the
  _agent's_ editor and is floored, because an agent that could widen its own inbound gate could be
  talked into it by the message it is reading. There are no users, teams or roles here; the browser
  mints itself an unscoped key because the browser is the owner.

  The schedule panel gained create, enable, disable, delete and run-now, wiring client methods that had
  existed with zero callers since they were written.

  **Found while putting a UI on it:** `PATCH` and `DELETE` on a schedule the _manifest_ declares
  answered `200` and were undone at the next boot — reconciliation restores every field from the file,
  `enabled` included. The terminal had refused that since Phase 8 and the API never learned to, which is
  "a check only one surface performs is a check the two disagree about" one surface further out. Both now
  answer `409 schedule_manifest_owned`, and the panel shows which file decides a row instead of offering
  a button whose only outcome is that refusal.

- **An agent created over HTTP answers to one name.** `POST /v1/agents` returned the _name_ where every
  route keys on the slugged id, and derived its directory from the name while the terminal derived it
  through `slugify` — so creating "Milo" wrote `agents/Milo`, declared `id: milo`, and returned
  `{ id: "Milo", adopted: ["milo"] }`. The browser compared those and reported **`written, and not
running`** for an agent that was running perfectly, with no error text because there had been no
  error; the CLI then answered only to `Milo` and the API only to `milo`. Both the directory and the
  returned id now come from `dirFor` and the slug, which is the same derivation the wizard uses.

- **The web chat renders one reply per question, in order.** A live turn opened one event stream per
  React render: `client.agent(id)` returns a fresh object each call and the shell called it in its
  render body, so every `useCallback` keyed on it was new every render, the reattach effect re-fired
  with no cleanup, and each stream's `setState` committed a render that opened another. Six concurrent
  streams folded into one transcript and one stateful token filter, which is why a real reply came out
  as `DoingDoingDoing good good good…` and was then repeated eight more times. The facade is memoised,
  subscription ownership moved into `packages/web/src/lib/live.ts` so a second stream for one turn is
  refused rather than merely unlikely, and the reattach effect now aborts on cleanup — which also stops
  a turn started in one conversation appending rows into the next one.

  The same cascade was refetching `/sessions` on every render until the browser's per-origin budget ran
  out and rejected further calls with a `TypeError`, which is where the permanent
  `GET …/sessions did not reach … Failed to fetch` banner came from. Polls now clear the error on
  success, so one transient failure is no longer permanent.

- **`PluginContext.defineChannel` works through the binary.** It is documented public API, implemented,
  and conformance-tested, and it had never once worked from the command line: `Runtime.create` loads an
  agent's plugins and then validates `channels[].type` against what they registered, but every CLI
  command pre-loads the manifest _first_ against the binary's static channel table — so a manifest
  naming a plugin-supplied channel was refused with `channel_type_unknown` before the plugin that would
  satisfy it was imported. `serve` and `validate` now take the same two passes core does.

  It stayed invisible because `telegram` reaches the runtime from the CLI's own table and never through
  the plugin path, so the central registration function of `docs/03-SPEC-PLUGIN-API.md` had **no in-tree
  consumer**. It has one now: a two-field plugin defining one channel, loaded by the real binary under
  `serve`. The load also moved inside the skip-and-report loop, so a plugin that throws on import makes
  one discovered agent broken-and-skipped instead of taking the whole host down as it used to.

  Docs stopped claiming things that do not exist. `docs/01-ARCHITECTURE.md` listed a
  `packages/channel-whatsapp/` that has never been committed on any branch; `docs/02-SPEC-MANIFEST.md`
  documented a `whatsapp` channel type with `authDir` and `printQr` fields that no code reads, and
  `CLAUDE.md`/`AGENTS.md` named it in the package map. All four are gone, and the manifest spec now says
  plainly that `telegram` is the only type the binary registers and a second comes from a plugin.
  `docs/03-SPEC-PLUGIN-API.md`'s example showed a `defineChannel({…})` signature the implementation
  replaced with `(id, factory)` — while the same file spelled it correctly forty lines down. `needs_input`
  and plugin middleware are both recorded as having no producer and no first-party consumer respectively,
  where a reader will find it rather than discovering it.

- **The web transcript reads oldest-first, with each reply under the question that prompted it.** The
  message page is `ORDER BY id DESC` with `nextBefore` carrying the page's oldest id — correct,
  deliberate backwards-paging — and `docs/04-SPEC-WIRE.md` documented the message _shape_ and no order
  at all. That unstated contract is the actual defect: `packages/cli` reversed the page with a comment
  saying why and the browser did not, so the conversation rendered upside down with every assistant
  reply above its question. The order is now documented beside the shape, along with the related trap
  that both rows of one turn share `createdAt` to the millisecond, so `id` is the only total order.

  Error text stopped being printed twice: the client bakes a hint into `message` and the page was
  appending it again.
