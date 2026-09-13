/**
 * The `agent.yaml` schema, in full, per docs/02-SPEC-MANIFEST.md.
 *
 * Two deliberate choices:
 *
 * **Shape here, semantics in validate.ts.** Zod checks structure and applies defaults; every
 * cross-field rule and every semantic constraint lives in `validate.ts`, where a failure can
 * carry a field path *and* a hint naming the fix. Zod's "Invalid url" satisfies neither.
 *
 * **Unknown keys are rejected, not stripped.** A typo'd key that silently does nothing is the
 * exact class of failure rule 8 exists to prevent: the config looks applied and isn't. The one
 * exception is `channels[]`, whose type-specific fields belong to the channel plugin's own
 * schema and must survive to reach it.
 *
 * Sections beyond Phase 1 (tools, phases, skills, memory, channels, schedules, plugins) are
 * fully specified here so a forward-looking manifest validates, and are refused at load by
 * `validate.ts` rather than silently ignored.
 */

import { z } from "zod"
import { BRAND } from "../brand.ts"
import { DEFAULT_WORKSPACE_BUDGETS } from "../workspace/load.ts"

const slug = z.string().min(1)

/**
 * How authored workspace files are rendered for this model.
 *
 * Every field optional: this is an override of a derived default, not a declaration. Published
 * prompting guidance is written for frontier models and a good fraction of it inverts at 3–8B,
 * so it is encoded as a capability rather than a constant.
 */
export const PromptStyleSchema = z
    .object({
        delimiters: z.enum(["xml", "markdown", "plain"]).optional(),
        intensity: z.enum(["emphatic", "neutral", "soft"]).optional(),
        examplesIn: z.enum(["system", "user"]).optional(),
        skillsIn: z.enum(["system", "user"]).optional(),
    })
    .strict()

export const ModelCapabilitiesSchema = z
    .object({
        nativeTools: z.boolean().optional(),
        strictSchema: z.boolean().optional(),
        thinking: z.enum(["none", "anthropic", "openai", "deepseek"]).optional(),
        promptCache: z.enum(["none", "anthropic", "openai"]).optional(), // deepseek has no prompt cache, server-side -> refer packages/core/src/model/capabilities.ts
        parallelToolCalls: z.boolean().optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutput: z.number().int().positive().optional(),
        /** Merged field by field over the shipped default — set one without restating the rest. */
        promptStyle: PromptStyleSchema.optional(),
    })
    .strict()

export const ModelRoleSchema = z
    .object({
        /** Sent verbatim as the `model` parameter. */
        id: z.string().min(1),
        /** Must end at the version segment; the runtime appends `/chat/completions`. */
        baseUrl: z.string().min(1),
        /** The *name* of an env var. A literal key here fails validation. */
        apiKeyEnv: z.string().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        maxTokens: z.number().int().positive().optional(),
        /**
         * How much the model may deliberate. Sent as OpenAI's `reasoning_effort`; omitted when unset.
         *
         * Worth setting on any reasoning model doing short, well-specified work. Measured on
         * `qwen3.5:9b`: six simultaneous rules with reasoning on burned 2,000 output tokens in 104 s
         * and returned **empty content**; `none` answered correctly in 2.1 s. The failure mode is
         * the one `reserveOutput` already warns about — reasoning is billed to the output budget —
         * so this is the other half of that lever.
         *
         * Not universally honoured, and an endpoint that ignores it says nothing. Verify per
         * endpoint rather than assuming.
         */
        reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        /**
         * Ask the endpoint to report token usage in a streamed response.
         *
         * `stream_options` is an OpenAI extension, so it is off by default: an endpoint that does
         * not know it may reject the request outright. Measured: Ollama honours it and reports
         * nothing without it, so a local model's token counts come from the estimator until this is
         * set — which matters the moment a number is being compared rather than displayed.
         */
        streamUsage: z.boolean().optional(),
        capabilities: ModelCapabilitiesSchema.optional(),
    })
    .strict()

export const ModelSchema = z
    .object({
        main: ModelRoleSchema,
        /** Cheap model for tool selection. Falls back to `main`. */
        selector: ModelRoleSchema.optional(),
        /** Cheap model for summarisation. Falls back to `main`. */
        compactor: ModelRoleSchema.optional(),
    })
    /**
     * Any other key is a **custom role**, which a schedule may name with `role:`.
     *
     * This is what makes "a cheap model for the heartbeat, an expensive one for the weekly report"
     * expressible without duplicating an endpoint per schedule, and it is the general form the three
     * reserved names were always a special case of.
     *
     * **The cost is that a typo in a reserved name becomes a custom role rather than an error.**
     * `model.compacter:` parses cleanly, `compactor` silently falls back to `main`, and a configured
     * cheap compactor stops being used with nothing reporting it — the silent-degradation shape rule
     * 8 exists to prevent. Two things catch it, and both are required: `validate` warns about a
     * declared role that nothing references (a misspelled `compacter` is referenced by nothing), and
     * `resolveRoles(...).byName` throws on an unknown name rather than falling back, the same rule as
     * `ToolRegistry.resolve` throwing on an unknown slug and for the same reason.
     */
    .catchall(ModelRoleSchema)

/**
 * Compaction ladder trigger fractions of the *prompt budget* — `window` minus `reserveOutput` — not
 * of the whole window. Must be strictly ascending in stage order; validated.
 *
 * The order is `snip → micro → collapse → reset → trim`, which is not the order the field names were
 * first written in. It is ordered by information *destroyed*: `snip` and `micro` leave an
 * `artifact_read` pointer, `collapse` and `reset` leave the meaning as a digest, and `trim` leaves
 * nothing — so `trim` is the last rung despite freeing the most bytes. Two measurements forced it and
 * `context/compaction/stages.ts` carries both; the second is not a preference — with `trim` third the
 * digest stages could never fire, because a digest plus the preserved requests is never smaller than
 * the requests alone.
 *
 * `collapse` at 0.80 is where the first model call happens, down from 0.88. That is the price of making
 * the digest stages reachable at all, and it is stated rather than buried: below 0.80 the ladder is
 * entirely mechanical, offline and testable.
 *
 * Declared in stage order so the table reads the way the ladder runs.
 */
export const ThresholdsSchema = z
    .object({
        snip: z.number().default(0.6),
        micro: z.number().default(0.7),
        collapse: z.number().default(0.8),
        reset: z.number().default(0.88),
        trim: z.number().default(0.95),
    })
    .strict()

/**
 * Hard caps per tier and overall. Over budget fails the load naming the file — never truncation.
 *
 * The defaults come from `DEFAULT_WORKSPACE_BUDGETS` rather than being repeated here, so the figure
 * a manifest gets by omitting the section and the figure the loader applies without one cannot
 * drift apart. They are still a ceiling rather than a target: what a window *fits* and what a model
 * still *follows* are different numbers, and only the second one matters. Every token added here is
 * paid on every turn of every session.
 */
export const WorkspaceBudgetsSchema = z
    .object({
        static: z.number().int().positive().default(DEFAULT_WORKSPACE_BUDGETS.static),
        volatile: z.number().int().positive().default(DEFAULT_WORKSPACE_BUDGETS.volatile),
        reminder: z.number().int().positive().default(DEFAULT_WORKSPACE_BUDGETS.reminder),
        total: z.number().int().positive().default(DEFAULT_WORKSPACE_BUDGETS.total),
    })
    .strict()

export const RulesSchema = z
    .object({
        /**
         * Probability the model follows any one rule. Measure it with `eval rules` rather than
         * guessing — small models run well below 0.90, and a guessed figure produces a guard that
         * validates nothing.
         */
        perRuleSuccess: z.number().gt(0).lte(1).default(0.9),
        /** Probability that *all* stated rules are followed together. */
        reliabilityTarget: z.number().gt(0).lt(1).default(0.8),
        /**
         * `warn` exists because the imperative count is a heuristic and a wrong count must not be a
         * wall. It is deliberately not "raise reliabilityTarget", which changes the number without
         * changing the behaviour it is supposed to describe.
         */
        onExceed: z.enum(["fail", "warn"]).default("fail"),
    })
    .strict()

/**
 * A long-form identity document, shipped only to models that can carry one.
 *
 * The premise of a document this size is that a model given enough understanding of the goals will
 * derive rules the author never wrote. Derivation is precisely what small models cannot do, and the
 * document consumes a prohibitive share of their window while they fail to do it — so it is gated
 * rather than recommended or banned.
 */
export const SoulSchema = z
    .object({
        file: z.string().min(1),
        requires: z
            .object({
                /** A comparison such as `">=200000"`, against the resolved window. */
                contextWindow: z.string().min(1).optional(),
                /** Derived from the model id by size — `frontier` is 14B and up, or unsized. */
                class: z.enum(["frontier", "small"]).optional(),
            })
            .strict()
            .optional(),
        /** `distill` ships the committed compact file; summarising an identity automatically drops
         * exactly the parts that produce voice, so it is never done at runtime. */
        onUnmet: z.enum(["distill", "omit", "fail"]).default("distill"),
        /** The hand-edited compact file `soul distill` scaffolds. Required by `onUnmet: distill`. */
        distilled: z.string().min(1).optional(),
    })
    .strict()

export const KnowledgeSchema = z
    .object({
        dir: z.string().min(1),
        /** Entries activated in one turn. */
        maxActive: z.number().int().nonnegative().default(2),
        /** Total across activated entries. Tier 3 is retrieved, never pinned, so it is outside
         * the workspace's 1,300-token cap. */
        budget: z.number().int().positive().default(600),
    })
    .strict()

export const ContextSchema = z
    .object({
        /** Total token budget. Defaults to the model's `contextWindow` capability. */
        window: z.number().int().positive().optional(),
        reserveOutput: z.number().int().positive().default(4096),
        observationMaxTokens: z.number().int().positive().default(2000),
        /**
         * **Deprecated from Phase 3.5** — an alias for `static`, warning at load.
         *
         * Kept resolving against the *manifest* directory rather than the workspace directory, which
         * is what makes it an alias rather than a rename: a manifest that worked before Phase 3.5
         * finds the same files after it.
         */
        files: z.array(z.string().min(1)).default([]),
        /** Directory the tier lists resolve against. Relative to the manifest. */
        workspace: z.string().min(1).default("./workspace"),
        /** Tier 0, slot 0. Cache-stable, read-only, before breakpoint A. */
        static: z.array(z.string().min(1)).default([]),
        /** Tier 1, slot 3. Writable, *after* breakpoint A so a write leaves the cache intact. */
        volatile: z.array(z.string().min(1)).default([]),
        /** Tier 2, slot 9. After the history, before the current input. One or two rules. */
        reminder: z.string().min(1).optional(),
        budgets: WorkspaceBudgetsSchema.prefault({}),
        rules: RulesSchema.prefault({}),
        /** Capability-gated long-form identity, with `requires` and `onUnmet`. */
        soul: SoulSchema.optional(),
        /** Runtime-generated line about automatic compaction. Phase 7; refused until then. */
        compactionNotice: z.boolean().optional(),
        thresholds: ThresholdsSchema.prefault({}),
    })
    .strict()

export const ToolBudgetSchema = z
    .object({
        max: z.number().int().positive().default(24),
        /** Slots held for mutating tools so reads cannot starve writes. */
        reserveWrite: z.number().int().nonnegative().default(6),
    })
    .strict()

/**
 * What happens when untrusted content is in the turn and a mutating tool is requested.
 *
 * `refuse` is the default and never prompts, which is what makes it right for the unattended runs
 * this runtime exists for. `confirm` asks, and therefore needs an approver to be reachable — with
 * none, it refuses like `refuse` rather than proceeding. `allow` accepts the risk, stated rather
 * than assumed.
 */
export const ToolsUntrustedSchema = z
    .object({
        onMutate: z.enum(["refuse", "confirm", "allow"]).default("refuse"),
    })
    .strict()

/**
 * Which calls run, which ask, and which are refused.
 *
 * Named `policy` rather than `permissions` deliberately: `permissions` is already the plugin
 * manifest's block, where it is advisory and unenforced. Giving an enforced control the same word
 * as the project's one famously unenforced block is the worst available name.
 */
export const ToolsPolicySchema = z
    .object({
        // `allow` matches DEFAULT_POLICY, and for the same reason: pinning is the primary
        // authorization, and `ask` would mean every unattended run denies every call.
        mode: z.enum(["ask", "allow", "deny"]).default("allow"),
        allow: z.array(z.string().min(1)).default([]),
        deny: z.array(z.string().min(1)).default([]),
        /** What `ask` means with nobody to ask — a schedule, a pipe, a channel with no approver. */
        onNoApprover: z.enum(["deny", "allow"]).default("deny"),
    })
    .strict()

export const ToolsSchema = z
    .object({
        /** Config only — never auto-detected, so behaviour cannot drift with the model. */
        dialect: z.enum(["nlt", "native"]).default("nlt"),
        /**
         * Provider id → that provider's own configuration.
         *
         * A map rather than a scalar because `system`, `web` and `composio` are not alternatives:
         * an agent that runs commands and reads the web wants both, and the scalar field made that
         * unexpressible. Insertion order is priority order, as everywhere else in this manifest.
         *
         * Each provider validates its own block — core cannot, since it may not import one — so an
         * unknown key inside is refused by the provider package rather than here.
         */
        providers: z.record(slug, z.record(z.string(), z.unknown())).default({}),
        /** @deprecated The single-provider alias for `providers`. Warns; conflicts are refused. */
        provider: slug.optional(),
        /** @deprecated Goes with `provider`. */
        providerConfig: z.record(z.string(), z.unknown()).default({}),
        budget: ToolBudgetSchema.prefault({}),
        pinned: z.array(z.string().min(1)).default([]),
        search: z
            .object({ enabled: z.boolean().default(false) })
            .strict()
            .prefault({}),
        local: z.array(z.string().min(1)).default([]),
        untrusted: ToolsUntrustedSchema.prefault({}),
        policy: ToolsPolicySchema.prefault({}),
    })
    .strict()

export const PhaseSchema = z
    .object({
        /** Slugs, `tag:<name>` annotations, or `*`. */
        allow: z.array(z.string().min(1)),
        entry: z.boolean().optional(),
    })
    .strict()

export const SkillsSchema = z
    .object({
        dir: z.string().min(1).default("./skills"),
        maxActive: z.number().int().nonnegative().default(1),
        /**
         * Normalised BM25 floor. Below it, no skill activates.
         *
         * Calibrated to the normalisation in `skills/select.ts`, which bounds a score in `[0, 1)` —
         * changing that formula invalidates this default, and both sides say so.
         */
        threshold: z.number().default(0.35),
        // No `budget`, and its absence is the design (decision 11.59). A per-turn token cap on skills
        // only ever converted "the right procedure" into "no procedure": `maxActive` already bounds a
        // turn to one body, so the second limit added no protection and produced a refusal at install,
        // at load *and* mid-turn for a file somebody had deliberately chosen. Size is shown where the
        // choice is made — the catalogue prints every body's token count — and `skills validate` warns
        // above the spec's advised 5,000. Nothing refuses.
        // No `sources` field, and its absence is the design (decision 11.46). Where skills come from is
        // a machine-level list the CLI owns, not a property of one agent — and a fetchable URL inside the
        // document `Runtime.create` reads is an invitation to resolve it there, which is hard rule 4 and
        // the reason this project exists. The runtime's only relationship with a source is that a
        // directory was copied before it ever started.
    })
    .strict()

export const MemorySchema = z
    .object({
        /**
         * Which retriever backs slot 7. Only `fts5` exists; an unknown name is refused at load with
         * the known ones named, rather than silently retrieving nothing.
         *
         * A string rather than an enum because `MemoryRetriever` is a function-shaped seam and the
         * point of a seam is that something else can occupy it — the vectors this phase refuses until
         * lexical is proven insufficient arrive here as another name, not as another pipeline.
         */
        retriever: z.string().min(1).default("fts5"),
        /**
         * Where eviction files older notes, relative to the manifest. Indexed; never carried.
         *
         * The carried file is the workspace's `volatile` tier and is configured there. This directory
         * is its overflow: `memory_write` appends to the carried file, and when that file passes its
         * budget the oldest notes move here, where only retrieval reaches them.
         */
        dir: z.string().min(1).default("./memory"),
        /**
         * Passages injected in one turn. Slot 7 is retrieved, never pinned; compaction may drop it.
         *
         * Five rather than three since `includeHistory` began indexing conversations: a corpus that
         * holds both notes and exchanges answers "where did we get to" from several passages, and three
         * is one exchange plus the two notes that happen to share its vocabulary.
         */
        maxActive: z.number().int().nonnegative().default(5),
        /**
         * Score floor after original-query coverage and recency. The lexical component still uses the
         * same `rank/bm25.ts` scale as skills; `memory search` exposes both terms.
         *
         * **Lower than skills' 0.35 on purpose, because the two want opposite errors.** A wrong skill
         * *displaces* the right one at `maxActive: 1`, so routing pays for precision; an extra
         * remembered passage costs twenty tokens under a budget that already caps the slot, so
         * retrieval pays for recall.
         *
         * Measured over 5,000 passages: the original thirteen direct cases remain green, while a
         * four-term question sharing only `1998` falls to 0.123. A genuine one-term query has coverage
         * 1 and remains eligible.
         */
        threshold: z.number().default(0.2),
        /**
         * Total tokens across injected passages. Outside the workspace cap — this tier is retrieved.
         *
         * **Raised from 600 when `includeHistory` was implemented, and the change was required rather
         * than generous.** 600 was sized for note bullets, which are one line; a conversation exchange
         * is a question and a reply, capped at 600 characters a side by `MAX_INDEXED_MESSAGE_CHARS`, so
         * a full one estimates near 320 tokens and bills nearer 370 — `estimateTokens` runs 16–20% low
         * on exactly this kind of mixed text. Two exchanges would have exhausted the old budget.
         *
         * The interaction with `selectPassages` is why an undersized budget is worse than it looks: it
         * stops at the first passage that does not fit and never skips past it, so one exchange too
         * large for the budget does not merely go uninjected — it sits at the top of the ranking and
         * blocks everything behind it. A ceiling, not a target: nothing is injected to fill it.
         */
        budget: z.number().int().positive().default(2000),
        /**
         * Index the person's messages and the agent's replies as well as the notes.
         *
         * **Tool observations are never indexed, at any setting.** That is where untrusted text lives —
         * a fetched page, a provider result — and indexing it would make prompt injection *durable*:
         * text a stranger wrote, retrieved into slot 7 in a later session, long after the write gate
         * that fenced it stopped applying. `ChatMessage.origin` is what makes the distinction reliable,
         * since under a text dialect an observation comes back as a `user` message and the role does
         * not say.
         */
        includeHistory: z.boolean().default(true),
    })
    .strict()

/**
 * Not strict: `tokenEnv`, `mode`, `authDir` and friends are validated by the channel plugin's
 * own schema, and stripping them here would delete the channel's entire configuration.
 */
export const ChannelSchema = z
    .object({
        type: slug,
        id: slug,
        /** Inbound allowlist. `["*"]` permits anyone. Inbound only — no effect on delivery. */
        allowFrom: z.array(z.string().min(1)).optional(),
        enabled: z.boolean().default(true),
    })
    .passthrough()

export const DeliveryTargetSchema = z.object({ channel: slug, to: z.string().min(1) }).strict()

export const DeliverySchema = z
    .object({
        /** Channel used when a turn has no origin — schedules, API-initiated turns. */
        default: slug.optional(),
        targets: z.record(z.string(), DeliveryTargetSchema).default({}),
    })
    .strict()

export const ScheduleSchema = z
    .object({
        id: slug,
        kind: z.enum(["cron", "every", "at"]),
        /** cron: 5 or 6 field. every: duration (`15m`). at: ISO 8601, max +10 years. */
        expr: z.string().min(1),
        task: z.string().min(1),
        /** Required at write time — `{channel,to}` or the literal `"none"`. */
        deliver: z.union([z.literal("none"), DeliveryTargetSchema]),
        session: z.string().min(1).default("isolated"),
        /**
         * A model role this run uses instead of `main`.
         *
         * Names an entry under `model:` — one of the reserved three, or a custom one. Absent is
         * `main`, which is why it is optional rather than defaulted to the string: "unset" and
         * "explicitly main" are the same behaviour, and a default would make a listing claim the
         * author wrote something they did not.
         */
        role: slug.optional(),
        enabled: z.boolean().default(true),
        /** IANA name. Defaults to `TZ`, then UTC. */
        timezone: z.string().min(1).optional(),
    })
    .strict()

export const PluginRefSchema = z.union([
    z.string().min(1),
    z
        .object({
            spec: z.string().min(1),
            config: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
])

/**
 * When to conclude the model is stuck rather than working.
 *
 * A step cap protects against a model that loops; it is simply bad at it. Set low enough to catch a
 * loop it also stops real work — a six-step budget cut an agent off one step after it had installed
 * the dependency it needed — and set high enough for real work it lets a loop run to the cap. What
 * actually distinguishes the two is repetition: a working agent's calls differ, a stuck one's do not.
 *
 * So the cap is generous and this is the guard. Compared on slug *and* arguments, because the same
 * tool with different arguments is progress; `exec ls` twice in a row is not.
 */
export const NoProgressSchema = z
    .object({
        /**
         * Identical consecutive tool calls before the turn ends as `no_progress`. Two is a retry, which
         * is often correct — a transient failure deserves one more try. Three is a pattern.
         */
        identicalCalls: z.number().int().min(2).default(3),
    })
    .strict()

export const LimitsSchema = z
    .object({
        /**
         * Steps per turn before forced termination, reported as `reason: max_steps`.
         *
         * Generous on purpose. The previous default assumed a step budget was a *plan* — "a two-tool
         * chain needs five steps, one spare" — which is the budget for answering a question, not for
         * doing work. Real work recovers: a mangled command becomes a script file, a missing library
         * gets installed, a failed test gets read. `noProgress` is what stops a loop; this only stops
         * a runaway.
         */
        maxSteps: z.number().int().positive().default(40),
        noProgress: NoProgressSchema.prefault({}),
        /** Must exceed any upstream timeout on the model endpoint. */
        turnTimeoutMs: z.number().int().positive().default(1_800_000),
        toolTimeoutMs: z.number().int().positive().default(120_000),
        /** Read-only tools only; mutating tools always serialise. */
        maxParallelTools: z.number().int().positive().default(4),
    })
    .strict()

export const ServerSchema = z
    .object({
        enabled: z.boolean().default(false),
        port: z.number().int().min(1).max(65535).default(7420),
        /** Loopback by default. A public bind is explicit, and requires a token. */
        host: z.string().min(1).default("127.0.0.1"),
        tokenEnv: z.string().min(1).default(`${BRAND.envPrefix}API_TOKEN`),
    })
    .strict()

export const AgentManifestSchema = z
    .object({
        apiVersion: z.string().min(1),
        id: slug,
        name: z.string().min(1).optional(),
        /** Path to a base manifest. Shallow merge; arrays replace. */
        extends: z.string().min(1).optional(),

        model: ModelSchema,
        context: ContextSchema.prefault({}),
        tools: ToolsSchema.prefault({}),
        phases: z.record(z.string(), PhaseSchema).optional(),
        skills: SkillsSchema.optional(),
        knowledge: KnowledgeSchema.optional(),
        memory: MemorySchema.optional(),
        channels: z.array(ChannelSchema).default([]),
        delivery: DeliverySchema.optional(),
        schedules: z.array(ScheduleSchema).default([]),
        plugins: z.array(PluginRefSchema).default([]),
        limits: LimitsSchema.prefault({}),
        server: ServerSchema.prefault({}),
    })
    .strict()

export type ModelCapabilitiesOverride = z.infer<typeof ModelCapabilitiesSchema>
export type ModelRoleConfig = z.infer<typeof ModelRoleSchema>
export type ModelConfig = z.infer<typeof ModelSchema>
export type ContextConfig = z.infer<typeof ContextSchema>
export type WorkspaceBudgetsConfig = z.infer<typeof WorkspaceBudgetsSchema>
export type RulesConfig = z.infer<typeof RulesSchema>
export type ThresholdsConfig = z.infer<typeof ThresholdsSchema>
export type ToolsConfig = z.infer<typeof ToolsSchema>
export type PhaseConfig = z.infer<typeof PhaseSchema>
export type SkillsConfig = z.infer<typeof SkillsSchema>
export type KnowledgeConfig = z.infer<typeof KnowledgeSchema>
export type SoulConfig = z.infer<typeof SoulSchema>
export type MemoryConfig = z.infer<typeof MemorySchema>
export type ChannelConfig = z.infer<typeof ChannelSchema>
export type DeliveryConfig = z.infer<typeof DeliverySchema>
export type ScheduleConfig = z.infer<typeof ScheduleSchema>
export type LimitsConfig = z.infer<typeof LimitsSchema>
export type ServerConfig = z.infer<typeof ServerSchema>
export type AgentManifest = z.infer<typeof AgentManifestSchema>

/**
 * The role names the runtime itself uses. A manifest may declare others beside them.
 *
 * `main` is required and is the fallback for the other two. Anything else under `model:` is a custom
 * role, reachable only by a schedule naming it — the runtime never selects one on its own.
 */
export const MODEL_ROLES = ["main", "selector", "compactor"] as const
export type ModelRole = (typeof MODEL_ROLES)[number]

export function isReservedRole(name: string): name is ModelRole {
    return (MODEL_ROLES as readonly string[]).includes(name)
}

/** Role names declared beside the reserved three, in manifest order. */
export function customRoleNames(model: AgentManifest["model"]): readonly string[] {
    return Object.keys(model).filter((name) => !isReservedRole(name))
}
